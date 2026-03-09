#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { SpotifyConfig } from "./types.js";
import { SpotifyClient } from "./spotify-client.js";
import { getValidToken } from "./auth.js";
import { registerPlaybackTools } from "./tools/playback.js";
import { registerSearchTools } from "./tools/search.js";
import { registerInfoTools } from "./tools/info.js";
import { registerLibraryTools } from "./tools/library.js";

function getConfig(): SpotifyConfig {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? "http://localhost:8888/callback";

  if (!clientId) {
    console.error("Error: SPOTIFY_CLIENT_ID environment variable is required.");
    process.exit(1);
  }
  if (!clientSecret) {
    console.error("Error: SPOTIFY_CLIENT_SECRET environment variable is required.");
    process.exit(1);
  }

  return { clientId, clientSecret, redirectUri };
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

  const client = new SpotifyClient(config);
  const defaultDeviceId = process.env.SPOTIFY_DEVICE_ID;

  const server = new McpServer({
    name: "spotify-mcp-server",
    version: "1.0.0",
  });

  // Register all tools
  registerPlaybackTools(server, client, defaultDeviceId);
  registerSearchTools(server, client);
  registerInfoTools(server, client);
  registerLibraryTools(server, client);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Spotify MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
