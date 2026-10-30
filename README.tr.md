# Diji Voice Assistant

**Türkçe** · [English](README.md)

**Tamamen yerel çalışan Türkçe sesli asistan.** Bulut yok, telemetri yok, ses
cihazdan çıkmıyor. Konuşma tanıma, seslendirme, ses etkinliği algılama ve dil
modeli çağrılarının tamamı kendi makinenizde çalışır.

```
Mikrofon → VAD → Whisper (STT) → Tur dedektörü → LLM → MCP araçları → TTS → Hoparlör
```

![Diji ana ekranı](docs/screenshots/ui-main.png)

<details>
<summary><b>Ayarlar — model seçimi</b> (görseli aç)</summary>

![Ayarlar panelinde STT / LLM / TTS seçimi](docs/screenshots/ui-settings-models.png)

Listeler **tamamen makinede ne varsa** ondan üretilir. Seçim
`~/.config/diji/env` dosyasına kalıcı yazılır.

</details>

---

## İçindekiler

- [Ne yapar](#ne-yapar)
- [Mimari](#mimari)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Çalıştırma modları](#çalıştırma-modları)
- [Masaüstü arayüzü](#masaüstü-arayüzü)
- [Ajan kontrol API'si](#ajan-kontrol-apisi)
- [Model yönetimi](#model-yönetimi)
- [Yapılandırma](#yapılandırma)
- [İzin kapısı](#i-zin-kapısı)
- [Gizlilik ve güvenlik](#gizlilik-ve-güvenlik)
- [Proje yapısı](#proje-yapısı)
- [Sorun giderme](#sorun-giderme)
- [Katkı](#katkı)
- [Lisans](#lisans)

---

## Ne yapar

| Yetenek | Teknoloji | Durum |
|---|---|---|
| Konuşma tanıma (STT) | sherpa-onnx + Whisper | ✅ Gerçek, doğrulandı |
| Ses etkinliği (VAD) | sherpa-onnx + Silero | ✅ Gerçek, doğrulandı |
| Seslendirme (TTS) | Drifting TTS (Python) + sherpa-onnx VITS/Piper yedek | ✅ Gerçek, doğrulandı |
| Dil modeli (LLM) | OpenAI uyumlu yerel uç nokta (`127.0.0.1:8000`) | ✅ Gerçek, doğrulandı |
| Araç kullanımı (MCP) | JSON-RPC 2.0 over stdio, 6 sunucu | ✅ Gerçek, 24 araç |
| İzin kapısı | 🟢 oku / 🟡 yaz (onay) / 🔴 sil | ✅ Doğrulandı |
| Masaüstü arayüzü | Electron + TanStack Start (React) | ✅ Derleniyor |
| Model seçimi | Ayarlar panelinden STT/LLM/TTS, **kalıcı** | ✅ Doğrulandı |

**Ses bileşenlerinde hiçbir sahte (mock) yanıt yoktur.** Model dosyaları
eksikse motor **açık hata** verir — "asistan konuşuyor ama ses yok" gibi sessiz
arızalara izin verilmez.

---

## Mimari

```
┌──────────────┐   PCM 16 kHz   ┌──────────────────┐
│  Mikrofon    │───────────────▶│ VAD (Silero)     │──▶ konuşma var mı?
│  (arecord)   │                └────────┬─────────┘
└──────────────┘                         ▼
                              ┌──────────────────────┐
                              │ STT (Whisper ONNX)   │──▶ "yarın toplantım var mı?"
                              └──────────┬───────────┘
                                         ▼
                              ┌──────────────────────┐
                              │ Tur dedektörü (TR)   │──▶ cümle bitti mi?
                              └──────────┬───────────┘
                                         ▼
                  ┌──────────────────────────────────────┐
                  │ LLM  (127.0.0.1:8000, OpenAI uyumlu) │
                  └──────────┬───────────────────────────┘
                             │ tool_calls
                             ▼
                  ┌──────────────────────┐        ┌─────────────────────┐
                  │ MCP Client           │◀──────▶│ 6 yerel MCP sunucusu│
                  │ (JSON-RPC over stdio)│        │ gmail, calendar,    │
                  └──────────┬───────────┘        │ drive, notion,      │
                             ▼                    │ slack, chrome       │
                  ┌──────────────────────┐        └─────────────────────┘
                  │ TTS (Drifting/VITS)  │
                  └──────────┬───────────┘
                             ▼
                         Hoparlör (aplay)
```

### Bileşenler

| Paket | Görev |
|---|---|
| `agent/` | Ses boru hattı, LLM/MCP/TTS orkestrasyonu, kontrol sunucusu (`:8899`) |
| `shared/` | Yapılandırma şeması, tipler, günlükleyici, izin kapısı |
| `mcp_servers/` | 6 bağımsız MCP sunucusu (her biri ayrı alt süreç) |
| `ui-app/` | Electron + TanStack Start masaüstü arayüzü ("Kuantum Cam") |
| `ui/` | Önceki Next.js arayüzü (arşiv) |
| `scripts/` | Model indirme, kurulum, uçtan uca test, CDP doğrulama |

Ayrıntılı mimari: [`docs/ARCHITECTURE.tr.md`](docs/ARCHITECTURE.tr.md) · [English](docs/ARCHITECTURE.md)

### Tasarım kararları

- **stdio JSON-RPC.** Her MCP sunucusu ayrı alt süreçtir; biri çökse bile asistan ayakta kalır. **stdout yalnızca protokole aittir** — tüm günlükler `stderr`'e yazılır ([`shared/src/utils/logger.ts`](shared/src/utils/logger.ts)).
- **Sessiz arıza yok.** Eksik model, erişilemeyen LLM, ölü alt süreç → açık hata veya panelde dürüst durum.
- **Tek doğruluk kaynağı.** Arayüzdeki "seçili model" her zaman **çalışan motordan** okunur, yapılandırmadan değil.
- **Ölçülen değer uydurulmaz.** Telemetrideki süreler gerçek zaman damgalarından gelir; ölçülmeyen alan `—` kalır.

---

## Hızlı başlangıç

### Ön koşullar

| Gereksinim | Neden |
|---|---|
| Node.js ≥ 20, npm 10 | Ajan ve arayüz |
| `alsa-utils` (`arecord`, `aplay`) | Ses giriş/çıkışı |
| Python 3 + `drifting-tts` | Birincil TTS (isteğe bağlı — yedek VITS var) |
| Yerel LLM sunucusu | `http://127.0.0.1:8000/v1` (OpenAI uyumlu) |

```bash
sudo apt install alsa-utils
```

### Kurulum

```bash
git clone https://github.com/tekinaltun2025/Diji_Voice_Assistant.git
cd Diji_Voice_Assistant

npm install                        # bağımlılıklar
./scripts/download-models.sh all   # STT + VAD + TTS (~2 GB)
npm run build                      # shared + agent + ui + mcp
```

Modeller `~/.diji/models` altına kurulur.

### LLM sunucusunu doğrula

```bash
curl -s -H "Authorization: Bearer sk-local" http://127.0.0.1:8000/v1/models
```

Çıktıda `"id":"agent"` görünmelidir. Diji bu sunucuyu **kendisi başlatmaz**.
Görünmüyorsa asistan çökmez; yalnızca dil modeli yanıtları devre dışı kalır
(STT/VAD/TTS çalışmaya devam eder).

### Tek komutla masaüstü uygulaması

```bash
cd ui-app && ./jarvis-baslat.sh
```

Betik sırayla: (1) ajanı `127.0.0.1:8899`'da başlatır ve hazır olmasını bekler —
**zaten çalışıyorsa dokunmaz** (ikinci süreç mikrofon için yarışır); (2) SPA
derlemesi yoksa üretir; (3) Electron penceresini açar.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_HOME` | depo kökü | Ajan projesinin yolu |
| `DIJI_CONTROL_PORT` | `8899` | Kontrol sunucusu portu |
| `DIJI_TTS_ENABLED` | ajan varsayılanı | `0` = sessiz mod |
| `DIJI_CDP_PORT` | kapalı | Verilirse DevTools uzaktan hata ayıklama |

---

## Çalıştırma modları

### 1. Sesli mod (asıl kullanım)

```bash
npm start
# eşdeğeri: node agent/dist/index.js
```

Beklenen çıktı:

```
Mikrofon hazir {"device":"default"}
Sesli mod hazir — konusabilirsiniz (cikmak icin Ctrl+C)
```

Konuşun; sessizlik 600 ms'yi geçince segment Whisper'a gönderilir, yanıt TTS ile
hoparlörden okunur. Çıkış: `Ctrl+C`.

Cihaz seçimi (`arecord -l` / `aplay -l` ile listelenir):

```bash
DIJI_AUDIO_INPUT_DEVICE=plughw:2,1 \
DIJI_AUDIO_OUTPUT_DEVICE=plughw:0,0 \
npm start
```

### 2. Metin modu (mikrofonsuz)

```bash
npm run start:text
```

STT ve TTS atlanır; LLM + MCP + tur dedektörü zinciri çalışır. Komutlar:
`/help`, `/stats`, `/quit`.

### 3. Masaüstü arayüzü

```bash
npm run dev:ui          # geliştirme (Vite dev sunucusu + Electron)
cd ui-app && ./jarvis-baslat.sh   # tek komut, üretim derlemesiyle
```

### 4. Hepsi birlikte

```bash
npm run dev    # agent + ui, tek terminalde
```

MCP sunucularını ayrıca başlatmanız gerekmez — ajan onları kendi alt süreçleri
olarak doğurur.

---

## Masaüstü arayüzü

Arayüz **"Kuantum Cam"** tasarımını kullanır: mikrofon sesine tepki veren
akışkan dalga, servis kartları, hat telemetrisi ve sohbet paneli.

### Ekran bölümleri

| Bölüm | İçerik |
|---|---|
| Sol kenar | Güç · Geçmiş · Yeni sohbet · **Ayarlar**; altında 7 servis kartı (gerçek MCP durumu) |
| Orta üst | Durum göstergesi (`HAZIR` / `DİNLİYOR` / `KONUŞUYOR`) + dalga görselleştirmesi |
| Orta alt | Sohbet paneli + metin girişi |
| Sağ kenar | Hat telemetrisi: toplam cevap süresi, 8 aşama kutusu, olay akışı, onay diyaloğu |

### Ayarlar → model seçimi

Ayarlar panelinde üç açılır liste vardır: **SES TANIMA (STT)**, **DİL MODELİ
(LLM)**, **SESLENDİRME (TTS)**.

- Listeler **tamamen makinede ne varsa** ondan üretilir — sabit bir "desteklenen
  modeller" tablosu yoktur. `~/.diji/models` altına yeni bir Whisper/VITS dizini
  atmak yeterlidir.
- Eksik dosyalı modeller listede kalır ama `disabled` olur (seçilirse ajan
  açılışta ölürdü).
- Seçim **`~/.config/diji/env`** dosyasına yazılır → uygulama yeniden başlasa da
  geçerlidir. Yazma başarısız olursa model yine değişir ama arayüz
  "· yalnızca bu oturum" diye uyarır.

| Tür | Geçiş maliyeti |
|---|---|
| **LLM** | Anında — model adı her istek gövdesinde gider, motor yeniden başlatılmaz |
| **STT** | ~2–6 sn — Whisper modeli yükleme anında sabitlenir, motor yeniden kurulur |
| **TTS** | sherpa ~1–3 sn · drifting ~60–70 sn (Python köprüsü yeniden kurulur) |

Aynı modeli yeniden seçmek motoru **durdurmaz** (no-op).

### Teşhis paneli

Her aşama kendi kutusunda hem durumu hem **yalnızca o aşamaya ait** süreyi
gösterir:

| Kutu | Süre kaynağı |
|---|---|
| AJAN | tur bazlı değil — toplam süre, sesli mod durumu |
| MİKROFON | cihaz adı, giriş seviyesi |
| VAD | `vadMs` |
| STT | `sttMs` + karakter sayısı |
| LLM | `llmMs` + ilk token |
| MCP | `mcpMs` + çağrılan araçlar |
| TTS | `ttsMs` + ilk parça gecikmesi |
| OYNATMA | `playbackMs` |

> **Toplam ≠ aşama toplamı.** `vadMs` ve `playbackMs` diğer aşamalarla örtüşür;
> `totalMs` yalnızca **ilk sese** kadardır.

---

## Ajan kontrol API'si

Arayüz ajanı `127.0.0.1:8899` üzerinden yönetir (**yalnızca yerel**).

| Uç nokta | Açıklama |
|---|---|
| `GET /health` | `{ok, pid, uptime}` |
| `GET /state` | Boru hattı durumu + tüm aşamalar + olay geçmişi + `lastTurnLatency` + `conversation` |
| `GET /events` | SSE: `snapshot`, sonra `stage` / `log` / `turn-latency` / `conversation-update` |
| `POST /listen {enabled}` | Mikrofonu aç/kapat |
| `POST /ask {text}` | Metin turu (STT atlanır; `202` döner, yanıt SSE'den gelir) |
| `POST /inject` | 16 kHz mono PCM'i mikrofon gibi besle (hat testi) |
| `POST /confirm {confirmed}` | Bekleyen MCP işlemini onayla/reddet |
| `POST /bargein` | Çalan sesi kes |
| `GET /models` | Model kataloğu (Ayarlar listeleri) |
| `POST /models/select {kind,id}` | Model değiştir + kalıcı kaydet |

Tam sözleşme: [`docs/API.tr.md`](docs/API.tr.md) · [English](docs/API.md)

### Hat testleri

```bash
node scripts/control-e2e.js "Merhaba, kendini kisaca tanit"   # metin turu
node scripts/inject-e2e.js /tmp/konusma.pcm                    # VAD+STT+LLM+TTS
node scripts/cdp-eval.js "document.title"                      # arayüzü CDP ile oku
```

---

## Model yönetimi

```bash
./scripts/download-models.sh all       # hepsi
./scripts/download-models.sh vad       # Silero VAD       (~600 KB)
./scripts/download-models.sh tts       # Türkçe VITS       (~60 MB)
./scripts/download-models.sh whisper   # Whisper small     (~500 MB)
```

Farklı konum: `export DIJI_MODELS_DIR=/yol/modeller`

Ayrıntılar (model boyutları, nicemleme, TTS arka uçları): [`docs/MODELS.tr.md`](docs/MODELS.tr.md) · [English](docs/MODELS.md)

---

## Yapılandırma

Tüm ayarlar ortam değişkenleriyle geçersiz kılınabilir. Kalıcı ayarlar
`~/.config/diji/env` dosyasında tutulur (`ANAHTAR=değer` satırları).

### Sık kullanılanlar

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_LLM_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI uyumlu uç nokta |
| `DIJI_LLM_MODEL` | `agent` | Model adı |
| `DIJI_LLM_API_KEY` | `sk-local` | `Bearer` kimlik doğrulaması |
| `DIJI_LLM_TIMEOUT_MS` | `120000` | İstek zaman aşımı (ms) |
| `DIJI_LLM_REASONING_RESERVE` | `1024` | Reasoning rezervi; düşünmeyen modeller için `0` |
| `DIJI_STT_MODEL` | `whisper-small` | Whisper model boyutu |
| `DIJI_STT_MODEL_PREFIX` | *(yok)* | Tek modeli öne alır (Ayarlar buraya yazar) |
| `DIJI_STT_LANGUAGE` | `tr` | Tanıma dili |
| `DIJI_TTS_PROVIDER` | `drifting-tts` | `drifting-tts` veya `sherpa-vits` |
| `DIJI_TTS_VITS_MODEL` | `vits-piper-tr_TR-fettah-medium` | sherpa-vits model dizini |
| `DIJI_TTS_VOICE` | `studio` | Drifting TTS sesi |
| `DIJI_TTS_SPEED` | `1.0` | Konuşma hızı |
| `DIJI_TTS_ENABLED` | `1` | `0` = sessiz mod (yalnızca metin) |
| `DIJI_VAD_THRESHOLD` | `0.5` | Konuşma eşiği (0–1) |
| `DIJI_VAD_MIN_SILENCE` | `0.6` | Tur sonu sessizliği (**saniye**) |
| `DIJI_MCP_ENABLED` | `true` | Araçları kapat/aç |
| `DIJI_ALLOW_DELETE` | `false` | 🔴 silme iznini aç |
| `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |
| `DIJI_MODE` | `microphone` | `microphone` veya `text` |
| `DIJI_AUDIO_INPUT_DEVICE` | `default` | ALSA kayıt cihazı |
| `DIJI_AUDIO_OUTPUT_DEVICE` | `default` | ALSA çalma cihazı |

> **Süre birimleri saniyedir.** `minSilenceDuration: 0.6` = 600 ms.

Tam liste: [`docs/CONFIGURATION.tr.md`](docs/CONFIGURATION.tr.md) · [English](docs/CONFIGURATION.md)

---

## İzin kapısı

| Seviye | Davranış |
|---|---|
| 🟢 `read` | Hemen çalışır (arama, listeleme, okuma) |
| 🟡 `write` | Kullanıcıya **sesli** sorulur; onay yoksa çalışmaz |
| 🔴 `delete` | Varsayılan olarak **kapalı**. `DIJI_ALLOW_DELETE=true` gerekir |

Sesli onay 15 saniye bekler; zaman aşımında işlem **reddedilir** (güvenli taraf).
Arayüzde diyalog açılır, kalan süre sayılır.

---

## Gizlilik ve güvenlik

- **Ses cihazdan çıkmaz.** STT, TTS ve VAD yerel modellerle çalışır.
- **Kayıt tutulmaz.** Mikrofon akışı yalnızca işlenir; diske yazılmaz.
- **Sırlar depoda değil.** API anahtarları `~/.config/diji/env` (izin `0600`)
  altında tutulur; depoda yalnızca [`.env.example`](.env.example) vardır.
- **Kontrol sunucusu yalnızca yerel arayüze bağlanır** (`127.0.0.1`).
- **Yıkıcı işlemler onay ister** ve varsayılan olarak kapalıdır.

Güvenlik modeli ve tehdit değerlendirmesi: [`SECURITY.tr.md`](SECURITY.tr.md) · [English](SECURITY.md)

---

## Proje yapısı

```
Diji_Voice_Assistant/
├── agent/                 # Ses boru hattı + kontrol sunucusu
│   └── src/
│       ├── pipeline.ts        # Tur orkestrasyonu
│       ├── stt.ts tts.ts vad.ts
│       ├── llm.ts mcp-client.ts
│       ├── control-server.ts  # HTTP + SSE (:8899)
│       ├── model-catalog.ts   # Ayarlar listeleri (diskten okur)
│       ├── env-prefs.ts       # Kalıcı ayar yazımı
│       ├── telemetry.ts       # Aşama ölçümü
│       └── turn-detector.ts   # Türkçe tur sonu
├── shared/                # Tip + şema + günlükleyici + izin kapısı
├── mcp_servers/           # 6 bağımsız MCP sunucusu
├── ui-app/                # Electron + TanStack Start arayüzü
│   ├── electron/              # main / preload / agent-bridge
│   └── src/
│       ├── routes/index.tsx   # Kuantum Cam ekranı
│       ├── hooks/use-agent.ts # window.diji köprüsü
│       └── components/
├── scripts/               # Kurulum, model indirme, E2E, CDP
├── docs/                  # Mimari, kurulum, API, modeller
└── memory-bank/           # Proje bağlamı ve ilerleme kaydı
```

---

## Sorun giderme

**`LLM sunucusuna ulaşılamadı`**
→ `curl -H "Authorization: Bearer sk-local" http://127.0.0.1:8000/v1/models`
çalışıyor mu? `agent` modeli listede mi?

**`LLM sunucusu 401 döndürdü`**
→ `DIJI_LLM_API_KEY` (varsayılan `sk-local`) doğru mu?

> LLM erişilemezse asistan çökmez: STT/VAD/TTS çalışmaya devam eder.

**`Mikrofon baslatilamadi` / `arecord bulunamadi`**
→ `sudo apt install alsa-utils`. Cihazları `arecord -l` ile listeleyin.
Hiç mikrofon yoksa `npm run start:text`.

**Sesli modda transkript boş**
→ Kayıt seviyesini ölçün:
```bash
timeout 5 arecord -q -t raw -f S16_LE -c 1 -r 16000 -D default /tmp/t.raw
python3 -c "import struct,math;d=open('/tmp/t.raw','rb').read();n=len(d)//2;\
s=struct.unpack('<%dh'%n,d[:n*2]);print('rms=',math.sqrt(sum(x*x for x in s)/n))"
```
RMS `~100`'ün altındaysa yanlış cihaz veya mute. Geçici çözüm:
`DIJI_AUDIO_SILENCE_THRESHOLD=0.001`.

**Asistan yanıt veriyor ama ses çıkmıyor**
→ `aplay -l` ile çıkışı doğrulayın, `DIJI_AUDIO_OUTPUT_DEVICE=plughw:0,0` verin.

**`STT baslatilamadi: Whisper model dosyalari bulunamadi`**
→ `./scripts/download-models.sh whisper`

**`TTS baslatilamadi: VITS model dosyalari bulunamadi`**
→ `./scripts/download-models.sh tts`

**`MCP sunucusu atlandi: derlenmis giris noktasi bulunamadi`**
→ `npm run build:mcp`

**TTS segfault / `phoneme_codepoints is empty`**
→ `sherpa-onnx-node` 2.x'te Piper'ın espeak-ng fonemleştirmesi kaldırıldı.
`1.13.8`'e sabitlenmiştir; düşürmeyin.

**Electron `ERR_FILE_NOT_FOUND`**
→ SPA derlemesi `dist/client/_shell.html` üretir. `scripts/prepare-electron.cjs`
çalıştırılmalı (`jarvis-baslat.sh` bunu kendisi yapar).

---

## Komutlar

```bash
npm run build              # her şeyi derle
npm run build:shared       # paylaşılan tipler
npm run build:agent        # ajan
npm run build:ui           # arayüz (Next.js, arşiv)
npm run build:mcp          # 6 MCP sunucusu

npm start                  # ajanı sesli modda çalıştır
npm run start:text         # metin modu
npm run dev                # agent + ui birlikte
npm run lint               # ESLint
npm run typecheck          # tüm paketler

npm run verify:llm         # LLM uç noktasını canlı doğrula
npm run test:agent         # birim testleri
npm run smoke:fast         # duman testi (ses motorlarını atla)
```

---

## Katkı

Katkılar memnuniyetle karşılanır. Başlamadan önce
[`CONTRIBUTING.tr.md`](CONTRIBUTING.tr.md) dosyasını okuyun ([English](CONTRIBUTING.md)).

Kısa özet: TypeScript proje referansları (`tsc -b`) kullanılır, her paket
`composite: true` olmalıdır; `console.log` **kullanılmaz** (stdout MCP
protokolüne aittir, `stderr` günlükleyicisi kullanılır); ses bileşenlerinde mock
kabul edilmez.

---

## Lisans

[MIT](LICENSE) © 2026 Tekin Altun

Üçüncü taraf bileşenler ve model lisansları: [`docs/MODELS.tr.md`](docs/MODELS.tr.md) · [English](docs/MODELS.md#licences)
