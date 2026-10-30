#!/usr/bin/env node
/**
 * Diji uctan uca duman testi (smoke test).
 *
 * Neyi dogrular:
 *   1) Tum MCP sunuculari stdio uzerinden baslatilabiliyor mu? (initialize + tools/list)
 *   2) Her sunucu beklenen sayida arac sunuyor mu?
 *   3) Ajanin MCPClient'i gercek sunuculara baglanip araclari toplayabiliyor mu?
 *   4) Izin cikarimi dogru mu? (read/write/delete dagilimi)
 *   5) Izin kapisi 🔴 silmeyi engelliyor, 🟡 yazma icin onay istiyor mu?
 *   6) Ses motorlari (VAD/TTS/STT) model dosyalariyla baslatilabiliyor mu?
 *   7) TTS -> STT Turkce dongusu calisiyor mu?
 *
 * Model gerektiren adimlar (6-7) model yoksa ATLANIR, hata sayilmaz.
 *
 * Kullanim:
 *   node scripts/smoke-test.js
 *   node scripts/smoke-test.js --skip-audio
 *
 * Cikis kodu: 0 = tum zorunlu testler gecti, 1 = basarisiz.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = process.env.DIJI_MODELS_DIR || path.join(os.homedir(), '.diji', 'models');
const SKIP_AUDIO = process.argv.includes('--skip-audio');

const EXPECTED_TOOLS = {
  gmail: ['search_emails', 'read_email', 'send_email', 'list_labels'],
  calendar: ['list_events', 'create_event', 'get_event', 'delete_event'],
  drive: ['search_files', 'read_file', 'download_file', 'list_folder'],
  notion: ['search_pages', 'read_page', 'create_page', 'update_page'],
  slack: ['search_messages', 'read_channel', 'send_message', 'list_channels'],
  chrome: ['get_bookmarks', 'get_history', 'open_url', 'search_tabs'],
};

let passed = 0;
let failed = 0;
let skipped = 0;

const ok = (msg) => {
  console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
  passed += 1;
};
const bad = (msg) => {
  console.log(`\x1b[31m  ✗\x1b[0m ${msg}`);
  failed += 1;
};
const skip = (msg) => {
  console.log(`\x1b[33m  ○\x1b[0m ${msg} (atlandi)`);
  skipped += 1;
};
const section = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

/**
 * Tek bir MCP sunucusuna baglanip initialize + tools/list yapar.
 */
function probeServer(name) {
  return new Promise((resolve) => {
    const script = path.join(ROOT, 'mcp_servers', name, 'dist', 'index.js');

    if (!fs.existsSync(script)) {
      return resolve({ name, ok: false, err: `derlenmemis: ${script}` });
    }

    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const stderrLines = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* zaten kapali */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ name, ok: false, err: 'zaman asimi (20 sn)' }), 20000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && pending.has(message.id)) {
            const handler = pending.get(message.id);
            pending.delete(message.id);
            handler(message);
          }
        } catch {
          // Protokol disi satir: MCP hatasi
          finish({ name, ok: false, err: `protokol bozuldu: ${line.slice(0, 80)}` });
        }
      }
    });

    child.stderr.on('data', (d) => stderrLines.push(d.toString().trim()));
    child.on('error', (e) => finish({ name, ok: false, err: e.message }));

    const request = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        const t = setTimeout(() => rej(new Error(`zaman asimi: ${method}`)), 15000);
        pending.set(id, (msg) => {
          clearTimeout(t);
          res(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    (async () => {
      const init = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'diji-smoke', version: '1.0.0' },
      });

      if (init.error) {
        clearTimeout(timer);
        return finish({ name, ok: false, err: JSON.stringify(init.error) });
      }

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const list = await request('tools/list', {});
      clearTimeout(timer);
      const tools = (list.result && list.result.tools) || [];
      finish({ name, ok: true, tools: tools.map((t) => t.name) });
    })().catch((e) => {
      clearTimeout(timer);
      finish({ name, ok: false, err: e.message, log: stderrLines.slice(-2) });
    });
  });
}

