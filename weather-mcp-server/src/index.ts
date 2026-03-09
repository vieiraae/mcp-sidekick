#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WeatherClient } from "./weather-client.js";
import { registerGeocodingTools } from "./tools/geocoding.js";
import { registerForecastTools } from "./tools/forecast.js";

async function main(): Promise<void> {
  const client = new WeatherClient();

  const server = new McpServer({
    name: "weather-mcp-server",
    version: "1.0.0",
  });

  registerGeocodingTools(server, client);
  registerForecastTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
