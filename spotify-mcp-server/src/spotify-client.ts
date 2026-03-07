import axios, { AxiosError } from "axios";
import type { SpotifyConfig } from "./types.js";
import { SPOTIFY_API_BASE } from "./constants.js";
import { getValidToken } from "./auth.js";

export class SpotifyClient {
  constructor(private config: SpotifyConfig) {}

  async request<T>(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    data?: unknown,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    const token = await getValidToken(this.config);

    // Filter out undefined params
    const cleanParams = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
      : undefined;

    const response = await axios({
      method,
      url: `${SPOTIFY_API_BASE}/${endpoint}`,
      data,
      params: cleanParams,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    return response.data as T;
  }

  async requestNoContent(
    endpoint: string,
    method: "PUT" | "POST" | "DELETE" = "PUT",
    data?: unknown,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<void> {
    const token = await getValidToken(this.config);

    const cleanParams = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
      : undefined;

    await axios({
      method,
      url: `${SPOTIFY_API_BASE}/${endpoint}`,
      data,
      params: cleanParams,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  }
}

export function handleSpotifyError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error?.message ?? "Unknown error";

      switch (status) {
        case 401:
          return "Error: Authentication expired. The server will try to refresh the token on the next request.";
        case 403:
          return `Error: Forbidden - ${message}. Check that the required scopes are authorized.`;
        case 404:
          return `Error: Not found - ${message}. Check the ID or URI is correct.`;
        case 429: {
          const retryAfter = error.response.headers["retry-after"];
          return `Error: Rate limited. Retry after ${retryAfter ?? "a few"} seconds.`;
        }
        default:
          return `Error: Spotify API returned ${status} - ${message}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
