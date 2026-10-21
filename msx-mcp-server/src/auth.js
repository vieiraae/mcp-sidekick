// MSX CRM authentication service.
//
// By default, CRM access tokens are acquired from the Azure CLI and kept only in
// memory. The Azure CLI is invoked again when the token is near expiry or after
// CRM rejects it. Set MSX_AUTH_SOURCE=msal to use the MSX-IQ-compatible MSAL
// cache and device-code sign-in instead.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LogLevel, PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { createMsalCachePlugin } from './msal-cache-plugin.js';

const DEFAULT_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

// Impersonate the Azure CLI public client — broadly trusted and pre-authorized
// for Dynamics 365 / Dataverse, identical to the identity `az` uses.
const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const AZURE_CLI_TIMEOUT_MS = 60_000;
const AUTH_SOURCES = new Set(['azure-cli', 'msal']);

// Shared "Azure" MSAL cache — the same file MSX-IQ uses for CRM and EngineeringHub.
function getDefaultCachePath() {
  return join(homedir(), '.msx-iq', 'enghub-msal-cache.json');
}

const base64UrlDecode = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '='
  );
  return Buffer.from(padded, 'base64').toString('utf-8');
};

const parseTokenMetadata = (token, crmUrl) => {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(base64UrlDecode(payload));
    const exp = json.exp ? Number(json.exp) * 1000 : null;
    const expiresAt = exp ? new Date(exp) : null;
    const minutesRemaining = expiresAt
      ? Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 60_000), 0)
      : 0;
    return {
      isAuthenticated: true,
      userName: json.upn || json.unique_name || json.name || null,
      audience: json.aud || crmUrl,
      expiresAt,
      minutesRemaining,
      isExpired: expiresAt ? expiresAt <= Date.now() : false,
      isExpiringSoon: minutesRemaining > 0 && minutesRemaining <= 10
    };
  } catch {
    return null;
  }
};

function buildScopes(crmUrl) {
  const base = (crmUrl || '').replace(/\/+$/, '');
  return [`${base}/.default`];
}

