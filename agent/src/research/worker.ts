import {
  ResearchTask,
  ResearchResult,
  ResearchSource,
  ResearchConfig,
  ResearchStatus,
} from './types';
import { MCPCallResponse } from '@diji/shared';
import { ResearchQueue } from './queue';
import { ResearchNotifier, createResearchNotifier } from './notifier';
import { LLMEngine, LLMMessage, LLMTool, LLMResponse } from '../llm';
import { MCPClient } from '../mcp-client';
import { logInfo, logError, logWarn, logDebug } from '@diji/shared';

/**
 * Araştırma worker'ı: kuyruktan görev alır, LLM ile uzun süreli araştırma yapar,
 * MCP araçlarını çağırabilir ve sonucu saklar.
 */
export class ResearchWorker {
  private queue: ResearchQueue;
  private llmEngine: LLMEngine;
  private mcpClient: MCPClient | null;
  private config: ResearchConfig;
  private isRunning: boolean = false;
  private currentTaskId: string | null = null;
  private abortController: AbortController | null = null;
  private notifier: ResearchNotifier;

  constructor(
    queue: ResearchQueue,
    llmEngine: LLMEngine,
    config: ResearchConfig,
    mcpClient?: MCPClient
  ) {
    this.queue = queue;
    this.llmEngine = llmEngine;
    this.config = config;
    this.mcpClient = mcpClient || null;
    this.notifier = createResearchNotifier();
  }

  /**
   * Worker'i baslatir ve kuyrugu dinlemeye baslar.
   *
   * DIKKAT: Bu metot BLOKLAYICIDIR — kuyruk bosaldiginda bile donmez.
   * Bu yuzden cagiran taraf onu `void worker.start()` ile arka planda
   * baslatmalidir; `await` etmek tum pipeline'i kilitler.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logWarn('Research worker zaten çalışıyor');
      return;
    }

    this.isRunning = true;
    logInfo('Research worker başlatıldı', {
      model: this.config.llmModel,
      baseUrl: this.config.llmBaseUrl,
      timeout: this.config.timeout,
      maxSteps: this.config.maxSteps,
    });

    // Kuyruğu sürekli dinle
    while (this.isRunning) {
      const task = this.queue.dequeue();
      if (!task) {
        // Kuyruk boş, kısa bir süre bekle
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      try {
        await this.processTask(task);
      } catch (error) {
        logError('Görev işleme hatası', error as Error, { taskId: task.id });
        this.queue.fail(task.id, (error as Error).message);
      }
    }
  }

  /**
   * Worker'i beklemeden baslatir; dongu arka planda calisir.
   * Hatalar yutulmaz, loglanir.
   */
  startInBackground(): void {
    void this.start().catch((error: unknown) => {
      logError('Research worker beklenmedik sekilde durdu', error as Error);
    });
  }

