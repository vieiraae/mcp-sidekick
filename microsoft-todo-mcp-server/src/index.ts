#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MicrosoftTodoConfig } from "./types.js";
import { GraphClient } from "./graph-client.js";
import { getValidToken } from "./auth.js";
import { registerListTools } from "./tools/lists.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerChecklistTools } from "./tools/checklist.js";

function getConfig(): MicrosoftTodoConfig {
  const clientId = process.env.MICROSOFT_TODO_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_TODO_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_TODO_REDIRECT_URI ?? "http://localhost:3333/callback";
  const tenantId = process.env.MICROSOFT_TODO_TENANT_ID ?? "common";

  if (!clientId) {
    console.error("Error: MICROSOFT_TODO_CLIENT_ID environment variable is required.");
    process.exit(1);
  }
  if (!clientSecret) {
    console.error("Error: MICROSOFT_TODO_CLIENT_SECRET environment variable is required.");
    process.exit(1);
  }

  return { clientId, clientSecret, redirectUri, tenantId };
}

async function main(): Promise<void> {
  const config = getConfig();

  // Pre-authenticate mode: run with --auth to complete OAuth before using with MCP Inspector
  if (process.argv.includes("--auth")) {
    console.error("Starting authentication flow...");
    const token = await getValidToken(config);
    console.error(token ? "Authentication successful! Tokens saved. You can now use the server with MCP Inspector." : "Authentication failed.");
    process.exit(0);
  }

  const client = new GraphClient(config);

  const server = new McpServer({
    name: "microsoft-todo-mcp-server",
    version: "1.0.0",
  });

  // Register all tools
  registerListTools(server, client);
  registerTaskTools(server, client);
  registerChecklistTools(server, client);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Microsoft To Do MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
