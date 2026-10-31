import { AgentConfig } from '@diji/shared';
import { logger, logInfo, logError, logDebug, logWarn } from '@diji/shared';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMStreamChunk {
  content: string;
  tool_calls?: LLMToolCall[];
  done: boolean;
}

export interface LLMResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  /**
   * Reasoning (düşünme) modellerinin ham düşünme metni.
   * SADECE teşhis/telemetri içindir — asla TTS'e verilmez.
   */
  reasoning?: string;
}

export class LLMEngine {
  private config: AgentConfig['llm'];
  private isInitialized: boolean = false;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private apiKey: string;
  private timeoutMs: number;
  /**
   * Reasoning (düşünme) modelleri için ayrılan ek token bütçesi.
   *
   * Neden gerekli: `agent` gibi hibrit reasoning modelleri yanıt üretmeden
   * ÖNCE uzun bir "düşünme" metni üretir (gözlemlenen: ~4.500 karakter,
   * ~1.500 token). `max_tokens` bu düşünme metnini de kapsadığı için düşük
   * bütçede model `finish_reason: "length"` ile kesilir ve `content` BOŞ
   * kalır. Sesli asistan bu durumda hiçbir şey söylemez. Bu yüzden gerçek
   * yanıt bütçesinin üzerine ek bir rezerv ayrılır.
   */
  private reasoningReserve: number;
  /** Boş yanıt geldiğinde yapılacak en fazla yeniden deneme sayısı. */
  private static readonly MAX_EMPTY_RETRIES = 1;
  /**
   * Sunucuya gidebilecek MUTLAK üst sınır (token).
   *
   * Neden gerekli: bu modelde bütçe büyüdükçe model DAHA UZUN düşünüyor.
   * Ölçüm (aynı istem, `agent` modeli):
   *   max_tokens=2000  → 3.705 krkt düşünme → 21,3 sn
   *   max_tokens=4256  → 4.500+ krkt düşünme → 91,5 sn
   * Yani "bol bütçe ver, garanti olsun" yaklaşımı gecikmeyi 4 katına çıkarıyor.
   * Sesli asistan için üst sınır şarttır.
   */
  private static readonly ABSOLUTE_TOKEN_CAP = 2048;

  constructor(config: AgentConfig['llm']) {
    this.config = config;
    // Sondaki egik cizgiyi temizle: /v1/ + /chat/completions -> //chat/completions olmasin
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.apiKey = (config.apiKey ?? '').trim();
    this.timeoutMs = config.timeoutMs ?? 120000;
    this.reasoningReserve = config.reasoningReserve ?? 3072;
  }

  /**
   * Sağlayıcıyı ÇALIŞMA ZAMANINDA değiştirir (yerel ↔ DeepSeek).
   *
   * Neden `setModel`'den ayrı: model değişimi yalnızca istek gövdesindeki
   * `model` alanını değiştirir; sağlayıcı değişimi ise `baseUrl` + `apiKey`
   * alanlarını da değiştirir. Yalnızca modeli değiştirmek, DeepSeek model
   * adını yerel sunucuya göndermek gibi sessiz bir hataya yol açardı.
   *
   * Geçiş ATOMİKTİR: yeni uç nokta doğrulanmadan (healthCheck) eski
   * değerler korunur; doğrulama başarısız olursa hiçbir şey değişmez.
   */
  async setProvider(next: {
    baseUrl: string;
    model: string;
    apiKey: string;
    apiKeyFile?: string;
  }): Promise<{ previousBaseUrl: string; previousModel: string }> {
    const baseUrl = String(next.baseUrl ?? '').replace(/\/+$/, '');
    const model = String(next.model ?? '').trim();
    if (!baseUrl) throw new Error('baseUrl boş olamaz');
    if (!model) throw new Error('model boş olamaz');

    const previous = {
      previousBaseUrl: this.baseUrl,
      previousModel: this.model,
    };
    const previousKey = this.apiKey;

    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = String(next.apiKey ?? '').trim();

    try {
      await this.healthCheck();
    } catch (error) {
      // Geri al: doğrulanmamış bir uç noktada kalmak her turu bozardı.
      this.baseUrl = previous.previousBaseUrl;
      this.model = previous.previousModel;
      this.apiKey = previousKey;
      throw error;
    }

    logInfo('LLM saglayicisi degistirildi', {
      baseUrl: this.baseUrl,
      model: this.model,
      hasKey: this.apiKey.length > 0,
    });
    return previous;
  }

