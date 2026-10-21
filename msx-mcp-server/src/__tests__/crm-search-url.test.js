/**
 * crm-search-url.test.js
 *
 * Unit tests for URL construction in crm.js — specifically the seam that broke in production.
 *
 * BUG HISTORY: Before the fix, search('suggest', {...}) routed through buildUrl which
 * hardcoded /api/data/v9.2/, causing POST /api/data/v9.2/suggest (404) instead of
 * the real Dataverse Search endpoint POST /api/search/v1.0/suggest.
 *
 * These tests pin the FETCH URL so a URL regression fails immediately, not silently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCrmClient } from '../crm.js';

const BASE_URL = 'https://org.crm.dynamics.com';

function mockAuthService() {
  return {
    getCrmUrl: vi.fn().mockReturnValue(BASE_URL),
    ensureAuth: vi.fn().mockResolvedValue({ success: true }),
    getToken: vi.fn().mockReturnValue('tok-abc'),
    clearToken: vi.fn()
  };
}

function makeFetchStub() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ value: [] })
  });
}

describe('crm.js URL construction', () => {
  let auth;
  let client;
  let fetchStub;

  beforeEach(() => {
    auth = mockAuthService();
    client = createCrmClient(auth);
    fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
  });

  it('search("suggest") hits /api/search/v1.0/suggest — NOT /api/data/', async () => {
    await client.search('suggest', { search: 'caixa', entities: ['account'], top: 10, filter: 'statecode eq 0' });

    expect(fetchStub).toHaveBeenCalledOnce();
    const [urlArg] = fetchStub.mock.calls[0];
    expect(urlArg).toBe(`${BASE_URL}/api/search/v1.0/suggest`);
    expect(urlArg).not.toContain('/api/data/');
  });

  it('search("suggest") sends a POST request', async () => {
    await client.search('suggest', { search: 'caixa', entities: ['account'], top: 10, filter: 'statecode eq 0' });

    const [, optsArg] = fetchStub.mock.calls[0];
    expect(optsArg.method).toBe('POST');
  });

  it('search("suggest") body contains entities:["account"] and filter:"statecode eq 0"', async () => {
    await client.search('suggest', { search: 'caixa', entities: ['account'], top: 10, filter: 'statecode eq 0' });

    const [, optsArg] = fetchStub.mock.calls[0];
    const body = JSON.parse(optsArg.body);
    expect(body.entities).toEqual(['account']);
    expect(body.filter).toBe('statecode eq 0');
    expect(body.search).toBe('caixa');
  });

  it('normal OData request still targets /api/data/v9.2/ — no regression', async () => {
    await client.request('accounts', { query: { $filter: "startswith(name,'test')", $top: '5' } });

    expect(fetchStub).toHaveBeenCalledOnce();
    const [urlArg] = fetchStub.mock.calls[0];
    expect(urlArg).toContain(`${BASE_URL}/api/data/v9.2/accounts`);
    expect(urlArg).not.toContain('/api/search/');
  });

  it('search("query") also uses /api/search/v1.0/ base (not just suggest)', async () => {
    await client.search('query', { search: 'test', entities: ['account'] });

    const [urlArg] = fetchStub.mock.calls[0];
    expect(urlArg).toBe(`${BASE_URL}/api/search/v1.0/query`);
    expect(urlArg).not.toContain('/api/data/');
  });

  it('bears the Authorization header on search requests', async () => {
    await client.search('suggest', { search: 'caixa', entities: ['account'] });

    const [, optsArg] = fetchStub.mock.calls[0];
    expect(optsArg.headers.Authorization).toBe('Bearer tok-abc');
  });
});
