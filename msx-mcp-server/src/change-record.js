// Canonical ChangeRecord schema and redaction helpers for the audit log.
// See docs/specs/feature-1-audit-log-spec.md §2, §5.

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const LARGE_TEXT_THRESHOLD = 1000; // bytes — hash anything larger
const SECRET_KEY_PATTERNS = /(bearer|token|password|secret|key|auth|authorization|cookie|set-cookie)/i;
const SECRET_VALUE_PATTERNS = [
  /^Bearer\s+/i,                                    // Bearer token
  /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/, // JWT (3 base64 segments)
  /^sk-[a-zA-Z0-9]{32,}$/,                          // OpenAI-style api key
  /^[a-f0-9]{32,}$/i,                               // Hex key (32+ chars)
];

/**
 * Redact a GUID to its last 8 characters.
 * @param {string} guid
 * @returns {string}
 */
export function redactGuid(guid) {
  if (!guid || typeof guid !== 'string') return guid;
  return guid.length > 8 ? `…${guid.slice(-8)}` : guid;
}

/**
 * Hash large free-text values (notes, descriptions) to avoid storing
 * customer prose verbatim. Returns SHA-256 hex prefix.
 * @param {string} text
 * @returns {string}
 */
export function hashLargeText(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.length <= LARGE_TEXT_THRESHOLD) return text;
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return `<hash:${hash.slice(0, 16)}…>`;
}

/**
 * Check if a string value looks like a secret token/key.
 * @param {string} val
 * @returns {boolean}
 */
function looksLikeSecret(val) {
  if (!val || typeof val !== 'string') return false;
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(val));
}

/**
 * Redact potentially sensitive fields from an object.
 * - GUIDs → last 8 chars
 * - Large text → hashed
 * - No secrets/tokens
 * Does NOT mutate the input object (operates on a clone).
 * @param {object|null} obj
 * @returns {object|null}
 */
export function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const redacted = {};
  for (const [key, val] of Object.entries(obj)) {
    // Skip secret-looking keys
    if (SECRET_KEY_PATTERNS.test(key)) continue;

    if (typeof val === 'string') {
      // Skip secret-looking values (Bearer tokens, JWTs, api keys)
      if (looksLikeSecret(val)) continue;

      // GUID-like fields → redact
      if (key.toLowerCase().includes('id') && val.match(/^[0-9a-f-]{32,36}$/i)) {
        redacted[key] = redactGuid(val);
      } else if (val.length > LARGE_TEXT_THRESHOLD) {
        redacted[key] = hashLargeText(val);
      } else {
        redacted[key] = val;
      }
    } else if (typeof val === 'object' && val !== null) {
      redacted[key] = redactObject(val);
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

/**
 * Build a normalized, redacted ChangeRecord from staged operation data.
 * @param {object} input
 * @param {string} input.operationId    - Queue operation ID (OP-N)
 * @param {string|null} [input.correlationId] - Batch ID or null for one-by-one
 * @param {string} input.phase          - executed | failed | staged | etc.
 * @param {string} input.actor          - User UPN (email)
 * @param {string} input.sessionId      - Session identifier
 * @param {string} input.tool           - Tool name (e.g. "update_opportunity")
 * @param {string} input.entitySet      - CRM entity set path
 * @param {string} [input.recordId]     - Entity GUID (will be redacted to last 8 chars)
 * @param {string} [input.recordName]   - Display name (will be hashed if large)
 * @param {string} input.method         - POST | PATCH | DELETE
 * @param {string} input.description    - Human-readable summary
 * @param {object|null} [input.beforeState] - Snapshot before change
 * @param {object} [input.intendedAfter]    - Payload (PATCH delta)
 * @param {object|null} [input.actualAfter] - Post-write read (optional)
 * @param {string|null} [input.etag]        - ETag from read (optimistic concurrency)
 * @param {object} [input.result]           - { ok, status, id }
 * @param {object|null} [input.error]       - { message, code }
 * @param {number} [input.retryCount]
 * @param {string|null} [input.accountName]       - Customer/account display name (null on historical)
 * @param {string|null} [input.entityType]         - Entity type label: 'opportunity'|'milestone'|'task'|etc. (null on historical)
 * @param {string|null} [input.recordIdFull]       - Full record GUID (NOT redacted; for deep-linking only)
 * @param {string|null} [input.recordUrl]          - Dynamics deep-link URL (null if org base unavailable)
 * @param {string|null} [input.friendlyDescription]- Clean user-language description (null on historical)
 * @returns {object} ChangeRecord
 */
export function makeChangeRecord(input) {
  const {
    operationId,
    correlationId = null,
    phase,
    actor,
    sessionId,
    tool,
    entitySet,
    recordId = null,
    recordName = null,
    method,
    description,
    beforeState = null,
    intendedAfter = {},
    actualAfter = null,
    etag = null,
    result = { ok: false, status: null, id: null },
    error = null,
    retryCount = 0,
    override = null,
    note = null,
    accountName = null,
    entityType = null,
    recordIdFull = null,
    recordUrl = null,
    friendlyDescription = null,
  } = input;

  const record = {
    schemaVersion: 1,
    id: `chg_${randomUUID()}`,
    operationId,
    correlationId,
    ts: new Date().toISOString(),
    phase,
    actor,
    sessionId,
    tool,
    entitySet,
    recordId: recordId ? redactGuid(recordId) : null,
    recordIdFull: recordIdFull || null,
    recordName: recordName ? hashLargeText(recordName) : null,
    method,
    description: hashLargeText(description),
    accountName: accountName || null,
    entityType: entityType || null,
    recordUrl: recordUrl || null,
    friendlyDescription: friendlyDescription || null,
    beforeState: redactObject(beforeState),
    intendedAfter: redactObject(intendedAfter),
    actualAfter: redactObject(actualAfter),
    etag,
    result: {
      ok: result.ok ?? false,
      status: result.status ?? null,
      id: result.id ? redactGuid(result.id) : null,
    },
    error: error ? { message: error.message ?? String(error), code: error.code ?? null } : null,
    retryCount,
  };

  // Phase 2.4: include override and note fields if present
  if (override !== null && override !== undefined) {
    record.override = override;
  }
  if (note !== null && note !== undefined) {
    record.note = note;
  }

  return record;
}
