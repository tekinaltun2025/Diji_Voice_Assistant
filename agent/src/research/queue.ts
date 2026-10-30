import { ResearchTask, ResearchStatus, ResearchPriority } from './types';
import { logInfo, logWarn, logError } from '@diji/shared';

/**
 * Sıraya eklenen bir araştırma görevi için opsiyonel ilerleme geri çağrısı.
 */
export type TaskProgressCallback = (taskId: string, progress: number) => void;

/**
 * Araştırma görev kuyruğu. Öncelik bazlı sıralamalı, bellek içi kuyruk.
 * Daha yüksek öncelikli görevler önce işlenir.
 */
export class ResearchQueue {
  private queue: Map<string, ResearchTask> = new Map();
  private processing: Set<string> = new Set();
  private completed: Map<string, ResearchTask> = new Map();
  private failed: Map<string, ResearchTask> = new Map();
  private progressCallbacks: Map<string, TaskProgressCallback> = new Map();
  private maxHistorySize: number = 1000;

  /**
   * Kuyruğa yeni bir görev ekler. Mevcut ID varsa güncelleme yapar.
   */
  enqueue(task: ResearchTask): void {
    if (this.queue.has(task.id) || this.processing.has(task.id)) {
      logWarn('Görev kuyruğa eklenemedi, zaten mevcut', { taskId: task.id });
      return;
    }

    task.status = 'pending';
    task.progress = 0;
    task.createdAt = task.createdAt || new Date();
    task.updatedAt = new Date();

    this.queue.set(task.id, task);
    logInfo('Görev kuyruğa eklendi', {
      taskId: task.id,
      priority: task.priority,
      query: task.query.substring(0, 80),
    });
  }

  /**
   * En yüksek öncelikli bekleyen görevi kuyruktan çıkar ve işleme durumuna getirir.
   * Kuyruk boşsa null döner.
   */
  dequeue(): ResearchTask | null {
    if (this.queue.size === 0) {
      return null;
    }

    // Öncelik sırası: critical > high > medium > low
    const priorityOrder: ResearchPriority[] = ['critical', 'high', 'medium', 'low'];

    let bestTask: ResearchTask | null = null;
    let bestPriorityIndex = priorityOrder.length;

    for (const [, task] of this.queue) {
      const idx = priorityOrder.indexOf(task.priority);
      if (idx < bestPriorityIndex) {
        bestPriorityIndex = idx;
        bestTask = task;
      }
    }

    if (!bestTask) {
      return null;
    }

    this.queue.delete(bestTask.id);
    this.processing.add(bestTask.id);

    bestTask.status = 'processing';
    bestTask.startedAt = new Date();
    bestTask.updatedAt = new Date();

    logInfo('Görev kuyruktan çıkarıldı, işleme alındı', {
      taskId: bestTask.id,
      priority: bestTask.priority,
    });

    return bestTask;
  }

  /**
   * Görevi tamamlandı olarak işaretler ve geçmişe taşır.
   */
  complete(taskId: string, result?: ResearchTask['result']): void {
    const task = this.processing.has(taskId)
      ? this.findTaskById(taskId)
      : null;

    if (!task) {
      logWarn('Tamamlanacak görev işlemde bulunamadı', { taskId });
      return;
    }

    this.processing.delete(taskId);

    task.status = 'completed';
    task.completedAt = new Date();
    task.updatedAt = new Date();
    task.progress = 100;
    if (result) {
      task.result = result;
    }

    this.completed.set(taskId, task);
    this.trimHistory(this.completed);

    logInfo('Görev tamamlandı', { taskId, status: task.status });
  }

  /**
   * Görevi başarısız olarak işaretler ve hatayı kaydeder.
   */
  fail(taskId: string, error: string): void {
    const task = this.findTaskById(taskId);
    if (!task) {
      logWarn('Başarısız olarak işaretlenecek görev bulunamadı', { taskId });
      return;
    }

    this.processing.delete(taskId);

    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date();
    task.updatedAt = new Date();

    this.failed.set(taskId, task);
    this.trimHistory(this.failed);

    logError('Görev başarısız oldu', new Error(error), { taskId });
  }

