import { contextBridge, ipcRenderer } from 'electron';

interface DijiAPI {
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
  agentState: () => Promise<unknown>;
  agentListen: (enabled: boolean) => Promise<unknown>;
  agentAsk: (text: string) => Promise<unknown>;
  agentConfirm: (confirmed: boolean) => Promise<unknown>;
  /** TTS aç/kapat. `null` = ortam değişkenine (varsayılan) geri dön. */
  agentTts: (enabled: boolean | null) => Promise<unknown>;
  onTelemetry: (callback: (event: unknown) => void) => () => void;
}

contextBridge.exposeInMainWorld('diji', {
  showWindow: () => ipcRenderer.invoke('diji:show-window'),
  hideWindow: () => ipcRenderer.invoke('diji:hide-window'),
  setStatus: (status: string) => {
    ipcRenderer.send('diji:set-status', status);
  },
  activateNode: (nodeId: string) => {
    ipcRenderer.send('diji:activate-node', nodeId);
  },
  deactivateNode: (nodeId: string) => {
    ipcRenderer.send('diji:deactivate-node', nodeId);
  },
  getSettings: () => ipcRenderer.invoke('diji:get-settings'),
  setSettings: (settings: Partial<Record<string, unknown>>) =>
    ipcRenderer.invoke('diji:set-settings', settings),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('diji:set-auto-start', enabled),
  setAlwaysOnTop: (enabled: boolean) => ipcRenderer.invoke('diji:set-always-on-top', enabled),
  onStatusUpdate: (callback: (status: string) => void) => {
    const handler = (_event: unknown, status: string) => {
      callback(status);
    };
    ipcRenderer.on('diji:status-update', handler);
    return () => {
      ipcRenderer.off('diji:status-update', handler);
    };
  },
  onNodeActivate: (callback: (nodeId: string) => void) => {
    const handler = (_event: unknown, nodeId: string) => {
      callback(nodeId);
    };
    ipcRenderer.on('diji:node-activate', handler);
    return () => {
      ipcRenderer.off('diji:node-activate', handler);
    };
  },
  onNodeDeactivate: (callback: (nodeId: string) => void) => {
    const handler = (_event: unknown, nodeId: string) => {
      callback(nodeId);
    };
    ipcRenderer.on('diji:node-deactivate', handler);
    return () => {
      ipcRenderer.off('diji:node-deactivate', handler);
    };
  },
  sendVoiceCommand: (command: string) => {
    ipcRenderer.send('voice-command', command);
  },
  onVoiceResponse: (callback: (response: unknown) => void) => {
    const handler = (_event: unknown, response: unknown) => {
      callback(response);
    };
    ipcRenderer.on('voice-response', handler);
    return () => {
      ipcRenderer.off('voice-response', handler);
    };
  },
  // ---- ses ajanı köprüsü ----
  agentState: () => ipcRenderer.invoke('diji:agent-state'),
  agentListen: (enabled: boolean) => ipcRenderer.invoke('diji:agent-listen', enabled),
  agentAsk: (text: string) => ipcRenderer.invoke('diji:agent-ask', text),
  agentConfirm: (confirmed: boolean) => ipcRenderer.invoke('diji:agent-confirm', confirmed),
  agentTts: (enabled: boolean | null) => ipcRenderer.invoke('diji:agent-tts', enabled),
  onTelemetry: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      callback(payload);
    };
    ipcRenderer.on('diji:telemetry', handler);
    return () => {
      ipcRenderer.off('diji:telemetry', handler);
    };
  },
});

// Global Window augmentation is defined in shared/types/ui.ts