/**
 * Yazılımsal yankı kapılaması (AEC by VAD Blanking).
 *
 * SORUN
 *   Donanımsal AEC (PipeWire `module-echo-cancel`) bu makinede çalışmıyor:
 *   düğümler oluşsa bile `null-audio-sink` tabanlı oldukları için sessizlik
 *   üretiyorlar (`arecord -D pipewire` → maksimum genlik 0). Bu yüzden
 *   asistan konuşurken mikrofon, asistanın KENDİ sesini de duyar. Klasik
 *   çözüm "ses yüksekse kullanıcıdır" demektir — ve bu YANLIŞTIR:
 *
 *     1. "Asistanın ses seviyesi" mikrofon tarafında sabit DEĞİLDİR.
 *        Hoparlör kazancı, mesafe ve oda akustiği bilinmez; aynı PCM farklı
 *        oturumlarda 10 kat farklı genlikle dönebilir.
 *     2. Yakın hoparlörde YANKI genellikle kullanıcıdan DAHA YÜKSEKTİR.
 *        "RMS yüksekse kullanıcı" kuralı yankının kendisini barge-in sayar
 *        → asistan her cümlede kendini keser → sonsuz sessizlik.
 *     3. Kullanıcı asistan konuşurken de konuşur; ikisi de yüksek RMS verir.
 *        Basit kapılama (ducking) ikisini birlikte siler → kullanıcı hiç
 *        duyulmaz, barge-in asla tetiklenmez.
 *
 * ÇÖZÜM — REFERANS TABANLI KARAR
 *   Gerçek soru "bu ses ne kadar yüksek" değil, "bu ses BENİM sesim mi".
 *   Bunu genlikle değil, hoparlöre YAZDIĞIMIZ sinyalle karşılaştırarak
 *   çözeriz. [`SpeakerOutput`](./audio-io.ts) çaldığı her PCM'in RMS'ini
 *   zaman damgasıyla bu sınıfa bildirir; mikrofon parçası geldiğinde o ana
 *   denk gelen referans seviyesi bulunur:
 *
 *       beklenen yankı = referans RMS × kazanç
 *
 *   Ölçülen / beklenen oranı yankıyı kullanıcıdan ayırır. Referansı bilen
 *   taraf, kör eşik koyan taraf değildir.
 *
 * GECİKME BELİRSİZLİĞİ — MUHAFAZAKÂR PENCERE
 *   Hoparlör→mikrofon akustik gecikmesi (~5-80 ms) ve `aplay` tampon
 *   gecikmesi bilinmez. Tek nokta karşılaştırması yanlış eşleşir. Bu yüzden
 *   pencere içindeki EN YÜKSEK referans kullanılır: beklenen yankı olduğundan
 *   BÜYÜK tahmin edilir. Bu bilinçli bir tercihtir — hata yönü "fazla
 *   bastırma" tarafına düşer, "kullanıcıyı yanlışlıkla silme" tarafına değil.
 *   Gerçek konuşma yine de bu tahminin üstüne çıkar (konuşma, yankıdan
 *   tipik olarak 6-20 dB yüksektir).
 *
 * REFERANS "YAZILDI" ANI DEĞİL "ÇALINDI" ARALIĞI
 *   İlk sürümdeki kusur: hoparlöre verilen PCM, yazıldığı ANDA tek bir zaman
 *   damgasıyla kaydediliyordu. Oysa o PCM saniyelerce çalar. 240 ms'lik
 *   pencere dolduğunda damga düşüyor, referans BOŞALIYOR ve karar
 *   "referans-yok"a düşüp HİÇBİR bastırma yapmıyordu. Sonuç: koruma varmış
 *   gibi görünüyor, gerçekte çalışmıyor — asistan kendini kesmiyordu çünkü
 *   onu koruyan bir şey yoktu, sadece bastırma da yoktu.
 *   Düzeltme: her referans kovası RMS'in yanında ÇALMA SÜRESİNİ de taşır
 *   (`endMs = atMs + pcm.length / (2 × sampleRate)`). Kova, çalması bitene
 *   kadar yaşar; pencere sorgusu damga yerine ARALIK KESİŞİMİ ile eşleşir.
 *
 * KAZANÇ KENDİNİ AYARLAR — AMA YALNIZCA AŞAĞI
 *   Başlangıç kazancı muhafazakârdır. Yalnızca "ölçülen oran tahminden
 *   KÜÇÜK" örneklerde yavaşça düşürülür (yankı olduğu kesin örnekler).
 *   Kullanıcı konuşurken oran büyük olur ve kazanç ARTMAZ. Böylece kullanıcı
 *   bir kez yankı sanılırsa kalıcı olarak silinmez.
 *
 * SINIR — BU GERÇEK AEC DEĞİLDİR
 *   Doğrusal olmayan yankıyı (hoparlör kırpması, oda yankılanması) tamamen
 *   modellemez. Amacı, otomatik barge-in'i güvenli biçimde açabilmektir;
 *   tam yankı silme değildir. Donanımsal AEC kurulursa o tercih edilir.
 *
 * Bu sınıf SAF HESAPTIR: ağ, süreç, dosya erişimi yoktur. Bu yüzden
 * mock'suz test edilebilir.
 */