async function testMcpServers() {
  section('1) MCP sunuculari (stdio JSON-RPC)');

  const names = Object.keys(EXPECTED_TOOLS);
  const results = [];

  for (const name of names) {
    const result = await probeServer(name);
    results.push(result);

    if (!result.ok) {
      bad(`${name}: ${result.err}${result.log ? ` | ${result.log.join(' / ')}` : ''}`);
      continue;
    }

    const expected = EXPECTED_TOOLS[name];
    const missing = expected.filter((tool) => !result.tools.includes(tool));
    const extra = result.tools.filter((tool) => !expected.includes(tool));

    if (missing.length > 0) {
      bad(`${name}: eksik araclar -> ${missing.join(', ')}`);
    } else {
      ok(`${name}: ${result.tools.length} arac (${result.tools.join(', ')})`);
      if (extra.length > 0) {
        console.log(`      \x1b[90mek araclar: ${extra.join(', ')}\x1b[0m`);
      }
    }
  }

  return results;
}

async function testMcpClient() {
  section('2) Ajan MCP istemcisi + izin kapisi');

  const clientPath = path.join(ROOT, 'agent', 'dist', 'mcp-client.js');
  if (!fs.existsSync(clientPath)) {
    bad('ajan derlenmemis (agent/dist/mcp-client.js yok) — "npm run build:agent"');
    return;
  }

  const { MCPClient } = require(clientPath);

  const client = new MCPClient({ read: true, write: true, delete: false });

  const configs = Object.keys(EXPECTED_TOOLS).map((name) => ({
    name,
    enabled: true,
    command: process.execPath,
    args: [path.join(ROOT, 'mcp_servers', name, 'dist', 'index.js')],
    env: {},
    permissions: { read: true, write: true, delete: false },
    requiresVoiceConfirmation: true,
  }));

  try {
    await client.initialize(configs);

    const connected = client.getConnectedServerNames();
    if (connected.length === 6) {
      ok(`6/6 sunucuya baglandi`);
    } else {
      bad(`yalnizca ${connected.length}/6 sunucu bagli: ${connected.join(', ') || 'yok'}`);
    }

    const tools = client.getAllTools();
    const expectedTotal = Object.values(EXPECTED_TOOLS).reduce((a, t) => a + t.length, 0);

    if (tools.length === expectedTotal) {
      ok(`${tools.length} arac toplandi`);
    } else {
      bad(`beklenen ${expectedTotal} arac, bulunan ${tools.length}`);
    }

    // Izin dagilimi: her arac read/write/delete'ten birinde olmali
    const invalid = tools.filter((t) => !['read', 'write', 'delete'].includes(t.permission));
    if (invalid.length === 0) {
      const dist = tools.reduce((acc, t) => {
        acc[t.permission] = (acc[t.permission] || 0) + 1;
        return acc;
      }, {});
      ok(`izin dagilimi: ${JSON.stringify(dist)}`);
    } else {
      bad(`gecersiz izin: ${invalid.map((t) => t.name).join(', ')}`);
    }

    // Regresyon: open_url read olmali
    const openUrl = tools.find((t) => t.name === 'open_url');
    if (openUrl && openUrl.permission === 'read') {
      ok('open_url dogru sekilde "read" siniflandirildi');
    } else {
      bad(`open_url yanlis siniflandirildi: ${openUrl ? openUrl.permission : 'bulunamadi'}`);
    }

    // 🔴 silme engellenmeli (gate kapali)
    const delResult = await client.callTool({
      server: 'calendar',
      tool: 'delete_event',
      arguments: { userId: 'smoke', eventId: 'x' },
      userId: 'smoke',
      sessionId: 'smoke',
    });

    if (!delResult.success && /engellendi/i.test(delResult.error || '')) {
      ok('🔴 silme islemi engellendi (gate kapali)');
    } else {
      bad(`silme engellenmedi: ${JSON.stringify(delResult).slice(0, 120)}`);
    }

    // 🟡 yazma onay istemeli
    let confirmationAsked = false;
    client.setVoiceConfirmationCallback(async () => {
      confirmationAsked = true;
      return false; // reddet
    });

    const writeResult = await client.callTool({
      server: 'notion',
      tool: 'create_page',
      arguments: { userId: 'smoke', title: 'Test' },
      userId: 'smoke',
      sessionId: 'smoke',
    });

    if (confirmationAsked && !writeResult.success) {
      ok('🟡 yazma islemi ses onayi istedi ve ret ile durdu');
    } else {
      bad(`yazma onayi akisi hatali (soruldu=${confirmationAsked}, basari=${writeResult.success})`);
    }
  } finally {
    await client.dispose();
  }
}

