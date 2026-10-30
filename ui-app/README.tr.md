# Diji Voice Assistant — Masaüstü Arayüzü

**Türkçe** · [🇬🇧 English](README.md)

Diji ajanının Electron + TanStack Start arayüzü. **Bağımsız bir alt projedir**:
kendi `package.json`'ı, kendi bağımlılıkları ve kendi derleme hattı vardır.
Kök npm workspace'e dahil **değildir**.

Ajanla **kod bağımlılığı yoktur** — yalnızca HTTP/SSE üzerinden konuşur
(`127.0.0.1:8899`). Bu yüzden `npm install` iki tarafta ayrı yapılır.

---

## İçindekiler

- [Hızlı başlangıç](#hızlı-başlangıç)
- [Mimari](#mimari)
- [Klasör yapısı](#klasör-yapısı)
- [Ajanla iletişim](#ajanla-iletişim)
- [Ekran bölümleri](#ekran-bölümleri)
- [Ayarlar — model seçimi](#ayarlar--model-seçimi)
- [Derleme ve paketleme](#derleme-ve-paketleme)
- [Sorun giderme](#sorun-giderme)

---

## Hızlı başlangıç

Ön koşul: ajan derlenmiş ve çalışıyor olmalı (`../agent/dist/index.js`).

```bash
# 1. Bağımlılıklar
cd ui-app
npm install

# 2. Geliştirme (tarayıcıda, sıcak yeniden yükleme)
npm run dev                     # http://localhost:3000

# 3. Electron ile geliştirme
NODE_ENV=development npm run electron:dev

# 4. Üretim derlemesi + Electron
npm run build                   # → dist/
npm run electron:build          # → dist/ + electron/main.cjs
```

Ajan ayrı terminalde:

```bash
cd ..
npm start                       # veya: node agent/dist/index.js
curl -s http://127.0.0.1:8899/health   # {"ok":true,...}
```

> [!IMPORTANT]
> Kabuğunuzda `ELECTRON_RUN_AS_NODE=1` tanımlıysa Electron pencere açmaz,
> Node gibi davranır. Şununla başlatın:
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm run electron
> ```

---

## Mimari

```
┌───────────────────────────── Electron ana süreç (CJS) ─────────────────────────────┐
│                                                                                    │
│  electron/main.cjs                                                                 │
│    • BrowserWindow (contextIsolation:true, nodeIntegration:false, preload)          │
│    • Sistem tepsisi, global kısayol (Alt+Space), pencere konumu                    │
│    • Ajanı spawn eder: `node agent/dist/index.js` (10-20 sn yüklenme)              │
│    • app:// özel protokolü → dist/ varlıkları sunulur                              │
│                                                                                    │
│  electron/preload.cjs  ──contextBridge──▶  window.diji (dar yüzey, 10 metod)        │
│  electron/agent-bridge.cjs                                                                 │
│    • HTTP istemcisi  (GET/POST, 127.0.0.1:8899)                                    │
│    • SSE istemcisi   (/events → olayları renderer'a iter)                          │
│    • Sağlık yoklaması + otomatik yeniden bağlanma                                  │
└────────────────────────────────────┬───────────────────────────────────────────────┘
                                     │ IPC (kanal başına tek yön)
┌────────────────────────────────────▼───────────────────────────────────────────────┐
│  Renderer (React 19 + TanStack Router)                                             │
│    • use-agent.ts  → tüm ajan durumu tek hook'ta                                   │
│    • routes/index.tsx → Quantum Console arayüzü                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
                                     │ HTTP + SSE
                                     ▼
                           Diji ajanı (127.0.0.1:8899)
```

### Neden `app://` protokolü

SPA derlemesi `dist/client/_shell.html` üretir ve varlık yolları **mutlak**
(`/assets/…`). `file://` ile yüklendiğinde bu yollar dosya sisteminin köküne
gider ve sayfa boş açılır. Bu yüzden:

1. `scripts/prepare-electron.cjs` (kök depoda) `_shell.html`'i `index.html`
   olarak kopyalar ve `/assets/` → `./assets/` olarak yeniden yazar.
2. Electron `app://jarvis/` özel protokolünü kaydeder ve `dist/` dizinini sunar.

### Neden `isSpeaking` türetilir

```ts
// src/hooks/use-agent.ts
const isSpeaking = ttsStageActive || playbackStageActive;
```

Tek bir boolean bayrağa indirilirse barge-in sonrası arayüz `KONUŞUYOR`
durumunda asılı kalır. Barge-in `llm` + `tts` + `playback` üçünü birlikte
kapatır; iki aşamaya bakmak bu yarışı tolere eder.

---

## Klasör yapısı

```
ui-app/
├── electron/
│   ├── main.cjs              # Ana süreç: pencere, tray, kısayol, protokol, ajan spawn
│   ├── preload.cjs           # contextBridge → window.diji
│   └── agent-bridge.cjs      # HTTP + SSE istemcisi, sağlık yoklaması
├── src/
│   ├── routes/
│   │   ├── __root.tsx        # Kabuk
│   │   └── index.tsx         # Ana ekran (Quantum Console)
│   ├── hooks/
│   │   └── use-agent.ts      # Tek doğruluk kaynağı: tüm ajan durumu
│   ├── types/
│   │   └── diji.d.ts         # window.diji sözleşmesi (ajan API'sinin aynası)
│   └── styles.css            # Tasarım sistemi
├── dist/                     # Derleme çıktısı (gitignore)
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Ajanla iletişim

Tüm iletişim `window.diji` üzerinden. Ham `ipcRenderer` veya `fetch`
**kullanılmaz** — güvenlik yüzeyi dar tutulur.

```ts
interface DijiAPI {
  getState(): Promise<StatePayload>;
  isAvailable(): boolean;
  listen(enabled: boolean): Promise<ListenResult>;
  ask(text: string): Promise<AskResult>;            // 202, yanıt SSE'den
  setTts(enabled: boolean): Promise<TtsResult>;
  confirm(confirmed: boolean): Promise<ConfirmResult>;
  bargeIn(): Promise<BargeInResult>;
  getModels(): Promise<ModelCatalog>;
  selectModel(kind: ModelKind, id: string): Promise<ModelSelectResult>;
  onTelemetry(cb: (event: TelemetryEvent) => void): () => void;
  onConnection(cb: (status: ConnectionStatus) => void): () => void;
  readonly isElectron: true;
  readonly version: string;
}
```

Bu arayüz ajan API'sinin **birebir aynasıdır**. Yeni bir uç nokta eklenirse
önce [`src/types/diji.d.ts`](src/types/diji.d.ts) güncellenir, sonra
`electron/agent-bridge.cjs` ve `electron/preload.cjs`. Ajan sözleşmeleri için
[`../docs/API.tr.md`](../docs/API.tr.md) · [English](../docs/API.md).

### SSE olayları

Ayrım `data` içindeki `type` alanıyladır — yalnızca ilk olay (`snapshot`) ayrı
bir `event:` satırı taşır:

| `type` | Anlamı |
|---|---|
| *(yok — `snapshot`)* | Tam durum gövdesi |
| `stage` | Bir aşamanın durumu değişti |
| `log` | Teşhis satırı |
| `turn-latency` | Tur tamamlandı, gecikme dökümü |
| `conversation-update` | Sohbet geçmişi (tam liste) |
| `confirmation` | Onay bekleyen işlem açıldı/kapandı |
| `tts-toggle` | Seslendirme anahtarı değişti (tray dahil) |

---

## Ekran bölümleri

| Bölüm | İçerik |
|---|---|
| **Sol kenar çubuğu** | Navigasyon: Sohbet, Geçmiş, Ayarlar. Geçmiş ve Ayarlar birbirini kapatır. |
| **Kontrol düğmeleri** | Mikrofon aç/kapat, TTS aç/kapat, Barge-in (kes) |
| **Sahne** | Ses görselleştirmesi + aşama göstergesi |
| **Sohbet** | Konuşma geçmişi, metin girişi |
| **Telemetri** | 8 aşama (AJAN, MİKROFON, VAD, STT, LLM, TTS, OYNATMA, MCP), canlı log |
| **Onay diyaloğu** | MCP `write`/`delete` için sesli onayla eşzamanlı görsel onay |

---

## Ayarlar — model seçimi

Üç açılır liste: **SES TANIMA (STT)**, **DİL MODELİ (LLM)**, **SESLENDİRME
(TTS)**. Listeler tamamen **makinede ne varsa** ondan üretilir; sabit bir
"desteklenen modeller" tablosu yoktur.

| Tür | Kaynak | Geçiş maliyeti |
|---|---|---|
| STT | `~/.diji/models/sherpa-onnx-whisper-*` | ~2–6 sn (motor yeniden başlar) |
| TTS | `~/.diji/models/vits-*` | ~1–3 sn (drifting: ~60–70 sn) |
| LLM | Yerel sunucunun `/v1/models` yanıtı | Anında |

Seçim **kalıcıdır**: `~/.config/diji/env` dosyasına yazılır ve ajan yeniden
başladığında da geçerli olur. Bildirim bunu açıkça söyler:

```
Değişti: Small — dengeli · kalıcı kaydedildi
```

Kalıcılık başarısız olursa (izin hatası vb.) bildirim `· yalnızca bu oturum`
der ve nedeni ekler. **Geçersiz** seçim (`409`) dosyaya **yazılmaz**.

Ayrıntılar: [`../docs/MODELS.tr.md`](../docs/MODELS.tr.md) ·
[English](../docs/MODELS.md), [`../docs/API.tr.md`](../docs/API.tr.md#post-modelsselect).

---

## Derleme ve paketleme

| Komut | Ne yapar |
|---|---|
| `npm run dev` | Vite dev sunucusu (tarayıcı) |
| `npm run build` | Üretim derlemesi → `dist/` |
| `npm run preview` | Derlenmiş çıktıyı önizle |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

Paketleme kök depodaki `scripts/` içinden yürütülür:

```bash
# 1. Ajanı derle
cd .. && npx tsc -b && cd ui-app

# 2. Arayüzü derle
npm run build

# 3. _shell.html → index.html + varlık yolu düzeltmesi
node ../scripts/prepare-electron.cjs

# 4. Electron'u çalıştır
env -u ELECTRON_RUN_AS_NODE npx electron .
```

> [!NOTE]
> `dist/` ve `release/` **gitignore** edilmiştir. Paketlenmiş Electron
> çıktısı (~865 MB) depoya girmez.

---

## Sorun giderme

| Belirti | Neden | Çözüm |
|---|---|---|
| Beyaz/boş pencere | Varlık yolları çözülmedi | `node ../scripts/prepare-electron.cjs` çalıştır; `dist/index.html` var mı kontrol et |
| Pencere hiç açılmıyor | `ELECTRON_RUN_AS_NODE=1` ortamda | `env -u ELECTRON_RUN_AS_NODE npx electron .` |
| Sandbox hatası / renderer çöküyor | Kullanıcı ad alanı kısıtı | `DIJI_ELECTRON_SANDBOX=0`. `--disable-gpu` **eklemeyin** — renderer'ı `exitCode 133` ile öldürür |
| "Bağlantı yok" ama ajan ayakta | Ajan geç başladı | Köprü 30 sn boyunca yoklar; `/tmp/diji-agent.log`'a bakın |
| Arayüz `KONUŞUYOR`'da asılı | Barge-in yalnızca oynatmayı kesti | `POST /bargein` üçünü birlikte kapatmalı (ajan tarafı) |
| Ayarlar listesi boş | Ajan kataloğu okuyamadı | `curl -s 127.0.0.1:8899/models \| jq` |
| Model seçimi kayboldu | Env yazılamadı | Bildirimdeki `persistError`'a bakın; `stat -c '%a' ~/.config/diji/env` → `600` |

Ajan tarafı sorunlar: [`../docs/MODELS.tr.md`](../docs/MODELS.tr.md),
[`../docs/CONFIGURATION.tr.md`](../docs/CONFIGURATION.tr.md),
[`../SECURITY.tr.md`](../SECURITY.tr.md) — İngilizce:
[`../docs/MODELS.md`](../docs/MODELS.md),
[`../docs/CONFIGURATION.md`](../docs/CONFIGURATION.md),
[`../SECURITY.md`](../SECURITY.md).

---

## Lisans

[MIT](../LICENSE) — © 2026 Tekin Altun
