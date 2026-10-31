"use strict";
/**
 * Yazılımsal yankı kapılaması testleri.
 *
 * NEDEN BU TESTLER KRİTİK: Bu sınıfın hatalı olması iki uç sonuç üretir —
 * (a) asistan kendi sesini kullanıcı sanıp her cümlede kendini keser
 * (sonsuz sessizlik), (b) gerçek kullanıcı yankı sanılıp hiç duyulmaz
 * (barge-in asla çalışmaz). İkisi de saha testinde "bazen çalışıyor" gibi
 * görünür, bu yüzden karar tablosu burada tek tek sabitlenir.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const echo_guard_1 = require("../echo-guard");
/** PCM16 LE tampon üretir (testlerde referans kaydı için). */
function makePcm(samples) {
    const buffer = Buffer.alloc(samples.length * 2);
    samples.forEach((value, index) => {
        buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2);
    });
    return buffer;
}
describe('EchoGuard — karar tablosu', () => {
    it('sinyal yoksa hiçbir karar vermez (zayif-sinyal)', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.5);
        const decision = guard.evaluate({ rms: 0.001, atMs: 1010, vadSpeaking: false });
        expect(decision.suppressed).toBe(false);
        expect(decision.bargeIn).toBe(false);
        expect(decision.reason).toBe('zayif-sinyal');
    });
    it('referans yokken bastırmaz (asistan gerçekten susuyor)', () => {
        const guard = new echo_guard_1.EchoGuard();
        const decision = guard.evaluate({ rms: 0.09, atMs: 5000, vadSpeaking: true });
        expect(decision.suppressed).toBe(false);
        expect(decision.bargeIn).toBe(false);
        expect(decision.reason).toBe('referans-yok');
    });
    it('beklenen yankı seviyesindeki parçayı bastırır', () => {
        const guard = new echo_guard_1.EchoGuard();
        // Beklenen yankı = 0,4 × 0,35 = 0,14
        guard.recordReferenceRms(1000, 0.4);
        const decision = guard.evaluate({ rms: 0.14, atMs: 1010, vadSpeaking: true });
        expect(decision.suppressed).toBe(true);
        expect(decision.bargeIn).toBe(false);
        expect(decision.reason).toBe('yanki');
    });
    it('yankı beklenenden yüksek çıksa bile tolerans içindeyse bastırır', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.4);
        // Beklenen 0,14; tolerans 1,6 → 0,224'e kadar hâlâ yankı.
        const decision = guard.evaluate({ rms: 0.2, atMs: 1010, vadSpeaking: true });
        expect(decision.suppressed).toBe(true);
        expect(decision.bargeIn).toBe(false);
    });
    it('yüksek oran + VAD konuşma → barge-in, bastırma yok', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.4);
        // Beklenen 0,14; barge marjı 3,2 → 0,448 üstü kullanıcı.
        const decision = guard.evaluate({ rms: 0.6, atMs: 1010, vadSpeaking: true });
        expect(decision.bargeIn).toBe(true);
        expect(decision.suppressed).toBe(false);
        expect(decision.reason).toBe('kullanici');
    });
    it('yüksek oran ama VAD sessiz → bastırır (kapı çarpması kullanıcı değildir)', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.4);
        const decision = guard.evaluate({ rms: 0.6, atMs: 1010, vadSpeaking: false });
        expect(decision.bargeIn).toBe(false);
        expect(decision.suppressed).toBe(true);
        expect(decision.reason).toBe('yanki');
    });
    it('ara bölge güvenli tarafa (bastırma) düşer', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.4);
        // Oran ≈ 2,5: toleransın (1,6) üstünde, barge marjının (3,2) altında.
        const decision = guard.evaluate({ rms: 0.35, atMs: 1010, vadSpeaking: true });
        expect(decision.bargeIn).toBe(false);
        expect(decision.suppressed).toBe(true);
    });
});
describe('EchoGuard — gecikme penceresi', () => {
    it('pencere içindeki EN YÜKSEK referansı kullanır', () => {
        const guard = new echo_guard_1.EchoGuard();
        // Aynı pencerede zayıf ve güçlü referans: güçlü olan kazanmalı.
        guard.recordReferenceRms(1000, 0.05);
        guard.recordReferenceRms(1050, 0.5);
        const decision = guard.evaluate({ rms: 0.05, atMs: 1100, vadSpeaking: true });
        // Beklenen = 0,5 × 0,35 = 0,175 → 0,05 bunun çok altında, yankı.
        expect(decision.expectedEcho).toBeCloseTo(0.175, 4);
        expect(decision.suppressed).toBe(true);
    });
    it('pencere dışındaki referansı yok sayar', () => {
        const guard = new echo_guard_1.EchoGuard({ windowMs: 240 });
        guard.recordReferenceRms(1000, 0.5);
        // 1000 + 240 = 1240 sınırı; 1500 pencere dışı.
        const decision = guard.evaluate({ rms: 0.2, atMs: 1500, vadSpeaking: true });
        expect(decision.reason).toBe('referans-yok');
        expect(decision.suppressed).toBe(false);
    });
    it('referans kaydı aynı zaman kovasında en yüksek değeri tutar', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.1);
        guard.recordReferenceRms(1000, 0.6);
        guard.recordReferenceRms(1000, 0.3);
        const decision = guard.evaluate({ rms: 0.01, atMs: 1000, vadSpeaking: false });
        expect(decision.expectedEcho).toBeCloseTo(0.6 * echo_guard_1.DEFAULT_ECHO_GUARD_CONFIG.initialGain, 4);
    });
});
describe('EchoGuard — kazanç adaptasyonu', () => {
    it('yankı beklenenden zayıfsa kazancı düşürür', () => {
        const guard = new echo_guard_1.EchoGuard();
        const before = guard.getStats().gain;
        // Tekrarlanan zayıf yankı: oran ≈ 0,5.
        for (let i = 0; i < 8; i++) {
            const at = 1000 + i * 100;
            guard.recordReferenceRms(at, 0.4);
            guard.evaluate({ rms: 0.07, atMs: at + 10, vadSpeaking: false });
        }
        expect(guard.getStats().gain).toBeLessThan(before);
    });
    it('kullanıcı konuşması kazancı ARTIRMAZ (kullanıcı kalıcı silinmemeli)', () => {
        const guard = new echo_guard_1.EchoGuard();
        const before = guard.getStats().gain;
        for (let i = 0; i < 8; i++) {
            const at = 1000 + i * 100;
            guard.recordReferenceRms(at, 0.4);
            guard.evaluate({ rms: 0.8, atMs: at + 10, vadSpeaking: true });
        }
        expect(guard.getStats().gain).toBe(before);
    });
    it('kazanç alt sınırın altına inmez', () => {
        const guard = new echo_guard_1.EchoGuard({ minGain: 0.1 });
        for (let i = 0; i < 40; i++) {
            const at = 1000 + i * 100;
            guard.recordReferenceRms(at, 0.9);
            guard.evaluate({ rms: 0.01, atMs: at + 10, vadSpeaking: false });
        }
        expect(guard.getStats().gain).toBeGreaterThanOrEqual(0.1);
    });
    it('kazanç üst sınırın üstüne çıkmaz', () => {
        const guard = new echo_guard_1.EchoGuard({ maxGain: 0.5 });
        for (let i = 0; i < 40; i++) {
            const at = 1000 + i * 100;
            guard.recordReferenceRms(at, 0.9);
            guard.evaluate({ rms: 0.01, atMs: at + 10, vadSpeaking: false });
        }
        expect(guard.getStats().gain).toBeLessThanOrEqual(0.5);
    });
});
describe('EchoGuard — yaşam döngüsü', () => {
    it('clearReference sonrası referans yoktur', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.5);
        guard.clearReference();
        const decision = guard.evaluate({ rms: 0.2, atMs: 1010, vadSpeaking: true });
        expect(decision.reason).toBe('referans-yok');
    });
    it('reset kazancı ve sayaçları başlangıca döndürür', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReferenceRms(1000, 0.4);
        guard.evaluate({ rms: 0.01, atMs: 1010, vadSpeaking: false });
        expect(guard.getStats().suppressed).toBeGreaterThan(0);
        guard.reset();
        const stats = guard.getStats();
        expect(stats.gain).toBeCloseTo(echo_guard_1.DEFAULT_ECHO_GUARD_CONFIG.initialGain, 6);
        expect(stats.suppressed).toBe(0);
        expect(stats.bargeIn).toBe(0);
        expect(stats.referenceBuckets).toBe(0);
    });
    it('halka tampon kapasitesi sabit kalır (bellek şişmez)', () => {
        const guard = new echo_guard_1.EchoGuard({ windowMs: 240 });
        for (let i = 0; i < 500; i++) {
            guard.recordReferenceRms(1000 + i * 20, 0.3);
        }
        // 240/20 + 2 = 14 kova; pencere dışı temizlenir.
        expect(guard.getStats().referenceBuckets).toBeLessThanOrEqual(16);
    });
});
describe('EchoGuard.computePcm16Rms', () => {
    it('sessiz tampon için 0 döner', () => {
        expect(echo_guard_1.EchoGuard.computePcm16Rms(makePcm([0, 0, 0, 0]))).toBe(0);
    });
    it('tam ölçekli kare dalga için ≈1 döner', () => {
        const rms = echo_guard_1.EchoGuard.computePcm16Rms(makePcm([1, -1, 1, -1]));
        expect(rms).toBeCloseTo(1, 3);
    });
    it('boş tampon için 0 döner', () => {
        expect(echo_guard_1.EchoGuard.computePcm16Rms(Buffer.alloc(0))).toBe(0);
    });
    it('tek baytlık tampon için 0 döner (yarım örnek)', () => {
        expect(echo_guard_1.EchoGuard.computePcm16Rms(Buffer.alloc(1))).toBe(0);
    });
});
describe('EchoGuard — referans PCM üzerinden', () => {
    it('PCM tamponundan RMS hesaplayıp referansa yazar', () => {
        const guard = new echo_guard_1.EchoGuard();
        // 0,5 genlikli sinüs benzeri örnekler.
        const pcm = makePcm([0.5, -0.5, 0.5, -0.5]);
        guard.recordReference(1000, pcm, 16000);
        const decision = guard.evaluate({ rms: 0.01, atMs: 1010, vadSpeaking: false });
        expect(decision.expectedEcho).toBeCloseTo(0.5 * echo_guard_1.DEFAULT_ECHO_GUARD_CONFIG.initialGain, 4);
    });
    it('çok kısa PCM tamponunu yok sayar', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReference(1000, Buffer.alloc(1), 16000);
        const decision = guard.evaluate({ rms: 0.2, atMs: 1010, vadSpeaking: true });
        expect(decision.reason).toBe('referans-yok');
    });
});
/*
 * REGRESYON — "referans yazıldığı anda ölür" kusuru.
 *
 * İlk sürümde PCM, hoparlöre verildiği ANDA tek zaman damgasıyla kaydedilir
 * ve pencere (240 ms) dolduğunda düşerdi. Oysa o PCM saniyelerce çalar.
 * Sonuç: bastırma sessizce devre dışı kalıyordu — asistan kendini kesmiyordu
 * çünkü korunmuyordu, sadece hiçbir şey yapılmıyordu.
 */
