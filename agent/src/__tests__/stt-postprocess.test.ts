import {
  isHallucination,
  levenshtein,
  postprocessTranscript,
} from '../stt-postprocess';

/**
 * Türkçe STT son işleme testleri.
 *
 * Odak: Whisper'ın Türkçe'de ürettiği SOMUT hata örnekleri. Her test gerçek
 * bir gözlemden türetilmiştir; soyut "metin değişti mi" kontrolü yapılmaz.
 */
describe('levenshtein', () => {
  it('aynı kelimeler için 0 döner', () => {
    expect(levenshtein('takvim', 'takvim')).toBe(0);
  });

  it('tek karakter değişimini 1 olarak ölçer', () => {
    expect(levenshtein('takdim', 'takvim')).toBe(1);
  });

  it('ekleme/silmeyi doğru ölçer', () => {
    expect(levenshtein('gmal', 'gmail')).toBe(1);
    expect(levenshtein('takvimi', 'takvim')).toBe(1);
  });

  it('çok uzun kelimelerde hesaplamaz (yanlış eşleşmeyi önler)', () => {
    expect(levenshtein('a'.repeat(30), 'b'.repeat(30))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('isHallucination', () => {
  it('Whisper halüsinasyon kalıplarını yakalar', () => {
    expect(isHallucination('İzlediğiniz için teşekkürler.')).toBe(true);
    expect(isHallucination('Altyazı M.K.')).toBe(true);
    expect(isHallucination('Abone olmayı unutmayın!')).toBe(true);
    expect(isHallucination('Thanks for watching!')).toBe(true);
    expect(isHallucination('...')).toBe(true);
    expect(isHallucination('♪♪')).toBe(true);
  });

  it('gerçek konuşmayı halüsinasyon saymaz', () => {
    expect(isHallucination('Yarın için bir hatırlatıcı oluştur')).toBe(false);
    expect(isHallucination('Gmail kutusunda yeni ne var')).toBe(false);
  });
});

describe('postprocessTranscript', () => {
  it('halüsinasyon metnini tamamen atar', () => {
    const result = postprocessTranscript('İzlediğiniz için teşekkürler.');
    expect(result.text).toBe('');
    expect(result.dropped).toBe(true);
  });

  it('bitişik yazım hatalarını düzeltir', () => {
    const result = postprocessTranscript('birşey söyleyeceğim herşey yolunda');
    expect(result.text).toBe('bir şey söyleyeceğim her şey yolunda');
    expect(result.fixes).toBeGreaterThan(0);
  });

  it('"hiçbirşey" kalıbını düzeltir', () => {
    const result = postprocessTranscript('hiçbirşey yapmadım');
    expect(result.text).toBe('hiçbir şey yapmadım');
  });

  it('"şu anda" yazımını düzeltir', () => {
    const result = postprocessTranscript('şuanda meşgulüm');
    expect(result.text).toBe('şu anda meşgulüm');
  });

  it('alan terimlerini bulanık eşleşmeyle düzeltir', () => {
    const result = postprocessTranscript('takdim uygulamasını aç', {
      terms: ['takvim'],
      fuzzyDistance: 1,
    });
    expect(result.text).toBe('takvim uygulamasını aç');
  });

  it('sözlük (doğrudan değiştirme) uygular', () => {
    const result = postprocessTranscript('cı meyl kutusunu aç', {
      vocabulary: { 'cı meyl': 'gmail' },
    });
    expect(result.text).toBe('gmail kutusunu aç');
  });

  it('gürültü karakterlerini ve fazla noktalamayı temizler', () => {
    const result = postprocessTranscript('  [müzik]  selam!!!  ');
    expect(result.text).toBe('müzik selam!');
  });

  it('Türkçe karakterleri ASCIIye çevirmez', () => {
    const result = postprocessTranscript('ışık şiddetini artır');
    expect(result.text).toBe('ışık şiddetini artır');
  });

  it('kısa kelimelerde bulanık düzeltme yapmaz (yanlış eşleşme koruması)', () => {
    const result = postprocessTranscript('bir iki üç', {
      terms: ['birim'],
      fuzzyDistance: 1,
    });
    // "bir" (3 harf) → bulanık eşleşme denenmez.
    expect(result.text).toBe('bir iki üç');
  });

  it('enabled=false iken ham metni (kırpılmış) döndürür', () => {
    const result = postprocessTranscript('  birşey  ', { enabled: false });
    expect(result.text).toBe('birşey');
    expect(result.fixes).toBe(0);
  });

  it('boş metinde çökmez', () => {
    const result = postprocessTranscript('');
    expect(result.text).toBe('');
    expect(result.dropped).toBe(false);
  });
});
