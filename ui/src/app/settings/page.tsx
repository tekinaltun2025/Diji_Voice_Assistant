import { useEffect, useState } from 'react';

// Basit bir ayar sayfasi. Seçimler localStorage'da saklanir.
// LLM, STT ve TTS modelleri örnek listelerle sunulmuştur.

interface Settings {
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  theme: 'light' | 'dark';
}

const defaultSettings: Settings = {
  llmModel: 'gemini',
  sttModel: 'whisper-medium',
  ttsModel: 'vits-piper-tr',
  theme: 'light',
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  // Component mount old settings load
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('dijiSettings') : null;
    if (stored) {
      try {
        setSettings(JSON.parse(stored) as Settings);
      } catch {
        // ignore parse error, keep defaults
      }
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setSettings((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== 'undefined') {
      localStorage.setItem('dijiSettings', JSON.stringify(settings));
    }
    // Tema değişikliği için body class güncellenir
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    alert('Ayarlar kaydedildi');
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Ayarlar</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block mb-1 font-medium" htmlFor="llmModel">
            LLM Modeli
          </label>
          <select
            id="llmModel"
            name="llmModel"
            value={settings.llmModel}
            onChange={handleChange}
            className="w-full border rounded p-2"
          >
            <option value="gemini">Gemini (Google)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div>
          <label className="block mb-1 font-medium" htmlFor="sttModel">
            STT Modeli
          </label>
          <select
            id="sttModel"
            name="sttModel"
            value={settings.sttModel}
            onChange={handleChange}
            className="w-full border rounded p-2"
          >
            <option value="whisper-medium">Whisper Medium</option>
            <option value="whisper-large">Whisper Large</option>
            <option value="vits-piper-tr">VITS TR (Piper)</option>
          </select>
        </div>
        <div>
          <label className="block mb-1 font-medium" htmlFor="ttsModel">
            TTS Modeli
          </label>
          <select
            id="ttsModel"
            name="ttsModel"
            value={settings.ttsModel}
            onChange={handleChange}
            className="w-full border rounded p-2"
          >
            <option value="vits-piper-tr">VITS TR (Piper)</option>
            <option value="drifting-tts">Drifting TTS</option>
          </select>
        </div>
        <div>
          <label className="block mb-1 font-medium" htmlFor="theme">
            Tema
          </label>
          <select
            id="theme"
            name="theme"
            value={settings.theme}
            onChange={handleChange}
            className="w-full border rounded p-2"
          >
            <option value="light">Açık</option>
            <option value="dark">Koyu</option>
          </select>
        </div>
        <button
          type="submit"
          className="mt-4 bg-primary text-white px-4 py-2 rounded hover:bg-primary-dark"
        >
          Kaydet
        </button>
      </form>
    </div>
  );
}
