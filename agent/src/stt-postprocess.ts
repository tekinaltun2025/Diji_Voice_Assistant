import type { STTPostprocessConfig } from '@diji/shared';
import { logDebug } from '@diji/shared';

/**
 * Türkçe transkript son işleme (postprocess).
 *
 * Whisper'ın Türkçe'de gözlenen sistematik hatalarını hedefler:
 *
 *  1) HALÜSİNASYON: Sessiz/gürültülü bölgelerde eğitim verisinden ezberlenmiş
 *     kalıplar üretir ("İzlediğiniz için teşekkürler", "Altyazı M.K.",
 *     "Çeviri: ..."). Bu kalıplar konuşmayla ilgisizdir ve komutu zehirler.
 *  2) BİTİŞİK YAZIM: "birşey", "herşey", "hiçbirşey" gibi yaygın hatalar.
 *  3) ÖZEL TERİM: "gmail", "takvim", "notion" gibi alan sözcükleri yanlış
 *     duyulur ("cı meyl", "takvim"→"takdim"). Sözlük + bulanık eşleşme
 *     düzeltir.
 *  4) NEDENSİZ KARAKTER: "[", "♪", "…", tekrarlı noktalama, baştaki/sondaki
 *     boşluk ve tırnaklar.
 *
 * TASARIM NOTU: Düzeltmeler KELİME düzeyinde yapılır ve Türkçe'ye özgü
 * karakterler (ı/İ/i, ş/s, ğ/g) korunur. ASCII'ye çevirme YAPILMAZ —
 * aksi halde "ışık" ile "isik" aynı kabul edilir ve anlam bozulur.
 */

/** Son işleme sonucu: düzeltilmiş metin + yapılan düzeltme sayısı. */
export interface PostprocessResult {
  /** Düzeltilmiş metin. */
  text: string;
  /** Yapılan toplam düzeltme (sözlük + bulanık + boşluk + halüsinasyon). */
  fixes: number;
  /** Metin halüsinasyon olarak tamamen atıldı mı? */
  dropped: boolean;
}

export const DEFAULT_POSTPROCESS: Required<
  Omit<STTPostprocessConfig, 'vocabulary' | 'terms'>
> & { vocabulary: Record<string, string>; terms: string[] } = {
  enabled: true,
  vocabulary: {},
  terms: [],
  fuzzyDistance: 1,
  stripHallucinations: true,
  fixSpacing: true,
};

/**
 * Whisper'ın sessiz bölgelerde ürettiği bilinen kalıplar.
 *
 * Her kalıp KÜÇÜK HARFE çevrilmiş metinle karşılaştırılır. Eşleşme
 * "metnin tamamı bu kalıptan oluşuyor" biçimindedir; cümle içinde geçen
 * aynı sözcükler silinmez (yalnızca tam halüsinasyon atılır).
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^izledi[ğg]iniz i[çc]in te[şs]ekk[üu]rler[.!]?$/,
  /^altyaz[ıi] m\.? ?k\.?$/,
  /^altyaz[ıi]:? .*$/,
  /^[çc]eviri:? .*$/,
  /^abone olmay[ıi] unutmay[ıi]n[.!]?$/,
  /^kanal[ıi]m[ıi]za abone olun[.!]?$/,
  /^be[ğg]enmeyi unutmay[ıi]n[.!]?$/,
  /^thanks for watching[.!]?$/,
  /^thank you for watching[.!]?$/,
  /^subtitles? by .*$/,
  /^\.+$/,
  /^[\s.,!?…\-–—♪\[\(\)]*$/,
];

/**
 * Türkçe'de yaygın bitişik/ayrı yazım hataları.
 *
 * ÖNEMLİ: `\b` KULLANILMAZ. JavaScript'in `\b` sınırı ASCII tabanlıdır;
 * `ş`, `ç`, `ğ`, `ı`, `ö`, `ü` "kelime karakteri" sayılmadığı için
 * `\bşu` gibi bir kalıp HİÇ eşleşmez ("şuanda" düzeltilemiyordu — canlı
 * testte yakalandı). Bunun yerine Unicode harf sınırı kullanılır:
 * `(?<![\p{L}])` = önünde harf yok, `(?![\p{L}])` = ardında harf yok.
 *
 * Kelime SONU sınırı bilinçli olarak bazı kurallarda gevşetilmiştir:
 * "birşeyler" → "bir şeyler" gibi çekimli biçimler de düzeltilir.
 */
