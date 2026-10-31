import { logDebug, logError, logInfo, logWarn } from '@diji/shared';
import { ChildProcess, execFileSync, spawn } from 'child_process';

/**
 * Ses G/Ç katmanı — mikrofon ve hoparlör köprüsü.
 *
 * Neden `arecord` / `aplay`: Linux'ta en yaygın bulunan, ek npm bağımlılığı
 * gerektirmeyen ALSA araçlarıdır. PipeWire/PulseAudio kurulu sistemlerde de
 * ALSA uyumluluk katmanı üzerinden çalışırlar.
 *
 * Format sözleşmesi (tüm pipeline bu formatı bekler):
 *   PCM 16-bit little-endian, tek kanal (mono), 16.000 Hz
 * Bu, Whisper (STT), Silero (VAD) ve VITS (TTS) için gereken ortak formattır.
 */

/** Pipeline'ın beklediği örnekleme hızı. */
export const AUDIO_SAMPLE_RATE = 16000;

/** PCM 16-bit mono -> saniyede 32.000 bayt. */
export const BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * 2;

export interface MicrophoneOptions {
  /** ALSA cihaz adı (`arecord -l` ile listelenir). Varsayılan `default`. */
  device?: string;
  /** Geri çağrılacak PCM parçası boyutu (bayt). 16 kHz mono için 3200 = 100 ms. */
  chunkSize?: number;
  /** `arecord` çalıştırılabilir dosyası. */
  binary?: string;
  /**
   * Sessizlik eşiği (RMS, 0–1). Bu eşiğin altındaki parçalar pipeline'a
   * GÖNDERİLMEZ. Amaç: sürekli sessizlikte Whisper'ı boşuna çalıştırmamak
   * (CPU tasarrufu + yanlış transkripsiyonları önlemek).
   */
  silenceThreshold?: number;
}

export interface SpeakerOptions {
  /** ALSA cihaz adı. Varsayılan `default`. */
  device?: string;
  /** `aplay` çalıştırılabilir dosyası. */
  binary?: string;
  /**
   * Hoparlöre yazılan her PCM'i referans olarak bildirmek için geri çağrı.
   *
   * NEDEN: Yazılımsal yankı kapılaması (bkz. `echo-guard.ts`) "bu ses benim
   * mi" sorusunu ancak hoparlöre GERÇEKTEN yazdığımız sinyali bilerek
   * cevaplayabilir. Sabit genlik eşiği yanlış cevap verir. Bildirim tam
   * olarak PCM'in `aplay`'e verildiği anda yapılır — böylece zaman damgası
   * akustik gecikme penceresinin doğru ucuna düşer.
   */
  onReference?: (atMs: number, pcm: Buffer, sampleRate: number) => void;
  /**
   * Varsayılan örnekleme frekansı (Hz). `play()` çağrısında açık bir
   * frekans verilmezse bu değer kullanılır.
   *
   * Neden gerekli: TTS motorları farklı frekanslarda PCM üretir
   * (VITS/Piper 22.05 kHz, EMA Lightning 16/48 kHz). Frekansı sabit
   * varsaymak sesin hızlı ya da tiz çalınmasına yol açar.
   */
  sampleRate?: number;
}

/**
 * AEC (yankı engelleme) düğümünün adını çözer.
 *
 * NEDEN GEREKLİ: Gerçek full-duplex çalışmada mikrofon, hoparlör çıkışı
 * açıkken de dinlemeye devam eder. Yankı yazılım seviyesinde silinmezse
 * VAD asistanın kendi sesini "kullanıcı konuşuyor" sanar ve sistem kendini
 * sonsuz keser.
 *
 * NASIL: PipeWire echo-cancel modülü yüklendiğinde bir `Audio/Source` ve bir
 * `Audio/Sink` düğümü oluşturur. Düğüm adı sürüme/dile göre değişebildiği
 * için SABİT ad yazılmaz; `pw-cli list-objects Node` çıktısı taranır.
 *
 * BULUNAMAZSA `null` döner ve çağıran taraf mevcut donanım cihazına döner —
 * AEC yokluğu bir hata değildir (bkz. setup-aec.sh: bu sistemde WirePlumber
 * ALSA cihazlarını düğüm olarak yayınlamadığı için AEC düğümü oluşmuyor).
 */
/**
 * Yankı engellemenin FİİLEN kullanımda olup olmadığını bildirir.
 *
 * NEDEN GEREKLİ: Otomatik VAD barge-in, yankı silinmiyorken asistanın kendi
 * sesini "kullanıcı konuşuyor" sanıp her cümlede kendini kesmesine yol açar.
 * Bu yüzden barge-in varsayılan olarak yalnızca AEC gerçekten kullanılıyorsa
 * açılır. Değer `discoverDevices()` sırasında, gerçek seçim yapıldığında
 * belirlenir — tahmin değil, ölçüm.
 */
