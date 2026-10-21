// CRM request execution layer
// Adapted from electron/main.js fetch + ipcHandlers patterns

const API_VERSION = 'v9.2';
// Dataverse Search API uses a separate base path: /api/search/v1.0/
// It is DISTINCT from the OData data API at /api/data/v9.2/
const SEARCH_API_VERSION = 'v1.0';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const getRetryAfterMs = (response) => {
  const val = response.headers.get('Retry-After');
  if (!val) return null;
  const seconds = parseInt(val, 10);
  if (!isNaN(seconds)) return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS);
  const date = Date.parse(val);
  if (!isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
};

const parseErrorBody = async (response) => {
  try {
    const data = await response.json();
    return data?.error?.message || data?.message || `HTTP ${response.status}`;
  } catch {
    try { return (await response.text()) || `HTTP ${response.status}`; }
    catch { return `HTTP ${response.status}`; }
  }
};

export function createCrmClient(authService) {
  const buildUrl = (entityPath, query, { apiBase } = {}) => {
    const base = authService.getCrmUrl();
    const resolvedApiBase = apiBase ?? `api/data/${API_VERSION}`;
    const url = new URL(`${base}/${resolvedApiBase}/${entityPath}`);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url;
  };

  const getHeaders = (token, contentType, prefer) => ({
    Authorization: `Bearer ${token}`,
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    'Content-Type': contentType || 'application/json',
    Accept: 'application/json',
    Prefer: prefer || 'odata.include-annotations="*"',
    'Cache-Control': 'no-cache'
  });

  const fetchWithRetry = async (url, options, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, backoffMs = DEFAULT_BACKOFF_MS } = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const isWrite = WRITE_METHODS.has(method);
    let attempt = 0;
    let lastError = null;

    while (attempt <= retries) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url.toString(), { ...options, signal: controller.signal });
        clearTimeout(tid);

        if (response.ok) return response;

        if (response.status === 429) {
          const retryMs = getRetryAfterMs(response);
          if (retryMs !== null && attempt < retries) {
            await delay(retryMs);
            attempt++;
            continue;
          }
        }

        if (isWrite && RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          await delay(backoffMs * 2 ** attempt);
          attempt++;
          continue;
        }

        const msg = await parseErrorBody(response);
        const err = new Error(msg);
        err.status = response.status;
        throw err;
      } catch (err) {
        clearTimeout(tid);
        lastError = err;
        // Never auto-retry a non-idempotent POST on timeout/network error: the
        // request may have already reached CRM and created the record, so a retry
        // would produce duplicates (e.g. duplicate opportunities). Idempotent
        // methods (GET/PATCH/PUT/DELETE) remain safe to retry.
        if (attempt < retries && method !== 'POST' && (err?.name === 'AbortError' || err instanceof TypeError)) {
          await delay(backoffMs * 2 ** attempt);
          attempt++;
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error('Request failed');
  };

  /**
   * Execute a CRM request.
   * @param {string} entityPath - e.g. "opportunities" or "tasks(guid)"
   * @param {object} opts
   * @param {string} opts.method - HTTP method (default GET)
   * @param {object} opts.query  - OData query params ($filter, $select, etc.)
   * @param {object|string} opts.body - Request body
   * @param {string} [opts.etag] - ETag for optimistic concurrency (If-Match header)
   * @param {number} opts.timeoutMs
   * @param {number} opts.retries
   * @returns {Promise<{ok: boolean, status: number, data: object|null}>}
   */
  const request = async (entityPath, opts = {}) => {
    const authResult = await authService.ensureAuth();
    if (!authResult.success) {
      return { ok: false, status: 401, data: { message: authResult.error || 'Not authenticated' } };
    }

    const token = authService.getToken();
    const url = buildUrl(entityPath, opts.query, { apiBase: opts.apiBase });
    const method = (opts.method || 'GET').toUpperCase();
    const prefer = opts.prefer || (opts.preferReturnRepresentation || opts.returnRepresentation
      ? 'odata.include-annotations="*", return=representation'
      : undefined);
    const headers = getHeaders(token, opts.contentType, prefer);

    // Add If-Match header for optimistic concurrency on PATCH/DELETE
    if (opts.etag && (method === 'PATCH' || method === 'DELETE')) {
      headers['If-Match'] = opts.etag;
    }

    const fetchOpts = { method, headers };

    if (opts.body !== undefined && opts.body !== null) {
      fetchOpts.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    try {
      const response = await fetchWithRetry(url, fetchOpts, {
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retries: opts.retries ?? (WRITE_METHODS.has(method) ? DEFAULT_RETRIES : 0),
        backoffMs: opts.backoffMs ?? DEFAULT_BACKOFF_MS
      });

      let data = null;
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { data = await response.json(); } catch { /* empty 204 */ }
      }
      const entityId = response.headers.get('OData-EntityId') || response.headers.get('odata-entityid') || null;

      return { ok: true, status: response.status, data, entityId };
    } catch (err) {
      // On 401, clear the cached token and retry once with a fresh token
      if (err.status === 401 && !opts._authRetried) {
        authService.clearToken();
        return request(entityPath, { ...opts, _authRetried: true });
      }
      return {
        ok: false,
        status: err.status || 500,
        data: { message: err.message }
      };
    }
  };

  /**
   * Execute a request and auto-paginate if @odata.nextLink is present.
   * @param {string} entityPath
   * @param {object} opts
   * @param {number} [opts.maxRecords] - Hard ceiling on total records collected across pages. 0 = unlimited.
   */
  const requestAllPages = async (entityPath, opts = {}) => {
    const maxRecords = opts.maxRecords || 0; // 0 = no cap (caller-controlled)
    const first = await request(entityPath, opts);
    if (!first.ok || !first.data?.value) return first;

    const allValues = [...first.data.value];
    let nextLink = first.data['@odata.nextLink'];

    // Respect ceiling
    if (maxRecords > 0 && allValues.length >= maxRecords) {
      allValues.length = maxRecords;
      return { ok: true, status: 200, data: { ...first.data, value: allValues, truncated: true } };
    }

    while (nextLink) {
      const authResult = await authService.ensureAuth();
      if (!authResult.success) break;

      const token = authService.getToken();
      try {
        const resp = await fetch(nextLink, {
          headers: getHeaders(token)
        });
        if (resp.status === 401) {
          // Clear stale token and retry this page once
          authService.clearToken();
          const retryAuth = await authService.ensureAuth();
          if (!retryAuth.success) break;
          const retryResp = await fetch(nextLink, {
            headers: getHeaders(authService.getToken())
          });
          if (!retryResp.ok) break;
          const retryPage = await retryResp.json();
          if (retryPage?.value) allValues.push(...retryPage.value);
          nextLink = retryPage['@odata.nextLink'];
          continue;
        }
        if (!resp.ok) break;
        const page = await resp.json();
        if (page?.value) allValues.push(...page.value);
        // Enforce ceiling mid-pagination
        if (maxRecords > 0 && allValues.length >= maxRecords) {
          allValues.length = maxRecords;
          return { ok: true, status: 200, data: { ...first.data, value: allValues, truncated: true } };
        }
        nextLink = page['@odata.nextLink'];
      } catch {
        break;
      }
    }

    return { ok: true, status: 200, data: { ...first.data, value: allValues } };
  };

  /**
   * Execute a Dataverse Search API request (POST).
   *
   * Contract: Dataverse Search lives at /api/search/v1.0/ — DISTINCT from the OData
   * data API at /api/data/v9.2/. Pass only the operation name as resource (e.g. "suggest"
   * or "query"); this helper injects the correct base path automatically.
   *
   * @param {string} resource - Operation name only, e.g. "suggest" or "query"
   * @param {object} searchOpts - Body params forwarded as JSON (e.g. { search, entities, top, filter })
   * @returns {Promise<{ok: boolean, status: number, data: object|null}>}
   */
  const search = async (resource, searchOpts = {}) => {
    return request(resource, { method: 'POST', body: searchOpts, apiBase: `api/search/${SEARCH_API_VERSION}` });
  };

  return { request, requestAllPages, search, buildUrl, getCrmUrl: () => authService.getCrmUrl() };
}
