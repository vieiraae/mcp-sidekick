#!/usr/bin/env node
// MSX Helper MCP Server — entry point
// Exposes Dynamics 365 CRM operations as MCP tools over stdio transport

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAuthService } from './auth.js';
import { createCrmClient } from './crm.js';
import { registerTools } from './tools.js';
import { getApprovalQueue } from './approval-queue.js';

const DEFAULT_CRM_URL = 'https://microsoftsales.crm.dynamics.com';
const DEFAULT_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

function getConfig() {
  return {
    crmUrl: process.env.MSX_CRM_URL || DEFAULT_CRM_URL,
    tenantId: process.env.MSX_TENANT_ID || DEFAULT_TENANT_ID
  };
}

async function main() {
  const config = getConfig();

  const authService = createAuthService({
    crmUrl: config.crmUrl,
    tenantId: config.tenantId
  });

  if (process.argv.includes('--auth')) {
    if (authService._state.authSource === 'azure-cli') {
      const result = await authService.ensureAuth();
      if (!result.success) throw new Error(result.error);
      console.error(`Azure CLI token is available for ${result.metadata.userName ?? 'the signed-in account'}.`);
      return;
    }
    console.error('Starting Azure device-code sign-in...');
    await authService.signInWithDeviceCode((response) => {
      console.error(response.message);
    });
    console.error('Authentication successful. The MSAL cache is ready for the MCP server.');
    return;
  }

  const crmClient = createCrmClient(authService);

  const server = new McpServer({
    name: 'msx-mcp-server',
    version: '1.0.0'
  });

  registerTools(server, crmClient);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown with queue flush
  const shutdown = async () => {
    try {
      getApprovalQueue().dispose();
    } catch {
      // Best-effort
    }
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('beforeExit', () => {
    try {
      getApprovalQueue().dispose();
    } catch {
      // Best-effort
    }
  });
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