/** Yankı kapılaması yapılandırması. */
export interface EchoGuardConfig {
  /**
   * Referans penceresi (ms). Hoparlör→mikrofon gecikmesini kapsamalı.
   * Çok küçük → yanlış eşleşme; çok büyük → gereksiz bastırma.
   */
  windowMs: number;
  /**
   * Ölçülen/beklenen oranı bu değerin altındaysa parça YANKI sayılır.
   * 1'den büyük olması, "beklenenden biraz yüksek ses bile yankı olabilir"
   * demektir (hoparlör kırpması, ölçüm gürültüsü payı).
   */
  echoTolerance: number;
  /**
   * Oran bunun üstündeyse VE VAD konuşma diyorsa parça KULLANICI sayılır.
   * `echoTolerance`'dan belirgin biçimde büyük olmalı; aksi halde ara bölge
   * kalmaz ve yankı barge-in'e dönüşür.
   */
  bargeMargin: number;
  /** Başlangıç kazancı (referans RMS → beklenen mikrofon RMS). */
  initialGain: number;
  /** Kazanç alt sınırı. Sıfıra inerse bastırma tamamen kaybolur. */
  minGain: number;
  /** Kazanç üst sınırı. Aşırı bastırmayı engeller. */
  maxGain: number;
  /**
   * Kazanç adaptasyon hızı (0-1). Küçük değer = yavaş ve kararlı.
   * Hızlı adaptasyon tek bir yanlış örneğe aşırı tepki verir.
   */
  adaptRate: number;
  /**
   * Bu RMS'in altındaki parçalar "sinyal yok" sayılır ve HİÇBİR karar
   * verilmez. Ölçüldü (bu makine, sessiz oda): DC çıkarılmış parça RMS
   * p50 ≈ 0,001. Kapı çarpması/nefes bunun üstüne çıkar.
   */
  noiseFloor: number;
}

/** Varsayılanlar — bu makinede ölçülen değerlere dayanır. */
export const DEFAULT_ECHO_GUARD_CONFIG: EchoGuardConfig = {
  /*
   * 240 ms pencere: `aplay` tampon gecikmesi + akustik gecikme + mikrofon
   * parça süresi (100 ms) toplamını rahatça kapsar. Daha küçük değerlerde
   * referans ile mikrofon parçası ıskalanıyordu.
   */
  windowMs: 240,
  /*
   * 1,6 tolerans: beklenen yankının %60 üstüne kadar "hâlâ yankı" say.
   * Hoparlör kırpması ve oda yansımaları beklenen değeri yukarı taşır.
   */
  echoTolerance: 1.6,
  /*
   * 3,2 barge marjı: kullanıcı, beklenen yankının en az 3,2 katı olmalı.
   * Bu, ölçülen konuşma/yankı ayrımına (6-20 dB ≈ 2-10×) denk gelir ve
   * yankıyı barge-in sanma riskini pratikte sıfırlar. Yanlış tarafa
   * düşerse maliyet "kullanıcı biraz daha yüksek konuşmalı" olur — kabul
   * edilebilir. Tersi (kendini kesme) kabul edilemez.
   */
  bargeMargin: 3.2,
  /** 0,35: yakın hoparlörde yankı mikrofona görece zayıf döner. */
  initialGain: 0.35,
  minGain: 0.02,
  maxGain: 1.2,
  /** 0,25: her yankı örneğinde beklenen değerin dörtte biri kadar yaklaş. */
  adaptRate: 0.25,
  /** Sessiz oda tabanının (≈0,001) belirgin üstü. */
  noiseFloor: 0.004,
};

