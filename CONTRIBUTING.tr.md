# Katkı Rehberi

**Türkçe** · [🇬🇧 English](CONTRIBUTING.md)

Diji'ye katkı için teşekkürler. Bu belge, kod tabanının **gerçek** kurallarını
anlatır — idealize edilmiş bir stil rehberi değil, mevcut kodun uyduğu
sözleşmeler.

---

## İçindekiler

- [Hızlı başlangıç](#hızlı-başlangıç)
- [Proje yapısı](#proje-yapısı)
- [Derleme — proje referansları](#derleme--proje-referansları)
- [Test](#test)
- [Kod kuralları](#kod-kuralları)
- [Değişmezler (bozulmaması gerekenler)](#değişmezler-bozulmaması-gerekenler)
- [Hata ayıklama araçları](#hata-ayıklama-araçları)
- [Commit ve PR](#commit-ve-pr)
- [Dokümantasyon](#dokümantasyon)

---

## Hızlı başlangıç

```bash
# 1. Gereksinimler: Node >= 20, npm 10, arecord/aplay (alsa-utils), ffmpeg
node --version            # v20+
arecord --version
ffmpeg -version | head -1

# 2. Bağımlılıklar (postinstall `shared` paketini derler)
npm install

# 3. Modeller (VAD + Whisper + VITS, ~1,5 GB)
./scripts/download-models.sh all

# 4. Derle
npm run build

# 5. Yerel LLM sunucusunun ayakta olduğunu doğrula
curl -s http://127.0.0.1:8000/v1/models | head -c 200

# 6. Çalıştır
npm start                 # sesli mod
npm run start:text        # mikrofonsuz
```

Masaüstü arayüzü için `ui-app/` dizinine bakın: kendi `package.json`'ı vardır ve
kök workspace'e **dahil değildir**.

---

## Proje yapısı

| Dizin | Sorumluluk | Dil |
|---|---|---|
| `shared/` | Tipler, varsayılan yapılandırma, izin kapısı, logger. **Herkesin bağımlı olduğu temel.** | TS |
| `agent/` | Ses boru hattı: mikrofondan hoparlöre. Kontrol sunucusu, telemetri, model kataloğu. | TS |
| `mcp_servers/` | Altı MCP sunucusu (gmail, calendar, drive, notion, slack, chrome). stdio alt süreçler. | TS |
| `ui-app/` | TanStack Start + Electron masaüstü arayüzü. Bağımsız derleme. | TS/TSX |
| `scripts/` | İndirme, teşhis, E2E doğrulama betikleri. | JS/Py/sh |
| `docs/` | Mimari, API, yapılandırma, modeller. | MD |
| `ui/` | **Arşiv** — eski Next.js arayüzü. Yeni geliştirme `ui-app/` içinde. | TS |

### Katman bağımlılık kuralı

```
shared  ←  agent  ←  (hiçbir şey)
shared  ←  mcp_servers
ui-app  →  HTTP/SSE  →  agent     (kod bağımlılığı YOK, yalnızca sözleşme)
```

> [!IMPORTANT]
> `shared` **hiçbir** çalışma alanına bağımlı olamaz. `agent` `mcp_servers`'a
> kod olarak bağımlı olamaz (yalnızca süreç olarak başlatır). `ui-app` ajan
> kodunu **import etmez** — yalnızca `window.diji` köprüsünü kullanır.

---

## Derleme — proje referansları

Kök [`tsconfig.json`](tsconfig.json) TypeScript **proje referansları**
kullanır. `composite: true` olduğu için sıra önemlidir:

```
shared → agent / mcp_servers/*
```

### Tek komut

```bash
npx tsc -b                    # tüm referansları sırayla derler
npx tsc -b --clean            # build info + çıktıları temizler
```

### Tek paket

```bash
npx tsc -b shared             # agent'tan ÖNCE
npx tsc -b agent
```

### Tip denetimi (çıktı üretmeden)

```bash
npx tsc --noEmit -p agent/tsconfig.json
npx tsc --noEmit -p ui-app/tsconfig.json
```

> [!WARNING]
> `shared` derlenmeden `agent` derlerse `@diji/shared` çözümlenemez ve
> **yüzlerce** sahte hata görürsünüz. `npx tsc -b` her zaman doğru sırayı
> kullanır; tek tek `tsc -p` çalıştırmayın.

### `.tsbuildinfo` uyarısı

Depoda `*.tsbuildinfo` dosyaları **ignore edilir**. Bayatlamış build info
"hiçbir şey değişmemiş" gibi görünüp artımlı derlemeyi atlatabilir:

```bash
npx tsc -b --clean && npx tsc -b    # şüphelendiğinizde
```

---

## Test

### Birim testleri (Jest)

```bash
npm run test:agent            # agent/src/__tests__/*.test.ts
npx jest                      # kök config → aynı proje
npx jest --watch
npx jest -t 'permission'      # tek test
```

Test dosyaları `agent/src/__tests__/` altında, `*.test.ts` deseniyle. Kök
[`jest.config.js`](jest.config.js) `projects` tanımıyla çalışma alanını
bağlar; bu dosya olmadan Jest Babel varsayılanına düşer ve TS sözdiziminde
`Missing semicolon` hatası verir.

Mevcut kapsam:

| Dosya | Neyi doğrular |
|---|---|
| `audio-preprocess.test.ts` | Ön işleme zinciri (DC, high-pass, kırpma, kapı, AGC) |
| `stt-postprocess.test.ts` | Halüsinasyon ayıklama, sözlük, boşluk düzeltme |
| `permission.test.ts` | İzin kapısı sınıfları, token TTL, tek kullanımlık |

### Uçtan uca (gerçek ajan, mock yok)

```bash
npm run build
npm start &                                     # ajanı ayağa kaldır
node scripts/smoke-test.js                      # tam hat
node scripts/smoke-test.js --skip-audio         # ses cihazı olmadan
node scripts/control-e2e.js                     # tüm uç noktalar
node scripts/verify-stt-chain.js                # STT ön/son işleme
node scripts/verify-llm.js                      # LLM bağlantısı
node scripts/inject-e2e.js test.pcm             # PCM enjeksiyonu
```

> [!NOTE]
> Model dosyası gerektiren kontroller Jest'te **değil**, `scripts/` altındadır.
> Jest hızlı ve bağımsız kalmalı; 1,5 GB model yükleyen bir test birim testi
> değildir.

### Arayüz doğrulaması (gerçek Electron + CDP)

```bash
# Electron'u CDP ile başlat
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
    ui-app/electron/main.cjs --remote-debugging-port=9333 &

# Sayfayı sorgula
CDP_PORT=9333 node scripts/cdp-eval.js "document.querySelectorAll('select').length"
```

> [!CAUTION]
> `ELECTRON_RUN_AS_NODE=1` kabuk ortamınızda tanımlıysa Electron pencere açmaz,
> Node gibi davranır. `env -u ELECTRON_RUN_AS_NODE` ile başlatın.

> [!CAUTION]
> Süreç öldürürken `pkill -f "<desen>"` **kullanmayın** — desen kendi kabuğunuzu
> da eşleştirir ve komutu çalıştıran shell'i öldürür. PID ile öldürün:
> ```bash
> kill "$(curl -s http://127.0.0.1:8899/health | jq -r .pid)"
> pkill -x electron    # -x tam ad eşleşmesi, güvenli
> ```

---

## Kod kuralları

### Dil ve yorumlar

- Kod tanımlayıcıları **İngilizce** (`getModelCatalog`, `persistModelChoice`).
- Kullanıcıya görünen metinler **Türkçe** (`"Seçim kalıcı kaydedildi"`).
- Yorumlar **Türkçe** ve **neden** anlatır, **ne** değil. Mevcut kod tabanı
  yoğun yorumludur; bu bilinçlidir — çoğu yorum geçmiş bir hatayı belgeliyor
  ("KUSUR ONARIMI (2026-10-30): … daha önce HİÇ etkili değildi").

```ts
// İYİ — nedeni açıklar, gelecekteki bir geliştirmeyi hatadan korur
/*
 * KUSUR ONARIMI: `DIJI_STT_MODEL_PREFIX` daha önce HİÇ etkili değildi.
 * `stt.ts` önceliği `modelPriority ?? modelPrefix` sırasıyla çözer ve
 * `modelPriority` her zaman tanımlı olduğu için ikinci dal hiç çalışmıyordu.
 */

// KÖTÜ — kodu tekrar eder
// model prefix'i ayarla
```

### Günlükleme — `console.*` yasak

```ts
// İYİ
import { logInfo, logWarn, logError, logDebug } from '@diji/shared';
logInfo('Ajan hazir', { port });
logError('Ajan baslatilamadi', error as Error, { entry });
```

`console.log` yalnızca `scripts/` altındaki yardımcı betiklerde kabul edilir
(kullanıcıya doğrudan çıktı veriyorlar). `agent/`, `shared/`, `mcp_servers/`
içinde **yasaktır**: logger `LOG_LEVEL`'ı uygular ve yapılandırılmış bağlam
taşır.

### Hata yakalama

- Sessiz `catch {}` yalnızca **kasıtlı** yerde: `loadUserEnv()` (dosya yoksa
  sorun değil), `env-prefs` (asla throw etmez), davranışsız temizlik.
- Diğer her yerde: yakala, logla, anlamlı bir sonuç döndür.

```ts
// İYİ — hata yutulmuyor, çağırana taşınıyor
try {
  await p.startListening();
} catch (error) {
  const msg = (error as Error).message;
  telemetry.update('mic', 'error', msg);
  telemetry.log('error', 'mic', msg);
  send(res, 500, { ok: false, error: msg });
}
```

### Tip güvenliği

- `strict: true` — `any` kaçışı yok.
- `unknown` tercih edilir, sonra daraltılır.
- Dış veri (HTTP gövdesi, JSON dosyası) **her zaman** doğrulanır:

```ts
// control-server.ts — gövde doğrulaması
const kind = String(body.kind ?? '').trim() as 'stt' | 'tts' | 'llm';
if (kind !== 'stt' && kind !== 'tts' && kind !== 'llm') {
  send(res, 400, { ok: false, error: 'kind stt|tts|llm olmalı' });
  return;
}
```

### Biçimlendirme

```bash
npx prettier --write <dosya>
npx eslint <dosya>
```

`.prettierrc` ve `.eslintrc.js` depo kökündedir; varsayılanları değiştirmeyin.

---

## Değişmezler (bozulmaması gerekenler)

Bunlar tercih değil, **mimari sözleşmeler**. Değiştirirseniz bir şey sessizce
kırılır.

### 1. Örnekleme oranı 16 kHz mono PCM16

STT, VAD ve `/inject` aynı biçimi bekler. Boru hattında tek bir farklı oran,
segmentasyonu ve transkripsiyonu bozar.

### 2. Mikrofon cihazı `default`

`plughw:...` gibi ham donanım cihazına geçmek aygıtı tek başına ele geçirir ve
diğer tüm uygulamaların mikrofonunu keser. `agent-bridge.ts` bunu açıkça
sabitler.

### 3. Barge-in üçünü birden kapatır

`llm` + `tts` + `playback`. Yalnızca oynatma durdurulursa arayüz `KONUŞUYOR`
durumunda asılı kalır (`isSpeaking` iki aşamadan türetilir).

### 4. `current` = çalışan motorun kimliği, yapılandırma değil

`drifting-tts` başlatılamazsa motor sessizce `sherpa-vits`'e düşer. `config`'e
bakmak yanıltıcıdır; `TTSEngine.getModelName()` kullanılır.

### 5. Kalıcılık `~/.config/diji/env`'e, `config.json`'a değil

`config.json` `process.cwd()`'ye göre çözülür — Electron, terminal ve systemd
farklı `cwd` verir. Env dosyası mutlak yoldur ve `@diji/shared` değerlendirilmeden
**önce** okunur (`env-bootstrap.ts` ilk import olmalı).

### 6. Geçersiz seçim env'e yazılmaz

`/models/select` `409` döndüğünde dosyaya hiçbir şey yazılmamalı. Aksi halde
ajan bir sonraki açılışta kırılır.

### 7. Aynı modeli yeniden seçmek motoru yeniden başlatmaz

Ölçüldü: gereksiz yeniden başlatma 8 sn ölü zaman + mikrofonun boşa kesilmesi.
No-op koruması `selectModel()` içindedir.

### 8. `totalMs` = tur başı → **ilk ses**

Sentezin bitişi değil. `playbackMs` bundan **sonra** gerçekleşir ve toplama
katılmaz. Aşama süreleri birbirine girer; toplamları `totalMs` etmez.

### 9. `turnToken` olmadan ölçüm sıfırlanır

Eşzamanlı turlarda eski bir turun geç biten olayı yeni turun sayaçlarını ezer.

### 10. `App.tsx`/arayüzde `isSpeaking` türetilir

`tts` **veya** `playback` aktifse. Tek bayrağa indirmek barge-in sonrası asılı
kalmaya yol açar.

### 11. `ELECTRON_RUN_AS_NODE` ortamdan temizlenmeli

Bu makinede kabuk ortamında tanımlı; `env -u` ile başlatılmazsa Electron
pencere açmaz.

---

## Hata ayıklama araçları

| Araç | Amaç |
|---|---|
| `curl -s 127.0.0.1:8899/state \| jq` | Tam anlık durum |
| `curl -N 127.0.0.1:8899/events` | Canlı SSE akışı |
| `tail -f /tmp/diji-agent.log` | Ajan stdout/stderr (Electron spawn ederken) |
| `node scripts/cdp-eval.js "<js>"` | Arayüzü CDP ile sorgula |
| `scripts/inject-e2e.js` | PCM'i mikrofon gibi besle (mikrofon olmadan test) |
| `arecord -l` | Mikrofon cihaz listesi |
| `LOG_LEVEL=debug npm start` | Ayrıntılı günlük |

### Sık yapılan hatalar

| Hata | Sonuç | Doğrusu |
|---|---|---|
| `pkill -f "agent/dist/index.js"` | **Kendi kabuğunuzu öldürür** | PID ile `kill` |
| `tsc -p agent` (shared derlenmeden) | Yüzlerce sahte hata | `npx tsc -b` |
| `console.log` eklemek | `LOG_LEVEL` yok sayılır | `logInfo` vb. |
| `diji.d.ts` güncellemeden arayüz alanı eklemek | `tsc --noEmit` hatası | Tipi önce ekle |
| Mock kullanmak | Ses hattı gerçek donanım/örnekleme gerektirir | Gerçek motor + enjeksiyon |

---

## Commit ve PR

### Commit mesajı

```
<kapsam>: <kısa emir kipi özet>

<gerekirse gövde: NEDEN, ne değişti değil>
```

Kapsam örnekleri: `agent`, `shared`, `ui-app`, `mcp`, `docs`, `scripts`,
`config`. Örnekler:

```
agent: STT ön ek önceliğini düzelt (DIJI_STT_MODEL_PREFIX etkisizdi)
ui-app: Ayarlar'a model seçimi ekle
docs: API sözleşmelerini belgele
config: TTS_VITS_MODEL anahtarını ayır
```

### PR kontrol listesi

- [ ] `npx tsc -b` temiz
- [ ] `npm run test:agent` yeşil
- [ ] `node scripts/smoke-test.js --skip-audio` yeşil (dokunulan alan ses ise tam smoke)
- [ ] Yeni davranış gerçek ajanla doğrulandı (mock değil)
- [ ] Yeni ortam değişkeni → `docs/CONFIGURATION.md` + `default.ts`'te
      `process.env` ile okunuyor
- [ ] Yeni uç nokta/alan → `docs/API.md` + `ui-app/src/types/diji.d.ts`
- [ ] `console.log` eklenmedi
- [ ] Gizli bilgi (token, anahtar, kişisel yol) commit edilmedi
- [ ] Değişmezlerden biri bozulmadı (yukarıdaki 11 madde)

### Kapsam

Küçük ve odaklı PR'lar tercih edilir. Bir kusuru düzeltirken **ilgisiz**
biçimlendirme değişikliği yapmayın — diff okunamaz hale gelir.

---

## Dokümantasyon

Kod değişikliği dokümantasyon gerektiriyorsa aynı PR'da güncelleyin:

| Değişiklik | Güncellenecek |
|---|---|
| Yeni/biten uç nokta | [`docs/API.tr.md`](docs/API.tr.md) + [`docs/API.md`](docs/API.md) |
| Yeni ortam değişkeni | [`docs/CONFIGURATION.tr.md`](docs/CONFIGURATION.tr.md) + [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) |
| Model/arka uç değişikliği | [`docs/MODELS.tr.md`](docs/MODELS.tr.md) + [`docs/MODELS.md`](docs/MODELS.md) |
| Katman/sorumluluk değişikliği | [`docs/ARCHITECTURE.tr.md`](docs/ARCHITECTURE.tr.md) + [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Güvenlikle ilgili | [`SECURITY.tr.md`](SECURITY.tr.md) + [`SECURITY.md`](SECURITY.md) |
| Yeni komut/betik | [`README.tr.md`](README.tr.md) + [`scripts/README.md`](scripts/README.md) |

Bağlantılar **göreli** olmalı (`docs/API.md`, `../agent/src/pipeline.ts`) —
mutlak `file://` veya kişisel yol (`/home/<kullanıcı>/…`) yazmayın.

---

## Lisans

Katkılarınız [MIT](LICENSE) lisansı altında kabul edilir.
