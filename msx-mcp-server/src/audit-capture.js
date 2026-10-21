// Audit capture helper — bridges execution outcomes to audit log persistence.
// Called at every terminal execution point to record a ChangeRecord.
// See docs/specs/feature-1-audit-log-spec.md §3 (capture strategy).

import { makeChangeRecord } from './change-record.js';
import { appendChangeRecord } from './audit-store.js';
import { buildFriendlyDescription } from './audit-friendly.js';

// ── CRM base URL (set once by tools.js at startup for deep-link generation) ──
let _crmBase = null;

/**
 * Set the CRM org base URL used to build recordUrl deep-links.
 * Called from registerTools() when crmClient is available.
 * Pass null to clear (useful in tests).
 * @param {string|null} base - e.g. "https://org-name.crm.dynamics.com"
 */
export function setCrmBase(base) {
  _crmBase = (base && typeof base === 'string') ? base : null;
}

// ── Entity set → entityType + Dynamics logicalName mapping ───────────────────
const ENTITY_SET_MAP = {
  opportunities:            { type: 'opportunity',  logicalName: 'opportunity' },
  msp_engagementmilestones: { type: 'milestone',    logicalName: 'msp_engagementmilestone' },
  tasks:                    { type: 'task',          logicalName: 'task' },
  accounts:                 { type: 'account',      logicalName: 'account' },
  contacts:                 { type: 'contact',      logicalName: 'contact' },
  systemusers:              { type: 'user',          logicalName: 'systemuser' },
  // CRM action endpoints (no GUID in path)
  CloseTask:                { type: 'task',          logicalName: 'task' },
  WinOpportunity:           { type: 'opportunity',  logicalName: 'opportunity' },
  LoseOpportunity:          { type: 'opportunity',  logicalName: 'opportunity' },
};

function deriveEntityMeta(entitySet) {
  if (!entitySet || typeof entitySet !== 'string') return { type: null, logicalName: null };
  const base = entitySet.split('(')[0].trim();
  return ENTITY_SET_MAP[base] || { type: base.toLowerCase() || null, logicalName: base.toLowerCase() || null };
}


/**
 * Best-effort parse account name from a staged-op description string.
 * Looks for the first parenthesized token that is not a GUID.
 * E.g. 'Update opportunity "ABC" (GRUPO CATALANA) — stage' → "GRUPO CATALANA"
 * 
 * NOTE (Bug 9 fix): This function is NO LONGER USED for Customer column resolution.
 * It remains as a belt-and-suspenders fallback with pronoun filtering for any
 * legacy parse paths.
 * 
 * @param {string|null} description
 * @returns {string|null}
 */
function parseAccountNameFromDescription(description) {
  if (!description || typeof description !== 'string') return null;
  if (description.startsWith('<hash:')) return null;
  const match = description.match(/\(([^)]{2,80})\)/);
  if (!match) return null;
  const candidate = match[1].trim();
  // Reject GUID-like strings
  if (/^[0-9a-f-]{32,36}$/i.test(candidate)) return null;
  // Reject bracket-prefixed type labels like [Consumption]
  if (candidate.startsWith('[')) return null;
  // Reject quoted strings — milestone descriptions embed the milestone name as
  // ("Singapur - Infra") which is NOT an account name.
  if (candidate.startsWith('"')) return null;
  // Reject pronoun tokens (Belt-and-suspenders safety net for Bug 9)
  if (/^(he\/him|she\/her|they\/them)$/i.test(candidate)) return null;
  return candidate;
}

/**
 * Resolve the human-facing "intended after" state for the audit trail.
 *
 * Owner reassignment (both `change_owner` and `reassign_opportunity`) stages a
 * machine payload — `{ 'ownerid@odata.bind': '/systemusers(<guid>)' }` — while the
 * before snapshot keys on the friendly `owner` field. Persisting the raw payload as
 * intendedAfter split one change into two half-rows in the diff: a false "Owner → —"
 * removal (before has `owner`, after does not) plus a masked-GUID "added" row. The
 * staging path already computed the new owner's display name in `afterState.owner`;
 * fold it back so the change reads as a single honest "Owner: A → B" row, and drop
 * the now-redundant *@odata.bind lookup key.
 *
 * Deliberately narrow: only the owner-bind shape is reconciled. Every other write
 * type (close/reactivate/update) keeps its payload verbatim.
 *
 * @param {object} op - StagedOperation from ApprovalQueue
 * @returns {object|null} the intended-after object to persist
 */