/** Sinyal değerlendirme girdisi. */
export interface EchoEvaluateInput {
  /** Mikrofon parçasının DC çıkarılmış RMS değeri. */
  rms: number;
  /** Parçanın zaman damgası (ms). */
  atMs: number;
  /** VAD bu parçada konuşma gördü mü? */
  vadSpeaking: boolean;
}

/** Kararın nedeni — günlükte ve panelde ayrımı görünür kılar. */
export type EchoReason = 'yanki' | 'kullanici' | 'zayif-sinyal' | 'referans-yok';

/** Karar sonucu. */
export interface EchoDecision {
  /**
   * Parça bastırılmalı mı? `true` ise çağıran taraf PCM'i sıfırlar ve VAD'a
   * sessizlik besler. Durum makineleri (isInSpeech, sayaçlar) tutarlı kalır.
   */
  suppressed: boolean;
  /** Otomatik barge-in tetiklenmeli mi? */
  bargeIn: boolean;
  /** Ölçülen mikrofon RMS'i. */
  observedRms: number;
  /** Referanstan türetilen beklenen yankı RMS'i. */
  expectedEcho: number;
  /** `observedRms / expectedEcho`. Referans yoksa `Infinity`. */
  ratio: number;
  reason: EchoReason;
  /** O an kullanılan kazanç (teşhis için). */
  gain: number;
}

/** Referans halka tamponundaki tek kova. */
interface ReferenceBucket {
  /** PCM'in hoparlöre verildiği an (ms). */
  atMs: number;
  /**
   * PCM'in çalmasının BİTTİĞİ an (ms). Yaşam süresi buna göre belirlenir:
   * yazıldığı an referansın geçerli olduğu tek an değildir.
   */
  endMs: number;
  rms: number;
}

/**
 * Hoparlöre yazılan sinyalin RMS geçmişini tutan sabit boyutlu halka tampon.
 *
 * NEDEN SABİT BOYUT: sınırsız büyüyen bir dizi, uzun bir turda belleği
 * şişirir. Pencere/zaman çözünürlüğü sabit olduğu için kova sayısı da
 * sabittir (tipik: 240 ms / 20 ms = 12 kova, artı pay).
 */
class ReferenceRing {
  private readonly buckets: ReferenceBucket[] = [];
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly bucketMs: number;

  constructor(ttlMs: number, bucketMs: number) {
    this.ttlMs = ttlMs;
    this.bucketMs = bucketMs;
    // +2 pay: sınır durumlarında en eski kovanın hemen düşmesini engeller.
    this.capacity = Math.max(4, Math.ceil(ttlMs / bucketMs) + 2);
  }

  /**
   * Yeni referans ölçümü ekler.
   *
   * `durationMs` PCM'in çalma süresidir ve kovanın YAŞAM SÜRESİNİ belirler.
   * Aynı zaman kovasına düşen bildirimlerde RMS'in en yükseği, sürenin en
   * uzunu tutulur — ikisi de güvenli (fazla bastırma) yönündedir.
   */
  record(atMs: number, rms: number, durationMs: number): void {
    const endMs = atMs + Math.max(0, durationMs);
    const last = this.buckets[this.buckets.length - 1];

