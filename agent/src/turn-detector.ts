import { TurnDetectorConfig } from '@diji/shared';
import { logger, logInfo, logError, logDebug } from '@diji/shared';

export interface TurnDetectorResult {
  shouldEndTurn: boolean;
  reason: 'punctuation' | 'conjunction' | 'filler' | 'silence' | 'incomplete' | 'complete';
  confidence: number;
  timestamp: Date;
}

export class TurkishTurnDetector {
  private config: TurnDetectorConfig;
  private isInitialized: boolean = false;
  private lastText: string = '';
  private silenceStartTime: number | null = null;
  private turnEndTimeout: NodeJS.Timeout | null = null;
  private targetTurnEndTime: number = 900; // 0.9s hedef

  // Türkçe bağlaç kelimeleri - cümle sonu bu kelimelerle bitiyorsa konuşma tamamlanmamış demektir
  private readonly CONJUNCTIONS = [
    've',
    'ama',
    'çünkü',
    'yani',
    'şey',
    'fakat',
    'ancak',
    'veya',
    'ya da',
    'oysa',
    'buna göre',
    'dolayısıyla',
    'bu yüzden',
  ];

  // Türkçe dolgu kelimeleri
  private readonly FILLER_WORDS = [
    'şey',
    'yani',
    'işte',
    'demek',
    'hani',
    'işte',
    'yani',
    'şey',
  ];

  constructor(config: TurnDetectorConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      logInfo('Türkçe Turn Detector başlatılıyor', {
        fillerWords: this.config.fillerWords,
        conjunctions: this.config.conjunctions,
        punctuationEndsTurn: this.config.punctuationEndsTurn,
        maxSilenceBeforeTurn: this.config.maxSilenceBeforeTurn,
      });

      this.isInitialized = true;
      logInfo('Türkçe Turn Detector başarıyla başlatıldı');
    } catch (error) {
      logError('Türkçe Turn Detector başlatılamadı', error as Error);
      throw error;
    }
  }

  shouldEndTurn(text: string, silenceDuration: number): TurnDetectorResult {
    if (!this.isInitialized) {
      throw new Error('Turn Detector başlatılmamış');
    }

    const trimmed = text.trim();
    const lowerText = trimmed.toLowerCase();
    const timestamp = new Date();

    // Boş metin
    if (!trimmed) {
      return {
        shouldEndTurn: false,
        reason: 'incomplete',
        confidence: 0,
        timestamp,
      };
    }

    this.lastText = trimmed;

    // Kural 1: Cümle sonu noktalama işareti ile bitiyorsa (. ? !) → konuşma tamamlandı
    if (this.config.punctuationEndsTurn && /[.!?]$/.test(trimmed)) {
      return {
        shouldEndTurn: true,
        reason: 'punctuation',
        confidence: 0.95,
        timestamp,
      };
    }

    // Kural 2: Cümle "..." ile bitiyorsa → bekle (tamamlanmamış)
    if (/\.\.\.$/.test(trimmed)) {
      return {
        shouldEndTurn: false,
        reason: 'incomplete',
        confidence: 0.9,
        timestamp,
      };
    }

    // Kural 3: Cümle "," ile bitiyorsa → bekle (tamamlanmamış)
    if (/,$/.test(trimmed)) {
      return {
        shouldEndTurn: false,
        reason: 'incomplete',
        confidence: 0.9,
        timestamp,
      };
    }

    // Kural 4: Cümle bağlaç kelimesi ile bitiyorsa → bekle (tamamlanmamış)
    for (const conjunction of this.config.conjunctions) {
      if (lowerText.endsWith(conjunction.toLowerCase())) {
        return {
          shouldEndTurn: false,
          reason: 'conjunction',
          confidence: 0.85,
          timestamp,
        };
      }
    }

    // Kural 5: Cümle dolgu kelimesi ile BİTİYORSA → bekle (tamamlanmamış).
    // NOT: Eskiden `includes()` kullaniliyordu; bu, cumlenin ortasinda gecen
    // "yani"/"sey" gibi kelimelerde turu sonsuza kadar acik tutuyordu.
    const lastWord = lowerText.split(/[\s,;:]+/).filter(Boolean).pop() ?? '';
    for (const filler of this.config.fillerWords) {
      if (lastWord === filler.toLowerCase()) {
        return {
          shouldEndTurn: false,
          reason: 'filler',
          confidence: 0.8,
          timestamp,
        };
      }
    }

    // Kural 6: Noktalama YOK. Burada iki durum ayirt edilir:
    //  a) Sessizlik esigi asildi -> kullanici konusmayi bitirdi, tur kapanir.
    //  b) Sessizlik yetersiz -> kullanici devam ediyor olabilir, bekle.
    // ONEMLI: Eskiden burada kosulsuz `return false` vardi. Whisper cogu
    // zaman noktalama uretmedigi icin tur HIC kapanmiyor, LLM hic
    // cagrilmiyor ve asistan sessiz kaliyordu (asil hata).
    if (silenceDuration >= this.config.maxSilenceBeforeTurn) {
      return {
        shouldEndTurn: true,
        reason: 'silence',
        confidence: 0.8,
        timestamp,
      };
    }

    // Varsayılan: sessizlik yetersiz, kullanici devam ediyor olabilir
    return {
      shouldEndTurn: false,
      reason: 'incomplete',
      confidence: 0.6,
      timestamp,
    };
  }

  /**
   * 0.9s hedefli turn-end kararını değerlendirir.
   * Bu metin, pipeline tarafından sessizlik süresi takip edilirken çağrılır.
   */
  evaluateTurnEnd(
    text: string,
    silenceDuration: number,
    targetTimeMs: number = this.targetTurnEndTime
  ): TurnDetectorResult {
    const result = this.shouldEndTurn(text, silenceDuration);

    // Eğer hedef süreye ulaşıldıysa ve konuşma tamamlanmamışsa, yine de turn'ı bitir
    if (!result.shouldEndTurn && silenceDuration >= targetTimeMs) {
      return {
        shouldEndTurn: true,
        reason: 'silence',
        confidence: 0.65,
        timestamp: new Date(),
      };
    }

    return result;
  }

  reset(): void {
    this.lastText = '';
    this.silenceStartTime = null;

    if (this.turnEndTimeout) {
      clearTimeout(this.turnEndTimeout);
      this.turnEndTimeout = null;
    }

    logDebug('Turn Detector sıfırlandı');
  }

  getLastText(): string {
    return this.lastText;
  }

  async dispose(): Promise<void> {
    this.reset();
    this.isInitialized = false;
    logInfo('Türkçe Turn Detector kapatıldı');
  }
}

export const createTurkishTurnDetector = (
  config: TurnDetectorConfig
): TurkishTurnDetector => {
  return new TurkishTurnDetector(config);
};