function hasModel(fileName) {
  return fs.existsSync(path.join(MODELS_DIR, fileName));
}

async function testAudioEngines() {
  section('3) Ses motorlari (yerel sherpa-onnx)');

  const vadModel = hasModel('silero_vad.onnx');
  const ttsDir = hasModel('vits-piper-tr_TR-fettah-medium');
  const sttDir = hasModel('sherpa-onnx-whisper-small');

  if (!vadModel) {
    skip('VAD: silero_vad.onnx yok — "./scripts/download-models.sh vad"');
  } else {
    const { VADEngine } = require(path.join(ROOT, 'agent', 'dist', 'vad.js'));
    const vad = new VADEngine({
      provider: 'silero',
      threshold: 0.5,
      minSilenceDuration: 0.6,
      minSpeechDuration: 0.25,
      sampleRate: 16000,
    });
    try {
      await vad.initialize();
      const silence = vad.processAudio(Buffer.alloc(16000 * 2));
      if (silence.isSpeech === false) {
        ok('VAD: sessizlikte konusma algilamiyor (dogru)');
      } else {
        bad('VAD: sessizlikte konusma algiladi (yanlis)');
      }
      await vad.dispose();
    } catch (e) {
      bad(`VAD baslatilamadi: ${e.message}`);
    }
  }

  if (!ttsDir) {
    skip('TTS: Turkce VITS modeli yok — "./scripts/download-models.sh tts"');
  } else {
    const { TTSEngine } = require(path.join(ROOT, 'agent', 'dist', 'tts.js'));
    const tts = new TTSEngine({
      provider: 'sherpa-vits',
      model: 'vits-piper-tr_TR-fettah-medium',
      voice: 'fettah',
      speed: 1.0,
    });
    try {
      await tts.initialize();
      const result = await tts.synthesize('Merhaba efendim.');
      if (result.audioBuffer.length > 1000) {
        ok(`TTS: ${result.audioBuffer.length} byte ses uretildi (${Math.round(result.duration)} ms)`);
      } else {
        bad(`TTS: ses cok kisa (${result.audioBuffer.length} byte)`);
      }
      await tts.dispose();
    } catch (e) {
      bad(`TTS baslatilamadi: ${e.message}`);
    }
  }

  if (!sttDir || !ttsDir) {
    skip('STT: Whisper veya TTS modeli yok — "./scripts/download-models.sh whisper tts"');
    return;
  }

  // Uctan uca: TTS ile uret, STT ile geri tani
  const { TTSEngine } = require(path.join(ROOT, 'agent', 'dist', 'tts.js'));
  const { STTEngine } = require(path.join(ROOT, 'agent', 'dist', 'stt.js'));

  const tts = new TTSEngine({
    provider: 'sherpa-vits',
    model: 'vits-piper-tr_TR-fettah-medium',
    voice: 'fettah',
    speed: 1.0,
  });
  const stt = new STTEngine({ provider: 'whisper', model: 'whisper-small', language: 'tr' });

  try {
    await tts.initialize();
    await stt.initialize();

    const audio = await tts.synthesize('Merhaba, bugun hava cok guzel.');
    const sourceRate = tts.getSampleRate();
    await tts.dispose();

    // 22050 Hz -> 16000 Hz lineer resample (PCM16)
    const inCount = audio.audioBuffer.length / 2;
    const outCount = Math.floor((inCount * 16000) / sourceRate);
    const resampled = Buffer.alloc(outCount * 2);
    for (let i = 0; i < outCount; i++) {
      const pos = (i * sourceRate) / 16000;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, inCount - 1);
      const frac = pos - i0;
      const s0 = audio.audioBuffer.readInt16LE(i0 * 2);
      const s1 = audio.audioBuffer.readInt16LE(i1 * 2);
      resampled.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
    }

    const result = await stt.transcribe(resampled);
    await stt.dispose();

    const text = (result.text || '').toLowerCase();
    // Turkce karakterler ve noktalama farkli olabilir; anahtar kelimelere bak.
    const hasMerhaba = text.includes('merhaba');
    const hasHava = text.includes('hava');
    const hasGuzel = /g[uü]zel/.test(text);

    if (hasMerhaba && hasHava) {
      ok(`STT dongusu: "${result.text}"`);
      if (!hasGuzel) {
        console.log('      \x1b[90mnot: "guzel" kelimesi tam taninmadi (kabul edilebilir)\x1b[0m');
      }
    } else {
      bad(`STT dongusu beklenen metni tanimadi: "${result.text}"`);
    }
  } catch (e) {
    bad(`TTS->STT dongusu basarisiz: ${e.message}`);
  } finally {
    try {
      await tts.dispose();
    } catch {
      /* zaten kapali */
    }
    try {
      await stt.dispose();
    } catch {
      /* zaten kapali */
    }
  }
}

