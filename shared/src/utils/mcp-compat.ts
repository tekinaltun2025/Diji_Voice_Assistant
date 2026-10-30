/**
 * MCP SDK uyumluluk katmani.
 *
 * Eski (legacy) kayit deseni:
 *   server.setRequestHandler({ method, paramsSchema }, handler)
 *
 * MCP SDK 0.5+ bu deseni desteklemez; araclar `CallToolRequestSchema` ve
 * `ListToolsRequestSchema` uzerinden tek bir dispatcher ile yonetilir.
 *
 * Bu modul, legacy cagrilari toplayip SDK'nin bekledigi tek dispatcher'a
 * baglar. Boylece tum MCP sunuculari ayni sekilde kayit yapmaya devam eder.
 */

import { z } from 'zod';

export interface LegacyToolRequest {
  params: {
    // Tool govdeleri argumanlari serbestce destructure eder; SDK semasi
    // calisma aninda dogrular.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arguments?: any;
  };
}

export type LegacyToolHandler = (
  request: LegacyToolRequest
) => unknown | Promise<unknown>;

export interface LegacyToolSpec {
  method: string;
  paramsSchema: z.ZodObject<z.ZodRawShape>;
}

/**
 * MCP `Server` sinifinin `setRequestHandler` imzasi generic oldugu icin
 * yapisal olarak uyumlu en genis arayuz kullanilir.
 */
interface SetRequestHandlerCapable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setRequestHandler: (schema: any, handler: any) => void;
}

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: LegacyToolHandler;
}

const REGISTRY = new WeakMap<object, Map<string, RegisteredTool>>();

/**
 * Zod semasini JSON Schema'ya cevirir (MCP `inputSchema` icin).
 * Yalnizca bu projede kullanilan temel tipleri destekler.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const typeName = def.typeName as string;

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodLiteral':
      return { const: def.value, type: typeof def.value };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJsonSchema(def.type as z.ZodTypeAny),
      };
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodReadonly':
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);
    case 'ZodEffects':
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    case 'ZodUnion':
      return {
        anyOf: (def.options as z.ZodTypeAny[]).map(zodToJsonSchema),
      };
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const valueDef = (value as unknown as { _def: Record<string, unknown> })._def;
        properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
        const optionalTypes = ['ZodOptional', 'ZodDefault', 'ZodReadonly'];
        if (!optionalTypes.includes(valueDef.typeName as string)) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: true };
    default:
      // Bilinmeyen tip: kisitlama olmadan gecir
      return {};
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function humanizeToolName(name: string): string {
  return name
    .split('_')
    .map((part) => capitalize(part))
    .join(' ');
}

function extractToolName(spec: LegacyToolSpec): string {
  const shape = spec.paramsSchema.shape as Record<string, z.ZodTypeAny>;
  const nameSchema = shape.name;
  const def = (nameSchema as unknown as { _def: Record<string, unknown> } | undefined)?._def;
  if (def && typeof def.value === 'string') return def.value;
  throw new Error('Legacy tool kaydinda "name" alani literal string olmali');
}

function extractArgumentsSchema(spec: LegacyToolSpec): Record<string, unknown> {
  const shape = spec.paramsSchema.shape as Record<string, z.ZodTypeAny>;
  const argsSchema = shape.arguments;
  if (!argsSchema) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  return zodToJsonSchema(argsSchema);
}

function toMcpResult(result: unknown): Record<string, unknown> {
  const serialized =
    typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2);

  const failed =
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    (result as { success?: unknown }).success === false;

  return {
    content: [{ type: 'text', text: serialized }],
    ...(failed ? { isError: true } : {}),
  };
}

function loadMcpSchemas(): {
  CallToolRequestSchema: unknown;
  ListToolsRequestSchema: unknown;
} | null {
  try {
    // CJS ortaminda senkron yukleme; SDK kurulu degilse sessizce devre disi kalir.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const types = require('@modelcontextprotocol/sdk/types.js') as Record<string, unknown>;
    if (types.CallToolRequestSchema && types.ListToolsRequestSchema) {
      return {
        CallToolRequestSchema: types.CallToolRequestSchema,
        ListToolsRequestSchema: types.ListToolsRequestSchema,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function installDispatcher(
  server: SetRequestHandlerCapable,
  tools: Map<string, RegisteredTool>
): void {
  const schemas = loadMcpSchemas();

  // SDK yoksa eski/yeni ayrimi yapamayiz; kayit sessizce yutulur.
  if (!schemas) {
    return;
  }

  server.setRequestHandler(schemas.ListToolsRequestSchema, () => ({
    tools: Array.from(tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(schemas.CallToolRequestSchema, async (request: unknown) => {
    const payload = request as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params?: { name?: string; arguments?: any };
    };

    const toolName = payload.params?.name;
    if (!toolName) {
      return {
        content: [{ type: 'text', text: 'Arac adi belirtilmedi.' }],
        isError: true,
      };
    }

    const tool = tools.get(toolName);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Bilinmeyen arac: ${toolName}` }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler({
        params: { arguments: payload.params?.arguments ?? {} },
      });
      return toMcpResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Arac hatasi: ${message}` }],
        isError: true,
      };
    }
  });
}

/**
 * Legacy `setRequestHandler({ method, paramsSchema }, handler)` cagrisinin
 * yerine gecer. Ayni server uzerinde coklu cagri desteklenir.
 */
export function registerLegacyTool<T extends SetRequestHandlerCapable>(
  server: T,
  spec: LegacyToolSpec,
  handler: LegacyToolHandler
): void {
  let tools = REGISTRY.get(server);

  if (!tools) {
    tools = new Map<string, RegisteredTool>();
    REGISTRY.set(server, tools);
    installDispatcher(server, tools);
  }

  const name = extractToolName(spec);
  tools.set(name, {
    name,
    description: humanizeToolName(name),
    inputSchema: extractArgumentsSchema(spec),
    handler,
  });
}
