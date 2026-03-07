export const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
export const CHARACTER_LIMIT = 25000;

export function getAuthUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function getTokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export const MS_TODO_SCOPES = [
  "Tasks.ReadWrite",
  "User.Read",
  "offline_access",
].join(" ");
