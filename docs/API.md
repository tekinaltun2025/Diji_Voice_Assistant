# Ajan Kontrol API'si

**Türkçe** · [🇬🇧 English](en/API.md)

Ajan, çalışırken `127.0.0.1:8899` üzerinde küçük bir HTTP + SSE sunucusu açar
([`agent/src/control-server.ts`](../agent/src/control-server.ts)). Masaüstü
arayüzü ajanı yalnızca bu uç noktalar üzerinden yönetir: mikrofonu, ses
cihazlarını ve motorları açan süreç **tek** — ajan süreci.

> [!IMPORTANT]
> Sunucu `CONTROL_HOST = '127.0.0.1'` sabitine bağlıdır, `0.0.0.0`'a
> **açılmaz** ([`control-server.ts:30`](../agent/src/control-server.ts)).
> Dışarıdan erişilemez; yerel bir süreç olmadan port dinlenmez.

---

## İçindekiler

- [Taşıma katmanı](#taşıma-katmanı)
- [Uç nokta özeti](#uç-nokta-özeti)
- [`GET /health`](#get-health)
- [`GET /state`](#get-state)
- [`GET /events` — SSE](#get-events--sse)
- [`POST /listen`](#post-listen)
- [`POST /ask`](#post-ask)
- [`POST /inject`](#post-inject)
- [`POST /tts`](#post-tts)
- [`POST /confirm`](#post-confirm)
- [`POST /bargein`](#post-bargein)
- [`GET /models`](#get-models)
- [`POST /models/select`](#post-modelsselect)
- [SSE olay şemaları](#sse-olay-şemaları)
- [Hata kodları](#hata-kodları)
- [cURL ile hızlı denemeler](#curl-ile-hızlı-denemeler)

---

## Taşıma katmanı

| Konu | Değer |
|---|---|
| Ana makine | `127.0.0.1` (sabit) |
| Varsayılan port | `8899` — `DIJI_CONTROL_PORT` ile değişebilir |
| Yanıt tipi | `application/json; charset=utf-8` |
| CORS | `Access-Control-Allow-Origin: *` (yalnızca yerel) |
| Yöntemler | `GET`, `POST`, `OPTIONS` |
| Önbellek | `Cache-Control: no-store` |
| Gövde sınırı | 1 MB (`readBody` üstü keser) |

Her JSON yanıtı en az bir `ok: boolean` alanı taşır. `ok:false` durumunda
genellikle `error: string` bulunur.

```ts
// agent/src/control-server.ts:51
const send = (res, status, body): void => { /* JSON + CORS başlıkları */ };
```

`OPTIONS` isteği gövdesiz `204` döner; tarayıcı ön kontrolü için gereklidir.

---

## Uç nokta özeti

| Yöntem | Yol | Amaç | Tipik durum |
|---|---|---|---|
| `GET` | `/health` | Süreç canlı mı | `200` |
| `GET` | `/state` | Anlık tam durum görüntüsü | `200` |
| `GET` | `/events` | Canlı telemetri akışı (SSE) | `200` (akış) |
| `POST` | `/listen` | Mikrofonu aç/kapat | `200` |
| `POST` | `/ask` | Metin turu başlat | `202` |
| `POST` | `/inject` | PCM'i mikrofon gibi besle (teşhis) | `202` |
| `POST` | `/tts` | Seslendirmeyi aç/kapat | `200` |
| `POST` | `/confirm` | Bekleyen MCP onayını yanıtla | `200` |
| `POST` | `/bargein` | Konuşmayı/oynatmayı kes | `200` |
| `GET` | `/models` | Ayarlar için model kataloğu | `200` |
| `POST` | `/models/select` | Model değiştir (+ kalıcı kaydet) | `200` / `409` |

Boru hattı henüz kurulmadıysa (`getPipeline()` → `null`) dönen uç noktalar
`503 { ok:false, error:"ajan hazır değil" }` verir.

---

## `GET /health`

Ajan sürecinin canlılık kontrolü. Arayüzün bağlantı durumu göstergesi ve
başlatıcı betiklerin bekleme döngüsü bunu kullanır.

```json
{ "ok": true, "pid": 41213, "uptime": 137 }
```

| Alan | Tip | Açıklama |
|---|---|---|
| `pid` | `number` | Ajan süreç kimliği. Süreci sonlandırmak için bunu kullanın (`pkill -f` **değil** — kendi kabuğunuzu öldürür). |
| `uptime` | `number` | Saniye cinsinden çalışma süresi. |

---

## `GET /state`

Arayüzün ihtiyaç duyduğu **her şeyin** tek istekte özeti. Arayüz açılışta bir
kez çağırır, sonrasını SSE ile günceller.

```jsonc
{
  "ok": true,
  "pid": 41213,
  "uptime": 137,
  "pipeline": {
    "running": true,
    "sessionId": "s-9f1c…",
    "state": {
      "isListening": true,
      "isSpeaking": false,
      "isProcessing": false,
      "isBargeIn": false,
      "lastTranscript": "yarın toplantı var mı",
      "lastResponse": "Yarın saat 14:00'te bir toplantınız var.",
      "lastTurnLatency": { "totalMs": 1840 }
    },
    "audio": {
      "running": true,
      "device": "default",
      "totalBytes": 5216000,
      "forwardedChunks": 1630,
      "skippedChunks": 0,
      "restarts": 0,
      "acRms": 0.0412,
      "silenceThreshold": 0.002
    }
  },
  "ttsEnabled": true,
  "ttsOverride": null,
  "stages": [ { "key": "stt", "label": "STT", "status": "active", "detail": "…", "metrics": {}, "updatedAt": 1761798123456 } ],
  "log": [ { "id": 812, "t": 1761798123456, "level": "info", "stage": "mic", "msg": "dinleme açıldı" } ],
  "turnMetrics": { "sttMs": 412, "llmFirstTokenMs": 980, "llmTotalMs": 980, "ttsFirstByteMs": 180 },
  "lastTurnLatency": {
    "totalMs": 1840, "vadMs": 620, "sttMs": 412, "sttPreprocessMs": 18,
    "sttPostprocessMs": 4, "sttFixes": 1, "sttModel": "whisper-small",
    "llmMs": 980, "llmFirstTokenMs": 980, "mcpMs": 0,
    "ttsFirstChunkMs": 180, "ttsMs": 540, "playbackMs": 2900,
    "firstAudioMs": 1840, "ttsEnabled": true, "mcpToolCount": 0,
    "mcpServers": [], "sttChars": 22, "replyChars": 41,
    "llmModel": "agent", "measuredAt": 1761798123456
  },
  "conversation": [ { "id": "m-1", "role": "user", "text": "yarın toplantı var mı", "at": 1761798121000, "source": "voice" } ],
  "conversationLimit": 50,
  "stageOrder": ["agent", "mic", "vad", "stt", "llm", "tts", "playback", "mcp"],
  "pendingConfirmation": null,
  "mcpServers": [ { "name": "gmail", "connected": true, "toolCount": 4, "permissions": { "read": true, "write": true, "delete": false } } ]
}
```

### Alan sözleşmeleri

| Alan | Not |
|---|---|
| `stages` | Arayüz panelindeki 8 aşama. `status` ∈ `idle` \| `ready` \| `active` \| `warn` \| `error`. Sıra `stageOrder` ile sabittir. |
| `audio.acRms` | **Anlık** DC'si çıkarılmış RMS. "Sesim alınıyor mu" sorusunun doğru cevabı budur; `forwardedChunks` kümülatiftir ve ilk turdan sonra hep `>0` kalır. |
| `ttsEnabled` | Çalışma zamanındaki **gerçek** değer (env + kullanıcı seçimi). |
| `ttsOverride` | `null` = env geçerli; `true`/`false` = kullanıcı açıkça seçti. |
| `lastTurnLatency.totalMs` | Tur başı → **ilk ses**. Tam sentez süresi değildir. |
| `lastTurnLatency` | Aşama süreleri birbirine girer (`vadMs` tur başından öncesine, `playbackMs` ilk sesten sonrasına aittir); toplamları `totalMs` etmez. |
| `conversation` | Yalnızca **görünen** konuşma. LLM'e giden sistem/tool mesajları burada yoktur. Son `conversationLimit` (50) kayıt tutulur. |
| `pendingConfirmation` | `null` = bekleyen onay yok. `expiresAt === null` = soru hâlâ seslendiriliyor, sayaç başlamadı. **Uydurulmaz**: yalnızca ajan gerçekten beklerken doludur. |
| `mcpServers` | Canlı durum. `connected:false` ise araç listesi boştur. |

---

## `GET /events` — SSE

Sunucudan istemciye tek yönlü canlı akış. Arayüzün tüm canlılığı buradan gelir.

**Bağlantı davranışı**

1. Yanıt başlıkları `text/event-stream` olarak yazılır.
2. İlk yazılan satır `retry: 2000` → kopma durumunda istemci 2 sn sonra yeniden bağlanır.
3. Hemen ardından bir `snapshot` olayı gönderilir ve istemci ilk durumu alır.
4. İstemci abone listesine eklenir; `req.on('close')` ile çıkarılır.

```
retry: 2000

event: snapshot
data: {"ok":true,"pid":41213,…}

data: {"type":"stage","state":{…}}

data: {"type":"log","entry":{…}}
```

> [!NOTE]
> Yalnızca **ilk** olay `event:` satırı taşır (`snapshot`). Sonraki olaylar
> `event:` satırı olmadan, yalnızca `data:` olarak yazılır ve ayrım `data`
> içindeki `type` alanıyla yapılır ([`control-server.ts:65`](../agent/src/control-server.ts)).
> Bu yüzden istemci `EventSource.onmessage` kullanır, `addEventListener` değil.

---

## `POST /listen`

Mikrofon dinlemesini açar/kapatır. `enabled` **yoksa veya `false` değilse açık**
kabul edilir.

```jsonc
// istek
{ "enabled": true }

// yanıt
{ "ok": true, "listening": true }
```

| Durum | Gövde |
|---|---|
| Ajan yok | `503 { ok:false, error:"ajan hazır değil" }` |
| Açma hatası | `500 { ok:false, error:"<cihaz hatası>" }` |

Dinleme durumu ayrıca telemetriye yazılır (`mic` aşaması `ready` ↔ `idle`) ve
`stage` olayı olarak akışa düşer.

---

## `POST /ask`

Metin turu başlatır — mikrofonsuz test yolu. **Yanıt metni bu uç noktadan
dönmez**: istek kabul edilir (`202`), üretim arka planda sürer ve sonuç
`conversation-update` + `turn-latency` olaylarıyla gelir.

```jsonc
// istek
{ "text": "bugün hava nasıl" }

// yanıt — hemen
{ "ok": true, "accepted": true }
```

| Durum | Koşul |
|---|---|
| `202` | Kabul edildi, işlem sürüyor |
| `400 { ok:false, error:"metin boş" }` | `text` boş |
| `503` | Ajan hazır değil |

İşlem sırasında hata olursa istemciye HTTP kodu dönmez (202 çoktan gitti);
hata `log` olayı olarak akışa düşer (`level:"error"`, `stage:"llm"`).

---

## `POST /inject`

Teşhis yolu: gövdedeki ham PCM'i mikrofon akışıymış gibi boru hattına verir.
`Content-Type: application/octet-stream` ile **PCM16 / 16 kHz / mono**
gönderilir — WAV başlığı **olmadan**.

```bash
# 16 kHz mono PCM'e çevir, sonra enjekte et
ffmpeg -i test.wav -f s16le -acodec pcm_s16le -ac 1 -ar 16000 test.pcm -y
curl -X POST --data-binary @test.pcm \
     -H 'Content-Type: application/octet-stream' \
     http://127.0.0.1:8899/inject
```

```jsonc
{ "ok": true, "seconds": 3.42 }
```

**Neden gerçek zamanlı besleniyor:** VAD sessizlik süresini duvar saatinden
ölçer. Tüm PCM tek seferde verilseydi segment hiç kapanmaz, tur algılanmazdı.
Bu yüzden 100 ms'lik parçalar (`3200` bayt) `setInterval` ile verilir.

**Sondaki yapay sessizlik:** Gerçek mikrofonda konuşma bittikten sonra da
sessiz parçalar gelmeye devam eder ve VAD "konuşma bitti" kararını verir.
Enjeksiyonda bu doğal olarak yoktur; bu yüzden gövdeden sonra **1,5 sn**
(15 × 100 ms) sıfır PCM eklenir. Bu olmadan segment kapanmaz.

| Durum | Koşul |
|---|---|
| `202` | Kabul edildi |
| `400 { ok:false, error:"PCM çok kısa (en az 100 ms gerekli)" }` | Gövde < 3200 bayt |
| `503` | Ajan hazır değil |

---

## `POST /tts`

Seslendirmeyi çalışma zamanında açar/kapatır. Üç durumludur:

| Gövde | Anlamı |
|---|---|
| `{ "enabled": true }` | Zorla aç |
| `{ "enabled": false }` | Zorla kapat |
| `{}` veya `{ "enabled": null }` | Override'ı temizle → `DIJI_TTS_ENABLED` env değerine dön |

```jsonc
{ "ok": true, "enabled": true, "override": true }
```

Değişiklik `tts-toggle` SSE olayıyla tüm istemcilere yayılır, böylece tray
menüsü ve arayüz aynı anda güncellenir.

---

## `POST /confirm`

Bekleyen MCP onayını yanıtlar. `confirmed === true` **dışındaki her değer
reddir** (Katı eşitlik: `"true"` string'i onay sayılmaz).

```jsonc
// istek
{ "confirmed": true }

// yanıt
{ "ok": true, "applied": true }
```

### Yarış durumu ve çözümü

[`requestVoiceConfirmation()`](../agent/src/pipeline.ts) onay kaydını
TTS'ten **önce** yayınlar (`expiresAt: null`) ama bekleyen promise'i seslendirme
bittikten **sonra** kurar. Arayüz diyaloğu erken açtığı için kullanıcı hemen
"Onayla"ya basarsa istek `applied:false` ile sessizce kayboluyordu.

Çözüm: kayıt duruyorsa en fazla 5 sn boyunca 100 ms aralıklarla yeniden
denenir. Bekleyen onay yoksa hemen `applied:false` döner.

| `applied` | Anlamı |
|---|---|
| `true` | Karar iletildi, işlem sürüyor/sürdü |
| `false` | Bekleyen işlem yok (zaman aşımı, zaten yanıtlandı, hiç yoktu) |

---

## `POST /bargein`

Süren yanıtı keser: LLM akışı, TTS sentezi ve hoparlör kuyruğu **birlikte**
kapatılır. Gövde gerekmez.

```jsonc
{ "ok": true }
```

> [!WARNING]
> Üçünü birden kapatmak zorunludur. Yalnızca oynatma durdurulursa arayüz
> `KONUŞUYOR` durumunda asılı kalır çünkü `isSpeaking` `tts` **veya**
> `playback` aşamasının aktif olmasından türetilir.

---

## `GET /models`

Ayarlar ekranının model listeleri. Katalog **tamamen makinede ne varsa** ondan
üretilir — sabit bir "desteklenen modeller" tablosu yoktur
([`agent/src/model-catalog.ts`](../agent/src/model-catalog.ts)).

```jsonc
{
  "ok": true,
  "stt": {
    "current": "small",
    "options": [
      { "id": "small",  "label": "Small — dengeli (önerilen)", "available": true, "detail": "int8 · 484 MB" },
      { "id": "medium", "label": "Medium — yüksek doğruluk, yavaş", "available": false, "detail": "dosya eksik" }
    ]
  },
  "tts": {
    "current": "vits-piper-tr_TR-fettah-medium",
    "options": [
      { "id": "vits-piper-tr_TR-fettah-medium", "label": "Piper · Türkçe · fettah medium", "available": true, "detail": "model.onnx + tokens.txt" }
    ]
  },
  "llm": {
    "current": "agent",
    "options": [
      { "id": "agent", "label": "agent", "available": true, "detail": "yerel sunucu" },
      { "id": "coder", "label": "coder", "available": true, "detail": "yerel sunucu" }
    ]
  },
  "modelsDir": "/home/<kullanıcı>/.diji/models"
}
```

### Katalog kaynakları

| Tür | Kaynak | Koşul |
|---|---|---|
| `stt` | `~/.diji/models/sherpa-onnx-whisper-<önek>/` | `<önek>-encoder*.onnx`, `<önek>-decoder*.onnx`, `<önek>-tokens.txt` **üçü de** gerekir |
| `tts` | `~/.diji/models/vits-*` | `.onnx` + `tokens.txt` |
| `llm` | `http://127.0.0.1:8000/v1/models` | 2,5 sn zaman aşımı; sunucu kapalıysa boş liste |

`current` alanı **çalışan motorun gerçek kimliğidir**, yapılandırma değeri
değil. Ayrım önemli: `drifting-tts` başlatılamazsa motor sessizce
`sherpa-vits`'e düşer ve `config.tts.provider` yanıltıcı olur.

`modelsDir` `DIJI_MODELS_DIR` ile değiştirilebilir; teşhis için yanıtta
döndürülür.

> [!NOTE]
> Katalog `/state` içinde **değildir**: LLM listesi yerel sunucuya HTTP isteği
> gerektirir (~2,5 sn) ve `/state` her arayüz açılışında çağrılır. Bu yüzden
> katalog ayrı ve isteğe bağlıdır; yalnızca Ayarlar paneli açılınca çekilir.

| Durum | Koşul |
|---|---|
| `500 { ok:false, error }` | Katalog üretilemedi (disk izni, tarama hatası) |
| `503` | Ajan hazır değil |

---

## `POST /models/select`

Model değiştirir ve seçimi **kalıcı** olarak `~/.config/diji/env` dosyasına
yazar.

```jsonc
// istek
{ "kind": "stt", "id": "medium" }

// yanıt — başarılı
{
  "ok": true,
  "current": "medium",
  "persisted": true,
  "persistHint": "Seçim kalıcı kaydedildi (~/.config/diji/env)"
}
```

### `kind` değerleri ve geçiş maliyeti

| `kind` | Ne olur | Süre |
|---|---|---|
| `llm` | Yalnızca model adı sonraki istekte gövdeye yazılır; motor yeniden başlamaz | Anında |
| `stt` | `STTEngine` dispose + yeniden oluşturma (`modelPriority:[id, …]`) | ~2–6 sn |
| `tts` (VITS) | `TTSEngine` dispose + yeniden oluşturma | ~1–3 sn |
| `tts` (`drifting-tts`) | Python köprüsü yeniden başlar | ~60–70 sn → `slow:true` |

### Yanıt alanları

| Alan | Tip | Açıklama |
|---|---|---|
| `ok` | `boolean` | Değişim gerçekleşti mi |
| `current` | `string` | Değişim sonrası **çalışan** model kimliği |
| `reason` | `string?` | `ok:false` ise nedeni |
| `slow` | `boolean?` | Geçiş uzun sürdü (drifting-tts) |
| `persisted` | `boolean?` | Env dosyasına yazıldı mı |
| `persistError` | `string?` | Yazma başarısızsa nedeni (izin, disk) |
| `persistHint` | `string?` | Kullanıcıya gösterilecek hazır not |

### `persisted` / `ok` ayrımı — bilinçli karar

Kalıcılık yazımı başarısız olsa bile model **bu süreçte değişmiştir**, bu
yüzden yanıt `ok:true` kalır ve `persisted:false` ile ayrıca bildirilir. Arayüz
`· kalıcı kaydedildi` / `· yalnızca bu oturum` notunu buna göre kurar. Alternatif
(tek bir `ok` alanına iki anlam yüklemek) sessiz veri kaybına yol açardı.

### Yazılan anahtarlar

| `kind` | Yazılan anahtarlar |
|---|---|
| `llm` | `DIJI_LLM_MODEL` |
| `stt` | `DIJI_STT_MODEL_PREFIX`, `DIJI_STT_MODEL` |
| `tts` (dizin) | `DIJI_TTS_PROVIDER=sherpa-vits`, `DIJI_TTS_VITS_MODEL` |
| `tts` (sağlayıcı) | `DIJI_TTS_PROVIDER` |

Yazma sözleşmesi: satır satır (yorumlar korunur), yinelenen anahtarların
**hepsi** güncellenir, atomik (`temp` + `rename`), kip `0600`, **asla throw
etmez** ([`agent/src/env-prefs.ts`](../agent/src/env-prefs.ts)).

### Aynı modeli yeniden seçmek

Motor **yeniden başlatılmaz**. Ölçüldü: gereksiz yeniden başlatma 8 sn ölü
zaman ve mikrofonun boşa kesilmesi demekti. Bu durumda yalnızca kalıcılık
yazılır ve `ok:true` döner.

### Durum kodları

| Kod | Koşul | Örnek |
|---|---|---|
| `200` | Değişim başarılı (kalıcılık başarısız olsa da) | `{ ok:true, current:"medium", persisted:true }` |
| `400` | `kind` geçersiz / `id` boş | `{ ok:false, error:"kind stt\|tts\|llm olmalı" }` |
| `409` | Model seçilemez (diskte yok, sunucuda yok, motor hazır değil) | `{ ok:false, current:"small", reason:"model diskte bulunamadı" }` |
| `503` | Ajan hazır değil | `{ ok:false, error:"ajan hazır değil" }` |

> [!IMPORTANT]
> `409` durumunda **env dosyasına hiçbir şey yazılmaz**. Doğrulandı: geçersiz
> `large-v3` denemesinden sonra `grep -c large-v3 ~/.config/diji/env` → `0`.
> Geçersiz bir seçimin kalıcı hale gelmesi, ajanın bir sonraki açılışta
> kırılması demek olurdu.

---

## SSE olay şemaları

Tüm olaylar `data: <json>\n\n` biçiminde gelir. Ayrım `type` alanıyladır —
`snapshot` **istisnadır** (ayrı `event:` satırı taşır ve `type` alanı yoktur,
doğrudan `StatePayload` gövdesidir).

### `snapshot`

```jsonc
{ "ok": true, "pid": 41213, … }
```

Tam [`GET /state`](#get-state) gövdesi. Bağlantı kurulduğu anda bir kez gelir;
sonrasında parçalı güncellemeler akar.

### `stage`

Bir aşamanın durumu değişti.

```jsonc
{ "type": "stage", "state": { "key": "stt", "label": "STT", "status": "active", "detail": "transkripsiyon…", "metrics": { "ms": "412" }, "updatedAt": 1761798123456 } }
```

### `log`

Teşhis panelindeki satır.

```jsonc
{ "type": "log", "entry": { "id": 812, "t": 1761798123456, "level": "info", "stage": "mic", "msg": "dinleme açıldı" } }
```

`level` ∈ `info` \| `warn` \| `error`. `stage` ∈ `agent`, `mic`, `vad`, `stt`,
`llm`, `tts`, `playback`, `mcp`.

### `turn-latency`

Bir tur tamamlandı (ilk ses çıktı). Döküm
[`TurnLatency`](../agent/src/telemetry.ts) tipindedir.

```jsonc
{ "type": "turn-latency", "latency": { "totalMs": 1840, "sttMs": 412, "llmMs": 980, "ttsFirstChunkMs": 180, "…": "…" } }
```

> [!NOTE]
> `turnToken` mekanizması, eşzamanlı turlarda ölçümün sıfırlanmasını önler:
> eski bir turun geç biten olayı yeni turun sayaçlarını ezmez.

### `conversation-update`

Sohbet geçmişi değişti. **Tam liste** gönderilir; istemci durumu idempotent
biçimde eşitler (ekleme/silme ayrımı yapmak zorunda kalmaz).

```jsonc
{
  "type": "conversation-update",
  "conversation": [
    { "id": "m-1", "role": "user", "text": "yarın toplantı var mı", "at": 1761798121000, "source": "voice" },
    { "id": "m-2", "role": "assistant", "text": "Yarın 14:00'te toplantınız var.", "at": 1761798122000, "source": "voice", "latencyMs": 1840 }
  ]
}
```

### `confirmation`

Onay bekleyen işlem açıldı / kapandı.

```jsonc
{ "type": "confirmation", "pending": { "server": "gmail", "tool": "gmail.send_message", "permission": "write", "reason": "e-posta göndermek yazma izni gerektirir", "question": "…", "requestedAt": 1761798121000, "expiresAt": 1761798141000 } }
{ "type": "confirmation", "pending": null }
```

### `tts-toggle`

Seslendirme anahtarı değişti (tray veya arayüz).

```jsonc
{ "type": "tts-toggle", "enabled": false }
```

---

## Hata kodları

| Kod | Anlamı | Tipik neden |
|---|---|---|
| `200` | Başarılı | — |
| `202` | Kabul edildi, işlem sürüyor | `/ask`, `/inject` |
| `204` | Gövdesiz (CORS ön kontrolü) | `OPTIONS` |
| `400` | Geçersiz istek gövdesi | `kind`/`id`/`text` boş veya geçersiz |
| `409` | Model seçilemedi | Diskte/sunucuda yok, motor hazır değil |
| `500` | Sunucu hatası | Cihaz açılamadı, katalog üretilemedi |
| `503` | Ajan hazır değil | Boru hattı henüz kurulmadı |

---

## cURL ile hızlı denemeler

```bash
# Canlı mı?
curl -s http://127.0.0.1:8899/health

# Tam durum
curl -s http://127.0.0.1:8899/state | jq '.stages[] | {key, status, detail}'

# Canlı akış (ilk 200 satır)
curl -N http://127.0.0.1:8899/events | head -200

# Mikrofonu aç
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":true}' http://127.0.0.1:8899/listen

# Metin turu (yanıt SSE'den gelir)
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"text":"merhaba"}' http://127.0.0.1:8899/ask

# Model listesi
curl -s http://127.0.0.1:8899/models | jq '.stt'

# Model değiştir (kalıcı)
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"llm","id":"coder"}' http://127.0.0.1:8899/models/select

# Geçersiz seçim → 409, env'e YAZILMAZ
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'Content-Type: application/json' \
     -d '{"kind":"stt","id":"large-v3"}' http://127.0.0.1:8899/models/select

# Seslendirmeyi kapat
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":false}' http://127.0.0.1:8899/tts
```

Betikler hazır: [`scripts/smoke-test.js`](../scripts/smoke-test.js),
[`scripts/control-e2e.js`](../scripts/control-e2e.js),
[`scripts/inject-e2e.js`](../scripts/inject-e2e.js),
[`scripts/verify-stt-chain.js`](../scripts/verify-stt-chain.js).

---

## İlgili belgeler

- [ARCHITECTURE.md](ARCHITECTURE.md) — katmanlar, ses boru hattı, tur yaşam döngüsü
- [CONFIGURATION.md](CONFIGURATION.md) — ortam değişkenleri ve `~/.config/diji/env`
- [MODELS.md](MODELS.md) — model dosyaları, boyutlar, lisanslar
- [SECURITY.md](../SECURITY.md) — tehdit modeli, izin kapısı ([English](../SECURITY.en.md))