    if (last && atMs - last.atMs < this.bucketMs) {
      // Aynı zaman kovası: en yüksek RMS ve en uzun çalma süresi kazanır.
      last.rms = Math.max(last.rms, rms);
      last.endMs = Math.max(last.endMs, endMs);
      return;
    }

    this.buckets.push({ atMs, endMs, rms });
    while (this.buckets.length > this.capacity) this.buckets.shift();
  }

  /**
   * `[fromMs, toMs]` aralığıyla KESİŞEN kovaların EN YÜKSEK referans RMS'i.
   *
   * Damga yerine ARALIK KESİŞİMİ kullanılır: uzun bir PCM yazıldığı andan
   * çok sonra da duyulmaya devam eder, dolayısıyla referans o süre boyunca
   * geçerli sayılmalıdır. Aksi halde pencere boşalır ve bastırma sessizce
   * devre dışı kalır.
   *
   * Maksimum (ortalama değil) kullanılır: gecikme belirsizliğinde beklenen
   * yankıyı olduğundan büyük tahmin etmek, bastırma tarafında güvenli olandır.
   */
  maxBetween(fromMs: number, toMs: number): number {
    let max = 0;
    for (const bucket of this.buckets) {
      // Kesişim: kova [atMs, endMs], sorgu [fromMs, toMs].
      if (bucket.atMs > toMs || bucket.endMs < fromMs) continue;
      if (bucket.rms > max) max = bucket.rms;
    }
    return max;
  }

  /** Çalması bitmiş ve pencere dışında kalmış kovaları atar. */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.ttlMs;
    while (this.buckets.length > 0 && this.buckets[0].endMs < cutoff) {
      this.buckets.shift();
    }
  }

  clear(): void {
    this.buckets.length = 0;
  }

  get size(): number {
    return this.buckets.length;
  }
}

/**
 * Referans tabanlı yazılımsal yankı kapılaması.
 *
 * KULLANIM
 *   1. Hoparlör PCM yazdıkça: `recordReference(Date.now(), rms)`
 *   2. Mikrofon parçası geldiğinde: `evaluate({ rms, atMs, vadSpeaking })`
 *   3. Dönen karara göre PCM'i sıfırla (`suppressed`) veya barge-in yap
 */
export class EchoGuard {
  private readonly config: EchoGuardConfig;
  private readonly reference: ReferenceRing;
  private gain: number;

  /** Teşhis sayaçları — panelde ve günlükte görünür. */
  private suppressedCount: number = 0;
  private bargeInCount: number = 0;
  private evaluatedCount: number = 0;
  /**
   * Karar nedenlerinin dağılımı.
   *
   * NEDEN GEREKLİ: "barge-in olmadı" tek başına başarı kanıtı DEĞİLDİR —
   * kapılama hiç çalışmıyorken de barge-in olmaz. Bu sayaçlar bastırmanın
   * gerçekten devrede olduğunu (`yanki` sayısı) ve ne sıklıkla referans
   * bulunamadığını (`referans-yok`) ayırt eder.
   */
  private readonly reasonCounts: Record<EchoReason, number> = {
    yanki: 0,
    kullanici: 0,
    'zayif-sinyal': 0,
    'referans-yok': 0,
  };

  constructor(config: Partial<EchoGuardConfig> = {}) {
    this.config = { ...DEFAULT_ECHO_GUARD_CONFIG, ...config };
    this.gain = this.config.initialGain;
    // Kova çözünürlüğü 20 ms: mikrofon parçası 100 ms olduğu için yeterli.
    this.reference = new ReferenceRing(this.config.windowMs, 20);
  }

  /**
   * Hoparlöre yazılan PCM'i referans olarak kaydeder.
   *
   * Çağıran taraf ham PCM'i verir; RMS ve çalma süresi burada hesaplanır ki
   * hoparlör sınıfı örnek formatını bilmek zorunda kalmasın.
   *
   * `sampleRate` ÖNEMLİ: çalma süresi buradan türetilir. Yanlış oran, yanlış
   * yaşam süresi demektir — referans ya çok erken ölür (bastırma kaybolur)
   * ya da çok uzun yaşar (sessizlikte bile bastırır).
   */
  recordReference(atMs: number, pcm: Buffer, sampleRate: number): void {
    if (pcm.length < 2) return;
    const rms = EchoGuard.computePcm16Rms(pcm);
    this.reference.record(atMs, rms, EchoGuard.pcmDurationMs(pcm, sampleRate));
    this.reference.prune(atMs);
  }

