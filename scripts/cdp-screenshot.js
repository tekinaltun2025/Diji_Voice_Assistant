#!/usr/bin/env node
/**
 * CDP üzerinden ekran görüntüsü alır (dokümantasyon görselleri için).
 *
 * Neden ayrı bir betik: `cdp-eval.js` yalnızca `Runtime.evaluate` yapar.
 * Belge için gerçek pencerenin görüntüsü gerekiyor; bu da
 * `Page.captureScreenshot` ile alınır. Electron'u Xvfb/`import`/`scrot` gibi
 * ekran araçlarıyla değil, kendi DevTools bağlantısı üzerinden yakalıyoruz —
 * böylece Wayland'da da çalışır ve pencerenin önde olması gerekmez.
 *
 * Kullanım:
 *   CDP_PORT=9333 node scripts/cdp-screenshot.js docs/screenshots/ui-main.png
 *   CDP_PORT=9333 node scripts/cdp-screenshot.js --list
 *   CDP_PORT=9333 node scripts/cdp-screenshot.js --click "Ayarlar" out.png
 *   CDP_PORT=9333 node scripts/cdp-screenshot.js \
 *       --click "Yeni sohbet" --click "temizle" --wait 900 out.png
 *
 * Seçenekler:
 *   --list              Yalnızca hedefleri listele ve çık.
 *   --click "<metin>"   Verilen metni içeren düğmeye tıkla. TEKRARLANABİLİR;
 *                       sırayla uygulanır (önce "Yeni sohbet", sonra "temizle").
 *   --exec  "<js>"      Görüntüden önce sayfada JS çalıştır. TEKRARLANABİLİR.
 *                       Gizlilik maskelemesi için kullanılır, ör.:
 *                         --exec "document.body.innerHTML = document.body.innerHTML
 *                                 .replace(/\\/home\\/[a-z]+/g, '~')"
 *   --width  <px>       Görünüm alanı genişliğini geçici olarak ayarla.
 *   --height <px>       Görünüm alanı yüksekliğini geçici olarak ayarla.
 *   --wait   <ms>       Görüntüden önce bekle (varsayılan 600).
 *
 * ÖNEMLİ — gizlilik: alınan görüntü kullanıcı sohbetini ve yerel dosya
 * yollarını içerebilir. Public depoya eklemeden önce "Yeni sohbet" +
 * "temizle" ile temiz bir kare alın.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9333);
const HOST = '127.0.0.1';

/** Tek bir CDP çağrısı için üst sınır — büyük ekran görüntüleri yavaş olabilir. */
const CALL_TIMEOUT_MS = 30000;