let aecInUse = false;

/**
 * `setup-aec.sh` tarafından ZORLANMIŞ (sessiz) düğümlerin işareti.
 *
 * NEDEN GEREKLİ: `support.null-audio-sink` tabanlı düğümler list-objects
 * çıktısında gerçek `module-echo-cancel` düğümlerinden ayırt EDİLEMİYOR —
 * adları da (`echo-cancel-*`) birebir aynı. Bu işaret, üreten tarafın
 * bıraktığı tek güvenilir izdir ve bu dosya ile `setup-aec.sh` arasındaki
 * sözleşmedir. İKİ YERDE BİRLİKTE DEĞİŞTİRİLMELİDİR.
 */
const SILENT_MARKER = 'diji-silent-forced';

/** AEC kaynağı giriş cihazı olarak seçildi mi? */
export function isAecInUse(): boolean {
  return aecInUse;
}

function detectAecNode(mediaClass: 'Audio/Source' | 'Audio/Sink'): string | null {
  // Kullanıcı AEC'i kapatmak istediyse hiç arama yapma.
  if (process.env.DIJI_AUDIO_USE_AEC === '0') return null;

  try {
    const dump = execFileSync('pw-cli', ['list-objects', 'Node'], {
      encoding: 'utf8',
      timeout: 2000,
    });

    /*
     * NESNE SINIRI — ÖLÇÜLDÜ, TAHMİN DEĞİL.
     *
     * `pw-cli list-objects Node` kayıtları `id 30, type ...` biçiminde
     * yazar (İKİ NOKTA YOK). Eski desen `id:\s*\d+` idi: hiçbir zaman
     * eşleşmediği için çıktı TEK blok kalıyordu ve fonksiyon her çağrıda
     * `null` dönüyordu. Yani AEC araması bu sistemde hiç çalışmamış.
     * Ölçüm: eski desen 1 blok, yeni desen 14 blok.
     */
    const blocks = dump.split(/\n(?=\s*id\s+\d+[,:])/);
    for (const block of blocks) {
      /*
       * TAM `media.class` EŞLEŞMESİ — `includes` YETMEZ.
       *
       * `Audio/Source` araması, `Audio/Source/Virtual` yazan bloğu da
       * yakalar. `setup-aec.sh` zorlanmış düğümleri tam olarak
       * `Audio/Source/Virtual` olarak oluşturuyor — yani `includes`
       * kullanılsaydı sessiz düğüm "AEC kaynağı" sanılırdı.
       */
      const classMatch = block.match(/media\.class\s*=\s*"([^"]+)"/);
      if (!classMatch || classMatch[1] !== mediaClass) continue;

      const nameMatch = block.match(/node\.name\s*=\s*"([^"]+)"/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      // echo-cancel düğümleri adında "echo" veya setup-aec.sh'de yazdığımız
      // "diji-aec" önekini taşır.
      if (!/echo|diji-aec/i.test(name)) continue;

      /*
       * SESSİZ DÜĞÜMLERİ ELE — BU BİR GÜVENLİK KONTROLÜDÜR.
       *
       * `setup-aec.sh` hedef düğümleri `support.null-audio-sink` tabanlı
       * `adapter` factory'sinden zorluyor. Bu düğümler `list-objects`
       * çıktısında GÖRÜNÜR ve adları `echo-cancel-*` ile eşleşir — ama
       * SES ÜRETMEZLER. Ölçüldü (bu makine):
       *   `arecord -D pipewire`                     → maksimum genlik 0
       *   `pw-record --target echo-cancel-source`   → maksimum genlik 0
       *
       * Bunları AEC sanmak iki felakete yol açar:
       *   - giriş: ajan SAĞIR olur (sessiz kaynaktan okur)
       *   - çıkış: hoparlör SESSİZLEŞİR (ses sessiz havuza gider)
       *
       * NASIL AYIRT EDİLİR — TAHMİN DEĞİL, İŞARET:
       * `factory.name` list-objects çıktısında YOK (yalnızca `factory.id`
       * var) ve `factory.id`, `adapter` factory'sinde hem zorlanmış null
       * düğümler hem de gerçek adapter düğümleri için aynı çıkıyor — yani
       * factory üzerinden ayırt edilemiyor. `media.class` sonundaki
       * `/Virtual` de yalnızca Source tarafında var; Sink tarafında yok
       * (ölçüldü: `echo-cancel-sink` sade `Audio/Sink` olarak görünüyor).
       *
       * Bu yüzden ÜRETEN TARAF İŞARETLER: `setup-aec.sh` zorladığı
       * düğümlerin `node.description` alanına [`SILENT_MARKER`] yazar.
       * Tüketen taraf bu işareti görürse adayı REDDEDER. İşaret yoksa
       * düğüm gerçek `module-echo-cancel` çıktısıdır ve kullanılabilir.
       */
      if (block.includes(SILENT_MARKER)) continue;

      return name;
    }
  } catch (error) {
    // `pw-cli` yoksa veya PipeWire kapalıysa sessizce devam et: AEC isteğe
    // bağlı bir iyileştirmedir, zorunluluk değildir.
    logDebug('AEC düğümü aranamadı', { error: (error as Error).message });
  }
  return null;
}

