# Modeller

**Türkçe** · [🇬🇧 English](en/MODELS.md)

Diji'nin tüm ses motorları **yerel** çalışır. Konuşma, transkript ve yanıt
metni hiçbir bulut servisine gönderilmez. Model dosyaları kod deposunda
**tutulmaz** (`.gitignore` ağırlıkları dışlar); `~/.diji/models` altına
indirilir.

---

## İçindekiler

- [Model dizini](#model-dizini)
- [Dosya yerleşimi](#dosya-yerleşimi)
- [Hızlı indirme](#hızlı-indirme)
- [STT — Whisper](#stt--whisper)
- [VAD — Silero](#vad--silero)
- [TTS — iki arka uç](#tts--iki-arka-uç)
- [LLM — yerel sunucu](#llm--yerel-sunucu)
- [Model seçimi ve kalıcılık](#model-seçimi-ve-kalıcılık)
- [Elle model ekleme](#elle-model-ekleme)
- [Lisanslar](#lisanslar)
- [Sorun giderme](#sorun-giderme)

---

## Model dizini

```
~/.diji/models/
```

`DIJI_MODELS_DIR` ile değiştirilebilir. Dört tüketici de aynı değişkeni okur:
[`stt.ts:113`](../agent/src/stt.ts), [`vad.ts:79`](../agent/src/vad.ts),
[`tts.ts:70`](../agent/src/tts.ts),
[`model-catalog.ts:50`](../agent/src/model-catalog.ts). Ajan, VAD ve Ayarlar
paneli **aynı** dizini gördüğünden liste ile gerçek yükleme tutarlıdır.

---

## Dosya yerleşimi

```
~/.diji/models/
├── silero_vad.onnx                          # VAD (633 KB)
├── sherpa-onnx-whisper-small/               # STT (1.3 GB — int8 + fp32 birlikte)
│   ├── small-encoder.int8.onnx              #   108 MB
│   ├── small-decoder.int8.onnx              #   251 MB
│   ├── small-encoder.onnx                   #   391 MB
│   ├── small-decoder.onnx                   #   534 MB
│   ├── small-tokens.txt                     #   798 KB
│   └── test_wavs/                           #   örnekler
└── vits-piper-tr_TR-fettah-medium/          # TTS (61 MB)
    ├── tr_TR-fettah-medium.onnx             #   61 MB
    ├── tr_TR-fettah-medium.onnx.json
    ├── tokens.txt
    ├── MODEL_CARD
    └── espeak-ng-data/                      #   çok dilli fonemleştirme
```

> [!NOTE]
> Whisper paketleri **hem** int8 **hem** fp32 ağırlıkları birlikte getirir.
> Diji `computeType: 'int8'` kullandığı için yalnızca `*.int8.onnx` dosyaları
> yüklenir; fp32 dosyalar diskte yer kaplar ama kullanılmaz. Yer sıkıntısı
> varsa `*-encoder.onnx` ve `*-decoder.onnx` (int8 olmayanlar) silinebilir.

---

## Hızlı indirme

```bash
./scripts/download-models.sh all         # VAD + Whisper medium + VITS
./scripts/download-models.sh stt         # yalnızca Whisper (varsa medium, yoksa indirir)
./scripts/download-models.sh stt-small   # Whisper small
./scripts/download-models.sh stt-base
./scripts/download-models.sh stt-tiny
./scripts/download-models.sh stt-large   # large-v3 (CPU'da çok yavaş)
./scripts/download-models.sh tts         # yalnızca VITS
./scripts/download-models.sh vad         # yalnızca Silero
```

Betik idempotenttir: hedef dizin dolu ise **atlar**, yeniden indirmez
([`download-models.sh:29`](../scripts/download-models.sh)).

Tüm dosyalar `github.com/k2-fsa/sherpa-onnx/releases` üzerinden gelir; ek bir
hesap veya API anahtarı gerekmez.

---

## STT — Whisper

sherpa-onnx Whisper paketleri. Türkçe için en iyi yerel seçenek.

### Dosya koşulu — üçü birden zorunlu

Model **yüklenebilir** sayılması için şu üç dosya gerekir
([`model-catalog.ts:97`](../agent/src/model-catalog.ts)):

| Dosya | Desen |
|---|---|
| Encoder | `<önek>-encoder*.onnx` |
| Decoder | `<önek>-decoder*.onnx` |
| Tokenizer | `<önek>-tokens.txt` **veya** `tokens.txt` |

Biri eksikse model listede **görünür ama soluk** (`available: false`,
`detail: "dosya eksik"`) ve seçilemez. Bu bilinçlidir: kullanıcı neyin neden
çalışmadığını görebilmeli.

### Dizin adlandırma

İki biçim kabul edilir, ilk bulunan kullanılır:

1. `sherpa-onnx-whisper-<önek>` ← indirme betiğinin ürettiği
2. `whisper-<önek>`

### Boyut ve doğruluk dengesi

| Model | Yaklaşık boyut (int8) | Türkçe doğruluk | CPU gecikmesi | Öneri |
|---|---|---|---|---|
| `tiny` | ~40 MB | En düşük | En hızlı | Yalnızca deneme |
| `base` | ~75 MB | Düşük | Hızlı | Zayıf donanım |
| `small` | **359 MB** (108+251) | Dengeli | ~0,4 sn | **Varsayılan öneri** |
| `medium` | ~770 MB | Yüksek | ~2–3× small | Doğruluk önceliği |
| `large-v3` | ~1,5 GB | En yüksek | Çok yavaş | Gerçek zamanlı için uygun değil |

Tablo değerleri **bu makinede ölçülen** dosya boyutlarına ve gözlemlenen
gecikmelere dayanır; farklı donanımda değişir. `small` int8 dosya boyutları
yukarıdaki `ls` çıktısından alınmıştır.

### Öncelik çözümlemesi

```
buildSttPriority() → [DIJI_STT_MODEL_PREFIX, ...DIJI_STT_MODEL_PRIORITY (tekrarsız)]
```

Diskte listede **ilk bulunan** model yüklenir. Varsayılan sıra
`medium,small,base,tiny` — yani medium varsa o, yoksa small. Bu yüzden
`download-models.sh stt` medium'u tercih eder.

> [!WARNING]
> Ön ek listesi tek elemana indirilmez. İndirilseydi, seçilen model diskten
> silindiğinde ajan **hiç açılmazdı**. Yedekler korunduğu için sessizce bir
> alt modele düşer ve açılmaya devam eder.

### Türkçe kalite ayarları

| Ayar | Değer | Neden |
|---|---|---|
| `DIJI_STT_LANGUAGE` | `tr` | Dil zorlaması; otomatik algılama Türkçe'de kararsız |
| `trimSilence` | açık | Whisper sessiz bölgede halüsinasyon üretir |
| `trimThreshold` | `0.006` | Ölçülen sessiz oda tabanına göre |
| Yüksek geçiren | 80 Hz | Masa/klavye gürültüsünü keser |
| AGC | hedef RMS 0,06 / azami 18 dB | Kullanıcı mikrofonun uzağındaysa kurtarır |
| Son işleme sözlüğü | gmail, takvim, notion, slack, drive, chrome, e-posta, toplantı, hatırlatıcı, etkinlik | Alan terimlerinin yanlış transkripsiyonunu düzeltir |

---

## VAD — Silero

| Özellik | Değer |
|---|---|
| Dosya | `~/.diji/models/silero_vad.onnx` |
| Boyut | 633 KB |
| Örnekleme | 16 kHz mono |
| Eşik | `DIJI_VAD_THRESHOLD` = `0.5` |
| Asgari sessizlik | `DIJI_VAD_MIN_SILENCE` = `0.6` sn |
| Asgari konuşma | `DIJI_VAD_MIN_SPEECH` = `0.25` sn |

Bu tek dosya yoksa ajan **açılmaz**: mikrofon akışından segment üretilemez.
`download-models.sh vad` ile indirilir; betik dosya varsa atlar.

---

## TTS — iki arka uç

### 1. `drifting-tts` (birincil, varsayılan)

| Özellik | Değer |
|---|---|
| Model | `Vyvo/drifting-tts-tr` |
| Parametre | 89,3 M |
| Türkçe WER | %1,33 (Freya-TR-Eval) |
| Doğal örnekleme | 24 kHz |
| Çalışma biçimi | Python alt süreci ([`scripts/drifting_tts_bridge.py`](../scripts/drifting_tts_bridge.py)), stdio JSON çerçeveleri |
| Gerekli | Python 3 + model ağırlıkları (HuggingFace) |

**Neden Python köprüsü:** model PyTorch tabanlıdır; Node'dan doğrudan
yüklenemez. Ajan `spawn` ile bir Python alt süreci açar ve iki yönlü JSON
satırları üzerinden konuşur.

> [!IMPORTANT]
> Bu makinede `drifting-tts` **başlamıyor** — Python köprüsü `code=null` ile
> ölüyor. Motor bunu algılayıp sessizce `sherpa-vits`'e düşer
> ([`tts.ts:385`](../agent/src/tts.ts)). Bu yüzden Ayarlar panelinde
> **çalışan** motor `sherpa-vits` görünür, `config.tts.provider` değil.

Geçiş maliyeti yüksektir: sağlayıcı değiştirildiğinde Python köprüsü yeniden
başlar ve ~60–70 sn sürer → `POST /models/select` yanıtında `slow: true`.

### 2. `sherpa-vits` (yedek, bu makinede fiilen çalışan)

| Özellik | Değer |
|---|---|
| Model | `vits-piper-tr_TR-fettah-medium` |
| Boyut | 61 MB |
| Konuşmacı | Tek (Fettah, erkek, medium kalite) |
| Fonemleştirme | `espeak-ng-data` (paket içinde) |
| Örnekleme | `DIJI_TTS_SAMPLE_RATE` = 48 kHz |
| Gerekli | `.onnx` + `tokens.txt` |

Dosya koşulu: dizinde **en az bir** `.onnx` **ve** `tokens.txt`
([`model-catalog.ts:142`](../agent/src/model-catalog.ts)). `espeak-ng-data`
alt dizini varsa etiket `espeak-ng`, yoksa `tek konuşmacı` gösterilir.

Geçiş maliyeti ~1–3 sn (motor dispose + yeniden oluşturma).

### Sağlayıcı seçimi

```bash
# sherpa-vits'e sabitle (bu makinede önerilen)
DIJI_TTS_PROVIDER=sherpa-vits
DIJI_TTS_VITS_MODEL=vits-piper-tr_TR-fettah-medium

# drifting-tts
DIJI_TTS_PROVIDER=drifting-tts
DIJI_TTS_MODEL=Vyvo/drifting-tts-tr
DIJI_TTS_PYTHON=python3
```

> [!CAUTION]
> `DIJI_TTS_MODEL` **her iki** sağlayıcıda okunur. drifting model kimliği
> (`Vyvo/drifting-tts-tr`) sherpa'ya sızarsa motor `vits-` dizini bulamaz ve
> TTS sessizce ölür. Bu yüzden sherpa için **ayrı** `DIJI_TTS_VITS_MODEL`
> anahtarı vardır ve Ayarlar ekranı onu yazar.

### Karşılaştırma

| | `drifting-tts` | `sherpa-vits` |
|---|---|---|
| Kalite | Daha doğal (89 M, tek adım) | İyi, "medium" VITS |
| Bağımlılık | Python 3 + PyTorch | Yok (saf onnx) |
| İlk yükleme | ~60–70 sn | ~1–3 sn |
| Geçiş | ~60–70 sn (`slow:true`) | ~1–3 sn |
| Bu makinede | Başlamıyor | **Çalışıyor** |

---

## LLM — yerel sunucu

Diji bir model **dosyası** taşımaz; OpenAI uyumlu yerel bir sunucuya bağlanır.

```bash
# Varsayılan
DIJI_LLM_BASE_URL=http://127.0.0.1:8000/v1
DIJI_LLM_MODEL=agent
DIJI_LLM_API_KEY=sk-local
```

### Sağlık kontrolü

Ajan açılışta `GET {baseUrl}/models` çağırır (2,5 sn zaman aşımı). Sunucu
kapalıysa ajan **yine açılır**; Ayarlar panelinde tek satır `available:false` /
`detail: "LLM sunucusuna ulaşılamadı"` görünür. Böylece kullanıcı "seçili" ile
"seçilebilir" ayrımını görür.

### Katalog kaynağı ve kimlik biçimi

`llama.cpp` sunucuları `/v1/models` yanıtında **tam dosya yolu** döndürebilir:

```jsonc
{ "data": [ { "id": "/home/user/models/agent.gguf", "details": { "parameter_size": "8B", "quantization_level": "Q4_K_M" } } ] }
```

Bu durumda:

- `label` → dosya adı, `.gguf` uzantısı kırpılmış (`agent`)
- `id` → **tam yol** (seçimde bu gönderilir; sunucu bu adla eşleştirir)
- `detail` → `8B · Q4_K_M · metin`

Kimliği kırpıp `agent` göndermek sunucuda eşleşmez → bu yüzden tam yol korunur.

### Reasoning bütçesi

`agent` hibrit reasoning modelidir: yanıttan önce ~1.500 token düşünme metni
üretir ve bu metin `DIJI_LLM_MAX_TOKENS` bütçesinden düşer.

| `DIJI_LLM_REASONING_RESERVE` | Sonuç |
|---|---|
| `0` | Reasoning modeli için **boş yanıt** |
| `1024` (varsayılan) | Dengeli |
| `2048` | Güvenli üst sınır |
| `4256` | Ölçüldü: 91 sn'ye kadar düşünme |

Reasoning kullanmayan modeller (ör. `coder`) için `0` uygun olabilir.

---

## Model seçimi ve kalıcılık

Ayarlar ekranı `/models` kataloğunu okur, `/models/select` ile değiştirir.
Ayrıntılı sözleşme [API.md](API.md#post-modelsselect) içinde.

| Tür | Geçiş | Kalıcı anahtar |
|---|---|---|
| `llm` | Anında | `DIJI_LLM_MODEL` |
| `stt` | ~2–6 sn | `DIJI_STT_MODEL_PREFIX` + `DIJI_STT_MODEL` |
| `tts` (VITS) | ~1–3 sn | `DIJI_TTS_PROVIDER=sherpa-vits` + `DIJI_TTS_VITS_MODEL` |
| `tts` (drifting) | ~60–70 sn | `DIJI_TTS_PROVIDER=drifting-tts` |

Seçim `~/.config/diji/env` dosyasına yazılır; ajan yeniden başladığında da
geçerlidir. **Geçersiz** seçim (`409`) env dosyasına **yazılmaz** — aksi halde
ajan bir sonraki açılışta kırılırdı.

Aynı modeli yeniden seçmek motoru yeniden başlatmaz (ölçüldü: gereksiz yeniden
başlatma 8 sn ölü zaman + mikrofonun boşa kesilmesi). Yalnızca kalıcılık yazılır.

Canlı doğrulama:

```bash
# 1. Mevcut durum
curl -s http://127.0.0.1:8899/models | jq '{stt:.stt.current, tts:.tts.current, llm:.llm.current}'

# 2. Değiştir
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"stt","id":"small"}' http://127.0.0.1:8899/models/select

# 3. Kalıcı yazıldı mı?
grep -E '^DIJI_(STT|LLM|TTS)' ~/.config/diji/env

# 4. Yeniden başlat ve aynı değerleri gör
kill "$(curl -s http://127.0.0.1:8899/health | jq -r .pid)"
node agent/dist/index.js &
sleep 5
curl -s http://127.0.0.1:8899/models | jq '{stt:.stt.current, tts:.tts.current, llm:.llm.current}'
```

---

## Elle model ekleme

Katalog **tamamen diskten** üretilir. Yani yeni bir model eklemek için indirme
betiğini beklemek gerekmez — doğru yerleşimle kopyalamak yeterlidir.

### Whisper

```bash
# 1. Paketi indir ve aç
curl -fL -o /tmp/whisper.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-medium.tar.bz2
tar -xf /tmp/whisper.tar.bz2 -C ~/.diji/models/

# 2. Üç dosyanın varlığını doğrula (üçü de zorunlu)
ls ~/.diji/models/sherpa-onnx-whisper-medium/ \
   | grep -E 'medium-(encoder|decoder).*\.onnx|tokens\.txt'

# 3. Ayarlar panelini yenile → model listede görünür
```

### VITS

```bash
curl -fL -o /tmp/vits.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-tr_TR-fettah-medium.tar.bz2
tar -xf /tmp/vits.tar.bz2 -C ~/.diji/models/

# .onnx + tokens.txt olmalı
ls ~/.diji/models/vits-*/
```

Dizin adı `vits-` ile **başlamalıdır**; katalog taraması bu ön eke bakıyor.

---

## Lisanslar

### Bu depo

Kaynak kod **MIT** — bkz. [LICENSE](../LICENSE). © 2026 Tekin Altun.

### Üçüncü taraf modeller

Model ağırlıkları bu depoda **bulunmaz** ve MIT kapsamı dışındadır. Kendi
lisansları geçerlidir:

| Bileşen | Lisans | Not |
|---|---|---|
| **OpenAI Whisper** (ağırlıklar) | MIT | sherpa-onnx paketleri Whisper ağırlıklarını taşır |
| **sherpa-onnx** (çalışma zamanı) | Apache-2.0 | k2-fsa |
| **Silero VAD** | MIT | Silero ekibi |
| **Piper / VITS** (`vits-piper-tr_TR-fettah-medium`) | MIT | Piper projesi; ses verisi kendi koşullarına tabi olabilir |
| **espeak-ng** | GPL-3.0 | Yalnızca VITS fonemleştirme verisi olarak paket içinde gelir |
| **Vyvo / drifting-tts-tr** | Model kartına bakın | HuggingFace modeli; kullanım koşullarını kontrol edin |
| **Electron** | MIT | Masaüstü kabuğu |
| **TanStack Start / React** | MIT | Arayüz |

> [!NOTE]
> `espeak-ng` verisi GPL-3.0'dır ve **ayrı bir süreç/veri olarak** kullanılır;
> Diji kaynak kodu türev çalışma sayılmaz. Yine de ticari dağıtım
> planlıyorsanız kendi hukuki değerlendirmenizi yapın.

### LLM modelleri

Yerel sunucunuzdaki modellerin lisansları (Llama, Qwen, Mistral, Gemma …)
tamamen size aittir; Diji yalnızca HTTP istemcisidir.

---

## Sorun giderme

| Belirti | Neden | Çözüm |
|---|---|---|
| Model listede **soluk** (`available:false`) | Dosya eksik | `detail` alanını okuyun; `download-models.sh` ile indirin |
| STT listesi **boş** | `~/.diji/models` yok veya ön ek uyuşmuyor | `ls ~/.diji/models`; dizin adı `sherpa-onnx-whisper-*` veya `whisper-*` olmalı |
| LLM listesinde tek satır "ulaşılamadı" | Yerel sunucu kapalı | `curl http://127.0.0.1:8000/v1/models` |
| TTS sessiz ama seçim başarılı | `drifting-tts` başlayamadı, yedek de yok | `DIJI_TTS_PROVIDER=sherpa-vits` yapın, VITS dizinini doğrulayın |
| STT "small" seçildi ama medium yükleniyor | Ön ek etkisiz kalmış | `buildSttPriority()` düzeltmesinin derlendiğinden emin olun; `grep STT ~/.config/diji/env` |
| Seçim yeniden başlatınca kayboluyor | Env dosyası okunmuyor veya yazılamıyor | `stat -c '%a' ~/.config/diji/env` → `600`; `DIJI_*` değerleri `default.ts`'te `process.env` ile okunuyor mu? |
| Model var ama "yüklenemedi" | int8 dosyası eksik, yalnızca fp32 var | `ls <dizin>/*int8*`; yoksa tam paketi indirin |
| `large-v3` 409 döndürüyor | Diskte yok | `download-models.sh stt-large` |

Ayrıntılı tanı: [ARCHITECTURE.md](ARCHITECTURE.md),
[CONFIGURATION.md](CONFIGURATION.md), [API.md](API.md).

---

## İlgili belgeler

- [ARCHITECTURE.md](ARCHITECTURE.md) — model yönetimi katmanı
- [API.md](API.md) — `/models` ve `/models/select` sözleşmeleri
- [CONFIGURATION.md](CONFIGURATION.md) — tüm `DIJI_*` değişkenleri
- [SECURITY.md](../SECURITY.md) — model dosyalarının bütünlüğü, ağ erişimi ([English](../SECURITY.en.md))