/** `/json/list` üzerinden hedefleri okur. */
function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: p, timeout: 5000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`gecersiz JSON (${p}): ${error.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('zaman asimi')));
    req.on('error', reject);
  });
}

/**
 * Minimal WebSocket istemcisi — bağımlılık eklememek için elle yazıldı.
 *
 * KRİTİK AYRINTI (ölçüldü): Chromium büyük yanıtları (ekran görüntüsü base64'ü
 * gibi) birden çok çerçeveye BÖLER — ilk çerçeve opcode 0x1, sonrakiler
 * opcode 0x0 (continuation). Yalnızca 0x1 işlendiğinde mesaj hiç tamamlanmaz
 * ve betik sonsuza kadar bekler (40 sn zaman aşımıyla doğrulandı). Bu yüzden
 * fragment'lar biriktirilip FIN bitinde birleştirilir.
 */
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl);
    const key = Buffer.from(String(Math.random())).toString('base64').slice(0, 24);
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      const pending = new Map();
      let seq = 0;
      let buffer = Buffer.alloc(0);
      /** Parçalı (continuation) çerçeve biriktiricisi. */
      let fragments = [];

      const sendFrame = (text) => {
        const payload = Buffer.from(text, 'utf8');
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.from([0x81, 0x80 | len]);
        } else if (len < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        // İstemci çerçeveleri maskelenmek ZORUNDA (RFC 6455 §5.3).
        const mask = Buffer.from([1, 2, 3, 4]);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      };

      /** Bekleyen çağrıyı sonuçlandırır (tek sefer; zamanlayıcıyı temizler). */
      const settle = (id, ok, payload) => {
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(waiter.timer);
        if (ok) waiter.resolve(payload);
        else waiter.reject(new Error(String(payload)));
      };

      const handleMessage = (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (!message || typeof message.id !== 'number') return;
        if (message.error) {
          // CDP hatası: `{ id, error: { code, message } }`
          settle(message.id, false, message.error.message || 'bilinmeyen CDP hatasi');
        } else {
          settle(message.id, true, message.result);
        }
      };

      const parse = () => {
        for (;;) {
          if (buffer.length < 2) return;
          const fin = (buffer[0] & 0x80) !== 0;
          const opcode = buffer[0] & 0x0f;
          let offset = 2;
          let len = buffer[1] & 0x7f;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buffer.length < 10) return;
            len = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + len) return;
          const payload = buffer.subarray(offset, offset + len);
          buffer = buffer.subarray(offset + len);

          if (opcode === 0x8) {
            // Kapanış çerçevesi: bekleyenleri reddet ve soketi bitir.
            for (const [id, waiter] of pending) {
              clearTimeout(waiter.timer);
              waiter.reject(new Error('CDP baglantisi kapandi'));
              pending.delete(id);
            }
            socket.end();
            return;
          }
          if (opcode === 0x9) {
            // Ping → pong (maskesiz, opcode 0xA).
            socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
            continue;
          }
          if (opcode === 0xa) continue; // pong

          if (opcode === 0x1 || opcode === 0x0) {
            fragments.push(Buffer.from(payload));
            if (!fin) continue; // devamı gelecek
            const full = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            handleMessage(full);
            continue;
          }
          // Diğer opcode'lar (binary 0x2) bu betik için gereksiz.
        }
      };

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        parse();
      });
      socket.on('error', (error) => {
        for (const [id, waiter] of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
          pending.delete(id);
        }
      });
      socket.on('close', () => {
        for (const [id, waiter] of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('CDP baglantisi kapandi'));
          pending.delete(id);
        }
      });

      resolve({
        call(method, params) {
          seq += 1;
          const id = seq;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP cagrisi zaman asimina ugradi: ${method}`));
            }, CALL_TIMEOUT_MS);
            pending.set(id, {
              resolve: res,
              reject: rej,
              timer,
            });
            sendFrame(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() {
          socket.end();
        },
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/** Argümanları ayrıştırır. */
function parseArgs(argv) {
  const out = {
    target: null,
    clicks: [],
    execs: [],
    width: null,
    height: null,
    wait: 600,
    list: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') out.list = true;
    else if (arg === '--click') out.clicks.push(argv[++i]);
    else if (arg === '--exec') out.execs.push(argv[++i]);
    else if (arg === '--width') out.width = Number(argv[++i]);
    else if (arg === '--height') out.height = Number(argv[++i]);
    else if (arg === '--wait') out.wait = Number(argv[++i]);
    else rest.push(arg);
  }
  out.target = rest[0] || 'docs/screenshots/ui-main.png';
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = await httpJson('/json/list');
  const pages = (targets || []).filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://')
  );

  if (args.list) {
    if (pages.length === 0) console.log('(sayfa hedefi yok)');
    for (const page of pages) console.log(`${page.title}  ${page.url}`);
    return;
  }
  if (pages.length === 0) {
    throw new Error('CDP sayfa hedefi bulunamadi (Electron --remote-debugging-port ile acik mi?)');
  }

  // Uygulama sayfasını seç: `app://` veya localhost tercih edilir.
  const page =
    pages.find((p) => String(p.url).startsWith('app://')) ||
    pages.find((p) => String(p.url).includes('localhost')) ||
    pages[0];

  const conn = await wsConnect(page.webSocketDebuggerUrl);
  try {
    await conn.call('Page.enable');
    await conn.call('Runtime.enable');

    if (args.width && args.height) {
      await conn.call('Emulation.setDeviceMetricsOverride', {
        width: args.width,
        height: args.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    for (const label of args.clicks) {
      // Düğme metniyle tıkla; id yok, `innerText` eşleşmesi yeterli.
      // Önce TAM eşleşme, sonra "içerir": "temizle" gibi kısa etiketler başka
      // bir düğmenin metniyle çakışabilir.
      const expr = `(() => {
        const wanted = ${JSON.stringify(String(label))};
        const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const target = wanted.toLowerCase();
        const hit =
          els.find((el) => norm(el.innerText) === target) ||
          els.find((el) => norm(el.innerText).includes(target));
        if (!hit) return { ok: false, count: els.length };
        hit.click();
        return { ok: true, text: (hit.innerText || '').replace(/\\s+/g, ' ').trim() };
      })()`;
      const r = await conn.call('Runtime.evaluate', { expression: expr, returnByValue: true });
      const value = r.result && r.result.value;
      if (!value || !value.ok) {
        throw new Error(
          `tikanacak dugme bulunamadi: "${label}" (${value ? value.count : 0} dugme tarandi)`
        );
      }
      console.log(`tiklandi: ${value.text}`);
      await new Promise((res) => setTimeout(res, 400));
    }

    for (const code of args.execs) {
      const r = await conn.call('Runtime.evaluate', {
        expression: String(code),
        returnByValue: true,
        awaitPromise: false,
      });
      if (r && r.exceptionDetails) {
        throw new Error(
          `--exec basarisiz: ${r.exceptionDetails.text || 'bilinmeyen hata'}`
        );
      }
      console.log('calistirildi: exec');
      await new Promise((res) => setTimeout(res, 250));
    }

    await new Promise((res) => setTimeout(res, Math.max(0, args.wait)));

    const shot = await conn.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    if (!shot || !shot.data) throw new Error('screenshot verisi donmedi');

    const outPath = path.resolve(process.cwd(), args.target);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    const size = fs.statSync(outPath).size;
    console.log(`yazildi: ${outPath} (${(size / 1024).toFixed(0)} KB)`);
  } finally {
    conn.close();
  }
}

main().catch((error) => {
  console.error('HATA:', error.message);
  process.exit(1);
});