/**
 * Mikrofon akışı.
 *
 * `arecord` alt süreci başlatır ve stdout'tan gelen PCM parçalarını
 * `onAudio` geri çağrısına verir. Süreç ölürse yeniden başlatmayı dener;
 * böylece USB mikrofon çıkarılıp takıldığında ajan ayakta kalır.
 */
export class MicrophoneInput {
  private process: ChildProcess | null = null;
  /** Aktif ALSA cihazi. Otomatik algilamada degisir. */
  private device: string;
  private readonly chunkSize: number;
  private readonly binary: string;
  private readonly silenceThreshold: number;

  /**
   * Denenecek cihaz listesi. Kullanici `DIJI_AUDIO_INPUT_DEVICE` verdiyse
   * yalnizca o kullanilir. Aksi halde `default` ile baslanir ve canli ses
   * gelmezse donanim cihazlari sirayla denenir.
   */
  private deviceCandidates: string[] = [];
  private candidateIndex: number = 0;
  /** Otomatik cihaz degistirme denemesi yapildi mi. */
  private autoSwitched: boolean = false;
  /**
   * Cihaz degisimi nedeniyle bilerek kapatildi mi? `close` olayi bunu
   * "akis kapandi" sanip ikinci bir arecord baslatmamali — aksi halde ayni
   * aygitta iki kayit akisi olusur (cift ses, bozuk VAD).
   */
  private switchingDevice: boolean = false;
  /** Cihaz canlilik kontrolu icin zamanlayici. */
  private probeTimer: NodeJS.Timeout | null = null;
  /**
   * Yoklama penceresinde gorulen EN YUKSEK DC-cikarilmis RMS.
   * YALNIZCA TESHIS amaclidir — canlilik karari buna dayanmaz.
   *
   * Neden karar kriteri degil: olculdu (2026-10-27) bozuk `default` cihazi
   * 0,0014-0,0038 AC RMS uretirken, SAGLIKLI DMIC sessiz bir odada
   * 0,00085-0,00149 uretiyor. Dagilimlar ORTUSUYOR; AC RMS tek basina
   * "bozuk cihaz" ile "sessiz oda"yi ayirt edemez. Guvenilir ayrim
   * `discoverDevices()` sirasidir (gercek DMIC once, `default` en son).
   */
  private probeMaxAcRms: number = 0;
  /**
   * ANLIK seviye: son ~1 saniyelik parcalardaki en yuksek DC-cikarilmis RMS.
   * Panelde "sesim aliniyor mu" sorusuna cevap verir. Kumulatif sayaclar
   * (`forwardedChunks`) bu soruyu yanitlayamaz.
   */
  private recentMaxAcRms: number = 0;
  /** `recentMaxAcRms` penceresinin baslangici (ms). */
  private recentWindowStart: number = 0;
  /** Anlik seviye penceresi: 2 sn. Panelde makul tepki suresi. */
  private static readonly RECENT_WINDOW_MS = 2000;
  /**
   * Yoklama penceresi. 1,5 sn cok kisa: cihaz acilirken ilk saniyede
   * DC oturma suciramasi olabiliyor. 2,5 sn daha guvenilir karar verir.
   */
  private static readonly PROBE_DELAY_MS = 2500;

  private onAudio: ((chunk: Buffer) => void) | null = null;
  private running: boolean = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts: number = 0;
  private static readonly MAX_RESTARTS = 5;

  /** Teşhis sayaçları. */
  private totalBytes: number = 0;
  private forwardedChunks: number = 0;
  private skippedChunks: number = 0;

