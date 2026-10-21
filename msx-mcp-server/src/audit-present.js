// Read-time presenter for the Activity View.
//
// Resolves a raw ChangeRecord into a complete, trustworthy DISPLAY entry —
// guaranteeing the three things the record must answer: WHAT changed, WHEN, and
// HOW. It repairs historical gaps (missing customer, missing CRM link, vague
// description, unmapped status) WITHOUT mutating stored data: the raw fields are
// preserved and resolved fields are added under `entry.view`.
//
// Precision rule: never fabricate a customer. Backfill only from another record
// for the SAME CRM record (same GUID) — the account of a given opportunity /
// milestone is stable, so this is exact, not a guess. If truly unknown, the
// customer is left null and shown honestly as "—".

import { FIELD_LABELS } from './audit-friendly.js';

const GUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const GUID_GLOBAL = new RegExp(GUID_RE.source, 'g');

// CRM entity-set (plural) → logical name (etn) used in a Dynamics deep link.
const SET_TO_LOGICAL = {
  opportunities: 'opportunity',
  msp_engagementmilestones: 'msp_engagementmilestone',
  tasks: 'task',
  accounts: 'account',
  systemusers: 'systemuser',
  annotations: 'annotation',
};

// Logical name → human entity label.
const ENTITY_LABELS = {
  opportunity: 'Opportunity',
  msp_engagementmilestone: 'Milestone',
  task: 'Task',
  account: 'Account',
  systemuser: 'User',
  annotation: 'Note',
};

const BLANK_NAMES = new Set(['', 'unknown', 'n/a', 'na', 'null', 'undefined', '-']);

/** Trim a value and reject blank/sentinel placeholders. */
function cleanName(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || BLANK_NAMES.has(s.toLowerCase())) return null;
  return s;
}

/** Does a string contain a raw CRM GUID? (used to reject leaky text) */
function hasGuid(value) {
  return typeof value === 'string' && GUID_RE.test(value);
}

/** Strip any raw GUIDs out of a human string. */
function stripGuids(value) {
  return String(value).replace(GUID_GLOBAL, '').replace(/\(\s*\)/g, '').trim();
}

/**
 * Parse an entitySet like `opportunities(<guid>)` or
 * `msp_engagementmilestones(<guid>)` into its logical name + record GUID.
 * @param {string} entitySet
 * @returns {{ setName: string|null, logicalName: string|null, guid: string|null }}
 */
export function parseEntitySet(entitySet) {
  if (typeof entitySet !== 'string' || !entitySet) {
    return { setName: null, logicalName: null, guid: null };
  }
  const paren = entitySet.indexOf('(');
  const setName = (paren >= 0 ? entitySet.slice(0, paren) : entitySet).trim();
  const m = entitySet.match(/\(([^)]+)\)/);
  const guid = m ? m[1].trim() : null;
  const logicalName =
    SET_TO_LOGICAL[setName] || (setName ? setName.replace(/s$/, '') : null);
  return { setName, logicalName, guid };
}

/** Human entity label for a record ('Opportunity' | 'Milestone' | …). */
export function entityLabelOf(record) {
  const { logicalName } = parseEntitySet(record?.entitySet);
  if (logicalName && ENTITY_LABELS[logicalName]) return ENTITY_LABELS[logicalName];
  // Fall back to the tool hint (e.g. create_milestone → Milestone)
  const tool = String(record?.tool || '').toLowerCase();
  if (tool.includes('milestone')) return 'Milestone';
  if (tool.includes('task')) return 'Task';
  if (tool.includes('opportunit')) return 'Opportunity';
  return 'Record';
}

/**
 * Build a GUID → accountName index from every record that DOES carry an account
 * name, so records for the same CRM record that are missing it can be backfilled
 * precisely. Keyed by both the entitySet GUID and recordIdFull.
 * @param {object[]} records
 * @returns {Map<string, string>}
 */
export function buildAccountIndex(records) {
  const index = new Map();
  if (!Array.isArray(records)) return index;
  for (const r of records) {
    const name = cleanName(r?.accountName);
    if (!name) continue;
    const { guid } = parseEntitySet(r.entitySet);
    if (guid) index.set(guid.toLowerCase(), name);
    if (r.recordIdFull) index.set(String(r.recordIdFull).toLowerCase(), name);
  }
  return index;
}

/**
 * Derive the CRM base origin (e.g. https://org.crm.dynamics.com) from any record
 * that already has a usable recordUrl — used to rebuild links for the few
 * records that are missing one.
 * @param {object[]} records
 * @returns {string|null}
 */
