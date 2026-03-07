import axios, { AxiosError } from "axios";
import type { MicrosoftTodoConfig } from "./types.js";
import { GRAPH_API_BASE } from "./constants.js";
import { getValidToken } from "./auth.js";

export class GraphClient {
  constructor(private config: MicrosoftTodoConfig) {}

  async request<T>(
    endpoint: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    data?: unknown,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    const token = await getValidToken(this.config);

    const cleanParams = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
      : undefined;

    const response = await axios({
      method,
      url: `${GRAPH_API_BASE}/${endpoint}`,
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
    method: "DELETE" | "PATCH" = "DELETE",
    data?: unknown
  ): Promise<void> {
    const token = await getValidToken(this.config);

    await axios({
      method,
      url: `${GRAPH_API_BASE}/${endpoint}`,
      data,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  }
}

export function handleGraphError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const graphError = error.response.data?.error;
      const message = graphError?.message ?? "Unknown error";
      const code = graphError?.code ?? "";

      switch (status) {
        case 401:
          return "Error: Authentication expired. The server will try to refresh the token on the next request.";
        case 403:
          return `Error: Forbidden - ${message}. Check that the required permissions (Tasks.ReadWrite) are consented.`;
        case 404:
          return `Error: Not found - ${message}. Check that the list or task ID is correct.`;
        case 409:
          return `Error: Conflict - ${message}.`;
        case 429: {
          const retryAfter = error.response.headers["retry-after"];
          return `Error: Rate limited. Retry after ${retryAfter ?? "a few"} seconds.`;
        }
        default:
          return `Error: Microsoft Graph returned ${status} (${code}) - ${message}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export function formatDateTime(dt: { dateTime: string; timeZone: string } | undefined): string {
  if (!dt) return "N/A";
  return new Date(dt.dateTime + "Z").toLocaleString();
}

export function formatStatus(status: string): string {
  const map: Record<string, string> = {
    notStarted: "Not Started",
    inProgress: "In Progress",
    completed: "Completed",
    waitingOnOthers: "Waiting on Others",
    deferred: "Deferred",
  };
  return map[status] ?? status;
}

export function formatImportance(importance: string): string {
  const map: Record<string, string> = {
    low: "Low",
    normal: "Normal",
    high: "High ⚠️",
  };
  return map[importance] ?? importance;
}