  constructor(options: MicrophoneOptions = {}) {
    this.device = options.device || process.env.DIJI_AUDIO_INPUT_DEVICE || 'default';
    this.chunkSize = options.chunkSize ?? 3200; // 100 ms
    this.binary = options.binary || process.env.DIJI_ARECORD_BIN || 'arecord';
    // Olculdu (2026-10-27, bu makine, canli DMIC plughw:...DEV=4, sessiz oda):
    // DC-cikarilmis parca RMS dagilimi p10=0,00085 / p50=0,00107 / p90=0,00149;
    // konusma parcalari 0,05-0,22 araliginda. Esik gurultu tabaninin hemen
    // uzerine (p90 x ~1,35) konuldu: gurultuyu VAD'e sokmaz, konusmanin zayif
    // baslangic/bitis hecelerini de kesmez. Eski 0,0015 degeri gurultu
    // tabanina cok yakindi; bozuk `default` cihazinin DC/kirpma artiklarini
    // gecirip Whisper halusinasyonuna ("(Muzik)", "(Kalabalik)") yol aciyordu.
    this.silenceThreshold =
      options.silenceThreshold ?? Number(process.env.DIJI_AUDIO_SILENCE_THRESHOLD || 0.002);

    // Kullanici acikca cihaz verdiyse otomatik algilama yapilmaz.
    const explicitDevice = options.device || process.env.DIJI_AUDIO_INPUT_DEVICE;
    this.deviceCandidates = explicitDevice ? [explicitDevice] : MicrophoneInput.discoverDevices();
  }

  /**
   * AEC (yankı engelleme) kaynağının adını çözer.
   *
   * NEDEN GEREKLİ: Gerçek full-duplex çalışmada mikrofon, hoparlör çıkışı
   * açıkken de dinlemeye devam eder. Yankı yazılım seviyesinde silinmezse
   * VAD asistanın kendi sesini "kullanıcı konuşuyor" sanar.
   *
   * NASIL: PipeWire echo-cancel modülü yüklendiğinde bir `Audio/Source`
   * düğümü oluşturur. Düğüm adı sürüme/dile göre değiştiği için SABİT ad
   * yazılmaz; `pw-dump` çıktısı taranır.
   *
   * BULUNAMAZSA `null` döner ve çağıran taraf donanım cihazına döner —
   * AEC yokluğu bir hata değildir (bkz. setup-aec.sh, bu sistemde AEC
   * düğümü oluşmuyor çünkü WirePlumber ALSA cihazlarını düğüm olarak
   * yayınlamıyor).
   */
  /**
   * Kayit yapilabilecek ALSA cihazlarini oncelik sirasina gore listeler.
   *
   * Neden gerekli: bircok sistemde `default` (PipeWire/PulseAudio) kayit
   * kaynagi tanimli degildir; cihaz acilir ve **tamamen sifir** ornek
   * uretir. Bu durumda hata olusmadigi icin eski kod sonsuza kadar sessiz
   * kalirdi. Burada gercek donanim cihazlari `plughw` uzerinden denenir
   * (S32_LE -> S16_LE donusumunu ALSA yapar).
   *
   * SIRA: AEC kaynağı > DMIC > diğer > `default`.
   * AEC en başta çünkü yankısız giriş, ham donanım girişinden DAHA
   * kullanışlıdır. Ancak AEC düğümü gerçekten VARSA eklenir; yoksa liste
   * bugünküyle birebir aynı kalır.
   */
  private static discoverDevices(): string[] {
    // AEC kaynağı varsa listenin başına koy.
    const aecSource = detectAecNode('Audio/Source');
    const aecList: string[] = aecSource ? [aecSource] : [];
    aecInUse = !!aecSource;
    if (aecSource) {
      logInfo('AEC kaynağı bulundu, giriş yankı engellemeye yönlendirildi', {
        device: aecSource,
      });
    }
    // SIRA KRITIK: `default` EN SONA konur.
    // Olculdu (bu makine): PipeWire `default` kaynagi hata vermeden calisir ama
    // neredeyse tamamen DC ofset + kirpilma uretir (DC ~6400/32768, DC-cikarilmis
    // RMS ~0,0018, 3 sn'de 598 kirpilmis ornek). Ayni anda gercek DMIC
    // (`plughw:CARD=amdsoundwire,DEV=4`) 40 kat guclu temiz AC sinyal verir
    // (RMS ~0,077, -22 dBFS). Eskiden `default` ilk aday oldugu ve liveness
    // yoklamasi yalnizca "bayt geldi mi" baktigi icin ajan hep bozuk `default`
    // uzerinde kalip gercek mikrofona hic gecmiyordu.
    const dmic: string[] = [];
    const other: string[] = [];

    try {
      // `arecord -l` ciktisi:
      //   "card 2: amdsoundwire [amd-soundwire], device 4: acp-dmic-codec dmic-hifi-4 []"
      const listing = execFileSync('arecord', ['-l'], { encoding: 'utf8' });
      const regex = /card\s+(\d+):\s+([^\s,\[]+)[^\n]*?device\s+(\d+):\s*([^\n]*)/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(listing)) !== null) {
        const cardName = match[2];
        const deviceIndex = match[3];
        const description = (match[4] || '').toLowerCase();
        const id = `plughw:CARD=${cardName},DEV=${deviceIndex}`;
        if (dmic.includes(id) || other.includes(id)) continue;

        // Dijital mikrofon (DMIC) en yuksek oncelik: bu makinede tek canli kaynak.
        if (/\bdmic\b|digital mic/.test(description)) dmic.push(id);
        else other.push(id);
      }
    } catch (error) {
      logWarn('Kayit cihazlari listelenemedi', {
        error: (error as Error).message,
      });
    }

