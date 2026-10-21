// NDJSON-based audit log persistence.
// See docs/specs/feature-1-audit-log-spec.md §4, §6.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  presentRecords,
  presentRecord,
  buildAccountIndex,
  deriveCrmBase,
  resolveCustomer,
} from './audit-present.js';

// Defense-in-depth: when running under the test runner, never fall back to the
// real user home dir. Any forgotten MSX_USER_DATA restore is caught here.
const _IN_TEST = !!(process.env.VITEST || process.env.NODE_ENV === 'test');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Resolve the data directory from MSX_USER_DATA or an override.
 * Mirrors web/src/data-paths.js logic.
 * @param {string|null} [dirOverride]
 * @returns {string}
 */
function resolveDataDir(dirOverride = null) {
  if (dirOverride) return dirOverride;
  if (process.env.MSX_USER_DATA && existsSync(process.env.MSX_USER_DATA)) {
    return process.env.MSX_USER_DATA;
  }
  // Under the test runner, never fall back to homedir — use a stable tmp guard
  // dir instead so a forgotten MSX_USER_DATA restore can NEVER pollute the real
  // user data directory.
  if (_IN_TEST) {
    const guard = join(tmpdir(), '.msx-iq-test-data');
    if (!existsSync(guard)) mkdirSync(guard, { recursive: true });
    return guard;
  }
  // Dev/prod fallback: OS user-data location (NOT repo dir)
  // Prefer homedir/.msx-iq-data over tmpdir for persistence across dev sessions
  try {
    const fallback = join(homedir(), '.msx-iq-data');
    if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return tmpdir();
  }
}

/**
 * Get the active audit log file name (rotates by month + size).
 * @param {string} dataDir
 * @returns {string} - absolute path
 */
function getActiveLogFile(dataDir) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const activeFile = join(dataDir, `audit-log-${month}.ndjson`);

  // Check size guard — if current month file exceeds MAX_FILE_SIZE, start a new one
  if (existsSync(activeFile)) {
    const stats = statSync(activeFile);
    if (stats.size >= MAX_FILE_SIZE) {
      // Append a sequence suffix
      let seq = 1;
      let rotatedFile;
      do {
        rotatedFile = join(dataDir, `audit-log-${month}-${seq}.ndjson`);
        seq++;
      } while (existsSync(rotatedFile) && statSync(rotatedFile).size >= MAX_FILE_SIZE);
      return rotatedFile;
    }
  }

  return activeFile;
}

let writeErrorLogged = false; // One-time diagnostic flag

/**
 * Append a ChangeRecord to the audit log (NDJSON).
 * Never throws — best-effort like audit.js.
 * @param {object} record - ChangeRecord
 * @param {object} [opts]
 * @param {string} [opts.dir] - Data directory override (for tests)
 */
export function appendChangeRecord(record, { dir = null } = {}) {
  try {
    const dataDir = resolveDataDir(dir);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const logFile = getActiveLogFile(dataDir);
    const line = JSON.stringify(record) + '\n';
    appendFileSync(logFile, line, 'utf8');
  } catch (err) {
    // Never crash on logging failure (spec §3.2)
    // Emit one-time diagnostic so misconfig is visible
    if (!writeErrorLogged) {
      console.error('[audit-store] Failed to write audit log:', err.message ?? String(err));
      writeErrorLogged = true;
    }
  }
}

/**
 * Read all audit records from disk (with resilience).
 * @param {string} dir - Data directory override (for tests) or null
 * @returns {object[]} - Array of parsed records
 */
export function readAllRecords(dir = null) {
  const dataDir = resolveDataDir(dir);
  if (!existsSync(dataDir)) {
    return [];
  }

  let files = [];
  try {
    files = readdirSync(dataDir)
      .filter(f => f.startsWith('audit-log') && f.endsWith('.ndjson'))
      .map(f => join(dataDir, f));
  } catch {
    return [];
  }

  const allRecords = [];
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          allRecords.push(record);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return allRecords;
}

/**
 * Apply filters to a collection of audit records.
 * @param {object[]} records
 * @param {object} query - Filter parameters
 * @returns {object[]} - Filtered records
 */
