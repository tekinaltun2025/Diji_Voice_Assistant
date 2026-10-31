import {
  AgentConfig,
  AgentMessage,
  llmProviderPreset,
  logDebug,
  logError,
  logger,
  logInfo,
  logWarn,
  MCPCallRequest,
  MCPCallResponse,
  MCPServerConfig,
  MCPTool,
  STTConfig,
  TTSConfig,
  TurnDetectorConfig,
  VADConfig,
  VoiceSession,
} from '@diji/shared';
import * as fs from 'fs';
import * as path from 'path';
import {
  createMicrophoneInput,
  createSpeakerOutput,
  isAecInUse,
  MicrophoneInput,
  SpeakerOutput,
} from './audio-io';
import { EchoGuard, softwareAecEnabled } from './echo-guard';
import {
  LLMEngine,
  LLMMessage,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
} from './llm';
import { MCPClient, VoiceConfirmationRequest } from './mcp-client';
import { readApiKeyFile, writeApiKeyFile, writeEnvVars } from './env-prefs';
import {
  assertModelSelectable,
  buildModelCatalog,
  scanLlmModels,
  type ModelCatalog,
  type ModelKind,
} from './model-catalog';
import {
  createQueryClassifier,
  createResearchNotifier,
  createResearchQueue,
  createResearchWorker,
  DEFAULT_RESEARCH_CONFIG,
  ResearchPriority,
  ResearchTask,
} from './research';
import { STTEngine, STTResult, STTStreamEvent } from './stt';
import { TTSEngine, TTSResult } from './tts';
import { TurkishTurnDetector, TurnDetectorResult } from './turn-detector';
import { VADProcessor, VADResult, VADStreamEvent } from './vad';
import {
  telemetry,
  TurnLatency,
  type ConversationEntry,
  type PendingConfirmation,
} from './telemetry';

/**
 * TTS ana anahtarı. `DIJI_TTS_ENABLED=0` (veya false/off/no) ile seslendirme
 * tamamen kapanır: yanıtlar yalnızca metin olarak iletilir, hoparlöre hiçbir
 * şey yazılmaz. Değer her turda okunur; böylece `~/.config/diji/env` gibi
 * geç yüklenen kaynaklardan gelen ayar da geçerli olur.
 *
 * Çalışma zamanı anahtarı (`pipeline.ttsOverride`) verilmişse ortam
 * değişkenini GÖLGELER: kullanıcı tepsi/arayüzden sesi kapatıp açtığında
 * süreç yeniden başlatılmak zorunda kalmaz (`process.env` çalışan bir Node
 * sürecinde dışarıdan değiştirilemez).
 */
/**
 * MCP araç adını sağlayıcı-güvenli biçime indirger.
 *
 * OpenAI uyumlu katı sağlayıcılar (DeepSeek dahil) araç adında yalnızca
 * `^[a-zA-Z0-9_-]+$` kabul eder. MCP araç adları ise `sunucu.arac` biçiminde
 * sunuluyordu ve nokta bu kalıbı bozuyordu — canlı doğrulamada her tur
 * `400 Bad Request: Invalid 'tools[0].function.name'` ile düşüyordu.
 */