    // Sıra: AEC (varsa) → DMIC → diğer donanım → `default` (son çare).
    const list = [...aecList, ...dmic, ...other, 'default'];
    logDebug('Kayıt cihazı adayları', { adaylar: list, aec: aecSource ?? 'yok' });
    return list;
  }

  /**
   * Mikrofonu başlatır. `arecord` yoksa açık hata verir — sessizce
   * "dinliyorum" numarası yapmaz.
   */
  async start(onAudio: (chunk: Buffer) => void): Promise<void> {
    if (this.running) return;

    this.onAudio = onAudio;
    this.running = true;
    this.restarts = 0;
    this.candidateIndex = 0;
    this.autoSwitched = false;
    this.device = this.deviceCandidates[0] ?? this.device;

    await this.spawnRecorder();
  }

  /**
   * Cihazdan canli veri gelip gelmedigini denetler. Gelmiyorsa (tam sifir
   * ornekler) bir sonraki adaya gecer.
   */
  private scheduleLivenessProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.autoSwitched) return;
    if (this.deviceCandidates.length <= 1) return;

    const baselineForwarded = this.forwardedChunks;
    const baselineBytes = this.totalBytes;
    this.probeMaxAcRms = 0;

    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (!this.running || this.autoSwitched) return;

      // Canlilik GELEN BAYT ile olculur. Sebep: sessiz bir odada parca
      // iletilmemesi NORMALDIR; `forwardedChunks` kullanilirsa cihaz yanlislikla
      // "olu" sayilir, donanim cihazi zorla acilir ve PipeWire'in elinden alinir
      // (hem kendi akisi hem diger uygulamalar bozulur).
      //
      // NOT: AC RMS bilincli olarak karar kriteri YAPILMADI. Olculdu (2026-10-27):
      // bozuk `default` cihazi 0,0014-0,0038 AC RMS, saglikli DMIC ise sessiz
      // odada 0,00085-0,00149 uretiyor — dagilimlar ORTUSUYOR, ayirt edici
      // degil. Cihaz secimini `discoverDevices()` sirasi belirler (gercek DMIC
      // once, `default` en son).
      const gotBytes = this.totalBytes > baselineBytes;

      if (gotBytes) return; // cihaz canli

      const next = this.candidateIndex + 1;
      if (next >= this.deviceCandidates.length) {
        logError('Hicbir kayit cihazindan ses alinamadi', undefined, {
          denenenCihazlar: this.deviceCandidates,
          sonCihazAcRms: Number(this.probeMaxAcRms.toFixed(5)),
          ipucu:
            'Mikrofon bagli mi? "arecord -D <cihaz> -f S16_LE -r 16000 -c 1 -d 3 /tmp/t.wav" ' +
            'ile tek tek cihaz deneyin. Gerekirse DIJI_AUDIO_INPUT_DEVICE ile cihazi elle belirtin.',
        });
        this.autoSwitched = true;
        return;
      }

      logWarn('Cihazdan ses gelmedi, sonraki cihaz deneniyor', {
        mevcutCihaz: this.device,
        yeniCihaz: this.deviceCandidates[next],
        alinanBayt: gotBytes ? this.totalBytes - baselineBytes : 0,
        iletilenParca: this.forwardedChunks - baselineForwarded,
        acRms: Number(this.probeMaxAcRms.toFixed(5)),
      });

      this.candidateIndex = next;
      this.device = this.deviceCandidates[next];
      this.restarts = 0;

      if (this.process) {
        // Kasıtlı kapatma: 'close' handler'ı bunu yeniden başlatma sanıp
        // ikinci bir arecord doğurmasın (aynı cihazda iki akış).
        this.switchingDevice = true;
        this.process.kill('SIGTERM');
        this.process = null;
      }
      void this.spawnRecorder();
    }, MicrophoneInput.PROBE_DELAY_MS);
  }

  private async spawnRecorder(): Promise<void> {
    if (!this.running) return;

    // NOT: `--period-size` burada verilmez. AMD SoundWire DMIC gibi
    // cihazlar yalnizca S32_LE/48kHz/2ch kabul eder ve periyot boyutu
    // donanima baglidir; sabit deger "Sample format non available"
    // hatasina yol acar. `plughw` donusumu ALSA'ya birakilir.
    const args = [
      '-q', // sessiz (ilerleme çubuğu yok)
      '-t',
      'raw', // ham PCM
      '-f',
      'S16_LE', // 16-bit little-endian
      '-c',
      '1', // mono
      '-r',
      String(AUDIO_SAMPLE_RATE),
      '-D',
      this.device,
    ];

    logInfo('Mikrofon baslatiliyor', {
      binary: this.binary,
      device: this.device,
      sampleRate: AUDIO_SAMPLE_RATE,
      chunkSize: this.chunkSize,
      adaySayisi: this.deviceCandidates.length,
    });

    const child = spawn(this.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;

    child.on('error', (error: Error) => {
      // En sık neden: `arecord` kurulu değil.
      logError('Mikrofon baslatilamadi', error, {
        binary: this.binary,
        hint: 'ALSA araclari kurulu mu?  sudo apt install alsa-utils',
      });
      this.running = false;
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        logWarn('arecord stderr', { data: text });
      }
    });

    let pending = Buffer.alloc(0);

    child.stdout?.on('data', (data: Buffer) => {
      this.totalBytes += data.length;
      pending = Buffer.concat([pending, data]);

      // Gelen baytları sabit boyutlu parçalara böl.
      while (pending.length >= this.chunkSize) {
        const chunk = pending.subarray(0, this.chunkSize);
        pending = pending.subarray(this.chunkSize);
        this.handleChunk(chunk);
      }
    });

    child.on('close', (code: number | null) => {
      this.process = null;
      if (this.probeTimer) {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
      }
      if (this.switchingDevice) {
        // Kasıtlı cihaz değişimi: yeni kayıt `spawnRecorder` ile zaten başladı.
        this.switchingDevice = false;
        return;
      }
      if (!this.running) return;

      // Cihaz acilmadi (ornek: yanlis format). Sonraki adaya gec.
      if (code !== 0 && code !== null && !this.autoSwitched) {
        const next = this.candidateIndex + 1;
        if (next < this.deviceCandidates.length) {
          logWarn('Kayit cihazi acilamadi, sonraki cihaz deneniyor', {
            code,
            mevcutCihaz: this.device,
            yeniCihaz: this.deviceCandidates[next],
          });
          this.candidateIndex = next;
          this.device = this.deviceCandidates[next];
          this.restarts = 0;
          this.restartTimer = setTimeout(() => {
            void this.spawnRecorder();
          }, 300);
          return;
        }
      }

      logWarn('Mikrofon akisi kapandi', {
        code,
        restarts: this.restarts,
      });

      if (this.restarts >= MicrophoneInput.MAX_RESTARTS) {
        logError('Mikrofon yeniden baslatma siniri asildi, akis durduruldu', undefined, {
          maxRestarts: MicrophoneInput.MAX_RESTARTS,
        });
        this.running = false;
        return;
      }

      this.restarts++;
      // Artan bekleme: 500ms, 1s, 2s, 3s, 4s
      const delay = Math.min(500 * this.restarts, 4000);
      this.restartTimer = setTimeout(() => {
        void this.spawnRecorder();
      }, delay);
    });

    // Kısa bir bekleme: süreç hemen ölürse (cihaz yok) bunu yakala.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    if (this.process) {
      logInfo('Mikrofon hazir', { device: this.device });
      this.scheduleLivenessProbe();
    }
  }

  /**
   * Gelen PCM parçasını sessizlik filtresinden geçirip pipeline'a iletir.
   */
  private handleChunk(chunk: Buffer): void {
    if (!this.onAudio) return;

    // DC offset temizligi. AMD SoundWire DMIC gibi bazi donanimlar
    // ~1000 ornek (≈0.03) sabit DC ofset uretir. Bu ofset VAD'in esik
    // kararini ve Whisper'in transkripsiyonunu bozar.
    const cleaned = this.removeDcOffset(chunk);

    const rms = this.computeRms(cleaned);

    // Canlilik yoklamasi icin pencere ici en yuksek AC RMS'i biriktir.
    // Esik filtresinden ONCE olculur: sessiz ama gercekten canli bir cihaz
    // (AC enerjisi var, konusma yok) "olu" sayilmamali.
    if (rms > this.probeMaxAcRms) this.probeMaxAcRms = rms;
    // Anlik seviye: 2 sn'lik kayan pencere. Sifirlanmazsa deger kumulatife
    // donusur ve "su an ses var mi" sorusunu yanitlamaz.
    const nowMs = Date.now();
    if (nowMs - this.recentWindowStart >= MicrophoneInput.RECENT_WINDOW_MS) {
      this.recentWindowStart = nowMs;
      this.recentMaxAcRms = rms;
    } else if (rms > this.recentMaxAcRms) {
      this.recentMaxAcRms = rms;
    }

    if (rms < this.silenceThreshold) {
      this.skippedChunks++;
      logDebug('Sessiz parca atlandi', {
        rms: Number(rms.toFixed(5)),
        threshold: this.silenceThreshold,
      });
      return;
    }

    this.forwardedChunks++;
    this.onAudio(cleaned);
  }

  /**
   * PCM 16-bit LE tampondan DC bilesenini (ortalama) cikarir.
   * Cikti yeni bir Buffer'dir; alt surec tamponu yeniden kullanilabilir.
   */
  private removeDcOffset(buffer: Buffer): Buffer {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) return Buffer.from(buffer);

    let sum = 0;
    for (let i = 0; i < sampleCount; i++) {
      sum += buffer.readInt16LE(i * 2);
    }
    const mean = Math.round(sum / sampleCount);

    // Ofset ihmal edilebilir duzeydeyse kopyalamaya gerek yok.
    if (Math.abs(mean) < 8) return Buffer.from(buffer);

    const out = Buffer.allocUnsafe(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      const value = buffer.readInt16LE(i * 2) - mean;
      // Kirpma: int16 araligini asma.
      out.writeInt16LE(value > 32767 ? 32767 : value < -32768 ? -32768 : value, i * 2);
    }
    return out;
  }

  /** PCM 16-bit LE -> normalize edilmiş RMS (0–1). */
  private computeRms(buffer: Buffer): number {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2);
      const normalized = sample / 32768;
      sumSquares += normalized * normalized;
    }

    return Math.sqrt(sumSquares / sampleCount);
  }

  /** Teşhis bilgisi. */
  getStats(): {
    running: boolean;
    device: string;
    totalBytes: number;
    forwardedChunks: number;
    skippedChunks: number;
    restarts: number;
    /** Son yoklama penceresinde olculen en yuksek DC-cikarilmis RMS. */
    acRms: number;
    silenceThreshold: number;
  } {
    return {
      running: this.running,
      device: this.device,
      totalBytes: this.totalBytes,
      forwardedChunks: this.forwardedChunks,
      skippedChunks: this.skippedChunks,
      restarts: this.restarts,
      acRms: Number(this.recentMaxAcRms.toFixed(5)),
      silenceThreshold: this.silenceThreshold,
    };
  }

  /** Mikrofonu durdurur. */
  stop(): void {
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }

    if (this.process) {
      // SIGTERM yeterli; arecord temiz kapanir.
      this.process.kill('SIGTERM');
      this.process = null;
    }

    logInfo('Mikrofon durduruldu', {
      totalBytes: this.totalBytes,
      forwardedChunks: this.forwardedChunks,
      skippedChunks: this.skippedChunks,
    });
  }
}

