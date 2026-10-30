#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol istemcisi (bağımlılıksız).
 *
 * Electron'u `--remote-debugging-port=9222` ile başlatıp arayüzün GERÇEKTEN
 * çizildiğini ve telemetri satırlarının canlı güncellendiğini doğrulamak için
 * kullanılır. `ws` paketi kurulu olmadığından WebSocket el sıkışması ve
 * çerçeveleme burada kendimiz yapılır.
 *
 * Kullanım:
 *   node scripts/cdp-eval.js "<js ifadesi>"
 *   node scripts/cdp-eval.js --targets
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DEBUG_PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: DEBUG_PORT, path }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`JSON çözümlenemedi: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

/** ws://host:port/path adresine basit WebSocket istemcisi açar. */
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
          `Host: ${url.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    socket.on('error', reject);

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);

    const sendFrame = (text) => {
      const payload = Buffer.from(text, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      header[0] = 0x81; // FIN + text
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    };

    const messages = [];
    const waiters = [];

    const onMessage = (msg) => {
      const w = waiters.shift();
      if (w) w(msg);
      else messages.push(msg);
    };

    const parse = () => {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (masked) offset += 4;
        if (buffer.length < offset + len) return;
        const payload = buffer.subarray(offset, offset + len);
        buffer = buffer.subarray(offset + len);
        if (opcode === 0x1) onMessage(payload.toString('utf8'));
        else if (opcode === 0x8) return;
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buffer.subarray(0, idx).toString('utf8');
        buffer = buffer.subarray(idx + 4);
        if (!/101/.test(head.split('\r\n')[0])) {
          reject(new Error(`WebSocket el sıkışması başarısız: ${head.split('\r\n')[0]}`));
          return;
        }
        handshakeDone = true;
        resolve({
          send: sendFrame,
          next: () =>
            new Promise((res) => {
              if (messages.length) res(messages.shift());
              else waiters.push(res);
            }),
          close: () => socket.end(),
        });
        parse();
        return;
      }
      parse();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const targets = await httpJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('sayfa hedefi bulunamadı');
  if (args[0] === '--targets') {
    console.log(JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url, title: t.title })), null, 1));
    return;
  }

  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const call = async (method, params) => {
    id += 1;
    const myId = id;
    ws.send(JSON.stringify({ id: myId, method, params }));
    for (;;) {
      const raw = await ws.next();
      const msg = JSON.parse(raw);
      if (msg.id === myId) return msg;
    }
  };

  const expression = args.join(' ') || 'document.title';
  if (args[0] === '--shot') {
    const out = args[1] || '/tmp/diji-shot.png';
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    const data = shot.result?.data;
    if (!data) throw new Error('ekran görüntüsü alınamadı');
    require('fs').writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(out);
    ws.close();
    return;
  }

  const result = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const value = result.result?.result?.value;
  const description = result.result?.result?.description;
  if (result.result?.exceptionDetails) {
    console.error('İSTİSNA:', JSON.stringify(result.result.exceptionDetails, null, 1));
    process.exit(1);
  }
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1) ?? description);
  ws.close();
}

main().catch((e) => {
  console.error('CDP hatası:', e.message);
  process.exit(1);
});