function sanitizeToolPart(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * `sunucu` + `arac` → `sunucu__arac`.
 *
 * Çift alt çizgi ayırıcıdır: tek alt çizgi araç adlarının kendisinde
 * bulunabildiği için (`list_channels`) belirsizlik yaratırdı.
 */
function mcpToolName(server: string, tool: string): string {
  const s = sanitizeToolPart(server) || 'server';
  const t = sanitizeToolPart(tool) || 'tool';
  return `${s}__${t}`;
}

function ttsDisabled(pipeline?: VoicePipeline): boolean {
  const override = pipeline?.getTtsOverride();
  if (override !== null && override !== undefined) return !override;
  return /^(0|false|off|no)$/i.test(process.env.DIJI_TTS_ENABLED ?? '1');
}

export interface PipelineEvent {
  type:
    | 'stt-partial'
    | 'stt-final'
    | 'vad-speech-start'
    | 'vad-speech-end'
    | 'turn-detected'
    | 'llm-streaming'
    | 'llm-complete'
    | 'tts-speaking'
    | 'tts-complete'
    | 'tts-toggle'
    | 'turn-latency'
    | 'mcp-call'
    | 'mcp-complete'
    | 'mcp-confirmation-required'
    | 'barge-in'
    | 'model-change'
    | 'error'
    | 'state-change';
  data: unknown;
  timestamp: Date;
  sessionId: string;
}

/**
 * `selectModel()` sonucu — kontrol sunucusunun arayüze döndürdüğü sözleşme.
 *
 * `persisted`, seçimin `~/.config/diji/env` dosyasına yazılıp yazılmadığını
 * söyler. `false` ise model DEĞİŞMİŞTİR (bu süreçte geçerli) ama ajan
 * yeniden başlarsa eski model döner — arayüz bunu `persistError` ile birlikte
 * dürüstçe gösterir.
 */
export interface ModelSelectOutcome {
  ok: boolean;
  /** Değişiklikten sonra ÇALIŞAN model kimliği. */
  current?: string;
  /** `ok:false` ise nedeni. */
  reason?: string;
  /** Geçiş uzun sürdü mü (drifting-tts Python köprüsü). */
  slow?: boolean;
  /** Seçim kalıcı olarak yazıldı mı. */
  persisted?: boolean;
  /** Kalıcılık yazılamadıysa nedeni. */
  persistError?: string;
}

export interface PipelineState {
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  isBargeIn: boolean;
  lastTranscript: string;
  lastResponse: string;
  currentSession: VoiceSession | null;
  /**
   * Son tamamlanan turun uçtan uca gecikmesi (tur başlangıcı → ilk ses çıkışı).
   * `null` = henüz ölçülmüş tur yok. Arayüz bunu HAT TELEMETRİSİ panelinin
   * en üstünde sürekli gösterir.
   */
  lastTurnLatency: TurnLatency | null;
}

export class VoicePipeline {
  private config: AgentConfig;
  private isRunning: boolean = false;
  private sessionId: string = '';
  private currentSession: VoiceSession | null = null;

  // Engine'ler
  private llmEngine: LLMEngine | null = null;
  private sttEngine: STTEngine | null = null;
  private ttsEngine: TTSEngine | null = null;
  private vadProcessor: VADProcessor | null = null;
  private turnDetector: TurkishTurnDetector | null = null;
  private mcpClient: MCPClient | null = null;

  // Research modülü
  private researchQueue: ReturnType<typeof createResearchQueue> | null = null;
  private researchWorker: ReturnType<typeof createResearchWorker> | null = null;
  private researchClassifier: ReturnType<typeof createQueryClassifier> | null = null;
  private researchNotifier: ReturnType<typeof createResearchNotifier> | null = null;

  // State
  private state: PipelineState = {
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
    isBargeIn: false,
    lastTranscript: '',
    lastResponse: '',
    currentSession: null,
    lastTurnLatency: null,
  };

  /**
   * Kullanıcının Ayarlar ekranından seçtiği modeller.
   *
   * Boş nesne = yapılandırma/ortam geçerli. Seçim yapıldığında **hem**
   * çalışma zamanına uygulanır **hem de** `~/.config/diji/env` dosyasına
   * yazılır (bkz. `persistModelChoice`); yani ajan yeniden başladığında da
   * geçerli olur. Bu alan yalnızca "bu süreçte ne seçildi" bilgisini tutar.
   */
  private modelOverride: { stt?: string; tts?: string; llm?: string } = {};

  /** Model değişimi sürerken eşzamanlı istekleri kilitleyen bayrak. */
  private isModelSwitching = false;

  /**
   * Tur başlangıç damgası (ms).
   *
   * NEDEN: "Toplam cevap süresi" tek bir referans noktası ister. Sesli yolda bu
   * nokta **`flushSpeechSegment()` girişidir**: VAD sessizlik eşiğini geçirip
   * segmenti kapattığı ve STT'nin FİİLEN başladığı an. Sessizlik beklentisi
   * (800 ms) kullanıcının konuşmasına ait olduğu için cevap süresine katılmaz;
   * böylece ölçülen toplam, aşama sürelerinin (STT→LLM→MCP→TTS) toplamıyla
   * birebir karşılaştırılabilir. Metin yolunda (`/ask`) istek kabul anıdır.
   *
   * Çok segmentli turlarda (turn detector "devam" dedi) YENİDEN yazılmaz;
   * ilk segmentin başlangıcı korunur.
   */
  private turnStartedAt: number | null = null;

  /** Tur gecikmesi bu turda yayınlandı mı? (çift yayını önler) */
  private turnLatencyPublished: boolean = false;

  /**
   * Tur kimliği. `speakResponse()` çalma bitene kadar beklediği için önceki
   * turun `finally` bloğu bir sonraki turun ölçümünü sıfırlayabiliyordu
   * (canlı ölçümde `totalMs = 0` olarak gözlendi). Her tur kendi kimliğini
   * taşır; kapanış yalnızca kimlik hâlâ geçerliyse ölçüm yayınlar.
   */
  private turnToken: number = 0;

  // Event callbacks
  private eventCallbacks: Map<string, Array<(event: PipelineEvent) => void>> = new Map();

  // Barge-in control
  private isTtsSpeaking: boolean = false;
  private abortController: AbortController | null = null;

  /**
   * Tur nesli (generation) sayacı.
   *
   * NEDEN GEREKLİ: `handleBargeIn()` çalışan turu iptal eder ama Node'da
   * iptal "öldürme" değildir — iptal edilen turun `finally` blokları ve
   * `await` sonrası devam eden satırları çalışmaya devam eder. Eskiden bu
   * satırlar YENİ turun durumunu eziyordu (canlı gözlem: kullanıcı sözünü
   * kestiğinde `isProcessing` yanlışlıkla `false`/`true` arasında kalıyor,
   * sonraki tur sessizce atlanıyordu).
   *
   * Çözüm: her tur başında bu sayaç artırılır. Tur içindeki her durum yazımı
   * kendi neslini doğrular; nesli eskimişse yazmaz.
   */
  private turnGeneration: number = 0;

  /**
   * Akışlı yanıt sırasında şu ana kadar ÜRETİLEN metin.
   *
   * NEDEN: Kullanıcı asistanı yarıda keserse üretilen kısım kaybolmamalı;
   * `handleBargeIn()` bu metni `" [kullanıcı sözü kesti]"` işaretiyle sohbet
   * geçmişine yazar, böylece model sonraki turda nerede kaldığını bilir.
   */
  private partialAssistantText: string = '';

  /**
   * Akışlı TTS cümle kuyruğunun sıralı zinciri.
   *
   * NEDEN: Cümleler LLM'den geldikçe sentezlenip çalınır. Ayrı ayrı
   * `await` edilmediğinde (amaç: akışı bloklamamak) iki cümle aynı anda
   * hoparlöre yazılabilir ve ses karışır. Zincir, çalmayı serileştirirken
   * sentezin akışla paralel ilerlemesini korur.
   */
  private ttsChain: Promise<void> = Promise.resolve();

  /**
   * Otomatik VAD barge-in için ardışık sesli parça sayacı.
   *
   * NEDEN 3 parça: 100 ms'lik parçalarda tek bir parça kapı çarpması, öksürük
   * veya yankı artığı olabilir. 3 ardışık parça (~300 ms kesintisiz konuşma)
   * gerçek bir müdahale ile paraziti ayırır.
   */
  private consecutiveVoiceChunks: number = 0;

  /** Otomatik VAD barge-in eşiği (ardışık parça). */
  private static readonly BARGEIN_VOICE_CHUNKS = 3;

  /**
   * Yazılımsal yankı kapılaması.
   *
   * Donanımsal AEC bu makinede çalışmıyor (düğümler sessizlik üretiyor),
   * bu yüzden asistan konuşurken mikrofonun duyduğu kendi sesini ayıklamak
   * için referans tabanlı kapılama kullanılır. `null` ise katman kapalıdır
   * (`DIJI_AEC_SOFTWARE=0`) ve otomatik barge-in güvenli tarafta kalır.
   */
  private echoGuard: EchoGuard | null = null;

  /**
   * Bastırılan parça sayacı — günlüğü her parçada doldurmamak için.
   * Her 50 bastırmada bir özet satırı yazılır.
   */
  private suppressedSinceLog: number = 0;

  /**
   * Akışlı turda hoparlöre YAZILAN ilk PCM'in zaman damgası.
   *
   * NEDEN alan: seslendirme artık turun içinden cümle cümle tetikleniyor;
   * ayrı bir `speakResponse()` çağrısı yok. `totalMs` ölçümü bu damgaya
   * dayanır (ses çıkışı = kullanıcının beklediği an).
   */
  private turnFirstAudioAt: number | null = null;

  /**
   * Otomatik (VAD kaynaklı) barge-in açık mı?
   *
   * DÖRT KADEMELİ KARAR — kullanıcı > yazılımsal koruma > donanım > kapalı:
   *
   *   1. `DIJI_BARGEIN_AUTO` açıkça verildiyse o kazanır.
   *   2. Yazılımsal yankı kapılaması etkinse (`echoGuard` kurulu) AÇIK.
   *      Referans tabanlı katman asistanın kendi sesini ayıkladığı için
   *      kendini kesme riski ortadan kalkar — bu yüzden varsayılan açıktır.
   *   3. Donanımsal AEC FİİLEN kullanımda ise (`isAecInUse()`) AÇIK.
   *   4. Hiçbiri yoksa KAPALI.
   *
   * NEDEN kapalı bir varsayılan vardı: otomatik barge-in, yankı
   * silinmiyorken asistanın kendi sesini "kullanıcı konuşuyor" sanıp her
   * cümlede kendini kesmesine yol açar (sonsuz sessizlik). FAZ 20'de
   * yazılımsal katman eklendiği için artık 2. kademe devrededir ve özellik
   * insan müdahalesi olmadan çalışır.
   */
  private get autoBargeIn(): boolean {
    const raw = process.env.DIJI_BARGEIN_AUTO;
    if (raw !== undefined) return /^(1|true|yes|on)$/i.test(raw);
    // Yazılımsal AEC hazırsa yankı ayıklanıyor demektir; güvenle açılır.
    if (this.echoGuard !== null) return true;
    return isAecInUse();
  }

  /**
   * Çalışma zamanı TTS anahtarı.
   *
   * `null` = ortam değişkenine göre karar ver (varsayılan davranış).
   * `true` / `false` = kullanıcı tray/arayüzden açıkça seçti, env'i gölgeler.
   *
   * Neden: `process.env` çalışan Node sürecinde dışarıdan değiştirilemez;
   * kullanıcının yeniden başlatmadan sesi açıp kapatabilmesi için bu alan gerekir.
   */
  private ttsOverride: boolean | null = null;

  // Ses G/C: mikrofon ve hoparlor (opsiyonel — metin modunda yok)
  private microphone: MicrophoneInput | null = null;
  private speaker: SpeakerOutput | null = null;

  /**
   * Konusma segmenti biriktirici.
   *
   * Neden gerekli: `processAudio()` mikrofon akisindan ~100 ms'lik parcalar
   * alir. Her parcayi ayri ayri STT'ye gondermek anlamsizdir (Whisper cumle
   * baglamina ihtiyac duyar). Bu yuzden konusma basladiginda parcalar
   * burada biriktirilir, sessizlik esigi asildiginda TEK bir tampon olarak
   * STT'ye gonderilir.
   */
  private speechBuffer: Buffer[] = [];
  private speechBufferBytes: number = 0;
  private isInSpeech: boolean = false;
  private lastSpeechAt: number = 0;

  /** Tek bir turda biriktirilecek azami ses (guvenlik siniri, ~30 sn). */
  private static readonly MAX_SPEECH_BYTES = 32000 * 30;
  /**
   * Azami sessizlik suresi (ms) — bu sure sonunda segment kapanir.
   *
   * 2026-10-28: 800 → **600 ms**. Kullanıcı isteğiyle düşürüldü (daha hızlı
   * tur kapanışı). ⚠️ RİSK: Türkçe konuşmada cümle içi duraksamalar 600 ms'yi
   * aşabildiği için STT cümleyi ORTASINDAN kesebilir. Bu değer
   * `VADConfig.minSilenceDuration` (0,6 sn, Silero'nun kendi kararı) ile
   * AYNI seviyeye indi; ikisi artık tutarlı.
   */
  private static readonly SPEECH_END_SILENCE_MS = 600;

  /** LLM servisi erisilebilir mi? (yanit uretimi icin gerekli) */
  private isLlmReady: boolean = false;

  // Sesli onay: UI/ses katmanindan gelecek yaniti bekleyen promise
  private pendingConfirmation: {
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  /** Sesli onay icin beklenecek azami sure (ms). */
  private static readonly CONFIRMATION_TIMEOUT_MS = 15000;

  // Conversation history
  private conversationHistory: LLMMessage[] = [];

  constructor(config: AgentConfig) {
    this.config = config;
    this.sessionId = this.generateSessionId();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logWarn('Pipeline zaten calisiyor');
      return;
    }

    try {
      logInfo('Ses pipeline baslatiliyor', { sessionId: this.sessionId });

      // Engine'leri baslat
      await this.initializeEngines();

      // MCP client'i baslat
      await this.initializeMCPClient();

      // Research modülünü baslat
      await this.initializeResearchModule();

      this.isRunning = true;
      this.state.isListening = true;
      this.state.currentSession = this.currentSession;

      // Başlangıçta env değeri geçerli; override null kalır. Kullanıcının
      // önceki oturumdaki tray seçimi süreç ömrüyle birlikte biter — bu
      // kasıtlıdır: uygulama yeniden başlarsa `~/.config/diji/env` belirler.
      this.ttsOverride = null;

      // Panelin ilk açılışta doğru durumu göstermesi için TTS aşamasını
      // gerçek anahtara göre bildir (env'de 0 ise "kapalı", değilse "hazır").
      if (this.isTtsEnabled()) {
        telemetry.update('tts', 'ready', 'TTS açık', { durum: 'açık' });
        telemetry.update('playback', 'idle', 'bekliyor');
      } else {
        telemetry.update('tts', 'idle', 'TTS kapalı — ses üretmiyor', { durum: 'kapalı' });
        telemetry.update('playback', 'idle', 'TTS kapalı');
      }

      this.emit('state-change', { state: this.state });

      logInfo('Ses pipeline baslatildi', { sessionId: this.sessionId, ttsEnabled: this.isTtsEnabled() });
    } catch (error) {
      logError('Pipeline baslatilamadi', error as Error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logWarn('Pipeline zaten durdurulmus');
      return;
    }

    try {
      logInfo('Ses pipeline durduruluyor', { sessionId: this.sessionId });

      // Once mikrofonu kapat: kendi kapanis sesimizi dinlemeyelim.
      this.stopListening();

      // TTS'i durdur
      if (this.ttsEngine && this.ttsEngine.getIsSpeaking()) {
        await this.ttsEngine.stop();
      }

      // Hoparlor kuyrugunu bosalt ve kapat
      if (this.speaker) {
        await this.speaker.stop();
        this.speaker = null;
      }

      // Engine'leri kapat
      await this.disposeEngines();

      this.isRunning = false;
      this.state.isListening = false;
      this.state.isSpeaking = false;
      this.state.isProcessing = false;
      this.state.isBargeIn = false;

      this.emit('state-change', { state: this.state });

      logInfo('Ses pipeline durduruldu', { sessionId: this.sessionId });
    } catch (error) {
      logError('Pipeline durdurulurken hata', error as Error);
    }
  }

  private async initializeEngines(): Promise<void> {
    /*
     * Anahtar cozumlemesi AÇILIŞTA yapilir.
     *
     * `buildLlmDefaults()` uzak saglayicida `apiKey: ''` birakir — anahtar
     * `~/.config/diji/env` icine YAZILMAZ. Anahtar 0600 izinli ayri dosyada
     * durur. Burada okunmazsa, DeepSeek secili olarak yeniden baslatilan ajan
     * her turda 401 alirdi. Cozumleme sirasi:
     *   1. `config.llm.apiKey` (env'den acikca verilmisse)
     *   2. `process.env.DIJI_LLM_API_KEY`
     *   3. `apiKeyFile` (0600 ayri dosya)
     */
    const llmConfig = { ...this.config.llm };
    if (!(llmConfig.apiKey ?? '').trim()) {
      const fromEnv = (process.env.DIJI_LLM_API_KEY ?? '').trim();
      // Dosya YALNIZCA uzak saglayicida okunur: yerel saglayici anahtar
      // istemez ve `secrets/deepseek.key` yerel istege sizmamalidir.
      const fromFile =
        llmConfig.provider === 'deepseek' && llmConfig.apiKeyFile
          ? readApiKeyFile(llmConfig.provider)
          : '';
      llmConfig.apiKey = fromEnv || fromFile;
      if (!llmConfig.apiKey && llmConfig.provider === 'deepseek') {
        logWarn('DeepSeek secili ama API anahtari yok — Ayarlar ekranindan girin', {
          apiKeyFile: llmConfig.apiKeyFile,
        });
      }
    }

    const sttConfig = this.config.stt as unknown as STTConfig;
    const ttsConfig = this.config.tts as TTSConfig;
    const vadConfig = this.config.vad as VADConfig;
    const turnDetectorConfig = this.config.turnDetector as TurnDetectorConfig;

    this.llmEngine = new LLMEngine(llmConfig);
    this.sttEngine = new STTEngine(sttConfig, {
      modelDir: sttConfig.modelPath,
      modelPrefix: sttConfig.modelPrefix,
      modelPriority: sttConfig.modelPriority,
      numThreads: sttConfig.numThreads,
      executionProvider: sttConfig.executionProvider,
    });
    this.ttsEngine = new TTSEngine(ttsConfig, {
      modelPath: ttsConfig.modelPath,
      speakerId: ttsConfig.speakerId,
    });
    this.vadProcessor = new VADProcessor(vadConfig, {
      modelPath: vadConfig.modelPath,
    });
    this.turnDetector = new TurkishTurnDetector(turnDetectorConfig);

    // Ses bilesenleri zorunludur: bunlar olmadan asistan "sagir/dilsiz" olur
    // ve sessizce yanlis davranir. Basarisizlik acikca bildirilir.
    await this.sttEngine.initialize();
    await this.ttsEngine.initialize();
    await this.vadProcessor.initialize();
    await this.turnDetector.initialize();

    // LLM harici bir servistir (yerel model sunucusu). Calismiyorsa cevap
    // uretemeyiz; yine de pipeline ayakta kalir ki kullanici teshis edebilsin.
    try {
      await this.llmEngine.initialize();
      this.isLlmReady = true;
      logInfo('LLM motoru hazir');
    } catch (error) {
      this.isLlmReady = false;
      logError(
        'LLM motoru baslatilamadi — asistan yanit uretemeyecek. ' +
          'Sesli bilesenler (STT/TTS/VAD) calisiyor.',
        error as Error
      );
    }

    /*
     * YAZILIMSAL YANKI KAPILAMASI — motor kurulumundan SONRA, dinlemeden ÖNCE.
     *
     * Donanımsal AEC bu makinede çalışmıyor (zorlanmış düğümler sessizlik
     * üretiyor), bu yüzden asistan konuşurken kendi sesini ayıklayacak bir
     * katman şart. Katman hazırsa otomatik barge-in de güvenle açılır
     * (bkz. `autoBargeIn`).
     */
    if (softwareAecEnabled()) {
      this.echoGuard = new EchoGuard();
      logInfo('Yazilimsal yanki kapilamasi etkin (referans tabanli)', {
        gain: this.echoGuard.getStats().gain,
        note: 'Donanimsal AEC olmadan otomatik barge-in calisir',
      });
    } else {
      this.echoGuard = null;
      logWarn(
        'Yazilimsal yanki kapilamasi KAPALI (DIJI_AEC_SOFTWARE=0) — ' +
          'otomatik barge-in yalnizca donanimsal AEC varsa calisir'
      );
    }

    logInfo('Ses motorlari baslatildi', {
      stt: sttConfig.model,
      tts: ttsConfig.model,
      vad: vadConfig.provider,
      llmReady: this.isLlmReady,
      softwareAec: this.echoGuard !== null,
    });
  }

  /**
   * Research modülünü başlatır: queue, classifier, worker ve notifier.
   */
  private async initializeResearchModule(): Promise<void> {
    if (!this.llmEngine || !this.ttsEngine) {
      logWarn('Research modülü baslatilamadi: llmEngine veya ttsEngine hazir degil');
      return;
    }

    try {
      this.researchQueue = createResearchQueue();
      this.researchClassifier = createQueryClassifier(false, this.llmEngine);
      this.researchWorker = createResearchWorker(
        this.researchQueue,
        this.llmEngine,
        DEFAULT_RESEARCH_CONFIG,
        this.mcpClient || undefined
      );
      this.researchNotifier = createResearchNotifier();
      this.researchNotifier.setTTSEngine(this.ttsEngine);

      // Worker dongusu bloklayicidir; await edilirse pipeline baslatma
      // kilitlenir. Arka planda calistirilir.
      this.researchWorker.startInBackground();

      logInfo('Research modülü baslatildi', {
        llmModel: DEFAULT_RESEARCH_CONFIG.llmModel,
        baseUrl: DEFAULT_RESEARCH_CONFIG.llmBaseUrl,
        timeout: DEFAULT_RESEARCH_CONFIG.timeout,
      });
    } catch (error) {
      logError('Research modülü baslatilirken hata', error as Error);
    }
  }

  private async initializeMCPClient(): Promise<void> {
    if (!this.config.mcp.enabled) {
      logInfo('MCP devre disi birakildi');
      return;
    }

    this.mcpClient = new MCPClient(this.config.mcp.permissionGate);

    // MCP sunucu konfigurasyonlarini olustur
    const serverConfigs: MCPServerConfig[] = this.getMCPServerConfigs();

    await this.mcpClient.initialize(serverConfigs);

    // Ses onay callback'ini ayarla
    this.mcpClient.setVoiceConfirmationCallback(
      async (request: VoiceConfirmationRequest): Promise<boolean> => {
        return await this.requestVoiceConfirmation(request);
      }
    );

    logInfo('MCP client baslatildi', {
      connectedServers: this.mcpClient.getConnectedServerNames(),
    });
  }

  /**
   * MCP sunucularinin baslatma tanimlarini uretir.
   *
   * Onemli: Bu sunucular bu deponun icindeki yerel paketlerdir
   * (`mcp_servers/<ad>/dist/index.js`). npm registry'de ayni isimde
   * paketler yoktur; bu yuzden `npx <paket>` yerine dogrudan derlenmis
   * giris noktasi `node` ile calistirilir.
   */
  private getMCPServerConfigs(): MCPServerConfig[] {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const deleteAllowed = this.config.mcp.permissionGate.delete;

    const definitions: Array<{
      name: MCPServerConfig['name'];
      permissions: MCPServerConfig['permissions'];
    }> = [
      {
        name: 'gmail',
        permissions: { read: true, write: true, delete: false },
      },
      {
        name: 'calendar',
        // Takvim silme islemi yalnizca acikca izin verildiyse acilir.
        permissions: { read: true, write: true, delete: deleteAllowed },
      },
      {
        name: 'drive',
        permissions: { read: true, write: true, delete: deleteAllowed },
      },
      {
        name: 'notion',
        permissions: { read: true, write: true, delete: deleteAllowed },
      },
      {
        name: 'slack',
        permissions: { read: true, write: true, delete: false },
      },
      {
        name: 'chrome',
        permissions: { read: true, write: true, delete: false },
      },
    ];

    const overrides = this.config.mcp.servers ?? [];
    const configs: MCPServerConfig[] = [];

    for (const definition of definitions) {
      const override = overrides.find((item) => item.name === definition.name);
      const entryScript = path.join(repoRoot, 'mcp_servers', definition.name, 'dist', 'index.js');

      const existsOnDisk = fs.existsSync(entryScript);

      if (!existsOnDisk && !override?.command) {
        logWarn(
          `MCP sunucusu atlandi: derlenmis giris noktasi bulunamadi. ` +
            `Once "npm run build:mcp" calistirin.`,
          { server: definition.name, expectedPath: entryScript }
        );
        continue;
      }

      configs.push({
        name: definition.name,
        enabled: override?.enabled ?? true,
        command: override?.command ?? process.execPath,
        args: override?.args ?? [entryScript],
        env: {
          ...(override?.env ?? {}),
          LOG_LEVEL: process.env.LOG_LEVEL || 'info',
          // Alt surecler token'lari ayni yerde saklasin.
          ...(process.env.TOKEN_STORAGE_PATH
            ? { TOKEN_STORAGE_PATH: process.env.TOKEN_STORAGE_PATH }
            : {}),
          ...(process.env.ENCRYPTION_PASSWORD
            ? { ENCRYPTION_PASSWORD: process.env.ENCRYPTION_PASSWORD }
            : {}),
        },
        permissions: definition.permissions,
        requiresVoiceConfirmation: true,
      });
    }

    return configs;
  }

  private async disposeEngines(): Promise<void> {
    const disposePromises: Promise<void>[] = [];

    if (this.llmEngine) {
      disposePromises.push(this.llmEngine.dispose());
      this.llmEngine = null;
    }

    if (this.sttEngine) {
      disposePromises.push(this.sttEngine.dispose());
      this.sttEngine = null;
    }

    if (this.ttsEngine) {
      disposePromises.push(this.ttsEngine.dispose());
      this.ttsEngine = null;
    }

    if (this.vadProcessor) {
      disposePromises.push(this.vadProcessor.dispose());
      this.vadProcessor = null;
    }

    if (this.turnDetector) {
      disposePromises.push(this.turnDetector.dispose());
      this.turnDetector = null;
    }

    if (this.mcpClient) {
      disposePromises.push(this.mcpClient.dispose());
      this.mcpClient = null;
    }

    await Promise.all(disposePromises);
  }

  /**
   * Metin modu giris noktasi: STT'yi atlayarak dogrudan tur isler.
   * Mikrofon/hoparlor olmadan LLM + MCP + turn detector zincirini test eder.
   */
  async processText(userText: string): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Pipeline calismiyor');
    }

    const text = userText.trim();
    if (!text) return;

    // Metin yolu: tur başlangıcı = isteğin kabul edildiği an. STT atlandığı
    // için `sttMs` 0 kalır; toplam süre LLM + MCP + TTS'i kapsar.
    this.turnStartedAt = Date.now();
    this.turnLatencyPublished = false;
    this.turnToken = telemetry.turnStart(this.turnStartedAt, this.llmModelName());
    // Metin yolunda VAD hiç çalışmadı; `sttChars` girdi uzunluğudur.
    telemetry.setSttChars(text.length);

    this.state.lastTranscript = text;
    this.emit('stt-final', {
      text,
      isFinal: true,
      language: 'tr',
      confidence: 1,
    });

    await this.handleTurnEnd(text, 'text');
  }

  /**
   * Mikrofon akisindan gelen PCM parcasi (genelde ~100 ms).
   *
   * Onemli: burada STT CAGRILMAZ. Parcalar once VAD ile filtrelenir,
   * konusma boyunca `speechBuffer` icinde biriktirilir ve sessizlik
   * esigi asildiginda TEK bir tampon olarak `transcribeSegment()`'e
   * verilir. Whisper cumle baglami ister; 100 ms'lik parcalar uzerinde
   * anlamli transkripsiyon uretemez.
   */
  async processAudio(audioBuffer: Buffer): Promise<void> {
    if (!this.isRunning) {
      logWarn('Pipeline calismiyor, isleme atlaniyor');
      return;
    }

    /*
     * OTOMATİK VAD BARGE-IN.
     *
     * ESKİ DAVRANIŞ: `if (isBargeIn || isTtsSpeaking) return;` — asistan
     * konuşurken mikrofon TAMAMEN kapatılıyordu. Bu, yankı döngüsünü
     * engelliyordu ama kullanıcının asistanı kesmesini de imkânsız kılıyordu
     * (tek yol arayüzdeki düğmeydi).
     *
     * YENİ DAVRANIŞ: asistan konuşurken ses YOK SAYILMAZ, VAD ile dinlenir.
     * Ardışık 3 parça (~300 ms) ses algılanırsa `handleBargeIn()` çağrılır.
     *
     * ⚠️ GÜVENLİK: yankı engelleme (AEC) ÇALIŞMIYORKEN bu, asistanın kendi
     * sesini "kullanıcı" sanıp her cümlede kendini kesmesine yol açar.
     * Bu makinede PipeWire echo-cancel düğümü oluşmadığı için özellik
     * VARSAYILAN OLARAK KAPALIDIR (`DIJI_BARGEIN_AUTO=1` ile açılır).
     * AEC doğrulandıktan sonra açılması güvenlidir.
     */
    if (this.state.isBargeIn) {
      // Histerezis penceresi: barge-in sonrası hoparlör susana kadar
      // gelen ses yok sayılır (kendi son hecemizi duymayalım).
      logDebug('Barge-in histerezis penceresi, ses islenmiyor');
      return;
    }

    const assistantActive = this.isTtsSpeaking || this.state.isProcessing;
    if (assistantActive && !this.autoBargeIn) {
      logDebug('TTS/islem aktif, otomatik barge-in kapali — ses islenmiyor');
      return;
    }

    // Islem/TTS aktif DEĞİLKEN yeni ses biriktirme (tur zaten kapandi).
    if (this.state.isProcessing && !this.autoBargeIn) {
      logDebug('Isleme devam ediyor, ses biriktirilmiyor');
      return;
    }

    try {
      const vadResult: VADResult | null = this.vadProcessor
        ? this.vadProcessor.isSpeech(audioBuffer)
        : null;

      const isSpeech = vadResult ? vadResult.isSpeech : true;
      // Teşhis: her parçada VAD güveni panele yazılır (canlı "ses alınıyor mu").
      telemetry.vadChunk(isSpeech, vadResult?.confidence ?? 1, vadResult?.audioLevel);
      const now = Date.now();

      /*
       * ASİSTAN AKTİF — YAZILIMSAL YANKI KAPILAMASI + BARGE-IN SAYACI.
       *
       * İki katman birlikte çalışır:
       *
       *   1. KAPILAMA (`EchoGuard`): hoparlöre yazdığımız referansla
       *      karşılaştırır. Parça referansla açıklanabiliyorsa YANKIDIR →
       *      VAD'a sessizlik beslenir, sayaç sıfırlanır. Böylece asistanın
       *      kendi sesi barge-in'i asla tetiklemez.
       *
       *   2. SAYAÇ: parça referansla açıklanamıyor ve VAD konuşma diyorsa
       *      gerçek kullanıcıdır. Ardışık 3 parça (~300 ms) kesintisiz
       *      konuşma demektir; tek parça kapı çarpması olabilir.
       *
       * NEDEN KAPILAMA OLMADAN SAYAÇ YETMİYOR: yankı genliği kullanıcıdan
       * yüksek olabildiği için VAD yankıyı her zaman "konuşma" görür.
       * Kapılama olmadan sayaç, asistanın kendi sesiyle 3 parçada dolar ve
       * asistan her cümlede kendini keser (FAZ 19'da bu yüzden kapalıydı).
       *
       * Ses KONUŞMA TAMPONUNA EKLENMEZ: barge-in gerçekleşirse
       * `handleBargeIn()` tamponu zaten temizler, gerçekleşmezse (parazit)
       * tampona sızmamış olur.
       */
      if (assistantActive) {
        const rms = this.echoGuard ? EchoGuard.computePcm16Rms(audioBuffer) : 0;

        if (this.echoGuard) {
          const decision = this.echoGuard.evaluate({
            rms,
            atMs: now,
            vadSpeaking: isSpeech,
          });

          if (decision.bargeIn) {
            logInfo('Yazilimsal AEC: kullanici sesi yankidan ayrildi, barge-in', {
              observedRms: Number(decision.observedRms.toFixed(4)),
              expectedEcho: Number(decision.expectedEcho.toFixed(4)),
              ratio: Number(decision.ratio.toFixed(2)),
              gain: decision.gain,
              sessionId: this.sessionId,
            });
            this.consecutiveVoiceChunks = 0;
            this.echoGuard.clearReference();
            this.handleBargeIn();
            return;
          }

          if (decision.suppressed) {
            /*
             * Yankı bastırıldı. VAD'a bu parçayı SESSİZ olarak bildirmek
             * yerine hiç göndermiyoruz: `vadChunk` zaten çağrıldı, durum
             * makineleri (isInSpeech, sayaçlar) sıfırlanıyor. PCM'i VAD'a
             * yeniden beslemek gecikmeyi artırıp çift sayıma yol açardı.
             */
            this.consecutiveVoiceChunks = 0;
            this.suppressedSinceLog += 1;
            /*
             * Her 20 bastırmada bir ÖZET satırı — `logInfo` seviyesinde.
             *
             * NEDEN debug değil: canlı doğrulamada "bastırma gerçekten
             * çalışıyor mu" sorusunun cevabı varsayılan günlük seviyesinde
             * görünmelidir. Aksi halde sessizlik ile bastırma ayırt edilemez.
             * Her parçada yazmamak günlüğü okunabilir tutar.
             */
            if (this.suppressedSinceLog % 20 === 0) {
              logInfo('Yazilimsal AEC: yanki bastirildi', {
                // `getStats()` zaten `suppressed` sayacini tasir.
                ratio: Number(decision.ratio.toFixed(2)),
                ...this.echoGuard.getStats(),
              });
            }
            return;
          }
          // Karar "referans-yok" veya "zayif-sinyal": kapılama uygulanmaz,
          // aşağıdaki normal sayaç mantığı çalışır.
        }

        if (isSpeech) {
          this.consecutiveVoiceChunks += 1;
          if (this.consecutiveVoiceChunks >= VoicePipeline.BARGEIN_VOICE_CHUNKS) {
            logInfo('Otomatik barge-in: kullanici konusmaya basladi', {
              chunkCount: this.consecutiveVoiceChunks,
              sessionId: this.sessionId,
            });
            this.handleBargeIn();
            return;
          }
        } else {
          this.consecutiveVoiceChunks = 0;
        }
        // Asistan konuşurken ses biriktirilmez (henüz barge-in eşiği aşılmadı).
        return;
      }

      // Konuşma yoksa sayaç sıfırlanır.
      if (!isSpeech) this.consecutiveVoiceChunks = 0;

      if (isSpeech) {
        if (!this.isInSpeech) {
          this.isInSpeech = true;
          this.state.isListening = true;
          this.emit('vad-speech-start', {
            isSpeech: true,
            confidence: vadResult?.confidence ?? 1,
            audioLevel: vadResult?.audioLevel ?? 0,
          });
        }

        this.lastSpeechAt = now;
        this.speechBuffer.push(audioBuffer);
        this.speechBufferBytes += audioBuffer.length;

        // Guvenlik siniri: cok uzun konusmayi zorla kes.
        if (this.speechBufferBytes >= VoicePipeline.MAX_SPEECH_BYTES) {
          logWarn('Azami konusma suresi asildi, segment zorla kapatiliyor', {
            bytes: this.speechBufferBytes,
          });
          await this.flushSpeechSegment();
        }
        return;
      }

      // Sessizlik: konusma icindeydik ve esik sureyi gecti mi?
      if (this.isInSpeech) {
        const silenceMs = now - this.lastSpeechAt;

        if (silenceMs >= VoicePipeline.SPEECH_END_SILENCE_MS) {
          this.emit('vad-speech-end', { silenceMs });
          await this.flushSpeechSegment();
        }
      }
    } catch (error) {
      logError('Ses isleme hatasi', error as Error);
      this.emit('error', { error: (error as Error).message });
    }
  }

  /**
   * Biriken konusma segmentini STT'ye gonderir ve tur sonunu degerlendirir.
   */
  private async flushSpeechSegment(): Promise<void> {
    const bytes = this.speechBufferBytes;
    const buffer = Buffer.concat(this.speechBuffer);
    // VAD süresi: son konuşma karesinin zaman damgası → tam bu giriş.
    // `lastSpeechAt` aşağıda sıfırlandığı için ÖNCE okunmalı.
    const speechEndedAt = this.lastSpeechAt;
    const flushEnteredAt = Date.now();

    // Durumu hemen sifirla: STT sirasinda yeni ses birikebilir.
    this.speechBuffer = [];
    this.speechBufferBytes = 0;
    this.isInSpeech = false;
    this.lastSpeechAt = 0;

    // 0,3 saniyeden kisa segmentler (ortam gurultusu) yoksayilir.
    const minBytes = Math.floor(16000 * 2 * 0.3);
    if (bytes < minBytes) {
      logDebug('Segment cok kisa, atlandi', { bytes });
      return;
    }

    /*
     * TUR BAŞLANGICI (sesli yol).
     *
     * Nokta: bu fonksiyonun girişi. VAD sessizlik eşiğini (800 ms) geçirdi ve
     * segmenti kapattı; kullanıcı konuşmayı BİTİRMİŞTİR ve STT hemen ardından
     * çalışmaya başlar. Alternatif aday `handleTurnEnd()` başı idi, ancak orası
     * STT tamamlandıktan SONRA çalışır → STT süresi toplamdan düşerdi.
     * VAD'in "konuşma bitti" kararı da (`processAudio` içinde) `silenceMs >=
     * 800` kontrolünün yapıldığı an olup buradan yalnızca bir çağrı öncedir;
     * aradaki fark mikrosaniye düzeyindedir, bu yüzden tek doğru referans bu
     * giriştir.
     *
     * Çok segmentli turda (turn detector "devam") YENİDEN yazılmaz: ilk
     * segmentin başlangıcı korunur, böylece toplam süre tüm turu kapsar.
     */
    const turnStart = this.turnStartedAt ?? Date.now();
    if (this.turnStartedAt === null) {
      this.turnStartedAt = turnStart;
      this.turnLatencyPublished = false;
      this.turnToken = telemetry.turnStart(turnStart, this.llmModelName());
    }

    // VAD süresi: son konuşma karesi → bu giriş (segment kapanışı). Birden çok
    // segmentte TOPLANIR; seslendirilmeyen kısa segmentlerde de gerçek bir
    // sessizlik beklemesi yaşandığı için ölçülür.
    if (speechEndedAt > 0) {
      telemetry.addStageTime('vad', flushEnteredAt - speechEndedAt);
    }

    if (!this.sttEngine) {
      logWarn('STT motoru yok, segment islenemedi');
      return;
    }

    try {
      logInfo('Konusma segmenti taniniyor', {
        bytes,
        durationMs: Math.round((bytes / (16000 * 2)) * 1000),
        sessionId: this.sessionId,
      });

      telemetry.sttStart();
      const sttBegin = Date.now();
      const sttResult = await this.sttEngine.transcribe(buffer);
      const sttWallMs = Date.now() - sttBegin;

      /*
       * Aşama süreleri ayrıştırılır:
       *   - `sttMs`           : model çıkarımı (toplam - ön/son işleme)
       *   - `sttPreprocessMs` : ses temizliği (DC/high-pass/kırpma/AGC)
       *   - `sttPostprocessMs`: transkript düzeltmesi
       * Toplam duvar süresini tek alana yazmak, yeni zincirin maliyetini
       * görünmez kılardı; kullanıcı hangi adımın yavaş olduğunu görebilmeli.
       */
      const preprocessMs = Math.max(0, Math.round(sttResult.preprocessMs || 0));
      const postprocessMs = Math.max(0, Math.round(sttResult.postprocessMs || 0));
      telemetry.addStageTime('stt', Math.max(0, sttWallMs - preprocessMs - postprocessMs));
      telemetry.setSttPreprocessTime(preprocessMs);
      telemetry.setSttPostprocessTime(postprocessMs);
      telemetry.addSttFixes(sttResult.fixes || 0);
      telemetry.setSttModel(sttResult.model || '');
      // Transkript uzunluğu (`sttChars`): son segmentin metni esas alınır.
      telemetry.setSttChars(sttResult.text ? sttResult.text.trim().length : 0);

      if (!sttResult.text || sttResult.text.trim().length === 0) {
        if (sttResult.silent) {
          logDebug('Segment sessiz (on isleme sonrasi bos), tur atlandi');
        } else if (sttResult.rawText) {
          logInfo('Transkript son isleme sonrasi bos kaldi (halusinasyon elendi)', {
            rawText: sttResult.rawText,
          });
        } else {
          logDebug('Bos transkripsiyon, tur atlandi');
        }
        return;
      }

      if (sttResult.rawText && sttResult.rawText !== sttResult.text) {
        logInfo('Transkript duzeltildi', {
          raw: sttResult.rawText,
          fixed: sttResult.text,
          fixes: sttResult.fixes,
        });
      }

      this.state.lastTranscript = sttResult.text;

      this.emit('stt-final', {
        text: sttResult.text,
        isFinal: sttResult.isFinal,
        language: sttResult.language,
        confidence: sttResult.confidence,
        // Panelin sabit "whisper-small" yazmasını önler: gerçek model +
        // zincirin ölçülen maliyeti buradan akar.
        model: sttResult.model,
        preprocessMs,
        postprocessMs,
        fixes: sttResult.fixes,
      });

      // Turn detector: cumle bitti mi?
      const turnResult = this.turnDetector
        ? this.turnDetector.shouldEndTurn(
            sttResult.text,
            VoicePipeline.SPEECH_END_SILENCE_MS / 1000
          )
        : { shouldEndTurn: true };

      if (turnResult.shouldEndTurn) {
        await this.handleTurnEnd(sttResult.text);
      } else {
        logDebug('Turn devam ediyor', { text: sttResult.text });
      }
    } catch (error) {
      logError('Segment tanima hatasi', error as Error);
      this.emit('error', { error: (error as Error).message });
    }
  }

  /**
   * Mikrofonu acar ve gelen sesi `processAudio()`'ya baglar.
   * Hoparlor yoklugu bir hata degildir: yalnizca mikrofonla da calisir.
   */
  async startListening(): Promise<void> {
    if (this.microphone) return;

    if (!this.vadProcessor) {
      logWarn('VAD yok; mikrofon aciliyor fakat sessizlik algilama devre disi');
    }

    /*
     * Hoparlöre yazılan her PCM'i referans olarak kapılamaya bildir.
     * Bu bağ olmadan sınıf "beklenen yankı"yı bilemez ve kör eşiğe döner —
     * yani asistanın kendini kesme riski geri gelir.
     */
    this.speaker = createSpeakerOutput({
      onReference: (atMs, pcm, sampleRate) => {
        /*
         * Örnekleme oranı MUTLAKA iletilir: referansın geçerlilik süresi
         * PCM'in çalma süresidir. Oranı düşürürsek referans, ses daha
         * çalarken ölür ve yankı kapılaması sessizce devre dışı kalır.
         */
        this.echoGuard?.recordReference(atMs, pcm, sampleRate);
      },
    });

    this.microphone = createMicrophoneInput();
    await this.microphone.start((chunk: Buffer) => {
      void this.processAudio(chunk);
    });

    this.state.isListening = true;
    this.emit('state-change', { state: this.state });
    // Mikrofon aşaması: cihaz adıyla birlikte panele yaz.
    const stats = this.microphone?.getStats();
    telemetry.update('mic', 'ready', `mikrofon açık: ${stats?.device ?? 'default'}`, {
      cihaz: stats?.device ?? 'default',
    });
    telemetry.log('info', 'mic', `dinleme başladı (${stats?.device ?? 'default'})`);
    logInfo('Mikrofon dinlemesi baslatildi');
  }

  /** Mikrofonu kapatir. */
  stopListening(): void {
    if (this.microphone) {
      this.microphone.stop();
      this.microphone = null;
    }
    this.state.isListening = false;
    this.emit('state-change', { state: this.state });
    telemetry.update('mic', 'idle', 'mikrofon kapalı');
  }

  /** Teşhis: mikrofon istatistikleri. */
  getAudioStats() {
    return this.microphone?.getStats() ?? null;
  }

  /**
   * Teşhis: yazılımsal yankı kapılaması istatistikleri.
   *
   * NEDEN DIŞA AÇIK: "Bastırma çalışıyor mu" sorusu günlük seviyesine bağlı
   * kalmamalı. `suppressed` sayacı artıyorsa yankı gerçekten ayıklanıyor
   * demektir; `bargeIn` sayacı artıyorsa kullanıcı sesi yankıdan ayrılmış
   * demektir. İkisi de canlı ölçülebilir olmalı; aksi halde "çalışıyor gibi
   * görünüyor" ile "çalışıyor" ayırt edilemez.
   */
  getEchoGuardStats(): {
    enabled: boolean;
    gain?: number;
    referenceBuckets?: number;
    evaluated?: number;
    suppressed?: number;
    bargeIn?: number;
    /** Karar nedenlerinin dağılımı — bastırmanın gerçekten çalıştığının kanıtı. */
    reasons?: Record<string, number>;
  } {
    if (!this.echoGuard) return { enabled: false };
    return { enabled: true, ...this.echoGuard.getStats() };
  }

  private async handleTurnEnd(
    userText: string,
    source: 'voice' | 'text' = 'voice'
  ): Promise<void> {
    if (this.state.isProcessing) {
      logWarn('Zaten isleme devam ediyor, turn atlaniyor');
      return;
    }

    // Güvenlik ağı: tur başlangıcı yukarıda (flushSpeechSegment / processText)
    // işaretlenir. Başka bir yol buraya doğrudan gelirse ölçüm yine çalışsın.
    if (this.turnStartedAt === null) {
      this.turnStartedAt = Date.now();
      this.turnLatencyPublished = false;
      this.turnToken = telemetry.turnStart(this.turnStartedAt, this.llmModelName());
    }

    // Sohbet geçmişi: kullanıcı mesajı TUR KABUL EDİLDİKTEN sonra yazılır.
    // (Erken `return` edilirse arayüzde yanıtsız bir balon kalmaz.)
    this.recordUserMessage(userText, source);

    this.state.isProcessing = true;
    this.state.isListening = false;
    this.emit('state-change', { state: this.state });

    try {
      logInfo('Turn algilandi, isleme basliyor', {
        userText,
        sessionId: this.sessionId,
      });

      this.emit('turn-detected', {
        text: userText,
        sessionId: this.sessionId,
      });

      // Research routing: ağır sorgu mu, hızlı yanıt mı?
      if (this.researchClassifier && this.researchQueue && this.researchWorker) {
        const classification = await this.researchClassifier.classify(userText);

        if (classification.type === 'heavy') {
          // Ağır araştırma: background worker'a yönlendir.
          // DİKKAT: burada `return` etmek `isProcessing` bayrağını kilitli
          // bırakır ve sonraki tüm turlar sessizce atlanır. Bu yüzden
          // bayraklar `finally` benzeri bir akışla burada da sıfırlanır.
          await this.routeToResearch(userText, classification);
          this.state.isProcessing = false;
          this.state.isListening = true;
          this.emit('state-change', { state: this.state });
          return;
        }
      }

      // Bu turun nesli: `handleBargeIn()` sayacı artırdığında aşağıdaki
      // durum yazımları geçersiz olur ve çalışmayı bırakır.
      const generation = this.turnGeneration;

      // Barge-in bu turu iptal edebilsin diye dış sinyal bağlanır.
      const controller = new AbortController();
      this.abortController = controller;

      /*
       * AKIŞLI TUR: yanıtın tamamı beklenmez; cümleler hazır oldukça
       * sentezlenip çalınır (ölçülen kazanç: ilk ses 1598 ms → 110 ms).
       *
       * HATA İZOLASYONU: akış yolu LLM'e ulaşamazsa (sunucu kapalı, anahtar
       * yok, model yok) eskiden istisna yukarı fırlıyor ve kullanıcı HİÇBİR
       * ŞEY duymuyordu. Canlı doğrulamada yakalandı: DeepSeek 5 sn zaman
       * aşımına düştü ve tüm turlar sessizce düştü. Artık boru hattının
       * mevcut davranışı korunuyor: kullanıcıya kısa bir bilgi mesajı söylenir.
       */
      let turnResult: { spokenText: string; toolCalls: LLMToolCall[] };
      let streamingFailed = false;
      try {
        turnResult = await this.runStreamingTurn(userText, controller.signal);
      } catch (streamError) {
        // Barge-in iptali hata değildir: tur zaten kapandı.
        if (controller.signal.aborted) throw streamError;

        streamingFailed = true;
        logWarn('Akisli tur basarisiz, kullaniciya bilgi veriliyor', {
          error: (streamError as Error).message,
          sessionId: this.sessionId,
        });
        turnResult = { spokenText: '', toolCalls: [] };
      }

      this.abortController = null;

      // Barge-in olduysa tur burada biter: geri yazma yok, durum zaten
      // `handleBargeIn()` tarafından güncellendi.
      if (generation !== this.turnGeneration) {
        logInfo('Tur barge-in ile sonlandi, gecmis yazimi atlandi', {
          sessionId: this.sessionId,
        });
        return;
      }

      // MCP tool çağrıları varsa işle (akış boyunca biriktirilmiş).
      if (turnResult.toolCalls.length > 0) {
        await this.handleMCPToolCalls(turnResult.toolCalls);
      }

      // Reasoning modelleri bazen butceyi dusunmeye harcayip bos `content`
      // dondurur. Bu durumda sessiz kalmak yerine kullaniciya kisa bir bilgi
      // verilir; aksi halde asistan "donmus" gibi gorunur.
      let spokenText = turnResult.spokenText.trim();
      if (!spokenText) {
        logWarn('LLM bos yanit dondurdu, yedek mesaj kullaniliyor', {
          sessionId: this.sessionId,
          streamingFailed,
        });
        // LLM'e hiç ulaşılamadıysa "yanıtlayamadım" demek yanıltıcı olur;
        // kullanıcı bağlantı sorununu bilmeli.
        spokenText = streamingFailed
          ? 'Şu anda dil modeline ulaşamıyorum. Bağlantıyı kontrol edip tekrar dener misiniz?'
          : 'Bunu şu anda yanıtlayamadım. Soruyu farklı bir şekilde sorar mısınız?';
        // Yedek mesaj seslendirilmediyse kullanıcı sessizlik duymasın.
        if (!ttsDisabled(this) && this.ttsEngine) {
          try {
            await this.speakResponse(spokenText);
          } catch (error) {
            logWarn('Yedek mesaj seslendirilemedi', {
              error: (error as Error).message,
            });
          }
        }
      }

      // Yanıt uzunluğu (`replyChars`) — seslendirilen gerçek metin.
      telemetry.setReplyChars(spokenText.length);

      // Tur ölçümü: akışlı yolda ilk ses `turnFirstAudioAt` ile işaretlendi.
      const latency = this.publishTurnLatency(
        this.turnFirstAudioAt,
        !ttsDisabled(this) && !!this.ttsEngine
      );

      // LLM bağlamı: yanıt geçmişe eklenmeli, aksi halde model sonraki turda
      // kendi söylediğini hatırlamaz.
      this.conversationHistory.push({ role: 'user', content: userText });
      this.conversationHistory.push({ role: 'assistant', content: spokenText });
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      // Sohbet geçmişi: asistan yanıtı (madde 4). Sesli ve metin yolu AYNI
      // `displayHistory` listesine yazar; arayüz `conversation-update` ile
      // anında görür.
      this.recordAssistantMessage(spokenText, source, latency?.totalMs);

      this.state.lastResponse = spokenText;
      this.state.isProcessing = false;
      this.state.isListening = true;

      this.emit('state-change', { state: this.state });
      this.emit('llm-complete', {
        response: spokenText,
        rawResponse: turnResult.spokenText,
        hadReasoning: false,
        sessionId: this.sessionId,
      });

      logInfo('Isleme tamamlandi', { sessionId: this.sessionId });
    } catch (error) {
      logError('Turn isleme hatasi', error as Error);
      this.state.isProcessing = false;
      this.state.isListening = true;
      this.emit('state-change', { state: this.state });
      this.emit('error', { error: (error as Error).message });
      // Yarım kalan tur ölçümü yayınlanmaz: panelde son BAŞARILI değer kalır.
      this.turnStartedAt = null;
      telemetry.abortTurn();
    }
  }

  /**
   * Ağır sorguyu research worker'ına yönlendirir.
   */
  private async routeToResearch(userText: string, classification: any): Promise<void> {
    if (!this.researchQueue || !this.researchWorker || !this.ttsEngine) {
      logWarn('Research modülü hazir degil, normal akisa devam ediliyor');
      return;
    }

    logInfo('Agir sorgu research workerina yonlendiriliyor', {
      userText,
      classification,
      sessionId: this.sessionId,
    });

    // Research task olustur
    const task: ResearchTask = {
      id: `research_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      userId: this.currentSession?.userId || 'anonymous',
      sessionId: this.sessionId,
      query: userText,
      status: 'pending',
      priority: 'medium' as ResearchPriority,
      createdAt: new Date(),
      updatedAt: new Date(),
      progress: 0,
    };

    // Kuyruğa ekle
    this.researchQueue.enqueue(task);

    // TTS ile kullanıcıya bilgilendirme
    if (this.researchNotifier) {
      this.researchNotifier.setTTSEngine(this.ttsEngine);
      await this.researchNotifier.notifyStart();
    } else {
      // Fallback: doğrudan TTS
      const message = 'Ayrıntılı bakıyorum, biraz sürebilir.';
      try {
        await this.speakResponse(message);
      } catch (error) {
        logWarn('Research baslangic bildirimi gonderilemedi', {
          error: (error as Error).message,
        });
      }
    }

    // State'i güncelle
    this.state.isProcessing = false;
    this.state.isListening = true;
    this.emit('state-change', { state: this.state });

    logInfo('Research task kuyruğa eklendi, pipeline responsive kaldi', {
      taskId: task.id,
    });
  }

  private async generateLLMResponse(userText: string): Promise<LLMResponse> {
    if (!this.llmEngine) {
      throw new Error('LLM engine baslatilmamis');
    }

    this.state.isProcessing = true;
    this.emit('state-change', { state: this.state });

    try {
      // Mesajlari hazirla
      const messages: LLMMessage[] = [
        ...this.conversationHistory,
        { role: 'user', content: userText },
      ];

      // MCP tool'larini LLM'e tanimla
      const tools: LLMTool[] = this.getMCPToolsAsLLMTools();

      const systemPrompt = `Sen Diji, Turkce konusan bir sesli asistanisin. Kullanicilarla Turkce iletisim kurarsin.

KURALLAR:
1. Daima Turkce yanit ver
2. Dogal, samimi ve yardimsever bir ton kullan
3. Kisa ve oz yanitlar ver (sesli asistan icin uygun)
4. Tool cagrisi gerekiyorsa, uygun tool'u sec ve parametreleri doldur
5. Kullanicinin niyetini dogru anla ve uygun eylemi al
6. Turkce dil kurallarina uygun konus
7. Her zaman kisa ve oz cevap ver; yaniti en fazla 1-2 cumlede tut, gereksiz aciklama ve madde isaretli liste kullanma
8. Yeteneklerini, ozelliklerini veya yapabildiklerini asla sayma; "sunlari yapabilirim:" tarzi liste verme, kendini tanitmaya girme, arac veya yetenek adi siralama ("e-posta, takvim, dosya, mesajlasma gibi" gibi). Kullanici "neler yapabiliyorsun" veya "kendini tanit" dese bile tek kisa cumleyle gec

Kullanici mesaji: ${userText}`;

      const llmBegin = Date.now();
      const response = await this.llmEngine.generateResponse(
        messages,
        tools.length > 0 ? tools : undefined,
        systemPrompt
      );
      const llmElapsed = Date.now() - llmBegin;
      telemetry.addStageTime('llm', llmElapsed);
      // Akış KULLANILMIYOR (kapsam dışı): ilk içerik token'ı ancak yanıtın
      // tamamıyla gelir, bu yüzden `llmFirstTokenMs = llmMs`.
      telemetry.setLlmFirstToken(llmElapsed);

      // Konusma gecmisine ekle
      this.conversationHistory.push({ role: 'user', content: userText });
      this.conversationHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Gecmisi sinirla (son 20 mesaj)
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      this.emit('llm-streaming', {
        content: response.content,
        toolCalls: response.tool_calls,
      });

      return response;
    } catch (error) {
      logError('LLM yanit hatasi', error as Error);
      throw error;
    }
  }

  private async *generateLLMResponseStream(
    userText: string,
    /**
     * Barge-in iptal sinyali.
     *
     * NEDEN gerekli: akış sırasında kullanıcı sözünü kestiğinde HTTP okuması
     * `reader.read()` içinde asılı kalır; sinyal olmadan yeni tur için
     * `isProcessing` kilidi açılmaz.
     */
    signal?: AbortSignal
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    if (!this.llmEngine) {
      throw new Error('LLM engine baslatilmamis');
    }

    const messages: LLMMessage[] = [
      ...this.conversationHistory,
      { role: 'user', content: userText },
    ];

    const tools: LLMTool[] = this.getMCPToolsAsLLMTools();

    const systemPrompt = `Sen Diji, Turkce konusan bir sesli asistanisin. Kullanicilarla Turkce iletisim kurarsin.

KURALLAR:
1. Daima Turkce yanit ver
2. Dogal, samimi ve yardimsever bir ton kullan
3. Kisa ve oz yanitlar ver (sesli asistan icin uygun)
4. Tool cagrisi gerekiyorsa, uygun tool'u sec ve parametreleri doldur
5. Kullanicinin niyetini dogru anla ve uygun eylemi al
6. Turkce dil kurallarina uygun konus
7. Her zaman kisa ve oz cevap ver; yaniti en fazla 1-2 cumlede tut, gereksiz aciklama ve madde isaretli liste kullanma
8. Yeteneklerini, ozelliklerini veya yapabildiklerini asla sayma; "sunlari yapabilirim:" tarzi liste verme, kendini tanitmaya girme, arac veya yetenek adi siralama ("e-posta, takvim, dosya, mesajlasma gibi" gibi). Kullanici "neler yapabiliyorsun" veya "kendini tanit" dese bile tek kisa cumleyle gec`;

    yield* this.llmEngine.generateResponseStream(
      messages,
      tools.length > 0 ? tools : undefined,
      systemPrompt,
      signal
    );
  }

  private getMCPToolsAsLLMTools(): LLMTool[] {
    if (!this.mcpClient) return [];

    const tools = this.mcpClient.getAllTools();
    return tools.map((tool) => ({
      type: 'function',
      function: {
        // LLM'e araç adı MUTLAKA `sunucu__arac` biçiminde sunulur.
        //
        // NEDEN ön ek: `handleMCPToolCalls()` sunucuyu bu öneke göre çözer.
        // Ön ek olmadan model `list_channels` döndürüyor, ajan bunu sunucu adı
        // sanıp "MCP sunucusu bulunamadi" hatası veriyordu (canlı logda
        // görüldü). Ad ayrıca iki farklı sunucudaki aynı araç adını
        // çakışmaktan korur.
        //
        // NEDEN `__` ve sanitize: OpenAI uyumlu katı sağlayıcılar araç adında
        // yalnızca `^[a-zA-Z0-9_-]+$` kabul eder. Nokta içeren `sunucu.arac`
        // biçimi DeepSeek'te her turu 400 ile bozuyordu (canlı logda görüldü:
        // "Invalid 'tools[0].function.name'"). Bu yüzden hem ayırıcı `__`
        // yapıldı hem de parçalar bu karakter kümesine indirgendi.
        name: mcpToolName(tool.server, tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * Modelin döndürdüğü araç adını `{ server, tool }` çiftine çözer.
   *
   * Beklenen biçim `sunucu.arac` (LLM'e bu biçimde sunulur). Model öneki
   * atlarsa araç adı tüm bağlı sunucularda aranır; tam olarak tek bir
   * sunucuda bulunursa o kullanılır. Birden çok sunucuda aynı ad varsa
   * belirsizlik nedeniyle `null` döner — yanlış sunucuda yan etki
   * üretmektense çağrı atlanır.
   */
  private resolveMcpTool(name: string): { server: string; tool: string } | null {
    if (!this.mcpClient) return null;
    const requested = String(name ?? '').trim();
    if (!requested) return null;

    // Tam eşleşme en güvenilir yol: adı biz ürettiysek (sanitize edilmiş
    // `sunucu__arac`) geri çözmek için tahmin yürütmeye gerek yok.
    const exact = this.mcpClient
      .getAllTools()
      .find((tool) => mcpToolName(tool.server, tool.name) === requested);
    if (exact) return { server: exact.server, tool: exact.name };

    // Ayırıcıyı çöz: `__` (güncel biçim) veya `.` (eski biçim / model kendi
    // ürettiyse). Parçalar da sanitize edilerek karşılaştırılır.
    for (const separator of ['__', '.']) {
      const at = requested.indexOf(separator);
      if (at <= 0 || at >= requested.length - separator.length) continue;
      const server = requested.slice(0, at);
      const tool = requested.slice(at + separator.length);
      const found = this.mcpClient
        .getAllTools()
        .find(
          (candidate) =>
            sanitizeToolPart(candidate.server) === server &&
            sanitizeToolPart(candidate.name) === tool
        );
      if (found) return { server: found.server, tool: found.name };
    }

    // Ön ek yok (veya yanlış): araç adını tüm sunucularda ara.
    const matches = this.mcpClient
      .getAllTools()
      .filter(
        (tool) =>
          tool.name === requested ||
          `${tool.server}.${tool.name}` === requested ||
          mcpToolName(tool.server, tool.name) === requested
      );

    if (matches.length === 1) {
      const only = matches[0];
      return { server: only.server, tool: only.name };
    }

    logWarn('MCP araç adı belirsiz veya bulunamadı', {
      requested,
      candidates: matches.map((tool) => `${tool.server}.${tool.name}`),
    });
    return null;
  }

  private async handleMCPToolCalls(
    toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[]
  ): Promise<void> {
    if (!this.mcpClient) {
      logWarn('MCP client baslatilmamis, tool cagrilari atlaniyor');
      return;
    }

    for (const toolCall of toolCalls) {
      try {
        const args = JSON.parse(toolCall.function.arguments || '{}');

        // Sunucu adini tool isminden cikar (beklenen bicim: `sunucu.arac`).
        // Model bazen oneki atlar; o durumda arac adi TUM sunucularda aranir.
        // Bu, "MCP sunucusu bulunamadi: list_channels" hatasinin kok nedenidir.
        const resolved = this.resolveMcpTool(toolCall.function.name);
        if (!resolved) {
          logWarn('MCP araci cozulemedi, cagri atlandi', {
            requested: toolCall.function.name,
          });
          this.emit('mcp-complete', {
            tool: toolCall.function.name,
            success: false,
            error: `arac bulunamadi: ${toolCall.function.name}`,
          });
          continue;
        }

        const request: MCPCallRequest = {
          server: resolved.server as MCPCallRequest['server'],
          // Sunucuya PREFIX'SIZ ad gonderilir; `tools/call` bunu bekler.
          tool: resolved.tool,
          arguments: args,
          userId: this.currentSession?.userId || 'anonymous',
          sessionId: this.sessionId,
        };

        this.emit('mcp-call', {
          server: request.server,
          tool: `${resolved.server}.${resolved.tool}`,
          sessionId: this.sessionId,
        });

        // MCP bağlamı: araç sayısı + çağrılan sunucu adları (`prefix.tool`).
        telemetry.addMcpTool(`${resolved.server}.${resolved.tool}`);

        const mcpBegin = Date.now();
        const response: MCPCallResponse = await this.mcpClient.callTool(request);
        telemetry.addStageTime('mcp', Date.now() - mcpBegin);

        this.emit('mcp-complete', {
          server: request.server,
          tool: request.tool,
          success: response.success,
          data: response.data,
          error: response.error,
        });

        if (!response.success) {
          logWarn('MCP tool cagrisi basarisiz', {
            server: request.server,
            tool: request.tool,
            error: response.error,
          });
        }
      } catch (error) {
        logError('MCP tool cagrisi hatasi', error as Error, {
          tool: toolCall.function.name,
        });
      }
    }
  }

  private async speakResponse(text: string): Promise<TurnLatency | null> {
    // TTS tamamen kapatılabilir (DIJI_TTS_ENABLED=0/off): yanıt yalnızca
    // metin olarak arayüze ve günlüğe gider, ses üretilmez. Panelde TTS
    // satırı "kapalı" görünür; boru hattı konuşma durumuna hiç girmez.
    if (ttsDisabled(this)) {
      logInfo('TTS kapali — yanit seslendirilmedi', { textLength: text.length });
      telemetry.update('tts', 'idle', 'TTS kapalı — ses üretilmiyor');
      telemetry.update('playback', 'idle', 'TTS kapalı');
      telemetry.log('info', 'tts', 'TTS kapalı, yanıt yalnızca metin');
      // Seslendirme yok: turun "çıkış" anı, yanıt metninin hazır olduğu andır.
      return this.publishTurnLatency(null, false);
    }

    if (!this.ttsEngine) {
      throw new Error('TTS engine baslatilmamis');
    }

    this.state.isSpeaking = true;
    this.isTtsSpeaking = true;
    this.emit('state-change', { state: this.state });

    // TTS aşaması: sentez isteğinin başladığı an. `ttsMs`, bu andan İLK PCM
    // parçasının hoparlöre yazıldığı ana kadar ölçülür (tüm sentez değil):
    // kullanıcının beklediği süre ilk sesin duyulmasına kadardır.
    const ttsBegin = Date.now();
    let firstAudioAt: number | null = null;
    let lastChunkAt = 0;

    try {
      logInfo('TTS konusma baslatiliyor', {
        textLength: text.length,
        sessionId: this.sessionId,
      });

      this.emit('tts-speaking', {
        text,
        sessionId: this.sessionId,
      });

      // Akışlı TTS
      for await (const event of this.ttsEngine.speakStream(text)) {
        if (event.type === 'audio' && event.audioBuffer) {
          // Hoparlore yaz (paralel: sentez devam ederken ses calar).
          // Ornekleme frekansi TTS'ten geldigi gibi iletilir; sabit
          // 16 kHz varsaymak 22.05 kHz VITS ciktisini hizlandirirdi.
          if (this.speaker) {
            void this.speaker.play(
              event.audioBuffer,
              event.sampleRate ?? this.ttsEngine?.getSampleRate()
            );
          }

          /*
           * İLK SES ÇIKIŞI.
           *
           * `play()` çağrısı PCM'i `aplay` alt sürecinin stdin'ine yazar; ses
           * bu andan itibaren duyulmaya başlar (ALSA tamponu ~onlarca ms).
           * Sentezin BİTMESİ değil, ilk parçanın yazılması esas alınır —
           * aksi halde TTS'in tamamı (6-7 sn) gecikmeye eklenirdi ve
           * "hoparlörden ilk ses çıktığı an" tanımına uymazdı.
           */
          const chunkAt = Date.now();
          lastChunkAt = chunkAt;
          if (firstAudioAt === null) {
            firstAudioAt = chunkAt;
            telemetry.setTtsTiming(chunkAt - ttsBegin, chunkAt - ttsBegin);
          }

          this.emit('tts-speaking', {
            audioBuffer: event.audioBuffer,
            text: event.text,
            sessionId: this.sessionId,
          });
        } else if (event.type === 'complete') {
          // Sentez bitti ama ses hala caliyor olabilir: kuyrugu bosalt.
          // Aksi halde hoparlor kesilir ve son hece duyulmaz.
          if (this.speaker) {
            await this.speaker.flush();
          }
          this.emit('tts-complete', {
            text,
            sessionId: this.sessionId,
          });
        } else if (event.type === 'error') {
          this.emit('error', {
            error: 'TTS sentezleme hatasi',
            sessionId: this.sessionId,
          });
        }
      }
    } catch (error) {
      logError('TTS konusma hatasi', error as Error);
      throw error;
    } finally {
      // Sentezin tamamı (`ttsMs`): ilk parça → son parça.
      if (firstAudioAt !== null) {
        const synthEnd = lastChunkAt || Date.now();
        telemetry.setTtsTiming(firstAudioAt - ttsBegin, synthEnd - ttsBegin);
      }

      // Çalma süresi (`playbackMs`): ilk PCM yazıldı → kuyruk boşaldı.
      // `flush()` sıradaki tüm `aplay` süreçlerinin kapanmasını beklediği için
      // gerçek çalma bitişini verir (sentez bitişini değil). `totalMs`'ten
      // SONRA gerçekleşir, bu yüzden toplam süreye katılmaz.
      if (firstAudioAt !== null && this.speaker) {
        try {
          await this.speaker.flush();
        } catch {
          /* çalma zaten bitmiş olabilir */
        }
        telemetry.setPlaybackTime(Date.now() - firstAudioAt);
      }

      this.state.isSpeaking = false;
      this.isTtsSpeaking = false;
      this.emit('state-change', { state: this.state });

      // Ses hiç üretilemediyse (boş/hata) tur yine kapanmalı: toplam süre
      // metnin hazır olduğu ana kadar ölçülür, `ttsEnabled` gerçek değeri taşır.
      return this.publishTurnLatency(firstAudioAt, true);
    }
  }

  /**
   * Akışlı tur: LLM'den gelen parçaları cümle sınırında TTS'e aktarır.
   *
   * ESKİ DAVRANIŞ (kapalıydı): `generateLLMResponse()` yanıtın TAMAMINI
   * bekliyor, sonra `speakResponse()` metnin tamamını seslendiriyordu.
   * Canlı ölçüm: akışsız ilk ses 1598 ms, akışlı ilk ses 110 ms — 14 kat.
   *
   * YENİ DAVRANIŞ: parçalar geldikçe biriktirilir; nokta/soru/ünlem gibi bir
   * cümle sonu görüldüğünde o cümle hemen sentezlenip çalınır. Kullanıcı
   * modelin cümleyi bitirmesini beklemez.
   *
   * KORUNANLAR (regresyon olmasın diye):
   *   - `tool_calls` biriktirilir ve tur sonunda `handleMCPToolCalls()`'a
   *     verilir; MCP yeteneği kaybolmaz.
   *   - Akış içerik üretmezse (yalnızca düşünme metni) yedek mesaj söylenir.
   *   - `conversationHistory` + `recordAssistantMessage` ikisi de yazılır;
   *     arayüz balonu ve LLM bağlamı ayrı ayrı beslenir.
   *
   * @returns Seslendirilen metin ve MCP araç çağrıları.
   */
  private async runStreamingTurn(
    userText: string,
    signal: AbortSignal
  ): Promise<{ spokenText: string; toolCalls: LLMToolCall[] }> {
    if (!this.llmEngine) {
      throw new Error('LLM engine baslatilmamis');
    }

    const speak = !ttsDisabled(this) && !!this.ttsEngine;

    if (speak) {
      this.state.isSpeaking = true;
      this.isTtsSpeaking = true;
      this.emit('state-change', { state: this.state });
      this.emit('tts-speaking', { text: '', sessionId: this.sessionId });
    }

    const ttsBegin = Date.now();
    this.turnFirstAudioAt = null;
    this.partialAssistantText = '';

    let accumulated = '';
    let pending = '';
    let lastChunkAt = 0;
    const toolCalls: LLMToolCall[] = [];

    // Cümleleri sırayla sentezleyip çalan zincir. `await` EDİLMEZ:
    // akışı bloklamamak esas amaçtır; sıra koruması zincirle sağlanır.
    const queueSentence = (sentence: string): void => {
      const clean = sentence.trim();
      if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;

      this.ttsChain = this.ttsChain
        .then(() => this.synthesizeAndPlaySentence(clean, ttsBegin))
        .catch((error: unknown) => {
          // Tek cümlenin hatası turu düşürmez (TTS tarafındaki aynı kural).
          logWarn('Akisli TTS cumlesi calinamadi', {
            error: (error as Error).message,
          });
        });
    };

    try {
      for await (const chunk of this.generateLLMResponseStream(userText, signal)) {
        // Barge-in: tur geçersiz kılındıysa döngüden çık.
        if (signal.aborted) break;

        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          toolCalls.push(...chunk.tool_calls);
        }

        // `content` hiçbir zaman null değil (bkz. `LLMStreamChunk`); boş
        // string olabilir — boş parça yalnızca araç çağrısı taşıyan iletidir.
        const delta = chunk.content ?? '';
        if (!delta) continue;

        const now = Date.now();
        lastChunkAt = now;

        // İLK TOKEN: kullanıcının gördüğü ilk metin anı.
        if (!accumulated) {
          const since = this.turnStartedAt ?? now;
          telemetry.addStageTime('llm', now - since);
          telemetry.setLlmFirstToken(now - since);
        }

        accumulated += delta;
        pending += delta;
        // Barge-in sırasında geçmişe yazılacak kısmi metin.
        this.partialAssistantText = accumulated;

        this.emit('llm-streaming', { content: delta });

        // Cümle sınırı: nokta/soru/ünlem/noktalı virgül sonrası boşluk.
        // Lookbehind sayesinde ayırıcı cümlede kalır.
        const pieces = pending.split(/(?<=[.,!?:;])\s+/);
        pending = pieces.pop() ?? '';
        for (const piece of pieces) queueSentence(piece);
      }
    } catch (error) {
      // Barge-in kaynaklı iptal normaldir; hata olarak raporlanmaz.
      if (signal.aborted || (error as Error).name === 'AbortError') {
        logInfo('Akisli tur barge-in ile iptal edildi', {
          sessionId: this.sessionId,
        });
      } else {
        logError('Akisli tur hatasi', error as Error);
        throw error;
      }
    }

    // Kalan parçayı da seslendir (cümle sonu işareti olmayabilir).
    if (pending.trim()) queueSentence(pending);

    if (speak) {
      // Tüm cümleler çalana kadar bekle; aksi halde son hece kesilir.
      await this.ttsChain.catch(() => undefined);
      await this.speaker?.flush().catch(() => undefined);

      if (this.turnFirstAudioAt !== null) {
        telemetry.setTtsTiming(
          this.turnFirstAudioAt - ttsBegin,
          (lastChunkAt || Date.now()) - ttsBegin
        );
        telemetry.setPlaybackTime(Date.now() - this.turnFirstAudioAt);
      }

      this.state.isSpeaking = false;
      this.isTtsSpeaking = false;
      this.emit('tts-complete', { text: accumulated, sessionId: this.sessionId });
      this.emit('state-change', { state: this.state });
    }

    return {
      spokenText: accumulated,
      toolCalls: Array.from(
        // Aynı kimlikle birden fazla parça gelirse tekilleştir.
        new Map(toolCalls.map((call) => [call.id || `${call.function.name}`, call])).values()
      ),
    };
  }

  /**
   * Tek bir cümleyi sentezleyip hoparlöre yazar (akışlı tur yardımcısı).
   *
   * NEDEN ayrı metot: `ttsChain` içinde sırayla çalışır, turun akışını
   * bloklamaz ve barge-in sonrası sessizce düşer.
   */
  private async synthesizeAndPlaySentence(
    sentence: string,
    ttsBegin: number
  ): Promise<void> {
    if (!this.ttsEngine) return;
    // Tur iptal edildiyse sentezleme: boşa CPU harcamayalım.
    if (this.state.isBargeIn) return;

    for await (const event of this.ttsEngine.speakStream(sentence)) {
      if (event.type === 'audio' && event.audioBuffer) {
        if (this.speaker) {
          /*
           * `play()` await EDİLMEZ — hoparlör yazımı kendi kuyruğunda
           * serileşir. Beklenseydi sentez ile çalma birbirini kilitlerdi.
           */
          void this.speaker.play(
            event.audioBuffer,
            event.sampleRate ?? this.ttsEngine?.getSampleRate()
          );
        }

        if (this.turnFirstAudioAt === null) {
          this.turnFirstAudioAt = Date.now();
          telemetry.setTtsTiming(this.turnFirstAudioAt - ttsBegin, 0);
        }

        this.emit('tts-speaking', {
          audioBuffer: event.audioBuffer,
          text: event.text,
          sessionId: this.sessionId,
        });
      } else if (event.type === 'error') {
        logWarn('Akisli TTS parcasi hata verdi', { text: event.text });
      }
    }
  }

  /**
   * Tur gecikmesini BİR KEZ yayınlar ve tur zamanlayıcısını temizler.
   *
   * Neden tek sefer: `speakResponse()` hem ana yanıt hem MCP onay sorusu
   * (`requestVoiceConfirmation`) için çağrılır. Kullanıcının duyduğu İLK ses
   * hangisiyse toplam süre odur; sonraki konuşmalar ölçümü yeniden yayınlamaz.
   */
  private publishTurnLatency(
    firstAudioAt: number | null,
    ttsEnabled: boolean
  ): TurnLatency | null {
    if (this.turnLatencyPublished) return this.state.lastTurnLatency;
    // Tur başlamadıysa (ör. selamlama, onay sorusu) ölçüm yayınlanmaz.
    if (this.turnStartedAt === null) return this.state.lastTurnLatency;
    this.turnLatencyPublished = true;
    this.turnStartedAt = null;
    const token = this.turnToken;

    // Kimlik eşleşmezse (bu tur kapanırken yeni bir tur başlamış) yayın yok:
    // aksi halde yeni turun sayaçları sıfırlanmış hâlde okunur ve saçma bir
    // `totalMs` üretilirdi.
    const latency = telemetry.finishTurn(firstAudioAt, ttsEnabled, token);
    if (!latency) return this.state.lastTurnLatency;

    this.state.lastTurnLatency = latency;
    // `finishTurn` telemetri olayını kendisi yayınladı; pipeline aboneleri
    // (varsa) için de aynı olay aktarılır.
    this.emit('turn-latency', latency);
    // Asistan balonundaki gecikme notu yanıt eklendikten SONRA kesinleşir.
    telemetry.attachLatencyToLastAssistant(latency.totalMs);
    return latency;
  }

  /**
   * Yazma/silme islemleri icin kullanici onayini bekler.
   *
   * Sahte `true` DONMEZ. Onay istegi UI'ya ve ses katmanina iletilir;
   * kullanici "evet" derse `confirmPendingAction(true)`, "hayir" derse
   * `confirmPendingAction(false)` cagrilmalidir. Zaman asiminda islem
   * guvenli taraf olarak REDDEDILIR.
   */
  private async requestVoiceConfirmation(request: VoiceConfirmationRequest): Promise<boolean> {
    logInfo('Ses onayi isteniyor', {
      server: request.server,
      tool: request.tool,
      permission: request.permission,
      reason: request.reason,
    });

    // Onceki bekleyen onay varsa reddet (ayni anda tek onay).
    this.confirmPendingAction(false);

    // Kullaniciya sesli olarak sorulacak cumle.
    const spokenQuestion =
      request.permission === 'delete'
        ? `Silmek uzereyim: ${request.server} uzerinde ${request.tool}. Onaylıyor musun?`
        : `${request.server} uzerinde ${request.tool} islemini yapayim mi?`;

    this.emit('mcp-confirmation-required', {
      server: request.server,
      tool: request.tool,
      permission: request.permission,
      reason: request.reason,
      question: spokenQuestion,
      sessionId: this.sessionId,
    });

    // Arayüz onay diyaloğunu bu kayıtla açar. `expiresAt` seslendirme
    // bittikten sonra doldurulur; sayaç o an başlar.
    const requestedAt = Date.now();
    telemetry.setPendingConfirmation({
      server: request.server,
      tool: request.tool,
      permission: request.permission,
      reason: request.reason,
      question: spokenQuestion,
      requestedAt,
      expiresAt: null,
    });

    // Soruyu sesli olarak sor.
    try {
      await this.speakResponse(spokenQuestion);
    } catch (error) {
      logWarn('Onay sorusu seslendirilemedi', {
        error: (error as Error).message,
      });
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        logWarn('Ses onayi zaman asimina ugradi, islem reddedildi', {
          server: request.server,
          tool: request.tool,
        });
        this.pendingConfirmation = null;
        // Arayüz diyaloğu kapatır; süre doldu bilgisi olay akışına yazılır.
        telemetry.setPendingConfirmation(null);
        telemetry.log('warn', 'mcp', 'onay zaman aşımı — işlem reddedildi');
        resolve(false);
      }, VoicePipeline.CONFIRMATION_TIMEOUT_MS);

      this.pendingConfirmation = { resolve, timer };

      // Sayaç artık işliyor: arayüz geri sayımı gösterebilsin.
      telemetry.setPendingConfirmation({
        server: request.server,
        tool: request.tool,
        permission: request.permission,
        reason: request.reason,
        question: spokenQuestion,
        requestedAt,
        expiresAt: Date.now() + VoicePipeline.CONFIRMATION_TIMEOUT_MS,
      });
    });
  }

  /**
   * Bekleyen sesli onayi sonuclandirir.
   *
   * @param confirmed true = onaylandi, false = reddedildi
   * @returns Bekleyen istek yoksa false.
   */
  confirmPendingAction(confirmed: boolean): boolean {
    if (!this.pendingConfirmation) {
      logDebug('Onaylanacak bekleyen islem yok');
      return false;
    }

    const { resolve, timer } = this.pendingConfirmation;
    this.pendingConfirmation = null;
    clearTimeout(timer);
    // Arayüzdeki onay diyaloğu kapansın (hem onay hem ret aynı olayı üretir).
    telemetry.setPendingConfirmation(null);

    logInfo(confirmed ? 'Islem kullanici tarafindan onaylandi' : 'Islem reddedildi', {
      sessionId: this.sessionId,
    });

    resolve(confirmed);
    return true;
  }

  /** Bekleyen onay var mi? */
  hasPendingConfirmation(): boolean {
    return this.pendingConfirmation !== null;
  }

  /**
   * Kullanıcının asistanı sözünü kesmesi (barge-in).
   *
   * ÜÇ ŞEY BİRDEN KAPATILMALIDIR — biri eksik kalırsa müdahale "görünmez"
   * olur ve sistem kendi kendine konuşmaya devam eder:
   *
   *   1. LLM isteği  → `AbortController.abort()` (ağ bağlantısı iptal)
   *   2. TTS üretimi → `ttsEngine.stop()` (sonraki cümleyi sentezleme)
   *   3. Hoparlör    → `speaker.interrupt()` (çalmakta olan PCM'i kes)
   *
   * Eskiden 2 ve 3 eksikti: `ttsEngine.stop()` yalnızca BİR SONRAKİ cümleyi
   * durduruyordu, hoparlöre yazılmış ses kesilmiyordu; `speaker.interrupt()`
   * hiç çağrılmıyordu. Ayrıca `isProcessing` sıfırlanmadığı için kullanıcının
   * müdahale sırasında söylediği söz `processAudio()` tarafından sessizce
   * atılıyordu.
   */
  handleBargeIn(): void {
    if (!this.isRunning) return;

    // Turu geçersiz kıl: eski turun `await` sonrası satırları artık durum
    // yazamaz (bkz. `turnGeneration` açıklaması).
    this.turnGeneration += 1;
    const interruptedGeneration = this.turnGeneration - 1;

    logInfo('Barge-in algilandi, tur iptal ediliyor', {
      sessionId: this.sessionId,
      generation: interruptedGeneration,
      hadPartialText: this.partialAssistantText.length > 0,
    });

    this.state.isBargeIn = true;
    this.state.isSpeaking = false;
    this.state.isProcessing = false;
    this.isTtsSpeaking = false;

    // Barge-in turu iptal eder: yarım kalan ölçüm yayınlanmaz, son başarılı
    // `lastTurnLatency` değeri panelde kalır.
    this.turnStartedAt = null;
    this.turnLatencyPublished = true;
    telemetry.abortTurn();

    // (1) LLM isteğini iptal et. `abort()` senkron çalışır; `fetch` reddeder.
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (error) {
        logDebug('AbortController zaten kapatilmis', {
          error: (error as Error).message,
        });
      }
      this.abortController = null;
    }

    // (2) TTS sentez döngüsünü durdur (sonraki cümle sentezlenmez).
    if (this.ttsEngine) {
      this.ttsEngine.stop();
    }

    // (3) Hoparlörde çalan sesi hemen kes. `SIGTERM` → `aplay` süreci
    // kapanır; kuyruktaki yeni parçalar `stopped` bayrağına gerek kalmadan
    // EPIPE ile sessizce düşer (bkz. `writeChunk`).
    if (this.speaker) {
      this.speaker.interrupt();
    }

    // Yarım kalan asistan metnini geçmişe yaz: model sonraki turda nerede
    // kaldığını bilmeli. Boşsa hiçbir şey eklenmez (geçmişi kirletmesin).
    const partial = this.partialAssistantText.trim();
    this.partialAssistantText = '';
    if (partial.length > 0) {
      const marked = `${partial} [kullanıcı sözü kesti]`;
      this.conversationHistory.push({ role: 'assistant', content: marked });
      // Arayüzde de görünmeli: aksi halde kullanıcı yarım yanıtı göremez.
      this.recordAssistantMessage(marked, 'voice', undefined);
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }
    }

    // Yarım kalan konuşma tamponu SİLİNMELİ: aksi halde barge-in sonrası
    // söylenen ilk söz, kesilen cümlenin sesiyle birleşip tek segment olur.
    this.speechBuffer = [];
    this.speechBufferBytes = 0;
    this.isInSpeech = false;
    this.consecutiveVoiceChunks = 0;

    /*
     * Referans geçmişi de temizlenir: hoparlör kesildiği için artık çalan
     * bir sinyal yoktur. Temizlenmezse eski referans, kullanıcının barge-in
     * sonrası söylediği ilk sözlerle eşleşip onları yankı sanabilir —
     * yani kullanıcı az önce sözünü kestiği hâlde duyulmaz.
     */
    this.echoGuard?.clearReference();
    this.suppressedSinceLog = 0;

    this.emit('barge-in', {
      sessionId: this.sessionId,
      timestamp: new Date(),
    });

    this.emit('state-change', { state: this.state });

    /*
     * HISTEREZİS — 300 ms.
     *
     * `isBargeIn` bu süre boyunca `true` kalır ve `processAudio()` sesi
     * yok sayar. NEDEN: hoparlörü kesen `SIGTERM` ile sesin gerçekten
     * susması arasında ALSA tamponu kadar (~onlarca ms) gecikme vardır.
     * Bu pencere kapatılmazsa mikrofon kendi son hecesini duyar ve yeni
     * turu yanlış transkriptle başlatır.
     */
    setTimeout(() => {
      // Bu arada yeni bir barge-in geldiyse dokunma (nesil kontrolü).
      if (this.turnGeneration !== interruptedGeneration + 1) return;
      this.state.isBargeIn = false;
      this.state.isListening = true;
      this.emit('state-change', { state: this.state });
    }, 300);
  }

  getState(): PipelineState {
    return { ...this.state };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Arayüz sohbet panelinin gösterdiği mesajlar (son 50).
   *
   * Kaynak `telemetry.displayHistory`'dir; LLM'e giden
   * `conversationHistory`'den ayrıdır ve sistem/tool mesajı içermez.
   */
  getConversation(): ConversationEntry[] {
    return telemetry.getConversation();
  }

  isPipelineRunning(): boolean {
    return this.isRunning;
  }

  /**
   * MCP sunucularının CANLI durumu (arayüzdeki servis listesi).
   *
   * MCP devre dışıysa veya istemci başlatılamadıysa boş dizi döner —
   * arayüz "bağlı değil" gösterir, sahte "aktif" üretilmez.
   */
  getMcpServerStatuses(): Array<{
    name: string;
    connected: boolean;
    toolCount: number;
    permissions: { read: boolean; write: boolean; delete: boolean };
  }> {
    if (!this.mcpClient) return [];
    return this.mcpClient.getServerStatuses().map((status) => ({
      name: status.name,
      connected: status.connected,
      toolCount: status.toolCount,
      permissions: status.permissions,
    }));
  }

  /** Arayüzün açtığı onay diyaloğunun kaynağı (yoksa `null`). */
  getPendingConfirmation(): PendingConfirmation | null {
    return telemetry.getPendingConfirmation();
  }

  /**
   * Ayarlar ekranının model listelerini üretir.
   *
   * `current` değerleri **çalışan motorun gerçek** kimliğidir (yapılandırma
   * değil): STT çözümlenmiş model adını, TTS etkin sağlayıcıyı, LLM istek
   * gövdesinde kullanılan model adını döndürür. Böylece arayüz "seçili"
   * işaretini doğru koyar.
   */
  async getModelCatalog(): Promise<ModelCatalog> {
    const sttCurrent = this.sttEngine?.getModelName() ?? this.config.stt.model;
    const llmCurrent = this.llmEngine?.getModelName() ?? this.effectiveLlmModel();
    const ttsCurrent = this.effectiveTtsModel();

    // Etkin uc nokta MOTORDAN okunur (yapilandirmadan degil): saglayici
    // degistiginde `config.llm.baseUrl` eski degeri tasimaya devam eder.
    const llmBaseUrl = this.llmEngine?.getBaseUrl() ?? this.config.llm.baseUrl;
    const llmProvider = this.effectiveLlmProvider();

    return buildModelCatalog({
      modelsDir: this.config.stt.modelPath,
      sttCurrent,
      sttPriority: this.sttPriority(),
      ttsCurrent,
      // Katalog, ETKIN saglayicinin anahtariyla sorgulanir. Yanlis anahtar
      // gondermek uzak API'de 401, yerelde ise gereksiz baslik uretirdi.
      llmApiKey: this.apiKeyFor(llmProvider),
      llmBaseUrl,
      llmCurrent,
      llmProvider,
    });
  }

  /**
   * Etkin LLM saglayicisi.
   *
   * Oncelik MOTORDADIR: `setProvider` basarisiz olursa motor eski uc noktada
   * kalir; arayuzun "secili" isaretini yapilandirmaya gore koymak yaniltıcı
   * olurdu.
   */
  private effectiveLlmProvider(): 'local' | 'deepseek' {
    const fromEngine = this.llmEngine?.getBaseUrl();
    if (fromEngine) {
      return fromEngine.includes('deepseek.com') ? 'deepseek' : 'local';
    }
    return this.config.llm.provider === 'deepseek' ? 'deepseek' : 'local';
  }

  /**
   * Verilen saglayici icin kullanilacak anahtar.
   *
   * Yerel saglayici anahtar istemez; `sk-local` gibi bir yer tutucu doner.
   * Uzak saglayici icin once `DIJI_LLM_API_KEY`, sonra 0600 izinli ayri
   * dosya (`~/.config/diji/secrets/deepseek.key`) okunur.
   */
  private apiKeyFor(provider: 'local' | 'deepseek'): string {
    if (provider === 'local') {
      const local = (this.config.llm.apiKey ?? '').trim();
      return local || 'sk-local';
    }
    const fromEnv = (process.env.DIJI_LLM_API_KEY ?? '').trim();
    if (fromEnv) return fromEnv;
    return readApiKeyFile(provider);
  }

  /**
   * Ayarlar ekranindan LLM SAGLAYICISINI degistirir (yerel ↔ DeepSeek).
   *
   * Neden model seciminden ayri: saglayici degisimi `baseUrl` ve `apiKey`
   * alanlarini da degistirir. Tek bir "model" listesinde karistirmak,
   * kullanicinin yerel sunucuya `deepseek-flash` adi gondermesi gibi sessiz
   * hatalara yol acardi.
   *
   * Guvenlik kurali: uzak saglayici secildiginde anahtar YOKSA gecis
   * YAPILMAZ — `apiKeyRequired: true` doner ve arayuz anahtar alanini acar.
   * Anahtar olmadan gecmek her turu 401 ile bozardi.
   */
  async selectLlmProvider(
    provider: 'local' | 'deepseek',
    apiKey?: string
  ): Promise<{
    ok: boolean;
    current?: 'local' | 'deepseek';
    reason?: string;
    /** Uzak saglayici icin anahtar gerekiyor ve yok. */
    apiKeyRequired?: boolean;
    /** Gecis yapildiysa etkin uc nokta (anahtar icermez). */
    baseUrl?: string;
    persisted?: boolean;
    persistError?: string;
  }> {
    if (this.isModelSwitching) {
      return { ok: false, reason: 'Başka bir model değişimi sürüyor' };
    }

    const preset = llmProviderPreset(provider);
    if (!preset) return { ok: false, reason: `Bilinmeyen sağlayıcı: ${provider}` };

    // Anahtar: istekte verilen > kayitli dosya.
    const provided = String(apiKey ?? '').trim();
    const effectiveKey = preset.requiresApiKey
      ? provided || readApiKeyFile(preset.id)
      : this.apiKeyFor('local');

    if (preset.requiresApiKey && !effectiveKey) {
      return {
        ok: false,
        current: this.effectiveLlmProvider(),
        apiKeyRequired: true,
        reason: `${preset.label} için API anahtarı gerekli`,
      };
    }

    if (!this.llmEngine) return { ok: false, reason: 'LLM motoru hazır değil' };

    this.isModelSwitching = true;
    try {
      // Once anahtar kalici yazilir: `setProvider` dogrulamasi ANAHTARI
      // kullanacagi icin dosyanin once hazir olmasi gerekir. Dogrulama
      // basarisiz olursa anahtar geri alinir (asagida).
      const previousKey = readApiKeyFile(preset.id);
      let keyWritten = false;
      if (preset.requiresApiKey && provided) {
        const written = writeApiKeyFile(preset.id, provided);
        if (!written.ok) {
          return {
            ok: false,
            reason: `API anahtarı yazılamadı: ${written.error ?? 'bilinmeyen hata'}`,
          };
        }
        keyWritten = true;
      }

      let model = preset.defaultModel ?? this.config.llm.model;
      // Uzak saglayicida model listesi dogrulanir: yanlis model adi her turu
      // bos yanita cevirirdi. Ulasilamazsa onerilen adla devam edilir.
      if (preset.requiresApiKey) {
        const offered = await scanLlmModels(preset.baseUrl, effectiveKey, model);
        const usable = offered.filter((option) => option.available);
        if (usable.length > 0 && !usable.some((option) => option.id === model)) {
          model = usable[0].id;
        }
      }

      try {
        await this.llmEngine.setProvider({
          baseUrl: preset.baseUrl,
          model,
          apiKey: effectiveKey,
        });
      } catch (error) {
        // Dogrulama basarisiz: yazilan anahtari geri al (kullanici yanlis
        // anahtar girdiyse dosyada kalmasin).
        if (keyWritten) writeApiKeyFile(preset.id, previousKey);
        return {
          ok: false,
          current: this.effectiveLlmProvider(),
          reason: `Sağlayıcıya ulaşılamadı: ${(error as Error).message}`,
        };
      }

      this.config.llm.provider = preset.id;
      this.config.llm.baseUrl = preset.baseUrl;
      this.config.llm.model = model;
      this.modelOverride.llm = model;

      telemetry.log('info', 'llm', `sağlayıcı: ${preset.label} (${model})`);
      this.emit('model-change', {
        kind: 'llm',
        model,
        provider: preset.id,
        sessionId: this.sessionId,
      });

      // Kalicilik: saglayici + model birlikte yazilir. `DIJI_LLM_BASE_URL`
      // YAZILMAZ; preset zaten dogru adresi tasir ve kullanici elle farkli
      // bir adres girmisse onu ezmek istemeyiz.
      const world = writeEnvVars({
        DIJI_LLM_PROVIDER: preset.id,
        ...(preset.id === 'deepseek' ? { DIJI_LLM_MODEL: model } : {}),
      });

      return {
        ok: true,
        current: preset.id,
        baseUrl: preset.baseUrl,
        persisted: world.ok,
        persistError: world.ok ? undefined : world.error,
      };
    } finally {
      this.isModelSwitching = false;
    }
  }

  /** STT'nin diskte arayacağı ön ek sırası (`stt.ts` ile aynı kural). */
  private sttPriority(): string[] {
    const configured = this.config.stt.modelPriority;
    if (configured && configured.length > 0) return configured;
    const prefix = this.config.stt.modelPrefix;
    if (prefix) return [prefix];
    return ['medium', 'small', 'base', 'tiny'];
  }

  /**
   * Etkin TTS model kimliği.
   *
   * Öncelik ÇALIŞAN motordadır: `config.tts.provider` yalnızca kullanıcının
   * niyetidir. Drifting TTS başlatılamayıp `sherpa-vits`'e düşüldüğünde
   * yapılandırma hâlâ `drifting-tts` der; panelde çalışmayan bir sağlayıcıyı
   * "seçili" göstermek yanıltıcı olurdu (canlı doğrulamada yakalandı).
   */
  private effectiveTtsModel(): string {
    const running = this.ttsEngine?.getModelName();
    if (running) return running;
    if (this.modelOverride.tts) return this.modelOverride.tts;
    if (this.config.tts.provider !== 'sherpa-vits') return this.config.tts.provider;
    return this.config.tts.model;
  }

  private effectiveLlmModel(): string {
    return this.modelOverride.llm ?? this.config.llm.model;
  }

  /**
   * Ayarlar ekranından model değiştirir.
   *
   * Davranış türe göre farklıdır ve bu bilinçlidir:
   *   - **llm**: yeni ad her istekte gövdede gider; motor yeniden başlatılmaz
   *     (anında etkili, ~50 ms).
   *   - **stt**: Whisper tanıyıcısı modeli yükleme anında sabitler; motor
   *     dispose edilip yeniden başlatılır (~1–4 sn). Bu sırada mikrofon
   *     kısa süre durabilir.
   *   - **tts**: VITS motoru da modeli yükleme anında sabitler; yeniden
   *     başlatılır (drifting-tts seçiliyse Python köprüsü yeniden kurulur,
   *     ~60–70 sn sürebilir — bu yüzden yanıtta `slow: true` döner).
   *
   * Seçim önce KATALOGDAN doğrulanır: kullanılamaz bir model kimliği
   * gönderilirse ajan bozuk duruma düşmez, açık hata döner.
   */
  async selectModel(kind: ModelKind, id: string): Promise<ModelSelectOutcome> {
    if (this.isModelSwitching) {
      return { ok: false, reason: 'Başka bir model değişimi sürüyor' };
    }

    const wanted = String(id ?? '').trim();
    if (!wanted) return { ok: false, reason: 'Model kimliği boş' };

    this.isModelSwitching = true;
    try {
      const catalog = await this.getModelCatalog();
      const check = assertModelSelectable(catalog, kind, wanted);
      if (!check.ok) return { ok: false, reason: check.reason };

      /**
       * Aynı model yeniden seçilirse MOTOR DURDURULMAZ.
       *
       * Neden önemli: STT/TTS motorları modeli yükleme anında sabitler, bu
       * yüzden "değiştir" yolu dispose + initialize demektir (STT ~2-6 sn,
       * drifting-tts ~60-70 sn). Kullanıcı açılır listede zaten seçili olan
       * satıra dokunursa motoru boşuna durdurmak mikrofonu/sesi gereksiz
       * keser (canlı doğrulamada aynı model seçiminde 8 sn bekleme ölçüldü).
       *
       * Kalıcılık YİNE yazılır: kullanıcı "bu modeli kalıcı yap" demiş olur
       * (ör. env dosyasında hiç yoksa ilk kez eklenir).
       */
      const currentNow =
        kind === 'llm'
          ? this.llmEngine?.getModelName() ?? this.effectiveLlmModel()
          : kind === 'stt'
            ? this.sttEngine?.getModelName().replace(/^whisper-/, '') ?? catalog.stt.current
            : this.effectiveTtsModel();
      if (currentNow === wanted) {
        this.modelOverride[kind] = wanted;
        const persist = this.persistModelChoice(kind, wanted);
        return { ok: true, current: currentNow, ...persist };
      }

      if (kind === 'llm') {
        if (!this.llmEngine) return { ok: false, reason: 'LLM motoru hazır değil' };
        await this.llmEngine.setModel(wanted);
        this.modelOverride.llm = wanted;
        telemetry.log('info', 'llm', `model değişti: ${wanted}`);
        this.emit('model-change', { kind, model: wanted, sessionId: this.sessionId });
        const persist = this.persistModelChoice('llm', wanted);
        return { ok: true, current: this.llmEngine.getModelName(), ...persist };
      }

      if (kind === 'stt') {
        await this.restartStt(wanted);
        this.modelOverride.stt = wanted;
        telemetry.log('info', 'stt', `model değişti: whisper-${wanted}`);
        this.emit('model-change', { kind, model: wanted, sessionId: this.sessionId });
        // `current` ÇALIŞAN motordan okunur: yeni dosya eksikse STT yedek
        // modele düşebilir ve panel bunu dürüstçe göstermelidir.
        const current = this.sttEngine?.getModelName() ?? `whisper-${wanted}`;
        const persist = this.persistModelChoice('stt', wanted, current);
        return { ok: true, current, ...persist };
      }

      // TTS: sağlayıcı adı seçildiyse sağlayıcı değişir, dizin adı seçildiyse
      // `sherpa-vits` sağlayıcısı o dizinle yeniden kurulur.
      const isProvider = wanted === 'drifting-tts' || wanted === 'sherpa-vits';
      // `drifting-tts` Python köprüsünü yeniden başlatır (~60-70 sn model
      // yüklemesi); `sherpa-vits` ONNX modelini yükler (~1-3 sn). Arayüz uzun
      // süren geçişte "yükleniyor" göstergesini buna göre uzatır.
      const slow = wanted === 'drifting-tts';
      await this.restartTts(
        wanted,
        isProvider ? (wanted as 'drifting-tts' | 'sherpa-vits') : 'sherpa-vits'
      );
      this.modelOverride.tts = wanted;
      telemetry.log('info', 'tts', `model değişti: ${wanted}`);
      this.emit('model-change', { kind, model: wanted, sessionId: this.sessionId });
      // Gerçek sonucu bildir: drifting-tts istenip sherpa'ya düşüldüyse
      // `current` sherpa modelidir. Kalıcılık da ÇALIŞAN sağlayıcıya göre
      // yazılır — aksi halde her açılışta başarısız sağlayıcı denenirdi.
      const running = this.ttsEngine?.getModelName() || 'sherpa-vits';
      const persist = this.persistModelChoice('tts', wanted, running);
      return { ok: true, current: running, slow, ...persist };
    } catch (error) {
      logError('Model degistirilemedi', error as Error, { kind, id: wanted });
      return { ok: false, reason: (error as Error).message };
    } finally {
      this.isModelSwitching = false;
    }
  }

  /**
   * Seçilen modeli `~/.config/diji/env` dosyasına yazar (kalıcı).
   *
   * Neden env dosyası: ajan yapılandırması [`env-bootstrap.ts`](agent/src/env-bootstrap.ts:1)
   * ile EN ERKEN aşamada bu dosyadan okunur; yazılan anahtar bir sonraki
   * açılışta hiçbir ek kod çalışmadan etkili olur (bkz. `env-prefs.ts`).
   *
   * Kalıcılık başarısız olsa bile model DEĞİŞİKLİĞİ geri alınmaz: seçim bu
   * süreçte geçerlidir, arayüz `persisted:false` görüp kullanıcıyı uyarır.
   *
   * @param running TTS için ÇALIŞAN model/sağlayıcı; istenen değil (düşüş olabilir).
   */
  private persistModelChoice(
    kind: ModelKind,
    wanted: string,
    running?: string
  ): { persisted: boolean; persistError?: string } {
    let updates: Record<string, string>;

    if (kind === 'llm') {
      updates = { DIJI_LLM_MODEL: wanted };
    } else if (kind === 'stt') {
      // `DIJI_STT_MODEL_PREFIX` oncelik listesinin basina alinir (bkz. default.ts
      // buildSttPriority). `DIJI_STT_MODEL` bilgilendirici tam addir.
      updates = {
        DIJI_STT_MODEL_PREFIX: wanted,
        DIJI_STT_MODEL: running ?? `whisper-${wanted}`,
      };
    } else {
      // TTS iki anahtar ister: sağlayıcı ve (sherpa ise) model dizini.
      // `drifting-tts` sağlayıcı adı olarak yazılır; dizin adı seçildiyse
      // `sherpa-vits` sağlayıcısı + o dizin yazılır.
      const isProvider = wanted === 'drifting-tts' || wanted === 'sherpa-vits';
      if (isProvider) {
        updates = { DIJI_TTS_PROVIDER: wanted };
      } else {
        updates = { DIJI_TTS_PROVIDER: 'sherpa-vits', DIJI_TTS_VITS_MODEL: running ?? wanted };
      }
    }

    const result = writeEnvVars(updates);
    if (!result.ok) {
      telemetry.log('warn', kind, `seçim kaydedilemedi: ${result.error ?? 'bilinmeyen hata'}`);
      return { persisted: false, persistError: result.error };
    }
    telemetry.log('info', kind, `seçim kalıcı yazıldı: ${result.path}`);
    return { persisted: true };
  }

  /** Whisper tanıyıcısını yeni ön ek ile yeniden kurar. */
  private async restartStt(prefix: string): Promise<void> {
    const sttConfig = this.config.stt as unknown as STTConfig;

    if (this.sttEngine) {
      await this.sttEngine.dispose();
      this.sttEngine = null;
    }

    // Modeli TEK ön eke sabitle: aksi halde `modelPriority` diskte bulduğu
    // ilk (muhtemelen daha büyük) modeli yükler ve seçim yok sayılır.
    this.sttEngine = new STTEngine(sttConfig, {
      modelDir: sttConfig.modelPath,
      modelPrefix: prefix,
      modelPriority: [prefix],
      numThreads: sttConfig.numThreads,
      executionProvider: sttConfig.executionProvider,
    });
    await this.sttEngine.initialize();
  }

  /** TTS motorunu yeni model/sağlayıcı ile yeniden kurar. */
  private async restartTts(
    modelOrProvider: string,
    provider: 'drifting-tts' | 'sherpa-vits'
  ): Promise<void> {
    const baseConfig = this.config.tts as TTSConfig;

    if (this.ttsEngine) {
      await this.ttsEngine.dispose();
      this.ttsEngine = null;
    }

    const nextConfig: TTSConfig = {
      ...baseConfig,
      provider,
      // Sağlayıcı adı seçildiyse model alanı dokunulmaz; dizin adı seçildiyse
      // `model` alanına yazılır (tts.ts model dizinini KNOWN_TTS_DIRS + `model`
      // üzerinden çözer).
      model: provider === 'sherpa-vits' ? modelOrProvider : baseConfig.model,
    };

    this.ttsEngine = new TTSEngine(nextConfig, {
      modelPath: baseConfig.modelPath,
      speakerId: baseConfig.speakerId,
    });
    await this.ttsEngine.initialize();
  }

  /**
   * Çalışma zamanı TTS anahtarının mevcut değeri (true = açık).
   *
   * Karar sırası: önce `ttsOverride` (kullanıcı seçimi), yoksa
   * `DIJI_TTS_ENABLED` ortam değişkeni.
   */
  isTtsEnabled(): boolean {
    return !ttsDisabled(this);
  }

  /**
   * TTS'i çalışma zamanında açar/kapatır. `null` = env'e geri dön.
   *
   * `return` değeri değişiklikten SONRAKİ gerçek durumdur (true = ses açık).
   */
  setTtsEnabled(enabled: boolean | null): boolean {
    this.ttsOverride = enabled;
    const aktif = this.isTtsEnabled();

    logInfo(
      enabled === null ? 'TTS ortam degiskenine geri dondu' : 'TTS calisma zamani anahtari degisti',
      {
        enabled,
        aktif,
      }
    );

    // Panelin doğru durumu göstermesi için telemetriye yayınla: TTS kapalıyken
    // satır "hazır" görünürse kullanıcı yanıtın neden sessiz olduğunu anlayamaz.
    // `emit()` telemetriye de beslenir; `tts-toggle` olayı orada TTS/OYNATMA
    // aşamalarını günceller ve menü senkronizasyonu için SSE'ye düşer.
    this.emit('tts-toggle', { enabled: aktif, override: enabled, sessionId: this.sessionId });
    return aktif;
  }

  /** Kontrol sunucusunun telemetri için kullandığı ham override değeri. */
  getTtsOverride(): boolean | null {
    return this.ttsOverride;
  }

  on(eventType: string, callback: (event: PipelineEvent) => void): void {
    if (!this.eventCallbacks.has(eventType)) {
      this.eventCallbacks.set(eventType, []);
    }
    this.eventCallbacks.get(eventType)!.push(callback);
  }

  off(eventType: string, callback: (event: PipelineEvent) => void): void {
    const callbacks = this.eventCallbacks.get(eventType);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    }
  }

  private emit(eventType: string, data: unknown): void {
    // Telemetri her zaman beslenir: arayüz sonradan bağlansa bile anlık
    // durumu görebilir (dinleyici yoksa bile aşama durumu güncellenir).
    try {
      telemetry.ingestPipelineEvent(eventType, data);
    } catch {
      /* telemetri asla pipeline'ı bozmaz */
    }

    const callbacks = this.eventCallbacks.get(eventType);
    if (callbacks) {
      const event: PipelineEvent = {
        type: eventType as PipelineEvent['type'],
        data,
        timestamp: new Date(),
        sessionId: this.sessionId,
      };

      for (const callback of callbacks) {
        try {
          callback(event);
        } catch (error) {
          logError('Event callback hatasi', error as Error, {
            eventType,
          });
        }
      }
    }
  }

  private generateSessionId(): string {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  }

  /**
   * Bu turda kullanılacak LLM modelinin adı.
   *
   * Ayarlar'dan model değiştirildiğinde `config.llm.model` DEĞİŞMEZ (motor
   * yapılandırması açılışta sabittir); gerçek ad `modelOverride.llm`'dedir.
   * Yalnızca `config` okunsaydı telemetri ve tur gecikmesi eski modeli
   * gösterirdi.
   */
  private llmModelName(): string {
    if (this.modelOverride.llm) return this.modelOverride.llm;
    const llm = this.config.llm as { model?: string } | undefined;
    return llm?.model ?? '';
  }

  /**
   * Kullanıcı mesajını ARAYÜZ sohbet geçmişine ekler.
   *
   * `conversationHistory` (LLM'e giden) DEĞİL, telemetrinin `displayHistory`
   * listesi kullanılır: sistem/tool mesajları arayüze sızmaz.
   */
  private recordUserMessage(text: string, source: 'voice' | 'text'): void {
    const clean = text.trim();
    if (!clean) return;
    telemetry.appendConversation({ role: 'user', text: clean, source });
  }

  /**
   * Asistan yanıtını ARAYÜZ sohbet geçmişine ekler.
   *
   * `latencyMs` turun uçtan uca süresidir (henüz ölçülmediyse eklenmez;
   * ölçüm tamamlandığında `telemetry.attachLatencyToLastAssistant()` ile
   * sonradan işlenir).
   */
  private recordAssistantMessage(
    text: string,
    source: 'voice' | 'text',
    latencyMs?: number
  ): void {
    const clean = text.trim();
    if (!clean) return;
    telemetry.appendConversation({
      role: 'assistant',
      text: clean,
      source,
      ...(typeof latencyMs === 'number' && latencyMs > 0 ? { latencyMs } : {}),
    });
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.conversationHistory = [];
    this.eventCallbacks.clear();
    logInfo('Pipeline dispose edildi', { sessionId: this.sessionId });
  }
}

export const createVoicePipeline = (config: AgentConfig): VoicePipeline => {
  return new VoicePipeline(config);
};