describe('EchoGuard — referans çalma süresi boyunca geçerli', () => {
    /** 1 saniyelik 16 kHz PCM (16000 örnek × 2 bayt). */
    function oneSecondPcm(amplitude) {
        const sampleCount = 16000;
        const pcm = Buffer.alloc(sampleCount * 2);
        for (let i = 0; i < sampleCount; i++) {
            pcm.writeInt16LE(Math.round(amplitude * 32767), i * 2);
        }
        return pcm;
    }
    it('1 sn PCM, yazıldıktan 900 ms sonra bile referans verir', () => {
        const guard = new echo_guard_1.EchoGuard();
        // Uzun PCM 1000 ms'de yazıldı: 1 saniye boyunca çalar.
        guard.recordReference(1000, oneSecondPcm(0.5), 16000);
        // Pencere (240 ms) çoktan geçti ama ses HÂLÂ çalıyor.
        const decision = guard.evaluate({ rms: 0.05, atMs: 1900, vadSpeaking: false });
        expect(decision.reason).not.toBe('referans-yok');
        expect(decision.expectedEcho).toBeGreaterThan(0);
    });
    it('çalma bittikten ve pencere geçtikten sonra referans ölür', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReference(1000, oneSecondPcm(0.5), 16000);
        // Çalma 2000 ms'de bitti; 240 ms pencere + pay sonrası referans yok.
        const decision = guard.evaluate({ rms: 0.05, atMs: 2400, vadSpeaking: false });
        expect(decision.reason).toBe('referans-yok');
    });
    it('asistan susunca (referans yok) kullanıcı bastırılmaz', () => {
        const guard = new echo_guard_1.EchoGuard();
        const decision = guard.evaluate({ rms: 0.5, atMs: 5000, vadSpeaking: true });
        expect(decision.suppressed).toBe(false);
        expect(decision.reason).toBe('referans-yok');
    });
    it('uzun yankı sırasında kullanıcı sesi hâlâ barge-in sayılır', () => {
        const guard = new echo_guard_1.EchoGuard();
        guard.recordReference(1000, oneSecondPcm(0.2), 16000);
        // expectedEcho = 0.2 × 0.35 = 0.07; 0.5 / 0.07 ≈ 7,1 → barge marjının üstü.
        const decision = guard.evaluate({ rms: 0.5, atMs: 1500, vadSpeaking: true });
        expect(decision.reason).toBe('kullanici');
        expect(decision.bargeIn).toBe(true);
    });
});
describe('EchoGuard.pcmDurationMs', () => {
    it('16 kHz mono PCM16 için süreyi doğru hesaplar', () => {
        // 16000 örnek = 1 saniye.
        expect(echo_guard_1.EchoGuard.pcmDurationMs(Buffer.alloc(32000), 16000)).toBeCloseTo(1000, 3);
    });
    it('geçersiz örnekleme oranında 0 döner', () => {
        expect(echo_guard_1.EchoGuard.pcmDurationMs(Buffer.alloc(32000), 0)).toBe(0);
    });
    it('boş tampon için 0 döner', () => {
        expect(echo_guard_1.EchoGuard.pcmDurationMs(Buffer.alloc(0), 16000)).toBe(0);
    });
});
//# sourceMappingURL=echo-guard.test.js.map