export function deriveCrmBase(records) {
  if (!Array.isArray(records)) return null;
  for (const r of records) {
    const url = r?.recordUrl;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      try {
        return new URL(url).origin;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/**
 * Resolve the customer (account) name for a record — precise, never fabricated.
 * @param {object} record
 * @param {Map<string,string>} index - from buildAccountIndex
 * @returns {string|null}
 */
export function resolveCustomer(record, index) {
  const direct = cleanName(record?.accountName);
  if (direct) return direct;
  if (index && index.size) {
    const { guid } = parseEntitySet(record?.entitySet);
    if (guid && index.has(guid.toLowerCase())) return index.get(guid.toLowerCase());
    if (record?.recordIdFull) {
      const k = String(record.recordIdFull).toLowerCase();
      if (index.has(k)) return index.get(k);
    }
  }
  return null;
}

/** Extract a quoted record name from a description ("Contoso Q2" → Contoso Q2). */
function parseQuotedName(description) {
  if (typeof description !== 'string') return null;
  const m = description.match(/"([^"]{2,})"/);
  return m ? cleanName(m[1]) : null;
}

/**
 * Resolve a human record name. Never returns "Unknown" — falls back to the
 * entity label + short id so a row is always identifiable.
 * @param {object} record
 * @returns {string}
 */
export function resolveRecordName(record) {
  const direct = cleanName(record?.recordName) || cleanName(record?.recordDisplayName);
  if (direct) return direct;
  const quoted = parseQuotedName(record?.description);
  if (quoted) return quoted;
  const { guid } = parseEntitySet(record?.entitySet);
  const short = (record?.recordIdFull || guid || record?.recordId || '')
    .toString()
    .replace(/-/g, '')
    .slice(-6);
  const label = entityLabelOf(record);
  return short ? `${label} …${short}` : label;
}

/** Is a stored recordUrl actually usable as a deep link? */
function isUsableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && /[?&]id=/.test(url);
}

/**
 * Resolve a working Dynamics deep link for the record. Tries the stored URL, then
 * rebuilds from the full GUID + CRM base. Returns null (no link) rather than a
 * broken one.
 * @param {object} record
 * @param {string|null} crmBase
 * @returns {string|null}
 */
export function resolveRecordUrl(record, crmBase) {
  if (isUsableUrl(record?.recordUrl)) return record.recordUrl;
  const { logicalName, guid } = parseEntitySet(record?.entitySet);
  const fullId =
    (record?.recordIdFull && GUID_RE.test(record.recordIdFull) && record.recordIdFull) ||
    (guid && GUID_RE.test(guid) && guid) ||
    null;
  if (crmBase && logicalName && fullId) {
    return `${crmBase}/main.aspx?pagetype=entityrecord&etn=${logicalName}&id=${fullId}`;
  }
  return null;
}

/**
 * Human action verb for a record, driven primarily by the tool that produced it.
 * @param {object} record
 * @returns {string}
 */
export function resolveAction(record) {
  const tool = String(record?.tool || '').toLowerCase();
  const method = String(record?.method || '').toUpperCase();

  if (tool.includes('stage') || tool.includes('mcem')) return 'Update stage';
  if (tool.includes('change_owner') || tool.includes('assign')) return 'Change owner';
  if (tool.includes('reactivate')) return 'Reactivate';
  if (tool.includes('close')) return 'Close';
  if (tool.includes('comment')) return 'Add comment';
  if (tool.includes('create_milestone')) return 'Create milestone';
  if (tool.includes('create')) return 'Create';
  if (tool.includes('delete')) return 'Delete';
  if (tool.includes('quantity') || tool.includes('capacity') || tool.includes('commitment'))
    return 'Update milestone';
  if (tool.includes('milestone')) return 'Update milestone';
  if (tool.includes('update_opportunity') || tool.includes('opportunity')) return 'Update';

  if (method === 'POST') return 'Create';
  if (method === 'DELETE') return 'Delete';
  if (method === 'PATCH') return 'Update';
  return 'Change';
}

// Phase → { label, tone }. Covers every phase seen in real logs plus spec phases.
const PHASE_STATUS = {
  executed: { label: 'Executed', tone: 'success' },
  staged: { label: 'Staged', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  'dead-letter': { label: 'Dead letter', tone: 'danger' },
  'stale-conflict': { label: 'Stale (conflict)', tone: 'warning' },
  uncertain: { label: 'Uncertain', tone: 'warning' },
  'precheck-abort': { label: 'Skipped (precheck)', tone: 'neutral' },
  'override-abort-404': { label: 'Aborted (record gone)', tone: 'warning' },
  'override-abort-reread-failed': { label: 'Aborted (re-read failed)', tone: 'warning' },
};

/**
 * Map a phase to a display status with a semantic tone (status-only colours).
 * @param {string} phase
 * @returns {{ key: string, label: string, tone: 'success'|'danger'|'warning'|'neutral' }}
 */
export function resolveStatus(phase) {
  const key = String(phase || '').trim();
  if (PHASE_STATUS[key]) return { key, ...PHASE_STATUS[key] };
  // Any other override-abort-* variant → warning "Aborted".
  if (key.startsWith('override-abort')) return { key, label: 'Aborted', tone: 'warning' };
  if (key.startsWith('precheck')) return { key, label: 'Skipped', tone: 'neutral' };
  // Humanise an unknown phase instead of showing the raw token.
  const label = key
    ? key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Unknown';
  return { key: key || 'unknown', label, tone: 'neutral' };
}

/**
 * Did the intended change actually take effect? Drives honest before/after display
 * so a failed write is never shown as though it succeeded.
 *  - 'applied'     : written to Dynamics (executed).
 *  - 'pending'     : staged for approval, not yet written.
 *  - 'skipped'     : aborted before any write (precheck) — nothing was attempted.
 *  - 'uncertain'   : sent but the outcome is unknown (timeout/ambiguous).
 *  - 'not-applied' : attempted or errored but did NOT take effect (failed, stale, aborted).
 * @param {string} phase
 * @returns {'applied'|'pending'|'skipped'|'uncertain'|'not-applied'}
 */
export function resolveAppliedState(phase) {
  const key = String(phase || '').trim();
  if (key === 'executed') return 'applied';
  if (key.startsWith('staged')) return 'pending';
  if (key.startsWith('precheck')) return 'skipped';
  if (key === 'uncertain') return 'uncertain';
  return 'not-applied';
}

/** Labels for the payload keys of a preflight / stage-prerequisite save. */
function preflightFieldLabels(record) {
  const payload = record?.intendedAfter || record?.payload || {};
  const labels = [
    ...new Set(
      Object.keys(payload)
        .map((k) => FIELD_LABELS[k])
        .filter(Boolean)
    ),
  ].slice(0, 4);
  return labels;
}

/**
 * Resolve a clear, non-vague, GUID-free summary sentence for a record.
 * @param {object} record
 * @returns {string}
 */
export function resolveSummary(record) {
  const tool = String(record?.tool || '').toLowerCase();
  const name = resolveRecordName(record);
  const entity = entityLabelOf(record).toLowerCase();

  // Stage-prerequisite / preflight save — historically "Save stage prerequisite
  // field(s) for <GUID>". Rebuild with human field labels, no GUID.
  if (tool.includes('preflight') || /prerequisite field/i.test(record?.description || '')) {
    const labels = preflightFieldLabels(record);
    if (labels.length) return `Set stage prerequisites (${labels.join(', ')}) for "${name}"`;
    return `Set stage prerequisites for "${name}"`;
  }

  // MCEM / stage move — the raw description ("Move opportunity …") is clean and
  // information-rich; just strip any stray GUID.
  if (tool.includes('stage') || tool.includes('mcem')) {
    const desc = cleanName(record?.description);
    if (desc && !/prerequisite/i.test(desc)) return stripGuids(desc);
    return `Updated stage for "${name}"`;
  }

  // Prefer the stored friendly description when it is present and GUID-free.
  const friendly = cleanName(record?.friendlyDescription);
  if (friendly && !hasGuid(friendly)) return friendly;

  // Otherwise clean the raw technical description.
  const desc = cleanName(record?.description);
  if (desc) {
    const cleaned = stripGuids(desc).replace(/:\s*msp_\w+\s*$/i, '').trim();
    // Map a bare field-code description to its label.
    if (FIELD_LABELS[cleaned]) {
      return `Updated ${FIELD_LABELS[cleaned]} for "${name}"`;
    }
    if (cleaned && !hasGuid(cleaned)) return cleaned;
  }

  // Last resort — compose from the action + entity + name (always meaningful).
  return `${resolveAction(record)} ${entity} "${name}"`;
}

/**
 * Present a single raw record: preserve all raw fields, add resolved display
 * fields under `entry.view`.
 * @param {object} record
 * @param {{ index?: Map<string,string>, crmBase?: string|null }} [ctx]
 * @returns {object}
 */
export function presentRecord(record, ctx = {}) {
  if (!record || typeof record !== 'object') return record;
  const { index = null, crmBase = null } = ctx;
  const correlationId = record.correlationId || null;
  const view = {
    when: record.ts || null,
    customer: resolveCustomer(record, index),
    recordName: resolveRecordName(record),
    entityLabel: entityLabelOf(record),
    recordUrl: resolveRecordUrl(record, crmBase),
    action: resolveAction(record),
    summary: resolveSummary(record),
    status: resolveStatus(record.phase),
    appliedState: resolveAppliedState(record.phase),
    source: correlationId
      ? { kind: 'batch', label: 'Batch', correlationShort: shortCorrelation(correlationId) }
      : { kind: 'manual', label: 'Manual', correlationShort: null },
    actor: cleanName(record.actor),
  };
  return { ...record, view };
}

/** Short, human-friendly correlation tag (last segment). */
function shortCorrelation(correlationId) {
  const s = String(correlationId);
  const tail = s.split(/[_-]/).pop() || s;
  return tail.slice(-6);
}

/**
 * Present a list of records. Builds the account backfill index + CRM base from
 * `indexSource` (defaults to the records themselves) so backfill can draw on the
 * full corpus even when the visible page is filtered.
 * @param {object[]} records
 * @param {object[]} [indexSource]
 * @returns {object[]}
 */
export function presentRecords(records, indexSource = null) {
  if (!Array.isArray(records)) return [];
  const src = Array.isArray(indexSource) ? indexSource : records;
  const index = buildAccountIndex(src);
  const crmBase = deriveCrmBase(src);
  return records.map((r) => presentRecord(r, { index, crmBase }));
}