function applyFilters(records, query) {
  let filtered = records;

  // Guard against HTTP parameter tampering: a query param can arrive as an array
  // (e.g. ?endDate[]=x), so coerce string-typed filters to a string (or null)
  // before calling string methods — prevents type confusion.
  const startDate = typeof query.startDate === 'string' ? query.startDate : null;
  const endDate = typeof query.endDate === 'string' ? query.endDate : null;
  const entitySet = typeof query.entitySet === 'string' ? query.entitySet : null;
  const search = typeof query.search === 'string' ? query.search : null;

  if (startDate) {
    const start = new Date(startDate);
    if (!isNaN(start.getTime())) {
      filtered = filtered.filter(r => new Date(r.ts) >= start);
    }
  }
  if (endDate) {
    let end;
    if (endDate.includes('T')) {
      end = new Date(endDate);
    } else {
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    }
    if (!isNaN(end.getTime())) {
      filtered = filtered.filter(r => new Date(r.ts) <= end);
    }
  }
  if (entitySet) {
    filtered = filtered.filter(r => r.entitySet && r.entitySet.toLowerCase().includes(entitySet.toLowerCase()));
  }
  if (query.method) {
    filtered = filtered.filter(r => r.method === query.method);
  }
  if (query.phase) {
    filtered = filtered.filter(r => r.phase === query.phase);
  }
  if (query.actor) {
    filtered = filtered.filter(r => r.actor === query.actor);
  }
  if (query.correlationId !== undefined) {
    filtered = filtered.filter(r => r.correlationId === query.correlationId);
  }
  if (search) {
    const lowerSearch = search.toLowerCase();
    filtered = filtered.filter(r =>
      (r.description && r.description.toLowerCase().includes(lowerSearch)) ||
      (r.recordName && r.recordName.toLowerCase().includes(lowerSearch))
    );
  }
  // source filter: 'batch' = correlationId != null; 'manual' = correlationId == null
  if (query.source === 'batch') {
    filtered = filtered.filter(r => r.correlationId != null);
  } else if (query.source === 'manual') {
    filtered = filtered.filter(r => r.correlationId == null);
  }
  // outcome filter: 'ok' = phase === 'executed'; 'attention' = phase in {failed, stale-conflict, dead-letter, uncertain}
  if (query.outcome === 'ok') {
    filtered = filtered.filter(r => r.phase === 'executed');
  } else if (query.outcome === 'attention') {
    const attentionPhases = new Set(['failed', 'stale-conflict', 'dead-letter', 'uncertain']);
    filtered = filtered.filter(r => attentionPhases.has(r.phase));
  }

  return filtered;
}

/**
 * Query the audit log with filters and pagination.
 * Reads NDJSON file(s), filters in-memory, returns newest-first.
 * @param {object} [query]
 * @param {string} [query.startDate]   - ISO date string (inclusive)
 * @param {string} [query.endDate]     - ISO date string (inclusive)
 * @param {string} [query.entitySet]   - Filter by entity set prefix
 * @param {string} [query.method]      - POST | PATCH | DELETE
 * @param {string} [query.phase]       - executed | failed | staged | etc.
 * @param {string} [query.actor]       - User UPN
 * @param {string} [query.correlationId] - Batch ID (REQUIRED per spec §6)
 * @param {string} [query.search]      - Free-text search across description
 * @param {string} [query.source]      - 'batch' (correlationId != null) | 'manual' (correlationId == null)
 * @param {string} [query.outcome]     - 'ok' (phase === 'executed') | 'attention' (phase in {failed, stale-conflict, dead-letter, uncertain})
 * @param {number} [query.limit=50]
 * @param {number} [query.offset=0]
 * @param {boolean} [query.unbounded=false] - Bypass the 200-row clamp (export only)
 * @param {string} [query.dir]         - Data directory override (for tests)
 * @returns {{ total: number, entries: object[] }}
 */
export function queryAuditLog({
  startDate = null,
  endDate = null,
  entitySet = null,
  method = null,
  phase = null,
  actor = null,
  correlationId = undefined,
  search = null,
  source = null,
  outcome = null,
  customer = null,
  present = false,
  limit = 50,
  offset = 0,
  unbounded = false,
  dir = null,
} = {}) {
  // Clamp pagination params (safety net for both MCP and router callers).
  // `unbounded` lets a trusted server caller (the XLSX export) retrieve the FULL
  // filtered set so the exported workbook is a complete system-of-record rather
  // than a silently truncated 200-row page.
  const parsedLimit = Number.isFinite(limit) ? limit : 50;
  const parsedOffset = Number.isFinite(offset) ? offset : 0;
  const clampedLimit = Math.max(1, Math.min(parsedLimit, 200));
  const clampedOffset = Math.max(0, parsedOffset);

  const allRecords = readAllRecords(dir);
  let filtered = applyFilters(allRecords, {
    startDate,
    endDate,
    entitySet,
    method,
    phase,
    actor,
    correlationId,
    search,
    source,
    outcome,
  });

  // Customer filter operates on the RESOLVED account name (exact, precise),
  // using a backfill index built from the full corpus so records missing an
  // inline account still match.
  const wantCustomer = typeof customer === 'string' ? customer.trim() : null;
  if (wantCustomer) {
    const index = buildAccountIndex(allRecords);
    const target = wantCustomer.toLowerCase();
    filtered = filtered.filter((r) => {
      const c = resolveCustomer(r, index);
      return c && c.toLowerCase() === target;
    });
  }

  // Sort newest-first
  filtered.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  // TODO(Phase 3): 12-month retention pruning

  const total = filtered.length;
  const sliceEnd = unbounded ? total : clampedOffset + clampedLimit;
  let entries = filtered.slice(clampedOffset, sliceEnd);

  // Enrich the returned page with resolved display fields (backfill index drawn
  // from the FULL corpus, not just the page) when the caller asks for it.
  if (present) {
    entries = presentRecords(entries, allRecords);
  }

  return { total, entries };
}