  /**
   * Worker'ı durdurur.
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.currentTaskId) {
      this.queue.cancel(this.currentTaskId);
      this.currentTaskId = null;
    }

    logInfo('Research worker durduruldu');
  }

  /**
   * Tek bir görev işler: LLM'e gönderir, MCP araçlarını çağırır, sonucu oluşturur.
   */
  private async processTask(task: ResearchTask): Promise<void> {
    this.currentTaskId = task.id;
    this.abortController = new AbortController();

    logInfo('Araştırma görevi işlenmeye başlıyor', {
      taskId: task.id,
      query: task.query,
      priority: task.priority,
    });

    try {
      // Görev işleme durumuna geçti
      this.queue.updateProgress(task.id, 5);

      // 1. Adım: Araştırma planı oluştur (LLM ile)
      const plan = await this.createResearchPlan(task);
      this.queue.updateProgress(task.id, 20);

      // 2. Adım: MCP araçlarını kullanarak veri toplaması (varsa)
      const mcpResults: Record<string, unknown> = {};
      const sources: ResearchSource[] = [];

      if (this.mcpClient && plan.mcpToolsNeeded && plan.mcpToolsNeeded.length > 0) {
        for (const toolName of plan.mcpToolsNeeded) {
          try {
            const mcpResponse = await this.callMCPTool(toolName, plan, task);
            if (mcpResponse.success) {
              mcpResults[toolName] = mcpResponse.data;
              // Kaynakları çıkar
              if (mcpResponse.data && typeof mcpResponse.data === 'object') {
                const data = mcpResponse.data as Record<string, unknown>;
                if (data['sources'] && Array.isArray(data['sources'])) {
                  for (const src of data['sources'] as any[]) {
                    sources.push({
                      name: src.name || toolName,
                      url: src.url,
                      type: 'mcp',
                      relevance: src.relevance ?? 0.8,
                      snippet: src.snippet,
                    });
                  }
                }
              }
            } else {
              logWarn('MCP tool çağrısı başarısız', {
                taskId: task.id,
                tool: toolName,
                error: mcpResponse.error,
              });
            }
          } catch (error) {
            logError('MCP tool çağrısı sırasında hata', error as Error, {
              taskId: task.id,
              tool: toolName,
            });
          }
        }
      }

      this.queue.updateProgress(task.id, 50);

      // 3. Adım: Toplanan verilerle LLM ile nihai özet oluştur
      const finalResponse = await this.generateFinalAnswer(task, plan, mcpResults, sources);
      this.queue.updateProgress(task.id, 80);

      // 4. Adım: Sonucu derle
      const result: ResearchResult = {
        taskId: task.id,
        summary: finalResponse.summary,
        details: finalResponse.details,
        sources,
        mcpToolResults: Object.keys(mcpResults).length > 0 ? mcpResults : undefined,
        generatedAt: new Date(),
      };

      task.status = 'completed';
      task.completedAt = new Date();
      task.updatedAt = new Date();
      task.progress = 100;
      task.result = result;

      this.queue.complete(task.id, result);

      // Bildirim gönder
      createResearchNotifier().notifyComplete(result.summary);

      logInfo('Araştırma görevi tamamlandı', {
        taskId: task.id,
        summaryLength: result.summary.length,
        sourceCount: result.sources.length,
      });
    } catch (error) {
      const errorMessage = (error as Error).message;
      logError('Araştırma görevi başarısız oldu', error as Error, { taskId: task.id });

      task.status = 'failed';
      task.error = errorMessage;
      task.completedAt = new Date();
      task.updatedAt = new Date();

      this.queue.fail(task.id, errorMessage);

      this.notifier.notifyError(errorMessage);
    } finally {
      this.currentTaskId = null;
      this.abortController = null;
    }
  }

