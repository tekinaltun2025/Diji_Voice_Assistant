/**
 * Sesli pipeline yapilandirma tipleri.
 *
 * Not: Tum sure birimleri SANIYE cinsindendir (sherpa-onnx ile uyumlu).
 */

/**
 * Ses ön işleme (preprocess) ayarları.
 *
 * Türkçe STT doğruluğunu artıran zincir: DC temizliği → yüksek geçiren
 * filtre → sessizlik kırpma → gürültü kapısı → otomatik kazanç denetimi.
 * Her adım tek tek kapatılabilir; varsayılanlar konuşma için güvenli
 * aralıklarda seçilmiştir.
 */
export interface STTPreprocessConfig {
  /** Ön işleme zinciri açık mı? Varsayılan: true. */
  enabled?: boolean;
  /** Yüksek geçiren filtre kesim frekansı (Hz). 0 = kapalı. Varsayılan: 80. */
  highPassHz?: number;
  /**
   * Baştan/sondan sessizliği kırp.
   *
   * Neden kritik: Whisper sessiz bölgelerde halüsinasyon üretir
   * ("İzlediğiniz için teşekkürler", "Altyazı M.K." gibi). Kırpma bu
   * hataların büyük kısmını ortadan kaldırır. Varsayılan: true.
   */
  trimSilence?: boolean;
  /** Kırpma eşiği (RMS, 0..1). Varsayılan: 0.006. */
  trimThreshold?: number;
  /** Kırpma sonrası başta/sonda bırakılacak pay (ms). Varsayılan: 120. */
  trimPaddingMs?: number;
  /** Otomatik kazanç denetimi hedef RMS (0..1). 0 = kapalı. Varsayılan: 0.06. */
  targetRms?: number;
  /** AGC ile uygulanabilecek azami kazanç (dB). Varsayılan: 18. */
  maxGainDb?: number;
  /** Gürültü kapısı eşiği (RMS, 0..1). 0 = kapalı. Varsayılan: 0.0025. */
  noiseGateRms?: number;
  /** Ön vurgu katsayısı (0..1; 0 = kapalı). Varsayılan: 0. */
  preEmphasis?: number;
}

/**
 * Transkript sonrası düzeltme (postprocess) ayarları.
 *
 * Whisper'ın Türkçe'de yaptığı tipik hataları hedefler: bitişik yazım
 * ("birşey" → "bir şey"), alan terimleri (takvim/gmail/notion), halüsinasyon
 * cümleleri ve noktalama gürültüsü.
 */
export interface STTPostprocessConfig {
  /** Son işleme açık mı? Varsayılan: true. */
  enabled?: boolean;
  /** Doğrudan değiştirme sözlüğü (yanlış → doğru), küçük harf anahtarlarla. */
  vocabulary?: Record<string, string>;
  /** Yakın-eşleşme düzeltmesi için terim listesi (marka/uygulama adları). */
  terms?: string[];
  /** Levenshtein azami mesafesi (1 önerilir; uzun kelimelerde ölçeklenir). Varsayılan: 1. */
  fuzzyDistance?: number;
  /** Whisper halüsinasyon kalıplarını temizle. Varsayılan: true. */
  stripHallucinations?: boolean;
  /** Türkçe bitişik yazım düzeltmeleri ("birşey" → "bir şey"). Varsayılan: true. */
  fixSpacing?: boolean;
}

