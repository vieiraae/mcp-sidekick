import axios, { AxiosError } from "axios";
import { OPEN_METEO_FORECAST_BASE, OPEN_METEO_GEOCODING_BASE } from "./constants.js";
import type { GeocodingResponse, ForecastResponse } from "./types.js";

export class WeatherClient {
  async geocode(name: string, count = 5, language = "en"): Promise<GeocodingResponse> {
    const response = await axios.get<GeocodingResponse>(`${OPEN_METEO_GEOCODING_BASE}/search`, {
      params: { name, count, language, format: "json" },
      timeout: 15000,
    });
    return response.data;
  }

  async forecast(params: Record<string, string | number | boolean | undefined>): Promise<ForecastResponse> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined)
    );
    const response = await axios.get<ForecastResponse>(`${OPEN_METEO_FORECAST_BASE}/forecast`, {
      params: cleanParams,
      timeout: 15000,
    });
    return response.data;
  }
}

export function handleWeatherError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const reason = (error.response.data as { reason?: string })?.reason ?? "Unknown error";
      return `Error: Open-Meteo API returned ${error.response.status} - ${reason}`;
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