/**
 * Hoparlör çıkışı.
 *
 * TTS'ten gelen PCM'i `aplay` alt sürecine yazar. Yazma işlemi sıralıdır;
 * aynı anda tek bir `aplay` süreci çalışır. Yeni bir cümle geldiğinde
 * mevcut süreç beklenir (kuyruk) veya `interrupt()` ile kesilir.
 */
export class SpeakerOutput {
  private process: ChildProcess | null = null;
  private readonly device: string;
  private readonly binary: string;
  private readonly defaultSampleRate: number;
  private writing: Promise<void> = Promise.resolve();
  private stopped: boolean = false;
  /** Referans bildirimi geri çağrısı (yazılımsal AEC için). */
  private readonly onReference:
    | ((atMs: number, pcm: Buffer, sampleRate: number) => void)
    | null;

  constructor(options: SpeakerOptions = {}) {
    /*
     * ÇIKIŞ CİHAZI SEÇİMİ — üç kademeli, son kademe bugünkü davranıştır.
     *
     *   1. `options.device` / `DIJI_AUDIO_OUTPUT_DEVICE` — kullanıcı açıkça seçti
     *   2. AEC sink düğümü — yankı engelleme kuruluysa ses oradan geçmeli,
     *      yoksa AEC referans sinyali alamaz ve yankıyı silemez
     *   3. `default` — PipeWire/PulseAudio varsayılanı (mevcut davranış)
     *
     * NEDEN 3. kademe şart: bu sistemde PipeWire echo-cancel düğümü
     * oluşmuyor (bullt: WirePlumber ALSA cihazlarını Audio/Sink olarak
     * yayınlamıyor). AEC yoksa çıkışın `default` kalması gerekir; aksi halde
     * hiçbir şey çalınmaz.
     */
    const explicit = options.device || process.env.DIJI_AUDIO_OUTPUT_DEVICE;
    if (explicit) {
      this.device = explicit;
    } else {
      const aecSink = detectAecNode('Audio/Sink');
      this.device = aecSink ?? 'default';
      if (aecSink) {
        logInfo('AEC hedefi bulundu, çıkış yankı engellemeye yönlendirildi', {
          device: aecSink,
        });
      }
    }
    this.binary = options.binary || process.env.DIJI_APLAY_BIN || 'aplay';
    this.defaultSampleRate = options.sampleRate || AUDIO_SAMPLE_RATE;
    this.onReference = options.onReference ?? null;
  }