  /**
   * Referansı RMS olarak doğrudan kaydeder (testler ve ölçüm için).
   *
   * `durationMs` verilmezse kova yalnızca pencere boyunca yaşar — kısa
   * bildirimler için doğru varsayılan budur.
   */
  recordReferenceRms(atMs: number, rms: number, durationMs: number = 0): void {
    this.reference.record(atMs, Math.max(0, rms), durationMs);
    this.reference.prune(atMs);
  }

  /**
   * Bir mikrofon parçası için karar üretir.
   *
   * KARAR TABLOSU (asistan konuşurken)
   *   rms ≤ noiseFloor                      → zayif-sinyal, bastırma YOK
   *   referans yok (TTS akmıyor)            → referans-yok,   bastırma YOK
   *   oran < echoTolerance                  → yanki,  bastırılır
   *   oran ≥ bargeMargin VE VAD konuşuyor   → kullanici, barge-in
   *   aksi halde (ara bölge)                → yanki,  bastırılır (güvenli taraf)
   */
  evaluate(input: EchoEvaluateInput): EchoDecision {
    this.evaluatedCount += 1;

    const { rms, atMs, vadSpeaking } = input;
    const gain = this.gain;

    const weak: EchoDecision = {
      suppressed: false,
      bargeIn: false,
      observedRms: rms,
      expectedEcho: 0,
      ratio: Number.POSITIVE_INFINITY,
      reason: 'zayif-sinyal',
      gain,
    };

    // Sinyal yok: karar verme. Aksi halde sessizlikte "yankı" deyip
    // durum makinelerini gereksiz yere meşgul ederiz.
    if (!(rms > this.config.noiseFloor)) {
      this.reasonCounts['zayif-sinyal'] += 1;
      return weak;
    }

    /*
     * KAZANÇ BURADA UYGULANIR.
     *
     * Ham referans RMS'i hoparlörün çıkış seviyesidir; mikrofona dönen
     * yankı ise bundan çok daha zayıftır (mesafe, yön, oda emilimi).
     * `gain` bu dönüşümü modeller: beklenen yankı = referans × kazanç.
     * Çarpım unutulursa referans olduğu gibi "beklenen" sayılır ve her
     * gerçek yankı beklenenin çok altında kalıp sürekli bastırılır —
     * yani kullanıcı sağır kalır.
     */
    const referenceRms = this.reference.maxBetween(
      atMs - this.config.windowMs,
      atMs
    );
    const expectedEcho = referenceRms * gain;

    // Referans yok: asistan aslında susuyor (TTS bitti ama bayrak henüz
    // düşmedi). Bu durumda bastırmak kullanıcıyı sağır bırakır.
    if (!(expectedEcho > 0)) {
      this.reasonCounts['referans-yok'] += 1;
      return {
        suppressed: false,
        bargeIn: false,
        observedRms: rms,
        expectedEcho: 0,
        ratio: Number.POSITIVE_INFINITY,
        reason: 'referans-yok',
        gain,
      };
    }

    const ratio = rms / expectedEcho;

    const result: EchoDecision = {
      suppressed: false,
      bargeIn: false,
      observedRms: rms,
      expectedEcho,
      ratio,
      reason: 'yanki',
      gain,
    };

    if (ratio >= this.config.bargeMargin && vadSpeaking) {
      result.reason = 'kullanici';
      result.bargeIn = true;
      this.bargeInCount += 1;
      this.reasonCounts['kullanici'] += 1;
      // Kullanıcı örneği kazancı DEĞİŞTİRMEZ: aksi halde kullanıcı sesi
      // yankı sanılıp kalıcı olarak silinirdi.
      return result;
    }

    result.suppressed = true;
    result.reason = 'yanki';
    this.suppressedCount += 1;
    this.reasonCounts['yanki'] += 1;
    this.adaptGain(ratio);
    result.gain = this.gain;
    return result;
  }

