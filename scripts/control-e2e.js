#!/usr/bin/env node
/**
 * Kontrol sunucusu uçtan uca testi:
 *  1) /events SSE akışına abone ol
 *  2) POST /ask ile gerçek bir tur başlat (STT atlanır, LLM+TTS+oynatma çalışır)
 *  3) Aşama geçişlerini ve günlük kayıtlarını sırayla yazdır
 *
 * Kullanım: node scripts/control-e2e.js "Merhaba, kendini kısaca tanıt"
 */
const http = require('http');

const PORT = Number(process.env.DIJI_CONTROL_PORT || 8899);
const TEXT = process.argv[2] || 'Merhaba, kendini kisaca tanit';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120000);

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

let seenLlmDone = false;
let seenTtsDone = false;
const transitions = [];
let req;

function maybeFinish() {
  if (seenLlmDone && seenTtsDone) {
    setTimeout(() => {
      console.log('\n=== ÖZET ===');
      for (const line of transitions) console.log(line);
      console.log(`\nLLM tamam: ${seenLlmDone}, TTS tamam: ${seenTtsDone}`);
      process.exit(0);
    }, 500);
  }
}

req = http.get({ host: '127.0.0.1', port: PORT, path: '/events' }, (res) => {
  console.log(`SSE bağlandı (${res.statusCode})`);
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      let evt;
      try {
        evt = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      if (evt.type === 'stage') {
        const m = Object.entries(evt.state.metrics || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        const line = `[${ts()}] ${evt.state.key.padEnd(8)} ${evt.state.status.padEnd(6)} ${evt.state.detail}${m ? '  {' + m + '}' : ''}`;
        // yalnızca durum değişimlerini yaz (vad her parçada güncelleniyor)
        const prev = transitions.filter((l) => l.includes(` ${evt.state.key.padEnd(8)} `)).pop();
        const sig = `${evt.state.status}|${evt.state.detail}`;
        if (!prev || !prev.includes(sig)) {
          transitions.push(line);
          console.log(line);
        }
        if (evt.state.key === 'llm' && evt.state.status === 'ready') seenLlmDone = true;
        if (evt.state.key === 'tts' && evt.state.status === 'ready') seenTtsDone = true;
        maybeFinish();
      } else if (evt.type === 'log') {
        const line = `[${ts()}] LOG ${evt.entry.level.toUpperCase().padEnd(5)} ${evt.entry.stage.padEnd(8)} ${evt.entry.msg}`;
        transitions.push(line);
        console.log(line);
      }
    }
  });
  res.on('end', () => console.log('SSE kapandı'));

  // Abone olduktan sonra turu başlat
  const body = JSON.stringify({ text: TEXT });
  const post = http.request(
    { host: '127.0.0.1', port: PORT, path: '/ask', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (r) => {
      let out = '';
      r.on('data', (d) => (out += d));
      r.on('end', () => console.log(`POST /ask -> ${r.statusCode} ${out}`));
    }
  );
  post.on('error', (e) => console.error('POST hatası', e.message));
  post.end(body);
});

req.on('error', (e) => {
  console.error('SSE bağlantı hatası:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error(`\nZAMAN AŞIMI (${TIMEOUT_MS} ms) — llm=${seenLlmDone} tts=${seenTtsDone}`);
  for (const line of transitions) console.error(line);
  process.exit(2);
}, TIMEOUT_MS);