const SPACING_FIXES: Array<{ wrong: RegExp; right: string }> = [
  { wrong: /(?<![\p{L}])bir[şs]ey/giu, right: 'bir şey' },
  { wrong: /(?<![\p{L}])her[şs]ey/giu, right: 'her şey' },
  { wrong: /(?<![\p{L}])hi[çc]bir[şs]ey/giu, right: 'hiçbir şey' },
  { wrong: /(?<![\p{L}])[şs]u\s*anda(?![\p{L}])/giu, right: 'şu anda' },
  { wrong: /(?<![\p{L}])her\s*zaman(?![\p{L}])/giu, right: 'her zaman' },
  { wrong: /(?<![\p{L}])her\s*kez(?![\p{L}])/giu, right: 'her kez' },
  { wrong: /(?<![\p{L}])ne\s*zaman(?![\p{L}])/giu, right: 'ne zaman' },
  { wrong: /(?<![\p{L}])nas[ıi]l\s*olsa(?![\p{L}])/giu, right: 'nasıl olsa' },
  { wrong: /(?<![\p{L}])hafta\s*sonu(?![\p{L}])/giu, right: 'hafta sonu' },
  { wrong: /(?<![\p{L}])[öo][ğg]leden\s*sonra(?![\p{L}])/giu, right: 'öğleden sonra' },
  { wrong: /(?<![\p{L}])ö[ğg]le\s*aras[ıi](?![\p{L}])/giu, right: 'öğle arası' },
  { wrong: /(?<![\p{L}])e\s*posta(?![\p{L}])/giu, right: 'e-posta' },
  { wrong: /(?<![\p{L}])eposta(?![\p{L}])/giu, right: 'e-posta' },
  { wrong: /(?<![\p{L}])mail\s*box(?![\p{L}])/giu, right: 'mailbox' },
];

/** Metinden atılacak gürültü karakterleri (anlam taşımayan). */
const NOISE_CHARS = /[♪♫\[\]{}<>|_*#@^~`]/g;

/**
 * Levenshtein mesafesi (iki satırlı dinamik programlama).
 *
 * Kelime uzunluğu 24'ü aşarsa hesaplanmaz (`Infinity`): uzun kelimelerde
 * mesafe-1 eşleşmesi yanlış düzeltmelere yol açar.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > 24 || b.length > 24) return Number.POSITIVE_INFINITY;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[b.length];
}

/**
 * Bir kelime için bulanık düzeltme arar.
 *
 * Yalnızca kelime uzunluğu ≥ 4 ise denenir: kısa kelimelerde ("bir", "ve")
 * mesafe-1 eşleşmesi neredeyse her zaman yanlıştır.
 */
function fuzzyFixWord(word: string, terms: string[], maxDistance: number): string | null {
  const lower = word.toLocaleLowerCase('tr');
  if (lower.length < 4) return null;

  // Uzun kelimelerde mesafe ölçeklenir: 4-6 harf → 1, 7+ harf → 2 (üst sınır).
  const allowed =
    lower.length >= 7 ? Math.min(2, Math.max(1, maxDistance)) : Math.max(1, maxDistance);

  let best: { term: string; distance: number } | null = null;
  for (const term of terms) {
    const termLower = term.toLocaleLowerCase('tr');
    if (termLower === lower) return null; // zaten doğru
    const distance = levenshtein(lower, termLower);
    if (distance <= allowed && (!best || distance < best.distance)) {
      best = { term, distance };
    }
  }

  if (!best) return null;

  // Bulunan terimin büyük/küçük harf düzenini kabaca koru.
  if (word[0] === word[0]?.toLocaleUpperCase('tr') && word[0] !== word[0]?.toLocaleLowerCase('tr')) {
    return best.term.charAt(0).toLocaleUpperCase('tr') + best.term.slice(1);
  }
  return best.term;
}

/**
 * Baştaki noktalama, tekrarlı noktalama ve çoklu boşluğu temizler.
 *
 * SONDAKİ noktalama KORUNUR: Türkçe'de anlam taşır ve tur sonu algılayıcı
 * (`punctuationEndsTurn`) bunu kullanır. Yalnızca tekrarlar ("!!!") teke
 * indirilir ve noktalama öncesi boşluk kaldırılır.
 */
function normalizeWhitespaceAndPunctuation(text: string): string {
  return text
    .replace(NOISE_CHARS, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])\1{1,}/g, '$1')
    .replace(/^[\s,.;:!?\-–—]+/, '')
    .trim();
}

