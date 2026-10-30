/**
 * Kalıcı tercih yazımı — `~/.config/diji/env` dosyası.
 *
 * Neden env dosyası, neden `config.json` değil:
 *
 *   Ajan yapılandırması [`env-bootstrap.ts`](agent/src/env-bootstrap.ts:1)
 *   içinde EN ERKEN aşamada `~/.config/diji/env` dosyasından okunur ve
 *   `@diji/shared` modülü yüklenirken `DEFAULT_AGENT_CONFIG` bu değerlerle
 *   üretilir. Yani bu dosyaya yazılan bir anahtar, ajan yeniden başladığında
 *   **hiçbir ek kod çalışmadan** etkili olur. `config.json` yolu ise
 *   `process.cwd()`'ye bağlıdır ve uygulama farklı bir dizinden
 *   başlatıldığında bulunamaz.
 *
 * Davranış sözleşmesi:
 *   - Dosya yoksa oluşturulur (`~/.config/diji/` dizini dahil).
 *   - **Yorumlar ve ilgisiz anahtarlar korunur** — dosya satır satır işlenir,
 *     baştan yazılmaz.
 *   - Aynı anahtar birden fazla kez geçiyorsa HEPSİ güncellenir (env okuyucu
 *     son değeri kullanacağı için tekilleştirme şart).
 *   - Yazma **atomiktir**: geçici dosyaya yazılıp `rename` ile yerine konur.
 *     Yarıda kesilen bir yazma mevcut ayarları bozmaz.
 *   - Dosya izni `0600`: içinde API anahtarı gibi değerler olabilir.
 *   - Fonksiyonlar **fırlatmaz**; sonucu `{ ok, path, error }` olarak döner.
 *     Model seçimi başarılı olduğu halde kalıcılık yazılamazsa ajan çalışmaya
 *     devam etmeli, arayüz de bunu dürüstçe göstermelidir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logInfo, logWarn } from '@diji/shared';

/** `loadUserEnv()` ile aynı konum — tek doğruluk kaynağı. */
export function envFilePath(): string {
  return path.join(os.homedir(), '.config', 'diji', 'env');
}

/**
 * Uzak LLM saglayicisinin API anahtarinin tutuldugu dosya.
 *
 * Neden `env` dosyasina YAZILMIYOR: `~/.config/diji/env` kullanicinin
 * duzenledigi, yedekledigi ve bazen paylastigi bir dosya. Depo PUBLIC
 * oldugu icin anahtarin oraya sizmasi gercek bir risk. Bu dosya ayri
 * tutulur, dizini `0700`, kendisi `0600` olur ve `.gitignore` kapsamindadir
 * (`~/.config` depo disinda oldugu icin zaten takip edilmez).
 */
export function apiKeyFilePath(provider: string): string {
  return path.join(os.homedir(), '.config', 'diji', 'secrets', `${provider}.key`);
}

export interface ApiKeyWriteResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * API anahtarini 0600 izinli ayri dosyaya yazar.
 *
 * Bos anahtar "sil" anlamina gelir: dosya kaldirilir ve `ok:true` doner.
 * Boylece kullanici anahtari temizleyerek uzak saglayiciyi devre disi
 * birakabilir.
 */
export function writeApiKeyFile(provider: string, key: string): ApiKeyWriteResult {
  const file = apiKeyFilePath(provider);
  const trimmed = String(key ?? '').trim();

  try {
    if (!trimmed) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      logInfo('API anahtari silindi', { provider, file });
      return { ok: true, path: file };
    }

    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Gecici dosya + rename: yarida kesilen yazma eski anahtari bozmaz.
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, trimmed, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    // `rename` var olan dosyanin modunu koruyabilir; acikca daraltilir.
    fs.chmodSync(file, 0o600);

    logInfo('API anahtari yazildi', { provider, file, length: trimmed.length });
    return { ok: true, path: file };
  } catch (error) {
    logWarn('API anahtari yazilamadi', { provider, file, error: (error as Error).message });
    return { ok: false, path: file, error: (error as Error).message };
  }
}

/**
 * API anahtarini dosyadan okur. Dosya yoksa bos dize doner (firlatmaz) —
 * cagiran taraf "anahtar yok" durumunu normal akis olarak ele alir.
 */
export function readApiKeyFile(provider: string): string {
  try {
    const file = apiKeyFilePath(provider);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Anahtarin var olup olmadigi (icerigi sizdirmadan) — arayuz icin. */
export function hasApiKeyFile(provider: string): boolean {
  return readApiKeyFile(provider).length > 0;
}

export interface EnvWriteResult {
  ok: boolean;
  /** Yazılan dosya (teşhis için arayüzde gösterilir). */
  path: string;
  /** `ok:false` ise nedeni. */
  error?: string;
  /** Yeni eklenen / değişen anahtarlar. */
  changed: string[];
}

/**
 * Birden çok anahtarı tek geçişte yazar.
 *
 * Neden toplu: TTS seçimi iki anahtarı birlikte değiştirir
 * (`DIJI_TTS_PROVIDER` + `DIJI_TTS_VITS_MODEL`). İki ayrı yazma, arada oluşan
 * bir hata durumunda yarım kalmış (tutarsız) bir yapılandırma bırakırdı.
 */
export function writeEnvVars(updates: Record<string, string>): EnvWriteResult {
  const file = envFilePath();
  const keys = Object.keys(updates).filter((key) => /^[A-Za-z0-9_]+$/.test(key));
  const changed: string[] = [];

  if (keys.length === 0) {
    return { ok: true, path: file, changed };
  }

  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    let lines: string[] = [];
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } else {
      // Dosya ilk kez oluşturuluyorsa niyeti açıkça yaz.
      lines = ['# Diji kalıcı ayarları (Ayarlar ekranından yönetilir)'];
    }

    const seen = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      // Yorum ve boş satırlara dokunma.
      if (/^\s*#/.test(line)) continue;

      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (!match) continue;

      const key = match[1];
      if (!(key in updates)) continue;

      lines[index] = `${key}=${formatValue(updates[key])}`;
      seen.add(key);
      changed.push(key);
    }

    // Dosyada olmayan anahtarları sona ekle. Sondaki boş satırı koru.
    const missing = keys.filter((key) => !seen.has(key));
    if (missing.length > 0) {
      const trailing = lines.length > 0 && lines[lines.length - 1].trim() === '';
      if (trailing) lines.pop();
      for (const key of missing) {
        lines.push(`${key}=${formatValue(updates[key])}`);
        changed.push(key);
      }
      lines.push('');
    }

    const content = lines.join('\n');
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);

    logInfo('Kalici ayar yazildi', { file, keys: changed });
    return { ok: true, path: file, changed };
  } catch (error) {
    logWarn('Kalici ayar yazilamadi', { file, error: (error as Error).message });
    return { ok: false, path: file, error: (error as Error).message, changed };
  }
}

/**
 * Değeri env formatına çevirir.
 *
 * Boşluk içeren değer tırnaklanır — `loadUserEnv()` tırnakları kırptığı için
 * tur-gidiş (round-trip) kayıpsızdır.
 */
function formatValue(value: string): string {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (clean === '') return '';
  return /[\s#"'`$\\]/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
}