  /**
   * Görevi iptal eder.
   */
  cancel(taskId: string): boolean {
    // Kuyrukta bekliyorsa doğrudan kaldır
    if (this.queue.has(taskId)) {
      const task = this.queue.get(taskId)!;
      this.queue.delete(taskId);
      task.status = 'cancelled';
      task.updatedAt = new Date();
      this.completed.set(taskId, task);
      this.trimHistory(this.completed);
      logInfo('Görev kuyruktan iptal edildi', { taskId });
      return true;
    }

    // İşlemdeyse işaretle (worker tarafından kontrol edilecek)
    if (this.processing.has(taskId)) {
      const task = this.findTaskById(taskId);
      if (task) {
        task.status = 'cancelled';
        task.updatedAt = new Date();
        logInfo('Görev iptal işaretlendi', { taskId });
        return true;
      }
    }

    logWarn('İptal edilecek görev bulunamadı', { taskId });
    return false;
  }

  /**
   * Belirli bir görevi ID ile bulur (kuyruk, işlemde, tamamlanmış veya başarısız).
   */
  getTask(taskId: string): ResearchTask | undefined {
    return (
      this.queue.get(taskId) ||
      this.findTaskById(taskId) ||
      this.completed.get(taskId) ||
      this.failed.get(taskId)
    );
  }

  /**
   * Tüm bekleyen görevleri döner (öncelik sıralı).
   */
  getPendingTasks(): ResearchTask[] {
    return Array.from(this.queue.values()).sort((a, b) => {
      const order: Record<ResearchPriority, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      return order[a.priority] - order[b.priority];
    });
  }

  /**
   * Şu anda işlemdeki görevleri döner.
   */
  getProcessingTasks(): ResearchTask[] {
    const tasks: ResearchTask[] = [];
    for (const taskId of this.processing) {
      const task = this.findTaskById(taskId);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  /**
   * Tamamlanmış görevleri döner.
   */
  getCompletedTasks(): ResearchTask[] {
    return Array.from(this.completed.values());
  }

  /**
   * Başarısız görevleri döner.
   */
  getFailedTasks(): ResearchTask[] {
    return Array.from(this.failed.values());
  }

  /**
   * Kuyrukta bekleyen görev sayısını döner.
   */
  getQueueSize(): number {
    return this.queue.size;
  }

  /**
   * İşlemdeki görev sayısını döner.
   */
  getProcessingSize(): number {
    return this.processing.size;
  }

  /**
   * Belirli bir görev için ilerleme geri çağrısı kaydeder.
   */
  onProgress(taskId: string, callback: TaskProgressCallback): void {
    this.progressCallbacks.set(taskId, callback);
  }

  /**
   * Görev ilerlemesini günceller ve geri çağırmayı tetikler.
   */
  updateProgress(taskId: string, progress: number): void {
    const task = this.findTaskById(taskId);
    if (task) {
      task.progress = Math.max(0, Math.min(100, progress));
      task.updatedAt = new Date();
    }

    const callback = this.progressCallbacks.get(taskId);
    if (callback) {
      callback(taskId, progress);
    }
  }

  /**
   * Belirli bir görevin ilerleme geri çağınımı kaldırır.
   */
  removeProgressCallback(taskId: string): void {
    this.progressCallbacks.delete(taskId);
  }

  /**
   * Kuyruğu ve tüm durumları temizler.
   */
  clear(): void {
    this.queue.clear();
    this.processing.clear();
    this.completed.clear();
    this.failed.clear();
    this.progressCallbacks.clear();
    logInfo('Araştırma kuyruğu temizlendi');
  }

  /**
   * Maksimum geçmiş boyutunu ayarlar.
   */
  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
  }

  /**
   * ID ile görevi arar (sadece işlemdeki listede).
   */
  private findTaskById(taskId: string): ResearchTask | undefined {
    // İşlemdeki görevler kuyruktan çıkarıldığı için ayrı bir liste tutmuyoruz,
    // ancak complete/fail sırasında geçmişe taşınmıştır. Burada completed/failed'den bakıyoruz.
    return this.completed.get(taskId) || this.failed.get(taskId);
  }

  /**
   * Geçmiş boyutunu sınırlandırır.
   */
  private trimHistory(map: Map<string, ResearchTask>): void {
    if (map.size > this.maxHistorySize) {
      const entries = Array.from(map.entries()).sort(
        ([, a], [, b]) =>
          new Date(a.updatedAt || a.createdAt).getTime() -
          new Date(b.updatedAt || b.createdAt).getTime()
      );
      const toRemove = entries.slice(0, map.size - this.maxHistorySize);
      for (const [id] of toRemove) {
        map.delete(id);
      }
    }
  }
}

export const createResearchQueue = (): ResearchQueue => {
  return new ResearchQueue();
};