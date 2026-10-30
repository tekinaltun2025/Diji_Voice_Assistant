#!/usr/bin/env node
/**
 * Diji — LLM uç noktası canlı doğrulama betiği
 *
 * Amaç: `agent/src/llm.ts` içindeki GERÇEK `LLMEngine` sınıfını, üretimde
 * kullanılacak yapılandırmayla başlatıp uçtan uca yanıt üretimini doğrulamak.
 * Hiçbir mock yoktur; ağ çağrısı gerçek sunucuya gider.
 *
 * Kontroller:
 *   1. /v1/models erişilebilir mi, beklenen model listede mi?
 *   2. Sağlık kontrolü (initialize) geçiyor mu?
 *   3. Basit Türkçe istem gerçek içerik döndürüyor mu? (boş yanıt regresyonu)
 *   4. Reasoning modeli bütçe aşımına karşı dayanıklı mı? (düşük bütçe testi)
 *   5. Akışlı (streaming) mod içerik üretiyor mu?
 *
 * Kullanım:
 *   node scripts/verify-llm.js
 *   DIJI_LLM_MODEL=coder node scripts/verify-llm.js
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AGENT_DIST = path.join(ROOT, 'agent', 'dist');
const SHARED_DIST = path.join(ROOT, 'shared', 'dist');

const C = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail) {
  passed++;
  console.log(`${C.green}✅${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
}

function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.log(`${C.red}❌${C.reset} ${name}`);
  if (reason) console.log(`   ${C.red}${reason}${C.reset}`);
}

function section(title) {
  console.log(`\n${C.cyan}── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}${C.reset}`);
}

/** Boş görünen ama düşünme metni içeren yanıtı ayırt eder. */
function looksEmpty(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

async function main() {
  console.log(`${C.cyan}Diji — LLM canlı doğrulama${C.reset}`);
  console.log(`${C.dim}Kök dizin: ${ROOT}${C.reset}`);

  // Derlenmiş çıktılar mevcut mu?
  const fs = require('fs');
  for (const required of [
    path.join(SHARED_DIST, 'index.js'),
    path.join(AGENT_DIST, 'llm.js'),
  ]) {
    if (!fs.existsSync(required)) {
      console.error(
        `${C.red}Derlenmiş dosya bulunamadı: ${required}${C.reset}\n` +
          `${C.yellow}Önce 'npm run build:shared && npm run build:agent' çalıştırın.${C.reset}`
      );
      process.exit(1);
    }
  }

  // Ortam değişkenlerinden yapılandırmayı oku (üretimle aynı varsayılanlar).
  const baseUrl = (process.env.DIJI_LLM_BASE_URL || 'http://127.0.0.1:8000/v1').replace(/\/+$/, '');
  const model = process.env.DIJI_LLM_MODEL || 'agent';
  const apiKey = process.env.DIJI_LLM_API_KEY || 'sk-local';
  const reasoningReserve = Number(process.env.DIJI_LLM_REASONING_RESERVE || 1024);
  // Sesli asistan icin kabul edilebilir ust sinir. Reasoning modeli butce
  // buyudukce DAHA UZUN dusunur; bu esik regresyonu yakalar.
  const latencyLimitMs = Number(process.env.DIJI_LLM_LATENCY_LIMIT_MS || 45000);

  const config = {
    provider: 'ollama',
    baseUrl,
    model,
    apiKey,
    temperature: Number(process.env.DIJI_LLM_TEMPERATURE || 0.3),
    // Kasıtlı olarak KÜÇÜK görünür yanıt bütçesi: reasoning rezervi
    // çalışmıyorsa bu test boş yanıtla başarısız olur.
    maxTokens: 256,
    timeoutMs: Number(process.env.DIJI_LLM_TIMEOUT_MS || 180000),
    reasoningReserve,
  };

  console.log(`${C.dim}baseUrl=${baseUrl}  model=${model}  reasoningReserve=${reasoningReserve}${C.reset}`);

  // ── 1) /v1/models ────────────────────────────────────────────────────────
  section('1) Uç nokta erişimi (/v1/models)');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      fail('/v1/models yanıtı', `HTTP ${response.status} ${response.statusText}`);
    } else {
      const payload = await response.json();
      const ids = (payload.data || []).map((m) => m.id).filter(Boolean);
      ok('/v1/models erişilebilir', `(${ids.length} model)`);
      if (ids.includes(model)) {
        ok(`Model listede: ${model}`);
      } else {
        fail(`Model listede yok: ${model}`, `Mevcut: ${ids.join(', ') || '(boş)'}`);
      }
    }
  } catch (error) {
    fail('/v1/models isteği', error.message);
  }

  // ── 2) Motor başlatma ────────────────────────────────────────────────────
  section('2) LLMEngine.initialize()');
  let engine;
  try {
    // Derlenmiş modülü yükle. shared paketi @diji/shared olarak çözülür.
    const { LLMEngine } = require(path.join(AGENT_DIST, 'llm.js'));
    engine = new LLMEngine(config);
    await engine.initialize();
    ok('Motor başlatıldı (sağlık kontrolü geçti)');
  } catch (error) {
    fail('Motor başlatılamadı', error.message);
    summarize();
    return;
  }

  // ── 3) Basit Türkçe yanıt (boş yanıt regresyonu) ─────────────────────────
  section('3) Türkçe yanıt üretimi (bütçe baskısı altında)');
  let firstContent = '';
  try {
    const startedAt = Date.now();
    const response = await engine.generateResponse(
      [{ role: 'user', content: 'Merhaba! Tek cümleyle kendini tanıt.' }],
      undefined,
      'Sen Diji adlı Türkçe sesli asistansın. Kısa ve doğal Türkçe yanıt ver.'
    );
    const elapsed = Date.now() - startedAt;

    if (looksEmpty(response.content)) {
      fail(
        'Yanıt içeriği boş',
        `Düşünme metni: ${(response.reasoning || '').length} karakter. ` +
          'max_tokens düşünmeye harcandı — reasoning rezervi çalışmıyor.'
      );
    } else {
      ok('Yanıt içeriği dolu', `(${elapsed} ms)`);
      firstContent = response.content;
      console.log(`   ${C.dim}→ "${truncate(response.content, 160)}"${C.reset}`);
      if (response.reasoning) {
        console.log(
          `   ${C.dim}(düşünme metni ayrıldı: ${response.reasoning.length} karakter, seslendirilmez)${C.reset}`
        );
      }
      // Gecikme esigi: sesli asistan icin yanit bu sureyi asmamali.
      if (elapsed <= latencyLimitMs) {
        ok('Gecikme kabul edilebilir', `(${elapsed} ms ≤ ${latencyLimitMs} ms)`);
      } else {
        fail(
          'Gecikme cok yuksek',
          `${elapsed} ms > ${latencyLimitMs} ms. ` +
            'DIJI_LLM_REASONING_RESERVE degerini dusurun veya dusunmesiz model kullanin.'
        );
      }
      // Türkçe karakter / dil kontrolü
      if (/[çğıöşüÇĞİÖŞÜ]/.test(response.content) || /\b(bir|ve|için|sen|ben)\b/i.test(response.content)) {
        ok('Yanıt Türkçe görünüyor');
      } else {
        fail('Yanıt Türkçe değil gibi', truncate(response.content, 80));
      }
    }
  } catch (error) {
    fail('generateResponse hatası', error.message);
  }

  // ── 4) Akışlı mod ────────────────────────────────────────────────────────
  section('4) Akışlı (streaming) yanıt');
  try {
    let streamed = '';
    let chunks = 0;
    const startedAt = Date.now();

    for await (const chunk of engine.generateResponseStream(
      [{ role: 'user', content: 'İki kelimeyle nasılsın diye sor.' }],
      undefined,
      'Sen Diji adlı Türkçe sesli asistansın. Çok kısa yanıt ver.'
    )) {
      if (chunk.content) {
        streamed += chunk.content;
        chunks++;
      }
      if (chunk.done) break;
    }

    const elapsed = Date.now() - startedAt;
    if (looksEmpty(streamed)) {
      fail('Akış boş döndü', 'Hiç içerik parçası gelmedi (yalnızca düşünme metni olabilir).');
    } else {
      ok(`Akış içerik üretti (${chunks} parça, ${elapsed} ms)`);
      console.log(`   ${C.dim}→ "${truncate(streamed, 160)}"${C.reset}`);
    }
  } catch (error) {
    fail('generateResponseStream hatası', error.message);
  }

  // ── 5) Araç tanımı ile istek ─────────────────────────────────────────────
  section('5) Araç (tool) tanımıyla istek');
  try {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Belirtilen şehir için hava durumunu döndürür.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'Şehir adı' } },
            required: ['city'],
          },
        },
      },
    ];

    const response = await engine.generateResponse(
      [{ role: 'user', content: 'İstanbul için hava durumunu öğrenir misin?' }],
      tools,
      'Sen Diji adlı Türkçe sesli asistansın. Gerektiğinde araçları kullan.'
    );

    if (response.tool_calls && response.tool_calls.length > 0) {
      ok('Araç çağrısı üretildi', `(${response.tool_calls.map((t) => t.function?.name).join(', ')})`);
    } else if (!looksEmpty(response.content)) {
      ok('Araç çağrısı yerine metin yanıt (kabul edilebilir)', truncate(response.content, 90));
    } else {
      fail('Ne araç çağrısı ne metin', 'Model tamamen boş döndü.');
    }
  } catch (error) {
    fail('Araçlı istek hatası', error.message);
  }

  // ── Temizlik ─────────────────────────────────────────────────────────────
  try {
    await engine.dispose();
  } catch {
    /* yoksay */
  }

  summarize();
}

function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function summarize() {
  console.log(`\n${C.cyan}── Özet ${'─'.repeat(52)}${C.reset}`);
  console.log(`${C.green}Geçti: ${passed}${C.reset}   ${failed > 0 ? C.red : C.dim}Başarısız: ${failed}${C.reset}`);

  if (failed > 0) {
    console.log(`\n${C.red}Başarısız kontroller:${C.reset}`);
    for (const f of failures) {
      console.log(`  • ${f.name}${f.reason ? ` — ${f.reason}` : ''}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`\n${C.green}LLM uç noktası üretime hazır.${C.reset}`);
  }
}

main().catch((error) => {
  console.error(`${C.red}Beklenmeyen hata:${C.reset}`, error);
  process.exitCode = 1;
});
