export interface UIConfig {
  electron: {
    port: number;
    width: number;
    height: number;
    resizable: boolean;
    fullscreen: boolean;
  };
  nextjs: {
    port: number;
    dev: boolean;
  };
  theme: {
    primary: string;
    secondary: string;
    background: string;
    surface: string;
    text: string;
  };
  language: 'tr-TR';
}

export interface VoiceAssistantState {
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  volume: number;
  muted: boolean;
  lastTranscript: string;
  lastResponse: string;
}

export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
}
export interface DijiAPI {
  showWindow: () => Promise<{ success: boolean }>;
  hideWindow: () => Promise<{ success: boolean }>;
  setStatus: (status: string) => void;
  activateNode: (nodeId: string) => void;
  deactivateNode: (nodeId: string) => void;
  getSettings: () => Promise<Record<string, unknown>>;
  setSettings: (settings: Partial<Record<string, unknown>>) => Promise<Record<string, unknown>>;
  setAutoStart: (enabled: boolean) => Promise<{ success: boolean }>;
  setAlwaysOnTop: (enabled: boolean) => Promise<{ success: boolean }>;
  onStatusUpdate: (callback: (status: string) => void) => () => void;
  onNodeActivate: (callback: (nodeId: string) => void) => () => void;
  onNodeDeactivate: (callback: (nodeId: string) => void) => () => void;
  sendVoiceCommand: (command: string) => void;
  onVoiceResponse: (callback: (response: unknown) => void) => () => void;
  /** Ajan köprüsü: TTS aç/kapat. `null` = ortam değişkenine geri dön. */
  agentTts: (enabled: boolean | null) => Promise<unknown>;
}

// Not: Window global augmentation UI tarafında (ui/src/types/global.d.ts) yapılır.
// shared paketi DOM lib'ine bağımlı olmamalıdır.