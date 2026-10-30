declare module '@mlx-community/whisper' {
  export function loadModel(model: string): Promise<unknown>;
  export function transcribe(model: unknown, audio: unknown): Promise<string>;
}

declare module '@silero-vad/node' {
  export function load(opts: { threshold: number; sampleRate: number }): Promise<unknown>;
  export function isSpeech(model: unknown, audio: Float32Array): Promise<boolean>;
}
