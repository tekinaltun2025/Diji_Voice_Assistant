import { TTSEngine, TTSStreamEvent } from '../tts';
import { logInfo, logError, logWarn } from '@diji/shared';

/**
 * Araştırma modülü için sesli bildirim servisi.
 * Araştırma başladığında ve bittiğinde TTS ile sesli uyarı verir.
 */
export class ResearchNotifier {
  private ttsEngine: TTSEngine | null = null;
  private isSpeaking: boolean = false;
  private notificationQueue: string[] = [];
  private processingQueue: boolean = false;

  /**
   * TTS motorunu ayarlar.
   */
  setTTSEngine(ttsEngine: TTSEngine): void {
    this.ttsEngine = ttsEngine;
    logInfo('ResearchNotifier TTS motoruna bağlandı');
  }

  /**
   * Araştırma başlangıç bildirimi: "Ayrıntılı bakıyorum, biraz sürebilir."
   */
  async notifyStart(): Promise<void> {
    const message = 'Ayrıntılı bakıyorum, biraz sürebilir.';
    await this.speak(message);
    logInfo('Araştırma başlangıç bildirimi gönderildi', { message });
  }

  /**
   * Araştırma tamamlanma bildirimi: "Araştırma tamamlandı: [özet]"
   */
  async notifyComplete(summary: string): Promise<void> {
    const message = `Araştırma tamamlandı: ${summary}`;
    await this.speak(message);
    logInfo('Araştırma tamamlanma bildirimi gönderildi', {
      summaryLength: summary.length,
      messageLength: message.length,
    });
  }

  /**
   * Araştırma hata bildirimi.
   */
  async notifyError(errorMessage: string): Promise<void> {
    const message = `Araştırma sırasında bir hata oluştu: ${errorMessage}`;
    await this.speak(message);
    logWarn('Araştırma hata bildirimi gönderildi', { error: errorMessage });
  }

  /**
   * Özel bir mesajı sesli olarak söyler.
   */
  async speak(text: string): Promise<void> {
    if (!this.ttsEngine) {
      logWarn('TTS motoru ayarlanmamış, bildirim atlanıyor', { text });
      return;
    }

    // Zaten konuşuyorsa kuyruğa ekle
    if (this.isSpeaking) {
      this.notificationQueue.push(text);
      this.processQueue();
      return;
    }

    this.isSpeaking = true;

    try {
      logInfo('TTS bildirim söyleniyor', { textLength: text.length });

      // TTS speakStream kullanarak sesli çal
      for await (const event of this.ttsEngine.speakStream(text)) {
        if (event.type === 'error') {
          logError('TTS bildirim sentezleme hatası');
          break;
        }
      }
    } catch (error) {
      logError('TTS bildirim hatası', error as Error);
    } finally {
      this.isSpeaking = false;
      this.processQueue();
    }
  }

  /**
   * Kuyruktaki bildirimleri sırayla işler.
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.notificationQueue.length === 0) {
      return;
    }

    this.processingQueue = true;

    while (this.notificationQueue.length > 0) {
      const text = this.notificationQueue.shift()!;
      await this.speak(text);
    }

    this.processingQueue = false;
  }

  /**
   * Bekleyen bildirim sayısını döner.
   */
  getPendingCount(): number {
    return this.notificationQueue.length;
  }

  /**
   - Şu anda konuşulup konuşulmadığını döner.
   */
  getIsSpeaking(): boolean {
    return this.isSpeaking;
  }

  /**
   - Kuyruğu temizler.
   */
  clearQueue(): void {
    this.notificationQueue = [];
    logInfo('Bildirim kuyruğu temizlendi');
  }
}

export const createResearchNotifier = (): ResearchNotifier => {
  return new ResearchNotifier();
};