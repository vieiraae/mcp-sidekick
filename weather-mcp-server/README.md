# Weather MCP Server

Part of the [MCP Sidekick](https://github.com/vieiraae/mcp-sidekick) project.

An MCP (Model Context Protocol) server that provides weather forecasts using the free [Open-Meteo API](https://open-meteo.com/) — geocode locations, get current conditions, hourly forecasts, and daily summaries. No API key required.

## Prerequisites

- Node.js >= 18

## Setup

1. **Install & Build**
   ```bash
   cd weather-mcp-server
   npm install
   npm run build
   ```

2. **Configure in your MCP client** — create a `.mcp.json` file in your project:
   ```json
   {
     "servers": {
       "weather": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@mcp-sidekick/weather"]
       }
     }
   }
   ```

3. **Start using** — no authentication needed. The Open-Meteo API is free for non-commercial use with up to 10,000 daily API calls.

## Available Tools

### Geocoding
| Tool | Description |
|---|---|
| `weather_geocode` | Search for a location by name or postal code, returns coordinates |

### Forecast
| Tool | Description |
|---|---|
| `weather_current` | Get current weather conditions for a city |
| `weather_forecast` | Get hourly weather forecast for a city (up to 16 days) |
| `weather_daily` | Get daily weather forecast summary for a city (up to 16 days) |

## Units

Temperature and wind speed units are **automatically detected** based on the city's country:

- **Temperature**: Fahrenheit for US, Bahamas, Cayman Islands, Liberia, Palau, Micronesia, Marshall Islands — Celsius everywhere else
- **Wind speed**: mph for US, UK, Liberia, Myanmar — km/h everywhere else

You can override either unit explicitly via the `temperature_unit` and `wind_speed_unit` parameters.

## Typical Workflow

Just ask for the weather in any city — all tools accept a city name directly and handle geocoding internally. No need to look up coordinates first.

The `weather_geocode` tool is still available if you need to resolve a location name to coordinates for other purposes.

## Data Source

All weather data is provided by [Open-Meteo](https://open-meteo.com/), which combines high-resolution weather models from multiple national weather services worldwide (DWD, NOAA, Météo-France, ECMWF, and more).
