/**
 * MCP sunucu tarafi giris noktasi.
 *
 * Neden ayri bir dosya?
 *  - Bu modul `@modelcontextprotocol/sdk`'yi (ESM) yukler. Istemci (ajan)
 *    veya arayuz bu SDK'ya ihtiyac duymaz; barrel export'a dahil edilirse
 *    gereksiz yere butun paketlere sizar ve test ortamlarinda (CJS) kirilir.
 *
 * Kullanim (yalnizca mcp_servers/* icinde):
 *   import { runMcpServerStdio } from '@diji/shared/dist/mcp-server.js';
 */

export {
  runMcpServerStdio,
  readServerConfigFromEnv,
  type MCPServerBootstrapInfo,
} from './utils/mcp-stdio-bootstrap';