function runAzureCli(args) {
  const command = process.env.MSX_AZ_PATH || (process.platform === 'win32' ? 'az.cmd' : 'az');
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: AZURE_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function describeAzureCliError(error, tenantId) {
  if (error?.code === 'ENOENT') {
    return 'Azure CLI was not found. Install it or set MSX_AZ_PATH to the az executable.';
  }
  if (error?.killed) {
    return 'Azure CLI timed out while acquiring an MSX CRM token.';
  }
  const detail = String(error?.stderr || error?.message || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return `Azure CLI could not acquire an MSX CRM token. Run \`az login --tenant ${tenantId}\` and try again.${detail ? ` Details: ${detail}` : ''}`;
}

function parseAzureCliExpiry(result) {
  const epoch = Number(result.expires_on);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
  const parsed = result.expiresOn ? new Date(result.expiresOn) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function buildFallbackMetadata(crmUrl, userName, expiresAt) {
  const minutesRemaining = expiresAt
    ? Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 60_000), 0)
    : 0;
  return {
    isAuthenticated: true,
    userName: userName ?? null,
    audience: crmUrl,
    expiresAt,
    minutesRemaining,
    isExpired: expiresAt ? expiresAt <= new Date() : false,
    isExpiringSoon: minutesRemaining > 0 && minutesRemaining <= 10,
  };
}

export function createAuthService({
  crmUrl,
  tenantId = DEFAULT_TENANT_ID,
  authSource = process.env.MSX_AUTH_SOURCE || 'azure-cli',
  clientId = process.env.MSX_CLIENT_ID || AZURE_CLI_CLIENT_ID,
  cachePath = process.env.MSX_MCP_CACHE_PATH || getDefaultCachePath(),
  publicClientFactory,
  azureCliRunner = runAzureCli,
} = {}) {
  if (!AUTH_SOURCES.has(authSource)) {
    throw new Error(`Unsupported MSX_AUTH_SOURCE "${authSource}". Use "azure-cli" or "msal".`);
  }

  const state = {
    token: null,
    metadata: null,
    crmUrl,
    tenantId,
    authSource,
    clientId,
    scopes: buildScopes(crmUrl),
    cachePath,
    pca: null,
    cacheCorrupted: false,
    tokenRequest: null,
  };

  const cachePlugin = createMsalCachePlugin({
    cachePath: state.cachePath,
    onCacheCorruption: () => {
      state.cacheCorrupted = true;
    },
  });

  function getPca() {
    if (state.pca) return state.pca;
    const config = {
      auth: {
        clientId: state.clientId,
        authority: `https://login.microsoftonline.com/${state.tenantId}`,
      },
      cache: { cachePlugin },
      system: {
        loggerOptions: {
          logLevel: LogLevel.Warning,
          loggerCallback: () => {},
          piiLoggingEnabled: false,
        },
      },
    };
    state.pca = publicClientFactory ? publicClientFactory(config) : new PublicClientApplication(config);
    return state.pca;
  }

  function isTokenUsable() {
    if (!state.token || !state.metadata) return false;
    if (state.metadata.expiresAt) {
      const remainingMs = state.metadata.expiresAt.getTime() - Date.now();
      if (remainingMs < TOKEN_REFRESH_BUFFER_MS) return false;
    }
    return true;
  }

  async function getCachedAccount() {
    const accounts = await getPca().getTokenCache().getAllAccounts();
    return accounts[0] || null;
  }

  async function acquireTokenSilent() {
    const account = await getCachedAccount();
    if (!account) return null;
    try {
      return await getPca().acquireTokenSilent({ account, scopes: state.scopes });
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError || err.name === 'InteractionRequiredAuthError') {
        return null;
      }
      throw err;
    }
  }

  async function acquireTokenFromAzureCli() {
    const stdout = await azureCliRunner([
      'account',
      'get-access-token',
      '--tenant',
      state.tenantId,
      '--resource',
      (state.crmUrl || '').replace(/\/+$/, ''),
      '--output',
      'json',
      '--only-show-errors',
    ]);

    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error('Azure CLI returned an invalid token response.');
    }
    if (!result?.accessToken) {
      throw new Error('Azure CLI returned no MSX CRM access token.');
    }

    const metadata = parseTokenMetadata(result.accessToken, state.crmUrl)
      ?? buildFallbackMetadata(state.crmUrl, null, parseAzureCliExpiry(result));
    state.token = result.accessToken;
    state.metadata = metadata;
    return { success: true, metadata: { ...metadata } };
  }

  function ensureAzureCliAuth() {
    if (isTokenUsable()) {
      return Promise.resolve({ success: true, metadata: { ...state.metadata } });
    }
    // Concurrent tool calls share one az invocation.
    if (!state.tokenRequest) {
      state.tokenRequest = acquireTokenFromAzureCli()
        .catch((error) => {
          clearToken();
          return {
            success: false,
            error: describeAzureCliError(error, state.tenantId),
            requiresSignIn: true,
          };
        })
        .finally(() => {
          state.tokenRequest = null;
        });
    }
    return state.tokenRequest;
  }

  const signInWithDeviceCode = async (deviceCodeCallback) => {
    if (state.authSource !== 'msal') {
      throw new Error('Device-code sign-in is only available when MSX_AUTH_SOURCE=msal.');
    }
    const result = await getPca().acquireTokenByDeviceCode({
      scopes: state.scopes,
      deviceCodeCallback,
    });
    if (!result?.accessToken) {
      throw new Error('Azure device-code sign-in completed without an access token.');
    }

    state.token = result.accessToken;
    state.metadata = parseTokenMetadata(result.accessToken, state.crmUrl)
      ?? buildFallbackMetadata(state.crmUrl, result.account?.username, result.expiresOn ?? null);
    state.cacheCorrupted = false;
    return { success: true, metadata: { ...state.metadata } };
  };

  const clearToken = () => {
    state.token = null;
    state.metadata = null;
  };

  const ensureAuth = async (settings = {}) => {
    if (settings.crmUrl && settings.crmUrl !== state.crmUrl) {
      state.crmUrl = settings.crmUrl;
      state.scopes = buildScopes(settings.crmUrl);
      clearToken();
    }
    if (settings.tenantId && settings.tenantId !== state.tenantId) {
      state.tenantId = settings.tenantId;
      state.pca = null;
      clearToken();
    }

    if (state.authSource === 'azure-cli') {
      return ensureAzureCliAuth();
    }

    if (isTokenUsable()) {
      return { success: true, metadata: { ...state.metadata } };
    }

    try {
      const result = await acquireTokenSilent();
      if (!result?.accessToken) {
        clearToken();
        return {
          success: false,
          error: state.cacheCorrupted
            ? 'Cached Azure credentials were damaged and were reset. Run the server with --auth to sign in to Azure again.'
            : 'Azure sign-in required. Run the server with --auth to sign in to Azure and connect MSX CRM.',
          requiresSignIn: true,
        };
      }
      state.token = result.accessToken;
      state.metadata = parseTokenMetadata(result.accessToken, state.crmUrl);
      state.cacheCorrupted = false;
      return { success: true, metadata: { ...state.metadata } };
    } catch (error) {
      clearToken();
      return { success: false, error: error.message, requiresSignIn: true };
    }
  };

  const getToken = () => state.token;
  const getAuthStatus = () =>
    state.metadata ? { ...state.metadata } : { isAuthenticated: false };
  const getCrmUrl = () => state.crmUrl;

  return {
    ensureAuth,
    signInWithDeviceCode,
    getToken,
    getAuthStatus,
    getCrmUrl,
    clearToken,
    _state: state,
  };
}
