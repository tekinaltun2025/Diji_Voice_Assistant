"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_client_1 = require("../mcp-client");
/**
 * MCPClient'in alt surec baslatmadan test edilebilmesi icin, `servers`
 * haritasini dogrudan dolduruyoruz. Bu, gercek sunuculari calistirmadan
 * izin mantigini izole test etmemizi saglar.
 */
function seedClient(client, stub) {
    const connection = {
        name: stub.name,
        config: {
            name: stub.name,
            enabled: true,
            command: 'node',
            args: [],
            env: {},
            permissions: stub.permissions,
            requiresVoiceConfirmation: true,
        },
        isConnected: true,
        tools: stub.toolNames.map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object', properties: {} },
            server: stub.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            permission: client.inferPermission(name),
        })),
        client: null,
        buffer: '',
        pending: new Map(),
        nextId: 1,
        initialized: true,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.servers.set(stub.name, connection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.isInitialized = true;
}
describe('MCP izin cikarimi', () => {
    let client;
    beforeEach(() => {
        client = new mcp_client_1.MCPClient({ read: true, write: true, delete: false });
    });
    it('okuma araclarini read olarak siniflandirir', () => {
        seedClient(client, {
            name: 'chrome',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['get_bookmarks', 'get_history', 'search_tabs', 'open_url', 'read_email'],
        });
        const tools = client.getAllTools();
        expect(tools).toHaveLength(5);
        for (const tool of tools) {
            expect(tool.permission).toBe('read');
        }
    });
    it('open_url aracini yazma olarak SINIFLANDIRMAZ', () => {
        // Regresyon: "open" icinde "p" harfi gectigi icin eski regex yanlis
        // eslesebiliyordu; tam kelime eslesmesi bunu engeller.
        seedClient(client, {
            name: 'chrome',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['open_url'],
        });
        const tool = client.getAllTools().find((t) => t.name === 'open_url');
        expect(tool?.permission).toBe('read');
    });
    it('gonderme/olusturma araclarini write olarak siniflandirir', () => {
        seedClient(client, {
            name: 'gmail',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['send_email', 'create_page', 'update_page', 'add_label'],
        });
        for (const tool of client.getAllTools()) {
            expect(tool.permission).toBe('write');
        }
    });
    it('silme araclarini delete olarak siniflandirir', () => {
        seedClient(client, {
            name: 'calendar',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['delete_event', 'remove_file', 'trash_note'],
        });
        for (const tool of client.getAllTools()) {
            expect(tool.permission).toBe('delete');
        }
    });
    it('Turkce arac adlarini da tanir', () => {
        seedClient(client, {
            name: 'notion',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['sil_sayfa', 'gonder_mesaj', 'olustur_sayfa'],
        });
        const byName = new Map(client.getAllTools().map((t) => [t.name, t.permission]));
        expect(byName.get('sil_sayfa')).toBe('delete');
        expect(byName.get('gonder_mesaj')).toBe('write');
        expect(byName.get('olustur_sayfa')).toBe('write');
    });
});
describe('MCP izin kapisi', () => {
    it('gate kapaliyken silme islemini reddeder', async () => {
        const client = new mcp_client_1.MCPClient({ read: true, write: true, delete: false });
        seedClient(client, {
            name: 'calendar',
            permissions: { read: true, write: true, delete: true },
            toolNames: ['delete_event'],
        });
        const result = await client.callTool({
            server: 'calendar',
            tool: 'delete_event',
            arguments: { eventId: 'x' },
            userId: 'u',
            sessionId: 's',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Silme islemi engellendi');
    });
    it('sunucu izni kapaliyken yazma islemini reddeder', async () => {
        const client = new mcp_client_1.MCPClient({ read: true, write: true, delete: false });
        seedClient(client, {
            name: 'gmail',
            permissions: { read: true, write: false, delete: false },
            toolNames: ['send_email'],
        });
        const result = await client.callTool({
            server: 'gmail',
            tool: 'send_email',
            arguments: {},
            userId: 'u',
            sessionId: 's',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('write izni yok');
    });
    it('ses onayi callbacki yoksa yazma islemini engeller', async () => {
        const client = new mcp_client_1.MCPClient({ read: true, write: true, delete: false });
        seedClient(client, {
            name: 'gmail',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['send_email'],
        });
        const result = await client.callTool({
            server: 'gmail',
            tool: 'send_email',
            arguments: {},
            userId: 'u',
            sessionId: 's',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Ses onay callbacki ayarlanmamis');
        expect(result.requiresConfirmation).toBe(true);
    });
    it('kullanici onayi reddederse islemi durdurur', async () => {
        const client = new mcp_client_1.MCPClient({ read: true, write: true, delete: false });
        seedClient(client, {
            name: 'gmail',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['send_email'],
        });
        client.setVoiceConfirmationCallback(async () => false);
        const result = await client.callTool({
            server: 'gmail',
            tool: 'send_email',
            arguments: {},
            userId: 'u',
            sessionId: 's',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('reddedildi');
    });
    it('bilinmeyen araci reddeder', async () => {
        const client = new mcp_client_1.MCPClient();
        seedClient(client, {
            name: 'chrome',
            permissions: { read: true, write: true, delete: false },
            toolNames: ['get_bookmarks'],
        });
        const result = await client.callTool({
            server: 'chrome',
            tool: 'yok_boyle_arac',
            arguments: {},
            userId: 'u',
            sessionId: 's',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Tool bulunamadi');
    });
    it('bagli olmayan sunucuyu reddeder', async () => {
        const client = new mcp_client_1.MCPClient();
        seedClient(client, {
            name: 'gmail',
            permissions: { read: true, write: true, delete: false },
            toolNames: [],
        });
        const result = await client.callTool({
            server: 'slack',
            tool: 'search_messages',
            arguments: {},
            userId: 'u',
            sessionId: 's',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('bulunamadi');
    });
});
//# sourceMappingURL=permission.test.js.map