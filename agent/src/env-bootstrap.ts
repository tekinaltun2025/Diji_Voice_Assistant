/**
 * Erken ortam yükleme (env bootstrap).
 *
 * Neden ayrı bir modül: `@diji/shared` paketi `DEFAULT_AGENT_CONFIG` ve
 * `configLoader` örneklerini MODÜL YÜKLEME anında oluşturur ve bu sırada
 * `process.env` üzerinden `DIJI_TTS_*`, `DIJI_STT_*`, `DIJI_LLM_*` gibi
 * değerleri okur. `loadUserEnv()` ana giriş dosyasının `main()` fonksiyonu
 * içinde çağrıldığında, `@diji/shared` çoktan yüklenmiş olur ve
 * `~/.config/diji/env` dosyasındaki değerler **hiç okunmaz**
 * (yalnızca çalışma zamanında `process.env`'i doğrudan okuyan
 * `DIJI_TTS_ENABLED` gibi anahtarlar etkilenir).
 *
 * Çözüm: bu modül `agent/src/index.ts` içinde TÜM importlardan önce
 * yüklenir; böylece env dosyası `@diji/shared` değerlendirilmeden önce
 * `process.env`'e yazılmış olur.
 *
 * Öncelik kuralı: terminalde (veya arayüzden spawn edilirken) zaten
 * tanımlı bir değişken varsa env dosyasındaki değer onu EZMEZ.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `~/.config/diji/env` dosyasını okur: `ANAHTAR=değer` satırları.
 * - `#` ile başlayan satırlar ve boş satırlar yoksayılır.
 * - Değerdeki tek/çift tırnaklar kırpılır.
 * - Ortamda zaten tanımlı bir değişken varsa dosyadaki değer onu ezmez.
 */
export function loadUserEnv(): void {
  try {
    const file = path.join(os.homedir(), '.config', 'diji', 'env');
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      if (process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* dosya yoksa sorun değil */
  }
}

// Modül yüklenir yüklenmez çalıştır: import sırası garanti edildiği için
// `@diji/shared` değerlendirilmeden önce env hazır olur.
loadUserEnv();

export default loadUserEnv;