  /**
   * Araştırma planı oluşturur: hangi MCP araçları kullanılacak, hangi kaynaklara bakılacak.
   */
  private async createResearchPlan(task: ResearchTask): Promise<{
    mcpToolsNeeded: string[];
    searchQueries: string[];
    focusAreas: string[];
  }> {
    const systemPrompt = `Sen Diji'nin arka plan araştırma asistanısın. Görev, kullanıcının sorgusunu derinleştiren bir araştırma planı hazırlamaktır.

KURALLAR:
1. Daima Türkçe yanıt ver
2. Sadece JSON formatında yanıt ver
3. Ağır araştırma gerektiren konular için MCP araçlarını (gmail, calendar, drive, notion, slack, chrome) belirle
4. searchQueries: araştırma sırasında kullanılacak anahtar kelime listesi
5. focusAreas: odaklanılması gereken konu alanları
6. mcpToolsNeeded: kullanılacak MCP araç isimleri (varsa)

JSON ŞEMASI:
{
  "mcpToolsNeeded": ["tool_name_1", "tool_name_2"],
  "searchQueries": ["sorgu1", "sorgu2"],
  "focusAreas": ["alan1", "alan2"]
}

Kullanıcı sorgusu: ${task.query}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task.query },
    ];

    const response: LLMResponse = await this.llmEngine.generateResponse(
      messages,
      undefined,
      systemPrompt
    );

    try {
      const plan = JSON.parse(response.content) as {
        mcpToolsNeeded?: string[];
        searchQueries?: string[];
        focusAreas?: string[];
      };

      return {
        mcpToolsNeeded: plan.mcpToolsNeeded || [],
        searchQueries: plan.searchQueries || [task.query],
        focusAreas: plan.focusAreas || [],
      };
    } catch (parseError) {
      logWarn('Araştırma planı JSON ayrıştırılamadı, varsayılan kullanılıyor', {
        taskId: task.id,
        error: (parseError as Error).message,
      });

      return {
        mcpToolsNeeded: [],
        searchQueries: [task.query],
        focusAreas: [],
      };
    }
  }

  /**
   * MCP aracını çağırır.
   */
  private async callMCPTool(
    toolName: string,
    plan: { mcpToolsNeeded: string[]; searchQueries: string[]; focusAreas: string[] },
    task: ResearchTask
  ): Promise<MCPCallResponse> {
    if (!this.mcpClient) {
      throw new Error('MCP client başlatılmamış');
    }

    // Tool ismi "server.tool" formatında olabilir
    const parts = toolName.split('.');
    const serverName = parts[0] as any;

    const callArgs: Record<string, unknown> = {
      query: task.query,
      searchQueries: plan.searchQueries,
      focusAreas: plan.focusAreas,
    };

    const request = {
      server: serverName,
      tool: toolName,
      arguments: callArgs,
      userId: task.userId,
      sessionId: task.sessionId,
    };

    logDebug('MCP tool çağrılıyor', { taskId: task.id, tool: toolName, server: serverName });

    return this.mcpClient.callTool(request);
  }

  /**
   * Toplanan verilerle nihai araştırma yanıtı oluşturur.
   */
  private async generateFinalAnswer(
    task: ResearchTask,
    plan: { mcpToolsNeeded: string[]; searchQueries: string[]; focusAreas: string[] },
    mcpResults: Record<string, unknown>,
    sources: ResearchSource[]
  ): Promise<{ summary: string; details: string }> {
    const mcpContext = Object.keys(mcpResults).length > 0
      ? `MCP Araç Sonuçları:\n${JSON.stringify(mcpResults, null, 2)}\n`
      : 'MCP araç sonucu bulunamadı.';

    const sourcesContext = sources.length > 0
      ? `Kaynaklar:\n${sources.map((s, i) => `${i + 1}. ${s.name} (${s.type})${s.url ? ' - ' + s.url : ''}\n   Alıntı: ${s.snippet || ''}`).join('\n')}\n`
      : 'Kaynak bulunamadı.';

    const systemPrompt = `Sen Diji'nin arka plan araştırma asistanısın. Kullanıcının sorgusunu derinleştiren, kapsamlı bir araştırma raporu hazırlayacaksın.

KURALLAR:
1. Daima Türkçe yanıt ver
2. Kapsamlı, detaylı ve organized bir rapor yaz
3. Özet (summary) bölümünü kısa ve net tut
4. Detaylı bilgi (details) bölümünü geniş ve ayrıntılı yaz
5. Kaynakları参照 olarak göster
6. MCP araçlarından gelen verileri entegre et

ARAŞTIRMA PLANI:
- Odak alanları: ${plan.focusAreas.join(', ') || 'Belirtilmemiş'}
- Arama sorguları: ${plan.searchQueries.join(', ')}
- Kullanılan MCP araçları: ${plan.mcpToolsNeeded.join(', ') || 'Yok'}

${mcpContext}

${sourcesContext}

Kullanıcı sorgusu: ${task.query}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Aşağıdaki araştırma için kapsamlı bir Türkçe rapor hazırla: ${task.query}` },
    ];

    const response: LLMResponse = await this.llmEngine.generateResponse(
      messages,
      undefined,
      systemPrompt
    );

    // Yanıtı özet ve detay olarak böl
    const content = response.content || '';
    const summary = this.extractSummary(content);
    const details = content;

    return { summary, details };
  }

  /**
   * Uzun yanıttan özet kısmını çıkarır (ilk cümleler veya "Özet:" kısmı).
   */
  private extractSummary(content: string): string {
    // "Özet:" veya "Summary:" ile başlayan bölümü ara
    const summaryMatch = content.match(/^(Özet|Summary):\s*(.+?)(?=\n\n|\n[A-Z]|$)/is);
    if (summaryMatch) {
      return summaryMatch[2].trim();
    }

    // İlk iki cümleyi al
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length >= 2) {
      return sentences.slice(0, 2).join('. ') + '.';
    }

    return content.substring(0, 200) + '...';
  }

  /**
   * Şu anda işlemdeki görev ID'sini döner.
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  /**
   * Worker'ın çalışıp çalışmadığını döner.
   */
  isWorkerRunning(): boolean {
    return this.isRunning;
  }
}

export const createResearchWorker = (
  queue: ResearchQueue,
  llmEngine: LLMEngine,
  config: ResearchConfig,
  mcpClient?: MCPClient
): ResearchWorker => {
  return new ResearchWorker(queue, llmEngine, config, mcpClient);
};