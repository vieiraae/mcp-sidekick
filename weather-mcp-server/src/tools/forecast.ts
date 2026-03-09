import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WeatherClient, handleWeatherError } from "../weather-client.js";
import { WMO_CODES } from "../constants.js";

function weatherDescription(code: number): string {
  return WMO_CODES[code] ?? `Unknown (${code})`;
}

// Countries that use Fahrenheit as their standard temperature unit
const FAHRENHEIT_COUNTRIES = new Set(["US", "BS", "KY", "LR", "PW", "FM", "MH"]);

// Countries that use mph as their standard wind speed unit
const MPH_COUNTRIES = new Set(["US", "GB", "LR", "MM"]);

function defaultTempUnit(countryCode?: string): "celsius" | "fahrenheit" {
  return countryCode && FAHRENHEIT_COUNTRIES.has(countryCode.toUpperCase()) ? "fahrenheit" : "celsius";
}

function defaultWindUnit(countryCode?: string): "kmh" | "mph" {
  return countryCode && MPH_COUNTRIES.has(countryCode.toUpperCase()) ? "mph" : "kmh";
}

export function registerForecastTools(server: McpServer, client: WeatherClient): void {

  server.registerTool(
    "weather_current",
    {
      title: "Get Current Weather",
      description: `Get current weather conditions for a city.

Args:
  - city (string): City name to get weather for
  - temperature_unit (string, optional): "celsius" or "fahrenheit" (default: auto-detected from city's country)
  - wind_speed_unit (string, optional): "kmh", "ms", "mph", or "kn" (default: auto-detected from city's country)

Returns:
  Current temperature, humidity, weather condition, wind speed/direction, and more.`,
      inputSchema: {
        city: z.string().describe("City name to get weather for"),
        temperature_unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit (default: auto-detected from country)"),
        wind_speed_unit: z.enum(["kmh", "ms", "mph", "kn"]).optional().describe("Wind speed unit (default: auto-detected from country)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ city, temperature_unit, wind_speed_unit }) => {
      try {
        const geo = await client.geocode(city, 1);
        if (!geo.results || geo.results.length === 0) {
          return { content: [{ type: "text", text: `No location found for "${city}".` }] };
        }
        const location = geo.results[0];

        const data = await client.forecast({
          latitude: location.latitude,
          longitude: location.longitude,
          current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
          temperature_unit: temperature_unit ?? defaultTempUnit(location.country_code),
          wind_speed_unit: wind_speed_unit ?? defaultWindUnit(location.country_code),
          timezone: "auto",
        });

        if (!data.current) {
          return { content: [{ type: "text", text: "No current weather data available." }] };
        }

        const c = data.current;
        const u = data.current_units ?? {};
        const code = c.weather_code as number;

        const locationName = [location.name, location.admin1, location.country].filter(Boolean).join(", ");
        const text = [
          `**Current Weather for ${locationName}** (${data.timezone})`,
          `**Condition**: ${weatherDescription(code)}`,
          `**Temperature**: ${c.temperature_2m}${u.temperature_2m ?? "°C"}`,
          `**Feels Like**: ${c.apparent_temperature}${u.apparent_temperature ?? "°C"}`,
          `**Humidity**: ${c.relative_humidity_2m}${u.relative_humidity_2m ?? "%"}`,
          `**Cloud Cover**: ${c.cloud_cover}${u.cloud_cover ?? "%"}`,
          `**Wind**: ${c.wind_speed_10m}${u.wind_speed_10m ?? "km/h"} from ${c.wind_direction_10m}°`,
          `**Wind Gusts**: ${c.wind_gusts_10m}${u.wind_gusts_10m ?? "km/h"}`,
          `**Precipitation**: ${c.precipitation}${u.precipitation ?? "mm"}`,
          `**Pressure**: ${c.surface_pressure}${u.surface_pressure ?? "hPa"}`,
          `**Day/Night**: ${c.is_day === 1 ? "Day" : "Night"}`,
          `**Coordinates**: ${data.latitude}, ${data.longitude} | Elevation: ${data.elevation}m`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleWeatherError(error) }] };
      }
    }
  );

  server.registerTool(
    "weather_forecast",
    {
      title: "Get Weather Forecast",
      description: `Get hourly weather forecast for a city (up to 16 days).

Args:
  - city (string): City name to get forecast for
  - forecast_days (number, optional): Number of forecast days (1-16, default 7)
  - temperature_unit (string, optional): "celsius" or "fahrenheit" (default: auto-detected from city's country)
  - wind_speed_unit (string, optional): "kmh", "ms", "mph", or "kn" (default: auto-detected from city's country)

Returns:
  Hourly forecast with temperature, humidity, precipitation, weather condition, wind, and cloud cover.`,
      inputSchema: {
        city: z.string().describe("City name to get forecast for"),
        forecast_days: z.number().int().min(1).max(16).optional().describe("Forecast days (1-16, default 7)"),
        temperature_unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit (default: auto-detected from country)"),
        wind_speed_unit: z.enum(["kmh", "ms", "mph", "kn"]).optional().describe("Wind speed unit (default: auto-detected from country)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ city, forecast_days, temperature_unit, wind_speed_unit }) => {
      try {
        const geo = await client.geocode(city, 1);
        if (!geo.results || geo.results.length === 0) {
          return { content: [{ type: "text", text: `No location found for "${city}".` }] };
        }
        const location = geo.results[0];

        const data = await client.forecast({
          latitude: location.latitude,
          longitude: location.longitude,
          hourly: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility",
          forecast_days: forecast_days ?? 7,
          temperature_unit: temperature_unit ?? defaultTempUnit(location.country_code),
          wind_speed_unit: wind_speed_unit ?? defaultWindUnit(location.country_code),
          timezone: "auto",
        });

        if (!data.hourly || !data.hourly.time) {
          return { content: [{ type: "text", text: "No forecast data available." }] };
        }

        const h = data.hourly;
        const u = data.hourly_units ?? {};
        const times = h.time as string[];

        // Group by day and show summary per 3-hour intervals
        const locationName = [location.name, location.admin1, location.country].filter(Boolean).join(", ");
        const lines: string[] = [
          `**Hourly Forecast for ${locationName}** — ${data.timezone}`,
          "",
        ];

        let currentDay = "";
        for (let i = 0; i < times.length; i += 3) {
          const time = times[i];
          const day = time.substring(0, 10);
          const hour = time.substring(11, 16);

          if (day !== currentDay) {
            currentDay = day;
            lines.push(`\n**${day}**`);
            lines.push(`| Time | Temp | Feels | Humidity | Precip Prob | Precip | Condition | Wind | Gusts | Cloud |`);
            lines.push(`|------|------|-------|----------|-------------|--------|-----------|------|-------|-------|`);
          }

          const code = (h.weather_code as number[])[i];
          lines.push(
            `| ${hour} ` +
            `| ${(h.temperature_2m as number[])[i]}${u.temperature_2m ?? "°C"} ` +
            `| ${(h.apparent_temperature as number[])[i]}${u.apparent_temperature ?? "°C"} ` +
            `| ${(h.relative_humidity_2m as number[])[i]}${u.relative_humidity_2m ?? "%"} ` +
            `| ${(h.precipitation_probability as number[])[i]}${u.precipitation_probability ?? "%"} ` +
            `| ${(h.precipitation as number[])[i]}${u.precipitation ?? "mm"} ` +
            `| ${weatherDescription(code)} ` +
            `| ${(h.wind_speed_10m as number[])[i]}${u.wind_speed_10m ?? "km/h"} ${(h.wind_direction_10m as number[])[i]}° ` +
            `| ${(h.wind_gusts_10m as number[])[i]}${u.wind_gusts_10m ?? "km/h"} ` +
            `| ${(h.cloud_cover as number[])[i]}${u.cloud_cover ?? "%"} |`
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleWeatherError(error) }] };
      }
    }
  );

  server.registerTool(
    "weather_daily",
    {
      title: "Get Daily Forecast",
      description: `Get daily weather forecast summary for a city (up to 16 days).

Args:
  - city (string): City name to get forecast for
  - forecast_days (number, optional): Number of forecast days (1-16, default 7)
  - temperature_unit (string, optional): "celsius" or "fahrenheit" (default: auto-detected from city's country)
  - wind_speed_unit (string, optional): "kmh", "ms", "mph", or "kn" (default: auto-detected from city's country)

Returns:
  Daily summary with min/max temperature, precipitation, sunrise/sunset, and dominant wind.`,
      inputSchema: {
        city: z.string().describe("City name to get forecast for"),
        forecast_days: z.number().int().min(1).max(16).optional().describe("Forecast days (1-16, default 7)"),
        temperature_unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit (default: auto-detected from country)"),
        wind_speed_unit: z.enum(["kmh", "ms", "mph", "kn"]).optional().describe("Wind speed unit (default: auto-detected from country)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ city, forecast_days, temperature_unit, wind_speed_unit }) => {
      try {
        const geo = await client.geocode(city, 1);
        if (!geo.results || geo.results.length === 0) {
          return { content: [{ type: "text", text: `No location found for "${city}".` }] };
        }
        const location = geo.results[0];

        const data = await client.forecast({
          latitude: location.latitude,
          longitude: location.longitude,
          daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,precipitation_sum,rain_sum,showers_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max",
          forecast_days: forecast_days ?? 7,
          temperature_unit: temperature_unit ?? defaultTempUnit(location.country_code),
          wind_speed_unit: wind_speed_unit ?? defaultWindUnit(location.country_code),
          timezone: "auto",
        });

        if (!data.daily || !data.daily.time) {
          return { content: [{ type: "text", text: "No daily forecast data available." }] };
        }

        const d = data.daily;
        const u = data.daily_units ?? {};
        const times = d.time as string[];

        const locationName = [location.name, location.admin1, location.country].filter(Boolean).join(", ");
        const lines: string[] = [
          `**Daily Forecast for ${locationName}** — ${data.timezone}`,
          "",
        ];

        for (let i = 0; i < times.length; i++) {
          const code = (d.weather_code as number[])[i];
          const sunrise = ((d.sunrise as string[])[i] ?? "").substring(11, 16);
          const sunset = ((d.sunset as string[])[i] ?? "").substring(11, 16);

          lines.push(`**${times[i]}** — ${weatherDescription(code)}`);
          lines.push(
            `  Temp: ${(d.temperature_2m_min as number[])[i]}${u.temperature_2m_min ?? "°C"} – ${(d.temperature_2m_max as number[])[i]}${u.temperature_2m_max ?? "°C"} ` +
            `| Feels: ${(d.apparent_temperature_min as number[])[i]}${u.apparent_temperature_min ?? "°C"} – ${(d.apparent_temperature_max as number[])[i]}${u.apparent_temperature_max ?? "°C"}`
          );
          lines.push(
            `  Precipitation: ${(d.precipitation_sum as number[])[i]}${u.precipitation_sum ?? "mm"} ` +
            `(prob. ${(d.precipitation_probability_max as number[])[i]}${u.precipitation_probability_max ?? "%"}) ` +
            `| Rain: ${(d.rain_sum as number[])[i]}${u.rain_sum ?? "mm"} ` +
            `| Snow: ${(d.snowfall_sum as number[])[i]}${u.snowfall_sum ?? "cm"}`
          );
          lines.push(
            `  Wind: ${(d.wind_speed_10m_max as number[])[i]}${u.wind_speed_10m_max ?? "km/h"} ` +
            `(gusts ${(d.wind_gusts_10m_max as number[])[i]}${u.wind_gusts_10m_max ?? "km/h"}) ` +
            `from ${(d.wind_direction_10m_dominant as number[])[i]}° ` +
            `| UV: ${(d.uv_index_max as number[])[i]}`
          );
          lines.push(`  Sunrise: ${sunrise} | Sunset: ${sunset}`);
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleWeatherError(error) }] };
      }
    }
  );
}
