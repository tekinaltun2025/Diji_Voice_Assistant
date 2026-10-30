# Güvenlik Politikası

Diji bir **sesli asistan**dır: mikrofonu açar, konuşmayı yerel olarak yazıya
çevirir, yerel bir dil modeline gönderir ve yanıtı seslendirir. Ayrıca MCP
araçlarıyla Gmail, Takvim, Drive, Notion, Slack ve tarayıcıya erişebilir.

Bu belge, sistemin **gerçekten** neyi koruduğunu ve neyi korumadığını anlatır.
Abartılı güvenlik iddiaları yerine tehdit modelini açıkça yazmak amaçlanmıştır.

---

## İçindekiler

- [Tehdit modeli](#tehdit-modeli)
- [Tasarım gereği güvenli olan şeyler](#tasarım-gereği-güvenli-olan-şeyler)
- [İzin kapısı](#i̇zin-kapısı)
- [Kontrol sunucusu](#kontrol-sunucusu)
- [Electron izolasyonu](#electron-i̇zolasyonu)
- [Sır yönetimi](#sır-yönetimi)
- [Ses gizliliği](#ses-gizliliği)
- [Bilinen sınırlar](#bilinen-sınırlar)
- [Sertleştirme kontrol listesi](#sertleştirme-kontrol-listesi)
- [Güvenlik açığı bildirimi](#güvenlik-açığı-bildirimi)

---

## Tehdit modeli

### Korunanlar

| Varlık | Neden önemli |
|---|---|
| Mikrofon akışı | Ham ses; konuşma içeriği ve ortam bilgisi taşır |
| Transkript ve yanıtlar | Kişisel/ticari içerik |
| OAuth2 token'ları | Gmail/Takvim/Drive/Notion/Slack hesaplarına erişim |
| LLM API anahtarı | Yerel olsa da yapılandırma dosyasında durur |
| MCP araç yetkileri | E-posta gönderme, etkinlik oluşturma, dosya okuma |

### Varsayılan olarak güvenilen

| Varsayım | Sonuç |
|---|---|
| İşletim sistemi ve kullanıcı hesabı | Aynı kullanıcı hesabında çalışan her süreç bu verilere erişebilir. Diji bunu engellemez. |
| `127.0.0.1` | Yerel makinedeki diğer süreçler güvenilir kabul edilir. |
| Yerel LLM sunucusu | `127.0.0.1:8000` üzerindeki sunucu güvenilirdir. |
| Model dosyaları | `~/.diji/models` içeriği değiştirilmemiştir. |

### Kapsam dışı (Diji'nin savunmadığı)

- Aynı kullanıcı hesabında çalışan kötü niyetli bir sürecin belleği okuması
- Fiziksel erişim (mikrofonu doğrudan dinleme)
- İşletim sistemi çekirdeği veya ses alt sistemi ele geçirilmesi
- Ağ üzerinden gelen saldırılar (kontrol sunucusu yereldir; açık değildir)
- Yerel LLM sunucusunun kendi güvenliği

---

## Tasarım gereği güvenli olan şeyler

### 1. Bulut yok

Ses, transkript ve yanıt **hiçbir üçüncü taraf servise** gitmez:

- STT: `sherpa-onnx` yerel (Whisper ağırlıkları diskte)
- VAD: `silero_vad.onnx` yerel
- TTS: yerel VITS veya yerel Python köprüsü
- LLM: `127.0.0.1` üzerindeki OpenAI uyumlu sunucu

Tek dış bağlantı **model indirme**dir (`github.com/k2-fsa/sherpa-onnx`), o da
yalnızca `scripts/download-models.sh` elle çalıştırıldığında olur.

### 2. Kontrol sunucusu yalnızca yerel

```ts
// agent/src/control-server.ts:30
export const CONTROL_HOST = '127.0.0.1';
```

Sabittir; ortam değişkeniyle `0.0.0.0`'a **açılamaz**. Portu değiştirmek
mümkündür (`DIJI_CONTROL_PORT`), ana makineyi değiştirmek mümkün değildir.

### 3. Token'lar şifreli saklanır

MCP sunucuları OAuth2 token'larını `ENCRYPTION_PASSWORD` ile şifreleyerek
`TOKEN_STORAGE_PATH` (varsayılan `./tokens`) altına yazar; dizin `.gitignore`
ile dışlanmıştır.

### 4. Silme varsayılan olarak kapalı

```ts
// shared/src/config/default.ts:118
permissionGate: { read: true, write: true, delete: false }
```

`delete` yalnızca `DIJI_ALLOW_DELETE=true` ile açılır ve açıldığında bile her
çağrıda ses onayı istenir.

### 5. Env dosyası 0600

`~/.config/diji/env` `0600` kipinde yazılır, dizin `0700`'dür. Yazma atomiktir
(`temp` + `rename`), yarım dosya oluşmaz
([`env-prefs.ts`](agent/src/env-prefs.ts)).

---

## İzin kapısı

Her MCP çağrısı [`PermissionGate.evaluate()`](shared/src/permission-gate.ts)
üzerinden geçer. Üç izin sınıfı vardır:

| Sınıf | Davranış |
|---|---|
| `read` | Hemen yürütülür (arama, listeleme, okuma) |
| `write` | **Ses onayı** gerekir. Onay yoksa çağrı yapılmaz. |
| `delete` | Varsayılan olarak **engellenir**. `DIJI_ALLOW_DELETE=true` ise ses onayıyla yürütülür. Takvim silme özel durumdur: her zaman sıkı onay. |

### Onay akışı

```
1. LLM bir araç çağırmak ister
2. MCPClient.callTool() → PermissionGate.evaluate()
3. write/delete ise: randomBytes(32) token üretilir, 5 dk TTL
4. Telemetriye `pendingConfirmation` yazılır → SSE `confirmation` olayı
5. Asistan soruyu SESLENDİRİR ("Şu e-postayı göndermemi onaylıyor musunuz?")
6. Kullanıcı arayüzden veya sesle yanıtlar → POST /confirm { confirmed }
7. Token doğrulanır (tek kullanımlık), süresi dolmuşsa reddedilir
8. Onaylandıysa araç çağrılır; reddedildiyse LLM'e "kullanıcı reddetti" döner
```

### Yarış durumu — düzeltildi

Onay kaydı TTS'ten **önce** yayınlanıyor (`expiresAt: null`) ama bekleyen
promise seslendirme bittikten **sonra** kuruluyordu. Kullanıcı diyaloğu erken
görüp hemen onaylarsa istek `applied:false` ile sessizce kayboluyordu —
yani **kullanıcı onayladığını sanırken işlem yapılmıyordu**.

Çözüm: `/confirm` en fazla 5 sn boyunca 100 ms aralıklarla yeniden dener
([`control-server.ts:366`](agent/src/control-server.ts)).

### Token özellikleri

| Özellik | Değer |
|---|---|
| Üretim | `randomBytes(32).toString('hex')` → 256 bit |
| TTL | 5 dakika (`TOKEN_TTL_MS`) |
| Kullanım | Tek kullanımlık — `confirm()` sildikten sonra döner |
| Doğrulama | Sabit zamanlı değil (bkz. [bilinen sınırlar](#bilinen-sınırlar)) |

### Onay kapısının sınırı — önemli

> [!WARNING]
> Onay kapısı, **LLM'i** kötü niyetli eylemlerden korur, **kullanıcıyı** LLM'in
> yanlış anlamasından korumaz. LLM, kullanıcının niyetini yanlış yorumlayıp
> gereksiz bir `write` çağrısı başlatabilir. Onay diyaloğunu **okuyun**;
> "Onayla"ya refleksle basmayın.

---

## Kontrol sunucusu

| Özellik | Durum | Not |
|---|---|---|
| Ana makine | `127.0.0.1` sabit | Ağdan erişilemez |
| Kimlik doğrulama | **Yok** | Yerel süreçler güvenilir kabul edilir |
| CORS | `*` | Yerel olduğu için zararsız; yine de herhangi bir yerel web sayfası teoride istek atabilir |
| Gövde sınırı | 1 MB | `readBody` fazlasını keser |
| `/inject` | Ses enjeksiyonu | 1 MB sınırı ~32 sn ses demektir |

### Neden kimlik doğrulama yok

Kontrol sunucusu **yerel bir IPC kanalı** gibi çalışır. Kimlik doğrulama eklemek
her istekte bir sır paylaşımı gerektirir ve bu sır yine yerel dosyada durur —
kazanç sağlamaz. Bunun yerine yüzey daraltıldı:

- Ana makine `127.0.0.1`'e sabit
- Yalnızca gerekli 11 uç nokta
- Erişim yalnızca Electron köprüsü ve `scripts/*.js` üzerinden

> [!CAUTION]
> `CONTROL_HOST` sabitini değiştirmeyin. Ağa açılan bir kontrol sunucusu,
> kimlik doğrulama olmadığı için **herkesin mikrofonunuzu açıp MCP
> araçlarınızı çalıştırabildiği** bir arayüz olur.

---

## Electron izolasyonu

```ts
// ui/electron/main.ts:165
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  preload: path.join(__dirname, 'preload.js'),
}
```

| Ayar | Değer | Sonuç |
|---|---|---|
| `nodeIntegration` | `false` | Renderer `require`/`process` göremez |
| `contextIsolation` | `true` | Preload ve sayfa bağlamı ayrı |
| `preload` | Dar `window.diji` yüzeyi | Yalnızca 10 metod, ham IPC değil |

Renderer'a açılan yüzey [`ui-app/src/types/diji.d.ts`](ui-app/src/types/diji.d.ts)
içinde tanımlıdır: `getState`, `listen`, `ask`, `setTts`, `confirm`, `bargeIn`,
`getModels`, `selectModel`, `onTelemetry`, `onConnection`. Ham `ipcRenderer`
veya dosya sistemi erişimi **verilmez**.

### Sandbox

Varsayılan: sandbox **açık**. Yalnızca `DIJI_ELECTRON_SANDBOX=0` ile kapatılır.

> [!WARNING]
> `DIJI_ELECTRON_SANDBOX=0` yalnızca yerel kullanıcı ad alanı kısıtı nedeniyle
> Chromium hiç açılamadığında kullanılmalıdır. Kapalıyken renderer daha geniş
> yetkiye sahiptir.

---

## Sır yönetimi

### Depoya giren ve girmeyen

`.gitignore` şunları **dışlar**:

```gitignore
*.env
!.env.example
credentials*.json
*client_secret*.json
token*.json
*.pem
*.key
oauth-tokens/
tokens/
```

Yayın öncesi tarama yapıldı: `sk-`, `ghp_`, `xox*`, `AIza`, `ntn_`, özel anahtar
blokları arandı → **kaynak kodda sıfır eşleşme**. Depoda `.env`, `.pem`,
`credentials*.json`, `token*.json` dosyası **yok**.

### Ortam değişkeni ile sır verme

```bash
# Doğru: süreç ortamı (kabuk geçmişine dikkat)
ENCRYPTION_PASSWORD='…' node agent/dist/index.js

# Yanlış: env dosyasına düz metin yazmak (0600 olsa da diskte durur)
```

`~/.config/diji/env` **sırlar için tasarlanmadı** — model seçimi gibi kalıcı
ayarlar içindir. OAuth client secret'ları ve `ENCRYPTION_PASSWORD` için
systemd `EnvironmentFile=` (0600) veya bir sır yöneticisi kullanın.

### Varsayılan parola uyarısı

`ENCRYPTION_PASSWORD` varsayılanı `diji-default-key`'dir. Bu yalnızca
geliştirme kolaylığı içindir.

> [!CAUTION]
> Gerçek OAuth token'ı saklıyorsanız `ENCRYPTION_PASSWORD`'ü **mutlaka**
> değiştirin. Varsayılan parolayla şifrelenmiş token, dosyayı ele geçiren
> herkes tarafından çözülebilir.

### LLM API anahtarı

`DIJI_LLM_API_KEY` varsayılanı `sk-local`'dir ve yerel sunucu genelde
doğrulama yapmaz. Gerçek bir anahtar kullanıyorsanız env dosyasına değil süreç
ortamına verin.

---

## Ses gizliliği

| Konu | Durum |
|---|---|
| Ham ses diske yazılır mı? | **Hayır.** Yalnızca bellekte işlenir. |
| Transkript diske yazılır mı? | **Hayır.** Yalnızca bellekte (`CONVERSATION_LIMIT` = 50 mesaj). |
| Loglar ses içerir mi? | **Hayır.** Yalnızca süreler, seviyeler ve transkript uzunluğu. |
| `/inject` gövdesi saklanır mı? | **Hayır.** İşlenir, atılır. |
| Arayüz geçmişi | Tarayıcı `localStorage`'ında; sohbet metni orada durur |

> [!NOTE]
> Arayüz sohbet geçmişini `localStorage`'da tutar. Paylaşılan bir makinede
> çalışıyorsanız bu dizini temizleyin.

### Mikrofon sahipliği

Ajan mikrofonu `arecord` ile `default` (PipeWire) üzerinden okur. Ham donanım
cihazına (`plughw:...`) geçmek aygıtı **tek başına ele geçirir** ve diğer tüm
uygulamaların mikrofonunu keser. Bu yüzden Electron köprüsü cihazı açıkça
`default`'a sabitler:

```ts
// ui/electron/agent-bridge.ts:204
DIJI_AUDIO_INPUT_DEVICE: process.env.DIJI_AUDIO_INPUT_DEVICE || 'default',
```

---

## Bilinen sınırlar

Bu liste **dürüstlük** içindir; bilinen zayıflıklar gizlenmez.

| Sınır | Etki | Azaltma |
|---|---|---|
| Kontrol sunucusunda kimlik doğrulama yok | Aynı makinedeki herhangi bir süreç ajanı yönetebilir | Yerel ana makineye sabit; yüzey dar |
| Onay token'ı sabit zamanlı karşılaştırılmıyor | Teorik zamanlama saldırısı | Token 256 bit rastgele ve 5 dk TTL; pratikte sömürülemez |
| CORS `*` | Yerel bir web sayfası `fetch` atabilir | Tarayıcılar `127.0.0.1`'e mixed-content kısıtı uygular; yine de tam garanti değil |
| `/inject` ses enjeksiyonuna açık | Yerel bir süreç sahte konuşma enjekte edebilir | Teşhis uç noktası; üretimde gerekmiyorsa güvenlik duvarı kuralı ekleyin |
| Env dosyası düz metin | Model seçimi ve yol bilgisi okunabilir | `0600`; sır koymayın |
| OAuth token şifrelemesi tek parolaya bağlı | Parola zayıfsa token çözülebilir | Güçlü `ENCRYPTION_PASSWORD` |
| LLM çıktısı denetlenmez | Model yanlış/zararlı içerik üretebilir | `write`/`delete` onay kapısı; çıktıyı okuyun |
| Ses dosyası bütünlüğü doğrulanmaz | Değiştirilmiş model yüklenebilir | Model dizinini `0700` tutun, indirmeleri resmî kaynaktan yapın |
| `ELECTRON_RUN_AS_NODE` | Kabukta tanımlıysa Electron Node gibi davranır | `env -u ELECTRON_RUN_AS_NODE` ile başlatın |

---

## Sertleştirme kontrol listesi

Üretimde/çok kullanıcılı makinede çalıştırmadan önce:

- [ ] `ENCRYPTION_PASSWORD`'ü varsayılandan değiştir (`diji-default-key` değil)
- [ ] OAuth client secret'larını env dosyasına değil süreç ortamına ver
- [ ] `~/.config/diji` → `0700`, `~/.config/diji/env` → `0600` olduğunu doğrula
- [ ] `~/.diji/models` dizinini yalnızca sahibine okut (`chmod 700`)
- [ ] `DIJI_ALLOW_DELETE` kapalı bırak (varsayılan)
- [ ] Model dosyalarını yalnızca `github.com/k2-fsa/sherpa-onnx` üzerinden indir
- [ ] Aynı makinede güvenilmeyen kullanıcı/süreç yoksa kontrol sunucusu riski kabul et
- [ ] Arayüz `localStorage` geçmişini paylaşılan makinede temizle
- [ ] `scripts/*.js` yardımcılarını üretimde çalıştırma (`/inject`, `cdp-eval`)

Doğrulama komutları:

```bash
stat -c '%a %n' ~/.config/diji ~/.config/diji/env ~/.diji/models
ss -ltnp 2>/dev/null | grep 8899          # 127.0.0.1:8899 olmalı, 0.0.0.0 değil
grep -rn 'ENCRYPTION_PASSWORD' ~/.config/diji/env 2>/dev/null  # boş olmalı
```

---

## Güvenlik açığı bildirimi

Bu proje kişisel/kurumsal bir yerel asistan uygulamasıdır ve bir güvenlik
ekibi yoktur. Yine de bir açık bulduysanız:

**Yapın:**

1. Depoda **özel** bir güvenlik raporu açın (GitHub → Security → Report a
   vulnerability), veya
2. Doğrudan proje sahibine ulaşın.

Rapora şunları ekleyin: etkilenen sürüm/commit, yeniden üretme adımları,
beklenen ve gerçekleşen davranış, olası etki.

**Yapmayın:**

- Açığı herkese açık bir issue olarak paylaşmayın.
- Gerçek kişisel veri (konuşma kaydı, token, e-posta) eklemeyin.

Yanıt süresi garanti edilmez; ancak geçerli raporlar öncelikli ele alınır.

---

## İlgili belgeler

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — mimari, izin akışı
- [docs/API.md](docs/API.md) — kontrol sunucusu uç noktaları
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — sır içeren değişkenler
- [docs/MODELS.md](docs/MODELS.md) — üçüncü taraf model lisansları
- [CONTRIBUTING.md](CONTRIBUTING.md) — katkı süreci
