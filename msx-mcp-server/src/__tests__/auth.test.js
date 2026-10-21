import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthService } from '../auth.js';

// Helper: create a fake JWT with a given exp
function fakeJwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    name: 'Test User',
    upn: 'test@microsoft.com',
    aud: 'https://test.crm.dynamics.com',
    exp
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

// Build a fake MSAL PublicClientApplication. `accounts` controls whether a
// cached account exists; `silentResult` controls what acquireTokenSilent returns
// (or set `silentError` to throw).
function makeFakePca({
  accounts = [],
  silentResult = null,
  silentError = null,
  deviceCodeResult = null,
  deviceCodeError = null,
} = {}) {
  return {
    getTokenCache: () => ({
      getAllAccounts: vi.fn(async () => accounts),
    }),
    acquireTokenSilent: vi.fn(async () => {
      if (silentError) throw silentError;
      return silentResult;
    }),
    acquireTokenByDeviceCode: vi.fn(async (request) => {
      request.deviceCodeCallback({ message: 'Use the displayed verification code.' });
      if (deviceCodeError) throw deviceCodeError;
      return deviceCodeResult;
    }),
  };
}

describe('createAuthService (MSAL)', () => {
  let svc;
  let fakePca;

  beforeEach(() => {
    vi.clearAllMocks();
    fakePca = makeFakePca();
    svc = createAuthService({
      authSource: 'msal',
      crmUrl: 'https://test.crm.dynamics.com',
      tenantId: '00000000-0000-0000-0000-000000000000',
      cachePath: '/tmp/msx-iq-test-cache-does-not-exist.json',
      publicClientFactory: () => fakePca,
    });
  });

  it('exposes expected methods', () => {
    expect(typeof svc.ensureAuth).toBe('function');
    expect(typeof svc.signInWithDeviceCode).toBe('function');
    expect(typeof svc.getToken).toBe('function');
    expect(typeof svc.getAuthStatus).toBe('function');
    expect(typeof svc.getCrmUrl).toBe('function');
    expect(typeof svc.clearToken).toBe('function');
  });

  it('builds the resource /.default scope from crmUrl', () => {
    expect(svc._state.scopes).toEqual(['https://test.crm.dynamics.com/.default']);
  });

  it('getAuthStatus returns unauthenticated when no token', () => {
    expect(svc.getAuthStatus()).toEqual({ isAuthenticated: false });
  });

  it('ensureAuth acquires a token silently from the shared cache', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = fakeJwt(futureExp);
    fakePca = makeFakePca({
      accounts: [{ homeAccountId: 'abc', username: 'test@microsoft.com' }],
      silentResult: { accessToken: token },
    });
    svc = createAuthService({
      authSource: 'msal',
      crmUrl: 'https://test.crm.dynamics.com',
      tenantId: '00000000-0000-0000-0000-000000000000',
      cachePath: '/tmp/msx-iq-test-cache-does-not-exist.json',
      publicClientFactory: () => fakePca,
    });

    const result = await svc.ensureAuth();
    expect(result.success).toBe(true);
    expect(result.metadata.userName).toBe('test@microsoft.com'); // Now prefers UPN over name
    expect(svc.getToken()).toBe(token);
    expect(fakePca.acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['https://test.crm.dynamics.com/.default'] })
    );
  });

  it('ensureAuth reports requiresSignIn when no cached account exists', async () => {
    const result = await svc.ensureAuth();
    expect(result.success).toBe(false);
    expect(result.requiresSignIn).toBe(true);
    expect(result.error).toMatch(/sign in to azure/i);
  });

  it('signs in with device code using the CRM scope and exposes the returned account', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = fakeJwt(futureExp);
    const deviceCodeResult = {
      accessToken: token,
      account: { username: 'device-user@microsoft.com' },
    };
    fakePca = makeFakePca({ deviceCodeResult });
    svc = createAuthService({
      authSource: 'msal',
      crmUrl: 'https://test.crm.dynamics.com',
      tenantId: '00000000-0000-0000-0000-000000000000',
      cachePath: '/tmp/msx-iq-test-cache-does-not-exist.json',
      publicClientFactory: () => fakePca,
    });
    const onDeviceCode = vi.fn();

    const result = await svc.signInWithDeviceCode(onDeviceCode);

    expect(result.success).toBe(true);
    expect(result.metadata.userName).toBe('test@microsoft.com');
    expect(svc.getToken()).toBe(token);
    expect(onDeviceCode).toHaveBeenCalledWith({
      message: 'Use the displayed verification code.',
    });
    expect(fakePca.acquireTokenByDeviceCode).toHaveBeenCalledWith({
      scopes: ['https://test.crm.dynamics.com/.default'],
      deviceCodeCallback: onDeviceCode,
    });
  });

  it('fails device-code sign-in when MSAL returns no access token', async () => {
    await expect(svc.signInWithDeviceCode(vi.fn())).rejects.toThrow(
      'Azure device-code sign-in completed without an access token.'
    );
  });

  it('ensureAuth reports requiresSignIn when silent interaction is required', async () => {
    const err = new Error('interaction required');
    err.name = 'InteractionRequiredAuthError';
    fakePca = makeFakePca({
      accounts: [{ homeAccountId: 'abc' }],
      silentError: err,
    });
    svc = createAuthService({
      authSource: 'msal',
      crmUrl: 'https://test.crm.dynamics.com',
      cachePath: '/tmp/msx-iq-test-cache-does-not-exist.json',
      publicClientFactory: () => fakePca,
    });

    const result = await svc.ensureAuth();
    expect(result.success).toBe(false);
    expect(result.requiresSignIn).toBe(true);
  });

  it('ensureAuth reuses cached non-expired token without calling MSAL again', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    svc._state.token = fakeJwt(futureExp);
    svc._state.metadata = {
      isAuthenticated: true,
      userName: 'Cached User',
      isExpired: false,
      expiresAt: new Date(futureExp * 1000)
    };

    const result = await svc.ensureAuth();
    expect(result.success).toBe(true);
    expect(result.metadata.userName).toBe('Cached User');
    expect(fakePca.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it('ensureAuth refreshes a token that is expiring soon (< 2 min)', async () => {
    const soonExp = Math.floor(Date.now() / 1000) + 60;
    svc._state.token = fakeJwt(soonExp);
    svc._state.metadata = {
      isAuthenticated: true,
      userName: 'Old User',
      isExpired: false,
      expiresAt: new Date(soonExp * 1000)
    };

    const freshExp = Math.floor(Date.now() / 1000) + 3600;
    const freshToken = fakeJwt(freshExp);
    fakePca = makeFakePca({
      accounts: [{ homeAccountId: 'abc' }],
      silentResult: { accessToken: freshToken },
    });
    svc = createAuthService({
      authSource: 'msal',
      crmUrl: 'https://test.crm.dynamics.com',
      cachePath: '/tmp/msx-iq-test-cache-does-not-exist.json',
      publicClientFactory: () => fakePca,
    });
    svc._state.token = fakeJwt(soonExp);
    svc._state.metadata = {
      isAuthenticated: true,
      userName: 'Old User',
      isExpired: false,
      expiresAt: new Date(soonExp * 1000)
    };

    const result = await svc.ensureAuth();
    expect(result.success).toBe(true);
    expect(fakePca.acquireTokenSilent).toHaveBeenCalled();
    expect(svc.getToken()).toBe(freshToken);
  });

  it('clearToken invalidates cached credentials', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    svc._state.token = fakeJwt(futureExp);
    svc._state.metadata = { isAuthenticated: true, userName: 'Test' };

    svc.clearToken();
    expect(svc.getToken()).toBeNull();
    expect(svc.getAuthStatus()).toEqual({ isAuthenticated: false });
  });
});

