export type MCPServerName =
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'notion'
  | 'slack'
  | 'chrome';

export type MCPPermission = 'read' | 'write' | 'delete';

export type MCPConfirmationStatus = 'granted' | 'pending' | 'denied';

export interface MCPServerConfig {
  name: MCPServerName;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  permissions: {
    read: boolean;
    write: boolean;
    delete: boolean;
  };
  requiresVoiceConfirmation: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: MCPServerName;
  permission: MCPPermission;
}

export interface MCPCallRequest {
  server: MCPServerName;
  tool: string;
  arguments: Record<string, unknown>;
  userId: string;
  sessionId: string;
}

export interface MCPCallResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  requiresConfirmation?: boolean;
  confirmationStatus?: MCPConfirmationStatus;
  confirmationToken?: string;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, context: MCPToolContext) => Promise<MCPCallResponse>;
  permission: MCPPermission;
}

export interface MCPToolContext {
  userId: string;
  sessionId: string;
  serverName: MCPServerName;
  token?: string;
}

export interface OAuth2Token {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
}

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  scope: string[];
}