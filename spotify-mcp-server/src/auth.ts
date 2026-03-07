import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import axios from "axios";
import type { SpotifyConfig, SpotifyTokens } from "./types.js";
import { SPOTIFY_AUTH_URL, SPOTIFY_TOKEN_URL, SPOTIFY_SCOPES } from "./constants.js";

const TOKEN_FILE = path.join(os.homedir(), ".spotify-mcp-tokens.json");

export function loadTokens(): SpotifyTokens | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = fs.readFileSync(TOKEN_FILE, "utf-8");
      return JSON.parse(data) as SpotifyTokens;
    }
  } catch {
    // Ignore corrupted token file
  }
  return null;
}

export function saveTokens(tokens: SpotifyTokens): void {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function refreshAccessToken(
  config: SpotifyConfig,
  refreshToken: string
): Promise<SpotifyTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await axios.post(SPOTIFY_TOKEN_URL, params.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
  });

  const tokens: SpotifyTokens = {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token ?? refreshToken,
    expires_at: Date.now() + response.data.expires_in * 1000,
  };

  saveTokens(tokens);
  return tokens;
}

export async function getValidToken(config: SpotifyConfig): Promise<string> {
  let tokens = loadTokens();

  if (!tokens) {
    tokens = await performAuthFlow(config);
  }

  // Refresh if expiring within 60 seconds
  if (tokens.expires_at - Date.now() < 60_000) {
    tokens = await refreshAccessToken(config, tokens.refresh_token);
  }

  return tokens.access_token;
}

export function performAuthFlow(config: SpotifyConfig): Promise<SpotifyTokens> {
  return new Promise((resolve, reject) => {
    const redirectUrl = new URL(config.redirectUri);
    const port = Number(redirectUrl.port) || 8888;

    const server = http.createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === redirectUrl.pathname || url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end("No authorization code received");
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        try {
          const params = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
          });

          const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, params.toString(), {
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
            },
          });

          const tokens: SpotifyTokens = {
            access_token: tokenResponse.data.access_token,
            refresh_token: tokenResponse.data.refresh_token,
            expires_at: Date.now() + tokenResponse.data.expires_in * 1000,
          };

          saveTokens(tokens);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h1>Authorization successful!</h1><p>You can close this window and return to your application.</p></body></html>");
          server.close();
          resolve(tokens);
        } catch (err) {
          res.writeHead(500);
          res.end("Token exchange failed");
          server.close();
          reject(err);
        }
      }
    });

    server.listen(port, () => {
      const authUrl = new URL(SPOTIFY_AUTH_URL);
      authUrl.searchParams.set("client_id", config.clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", config.redirectUri);
      authUrl.searchParams.set("scope", SPOTIFY_SCOPES);

      const fullAuthUrl = authUrl.toString();
      console.error(`\n🎵 Spotify Authorization Required`);
      console.error(`Open this URL in your browser to authorize:\n`);
      console.error(fullAuthUrl);
      console.error(`\nWaiting for authorization...\n`);

      // Try to open the browser automatically
      import("open").then((open) => open.default(fullAuthUrl)).catch(() => {
        // If open fails, user must manually open the URL
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}
