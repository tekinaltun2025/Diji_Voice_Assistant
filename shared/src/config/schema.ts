import { z } from 'zod';

/**
 * Calisma zamani yapilandirma dogrulamasi.
 *
 * Not: LiveKit anahtarlari opsiyoneldir; yerel (tek makine) kurulumda
 * LiveKit sunucusu kullanilmadan da pipeline calisabilir.
 */
export const AgentConfigSchema = z.object({
  livekit: z.object({
    url: z.string().min(1),
    apiKey: z.string().default(''),
    apiSecret: z.string().default(''),
  }),
  stt: z.object({
    provider: z.literal('whisper'),
    model: z.string().min(1),
    language: z.string().min(1),
    device: z.enum(['mlx', 'cpu', 'gpu']).optional(),
    computeType: z.enum(['float16', 'int8', 'float32']).optional(),
    numThreads: z.number().int().positive().optional(),
    /** Model dosyalarinin bulundugu dizin (bos ise otomatik aranir). */
    modelPath: z.string().optional(),
    /** ONNX Runtime yurutucusu. */
    executionProvider: z.enum(['cpu', 'cuda']).optional(),
    /** Tercih edilen model oneki (or. "medium"). */
    modelPrefix: z.string().min(1).optional(),
    /** Diskte aranacak model onekleri, oncelik sirasiyla. */
    modelPriority: z.array(z.string().min(1)).optional(),
    preprocess: z
      .object({
        enabled: z.boolean().optional(),
        highPassHz: z.number().min(0).max(2000).optional(),
        trimSilence: z.boolean().optional(),
        trimThreshold: z.number().min(0).max(1).optional(),
        trimPaddingMs: z.number().min(0).max(5000).optional(),
        targetRms: z.number().min(0).max(1).optional(),
        maxGainDb: z.number().min(0).max(60).optional(),
        noiseGateRms: z.number().min(0).max(1).optional(),
        preEmphasis: z.number().min(0).max(1).optional(),
      })
      .optional(),
    postprocess: z
      .object({
        enabled: z.boolean().optional(),
        vocabulary: z.record(z.string()).optional(),
        terms: z.array(z.string().min(1)).optional(),
        fuzzyDistance: z.number().int().min(0).max(3).optional(),
        stripHallucinations: z.boolean().optional(),
        fixSpacing: z.boolean().optional(),
      })
      .optional(),
  }),
  tts: z.object({
    provider: z.union([z.literal('drifting-tts'), z.literal('sherpa-vits')]),
    model: z.string().min(1),
    voice: z.string().min(1),
    device: z.enum(['mlx', 'cpu', 'gpu']).optional(),
    speed: z.number().positive().max(3).default(1),
    speakerId: z.number().int().min(0).optional(),
    modelPath: z.string().optional(),
    /** Uretilecek PCM ornekleme frekansi (Hz). Pipeline 16 kHz bekler. */
    sampleRate: z.number().int().positive().optional(),
    /** `drifting-tts` koprusu icin Python yorumlayicisi. */
    pythonPath: z.string().optional(),
    /** `drifting-tts` kopru betigi yolu. */
    bridgePath: z.string().optional(),
  }),
  llm: z.object({
    provider: z.literal('ollama'),
    baseUrl: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().positive(),
    apiKey: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Reasoning modelleri icin ek token rezervi (0 = rezerv yok). */
    reasoningReserve: z.number().int().min(0).optional(),
  }),
  vad: z.object({
    provider: z.literal('silero'),
    threshold: z.number().min(0).max(1),
    minSilenceDuration: z.number().positive(),
    minSpeechDuration: z.number().positive(),
    sampleRate: z.number().int().positive(),
    modelPath: z.string().optional(),
  }),
  turnDetector: z.object({
    provider: z.literal('turkish-custom'),
    fillerWords: z.array(z.string()),
    conjunctions: z.array(z.string()),
    punctuationEndsTurn: z.boolean(),
    maxSilenceBeforeTurn: z.number().positive(),
  }),
  mcp: z.object({
    enabled: z.boolean(),
    permissionGate: z.object({
      read: z.boolean(),
      write: z.boolean(),
      delete: z.boolean(),
    }),
    servers: z
      .array(
        z.object({
          name: z.enum(['gmail', 'calendar', 'drive', 'notion', 'slack', 'chrome']),
          enabled: z.boolean(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
        })
      )
      .optional(),
  }),
});

export type AgentConfigSchemaType = z.infer<typeof AgentConfigSchema>;