/**
 * List the distinct resolved customer names across the filtered audit log —
 * powers the Activity View customer dropdown (server-side, so it reflects the
 * whole log, not just the loaded page). The `customer` filter itself is ignored.
 * @param {object} [query] - Same filters as queryAuditLog (excl. customer/limit)
 * @returns {string[]} - Sorted distinct customer names
 */
export function listAuditCustomers({
  startDate = null,
  endDate = null,
  entitySet = null,
  method = null,
  phase = null,
  actor = null,
  correlationId = undefined,
  search = null,
  source = null,
  outcome = null,
  dir = null,
} = {}) {
  const allRecords = readAllRecords(dir);
  const filtered = applyFilters(allRecords, {
    startDate,
    endDate,
    entitySet,
    method,
    phase,
    actor,
    correlationId,
    search,
    source,
    outcome,
  });
  const index = buildAccountIndex(allRecords);
  const names = new Set();
  for (const r of filtered) {
    const c = resolveCustomer(r, index);
    if (c) names.add(c);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Summarize the audit log with filters (NO pagination).
 * Returns aggregate counts over the FULL filtered set.
 * @param {object} [query] - Same filters as queryAuditLog (excl. limit/offset)
 * @returns {{ total: number, outcome: { ok: number, attention: number }, byType: { opportunities: number, milestones: number, other: number }, bySource: { batch: number, manual: number } }}
 */
export function summarizeAuditLog({
  startDate = null,
  endDate = null,
  entitySet = null,
  method = null,
  phase = null,
  actor = null,
  correlationId = undefined,
  search = null,
  source = null,
  outcome = null,
  customer = null,
  dir = null,
} = {}) {
  const allRecords = readAllRecords(dir);
  let filtered = applyFilters(allRecords, {
    startDate,
    endDate,
    entitySet,
    method,
    phase,
    actor,
    correlationId,
    search,
    source,
    outcome,
  });

  // Keep KPIs consistent with a selected customer.
  const wantCustomer = typeof customer === 'string' ? customer.trim() : null;
  if (wantCustomer) {
    const index = buildAccountIndex(allRecords);
    const target = wantCustomer.toLowerCase();
    filtered = filtered.filter((r) => {
      const c = resolveCustomer(r, index);
      return c && c.toLowerCase() === target;
    });
  }

  const summary = {
    total: filtered.length,
    outcome: { ok: 0, attention: 0 },
    byType: { opportunities: 0, milestones: 0, other: 0 },
    bySource: { batch: 0, manual: 0 },
  };

  const attentionPhases = new Set(['failed', 'stale-conflict', 'dead-letter', 'uncertain']);

  for (const record of filtered) {
    // outcome
    if (record.phase === 'executed') {
      summary.outcome.ok++;
    } else if (attentionPhases.has(record.phase)) {
      summary.outcome.attention++;
    }

    // byType: classify by entitySet
    if (record.entitySet && record.entitySet.toLowerCase().includes('opportunities')) {
      summary.byType.opportunities++;
    } else if (record.entitySet && record.entitySet.toLowerCase().includes('milestone')) {
      summary.byType.milestones++;
    } else {
      summary.byType.other++;
    }

    // bySource
    if (record.correlationId != null) {
      summary.bySource.batch++;
    } else {
      summary.bySource.manual++;
    }
  }

  return summary;
}

/**
 * Get a single audit entry by ID.
 * @param {string} id - ChangeRecord id (chg_<uuid>)
 * @param {object} [opts]
 * @param {string} [opts.dir] - Data directory override (for tests)
 * @returns {object|null}
 */
export function getAuditEntry(id, { dir = null } = {}) {
  const dataDir = resolveDataDir(dir);
  if (!existsSync(dataDir)) return null;

  // Wrap directory read in try/catch for resilience
  let files = [];
  try {
    files = readdirSync(dataDir)
      .filter(f => f.startsWith('audit-log') && f.endsWith('.ndjson'))
      .map(f => join(dataDir, f));
  } catch {
    // Unreadable dir or not a directory → return null
    return null;
  }

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record.id === id) return record;
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return null;
}

/**
 * Get a single audit entry by ID, enriched with resolved display fields
 * (`entry.view`). Reads the full corpus so customer backfill + CRM base
 * derivation are accurate.
 * @param {string} id - ChangeRecord id (chg_<uuid>)
 * @param {object} [opts]
 * @param {string} [opts.dir] - Data directory override (for tests)
 * @returns {object|null}
 */
export function getPresentedAuditEntry(id, { dir = null } = {}) {
  const raw = getAuditEntry(id, { dir });
  if (!raw) return null;
  const allRecords = readAllRecords(dir);
  const index = buildAccountIndex(allRecords);
  const crmBase = deriveCrmBase(allRecords);
  return presentRecord(raw, { index, crmBase });
}