async function testTurnDetector() {
  section('4) Turkce turn detector');

  const modPath = path.join(ROOT, 'agent', 'dist', 'turn-detector.js');
  if (!fs.existsSync(modPath)) {
    bad('turn-detector derlenmemis — "npm run build:agent"');
    return;
  }

  const { TurkishTurnDetector } = require(modPath);
  const detector = new TurkishTurnDetector({
    provider: 'turkish-custom',
    fillerWords: ['şey', 'yani', 'işte', 'demek', 'hani'],
    conjunctions: ['ve', 'ama', 'çünkü', 'fakat', 'ancak', 'veya', 'ya da'],
    punctuationEndsTurn: true,
    maxSilenceBeforeTurn: 0.8,
  });

  try {
    await detector.initialize();

    const complete = detector.shouldEndTurn('Bugün hava çok güzel.', 1.0);
    if (complete.shouldEndTurn === true) {
      ok('Nokta ile biten cumle -> tur bitti');
    } else {
      bad(`Nokta ile biten cumle tur sonu sayilmadi: ${JSON.stringify(complete)}`);
    }

    const incomplete = detector.shouldEndTurn('Bugün hava çok güzel ve', 0.1);
    if (incomplete.shouldEndTurn === false) {
      ok('Baglac ile biten cumle -> tur devam ediyor');
    } else {
      bad(`Baglac ile biten cumle tur sonu sayildi: ${JSON.stringify(incomplete)}`);
    }

    const filler = detector.shouldEndTurn('yani şey', 0.1);
    if (filler.shouldEndTurn === false) {
      ok('Dolgu kelimesi -> tur devam ediyor');
    } else {
      bad(`Dolgu kelimesi tur sonu sayildi: ${JSON.stringify(filler)}`);
    }

    await detector.dispose();
  } catch (e) {
    bad(`turn detector basarisiz: ${e.message}`);
  }
}

async function main() {
  console.log('\x1b[1m\x1b[36mDiji Duman Testi\x1b[0m');
  console.log(`Kok dizin : ${ROOT}`);
  console.log(`Model dir : ${MODELS_DIR}`);

  await testMcpServers();
  await testMcpClient();
  await testTurnDetector();

  if (SKIP_AUDIO) {
    section('3) Ses motorlari');
    skip('--skip-audio verildi');
  } else {
    await testAudioEngines();
  }

  console.log('\n' + '─'.repeat(50));
  console.log(
    `\x1b[1mSonuc:\x1b[0m ${passed} gecti, ${failed} basarisiz, ${skipped} atlandi`
  );

  if (failed > 0) {
    console.log('\x1b[31mDUMMAN TESTI BASARISIZ\x1b[0m');
    process.exit(1);
  }

  console.log('\x1b[32mDUMMAN TESTI BASARILI\x1b[0m');
  if (skipped > 0) {
    console.log(
      '\x1b[33mNot: bazi testler model dosyalari olmadigi icin atlandi.\x1b[0m'
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\x1b[31mBeklenmedik hata:\x1b[0m', e);
  process.exit(1);
});