/**
 * Metnin tamamı bilinen bir halüsinasyon kalıbı mı?
 */
export function isHallucination(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase('tr');
  if (!normalized) return true;
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Whisper transkriptini Türkçe için temizler ve düzeltir.
 *
 * @param raw     STT'den gelen ham metin.
 * @param options Son işleme ayarları (`STTPostprocessConfig`).
 */
export function postprocessTranscript(
  raw: string,
  options: STTPostprocessConfig = {}
): PostprocessResult {
  const cfg = {
    ...DEFAULT_POSTPROCESS,
    ...options,
    vocabulary: { ...DEFAULT_POSTPROCESS.vocabulary, ...(options.vocabulary ?? {}) },
    terms: options.terms ?? DEFAULT_POSTPROCESS.terms,
  };

  if (!cfg.enabled) {
    return { text: raw.trim(), fixes: 0, dropped: false };
  }

  let text = raw.trim();
  let fixes = 0;

  // 1) Halüsinasyon: konuşmayla ilgisiz ezber kalıplar tamamen atılır.
  if (cfg.stripHallucinations && text && isHallucination(text)) {
    logDebug('STT halüsinasyonu atıldı', { text });
    return { text: '', fixes: 1, dropped: true };
  }

  // 2) Gürültü karakterleri + boşluk/noktalama normalizasyonu.
  const normalized = normalizeWhitespaceAndPunctuation(text);
  if (normalized !== text) fixes += 1;
  text = normalized;

  if (!text) {
    return { text: '', fixes, dropped: false };
  }

  // 3) Bitişik yazım düzeltmeleri.
  if (cfg.fixSpacing) {
    for (const rule of SPACING_FIXES) {
      const next = text.replace(rule.wrong, rule.right);
      if (next !== text) {
        text = next;
        fixes += 1;
      }
    }
  }

  // 4) Sözlük (doğrudan değiştirme). Anahtarlar küçük harf; kelime sınırı yok
  //    çünkü "e posta" gibi boşluklu hatalar da hedeflenebilir.
  const vocabEntries = Object.entries(cfg.vocabulary);
  if (vocabEntries.length > 0) {
    for (const [wrong, right] of vocabEntries) {
      if (!wrong) continue;
      const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      const next = text.replace(re, right);
      if (next !== text) {
        text = next;
        fixes += 1;
      }
    }
  }

  // 5) Alan terimleri için bulanık düzeltme (kelime kelime).
  if (cfg.terms.length > 0 && cfg.fuzzyDistance > 0) {
    const words = text.split(' ');
    let changed = false;
    for (let i = 0; i < words.length; i++) {
      // Noktalama taşıyan kelimeden yalnızca harf kısmını değerlendir.
      const match = words[i].match(/^([\p{L}]+)(.*)$/u);
      if (!match) continue;
      const core = match[1];
      const suffix = match[2];
      const fixed = fuzzyFixWord(core, cfg.terms, cfg.fuzzyDistance);
      if (fixed && fixed !== core) {
        words[i] = fixed + suffix;
        changed = true;
        fixes += 1;
      }
    }
    if (changed) text = words.join(' ');
  }

  return { text: text.trim(), fixes, dropped: false };
}