  /**
   * Kazancı AŞAĞI doğru adapte eder.
   *
   * Yalnızca oran 1'den küçükken (yankı beklediğimizden zayıf döndüğünde)
   * çalışır. Oran 1'den büyükse bilinçli olarak dokunulmaz — o örnek ya
   * kullanıcıdır ya da beklenen tahmin zaten düşüktür; ikisinde de kazancı
   * yükseltmek bastırmayı güçlendirip kullanıcıyı silme riski taşır.
   */
  private adaptGain(ratio: number): void {
    if (!(ratio > 0) || ratio >= 1) return;
    const target = Math.max(this.config.minGain, Math.min(this.config.maxGain, this.gain * ratio));
    this.gain = this.gain + (target - this.gain) * this.config.adaptRate;
    // Kayan nokta sapmasına karşı sınırla.
    this.gain = Math.max(this.config.minGain, Math.min(this.config.maxGain, this.gain));
  }

  /** Barge-in sonrası: hoparlör sustu, referans geçmişi anlamsız. */
  clearReference(): void {
    this.reference.clear();
  }

  /** Tam sıfırlama (yeni oturum / TTS yeniden başladı). */
  reset(): void {
    this.reference.clear();
    this.gain = this.config.initialGain;
    this.suppressedCount = 0;
    this.bargeInCount = 0;
    this.evaluatedCount = 0;
    this.reasonCounts.yanki = 0;
    this.reasonCounts.kullanici = 0;
    this.reasonCounts['zayif-sinyal'] = 0;
    this.reasonCounts['referans-yok'] = 0;
  }

  /** Teşhis anlık görüntüsü. */
  getStats(): {
    gain: number;
    referenceBuckets: number;
    evaluated: number;
    suppressed: number;
    bargeIn: number;
    /**
     * Karar nedenlerinin dağılımı.
     *
     * "barge-in olmadı" tek başına başarı DEĞİLDİR: hiç çalışmayan bir
     * kapılama da barge-in üretmez. `yanki` sayısı bastırmanın gerçekten
     * devrede olduğunu, `referans-yok` sayısı ise referansın ıskalandığını
     * gösterir.
     */
    reasons: Record<EchoReason, number>;
  } {
    return {
      gain: Number(this.gain.toFixed(4)),
      referenceBuckets: this.reference.size,
      evaluated: this.evaluatedCount,
      suppressed: this.suppressedCount,
      bargeIn: this.bargeInCount,
      reasons: { ...this.reasonCounts },
    };
  }

  /**
   * PCM16 mono tamponun çalma süresi (ms).
   *
   * Örnek başına 2 bayt (S16_LE). Geçersiz örnekleme oranında 0 döner:
   * süre bilinemiyorsa kova yalnızca pencere boyunca yaşar; bu, referansın
   * sonsuza kadar canlı kalmasından çok daha güvenlidir.
   */
  static pcmDurationMs(pcm: Buffer, sampleRate: number): number {
    if (!(sampleRate > 0)) return 0;
    const sampleCount = Math.floor(pcm.length / 2);
    return (sampleCount / sampleRate) * 1000;
  }

  /** PCM16 little-endian tamponun RMS'i (0-1 aralığına normalize). */
  static computePcm16Rms(pcm: Buffer): number {
    const sampleCount = Math.floor(pcm.length / 2);
    if (sampleCount === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcm.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }
}

/**
 * Kullanıcı yazılımsal katmanı kapatmak istedi mi?
 *
 * `DIJI_AEC_SOFTWARE=0` → kapalı. Varsayılan AÇIK: donanımsal AEC bu
 * makinede çalışmadığı için tek koruma katmanı budur.
 */
export function softwareAecEnabled(): boolean {
  const raw = process.env.DIJI_AEC_SOFTWARE;
  if (raw === undefined) return true;
  return !/^(0|false|no|off)$/i.test(raw);
}
