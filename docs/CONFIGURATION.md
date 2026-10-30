# Yapılandırma

Diji hiçbir ayar dosyası olmadan da açılır: tüm varsayılanlar
[`shared/src/config/default.ts`](../shared/src/config/default.ts) içinde
tanımlıdır. Ayar değiştirmenin üç yolu vardır ve **öncelik sırası** belirgindir.

---

## İçindekiler

- [Öncelik sırası](#öncelik-sırası)
- [`~/.config/diji/env` — kalıcı ayar dosyası](#configdijienv--kalıcı-ayar-dosyası)
- [Neden `config.json` değil?](#neden-configjson-değil)
- [Ayarlar ekranının yazdığı anahtarlar](#ayarlar-ekranının-yazdığı-anahtarlar)
- [Değişken referansı](#değişken-referansı)
- [Örnek dosyalar](#örnek-dosyalar)
- [Doğrulama](#doğrulama)

---

## Öncelik sırası

Bir değer için çözümleme sırası (yukarıdaki kazanır):

```
1. Süreç ortamı        (terminalde `export`, systemd unit, Electron spawn env)
2. ~/.config/diji/env  (kalıcı kullanıcı ayarı — yalnızca ortamda YOKSA uygulanır)
3. `default.ts` içindeki gömülü varsayılan
```

`loadUserEnv()` bu kuralı açıkça uygular:

```ts
// agent/src/env-bootstrap.ts:38
if (process.env[match[1]] === undefined) {
  process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
```

> [!IMPORTANT]
> Bu, kullanıcının `DIJI_LLM_MODEL=agent node agent/dist/index.js` gibi tek
> seferlik bir geçersiz kılma yapabilmesi için bilinçlidir. Kalıcı dosya
> oturumluk ayarı **ezmez**.

---

## `~/.config/diji/env` — kalıcı ayar dosyası

Biçim: `ANAHTAR=değer` satırları. Kabuk betiği değildir — `export` yazılmaz,
değişken genişletmesi yapılmaz.

```bash
# Diji kalıcı ayarları (Ayarlar ekranından yönetilir)
DIJI_STT_MODEL_PREFIX=small
DIJI_STT_MODEL=whisper-small
DIJI_LLM_MODEL=agent
DIJI_TTS_PROVIDER=sherpa-vits
DIJI_TTS_VITS_MODEL=vits-piper-tr_TR-fettah-medium
```

### Ayrıştırma kuralları

| Kural | Davranış |
|---|---|
| `#` ile başlayan satır | Yorum — yok sayılır |
| Boş satır | Yok sayılır |
| `ANAHTAR=değer` | Eşleşme deseni: `^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$` |
| Değerde tırnak | Tek/çift tırnak kırpılır (`"small"` → `small`) |
| Değerde boşluk | Yalnızca **baştaki/sondaki** boşluk kırpılır; iç boşluk korunur |
| Değişken genişletmesi | **Yok** — `$HOME` düz metin olarak kalır |
| Dosya yok | Sessizce yok sayılır (hata değil) |
| Dosya bozuk | Ayrıştırılamayan satırlar atlanır; ajan açılmaya devam eder |

### Erken yükleme — kritik ayrıntı

`~/.config/diji/env`, **tüm importlardan önce** okunmalıdır. Nedeni:
`@diji/shared` paketi `DEFAULT_AGENT_CONFIG` nesnesini **modül yükleme anında**
oluşturur ve bu sırada `process.env`'i okur. `main()` içinde çağrılsaydı değerler
çoktan donmuş olurdu.

Çözüm [`agent/src/env-bootstrap.ts`](../agent/src/env-bootstrap.ts) dosyasının
`agent/src/index.ts` içinde **ilk import** olmasıdır; modül gövdesindeki
`loadUserEnv()` çağrısı import sırasında çalışır.

Bu yüzden yeni bir `DIJI_*` değişkeni eklerken onu `default.ts` içinde
`process.env` üzerinden okuyun — aksi halde env dosyasından gelen değer
kullanılmaz.

### Yazma garantileri

Ayarlar ekranı bu dosyaya [`agent/src/env-prefs.ts`](../agent/src/env-prefs.ts)
üzerinden yazar:

| Garanti | Uygulama |
|---|---|
| Yorumlar korunur | `^\s*#` satırları olduğu gibi bırakılır |
| Yinelenen anahtarlar | Eşleşen **tüm** satırlar güncellenir (ilk değil) |
| Eksik anahtarlar | Sona eklenir |
| Atomiklik | `temp` dosyaya yazılıp `rename` ile yerine konur |
| Kip | `0600` (yalnızca sahibi okur) |
| Dizin | `~/.config/diji` → `0700`, gerekiyorsa oluşturulur |
| Hata | **Asla throw etmez** — `{ ok:false, error }` döner |
| Değer kaçışı | Boşluk/`#`/tırnak/`$`/`\` içeren değerler çift tırnağa alınır |

```ts
// agent/src/env-prefs.ts
function formatValue(value: string): string {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (clean === '') return '';
  return /[\s#"'`$\\]/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
}
```

---

## Neden `config.json` değil?

[`ConfigLoader`](../shared/src/config/loader.ts) bir `config.json` da
destekler, ama üretimde **kullanılmaz**:

| Sorun | Açıklama |
|---|---|
| Göreli yol | `config.json` `process.cwd()`'ye göre çözülür. Ajan terminalden, Electron'dan veya systemd'den başlatıldığında `cwd` farklıdır → dosya bazen bulunur, bazen bulunmaz. |
| Sessiz kayıp | Dosya bulunamazsa hata verilmez; varsayılanlar kullanılır ve kullanıcı neden ayarının işlemediğini anlamaz. |
| Derin birleştirme | `deepMerge` kısmi ayar yazmayı destekler ama yazma yolu yoktur; dosyayı elle düzenlemek gerekir. |
| Arayüz erişimi | Electron süreci kullanıcının `cwd`'sini bilmez; yazma yeri belirsiz kalırdı. |

`~/.config/diji/env` mutlak yoldur, `cwd`'den bağımsızdır ve zaten en erken
aşamada okunur. Bu yüzden kalıcılık oraya yazılır.

---

## Ayarlar ekranının yazdığı anahtarlar

`POST /models/select` çağrısı türe göre farklı anahtarlar yazar
([`pipeline.ts:1829`](../agent/src/pipeline.ts)):

| `kind` | Yazılan anahtarlar | Neden |
|---|---|---|
| `llm` | `DIJI_LLM_MODEL` | Tek alan yeterli |
| `stt` | `DIJI_STT_MODEL_PREFIX`, `DIJI_STT_MODEL` | Ön ek öncelik listesini belirler; `DIJI_STT_MODEL` teşhis/log içindir |
| `tts` (VITS dizini) | `DIJI_TTS_PROVIDER=sherpa-vits`, `DIJI_TTS_VITS_MODEL` | Sağlayıcı sabitlenir ki drifting model kimliği sızmasın |
| `tts` (sağlayıcı seçimi) | `DIJI_TTS_PROVIDER` | `drifting-tts` veya `sherpa-vits` |

### `DIJI_STT_MODEL_PREFIX` neden listede öne alınıyor?

[`stt.ts`](../agent/src/stt.ts) önceliği şu sırayla çözer:

```
options.modelPriority ?? config.modelPriority ?? config.modelPrefix
```

`modelPriority` `default.ts` içinde **her zaman tanımlı** olduğu için
`modelPrefix` dalı hiç çalışmıyordu — yani kalıcı seçim sessizce yok sayılırdı.
Düzeltme: `buildSttPriority()` ön eki listenin **başına** alır, kalan yedekleri
korur.

```ts
// shared/src/config/default.ts:145
function buildSttPriority(): string[] {
  const configured = (process.env.DIJI_STT_MODEL_PRIORITY || 'medium,small,base,tiny')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const forced = (process.env.DIJI_STT_MODEL_PREFIX || '').trim();
  if (!forced) return configured;
  return [forced, ...configured.filter((item) => item !== forced)];
}
```

Tek ön eke indirilmedi: o model diskten silinirse ajan hiç açılmazdı. Yedekler
korunduğu için sessizce eski modele düşer.

---

## Değişken referansı

### Çalışma modu ve süreç

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_MODE` | `microphone` | `microphone` \| `text` \| `both`. Metin modu mikrofonsuz çalışır. |
| `DIJI_CONTROL_PORT` | `8899` | Kontrol sunucusu portu (ana makine sabit `127.0.0.1`). |
| `DIJI_MODELS_DIR` | `~/.diji/models` | Model dosyalarının kök dizini. STT/VAD/TTS/katalog hep buradan okur. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug`. Alt süreçlere de geçirilir. |
| `DIJI_ROOT` | — | Electron köprüsünün proje kökünü bulmak için baktığı ilk ipucu. |
| `DIJI_NODE_BIN` | `PATH`'ten | Ajanı spawn ederken kullanılacak Node yorumlayıcısı. |

### Ses aygıtları

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_AUDIO_INPUT_DEVICE` | `default` | `arecord` cihazı (`default`, `plughw:1,0`, `hw:…`). **Açıkça verilirse otomatik algılama yapılmaz.** |
| `DIJI_AUDIO_OUTPUT_DEVICE` | `default` | `aplay` cihazı. |
| `DIJI_AUDIO_SILENCE_THRESHOLD` | `0.002` | Mikrofon "sessiz ortam" eşiği (RMS). Panelin `idle`/`active` ayrımı buna dayanır. |
| `DIJI_ARECORD_BIN` | `arecord` | Kayıt ikilisi yolu (test/alternatif araç için). |
| `DIJI_APLAY_BIN` | `aplay` | Oynatma ikilisi yolu. |

> [!NOTE]
> Yanlış cihaz seçimi "STT çalışmıyor" şikayetinin **en sık** nedenidir.
> Ölçüldü (2026-10-27): sorun tanıma zincirinde değil, mikrofon cihaz
> seçimindeydi. `arecord -l` ile doğrulayın.

### STT (Whisper)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_STT_MODEL` | `whisper-small` | Bilgilendirici/log kimliği. Gerçek seçim `PRIORITY` + `PREFIX` ile yapılır. |
| `DIJI_STT_MODEL_PREFIX` | — | Belirtilen ön eki öncelik listesinin **başına** alır (kalıcı seçim). |
| `DIJI_STT_MODEL_PRIORITY` | `medium,small,base,tiny` | Virgülle ayrılmış yedek listesi. Diskte ilk **bulunan** yüklenir. |
| `DIJI_STT_LANGUAGE` | `tr` | Tanıma dili. |
| `DIJI_STT_THREADS` | `2` | CPU iş parçacığı sayısı. |
| `DIJI_STT_PREPROCESS` | `true` | `false` → ön işleme tamamen kapanır. |
| `DIJI_STT_HIGHPASS_HZ` | `80` | High-pass filtresi kesim frekansı. |
| `DIJI_STT_TRIM_THRESHOLD` | `0.006` | Sessizlik kırpma eşiği (Whisper halüsinasyonunu engeller). |
| `DIJI_STT_TARGET_RMS` | `0.06` | AGC hedef seviyesi. |
| `DIJI_STT_MAX_GAIN_DB` | `18` | AGC azami kazancı. |
| `DIJI_STT_NOISE_GATE_RMS` | `0.0025` | Gürültü kapısı eşiği. |
| `DIJI_STT_POSTPROCESS` | `true` | `false` → sözlük/boşluk düzeltmesi kapanır. |
| `DIJI_STT_FUZZY_DISTANCE` | `1` | Bulanık terim eşleştirme mesafesi. |

Ön işleme zinciri: DC çıkarma → high-pass → kırpma → gürültü kapısı → AGC.
Son işleme: halüsinasyon ayıklama → sözlük (Gmail, takvim, Notion …) → boşluk
düzeltme. Süreler ayrı ölçülür (`sttPreprocessMs`, `sttPostprocessMs`) ki
zincirin maliyeti görülsün.

### VAD

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_VAD_THRESHOLD` | `0.5` | Silero konuşma olasılığı eşiği. |
| `DIJI_VAD_MIN_SILENCE` | `0.6` | Konuşma bitti sayılmadan önceki asgari sessizlik (sn). |
| `DIJI_VAD_MIN_SPEECH` | `0.25` | En kısa konuşma süresi (sn). |

Örnekleme oranı `16000` sabittir — STT/VAD/inject aynı oranı kullanır.

### TTS

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_TTS_ENABLED` | `1` | `0`/`false`/`off`/`no` → seslendirme baştan kapalı. |
| `DIJI_TTS_PROVIDER` | `drifting-tts` | `drifting-tts` \| `sherpa-vits`. |
| `DIJI_TTS_VITS_MODEL` | — | **Yalnızca sherpa-vits** dizin adı. Ayarlar ekranı bunu yazar. |
| `DIJI_TTS_MODEL` | sağlayıcıya göre | drifting: `Vyvo/drifting-tts-tr`. Eski/genel anahtar — sherpa'da yedek olarak okunur. |
| `DIJI_TTS_VOICE` | `studio` / `fettah` | Ses kimliği (sağlayıcıya göre). |
| `DIJI_TTS_SPEED` | `1.0` | Konuşma hızı. |
| `DIJI_TTS_SAMPLE_RATE` | `48000` | Çıkış örnekleme oranı. |
| `DIJI_TTS_PYTHON` | `python3` | drifting-tts köprüsü için Python yorumlayıcısı. |
| `DIJI_TTS_BRIDGE` | `scripts/drifting_tts_bridge.py` | Köprü betiği yolu. |

> [!WARNING]
> `DIJI_TTS_MODEL` her iki sağlayıcıda okunduğu için drifting model kimliği
> (`Vyvo/drifting-tts-tr`) sherpa'ya sızabiliyordu. Bu yüzden ayrı
> `DIJI_TTS_VITS_MODEL` eklendi; Ayarlar ekranı bunu kullanır.

### LLM

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_LLM_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI uyumlu yerel sunucu. |
| `DIJI_LLM_MODEL` | `agent` | Model kimliği. |
| `DIJI_LLM_API_KEY` | `sk-local` | Yerel sunucu genelde doğrulamaz; yer tutucudur. |
| `DIJI_LLM_TEMPERATURE` | `0.7` | — |
| `DIJI_LLM_MAX_TOKENS` | `1024` | Yanıt bütçesi. |
| `DIJI_LLM_TIMEOUT_MS` | `120000` | İstek zaman aşımı. |
| `DIJI_LLM_REASONING_RESERVE` | `1024` | Reasoning modelleri için ayrılan token payı. |

**Reasoning bütçesi ölçümü:** `agent` hibrit reasoning modelidir; yanıttan önce
~1.500 token düşünme metni üretir ve bu metin `max_tokens` bütçesinden düşer.
Rezerv olmadan yanıt **boş** döner. Rezerv çok büyükse model daha uzun düşünür
(ölçüldü: 4256 token bütçe → 91 sn). 1024 rezerv, 2048 mutlak tavanla dengeli
çalışır. Reasoning kullanmayan modeller için `0` verin.

### MCP

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_MCP_ENABLED` | `true` | `false` → MCP istemcisi hiç kurulmaz. |
| `DIJI_ALLOW_DELETE` | `false` | `true` → silme izni açılır (yine de ses onayı istenir). |
| `TOKEN_STORAGE_PATH` | `./tokens` | OAuth2 token dizini. Alt süreçlere geçirilir. |
| `ENCRYPTION_PASSWORD` | `diji-default-key` | Token şifreleme parolası. **Üretimde mutlaka değiştirin.** |

### MCP OAuth2 (sunucu başına)

| Sunucu | Değişkenler |
|---|---|
| Gmail | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` |
| Takvim | `CALENDAR_CLIENT_ID`, `CALENDAR_CLIENT_SECRET`, `CALENDAR_REDIRECT_URI` |
| Drive | `DRIVE_CLIENT_ID`, `DRIVE_CLIENT_SECRET`, `DRIVE_REDIRECT_URI` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI` |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` |

Yönlendirme URI'si varsayılanı `http://localhost:3000/auth/<sunucu>/callback`.
Chrome sunucusu OAuth kullanmaz (yerel tarayıcı denetimi).

### Araştırma modülü

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_RESEARCH_TEMPERATURE` | `0.7` | — |
| `DIJI_RESEARCH_MAX_TOKENS` | `4096` | Araştırma yanıt bütçesi (sohbetten yüksek). |
| `DIJI_RESEARCH_TIMEOUT_MS` | `300000` | 5 dakika. |
| `DIJI_RESEARCH_MAX_STEPS` | `10` | Azami araç çemberi sayısı. |

### LiveKit (kullanılmıyor)

| Değişken | Açıklama |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Şemada duruyor, mevcut boru hattı LiveKit kullanmıyor. Boş bırakılabilir. |

### Electron

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIJI_ELECTRON_SANDBOX` | `1` | `0` → sandbox kapatılır (**önerilmez**). |

> [!CAUTION]
> Kabuğunuzda `ELECTRON_RUN_AS_NODE=1` tanımlıysa Electron pencere açmaz,
> Node gibi davranır. Başlatırken `env -u ELECTRON_RUN_AS_NODE` kullanın.

---

## Örnek dosyalar

### `~/.config/diji/env` — dengeli kurulum

```bash
# Diji kalıcı ayarları
DIJI_MODE=microphone
DIJI_LOCALE=tr

# Ses tanıma — small dengeli, medium daha doğru ama yavaş
DIJI_STT_MODEL_PREFIX=small
DIJI_STT_MODEL=whisper-small
DIJI_STT_LANGUAGE=tr

# Dil modeli
DIJI_LLM_BASE_URL=http://127.0.0.1:8000/v1
DIJI_LLM_MODEL=agent
DIJI_LLM_REASONING_RESERVE=1024

# Seslendirme — sherpa-vits bu makinede güvenilir
DIJI_TTS_ENABLED=1
DIJI_TTS_PROVIDER=sherpa-vits
DIJI_TTS_VITS_MODEL=vits-piper-tr_TR-fettah-medium
```

### `~/.config/diji/env` — mikrofonsuz geliştirme

```bash
DIJI_MODE=text
DIJI_TTS_ENABLED=0
LOG_LEVEL=debug
DIJI_MCP_ENABLED=false
```

### `.env.example` (depo kökünde)

Sürüm kontrolüne giren örnek dosya [`../.env.example`](../.env.example)
konumundadır. Gerçek değerleri **asla** commit etmeyin; `.gitignore` `*.env`
desenini dışlar (`!.env.example` hariç).

---

## Doğrulama

```bash
# 1. Varsayılanların çözüldüğünü gör
node -e "console.log(JSON.stringify(require('./agent/dist/index.js'),null,2))" 2>/dev/null || true

# 2. Ajanın gerçekten hangi modelle açıldığını oku
curl -s http://127.0.0.1:8899/models | jq '{stt:.stt.current, tts:.tts.current, llm:.llm.current}'

# 3. Env dosyasının okunduğunu kanıtla: değeri değiştir, ajanı yeniden başlat, tekrar oku
grep '^DIJI_LLM_MODEL' ~/.config/diji/env

# 4. Dosya izinleri (0600 olmalı)
stat -c '%a %n' ~/.config/diji/env ~/.config/diji

# 5. Süreç ortamının env dosyasını EZMEDİĞİNİ doğrula
DIJI_LLM_MODEL=coder node agent/dist/index.js   # coder kazanır (öncelik 1)
```

Model seçimiyle ilgili canlı doğrulama adımları
[API.md](API.md#post-modelsselect) ve [MODELS.md](MODELS.md) içinde.

---

## İlgili belgeler

- [ARCHITECTURE.md](ARCHITECTURE.md) — katmanlar, ses boru hattı, tur yaşam döngüsü
- [API.md](API.md) — uç nokta sözleşmeleri, `/models/select` ayrıntıları
- [MODELS.md](MODELS.md) — model dosyaları, boyutlar, indirme
- [SECURITY.md](../SECURITY.md) — sır yönetimi, izin kapısı
