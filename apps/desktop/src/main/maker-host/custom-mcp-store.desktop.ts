import { safeStorage } from 'electron';
import { oauthSecureStorageAvailable } from '../plugin-oauth/identityStore.js';
import { getDbClient } from '../localDb/client/current.js';
import { createCustomMcpStore } from './custom-mcp-store.js';
export { MCP_TRANSPORTS, CUSTOM_MCP_ID_RE, isUnsafeMcpServerId, validateCustomMcpConfig } from './custom-mcp-store.js';
export type { CustomMcpConfig, McpTransport, ValidationResult } from './custom-mcp-store.js';

export const { listCustomMcpServers, listCustomMcpNamesForSetup, listCustomMcpRuntimeGenerations, getCustomMcpServer, customMcpServerExists, createCustomMcpServer, updateCustomMcpServer, deleteCustomMcpServer } = createCustomMcpStore({
  getDbClient: () => getDbClient(),
  credentials: {
    assertAvailable() {
      if (!oauthSecureStorageAvailable({ platform: process.platform,
        available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend?.() }))
        throw new Error('MCP header encryption is unavailable');
    },
    encrypt: value => safeStorage.encryptString(value).toString('base64'),
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
  },
});