export interface STTConfig {
  /** Konusma tanima arka ucu. Varsayilan: whisper (sherpa-onnx). */
  provider: 'whisper';
  /** Model adi ya da model dizini ipucu (or. "whisper-small"). */
  model: string;
  /** ISO dil kodu (or. "tr"). */
  language: string;
  device?: 'mlx' | 'cpu' | 'gpu';
  computeType?: 'float16' | 'int8' | 'float32';
  /** Whisper model dosyalarinin bulundugu dizin (bos ise otomatik aranir). */
  modelPath?: string;
  /** ONNX Runtime thread sayisi. */
  numThreads?: number;
  /** ONNX Runtime yurutucu. */
  executionProvider?: 'cpu' | 'cuda';
  /**
   * Tercih edilen model öneki (or. "medium").
   *
   * Doğruluk sırası: medium > small > base > tiny. Büyük model Türkçe'de
   * belirgin biçimde daha düşük WER verir; maliyeti CPU gecikmesidir.
   */
  modelPrefix?: string;
  /**
   * Diskte aranacak model önekleri, öncelik sırasıyla.
   *
   * Varsayılan: ['medium', 'small', 'base', 'tiny']. İlk bulunan kullanılır;
   * hiçbiri yoksa başlatma hatası verilir (sessiz sahte metin üretilmez).
   */
  modelPriority?: string[];
  /** Ses ön işleme zinciri (bkz. `STTPreprocessConfig`). */
  preprocess?: STTPreprocessConfig;
  /** Transkript sonrası düzeltme (bkz. `STTPostprocessConfig`). */
  postprocess?: STTPostprocessConfig;
}

export interface TTSConfig {
  /**
   * Seslendirme arka ucu.
   *
   * - `drifting-tts` : Vyvo/drifting-tts-tr (tek adimli Turkce TTS, 89.3M
   *                    params). Python kopru alt sureci uzerinden calisir;
   *                    native cikis 24 kHz'dir, istenen frekansa Python
   *                    tarafinda yeniden orneklenir.
   * - `sherpa-vits`  : Yerel Piper/VITS ONNX modeli (Node, sherpa-onnx-node).
   *                    `drifting-tts` baslatilamazsa kullanilan yedek yol.
   *
   * Varsayilan: drifting-tts.
   */
  provider: 'sherpa-vits' | 'drifting-tts';
  /** Model adi ya da model dizini ipucu. */
  model: string;
  /** Ses/konusmaci etiketi (bilgilendirici). */
  voice: string;
  device?: 'mlx' | 'cpu' | 'gpu';
  /** Konusma hizi carpani (1.0 = normal). */
  speed: number;
  /** Cok konusmacili modellerde konusmaci kimligi. */
  speakerId?: number;
  /** Model dosya/dizin yolu (bos ise ~/.diji/models altinda aranir). */
  modelPath?: string;
  /**
   * Uretilecek PCM ornekleme frekansi (Hz).
   *
   * Pipeline 16 kHz bekledigi icin varsayilan 16000'dir. `drifting-tts`
   * native olarak 24 kHz uretir ve istenen frekansa Python tarafinda
   * yeniden ornekler (16k/22.05k/24k/44.1k/48k desteklenir; diger degerler
   * en yakina yuvarlanir).
   */
  sampleRate?: number;
  /** Yalnizca `drifting-tts` icin: Python yorumlayicisi (varsayilan `python3`). */
  pythonPath?: string;
  /** Yalnizca `drifting-tts` icin: kopru betiginin yolu (bos ise otomatik). */
  bridgePath?: string;
}

export interface VADConfig {
  provider: 'silero';
  /** Konusma esigi (0..1). */
  threshold: number;
  /** Tur sonu icin gereken sessizlik suresi (SANIYE). */
  minSilenceDuration: number;
  /** Gecerli sayilan en kisa konusma suresi (SANIYE). */
  minSpeechDuration: number;
  /** Ornekleme frekansi (Hz). */
  sampleRate: number;
  /** silero_vad.onnx yolu (bos ise varsayilan dizinde aranir). */
  modelPath?: string;
}

export interface TurnDetectorConfig {
  provider: 'turkish-custom';
  fillerWords: string[];
  conjunctions: string[];
  punctuationEndsTurn: boolean;
  /** Bu sessizlik suresi (SANIYE) asilirsa tur biter. */
  maxSilenceBeforeTurn: number;
}

export interface VoicePipelineConfig {
  stt: STTConfig;
  tts: TTSConfig;
  vad: VADConfig;
  turnDetector: TurnDetectorConfig;
  llm: {
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
}