function resolveIntendedAfter(op) {
  const payload = op?.payload;
  if (!payload || typeof payload !== 'object') return payload ?? null;
  const ownerName = op?.afterState?.owner;
  const bindKey = Object.keys(payload).find((k) => /^ownerid@odata\.bind$/i.test(k));
  if (bindKey && ownerName != null) {
    const rest = { ...payload };
    delete rest[bindKey];
    return { ...rest, owner: ownerName };
  }
  return payload;
}

/**
 * Capture a CRM write execution outcome to the audit log.
 * Never throws — purely observational, cannot change execution behavior.
 *
 * @param {object} op - StagedOperation from ApprovalQueue
 * @param {object} outcome
 * @param {string} outcome.phase - executed | failed | precheck-abort | dead-letter | uncertain
 * @param {object} [outcome.result] - { ok, status, id } from CRM response
 * @param {object|string} [outcome.error] - Error details from failure
 * @param {string|null} [actor] - User UPN (email) from auth metadata
 * @param {string|null} [correlationId] - Batch ID (null for one-by-one)
 */
export function captureAuditRecord(op, { phase, result = null, error = null, override = null, note = null }, actor = null, correlationId = null) {
  try {
    // ── Extract GUID from entitySet (Bug 10 fix: prefer explicit op.recordId) ──
    let recordId = op.recordId || null;
    let recordIdFull = op.recordId || null;
    if (!recordId && op.entitySet) {
      const match = op.entitySet.match(/\(([^)]+)\)/);
      if (match) {
        recordIdFull = match[1];  // full GUID — not redacted (for deep-linking)
        recordId = match[1];     // makeChangeRecord will redact this copy
      }
    }

    // ── Derive entity type + Dynamics logicalName ────────────────────────────
    const { type: entityType, logicalName } = deriveEntityMeta(op.entitySet);

    // ── Build deep-link URL (Bug 10 fix: prefer explicit op.recordUrl) ───────
    const crmBase = (op.crmBase || _crmBase) || null;
    let recordUrl = op.recordUrl || null;
    if (!recordUrl && crmBase && logicalName && recordIdFull) {
      const base = crmBase.replace(/\/$/, '');
      recordUrl = `${base}/main.aspx?pagetype=entityrecord&etn=${logicalName}&id=${recordIdFull}`;
    }

    // ── Account name: use authoritative value from staging time (Bug 9 fix) ────
    // IMPORTANT: op.accountName is now set authoritatively at staging time via
    // resolveAccountNameForOp() for ALL operation types. The description-parse
    // fallback has been REMOVED to prevent pronoun leakage (He/Him, She/Her, etc).
    // When account is unknown, we show blank/"—", not a parsed guess.
    const accountName = op.accountName || null;

    // ── Friendly description: use pre-computed if available, else derive ────
    const friendlyDescription = op.friendlyDescription || buildFriendlyDescription(op, entityType);

    const record = makeChangeRecord({
      operationId: op.id,
      correlationId,
      phase,
      actor: actor || null,  // TODO(0.x): thread UPN from web layer if auth unavailable
      sessionId: null,  // TODO(Phase 2): session tracking
      tool: op.type,
      entitySet: op.entitySet,
      recordId,
      recordIdFull,
      recordName: op.recordName
        || op.identity?.milestoneName
        || op.changeOwner?.recordName
        || op.identity?.opportunityName
        || op.beforeState?.msp_name
        || op.beforeState?.name
        || null,
      method: op.method,
      description: op.description,
      accountName,
      entityType,
      recordUrl,
      friendlyDescription,
      beforeState: op.beforeState,
      intendedAfter: resolveIntendedAfter(op),
      actualAfter: null,  // TODO(Phase 3): optional post-write read
      etag: op.etag || null,  // Phase 2.4: optimistic concurrency
      result: result ? {
        ok: result.ok ?? false,
        status: result.status ?? null,
        id: result.data?.id || result.data?.opportunityid || result.data?.opportunityId || result.data?.msp_engagementmilestoneid || result.data?.milestoneId || null
      } : { ok: false, status: null, id: null },
      error: error ? {
        message: typeof error === 'string' ? error : (error.message ?? String(error)),
        code: error.code ?? error.status ?? null
      } : null,
      retryCount: op.retryCount ?? 0,
      override: override ?? null,  // Phase 2.4: override flag
      note: note ?? null,  // Phase 2.4: additional notes
    });

    appendChangeRecord(record);
  } catch (err) {
    // Never throw — audit failure must not break execution
    // appendChangeRecord already never-throws, but defense-in-depth
  }
}