describe('createAuthService (Azure CLI)', () => {
  const crmUrl = 'https://test.crm.dynamics.com/';
  const tenantId = '00000000-0000-0000-0000-000000000000';

  function makeService(runner) {
    return createAuthService({ authSource: 'azure-cli', crmUrl, tenantId, azureCliRunner: runner });
  }

  it('acquires a token with the configured tenant and CRM resource', async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const runner = vi.fn(async () => JSON.stringify({ accessToken: token }));
    const svc = makeService(runner);

    const result = await svc.ensureAuth();

    expect(result.success).toBe(true);
    expect(result.metadata.userName).toBe('test@microsoft.com');
    expect(svc.getToken()).toBe(token);
    expect(runner).toHaveBeenCalledWith([
      'account', 'get-access-token',
      '--tenant', tenantId,
      '--resource', 'https://test.crm.dynamics.com',
      '--output', 'json',
      '--only-show-errors',
    ]);
  });

  it('reuses the in-memory token until it needs refresh', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
    }));
    const svc = makeService(runner);

    await svc.ensureAuth();
    await svc.ensureAuth();

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('calls Azure CLI again when the token is near expiry', async () => {
    const oldToken = fakeJwt(Math.floor(Date.now() / 1000) + 60);
    const newToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const runner = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ accessToken: oldToken }))
      .mockResolvedValueOnce(JSON.stringify({ accessToken: newToken }));
    const svc = makeService(runner);

    await svc.ensureAuth();
    await svc.ensureAuth();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(svc.getToken()).toBe(newToken);
  });

  it('calls Azure CLI again after clearToken', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
    }));
    const svc = makeService(runner);

    await svc.ensureAuth();
    svc.clearToken();
    await svc.ensureAuth();

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('shares one Azure CLI call across concurrent requests', async () => {
    let resolve;
    const runner = vi.fn(() => new Promise((r) => { resolve = r; }));
    const svc = makeService(runner);

    const pending = Promise.all([svc.ensureAuth(), svc.ensureAuth()]);
    resolve(JSON.stringify({ accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600) }));
    const results = await pending;

    expect(runner).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('uses Azure CLI expiry fields for opaque tokens', async () => {
    const expiresOn = Math.floor(Date.now() / 1000) + 3600;
    const svc = makeService(vi.fn(async () => JSON.stringify({
      accessToken: 'opaque-token',
      expires_on: expiresOn,
    })));

    const result = await svc.ensureAuth();

    expect(result.metadata.expiresAt).toEqual(new Date(expiresOn * 1000));
  });

  it('returns a sign-in hint without exposing command output secrets', async () => {
    const error = new Error('Command failed');
    error.stderr = 'ERROR: Please run az login.\nsecret-token-value';
    const svc = makeService(vi.fn(async () => { throw error; }));

    const result = await svc.ensureAuth();

    expect(result.success).toBe(false);
    expect(result.requiresSignIn).toBe(true);
    expect(result.error).toContain(`az login --tenant ${tenantId}`);
    expect(result.error).toContain('ERROR: Please run az login.');
    expect(result.error).not.toContain('secret-token-value');
    expect(svc.getToken()).toBeNull();
  });

  it('reports a missing Azure CLI', async () => {
    const error = Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
    const svc = makeService(vi.fn(async () => { throw error; }));

    const result = await svc.ensureAuth();

    expect(result.error).toContain('Azure CLI was not found');
  });

  it('rejects device-code sign-in in Azure CLI mode', async () => {
    const svc = makeService(vi.fn());
    await expect(svc.signInWithDeviceCode(() => {})).rejects.toThrow('MSX_AUTH_SOURCE=msal');
  });
});