  /**
   * PCM parçasını hoparlöre yazar.
   * Parçalar sırayla işlenir; eşzamanlı çağrılar kuyruğa girer.
   *
   * @param pcm      16-bit mono little-endian PCM.
   * @param sampleRate PCM'in gerçek örnekleme frekansı. Verilmezse
   *                 yapılandırılmış varsayılan (16 kHz) kullanılır.
   */
  async play(pcm: Buffer, sampleRate?: number): Promise<void> {
    if (this.stopped || pcm.length === 0) return;

    const rate = sampleRate && sampleRate > 0 ? sampleRate : this.defaultSampleRate;

    this.writing = this.writing
      .then(() => this.writeChunk(pcm, rate))
      .catch((error: unknown) => {
        logError('Hoparlore yazma hatasi', error as Error);
      });

    return this.writing;
  }

  /**
   * Kuyruktaki tüm sesin çalınmasını bekler.
   * Sentez bittiğinde çağrılır; aksi halde süreç kapanırken son hece kesilir.
   */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  private writeChunk(pcm: Buffer, sampleRate: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }

      /*
       * REFERANS BİLDİRİMİ — tam burada, `aplay` başlatılmadan hemen önce.
       *
       * Zamanlama kritik: yazılımsal yankı kapılaması bu zaman damgasını
       * akustik gecikme penceresinin merkezi olarak kullanır. PCM'i kuyruğa
       * `play()` içinde değil BURADA bildirmek gerekir; aksi halde kuyrukta
       * bekleyen parçalar gelecekteki bir zamanla eşleşir ve referans
       * pencereyi ıskalar.
       */
      if (this.onReference) {
        try {
          this.onReference(Date.now(), pcm, sampleRate);
        } catch (error) {
          // Referans bildirimi başarısız olsa bile ses ÇALINMALI.
          // Teşhis katmanı asla ses yolunu kesmemelidir.
          logDebug('Referans bildirimi hatasi', { error: (error as Error).message });
        }
      }

