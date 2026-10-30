# Mimari

**Türkçe** · [🇬🇧 English](en/ARCHITECTURE.md)

Bu doküman Diji Voice Assistant'ın iç yapısını, veri akışını ve tasarım
kararlarının gerekçelerini açıklar.

- [1. Genel bakış](#1-genel-bakış)
- [2. Katmanlar](#2-katmanlar)
- [3. Ses boru hattı](#3-ses-boru-haddi)
- [4. Tur yaşam döngüsü](#4-tur-yaşam-döngüsü)
- [5. MCP entegrasyonu](#5-mcp-entegrasyonu)
- [6. Kontrol sunucusu ve telemetri](#6-kontrol-sunucusu-ve-telemetri)
- [7. Arayüz katmanı](#7-arayüz-katmanı)
- [8. Model yönetimi](#8-model-yönetimi)
- [9. Tasarım kararları](#9-tasarım-kararları)
- [10. Bilinen sınırlar](#10-bilinen-sınırlar)

---

## 1. Genel bakış

Diji üç bağımsız süreç grubundan oluşur:

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron (ui-app/)                                             │
│  ├── main.cjs          pencere + app:// protokolü + IPC         │
│  ├── preload.cjs       dar window.diji köprüsü                  │
│  └── agent-bridge.cjs  HTTP/SSE istemcisi                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP + SSE (127.0.0.1:8899)
┌───────────────────────────▼─────────────────────────────────────┐
│  Agent (agent/)                                                 │
│  ├── pipeline.ts       tur orkestrasyonu                        │
│  ├── control-server.ts HTTP/SSE uç noktaları                    │
│  ├── telemetry.ts      aşama ölçümü + olay akışı                │
│  └── motorlar          stt · tts · vad · llm · mcp              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ stdio JSON-RPC (her biri ayrı süreç)
┌───────────────────────────▼─────────────────────────────────────┐
│  6 MCP sunucusu (mcp_servers/)                                  │
│  gmail · calendar · drive · notion · slack · chrome             │
└─────────────────────────────────────────────────────────────────┘
```

Ek olarak agent, **yerel LLM sunucusuna** HTTP ile bağlanır
(`127.0.0.1:8000/v1`) ve **ALSA araçlarını** (`arecord` / `aplay`) alt süreç
olarak çalıştırır.

---

## 2. Katmanlar

### `shared/`

Tek doğruluk kaynağı: yapılandırma şeması, tipler, günlükleyici, izin kapısı.

| Dosya | Görev |
|---|---|
| `config/schema.ts` | Zod şeması — çalışma zamanı doğrulaması |
| `config/default.ts` | Ortam değişkenlerinden varsayılanlar |
| `config/loader.ts` | `config.json` + varsayılanları derin birleştirir |
| `permission-gate.ts` | 🟢 / 🟡 / 🔴 kural motoru |
| `utils/logger.ts` | **stderr**'e yapılandırılmış günlük |
| `types/*` | Ortak arayüzler |

**Kritik kural:** `shared/utils/logger.ts` dışında hiçbir yerde `console.log`
kullanılmaz. MCP sunucularında `stdout` yalnızca JSON-RPC protokolüne aittir;
tek bir `console.log` protokolü bozar.

### `agent/`

| Bileşen | Görev |
|---|---|
| `pipeline.ts` | Tur orkestrasyonu, motor yaşam döngüsü, barge-in, onay akışı |
| `control-server.ts` | HTTP + SSE uç noktaları (`:8899`) |
| `telemetry.ts` | Aşama durumları, tur gecikmesi, olay akışı, sohbet geçmişi |
| `stt.ts` | sherpa-onnx Whisper + ön/son işleme |
| `tts.ts` | Drifting TTS köprüsü + sherpa-onnx VITS yedeği |
| `vad.ts` | sherpa-onnx Silero |
| `llm.ts` | OpenAI uyumlu istemci, reasoning bütçesi, akış |
| `mcp-client.ts` | JSON-RPC 2.0 over stdio, izin kapısı entegrasyonu |
| `model-catalog.ts` | Diskteki/sunucudaki modelleri tarar (Ayarlar listeleri) |
| `env-prefs.ts` | Kalıcı tercih yazımı (`~/.config/diji/env`) |
| `turn-detector.ts` | Türkçe tur sonu sezgisi |
| `audio-io.ts` | ALSA süreç yönetimi |
| `audio-preprocess.ts` | DC/high-pass/kırpma/AGC |
| `stt-postprocess.ts` | Halüsinasyon eleme, sözlük, aralık düzeltme |
| `research/` | Ağır sorgular için arka plan işçisi |

### `mcp_servers/`

Her sunucu bağımsız bir paket ve bağımsız bir alt süreçtir
(`dist/index.js`). Ajan onları başlatır, `tools/list` ile araçları toplar,
`tools/call` ile çağırır.

### `ui-app/`

TanStack Start (React 19) + Electron. Renderer saf web teknolojisiyle çalışır;
Node yeteneği yoktur (`contextIsolation: true`, `nodeIntegration: false`).
Erişim yalnızca `window.diji` üzerinden, dar bir yüzeyle sağlanır.

---

## 3. Ses boru hattı

```
arecord (16 kHz mono PCM, ~100 ms'lik parçalar)
   │
   ▼
audio-preprocess   DC engeli · high-pass (80 Hz) · sessizlik kırpma · AGC
   │
   ▼
VAD (Silero)       konuşma var mı? → yoksa CPU harcamadan at
   │  konuşma varsa parçalar speechBuffer'da BİRİKTİRİLİR
   ▼
sessizlik ≥ 600 ms → segment kapanır
   │
   ▼
STT (Whisper)      TEK tampon üzerinde tanıma (100 ms'lik parçalar anlamsız)
   │
   ▼
stt-postprocess    halüsinasyon eleme · sözlük · aralık düzeltme
   │
   ▼
turn-detector      cümle bitti mi? (dolgu kelimeleri, bağlaçlar, noktalama)
   │  bitmediyse bir sonraki segmenti bekle
   ▼
handleTurnEnd()
```

**Neden biriktirme?** Whisper cümle bağlamına ihtiyaç duyar. 100 ms'lik bir
parça üzerinde anlamlı transkripsiyon üretilemez.

**Neden sessizlik eşiği 600 ms?** Daha uzun eşik yanıtı geciktirir; daha kısa
eşik Türkçe cümle içi duraklamalarda cümleyi ortasından keser. 600 ms,
`VADConfig.minSilenceDuration` ile aynı seviyeye getirilmiştir (tutarlılık).

### Sessizlik ön filtresi

RMS `0.004` altındaki parçalar VAD'a **hiç gönderilmez**. Bu, boş kayıt
cihazlarında CPU yakmayı ve hayalet transkripsiyonları önler.

---

## 4. Tur yaşam döngüsü

```
[1] turnStartedAt = now          ← tur başlangıcı (STT fiilen başlarken)
[2] STT                          telemetry.addStageTime('stt', …)
[3] LLM çağrısı                  telemetry.addStageTime('llm', …)
[4] tool_calls varsa MCP         telemetry.addStageTime('mcp', …)
[5] onay gerekiyorsa → bekle
[6] TTS akışı, ilk PCM yazımı    ← BURADA totalMs kesilir (ilk ses)
[7] kuyruk boşalana kadar bekle  playbackMs (totalMs'e DAHİL DEĞİL)
[8] finishTurn() → turn-latency olayı
```

### `totalMs` tanımı

**Tur başlangıcı → hoparlörden ilk ses çıktığı an.** Sentezin tamamı değil.
Kullanıcının beklediği süre bu tanıma karşılık gelir; TTS'in 6–7 saniyelik
tamamı eklenirse ölçüm anlamsızlaşır.

### Neden `turnToken` var?

`speakResponse()` çalma bitene kadar bekler. Bu sırada yeni bir tur
başlayabilir. Önceki turun `finally` bloğu yeni turun sayaçlarını sıfırlayarak
`totalMs = 0` üretebiliyordu (canlı ölçümde yakalandı). Her tur kendi kimliğini
taşır; kapanış yalnızca kimlik hâlâ geçerliyse ölçüm yayınlar.

### Barge-in (sesi kesme)

Kullanıcı konuşurken asistanın sesini keser:

1. `ttsEngine.stop()` + `abortController.abort()`
2. `telemetry.abortTurn()` — yarım kalan ölçüm **yayınlanmaz**
3. `llm` / `tts` / `playback` aşamaları **birlikte** `ready`/`idle`'a alınır
4. 500 ms sonra dinleme durumuna dönülür

> Adım 3 kritiktir: yalnızca `playback` kapatılırsa arayüz `KONUŞUYOR` durumunda
> takılı kalır ve "Sesi kes" düğmesi görünür kalır (canlı doğrulamada yakalandı).

---

## 5. MCP entegrasyonu

### Süreç modeli

Her sunucu `node mcp_servers/<ad>/dist/index.js` olarak başlatılır.
`stdout` → JSON-RPC çerçeveleri, `stderr` → günlükler.

Bir sunucu çökerse yalnızca o sunucunun araçları kaybolur; boru hattı ayakta
kalır ve `getMcpServerStatuses()` başarısız sunucuyu `connected: false` bildirir.

### Araç adlandırma

LLM'e araçlar **`sunucu.arac`** biçiminde sunulur (ör. `gmail.send_email`).

Neden: ön ek olmadan model `list_channels` döndürüyor, ajan bunu sunucu adı
sanıp "MCP sunucusu bulunamadı" hatası veriyordu. Ön ek ayrıca iki sunucudaki
aynı araç adını çakışmaktan korur.

Model öneki atlarsa `resolveMcpTool()` aracı tüm sunucularda arar. Tam olarak
tek sunucuda bulunursa o kullanılır; birden çok sunucuda varsa **belirsizlik
nedeniyle çağrı atlanır** (yanlış sunucuda yan etki üretmektense).

### İzin akışı

```
tool_calls
   │
   ▼
inferPermission(toolName) ──▶ read    → hemen çalışır
                          ├─▶ write   → requestVoiceConfirmation() → 15 sn bekle
                          └─▶ delete  → DIJI_ALLOW_DELETE değilse RED
```

Onay isteği **hem** SSE olayı (`mcp-confirmation-required`) **hem** telemetri
kaydı (`telemetry.setPendingConfirmation`) üretir; arayüz diyaloğu bu kayıtla
açar ve geri sayımı gösterir.

**Yarış durumu (düzeltildi):** onay kaydı `expiresAt: null` ile TTS'ten **önce**
yayınlanır, ama promise seslendirme **bittikten sonra** kurulurdu. Kullanıcı
"Onayla"ya hemen basarsa istek `applied: false` ile sessizce kayboluyordu.
Çözüm: `POST /confirm`, bekleyen kayıt duruyorsa en fazla 5 sn bekleyip yeniden
dener.

---

## 6. Kontrol sunucusu ve telemetri

### Uç noktalar

Tam sözleşme: [`API.md`](API.md)

### Telemetri modeli

`telemetry.ts` iki şeyi tutar:

1. **Anlık aşama durumu** — 8 aşama (`agent`, `mic`, `vad`, `stt`, `llm`,
   `mcp`, `tts`, `playback`), her biri `{status, detail, metrics}`
2. **Tur ölçümü** — `turnStart()` ile başlar, `finishTurn()` ile `TurnLatency`
   üretir

`TurnLatency` alanları:

```
totalMs, vadMs, sttMs, llmMs, llmFirstTokenMs, mcpMs,
ttsFirstChunkMs, ttsMs, playbackMs, firstAudioMs,
ttsEnabled, mcpToolCount, mcpServers, sttChars, replyChars,
llmModel, measuredAt
```

**Toplam ≠ aşama toplamı.** `vadMs` ve `playbackMs` diğer aşamalarla örtüşür.

### SSE akışı

```
snapshot            → bağlantı anında tam durum
stage               → tek aşamanın değişimi
log                 → zaman damgalı olay kaydı
turn-latency        → tur bittiğinde tam nesne
conversation-update → sohbet listesinin tamamı (son 50)
confirmation        → onay diyaloğu aç/kapat
barge-in / tts-toggle / model-change
```

Arayüz bağlantı koptuğunda üstel geri çekilmeyle yeniden bağlanır; `snapshot`
sayesinde durum asla bayat kalmaz.

---

## 7. Arayüz katmanı

### Süreç izolasyonu

`main.cjs` → `preload.cjs` → renderer. Renderer'ın Node yeteneği yoktur.
`window.diji` yalnızca şu yüzeyi açar:

```ts
window.diji = {
  getState, getModels, selectModel,
  ask, listen, tts, confirm, bargeIn,
  onTelemetry, onConnection,
}
```

Her çağrı `ipcRenderer.invoke` ile main'e, oradan `agent-bridge.cjs` ile HTTP'ye
gider. Zaman aşımları işleme göre ayarlıdır (model seçimi 120 sn — drifting TTS
Python köprüsü uzun sürebilir).

### Varlık yükleme

SPA derlemesi `dist/client/_shell.html` üretir ve varlık yolları **mutlak**
(`/assets/...`) olur. `file://` ile yüklenirse JS/CSS hiç gelmez ve arayüz
görünür ama **tüm düğmeler ölü** kalır.

Çözüm: `scripts/prepare-electron.cjs` yolları `./` yapar ve `index.html` yazar;
`main.cjs` sayfayı `app://jarvis/` özel protokolü üzerinden sunar.
`resolveRootDocument()` hem `index.html` hem `_shell.html` arar (ileri/geri
uyumluluk).

### `isSpeaking` neden türetiliyor?

`state.pipeline.state.isSpeaking` yalnızca `snapshot`/`getState` ile gelir;
`stage` olayları onu güncellemez → bayatlar (TTS bitse bile `true` kalabilir).
Canlı sinyal `tts` ve `playback` aşamalarıdır (saniyede birkaç kez SSE ile
tazelenir). `use-agent.ts` bunu `useMemo` ile türetir; bayat bayrak yalnızca
aşama bilgisi hiç yoksa yedek olur.

---

## 8. Model yönetimi

### Katalog (`model-catalog.ts`)

Tek doğruluk kaynağı. Sabit "desteklenen modeller" tablosu **yoktur**.

| Tür | Kaynak | Kural |
|---|---|---|
| STT | `~/.diji/models/sherpa-onnx-whisper-<önek>/` | `encoder*` + `decoder*` + `tokens` **üçü** |
| TTS | `~/.diji/models/vits-*` | `.onnx` + `tokens.txt` |
| LLM | `http://127.0.0.1:8000/v1/models` | 2,5 sn abort |

Eksik dosyalı model listede **kalır** ama `available: false` → arayüzde
`disabled`. Neden: yarım indirilmiş model seçilirse ajan açılışta ölür.

`current` alanı **çalışan motordan** okunur, yapılandırmadan değil. Neden:
`config.tts.provider = drifting-tts` derken Python köprüsü ölüp sherpa-vits
çalışabiliyor; panelde çalışmayan bir sağlayıcıyı "seçili" göstermek yanıltıcı
olurdu.

### Geçiş

| Tür | Yöntem | Süre |
|---|---|---|
| llm | ad her istek gövdesinde — motor yeniden başlatılmaz | anında |
| stt | `STTEngine` dispose + yeniden kur (`modelPriority: [önek]`) | ~2–6 sn |
| tts | `TTSEngine` dispose + yeniden kur | sherpa ~1–3 sn · drifting ~60–70 sn |

Aynı model yeniden seçilirse **no-op** — motor durdurulmaz. (Canlı ölçümde aynı
seçim 8 sn boşa bekleme ve gereksiz mikrofon kesintisi üretiyordu.)

### Kalıcılık (`env-prefs.ts`)

Seçim `~/.config/diji/env` dosyasına yazılır.

**Neden `config.json` değil:** yapılandırma `env-bootstrap.ts` ile en erken
aşamada bu dosyadan okunur ve `@diji/shared` yüklenirken `DEFAULT_AGENT_CONFIG`
bu değerlerle üretilir. Yazılan anahtar bir sonraki açılışta hiçbir ek kod
çalışmadan etkili olur. `config.json` yolu `process.cwd()`'ye bağlıdır.

| Özellik | Davranış |
|---|---|
| Yorumlar | Korunur — satır satır işlenir |
| Atomiklik | Geçici dosya → `rename` |
| İzin | `0600` (API anahtarı olabilir) |
| Hata | Fırlatmaz → `{ ok, path, error, changed }` |

Yazma başarısız olursa **model değişikliği geri alınmaz** (bu süreçte
geçerlidir) ama yanıt `persisted: false` + `persistError` döner; arayüz
"· yalnızca bu oturum" diye uyarır.

---

## 9. Tasarım kararları

| Karar | Gerekçe |
|---|---|
| **stdio JSON-RPC** (HTTP değil) | Süreç izolasyonu; sunucu çökse bile asistan ayakta. Kimlik doğrulama/port yönetimi gerekmez |
| **Mock yok** | Ses bileşeninde sahte yanıt "asistan konuşuyor ama ses yok" arızasını gizler |
| **`stdout` = protokol** | Tek bir `console.log` MCP çerçevesini bozar |
| **Aşama başına telemetri** | Hangi adımın yavaş olduğu görünmeli; tek toplam sayı teşhis ettirmez |
| **`current` = çalışan motor** | Yapılandırma niyettir, gerçek değildir |
| **`totalMs` = ilk ses** | Kullanıcının beklediği süre budur |
| **`turnToken`** | Eşzamanlı turlarda ölçüm sıfırlanmasını önler |
| **Onay 15 sn + zaman aşımında RED** | Güvenli taraf; sessizce izin vermek yerine reddet |
| **Araç adı `sunucu.arac`** | Çakışma ve yanlış çözümleme riskini kaldırır |
| **`app://` protokolü** | `file://` mutlak varlık yollarını kırar → ölü düğmeler |

---

## 10. Bilinen sınırlar

| Sınır | Açıklama |
|---|---|
| Tek oturum | Eşzamanlı sesli tur kilidi (`isProcessing`) vardır; ikinci tur atlanır |
| Linux + ALSA | `arecord`/`aplay` alt süreçleri Linux'a özgüdür |
| Yerel LLM zorunlu | Diji LLM sunucusunu **başlatmaz**; yalnızca bağlanır |
| Drifting TTS platformu | Python + torch gerekir; başlatılamazsa sherpa-vits'e düşer |
| Whisper sabit model | Tanıyıcı modeli yükleme anında sabitler → geçiş motoru yeniden kurar |
| Reasoning bütçesi | `agent` modeli düşünür; toplam bütçe 2048 token ile sınırlıdır |
| Uzun konuşma sınırı | Segment ~30 sn'de zorla kapatılır (`MAX_SPEECH_BYTES`) |
| Arayüz `ui/` | Önceki Next.js arayüzü arşiv durumunda; üretim arayüzü `ui-app/` |