  /** Etkin uç nokta (arayüz teşhisi için; anahtar ASLA dönmez). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Anahtar tanımlı mı (içeriği sızdırmadan). */
  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Sunucuya gönderilecek toplam `max_tokens`.
   * `maxTokens` yalnızca KULLANICIYA dönen yanıt için ayrılmıştır; buna
   * reasoning rezervi eklenir. Rezerv 0 ise davranış eskisiyle aynıdır.
   *
   * Sonuç `ABSOLUTE_TOKEN_CAP` ile sınırlanır: bütçe büyüdükçe modelin
   * düşünme süresi de büyüdüğü için sınırsız bütçe gecikmeyi patlatır.
   */
  private totalTokenBudget(multiplier: number = 1): number {
    const reserve = Math.max(0, Math.floor(this.reasoningReserve * multiplier));
    const tokens = Math.max(1, Math.floor(this.maxTokens * multiplier));
    return Math.min(tokens + reserve, LLMEngine.ABSOLUTE_TOKEN_CAP);
  }

  /**
   * Boş yanıt nedenini teşhis eder. Yalnızca loglama amaçlıdır.
   */
  private describeEmptyResponse(
    finishReason: string | undefined,
    reasoningLength: number
  ): string {
    if (reasoningLength > 0) {
      return (
        `Yanıt boş kaldı (finish_reason=${finishReason ?? 'bilinmiyor'}, ` +
        `düşünme metni ${reasoningLength} karakter). Model token bütçesini ` +
        'düşünmeye harcadı. DIJI_LLM_REASONING_RESERVE değerini artırın.'
      );
    }
    return `Yanıt boş kaldı (finish_reason=${finishReason ?? 'bilinmiyor'}).`;
  }

  /**
   * Tum LLM isteklerinde kullanilan basliklar.
   * OpenAI uyumlu sunucular `Authorization: Bearer <key>` bekler; anahtar
   * bos ise baslik gonderilmez (bazi yerel sunucular reddedebilir).
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      logInfo('LLM motoru başlatılıyor', {
        baseUrl: this.baseUrl,
        model: this.model,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      });

      // Bağlantı testi için basit bir istek gönder
      await this.healthCheck();

      this.isInitialized = true;
      logInfo('LLM motoru başarıyla başlatıldı', { model: this.model });
    } catch (error) {
      logError('LLM motoru başlatılamadı', error as Error, {
        baseUrl: this.baseUrl,
        model: this.model,
      });
      throw error;
    }
  }

  /**
   * Modeli ÇALIŞMA ZAMANINDA değiştirir.
   *
   * Neden yeniden başlatma gerekmez: model adı her istekte gövdede
   * (`model: this.model`) gönderilir; motorun kendi durumu yoktur. Yerel
   * OpenAI uyumlu sunucu (llama.cpp / Ollama) modeli istek başına çözer.
   *
   * Yine de yeni ad TAM olarak doğrulanır: sunucudaki `/models` listesinde
   * yoksa geçiş yapılmaz, aksi halde her tur sessizce boş yanıt dönerdi.
   */
  async setModel(model: string): Promise<{ previous: string; model: string }> {
    const next = String(model ?? '').trim();
    if (!next) throw new Error('Model adi bos olamaz');
    if (next === this.model) return { previous: this.model, model: this.model };

    const previous = this.model;
    this.model = next;
    try {
      // `healthCheck` yeni modelin sunucuda listelendiğini doğrular; listede
      // yoksa yalnızca UYARI verir (bazı yönlendiriciler dinamik eşler), bu
      // yüzden burada elle bir liste kontrolü yapmıyoruz.
      await this.healthCheck();
    } catch (error) {
      this.model = previous;
      throw error;
    }

    logInfo('LLM modeli degistirildi', { previous, model: this.model });
    return { previous, model: this.model };
  }