      const args = [
        '-q',
        '-t',
        'raw',
        '-f',
        'S16_LE',
        '-c',
        '1',
        '-r',
        String(sampleRate),
        '-D',
        this.device,
      ];

      const child = spawn(this.binary, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
      });

      this.process = child;

      child.on('error', (error: Error) => {
        logError('aplay baslatilamadi', error, {
          binary: this.binary,
          hint: 'ALSA araclari kurulu mu?  sudo apt install alsa-utils',
        });
        this.process = null;
        resolve();
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          logWarn('aplay stderr', { data: text });
        }
      });

      child.on('close', () => {
        this.process = null;
        resolve();
      });

      // PCM'i yaz ve akisi kapat (aplay EOF'ta çalar).
      child.stdin?.on('error', (error: Error) => {
        // EPIPE: aplay erken kapandi (barge-in / interrupt). Normaldir.
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
          logError('aplay stdin hatasi', error);
        }
      });

      child.stdin?.end(pcm);
    });
  }

  /** Çalan sesi hemen keser (barge-in için). */
  interrupt(): void {
    if (this.process) {
      logDebug('Hoparlor kesildi (barge-in)');
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /** Kaynakları kapatır. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.interrupt();
    await this.writing.catch(() => undefined);
    logInfo('Hoparlor durduruldu');
  }
}

export const createMicrophoneInput = (options?: MicrophoneOptions): MicrophoneInput =>
  new MicrophoneInput(options);

export const createSpeakerOutput = (options?: SpeakerOptions): SpeakerOutput =>
  new SpeakerOutput(options);
