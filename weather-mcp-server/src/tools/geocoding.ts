import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WeatherClient, handleWeatherError } from "../weather-client.js";

export function registerGeocodingTools(server: McpServer, client: WeatherClient): void {

  server.registerTool(
    "weather_geocode",
    {
      title: "Geocode Location",
      description: `Search for a location by name and get its geographical coordinates (latitude, longitude).

Use this to resolve a city name into coordinates before calling forecast tools.

Args:
  - name (string): City name or postal code to search for
  - count (number, optional): Number of results to return (1-100, default 5)
  - language (string, optional): Language for results (default "en")

Returns:
  A list of matching locations with coordinates, country, timezone, and population.`,
      inputSchema: {
        name: z.string().describe("City name or postal code to search for"),
        count: z.number().int().min(1).max(100).optional().describe("Number of results (1-100, default 5)"),
        language: z.string().optional().describe("Language code for results (default: en)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, count, language }) => {
      try {
        const data = await client.geocode(name, count ?? 5, language ?? "en");

        if (!data.results || data.results.length === 0) {
          return { content: [{ type: "text", text: `No locations found for "${name}".` }] };
        }

        const lines = data.results.map((r) => {
          const parts = [
            `**${r.name}**`,
            r.admin1 ? r.admin1 : undefined,
            r.country,
          ].filter(Boolean);
          return [
            `- ${parts.join(", ")}`,
            `  Coordinates: ${r.latitude}, ${r.longitude}`,
            r.elevation !== undefined ? `  Elevation: ${r.elevation}m` : undefined,
            r.timezone ? `  Timezone: ${r.timezone}` : undefined,
            r.population ? `  Population: ${r.population.toLocaleString()}` : undefined,
          ].filter(Boolean).join("\n");
        });

        return { content: [{ type: "text", text: `**Locations matching "${name}":**\n\n${lines.join("\n\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleWeatherError(error) }] };
      }
    }
  );
}