  /** Etkin model adı (arayüz ve telemetri için). */
  getModelName(): string {
    return this.model;
  }

  private async healthCheck(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.buildHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `LLM sunucusu ${response.status} ${response.statusText} döndürdü (${this.baseUrl}). ` +
            'Sunucunun OpenAI uyumlu bir /v1 uç noktası sunduğunu doğrulayın.'
        );
      }

      // Modelin gerçekten yüklü olduğunu doğrula (erken hata, geç sürprizden iyidir).
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const available = (payload.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === 'string');

      if (available.length > 0 && !available.includes(this.model)) {
        // Model listelenmiyorsa uyari ver ama baslatmayi engelleme:
        // bazi yonlendiriciler modeli dinamik olarak eslestirir.
        logWarn(
          `Yapılandırılmış model sunucuda listelenmiyor: ${this.model}. ` +
            `Mevcut modeller: ${available.join(', ')}. ` +
            'DIJI_LLM_MODEL ile değiştirebilirsiniz.'
        );
      } else if (available.length > 0) {
        logInfo('LLM modeli sunucuda dogrulandi', {
          model: this.model,
          available: available.length,
        });
      }
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `zaman aşımı (5 sn)`
          : error instanceof Error
            ? error.message
            : String(error);

      const authHint = this.apiKey
        ? '  3) API anahtarı doğru mu?  DIJI_LLM_API_KEY ile değiştirilebilir.'
        : '  3) Sunucu API anahtarı bekliyor olabilir: DIJI_LLM_API_KEY ayarlayın.';

      throw new Error(
        `LLM sunucusuna ulaşılamadı: ${this.baseUrl} — ${reason}\n` +
          'Kontroller:\n' +
          '  1) Yerel model sunucusu çalışıyor mu?\n' +
          `  2) "${this.model}" modeli mevcut mu?  (/v1/models ile kontrol edin)\n` +
          `${authHint}\n` +
          '  Adres: DIJI_LLM_BASE_URL ile değiştirilebilir.'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async generateResponse(
    messages: LLMMessage[],
    tools?: LLMTool[],
    systemPrompt?: string,
    /**
     * Dış iptal sinyali (barge-in).
     *
     * NEDEN: `generateResponse` yedek yol olarak akıştan çağrılır. Kullanıcı
     * sözünü kestiğinde akıştaki istek iptal edilirken bu yedek istek ayakta
     * kalıyordu ve iptal edilmiş tur için 1,5 saniyelik boşa bekleme
     * yaratıyordu. Sinyal dışarıdan verilirse iki istek birlikte ölür.
     */
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    if (!this.isInitialized) {
      throw new Error('LLM motoru başlatılmamış');
    }

    const requestMessages: LLMMessage[] = [];

    if (systemPrompt) {
      requestMessages.push({ role: 'system', content: systemPrompt });
    }

    requestMessages.push(...messages);

    let lastReasoning = '';

    // Ilk deneme normal butcede; yanit bossa butce artirilarak bir kez
    // yeniden denenir. Reasoning modelleri dusunmeye butce harcadiginda
    // ikinci deneme basarili olur.
    for (let attempt = 0; attempt <= LLMEngine.MAX_EMPTY_RETRIES; attempt++) {
      const budget = this.totalTokenBudget(attempt === 0 ? 1 : 2);

      const requestBody: Record<string, unknown> = {
        model: this.model,
        messages: requestMessages,
        temperature: this.temperature,
        max_tokens: budget,
        stream: false,
      };

      if (tools && tools.length > 0) {
        requestBody['tools'] = tools;
        requestBody['tool_choice'] = 'auto';
      }

      logDebug('LLM isteği gönderiliyor', {
        messageCount: requestMessages.length,
        hasTools: tools ? tools.length > 0 : false,
        hasSystemPrompt: !!systemPrompt,
        maxTokens: budget,
        attempt: attempt + 1,
      });

      /*
       * İKİ SİNYAL, TEK FETCH.
       *
       * `AbortSignal.any()` iki sinyalden biri iptal olduğunda yok eder:
       * zaman aşımı (bu sınıfın kendi koruması) veya dış iptal (barge-in).
       * Bu yüzden kendi controller'ımızı atmıyoruz — zaman aşımı hâlâ
       * gerekli, aksi halde sunucu yanıt vermezse istek sonsuza kadar asılı
       * kalır ve `isProcessing` kilitlenir.
       */
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;

      try {
        // Dış sinyal zaten iptal edilmişse sunucuya hiç gitme.
        externalSignal?.throwIfAborted();

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `LLM API hatası: ${response.status} ${response.statusText} - ${errorText}`
          );
        }

        const data: any = await response.json();

        const choice = data.choices?.[0];
        // `content` KULLANICIYA dönen yanıttır. `reasoning_content` /
        // `reasoning` alanları dusunme metnidir ve ASLA seslendirilmez.
        const content: string = choice?.message?.content || '';
        const reasoning: string =
          choice?.message?.reasoning_content || choice?.message?.reasoning || '';
        const finishReason: string | undefined = choice?.finish_reason;
        const toolCalls = choice?.message?.tool_calls as LLMToolCall[] | undefined;

        if (reasoning) lastReasoning = reasoning;

        logDebug('LLM yanıtı alındı', {
          contentLength: content.length,
          reasoningLength: reasoning.length,
          finishReason: finishReason ?? 'bilinmiyor',
          toolCallCount: toolCalls?.length || 0,
        });

        const hasToolCalls = !!toolCalls && toolCalls.length > 0;

        // Bos yanit + arac cagrisi yok => model butceyi dusunmeye harcadi.
        if (!content.trim() && !hasToolCalls) {
          if (attempt < LLMEngine.MAX_EMPTY_RETRIES) {
            logWarn(
              this.describeEmptyResponse(finishReason, reasoning.length) +
                ' Daha büyük bütçeyle yeniden deneniyor.'
            );
            continue;
          }
          logError(
            this.describeEmptyResponse(finishReason, reasoning.length),
            undefined,
            { model: this.model }
          );
        }

        return {
          content,
          tool_calls: toolCalls,
          reasoning: lastReasoning || undefined,
        };
      } catch (error) {
        logError('LLM yanıt oluşturma hatası', error as Error, {
          model: this.model,
        });
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Döngü yalnızca tüm denemeler boş dönerse buraya ulaşır.
    return { content: '', reasoning: lastReasoning || undefined };
  }

  async *generateResponseStream(
    messages: LLMMessage[],
    tools?: LLMTool[],
    systemPrompt?: string,
    /**
     * Dış iptal sinyali (barge-in).
     *
     * NEDEN: akışlı tur çalışırken kullanıcı sözünü kestiğinde bu jeneratör
     * `return()` ile kapatılır; ancak kapanış yalnızca bir sonraki `yield`
     * noktasında etkili olur. Okuma (`reader.read()`) sunucu yeni bayt
     * gönderene kadar asılı kaldığı için, jeneratörün beklemesini kesmek
     * üzere `fetch` çağrısına dış sinyal bağlanır. Sinyal iptal edilince
     * okuma reddedilir ve akış anında kapanır.
     */
    externalSignal?: AbortSignal
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    if (!this.isInitialized) {
      throw new Error('LLM motoru başlatılmamış');
    }

    try {
      const requestMessages: LLMMessage[] = [];

      if (systemPrompt) {
        requestMessages.push({ role: 'system', content: systemPrompt });
      }

      requestMessages.push(...messages);

      const requestBody: Record<string, unknown> = {
        model: this.model,
        messages: requestMessages,
        temperature: this.temperature,
        // Reasoning rezervi akisli modda da gereklidir; aksi halde dusunme
        // metni butceyi tuketir ve `content` hic gelmez. Butce tavani
        // (ABSOLUTE_TOKEN_CAP) akista da gecerlidir: daha buyuk butce modeli
        // daha uzun dusundurur ve gecikmeyi patlatir.
        max_tokens: this.totalTokenBudget(1),
        stream: true,
      };

      if (tools && tools.length > 0) {
        requestBody['tools'] = tools;
        requestBody['tool_choice'] = 'auto';
      }

      logDebug('LLM akışlı istek gönderiliyor', {
        messageCount: requestMessages.length,
        hasTools: tools ? tools.length > 0 : false,
      });

      // Zaman aşımı sinyali ile dış (barge-in) sinyali birleştirilir:
      // hangisi önce iptal olursa istek ölür (bkz. `generateResponse`).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;

      try {
        externalSignal?.throwIfAborted();

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LLM API hatası: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('LLM yanıt akışı okunamadı');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let currentToolCallIndex: number | null = null;
        let currentToolCallId = '';
        let currentToolCallName = '';
        let currentToolCallArgs = '';
        /** Kullaniciya giden (seslendirilebilir) metin geldi mi? */
        let yieldedContent = false;
        /** Dusunme metni uzunlugu — yalnizca teshis icin. */
        let reasoningLength = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine.startsWith('data:')) continue;

              const dataStr = trimmedLine.slice(5).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                // Reasoning deltalari ASLA seslendirilmez. Bazi sunucular
                // bunlari `reasoning_content`, bazilari `reasoning` alaninda
                // gonderir; ikisi de yalnizca sayilir.
                const reasoningDelta: string =
                  delta.reasoning_content || delta.reasoning || '';
                if (reasoningDelta) {
                  reasoningLength += reasoningDelta.length;
                }

                const content = delta.content || '';
                const toolCalls = delta.tool_calls;

                if (content) {
                  yieldedContent = true;
                  yield { content, done: false };
                }

                if (toolCalls && Array.isArray(toolCalls)) {
                  for (const tc of toolCalls) {
                    if (tc.index !== undefined && tc.index !== currentToolCallIndex) {
                      if (currentToolCallIndex !== null) {
                        yield {
                          content: '',
                          tool_calls: [
                            {
                              id: currentToolCallId,
                              type: 'function',
                              function: {
                                name: currentToolCallName,
                                arguments: currentToolCallArgs,
                              },
                            },
                          ],
                          done: false,
                        };
                      }
                      currentToolCallIndex = tc.index;
                      currentToolCallId = tc.id || '';
                      currentToolCallName = tc.function?.name || '';
                      currentToolCallArgs = '';
                    }

                    if (tc.function?.arguments) {
                      currentToolCallArgs += tc.function.arguments;
                    }
                  }
                }
              } catch (parseError) {
                // Geçersiz JSON parçasını atla
                logDebug('LLM akış parası ayrıştırılamadı', { line: trimmedLine.substring(0, 100) });
              }
            }
          }

          // Son tool çağrısını yield et
          if (currentToolCallIndex !== null) {
            yield {
              content: '',
              tool_calls: [
                {
                  id: currentToolCallId,
                  type: 'function',
                  function: {
                    name: currentToolCallName,
                    arguments: currentToolCallArgs,
                  },
                },
              ],
              done: false,
            };
          }

          // Geri donus: akis yalnizca dusunme metni uretip icerik vermediyse
          // (butce tavani yetmedi), akis disi moda dusulur. Kullaniciyi bos
          // yanitla birakmak yerine kucuk ek maliyetle yanit alinir.
          if (!yieldedContent && currentToolCallIndex === null) {
            logWarn(
              'LLM akışı içerik üretmedi — akışsız moda geçiliyor. ' +
                `(düşünme: ${reasoningLength} karakter)`
            );

            // Yedek istek de AYNI sinyale bağlanır: aksi halde akış iptal
            // edilirken yedek istek ayakta kalıp iptal edilmiş tur için
            // 1,5 saniye boşa bekletiyordu.
            const fallback = await this.generateResponse(
              messages,
              tools,
              systemPrompt,
              externalSignal
            );

            if (fallback.content) {
              yield { content: fallback.content, done: false };
            } else if (fallback.tool_calls && fallback.tool_calls.length > 0) {
              yield {
                content: '',
                tool_calls: fallback.tool_calls,
                done: false,
              };
            }
          }

          yield { content: '', done: true };
        } finally {
          reader.releaseLock();
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      logError('LLM akışlı yanıt hatası', error as Error, {
        model: this.model,
      });
      throw error;
    }
  }

  async generateTurkishResponse(
    userMessage: string,
    conversationHistory: LLMMessage[] = [],
    tools?: LLMTool[]
  ): Promise<LLMResponse> {
    const systemPrompt = `Sen Diji, Türkçe konuşan bir sesli asistanısın. Kullanıcılarla Türkçe iletişim kurarsın.

KURALLAR:
1. Daima Türkçe yanıt ver
2. Doğal, samimi ve yardımsever bir ton kullan
3. Kısa ve öz yanıtlar ver (sesli asistan için uygun)
4. Tool çağrısı gerekiyorsa, uygun tool'u seç ve parametreleri doldur
5. Kullanıcının niyetini doğru anla ve uygun eylemi al
6. Türkçe dil kurallarına uygun konuş
7. Her zaman kısa ve öz cevap ver; yanıtı en fazla 1-2 cümlede tut, gereksiz açıklama ve madde işaretli liste kullanma
8. Yeteneklerini, özelliklerini veya yapabildiklerini asla sayma; "şunları yapabilirim:" tarzı liste verme, kendini tanıtmaya girme, araç veya yetenek adı sıralama ("e-posta, takvim, dosya, mesajlaşma gibi" gibi). Kullanıcı "neler yapabiliyorsun" veya "kendini tanıt" dese bile tek kısa cümleyle geç

Kullanıcı mesajı: ${userMessage}`;

    const messages: LLMMessage[] = [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];

    return this.generateResponse(messages, tools, systemPrompt);
  }

  async *generateTurkishResponseStream(
    userMessage: string,
    conversationHistory: LLMMessage[] = [],
    tools?: LLMTool[]
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const systemPrompt = `Sen Diji, Türkçe konuşan bir sesli asistanısın. Kullanıcılarla Türkçe iletişim kurarsın.

KURALLAR:
1. Daima Türkçe yanıt ver
2. Doğal, samimi ve yardımsever bir ton kullan
3. Kısa ve öz yanıtlar ver (sesli asistan için uygun)
4. Tool çağrısı gerekiyorsa, uygun tool'u seç ve parametreleri doldur
5. Kullanıcının niyetini doğru anla ve uygun eylemi al
6. Türkçe dil kurallarına uygun konuş
7. Her zaman kısa ve öz cevap ver; yanıtı en fazla 1-2 cümlede tut, gereksiz açıklama ve madde işaretli liste kullanma
8. Yeteneklerini, özelliklerini veya yapabildiklerini asla sayma; "şunları yapabilirim:" tarzı liste verme, kendini tanıtmaya girme, araç veya yetenek adı sıralama ("e-posta, takvim, dosya, mesajlaşma gibi" gibi). Kullanıcı "neler yapabiliyorsun" veya "kendini tanıt" dese bile tek kısa cümleyle geç

Kullanıcı mesajı: ${userMessage}`;

    const messages: LLMMessage[] = [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];

    yield* this.generateResponseStream(messages, tools, systemPrompt);
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logInfo('LLM motoru kapatıldı', { model: this.model });
  }
}

export const createLLMEngine = (config: AgentConfig['llm']): LLMEngine => {
  return new LLMEngine(config);
};