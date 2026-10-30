#!/usr/bin/env node
/**
 * Her MCP sunucusuna calistirilabilir stdio giris noktasi ekler.
 *
 * Neden: `registerTools()` yalnizca handler kaydeder. Sunucunun gercekten
 * dinlemesi icin bir transport'a baglanmasi ve ajanin alt surec olarak
 * baslatabilecegi bir `main` blokuna sahip olmasi gerekir.
 *
 * Kullanim: node scripts/add-mcp-entrypoints.js
 */
const fs = require('fs');
const path = require('path');

const SERVERS = [
  { dir: 'gmail', className: 'GmailMCPServer' },
  { dir: 'calendar', className: 'CalendarMCPServer' },
  { dir: 'drive', className: 'DriveMCPServer' },
  { dir: 'notion', className: 'NotionMCPServer' },
  { dir: 'slack', className: 'SlackMCPServer' },
  { dir: 'chrome', className: 'ChromeMCPServer' },
];

const MARKER = '// --- stdio entrypoint (otomatik eklendi) ---';

function buildEntrypoint({ dir, className }) {
  const name = dir;
  return `
${MARKER}
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('${name}');
  const server = new Server(
    { name: 'diji-${name}', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new ${className}(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-${name}', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('${className} baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
`;
}

let changed = 0;

for (const server of SERVERS) {
  const filePath = path.join(__dirname, '..', 'mcp_servers', server.dir, 'src', 'index.ts');

  if (!fs.existsSync(filePath)) {
    console.error(`[skip] bulunamadi: ${filePath}`);
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes(MARKER)) {
    console.log(`[skip] zaten eklenmis: ${server.dir}`);
    continue;
  }

  // 1) Bootstrap importlarini ekle (registerLegacyTool importundan sonra)
  const importAnchor = "import { registerLegacyTool } from '@diji/shared';";
  const newImports =
    importAnchor +
    "\nimport { runMcpServerStdio, readServerConfigFromEnv } from '@diji/shared';";

  if (!content.includes(importAnchor)) {
    console.error(`[skip] import capasi bulunamadi: ${server.dir}`);
    continue;
  }
  content = content.replace(importAnchor, newImports);

  // 2) Dosya sonuna entrypoint ekle
  content = content.replace(/\s*$/, '\n') + buildEntrypoint(server);

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[ok] ${server.dir}`);
  changed += 1;
}

console.log(`\n${changed} sunucuya stdio entrypoint eklendi.`);
