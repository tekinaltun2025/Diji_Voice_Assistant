#!/usr/bin/env node
/**
 * Mikrofon yerine dosyadan PCM besleyerek VAD + STT + LLM + TTS hattını
 * uçtan uca doğrular.
 *
 * Kullanım:
 *   node scripts/inject-e2e.js <pcm-dosyasi>      # 16 kHz mono PCM16 (ham)
 *
 * Beklenen olay sırası: vad-speech-start → stt-final → llm-complete → tts-complete
 */
const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.DIJI_CONTROL_PORT || 8899);
const file = process.argv[2];
if (!file) {
  console.error('kullanım: node scripts/inject-e2e.js <pcm-dosyasi>');
  process.exit(1);
}
const pcm = fs.readFileSync(file);
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const seen = new Set();

function check() {
  if (seen.has('stt') && seen.has('llm') && seen.has('tts')) {
    setTimeout(() => {
      console.log('\nSONUÇ: VAD ✓  STT ✓  LLM ✓  TTS ✓');
      process.exit(0);
    }, 800);
  }
}

const req = http.get({ host: '127.0.0.1', port: PORT, path: '/events' }, (res) => {
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (evt.type === 'log') {
        console.log(`[${ts()}] LOG ${evt.entry.stage}: ${evt.entry.msg}`);
        if (evt.entry.stage === 'stt' && evt.entry.msg.startsWith('duyulan:')) {
          seen.add('stt');
          check();
        }
        if (evt.entry.stage === 'llm' && evt.entry.msg.startsWith('yanıt tamam')) {
          seen.add('llm');
          check();
        }
        if (evt.entry.stage === 'tts' && evt.entry.msg.startsWith('ses tamam')) {
          seen.add('tts');
          check();
        }
      } else if (evt.type === 'stage' && evt.state.status !== 'active') {
        console.log(`[${ts()}] ${evt.state.key}=${evt.state.status} ${evt.state.detail}`);
      }
    }
  });

  const post = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/inject',
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': pcm.length },
    },
    (r) => {
      let out = '';
      r.on('data', (d) => (out += d));
      r.on('end', () => console.log(`POST /inject -> ${r.statusCode} ${out}`));
    }
  );
  post.on('error', (e) => console.error('POST hatası', e.message));
  post.end(pcm);
});

req.on('error', (e) => {
  console.error('SSE bağlantı hatası:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error(`\nZAMAN AŞIMI — görülen: ${[...seen].join(', ') || 'hiçbiri'}`);
  process.exit(2);
}, 120000);
