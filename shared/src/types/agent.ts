import {
  STTConfig,
  TTSConfig,
  VADConfig,
  TurnDetectorConfig,
} from './voice';

export interface AgentConfig {
  livekit: {
    url: string;
    apiKey: string;
    apiSecret: string;
  };
  stt: STTConfig;
  tts: TTSConfig;
  llm: {
    /**
     * LLM saglayicisi.
     *
     * `local`  : bu makinede calisan OpenAI uyumlu yonlendirici (varsayilan).
     * `deepseek`: uzak DeepSeek API'si (https://api.deepseek.com/v1).
     *
     * Deger yalnizca NIYETI anlatir; gercek kullanilan saglayici
     * `LLMEngine` icinde cozulur.
     */
    provider: 'local' | 'deepseek';
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    /** OpenAI uyumlu sunucu icin API anahtari (gerekmiyorsa bos). */
    apiKey?: string;
    /**
     * API anahtarinin okunacagi dosya (mutlak yol).
     *
     * Neden ayri dosya: `~/.config/diji/env` surekli duzenlenen bir dosya ve
     * kullanicilar onu paylasabilir/yedekleyebilir. Uzak saglayici anahtari
     * `~/.config/diji/secrets/deepseek.key` gibi YALNIZCA 0600 izinli ayri bir
     * dosyada tutulur. `apiKey` doluysa bu dosya okunmaz.
     */
    apiKeyFile?: string;
    /** Istek zaman asimi (ms). Agir modeller icin artirilabilir. */
    timeoutMs?: number;
    /**
     * Reasoning (dusunme) modelleri icin ek token rezervi.
     *
     * Hibrit reasoning modelleri (orn. "agent" = Qwen3.5) yanit vermeden once
     * uzun bir dusunme metni uretir. `maxTokens` yalnizca gorunur yanit icin
     * ayrilir; sunucuya `maxTokens + reasoningReserve` gonderilir. Aksi halde
     * model butceyi dusunmeye harcayip BOS yanit dondurur.
     *
     * Reasoning kullanmayan modeller icin 0 verin.
     */
    reasoningReserve?: number;
  };
  vad: VADConfig;
  turnDetector: TurnDetectorConfig;
  mcp: {
    enabled: boolean;
    permissionGate: {
      read: boolean;
      write: boolean;
      delete: boolean;
    };
    /** Sunucu komutlari bos ise varsayilan yerel paket yollari kullanilir. */
    servers?: Array<{
      name: 'gmail' | 'calendar' | 'drive' | 'notion' | 'slack' | 'chrome';
      enabled: boolean;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
}

export interface VoiceSession {
  id: string;
  userId: string;
  startedAt: Date;
  lastActivity: Date;
  isActive: boolean;
  language: 'tr-TR';
}

export interface AgentMessage {
  type: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}
