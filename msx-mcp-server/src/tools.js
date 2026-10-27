// MCP tool definitions — maps CRM operations to MCP tools
// Each tool receives validated params and calls createCrmClient methods

import { z } from 'zod';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isValidGuid, normalizeGuid, isValidTpid, sanitizeODataString } from './validation.js';
import { getApprovalQueue, MAX_RETRIES } from './approval-queue.js';
import { auditLog } from './audit.js';
import { mapRoleToCode, DEPARTMENT_NAMES } from './taxonomy.js';
import { captureAuditRecord, setCrmBase } from './audit-capture.js';
import { queryAuditLog, getAuditEntry } from './audit-store.js';
import { buildFriendlyDescription as buildAuditFriendlyDesc } from './audit-friendly.js';

// Reserved for future runtime telemetry. Currently a no-op.
function logRuntimeFinding() {}

// Guard to prevent duplicate dead-letter listeners
const deadLetterListenerGuard = new WeakSet();

// ── Entity allowlist ─────────────────────────────────────────
// Only these Dynamics 365 entity sets may be queried via crm_query
// and crm_get_record.  Purpose-built tools bypass this list because
// they already constrain scope through hard-coded entity paths.
export const ALLOWED_ENTITY_SETS = new Set([
  'accounts',
  'contacts',
  'opportunities',
  'msp_engagementmilestones',
  'msp_dealteams',
  'msp_workloads',
  'msp_salesplaymappings',
  'msp_accountplansalesplaybooks',
  'msp_solutionplayextensions',
  'competitors',
  'msp_licensingprograms',
  'tasks',
  'systemusers',
  'transactioncurrencies',
  // Deal team / partner linkage (alternative to msp_dealteams in some orgs)
  'connections',
  'connectionroles',
  // BPF stage name resolution (mcem-stage-identification)
  'processstages',
  'msp_mcemprocesses',
  // Metadata endpoints (used by get_task_status_options pattern)
  'EntityDefinitions',
  // System saved views (used by get_team_accounts for territory lookup)
  'savedqueries',
  // Territory intelligence (ATU Group resolution for territory tools)
  'territories',
  // Opportunity product/solution line items (solution-play tools)
  'opportunityproducts',
  // MSX Solution Play checklist rows (opportunity ↔ sales play junction)
  'msp_salesplaychecklists',
  // D365 Access Teams (deal/milestone team management)
  'teams',
]);

/** Check whether an entity set (or entity-set-with-key) is on the allowlist. */
export function isEntityAllowed(entitySet) {
  if (!entitySet || typeof entitySet !== 'string') return false;
  // Strip key suffix: "accounts(guid)" → "accounts"
  const base = entitySet.split('(')[0].split('/')[0];
  return ALLOWED_ENTITY_SETS.has(base);
}

/**
 * Deterministically lowercase Dataverse lookup columns (`_<prefix>_<field>_value`)
 * inside a raw OData query fragment. Dataverse lookup-value columns are ALWAYS
 * lowercase after the publisher prefix, but the model sometimes builds mixed-case
 * tokens (e.g. `_msp_OpportunityId_value`) which Dataverse rejects with a field-name
 * error. Lowercasing just the `_*_value` tokens fixes the casing bug for crm_query
 * without touching values, function calls, or other identifiers.
 * @param {string|undefined} fragment - an OData $filter/$select/$orderby/$expand string
 * @returns {string|undefined} the fragment with lookup tokens lowercased
 */
export function normalizeLookupCasing(fragment) {
  if (typeof fragment !== 'string' || !fragment) return fragment;
  return fragment.replace(/_[A-Za-z][A-Za-z0-9]*_value/g, (token) => token.toLowerCase());
}

// Workload TYPE constants (msp_milestoneworkload optionset)
const WORKLOAD_TYPE = {
  AZURE: 861980000,
  D365: 861980001,
  SECURITY: 861980002,
  MODERN_WORK: 861980003
};

const MILESTONE_SELECT = [
  'msp_engagementmilestoneid',
  'msp_milestonenumber',
  'msp_name',
  '_msp_workloadlkid_value',
  'msp_commitmentrecommendation',
  'msp_milestonecategory',
  // Seller-set recurrence. `msp_nonrecurring` is an option set (861980000 = Yes) and
  // `msp_nonrecurringmonths` is how many months the effect lasts. Sparse in practice
  // — ~3% of live rows — but AUTHORITATIVE when set, so it must outrank the
  // category-based inference in acr-insights.inferRecurrence().
  'msp_nonrecurring',
  'msp_nonrecurringmonths',
  'msp_monthlyuse',
  'msp_noofactivations',
  'msp_milestonedate',
  'msp_milestonestatus',
  'msp_milestonestatusreason',
  'msp_helpneeded',
  'msp_milestonecomments',
  '_ownerid_value',
  '_msp_opportunityid_value',
  'msp_forecastcommentsjsonfield',
  'msp_forecastcomments',
  'msp_forecastcomments_lastmodifiedon',
  'msp_milestoneworkload',
  'msp_deliveryspecifiedfield',
  'msp_milestonepreferredazureregion',
  'msp_milestoneazurecapacitytype'
].join(',');

const OPP_SELECT = [
  'opportunityid', 'name', 'estimatedclosedate',
  'msp_estcompletiondate', 'msp_consumptionconsumedrecurring',
  'estimatedvalue',
  '_ownerid_value', '_parentaccountid_value', 'msp_salesplay',
  'msp_solutionarea',
  'msp_opportunitynumber', 'msp_activesalesstage',
  'msp_opportunitytype'
].join(',');

const MCEM_STAGE_OPPORTUNITY_SELECT = [
  OPP_SELECT,
  'msp_solutionarea',
  'description',
  '_parentcontactid_value',
  '_msp_primarycompetitor_value',
  'msp_competethreatlevel',
  'msp_customerprioritiesidentified',
  'msp_qualifiedopportunity',
  'msp_initialstakeholderidentificationcomplete',
  'msp_customerneedsandoutcomesdefine',
  'msp_businessvalueconsiderationscompleted',
  'msp_designagreedwithcustomer',
  'msp_solutionplaysconfirmeddealteamorchest',
  'msp_partnersidentifiedandengaged',
  'msp_solutiondesignvalidatedwithcustomer',
  'msp_technicalbusinessproofrequirementside',
  'msp_customersignedoffonproposesolution',
  'msp_customeragreementinplace',
  'msp_customersuccessplanreviewedwithcustomer',
  'msp_customercommittoproposal',
  'msp_solutiondeliveredagainstagreedoutcome',
  'msp_outcomesmetandbaselinemetricsinplace',
  'msp_resourcesalignagainstdeliveryplan',
  'msp_changemanagementplanplace',
  'msp_customercanoperateandmaintainsolution',
  'msp_opportunitycompletedandnextstepsidentify',
  'msp_customersuccessplanupdated',
  'msp_customerhealthmetricsagreedwithmonitoring',
  'msp_nextsetofcustomerneedsidentify',
  'msp_busvalueandsuccessoutcomemonitoringinplac'
].join(',');

const TASK_CATEGORIES = [
  { label: 'Technical Close/Win Plan', value: 606820005 },
  { label: 'Architecture Design Session', value: 861980004 },
  { label: 'Blocker Escalation', value: 861980006 },
  { label: 'Briefing', value: 861980008 },
  { label: 'Consumption Plan', value: 861980007 },
  { label: 'Demo', value: 861980002 },
  { label: 'PoC/Pilot', value: 861980005 },
  { label: 'Workshop', value: 861980001 }
];

// ── Milestone view field picklist options ─────────────────────
// Embedded here so the agent can present options to users without
// a metadata round-trip.  get_milestone_field_options still queries
// live metadata for the full list (especially Azure regions/capacity).

const WORKLOAD_TYPES = [
  { label: 'Azure', value: 861980000 },
  { label: 'Dynamics 365', value: 861980001 },
  { label: 'Security', value: 861980002 },
  { label: 'Modern Work', value: 861980003 }
];

const DELIVERED_BY = [
  { label: 'Customer', value: 606820000 },
  { label: 'Partner', value: 606820001 },
  { label: 'ISD', value: 606820002 },
  { label: 'Microsoft Support', value: 606820003 }
];

const MILESTONE_STATUSES = [
  { label: 'On Track', value: 861980000 },
  { label: 'At Risk', value: 861980001 },
  { label: 'Blocked', value: 861980002 },
  { label: 'Completed', value: 861980003 },
  { label: 'Cancelled', value: 861980004 },
  { label: 'Lost to Competitor', value: 861980005 },
  { label: 'Hygiene/Duplicate', value: 861980006 },
  { label: 'Closed as Incomplete', value: 861980007 }
];

const MILESTONE_STATUS_REASONS = [
  { label: 'App compatibility / product feature or capability', value: 861980000 },
  { label: 'Billing, Licensing and Subscription', value: 861980001 },
  { label: 'Customer IT Infrastructure and Remediation', value: 861980002 },
  { label: 'IT Change Management and Resourcing', value: 861980003 },
  { label: 'Organizational Change Management', value: 861980004 },
  { label: 'Partner engagement', value: 861980005 },
  { label: 'Service reliability', value: 861980006 },
  { label: 'Cloud Trust', value: 861980007 },
  { label: 'Executive Sponsorship', value: 861980008 },
  { label: 'Capacity/Service Availability', value: 861980009 },
  { label: 'Non-Addressable', value: 861980010 },
  { label: 'Multi-Region Strategy', value: 861980011 },
  { label: 'No Intent', value: 861980012 },
  { label: 'Downstream Resources', value: 606820000 },
  { label: 'Compliance/Regulatory', value: 606820001 }
];

// Help Needed picklist — msp_helpneeded.
// Full live picklist (30 options, read from CRM metadata 2026-07-31 via
// get_milestone_field_options). ⚠️ Keep in sync with HELP_NEEDED_OPTIONS in
// web/public/app.js — web/public/__tests__/help-needed-parity.test.js enforces it.
// The previous 7-entry subset silently hid 23 valid reasons from the UI, and mislabelled
// 861980005 as plain "Executive Support (Non-engineering)" when CRM splits that into
// separate Corp and Field options.
const MILESTONE_HELP_NEEDED = [
  { label: 'Azure Capacity', value: 861980001 },
  { label: 'Azure Service/Product Availability', value: 606820000 },
  { label: 'Azure Tech Skilling', value: 861980014 },
  { label: 'Billing, Licensing & Subscription', value: 861980000 },
  { label: 'COVID-19, No Help Needed', value: 394380000 },
  { label: 'Discounting', value: 861980002 },
  { label: 'ESG-Sustainability Regulation/Policy', value: 606820001 },
  { label: 'Exec Visit', value: 861980006 },
  { label: 'Executive Escalation - Customer', value: 861980003 },
  { label: 'Executive Support (Engineering)', value: 861980004 },
  { label: 'Executive Support (Non-engineering – Corp)', value: 861980005 },
  { label: 'Executive Support (Non-engineering – Field)', value: 861980017 },
  { label: 'Funds [<100K]', value: 861980007 },
  { label: 'Funds [100K+]', value: 861980008 },
  { label: 'Legal', value: 725300000 },
  { label: 'MS Services Support', value: 861980015 },
  { label: 'No Intent', value: 861980020 },
  { label: 'Non-Addressable: Dual Usage (On-Prem)', value: 606820004 },
  { label: 'Non-Addressable: Is Procurement Account', value: 606820005 },
  { label: 'Non-Addressable: Other', value: 861980016 },
  { label: 'Non-Addressable: Over Licensed', value: 606820002 },
  { label: 'Non-Addressable: Regulatory Blocker', value: 606820003 },
  { label: 'Non-Addressable: Seasonal', value: 606820006 },
  { label: 'Partner (Business)', value: 861980009 },
  { label: 'Partner (Capability)', value: 861980018 },
  { label: 'Partner (Funds)', value: 861980019 },
  { label: 'Resources [Engineering]', value: 861980010 },
  { label: 'Resources [Non-Engineering]', value: 861980011 },
  { label: 'Technical Blockers', value: 861980012 },
  { label: 'Technical Gaps', value: 861980013 }
];

const COMMITMENT_RECOMMENDATIONS = [
  { label: 'Uncommitted', value: 861980000 },
  { label: 'Committed', value: 861980003 }
];

// Full live-validated picklist (10 options, re-confirmed 2026-06-16 against live org).
// ⚠️  THIS IS THE SINGLE SOURCE OF TRUTH for milestone category codes.
//     Keep in sync with: web/public/app.js → CREATION_MILESTONE_CATEGORY_OPTIONS
//     and .copilot/skills/dataverse-field-catalog/SKILL.md → msp_milestonecategory option set.
//     861980001 "Pre-Production" is NOT in the live org — intentionally omitted.
export const MILESTONE_CATEGORIES = [
  { label: 'POC/Pilot',            value: 861980000 },
  { label: 'Production',           value: 861980002 },
  { label: 'Deal Registration',    value: 861980003 },
  { label: 'Dual Credit',          value: 861980004 },
  { label: 'Other Adjustments',    value: 861980005 },
  { label: 'Partner Reported ACR', value: 861980006 },
  { label: 'Credit Offer',         value: 861980007 },
  { label: 'Optimization',         value: 861980008 },
  { label: 'Intent (MW, BA, Sec)', value: 861980009 },
  { label: 'ISV/ Marketplace',     value: 725300001 },
];

// Common regions — full list (75 options) available via get_milestone_field_options
const PREFERRED_AZURE_REGIONS_COMMON = [
  { label: 'East US - Blue Ridge', value: 861980005 },
  { label: 'East US 2 - Boydton', value: 861980006 },
  { label: 'Central US - Des Moines', value: 861980018 },
  { label: 'West US 2 - Quincy', value: 861980040 },
  { label: 'West US 3 - Phoenix', value: 861980036 },
  { label: 'West Europe - Amsterdam', value: 861980001 },
  { label: 'North Europe - Dublin', value: 861980022 },
  { label: 'Southeast Asia - Singapore', value: 861980046 },
  { label: 'None', value: 861980076 }
];

// Common capacity types — full list (65 options) available via get_milestone_field_options
// NOTE: This is a MultiSelectPicklist — values are comma-separated strings (e.g. "861980081,861980065")
const AZURE_CAPACITY_TYPES_COMMON = [
  { label: 'None', value: 861980000 },
  { label: 'Av2/Dv2/Dv3/Ev3/Dsv3/Esv3 (Intel) (Cores)', value: 861980037 },
  { label: 'Azure SQL Database (Cores or DTUs)', value: 861980065 },
  { label: 'Azure OpenAI Service', value: 861980081 },
  { label: 'Nd H100 V5 (Cores) (Future)', value: 861980080 },
  { label: 'Other', value: 861980032 }
];

/** Resolve a picklist numeric value to "Label (value)" for human-readable output.
 *  For multi-select (comma-separated codes), resolves each code individually. */
function resolvePicklistLabel(options, value) {
  if (value === undefined || value === null) return null;
  // Multi-select: comma-separated string of codes
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map(code => {
      const num = Number(code.trim());
      const match = options.find(o => o.value === num);
      return match ? `${match.label} (${num})` : String(num);
    }).join(', ');
  }
  const num = typeof value === 'string' ? Number(value) : value;
  const match = options.find(o => o.value === num);
  return match ? `${match.label} (${num})` : String(num);
}

/**
 * Resolve a picklist input that may be a numeric code or a human-readable label.
 * Returns the numeric code, or undefined if unresolvable.
 */
function resolveOptionValue(options, input) {
  if (input === undefined || input === null) return undefined;
  // Already a number — validate it exists
  if (typeof input === 'number') {
    return options.some(o => o.value === input) ? input : undefined;
  }
  // String: try numeric parse first
  const asNum = Number(input);
  if (!isNaN(asNum) && options.some(o => o.value === asNum)) return asNum;
  // String label match (case-insensitive)
  const match = options.find(o => o.label.toLowerCase() === String(input).toLowerCase().trim());
  return match ? match.value : undefined;
}

/** Map of CRM payload keys to their picklist arrays for resolution. */
const PICKLIST_MAP = {
  msp_milestoneworkload: WORKLOAD_TYPES,
  msp_deliveryspecifiedfield: DELIVERED_BY,
  msp_milestonepreferredazureregion: PREFERRED_AZURE_REGIONS_COMMON,
  msp_milestoneazurecapacitytype: AZURE_CAPACITY_TYPES_COMMON,
  msp_milestonestatus: MILESTONE_STATUSES,
  msp_milestonestatusreason: MILESTONE_STATUS_REASONS,
  msp_helpneeded: MILESTONE_HELP_NEEDED,
  msp_commitmentrecommendation: COMMITMENT_RECOMMENDATIONS,
  msp_milestonecategory: MILESTONE_CATEGORIES
};

/** Resolve all picklist fields in a payload to human-readable labels.
 *  Non-picklist and lookup fields are passed through as-is. */
function resolvePayloadLabels(payload) {
  const resolved = {};
  for (const [key, value] of Object.entries(payload)) {
    const picklist = PICKLIST_MAP[key];
    if (picklist && value !== undefined && value !== null) {
      resolved[key] = resolvePicklistLabel(picklist, value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

const BLOCKED_MILESTONE_STATUS = 861980002;
const CAPACITY_SERVICE_AVAILABILITY_REASON = 861980009;
const AZURE_CAPACITY_HELP_NEEDED = 861980001;

function hasCapacityAzureCapacityType(value) {
  if (value === undefined || value === null) return false;
  return String(value)
    .split(',')
    .map(code => code.trim())
    .some(code => code && code !== '861980000');
}

function validOptionsMessage(options) {
  return options.map(o => `${o.label} (${o.value})`).join(', ');
}

/** Derive comment initials from a full display name.
 * "Joaquin Perez del Real" → "JPdR"  (first char of each word, preserving original case) */
function buildCommentInitials(fullName) {
  if (!fullName) return 'MSX';
  return fullName.split(/\s+/).filter(Boolean).map(w => w.charAt(0)).join('');
}

const COMMENT_MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Build "21/May" style date for forecast comment prefix. */
function buildCommentDateStr(date = new Date()) {
  return `${date.getDate()}/${COMMENT_MONTH_ABBR[date.getMonth()]}`;
}

/**
 * Compute the updated forecast comment fields for a new milestone comment entry.
 * - msp_forecastcomments: prepend "{initials} - {date} - {comment}\n" (newest first)
 * - msp_forecastcommentsjsonfield: append JSON entry (oldest first)
 * NOTE: userId in the JSON entry must be a human-readable name (not a GUID). CRM has a
 * post-save plugin that regenerates msp_forecastcomments from the JSON when it detects a
 * GUID-format userId — using the GUID verbatim as the prefix, clobbering our initials write.
 * Using the full display name avoids the plugin and preserves our initials-formatted plain-text.
 * NOTE: Two concurrent writes will silently lose one entry (last-write-wins on the JSON string).
 *       Acceptable for now — document and revisit if concurrency issues arise.
 */
function buildForecastCommentUpdate(comment, authorName, authorGuid, record) {
  const initials = buildCommentInitials(authorName);
  const dateStr = buildCommentDateStr();
  const now = new Date().toISOString();

  const newLine = `${initials} - ${dateStr} - ${comment}\n`;
  const newForecastComments = newLine + (record.msp_forecastcomments || '');

  let entries = [];
  if (record.msp_forecastcommentsjsonfield) {
    try { entries = JSON.parse(record.msp_forecastcommentsjsonfield); } catch { entries = []; }
  }
  if (!Array.isArray(entries)) entries = [];

  // Use the full display name (not GUID) so CRM's post-save auto-derive plugin does not
  // trigger and clobber our initials-formatted msp_forecastcomments plain-text.
  const userId = authorName || 'MSX-IQ';

  entries.push({ userId, modifiedOn: now, comment });

  return {
    msp_forecastcomments: newForecastComments,
    msp_forecastcommentsjsonfield: JSON.stringify(entries)
  };
}

const FORECAST_COMMENT_APPEND_ONLY_MESSAGE =
  'Forecast comments are append-only. Pass only the new comment body; editing, deleting, reordering, or rewriting existing forecast comments is not supported.';

/** Matches an existing rendered rollup line like "JPdR - 21/May - ...". */
const FORECAST_COMMENT_ROLLUP_LINE_RE =
  /^\s*[A-Z]{2,4}\s+-\s+\d{1,2}\/[A-Z][a-z]{2}\s+-\s+/m;

/**
 * Guard against AI callers re-submitting the full forecast-comment rollup as the
 * "new" comment body, which would re-append the entire history and cause the
 * comment field to grow exponentially. Returns the cleaned new comment when the
 * input is a genuine single new entry, otherwise an error message.
 */
function validateNewForecastComment(submittedComment, existingRollup) {
  if (typeof submittedComment !== 'string') {
    return { ok: false, message: `${FORECAST_COMMENT_APPEND_ONLY_MESSAGE} The new comment body must be a string.` };
  }
  const submitted = submittedComment.trim();
  if (!submitted) {
    return { ok: false, message: `${FORECAST_COMMENT_APPEND_ONLY_MESSAGE} The new comment body cannot be empty.` };
  }
  if (FORECAST_COMMENT_ROLLUP_LINE_RE.test(submitted)) {
    return { ok: false, message: FORECAST_COMMENT_APPEND_ONLY_MESSAGE };
  }
  if (typeof existingRollup !== 'string' || !existingRollup.trim()) {
    return { ok: true, comment: submitted };
  }
  const normalizedSubmitted = submitted.replace(/\r\n/g, '\n');
  const normalizedExisting = existingRollup.replace(/\r\n/g, '\n').trim();
  if (!normalizedExisting || !normalizedSubmitted.includes(normalizedExisting)) {
    return { ok: true, comment: submitted };
  }
  return { ok: false, message: FORECAST_COMMENT_APPEND_ONLY_MESSAGE };
}

function applyMilestoneStatusReasonFields(payload, { resolvedStatus, milestoneStatusReason, azureCapacityType, helpNeeded }) {
  if (milestoneStatusReason !== undefined) {
    const resolvedReason = resolveOptionValue(MILESTONE_STATUS_REASONS, milestoneStatusReason);
    if (resolvedReason === undefined) return `Invalid milestoneStatusReason "${milestoneStatusReason}". Valid: ${validOptionsMessage(MILESTONE_STATUS_REASONS)}`;
    payload.msp_milestonestatusreason = resolvedReason;
  }

  if (helpNeeded !== undefined) {
    const resolvedHelp = resolveOptionValue(MILESTONE_HELP_NEEDED, helpNeeded);
    if (resolvedHelp === undefined) return `Invalid helpNeeded "${helpNeeded}". Valid: ${validOptionsMessage(MILESTONE_HELP_NEEDED)}`;
    payload.msp_helpneeded = resolvedHelp;
  }

  if (resolvedStatus === BLOCKED_MILESTONE_STATUS) {
    const isCapacityBlocker = hasCapacityAzureCapacityType(azureCapacityType);
    if (payload.msp_milestonestatusreason === undefined) {
      if (!isCapacityBlocker) {
        return `milestoneStatusReason is required when milestoneStatus is Blocked. Use Capacity/Service Availability (${CAPACITY_SERVICE_AVAILABILITY_REASON}) for quota/capacity blockers.`;
      }
      payload.msp_milestonestatusreason = CAPACITY_SERVICE_AVAILABILITY_REASON;
    }
    if (
      isCapacityBlocker &&
      payload.msp_milestonestatusreason === CAPACITY_SERVICE_AVAILABILITY_REASON &&
      payload.msp_helpneeded === undefined
    ) {
      payload.msp_helpneeded = AZURE_CAPACITY_HELP_NEEDED;
    }
  }

  return null;
}

/** Maximum records crm_query will return via auto-pagination. */
export const CRM_QUERY_MAX_RECORDS = 500;

const text = (content) => ({ content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] });
const error = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

/** Build a Dynamics 365 deep-link URL to open a record in the browser. */
function buildRecordUrl(crmBaseUrl, entityLogicalName, guid) {
  if (!crmBaseUrl || !entityLogicalName || !guid) return undefined;
  return `${crmBaseUrl}/main.aspx?etn=${entityLogicalName}&id=${guid}&pagetype=entityrecord`;
}

/**
 * Resolve the authoritative parent account name for an operation.
 * Returns the formatted account company name from CRM, or null if unavailable.
 * Never returns a guess or parsed value.
 *
 * Resolution paths:
 * - Opportunity ops: read _parentaccountid_value from the opportunity
 * - Milestone ops: read parent opp ID, then read that opp's _parentaccountid_value
 * - Task ops: read parent milestone ID → parent opp ID → account (two-hop)
 * - Solution play / deal team ops: read opportunity's _parentaccountid_value
 * - Milestone team ops: read parent milestone's parent opp's _parentaccountid_value
 *
 * @param {object} crmClient - CRM client instance
 * @param {object} context - Operation context with entityType and one of: opportunityId, milestoneId, taskId, recordId
 * @returns {Promise<string|null>} Formatted account name or null
 */
async function resolveAccountNameForOp(crmClient, context) {
  try {
    const { entityType, opportunityId, milestoneId, taskId, recordId } = context;

    // Direct opportunity operations
    if ((entityType === 'opportunity' || context.isOpportunityOp) && (opportunityId || recordId)) {
      const oppId = normalizeGuid(opportunityId || recordId);
      if (!isValidGuid(oppId)) return null;
      const result = await crmClient.request(`opportunities(${oppId})`, {
        query: { $select: '_parentaccountid_value' }
      });
      return result.ok && result.data ? (fv(result.data, '_parentaccountid_value') || null) : null;
    }

    // Milestone operations → resolve via parent opportunity
    if ((entityType === 'milestone' || context.isMilestoneOp) && (milestoneId || recordId)) {
      const msId = normalizeGuid(milestoneId || recordId);
      if (!isValidGuid(msId)) return null;
      const msResult = await crmClient.request(`msp_engagementmilestones(${msId})`, {
        query: { $select: '_msp_opportunityid_value' }
      });
      if (!msResult.ok || !msResult.data) return null;
      const oppId = msResult.data._msp_opportunityid_value;
      if (!oppId) return null;
      const oppResult = await crmClient.request(`opportunities(${oppId})`, {
        query: { $select: '_parentaccountid_value' }
      });
      return oppResult.ok && oppResult.data ? (fv(oppResult.data, '_parentaccountid_value') || null) : null;
    }

    // Task operations → two-hop via parent milestone → parent opportunity
    if ((entityType === 'task' || context.isTaskOp) && (taskId || recordId)) {
      const tId = normalizeGuid(taskId || recordId);
      if (!isValidGuid(tId)) return null;
      const taskResult = await crmClient.request(`tasks(${tId})`, {
        query: { $select: '_regardingobjectid_value' }
      });
      if (!taskResult.ok || !taskResult.data) return null;
      const msId = taskResult.data._regardingobjectid_value;
      if (!msId) return null;
      const msResult = await crmClient.request(`msp_engagementmilestones(${msId})`, {
        query: { $select: '_msp_opportunityid_value' }
      });
      if (!msResult.ok || !msResult.data) return null;
      const oppId = msResult.data._msp_opportunityid_value;
      if (!oppId) return null;
      const oppResult = await crmClient.request(`opportunities(${oppId})`, {
        query: { $select: '_parentaccountid_value' }
      });
      return oppResult.ok && oppResult.data ? (fv(oppResult.data, '_parentaccountid_value') || null) : null;
    }

    return null;
  } catch {
    // Best-effort: never throw, just return null when lookup fails
    return null;
  }
}

function monthKey(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 7);
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Format a numeric value as USD currency. Returns null if value is null/undefined/zero. */
function formatCurrency(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isNaN(num) || num === 0) return null;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/month`;
}

/** Derive a coarse opportunity health label from its estimated completion date. */
function deriveOpportunityHealth(opportunity) {
  const completion = toIsoDate(opportunity?.msp_estcompletiondate);
  if (!completion) return 'Unknown';
  const today = toIsoDate(new Date().toISOString());
  if (completion < today) return 'At Risk';
  const diffDays = Math.floor(
    (new Date(completion).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays <= 14) return 'Watch';
  return 'On Track';
}

/** Split an array into chunks of at most chunkSize elements. */
function chunkArray(items, chunkSize = 25) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  return chunks;
}

// Appended to read-tool descriptions that preserve @odata.etag so agents can
// forward it on later writes via expectedEtag.
const ETAG_RETURNED_NOTE =
  ' Each returned record carries `@odata.etag`, an opaque version token for ' +
  'concurrency control. Pass it as `expectedEtag` to subsequent update tools; ' +
  'do not display it to users.';

// Short-lived cache for resolved territory → account lookups (5 min TTL).
const territoryCache = new Map();

// GUID accepting optional braces — validates format, then normalizes
// (strips braces, lowercases) so handlers receive a clean value.
const guidSchema = z
  .string()
  .regex(
    /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i,
    'Must be a valid GUID (with or without braces)',
  )
  .transform((v) => v.replace(/[{}]/g, '').toLowerCase());

// Maps a Solution Play's msp_globalsolutionarea code to the opportunity's
// msp_solutionarea code (different picklists, same labels, different numbers).
const SOLUTION_AREA_PLAY_TO_OPPORTUNITY = {
  861980000: 394380000, // Cloud and AI Platforms
  861980003: 394380002, // AI Business Solutions
  861980005: 861980005, // Security
  861980011: 861980011, // Microsoft Unified
};

// Allowlisted fields for account/contact CRUD writes. Anything outside
// these sets is rejected before staging so a stray payload key can never
// reach Dataverse.
const UPDATE_ACCOUNT_FIELDS = new Set([
  'name',
  'telephone1',
  'websiteurl',
  'emailaddress1',
  'description',
  'industrycode',
  'revenue',
  'numberofemployees',
  'address1_line1',
  'address1_line2',
  'address1_city',
  'address1_stateorprovince',
  'address1_postalcode',
  'address1_country',
  'primarycontactid@odata.bind',
  'ownerid@odata.bind',
]);

const UPDATE_CONTACT_FIELDS = new Set([
  'firstname',
  'lastname',
  'jobtitle',
  'emailaddress1',
  'emailaddress2',
  'telephone1',
  'mobilephone',
  'description',
  'address1_line1',
  'address1_city',
  'address1_stateorprovince',
  'address1_postalcode',
  'address1_country',
  'parentcustomerid_account@odata.bind',
  'ownerid@odata.bind',
]);

const CREATE_CONTACT_FIELDS = new Set([
  'firstname',
  'lastname',
  'jobtitle',
  'emailaddress1',
  'telephone1',
  'mobilephone',
  'description',
  'address1_city',
  'address1_country',
  'parentcustomerid_account@odata.bind',
]);

// Allowed top-level keys on the AddUserToRecordTeam/RemoveUserFromRecordTeam
// bound-action payload (deal/milestone team management).
const TEAM_ACTION_FIELDS = new Set(['Record', 'TeamTemplate']);

// D365 Access Team template IDs (tenant-specific, stable). The opportunity
// "Deal Team" and engagement-milestone "Milestone Team" tabs in MSX are
// backed by these access-team templates.
const OPP_TEAM_TEMPLATE_ID = 'cc923a9d-7651-e311-9405-00155db3ba1e';
const MILESTONE_TEAM_TEMPLATE_ID = '316e4735-9e83-eb11-a812-0022481e1be0';

// Reject any payload key outside the allowlist. Returns an error string or null.
function validateWritePayloadFields(payload, allowedFields) {
  const unexpected = Object.keys(payload).filter((key) => !allowedFields.has(key));
  if (!unexpected.length) return null;
  return `Payload contains restricted field(s): ${unexpected.join(', ')}.`;
}

// Maps a write-payload field name to the form used in a $select for the
// before-state fetch (lookup binds become their _value column).
function beforeStateFieldForUpdate(field) {
  if (field === 'ownerid@odata.bind') return '_ownerid_value';
  if (field.endsWith('@odata.bind')) return field.slice(0, field.indexOf('@'));
  return field;
}

// Resolves a systemuser by GUID or email for team-management tools. Returns
// { resolvedUserId, displayName } on success or { error }.
async function resolveSystemUser({ crmClient, systemUserId, email }) {
  let resolvedUserId = systemUserId || null;
  let displayName = null;

  if (!resolvedUserId && email) {
    const sanitizedEmail = sanitizeODataString(email.trim());
    const userResult = await crmClient.requestAllPages('systemusers', {
      query: {
        $filter: `internalemailaddress eq '${sanitizedEmail}'`,
        $select: 'systemuserid,fullname,internalemailaddress',
        $top: '5',
      },
    });
    if (userResult.ok && userResult.data?.value?.length) {
      resolvedUserId = normalizeGuid(userResult.data.value[0].systemuserid);
      displayName = userResult.data.value[0].fullname;
    } else {
      return { error: error(`No systemuser found with email "${email}". Verify the email address is correct.`) };
    }
  }

  if (!resolvedUserId || !isValidGuid(resolvedUserId)) {
    return { error: error('Either email or systemUserId is required to add/remove a team member.') };
  }

  if (!displayName) {
    const userResult = await crmClient.request(`systemusers(${resolvedUserId})`, { query: { $select: 'fullname' } });
    if (userResult.ok && userResult.data) displayName = userResult.data.fullname;
  }

  return { resolvedUserId, displayName };
}

// Resolves a single msp_salesplaychecklists row on an opportunity, either by
// its GUID or by Solution Play name (with optional Solution Area
// disambiguation). Shared by set_opportunity_solution_play_primary and
// remove_opportunity_solution_play. Returns { row } on success or { error }.
async function resolveChecklistTarget({ crmClient, rows, solutionPlayChecklistId, solutionPlayName, solutionArea }) {
  if (solutionPlayChecklistId) {
    const row = rows.find((r) => r.msp_salesplaychecklistid === solutionPlayChecklistId) || null;
    if (!row) return { error: error(`Checklist row ${solutionPlayChecklistId} is not attached to this opportunity.`) };
    return { row };
  }

  const needle = solutionPlayName.replace(/'/g, "''");
  const playSearch = await crmClient.requestAllPages('msp_accountplansalesplaybooks', {
    query: {
      $filter: `(contains(msp_name,'${needle}') or contains(msp_salesplayname,'${needle}'))`,
      $select: 'msp_accountplansalesplaybookid,msp_name,msp_salesplayname',
      $top: '20',
    },
  });
  if (!playSearch.ok) return { error: error(`Solution Play search failed (${playSearch.status}): ${playSearch.data?.message}`) };
  const playMatches = playSearch.data?.value || [];
  const exactPlays = playMatches.filter(
    (m) =>
      String(m.msp_name || '').toLowerCase() === solutionPlayName.toLowerCase() ||
      String(m.msp_salesplayname || '').toLowerCase() === solutionPlayName.toLowerCase(),
  );
  const playIds = new Set((exactPlays.length ? exactPlays : playMatches).map((m) => m.msp_accountplansalesplaybookid));
  const candidateRows = rows.filter((r) => playIds.has(r._msp_salesplay_value));
  if (!candidateRows.length) return { error: error(`No checklist row on this opportunity matches Solution Play "${solutionPlayName}".`) };

  const describeRow = (r) =>
    `${r['msp_solutionarea@OData.Community.Display.V1.FormattedValue'] || r.msp_solutionarea || 'null'} (${r.msp_salesplaychecklistid})`;

  let chosen = null;
  if (solutionArea && candidateRows.length > 1) {
    const wanted = solutionArea.toLowerCase().trim();
    const areaMatches = candidateRows.filter((r) => {
      const code = r.msp_solutionarea;
      if (code === null || code === undefined) return false;
      const label = String(r['msp_solutionarea@OData.Community.Display.V1.FormattedValue'] || '').toLowerCase();
      return label.includes(wanted) || String(code).includes(wanted);
    });
    if (areaMatches.length === 1) chosen = areaMatches[0];
    else if (areaMatches.length > 1)
      return { error: error(`Multiple checklist rows match Solution Play "${solutionPlayName}" + Solution Area "${solutionArea}". Pass solutionPlayChecklistId.`) };
    else
      return { error: error(`No checklist row matches Solution Play "${solutionPlayName}" + Solution Area "${solutionArea}". Available: ${candidateRows.map(describeRow).join('; ')}.`) };
  }
  if (!chosen) {
    if (candidateRows.length > 1)
      return { error: error(`Solution Play "${solutionPlayName}" matches ${candidateRows.length} checklist rows. Pass solutionArea or solutionPlayChecklistId. Rows: ${candidateRows.map(describeRow).join('; ')}.`) };
    chosen = candidateRows[0];
  }
  return { row: chosen };
}

/** Map task statusCode to the required statecode for Dynamics 365 state transitions. */
function taskStateForStatus(statusCode) {
  if ([5].includes(statusCode)) return 1;       // Completed
  if ([6].includes(statusCode)) return 2;       // Cancelled
  return 0;                                      // Open
}

function fv(record, field) {
  return record[`${field}@OData.Community.Display.V1.FormattedValue`] ?? null;
}

/** Returns ISO date string for (today - days). */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

/** Fiscal month grain tokens, indexed by JS month number (0=Jan). "FY27-JUL". */
const MS_MONTH_PERIODS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MS_MONTH_INDEX = Object.fromEntries(MS_MONTH_PERIODS.map((m, i) => [m, i]));

/** Parse a fiscal token into {fyStartYear, period}.
 *  Accepts:
 *    - Canonical "FY{YY}-{period}" (e.g. "FY26-Q1")
 *    - Bare absolute "FY{YY}" (e.g. "FY27" → whole fiscal year)
 *    - Bare "{period}" (legacy, FY-relative-to-now)
 *  MS FY math: FY26 starts Jul 1 2025 → fyStartYear for FY{YY} = 2000 + YY - 1.
 *  Throws on invalid input (preserves legacy getMsFiscalRange contract).
 *  @param {string} input — token like "FY27-H2", "FY27", "Q1", "FY", "current-Q"
 *  @param {Date} [now=new Date()] — reference date for resolving bare tokens (testability)
 *  @returns {{fyStartYear:number, period:string, hasExplicitFy:boolean}}
 */
export function parseFiscalToken(input, now = new Date()) {
  if (input == null) throw new Error(`Unknown fiscal period: ${input}`);
  const raw = String(input).trim().toUpperCase();
  if (raw === '') throw new Error(`Unknown fiscal period: ${input}`);

  let hasExplicitFy = false;
  let yyPart = null;
  let periodPart = raw;

  // First try canonical "FY{YY}-{period}" pattern
  const canonicalMatch = raw.match(/^FY(\d{2})-(.+)$/);
  if (canonicalMatch) {
    hasExplicitFy = true;
    yyPart = parseInt(canonicalMatch[1], 10);
    periodPart = canonicalMatch[2];
  } else {
    // Try bare absolute "FY{YY}" pattern (whole fiscal year)
    const bareAbsoluteMatch = raw.match(/^FY(\d{2})$/);
    if (bareAbsoluteMatch) {
      hasExplicitFy = true;
      yyPart = parseInt(bareAbsoluteMatch[1], 10);
      periodPart = 'FY'; // Treat bare "FY27" as the whole fiscal year
    }
  }

  // Whitelist period suffixes — anything else is invalid (matches legacy throw behaviour).
  // Month grain (#N Month filter): "FY27-JUL". Kept in lockstep with web/src/fiscal.js
  // and web/public/helpers.js — all three parsers must know the same grains or the UI
  // silently renders one window's numbers under another window's label.
  const validPeriods = new Set([
    'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'FY',
    ...MS_MONTH_PERIODS,
    'CURRENT-Q', 'CURRENT-H', 'CURRENT-FY', 'CURRENT-M',
  ]);
  if (!validPeriods.has(periodPart)) throw new Error(`Unknown fiscal period: ${input}`);

  let fyStartYear;
  if (hasExplicitFy) {
    fyStartYear = 2000 + yyPart - 1; // FY26 → 2025
  } else {
    const month = now.getMonth();
    fyStartYear = month >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  }
  return { fyStartYear, period: periodPart, hasExplicitFy };
}

/** Compute Microsoft fiscal-year date range for a given period.
 *  MS FY runs Jul–Jun (Q1=Jul-Sep, Q2=Oct-Dec, Q3=Jan-Mar, Q4=Apr-Jun).
 *  Accepts:
 *    - Bare legacy: Q1–Q4, H1–H2, FY, current-Q, current-H, current-FY (resolves to current FY).
 *    - Canonical: FY{YY}-{Q1|Q2|Q3|Q4|H1|H2|FY} (resolves to the explicit FY).
 *  Throws on invalid input.
 */
export function getMsFiscalRange(period) {
  const { fyStartYear, period: p } = parseFiscalToken(period);

  // currentQ only matters for CURRENT-* tokens — and those are always relative to "now",
  // never to an explicit FY (FY26-CURRENT-Q would be nonsensical, but parseFiscalToken
  // happily yields fyStartYear from the FY26 prefix; CURRENT-Q ignores fyStartYear and
  // re-derives from `new Date()` below to preserve the original "current quarter" intent).
  const now = new Date();
  const m = now.getMonth();
  let currentQ;
  if (m >= 6 && m <= 8) currentQ = 1;
  else if (m >= 9 && m <= 11) currentQ = 2;
  else if (m <= 2) currentQ = 3;
  else currentQ = 4;

  const quarterRanges = {
    1: { start: `${fyStartYear}-07-01`, end: `${fyStartYear}-09-30` },
    2: { start: `${fyStartYear}-10-01`, end: `${fyStartYear}-12-31` },
    3: { start: `${fyStartYear + 1}-01-01`, end: `${fyStartYear + 1}-03-31` },
    4: { start: `${fyStartYear + 1}-04-01`, end: `${fyStartYear + 1}-06-30` }
  };

  if (p === 'CURRENT-Q') return quarterRanges[currentQ];
  if (p === 'CURRENT-M') {
    return getMsFiscalRange(`FY${String((fyStartYear + 1) % 100).padStart(2, '0')}-${MS_MONTH_PERIODS[m]}`);
  }
  if (p === 'CURRENT-H') {
    return currentQ <= 2
      ? { start: `${fyStartYear}-07-01`, end: `${fyStartYear}-12-31` }
      : { start: `${fyStartYear + 1}-01-01`, end: `${fyStartYear + 1}-06-30` };
  }
  if (p === 'CURRENT-FY' || p === 'FY') {
    return { start: `${fyStartYear}-07-01`, end: `${fyStartYear + 1}-06-30` };
  }
  if (/^Q[1-4]$/.test(p)) return quarterRanges[parseInt(p[1])];
  if (p === 'H1') return { start: `${fyStartYear}-07-01`, end: `${fyStartYear}-12-31` };
  if (p === 'H2') return { start: `${fyStartYear + 1}-01-01`, end: `${fyStartYear + 1}-06-30` };
  if (Object.prototype.hasOwnProperty.call(MS_MONTH_INDEX, p)) {
    const mi = MS_MONTH_INDEX[p];
    // Jul–Dec sit in the FY start year; Jan–Jun roll into the next calendar year.
    const year = mi >= 6 ? fyStartYear : fyStartYear + 1;
    const mm = String(mi + 1).padStart(2, '0');
    // Day 0 of the next month = last day of this one (28/29/30/31, leap-year safe).
    const lastDay = new Date(Date.UTC(year, mi + 1, 0)).getUTCDate();
    return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
  }
  // Unreachable — parseFiscalToken's whitelist already rejected anything else.
  throw new Error(`Unknown fiscal period: ${period}`);
}

const ACTIVE_STATUSES = new Set(['Not Started', 'In Progress', 'On Track', 'Blocked', 'At Risk']);

/** Derive human-readable commitment label from a milestone record.
 *  Uses CRM's own formatted value as source of truth instead of hardcoded codes. */
function commitmentLabel(m) {
  return fv(m, 'msp_commitmentrecommendation') || 'Unknown';
}

/** Normalize commitment to a Committed/Uncommitted bucket for dashboard aggregation.
 *  Best Case counts as Committed per MCEM business rules. */
function commitmentBucket(m) {
  const label = commitmentLabel(m).toLowerCase();
  return (label === 'committed' || label === 'best case') ? 'Committed' : 'Uncommitted';
}

/** Parse workload TYPE code from milestone record (shared logic for capacity/workload filtering). */
function parseWorkloadTypeCode(m) {
  const rawWorkloadType = m.msp_milestoneworkload;
  const parsedWorkloadType = rawWorkloadType === undefined || rawWorkloadType === null || rawWorkloadType === ''
    ? null
    : (typeof rawWorkloadType === 'number' ? rawWorkloadType : parseInt(rawWorkloadType, 10));
  return Number.isFinite(parsedWorkloadType) ? parsedWorkloadType : null;
}

/** Get workload TYPE label from code. */
function workloadTypeLabel(code) {
  switch (code) {
    case WORKLOAD_TYPE.AZURE: return 'Azure';
    case WORKLOAD_TYPE.D365: return 'D365';
    case WORKLOAD_TYPE.SECURITY: return 'Security';
    case WORKLOAD_TYPE.MODERN_WORK: return 'Modern Work';
    default: return null;
  }
}

function buildMilestoneSummary(milestones, crmBaseUrl) {
  const byStatus = {};
  const byOpportunity = {};
  const byCommitment = { Committed: 0, Uncommitted: 0 };
  const byWorkloadType = {};
  const byWorkload = {};
  for (const m of milestones) {
    const status = fv(m, 'msp_milestonestatus') || 'Unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    const opp = fv(m, '_msp_opportunityid_value') || 'Unknown';
    byOpportunity[opp] = (byOpportunity[opp] || 0) + 1;
    byCommitment[commitmentBucket(m)] += 1;
    // Group by workload TYPE (A4)
    const workloadTypeCode = parseWorkloadTypeCode(m);
    const workloadType = workloadTypeLabel(workloadTypeCode) || 'Unknown';
    byWorkloadType[workloadType] = (byWorkloadType[workloadType] || 0) + 1;
    // Group by specific workload name
    const workloadName = fv(m, '_msp_workloadlkid_value') || 'Unknown';
    byWorkload[workloadName] = (byWorkload[workloadName] || 0) + 1;
  }
  return {
    count: milestones.length,
    byStatus,
    byCommitment,
    byOpportunity,
    byWorkloadType,
    byWorkload,
    milestones: milestones.map(m => ({
      ...m,
      status: fv(m, 'msp_milestonestatus'),
      commitment: commitmentLabel(m),
      opportunity: fv(m, '_msp_opportunityid_value'),
      recordUrl: buildRecordUrl(crmBaseUrl, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
    }))
  };
}

// Terminal milestone statuses that should NOT count toward live aggregates
// (seats/ACR) or active triage. Mirrors the exclusion list used by
// buildMilestoneTriage so every consumer drops the same cancelled/closed set.
const EXCLUDED_TERMINAL_MILESTONE_STATUSES = ['Cancelled', 'Closed as Incomplete', 'Lost to Competitor', 'Hygiene/Duplicate'];
const EXCLUDED_TERMINAL_MILESTONE_STATUS_CODES = [861980004, 861980007, 861980005, 861980006]; // Cancelled, Closed as Incomplete, Lost to Competitor, Hygiene/Duplicate

/** True when a milestone is in a terminal (cancelled/closed/lost/hygiene) status. */
function isExcludedTerminalMilestone(m) {
  const status = fv(m, 'msp_milestonestatus') || 'Unknown';
  const rawCode = m.msp_milestonestatus;
  const parsed = rawCode === undefined || rawCode === null || rawCode === ''
    ? null
    : (typeof rawCode === 'number' ? rawCode : parseInt(rawCode, 10));
  const statusCode = Number.isFinite(parsed) ? parsed : null;
  return EXCLUDED_TERMINAL_MILESTONE_STATUSES.includes(status) ||
    EXCLUDED_TERMINAL_MILESTONE_STATUS_CODES.includes(statusCode);
}

// Shared "done milestone" helper: Completed + all excluded terminal statuses.
// Used by pipeline_health, handoff_check, stage_map to prevent leaking Lost/Hygiene
// milestones into findings (A3 — MCEM terminal-status leak fix).
const DONE_MILESTONE_STATUS_CODES = [861980003, ...EXCLUDED_TERMINAL_MILESTONE_STATUS_CODES]; // Completed, Cancelled, Closed as Incomplete, Lost to Competitor, Hygiene/Duplicate
const DONE_MILESTONE_STATUSES = new Set(['Completed', 'Cancelled', 'Closed as Incomplete', 'Lost to Competitor', 'Hygiene/Duplicate']);

/** True when a milestone is "done" (Completed or any excluded terminal status). */
function isDoneMilestone(m) {
  const status = fv(m, 'msp_milestonestatus') || '';
  const raw = m.msp_milestonestatus;
  const code = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return DONE_MILESTONE_STATUSES.has(status) || DONE_MILESTONE_STATUS_CODES.includes(code);
}

/**
 * Aggregate per-opportunity seats (usage) and monthlyUse/ACR (consumption) from
 * engagement milestones in ONE batch query (chunked by 25 opp IDs to keep the
 * filter URL manageable) — never N+1. Terminal milestones are excluded so live
 * totals don't include cancelled/closed work. Mirrors the field semantics used by
 * web/src/fiscal.js (monthlyUse ← msp_monthlyuse, seats ← msp_noofactivations).
 * @returns {Promise<Record<string, { seats: number, monthlyUse: number }>>} oppId → totals
 */
async function aggregateOppMetrics(crmClient, oppIds) {
  const totals = {};
  const uniqueIds = [...new Set((oppIds || []).filter(Boolean))];
  if (!uniqueIds.length) return totals;

  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 25) chunks.push(uniqueIds.slice(i, i + 25));
  for (const chunk of chunks) {
    const f = `(${chunk.map(id => `_msp_opportunityid_value eq '${id}'`).join(' or ')})`;
    const r = await crmClient.requestAllPages('msp_engagementmilestones', {
      query: { $filter: f, $select: 'msp_engagementmilestoneid,_msp_opportunityid_value,msp_monthlyuse,msp_noofactivations,msp_milestonestatus' }
    });
    if (!r.ok || !r.data?.value) continue;
    for (const m of r.data.value) {
      if (isExcludedTerminalMilestone(m)) continue;
      const oppId = m._msp_opportunityid_value;
      if (!oppId) continue;
      if (!totals[oppId]) totals[oppId] = { seats: 0, monthlyUse: 0 };
      totals[oppId].seats += Number(m.msp_noofactivations) || 0;
      totals[oppId].monthlyUse += Number(m.msp_monthlyuse) || 0;
    }
  }
  return totals;
}

/**
 * Triage format: classifies milestones into urgency buckets and strips
 * verbose OData annotations for a compact, action-oriented response.
 */
function buildMilestoneTriage(milestones, crmBaseUrl) {
  const now = new Date();
  // Use local date strings (NOT toISOString which shifts to UTC and can lose a day)
  const pad = n => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // "Due soon" = end of current month (seller's mental model: this month)
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const soonStr = `${endOfMonth.getFullYear()}-${pad(endOfMonth.getMonth() + 1)}-${pad(endOfMonth.getDate())}`;

  const buckets = { overdue: [], due_soon: [], blocked: [], on_track: [], completed: [] };
  // date_urgent: milestones with imminent dates REGARDLESS of status (for "Needs Attention")
  const dateUrgent = { overdue: [], due_soon: [] };
  // Summary remains active-only so existing dashboard panels do not start counting terminal items.
  const summary = { total: 0, overdue: 0, due_soon: 0, blocked: 0, on_track: 0, completed: 0, byCommitment: { Committed: 0, Uncommitted: 0 } };

  const COMPLETED_STATUS_CODES = [861980003];

  for (const m of milestones) {
    const status = fv(m, 'msp_milestonestatus') || 'Unknown';
    const rawCode = m.msp_milestonestatus;
    const parsedStatusCode = rawCode === undefined || rawCode === null || rawCode === ''
      ? null
      : (typeof rawCode === 'number' ? rawCode : parseInt(rawCode, 10));
    const statusCode = Number.isFinite(parsedStatusCode) ? parsedStatusCode : null;
    const isCompleted = status === 'Completed' || COMPLETED_STATUS_CODES.includes(statusCode);

    // Matrix needs completed milestones, but cancelled/closed terminal items stay out of the payload.
    if (isExcludedTerminalMilestone(m)) {
      continue;
    }

    const date = m.msp_milestonedate || null;
    const commitment = commitmentLabel(m);
    const rawCategoryCode = m.msp_milestonecategory;
    const parsedCategoryCode = rawCategoryCode === undefined || rawCategoryCode === null || rawCategoryCode === ''
      ? null
      : (typeof rawCategoryCode === 'number' ? rawCategoryCode : parseInt(rawCategoryCode, 10));
    const categoryCode = Number.isFinite(parsedCategoryCode) ? parsedCategoryCode : null;
    const category = fv(m, 'msp_milestonecategory') || null;
    const workloadLabel = fv(m, '_msp_workloadlkid_value') || fv(m, 'msp_milestoneworkload');
    const marketplacePattern = /\b(isv|marketplace|mbs)\b/i;
    const isMarketplace = categoryCode === 725300001
      || marketplacePattern.test(category || '')
      || marketplacePattern.test(workloadLabel || '');
    const isPracr = categoryCode === 861980006;

    const compact = {
      id: m.msp_engagementmilestoneid,
      number: m.msp_milestonenumber,
      name: m.msp_name,
      status,
      statusCode,
      statusReason: fv(m, 'msp_milestonestatusreason') || null,
      statusReasonCode: m.msp_milestonestatusreason ?? null,
      category,
      categoryCode,
      isMarketplace,
      isPracr,
      commitment,
      commitmentCode: m.msp_commitmentrecommendation ?? null,
      nonRecurring: m.msp_nonrecurring == null || m.msp_nonrecurring === '' ? null : Number(m.msp_nonrecurring) === 861980000,
      nonRecurringMonths: Number.isFinite(Number(m.msp_nonrecurringmonths)) ? Number(m.msp_nonrecurringmonths) : null,
      date,
      monthlyUse: Number(m.msp_monthlyuse) || 0,
      seats: Number(m.msp_noofactivations) || 0,
      opportunity: fv(m, '_msp_opportunityid_value'),
      opportunityId: m._msp_opportunityid_value || null,
      // Owner (raw GUID + display name). Threaded so the matrix / lineage can show
      // the milestone owner; mirrors projectMilestoneCompact's owner handling.
      ownerId: m._ownerid_value ? String(m._ownerid_value).toLowerCase().replace(/[{}]/g, '') : null,
      ownerName: fv(m, '_ownerid_value') || '',
      workload: workloadLabel,
      azureRegion: fv(m, 'msp_milestonepreferredazureregion'),
      azureRegionCode: m.msp_milestonepreferredazureregion ?? null,
      azureCapacityType: fv(m, 'msp_milestoneazurecapacitytype'),
      azureCapacityCode: m.msp_milestoneazurecapacitytype ?? null,
      // Workload TYPE optionset (msp_milestoneworkload) — authoritative Azure
      // discriminator. Azure=861980000, D365=861980001, Security=861980002,
      // Modern Work=861980003. Carried raw so the dashboard scopes Azure nudges by
      // TYPE, not by the workload LABEL (which can be prefixed e.g. "AI: Azure …").
      workloadTypeCode: m.msp_milestoneworkload ?? null,
      recordUrl: buildRecordUrl(crmBaseUrl, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
    };

    if (isCompleted) {
      buckets.completed.push(compact);
      summary.completed++;
      continue;
    }

    summary.total++;
    summary.byCommitment[commitmentBucket(m)] += 1;
    if (m.tasks) compact.tasks = m.tasks;

    if (status === 'Blocked' || status === 'At Risk') {
      buckets.blocked.push(compact);
      summary.blocked++;
    } else if (date && date < todayStr) {
      buckets.overdue.push(compact);
      summary.overdue++;
    } else if (date && date <= soonStr) {
      buckets.due_soon.push(compact);
      summary.due_soon++;
    } else {
      buckets.on_track.push(compact);
      summary.on_track++;
    }

    // Date-based urgency — independent of status bucket
    // A Blocked milestone expiring tomorrow still needs date-based attention
    if (date && date < todayStr) {
      dateUrgent.overdue.push(compact);
    } else if (date && date <= soonStr) {
      dateUrgent.due_soon.push(compact);
    }
  }

  // Sort each bucket by date ascending
  for (const list of Object.values(buckets)) {
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  }

  return { summary, ...buckets, date_urgent: dateUrgent };
}

/**
 * Default compact projection for `get_milestones` table-friendly responses.
 * Strips OData annotations (FormattedValue, lookuplogicalname, @odata.etag, …) and
 * unused fields (msp_forecastcomments*, msp_deliveryspecifiedfield, region/capacity, …)
 * that bloat each record by ~3-4 KB. Keeps the raw msp_* keys the existing tests
 * assert against, and adds short friendly aliases (status, commitment, opportunity,
 * workload, customer, link) so the LLM can render a table without re-parsing
 * `@OData.Community.Display.V1.FormattedValue` suffixes.
 *
 * Target: ≤ ~500 bytes per milestone (vs ~4 KB raw) so 9 records fit well under
 * the bundled-CLI 20 KB temp-spill threshold.
 */
function projectMilestoneCompact(m, crmBaseUrl, customerName = null, ownerFilterGuid = null) {
  const rawOwner = m._ownerid_value || null;
  const ownerId = rawOwner ? String(rawOwner).toLowerCase().replace(/[{}]/g, '') : null;
  
  // Region None code (single optionset)
  const REGION_NONE = 861980076;
  // Capacity None code (multi-select, comma-separated)
  const CAPACITY_NONE = 861980000;
  
  // Azure region helpers
  const rawRegion = m.msp_milestonepreferredazureregion ?? null;
  const azureRegionCode = rawRegion;
  const azureRegion = fv(m, 'msp_milestonepreferredazureregion');
  const hasAzureRegion = rawRegion !== null && rawRegion !== '' && rawRegion !== REGION_NONE;
  
  // Azure capacity helpers (multi-select comma-separated)
  const rawCapacity = m.msp_milestoneazurecapacitytype ?? null;
  const azureCapacityCode = rawCapacity;
  const azureCapacityType = fv(m, 'msp_milestoneazurecapacitytype');
  // Split on commas, check if any non-None codes exist
  const capacityCodes = rawCapacity && typeof rawCapacity === 'string' && rawCapacity.trim() !== ''
    ? rawCapacity.split(',').map(c => Number(c.trim())).filter(c => !isNaN(c))
    : [];
  const hasAzureCapacityType = capacityCodes.length > 0 && capacityCodes.some(c => c !== CAPACITY_NONE);

  // Workload TYPE fields (A4)
  const workloadTypeCode = parseWorkloadTypeCode(m);
  const workloadType = workloadTypeLabel(workloadTypeCode);

  // Comment fields (A5) — forecast journal is the single source of truth
  const forecastComments = m.msp_forecastcomments ?? null;
  const hasComments = forecastComments !== null && forecastComments !== '';
  const lastCommentedOnRaw = m['msp_forecastcomments_lastmodifiedon@OData.Community.Display.V1.FormattedValue']
    ?? m.msp_forecastcomments_lastmodifiedon
    ?? null;
  const lastCommentedOn = lastCommentedOnRaw;
  // Compute age in days using local date handling (consistent with buildMilestoneTriage)
  let commentAgeDays = null;
  if (lastCommentedOn) {
    const commentDate = new Date(lastCommentedOn);
    if (!isNaN(commentDate.getTime())) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const commentYYYYMMDD = `${commentDate.getFullYear()}-${pad(commentDate.getMonth() + 1)}-${pad(commentDate.getDate())}`;
      const today = new Date(todayStr);
      const commentDay = new Date(commentYYYYMMDD);
      const diffMs = today.getTime() - commentDay.getTime();
      commentAgeDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }
  }
  
  const out = {
    msp_engagementmilestoneid: m.msp_engagementmilestoneid,
    msp_milestonenumber: m.msp_milestonenumber || null,
    msp_name: m.msp_name || null,
    msp_milestonedate: m.msp_milestonedate || null,
    msp_monthlyuse: m.msp_monthlyuse ?? null,
    _msp_opportunityid_value: m._msp_opportunityid_value ?? null,
    _msp_workloadlkid_value: m._msp_workloadlkid_value ?? null,
    status: fv(m, 'msp_milestonestatus'),
    statusCode: m.msp_milestonestatus ?? null,
    statusReason: fv(m, 'msp_milestonestatusreason') || null,
    statusReasonCode: m.msp_milestonestatusreason ?? null,
    commitment: commitmentLabel(m),
    commitmentCode: m.msp_commitmentrecommendation ?? null,
    // Seller-set recurrence — tri-state. `true` means the source SAID non-recurring;
    // `null` means it said nothing, which is not the same as "recurring" and must not
    // collapse into it. Consumers fall back to category inference only on `null`.
    nonRecurring: m.msp_nonrecurring == null || m.msp_nonrecurring === '' ? null : Number(m.msp_nonrecurring) === 861980000,
    nonRecurringMonths: Number.isFinite(Number(m.msp_nonrecurringmonths)) ? Number(m.msp_nonrecurringmonths) : null,
    category: fv(m, 'msp_milestonecategory'),
    // Raw option-set code alongside the label. The label is localisable and has
    // drifted before ("POC/Pilot" vs "PoC/Pilot"); anything that must BRANCH on
    // category — recurrence inference in the ACR alignment surface, for one —
    // needs the stable numeric code rather than a string match.
    categoryCode: (() => {
      const raw = m.msp_milestonecategory;
      if (raw === undefined || raw === null || raw === '') return null;
      const code = typeof raw === 'number' ? raw : parseInt(raw, 10);
      return Number.isFinite(code) ? code : null;
    })(),
    opportunity: fv(m, '_msp_opportunityid_value'),
    opportunityId: m._msp_opportunityid_value || null,
    workload: fv(m, '_msp_workloadlkid_value'),
    workloadType,
    workloadTypeCode,
    customer: customerName,
    ownerName: fv(m, '_ownerid_value'),
    ownerId,
    assignedToMe: ownerFilterGuid ? ownerId === String(ownerFilterGuid).toLowerCase().replace(/[{}]/g, '') : null,
    azureRegion,
    azureRegionCode,
    azureCapacityType,
    azureCapacityCode,
    hasAzureRegion,
    hasAzureCapacityType,
    // Delivered By (msp_deliveryspecifiedfield) — the Update Commitment flow (#3) needs to
    // know whether this always-required-on-commit field is already set on the milestone.
    deliveredByCode: m.msp_deliveryspecifiedfield ?? null,
    deliveredBy: fv(m, 'msp_deliveryspecifiedfield'),
    hasDeliveredBy: m.msp_deliveryspecifiedfield !== null && m.msp_deliveryspecifiedfield !== undefined && m.msp_deliveryspecifiedfield !== '',
    hasComments,
    lastCommentedOn,
    commentAgeDays,
    link: buildRecordUrl(crmBaseUrl, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
  };
  // Preserve inline tasks when includeTasks=true was requested upstream.
  if (m.tasks) out.tasks = m.tasks;
  return out;
}

/**
 * Compact milestone object for health check findings — includes opp context.
 */
function compactMs(m, crmBase, oppMap) {
  const oppId = m._msp_opportunityid_value;
  const opp = oppMap?.[oppId];
  return {
    id: m.msp_engagementmilestoneid,
    number: m.msp_milestonenumber,
    name: m.msp_name,
    status: fv(m, 'msp_milestonestatus') || 'Unknown',
    commitment: commitmentLabel(m),
    category: fv(m, 'msp_milestonecategory') || null,
    date: m.msp_milestonedate || null,
    opportunity: fv(m, '_msp_opportunityid_value') || null,
    opportunityId: oppId || null,
    opportunityNumber: opp?.msp_opportunitynumber || null,
    workload: fv(m, '_msp_workloadlkid_value') || null,
    owner: fv(m, '_ownerid_value') || null,
    recordUrl: buildRecordUrl(crmBase, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
  };
}

const MCEM_STAGE_MAP = {
  'listen & consult':  1,
  'inspire & design':  2,
  'empower & achieve': 3,
  'realize value':     4,
  'manage & optimize': 5,
};

const MCEM_PROCESS_ID = '5cbd275e-a16c-4e49-9910-7aa1aab15997';
const MCEM_STAGE_YES = 606820000;
const MCEM_EXIT_CRITERIA_YES = 861980000;
const MCEM_BPF_ENTITY_SET_FALLBACK = 'msp_mcemprocesses';

const MCEM_STAGE_FIELD_META = {
  msp_solutionarea: {
    field: 'msp_solutionarea',
    readField: 'msp_solutionarea',
    label: 'Solution Area',
    type: 'picklist',
    required: true
  },
  msp_salesplay: {
    field: 'msp_salesplay',
    readField: 'msp_salesplay',
    label: 'Sales Play',
    type: 'picklist',
    required: true
  },
  description: {
    field: 'description',
    readField: 'description',
    label: 'Customer Need',
    type: 'text',
    required: true
  },
  parentcontactid: {
    field: 'parentcontactid',
    readField: '_parentcontactid_value',
    bindKey: 'parentcontactid@odata.bind',
    label: 'Customer Decision Maker',
    type: 'lookup',
    required: true,
    lookup: {
      entity: 'contact',
      entitySet: 'contacts',
      idField: 'contactid',
      displayField: 'fullname',
      bind: 'parentcontactid@odata.bind',
      context: 'opportunityAccount',
      searchTool: 'mcem_stage_lookup_search',
      searchEndpoint: '/api/opportunity-stage-lookup-search'
    }
  },
  msp_primarycompetitor: {
    field: 'msp_primarycompetitor',
    readField: '_msp_primarycompetitor_value',
    bindKey: 'msp_PrimaryCompetitor@odata.bind',
    bindAliases: ['msp_primarycompetitor@odata.bind'],
    label: 'Primary Competitor',
    type: 'lookup',
    required: true,
    lookup: {
      entity: 'competitor',
      entitySet: 'competitors',
      idField: 'competitorid',
      displayField: 'name',
      bind: 'msp_PrimaryCompetitor@odata.bind',
      context: 'global',
      searchTool: 'mcem_stage_lookup_search',
      searchEndpoint: '/api/opportunity-stage-lookup-search'
    }
  },
  msp_competethreatlevel: {
    field: 'msp_competethreatlevel',
    readField: 'msp_competethreatlevel',
    label: 'Compete Threat Level',
    type: 'picklist',
    required: true
  }
};

const MCEM_STAGES = [
  {
    number: 1,
    name: 'Listen & Consult',
    id: '60b911e7-32fb-4490-98c7-a9d3e06a6492',
    checklist: {
      msp_customerprioritiesidentified: MCEM_STAGE_YES,
      msp_qualifiedopportunity: MCEM_EXIT_CRITERIA_YES,
      msp_initialstakeholderidentificationcomplete: MCEM_STAGE_YES,
      msp_customerneedsandoutcomesdefine: MCEM_STAGE_YES
    },
    blockers: [
      MCEM_STAGE_FIELD_META.msp_solutionarea,
      MCEM_STAGE_FIELD_META.msp_salesplay
    ]
  },
  {
    number: 2,
    name: 'Inspire & Design',
    id: 'f5a927f6-03c6-45fc-a8af-70adc140d470',
    checklist: {
      msp_businessvalueconsiderationscompleted: MCEM_STAGE_YES,
      msp_designagreedwithcustomer: MCEM_EXIT_CRITERIA_YES,
      msp_solutionplaysconfirmeddealteamorchest: MCEM_STAGE_YES,
      msp_partnersidentifiedandengaged: MCEM_STAGE_YES,
      msp_solutiondesignvalidatedwithcustomer: MCEM_STAGE_YES,
      msp_technicalbusinessproofrequirementside: MCEM_STAGE_YES
    },
    blockers: [
      MCEM_STAGE_FIELD_META.description,
      MCEM_STAGE_FIELD_META.parentcontactid
    ]
  },
  {
    number: 3,
    name: 'Empower & Achieve',
    id: '937a8569-d7e5-41b4-a4a3-2f74cec5a6d9',
    checklist: {
      msp_customersignedoffonproposesolution: MCEM_STAGE_YES,
      msp_customeragreementinplace: MCEM_EXIT_CRITERIA_YES,
      msp_customersuccessplanreviewedwithcustomer: MCEM_STAGE_YES,
      msp_customercommittoproposal: MCEM_STAGE_YES
    },
    blockers: [
      MCEM_STAGE_FIELD_META.msp_primarycompetitor,
      MCEM_STAGE_FIELD_META.msp_competethreatlevel
    ],
    milestoneRequiredForNext: true
  },
  {
    number: 4,
    name: 'Realize Value',
    id: '5031ed91-b1ec-400b-a4a3-05b6e85c5c83',
    checklist: {
      msp_solutiondeliveredagainstagreedoutcome: MCEM_STAGE_YES,
      msp_outcomesmetandbaselinemetricsinplace: MCEM_EXIT_CRITERIA_YES,
      msp_resourcesalignagainstdeliveryplan: MCEM_STAGE_YES,
      msp_changemanagementplanplace: MCEM_STAGE_YES
    },
    blockers: []
  },
  {
    number: 5,
    name: 'Manage & Optimize',
    id: '2a1bc476-b566-49b9-a9b7-392076e28c03',
    checklist: {
      msp_customercanoperateandmaintainsolution: MCEM_STAGE_YES,
      msp_opportunitycompletedandnextstepsidentify: MCEM_EXIT_CRITERIA_YES,
      msp_customersuccessplanupdated: MCEM_STAGE_YES,
      msp_customerhealthmetricsagreedwithmonitoring: MCEM_STAGE_YES,
      msp_nextsetofcustomerneedsidentify: MCEM_STAGE_YES,
      msp_busvalueandsuccessoutcomemonitoringinplac: MCEM_STAGE_YES
    },
    blockers: []
  }
];

const MCEM_STAGE_BY_NUMBER = Object.fromEntries(MCEM_STAGES.map(stage => [stage.number, stage]));
const MCEM_STAGE_BY_ID = Object.fromEntries(MCEM_STAGES.map(stage => [stage.id.toLowerCase(), stage]));

const MCEM_PRIMARY_COMPETITOR_QUICK_OPTIONS = [
  {
    key: 'google-gcp',
    label: 'Google | GCP',
    type: 'record-search',
    entitySet: 'competitors',
    searchTerms: ['Google', 'GCP'],
    submit: { mode: 'selectedLookupOption' }
  },
  {
    key: 'aws-other',
    label: 'AWS | Other',
    type: 'record-search',
    entitySet: 'competitors',
    searchTerms: ['AWS', 'Other'],
    submit: { mode: 'selectedLookupOption' }
  },
  {
    key: 'none',
    label: 'None',
    type: 'null-selection',
    entitySet: null,
    searchTerms: [],
    submit: {
      mode: 'clearLookup',
      value: { quickOptionKey: 'none', value: null }
    }
  }
];

/**
 * Extract MCEM stage number (1–5) from an opportunity record.
 * Maps actual live MCEM phase name strings (e.g., "Inspire & Design") to stage numbers.
 * Legacy fallback: handles raw numeric option-set codes and formatted text like "Stage 3".
 * Returns null if the stage cannot be determined (safe — don't flag ambiguous cases).
 */
function parseSalesStageNumber(opp) {
  const raw = opp.msp_activesalesstage;
  if (typeof raw === 'number' && raw >= 1 && raw <= 5) return raw;
  const fmt = fv(opp, 'msp_activesalesstage') || (typeof raw === 'string' ? raw : '');
  if (!fmt) return null;
  const normalized = fmt.toLowerCase().trim();
  // Map MCEM phase names to stage numbers (actual live values)
  if (MCEM_STAGE_MAP[normalized] !== undefined) return MCEM_STAGE_MAP[normalized];
  // Legacy fallback: numeric digit in string (for any orgs still using old format)
  const m = normalized.match(/\b([1-5])\b/);
  return m ? parseInt(m[1], 10) : null;
}

function normalizeMcemStageInput(input) {
  if (typeof input === 'number' && MCEM_STAGE_BY_NUMBER[input]) return MCEM_STAGE_BY_NUMBER[input];
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (MCEM_STAGE_MAP[normalized]) return MCEM_STAGE_BY_NUMBER[MCEM_STAGE_MAP[normalized]];
  const stageMatch = normalized.match(/(?:stage\s*)?([1-5])$/);
  if (stageMatch) return MCEM_STAGE_BY_NUMBER[Number(stageMatch[1])];
  const byId = MCEM_STAGE_BY_ID[normalized.replace(/[{}]/g, '')];
  return byId || null;
}

function bpfStageId(record) {
  const raw = record?._activestageid_value ||
    record?.activestageid?.processstageid ||
    record?.activestageid ||
    record?.ActiveStageId ||
    record?.activestageid;
  return raw ? normalizeGuid(String(raw)) : null;
}

function bpfInstanceId(record) {
  return record?.businessprocessflowinstanceid ||
    record?.msp_mcemprocessid ||
    record?.msp_mcemprocessid_value ||
    record?.ProcessInstanceId ||
    record?.processinstanceid ||
    null;
}

function bpfEntitySet(record) {
  return record?.entitySet || record?.EntitySetName || record?.entitysetname || null;
}

function bpfProcessDefinitionId(record) {
  const raw = record?.ProcessDefinitionId || record?.processdefinitionid || record?._processid_value || record?.processid;
  return raw ? normalizeGuid(String(raw)) : null;
}

function normalizeRetrieveProcessInstance(record = {}) {
  return {
    ...record,
    businessprocessflowinstanceid: bpfInstanceId(record),
    _activestageid_value: bpfStageId(record),
    traversedpath: record.TraversedPath || record.traversedpath || null,
    entitySet: bpfEntitySet(record)
  };
}

function chooseMcemProcessInstance(instances = []) {
  const processId = normalizeGuid(MCEM_PROCESS_ID);
  return instances.find(item => bpfProcessDefinitionId(item) === processId) ||
    instances.find(item => MCEM_STAGE_BY_ID[bpfStageId(item)]) ||
    instances[0] ||
    null;
}

async function retrieveProcessInstance(crmClient, opportunityId) {
  const path = `RetrieveProcessInstances(EntityId=@entityId,EntityLogicalName=@entityLogicalName)?@entityId=${opportunityId}&@entityLogicalName='opportunity'`;
  const result = await crmClient.request(path, { retries: 2 });
  if (!result.ok) return { ok: false, status: result.status, message: result.data?.message || 'RetrieveProcessInstances failed' };
  const instance = chooseMcemProcessInstance(result.data?.value || []);
  return { ok: true, instance: instance ? normalizeRetrieveProcessInstance(instance) : null };
}

async function discoverBpfEntitySets(crmClient) {
  const candidates = [];
  const add = value => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  const exact = await crmClient.request("EntityDefinitions(LogicalName='msp_mcemprocess')", {
    query: { $select: 'LogicalName,EntitySetName' }
  });
  if (exact.ok) add(exact.data?.EntitySetName);

  const allBpf = await crmClient.requestAllPages('EntityDefinitions', {
    query: {
      $select: 'LogicalName,EntitySetName',
      $filter: 'IsBPFEntity eq true'
    }
  });
  if (allBpf.ok) {
    for (const meta of allBpf.data?.value || []) {
      if (/mcem|opportunity/i.test(`${meta.LogicalName || ''} ${meta.EntitySetName || ''}`)) add(meta.EntitySetName);
    }
    for (const meta of allBpf.data?.value || []) add(meta.EntitySetName);
  }
  add(MCEM_BPF_ENTITY_SET_FALLBACK);

  return candidates;
}

// Org-stable cache: the MCEM BPF entity-set NAME never changes for a tenant, so once
// resolved we reuse it. This avoids re-running discoverBpfEntitySets' 2 EntityDefinitions
// metadata queries on EVERY BPF read — which is both slow and a transient-failure surface
// under load (otherwise it intermittently yields "BPF entity set could not be discovered"
// mid-transition on a heavy, many-milestone opp).
let resolvedBpfEntitySet = null;

async function fetchBpfRecordByInstanceId(crmClient, instanceId, preferredEntitySet = null) {
  const bpfSelect = 'businessprocessflowinstanceid,_activestageid_value,activestageid,traversedpath';
  // Fast path: try the already-resolved / preferred entity set with a direct read
  // (retries ride out a transient 429/5xx) before falling back to full discovery.
  const primary = preferredEntitySet || resolvedBpfEntitySet;
  if (primary) {
    const direct = await crmClient.request(`${primary}(${instanceId})`, { query: { $select: bpfSelect }, retries: 2 });
    if (direct.ok) { resolvedBpfEntitySet = primary; return { ok: true, instance: { ...direct.data, entitySet: primary } }; }
  }

  const discovered = await discoverBpfEntitySets(crmClient);
  const candidates = preferredEntitySet
    ? [preferredEntitySet, ...discovered.filter(name => name !== preferredEntitySet)]
    : discovered;

  let lastFailure = null;
  for (const entitySet of candidates) {
    const result = await crmClient.request(`${entitySet}(${instanceId})`, { query: { $select: bpfSelect }, retries: 2 });
    if (result.ok) { resolvedBpfEntitySet = entitySet; return { ok: true, instance: { ...result.data, entitySet } }; }
    if (result.status !== 404) {
      lastFailure = { status: result.status, message: result.data?.message || `BPF lookup failed for ${entitySet}` };
    }
  }
  return { ok: false, ...(lastFailure || { status: 404, message: 'BPF entity set lookup failed' }) };
}

function currentMcemStageFrom(opp, bpfInstance) {
  const activeStageId = bpfStageId(bpfInstance);
  if (activeStageId && MCEM_STAGE_BY_ID[activeStageId]) return MCEM_STAGE_BY_ID[activeStageId];
  const parsed = parseSalesStageNumber(opp);
  return parsed ? MCEM_STAGE_BY_NUMBER[parsed] : null;
}

async function fetchMcemBpfInstance(crmClient, opportunityId) {
  const retrieveResult = await retrieveProcessInstance(crmClient, opportunityId);
  if (retrieveResult.ok && retrieveResult.instance) {
    const instanceId = bpfInstanceId(retrieveResult.instance);
    if (!instanceId) return retrieveResult;
    const fullRecord = await fetchBpfRecordByInstanceId(crmClient, instanceId, bpfEntitySet(retrieveResult.instance));
    if (fullRecord.ok) return fullRecord;
    return retrieveResult;
  }

  const candidates = await discoverBpfEntitySets(crmClient);
  let lastFailure = retrieveResult.ok ? null : { status: retrieveResult.status, message: retrieveResult.message };
  for (const entitySet of candidates) {
    const result = await crmClient.requestAllPages(entitySet, {
      query: {
        $filter: `_regardingobjectid_value eq '${opportunityId}'`,
        $select: 'businessprocessflowinstanceid,msp_mcemprocessid,_activestageid_value,activestageid,traversedpath,_regardingobjectid_value',
        $top: '1'
      },
      maxRecords: 1
    });
    if (result.ok) {
      const instance = result.data?.value?.[0] || null;
      return { ok: true, instance: instance ? { ...instance, entitySet } : null };
    }
    if (result.status !== 404) {
      lastFailure = { status: result.status, message: result.data?.message || `BPF lookup failed for ${entitySet}` };
    }
  }

  if (retrieveResult.ok) return { ok: true, instance: null };
  return { ok: false, ...(lastFailure || { status: 404, message: 'BPF lookup failed' }) };
}

async function fetchMcemOpportunityState(crmClient, opportunityId) {
  const [oppResult, bpfResult] = await Promise.all([
    crmClient.request(`opportunities(${opportunityId})`, {
      query: { $select: MCEM_STAGE_OPPORTUNITY_SELECT }
    }),
    fetchMcemBpfInstance(crmClient, opportunityId)
  ]);
  if (!oppResult.ok) return { ok: false, status: oppResult.status, message: oppResult.data?.message || 'Opportunity lookup failed' };
  if (!bpfResult.ok) return { ok: false, status: bpfResult.status, message: bpfResult.message };
  return { ok: true, opportunity: oppResult.data, bpfInstance: bpfResult.instance };
}

function hasValue(record, field) {
  const value = record?.[field];
  return value !== undefined && value !== null && value !== '';
}

function blockerReadField(blocker) {
  return blocker.readField || blocker.field;
}

function parseOptionSetOptions(options = []) {
  return options
    .map(o => ({
      value: o?.Value,
      label: o?.Label?.UserLocalizedLabel?.Label || o?.Label?.LocalizedLabels?.[0]?.Label || ''
    }))
    .filter(o => Number.isInteger(o.value) && o.label);
}

function lookupOptionFromRecord(record, meta, context = {}) {
  const id = normalizeGuid(record?.[meta.lookup.idField]);
  if (!isValidGuid(id)) return null;
  const label = record?.[meta.lookup.displayField] ||
    record?.fullname ||
    record?.name ||
    record?.emailaddress1 ||
    id;
  const recordAccountId = record?._parentcustomerid_value ? normalizeGuid(record._parentcustomerid_value) : null;
  const isAccountRelated = Boolean(meta.field === 'parentcontactid' && context.accountId && recordAccountId === context.accountId);
  const secondaryParts = [
    record?.jobtitle,
    record?.emailaddress1,
    fv(record, '_parentcustomerid_value')
  ].filter(Boolean);
  const bindPath = `/${meta.lookup.entitySet}(${id})`;
  return {
    id,
    label,
    name: label,
    entity: meta.lookup.entity,
    entitySet: meta.lookup.entitySet,
    bindKey: meta.bindKey,
    bindPath,
    bindValue: bindPath,
    field: meta.field,
    secondaryText: secondaryParts.length ? secondaryParts.join(' • ') : null,
    rank: {
      scope: isAccountRelated ? 'account-related' : 'global',
      reason: isAccountRelated ? 'Contact belongs to the opportunity account.' : 'Matched the global lookup search.'
    }
  };
}

async function getOpportunityLookupContext(crmClient, opportunityId) {
  if (!isValidGuid(opportunityId)) return { opportunityId: null, accountId: null, accountName: null };
  const result = await crmClient.request(`opportunities(${opportunityId})`, {
    query: { $select: 'opportunityid,_parentaccountid_value' }
  });
  if (!result.ok) return { opportunityId, accountId: null, accountName: null };
  return {
    opportunityId,
    accountId: result.data?._parentaccountid_value ? normalizeGuid(result.data._parentaccountid_value) : null,
    accountName: fv(result.data, '_parentaccountid_value') || null
  };
}

function buildLookupSearchContract(meta, context = {}) {
  const contract = {
    kind: 'searchable-select',
    field: meta.field,
    label: meta.label,
    entity: meta.lookup.entity,
    entitySet: meta.lookup.entitySet,
    idField: meta.lookup.idField,
    displayField: meta.lookup.displayField,
    bindKey: meta.bindKey,
    searchTool: meta.lookup.searchTool,
    searchEndpoint: meta.lookup.searchEndpoint,
    queryParameters: {
      opportunityId: context.opportunityId || null,
      accountId: context.accountId || null,
      field: meta.field,
      entitySet: meta.lookup.entitySet
    },
    inputValue: 'selected option id',
    displayValue: 'label',
    allowManualGuidEntry: false
  };
  if (meta.field === 'msp_primarycompetitor') {
    contract.quickOptions = MCEM_PRIMARY_COMPETITOR_QUICK_OPTIONS;
    contract.nullSelection = {
      allowed: true,
      quickOptionKey: 'none',
      submitValue: { quickOptionKey: 'none', value: null },
      bindKey: meta.bindKey
    };
  }
  return contract;
}

function getLookupSearchTerms(meta, term = '') {
  const rawTerm = String(term || '').trim();
  if (!rawTerm) return [];
  const normalized = rawTerm.toLowerCase();
  if (meta.field === 'msp_primarycompetitor') {
    const quickOption = MCEM_PRIMARY_COMPETITOR_QUICK_OPTIONS.find(option =>
      option.type === 'record-search' &&
      (
        option.key.toLowerCase() === normalized ||
        option.label.toLowerCase() === normalized ||
        option.searchTerms.some(searchTerm => searchTerm.toLowerCase() === normalized)
      )
    );
    if (quickOption) return quickOption.searchTerms.map(sanitizeODataString).filter(Boolean);
  }
  return [sanitizeODataString(rawTerm)].filter(Boolean);
}

function buildLookupSearchFilter(meta, safeTerms = [], accountId = null) {
  const filters = [];
  if (meta.field === 'parentcontactid' && accountId) filters.push(`_parentcustomerid_value eq '${accountId}'`);
  if (safeTerms.length) {
    if (meta.field === 'parentcontactid') {
      const safeTerm = safeTerms[0];
      filters.push(`(contains(fullname,'${safeTerm}') or contains(emailaddress1,'${safeTerm}'))`);
    } else {
      filters.push(`(${safeTerms.map(safeTerm => `contains(${meta.lookup.displayField},'${safeTerm}')`).join(' or ')})`);
    }
  }
  return filters.length ? filters.join(' and ') : null;
}

function buildLookupSearchQuery(meta, safeTerms, fetchLimit, accountId = null) {
  const query = {
    $select: [
      meta.lookup.idField,
      meta.lookup.displayField,
      meta.field === 'parentcontactid' ? 'emailaddress1,jobtitle,_parentcustomerid_value' : null
    ].filter(Boolean).join(','),
    $top: String(fetchLimit),
    $orderby: `${meta.lookup.displayField} asc`
  };
  const filter = buildLookupSearchFilter(meta, safeTerms, accountId);
  if (filter) query.$filter = filter;
  return query;
}

function rankLookupOptions(options) {
  return [...options].sort((a, b) => {
    const aRank = a.rank?.scope === 'account-related' ? 0 : 1;
    const bRank = b.rank?.scope === 'account-related' ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
}

async function fetchLookupSearchPage(crmClient, meta, query, fetchLimit) {
  const result = await crmClient.requestAllPages(meta.lookup.entitySet, { query, maxRecords: fetchLimit });
  if (!result.ok) return result;
  return result;
}

async function searchMcemLookupOptions(crmClient, { field, entitySet, term = '', opportunityId, accountId, limit = 25, skip = 0 } = {}) {
  const meta = MCEM_STAGE_FIELD_META[field];
  if (!meta || meta.type !== 'lookup') {
    return { ok: false, error: 'Unsupported lookup blocker field.' };
  }
  if (entitySet && entitySet !== meta.lookup.entitySet) {
    return { ok: false, error: `${meta.label} search only supports ${meta.lookup.entitySet}.` };
  }

  const top = Math.max(1, Math.min(Number(limit) || 25, 50));
  const offset = Math.max(0, Number(skip) || 0);
  const fetchLimit = offset + top + 1;
  const safeTerms = getLookupSearchTerms(meta, term);
  let effectiveAccountId = accountId ? normalizeGuid(accountId) : null;
  let context = { opportunityId: opportunityId ? normalizeGuid(opportunityId) : null, accountId: effectiveAccountId };

  if (meta.field === 'parentcontactid' && !effectiveAccountId && isValidGuid(context.opportunityId)) {
    context = await getOpportunityLookupContext(crmClient, context.opportunityId);
    effectiveAccountId = context.accountId;
  }

  if (meta.field === 'parentcontactid' && !effectiveAccountId) {
    const nextPage = null;
    return {
      ok: true,
      field: meta.field,
      label: meta.label,
      lookup: buildLookupSearchContract(meta, context),
      options: [],
      limit: top,
      hasMore: false,
      nextPage,
      warning: 'Customer Decision Maker lookup requires an opportunity account context; broader CRM fallback was not used.',
      pagination: { limit: top, returned: 0, hasMore: false, nextPage }
    };
  }

  const query = buildLookupSearchQuery(meta, safeTerms, fetchLimit, effectiveAccountId);

  const records = [];
  const result = await fetchLookupSearchPage(crmClient, meta, query, fetchLimit);
  if (!result.ok) return { ok: false, error: result.data?.message || `${meta.label} lookup search failed`, status: result.status };
  records.push(...(result.data?.value || []));

  const seen = new Set();
  const rankedOptions = rankLookupOptions(records
    .filter(record => meta.field !== 'parentcontactid' || normalizeGuid(record?._parentcustomerid_value) === effectiveAccountId)
    .map(record => lookupOptionFromRecord(record, meta, context))
    .filter(Boolean)
    .filter(option => {
      if (seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    }));
  const options = rankedOptions.slice(offset, offset + top);
  const hasMore = rankedOptions.length > offset + top;
  const nextPage = hasMore ? { skip: offset + top, limit: top } : null;
  return {
    ok: true,
    field: meta.field,
    label: meta.label,
    lookup: buildLookupSearchContract(meta, context),
    options,
    limit: top,
    hasMore,
    nextPage,
    pagination: {
      limit: top,
      returned: options.length,
      hasMore,
      nextPage
    }
  };
}

async function getOpportunityPicklistOptions(crmClient, logicalName) {
  const result = await crmClient.request(
    `EntityDefinitions(LogicalName='opportunity')/Attributes(LogicalName='${logicalName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata`,
    { query: { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' } }
  );
  if (!result.ok) return { ok: false, status: result.status, message: result.data?.message || 'Picklist metadata lookup failed' };
  return { ok: true, options: parseOptionSetOptions(result.data?.OptionSet?.Options || []) };
}

async function enrichMcemBlocker(crmClient, blocker, from, to, context = {}) {
  const enriched = {
    blockerType: 'missing_required_field',
    type: blocker.type,
    stage: from.name,
    field: blocker.field,
    label: blocker.label,
    required: blocker.required !== false,
    message: `${blocker.label} is required before moving from ${from.name} to ${to.name}.`
  };
  if (blocker.type) enriched.fieldType = blocker.type;
  if (blocker.bindKey) enriched.bindKey = blocker.bindKey;
  if (blocker.type === 'lookup') {
    const searchResult = await searchMcemLookupOptions(crmClient, {
      field: blocker.field,
      opportunityId: context.opportunityId,
      accountId: context.accountId,
      limit: 25
    });
    enriched.lookup = searchResult.ok
      ? {
          ...searchResult.lookup,
          options: searchResult.options,
          hasMore: searchResult.hasMore,
          nextPage: searchResult.nextPage,
          pagination: searchResult.pagination
        }
      : { ...buildLookupSearchContract(blocker, context), options: [], warning: searchResult.error };
    enriched.options = enriched.lookup.options;
    enriched.hasMore = Boolean(searchResult.ok && searchResult.hasMore);
    enriched.nextPage = searchResult.ok ? searchResult.nextPage : null;
    enriched.pagination = searchResult.ok ? searchResult.pagination : null;
  } else if (blocker.lookup) {
    enriched.lookup = blocker.lookup;
  }
  if (blocker.type === 'picklist') {
    const optionsResult = await getOpportunityPicklistOptions(crmClient, blocker.field);
    enriched.options = optionsResult.ok ? optionsResult.options : [];
  }
  return enriched;
}

const MCEM_INPUT_FIELD_ALIASES = Object.fromEntries(
  Object.values(MCEM_STAGE_FIELD_META).flatMap(meta => {
    const aliases = [[meta.field, meta]];
    if (meta.readField && meta.readField !== meta.field) aliases.push([meta.readField, meta]);
    if (meta.bindKey) aliases.push([meta.bindKey, meta]);
    for (const bindAlias of meta.bindAliases || []) aliases.push([bindAlias, meta]);
    return aliases;
  })
);

function extractLookupSelection(raw) {
  if (raw === null) return { id: null, entitySet: null, isNullSelection: true };
  if (raw && typeof raw === 'object') {
    const quickOptionKey = String(raw.quickOptionKey || raw.key || '').trim().toLowerCase();
    const rawValue = raw.value ?? raw.id ?? raw.guid;
    if (quickOptionKey === 'none' && (rawValue === null || rawValue === undefined || rawValue === '')) {
      return { id: null, entitySet: null, isNullSelection: true, quickOptionKey: 'none' };
    }
  }
  const value = raw && typeof raw === 'object' ? (raw.id || raw.value || raw.guid) : raw;
  const stringValue = String(value ?? '').trim();
  const rawEntitySet = raw && typeof raw === 'object' ? (raw.entitySet || raw.entityset) : null;
  if (!stringValue) return { id: '', entitySet: rawEntitySet };

  const bindMatch = stringValue.match(/^\/?([A-Za-z0-9_]+)\(([0-9a-fA-F-{}]+)\)$/);
  if (bindMatch) {
    return { entitySet: bindMatch[1], id: normalizeGuid(bindMatch[2]) };
  }
  return { entitySet: rawEntitySet, id: normalizeGuid(stringValue) };
}

async function validateLookupSelection(crmClient, meta, id, opportunityId) {
  const result = await crmClient.request(`${meta.lookup.entitySet}(${id})`, {
    query: {
      $select: [
        meta.lookup.idField,
        meta.lookup.displayField,
        meta.field === 'parentcontactid' ? '_parentcustomerid_value' : null
      ].filter(Boolean).join(',')
    }
  });
  if (!result.ok) return { ok: false, error: `Select a valid ${meta.label} option.` };

  return { ok: true };
}

async function normalizeLookupInput(crmClient, raw, meta, opportunityId) {
  const selection = extractLookupSelection(raw);
  if (selection.isNullSelection) {
    if (meta.field === 'msp_primarycompetitor') return { ok: true, key: meta.bindKey, value: null };
    return { ok: false, error: `${meta.label} cannot be blank.` };
  }
  if (!selection.id) return { ok: false, error: `${meta.label} cannot be blank.` };
  const allowedEntitySets = [meta.lookup.entitySet, meta.lookup.bindEntitySet].filter(Boolean);
  if (selection.entitySet && !allowedEntitySets.includes(selection.entitySet)) {
    return { ok: false, error: `${meta.label} must be selected from ${allowedEntitySets.join(' or ')}.` };
  }
  if (!isValidGuid(selection.id)) return { ok: false, error: `Select a valid ${meta.label} option.` };

  const validation = await validateLookupSelection(crmClient, meta, selection.id, opportunityId);
  if (!validation.ok) return validation;
  const bindEntitySet = meta.lookup.bindEntitySet || meta.lookup.entitySet;
  return { ok: true, key: meta.bindKey, value: `/${bindEntitySet}(${selection.id})` };
}

async function normalizePicklistInput(crmClient, raw, meta) {
  const optionsResult = await getOpportunityPicklistOptions(crmClient, meta.field);
  if (!optionsResult.ok) {
    return { ok: false, error: `Could not validate ${meta.label} (${optionsResult.status}): ${optionsResult.message}` };
  }
  const options = optionsResult.options;
  if (!options.length) return { ok: false, error: `Could not validate ${meta.label}: no picklist options returned by CRM metadata.` };

  if (typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+$/.test(raw.trim()))) {
    const value = Number(raw);
    if (options.some(o => o.value === value)) return { ok: true, key: meta.field, value };
    return { ok: false, error: `${meta.label} option value ${value} is not valid.` };
  }

  const label = String(raw ?? '').trim().toLowerCase();
  const match = options.find(o => o.label.toLowerCase() === label);
  if (match) return { ok: true, key: meta.field, value: match.value };
  return { ok: false, error: `${meta.label} option label "${raw}" is not valid.` };
}

async function buildAllowedPrereqPayload(crmClient, opportunityId, fieldValues = {}) {
  const payload = {};
  for (const [key, raw] of Object.entries(fieldValues || {})) {
    if (raw === undefined || raw === '') continue;
    const meta = MCEM_INPUT_FIELD_ALIASES[key];
    if (!meta) return { ok: false, error: `Unsupported stage prerequisite field "${key}".` };
    if (raw === null && !(meta.type === 'lookup' && meta.field === 'msp_primarycompetitor')) continue;

    if (meta.type === 'lookup') {
      const normalized = await normalizeLookupInput(crmClient, raw, meta, opportunityId);
      if (!normalized.ok) return normalized;
      payload[normalized.key] = normalized.value;
    } else if (meta.type === 'picklist') {
      const normalized = await normalizePicklistInput(crmClient, raw, meta);
      if (!normalized.ok) return normalized;
      payload[normalized.key] = normalized.value;
    } else {
      payload[meta.field] = String(raw);
    }
  }
  return { ok: true, payload };
}

async function saveMcemStageFieldValues(crmClient, opportunityId, fieldValues = {}, captureFunc = null, getActor = null) {
  const normalizedFields = await buildAllowedPrereqPayload(crmClient, opportunityId, fieldValues);
  if (!normalizedFields.ok) return normalizedFields;

  const savedFieldNames = Object.keys(normalizedFields.payload);
  if (!savedFieldNames.length) return { ok: true, savedFieldNames };

  const saveResult = await crmClient.request(`opportunities(${opportunityId})`, {
    method: 'PATCH',
    body: normalizedFields.payload
  });
  if (!saveResult.ok && saveResult.status !== 204) {
    // Capture failed field save (best-effort, never throw)
    if (captureFunc) {
      try {
        captureFunc(
          {
            id: `preflight-save-${opportunityId}`,
            type: 'mcem_stage_preflight',
            entitySet: `opportunities(${opportunityId})`,
            method: 'PATCH',
            payload: normalizedFields.payload,
            beforeState: null,
            description: `Save stage prerequisite field(s) for ${opportunityId}`
          },
          { phase: 'failed', result: { ok: false, status: saveResult.status }, error: saveResult.data?.message || 'Field save failed' },
          getActor?.() || null
        );
      } catch {
        // Never throw from audit capture
      }
    }
    return {
      ok: false,
      error: `Saving stage prerequisite field(s) failed (${saveResult.status}): ${saveResult.data?.message || 'unknown error'}`
    };
  }

  // Capture successful field save (best-effort, never throw)
  if (captureFunc) {
    try {
      captureFunc(
        {
          id: `preflight-save-${opportunityId}`,
          type: 'mcem_stage_preflight',
          entitySet: `opportunities(${opportunityId})`,
          method: 'PATCH',
          payload: normalizedFields.payload,
          beforeState: null,
          description: `Save stage prerequisite field(s) for ${opportunityId}`
        },
        { phase: 'executed', result: { ok: true, status: saveResult.status || 204 } },
        getActor?.() || null
      );
    } catch {
      // Never throw from audit capture
    }
  }

  return { ok: true, savedFieldNames };
}

async function countOpportunityMilestones(crmClient, opportunityId) {
  const result = await crmClient.requestAllPages('msp_engagementmilestones', {
    query: {
      $filter: `_msp_opportunityid_value eq '${opportunityId}'`,
      $select: 'msp_engagementmilestoneid',
      $top: '1'
    },
    maxRecords: 1
  });
  if (!result.ok) return { ok: false, status: result.status, message: result.data?.message || 'Milestone lookup failed' };
  return { ok: true, count: result.data?.value?.length || 0 };
}

async function buildMcemStagePreflight(crmClient, opportunityId, targetStageInput) {
  const targetStage = normalizeMcemStageInput(targetStageInput);
  if (!targetStage) return { ok: false, error: 'Invalid target MCEM stage. Use 1-5 or a stage name such as "Realize Value".' };

  const state = await fetchMcemOpportunityState(crmClient, opportunityId);
  if (!state.ok) return { ok: false, error: `Stage preflight failed (${state.status}): ${state.message}` };

  const currentStage = currentMcemStageFrom(state.opportunity, state.bpfInstance);
  if (!currentStage) return { ok: false, error: 'Unable to determine current MCEM stage from BPF state or opportunity display stage.' };

  if (!state.bpfInstance || !bpfInstanceId(state.bpfInstance)) {
    return {
      ok: true,
      status: 'blocked',
      opportunity: { id: opportunityId, name: state.opportunity.name || null },
      currentStage: { number: currentStage.number, name: currentStage.name },
      targetStage: { number: targetStage.number, name: targetStage.name },
      moves: [],
      blockers: [{ type: 'bpf_instance_missing', message: 'Active MCEM BPF instance was not found for this opportunity.' }],
      canMove: false
    };
  }

  const blockers = [];
  if (targetStage.number < currentStage.number) {
    return {
      ok: true,
      status: 'ready',
      opportunity: { id: opportunityId, name: state.opportunity.name || null },
      bpfInstanceId: state.bpfInstance ? bpfInstanceId(state.bpfInstance) : null,
      currentStage: { number: currentStage.number, name: currentStage.name },
      targetStage: { number: targetStage.number, name: targetStage.name },
      direction: 'backward',
      moves: [{
        from: { number: currentStage.number, name: currentStage.name },
        to: { number: targetStage.number, name: targetStage.name },
        ready: true,
        direction: 'backward',
        autoFillChecklistSilently: false,
        internalAutoFillFieldCount: 0,
        opportunityPayload: {},
        targetStageId: targetStage.id
      }],
      blockers,
      canMove: true,
      note: 'Backward MCEM stage movement updates the active BPF stage only; forward-stage prerequisites are not blocking when regressing to an earlier stage.'
    };
  }


  const moves = [];
  const lookupContext = {
    opportunityId,
    accountId: state.opportunity?._parentaccountid_value ? normalizeGuid(state.opportunity._parentaccountid_value) : null,
    accountName: fv(state.opportunity, '_parentaccountid_value') || null
  };

  for (let stageNumber = currentStage.number; stageNumber < targetStage.number; stageNumber += 1) {
    const from = MCEM_STAGE_BY_NUMBER[stageNumber];
    const to = MCEM_STAGE_BY_NUMBER[stageNumber + 1];
    const missing = [];

    for (const blocker of from.blockers || []) {
      if (!hasValue(state.opportunity, blockerReadField(blocker))) {
        missing.push(blocker.label);
        blockers.push(await enrichMcemBlocker(crmClient, blocker, from, to, lookupContext));
      }
    }

    if (from.milestoneRequiredForNext) {
      const milestoneCheck = await countOpportunityMilestones(crmClient, opportunityId);
      if (!milestoneCheck.ok) {
        blockers.push({
          type: 'milestone_check_failed',
          stage: from.name,
          message: `Could not verify milestone gate (${milestoneCheck.status}): ${milestoneCheck.message}`
        });
      } else if (milestoneCheck.count === 0) {
        blockers.push({
          type: 'milestone_required',
          stage: from.name,
          message: 'At least one milestone is required before moving to Realize Value. Create a milestone through the existing milestone flow, then retry.'
        });
      }
    }

    moves.push({
      from: { number: from.number, name: from.name },
      to: { number: to.number, name: to.name },
      ready: missing.length === 0,
      direction: 'forward',
      autoFillChecklistSilently: true,
      internalAutoFillFieldCount: Object.keys(from.checklist).length,
      opportunityPayload: { ...from.checklist },
      targetStageId: to.id
    });
  }

  return {
    ok: true,
    status: blockers.length ? 'blocked' : (moves.length ? 'ready' : 'already_at_target'),
    opportunity: { id: opportunityId, name: state.opportunity.name || null },
    bpfInstanceId: state.bpfInstance ? bpfInstanceId(state.bpfInstance) : null,
    currentStage: { number: currentStage.number, name: currentStage.name },
    targetStage: { number: targetStage.number, name: targetStage.name },
    direction: targetStage.number > currentStage.number ? 'forward' : 'none',
    moves,
    blockers,
    canMove: blockers.length === 0,
    note: 'BPF checklist fields are auto-filled silently and are intentionally not listed in user-facing blockers.'
  };
}

function splitTraversedPath(existingPath) {
  return String(existingPath || '')
    .split(',')
    .map(p => normalizeGuid(p.trim()))
    .filter(Boolean);
}

function appendTraversedPath(existingPath, nextStageId) {
  const normalizedNext = normalizeGuid(nextStageId);
  const parts = splitTraversedPath(existingPath);
  if (!parts.includes(normalizedNext)) parts.push(normalizedNext);
  return parts.join(',');
}

function truncateTraversedPath(existingPath, targetStageId) {
  const normalizedTarget = normalizeGuid(targetStageId);
  const parts = splitTraversedPath(existingPath);
  const targetIndex = parts.indexOf(normalizedTarget);
  if (targetIndex < 0) {
    return {
      ok: false,
      message: `Cannot move backward because target stage ${normalizedTarget || targetStageId} is not present in the BPF traversed path.`
    };
  }
  return { ok: true, path: parts.slice(0, targetIndex + 1).join(',') };
}

// Dynamics async-processes an MCEM stage transition (checklist rollups + milestone
// recalculations on the parent opportunity — heavier for opps with MANY milestones),
// which keeps churning the opportunity / BPF-instance @odata.etag for a short window
// after each write. A PATCH whose etag was fresh a moment ago can therefore still get
// a 412 stale-conflict even though nothing external changed. Re-read the current etag
// and retry with backoff to ride out the churn. Non-412 failures return immediately —
// they are real errors, not races.
const STAGE_PATCH_CHURN_BACKOFFS_MS = [0, 250, 500, 900, 1400];
export async function patchStageWithChurnRetry(crmClient, path, body, initialEtag, refetchEtag) {
  let etag = initialEtag;
  let last;
  for (let attempt = 0; attempt < STAGE_PATCH_CHURN_BACKOFFS_MS.length; attempt++) {
    const backoff = STAGE_PATCH_CHURN_BACKOFFS_MS[attempt];
    if (backoff) await new Promise(resolve => setTimeout(resolve, backoff));
    last = await crmClient.request(path, { method: 'PATCH', body, etag });
    if (last.ok || last.status === 204) return last;
    if (last.status !== 412) return last; // real error — do not retry
    // 412 stale-conflict: re-read a fresh etag and retry.
    try {
      const fresh = await refetchEtag();
      if (fresh) etag = fresh;
    } catch { /* keep the prior etag; a later attempt may still land */ }
  }
  return last;
}

export async function executeMcemStageTransition(crmClient, op) {
  const opportunityId = op.stagePlan?.opportunityId;
  const steps = op.stagePlan?.steps || [];
  const executedSteps = [];

  for (const step of steps) {
    const state = await fetchMcemOpportunityState(crmClient, opportunityId);
    if (!state.ok) return { ok: false, status: state.status, message: state.message, executedSteps };
    const currentStage = currentMcemStageFrom(state.opportunity, state.bpfInstance);

    // Idempotent: if the opp is ALREADY at this step's target, the move already
    // landed — e.g. a retry after transient etag churn, or a duplicate staged op.
    // Treat it as done instead of raising a false "BPF state changed" error: the
    // record is exactly where the user asked it to be. (This is the "error but the
    // change happened" case.)
    if (currentStage && currentStage.number === step.to.number) {
      executedSteps.push({ from: step.from.name, to: step.to.name, verified: true, alreadyApplied: true });
      continue;
    }

    if (!currentStage || currentStage.number !== step.from.number) {
      return {
        ok: false,
        status: 409,
        message: `BPF state changed before execution. Expected ${step.from.name}, found ${currentStage?.name || 'unknown'}. Re-run preflight.`,
        executedSteps
      };
    }

    if (Object.keys(step.opportunityPayload || {}).length) {
      const patchResult = await patchStageWithChurnRetry(
        crmClient,
        `opportunities(${opportunityId})`,
        step.opportunityPayload,
        state.opportunity?.['@odata.etag'],
        async () => {
          const r = await crmClient.request(`opportunities(${opportunityId})`, { query: { $select: 'opportunityid' } });
          return r.ok ? r.data?.['@odata.etag'] : null;
        }
      );
      if (!patchResult.ok && patchResult.status !== 204) {
        return { ok: false, status: patchResult.status, message: patchResult.data?.message || 'Opportunity prerequisite patch failed', executedSteps };
      }

      const saved = await crmClient.request(`opportunities(${opportunityId})`, {
        query: { $select: 'opportunityid' }
      });
      if (!saved.ok) return { ok: false, status: saved.status, message: saved.data?.message || 'Opportunity save verification failed', executedSteps };
    }

    const latestBpf = await fetchMcemBpfInstance(crmClient, opportunityId);
    if (!latestBpf.ok || !latestBpf.instance) {
      return { ok: false, status: latestBpf.status || 404, message: latestBpf.message || 'BPF instance missing after save', executedSteps };
    }
    const instanceId = bpfInstanceId(latestBpf.instance);
    if (!instanceId) return { ok: false, status: 500, message: 'BPF instance id missing; cannot move stage safely', executedSteps };
    const entitySet = bpfEntitySet(latestBpf.instance);
    if (!entitySet) return { ok: false, status: 404, message: 'BPF entity set could not be discovered; cannot move stage safely', executedSteps };

    const traversedPath = step.direction === 'backward'
      ? truncateTraversedPath(latestBpf.instance.traversedpath, step.targetStageId)
      : { ok: true, path: appendTraversedPath(latestBpf.instance.traversedpath, step.targetStageId) };
    if (!traversedPath.ok) {
      return { ok: false, status: 409, message: traversedPath.message, executedSteps };
    }

    const moveResult = await patchStageWithChurnRetry(
      crmClient,
      `${entitySet}(${instanceId})`,
      {
        'activestageid@odata.bind': `/processstages(${step.targetStageId})`,
        traversedpath: traversedPath.path
      },
      latestBpf.instance?.['@odata.etag'],
      async () => {
        // Re-read the fresh etag directly from the known instance — no re-discovery.
        const r = await crmClient.request(`${entitySet}(${instanceId})`, { query: { $select: 'businessprocessflowinstanceid' }, retries: 2 });
        return r.ok ? r.data?.['@odata.etag'] : null;
      }
    );
    if (!moveResult.ok && moveResult.status !== 204) {
      return { ok: false, status: moveResult.status, message: moveResult.data?.message || 'BPF stage movement failed', executedSteps };
    }

    // Verify with a short read-after-write retry: the BPF PATCH returned success,
    // but under async churn the immediate read-back can briefly lag the committed
    // stage. Re-read the KNOWN instance directly (no re-discovery) a few times.
    let verifiedStageId = null;
    for (let vAttempt = 0; vAttempt < 4; vAttempt++) {
      if (vAttempt) await new Promise(resolve => setTimeout(resolve, 300 * vAttempt));
      const verify = await crmClient.request(`${entitySet}(${instanceId})`, { query: { $select: '_activestageid_value,activestageid' }, retries: 1 });
      verifiedStageId = verify.ok ? bpfStageId(verify.data) : null;
      if (verifiedStageId === step.targetStageId) break;
    }
    if (verifiedStageId !== step.targetStageId) {
      return {
        ok: false,
        status: 409,
        message: `BPF verification failed after moving to ${step.to.name}. Expected ${step.targetStageId}, got ${verifiedStageId || 'unknown'}.`,
        executedSteps
      };
    }

    executedSteps.push({ from: step.from.name, to: step.to.name, verified: true });
  }

  return { ok: true, status: 204, data: { executedSteps } };
}

async function applyTaskFilter(crmClient, milestones, mode) {
  if (!milestones.length) return milestones;
  const msIds = milestones.map(m => m.msp_engagementmilestoneid).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < msIds.length; i += 25) chunks.push(msIds.slice(i, i + 25));
  const taskMatches = new Set();
  for (const chunk of chunks) {
    const tf = chunk.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
    const taskResult = await crmClient.requestAllPages('tasks', {
      query: { $filter: tf, $select: '_regardingobjectid_value' }
    });
    if (taskResult.ok && taskResult.data?.value) {
      for (const t of taskResult.data.value) taskMatches.add(t._regardingobjectid_value);
    }
  }
  if (mode === 'without-tasks') {
    return milestones.filter(m => !taskMatches.has(m.msp_engagementmilestoneid));
  }
  return milestones.filter(m => taskMatches.has(m.msp_engagementmilestoneid));
}

const INLINE_TASK_SELECT = 'activityid,subject,scheduledend,statuscode,statecode,_ownerid_value,description,msp_taskcategory,_regardingobjectid_value';

/** Fetch tasks for a list of milestone IDs and return them as a flat array. */
async function fetchTasksForMilestones(crmClient, msIds) {
  if (!msIds.length) return [];
  const chunks = [];
  for (let i = 0; i < msIds.length; i += 25) chunks.push(msIds.slice(i, i + 25));
  const allTasks = [];
  for (const chunk of chunks) {
    const tf = chunk.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
    const taskResult = await crmClient.requestAllPages('tasks', {
      query: { $filter: tf, $select: INLINE_TASK_SELECT, $orderby: 'createdon desc' }
    });
    if (taskResult.ok && taskResult.data?.value) allTasks.push(...taskResult.data.value);
  }
  return allTasks;
}

/** Batch-fetch tasks and embed them as a `tasks` array on each milestone record. */
async function embedTasksOnMilestones(crmClient, milestones) {
  if (!milestones.length) return milestones;
  const msIds = milestones.map(m => m.msp_engagementmilestoneid).filter(Boolean);
  const allTasks = await fetchTasksForMilestones(crmClient, msIds);
  const byMilestone = {};
  for (const t of allTasks) {
    const msId = t._regardingobjectid_value;
    if (!byMilestone[msId]) byMilestone[msId] = [];
    byMilestone[msId].push(t);
  }
  return milestones.map(m => ({
    ...m,
    tasks: byMilestone[m.msp_engagementmilestoneid] || []
  }));
}

/** Shared pipeline data fetcher for pipeline_health, handoff_check, and stage_map.
 *  Fetches active owned opps + deduplicated milestones (from opps + owned by user).
 *  Returns { myOpps, myOppIds, myOppMap, allMilestones, activeMilestones, allOppMap }.
 */
async function fetchUserPipelineData(crmClient, userId) {
  const oppDateFilter = `msp_estcompletiondate ge ${daysAgo(30)}`;
  const ownedOppResult = await crmClient.requestAllPages('opportunities', {
    query: {
      $filter: `_ownerid_value eq '${userId}' and statecode eq 0 and ${oppDateFilter}`,
      $select: OPP_SELECT,
      $orderby: 'name'
    }
  });
  const myOpps = (ownedOppResult.ok ? ownedOppResult.data?.value : []) || [];
  const myOppIds = myOpps.map(o => o.opportunityid);
  const myOppMap = Object.fromEntries(myOpps.map(o => [o.opportunityid, o]));

  const fetchMsFromOpps = async () => {
    if (!myOppIds.length) return [];
    const chunks = [];
    for (let i = 0; i < myOppIds.length; i += 25) chunks.push(myOppIds.slice(i, i + 25));
    const all = [];
    for (const chunk of chunks) {
      const f = `(${chunk.map(id => `_msp_opportunityid_value eq '${id}'`).join(' or ')})`;
      const r = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: { $filter: f, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
      });
      if (r.ok && r.data?.value) all.push(...r.data.value);
    }
    return all;
  };

  const [msFromOpps, msOwnedByMeResult] = await Promise.all([
    fetchMsFromOpps(),
    crmClient.requestAllPages('msp_engagementmilestones', {
      query: {
        $filter: `_ownerid_value eq '${userId}'`,
        $select: MILESTONE_SELECT,
        $orderby: 'msp_milestonedate'
      }
    })
  ]);
  const msOwnedByMe = (msOwnedByMeResult.ok ? msOwnedByMeResult.data?.value : []) || [];

  const milestoneMap = new Map();
  for (const m of msFromOpps) milestoneMap.set(m.msp_engagementmilestoneid, m);
  for (const m of msOwnedByMe) milestoneMap.set(m.msp_engagementmilestoneid, m);
  const allMilestones = [...milestoneMap.values()];

  // Verify extra opps (milestones owned by userId on other people's opps) are still active
  const extraOppIds = [...new Set(
    allMilestones.map(m => m._msp_opportunityid_value).filter(id => id && !myOppMap[id])
  )];
  const extraOppMap = {};
  if (extraOppIds.length) {
    const chunks = [];
    for (let i = 0; i < extraOppIds.length; i += 25) chunks.push(extraOppIds.slice(i, i + 25));
    for (const chunk of chunks) {
      const f = `(${chunk.map(id => `opportunityid eq '${id}'`).join(' or ')}) and statecode eq 0`;
      const r = await crmClient.requestAllPages('opportunities', {
        query: { $filter: f, $select: OPP_SELECT }
      });
      if (r.ok && r.data?.value) for (const o of r.data.value) extraOppMap[o.opportunityid] = o;
    }
  }

  const allOppMap = { ...myOppMap, ...extraOppMap };
  const activeMilestones = allMilestones.filter(
    m => m._msp_opportunityid_value && allOppMap[m._msp_opportunityid_value]
  );
  return { myOpps, myOppIds, myOppMap, allMilestones, activeMilestones, allOppMap };
}

/**
 * Determine the expected MCEM role group for a milestone given its parent opportunity's stage
 * and the milestone's commitment status.
 * Returns 'ATU' | 'STU' | 'CSU' | null (null = stage unknown, skip).
 */
function expectedRoleForMilestone(stage, committed) {
  if (stage === 1) return 'ATU';
  if (stage === 2 || stage === 3) return committed ? 'CSU' : 'STU';
  if (stage === 4 || stage === 5) return 'CSU';
  return null;
}

/** Format handoff_check result as markdown with CRM deep-links. */
function formatHandoffCheckOutput(violations, warnings, summary) {
  const highViolations = violations.filter(v => v.severity === 'high');
  const mediumViolations = violations.filter(v => v.severity === 'medium');
  const lines = [];

  lines.push('## Handoff Check');
  lines.push('');
  lines.push(
    `**${summary.violations_found} violation${summary.violations_found !== 1 ? 's' : ''}** ` +
    `(${highViolations.length} high, ${mediumViolations.length} medium) · ` +
    `**${summary.warnings} warning${summary.warnings !== 1 ? 's' : ''}** · ` +
    `${summary.total_opps_checked} opp${summary.total_opps_checked !== 1 ? 's' : ''} checked`
  );

  const oppLink = (name, url) => url ? `[${name || 'Unknown'} 🔗](${url})` : (name || 'Unknown');
  const msLink  = (name, url) => url ? `[${name || 'Unknown'} 🔗](${url})` : (name || 'Unknown');

  const renderViolationTable = (vs) => {
    lines.push('');
    lines.push('| Opportunity | Milestone | Stage | Current Owner | Current Role | Expected Role | Scenario |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const v of vs) {
      const stageLabel = `${v.stage}${v.stageName ? ` — ${v.stageName}` : ''}`;
      lines.push(
        `| ${oppLink(v.opportunityName, v.opportunityUrl)} | ${msLink(v.milestoneName, v.milestoneUrl)} | ` +
        `${stageLabel} | ${v.currentOwner || '—'} | ${v.currentRoleGroup || '—'} | ` +
        `${v.expectedRoleGroup || '—'} | ${v.scenario || '—'} |`
      );
    }
  };

  if (highViolations.length > 0) {
    lines.push('');
    lines.push('### 🔴 High Severity Violations');
    renderViolationTable(highViolations);
  }

  if (mediumViolations.length > 0) {
    lines.push('');
    lines.push('### 🟡 Medium Severity Violations');
    renderViolationTable(mediumViolations);
  }

  if (violations.length === 0) {
    lines.push('');
    lines.push('✅ No ownership violations detected.');
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('### ⚠️ Warnings (Role Data Missing)');
    lines.push('');
    lines.push('| Opportunity | Milestone | Note |');
    lines.push('|---|---|---|');
    for (const w of warnings) {
      lines.push(`| ${oppLink(w.opportunityName, w.opportunityUrl)} | ${w.milestoneName || '—'} | ${w.note || '—'} |`);
    }
  }

  return lines.join('\n');
}

/** Format stage_map result as markdown with CRM deep-links. */
function formatStageMapOutput(stages, unknownStageOpps, meta) {
  const lines = [];
  lines.push('## Stage Map');
  lines.push('');

  const coverageParts = [];
  if (meta.stages_with_coverage.length > 0) {
    coverageParts.push(`Coverage: Stages ${meta.stages_with_coverage.join(', ')}`);
  }
  if (meta.stages_without_coverage.length > 0) {
    coverageParts.push(`No coverage: Stages ${meta.stages_without_coverage.join(', ')}`);
  }
  lines.push(
    `**${meta.total_opps} opp${meta.total_opps !== 1 ? 's' : ''}** · ${coverageParts.join(' · ')}`
  );

  for (let s = 1; s <= 5; s++) {
    const sg = stages[String(s)];
    if (!sg) continue;

    lines.push('');
    lines.push(`### Stage ${s} — ${sg.stageName} (Expected: ${sg.expectedRoleGroup})`);

    if (sg.opportunities.length === 0) {
      lines.push('');
      lines.push('_No opportunities in this stage._');
      continue;
    }

    lines.push('');
    lines.push('| Opportunity | Customer | Owner | Role | ⚠️ | Committed | Uncommitted | Total |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const opp of sg.opportunities) {
      const link = opp.recordUrl ? `[${opp.name || 'Unknown'} 🔗](${opp.recordUrl})` : (opp.name || 'Unknown');
      const alert = opp.ownershipAlert ? '⚠️' : '';
      lines.push(
        `| ${link} | ${opp.customer || '—'} | ${opp.owner || '—'} | ${opp.ownerRoleGroup || '—'} | ` +
        `${alert} | ${opp.milestones.committed} | ${opp.milestones.uncommitted} | ${opp.milestones.total} |`
      );
    }
  }

  if (unknownStageOpps && unknownStageOpps.length > 0) {
    lines.push('');
    lines.push('### ❓ Unknown Stage');
    lines.push('');
    lines.push('| Opportunity | Customer | Owner | Role |');
    lines.push('|---|---|---|---|');
    for (const opp of unknownStageOpps) {
      const link = opp.recordUrl ? `[${opp.name || 'Unknown'} 🔗](${opp.recordUrl})` : (opp.name || 'Unknown');
      lines.push(`| ${link} | ${opp.customer || '—'} | ${opp.owner || '—'} | ${opp.ownerRoleGroup || '—'} |`);
    }
  }

  return lines.join('\n');
}



const OPPORTUNITY_TYPE_OPTIONS = [
  { label: 'Billed', value: 606820000 },
  { label: 'Consumption', value: 606820001 }
];

const OPPORTUNITY_SOLUTION_AREA_OPTIONS = [
  { label: 'Cloud and AI Platforms', value: 394380000 },
  { label: 'AI Business Solutions', value: 394380002 },
  { label: 'Security', value: 861980005 },
  { label: 'Microsoft Unified', value: 861980011 },
  { label: 'Windows and Devices', value: 861980012 },
  { label: 'Microsoft Services', value: 861980013 }
];

const OPPORTUNITY_SALES_PLAY_FALLBACK_BY_SOLUTION_AREA = {
  394380000: [
    { label: 'Copilot and Agents at Work - Mainstream', value: 861980097, playId: null, globalSolutionArea: null },
    { label: 'Drive Cloud Success through Unified with Enhanced Solutions - Mainstream', value: 861980087, playId: null, globalSolutionArea: null },
    { label: 'Innovate with Azure AI Apps and Agents - Mainstream', value: 861980098, playId: null, globalSolutionArea: null },
    { label: 'Innovate with Low Code AI and Agents - Mainstream', value: 861980068, playId: null, globalSolutionArea: null },
    { label: 'Migrate and Modernize Your Estate - Mainstream', value: 861980067, playId: null, globalSolutionArea: null },
    { label: 'Modern SecOps with Unified Platform - Mainstream', value: 606820006, playId: null, globalSolutionArea: null },
    { label: 'Protect Cloud AI Platform and Apps - Mainstream', value: 861980101, playId: null, globalSolutionArea: null },
    { label: 'Scale with Cloud and AI Endpoints - Mainstream', value: 861980056, playId: null, globalSolutionArea: null },
    { label: 'Unify Your Data Platform - Mainstream', value: 861980038, playId: null, globalSolutionArea: null },
    { label: 'Not Applicable', value: 861980040, playId: null, globalSolutionArea: null }
  ],
  394380002: [
    { label: 'AI Ready with Surface Copilot PCs - Mainstream', value: 861980032, playId: null, globalSolutionArea: null },
    { label: 'Copilot and Agents at Work - Mainstream', value: 861980097, playId: null, globalSolutionArea: null },
    { label: 'Data Security - Mainstream', value: 861980027, playId: null, globalSolutionArea: null },
    { label: 'Drive Cloud Success through Unified with Enhanced Solutions - Mainstream', value: 861980087, playId: null, globalSolutionArea: null },
    { label: 'ERP Transformation with AI - Mainstream', value: 861980026, playId: null, globalSolutionArea: null },
    { label: 'Innovate with Low Code AI and Agents - Mainstream', value: 861980068, playId: null, globalSolutionArea: null },
    { label: 'Sales Transformation with AI - Mainstream', value: 861980020, playId: null, globalSolutionArea: null },
    { label: 'Scale with Cloud and AI Endpoints - Mainstream', value: 861980056, playId: null, globalSolutionArea: null },
    { label: 'Secure AI Productivity - Mainstream', value: 861980030, playId: null, globalSolutionArea: null },
    { label: 'Service Transformation with AI - Mainstream', value: 861980024, playId: null, globalSolutionArea: null },
    { label: 'Converged Communications - Specialized', value: 861980055, playId: null, globalSolutionArea: null },
    { label: 'Not Applicable', value: 861980040, playId: null, globalSolutionArea: null }
  ],
  861980005: [
    { label: 'Copilot and Agents at Work - Mainstream', value: 861980097, playId: null, globalSolutionArea: null },
    { label: 'Data Security - Mainstream', value: 861980027, playId: null, globalSolutionArea: null },
    { label: 'Drive Cloud Success through Unified with Enhanced Solutions - Mainstream', value: 861980087, playId: null, globalSolutionArea: null },
    { label: 'Migrate and Modernize Your Estate - Mainstream', value: 861980067, playId: null, globalSolutionArea: null },
    { label: 'Modern SecOps with Unified Platform - Mainstream', value: 606820006, playId: null, globalSolutionArea: null },
    { label: 'Protect Cloud AI Platform and Apps - Mainstream', value: 861980101, playId: null, globalSolutionArea: null },
    { label: 'Secure AI Productivity - Mainstream', value: 861980030, playId: null, globalSolutionArea: null },
    { label: 'Unify Your Data Platform - Mainstream', value: 861980038, playId: null, globalSolutionArea: null },
    { label: 'Converged Communications - Specialized', value: 861980055, playId: null, globalSolutionArea: null },
    { label: 'Not Applicable', value: 861980040, playId: null, globalSolutionArea: null }
  ],
  861980011: [
    { label: 'Drive Cloud Success through Unified with Enhanced Solutions - Mainstream', value: 861980087, playId: null, globalSolutionArea: null },
    { label: 'Not Applicable', value: 861980040, playId: null, globalSolutionArea: null }
  ],
  861980012: [ { label: 'Not Applicable', value: 861980040, playId: null, globalSolutionArea: null } ],
  861980013: [ { label: 'Not Applicable', value: 861980040, playId: null, globalSolutionArea: null } ]
};

let solutionSalesPlayCache = null;
const SOLUTION_SALES_PLAY_CACHE_MS = 5 * 60 * 1000;
export function resetSolutionSalesPlayCache() { solutionSalesPlayCache = null; }

const CREATION_LOOKUP_META = {
  account: { entitySet: 'accounts', idField: 'accountid', labelField: 'name', bind: 'parentaccountid@odata.bind', target: 'account' },
  currency: { entitySet: 'transactioncurrencies', idField: 'transactioncurrencyid', labelField: 'currencyname', bind: 'transactioncurrencyid@odata.bind', target: 'transactioncurrency' },
  transactioncurrency: { entitySet: 'transactioncurrencies', idField: 'transactioncurrencyid', labelField: 'currencyname', bind: 'transactioncurrencyid@odata.bind', target: 'transactioncurrency' },
  transactioncurrencyid: { entitySet: 'transactioncurrencies', idField: 'transactioncurrencyid', labelField: 'currencyname', bind: 'transactioncurrencyid@odata.bind', target: 'transactioncurrency' },
  systemuser: { entitySet: 'systemusers', idField: 'systemuserid', labelField: 'fullname', bind: 'ownerid@odata.bind', target: 'systemuser' },
  owner: { entitySet: 'systemusers', idField: 'systemuserid', labelField: 'fullname', bind: 'ownerid@odata.bind', target: 'systemuser' },
  workload: { entitySet: 'msp_workloads', idField: 'msp_workloadid', labelField: 'msp_name', bind: 'msp_WorkloadlkId@odata.bind', target: 'msp_workload' },
  msp_workload: { entitySet: 'msp_workloads', idField: 'msp_workloadid', labelField: 'msp_name', bind: 'msp_WorkloadlkId@odata.bind', target: 'msp_workload' },
  msdyn_workload: { entitySet: 'msp_workloads', idField: 'msp_workloadid', labelField: 'msp_name', bind: 'msp_WorkloadlkId@odata.bind', target: 'msp_workload' },
  msp_workloadlk: { entitySet: 'msp_workloads', idField: 'msp_workloadid', labelField: 'msp_name', bind: 'msp_WorkloadlkId@odata.bind', target: 'msp_workload' },
  msp_workloadlkid: { entitySet: 'msp_workloads', idField: 'msp_workloadid', labelField: 'msp_name', bind: 'msp_WorkloadlkId@odata.bind', target: 'msp_workload' },
  opportunity: { entitySet: 'opportunities', idField: 'opportunityid', labelField: 'name', bind: 'msp_OpportunityId@odata.bind', target: 'opportunity' },
  contact: { entitySet: 'contacts', idField: 'contactid', labelField: 'fullname', bind: 'parentcontactid@odata.bind', target: 'contact' },
  competitor: { entitySet: 'competitors', idField: 'competitorid', labelField: 'name', bind: 'msp_PrimaryCompetitor@odata.bind', target: 'competitor' },
  licensingprogram: { entitySet: 'msp_licensingprograms', idField: 'msp_licensingprogramid', labelField: 'msp_name', bind: 'msp_licensingprogram@odata.bind', target: 'msp_licensingprogram' }
};

function normalizeCreationLookup(raw, fallbackEntitySet) {
  const selection = extractLookupSelection(raw);
  return { id: selection.id, entitySet: selection.entitySet || fallbackEntitySet, isNullSelection: selection.isNullSelection };
}

function normalizeDateOnly(value, fieldName) {
  const normalized = toIsoDate(value);
  if (!normalized) return { ok: false, error: `${fieldName} must be a valid YYYY-MM-DD date.` };
  return { ok: true, value: normalized };
}

function normalizeNumericOption(raw, options, fieldName) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: false, error: `${fieldName} is required.` };
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return { ok: false, error: `${fieldName} is required.` };
  if (options?.length && !options.some(o => o.value === value)) return { ok: false, error: `${fieldName} option ${value} is not supported.` };
  return { ok: true, value };
}

function normalizeMultiSelect(raw, options, fieldName) {
  const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (!values.length) return { ok: false, error: `${fieldName} is required.` };
  const normalized = [];
  for (const item of values) {
    const parsed = normalizeNumericOption(item, options, fieldName);
    if (!parsed.ok) return parsed;
    normalized.push(parsed.value);
  }
  return { ok: true, value: normalized.join(',') };
}

async function ensureExistingRecord(crmClient, entitySet, id, select, label) {
  const normalized = normalizeGuid(id);
  if (!isValidGuid(normalized)) return { ok: false, error: `Invalid ${label || entitySet} GUID.` };
  const result = await crmClient.request(`${entitySet}(${normalized})`, { query: { $select: select } });
  if (!result.ok) return { ok: false, error: `${label || entitySet} not found or inaccessible (${result.status}): ${result.data?.message || 'not found'}` };
  return { ok: true, id: normalized, record: result.data };
}

async function resolveOwnerForCreate(crmClient, ownerInput) {
  if (ownerInput) {
    const normalized = normalizeCreationLookup(ownerInput, 'systemusers');
    return ensureExistingRecord(crmClient, 'systemusers', normalized.id, 'systemuserid,fullname,internalemailaddress,msp_rolegroup,msp_role,msp_roleidentity,msp_rolesummary', 'Owner');
  }
  const who = await crmClient.request('WhoAmI');
  if (!who.ok) return { ok: false, error: `Could not resolve current CRM user (${who.status}): ${who.data?.message || 'WhoAmI failed'}` };
  return ensureExistingRecord(crmClient, 'systemusers', who.data?.UserId, 'systemuserid,fullname,internalemailaddress,msp_rolegroup,msp_role,msp_roleidentity,msp_rolesummary', 'Current user');
}

function buildOwnerRoleInfo(ownerRecord) {
  const roleGroup = ownerRecord?.msp_rolegroup || null;
  const normalized = roleGroup ? String(roleGroup).toUpperCase() : null;
  return {
    ownerRoleGroup: normalized || 'unknown',
    ownerIsAtu: normalized === 'ATU',
    ownerRoleUnknown: !normalized,
    owner: ownerRecord ? {
      id: ownerRecord.systemuserid || ownerRecord.ownerid || null,
      name: ownerRecord.fullname || null,
      email: ownerRecord.internalemailaddress || null,
      roleGroup: normalized || null,
      role: ownerRecord.msp_role || null,
      roleIdentity: ownerRecord.msp_roleidentity || null,
      roleSummary: ownerRecord.msp_rolesummary || null
    } : null
  };
}

function createdIdFromResult(result, idField) {
  const data = result?.data || {};
  const direct = data[idField] || data.id || data[`${idField}`];
  if (direct && isValidGuid(normalizeGuid(direct))) return normalizeGuid(direct);
  const entityId = data['@odata.id'] || data['@odata.editLink'] || result?.entityId || result?.headers?.['odata-entityid'] || result?.headers?.['OData-EntityId'];
  const match = String(entityId || '').match(/\(([0-9a-fA-F-]{36})\)/);
  return match ? normalizeGuid(match[1]) : null;
}

function formatLookupOption(meta, record, secondaryText) {
  const id = normalizeGuid(record[meta.idField]);
  const label = record[meta.labelField] || record.name || record.fullname || id;
  return { id, value: `/${meta.entitySet}(${id})`, entitySet: meta.entitySet, entityType: meta.target, label, secondaryText: secondaryText || null, bind: meta.bind };
}

function canonicalCreationEntity(entity) {
  const key = String(entity || '').toLowerCase();
  if (['transactioncurrency', 'transactioncurrencyid'].includes(key)) return 'currency';
  if (['msp_workload', 'msdyn_workload', 'msp_workloadlk', 'msp_workloadlkid'].includes(key)) return 'workload';
  return key;
}

function creationLookupFilter(entity, term, context = {}) {
  entity = canonicalCreationEntity(entity);
  const q = sanitizeODataString(String(term || '').trim());
  const has = q.length > 0;
  if (entity === 'account') return has ? `contains(name,'${q}')` : 'statecode eq 0';
  if (entity === 'currency') return has ? `(contains(currencyname,'${q}') or isocurrencycode eq '${q.toUpperCase()}')` : "isocurrencycode eq 'EUR'";
  if (entity === 'systemuser' || entity === 'owner') return has ? `(contains(fullname,'${q}') or contains(internalemailaddress,'${q}')) and isdisabled eq false` : 'isdisabled eq false';
  if (entity === 'workload') return has ? `contains(msp_name,'${q}')` : 'statecode eq 0';
  if (entity === 'opportunity') return has ? `contains(name,'${q}') and statecode eq 0` : 'statecode eq 0';
  if (entity === 'contact') { const accountId = normalizeGuid(context.accountId || ''); const base = has ? `contains(fullname,'${q}')` : 'statecode eq 0'; return isValidGuid(accountId) ? `${base} and _parentcustomerid_value eq '${accountId}'` : base; }
  if (entity === 'competitor') return has ? `contains(name,'${q}')` : 'statecode eq 0';
  if (entity === 'licensingprogram') return has ? `contains(msp_name,'${q}')` : 'statecode eq 0';
  return null;
}



function normalizeLookupSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/gi, 'n') // spanish-ok: ñ is a regex pattern char in normalizeLookupSearchText, not user-facing text
    .toLowerCase()
    .trim();
}

function matchesNormalizedTerm(record, fields, term) {
  const normalizedTerm = normalizeLookupSearchText(term);
  if (!normalizedTerm) return true;
  const haystack = normalizeLookupSearchText(fields.map(field => record[field] || record[`${field}@OData.Community.Display.V1.FormattedValue`] || '').join(' '));
  return normalizedTerm.split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
}

function pageLookupItems(items, { limit = 20, skip = 0 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const offset = Math.max(Number(skip) || 0, 0);
  const page = items.slice(offset, offset + capped);
  return { page, capped, offset, hasMore: items.length > offset + capped };
}

async function fetchDefaultCurrency(crmClient) {
  const result = await crmClient.requestAllPages('transactioncurrencies', {
    query: { $filter: "isocurrencycode eq 'EUR'", $select: 'transactioncurrencyid,currencyname,isocurrencycode,currencysymbol', $top: '1' },
    maxRecords: 1
  });
  const record = result.ok ? result.data?.value?.[0] : null;
  return record ? { ok: true, id: normalizeGuid(record.transactioncurrencyid), record } : { ok: false, error: 'EUR currency not found.' };
}

async function fetchAccountsByODataStartswith(crmClient, { term = '', limit = 20, skip = 0 } = {}) {
  const safe = sanitizeODataString(term, { maxLength: 100 });
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const offset = Math.max(Number(skip) || 0, 0);
  const result = await crmClient.requestAllPages('accounts', {
    query: {
      $filter: `startswith(name,'${safe}')`,
      $select: 'accountid,name',
      $top: String(capped + offset + 1)
    },
    maxRecords: capped + offset + 1
  });
  if (!result.ok) return { ok: false, entity: 'account', error: `Account search failed (${result.status})` };
  const all = result.data?.value || [];
  const page = all.slice(offset, offset + capped);
  const hasMore = all.length > offset + capped;
  const options = page.map(r => ({
    id: normalizeGuid(r.accountid),
    value: `/accounts(${normalizeGuid(r.accountid)})`,
    entitySet: 'accounts',
    entityType: 'account',
    label: r.name || r.accountid,
    bind: 'parentaccountid@odata.bind'
  }));
  return {
    ok: true,
    entity: 'account',
    scope: 'odata-fallback',
    degraded: true,
    hint: 'Dataverse Search unavailable — showing prefix matches only.',
    options,
    hasMore,
    nextPage: hasMore ? { skip: offset + capped, limit: capped } : null
  };
}

async function fetchUserScopedAccountOptions(crmClient, { term = '', limit = 20, skip = 0 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const offset = Math.max(Number(skip) || 0, 0);

  // 3-char gate — avoid expensive searches on partial input
  if (!term || term.length < 3) {
    return { ok: true, entity: 'account', scope: 'dataverse-search', options: [], hasMore: false, hint: 'Type 3+ characters to search' };
  }

  const safe = sanitizeODataString(term, { maxLength: 100 });

  // Primary: Dataverse Search Suggest
  try {
    const searchResult = await crmClient.search('suggest', {
      search: safe, entities: ['account'], top: capped + offset, filter: 'statecode eq 0'
    });
    if (searchResult.ok && Array.isArray(searchResult.data?.value)) {
      const docs = searchResult.data.value;
      const sliced = docs.slice(offset, offset + capped);
      const hasMore = docs.length > offset + capped;
      const options = sliced.map(item => {
        const doc = item.document || {};
        const id = normalizeGuid(doc['@search.objectid'] || '');
        return {
          id,
          value: `/accounts(${id})`,
          entitySet: 'accounts',
          entityType: 'account',
          label: doc.name || id,
          bind: 'parentaccountid@odata.bind'
        };
      });
      return { ok: true, entity: 'account', scope: 'dataverse-search', options, hasMore, nextPage: hasMore ? { skip: offset + capped, limit: capped } : null };
    }
    // ok but unexpected shape — fall through to OData fallback
    throw new Error('Unexpected search response shape');
  } catch (err) {
    console.warn('[account-search] suggest failed, falling back to OData:', err?.message);
    // Fallback: OData startswith (degraded path)
    return fetchAccountsByODataStartswith(crmClient, { term, limit, skip });
  }
}

async function searchCreationLookupOptions(crmClient, { entity, term = '', context = {}, limit = 20, skip = 0 }) {
  const key = canonicalCreationEntity(entity);
  if (key === 'account') return fetchUserScopedAccountOptions(crmClient, { term, limit, skip });
  const meta = CREATION_LOOKUP_META[key];
  if (!meta) return { ok: false, error: `Unsupported lookup entity "${entity}".` };
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const offset = Math.max(Number(skip) || 0, 0);
  const filter = creationLookupFilter(key, term, context || {});
  const selectExtras = { account: ',accountnumber', currency: ',isocurrencycode,currencysymbol', systemuser: ',internalemailaddress,domainname,msp_rolegroup,msp_role,msp_roleidentity,msp_rolesummary', owner: ',internalemailaddress,domainname,msp_rolegroup,msp_role,msp_roleidentity,msp_rolesummary', opportunity: ',_parentaccountid_value', contact: ',emailaddress1,_parentcustomerid_value', workload: '', competitor: '', licensingprogram: '' };
  let result = await crmClient.requestAllPages(meta.entitySet, { query: { $filter: filter, $select: `${meta.idField},${meta.labelField}${selectExtras[key] || ''}`, $orderby: meta.labelField, $top: String(capped + offset + 1) }, maxRecords: capped + offset + 1 });
  if (!result.ok) return { ok: false, error: `Lookup search failed (${result.status}): ${result.data?.message || 'CRM error'}` };
  let records = result.data?.value || [];
  if ((key === 'systemuser' || key === 'owner') && term && !records.some(record => matchesNormalizedTerm(record, ['fullname', 'internalemailaddress', 'domainname'], term))) {
    const tokens = normalizeLookupSearchText(term).split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const safeToken = sanitizeODataString(token);
      if (!safeToken) continue;
      const broad = await crmClient.requestAllPages(meta.entitySet, {
        query: { $filter: `(contains(fullname,'${safeToken}') or contains(internalemailaddress,'${safeToken}') or contains(domainname,'${safeToken}')) and isdisabled eq false`, $select: `${meta.idField},${meta.labelField}${selectExtras[key] || ''}`, $orderby: meta.labelField, $top: '100' },
        maxRecords: 100
      });
      if (broad.ok && (broad.data?.value || []).some(record => matchesNormalizedTerm(record, ['fullname', 'internalemailaddress', 'domainname'], term))) {
        records = broad.data?.value || [];
        break;
      }
    }
  }
  if (key === 'systemuser' || key === 'owner') records = records.filter(record => matchesNormalizedTerm(record, ['fullname', 'internalemailaddress', 'domainname'], term));
  const { page, capped: pageLimit, offset: pageOffset, hasMore } = pageLookupItems(records, { limit, skip });
  const options = page.map(record => formatLookupOption(meta, record, record.accountnumber || record.isocurrencycode || record.internalemailaddress || record.emailaddress1 || fv(record, '_parentaccountid_value') || fv(record, '_parentcustomerid_value') || null));
  return { ok: true, entity: key, options, hasMore, nextPage: hasMore ? { skip: pageOffset + pageLimit, limit: pageLimit } : null };
}

async function getSolutionAreaSalesPlayMap(crmClient, accountId) {
  const now = Date.now();
  if (!accountId && solutionSalesPlayCache && now - solutionSalesPlayCache.fetchedAtMs < SOLUTION_SALES_PLAY_CACHE_MS) return solutionSalesPlayCache.value;
  const fallbackMap = Object.fromEntries(Object.entries(OPPORTUNITY_SALES_PLAY_FALLBACK_BY_SOLUTION_AREA).map(([value, options]) => [value, options]));
  try {
    // 60s timeout (vs the 20s default): these are 3 large (≤2000-row) reads; a cold fetch already
    // runs ~18s, so any MCAPS load spike would hit the 20s abort and fall back to the playId-less
    // fixture map below — which then makes multi-play CREATE fail with an opaque blocker.
    const mapTimeout = 60000;
    const [mapping, books, extensions] = await Promise.all([
      crmClient.requestAllPages('msp_salesplaymappings', { query: { $filter: 'statecode eq 0 and statuscode eq 1', $select: '_msp_salesplayid_value,msp_salesplayoptionset,msp_opportunitysolutionarea,msp_solutionareaglobal' }, maxRecords: 2000, timeoutMs: mapTimeout }),
      crmClient.requestAllPages('msp_accountplansalesplaybooks', { query: { $filter: 'statecode eq 0 and statuscode eq 1', $select: 'msp_name,msp_accountplansalesplaybookid,msp_solutionarea,msp_globalsolutionarea' }, maxRecords: 2000, timeoutMs: mapTimeout }),
      crmClient.requestAllPages('msp_solutionplayextensions', { query: { $filter: 'statecode eq 0 and statuscode eq 1', $select: 'msp_priorityplay,msp_subsegment,msp_area,_msp_solutionplaybook_value' }, maxRecords: 2000, timeoutMs: mapTimeout })
    ]);
    if (!mapping.ok || !books.ok || !extensions.ok) throw new Error('One or more mapping queries failed');
    const mappings = mapping.data?.value || [];
    const bookById = new Map((books.data?.value || []).map(b => [normalizeGuid(b.msp_accountplansalesplaybookid), b]));
    let accountSubSegment = null; let accountArea = null;
    if (accountId && isValidGuid(normalizeGuid(accountId))) {
      const acct = await crmClient.request(`accounts(${normalizeGuid(accountId)})`, { query: { $select: 'msp_endcustomersubsegmentcode', $expand: 'territoryid($select=msp_salesgeographyarea)' } });
      if (acct.ok) { accountSubSegment = acct.data?.msp_endcustomersubsegmentcode ? String(acct.data.msp_endcustomersubsegmentcode) : null; accountArea = acct.data?.territoryid?.msp_salesgeographyarea || null; }
    }
    const rows = [];
    for (const ext of extensions.data?.value || []) {
      if (accountSubSegment && ext.msp_subsegment && !String(ext.msp_subsegment).includes(accountSubSegment)) continue;
      if (accountArea && ext.msp_area) { const areaText = String(ext.msp_area).toLowerCase(); if (!areaText.includes(String(accountArea).toLowerCase()) && !areaText.includes('global')) continue; }
      const book = bookById.get(normalizeGuid(ext._msp_solutionplaybook_value));
      if (!book) continue;
      for (const m of mappings.filter(m => normalizeGuid(m._msp_salesplayid_value) === normalizeGuid(book.msp_accountplansalesplaybookid))) rows.push({ ...ext, ...book, ...m });
    }
    if (!rows.length) return { ok: true, mappingSource: 'fixture', mappingWarning: 'No Dataverse mapping rows matched; using fixture fallback.', lastFetchedAt: new Date().toISOString(), map: fallbackMap };
    const grouped = new Map();
    for (const row of rows) {
      const solutionValue = row.msp_opportunitysolutionarea; const salesValue = row.msp_salesplayoptionset;
      if (solutionValue == null || salesValue == null || salesValue === 861980040) continue;
      const solutionLabel = fv(row, 'msp_opportunitysolutionarea') || fv(row, 'msp_solutionareaglobal') || OPPORTUNITY_SOLUTION_AREA_OPTIONS.find(o => o.value === solutionValue)?.label || String(solutionValue);
      if (!grouped.has(solutionValue)) grouped.set(solutionValue, { solutionArea: { label: solutionLabel, value: solutionValue }, salesPlays: [] });
      const salesPlays = grouped.get(solutionValue).salesPlays;
      if (!salesPlays.some(o => o.value === salesValue)) salesPlays.push({ label: row.msp_name || String(salesValue), value: salesValue, playId: row.msp_accountplansalesplaybookid || null, globalSolutionArea: row.msp_globalsolutionarea ?? null, priorityPlay: row.msp_priorityplay ?? null });
    }
    for (const group of grouped.values()) { if (!group.salesPlays.some(o => o.value === 861980040)) group.salesPlays.push({ label: 'Not Applicable', value: 861980040 }); group.salesPlays.sort((a, b) => String(a.label).localeCompare(String(b.label))); }
    const mapped = Object.fromEntries([...grouped.entries()].map(([code, group]) => [String(code), group.salesPlays]));
    const value = { ok: true, mappingSource: 'dataverse', mappingWarning: null, lastFetchedAt: new Date().toISOString(), map: mapped };
    if (!accountId) solutionSalesPlayCache = { fetchedAtMs: now, value };
    return value;
  } catch (err) { return { ok: true, mappingSource: 'fixture', mappingWarning: err.message, lastFetchedAt: new Date().toISOString(), map: fallbackMap }; }
}

async function findOpportunityDuplicates(crmClient, { accountId, name }) {
  if (!accountId || !name) return [];
  const filter = `_parentaccountid_value eq '${accountId}' and statecode eq 0 and name eq '${sanitizeODataString(name)}'`;
  const result = await crmClient.requestAllPages('opportunities', { query: { $filter: filter, $select: 'opportunityid,name,_parentaccountid_value,_ownerid_value,msp_activesalesstage,createdon', $top: '10' }, maxRecords: 10 });
  return result.ok ? (result.data?.value || []).map(o => ({ id: o.opportunityid, name: o.name, accountId: o._parentaccountid_value || null, accountName: fv(o, '_parentaccountid_value'), stage: o.msp_activesalesstage || null, ownerName: fv(o, '_ownerid_value'), recordUrl: buildRecordUrl(crmClient.getCrmUrl?.(), 'opportunity', o.opportunityid) })) : [];
}

async function findMilestoneDuplicates(crmClient, { opportunityId, name }) {
  if (!opportunityId || !name) return [];
  const filter = `_msp_opportunityid_value eq '${opportunityId}' and statecode eq 0 and msp_name eq '${sanitizeODataString(name)}'`;
  const result = await crmClient.requestAllPages('msp_engagementmilestones', { query: { $filter: filter, $select: 'msp_engagementmilestoneid,msp_name,msp_milestonedate,_msp_opportunityid_value,_ownerid_value', $top: '10' }, maxRecords: 10 });
  return result.ok ? (result.data?.value || []).map(m => ({ id: m.msp_engagementmilestoneid, name: m.msp_name, accountName: null, stage: null, ownerName: fv(m, '_ownerid_value'), milestoneDate: m.msp_milestonedate || null, recordUrl: buildRecordUrl(crmClient.getCrmUrl?.(), 'msp_engagementmilestone', m.msp_engagementmilestoneid) })) : [];
}

// ── Milestones staged with a staged opportunity (Batch Mode) ──────────────────
// Batch Mode stages a new opportunity and its milestones together. The milestones wait for the
// opportunity op (approval-queue dependsOn): until it runs there is no record to link them to,
// so its staged create stands in for it, and execute binds the new id before they run.

/** The staged create_opportunity `parentOperationId` names, plus the milestones already staged after it. */
function resolveStagedParentOpportunity(queue, parentOperationId) {
  const id = String(parentOperationId || '').trim();
  const parentOp = id ? queue.get(id) : null;
  if (!parentOp || parentOp.type !== 'create_opportunity' || parentOp.status !== 'pending' || parentOp.dependsOn) {
    return { error: `${id || 'parentOperationId'} is not a staged opportunity create waiting in the batch. Stage the opportunity first, or link the milestone to an existing opportunity.` };
  }
  const siblings = queue.listDependents(parentOp.id)
    .filter(op => op.type === 'create_milestone' && op.status === 'pending')
    .map(op => ({ id: op.id, name: op.payload?.create?.msp_name || '', milestoneDate: op.payload?.create?.msp_milestonedate || null }));
  return { parentOp, siblings };
}

/** The staged parent named by create_milestone(_preflight) params, or null when none is named. */
function stagedParentFromParams(params = {}) {
  const parentOperationId = String(params.parentOperationId || '').trim();
  if (!parentOperationId) return null;
  if (String(params.opportunityId || '').trim()) return { error: 'Pass either opportunityId (an existing opportunity) or parentOperationId (an opportunity staged in this batch), not both.' };
  return resolveStagedParentOpportunity(getApprovalQueue(), parentOperationId);
}

/** Stand-in for ensureExistingRecord: the staged create's name and dates, no id yet. */
function stagedOpportunityCheck(parentOp) {
  const create = parentOp.payload?.create || {};
  const dates = parentOp.payload?.postCreatePatch || {};
  return {
    ok: true,
    id: null,
    record: { name: create.name || null, statecode: 0, msp_eststartdate: dates.msp_eststartdate || null, msp_estcompletiondate: dates.msp_estcompletiondate || null }
  };
}

/** Same-name milestones already staged for the same new opportunity (CRM compares names case-insensitively). */
function stagedMilestoneDuplicates(name, siblings = []) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return [];
  return siblings
    .filter(s => String(s.name || '').trim().toLowerCase() === key)
    .map(s => ({ id: null, operationId: s.id, name: s.name, accountName: null, stage: null, ownerName: null, milestoneDate: s.milestoneDate, recordUrl: null, staged: true }));
}

/**
 * A staged create_opportunity just ran: link the milestones staged with it to the new record and
 * release them to run. Matches creating them one by one afterwards — each re-reads the opportunity,
 * so the parent date patch only fills a date the new record still lacks, and the first milestone
 * to fill it wins. Returns the released op ids.
 */
function bindMilestonesToCreatedOpportunity(queue, parentOp, opportunityId, record = null) {
  const id = normalizeGuid(opportunityId);
  if (!parentOp || !isValidGuid(id)) return [];
  // The verified record when there is one; otherwise the dates the create POST carried.
  const known = record || parentOp.payload?.postCreatePatch || {};
  const datesSet = new Set(['msp_eststartdate', 'msp_estcompletiondate'].filter(key => known[key]));
  return queue.releaseDependents(parentOp.id, (op) => {
    if (op.type !== 'create_milestone') return;
    op.payload.opportunityId = id;
    op.payload.create = { ...op.payload.create, 'msp_OpportunityId@odata.bind': `/opportunities(${id})` };
    const patch = { ...(op.payload.opportunityPatch || {}) };
    for (const key of Object.keys(patch)) {
      if (datesSet.has(key)) delete patch[key];
      else datesSet.add(key);
    }
    op.payload.opportunityPatch = patch;
  }).map(op => op.id);
}

/**
 * PLAY's run order: an op waiting for another queued op (stage's dependsOn) runs right after it,
 * the way the batch drawer lists it, even when something else was staged in between. Everything
 * else keeps its staging order.
 */
function orderDependentsAfterParents(ops) {
  const queued = new Set(ops.map(op => op.id));
  const waitsForQueued = (op) => !!op.dependsOn && queued.has(op.dependsOn);
  const dependents = new Map();
  for (const op of ops.filter(waitsForQueued)) {
    if (!dependents.has(op.dependsOn)) dependents.set(op.dependsOn, []);
    dependents.get(op.dependsOn).push(op);
  }
  const ordered = [];
  const placed = new Set();
  const place = (op) => {
    if (placed.has(op)) return;
    placed.add(op);
    ordered.push(op);
    for (const dep of dependents.get(op.id) || []) place(dep);
  };
  for (const op of ops) if (!waitsForQueued(op)) place(op);
  // Ops waiting on each other (stage() can't create that) would never be placed above.
  for (const op of ops) place(op);
  return ordered;
}


function creationLookupMetadata() {
  return {
    account: { fieldName: 'accountId', label: 'Account', type: 'lookup', required: true, searchEndpoint: '/api/crm-creation-lookup-search', searchMethod: 'POST', entity: 'account' },
    currency: { fieldName: 'currencyId', label: 'Currency', type: 'lookup', required: true, searchEndpoint: '/api/crm-creation-lookup-search', searchMethod: 'POST', entity: 'currency' },
    owner: { fieldName: 'ownerId', label: 'Owner', type: 'lookup', required: false, searchEndpoint: '/api/crm-creation-lookup-search', searchMethod: 'POST', entity: 'systemuser' },
    workload: { fieldName: 'workloadId', label: 'Workload', type: 'lookup', required: true, searchEndpoint: '/api/crm-creation-lookup-search', searchMethod: 'POST', entity: 'workload' },
    opportunity: { fieldName: 'opportunityId', label: 'Opportunity', type: 'lookup', required: true, searchEndpoint: '/api/crm-creation-lookup-search', searchMethod: 'POST', entity: 'opportunity' }
  };
}

function opportunityCreateFields() {
  return [
    { fieldName: 'name', label: 'Title', type: 'text', required: true },
    creationLookupMetadata().account,
    creationLookupMetadata().currency,
    { fieldName: 'opportunityType', label: 'Opportunity Intent', type: 'multiselect', required: true, options: OPPORTUNITY_TYPE_OPTIONS },
    { fieldName: 'plays', label: 'Sales Plays (ordered, first=primary)', type: 'ordered-multiselect', required: true, searchEndpoint: '/api/crm-creation-lookup-search', note: 'Each play creates an msp_salesplaychecklists row. Primary SA is derived from plays[0].globalSolutionArea.' },
    { fieldName: 'solutionArea', label: 'Solution Area', type: 'optionset', required: false, deprecated: true, note: 'Deprecated — use plays array instead. Kept for backward compatibility.', options: OPPORTUNITY_SOLUTION_AREA_OPTIONS },
    { fieldName: 'salesPlay', label: 'Sales Play', type: 'optionset', required: false, deprecated: true, note: 'Deprecated — use plays array instead. Kept for backward compatibility.', dependsOn: 'solutionArea', searchEndpoint: '/api/crm-creation-lookup-search', searchMethod: 'POST' },
    { fieldName: 'description', label: 'Customer Need', type: 'textarea', required: false },
    { fieldName: 'estimatedStartDate', label: 'Est. Start Date', type: 'date', required: false },
    { fieldName: 'estimatedCompletionDate', label: 'Est. Completion Date', type: 'date', required: false },
    { fieldName: 'ownerMode', label: 'Owner Mode', type: 'choice', required: false, options: [{ label: 'Current user', value: 'currentUser' }, { label: 'Other user', value: 'other' }] },
    creationLookupMetadata().owner
  ];
}

function milestoneCreateFields() {
  return [
    creationLookupMetadata().opportunity,
    { fieldName: 'name', label: 'Milestone Name', type: 'text', required: true },
    { fieldName: 'milestoneDate', label: 'Milestone Date', type: 'date', required: true },
    { fieldName: 'monthlyUse', label: 'Monthly Use', type: 'money', required: true },
    { fieldName: 'milestoneCategory', label: 'Milestone Category', type: 'optionset', required: true, options: MILESTONE_CATEGORIES },
    { fieldName: 'customerCommitment', label: 'Customer Commitment', type: 'optionset', required: true, options: COMMITMENT_RECOMMENDATIONS },
    creationLookupMetadata().workload,
    { fieldName: 'workloadType', label: 'Workload Type', type: 'optionset', required: false, defaultedByBackend: true, options: WORKLOAD_TYPES },
    { fieldName: 'deliveredBy', label: 'Delivered By', type: 'optionset', required: true, options: DELIVERED_BY },
    { fieldName: 'preferredAzureRegion', label: 'Preferred Azure Region', type: 'optionset', required: true },
    { fieldName: 'azureCapacityType', label: 'Azure Capacity Type', type: 'multiselect', required: true },
    { fieldName: 'milestoneStatus', label: 'Milestone Status', type: 'optionset', required: true, options: MILESTONE_STATUSES },
    { fieldName: 'milestoneStatusReason', label: 'Milestone Status Reason', type: 'optionset', required: true, options: MILESTONE_STATUS_REASONS },
    { fieldName: 'milestoneComments', label: 'Risk/Blocker Details', type: 'textarea', required: true },
    { fieldName: 'forecastComments', label: 'Forecast Comments', type: 'textarea', required: false },
    { fieldName: 'ownerMode', label: 'Owner Mode', type: 'choice', required: false, options: [{ label: 'Current user', value: 'currentUser' }, { label: 'Other user', value: 'other' }] },
    creationLookupMetadata().owner,
    creationLookupMetadata().currency
  ];
}

function planWarnings(plan) {
  const warnings = [];
  if (plan.ownerRoleUnknown) warnings.push({ code: 'owner_role_unknown', level: 'warning', message: 'Owner role group is unknown; ATU recommendation cannot be verified.' });
  else if (plan.ownerRoleGroup && plan.ownerRoleGroup !== 'ATU') warnings.push({ code: 'owner_not_atu', level: 'warning', message: 'This opportunity starts in stage 1; you should assign it to someone in ATU.' });
  if (plan.duplicates?.length) warnings.push({ code: 'duplicates', level: 'warning', message: 'Duplicate candidates found. Pass allowDuplicate=true to create anyway.' });
  if (plan.playWarnings?.length) warnings.push(...plan.playWarnings.map(w => ({ ...w, level: 'warning' })));
  return warnings;
}

function toPreflightContract(plan, entity) {
  return {
    ok: true,
    canCreate: Boolean(plan.canCreate),
    fields: entity === 'opportunity' ? opportunityCreateFields() : milestoneCreateFields(),
    lookups: creationLookupMetadata(),
    defaults: entity === 'opportunity'
      ? { ownerMode: 'currentUser', opportunityType: ['606820001'], currency: plan.normalized?.currency ? { id: plan.normalized.currency.transactioncurrencyid, label: plan.normalized.currency.currencyname, isoCode: plan.normalized.currency.isocurrencycode } : null }
      : { ownerMode: 'currentUser', milestoneStatus: 861980000, customerCommitment: 861980000, milestoneStatusReason: null, azureCapacityType: '861980000', currency: plan.normalized?.currency ? { id: plan.normalized.currency.transactioncurrencyid, label: plan.normalized.currency.currencyname, isoCode: plan.normalized.currency.isocurrencycode } : null },
    duplicates: plan.duplicates || [],
    warnings: planWarnings(plan),
    normalizedPayload: plan.normalized?.payloadPreview || {},
    ownerRoleGroup: plan.ownerRoleGroup,
    ownerIsAtu: plan.ownerIsAtu,
    ownerRoleUnknown: plan.ownerRoleUnknown,
    warningLevel: plan.ownerRoleUnknown || (plan.ownerRoleGroup && plan.ownerRoleGroup !== 'ATU') ? 'warning' : 'none',
    warningText: plan.ownerRoleUnknown
      ? 'Owner role group is unknown; ATU recommendation cannot be verified.'
      : (plan.ownerRoleGroup && plan.ownerRoleGroup !== 'ATU' ? 'This opportunity starts in stage 1; you should assign it to someone in ATU.' : null),
    validation: { status: plan.status, blockers: plan.blockers || [] }
  };
}

function semanticLookupId(input, semanticKey, legacyKeys = []) {
  const direct = input[semanticKey];
  if (direct) return direct;
  for (const key of legacyKeys) if (input[key]) return input[key];
  return undefined;
}

async function buildOpportunityCreatePlan(crmClient, input = {}, { allowDuplicate = false } = {}) {
  const blockers = [];
  const name = String(input.name || input.title || '').trim();
  if (!name) blockers.push({ fieldName: 'name', label: 'Title', message: 'Title is required.' });
  const accountRaw = semanticLookupId(input, 'accountId', ['account', 'parentAccountId', 'parentaccountid', 'parentaccountid@odata.bind']);
  const account = normalizeCreationLookup(accountRaw, 'accounts');
  const accountCheck = account.id ? await ensureExistingRecord(crmClient, 'accounts', account.id, 'accountid,name,accountnumber', 'Account') : { ok: false, error: 'Account is required.' };
  if (!accountCheck.ok) blockers.push({ fieldName: 'parentaccountid', label: 'Account', message: accountCheck.error });
  const currencyRaw = semanticLookupId(input, 'currencyId', ['currency', 'transactionCurrencyId', 'transactioncurrencyid', 'transactioncurrencyid@odata.bind']);
  const currency = normalizeCreationLookup(currencyRaw, 'transactioncurrencies');
  const currencyCheck = currency.id
    ? await ensureExistingRecord(crmClient, 'transactioncurrencies', currency.id, 'transactioncurrencyid,currencyname,isocurrencycode', 'Currency')
    : await fetchDefaultCurrency(crmClient);
  if (!currencyCheck.ok) blockers.push({ fieldName: 'transactioncurrencyid', label: 'Currency', message: currencyCheck.error });
  const ownerMode = input.ownerMode || (input.ownerId ? 'other' : 'currentUser');
  const ownerRaw = ownerMode === 'other' ? semanticLookupId(input, 'ownerId', ['owner', 'ownerid', 'ownerid@odata.bind']) : null;
  const ownerCheck = await resolveOwnerForCreate(crmClient, ownerRaw);
  if (!ownerCheck.ok) blockers.push({ fieldName: 'ownerid', label: 'Owner', message: ownerCheck.error });
  const ownerRole = ownerCheck.ok ? buildOwnerRoleInfo(ownerCheck.record) : { ownerRoleGroup: 'unknown', ownerIsAtu: false, ownerRoleUnknown: true, owner: null };
  const opportunityType = normalizeMultiSelect(input.opportunityType ?? input.msp_opportunitytype, OPPORTUNITY_TYPE_OPTIONS, 'Opportunity Intent');
  if (!opportunityType.ok) blockers.push({ fieldName: 'msp_opportunitytype', label: 'Opportunity Intent', message: opportunityType.error });
  // Multi-play path: resolve playValue→{playId,globalSolutionArea} from the unscoped map at preflight
  // time so the universe matches what the modal showed and the cache is reused.
  // Scalar path preserved for backward compatibility when plays is absent/empty.
  const inboundPlays = Array.isArray(input.plays) ? input.plays : [];
  const isMultiPlay = inboundPlays.length > 0;
  let derivedOppSA = null; let derivedSalesPlayValue = null;
  const resolvedPlays = []; const playWarnings = [];
  if (isMultiPlay) {
    const mapResult = await getSolutionAreaSalesPlayMap(crmClient);
    // Fixture fallback = the live sales-play map (with playId GUIDs) was unavailable, usually a
    // transient CRM slow/timeout. Surface a clear, retryable message instead of the opaque
    // "could not be resolved — please reselect" (reselecting would not help in that case).
    const mapUnavailable = mapResult.mappingSource === 'fixture';
    if (mapUnavailable) {
      blockers.push({ fieldName: 'plays', label: 'Sales Plays', message: 'Solution Play data is temporarily unavailable (CRM was slow to respond). Please try Create again in a moment.' });
    }
    const playValueToMeta = {};
    for (const salesPlays of Object.values(mapResult.map || {})) {
      for (const play of salesPlays) {
        if (play.value != null && !(play.value in playValueToMeta)) {
          playValueToMeta[play.value] = { playId: play.playId || null, globalSolutionArea: play.globalSolutionArea ?? null };
        }
      }
    }
    let primaryBlocked = false;
    for (let i = 0; i < inboundPlays.length; i++) {
      const p = inboundPlays[i];
      const meta = playValueToMeta[p.playValue];
      if (!meta || !meta.playId) {
        if (i === 0) {
          if (!mapUnavailable) blockers.push({ fieldName: 'plays', label: 'Sales Plays', message: 'Primary Solution Play could not be resolved — please reselect.' });
          primaryBlocked = true;
          break;
        }
        playWarnings.push({ code: 'unresolvable_play', message: `Play ${p.playValue} could not be resolved and was excluded.` });
        continue;
      }
      resolvedPlays.push({ playValue: p.playValue, playId: meta.playId, globalSolutionArea: meta.globalSolutionArea ?? null, isPrimary: i === 0 });
    }
    if (!primaryBlocked && resolvedPlays.length > 0) {
      const primary = resolvedPlays[0];
      const globalSA = primary.globalSolutionArea;
      derivedOppSA = globalSA != null ? (SOLUTION_AREA_PLAY_TO_OPPORTUNITY[globalSA] ?? globalSA) : null;
      if (derivedOppSA != null && !OPPORTUNITY_SOLUTION_AREA_OPTIONS.some(o => o.value === derivedOppSA)) blockers.push({ fieldName: 'plays', label: 'Sales Plays', message: `Derived solution area ${derivedOppSA} is not in allowed options — possible map mismatch.` });
      derivedSalesPlayValue = Number(primary.playValue);
    }
  } else {
    const solutionArea = normalizeNumericOption(input.solutionArea ?? input.msp_solutionarea, OPPORTUNITY_SOLUTION_AREA_OPTIONS, 'Solution Area');
    if (!solutionArea.ok) blockers.push({ fieldName: 'msp_solutionarea', label: 'Solution Area', message: solutionArea.error });
    else derivedOppSA = solutionArea.value;
    const spv = Number(input.salesPlay ?? input.msp_salesplay);
    if (!Number.isFinite(spv)) blockers.push({ fieldName: 'msp_salesplay', label: 'Sales Play', message: 'Sales Play is required.' });
    else derivedSalesPlayValue = spv;
  }
  const startDateRaw = input.estimatedStartDate ?? input.msp_eststartdate;
  const completionDateRaw = input.estimatedCompletionDate ?? input.msp_estcompletiondate;
  const startDate = startDateRaw ? normalizeDateOnly(startDateRaw, 'estimatedStartDate') : { ok: true, value: null };
  const completionDate = completionDateRaw ? normalizeDateOnly(completionDateRaw, 'estimatedCompletionDate') : { ok: true, value: null };
  if (!startDate.ok) blockers.push({ fieldName: 'msp_eststartdate', label: 'Est. Start Date', message: startDate.error });
  if (!completionDate.ok) blockers.push({ fieldName: 'msp_estcompletiondate', label: 'Est. Completion Date', message: completionDate.error });
  const duplicates = accountCheck.ok && name ? await findOpportunityDuplicates(crmClient, { accountId: accountCheck.id, name }) : [];
  if (duplicates.length && !allowDuplicate) blockers.push({ fieldName: 'duplicates', label: 'Duplicate opportunity', message: 'An open opportunity with this title already exists for the selected account.' });
  const payload = { name, ...(input.description ? { description: String(input.description) } : {}), ...(accountCheck.ok ? { 'parentaccountid@odata.bind': `/accounts(${accountCheck.id})` } : {}), ...(currencyCheck.ok ? { 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${currencyCheck.id})` } : {}), ...(ownerCheck.ok ? { 'ownerid@odata.bind': `/systemusers(${ownerCheck.id})` } : {}), ...(opportunityType.ok ? { msp_opportunitytype: opportunityType.value } : {}),   ...(derivedOppSA != null ? { msp_solutionarea: derivedOppSA } : {}), ...(derivedSalesPlayValue != null ? { msp_salesplay: derivedSalesPlayValue } : {}) };
  const postCreatePatch = { ...(startDate.value ? { msp_eststartdate: startDate.value } : {}), ...(completionDate.value ? { msp_estcompletiondate: completionDate.value } : {}) };
  return { ok: blockers.length === 0, canCreate: blockers.length === 0, status: blockers.length ? (duplicates.length && !allowDuplicate ? 'duplicate_warning' : 'blocked') : 'ready', blockers, duplicates, inputs: [], playWarnings,   normalized: { payloadPreview: payload, postCreatePatch, plays: isMultiPlay ? resolvedPlays : null, account: accountCheck.record || null, currency: currencyCheck.record || null, owner: ownerRole.owner }, ...ownerRole };
}


function deriveMilestoneWorkloadType(workloadRecord) {
  const name = normalizeLookupSearchText(workloadRecord?.msp_name || '');
  if (name.startsWith('mw:') || name.includes('modern work') || name.includes('copilot chat')) return 861980003;
  if (name.startsWith('sec:') || name.includes('security') || name.includes('defender') || name.includes('sentinel')) return 861980002;
  if (name.includes('dynamics')) return 861980001;
  return 861980000;
}

/**
 * `stagedParent` (from stagedParentFromParams) validates a milestone against an opportunity that
 * is staged in the batch but not created yet.
 */
async function buildMilestoneCreatePlan(crmClient, input = {}, { allowDuplicate = false, stagedParent = null } = {}) {
  const blockers = [];
  const name = String(input.name || input.msp_name || '').trim();
  if (!name) blockers.push({ fieldName: 'name', label: 'Milestone name', message: 'Milestone name is required.' });
  const opportunityId = normalizeGuid(input.opportunityId || input.opportunityid || input._msp_opportunityid_value || '');
  let oppCheck;
  if (stagedParent?.error) oppCheck = { ok: false, error: stagedParent.error };
  else if (opportunityId) oppCheck = await ensureExistingRecord(crmClient, 'opportunities', opportunityId, 'opportunityid,name,statecode,msp_eststartdate,msp_estcompletiondate,_transactioncurrencyid_value', 'Opportunity');
  else if (stagedParent?.parentOp) oppCheck = stagedOpportunityCheck(stagedParent.parentOp);
  else oppCheck = { ok: false, error: 'Opportunity is required.' };
  if (!oppCheck.ok) blockers.push({ fieldName: 'opportunityId', label: 'Opportunity', message: oppCheck.error });
  else if (oppCheck.record.statecode !== undefined && oppCheck.record.statecode !== 0) blockers.push({ fieldName: 'opportunityId', label: 'Opportunity', message: 'Opportunity must be open.' });
  const milestoneDate = normalizeDateOnly(input.milestoneDate ?? input.msp_milestonedate, 'milestoneDate');
  if (!milestoneDate.ok) blockers.push({ fieldName: 'milestoneDate', label: 'Milestone Date', message: milestoneDate.error });
  const monthlyUse = Number(input.monthlyUse ?? input.msp_monthlyuse);
  if (!Number.isFinite(monthlyUse)) blockers.push({ fieldName: 'monthlyUse', label: 'Monthly use', message: 'Monthly use is required.' });
  const milestoneCategory = normalizeNumericOption(input.milestoneCategory ?? input.msp_milestonecategory, MILESTONE_CATEGORIES, 'Milestone Category');
  if (!milestoneCategory.ok) blockers.push({ fieldName: 'milestoneCategory', label: 'Milestone Category', message: milestoneCategory.error });
  const customerCommitment = normalizeNumericOption(input.customerCommitment ?? input.commitmentRecommendation ?? input.msp_commitmentrecommendation, COMMITMENT_RECOMMENDATIONS, 'Customer Commitment');
  if (!customerCommitment.ok) blockers.push({ fieldName: 'customerCommitment', label: 'Customer Commitment', message: customerCommitment.error });
  const rawWorkloadType = input.workloadType ?? input.msp_milestoneworkload;
  const workloadType = rawWorkloadType === undefined || rawWorkloadType === null || String(rawWorkloadType).trim() === ''
    ? { ok: true, value: null, defaulted: true }
    : normalizeNumericOption(rawWorkloadType, WORKLOAD_TYPES, 'Workload Type');
  if (!workloadType.ok) blockers.push({ fieldName: 'workloadType', label: 'Workload Type', message: workloadType.error });
  const deliveredBy = normalizeNumericOption(input.deliveredBy ?? input.msp_deliveryspecifiedfield, DELIVERED_BY, 'Delivered By');
  if (!deliveredBy.ok) blockers.push({ fieldName: 'deliveredBy', label: 'Delivered By', message: deliveredBy.error });
  const preferredAzureRegion = normalizeNumericOption(input.preferredAzureRegion ?? input.msp_milestonepreferredazureregion, null, 'Preferred Azure Region');
  if (!preferredAzureRegion.ok) blockers.push({ fieldName: 'preferredAzureRegion', label: 'Preferred Azure Region', message: preferredAzureRegion.error });
  const azureCapacityType = String(input.azureCapacityType ?? input.msp_milestoneazurecapacitytype ?? '').trim();
  if (!azureCapacityType) blockers.push({ fieldName: 'azureCapacityType', label: 'Azure Capacity Type', message: 'Azure Capacity Type is required.' });
  const rawMilestoneStatus = input.milestoneStatus ?? input.msp_milestonestatus ?? 861980000;
  const resolvedMilestoneStatus = resolveOptionValue(MILESTONE_STATUSES, rawMilestoneStatus);
  const milestoneStatus = resolvedMilestoneStatus === undefined
    ? { ok: false, error: `Invalid milestoneStatus "${rawMilestoneStatus}". Valid: ${validOptionsMessage(MILESTONE_STATUSES)}` }
    : { ok: true, value: resolvedMilestoneStatus };
  if (!milestoneStatus.ok) blockers.push({ fieldName: 'milestoneStatus', label: 'Milestone Status', message: milestoneStatus.error });
  const rawStatusReason = input.milestoneStatusReason ?? input.msp_milestonestatusreason;
  let milestoneStatusReason = rawStatusReason === undefined || rawStatusReason === null || rawStatusReason === ''
    ? { ok: true, value: undefined }
    : normalizeNumericOption(rawStatusReason, MILESTONE_STATUS_REASONS, 'Milestone Status Reason');
  if (milestoneStatus.value === BLOCKED_MILESTONE_STATUS && milestoneStatusReason.value === undefined && !hasCapacityAzureCapacityType(input.azureCapacityType ?? input.msp_milestoneazurecapacitytype)) {
    blockers.push({ fieldName: 'milestoneStatusReason', label: 'Milestone Status Reason', message: `milestoneStatusReason is required when milestoneStatus is Blocked. Use Capacity/Service Availability (${CAPACITY_SERVICE_AVAILABILITY_REASON}) for quota/capacity blockers.` });
  }
  if (!milestoneStatusReason.ok) blockers.push({ fieldName: 'milestoneStatusReason', label: 'Milestone Status Reason', message: milestoneStatusReason.error });
  const milestoneComments = String(input.milestoneComments ?? input.msp_milestonecomments ?? input.forecastComments ?? 'Created via MSX-IQ').trim();
  const workloadRaw = semanticLookupId(input, 'workloadId', ['workload', 'msp_WorkloadlkId@odata.bind']);
  const workload = normalizeCreationLookup(workloadRaw, 'msp_workloads');
  const workloadCheck = workload.id ? await ensureExistingRecord(crmClient, 'msp_workloads', workload.id, 'msp_workloadid,msp_name', 'Workload') : { ok: false, error: 'Workload is required.' };
  if (!workloadCheck.ok) blockers.push({ fieldName: 'workloadId', label: 'Workload', message: workloadCheck.error });
  const ownerMode = input.ownerMode || (input.ownerId ? 'other' : null);
  const ownerRaw = ownerMode === 'other' ? semanticLookupId(input, 'ownerId', ['owner', 'ownerid', 'ownerid@odata.bind']) : null;
  const ownerCheck = ownerMode ? await resolveOwnerForCreate(crmClient, ownerRaw) : { ok: true, id: null, record: null };
  if (!ownerCheck.ok) blockers.push({ fieldName: 'ownerId', label: 'Owner', message: ownerCheck.error });
  const currencyRaw = semanticLookupId(input, 'currencyId', ['currency', 'transactionCurrencyId', 'transactioncurrencyid@odata.bind']);
  let currencyCheck;
  if (currencyRaw) {
    const currency = normalizeCreationLookup(currencyRaw, 'transactioncurrencies');
    currencyCheck = await ensureExistingRecord(crmClient, 'transactioncurrencies', currency.id, 'transactioncurrencyid,currencyname,isocurrencycode', 'Currency');
    if (!currencyCheck.ok) blockers.push({ fieldName: 'transactionCurrencyId', label: 'Currency', message: currencyCheck.error });
  } else {
    currencyCheck = await fetchDefaultCurrency(crmClient);
  }
  let duplicates = [];
  if (oppCheck.ok && name) duplicates = oppCheck.id ? await findMilestoneDuplicates(crmClient, { opportunityId: oppCheck.id, name }) : stagedMilestoneDuplicates(name, stagedParent?.siblings);
  if (duplicates.length && !allowDuplicate) blockers.push({ fieldName: 'duplicates', label: 'Duplicate milestone', message: oppCheck.id ? 'A milestone with this name already exists for the selected opportunity.' : 'A milestone with this name is already staged for this opportunity.' });
  const createPayload = { msp_name: name, ...(oppCheck.ok && oppCheck.id ? { 'msp_OpportunityId@odata.bind': `/opportunities(${oppCheck.id})` } : {}), ...(workloadCheck.ok ? { 'msp_WorkloadlkId@odata.bind': `/msp_workloads(${workloadCheck.id})` } : {}), ...(currencyCheck.id ? { 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${currencyCheck.id})` } : {}), ...(ownerCheck.id ? { 'ownerid@odata.bind': `/systemusers(${ownerCheck.id})` } : {}), ...(milestoneDate.ok ? { msp_milestonedate: milestoneDate.value } : {}), ...(Number.isFinite(monthlyUse) ? { msp_monthlyuse: monthlyUse } : {}), ...(milestoneCategory.ok ? { msp_milestonecategory: milestoneCategory.value } : {}), ...(customerCommitment.ok ? { msp_commitmentrecommendation: customerCommitment.value } : {}), ...(workloadType.ok ? { msp_milestoneworkload: workloadType.value ?? deriveMilestoneWorkloadType(workloadCheck.record) } : {}), ...(deliveredBy.ok ? { msp_deliveryspecifiedfield: deliveredBy.value } : {}), ...(preferredAzureRegion.ok ? { msp_milestonepreferredazureregion: preferredAzureRegion.value } : {}), ...(azureCapacityType ? { msp_milestoneazurecapacitytype: azureCapacityType } : {}), ...(milestoneStatus.ok ? { msp_milestonestatus: milestoneStatus.value } : {}), ...(milestoneStatusReason.ok && milestoneStatusReason.value !== undefined ? { msp_milestonestatusreason: milestoneStatusReason.value } : {}), ...(milestoneComments ? { msp_milestonecomments: milestoneComments } : {}), ...(input.forecastComments !== undefined ? { msp_forecastcomments: String(input.forecastComments) } : {}) };
  if (milestoneStatus.ok) {
    const statusReasonError = applyMilestoneStatusReasonFields(createPayload, {
      resolvedStatus: milestoneStatus.value,
      milestoneStatusReason: createPayload.msp_milestonestatusreason,
      azureCapacityType: createPayload.msp_milestoneazurecapacitytype,
      helpNeeded: input.helpNeeded ?? input.msp_helpneeded
    });
    if (statusReasonError) blockers.push({ fieldName: 'milestoneStatusReason', label: 'Milestone Status Reason', message: statusReasonError });
  }
  const opportunityPatch = {};
  const fallbackDate = milestoneDate.ok ? milestoneDate.value : null;
  if (oppCheck.ok && fallbackDate) { if (!oppCheck.record.msp_eststartdate) opportunityPatch.msp_eststartdate = input.opportunityEstimatedStartDate || fallbackDate; if (!oppCheck.record.msp_estcompletiondate) opportunityPatch.msp_estcompletiondate = input.opportunityEstimatedCompletionDate || fallbackDate; }
  return { ok: blockers.length === 0, canCreate: blockers.length === 0, status: blockers.length ? (duplicates.length && !allowDuplicate ? 'duplicate_warning' : 'blocked') : 'ready', blockers, duplicates, inputs: [], normalized: { payloadPreview: createPayload, opportunityPatch, opportunity: oppCheck.record || null, workload: workloadCheck.record || null, owner: ownerCheck.record || null, currency: currencyCheck.record || null }, ...(ownerCheck.record ? buildOwnerRoleInfo(ownerCheck.record) : {}) };
}



async function cancelOpportunityRollback(crmClient, opportunityId, subject = 'Cancelled MSX-IQ mandatory milestone rollback') {
  const payload = {
    OpportunityClose: {
      'opportunityid@odata.bind': `/opportunities(${opportunityId})`,
      subject
    },
    Status: 861980004
  };
  let result = await crmClient.request('LoseOpportunity', { method: 'POST', body: payload });
  const isInvalidStatus = !result.ok && result.status !== 204
    && typeof result.data?.message === 'string'
    && result.data.message.includes('is not a valid status code');
  if (isInvalidStatus) {
    const metaPath = "EntityDefinitions(LogicalName='opportunity')/Attributes(LogicalName='statuscode')" +
      '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)';
    const metaResult = await crmClient.request(metaPath);
    if (metaResult.ok) {
      const options = metaResult.data?.OptionSet?.Options || [];
      const lostCode = options.find(o => o.State === 2)?.Value;
      if (lostCode !== undefined) {
        result = await crmClient.request('LoseOpportunity', { method: 'POST', body: { ...payload, Status: lostCode } });
        if (result.ok || result.status === 204) result._discoveredStatusCode = lostCode;
      }
    }
  }
  if (!result.ok && result.status !== 204) return result;
  const verify = await crmClient.request(`opportunities(${opportunityId})`, {
    query: { $select: 'opportunityid,name,statecode,statuscode,_ownerid_value' }
  });
  if (!verify.ok) return { ok: true, status: 204, data: { opportunityId, canceled: true, verifyWarning: verify.data?.message || 'Could not verify cancelled opportunity' } };
  return { ok: true, status: 200, data: { opportunityId, canceled: true, record: verify.data, discoveredStatusCode: result._discoveredStatusCode } };
}

async function validateOpportunityDeleteRollback(crmClient, opportunityId) {
  const oppNid = normalizeGuid(opportunityId);
  if (!isValidGuid(oppNid)) return { ok: false, error: 'Invalid opportunityId GUID.' };

  const who = await crmClient.request('WhoAmI');
  if (!who.ok || !who.data?.UserId) return { ok: false, error: `Unable to resolve current CRM user (${who.status}): ${who.data?.message || 'WhoAmI failed'}` };
  const currentUserId = normalizeGuid(who.data.UserId);

  const opp = await crmClient.request(`opportunities(${oppNid})`, {
    query: { $select: 'opportunityid,name,_ownerid_value,createdon,statecode' }
  });
  if (!opp.ok) return { ok: false, error: `Opportunity not found or inaccessible (${opp.status}): ${opp.data?.message || 'not found'}` };

  const ownerId = normalizeGuid(opp.data?._ownerid_value || '');
  if (!ownerId || ownerId !== currentUserId) {
    return { ok: false, error: 'Refusing to delete opportunity: it is not owned by the current CRM user.', reason: 'owner_mismatch', opportunity: opp.data };
  }

  const createdAt = opp.data?.createdon ? new Date(opp.data.createdon) : null;
  const maxAgeMs = 4 * 60 * 60 * 1000;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || (Date.now() - createdAt.getTime()) > maxAgeMs) {
    return { ok: false, error: 'Refusing to delete opportunity: it was not recently created by this flow.', reason: 'not_recent', opportunity: opp.data };
  }

  const milestones = await crmClient.requestAllPages('msp_engagementmilestones', {
    query: { $filter: `_msp_opportunityid_value eq '${oppNid}' and statecode eq 0`, $select: 'msp_engagementmilestoneid,msp_name', $top: '1' },
    maxRecords: 1
  });
  if (!milestones.ok) return { ok: false, error: `Could not verify milestone safety (${milestones.status}): ${milestones.data?.message || 'CRM error'}`, reason: 'milestone_check_failed', opportunity: opp.data };
  const existingMilestones = milestones.data?.value || [];
  if (existingMilestones.length > 0) {
    return { ok: false, error: 'Refusing to delete opportunity: it already has milestone records.', reason: 'has_milestones', opportunity: opp.data, milestones: existingMilestones };
  }

  return { ok: true, opportunityId: oppNid, opportunity: opp.data, currentUserId };
}

/**
 * Plain async helper to POST a single msp_salesplaychecklists row.
 * NOT the MCP tool handler — avoids staging/text coupling.
 * Modeled on the executor pattern in executeAddOpportunitySolutionPlay.
 */
async function createChecklistRow(crmClient, { opportunityId, playId, globalSolutionArea, isPrimary }) {
  const body = {
    'msp_OpportunityId@odata.bind': `/opportunities(${opportunityId})`,
    'msp_SalesPlay@odata.bind': `/msp_accountplansalesplaybooks(${playId})`,
    msp_primary: isPrimary,
  };
  if (globalSolutionArea != null) body.msp_solutionarea = globalSolutionArea;
  // Generous single-attempt timeout, no retries: this is a non-idempotent POST,
  // and MCAPS checklist plugins can be slow. Retrying would risk duplicate rows.
  return crmClient.request('msp_salesplaychecklists', { method: 'POST', body, timeoutMs: 45000, retries: 0 });
}

async function executeCreateOpportunity(crmClient, op, getCrmBase) {
  const completedSteps = [];
  const warnings = [];

  // STEP 1: Create opportunity record — ONE POST with ALL scalar fields INCLUDING dates.
  // CDP-measured (docs/reference/opportunity-creation-flow.md §7): folding the dates into the
  // create POST costs nothing extra (~22-25s with or without them), so we include them here and
  // drop the separate ~6s date PATCH. The ~25s is inherent MCAPS create-plugin time (the native
  // Xrm.WebApi create is the same — it cannot be reduced from the client).
  // Generous single-attempt timeout, NO retries: a retry on timeout would create duplicate
  // opportunities (the POST often succeeds server-side even when the client aborts).
  const createBody = { ...op.payload.create, ...(op.payload.postCreatePatch || {}) };
  const result = await crmClient.request('opportunities', { method: 'POST', body: createBody, preferReturnRepresentation: true, timeoutMs: 60000, retries: 0 });
  if (!result.ok) return { ok: false, status: result.status, data: { message: result.data?.message || 'Opportunity create failed', partial: false, completedSteps, failedStep: { step: 'createOpportunity', status: result.status, message: result.data?.message || 'CRM error' }, warnings } };
  const id = createdIdFromResult(result, 'opportunityid');
  if (!id) return { ok: false, status: 500, data: { message: 'Opportunity created but CRM did not return a record id.', partial: true, completedSteps: ['createOpportunity'], failedStep: { step: 'resolveCreatedId' }, warnings } };
  completedSteps.push('createOpportunity');
  const recordUrl = buildRecordUrl(getCrmBase?.(), 'opportunity', id);

  // STEP 2: Create checklist rows IN PARALLEL. CDP-measured (docs §7): msp_salesplaychecklists
  // rows are independent and Dataverse processes them concurrently — 4 rows sequential ~32s vs
  // parallel ~4.7s, 8 rows parallel ~6.8s (near-constant). This matches the native UI where "1
  // play and 15 plays take the same time". (Deep insert was rejected: it serialises the child
  // plugins inside the transaction → ~57s.)
  const plays = op.payload.plays || [];
  if (plays.length > 0) {
    const primary = plays[0];
    if (!primary.playId) {
      return { ok: false, status: 400, data: { message: 'Primary play is missing playId (GUID). Cannot create checklist row.', opportunityId: id, recordUrl, completedSteps, failedStep: { step: 'createPrimaryChecklist' }, warnings } };
    }
    const settled = await Promise.allSettled(plays.map((p, i) =>
      p.playId
        ? createChecklistRow(crmClient, { opportunityId: id, playId: p.playId, globalSolutionArea: p.globalSolutionArea ?? null, isPrimary: i === 0 })
        : Promise.resolve({ __missingPlayId: true })
    ));
    const rowOk = (s) => s.status === 'fulfilled' && !s.value?.__missingPlayId && (s.value.ok || s.value.status === 204);
    const rowErr = (s) => s.status === 'rejected' ? (s.reason?.message || 'request failed') : (s.value?.data?.message || `status ${s.value?.status}`);

    // 2a: PRIMARY row (index 0) — MUST succeed (hard failure if it doesn't)
    if (!rowOk(settled[0])) {
      const status = settled[0].status === 'fulfilled' ? (settled[0].value?.status || 502) : 502;
      return {
        ok: false, status,
        data: {
          message: `Primary checklist row creation failed: ${rowErr(settled[0])}. Opportunity was created but is in an incomplete state.`,
          opportunityId: id, recordUrl, completedSteps,
          failedStep: { step: 'createPrimaryChecklist', status, message: rowErr(settled[0]) },
          warnings,
        },
      };
    }
    completedSteps.push('createPrimaryChecklist');

    // 2b: Additional (non-primary) rows — failure degrades to partial:true with warnings
    let additionalOk = 0;
    for (let i = 1; i < plays.length; i++) {
      if (!plays[i].playId) {
        warnings.push({ code: 'missing_play_id', message: `Play ${plays[i].playValue} skipped — missing GUID.` });
        continue;
      }
      if (rowOk(settled[i])) additionalOk++;
      else warnings.push({ code: 'checklist_create_failed', message: `Play ${plays[i].playValue} (${plays[i].playId}) checklist failed: ${rowErr(settled[i])}` });
    }
    const additionalTotal = plays.length - 1;
    completedSteps.push(`createAdditionalChecklists(${additionalOk}/${additionalTotal})`);
    if (additionalOk < additionalTotal) {
      return {
        ok: true, status: 200,
        data: {
          opportunityId: id, recordUrl, partial: true, completedSteps,
          failedStep: { step: 'createAdditionalChecklists', message: `${additionalTotal - additionalOk} non-primary row(s) failed` },
          warnings, message: 'Opportunity created with primary play, but some additional plays failed.',
        },
      };
    }
  }

  // STEP 3: Verify (dates were folded into the create POST in STEP 1; no separate date PATCH).
  const verify = await crmClient.request(`opportunities(${id})`, { query: { $select: 'opportunityid,name,_ownerid_value,_parentaccountid_value,_transactioncurrencyid_value,msp_opportunitytype,msp_solutionarea,msp_salesplay,statecode,msp_eststartdate,msp_estcompletiondate' } });
  if (!verify.ok) {
    warnings.push({ code: 'verify_failed', message: verify.data?.message || 'Opportunity verification failed' });
  } else {
    completedSteps.push('verifyOpportunity');
  }

  const hasWarnings = warnings.length > 0;
  
  // Bug 10 fix: Enrich op with created record details for audit capture
  op.recordId = id;
  op.recordName = (verify.ok && verify.data?.name) || op.payload.create?.name || null;
  op.recordUrl = recordUrl;
  
  return {
    ok: true, status: 200,
    data: {
      opportunityId: id, recordUrl, record: verify.ok ? verify.data : null,
      partial: hasWarnings, completedSteps, failedStep: null, warnings,
      message: hasWarnings ? 'Opportunity created with warnings.' : 'Opportunity created.',
    },
  };
}

async function executeCreateMilestone(crmClient, op, getCrmBase) {
  const completedSteps = [];
  const warnings = [];
  if (op.payload.opportunityPatch && Object.keys(op.payload.opportunityPatch).length && op.payload.opportunityId) {
    // Note: no etag available for the parent opportunity at this point (not staged with the op).
    // This sub-step runs without optimistic concurrency protection; monitor for 412 responses.
    const patch = await crmClient.request(`opportunities(${op.payload.opportunityId})`, { method: 'PATCH', body: op.payload.opportunityPatch });
    if (!patch.ok && patch.status !== 204) return { ok: false, status: patch.status, data: { message: patch.data?.message || 'Parent opportunity date patch failed', partial: false, completedSteps, failedStep: { step: 'patchParentOpportunityDates', status: patch.status, message: patch.data?.message || 'CRM error' }, warnings } };
    completedSteps.push('patchParentOpportunityDates');
  }
  const result = await crmClient.request('msp_engagementmilestones', { method: 'POST', body: op.payload.create, preferReturnRepresentation: true });
  if (!result.ok) return { ok: false, status: result.status, data: { message: result.data?.message || 'Milestone create failed', partial: completedSteps.length > 0, completedSteps, failedStep: { step: 'createMilestone', status: result.status, message: result.data?.message || 'CRM error' }, warnings } };
  const id = createdIdFromResult(result, 'msp_engagementmilestoneid');
  if (!id) return { ok: false, status: 500, data: { message: 'Milestone created but CRM did not return a record id.', partial: true, completedSteps: [...completedSteps, 'createMilestone'], failedStep: { step: 'resolveCreatedId' }, warnings } };
  completedSteps.push('createMilestone');
  const recordUrl = buildRecordUrl(getCrmBase?.(), 'msp_engagementmilestone', id);
  if (op.payload.ownerPatch && Object.keys(op.payload.ownerPatch).length) {
    const patch = await crmClient.request(`msp_engagementmilestones(${id})`, { method: 'PATCH', body: op.payload.ownerPatch, etag: result.data?.['@odata.etag'] });
    if (!patch.ok && patch.status !== 204) {
      warnings.push({ code: 'owner_patch_failed', message: patch.data?.message || 'Milestone owner patch failed' });
      // Bug 10 fix: Enrich op even on partial failure
      op.recordId = id;
      op.recordName = result.data?.msp_name || op.payload.create?.msp_name || null;
      op.recordUrl = recordUrl;
      return { ok: true, status: 200, data: { milestoneId: id, recordUrl, partial: true, completedSteps, failedStep: { step: 'patchMilestoneOwner', status: patch.status, message: patch.data?.message || 'CRM error' }, warnings, message: 'Milestone created, but owner assignment failed.' } };
    }
    completedSteps.push('patchMilestoneOwner');
  }
  const verify = await crmClient.request(`msp_engagementmilestones(${id})`, { query: { $select: 'msp_engagementmilestoneid,msp_name,msp_monthlyuse,msp_milestonedate,msp_milestonecategory,msp_milestonestatus,msp_milestonestatusreason,msp_milestoneworkload,msp_deliveryspecifiedfield,msp_milestonepreferredazureregion,msp_milestoneazurecapacitytype,_ownerid_value,_msp_opportunityid_value,_transactioncurrencyid_value,_msp_workloadlkid_value' } });
  if (!verify.ok) {
    warnings.push({ code: 'verify_failed', message: verify.data?.message || 'Milestone verification failed' });
    // Bug 10 fix: Enrich op even on verification failure
    op.recordId = id;
    op.recordName = result.data?.msp_name || op.payload.create?.msp_name || null;
    op.recordUrl = recordUrl;
    return { ok: true, status: 200, data: { milestoneId: id, recordUrl, partial: true, completedSteps, failedStep: { step: 'verifyMilestone', status: verify.status, message: verify.data?.message || 'CRM error' }, warnings, message: 'Milestone created, but verification failed.' } };
  }
  completedSteps.push('verifyMilestone');
  
  // Bug 10 fix: Enrich op with created record details for audit capture
  op.recordId = id;
  op.recordName = verify.data?.msp_name || op.payload.create?.msp_name || null;
  op.recordUrl = recordUrl;
  
  return { ok: true, status: 200, data: { milestoneId: id, recordUrl, record: verify.data, partial: false, completedSteps, failedStep: null, warnings, message: 'Milestone created.' } };
}

async function executeCloseMsxOpportunity(crmClient, op) {
  const completedSteps = [];
  const warnings = [];
  const { opportunityId, opportunityPatch, closeRecord, completeMilestones } = op.payload;

  // Step 1: PATCH opportunity with MSX custom fields (msp_engagementstatus, close date, etc.)
  const patchResult = await crmClient.request(`opportunities(${opportunityId})`, {
    method: 'PATCH', body: opportunityPatch, etag: op.etag
  });
  if (!patchResult.ok && patchResult.status !== 204) {
    return { ok: false, status: patchResult.status, data: { message: patchResult.data?.message || 'MSX fields PATCH failed', partial: false, completedSteps, failedStep: { step: 'patchOpportunityMsxFields', status: patchResult.status, message: patchResult.data?.message || 'CRM error' }, warnings } };
  }
  completedSteps.push('patchOpportunityMsxFields');

  // Step 2: Create opportunityclose record — triggers CRM plugin that sets parent opp statecode
  const closeResult = await crmClient.request('opportunitycloses', { method: 'POST', body: closeRecord });
  if (!closeResult.ok && closeResult.status !== 204) {
    return { ok: false, status: closeResult.status, data: { message: closeResult.data?.message || 'opportunityclose create failed', partial: true, completedSteps, failedStep: { step: 'createOpportunityClose', status: closeResult.status, message: closeResult.data?.message || 'CRM error' }, warnings } };
  }
  completedSteps.push('createOpportunityClose');

  // Step 3: Complete open milestones (Consumption only, if requested)
  // Real capture: "Mark all open milestones as COMPLETED" sets msp_milestonestatus=861980003 (Completed).
  if (completeMilestones) {
    const msResult = await crmClient.request('msp_engagementmilestones', {
      query: {
        $filter: `_msp_opportunityid_value eq ${opportunityId} and statecode eq 0 and msp_milestonestatus ne 861980003`,
        $select: 'msp_engagementmilestoneid'
      }
    });
    if (!msResult.ok) {
      warnings.push({ code: 'milestone_fetch_failed', message: msResult.data?.message || 'Could not fetch open milestones' });
    } else {
      const milestones = msResult.data?.value || [];
      let completed = 0;
      for (const m of milestones) {
        if (!m['@odata.etag']) {
          warnings.push({ code: 'milestone_no_etag', message: `Milestone ${m.msp_engagementmilestoneid}: no etag available, completing WITHOUT concurrency protection` });
        }
        const completeResult = await crmClient.request(`msp_engagementmilestones(${m.msp_engagementmilestoneid})`, {
          method: 'PATCH', body: { msp_milestonestatus: 861980003 }, etag: m['@odata.etag']
        });
        if (!completeResult.ok && completeResult.status !== 204) {
          warnings.push({ code: 'milestone_complete_failed', message: `Milestone ${m.msp_engagementmilestoneid}: ${completeResult.data?.message || 'complete failed'}` });
        } else {
          completed++;
        }
      }
      completedSteps.push(`completeMilestones(${completed}/${milestones.length})`);
    }
  }

  // Verify final state
  const verify = await crmClient.request(`opportunities(${opportunityId})`, {
    query: { $select: 'opportunityid,name,statecode,statuscode,msp_engagementstatus,msp_billedrevenuestatus,msp_engagementclosedate,msp_actualbilledclosedate' }
  });
  if (!verify.ok) {
    warnings.push({ code: 'verify_failed', message: verify.data?.message || 'Verification failed' });
    return { ok: true, status: 200, data: { opportunityId, partial: true, completedSteps, failedStep: { step: 'verifyOpportunity' }, warnings, message: 'Opportunity closed, but verification failed.' } };
  }
  completedSteps.push('verifyOpportunity');
  return { ok: true, status: 200, data: { opportunityId, record: verify.data, partial: false, completedSteps, failedStep: null, warnings, message: 'MSX opportunity closed successfully.' } };
}

// Reactivate contract: single PATCH restores statecode=0/Active + clears MSX close fields.
// Empirically confirmed from real network capture — no SetState/ReactivateOpportunity action needed.
async function executeReactivateMsxOpportunity(crmClient, op) {
  const completedSteps = [];
  const warnings = [];
  const { opportunityId, isBilled } = op.payload;

  const reactivatePatch = {
    statecode: 0,
    statuscode: 1,
    msp_engagementstatus: 861980000,   // Active/In-progress
    msp_engagementstatusreason: null,
    msp_engagementclosedate: null,
    msp_engagementclosingcomments: null
  };

  // For Billed opps: also clear billed close fields (best-effort; not separately captured).
  if (isBilled) {
    reactivatePatch.msp_billedrevenueclosereason = null;
    reactivatePatch.msp_actualbilledclosedate = null;
    reactivatePatch.msp_billedclosingcomments = null;
    // msp_billedrevenuestatus: do not set — active value not confirmed from capture.
    warnings.push({ code: 'billed_reactivate_inferred', message: 'Billed close field clearing is best-effort; msp_billedrevenuestatus active value not confirmed from capture.' });
  }

  const patchResult = await crmClient.request(`opportunities(${opportunityId})`, {
    method: 'PATCH', body: reactivatePatch, etag: op.etag
  });
  if (!patchResult.ok && patchResult.status !== 204) {
    return { ok: false, status: patchResult.status, data: { message: patchResult.data?.message || 'Reactivate PATCH failed', partial: false, completedSteps, failedStep: { step: 'reactivatePatch', status: patchResult.status, message: patchResult.data?.message || 'CRM error' }, warnings } };
  }
  completedSteps.push('reactivatePatch');

  // Verify final statecode=0
  const verify = await crmClient.request(`opportunities(${opportunityId})`, {
    query: { $select: 'opportunityid,name,statecode,statuscode,msp_engagementstatus,msp_engagementstatusreason,msp_engagementclosedate' }
  });
  if (!verify.ok) {
    warnings.push({ code: 'verify_failed', message: verify.data?.message || 'Verification failed' });
    return { ok: true, status: 200, data: { opportunityId, partial: true, completedSteps, failedStep: { step: 'verifyOpportunity' }, warnings, message: 'Opportunity reactivated, but verification failed.' } };
  }
  if (verify.data.statecode !== 0) {
    warnings.push({ code: 'unexpected_statecode', message: `Expected statecode=0 after reactivation, got ${verify.data.statecode}` });
  }
  completedSteps.push('verifyOpportunity');
  return { ok: true, status: 200, data: { opportunityId, record: verify.data, partial: false, completedSteps, failedStep: null, warnings, message: 'MSX opportunity reactivated successfully.' } };
}

/**
 * Execute a staged add_opportunity_solution_play op: POST the checklist row,
 * then (best-effort) sync the parent opportunity's Solution Area via the
 * fallback slots. A failed area sync does NOT roll back the checklist row —
 * it is surfaced as a warning so the caller can retry via update_opportunity.
 */
async function executeAddOpportunitySolutionPlay(crmClient, op) {
  const result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
  if (!result.ok && result.status !== 204) return result;

  const warnings = [];
  if (op.fallbackEntitySet && op.fallbackPayload) {
    // Note: no etag available for the fallback opportunity patch (not staged with the op).
    // This sub-step runs without optimistic concurrency protection; checklist row was created successfully.
    const patch = await crmClient.request(op.fallbackEntitySet, { method: 'PATCH', body: op.fallbackPayload });
    if (!patch.ok && patch.status !== 204) {
      warnings.push(
        `Opportunity Solution Area update failed (${patch.status}): ${patch.data?.message || 'unknown error'}. ` +
        'Checklist row was created successfully; retry the area update via update_opportunity.'
      );
    }
  }
  if (warnings.length) result.data = { ...(result.data || {}), warnings };
  return result;
}

/**
 * Execute a staged set_opportunity_solution_play_primary op: PATCH the target
 * row to primary, then (best-effort) demote any previously-primary rows and
 * sync the parent opportunity's Solution Area. Secondary failures are surfaced
 * as warnings without rolling back the primary flag.
 */
async function executeSetSolutionPlayPrimary(crmClient, op) {
  const result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload, etag: op.etag });
  if (!result.ok && result.status !== 204) return result;

  const warnings = [];
  if (Array.isArray(op.demoteChecklistIds) && op.demoteChecklistIds.length) {
    for (const otherId of op.demoteChecklistIds) {
      // Note: no etag available for demoting other plays (IDs collected at staging time without etags).
      // This sub-step runs without optimistic concurrency protection; primary flag was set successfully.
      const demote = await crmClient.request(`msp_salesplaychecklists(${otherId})`, { method: 'PATCH', body: { msp_primary: false } });
      if (!demote.ok && demote.status !== 204) {
        warnings.push(
          `Failed to demote previous primary Solution Play row ${otherId} (${demote.status}): ${demote.data?.message || 'unknown error'}. ` +
          'The opportunity may now have multiple primary plays.'
        );
      }
    }
  }
  if (op.fallbackEntitySet && op.fallbackPayload) {
    // Note: no etag available for the fallback opportunity patch (not staged with the op).
    // This sub-step runs without optimistic concurrency protection; primary flag was set successfully.
    const patch = await crmClient.request(op.fallbackEntitySet, { method: 'PATCH', body: op.fallbackPayload });
    if (!patch.ok && patch.status !== 204) {
      warnings.push(
        `Opportunity Solution Area update failed (${patch.status}): ${patch.data?.message || 'unknown error'}. ` +
        'Primary flag was set successfully; retry the area update via update_opportunity.'
      );
    }
  }
  if (warnings.length) result.data = { ...(result.data || {}), warnings };
  return result;
}

/**
 * Register all CRM tools on an McpServer instance.
 */
export function registerTools(server, crmClient) {
  /** Lazily get the CRM base URL for deep-link generation. */
  const getCrmBase = () => crmClient.getCrmUrl?.() || null;

  // Publish CRM base to audit-capture so recordUrl deep-links are populated.
  setCrmBase(getCrmBase());

  /** Get current user UPN from auth metadata (for audit actor field). */
  const getCurrentActor = () => {
    try {
      const status = crmClient.authService?.getAuthStatus?.();
      return status?.userName || null;
    } catch {
      return null;
    }
  };

  /** Hook queue events to capture dead-letter transitions (only once per queue). */
  const queue = getApprovalQueue();
  if (!deadLetterListenerGuard.has(queue)) {
    deadLetterListenerGuard.add(queue);
    queue.on('op:dead-letter', (op) => {
      captureAuditRecord(op, { phase: 'dead-letter', error: op.lastError?.error || 'retries exhausted' }, getCurrentActor(), op.correlationId ?? null);
    });
  }

  // ── crm_whoami ──────────────────────────────────────────────
  server.tool(
    'crm_whoami',
    'Validate CRM access and return the current user identity (UserId, fullName, email).',
    {},
    async () => {
      const result = await crmClient.request('WhoAmI');
      if (!result.ok) return error(`WhoAmI failed: ${result.data?.message || result.status}`);

      const identity = { ...result.data };

      // WhoAmI only returns UserId/BusinessUnitId/OrganizationId.
      // Fetch the systemuser record to get fullname and email.
      if (identity.UserId) {
        try {
          const nid = normalizeGuid(identity.UserId);
          const user = await crmClient.request(`systemusers(${nid})`, {
            query: { $select: 'fullname,internalemailaddress,msp_rolegroup,msp_role,msp_rolesummary' }
          });
          if (user.ok && user.data) {
            identity.fullName = user.data.fullname || '';
            identity.email = user.data.internalemailaddress || '';

            // Role taxonomy enrichment — see mcp/msx/references/ROLE_TAXONOMY.md
            const rawRoleGroup = user.data.msp_rolegroup || null;
            const rawRole = user.data.msp_role || null;
            const rawRoleSummary = user.data.msp_rolesummary || null;
            const { roleCode, roleName } = mapRoleToCode(rawRoleSummary);

            identity.department = rawRoleGroup;
            identity.departmentName = rawRoleGroup ? (DEPARTMENT_NAMES[rawRoleGroup] || null) : null;
            identity.roleCode = roleCode;
            identity.roleName = roleName;
            identity.rawRoleGroup = rawRoleGroup;
            identity.rawRole = rawRole;
            identity.rawRoleSummary = rawRoleSummary;
          }
        } catch (e) {
          // Non-fatal — identity still has UserId
          console.warn('crm_whoami: failed to fetch systemuser details:', e.message);
        }
      }

      return text(identity);
    }
  );

  // ── crm_query ───────────────────────────────────────────────
  server.tool(
    'crm_query',
    `Execute a read-only OData GET against an allowed Dynamics 365 entity set. Supports $filter, $select, $orderby, $top, $expand. Auto-paginates up to ${CRM_QUERY_MAX_RECORDS} records. Allowed entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}.`,
    {
      entitySet: z.string().describe('Entity set name, e.g. "opportunities", "accounts", "msp_engagementmilestones"'),
      filter: z.string().optional().describe('OData $filter expression'),
      select: z.string().optional().describe('Comma-separated field names for $select'),
      orderby: z.string().optional().describe('OData $orderby expression'),
      top: z.number().optional().describe('Maximum number of records to return'),
      expand: z.string().optional().describe('OData $expand expression')
    },
    async ({ entitySet, filter, select, orderby, top, expand }) => {
      if (!entitySet) return error('entitySet is required');

      if (!isEntityAllowed(entitySet)) {
        auditLog({ tool: 'crm_query', entitySet, blocked: true, reason: 'entity not in allowlist' });
        return error(
          `Entity set "${entitySet}" is not in the allowed list. ` +
          `Permitted entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}. ` +
          `If you need access to this entity, add it to ALLOWED_ENTITY_SETS in tools.js.`
        );
      }

      const query = {};
      if (filter) query.$filter = normalizeLookupCasing(filter);
      if (select) query.$select = normalizeLookupCasing(select);
      if (orderby) query.$orderby = normalizeLookupCasing(orderby);
      if (top) query.$top = String(Math.min(top, CRM_QUERY_MAX_RECORDS));
      if (expand) query.$expand = normalizeLookupCasing(expand);

      const result = await crmClient.requestAllPages(entitySet, { query, maxRecords: CRM_QUERY_MAX_RECORDS });
      if (!result.ok) return error(`Query failed (${result.status}): ${result.data?.message}`);

      const records = result.data?.value || (result.data ? [result.data] : []);
      auditLog({ tool: 'crm_query', entitySet, params: { filter, select, top }, recordCount: records.length });
      return text({ count: records.length, value: records });
    }
  );

  // ── crm_get_record ──────────────────────────────────────────
  server.tool(
    'crm_get_record',
    `Retrieve a single Dynamics 365 record by entity set and GUID. Allowed entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}.`,
    {
      entitySet: z.string().describe('Entity set name, e.g. "opportunities", "accounts"'),
      id: z.string().describe('Record GUID'),
      select: z.string().optional().describe('Comma-separated field names for $select')
    },
    async ({ entitySet, id, select }) => {
      if (!entitySet) return error('entitySet is required');

      if (!isEntityAllowed(entitySet)) {
        auditLog({ tool: 'crm_get_record', entitySet, blocked: true, reason: 'entity not in allowlist' });
        return error(
          `Entity set "${entitySet}" is not in the allowed list. ` +
          `Permitted entity sets: ${[...ALLOWED_ENTITY_SETS].join(', ')}. ` +
          `If you need access to this entity, add it to ALLOWED_ENTITY_SETS in tools.js.`
        );
      }

      const normalized = normalizeGuid(id);
      if (!isValidGuid(normalized)) return error('Invalid GUID');
      const query = {};
      if (select) query.$select = select;
      const result = await crmClient.request(`${entitySet}(${normalized})`, { query });
      if (!result.ok) return error(`Get record failed (${result.status}): ${result.data?.message}`);
      auditLog({ tool: 'crm_get_record', entitySet, recordCount: 1 });
      return text(result.data);
    }
  );

  // ── list_opportunities ──────────────────────────────────────
  server.tool(
    'list_opportunities',
    'List open opportunities for one or more account IDs or by customer name keyword. Returns opportunity name, dates, owner, solution play.',
    {
      accountIds: z.array(z.string()).optional().describe('Array of Dynamics 365 account GUIDs'),
      customerKeyword: z.string().optional().describe('Customer name keyword — resolves matching accounts internally'),
      includeCompleted: z.boolean().optional().default(false).describe('Include opportunities past their estimated completion date (default: false)')
    },
    async ({ accountIds, customerKeyword, includeCompleted }) => {
      let resolvedIds = accountIds ? accountIds.map(normalizeGuid).filter(isValidGuid) : [];

      // Resolve customerKeyword → account GUIDs
      if (!resolvedIds.length && customerKeyword) {
        const sanitized = sanitizeODataString(customerKeyword.trim());
        const acctResult = await crmClient.requestAllPages('accounts', {
          query: { $filter: `contains(name,'${sanitized}')`, $select: 'accountid,name', $top: '50' }
        });
        const matchedAccounts = acctResult.ok ? (acctResult.data?.value || []) : [];
        if (!matchedAccounts.length) {
          return text({ count: 0, opportunities: [], matchedAccounts: [], message: `No accounts found matching '${customerKeyword}'` });
        }
        resolvedIds = matchedAccounts.map(a => a.accountid);
      }

      if (!resolvedIds.length) return error('Provide accountIds array or customerKeyword');

      // Chunk into groups of 25 to keep filter URL manageable
      const chunks = [];
      for (let i = 0; i < resolvedIds.length; i += 25) chunks.push(resolvedIds.slice(i, i + 25));

      const allOpps = [];
      for (const chunk of chunks) {
        let filter = `(${chunk.map(id => `_parentaccountid_value eq '${id}'`).join(' or ')}) and statecode eq 0`;
        if (!includeCompleted) {
          filter += ` and msp_estcompletiondate ge ${daysAgo(30)}`;
        }
        const result = await crmClient.requestAllPages('opportunities', {
          query: { $filter: filter, $select: OPP_SELECT, $orderby: 'name' }
        });
        if (result.ok && result.data?.value) allOpps.push(...result.data.value);
      }

      // Aggregate per-opp seats (usage) + monthlyUse/ACR (consumption) from milestones
      // in ONE batch query so consumers can show a type-appropriate metric (not "$0.00").
      const metricsByOpp = await aggregateOppMetrics(crmClient, allOpps.map(o => o.opportunityid));
      return text({ count: allOpps.length, opportunities: allOpps.map(o => {
        const agg = metricsByOpp[o.opportunityid] || { seats: 0, monthlyUse: 0 };
        return { ...o, seats: agg.seats, monthlyUse: agg.monthlyUse, recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', o.opportunityid) };
      }) });
    }
  );

  // Helper for capacityFilter logic (shared between opportunityIds and general paths)
  function matchesCapacityFilter(m, filterMode) {
    if (!filterMode) return true;
    
    // Capacity filters only apply to Azure-workload milestones
    // (Modern Work/D365/Security don't have meaningful Azure region/capacity)
    const workloadTypeCode = parseWorkloadTypeCode(m);
    
    // Non-Azure milestones are excluded from ALL capacityFilter results
    if (workloadTypeCode !== WORKLOAD_TYPE.AZURE) return false;
    
    const REGION_NONE = 861980076;
    const CAPACITY_NONE = 861980000;
    
    // Region helpers
    const rawRegion = m.msp_milestonepreferredazureregion ?? null;
    const hasRegion = rawRegion !== null && rawRegion !== '' && rawRegion !== REGION_NONE;
    
    // Capacity helpers (multi-select comma-separated)
    const rawCapacity = m.msp_milestoneazurecapacitytype ?? null;
    const capacityCodes = rawCapacity && typeof rawCapacity === 'string' && rawCapacity.trim() !== ''
      ? rawCapacity.split(',').map(c => Number(c.trim())).filter(c => !isNaN(c))
      : [];
    const hasCapacity = capacityCodes.length > 0 && capacityCodes.some(c => c !== CAPACITY_NONE);
    
    switch (filterMode) {
      case 'has-region': return hasRegion;
      case 'missing-region': return !hasRegion;
      case 'has-capacity': return hasCapacity;
      case 'missing-capacity': return !hasCapacity;
      case 'missing-any': return !hasRegion || !hasCapacity;
      case 'has-both': return hasRegion && hasCapacity;
      default: return true;
    }
  }

  // Helper for workloadFilter logic (A4)
  function matchesWorkloadFilter(m, filterMode) {
    if (!filterMode) return true;
    const workloadTypeCode = parseWorkloadTypeCode(m);
    // Accept both lowercase and the label forms
    const mode = filterMode.toLowerCase();
    switch (mode) {
      case 'azure': return workloadTypeCode === WORKLOAD_TYPE.AZURE;
      case 'd365': return workloadTypeCode === WORKLOAD_TYPE.D365;
      case 'security': return workloadTypeCode === WORKLOAD_TYPE.SECURITY;
      case 'modern-work':
      case 'modern work': return workloadTypeCode === WORKLOAD_TYPE.MODERN_WORK;
      default: return true;
    }
  }

  // Helper for commentFilter logic (A5)
  function matchesCommentFilter(m, filterMode) {
    if (!filterMode || filterMode === 'any') return true;
    const forecastComments = m.msp_forecastcomments ?? null;
    const hasComments = forecastComments !== null && forecastComments !== '';
    if (filterMode === 'none') return !hasComments;
    // For 'stale' and 'none-or-stale', we need to check last modified date
    const lastCommentedOnRaw = m['msp_forecastcomments_lastmodifiedon@OData.Community.Display.V1.FormattedValue']
      ?? m.msp_forecastcomments_lastmodifiedon
      ?? null;
    if (!hasComments) {
      // No comments means it matches 'none-or-stale'
      return filterMode === 'none-or-stale';
    }
    // Has comments — check if stale (>30 days)
    if (!lastCommentedOnRaw) {
      // Has comments but no timestamp (shouldn't happen, but treat as stale)
      return filterMode === 'stale' || filterMode === 'none-or-stale';
    }
    const commentDate = new Date(lastCommentedOnRaw);
    if (isNaN(commentDate.getTime())) {
      // Invalid date — treat as stale
      return filterMode === 'stale' || filterMode === 'none-or-stale';
    }
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const commentYYYYMMDD = `${commentDate.getFullYear()}-${pad(commentDate.getMonth() + 1)}-${pad(commentDate.getDate())}`;
    const today = new Date(todayStr);
    const commentDay = new Date(commentYYYYMMDD);
    const diffMs = today.getTime() - commentDay.getTime();
    const ageDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const isStale = ageDays > 30;
    if (filterMode === 'stale') return isStale;
    if (filterMode === 'none-or-stale') return isStale;
    return true;
  }

  // ── get_milestones ──────────────────────────────────────────
  server.tool(
    'get_milestones',
    'Get engagement milestones scoped by customer name, opportunity name/GUID, milestoneId, milestone number, or owner. Always requires a scoping parameter — never returns all milestones unscoped. Resolves customer/opportunity keywords to GUIDs internally — no need to call list_opportunities first. Supports batch opportunityIds, status/keyword filtering, task-presence filtering, and inline task embedding. When mine=true, only active milestones are returned by default (excludes Completed/Cancelled/Closed); pass statusFilter="all" to override. Use format="triage" for urgency-classified output (overdue, due_soon, blocked, on_track) — ideal for morning briefs and health reviews.',
    {
      customerKeyword: z.string().optional().describe('Customer name keyword — resolves accounts → opportunities → milestones in one call'),
      opportunityKeyword: z.string().optional().describe('Opportunity name keyword — resolves matching opportunities → milestones in one call'),
      opportunityId: z.string().optional().describe('Opportunity GUID to list milestones for'),
      opportunityIds: z.array(z.string()).optional().describe('Array of opportunity GUIDs for batch milestone retrieval'),
      milestoneNumber: z.string().optional().describe('Milestone number to search for, e.g. "7-123456789"'),
      milestoneId: z.string().optional().describe('Direct milestone GUID lookup'),
      ownerId: z.string().optional().describe('Owner system user GUID to list milestones for'),
      mine: z.boolean().optional().describe('When explicitly set to true, returns milestones owned by the authenticated CRM user. Automatically filters to active milestones (excludes Completed/Cancelled/Closed) unless statusFilter="all" is passed. Must be set explicitly — does NOT default to true. Prefer customerKeyword, opportunityKeyword, or opportunityId for narrower scoping.'),
      statusFilter: z.enum(['active', 'all']).optional().describe('Filter by status: active = Not Started/On Track/Blocked/At Risk'),
      keyword: z.string().optional().describe('Case-insensitive keyword filter across milestone name, opportunity, and workload'),
      format: z.enum(['compact', 'full', 'detail', 'summary', 'triage']).optional().describe('Response format: compact (default — table-friendly fields only, ~500 B/record), full / detail (raw OData record with all annotations), summary (grouped aggregates), or triage (urgency-classified). Prefer the default unless you need raw fields.'),
      taskFilter: z.enum(['all', 'with-tasks', 'without-tasks']).optional().describe('Filter milestones by task presence'),
      includeTasks: z.boolean().optional().describe('When true, embeds linked tasks inline on each milestone (avoids separate get_milestone_activities call). Default: false'),
      dateRange: z.string().optional().describe('Fiscal period filter: Q1-Q4, H1-H2, FY, JUL-JUN (single month), current-Q, current-H, current-M, current-FY (relative to now), OR absolute: FY26 / FY27 (whole year) / FY27-Q1 / FY27-H2 / FY27-AUG.'),
      commitmentFilter: z.enum(['committed', 'uncommitted', 'best-case', 'pipeline', 'all']).optional().describe('Filter by commitment recommendation. Maps to CRM values: committed, uncommitted, best-case (best case), pipeline. Default: no filter (returns all).'),
      capacityFilter: z.enum(['has-region', 'missing-region', 'has-capacity', 'missing-capacity', 'missing-any', 'has-both']).optional().describe('Filter by Azure region/capacity presence (Azure-workload milestones only — non-Azure milestones are excluded): has-region (has a real region, not None/empty), missing-region (Azure milestone with region null/empty or None code 861980076), has-capacity (has at least one non-None capacity type code), missing-capacity (Azure milestone with capacity null/empty or only None code 861980000), missing-any (Azure milestone missing region OR capacity), has-both (Azure milestone with region AND capacity).'),
      workloadFilter: z.enum(['azure', 'Azure', 'd365', 'D365', 'security', 'Security', 'modern-work', 'Modern Work']).optional().describe('Filter by workload TYPE (msp_milestoneworkload optionset): azure (Azure workload, code 861980000), d365 (D365 workload, code 861980001), security (Security workload, code 861980002), modern-work (Modern Work workload, code 861980003). Accepts lowercase or label forms.'),
      commentFilter: z.enum(['none', 'stale', 'none-or-stale', 'any']).optional().describe('Filter by forecast comment presence/recency: none (no forecast comments), stale (has forecast comments but last modified >30 days ago), none-or-stale (either no comments or stale comments), any (no filter). Uses msp_forecastcomments and msp_forecastcomments_lastmodifiedon.')
    },
    async ({ customerKeyword, opportunityKeyword, opportunityId, opportunityIds, milestoneNumber, milestoneId, ownerId, mine, statusFilter, keyword, format, taskFilter: taskFilterParam, includeTasks, dateRange, commitmentFilter, capacityFilter, workloadFilter, commentFilter }) => {
      // When mine=true, default to active milestones only (skip Completed/Cancelled/Closed)
      if (mine === true && statusFilter === undefined) {
        statusFilter = 'active';
      }

      // Direct GUID lookup
      if (milestoneId) {
        const nid = normalizeGuid(milestoneId);
        if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');
        const result = await crmClient.request(`msp_engagementmilestones(${nid})`, {
          query: { $select: MILESTONE_SELECT }
        });
        if (!result.ok) return error(`Milestone lookup failed (${result.status}): ${result.data?.message}`);
        const milestone = { ...result.data, commitment: commitmentLabel(result.data), recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', nid) };
        if (includeTasks) {
          milestone.tasks = await fetchTasksForMilestones(crmClient, [nid]);
        }
        return text(milestone);
      }

      // Resolve customerKeyword → opportunity GUIDs
      let resolvedOppIds = null;
      // Maps opportunityId → customer (account) name, populated when customerKeyword
      // is used. Threaded into projectMilestoneCompact so the LLM gets the customer
      // column without an extra expand on the milestone query.
      let oppCustomerMap = null;
      if (customerKeyword) {
        const sanitized = sanitizeODataString(customerKeyword.trim());
        const acctResult = await crmClient.requestAllPages('accounts', {
          query: { $filter: `contains(name,'${sanitized}')`, $select: 'accountid,name', $top: '50' }
        });
        const accounts = acctResult.ok ? (acctResult.data?.value || []) : [];
        if (!accounts.length) {
          return text({ count: 0, milestones: [], message: `No accounts found matching '${customerKeyword}'` });
        }
        const acctIds = accounts.map(a => a.accountid);
        const acctNameById = Object.fromEntries(accounts.map(a => [a.accountid, a.name]));
        let oppDateFilter;
        if (dateRange) {
          // Only require the opportunity to still be active during the period (completion >= period start).
          // The dateRange filter is applied to milestones later — no need to constrain opp end date here.
          const { start } = getMsFiscalRange(dateRange);
          oppDateFilter = `msp_estcompletiondate ge ${start}`;
        } else {
          oppDateFilter = `msp_estcompletiondate ge ${daysAgo(30)}`;
        }
        const acctChunks = [];
        for (let i = 0; i < acctIds.length; i += 25) acctChunks.push(acctIds.slice(i, i + 25));
        const allOpps = [];
        for (const chunk of acctChunks) {
          const acctFilter = `(${chunk.map(id => `_parentaccountid_value eq '${id}'`).join(' or ')}) and statecode eq 0 and ${oppDateFilter}`;
          const oppResult = await crmClient.requestAllPages('opportunities', {
            query: { $filter: acctFilter, $select: 'opportunityid,name,_parentaccountid_value', $orderby: 'name' }
          });
          if (oppResult.ok && oppResult.data?.value) allOpps.push(...oppResult.data.value);
        }
        if (!allOpps.length) {
          return text({ count: 0, milestones: [], message: `No active opportunities found for customer '${customerKeyword}'` });
        }
        resolvedOppIds = allOpps.map(o => o.opportunityid);
        oppCustomerMap = Object.fromEntries(
          allOpps.map(o => [o.opportunityid, acctNameById[o._parentaccountid_value] || null])
        );
      }

      // Resolve opportunityKeyword → opportunity GUIDs
      if (!resolvedOppIds && opportunityKeyword) {
        const sanitized = sanitizeODataString(opportunityKeyword.trim());
        let oppDateFilter2;
        if (dateRange) {
          const { start } = getMsFiscalRange(dateRange);
          oppDateFilter2 = `msp_estcompletiondate ge ${start}`;
        } else {
          oppDateFilter2 = `msp_estcompletiondate ge ${daysAgo(30)}`;
        }
        const oppResult = await crmClient.requestAllPages('opportunities', {
          query: {
            $filter: `contains(name,'${sanitized}') and statecode eq 0 and ${oppDateFilter2}`,
            $select: 'opportunityid,name',
            $orderby: 'name',
            $top: '50'
          }
        });
        const opps = oppResult.ok ? (oppResult.data?.value || []) : [];
        if (!opps.length) {
          return text({ count: 0, milestones: [], message: `No active opportunities found matching '${opportunityKeyword}'` });
        }
        resolvedOppIds = opps.map(o => o.opportunityid);
      }

      // If keyword resolution produced opportunity IDs, merge with explicit opportunityIds
      if (resolvedOppIds) {
        const merged = resolvedOppIds;
        if (opportunityIds?.length) merged.push(...opportunityIds);
        if (opportunityId) merged.push(opportunityId);
        opportunityIds = merged;
        opportunityId = undefined;
      }

      // Resolve owner GUID for post-filtering when opportunityIds path is used
      // alongside mine=true or ownerId. The opportunityIds OData filter only
      // narrows by opportunity, NOT by owner — without this, callers passing
      // (customerKeyword + ownerId) or (customerKeyword + mine=true) would get
      // milestones from every owner on those opportunities.
      let ownerFilterGuid = null;
      if (ownerId) {
        const nid = normalizeGuid(ownerId);
        if (!isValidGuid(nid)) return error('Invalid ownerId GUID');
        ownerFilterGuid = nid;
      } else if (mine === true) {
        const whoAmI = await crmClient.request('WhoAmI');
        if (!whoAmI.ok || !whoAmI.data?.UserId) {
          return error(`Unable to resolve current CRM user for milestone lookup (${whoAmI.status}): ${whoAmI.data?.message || 'WhoAmI failed'}`);
        }
        ownerFilterGuid = normalizeGuid(whoAmI.data.UserId);
      }

      // When querying by owner (mine/ownerId), we must post-filter milestones
      // to exclude those from Won/Lost opportunities (statecode !== 0).
      // The OData filter only checks _ownerid_value, not the parent opp's statecode.
      const filterByOppState = mine === true || ownerId != null;

      let filter;
      if (milestoneNumber) {
        const sanitized = sanitizeODataString(milestoneNumber.trim());
        filter = `msp_milestonenumber eq '${sanitized}'`;
      } else if (opportunityIds?.length) {
        const validIds = opportunityIds.map(normalizeGuid).filter(isValidGuid);
        if (!validIds.length) return error('No valid opportunity GUIDs in opportunityIds');
        const chunks = [];
        for (let i = 0; i < validIds.length; i += 25) chunks.push(validIds.slice(i, i + 25));
        let msDateFilter = '';
        if (dateRange) {
          const { start, end } = getMsFiscalRange(dateRange);
          msDateFilter = ` and msp_milestonedate ge ${start} and msp_milestonedate le ${end}`;
        }
        const allMilestones = [];
        for (const chunk of chunks) {
          const chunkFilter = `(${chunk.map(id => `_msp_opportunityid_value eq '${id}'`).join(' or ')})${msDateFilter}`;
          const chunkResult = await crmClient.requestAllPages('msp_engagementmilestones', {
            query: { $filter: chunkFilter, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
          });
          if (chunkResult.ok && chunkResult.data?.value) allMilestones.push(...chunkResult.data.value);
          // A swallowed chunk silently truncates the book. Never let it pass unnoticed.
          else console.error(`[get_milestones] chunk failed (${chunk.length} opportunities dropped): status=${chunkResult.status} ${chunkResult.error || ''}`);
        }
        let milestones = allMilestones;
        // Apply owner filter when caller combined opportunityIds (e.g. via
        // customerKeyword) with mine=true or ownerId — see ownerFilterGuid above.
        if (ownerFilterGuid) {
          const target = String(ownerFilterGuid).toLowerCase().replace(/[{}]/g, '');
          milestones = milestones.filter(m => {
            const mid = m._ownerid_value ? String(m._ownerid_value).toLowerCase().replace(/[{}]/g, '') : '';
            return mid === target;
          });
        }
        if (statusFilter === 'active') {
          milestones = milestones.filter(m => ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus')));
        }
        if (commitmentFilter && commitmentFilter !== 'all') {
          const normalize = s => s.toLowerCase().replace(/[\s\-]/g, '');
          const target = normalize(commitmentFilter);
          milestones = milestones.filter(m => normalize(fv(m, 'msp_commitmentrecommendation') || '') === target);
        }
        if (keyword) {
          const kw = keyword.toLowerCase();
          milestones = milestones.filter(m =>
            (m.msp_name || '').toLowerCase().includes(kw) ||
            (fv(m, '_msp_opportunityid_value') || '').toLowerCase().includes(kw) ||
            (fv(m, '_msp_workloadlkid_value') || '').toLowerCase().includes(kw)
          );
        }
        if (capacityFilter) {
          milestones = milestones.filter(m => matchesCapacityFilter(m, capacityFilter));
        }
        if (workloadFilter) {
          milestones = milestones.filter(m => matchesWorkloadFilter(m, workloadFilter));
        }
        if (commentFilter) {
          milestones = milestones.filter(m => matchesCommentFilter(m, commentFilter));
        }
        if (taskFilterParam && taskFilterParam !== 'all') {
          milestones = await applyTaskFilter(crmClient, milestones, taskFilterParam);
        }
        if (includeTasks) {
          milestones = await embedTasksOnMilestones(crmClient, milestones);
        }
        if (format === 'summary') return text(buildMilestoneSummary(milestones, getCrmBase()));
        if (format === 'triage') return text(buildMilestoneTriage(milestones, getCrmBase()));
        if (format === 'full' || format === 'detail') {
          return text({ count: milestones.length, milestones: milestones.map(m => ({ ...m, commitment: commitmentLabel(m), recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', m.msp_engagementmilestoneid) })) });
        }
        // Default: compact table-friendly projection (keeps response under the
        // bundled-CLI temp-spill threshold for typical 5-30 milestone results).
        const _base = getCrmBase();
        return text({ count: milestones.length, milestones: milestones.map(m => projectMilestoneCompact(m, _base, oppCustomerMap?.[m._msp_opportunityid_value] || null, ownerFilterGuid)) });
      } else if (opportunityId) {
        const nid = normalizeGuid(opportunityId);
        if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');
        filter = `_msp_opportunityid_value eq '${nid}'`;
      } else if (ownerId) {
        filter = `_ownerid_value eq '${ownerFilterGuid}'`;
      } else if (mine === true) {
        filter = `_ownerid_value eq '${ownerFilterGuid}'`;
      } else {
        return error('Scoping required: provide customerKeyword, opportunityKeyword, opportunityId, opportunityIds, milestoneNumber, milestoneId, ownerId, or mine=true. Unscoped milestone queries are not allowed.');
      }

      // Append milestone date filter when dateRange is provided
      if (dateRange) {
        const { start, end } = getMsFiscalRange(dateRange);
        filter += ` and msp_milestonedate ge ${start} and msp_milestonedate le ${end}`;
      }

      const result = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: { $filter: filter, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
      });
      if (!result.ok) return error(`Get milestones failed (${result.status}): ${result.data?.message}`);
      let milestones = result.data?.value || [];

      // Exclude non-completed milestones whose parent opportunity is Won or Lost (statecode !== 0).
      // Completed milestones on closed/Won opportunities remain visible for the pipeline matrix.
      if (filterByOppState && milestones.length > 0) {
        const oppIds = [...new Set(milestones.map(m => m._msp_opportunityid_value).filter(Boolean))];
        if (oppIds.length > 0) {
          const oppStateById = new Map();
          const chunks = [];
          for (let i = 0; i < oppIds.length; i += 25) chunks.push(oppIds.slice(i, i + 25));
          for (const chunk of chunks) {
            const oppFilter = chunk.map(id => `opportunityid eq '${id}'`).join(' or ');
            const oppResult = await crmClient.requestAllPages('opportunities', {
              query: { $filter: `(${oppFilter})`, $select: 'opportunityid,statecode' }
            });
            if (oppResult.ok && oppResult.data?.value) {
              for (const opp of oppResult.data.value) oppStateById.set(opp.opportunityid, opp.statecode);
            }
          }
          milestones = milestones.filter(m => {
            const oppId = m._msp_opportunityid_value;
            if (!oppId) return true;
            const state = oppStateById.get(oppId);
            if (state === 0) return true;
            const status = fv(m, 'msp_milestonestatus') || '';
            const rawCode = m.msp_milestonestatus;
            const parsedCode = rawCode === undefined || rawCode === null || rawCode === ''
              ? null
              : (typeof rawCode === 'number' ? rawCode : parseInt(rawCode, 10));
            return status === 'Completed' || parsedCode === 861980003;
          });
        }
      }

      // Post-query filters
      if (statusFilter === 'active') {
        milestones = milestones.filter(m => ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus')));
      }
      if (commitmentFilter && commitmentFilter !== 'all') {
        const normalize = s => s.toLowerCase().replace(/[\s\-]/g, '');
        const target = normalize(commitmentFilter);
        milestones = milestones.filter(m => normalize(fv(m, 'msp_commitmentrecommendation') || '') === target);
      }
      if (keyword) {
        const kw = keyword.toLowerCase();
        milestones = milestones.filter(m =>
          (m.msp_name || '').toLowerCase().includes(kw) ||
          (fv(m, '_msp_opportunityid_value') || '').toLowerCase().includes(kw) ||
          (fv(m, '_msp_workloadlkid_value') || '').toLowerCase().includes(kw)
        );
      }
      if (capacityFilter) {
        milestones = milestones.filter(m => matchesCapacityFilter(m, capacityFilter));
      }
      if (workloadFilter) {
        milestones = milestones.filter(m => matchesWorkloadFilter(m, workloadFilter));
      }
      if (commentFilter) {
        milestones = milestones.filter(m => matchesCommentFilter(m, commentFilter));
      }
      if (taskFilterParam && taskFilterParam !== 'all') {
        milestones = await applyTaskFilter(crmClient, milestones, taskFilterParam);
      }
      if (includeTasks) {
        milestones = await embedTasksOnMilestones(crmClient, milestones);
      }
      if (format === 'summary') return text(buildMilestoneSummary(milestones, getCrmBase()));
      if (format === 'triage') return text(buildMilestoneTriage(milestones, getCrmBase()));
      if (format === 'full' || format === 'detail') {
        return text({ count: milestones.length, milestones: milestones.map(m => ({ ...m, commitment: commitmentLabel(m), recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', m.msp_engagementmilestoneid) })) });
      }
      // Default: compact table-friendly projection (see projectMilestoneCompact).
      const _base = getCrmBase();
      return text({ count: milestones.length, milestones: milestones.map(m => projectMilestoneCompact(m, _base, oppCustomerMap?.[m._msp_opportunityid_value] || null, ownerFilterGuid)) });
    }
  );

  // ── get_team_accounts (territory lookup via saved view) ─────
  let _cachedTeamAccountsSqId = null;
  server.tool(
    'get_team_accounts',
    "Get accounts from the user's territory via the CRM 'My Team Accounts' system view. Uses the savedQuery parameter to execute the view as the current user.",
    {
      customerKeyword: z.string().optional().describe('Case-insensitive customer name filter')
    },
    async ({ customerKeyword }) => {
      // Resolve savedquery ID (cached after first call)
      if (!_cachedTeamAccountsSqId) {
        const sqResult = await crmClient.request('savedqueries', {
          query: { $filter: "name eq 'My Team Accounts' and returnedtypecode eq 'account'", $select: 'savedqueryid', $top: '1' }
        });
        _cachedTeamAccountsSqId = sqResult.ok && sqResult.data?.value?.[0]?.savedqueryid;
        if (!_cachedTeamAccountsSqId) {
          return error("Could not find 'My Team Accounts' saved view in CRM.");
        }
      }
      const acctResult = await crmClient.requestAllPages('accounts', {
        query: { savedQuery: _cachedTeamAccountsSqId, $select: 'accountid,name,msp_mstopparentid' }
      });
      let accounts = acctResult.ok ? (acctResult.data?.value || []) : [];
      if (customerKeyword) {
        const kw = customerKeyword.toLowerCase();
        accounts = accounts.filter(a => (a.name || '').toLowerCase().includes(kw));
      }
      return text({
        count: accounts.length,
        accounts: accounts.map(a => ({ accountid: a.accountid, name: a.name, tpid: a.msp_mstopparentid || null }))
      });
    }
  );

  // ── get_my_active_opportunities ─────────────────────────────
  server.tool(
    'get_my_active_opportunities',
    'Returns your active "My Opps": the deterministic union of (1) active opportunities you OWN and (2) active opportunities where you own ≥1 ACTIVE milestone. Active = opportunity statecode 0 (open, not Won/Lost) with an estimated completion date in the recent/future window; milestone ownership requires an active milestone (excludes Completed/Cancelled/Closed/Lost/Hygiene). Does NOT include opportunities you are merely on the deal team for, nor territory-wide opportunities you neither own nor have a milestone on — use list_my_territory_opportunities / Territory View for those. Optionally filter by customer name.',
    {
      customerKeyword: z.string().optional().describe('Case-insensitive customer name filter'),
      dateRange: z.string().optional().describe('Fiscal period filter: Q1-Q4, H1-H2, FY, JUL-JUN (single month), current-Q, current-H, current-M, current-FY (relative to now), OR absolute: FY26 / FY27 (whole year) / FY27-Q1 / FY27-H2 / FY27-AUG.')
    },
    async ({ customerKeyword, dateRange }) => {
      const whoAmI = await crmClient.request('WhoAmI');
      if (!whoAmI.ok || !whoAmI.data?.UserId) {
        return error(`Unable to resolve current CRM user (${whoAmI.status}): ${whoAmI.data?.message || 'WhoAmI failed'}`);
      }
      const userId = normalizeGuid(whoAmI.data.UserId);

      // 1. Owned opportunities
      let oppDateFilter;
      if (dateRange) {
        // Only require the opportunity to still be active during the period (completion >= period start).
        // Avoid filtering by end date — consumption opps often close well after the target quarter.
        const { start } = getMsFiscalRange(dateRange);
        oppDateFilter = `msp_estcompletiondate ge ${start}`;
      } else {
        oppDateFilter = `msp_estcompletiondate ge ${daysAgo(30)}`;
      }
      const ownedResult = await crmClient.requestAllPages('opportunities', {
        query: { $filter: `_ownerid_value eq '${userId}' and statecode eq 0 and ${oppDateFilter}`, $select: OPP_SELECT, $orderby: 'name' }
      });
      const ownedOpps = (ownedResult.ok ? ownedResult.data?.value : []) || [];
      const ownedIds = new Set(ownedOpps.map(o => o.opportunityid));

      // 2. Discover opps where the user OWNS ≥1 ACTIVE milestone.
      //    This is the "milestone owner" half of "My Opps" — you have real work on
      //    the opp via a milestone you own. It is queried DETERMINISTICALLY every
      //    time (not just as a fallback), so the result never depends on whether an
      //    unrelated entity (previously msp_dealteams) is queryable.
      //    Only ACTIVE milestones qualify (excludes Completed/Cancelled/Closed as
      //    Incomplete/Lost/Hygiene) — matching the "active" contract of My Opps.
      const milestoneOppIds = [];
      const msOwnResult = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: { $filter: `_ownerid_value eq '${userId}'`, $select: '_msp_opportunityid_value,msp_milestonestatus' }
      });
      if (msOwnResult.ok && msOwnResult.data?.value) {
        for (const m of msOwnResult.data.value) {
          if (!ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus'))) continue; // active milestones only
          const oppId = m._msp_opportunityid_value;
          if (oppId && !ownedIds.has(oppId) && !milestoneOppIds.includes(oppId)) milestoneOppIds.push(oppId);
        }
      }

      // 3. Fetch the milestone-owned opportunities. The active-state + date filter is
      //    re-applied at the OPPORTUNITY level, so a milestone you own on a
      //    Won/Lost/expired opp never leaks in (the milestone query only sees
      //    _ownerid_value, not the parent opp's statecode). Chunked to 25 ids per
      //    request to stay within OData filter limits.
      let milestoneOpps = [];
      if (milestoneOppIds.length) {
        for (let i = 0; i < milestoneOppIds.length; i += 25) {
          const chunk = milestoneOppIds.slice(i, i + 25);
          const msFilter = chunk.map(id => `opportunityid eq '${id}'`).join(' or ');
          const msOppResult = await crmClient.requestAllPages('opportunities', {
            query: { $filter: `(${msFilter}) and statecode eq 0 and ${oppDateFilter}`, $select: OPP_SELECT, $orderby: 'name' }
          });
          if (msOppResult.ok && msOppResult.data?.value) milestoneOpps.push(...msOppResult.data.value);
        }
      }

      // 4. Combine and tag. "My Opps" = active opps you OWN ∪ active opps where you
      //    own an active milestone. No deal-team-membership expansion and no
      //    territory dump — those made the view non-deterministic and surfaced opps
      //    you neither own nor have a milestone on. Territory-wide visibility lives
      //    in the dedicated Territory View (list_my_territory_opportunities).
      const base = getCrmBase();
      let opportunities = [
        ...ownedOpps.map(o => ({
          ...o,
          customer: fv(o, '_parentaccountid_value') || null,
          relationship: 'owner',
          recordUrl: buildRecordUrl(base, 'opportunity', o.opportunityid)
        })),
        ...milestoneOpps.map(o => ({
          ...o,
          customer: fv(o, '_parentaccountid_value') || null,
          relationship: 'milestone',
          recordUrl: buildRecordUrl(base, 'opportunity', o.opportunityid)
        }))
      ];

      // 5. Filter by customerKeyword
      if (customerKeyword) {
        const kw = customerKeyword.toLowerCase();
        opportunities = opportunities.filter(o => (o.customer || '').toLowerCase().includes(kw));
      }

      // 6. Aggregate per-opp seats (usage) + monthlyUse/ACR (consumption) from
      //    milestones in ONE batch query, so chat can show a type-appropriate
      //    metric instead of "$0.00" for usage/consumption opps (OPP_SELECT has no seats).
      const metricsByOpp = await aggregateOppMetrics(crmClient, opportunities.map(o => o.opportunityid));
      opportunities = opportunities.map(o => {
        const agg = metricsByOpp[o.opportunityid] || { seats: 0, monthlyUse: 0 };
        return { ...o, seats: agg.seats, monthlyUse: agg.monthlyUse };
      });

      return text({ count: opportunities.length, opportunities });
    }
  );

  // ── list_my_territory_opportunities ─────────────────────────
  server.tool(
    'list_my_territory_opportunities',
    'List ALL opportunities in your territory (via "My Team Accounts" saved view), regardless of owner. Useful for territory-wide views where you want to see opportunities you do NOT own. Supports filtering by opportunity type (billed/consumption/all), fiscal date range, and state (open/won/lost). Includes Owner column since results are multi-owner. Applies billed FY window filter to prevent cross-FY leakage.',
    {
      oppType: z
        .enum(['billed', 'consumption', 'all'])
        .optional()
        .describe('Opportunity type filter: billed (606820000), consumption (606820001), or all (default)'),
      dateRange: z
        .string()
        .optional()
        .describe('Fiscal period filter: Q1-Q4, H1-H2, FY, JUL-JUN (single month), current-Q, current-H, current-M, current-FY (relative to now), OR absolute: FY26 / FY27 (whole year) / FY27-Q1 / FY27-H2 / FY27-AUG. For billed opps, applies upper-bound FY window rule.'),
      status: z
        .enum(['open', 'won', 'lost', 'all'])
        .optional()
        .describe('Opportunity state filter (default: open)'),
    },
    async ({ oppType, dateRange, status }) => {
      // 1. Resolve territory accounts via "My Team Accounts" saved view
      let sqId = _cachedTeamAccountsSqId;
      if (!sqId) {
        const sqResult = await crmClient.request('savedqueries', {
          query: { $filter: "name eq 'My Team Accounts' and returnedtypecode eq 'account'", $select: 'savedqueryid', $top: '1' }
        });
        sqId = sqResult.ok && sqResult.data?.value?.[0]?.savedqueryid;
        if (sqId) _cachedTeamAccountsSqId = sqId;
        if (!sqId) return error("Could not find 'My Team Accounts' saved view in CRM.");
      }

      const acctResult = await crmClient.requestAllPages('accounts', {
        query: { savedQuery: sqId, $select: 'accountid,name,msp_mstopparentid' }
      });
      if (!acctResult.ok) {
        return error(`Territory accounts query failed (${acctResult.status}): ${acctResult.data?.message || 'unknown'}`);
      }
      const teamAccounts = acctResult.data?.value || [];
      if (teamAccounts.length === 0) {
        return text({ count: 0, opportunities: [], message: 'No team accounts found in your territory.' });
      }

      // 2. Build opportunity filter
      const acctIds = teamAccounts.map(a => a.accountid);
      const acctFilter = acctIds.map(id => `_parentaccountid_value eq '${id}'`).join(' or ');
      const filters = [`(${acctFilter})`];

      // State filter
      const stateCode = status === 'won' ? 1 : status === 'lost' ? 2 : status === 'all' ? undefined : 0;
      if (stateCode !== undefined) filters.push(`statecode eq ${stateCode}`);

      // Opportunity type filter (msp_opportunitytype is Edm.String with numeric code as text)
      if (oppType === 'billed') {
        filters.push(`msp_opportunitytype eq '606820000'`);
      } else if (oppType === 'consumption') {
        filters.push(`msp_opportunitytype eq '606820001'`);
      }

      // Date range filter (lower bound only for consumption — billed gets upper bound client-side)
      let fiscalRange = null;
      if (dateRange) {
        fiscalRange = getMsFiscalRange(dateRange);
        filters.push(`msp_estcompletiondate ge ${fiscalRange.start}`);
      }

      const oppResult = await crmClient.requestAllPages('opportunities', {
        query: { $filter: filters.join(' and '), $select: OPP_SELECT, $orderby: 'estimatedvalue desc' }
      });
      if (!oppResult.ok) {
        return error(`Territory opportunity query failed (${oppResult.status}): ${oppResult.data?.message || 'unknown'}`);
      }
      let opps = oppResult.data?.value || [];

      // 3. Apply billed FY window upper-bound filter client-side (gate caution — prevent cross-FY leakage)
      if (oppType === 'billed' && fiscalRange) {
        const { end } = fiscalRange;
        opps = opps.filter(o => {
          const closeStr = o.estimatedclosedate || o.msp_estcompletiondate;
          if (!closeStr) return true; // no date → keep
          return closeStr <= end;
        });
      }

      // 4. Deduplicate by opportunity ID (in case of data anomalies)
      const seen = new Set();
      opps = opps.filter(o => {
        if (seen.has(o.opportunityid)) return false;
        seen.add(o.opportunityid);
        return true;
      });

      // 5. Enrich with owner names (multi-owner view — owner column is expected)
      const ownerIds = [...new Set(opps.map(o => o._ownerid_value).filter(Boolean))];
      const ownerNameById = new Map();
      if (ownerIds.length > 0) {
        const ownerChunks = chunkArray(ownerIds, 25);
        for (const chunk of ownerChunks) {
          const ownerFilter = chunk.map(id => `systemuserid eq '${id}'`).join(' or ');
          const ownerResult = await crmClient.requestAllPages('systemusers', {
            query: { $filter: ownerFilter, $select: 'systemuserid,fullname' }
          });
          if (ownerResult.ok && ownerResult.data?.value) {
            for (const u of ownerResult.data.value) {
              ownerNameById.set(u.systemuserid, u.fullname);
            }
          }
        }
      }

      const base = getCrmBase();
      auditLog({
        tool: 'list_my_territory_opportunities',
        entitySet: 'opportunities',
        params: { oppType, dateRange, status },
        recordCount: opps.length,
      });

      return text({
        count: opps.length,
        opportunities: opps.map((o, i) => ({
          index: i + 1,
          opportunityNumber: o.msp_opportunitynumber || null,
          name: o.name,
          customer: fv(o, '_parentaccountid_value') || null,
          owner: ownerNameById.get(o._ownerid_value) || fv(o, '_ownerid_value') || null,
          estimatedValue: o.estimatedvalue || 0,
          estCompletionDate: o.msp_estcompletiondate || o.estimatedclosedate || null,
          salesPlay: fv(o, 'msp_salesplay') || null,
          solutionArea: fv(o, 'msp_solutionarea') || null,
          stage: fv(o, 'msp_activesalesstage') || null,
          type: fv(o, 'msp_opportunitytype') || null,
          recordUrl: buildRecordUrl(base, 'opportunity', o.opportunityid),
        })),
      });
    }
  );

  // ── pipeline_health ──────────────────────────────────────
  server.tool(
    'pipeline_health',
    'Run a full MCEM pipeline health check. Analyzes the UNION of (1) all milestones on opportunities you own and (2) all milestones where you are the owner — deduplicated. Checks: overdue milestones (UC1), active opps with no active milestones (UC4, shows last completed milestone), milestones expiring within 14 days (UC7), your opps in non-CSU MCEM stages (UC8), committed Production milestones on your opps owned by a non-CSU member (UC9a — flags only genuine STU→CSU handoff misses, not valid CSA/CSAM collaboration), POC/Pilot milestones wrongly owned by you instead of SE/STU (UC9b), and Blocked milestones you own that should be reviewed in your weekly RoB or escalated to the account team (UC10).',
    {},
    async () => {
      // Step 1: Who am I?
      const whoAmI = await crmClient.request('WhoAmI');
      if (!whoAmI.ok || !whoAmI.data?.UserId) {
        return error(`Unable to resolve current CRM user: ${whoAmI.data?.message || 'WhoAmI failed'}`);
      }
      const userId = normalizeGuid(whoAmI.data.UserId);
      const crmBase = getCrmBase();

      // Steps 2–5: Fetch active opps + deduplicated milestones (shared with handoff_check / stage_map)
      const { myOpps, myOppMap, allMilestones, activeMilestones, allOppMap } =
        await fetchUserPipelineData(crmClient, userId);

      // Step 5: Date helpers
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const plus14 = new Date(now);
      plus14.setDate(plus14.getDate() + 14);
      const plus14Str = `${plus14.getFullYear()}-${pad(plus14.getMonth() + 1)}-${pad(plus14.getDate())}`;

      // msp_milestonecategory option-set codes (from CRM metadata / MSX-IQ discovery)
      const CAT_POC_PILOT = 861980000;
      const CAT_PRODUCTION = 861980002;
      const catCode = m => {
        const raw = m.msp_milestonecategory;
        return typeof raw === 'number' ? raw : parseInt(raw, 10);
      };

      // ── UC1: Overdue milestones (date past today, not terminal) ──────────────
      const uc1_overdue = activeMilestones
        .filter(m => !isDoneMilestone(m) && m.msp_milestonedate && m.msp_milestonedate < todayStr)
        .map(m => compactMs(m, crmBase, allOppMap));
      uc1_overdue.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      // ── UC4: Active opp (owned by me) with no active milestone ──────────────
      // Group all milestones (including terminal) per opp for "last completed" lookup
      const allMsByOpp = {};
      for (const m of allMilestones) {
        const id = m._msp_opportunityid_value;
        if (!id) continue;
        if (!allMsByOpp[id]) allMsByOpp[id] = [];
        allMsByOpp[id].push(m);
      }
      const activeMsByOpp = {};
      for (const m of activeMilestones) {
        if (isDoneMilestone(m)) continue;
        const id = m._msp_opportunityid_value;
        if (!id) continue;
        if (!activeMsByOpp[id]) activeMsByOpp[id] = [];
        activeMsByOpp[id].push(m);
      }

      const uc4_oppsNoActiveMilestone = myOpps
        .filter(o => !(activeMsByOpp[o.opportunityid]?.length > 0))
        .map(o => {
          const oppId = o.opportunityid;
          const completed = (allMsByOpp[oppId] || [])
            .filter(m => fv(m, 'msp_milestonestatus') === 'Completed')
            .sort((a, b) => (b.msp_milestonedate || '').localeCompare(a.msp_milestonedate || ''));
          const lastCompleted = completed[0]
            ? {
                name: completed[0].msp_name,
                date: completed[0].msp_milestonedate,
                recordUrl: buildRecordUrl(crmBase, 'msp_engagementmilestone', completed[0].msp_engagementmilestoneid)
              }
            : null;
          return {
            opportunityId: oppId,
            name: o.name || null,
            opportunityNumber: o.msp_opportunitynumber || null,
            customer: fv(o, '_parentaccountid_value') || null,
            stage: fv(o, 'msp_activesalesstage') || null,
            totalMilestones: (allMsByOpp[oppId] || []).length,
            lastCompletedMilestone: lastCompleted,
            recordUrl: buildRecordUrl(crmBase, 'opportunity', oppId)
          };
        });

      // ── UC7: Expiring within 14 days (not yet overdue, not terminal) ─────────
      const uc7_expiringSoon = activeMilestones
        .filter(m => !isDoneMilestone(m) && m.msp_milestonedate && m.msp_milestonedate >= todayStr && m.msp_milestonedate <= plus14Str)
        .map(m => compactMs(m, crmBase, allOppMap));
      uc7_expiringSoon.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      // ── UC8: My opp in non-CSU MCEM stage (stages 1–3 belong to ATU/STU) ────
      const uc8_wrongStage = myOpps
        .filter(o => {
          const stage = parseSalesStageNumber(o);
          return stage !== null && stage <= 3;
        })
        .map(o => ({
          opportunityId: o.opportunityid,
          name: o.name || null,
          opportunityNumber: o.msp_opportunitynumber || null,
          customer: fv(o, '_parentaccountid_value') || null,
          stage: fv(o, 'msp_activesalesstage') || null,
          stageNumber: parseSalesStageNumber(o),
          recordUrl: buildRecordUrl(crmBase, 'opportunity', o.opportunityid)
        }));

      // ── UC9a: Committed Production milestone on MY opp — owner is non-CSU ────
      // Flags genuine STU→CSU handoff misses; skips valid CSAM↔CSA collaboration
      const uc9a_missedHandoff = await (async () => {
        // Step 1: pre-filter candidates (same 4 conditions + owner ≠ me)
        const candidates = activeMilestones.filter(m => {
          const oppId = m._msp_opportunityid_value;
          if (!oppId || !myOppMap[oppId]) return false;
          if (isDoneMilestone(m)) return false;
          if (catCode(m) !== CAT_PRODUCTION) return false;
          if (commitmentLabel(m).toLowerCase() !== 'committed') return false;
          return m._ownerid_value !== userId;
        });

        if (candidates.length === 0) return [];

        // Step 2: collect unique owner GUIDs
        const ownerGuids = [...new Set(candidates.map(m => m._ownerid_value).filter(Boolean))];

        // Step 3: batch-fetch systemusers in chunks of 25 to get msp_rolegroup
        const ownerDeptMap = {};
        const CHUNK = 25;
        for (let i = 0; i < ownerGuids.length; i += CHUNK) {
          const chunk = ownerGuids.slice(i, i + CHUNK);
          const chunkFilter = chunk.map(id => `systemuserid eq '${id}'`).join(' or ');
          const userResult = await crmClient.requestAllPages('systemusers', {
            query: { $filter: `(${chunkFilter})`, $select: 'systemuserid,msp_rolegroup' }
          });
          if (userResult.ok && userResult.data?.value) {
            for (const u of userResult.data.value) {
              ownerDeptMap[u.systemuserid] = u.msp_rolegroup || null;
            }
          }
          // On non-ok response: silently continue with empty entries (fail-open)
        }

        // Step 4: keep only candidates whose owner is not CSU.
        // If the role lookup failed (key not in map) or resolved to null (user found
        // but msp_rolegroup missing), include the milestone with lookupWarning: true
        // so consumers know the flagging may not be reliable. Never silently flag or
        // silently drop milestones whose owner role is unknown.
        return candidates.reduce((acc, m) => {
          const ownerId = m._ownerid_value;
          const roleResolved = ownerId in ownerDeptMap;
          const roleGroup = ownerDeptMap[ownerId];
          if (!roleResolved || roleGroup === null) {
            acc.push({
              ...compactMs(m, crmBase, allOppMap),
              currentOwner: fv(m, '_ownerid_value') || null,
              lookupWarning: true,
              warningReason: 'Owner role could not be resolved — possible false positive'
            });
          } else if (roleGroup !== 'CSU') {
            acc.push({ ...compactMs(m, crmBase, allOppMap), currentOwner: fv(m, '_ownerid_value') || null });
          }
          return acc;
        }, []);
      })();

      // ── UC9b: POC/Pilot milestone owned by me — CSU should NOT own these ────
      // Per MCEM §6 Milestone Ownership Matrix: in Stage 3 (Empower & Achieve),
      // committed milestones ARE legitimately owned by CSAM/CSA (CSU). Only
      // uncommitted POC/Pilot milestones are a wrong-owner signal. commitmentBucket()
      // treats both "Committed" and "Best Case" as committed, covering all live values.
      const uc9b_pocPilotWrongOwner = activeMilestones
        .filter(m => !isDoneMilestone(m) && catCode(m) === CAT_POC_PILOT && m._ownerid_value === userId && commitmentBucket(m) !== 'Committed')
        .map(m => compactMs(m, crmBase, allOppMap));

      // ── UC10: Blocked milestone I own — should be escalated to ATU ──────────
      const uc10_blockedOwnedByMe = activeMilestones
        .filter(m => !isDoneMilestone(m) && fv(m, 'msp_milestonestatus') === 'Blocked' && m._ownerid_value === userId)
        .map(m => compactMs(m, crmBase, allOppMap));

      // ── Summary ──────────────────────────────────────────────────────────────
      const totalIssues =
        uc1_overdue.length + uc4_oppsNoActiveMilestone.length + uc7_expiringSoon.length +
        uc8_wrongStage.length + uc9a_missedHandoff.length + uc9b_pocPilotWrongOwner.length +
        uc10_blockedOwnedByMe.length;

      const now2 = new Date();
      const pad2 = n => String(n).padStart(2, '0');
      const asOf = `${now2.getFullYear()}-${pad2(now2.getMonth() + 1)}-${pad2(now2.getDate())}`;

      const rawScore =
        uc1_overdue.length * 10 +
        uc9a_missedHandoff.length * 8 +
        uc10_blockedOwnedByMe.length * 7 +
        uc9b_pocPilotWrongOwner.length * 5 +
        uc4_oppsNoActiveMilestone.length * 4 +
        uc8_wrongStage.length * 3 +
        uc7_expiringSoon.length * 2;
      // issueScore is a WEIGHTED issue-burden score (higher = worse), capped at 100.
      // It is NOT a health percentage. Renamed from healthScore so it is never
      // mistaken for "score/100"; present pipeline health as "{totalIssues} issues — grade {healthGrade}".
      const issueScore = Math.min(100, rawScore);
      const issueScoreMax = 100;
      const healthGrade =
        issueScore === 0 ? 'A' :
        issueScore <= 10 ? 'B' :
        issueScore <= 25 ? 'C' :
        issueScore <= 50 ? 'D' : 'F';

      return text({
        healthStatus: totalIssues === 0 ? 'healthy' : totalIssues <= 3 ? 'attention_needed' : 'unhealthy',
        // Unambiguous, deterministic presentation — lead with the issue COUNT + grade,
        // never a misleading "{score}/100".
        summary: `${totalIssues} issues — grade ${healthGrade}`,
        totalIssues,
        healthGrade,
        issueScore,
        issueScoreMax,
        scope: {
          myOppsAnalyzed: myOpps.length,
          totalMilestonesAnalyzed: activeMilestones.length,
          asOf
        },
        findings: {
          overdue: { label: 'Overdue milestones', count: uc1_overdue.length, items: uc1_overdue },
          expiringSoon: { label: 'Expiring within 14 days', count: uc7_expiringSoon.length, items: uc7_expiringSoon },
          oppsWithoutActiveMilestone: { label: 'Active opps with no active milestone', count: uc4_oppsNoActiveMilestone.length, items: uc4_oppsNoActiveMilestone },
          wrongStageOpps: { label: 'Your opps in non-CSU MCEM stage (1–3)', count: uc8_wrongStage.length, items: uc8_wrongStage },
          committedProductionNotTransferred: { label: 'Committed Production milestone on your opp owned by non-CSU (missed STU→CSU handoff)', count: uc9a_missedHandoff.length, items: uc9a_missedHandoff },
          pocPilotWrongOwner: { label: 'POC/Pilot milestone you own — should belong to SE/STU', count: uc9b_pocPilotWrongOwner.length, items: uc9b_pocPilotWrongOwner },
          blockedMilestones: { label: 'Blocked milestones you own — consider escalating to ATU', count: uc10_blockedOwnedByMe.length, items: uc10_blockedOwnedByMe }
        }
      });
    }
  );

  // ── handoff_check ─────────────────────────────────────────
  server.tool(
    'handoff_check',
    'Evaluates all active opportunities and their milestones against the MCEM 8-scenario ownership matrix (stage × commitment status → expected role group) to detect MCEM handoff violations. Specifically catches: ATU→STU handoffs not completed (Stage 2–3 milestones still owned by ATU instead of STU/SSP), STU→CSU handoffs not completed (committed milestones owned by STU or ATU instead of CSU/CSAM/CSA), CSU ownership of uncommitted milestones in Stages 1–3 (cross-org contamination), and Stage 4–5 milestones not owned by CSU. Returns violations grouped by severity (high = missed committed handoff or pre-STU work still ATU-owned; medium = other mismatches), each with current owner, current role group, expected role group, stage, and scenario label. Milestones with missing role data go to warnings — zero false positives. Use this tool when the user asks about: ownership violations, wrong person on an opportunity or milestone, incomplete handoffs, role transitions, ATU→STU or STU→CSU handoffs, MCEM compliance, or who should own what. Prefer this over pipeline_health when the question is specifically about role ownership or handoff completeness rather than dates, overdue status, or general health.',
    {},
    async () => {
      const whoAmI = await crmClient.request('WhoAmI');
      if (!whoAmI.ok || !whoAmI.data?.UserId) {
        return error(`Unable to resolve current CRM user: ${whoAmI.data?.message || 'WhoAmI failed'}`);
      }
      const userId = normalizeGuid(whoAmI.data.UserId);
      const crmBase = getCrmBase();

      const { myOpps, activeMilestones, allOppMap } = await fetchUserPipelineData(crmClient, userId);

      // Batch-fetch role groups for all unique milestone owners
      const allOwnerIds = [...new Set(activeMilestones.map(m => m._ownerid_value).filter(Boolean))];
      const ownerInfoMap = {}; // systemuserid → { role, name }
      const CHUNK = 25;
      for (let i = 0; i < allOwnerIds.length; i += CHUNK) {
        const chunk = allOwnerIds.slice(i, i + CHUNK);
        const chunkFilter = chunk.map(id => `systemuserid eq '${id}'`).join(' or ');
        const res = await crmClient.requestAllPages('systemusers', {
          query: { $filter: `(${chunkFilter})`, $select: 'systemuserid,fullname,msp_rolegroup' }
        });
        if (res.ok && res.data?.value) {
          for (const u of res.data.value) {
            ownerInfoMap[u.systemuserid] = { role: u.msp_rolegroup || null, name: u.fullname || null };
          }
        }
      }

      const STAGE_NAMES = {
        1: 'Listen & Consult', 2: 'Inspire & Design', 3: 'Empower & Achieve',
        4: 'Realize Value', 5: 'Manage & Optimize'
      };

      const violations = [];
      const warnings = [];

      for (const m of activeMilestones) {
        if (isDoneMilestone(m)) continue;

        const oppId = m._msp_opportunityid_value;
        const opp = allOppMap[oppId];
        if (!opp) continue;

        const stage = parseSalesStageNumber(opp);
        if (stage === null) continue; // ambiguous — skip safely

        const committed = commitmentBucket(m) === 'Committed';
        const expectedRole = expectedRoleForMilestone(stage, committed);
        if (!expectedRole) continue;

        const ownerId = m._ownerid_value;
        if (!ownerId) continue;

        const resolved = ownerId in ownerInfoMap;
        const ownerInfo = ownerInfoMap[ownerId];
        const actualRole = ownerInfo?.role ?? null;

        if (!resolved || actualRole === null) {
          warnings.push({
            opportunityName: opp.name || null,
            opportunityUrl: buildRecordUrl(crmBase, 'opportunity', oppId),
            milestoneName: m.msp_name || null,
            note: 'roleGroupMissing — could not verify ownership (data gap)',
            roleGroupMissing: true
          });
          continue;
        }

        if (actualRole === expectedRole) continue;

        // Build scenario description from MCEM transition rules
        let scenario;
        if (stage <= 3 && !committed && actualRole === 'ATU') {
          scenario = `Stage ${stage} (${STAGE_NAMES[stage]}) uncommitted — ATU→STU handoff incomplete`;
        } else if (stage <= 3 && !committed && actualRole === 'CSU') {
          scenario = `Stage ${stage} (${STAGE_NAMES[stage]}) uncommitted — CSU should not own uncommitted milestone (STU expected)`;
        } else if (committed && actualRole === 'ATU') {
          scenario = `Committed milestone — ATU→CSU handoff incomplete`;
        } else if (committed && actualRole === 'STU') {
          scenario = `Committed milestone — STU→CSU handoff incomplete`;
        } else if ((stage === 4 || stage === 5) && actualRole !== 'CSU') {
          scenario = `Stage ${stage} (${STAGE_NAMES[stage]}) — ${actualRole}→CSU handoff incomplete`;
        } else if (stage === 1 && actualRole !== 'ATU') {
          scenario = `Stage 1 (Listen & Consult) — milestone owned by ${actualRole} (expected ATU)`;
        } else {
          scenario = `Stage ${stage} (${STAGE_NAMES[stage]}) — ${actualRole} owns milestone (expected ${expectedRole})`;
        }

        // Severity: high for clear missed handoffs on committed or pre-STU work, medium otherwise
        const severity =
          (committed && actualRole !== 'CSU') ||
          (stage >= 2 && stage <= 3 && !committed && actualRole === 'ATU')
            ? 'high' : 'medium';

        violations.push({
          opportunityName: opp.name || null,
          opportunityUrl: buildRecordUrl(crmBase, 'opportunity', oppId),
          customer: fv(opp, '_parentaccountid_value') || null,
          stage,
          stageName: STAGE_NAMES[stage] || null,
          milestoneName: m.msp_name || null,
          milestoneUrl: buildRecordUrl(crmBase, 'msp_engagementmilestone', m.msp_engagementmilestoneid),
          id: m.msp_engagementmilestoneid,
          currentOwner: ownerInfo?.name || fv(m, '_ownerid_value') || null,
          currentRoleGroup: actualRole,
          expectedRoleGroup: expectedRole,
          scenario,
          severity,
          committed
        });
      }

      const summary = {
        total_opps_checked: myOpps.length,
        violations_found: violations.length,
        warnings: warnings.length
      };
      return text(formatHandoffCheckOutput(violations, warnings, summary));
    }
  );

  // ── stage_map ──────────────────────────────────────────────
  server.tool(
    'stage_map',
    'Groups all active opportunities by MCEM stage (1 = Listen & Consult, 2 = Inspire & Design, 3 = Empower & Achieve, 4 = Realize Value, 5 = Manage & Optimize). For each stage, returns the list of opportunities with: owner name, role group (ATU/STU/CSU), committed milestone count, uncommitted milestone count, total milestone count, and an ownershipAlert flag when the opportunity owner\'s role group does not match the expected group for that stage (ATU for Stage 1, STU for Stages 2–3, CSU for Stages 4–5). Also flags stages with zero opportunity coverage. Use this tool when the user asks for: a pipeline overview by stage, pipeline distribution across MCEM stages, who owns what in each stage, stage coverage gaps, or wants to see their full pipeline organized by MCEM progression. Prefer this over crm_query when the request is about stage-level grouping or coverage rather than filtering individual records.',
    {},
    async () => {
      const whoAmI = await crmClient.request('WhoAmI');
      if (!whoAmI.ok || !whoAmI.data?.UserId) {
        return error(`Unable to resolve current CRM user: ${whoAmI.data?.message || 'WhoAmI failed'}`);
      }
      const userId = normalizeGuid(whoAmI.data.UserId);
      const crmBase = getCrmBase();

      const { myOpps, activeMilestones, allOppMap } = await fetchUserPipelineData(crmClient, userId);

      // Batch-fetch role groups for all unique opp owners
      const oppOwnerIds = [...new Set(myOpps.map(o => o._ownerid_value).filter(Boolean))];
      const ownerInfoMap = {};
      const CHUNK = 25;
      for (let i = 0; i < oppOwnerIds.length; i += CHUNK) {
        const chunk = oppOwnerIds.slice(i, i + CHUNK);
        const chunkFilter = chunk.map(id => `systemuserid eq '${id}'`).join(' or ');
        const res = await crmClient.requestAllPages('systemusers', {
          query: { $filter: `(${chunkFilter})`, $select: 'systemuserid,fullname,msp_rolegroup' }
        });
        if (res.ok && res.data?.value) {
          for (const u of res.data.value) {
            ownerInfoMap[u.systemuserid] = { role: u.msp_rolegroup || null, name: u.fullname || null };
          }
        }
      }

      const STAGE_NAMES = {
        1: 'Listen & Consult', 2: 'Inspire & Design', 3: 'Empower & Achieve',
        4: 'Realize Value', 5: 'Manage & Optimize'
      };
      // Expected opp owner role per stage (per MCEM §3 Quick Reference)
      const STAGE_EXPECTED_ROLE = { 1: 'ATU', 2: 'STU', 3: 'STU', 4: 'CSU', 5: 'CSU' };

      // Index active (non-terminal) milestones by opp, tracking committed/uncommitted counts
      const msByOpp = {};
      for (const m of activeMilestones) {
        const oppId = m._msp_opportunityid_value;
        if (!oppId) continue;
        if (isDoneMilestone(m)) continue;
        if (!msByOpp[oppId]) msByOpp[oppId] = { committed: 0, uncommitted: 0 };
        if (commitmentBucket(m) === 'Committed') msByOpp[oppId].committed++;
        else msByOpp[oppId].uncommitted++;
      }

      // Build stage groups (1–5)
      const stageGroups = {};
      for (let s = 1; s <= 5; s++) {
        stageGroups[s] = {
          stageName: STAGE_NAMES[s],
          expectedRoleGroup: STAGE_EXPECTED_ROLE[s],
          opportunities: [],
          summary: { total_opps: 0, with_milestones: 0, without_milestones: 0 }
        };
      }

      // Opps without a parseable stage — captured separately so they aren't silently dropped
      const unknownStageOpps = [];

      for (const opp of myOpps) {
        const stage = parseSalesStageNumber(opp);
        const oppId = opp.opportunityid;
        const ownerId = opp._ownerid_value;
        const ownerInfo = ownerInfoMap[ownerId] || null;
        const ownerRoleGroup = ownerInfo?.role || null;

        const msCounts = msByOpp[oppId] || { committed: 0, uncommitted: 0 };
        const msTotal = msCounts.committed + msCounts.uncommitted;

        const oppEntry = {
          opportunityId: oppId,
          name: opp.name || null,
          customer: fv(opp, '_parentaccountid_value') || null,
          owner: ownerInfo?.name || fv(opp, '_ownerid_value') || null,
          ownerRoleGroup,
          milestones: { committed: msCounts.committed, uncommitted: msCounts.uncommitted, total: msTotal },
          ownershipAlert: ownerRoleGroup !== null && stageGroups[stage]
            ? ownerRoleGroup !== STAGE_EXPECTED_ROLE[stage]
            : false,
          recordUrl: buildRecordUrl(crmBase, 'opportunity', oppId)
        };

        if (!stage || !stageGroups[stage]) {
          unknownStageOpps.push(oppEntry);
          continue;
        }

        stageGroups[stage].opportunities.push(oppEntry);
        stageGroups[stage].summary.total_opps++;
        if (msTotal > 0) stageGroups[stage].summary.with_milestones++;
        else stageGroups[stage].summary.without_milestones++;
      }

      const stagesWithCoverage = [];
      const stagesWithoutCoverage = [];
      for (let s = 1; s <= 5; s++) {
        if (stageGroups[s].summary.total_opps > 0) stagesWithCoverage.push(s);
        else stagesWithoutCoverage.push(s);
      }

      // Convert numeric keys to string keys for JSON output
      const stages = {};
      for (let s = 1; s <= 5; s++) stages[String(s)] = stageGroups[s];

      const meta = {
        total_opps: myOpps.length,
        stages_with_coverage: stagesWithCoverage,
        stages_without_coverage: stagesWithoutCoverage
      };
      return text(formatStageMapOutput(stages, unknownStageOpps.length > 0 ? unknownStageOpps : null, meta));
    }
  );

  // ── mcem_stage_lookup_search ────────────────────────────────
  server.tool(
    'mcem_stage_lookup_search',
    'Search whitelisted MCEM stage blocker lookup options. Only supports known blocker lookups such as Customer Decision Maker and Primary Competitor; returns human-readable labels plus selected ids/bind paths.',
    {
      field: z.enum(['parentcontactid', 'msp_primarycompetitor']).describe('Whitelisted lookup blocker field to search'),
      term: z.string().optional().describe('Search text typed by the user'),
      q: z.string().optional().describe('Alias for term from typeahead controls'),
      opportunityId: z.string().optional().describe('Opportunity GUID for account-scoped lookup context'),
      accountId: z.string().optional().describe('Optional account GUID context for contact lookup'),
      entitySet: z.string().optional().describe('Expected entity set from the preflight lookup contract'),
      limit: z.number().optional().describe('Maximum options to return, capped at 50'),
      skip: z.number().optional().describe('Optional offset for simple single-source pagination')
    },
    async ({ field, term = '', opportunityId, accountId, entitySet, limit = 25, skip = 0 }) => {
      const oppNid = opportunityId ? normalizeGuid(opportunityId) : null;
      const acctNid = accountId ? normalizeGuid(accountId) : null;
      if (opportunityId && !isValidGuid(oppNid)) return error('Invalid opportunityId GUID');
      if (accountId && !isValidGuid(acctNid)) return error('Invalid accountId GUID');

      const result = await searchMcemLookupOptions(crmClient, {
        field,
        term,
        opportunityId: oppNid,
        accountId: acctNid,
        entitySet,
        limit,
        skip
      });
      if (!result.ok) return error(result.error);
      return text(result);
    }
  );



  // ── crm_creation_lookup_search ──────────────────────────────
  server.tool(
    'crm_creation_lookup_search',
    'Search whitelisted Dataverse lookup values for create-opportunity and create-milestone modals, plus return the dynamic Solution Area -> Sales Play map.',
    {
      entity: z.enum(['account', 'currency', 'transactioncurrency', 'transactioncurrencyid', 'systemuser', 'owner', 'workload', 'msp_workload', 'msdyn_workload', 'msp_workloadlk', 'msp_Workloadlk', 'msp_workloadlkid', 'msp_WorkloadlkId', 'opportunity', 'contact', 'competitor', 'licensingprogram', 'solutionAreaSalesPlay']).describe('Lookup entity or special mapping mode'),
      term: z.string().optional().describe('Search text typed by the user'),
      q: z.string().optional().describe('Alias for term from typeahead controls'),
      context: z.object({}).passthrough().optional().describe('Optional context: accountId/opportunityId/solutionArea'),
      accountId: z.string().optional().describe('Optional account GUID context'),
      opportunityId: z.string().optional().describe('Optional opportunity GUID context'),
      limit: z.number().optional().describe('Maximum options to return, capped at 50'),
      skip: z.number().optional().describe('Offset for paging')
    },
    async ({ entity, term = '', q = '', context = {}, accountId, opportunityId, limit = 20, skip = 0 }) => {
      const mergedContext = { ...(context || {}), ...(accountId ? { accountId } : {}), ...(opportunityId ? { opportunityId } : {}) };
      if (entity === 'solutionAreaSalesPlay') {
        const result = await getSolutionAreaSalesPlayMap(crmClient, mergedContext.accountId);
        return text(result);
      }
      const result = await searchCreationLookupOptions(crmClient, { entity, term: term || q, context: mergedContext, limit, skip });
      if (!result.ok) return error(result.error);
      return text(result);
    }
  );

  // ── delete_opportunity ─────────────────────────────────────
  server.tool(
    'delete_opportunity',
    'Rollback a recently-created opportunity when the mandatory first-milestone flow is cancelled. It does not hard-delete; it closes/cancels the opportunity as Lost because normal users lack delete privilege. Safety checks: current user owns it, it was created recently, and it has no active milestones.',
    {
      opportunityId: z.string().describe('Opportunity GUID to cancel/close')
    },
    async ({ opportunityId }) => {
      const validation = await validateOpportunityDeleteRollback(crmClient, opportunityId);
      if (!validation.ok) return text({ ok: false, deleted: false, canceled: false, opportunityId: normalizeGuid(opportunityId), error: validation.error, reason: validation.reason || 'validation_failed', opportunity: validation.opportunity || null, milestones: validation.milestones || [] });

      const result = await cancelOpportunityRollback(crmClient, validation.opportunityId);
      if (!result.ok && result.status !== 204) {
        // Capture failed cancel attempt
        captureAuditRecord(
          { 
            id: `delete-opp-${validation.opportunityId}`, 
            type: 'delete_opportunity', 
            entitySet: `LoseOpportunity`, 
            method: 'POST', 
            payload: { opportunityId: validation.opportunityId }, 
            beforeState: validation.opportunity || null, 
            description: `Cancel opportunity ${validation.opportunityId}` 
          }, 
          { phase: 'failed', result: { ok: false, status: result.status }, error: result.data?.message || 'Cancel failed' }, 
          getCurrentActor()
        );
        return text({ ok: false, deleted: false, canceled: false, opportunityId: validation.opportunityId, error: result.data?.message || 'Cancel failed', reason: 'cancel_failed', status: result.status });
      }
      // Capture successful cancel
      captureAuditRecord(
        { 
          id: `delete-opp-${validation.opportunityId}`, 
          type: 'delete_opportunity', 
          entitySet: `LoseOpportunity`, 
          method: 'POST', 
          payload: { opportunityId: validation.opportunityId }, 
          beforeState: validation.opportunity || null, 
          description: `Cancel opportunity ${validation.opportunityId}` 
        }, 
        { phase: 'executed', result: { ok: true, status: result.status || 204, data: result.data } }, 
        getCurrentActor()
      );
      auditLog({ tool: 'delete_opportunity', opportunityId: validation.opportunityId, canceled: true, deleted: false });
      return text({ ok: true, deleted: false, canceled: true, opportunityId: validation.opportunityId, name: validation.opportunity?.name || null, record: result.data?.record || null, discoveredStatusCode: result.data?.discoveredStatusCode || null, message: 'Opportunity cancelled/closed.' });
    }
  );

  // ── create_opportunity_preflight ─────────────────────────────
  server.tool(
    'create_opportunity_preflight',
    'Validate a create-opportunity modal payload without writing CRM. Returns blockers, duplicate candidates, normalized payload preview, and ATU owner-disclaimer flags.',
    {
      name: z.string().optional(),
      title: z.string().optional(),
      account: z.any().optional(),
      accountId: z.any().optional(),
      parentAccountId: z.any().optional(),
      currency: z.any().optional(),
      currencyId: z.any().optional(),
      transactionCurrencyId: z.any().optional(),
      ownerMode: z.enum(['currentUser', 'other']).optional(),
      owner: z.any().optional(),
      ownerId: z.any().optional(),
      description: z.string().optional(),
      opportunityType: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
      plays: z.array(z.object({
        playValue: z.number().describe('Optionset code of the sales play'),
      })).min(1).optional().describe('Ordered list of selected plays (primary first). Backend resolves playId + globalSolutionArea from the unscoped map at preflight time.'),
      solutionArea: z.union([z.string(), z.number()]).optional().describe('Deprecated — use plays array. Kept for backward compatibility.'),
      salesPlay: z.union([z.string(), z.number()]).optional().describe('Deprecated — use plays array. Kept for backward compatibility.'),
      estimatedStartDate: z.string().optional(),
      estimatedCompletionDate: z.string().optional(),
      allowDuplicate: z.boolean().optional()
    },
    async (params) => {
      const plan = await buildOpportunityCreatePlan(crmClient, params, { allowDuplicate: Boolean(params.allowDuplicate) });
      return text(toPreflightContract(plan, 'opportunity'));
    }
  );

  // ── create_opportunity ──────────────────────────────────────
  server.tool(
    'create_opportunity',
    'Stage a multi-step opportunity create for modal-approved execution. Re-runs preflight, stages create + owner/date patch + checklist rows, and execute_operation performs the writes.',
    {
      name: z.string().optional(),
      title: z.string().optional(),
      account: z.any().optional(),
      accountId: z.any().optional(),
      parentAccountId: z.any().optional(),
      currency: z.any().optional(),
      currencyId: z.any().optional(),
      transactionCurrencyId: z.any().optional(),
      ownerMode: z.enum(['currentUser', 'other']).optional(),
      owner: z.any().optional(),
      ownerId: z.any().optional(),
      description: z.string().optional(),
      opportunityType: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
      plays: z.array(z.object({
        playValue: z.number().describe('Optionset code of the sales play'),
      })).min(1).optional().describe('Ordered list of selected plays (primary first). Backend resolves playId + globalSolutionArea from the unscoped map at preflight time.'),
      solutionArea: z.union([z.string(), z.number()]).optional().describe('Deprecated — use plays array. Kept for backward compatibility.'),
      salesPlay: z.union([z.string(), z.number()]).optional().describe('Deprecated — use plays array. Kept for backward compatibility.'),
      estimatedStartDate: z.string().optional(),
      estimatedCompletionDate: z.string().optional(),
      allowDuplicate: z.boolean().optional()
    },
    async (params) => {
      const plan = await buildOpportunityCreatePlan(crmClient, params, { allowDuplicate: Boolean(params.allowDuplicate) });
      if (!plan.canCreate) return text({ ...plan, staged: false, message: plan.duplicates?.length ? 'Duplicate candidates found. Pass allowDuplicate=true to create anyway.' : 'Resolve blockers before creating.' });
      const queue = getApprovalQueue();
      const checklistPreview = (plan.normalized.plays || []).map((p, i) => ({
        playValue: p.playValue, playId: p.playId,
        globalSolutionArea: p.globalSolutionArea ?? null, isPrimary: i === 0,
      }));
      const op = queue.stage({
        type: 'create_opportunity',
        entitySet: 'opportunities',
        method: 'POST',
        payload: {
          create: plan.normalized.payloadPreview,
          postCreatePatch: plan.normalized.postCreatePatch,
          plays: plan.normalized.plays || null,
        },
        beforeState: null,
        description: `Create opportunity "${plan.normalized.payloadPreview.name}" for ${plan.normalized.account?.name || 'selected account'}`
      });
      op.accountName = plan.normalized.account?.name || null;
      auditLog({ tool: 'create_opportunity', operationId: op.id, accountId: plan.normalized.account?.accountid || null });
      return text({
        ok: true,
        staged: true,
        operationId: op.id,
        status: 'staged',
        duplicates: plan.duplicates,
        ownerIsAtu: plan.ownerIsAtu,
        ownerRoleGroup: plan.ownerRoleGroup,
        ownerRoleUnknown: plan.ownerRoleUnknown,
        payloadPreview: plan.normalized.payloadPreview,
        postCreatePatch: plan.normalized.postCreatePatch,
        checklistPreview,
        playWarnings: plan.playWarnings || [],
        message: `Staged ${op.id}: ${op.description}. Will create opportunity + ${checklistPreview.length} checklist row(s). Approve via execute_operation or modal submit.`
      });
    }
  );
  server.tool(
    'create_milestone_preflight',
    'Validate a create-milestone modal payload without writing CRM. Returns blockers, duplicate candidates, parent opportunity date patch preview, and normalized payload preview.',
    {
      opportunityId: z.string().optional(),
      name: z.string().optional(),
      milestoneDate: z.string().optional(),
      monthlyUse: z.number().optional(),
      milestoneCategory: z.number().optional(),
      customerCommitment: z.union([z.number(), z.string()]).optional(),
      commitmentRecommendation: z.union([z.number(), z.string()]).optional(),
      milestoneStatus: z.union([z.number(), z.string()]).optional(),
      milestoneStatusReason: z.union([z.number(), z.string()]).optional(),
      milestoneComments: z.string().optional(),
      workloadId: z.any().optional(),
      workload: z.any().optional(),
      ownerMode: z.enum(['currentUser', 'other']).optional(),
      ownerId: z.any().optional(),
      owner: z.any().optional(),
      transactionCurrencyId: z.any().optional(),
      currencyId: z.any().optional(),
      currency: z.any().optional(),
      forecastComments: z.string().optional(),
      workloadType: z.number().optional(),
      deliveredBy: z.union([z.number(), z.string()]).optional(),
      preferredAzureRegion: z.union([z.number(), z.string()]).optional(),
      azureCapacityType: z.string().optional(),
      opportunityEstimatedStartDate: z.string().optional(),
      opportunityEstimatedCompletionDate: z.string().optional(),
      parentOperationId: z.string().optional().describe('Batch Mode: the OP-N of a create_opportunity staged in this batch, instead of opportunityId.'),
      allowDuplicate: z.boolean().optional()
    },
    async (params) => {
      const plan = await buildMilestoneCreatePlan(crmClient, params, { allowDuplicate: Boolean(params.allowDuplicate), stagedParent: stagedParentFromParams(params) });
      return text(toPreflightContract(plan, 'milestone'));
    }
  );

  // ── get_opportunity_owner_roles ────────────────────────────
  server.tool(
    'get_opportunity_owner_roles',
    'Return the opportunity owner + msp_rolegroup (ATU/STU/CSU) and the list of open milestones with their owner + msp_rolegroup. ' +
    'Used by the Update Stage flow to validate that owners are in the expected role for the target MCEM stage. ' +
    'Open milestone = statecode=0 and msp_milestonestatus not in {Completed, Cancelled, Closed as Incomplete}.',
    {
      opportunityId: z.string().describe('Opportunity GUID')
    },
    async ({ opportunityId }) => {
      const nid = normalizeGuid(opportunityId);
      if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');

      // Fetch opportunity — need owner id + name
      const oppResult = await crmClient.request(`opportunities(${nid})`, {
        query: { $select: 'opportunityid,name,statecode,_ownerid_value' }
      });
      if (!oppResult.ok) return error(`Opportunity not found: ${oppResult.data?.message || oppResult.status}`);

      const opp = oppResult.data;
      const oppOwnerId = opp._ownerid_value || null;

      // Fetch open milestones for this opportunity.
      // "Open" = statecode=0 (Active entity record) AND msp_milestonestatus not in terminal codes.
      const msFilter =
        `_msp_opportunityid_value eq ${nid} and statecode eq 0` +
        ` and msp_milestonestatus ne 861980003` +  // Completed
        ` and msp_milestonestatus ne 861980004` +  // Cancelled
        ` and msp_milestonestatus ne 861980005` +  // Lost to Competitor
        ` and msp_milestonestatus ne 861980006` +  // Hygiene/Duplicate
        ` and msp_milestonestatus ne 861980007`;   // Closed as Incomplete
      const msResult = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: {
          $filter: msFilter,
          $select: 'msp_engagementmilestoneid,msp_name,_ownerid_value,msp_milestonestatus',
          $orderby: 'msp_milestonedate'
        }
      });
      const milestones = msResult.ok ? (msResult.data?.value || []) : [];
      if (!msResult.ok) {
        // Non-fatal: return opportunity owner info even if milestone fetch fails
      }

      // Collect all unique systemuser IDs to batch-fetch (opp owner + milestone owners)
      const userIds = new Set();
      if (oppOwnerId) userIds.add(oppOwnerId);
      for (const m of milestones) {
        if (m._ownerid_value) userIds.add(m._ownerid_value);
      }

      // Batch-fetch systemusers: fullname + msp_rolegroup. Chunks of 25 (mirrors existing pattern).
      const userMap = {}; // id → { name, roleGroup }
      const CHUNK = 25;
      const userArr = [...userIds];
      for (let i = 0; i < userArr.length; i += CHUNK) {
        const chunk = userArr.slice(i, i + CHUNK);
        const chunkFilter = chunk.map(id => `systemuserid eq '${id}'`).join(' or ');
        const usersResult = await crmClient.request('systemusers', {
          query: { $filter: `(${chunkFilter})`, $select: 'systemuserid,fullname,msp_rolegroup' }
        });
        if (usersResult.ok && usersResult.data?.value) {
          for (const u of usersResult.data.value) {
            // msp_rolegroup is a raw string field — values are "ATU", "STU", "CSU" (uppercased for safety)
            userMap[u.systemuserid] = {
              name: u.fullname || null,
              roleGroup: u.msp_rolegroup ? String(u.msp_rolegroup).toUpperCase() : null
            };
          }
        }
      }

      const oppOwnerInfo = userMap[oppOwnerId] || null;
      const opportunityOut = {
        id: opp.opportunityid || nid,
        name: opp.name || null,
        ownerId: oppOwnerId,
        ownerName: oppOwnerInfo?.name || fv(opp, '_ownerid_value') || null,
        ownerRoleGroup: oppOwnerInfo?.roleGroup ?? null
      };

      const milestonesOut = milestones.map(m => {
        const mid = m._ownerid_value || null;
        const info = mid ? (userMap[mid] || null) : null;
        return {
          id: m.msp_engagementmilestoneid,
          name: m.msp_name || null,
          ownerId: mid,
          ownerName: info?.name || fv(m, '_ownerid_value') || null,
          ownerRoleGroup: info?.roleGroup ?? null,
          isOpen: true
        };
      });

      const warnings = [];
      if (!msResult.ok) {
        warnings.push({ code: 'milestone_fetch_failed', message: msResult.data?.message || 'Could not fetch milestones' });
      }

      return text({
        opportunity: opportunityOut,
        milestones: milestonesOut,
        ...(warnings.length ? { warnings } : {})
      });
    }
  );

  // ── mcem_stage_preflight ────────────────────────────────────
  server.tool(
    'mcem_stage_preflight',
    'Preflight for MCEM opportunity stage movement. Takes an opportunity ID and target MCEM stage, reads current BPF state, plans forward or backward movement, and returns only real user-actionable blockers. Optional fieldValues saves blocker fields and reruns preflight, but never stages or executes stage movement. BPF checklist fields are forward-move auto-fill internals and are never surfaced.',
    {
      opportunityId: z.string().describe('Opportunity GUID'),
      targetStage: z.union([z.string(), z.number()]).describe('Target MCEM stage number/name, e.g. 4 or "Realize Value"'),
      fieldValues: z.object({}).passthrough().optional().describe('Optional blocker field values to save before rechecking. Does not stage or execute movement.')
    },
    async ({ opportunityId, targetStage, fieldValues = {} }) => {
      const oppNid = normalizeGuid(opportunityId);
      if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');

      const saveResult = await saveMcemStageFieldValues(crmClient, oppNid, fieldValues, captureAuditRecord, getCurrentActor);
      if (!saveResult.ok) return error(saveResult.error);

      const preflight = await buildMcemStagePreflight(crmClient, oppNid, targetStage);
      if (!preflight.ok) return error(preflight.error);

      return text({
        status: preflight.status,
        canMove: preflight.canMove,
        savedFieldNames: saveResult.savedFieldNames,
        opportunity: preflight.opportunity,
        currentStage: preflight.currentStage,
        targetStage: preflight.targetStage,
        direction: preflight.direction,
        moves: preflight.moves.map(move => ({
          from: move.from,
          to: move.to,
          ready: move.ready,
          direction: move.direction,
          autoFillChecklistSilently: Boolean(move.autoFillChecklistSilently)
        })),
        blockers: preflight.blockers,
        note: preflight.note
      });
    }
  );

  // ── update_opportunity_stage ────────────────────────────────
  server.tool(
    'update_opportunity_stage',
    'Stage a write-safe MCEM opportunity stage transition for approval. Uses BPF movement through the MCEM process instance, supports forward and backward target stages, and silently auto-fills BPF checklist fields to Yes only for forward movement. Does not patch msp_activesalesstage as the movement mechanism and never auto-creates milestones.',
    {
      opportunityId: z.string().describe('Opportunity GUID'),
      targetStage: z.union([z.string(), z.number()]).describe('Target MCEM stage number/name, e.g. 4 or "Realize Value"'),
      fieldValues: z.object({}).passthrough().optional().describe('Optional values for real non-BPF blockers, e.g. msp_solutionarea, msp_salesplay, description, parentcontactid@odata.bind, msp_PrimaryCompetitor@odata.bind, msp_competethreatlevel.')
    },
    async ({ opportunityId, targetStage, fieldValues = {} }) => {
      const oppNid = normalizeGuid(opportunityId);
      if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');

      const saveResult = await saveMcemStageFieldValues(crmClient, oppNid, fieldValues, captureAuditRecord, getCurrentActor);
      if (!saveResult.ok) return error(saveResult.error);

      const preflight = await buildMcemStagePreflight(crmClient, oppNid, targetStage);
      if (!preflight.ok) return error(preflight.error);
      if (!preflight.canMove) {
        return text({
          staged: false,
          status: preflight.status,
          savedFieldNames: saveResult.savedFieldNames,
          opportunity: preflight.opportunity,
          currentStage: preflight.currentStage,
          targetStage: preflight.targetStage,
          direction: preflight.direction,
          moves: preflight.moves.map(move => ({ from: move.from, to: move.to, ready: move.ready, direction: move.direction })),
          blockers: preflight.blockers,
          message: 'Resolve the listed blocker(s), then retry. Milestones must be created through the existing user-confirmed milestone flow.'
        });
      }

      if (preflight.moves.length === 0) {
        return text({
          staged: false,
          status: 'already_at_target',
          savedFieldNames: saveResult.savedFieldNames,
          opportunity: preflight.opportunity,
          currentStage: preflight.currentStage,
          targetStage: preflight.targetStage,
          message: 'Opportunity is already at the requested MCEM stage.'
        });
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity_stage',
        entitySet: `opportunities(${oppNid})/mcem-stage-transition`,
        method: 'POST',
        payload: {
          opportunityId: oppNid,
          targetStage: preflight.targetStage,
          direction: preflight.direction,
          moves: preflight.moves.map(move => ({ from: move.from, to: move.to, direction: move.direction })),
          autoFillChecklistSilently: preflight.moves.some(move => move.autoFillChecklistSilently)
        },
        beforeState: {
          currentStage: preflight.currentStage,
          bpfInstanceId: preflight.bpfInstanceId
        },
        description: `Move opportunity "${preflight.opportunity.name || oppNid}" from ${preflight.currentStage.name} to ${preflight.targetStage.name}`
      });
      op.stagePlan = {
        opportunityId: oppNid,
        targetStage: preflight.targetStage,
        steps: preflight.moves
      };
      op.recordName = preflight.opportunity?.name || null;
      // Resolve the parent account name authoritatively (Bug 9 fix)
      op.accountName = await resolveAccountNameForOp(crmClient, {
        isOpportunityOp: true,
        opportunityId: oppNid
      });
      op.friendlyDescription = buildAuditFriendlyDesc(op, 'opportunity');

      auditLog({
        tool: 'update_opportunity_stage',
        opportunityId: oppNid,
        targetStage: preflight.targetStage.name,
        operationId: op.id,
        moves: preflight.moves.length
      });

      return text({
        staged: true,
        operationId: op.id,
        savedFieldNames: saveResult.savedFieldNames,
        opportunity: preflight.opportunity,
        currentStage: preflight.currentStage,
        targetStage: preflight.targetStage,
        direction: preflight.direction,
        moves: preflight.moves.map(move => ({ from: move.from, to: move.to, direction: move.direction })),
        autoFillChecklistSilently: preflight.moves.some(move => move.autoFillChecklistSilently),
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── reassign_opportunity ──────────────────────────────────
  server.tool(
    'reassign_opportunity',
    'Reassign an opportunity to a new owner. The change is staged for user approval before execution.',
    {
      opportunityId: z.string().describe('Opportunity GUID to reassign'),
      newOwnerId: z.string().describe('System user GUID of the new owner')
    },
    async ({ opportunityId, newOwnerId }) => {
      const nOppId = normalizeGuid(opportunityId);
      if (!isValidGuid(nOppId)) return error('Invalid opportunityId GUID');
      const nOwnerId = normalizeGuid(newOwnerId);
      if (!isValidGuid(nOwnerId)) return error('Invalid newOwnerId GUID');

      // Fetch current opportunity to show before/after
      const current = await crmClient.request(`opportunities(${nOppId})`, {
        query: { $select: 'name,_ownerid_value' }
      });
      if (!current.ok) return error(`Opportunity not found: ${current.data?.message || current.status}`);
      const reassignEtag = current.data?.['@odata.etag'];
      if (!reassignEtag) {
        return error(`Opportunity ${nOppId} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      const currentOwner = fv(current.data, '_ownerid_value') || current.data._ownerid_value || 'Unknown';

      // Look up new owner name
      const newOwner = await crmClient.request(`systemusers(${nOwnerId})`, {
        query: { $select: 'fullname' }
      });
      const newOwnerName = newOwner.ok ? newOwner.data.fullname : nOwnerId;

      // Stage the reassignment via approval queue
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update',
        entitySet: `opportunities(${nOppId})`,
        method: 'PATCH',
        description: `Reassign opportunity "${current.data.name}" from ${currentOwner} to ${newOwnerName}`,
        payload: { 'ownerid@odata.bind': `/systemusers(${nOwnerId})` },
        beforeState: { owner: currentOwner },
        etag: reassignEtag,
        afterState: { owner: newOwnerName },
        fieldSummary: { owner: `${currentOwner} → ${newOwnerName}` }
      });
      // Resolve the parent account name authoritatively (Bug 9 fix)
      op.accountName = await resolveAccountNameForOp(crmClient, {
        isOpportunityOp: true,
        opportunityId: nOppId
      });

      auditLog('reassign_opportunity', { opportunityId: nOppId, newOwnerId: nOwnerId, operationId: op.id });

      return text({
        status: 'pending',
        operationId: op.id,
        opportunity: current.data.name,
        from: currentOwner,
        to: newOwnerName,
        message: `Staged: reassign "${current.data.name}" from ${currentOwner} to ${newOwnerName}. Say "execute_operation ${op.id}" to confirm.`
      });
    }
  );

  // ── change_owner ─────────────────────────────────────────
  server.tool(
    'change_owner',
    'Change owner for an existing opportunity or engagement milestone. Stages a PATCH ownerid@odata.bind and execute_operation applies it.',
    {
      entityType: z.enum(['opportunity', 'msp_engagementmilestone']).describe('Record type to reassign'),
      recordId: z.string().describe('Opportunity or milestone GUID'),
      newOwnerId: z.string().describe('System user GUID for the new owner')
    },
    async ({ entityType, recordId, newOwnerId }) => {
      const id = normalizeGuid(recordId);
      if (!isValidGuid(id)) return error('Invalid recordId GUID');
      // newOwnerId may arrive as a bare GUID or an OData bind path
      // ("/systemusers(<guid>)") from the lookup UI; extract the GUID.
      const ownerGuidMatch = String(newOwnerId || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const ownerId = normalizeGuid(ownerGuidMatch ? ownerGuidMatch[0] : newOwnerId);
      if (!isValidGuid(ownerId)) return error('Invalid newOwnerId GUID');

      const meta = entityType === 'opportunity'
        ? { entitySet: 'opportunities', logicalName: 'opportunity', idField: 'opportunityid', nameField: 'name', accountSelect: '_parentaccountid_value' }
        : { entitySet: 'msp_engagementmilestones', logicalName: 'msp_engagementmilestone', idField: 'msp_engagementmilestoneid', nameField: 'msp_name', accountSelect: '_msp_opportunityid_value' };

      const current = await crmClient.request(`${meta.entitySet}(${id})`, {
        query: { $select: `${meta.idField},${meta.nameField},_ownerid_value,${meta.accountSelect}` }
      });
      if (!current.ok) return error(`Record not found or inaccessible (${current.status}): ${current.data?.message || 'not found'}`);
      const changeOwnerEtag = current.data?.['@odata.etag'];
      if (!changeOwnerEtag) {
        return error(`${entityType} record ${id} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }
      const currentOwner = fv(current.data, '_ownerid_value') || current.data._ownerid_value || 'Unknown';
      const recordName = current.data[meta.nameField] || id;

      // Resolve the parent account (customer company) so the audit record is
      // self-sufficient — no reliance on read-time backfill. Mirrors the
      // update_milestone account lookup: opportunities carry the account
      // directly; milestones resolve it via their parent opportunity.
      let changeOwnerAccount = null;
      try {
        if (entityType === 'opportunity') {
          changeOwnerAccount = fv(current.data, '_parentaccountid_value') || null;
        } else {
          const parentOppId = current.data._msp_opportunityid_value || null;
          if (parentOppId) {
            const oppAcc = await crmClient.request(`opportunities(${normalizeGuid(parentOppId)})`, {
              query: { $select: '_parentaccountid_value' }
            });
            if (oppAcc.ok && oppAcc.data) changeOwnerAccount = fv(oppAcc.data, '_parentaccountid_value') || null;
          }
        }
      } catch {
        // Best-effort: leave the account null if the lookup fails.
      }

      const newOwner = await crmClient.request(`systemusers(${ownerId})`, {
        query: { $select: 'systemuserid,fullname,internalemailaddress,isdisabled' }
      });
      if (!newOwner.ok) return error(`New owner not found or inaccessible (${newOwner.status}): ${newOwner.data?.message || 'not found'}`);
      if (newOwner.data?.isdisabled) return error('New owner is disabled.');
      const newOwnerName = newOwner.data?.fullname || ownerId;

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'change_owner',
        entitySet: `${meta.entitySet}(${id})`,
        method: 'PATCH',
        payload: { 'ownerid@odata.bind': `/systemusers(${ownerId})` },
        beforeState: { owner: currentOwner },
        etag: changeOwnerEtag,
        afterState: { owner: newOwnerName },
        description: `Change owner for ${entityType} "${recordName}" from ${currentOwner} to ${newOwnerName}`
      });
      op.changeOwner = { entityType, entitySet: meta.entitySet, recordId: id, newOwnerId: ownerId, newOwnerName, previousOwner: currentOwner, recordName };
      op.recordName = recordName;
      if (changeOwnerAccount) op.accountName = changeOwnerAccount;
      op.friendlyDescription = buildAuditFriendlyDesc(op, entityType);
      auditLog({ tool: 'change_owner', entityType, recordId: id, newOwnerId: ownerId, operationId: op.id });

      return text({
        ok: true,
        staged: true,
        operationId: op.id,
        entityType,
        recordId: id,
        recordName,
        from: currentOwner,
        to: newOwnerName,
        payload: op.payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or endpoint submit.`
      });
    }
  );

  // ── close_opportunity ──────────────────────────────────────
  server.tool(
    'close_opportunity',
    'Close/deactivate an opportunity. Supports closing as Won or Lost. The change is staged for user approval before execution. If the standard status code fails (e.g. MCAPS custom codes), the tool auto-discovers valid codes from CRM metadata on retry.',
    {
      opportunityId: z.string().describe('Opportunity GUID to close'),
      status: z.enum(['won', 'lost']).describe('Close as "won" or "lost"'),
      description: z.string().optional().describe('Optional close description/reason'),
      statusCode: z.number().optional().describe('Optional explicit status code override. If omitted, tries standard codes (3=Won, 4=Lost) with auto-discovery fallback.')
    },
    async ({ opportunityId, status, description, statusCode: userStatusCode }) => {
      const nid = normalizeGuid(opportunityId);
      if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');

      // Fetch current opportunity for context
      const current = await crmClient.request(`opportunities(${nid})`, {
        query: { $select: 'name,statecode,statuscode,_ownerid_value,_parentaccountid_value' }
      });
      if (!current.ok) return error(`Opportunity not found: ${current.data?.message || current.status}`);

      // Check if already closed
      if (current.data.statecode === 1 || current.data.statecode === 2) {
        return error(`Opportunity "${current.data.name}" is already closed (statecode=${current.data.statecode}).`);
      }

      const oppName = current.data.name;
      const customer = fv(current.data, '_parentaccountid_value') || 'Unknown';

      // Dynamics 365 requires WinOpportunity/LoseOpportunity actions (not PATCH)
      // MCAPS uses custom status codes: 861980021 (Won/N-A), 861980004 (Lost)
      const action = status === 'won' ? 'WinOpportunity' : 'LoseOpportunity';
      const defaultStatusCode = status === 'won' ? 861980021 : 861980004;
      const resolvedStatusCode = userStatusCode ?? defaultStatusCode;
      const payload = {
        OpportunityClose: {
          'opportunityid@odata.bind': `/opportunities(${nid})`,
          subject: `${status === 'won' ? 'Won' : 'Lost'}${description ? ': ' + description : ''}`
        },
        Status: resolvedStatusCode
      };

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'close_opportunity',
        entitySet: action,
        method: 'POST',
        description: `Close opportunity "${oppName}" (${customer}) as ${status.toUpperCase()}${description ? ': ' + description : ''}`,
        payload,
        beforeState: { statecode: 'Active', status: 'Open' },
        etag: current.data?.['@odata.etag'] || null,
        afterState: { statecode: status === 'won' ? 'Won' : 'Lost', status: status.toUpperCase() },
        fieldSummary: { status: `Active → ${status === 'won' ? 'Won' : 'Lost'}` },
        // Metadata for auto-discovery retry logic
        _closeStatus: status,
        _opportunityId: nid,
        _userStatusCode: userStatusCode ?? null
      });
      op.accountName = customer !== 'Unknown' ? customer : null;
      op.recordName = oppName;
      op.friendlyDescription = buildAuditFriendlyDesc(op, 'opportunity');

      auditLog('close_opportunity', { opportunityId: nid, status, operationId: op.id });

      return text({
        status: 'pending',
        operationId: op.id,
        opportunity: oppName,
        customer,
        closeAs: status,
        message: `Staged: close "${oppName}" as ${status.toUpperCase()}. Say "execute_operation ${op.id}" to confirm.`
      });
    }
  );

  // ── close_msx_opportunity ─────────────────────────────────
  // Consumption close-reason → msp_engagementstatusreason mapping.
  // Source: real network capture of Dynamics UI close dialog.
  // NOTE: Only "completed" (Won) is empirically confirmed. All non-completed reasons map to
  //       Lost (opportunitystatecode=2) — this is inferred from typical CRM behaviour and flagged below.
  const CONSUMPTION_CLOSE_REASON = {
    completed:          { statusReason: 861820003, isWon: true  },
    cancelled_customer: { statusReason: 861820000, isWon: false, inferred: true },
    cancelled_delayed:  { statusReason: 861820004, isWon: false, inferred: true },
    hygiene:            { statusReason: 861820001, isWon: false, inferred: false },
    lost:               { statusReason: 861820002, isWon: false, inferred: true },
    consolidated:       { statusReason: 606820009, isWon: false, inferred: true },
  };
  // opportunitystatuscode for Lost (inferred from prior impl — not separately captured for each reason).
  const MSX_LOST_STATUSCODE = 861980001;

  server.tool(
    'close_msx_opportunity',
    'Close an MSX/MCAPS opportunity with all required custom fields (msp_engagementstatus, close date, comments, etc.). ' +
    'Handles Consumption and/or Billed opportunity types, applies the correct MSX status codes, and optionally completes open milestones. ' +
    'More complete than close_opportunity — use this for MSX-managed opportunities. ' +
    'Consumption close reasons: completed (Won), cancelled_customer, cancelled_delayed, hygiene, lost, consolidated. ' +
    'Only "completed" → Won (opportunitystatecode=1) is empirically confirmed; others → Lost (inferred). ' +
    'The change is staged for user approval before execution.',
    {
      opportunityId: z.string().describe('Opportunity GUID to close'),
      closeReason: z.enum(['completed', 'cancelled_customer', 'cancelled_delayed', 'hygiene', 'lost', 'consolidated']).describe(
        'Consumption close reason (sets msp_engagementstatusreason). ' +
        '"completed" — Won (statecode=1, statuscode=861980021, confirmed). ' +
        '"cancelled_customer" — Cancelled by Customer (861820000, Lost, inferred). ' +
        '"cancelled_delayed" — Cancelled/Delayed (861820004, Lost, inferred). ' +
        '"hygiene" — Pipeline Hygiene/Duplicate (861820001, Lost). ' +
        '"lost" — Lost (861820002, Lost, inferred). ' +
        '"consolidated" — Consolidated (606820009, Lost, inferred).'
      ),
      closeDate: z.string().optional().describe('Actual close date (YYYY-MM-DD). Defaults to today.'),
      comments: z.string().optional().describe('Closing comments written to msp_engagementclosingcomments / msp_billedclosingcomments.'),
      completeOpenMilestones: z.boolean().optional().describe(
        'Complete (set msp_milestonestatus=861980003) all open milestones for Consumption opportunities. Defaults to false. ' +
        'Mirrors the "Mark all open milestones as Completed" checkbox in the Close Consumption dialog.'
      )
    },
    async ({ opportunityId, closeReason, closeDate, comments, completeOpenMilestones }) => {
      const nid = normalizeGuid(opportunityId);
      if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');

      const current = await crmClient.request(`opportunities(${nid})`, {
        query: { $select: 'name,statecode,statuscode,msp_opportunitytype,msp_engagementstatus,_parentaccountid_value' }
      });
      if (!current.ok) return error(`Opportunity not found: ${current.data?.message || current.status}`);
      const closeMsxEtag = current.data?.['@odata.etag'];
      if (!closeMsxEtag) {
        return error(`Opportunity ${nid} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      if (current.data.statecode === 1 || current.data.statecode === 2) {
        return error(`Opportunity "${current.data.name}" is already closed (statecode=${current.data.statecode}).`);
      }

      const oppType = current.data.msp_opportunitytype?.toString() || '';
      const isBilled = oppType.includes('606820000');
      const isConsumption = oppType.includes('606820001');

      if (!isBilled && !isConsumption) {
        return error(
          `Opportunity "${current.data.name}" has no MSX opportunity type (msp_opportunitytype is blank). ` +
          'Use close_opportunity for standard D365 close without MSX custom fields.'
        );
      }

      const today = closeDate || new Date().toISOString().split('T')[0];
      const reasonMeta = CONSUMPTION_CLOSE_REASON[closeReason];
      const isWon = reasonMeta.isWon;
      const oppName = current.data.name;
      const customer = fv(current.data, '_parentaccountid_value') || 'Unknown';
      const typeLabel = [isConsumption ? 'Consumption' : null, isBilled ? 'Billed' : null].filter(Boolean).join('+');

      // Build opportunity PATCH payload with MSX custom fields
      const opportunityPatch = {};
      if (isConsumption) {
        opportunityPatch.msp_engagementstatus = 861980003; // Closed
        opportunityPatch.msp_engagementstatusreason = reasonMeta.statusReason;
        opportunityPatch.actualclosedate = today;          // confirmed from real capture
        opportunityPatch.msp_billedrevenuestatus = 606820000; // N/A — set for all Consumption (confirmed)
        opportunityPatch.msp_engagementclosedate = today;
        opportunityPatch.msp_engagementclosingcomments = comments || null;
      }
      if (isBilled) {
        if (closeReason === 'hygiene') {
          opportunityPatch.msp_billedrevenueclosereason = 606820003; // BilledRevenueHygieneClosingReason
          opportunityPatch.msp_billedrevenuestatus = 861980000; // lostStatus — source-confirmed for hygiene
          opportunityPatch.msp_billedrevenue = 0;
        }
        if (!isConsumption) {
          // Pure Billed: set engagement status to N/A (Consumption already set its own value above)
          opportunityPatch.msp_engagementstatus = 606820000; // nastatus
        }
        opportunityPatch.msp_actualbilledclosedate = today;
        if (comments) opportunityPatch.msp_billedclosingcomments = comments;
      }

      // Build opportunityclose record — CRM plugin reads opportunitystatecode to close the parent opp.
      // opportunitystatuscode for Won=861980021 (confirmed). For Lost=861980001 (inferred from prior impl).
      const closeRecord = {
        'opportunityid@odata.bind': `/opportunities(${nid})`,
        opportunitystatecode: isWon ? 1 : 2,
        opportunitystatuscode: isWon ? 861980021 : MSX_LOST_STATUSCODE,
        statuscode: 1,
        statecode: 0
      };

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'close_msx_opportunity',
        entitySet: `opportunities(${nid})`,
        method: 'PATCH',
        description: `Close MSX opportunity "${oppName}" (${customer}) [${typeLabel}] as ${isWon ? 'WON' : 'LOST'}/${closeReason.toUpperCase()} on ${today}`,
        payload: { opportunityId: nid, opportunityPatch, closeRecord, completeMilestones: !!(completeOpenMilestones && isConsumption) },
        beforeState: { statecode: 'Active', msp_engagementstatus: current.data.msp_engagementstatus },
        etag: closeMsxEtag,
        afterState: { statecode: isWon ? 'Won' : 'Lost', closeReason },
        fieldSummary: {
          closeReason,
          opportunityType: typeLabel,
          closeDate: today,
          completeMilestones: !!(completeOpenMilestones && isConsumption)
        }
      });
      op.accountName = customer !== 'Unknown' ? customer : null;
      op.recordName = oppName;
      op.friendlyDescription = buildAuditFriendlyDesc(op, 'opportunity');

      auditLog('close_msx_opportunity', { opportunityId: nid, closeReason, closeDate: today, typeLabel, operationId: op.id });

      const warnings = [];
      if (reasonMeta.inferred) {
        warnings.push(`Close reason "${closeReason}" (opportunitystatecode=2/Lost, opportunitystatuscode=${MSX_LOST_STATUSCODE}): Lost status code is inferred — not empirically captured for this reason. Verify in CRM if close fails.`);
      }
      if (isBilled && closeReason !== 'hygiene') {
        warnings.push(`Billed close reason "${closeReason}": msp_billedrevenueclosereason value not confirmed from source capture. Billed-specific fields may need manual follow-up.`);
      }

      return text({
        status: 'pending',
        operationId: op.id,
        opportunity: oppName,
        customer,
        opportunityType: typeLabel,
        closeAs: isWon ? 'WON/COMPLETED' : `LOST/${closeReason.toUpperCase()}`,
        closeDate: today,
        completeMilestones: !!(completeOpenMilestones && isConsumption),
        ...(warnings.length ? { warnings } : {}),
        message: `Staged: close MSX opportunity "${oppName}" [${typeLabel}] as ${isWon ? 'WON/COMPLETED' : `LOST/${closeReason.toUpperCase()}`}. Say "execute_operation ${op.id}" to confirm.`
      });
    }
  );

  // ── reactivate_msx_opportunity ─────────────────────────────
  server.tool(
    'reactivate_msx_opportunity',
    'Reactivate a closed MSX/MCAPS opportunity. Performs a single PATCH to restore statecode=0/Active and clear MSX close fields. ' +
    'Empirically confirmed from real network capture — no SetState action needed in this MCAPS environment. ' +
    'The change is staged for user approval before execution.',
    {
      opportunityId: z.string().describe('Opportunity GUID to reactivate')
    },
    async ({ opportunityId }) => {
      const nid = normalizeGuid(opportunityId);
      if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');

      const current = await crmClient.request(`opportunities(${nid})`, {
        query: { $select: 'name,statecode,statuscode,msp_opportunitytype,msp_engagementstatus,_parentaccountid_value' }
      });
      if (!current.ok) return error(`Opportunity not found: ${current.data?.message || current.status}`);
      const reactivateEtag = current.data?.['@odata.etag'];
      if (!reactivateEtag) {
        return error(`Opportunity ${nid} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      if (current.data.statecode === 0) {
        return error(`Opportunity "${current.data.name}" is already active (statecode=0).`);
      }

      const oppType = current.data.msp_opportunitytype?.toString() || '';
      const isBilled = oppType.includes('606820000');
      const oppName = current.data.name;
      const customer = fv(current.data, '_parentaccountid_value') || 'Unknown';

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'reactivate_msx_opportunity',
        entitySet: `opportunities(${nid})`,
        method: 'PATCH',
        description: `Reactivate MSX opportunity "${oppName}" (${customer})`,
        payload: { opportunityId: nid, isBilled },
        beforeState: { statecode: current.data.statecode, statuscode: current.data.statuscode },
        etag: reactivateEtag,
        afterState: { statecode: 0, statuscode: 1 }
      });
      op.accountName = customer !== 'Unknown' ? customer : null;
      op.recordName = oppName;
      op.friendlyDescription = buildAuditFriendlyDesc(op, 'opportunity');

      auditLog('reactivate_msx_opportunity', { opportunityId: nid, operationId: op.id });

      const warnings = [];
      if (isBilled) {
        warnings.push('Billed opportunity: msp_billedrevenuestatus active value is not confirmed from capture — will clear billed close fields but skip msp_billedrevenuestatus reset.');
      }

      return text({
        status: 'pending',
        operationId: op.id,
        opportunity: oppName,
        customer,
        ...(warnings.length ? { warnings } : {}),
        message: `Staged: reactivate MSX opportunity "${oppName}". Say "execute_operation ${op.id}" to confirm.`
      });
    }
  );

  // ── update_opportunity ────────────────────────────────────
  server.tool(
    'update_opportunity',
    'Update fields on an opportunity. Supports estimated close date, description, estimated revenue, and forecast comments. Changes are staged for user approval. Stage changes are rejected here; use update_opportunity_stage for MCEM BPF movement.',
    {
      opportunityId: z.string().describe('Opportunity GUID'),
      stage: z.string().optional().describe('Deprecated. Direct msp_activesalesstage writes are rejected; use update_opportunity_stage.'),
      estimatedCloseDate: z.string().optional().describe('New estimated close date in YYYY-MM-DD format'),
      estimatedCompletionDate: z.string().optional().describe('New estimated completion date (msp_estcompletiondate) in YYYY-MM-DD format'),
      estimatedRevenue: z.number().optional().describe('Revenue estimate (estimatedvalue)'),
      description: z.string().optional().describe('Opportunity description/notes'),
      forecastComments: z.string().optional().describe('Forecast comments text'),
      commentAuthorName: z.string().optional().describe("Full display name of the person writing the comment. Used for initials in the plain-text journal. When provided alongside forecastComments, appends to history instead of overwriting."),
      commentAuthorGuid: z.string().optional().describe("Dataverse UserId GUID of the comment author. Stored as-is in msp_forecastcommentsjsonfield to match native CRM format.")
    },
    async ({ opportunityId, stage, estimatedCloseDate, estimatedCompletionDate, estimatedRevenue, description, forecastComments, commentAuthorName, commentAuthorGuid }) => {
      const nid = normalizeGuid(opportunityId);
      if (!isValidGuid(nid)) return error('Invalid opportunityId GUID');

      const payload = {};
      const changes = [];

      if (stage !== undefined) {
        return error('Direct msp_activesalesstage updates do not move the MCEM BPF. Use update_opportunity_stage for stage transitions.');
      }
      if (estimatedCloseDate !== undefined) {
        payload.estimatedclosedate = estimatedCloseDate;
        changes.push(`close date → ${estimatedCloseDate}`);
      }
      if (estimatedCompletionDate !== undefined) {
        payload.msp_estcompletiondate = estimatedCompletionDate;
        changes.push(`completion date → ${estimatedCompletionDate}`);
      }
      if (estimatedRevenue !== undefined) {
        payload.estimatedvalue = estimatedRevenue;
        changes.push(`revenue → ${estimatedRevenue}`);
      }
      if (description !== undefined) {
        payload.description = description;
        changes.push(`description updated`);
      }
      if (forecastComments !== undefined) {
        payload.msp_forecastcomments = forecastComments;
        changes.push(`forecast comments updated`);
      }

      if (Object.keys(payload).length === 0) return error('No fields to update — provide at least one of: stage, estimatedCloseDate, estimatedCompletionDate, estimatedRevenue, description, forecastComments');

      // Fetch current opportunity for context + before-state
      const current = await crmClient.request(`opportunities(${nid})`, {
        query: { $select: 'name,_parentaccountid_value,msp_activesalesstage,estimatedclosedate,msp_estcompletiondate,estimatedvalue,description,msp_forecastcomments,msp_forecastcommentsjsonfield' }
      });
      if (!current.ok) return error(`Opportunity not found: ${current.data?.message || current.status}`);
      const updateOppEtag = current.data?.['@odata.etag'];
      if (!updateOppEtag) {
        return error(`Opportunity ${nid} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      // When forecastComments is a user-initiated comment (author info provided), append to history
      // fields instead of overwriting. This matches native CRM behavior.
      // When called without author info (e.g. AI chat direct field set), keeps overwrite behavior.
      if (forecastComments !== undefined && (commentAuthorName || commentAuthorGuid)) {
        let authorName = commentAuthorName || null;
        let authorGuid = commentAuthorGuid || null;
        const forecastCheck = validateNewForecastComment(forecastComments, current.data.msp_forecastcomments);
        if (!forecastCheck.ok) return error(forecastCheck.message);
        const forecastUpdate = buildForecastCommentUpdate(forecastCheck.comment, authorName, authorGuid, current.data);
        payload.msp_forecastcomments = forecastUpdate.msp_forecastcomments;
        payload.msp_forecastcommentsjsonfield = forecastUpdate.msp_forecastcommentsjsonfield;
        changes.push('forecast comments appended');
      }

      const oppName = current.data.name || 'Unknown';
      const customer = fv(current.data, '_parentaccountid_value') || 'Unknown';

      // Build before-state limited to fields being changed
      const before = {};
      for (const key of Object.keys(payload)) {
        before[key] = current.data[key] ?? null;
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: `opportunities(${nid})`,
        method: 'PATCH',
        description: `Update opportunity "${oppName}" (${customer}) — ${changes.join(', ')}`,
        payload,
        beforeState: before,
        etag: updateOppEtag,
        afterState: { ...payload },
        fieldSummary: Object.fromEntries(
          Object.keys(payload).map(k => [k, `${before[k] ?? '(empty)'} → ${payload[k]}`])
        )
      });
      op.accountName = customer !== 'Unknown' ? customer : null;
      op.recordName = oppName !== 'Unknown' ? oppName : null;
      op.friendlyDescription = buildAuditFriendlyDesc(op, 'opportunity');

      auditLog('update_opportunity', { opportunityId: nid, changes, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        opportunity: oppName,
        customer,
        changes,
        before,
        after: payload,
        message: `Staged ${op.id}: update "${oppName}" — ${changes.join(', ')}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── create_milestone ───────────────────────────────────────
  server.tool(
    'create_milestone',
    'Stage a multi-step engagement milestone create linked to an opportunity. Requires runtime CRM fields such as status reason and milestone comments; execute_operation performs parent opportunity date patch, create, owner patch, and verification. In Batch Mode a milestone for an opportunity staged in the same batch passes parentOperationId instead of opportunityId: it waits for that create and runs right after it.',
    {
      opportunityId: z.string().optional().describe('Opportunity GUID to link the milestone to. Required unless parentOperationId is set.'),
      parentOperationId: z.string().optional().describe('Batch Mode only: the OP-N id of a create_opportunity staged in this batch. The milestone links to the opportunity it creates and runs right after it. Use instead of opportunityId.'),
      name: z.string().describe('Milestone name/title'),
      milestoneDate: z.string().describe('Required. Milestone date in YYYY-MM-DD format'),
      monthlyUse: z.number().describe('Required. Monthly use value'),
      milestoneCategory: z.number().describe(`Required. Milestone category: ${MILESTONE_CATEGORIES.map(o => `${o.value}=${o.label}`).join(', ')}`),
      customerCommitment: z.union([z.number(), z.string()]).optional().describe(`Required semantic field. Customer Commitment: ${COMMITMENT_RECOMMENDATIONS.map(o => `${o.value}=${o.label}`).join(', ')}`),
      commitmentRecommendation: z.union([z.number(), z.string()]).optional().describe(`Alias for customerCommitment. Customer Commitment: ${COMMITMENT_RECOMMENDATIONS.map(o => `${o.value}=${o.label}`).join(', ')}`),
      milestoneStatus: z.union([z.number(), z.string()]).describe('Required. Milestone status code/name from live metadata.'),
      milestoneStatusReason: z.union([z.number(), z.string()]).optional().describe('Milestone status reason code/name. Required by backend validation only when milestoneStatus is Blocked and no capacity blocker default applies.'),
      milestoneComments: z.string().describe('Required by CRM runtime. Risk/blocker/details text.'),
      helpNeeded: z.union([z.number(), z.string()]).optional().describe(`Help needed reason (name or code). For quota/capacity blockers use Azure Capacity=${AZURE_CAPACITY_HELP_NEEDED}.`),
      workloadId: z.any().describe('Required. Workload GUID or lookup object'),
      ownerMode: z.enum(['currentUser', 'other']).optional().describe('Owner mode. Use other with ownerId to assign a selected user.'),
      ownerId: z.any().optional().describe('System user GUID/lookup object to assign as owner. Defaults to current CRM behavior if omitted.'),
      transactionCurrencyId: z.any().optional().describe('Transaction currency GUID/lookup object'),
      currencyId: z.any().optional().describe('Transaction currency GUID semantic alias'),
      forecastComments: z.string().optional().describe('Forecast comments text'),
      workloadType: z.number().optional().describe(`Optional. Backend derives Workload Type from selected workload when omitted. Values: ${WORKLOAD_TYPES.map(o => `${o.value}=${o.label}`).join(', ')}.`),
      deliveredBy: z.union([z.number(), z.string()]).describe(`Required for milestone view. Delivered By: ${DELIVERED_BY.map(o => `${o.value}=${o.label}`).join(', ')}.`),
      preferredAzureRegion: z.union([z.number(), z.string()]).describe(`Required for milestone view. Preferred Azure Region.`),
      azureCapacityType: z.string().describe('Required. Azure Capacity Type (MultiSelectPicklist — comma-separated codes).'),
      opportunityEstimatedStartDate: z.string().optional().describe('Optional parent opportunity est. start date; defaults to milestoneDate when parent is missing it.'),
      opportunityEstimatedCompletionDate: z.string().optional().describe('Optional parent opportunity est. completion date; defaults to milestoneDate when parent is missing it.'),
      allowDuplicate: z.boolean().optional().describe('Allow create even when duplicate candidates are found')
    },
    async (params) => {
      const stagedParent = stagedParentFromParams(params);
      if (stagedParent?.error) return error(stagedParent.error);
      const plan = await buildMilestoneCreatePlan(crmClient, params, { allowDuplicate: Boolean(params.allowDuplicate), stagedParent });
      if (!plan.canCreate) {
        const missing = (plan.blockers || []).map(b => b.fieldName).filter(Boolean).join(', ');
        const details = (plan.blockers || []).map(b => b.message).filter(Boolean).join(' ');
        const message = plan.duplicates?.length
          ? 'Duplicate candidates found. Pass allowDuplicate=true to create anyway.'
          : `Missing required milestone view fields: ${missing}. ${details} These fields are mandatory for the milestone to display correctly in the opportunity milestone view. Use get_milestone_field_options for option values.`;
        return error(message);
      }
      const responsePayload = { ...plan.normalized.payloadPreview };
      const createPayload = { ...responsePayload };
      const ownerPatch = {};
      const queue = getApprovalQueue();
      const parentOp = stagedParent?.parentOp || null;
      const opportunityId = parentOp ? null : normalizeGuid(params.opportunityId);
      let op;
      try {
        op = queue.stage({
          type: 'create_milestone',
          entitySet: 'msp_engagementmilestones',
          method: 'POST',
          payload: {
            opportunityId,
            ...(parentOp ? { parentOperationId: parentOp.id } : {}),
            opportunityPatch: plan.normalized.opportunityPatch,
            create: createPayload,
            ownerPatch
          },
          beforeState: null,
          description: parentOp
            ? `Create milestone "${params.name}" on new opportunity "${plan.normalized.opportunity?.name || parentOp.id}"`
            : `Create milestone "${params.name}" on opportunity ${plan.normalized.opportunity?.name || opportunityId}`,
          dependsOn: parentOp?.id || null
        });
      } catch (err) {
        // The staged opportunity ran or was cancelled while this milestone was being validated.
        return error(err.message);
      }
      // Resolve the parent account name authoritatively (Bug 9 fix). A staged parent already
      // carries the one its create resolved.
      op.accountName = parentOp
        ? (parentOp.accountName || null)
        : await resolveAccountNameForOp(crmClient, { isOpportunityOp: true, opportunityId });
      auditLog({ tool: 'create_milestone', operationId: op.id, opportunityId, ...(parentOp ? { parentOperationId: parentOp.id } : {}) });
      return text({
        ok: true,
        staged: true,
        operationId: op.id,
        status: 'staged',
        ...(parentOp ? { dependsOn: parentOp.id } : {}),
        duplicates: plan.duplicates,
        description: op.description,
        payload: responsePayload,
        fieldSummary: resolvePayloadLabels(responsePayload),
        payloadPreview: createPayload,
        opportunityPatch: plan.normalized.opportunityPatch,
        ownerPatch,
        message: parentOp
          ? `Staged ${op.id}: ${op.description}. It runs right after ${parentOp.id} creates the opportunity — execute ${parentOp.id} (or execute_all) to run both.`
          : `Staged ${op.id}: ${op.description}. Approve via execute_operation or modal submit.`
      });
    }
  );

  // ── create_task ─────────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a task linked to an engagement milestone. Optionally specify category, subject, due date, and owner.',
    {
      milestoneId: z.string().describe('Engagement milestone GUID to link the task to'),
      subject: z.string().describe('Task subject/title'),
      category: z.number().optional().describe(`Task category code. Valid values: ${TASK_CATEGORIES.map(c => `${c.value} (${c.label})`).join(', ')}`),
      dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format'),
      ownerId: z.string().optional().describe('System user GUID to assign as owner'),
      description: z.string().optional().describe('Task description')
    },
    async ({ milestoneId, subject, category, dueDate, ownerId, description }) => {
      const nid = normalizeGuid(milestoneId);
      if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');
      if (!subject) return error('subject is required');

      const payload = {
        subject,
        'regardingobjectid_msp_engagementmilestone@odata.bind': `/msp_engagementmilestones(${nid})`
      };
      if (category !== undefined) payload.msp_taskcategory = category;
      if (dueDate) payload.scheduledend = dueDate;
      if (description) payload.description = description;
      if (ownerId) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        payload['ownerid@odata.bind'] = `/systemusers(${ownerNid})`;
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'create_task',
        entitySet: 'tasks',
        method: 'POST',
        payload,
        beforeState: null,
        description: `Create task "${subject}" on milestone ${nid}`
      });
      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── update_task ─────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update fields on an existing task (subject, due date, description, status).',
    {
      taskId: z.string().describe('Task GUID'),
      subject: z.string().optional().describe('New subject'),
      dueDate: z.string().optional().describe('New due date YYYY-MM-DD'),
      description: z.string().optional().describe('New description'),
      statusCode: z.number().optional().describe('New status code')
    },
    async ({ taskId, subject, dueDate, description, statusCode }) => {
      const nid = normalizeGuid(taskId);
      if (!isValidGuid(nid)) return error('Invalid taskId GUID');
      const payload = {};
      if (subject !== undefined) payload.subject = subject;
      if (dueDate !== undefined) payload.scheduledend = dueDate;
      if (description !== undefined) payload.description = description;
      if (statusCode !== undefined) {
        payload.statuscode = statusCode;
        payload.statecode = taskStateForStatus(statusCode);
      }
      if (Object.keys(payload).length === 0) return error('No fields to update');

      // Fetch before-state for diff preview
      const before = await crmClient.request(`tasks(${nid})`, {
        query: { $select: Object.keys(payload).join(',') }
      });

      // REQUIRE successful read with etag before staging — do NOT stage unconditional PATCHes
      if (!before.ok || !before.data) {
        return error(`Failed to read task ${nid} for etag capture (${before.status}): ${before.data?.message || 'not found'}`);
      }
      const beforeEtag = before.data['@odata.etag'];
      if (!beforeEtag) {
        return error(`Task ${nid} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_task',
        entitySet: `tasks(${nid})`,
        method: 'PATCH',
        payload,
        beforeState: before.data,
        etag: beforeEtag,
        description: `Update task ${nid}: ${Object.keys(payload).join(', ')}`
      });
      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        before: op.beforeState,
        after: payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── close_task ──────────────────────────────────────────────
  server.tool(
    'close_task',
    'Close a task using the CloseTask action (with fallback to bound Close endpoint).',
    {
      taskId: z.string().describe('Task GUID'),
      statusCode: z.number().describe('Status code for the closure (e.g. 5 = Completed, 6 = Cancelled)'),
      subject: z.string().optional().describe('Close subject (defaults to "Task Closed")')
    },
    async ({ taskId, statusCode, subject }) => {
      const nid = normalizeGuid(taskId);
      if (!isValidGuid(nid)) return error('Invalid taskId GUID');
      if (statusCode === undefined) return error('statusCode is required');

      // Fetch before-state
      const before = await crmClient.request(`tasks(${nid})`, {
        query: { $select: 'subject,statuscode,statecode' }
      });

      // Stage with CloseTask action as primary strategy
      const closePayload = {
        TaskClose: {
          subject: subject || 'Task Closed',
          'activityid@odata.bind': `/tasks(${nid})`
        },
        Status: statusCode
      };

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'close_task',
        entitySet: 'CloseTask',
        method: 'POST',
        payload: closePayload,
        beforeState: before.ok ? before.data : null,
        etag: before.ok ? before.data?.['@odata.etag'] : null,
        description: `Close task ${nid} with status ${statusCode}`
      });
      // Attach fallback info for executor
      op.fallbackEntitySet = `tasks(${nid})/Microsoft.Dynamics.CRM.Close`;
      op.fallbackPayload = { Status: statusCode };

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        before: op.beforeState,
        statusCode,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── update_milestone ────────────────────────────────────────
  server.tool(
    'update_milestone',
    'Update fields on an engagement milestone. Only fields you provide will be changed — all other fields are preserved. Supports name, date, monthly use, status, status reason, help needed, category, commitment, workload, owner, currency, comments, milestone comments, workload type, delivered by, preferred Azure region, and Azure capacity type.',
    {
      milestoneId: z.string().describe('Engagement milestone GUID'),
      name: z.string().optional().describe('New milestone name/title (cannot be empty)'),
      milestoneDate: z.string().optional().describe('New milestone date YYYY-MM-DD'),
      monthlyUse: z.number().optional().describe('New monthly use value (msp_monthlyuse) — the CONSUMPTION quantity, in currency. Use `seats` instead for usage milestones (Modern Work, D365, Power Platform, ABS, Intent), whose quantity lives in a different field.'),
      seats: z.number().optional().describe('New seats value (msp_noofactivations) — the USAGE quantity, in users/devices. This is the field the UI shows as "N seats"; writing monthlyUse on a usage milestone updates a field nobody is looking at.'),
      milestoneCategory: z.number().optional().describe(`Milestone category: ${MILESTONE_CATEGORIES.map(o => `${o.value}=${o.label}`).join(', ')}`),
      commitmentRecommendation: z.union([z.number(), z.string()]).optional().describe(`Commitment recommendation: ${COMMITMENT_RECOMMENDATIONS.map(o => `${o.value}=${o.label}`).join(', ')}`),
      milestoneStatus: z.union([z.number(), z.string()]).optional().describe(`Milestone status (name or code): ${MILESTONE_STATUSES.map(o => `${o.label}=${o.value}`).join(', ')}`),
      milestoneStatusReason: z.union([z.number(), z.string()]).optional().describe(`Milestone status reason (name or code), required by CRM when status is Blocked. For quota/capacity blockers use Capacity/Service Availability=${CAPACITY_SERVICE_AVAILABILITY_REASON}.`),
      helpNeeded: z.union([z.number(), z.string()]).optional().describe(`Help needed reason (name or code). For quota/capacity blockers use Azure Capacity=${AZURE_CAPACITY_HELP_NEEDED}.`),
      workloadId: z.string().optional().describe('New workload GUID (use null to clear)'),
      ownerId: z.string().optional().describe('New owner system user GUID'),
      transactionCurrencyId: z.string().optional().describe('New transaction currency GUID'),
      forecastComments: z.string().optional().describe('Forecast comments text'),
      milestoneComments: z.string().optional().describe('Milestone comments text. CRM requires this when status is Blocked or At Risk (a business rule enforces it server-side). Pass user-provided context describing why the milestone is blocked/at-risk.'),
      workloadType: z.number().optional().describe(`Workload Type: ${WORKLOAD_TYPES.map(o => `${o.value}=${o.label}`).join(', ')}`),
      deliveredBy: z.union([z.number(), z.string()]).optional().describe(`Delivered By: ${DELIVERED_BY.map(o => `${o.value}=${o.label}`).join(', ')}`),
      preferredAzureRegion: z.union([z.number(), z.string()]).optional().describe(`Preferred Azure Region. Common: ${PREFERRED_AZURE_REGIONS_COMMON.map(o => `${o.value}=${o.label}`).join(', ')}. Full list via get_milestone_field_options.`),
      azureCapacityType: z.string().optional().describe(`Azure Capacity Type (MultiSelectPicklist — comma-separated codes). Common: ${AZURE_CAPACITY_TYPES_COMMON.map(o => `${o.value}=${o.label}`).join(', ')}. Full list via get_milestone_field_options.`),
      skipOwnershipCheck: z.boolean().optional().describe('Skip client-side ownership verification. CRM API still enforces permissions.'),
      commentAuthorName: z.string().optional().describe("Full display name of the person writing the comment (e.g. 'Joaquin Perez del Real'). Used to build forecast comment initials. If omitted, resolved via WhoAmI."),
      commentAuthorGuid: z.string().optional().describe("Dataverse UserId GUID of the person writing the comment. Stored as userId in msp_forecastcommentsjsonfield to match native CRM format. If omitted, resolved via WhoAmI or falls back to authorName.")
    },
    async ({ milestoneId, name, milestoneDate, monthlyUse, seats, milestoneCategory, commitmentRecommendation, milestoneStatus, milestoneStatusReason, helpNeeded, workloadId, ownerId, transactionCurrencyId, forecastComments, milestoneComments, workloadType, deliveredBy, preferredAzureRegion, azureCapacityType, skipOwnershipCheck, commentAuthorName, commentAuthorGuid }) => {
      const nid = normalizeGuid(milestoneId);
      if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');

      // Guard: name must not be blanked
      if (name !== undefined && !name.trim()) return error('name cannot be empty — omit the field to keep the existing name');

      // Guard: a milestone has ONE quantity, and which field holds it depends on whether the
      // milestone is consumption or usage. Accepting both would write two different quantity
      // fields in a single PATCH and leave the record self-contradictory — with the reader
      // (getMilestoneAmount) picking whichever one its unit classification happens to prefer,
      // so the disagreement would be invisible. Refusing is the whole point of splitting them.
      if (monthlyUse !== undefined && seats !== undefined) {
        return error('Pass monthlyUse OR seats, not both — a milestone has one quantity. Use monthlyUse for consumption (msp_monthlyuse) and seats for usage (msp_noofactivations).');
      }

      const payload = {};
      if (name !== undefined) payload.msp_name = name;
      if (milestoneDate !== undefined) payload.msp_milestonedate = milestoneDate;
      if (monthlyUse !== undefined) payload.msp_monthlyuse = monthlyUse;
      if (seats !== undefined) payload.msp_noofactivations = seats;
      if (milestoneCategory !== undefined) payload.msp_milestonecategory = milestoneCategory;
      if (commitmentRecommendation !== undefined) payload.msp_commitmentrecommendation = commitmentRecommendation;
      let resolvedMilestoneStatus;
      if (milestoneStatus !== undefined) {
        const resolved = resolveOptionValue(MILESTONE_STATUSES, milestoneStatus);
        if (resolved === undefined) return error(`Invalid milestoneStatus "${milestoneStatus}". Valid: ${MILESTONE_STATUSES.map(o => `${o.label} (${o.value})`).join(', ')}`);
        payload.msp_milestonestatus = resolved;
        resolvedMilestoneStatus = resolved;
      }
      if (milestoneStatusReason !== undefined) {
        const resolvedReason = resolveOptionValue(MILESTONE_STATUS_REASONS, milestoneStatusReason);
        if (resolvedReason === undefined) return error(`Invalid milestoneStatusReason "${milestoneStatusReason}". Valid: ${validOptionsMessage(MILESTONE_STATUS_REASONS)}`);
        payload.msp_milestonestatusreason = resolvedReason;
      }
      if (helpNeeded !== undefined) {
        const resolvedHelp = resolveOptionValue(MILESTONE_HELP_NEEDED, helpNeeded);
        if (resolvedHelp === undefined) return error(`Invalid helpNeeded "${helpNeeded}". Valid: ${validOptionsMessage(MILESTONE_HELP_NEEDED)}`);
        payload.msp_helpneeded = resolvedHelp;
      }
      if (forecastComments !== undefined) payload.msp_forecastcomments = forecastComments;
      if (milestoneComments !== undefined) payload.msp_milestonecomments = milestoneComments;
      if (workloadType !== undefined) payload.msp_milestoneworkload = workloadType;
      if (deliveredBy !== undefined) payload.msp_deliveryspecifiedfield = deliveredBy;
      if (preferredAzureRegion !== undefined) payload.msp_milestonepreferredazureregion = preferredAzureRegion;
      if (azureCapacityType !== undefined) payload.msp_milestoneazurecapacitytype = azureCapacityType;

      if (workloadId !== undefined) {
        if (workloadId) {
          const workloadNid = normalizeGuid(workloadId);
          if (!isValidGuid(workloadNid)) return error('Invalid workloadId GUID');
          payload['msp_WorkloadlkId@odata.bind'] = `/msp_workloads(${workloadNid})`;
        } else {
          payload['msp_WorkloadlkId@odata.bind'] = null;
        }
      }

      if (ownerId !== undefined) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        payload['ownerid@odata.bind'] = `/systemusers(${ownerNid})`;
      }

      if (transactionCurrencyId !== undefined) {
        const currencyNid = normalizeGuid(transactionCurrencyId);
        if (!isValidGuid(currencyNid)) return error('Invalid transactionCurrencyId GUID');
        payload['transactioncurrencyid@odata.bind'] = `/transactioncurrencies(${currencyNid})`;
      }

      if (Object.keys(payload).length === 0) return error('No fields to update');

      // Fetch full milestone record for identity verification + before-state
      const fullRecord = await crmClient.request(`msp_engagementmilestones(${nid})`, {
        query: { $select: MILESTONE_SELECT }
      });
      if (!fullRecord.ok) {
        return error(`Milestone ${nid} not found or inaccessible (${fullRecord.status}): ${fullRecord.data?.message || 'lookup failed'}`);
      }

      const record = fullRecord.data;
      const updateMilestoneEtag = record['@odata.etag'];
      if (!updateMilestoneEtag) {
        return error(`Milestone ${nid} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }
      // When milestoneComments is provided (status-change comment) and forecastComments
      // was not explicitly supplied, auto-append to the forecast history fields so that
      // the comment is visible in every CRM view (native CRM behavior).
      if (milestoneComments !== undefined && forecastComments === undefined) {
        let authorName = commentAuthorName || null;
        let authorGuid = commentAuthorGuid || null;
        if (!authorName || !authorGuid) {
          const whoAmIRes = await crmClient.request('WhoAmI');
          if (whoAmIRes.ok && whoAmIRes.data?.UserId) {
            const nUserId = normalizeGuid(whoAmIRes.data.UserId);
            if (!authorGuid) authorGuid = nUserId;
            if (!authorName) {
              const userRes = await crmClient.request(`systemusers(${nUserId})`, {
                query: { $select: 'fullname' }
              });
              authorName = userRes.ok ? (userRes.data?.fullname || null) : null;
            }
          }
        }
        const forecastCheck = validateNewForecastComment(milestoneComments, record.msp_forecastcomments);
        if (!forecastCheck.ok) return error(forecastCheck.message);
        const forecastUpdate = buildForecastCommentUpdate(forecastCheck.comment, authorName, authorGuid, record);
        payload.msp_forecastcomments = forecastUpdate.msp_forecastcomments;
        payload.msp_forecastcommentsjsonfield = forecastUpdate.msp_forecastcommentsjsonfield;
      }

      const statusReasonError = applyMilestoneStatusReasonFields(payload, {
        resolvedStatus: resolvedMilestoneStatus,
        milestoneStatusReason: undefined,
        azureCapacityType: azureCapacityType !== undefined ? azureCapacityType : record.msp_milestoneazurecapacitytype,
        helpNeeded: undefined
      });
      if (statusReasonError) return error(statusReasonError);
      const milestoneNumber = record.msp_milestonenumber || null;
      const milestoneName = record.msp_name || null;
      const milestoneOppId = record._msp_opportunityid_value || null;
      const milestoneOwnerId = record._ownerid_value || null;
      const opportunityName = fv(record, '_msp_opportunityid_value') || null;

      // Ownership verification: ensure current user owns milestone or is on deal team
      if (!skipOwnershipCheck) {
        const whoAmI = await crmClient.request('WhoAmI');
        if (whoAmI.ok && whoAmI.data?.UserId) {
          const currentUserId = normalizeGuid(whoAmI.data.UserId);
          const isOwner = milestoneOwnerId && normalizeGuid(milestoneOwnerId) === currentUserId;
          console.log('Ownership check:', { milestoneOwnerId, currentUserId, isOwner, milestoneNumber });

          if (!isOwner && milestoneOppId) {
            // Check if user owns the opportunity or any milestones under it
            const oppResult = await crmClient.request(`opportunities(${normalizeGuid(milestoneOppId)})`, {
              query: { $select: '_ownerid_value' }
            });
            const oppOwnerId = oppResult.ok ? normalizeGuid(oppResult.data?._ownerid_value || '') : '';
            const isOppOwner = oppOwnerId === currentUserId;

            if (!isOppOwner) {
              const teamCheck = await crmClient.requestAllPages('msp_engagementmilestones', {
                query: {
                  $filter: `_msp_opportunityid_value eq '${normalizeGuid(milestoneOppId)}' and _ownerid_value eq '${currentUserId}'`,
                  $select: 'msp_engagementmilestoneid',
                  $top: '1'
                }
              });
              const isOnDealTeam = teamCheck.ok && teamCheck.data?.value?.length > 0;
              if (!isOnDealTeam) {
                return error(
                  `Ownership check failed: milestone ${milestoneNumber || nid} ("${milestoneName || 'unknown'}") ` +
                  `under opportunity "${opportunityName || milestoneOppId}" is not owned by you and you are not on the deal team. ` +
                  `Verify you have the correct milestone ID.`
                );
              }
            }
          } else if (!isOwner && !milestoneOppId) {
            return error(
              `Ownership check failed: milestone ${milestoneNumber || nid} is not owned by you ` +
              `and has no linked opportunity for deal-team verification.`
            );
          }
        }
      }

      // ── No-op stripping: remove payload fields that match current values ──
      // When AI callers over-send unchanged fields alongside the intended
      // change, narrow the staged payload to only truly-changed fields.
      // Forecast-comment fields are append-only/derived and always preserved.
      for (const key of Object.keys(payload)) {
        if (key === 'msp_forecastcomments' || key === 'msp_forecastcommentsjsonfield') continue;

        if (key.endsWith('@odata.bind')) {
          const bindingValue = payload[key];
          if (bindingValue === null) continue; // clearing a binding is always a change
          const guidMatch = String(bindingValue).match(
            /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i
          );
          if (guidMatch) {
            const fieldName = key.replace('@odata.bind', '').toLowerCase();
            const lookupKey = `_${fieldName}_value`;
            const currentGuid = normalizeGuid(record[lookupKey]);
            const newGuid = normalizeGuid(guidMatch[1]);
            if (currentGuid && currentGuid === newGuid) {
              delete payload[key];
            }
          }
        } else {
          const currentValue = record[key] ?? null;
          const newValue = payload[key] ?? null;
          if (currentValue === newValue) {
            delete payload[key];
          } else if (
            currentValue !== null &&
            newValue !== null &&
            String(currentValue) === String(newValue)
          ) {
            // Type-coerced match (e.g. number 861980000 vs string "861980000")
            delete payload[key];
          }
        }
      }

      if (Object.keys(payload).length === 0) {
        return error(
          'No changes detected — all provided values match the current milestone record. ' +
          'Only supply fields you want to change.'
        );
      }

      // Build before-state limited to fields being changed
      const before = {};
      for (const key of Object.keys(payload)) {
        before[key] = record[key] ?? null;
      }

      // Identity metadata for pre-execution verification
      const identity = {
        milestoneNumber,
        milestoneName,
        opportunityId: milestoneOppId,
        opportunityName,
      };

      const humanDesc = `Update milestone ${milestoneNumber || nid}` +
        (milestoneName ? ` ("${milestoneName}")` : '') +
        (opportunityName ? ` on "${opportunityName}"` : '') +
        `: ${Object.keys(payload).join(', ')}`;

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_milestone',
        entitySet: `msp_engagementmilestones(${nid})`,
        method: 'PATCH',
        payload,
        beforeState: before,
        description: humanDesc,
        etag: updateMilestoneEtag
      });
      // Attach identity for execution-time re-verification
      op.identity = identity;

      // Resolve the parent account name so the audit record shows the real
      // customer company, not the milestone name or opportunity name.
      // A lightweight lookup on the parent opportunity (already fetched partially
      // during ownership check; this fetch adds _parentaccountid_value).
      if (milestoneOppId) {
        try {
          const oppAccRes = await crmClient.request(`opportunities(${normalizeGuid(milestoneOppId)})`, {
            query: { $select: '_parentaccountid_value' }
          });
          if (oppAccRes.ok && oppAccRes.data) {
            const accountCompany = fv(oppAccRes.data, '_parentaccountid_value') || null;
            op.accountName = accountCompany;
          }
        } catch {
          // Best-effort: leave op.accountName null if lookup fails
        }
      }
      op.recordName = milestoneName || null;
      op.friendlyDescription = buildAuditFriendlyDesc(op, 'milestone');

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        identity,
        before: resolvePayloadLabels(before),
        after: resolvePayloadLabels(payload),
        payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`
      });
    }
  );

  // ── list_accounts_by_tpid ───────────────────────────────────
  server.tool(
    'list_accounts_by_tpid',
    'Find accounts by MS Top Parent ID (TPID). Returns account GUIDs and names.',
    {
      tpids: z.array(z.string()).describe('Array of TPID values (numeric strings)')
    },
    async ({ tpids }) => {
      if (!tpids?.length) return error('At least one TPID is required');
      const valid = tpids.filter(isValidTpid);
      if (!valid.length) return error('No valid TPIDs provided');

      const filter = valid.map(t => `msp_mstopparentid eq '${sanitizeODataString(t)}'`).join(' or ');
      const result = await crmClient.requestAllPages('accounts', {
        query: {
          $filter: filter,
          $select: 'accountid,name,msp_mstopparentid',
          $orderby: 'name'
        }
      });
      if (!result.ok) return error(`Account lookup failed (${result.status}): ${result.data?.message}`);
      const accounts = result.data?.value || [];
      return text({ count: accounts.length, accounts });
    }
  );

  // ── get_milestone_field_options ─────────────────────────────
  server.tool(
    'get_milestone_field_options',
    'Retrieve available picklist options for milestone fields from Dynamics 365 metadata. Use before create_milestone to discover valid values for required fields.',
    {
      field: z.enum(['workloadType', 'deliveredBy', 'preferredAzureRegion', 'azureCapacityType', 'milestoneStatusReason', 'helpNeeded']).describe('Which milestone picklist field to retrieve options for')
    },
    async ({ field }) => {
      const fieldMap = {
        workloadType: 'msp_milestoneworkload',
        deliveredBy: 'msp_deliveryspecifiedfield',
        preferredAzureRegion: 'msp_milestonepreferredazureregion',
        azureCapacityType: 'msp_milestoneazurecapacitytype',
        milestoneStatusReason: 'msp_milestonestatusreason',
        helpNeeded: 'msp_helpneeded'
      };
      const logicalName = fieldMap[field];
      const result = await crmClient.request(
        `EntityDefinitions(LogicalName='msp_engagementmilestone')/Attributes(LogicalName='${logicalName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata`,
        { query: { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' } }
      );
      if (!result.ok) return error(`Metadata query failed (${result.status}): ${result.data?.message}`);

      const options = result.data?.OptionSet?.Options || [];
      const parsed = options
        .map(o => ({
          value: o?.Value,
          label: o?.Label?.UserLocalizedLabel?.Label || o?.Label?.LocalizedLabels?.[0]?.Label || ''
        }))
        .filter(o => Number.isInteger(o.value) && o.label);
      return text({ field, logicalName, options: parsed });
    }
  );

  // ── get_task_status_options ─────────────────────────────────
  server.tool(
    'get_task_status_options',
    'Retrieve available task status/statuscode options from Dynamics 365 metadata.',
    {},
    async () => {
      const result = await crmClient.request(
        "EntityDefinitions(LogicalName='task')/Attributes(LogicalName='statuscode')/Microsoft.Dynamics.CRM.StatusAttributeMetadata",
        { query: { $select: 'LogicalName', $expand: 'OptionSet($select=Options)' } }
      );
      if (!result.ok) return error(`Metadata query failed (${result.status}): ${result.data?.message}`);

      const options = result.data?.OptionSet?.Options || [];
      const parsed = options
        .map(o => ({
          value: o?.Value,
          label: o?.Label?.UserLocalizedLabel?.Label || o?.Label?.LocalizedLabels?.[0]?.Label || '',
          stateCode: o?.State
        }))
        .filter(o => Number.isInteger(o.value) && o.label);
      return text(parsed);
    }
  );

  // ── get_milestone_activities ────────────────────────────────
  server.tool(
    'get_milestone_activities',
    'List tasks/activities linked to one or more engagement milestones. Supports batch retrieval via milestoneIds array.',
    {
      milestoneId: z.string().optional().describe('Single engagement milestone GUID'),
      milestoneIds: z.array(z.string()).optional().describe('Array of milestone GUIDs for batch retrieval')
    },
    async ({ milestoneId, milestoneIds }) => {
      // Batch mode
      if (milestoneIds?.length) {
        const validIds = milestoneIds.map(normalizeGuid).filter(isValidGuid);
        if (!validIds.length) return error('No valid milestone GUIDs in milestoneIds');
        const chunks = [];
        for (let i = 0; i < validIds.length; i += 25) chunks.push(validIds.slice(i, i + 25));
        const allTasks = [];
        for (const chunk of chunks) {
          const batchFilter = chunk.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
          const batchResult = await crmClient.requestAllPages('tasks', {
            query: {
              $filter: batchFilter,
              $select: 'activityid,subject,scheduledend,statuscode,statecode,_ownerid_value,description,msp_taskcategory,_regardingobjectid_value',
              $orderby: 'createdon desc'
            }
          });
          if (batchResult.ok && batchResult.data?.value) allTasks.push(...batchResult.data.value);
        }
        // Group by milestone and add recordUrls
        const base = getCrmBase();
        const byMilestone = {};
        for (const t of allTasks) {
          const msId = t._regardingobjectid_value;
          if (!byMilestone[msId]) byMilestone[msId] = [];
          byMilestone[msId].push({ ...t, recordUrl: buildRecordUrl(base, 'task', t.activityid) });
        }
        return text({ count: allTasks.length, byMilestone });
      }

      // Single mode (backward-compatible)
      if (!milestoneId) return error('Provide milestoneId or milestoneIds');
      const nid = normalizeGuid(milestoneId);
      if (!isValidGuid(nid)) return error('Invalid milestoneId GUID');

      const filter = `_regardingobjectid_value eq '${nid}'`;
      const result = await crmClient.requestAllPages('tasks', {
        query: {
          $filter: filter,
          $select: 'activityid,subject,scheduledend,statuscode,statecode,_ownerid_value,description,msp_taskcategory',
          $orderby: 'createdon desc'
        }
      });
      if (!result.ok) return error(`Get activities failed (${result.status}): ${result.data?.message}`);
      const tasks = (result.data?.value || []).map(t => ({ ...t, recordUrl: buildRecordUrl(getCrmBase(), 'task', t.activityid) }));
      return text({ count: tasks.length, tasks });
    }
  );

  // ── find_milestones_needing_tasks ───────────────────────────
  server.tool(
    'find_milestones_needing_tasks',
    'Composite tool: resolves customer keywords → accounts → opportunities → milestones, then identifies milestones without linked tasks.',
    {
      customerKeywords: z.array(z.string()).describe('Array of customer name keywords to search'),
      statusFilter: z.enum(['active', 'all']).optional().describe('Milestone status filter (default: active)')
    },
    async ({ customerKeywords, statusFilter = 'active' }) => {
      if (!customerKeywords?.length) return error('At least one customerKeyword is required');

      const customers = [];
      let totalNeedingTasks = 0;

      for (const keyword of customerKeywords) {
        const sanitized = sanitizeODataString(keyword.trim());

        // 1. Resolve accounts
        const acctResult = await crmClient.requestAllPages('accounts', {
          query: { $filter: `contains(name,'${sanitized}')`, $select: 'accountid,name', $top: '50' }
        });
        const accounts = acctResult.ok ? (acctResult.data?.value || []) : [];
        if (!accounts.length) {
          customers.push({ customer: keyword, error: 'No matching accounts found', milestonesNeedingTasks: 0, milestones: [] });
          continue;
        }

        // 2. Get opportunities for matched accounts
        const acctIds = accounts.map(a => a.accountid);
        const acctFilter = acctIds.map(id => `_parentaccountid_value eq '${id}'`).join(' or ');
        const oppResult = await crmClient.requestAllPages('opportunities', {
          query: { $filter: `(${acctFilter}) and statecode eq 0`, $select: OPP_SELECT, $orderby: 'name' }
        });
        const opps = oppResult.ok ? (oppResult.data?.value || []) : [];
        if (!opps.length) {
          customers.push({ customer: keyword, milestonesNeedingTasks: 0, milestones: [], accounts: accounts.map(a => a.name) });
          continue;
        }

        // 3. Get milestones for opportunities
        const oppIds = opps.map(o => o.opportunityid);
        const oppFilter = oppIds.map(id => `_msp_opportunityid_value eq '${id}'`).join(' or ');
        const msResult = await crmClient.requestAllPages('msp_engagementmilestones', {
          query: { $filter: oppFilter, $select: MILESTONE_SELECT, $orderby: 'msp_milestonedate' }
        });
        let milestones = msResult.ok ? (msResult.data?.value || []) : [];

        // Apply status filter
        if (statusFilter === 'active') {
          milestones = milestones.filter(m => ACTIVE_STATUSES.has(fv(m, 'msp_milestonestatus')));
        }

        if (!milestones.length) {
          customers.push({ customer: keyword, milestonesNeedingTasks: 0, milestones: [] });
          continue;
        }

        // 4. Batch task check
        const msIds = milestones.map(m => m.msp_engagementmilestoneid);
        const taskFilter = msIds.map(id => `_regardingobjectid_value eq '${id}'`).join(' or ');
        const taskResult = await crmClient.requestAllPages('tasks', {
          query: { $filter: taskFilter, $select: '_regardingobjectid_value' }
        });
        const taskMsIds = new Set();
        if (taskResult.ok && taskResult.data?.value) {
          for (const t of taskResult.data.value) taskMsIds.add(t._regardingobjectid_value);
        }

        const needingTasks = milestones.filter(m => !taskMsIds.has(m.msp_engagementmilestoneid));
        totalNeedingTasks += needingTasks.length;

        customers.push({
          customer: keyword,
          milestonesNeedingTasks: needingTasks.length,
          totalMilestones: milestones.length,
          milestones: needingTasks.map(m => ({
            id: m.msp_engagementmilestoneid,
            number: m.msp_milestonenumber,
            name: m.msp_name,
            status: fv(m, 'msp_milestonestatus'),
            commitment: commitmentLabel(m),
            date: toIsoDate(m.msp_milestonedate),
            opportunity: fv(m, '_msp_opportunityid_value'),
            workload: fv(m, '_msp_workloadlkid_value'),
            recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', m.msp_engagementmilestoneid)
          }))
        });
      }

      return text({ totalMilestonesNeedingTasks: totalNeedingTasks, customers });
    }
  );

  // ── view_milestone_timeline ─────────────────────────────────
  server.tool(
    'view_milestone_timeline',
    'Return timeline-friendly milestone events for a user or opportunity, with render hints for Copilot UI.',
    {
      ownerId: z.string().optional().describe('System user GUID to filter milestone owner'),
      opportunityId: z.string().optional().describe('Opportunity GUID to filter milestones'),
      fromDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('End date (YYYY-MM-DD)')
    },
    async ({ ownerId, opportunityId, fromDate, toDate }) => {
      if (!ownerId && !opportunityId) {
        return error('Provide ownerId or opportunityId');
      }

      const filters = [];
      if (ownerId) {
        const ownerNid = normalizeGuid(ownerId);
        if (!isValidGuid(ownerNid)) return error('Invalid ownerId GUID');
        filters.push(`_ownerid_value eq '${ownerNid}'`);
      }

      if (opportunityId) {
        const oppNid = normalizeGuid(opportunityId);
        if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');
        filters.push(`_msp_opportunityid_value eq '${oppNid}'`);
      }

      if (fromDate) filters.push(`msp_milestonedate ge ${sanitizeODataString(fromDate)}`);
      if (toDate) filters.push(`msp_milestonedate le ${sanitizeODataString(toDate)}`);

      const result = await crmClient.requestAllPages('msp_engagementmilestones', {
        query: {
          $filter: filters.join(' and '),
          $select: 'msp_engagementmilestoneid,msp_milestonenumber,msp_name,msp_milestonestatus,msp_commitmentrecommendation,msp_milestonedate,msp_monthlyuse,_msp_opportunityid_value',
          $orderby: 'msp_milestonedate asc'
        }
      });
      if (!result.ok) return error(`Timeline query failed (${result.status}): ${result.data?.message}`);

      const milestones = result.data?.value || [];
      const oppIds = [...new Set(milestones.map(m => m._msp_opportunityid_value).filter(Boolean))];
      const opportunityNames = {};

      for (const id of oppIds) {
        const opp = await crmClient.request(`opportunities(${id})`, { query: { $select: 'name' } });
        if (opp.ok && opp.data?.name) opportunityNames[id] = opp.data.name;
      }

      const base = getCrmBase();
      const events = milestones.map(m => ({
        id: m.msp_engagementmilestoneid,
        date: toIsoDate(m.msp_milestonedate),
        title: m.msp_name,
        milestoneNumber: m.msp_milestonenumber,
        status: m['msp_milestonestatus@OData.Community.Display.V1.FormattedValue'] ?? m.msp_milestonestatus,
        commitment: commitmentLabel(m),
        monthlyUse: m.msp_monthlyuse ?? null,
        opportunityId: m._msp_opportunityid_value ?? null,
        opportunityName: opportunityNames[m._msp_opportunityid_value] ?? null,
        recordUrl: buildRecordUrl(base, 'msp_engagementmilestone', m.msp_engagementmilestoneid)
      }));

      return text({
        count: events.length,
        events,
        renderHints: {
          view: 'timeline',
          defaultSort: { field: 'date', direction: 'asc' },
          dateField: 'date',
          titleField: 'title',
          laneField: 'opportunityName',
          statusField: 'status'
        }
      });
    }
  );

  // ── view_opportunity_cost_trend ────────────────────────────
  server.tool(
    'view_opportunity_cost_trend',
    'Return monthly cost/consumption trend points for an opportunity with chart/table render hints.',
    {
      opportunityId: z.string().describe('Opportunity GUID'),
      includeMilestones: z.boolean().optional().describe('Include milestone monthly-use points (default true)')
    },
    async ({ opportunityId, includeMilestones = true }) => {
      const oppNid = normalizeGuid(opportunityId);
      if (!isValidGuid(oppNid)) return error('Invalid opportunityId GUID');

      const opportunityResult = await crmClient.request(`opportunities(${oppNid})`, {
        query: {
          $select: 'opportunityid,name,estimatedclosedate,msp_estcompletiondate,msp_consumptionconsumedrecurring'
        }
      });
      if (!opportunityResult.ok) {
        return error(`Opportunity lookup failed (${opportunityResult.status}): ${opportunityResult.data?.message}`);
      }

      const opportunity = opportunityResult.data || {};
      const byMonth = new Map();

      if (includeMilestones) {
        const milestoneResult = await crmClient.requestAllPages('msp_engagementmilestones', {
          query: {
            $filter: `_msp_opportunityid_value eq '${oppNid}'`,
            $select: 'msp_milestonedate,msp_monthlyuse,msp_name,msp_milestonenumber',
            $orderby: 'msp_milestonedate asc'
          }
        });
        if (!milestoneResult.ok) {
          return error(`Milestone trend query failed (${milestoneResult.status}): ${milestoneResult.data?.message}`);
        }

        for (const milestone of milestoneResult.data?.value || []) {
          const key = monthKey(milestone.msp_milestonedate);
          const amount = Number(milestone.msp_monthlyuse ?? 0);
          if (!key || Number.isNaN(amount)) continue;
          byMonth.set(key, (byMonth.get(key) || 0) + amount);
        }
      }

      const points = [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, planned]) => ({ month, plannedMonthlyUse: planned }));

      const totalPlanned = points.reduce((sum, point) => sum + point.plannedMonthlyUse, 0);
      const consumedRecurring = Number(opportunity.msp_consumptionconsumedrecurring ?? 0);

      return text({
        opportunity: {
          id: opportunity.opportunityid,
          name: opportunity.name,
          estimatedCloseDate: toIsoDate(opportunity.estimatedclosedate),
          estimatedCompletionDate: toIsoDate(opportunity.msp_estcompletiondate),
          consumedRecurring
        },
        points,
        kpis: {
          consumedRecurring,
          totalPlannedMonthlyUse: totalPlanned,
          latestPlannedMonthlyUse: points.length ? points[points.length - 1].plannedMonthlyUse : 0
        },
        renderHints: {
          view: 'timeseries',
          xField: 'month',
          yFields: ['plannedMonthlyUse'],
          currency: 'USD',
          defaultChart: 'line',
          showTable: true
        }
      });
    }
  );

  // ── view_staged_changes_diff ───────────────────────────────
  server.tool(
    'view_staged_changes_diff',
    'Build a render-friendly before/after diff table from staged write payloads.',
    {
      before: z.object({}).passthrough().describe('Current values object (before)'),
      after: z.object({}).passthrough().describe('Proposed values object (after)'),
      context: z.string().optional().describe('Optional context label (e.g. operation ID)')
    },
    async ({ before, after, context }) => {
      const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
      const rows = keys
        .map((field) => {
          const beforeValue = before?.[field] ?? null;
          const afterValue = after?.[field] ?? null;
          const beforeText = beforeValue === null ? null : String(beforeValue);
          const afterText = afterValue === null ? null : String(afterValue);

          if (beforeText === afterText) return null;

          let changeType = 'updated';
          if (beforeValue === null && afterValue !== null) changeType = 'added';
          if (beforeValue !== null && afterValue === null) changeType = 'removed';

          return {
            field,
            before: beforeValue,
            after: afterValue,
            changeType
          };
        })
        .filter(Boolean);

      return text({
        context: context || null,
        summary: {
          changedFieldCount: rows.length
        },
        rows,
        renderHints: {
          view: 'diffTable',
          columns: ['field', 'before', 'after', 'changeType'],
          emphasisField: 'changeType'
        }
      });
    }
  );

  // ── list_pending_operations ──────────────────────────────────
  server.tool(
    'list_pending_operations',
    'List all staged CRM write operations awaiting human approval. Includes both pending and stale-conflict ops.',
    {},
    async () => {
      const queue = getApprovalQueue();
      const pending = queue.listPending();
      // Also surface stale-conflict ops for review/override
      const staleConflict = [...queue.getAll().values()].filter(op => op.status === 'stale-conflict');
      const allOps = [...pending, ...staleConflict];
      const now = Date.now();
      // An op waiting for another one lives exactly as long as that op stays queued.
      const expiresAtOf = (op) => (op.dependsOn ? queue.getAll().get(op.dependsOn)?.expiresAt : null) ?? op.expiresAt;
      return text({
        count: allOps.length,
        pendingCount: pending.length,
        staleConflictCount: staleConflict.length,
        operations: allOps.map(op => ({
          id: op.id,
          type: op.type,
          status: op.status,
          description: op.description,
          stagedAt: op.stagedAt,
          expiresInMs: Math.max(0, expiresAtOf(op) - now),
          entitySet: op.entitySet,
          method: op.method,
          retryCount: op.retryCount ?? 0,
          lastError: op.lastError ?? null,
          ...(op.dependsOn && { dependsOn: op.dependsOn }),
          ...(op.resolvedFrom && { resolvedFrom: op.resolvedFrom }),
          ...(op.recordName && { recordName: op.recordName }),
          ...(op.accountName && { accountName: op.accountName }),
          ...(op.friendlyDescription && { friendlyDescription: op.friendlyDescription }),
          before: op.beforeState,
          after: op.payload,
        })),
      });
    }
  );

  // ── execute_operation ──────────────────────────────────────
  // Milestones staged with a new opportunity (create_milestone parentOperationId) run right after
  // it: same steps as execute_operation's create_milestone path. execute_all reaches them on its
  // own: its run order puts them right after the opportunity.
  async function runReleasedMilestones(ids) {
    const queue = getApprovalQueue();
    const results = [];
    for (const depId of ids) {
      const dep = queue.approve(depId);
      if (!dep) {
        results.push({ id: depId, type: 'create_milestone', success: false, reason: 'expired or missing' });
        continue;
      }
      let res;
      try {
        res = await executeCreateMilestone(crmClient, dep, getCrmBase);
      } catch (err) {
        // The POST may have landed: leave it approved (resumable via execute_operation), like execute_all.
        captureAuditRecord(dep, { phase: 'uncertain', error: err?.message || 'unexpected error' }, getCurrentActor());
        results.push({ id: depId, type: 'create_milestone', success: false, reason: err?.message || 'unexpected error' });
        continue;
      }
      if (res.ok || res.status === 204) {
        queue.markExecuted(depId, res.data);
        captureAuditRecord(dep, { phase: 'executed', result: { ok: true, status: res.status || 204, data: res.data } }, getCurrentActor());
        results.push({ id: depId, type: 'create_milestone', success: true, milestoneId: res.data?.milestoneId ?? null, recordName: dep.recordName ?? null, recordUrl: res.data?.recordUrl ?? null, ...(res.data?.partial ? { partial: true, message: res.data.message } : {}) });
        continue;
      }
      const failMessage = res.data?.message || res.message || 'unknown error';
      const willDeadLetter = (dep.retryCount ?? 0) + 1 >= MAX_RETRIES;
      dep.correlationId = null; // Manual path: the dead-letter listener writes null (no batch id)
      queue.markFailed(depId, failMessage, res.status);
      if (!willDeadLetter) {
        captureAuditRecord(dep, { phase: 'failed', result: { ok: false, status: res.status }, error: failMessage }, getCurrentActor());
      }
      results.push({ id: depId, type: 'create_milestone', success: false, reason: failMessage });
    }
    return results;
  }

  server.tool(
    'execute_operation',
    'Approve and execute a single staged CRM write operation by ID. Executing a staged opportunity create also runs the milestones staged with it (create_milestone parentOperationId), right after it.',
    {
      id: z.string().describe('Operation ID (e.g. "OP-1")'),
      override: z.boolean().optional().describe('Force override stale-conflict by re-reading current record and applying with fresh etag')
    },
    async ({ id, override }) => {
      const queue = getApprovalQueue();
      const waiting = queue.get(id);
      if (waiting?.status === 'pending' && waiting.dependsOn) {
        return error(queue.get(waiting.dependsOn)
          ? `${id} runs right after ${waiting.dependsOn}, which creates its opportunity. Execute ${waiting.dependsOn} (or execute_all) to run both.`
          : `${id} was waiting for ${waiting.dependsOn}, which is no longer queued. Cancel ${id} and stage the milestone again on the opportunity.`);
      }
      // approve() expects 'pending'; also accept 'approved' (orphaned from a failed batch)
      let op = queue.approve(id);
      if (!op) {
        const existing = queue.get(id);
        if (existing && existing.status === 'approved') {
          op = existing; // resume orphaned approved op
        } else if (existing && existing.status === 'stale-conflict' && override) {
          // Allow override re-execution of stale-conflict
          op = existing;
          op.status = 'approved';
        } else {
          return error(`Operation ${id} not found, already executed, or expired.`);
        }
      }

      // Pre-execution integrity check for milestone updates
      if (op.type === 'update_milestone' && op.identity?.milestoneNumber) {
        const recheck = await crmClient.request(op.entitySet, {
          query: { $select: 'msp_milestonenumber,msp_name,_msp_opportunityid_value' }
        });
        if (!recheck.ok) {
          queue.markFailed(id, 'Pre-execution verification failed: milestone no longer accessible');
          captureAuditRecord(op, { phase: 'precheck-abort', error: 'milestone no longer accessible' }, getCurrentActor());
          return error(`${id} aborted: milestone no longer accessible (${recheck.status}). The record may have been deleted.`);
        }
        const currentNumber = recheck.data?.msp_milestonenumber;
        if (currentNumber && currentNumber !== op.identity.milestoneNumber) {
          queue.markFailed(id, `Milestone number mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}`);
          captureAuditRecord(op, { phase: 'precheck-abort', error: `identity mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}` }, getCurrentActor());
          return error(
            `${id} aborted: milestone identity mismatch. ` +
            `Expected milestone number ${op.identity.milestoneNumber} but record at this GUID is ${currentNumber}. ` +
            `This may indicate the wrong milestone was targeted.`
          );
        }
      }

      // Handle override: re-read current record for fresh etag
      if (override && (op.method === 'PATCH' || op.method === 'DELETE')) {
        const entityPath = op.entitySet;
        // Re-read ONLY to obtain a fresh @odata.etag. Do NOT derive $select from
        // op.beforeState: its keys are payload field names — e.g. change_owner's
        // { owner } or update_* ops' `ownerid@odata.bind` lookup keys — which are NOT
        // valid $select columns and make CRM return 400, aborting every override
        // (this silently defeated the Bug-1 owner-change retry). A plain GET returns
        // @odata.etag regardless; retries:2 rides out a transient 429/5xx on the re-read.
        const rereadResult = await crmClient.request(entityPath, { retries: 2 });
        if (rereadResult.status === 404) {
          // Record deleted since staging — ABORT override
          queue.markFailed(id, 'Record deleted since staging');
          captureAuditRecord(op, { phase: 'override-abort-404', error: 'Record deleted since staging' }, getCurrentActor());
          return error(`${id} aborted: record was deleted since staging. Cannot apply override to a deleted record.`);
        }
        if (rereadResult.ok && rereadResult.data?.['@odata.etag']) {
          op.etag = rereadResult.data['@odata.etag'];
        } else {
          // Reread failed or returned no etag — abort to prevent a blind forced overwrite.
          // 404 is already handled above; any other non-ok or missing etag is a real problem.
          const abortReason = !rereadResult.ok
            ? `Re-read for fresh etag failed (${rereadResult.status}): ${rereadResult.data?.message || 'CRM error'}`
            : 'Re-read succeeded but returned no etag — cannot override without concurrency protection.';
          queue.markFailed(id, abortReason);
          captureAuditRecord(op, { phase: 'override-abort-reread-failed', error: abortReason }, getCurrentActor());
          return error(`${id} aborted: ${abortReason}`);
        }
      }

      // Execute against CRM (wrapped in try/catch to capture exceptions)
      let result;
      try {
        if (op.type === 'close_task') {
          // Try primary CloseTask action, fallback to bound Close
          result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
          if (!result.ok && result.status !== 204 && op.fallbackEntitySet) {
            result = await crmClient.request(op.fallbackEntitySet, { method: 'POST', body: op.fallbackPayload });
          }
          // Third fallback: direct PATCH with state+status
          if (!result.ok && result.status !== 204) {
            const taskId = op.description.match(/task ([a-f0-9-]+)/)?.[1];
            if (taskId) {
              const sc = op.fallbackPayload?.Status || 5;
              result = await crmClient.request(`tasks(${taskId})`, {
                method: 'PATCH',
                body: { statecode: taskStateForStatus(sc), statuscode: sc },
                etag: op.etag
              });
            }
          }
        } else if (op.type === 'close_opportunity') {
          // Try with current status code first
          result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });

          // If status code is invalid and user didn't explicitly provide one, auto-discover from metadata
          const isInvalidStatus = !result.ok && result.status !== 204
            && typeof result.data?.message === 'string'
            && result.data.message.includes('is not a valid status code');

          if (isInvalidStatus && !op._userStatusCode) {
            const targetState = op._closeStatus === 'won' ? 1 : 2; // 1=Won, 2=Lost
            const metaPath = "EntityDefinitions(LogicalName='opportunity')/Attributes(LogicalName='statuscode')" +
              '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)';
            const metaResult = await crmClient.request(metaPath);

            if (metaResult.ok) {
              const options = metaResult.data?.OptionSet?.Options || [];
              const validCodes = options
                .filter(o => o.State === targetState)
                .map(o => o.Value);

              if (validCodes.length > 0) {
                const discoveredCode = validCodes[0];
                const retryPayload = { ...op.payload, Status: discoveredCode };
                result = await crmClient.request(op.entitySet, { method: op.method, body: retryPayload });

                if (result.ok || result.status === 204) {
                  // Annotate result so caller sees which code worked
                  result._discoveredStatusCode = discoveredCode;
                  logRuntimeFinding(
                    'api-error',
                    `WinOpportunity/LoseOpportunity: standard status code rejected. Discovered valid code: ${discoveredCode} for state=${targetState}.`,
                    `Action: ${op.entitySet}, Original code attempted: ${op.payload.Status}`
                  );
                }
              }
            }
          }
        } else if (op.type === 'close_msx_opportunity') {
          result = await executeCloseMsxOpportunity(crmClient, op);
        } else if (op.type === 'reactivate_msx_opportunity') {
          result = await executeReactivateMsxOpportunity(crmClient, op);
        } else if (op.type === 'create_opportunity') {
          result = await executeCreateOpportunity(crmClient, op, getCrmBase);
        } else if (op.type === 'create_milestone') {
          result = await executeCreateMilestone(crmClient, op, getCrmBase);
        } else if (op.type === 'update_opportunity_stage') {
          result = await executeMcemStageTransition(crmClient, op);
        } else if (op.type === 'add_opportunity_solution_play') {
          result = await executeAddOpportunitySolutionPlay(crmClient, op);
        } else if (op.type === 'set_opportunity_solution_play_primary') {
          result = await executeSetSolutionPlayPrimary(crmClient, op);
        } else {
          result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload, etag: op.etag });
        }
      } catch (err) {
        // Network/timeout/unexpected error — capture audit record, then re-throw
        // Phase: 'uncertain' for POST (may have succeeded), 'failed' for GET/PATCH/DELETE
        const isPost = op.method === 'POST';
        const phase = isPost ? 'uncertain' : 'failed';
        captureAuditRecord(op, { phase, error: err?.message || 'unexpected error' }, getCurrentActor());
        // Re-throw to preserve original error behavior (caller sees the exception)
        throw err;
      }

      if (result.ok || result.status === 204) {
        // Link the milestones staged with a new opportunity while it is still queued (they wait on it).
        const released = op.type === 'create_opportunity'
          ? bindMilestonesToCreatedOpportunity(queue, op, result.data?.opportunityId, result.data?.record)
          : [];
        queue.markExecuted(id, result.data);
        // Note override in audit if used
        const auditRecord = { phase: 'executed', result: { ok: true, status: result.status || 204, data: result.data } };
        if (override) {
          auditRecord.override = true;
          auditRecord.note = 'Executed with override (fresh etag).';
        }
        captureAuditRecord(op, auditRecord, getCurrentActor());
        const response = { success: true, executed: id, type: op.type, description: op.description, ...(result.data || {}) };
        if (result._discoveredStatusCode !== undefined) {
          response.discoveredStatusCode = result._discoveredStatusCode;
          response.note = `Standard status code was invalid. Auto-discovered and used status code ${result._discoveredStatusCode} from CRM metadata.`;
        }
        if (override) {
          response.override = true;
          response.note = (response.note ? response.note + ' ' : '') + 'Executed with override (fresh etag).';
        }
        if (released.length) response.dependentMilestones = await runReleasedMilestones(released);
        return text(response);
      }

      // Handle 412 Precondition Failed (stale-conflict)
      if (result.status === 412) {
        queue.markStaleConflict(id);
        captureAuditRecord(op, { phase: 'stale-conflict', result: { ok: false, status: 412 }, error: 'Precondition Failed: record was modified since staging' }, getCurrentActor());
        return error(`Execution of ${id} failed: stale-conflict (412). The record was modified by another user since staging. Review the current state and re-stage, or use execute_operation with override=true to force apply.`);
      }

      const failMessage = result.data?.message || result.message || 'unknown error';
      const willDeadLetter = (op.retryCount ?? 0) + 1 >= MAX_RETRIES;
      op.correlationId = null; // Manual path: ensure dead-letter listener writes null (no batch id)
      queue.markFailed(id, failMessage, result.status);
      // Only write 'failed' record if NOT transitioning to dead-letter (dead-letter listener writes it)
      if (!willDeadLetter) {
        captureAuditRecord(op, { phase: 'failed', result: { ok: false, status: result.status }, error: failMessage }, getCurrentActor());
      }
      if (result.data && (result.data.partial || result.data.completedSteps || result.data.failedStep)) {
        return text({
          error: true,
          ...result.data,
          message: failMessage,
          status: result.status
        });
      }
      return error(`Execution of ${id} failed (${result.status}): ${failMessage}`);
    }
  );

  // ── execute_all ────────────────────────────────────────────
  server.tool(
    'execute_all',
    'Approve and execute ALL pending staged operations in sequence. Milestones staged with a new opportunity (create_milestone parentOperationId) run right after it; if it is not created they are skipped and stay queued.',
    {},
    async () => {
      const queue = getApprovalQueue();
      const pending = orderDependentsAfterParents(queue.listPending());
      if (!pending.length) return text({ executed: 0, message: 'No pending operations.' });

      // Phase 2.5: ONE shared correlationId stamps every audit record produced by this PLAY run.
      // correlationId != null distinguishes batch (PLAY) from manual one-by-one (execute_operation).
      const correlationId = 'batch_' + Date.now() + '_' + randomUUID().slice(0, 8);

      // Track records written in THIS PLAY run (key = base entity instance, value = latest etag).
      // Used to detect self-inflicted 412s: when two ops in the same PLAY target the same record,
      // op1 bumps the etag so op2's staging-time etag is stale — but that is NOT a real conflict.
      // Normalize to the BASE entity-instance key so a bound-action write (e.g. the MCEM stage
      // transition staged as `opportunities(<id>)/mcem-stage-transition`, which PATCHes the base
      // `opportunities(<id>)`) is recognized as having written the same opportunity that a later
      // owner PATCH on `opportunities(<id>)` targets — otherwise that owner op would falsely look
      // like a third-party conflict and never self-recover.
      const writtenThisPlay = new Map();
      const baseEntityKey = (es) => {
        const s = String(es || '').toLowerCase();
        const m = s.match(/^([a-z0-9_]+\([^)]+\))/);
        return m ? m[1] : s;
      };

      const results = [];
      for (const op of pending) {
        try {
          if (op.dependsOn) {
            // Still waiting: the opportunity create it follows did not complete (or was not queued) in this run.
            results.push({ id: op.id, type: op.type, success: false, skipped: true, dependsOn: op.dependsOn, reason: `Skipped — runs after ${op.dependsOn}, which did not complete.` });
            continue;
          }
          const approved = queue.approve(op.id);
          if (!approved) {
            results.push({ id: op.id, type: op.type, success: false, reason: 'expired or missing' });
            continue;
          }

          // Stamp once so every dead-letter path for this op inherits the run id.
          // The ONLY reader is the dead-letter listener (tools.js:3430); all other
          // audit calls pass correlationId explicitly as the 4th arg.
          op.correlationId = correlationId;

          // Pre-execution integrity check for milestone updates
          if (op.type === 'update_milestone' && op.identity?.milestoneNumber) {
            const recheck = await crmClient.request(op.entitySet, {
              query: { $select: 'msp_milestonenumber,msp_name,_msp_opportunityid_value' }
            });
            if (!recheck.ok) {
              queue.markFailed(op.id, 'Pre-execution verification failed: milestone no longer accessible');
              captureAuditRecord(op, { phase: 'precheck-abort', error: 'milestone no longer accessible' }, getCurrentActor(), correlationId);
              results.push({ id: op.id, type: op.type, success: false, reason: 'milestone no longer accessible' });
              continue;
            }
            const currentNumber = recheck.data?.msp_milestonenumber;
            if (currentNumber && currentNumber !== op.identity.milestoneNumber) {
              queue.markFailed(op.id, `Milestone number mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}`);
              captureAuditRecord(op, { phase: 'precheck-abort', error: `identity mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}` }, getCurrentActor(), correlationId);
              results.push({ id: op.id, type: op.type, success: false, reason: `identity mismatch: expected ${op.identity.milestoneNumber}, got ${currentNumber}` });
              continue;
            }
          }

          let result;
          if (op.type === 'close_task') {
            result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });
            if (!result.ok && result.status !== 204 && op.fallbackEntitySet) {
              result = await crmClient.request(op.fallbackEntitySet, { method: 'POST', body: op.fallbackPayload });
            }
            // Third fallback: direct PATCH with state+status
            if (!result.ok && result.status !== 204) {
              const taskId = op.description.match(/task ([a-f0-9-]+)/)?.[1];
              if (taskId) {
                const sc = op.fallbackPayload?.Status || 5;
                result = await crmClient.request(`tasks(${taskId})`, {
                  method: 'PATCH',
                  body: { statecode: taskStateForStatus(sc), statuscode: sc },
                  etag: op.etag
                });
              }
            }
          } else if (op.type === 'close_opportunity') {
            result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload });

            const isInvalidStatus = !result.ok && result.status !== 204
              && typeof result.data?.message === 'string'
              && result.data.message.includes('is not a valid status code');

            if (isInvalidStatus && !op._userStatusCode) {
              const targetState = op._closeStatus === 'won' ? 1 : 2;
              const metaPath = "EntityDefinitions(LogicalName='opportunity')/Attributes(LogicalName='statuscode')" +
                '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)';
              const metaResult = await crmClient.request(metaPath);

              if (metaResult.ok) {
                const options = metaResult.data?.OptionSet?.Options || [];
                const validCodes = options
                  .filter(o => o.State === targetState)
                  .map(o => o.Value);

                if (validCodes.length > 0) {
                  const discoveredCode = validCodes[0];
                  const retryPayload = { ...op.payload, Status: discoveredCode };
                  result = await crmClient.request(op.entitySet, { method: op.method, body: retryPayload });
                  if (result.ok || result.status === 204) {
                    logRuntimeFinding(
                      'api-error',
                      `WinOpportunity/LoseOpportunity: standard status code rejected. Discovered valid code: ${discoveredCode} for state=${op._closeStatus === 'won' ? 1 : 2}.`,
                      `Action: ${op.entitySet}, Original code attempted: ${op.payload.Status}`
                    );
                  }
                }
              }
            }
          } else if (op.type === 'close_msx_opportunity') {
            result = await executeCloseMsxOpportunity(crmClient, op);
          } else if (op.type === 'reactivate_msx_opportunity') {
            result = await executeReactivateMsxOpportunity(crmClient, op);
          } else if (op.type === 'create_opportunity') {
            result = await executeCreateOpportunity(crmClient, op, getCrmBase);
          } else if (op.type === 'create_milestone') {
            result = await executeCreateMilestone(crmClient, op, getCrmBase);
          } else if (op.type === 'update_opportunity_stage') {
            result = await executeMcemStageTransition(crmClient, op);
          } else if (op.type === 'add_opportunity_solution_play') {
            result = await executeAddOpportunitySolutionPlay(crmClient, op);
          } else if (op.type === 'set_opportunity_solution_play_primary') {
            result = await executeSetSolutionPlayPrimary(crmClient, op);
          } else {
            result = await crmClient.request(op.entitySet, { method: op.method, body: op.payload, etag: op.etag });
          }

          // Handle 412 Precondition Failed (stale-conflict)
          // If this exact record was already written by an earlier op in THIS PLAY run, the 412 is
          // self-inflicted: our prior write bumped the etag and op.etag (captured at staging) is now
          // stale. Re-fetch the current etag and retry once with it.
          // If the record was NOT written by us in this play, treat it as a genuine third-party
          // conflict and keep the existing markStaleConflict behavior.
          if (result.status === 412) {
            const recKey = baseEntityKey(op.entitySet);
            if (writtenThisPlay.has(recKey) && (op.method === 'PATCH' || op.method === 'DELETE')) {
              // Self-inflicted 412: an earlier op in this PLAY wrote this record. Re-fetch a fresh
              // etag and re-apply. Retry with backoff to ride out Dynamics async churn (e.g. the
              // MCEM stage transition keeps bumping the opp etag after its synchronous response,
              // which otherwise stales a following owner PATCH on the same opportunity).
              let selfRecovered = false;
              const SELF_BACKOFFS_MS = [0, 300, 600, 1000, 1500];
              for (let a = 0; a < SELF_BACKOFFS_MS.length && !selfRecovered; a++) {
                try {
                  if (SELF_BACKOFFS_MS[a]) await new Promise((r) => setTimeout(r, SELF_BACKOFFS_MS[a]));
                  const refetch = await crmClient.request(op.entitySet, { method: 'GET' });
                  if (!refetch.ok || !refetch.data?.['@odata.etag']) break;
                  const freshEtag = refetch.data['@odata.etag'];
                  const retryResult = await crmClient.request(op.entitySet, { method: op.method, body: op.payload, etag: freshEtag });
                  if (retryResult.ok || retryResult.status === 204) {
                    writtenThisPlay.set(recKey, retryResult.data?.['@odata.etag'] ?? null);
                    queue.markExecuted(op.id, retryResult.data);
                    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: retryResult.status || 204, data: retryResult.data }, note: `self-recovered: etag refreshed after same-play 412 (attempt ${a + 1})` }, getCurrentActor(), correlationId);
                    results.push({ id: op.id, type: op.type, success: true, note: 'self-recovered' });
                    selfRecovered = true;
                  } else if (retryResult.status !== 412) {
                    break; // non-412 error — stop retrying, fall through to stale handling
                  }
                  // else 412 again: loop with more backoff
                } catch (_retryErr) {
                  // Refetch or retry threw — stop; fall back to stale-conflict, never crash the batch.
                  break;
                }
              }
              if (selfRecovered) continue;
            }
            // Genuine stale conflict (record not written by us in this play, or self-recovery failed)
            queue.markStaleConflict(op.id);
            captureAuditRecord(op, { phase: 'stale-conflict', result: { ok: false, status: 412 }, error: 'Precondition Failed: record was modified since staging' }, getCurrentActor(), correlationId);
            results.push({ id: op.id, type: op.type, success: false, reason: 'stale-conflict (412): record was modified since staging' });
            continue; // Skip to next op — do NOT markFailed or dead-letter
          }

          if (result.ok || result.status === 204) {
            // Link the milestones staged with a new opportunity while it is still queued; `pending`
            // lists them right after it, so this run executes them next.
            const released = op.type === 'create_opportunity'
              ? bindMilestonesToCreatedOpportunity(queue, op, result.data?.opportunityId, result.data?.record)
              : [];
            writtenThisPlay.set(baseEntityKey(op.entitySet), result.data?.['@odata.etag'] ?? null);
            queue.markExecuted(op.id, result.data);
            captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: result.status || 204, data: result.data } }, getCurrentActor(), correlationId);
            
            // Enrich result for create_opportunity: frontend needs opportunityId + recordName + requiresFirstMilestone
            if (op.type === 'create_opportunity') {
              // msp_opportunitytype is a multi-select picklist. normalizeMultiSelect stores it as a
              // comma-separated STRING (e.g. "606820001" or "606820000,606820001"), but it may also
              // arrive as a number or array. Normalize to numeric codes so Consumption (606820001) is
              // detected regardless of shape.
              const rawOppType = op.payload?.create?.msp_opportunitytype;
              const oppTypeCodes = (Array.isArray(rawOppType) ? rawOppType : String(rawOppType ?? '').split(','))
                .map(v => Number(String(v).trim()))
                .filter(n => !Number.isNaN(n));
              const isConsumption = oppTypeCodes.includes(606820001);
              results.push({
                id: op.id,
                type: 'create_opportunity',
                success: true,
                opportunityId: result.data?.opportunityId ?? null,
                recordName: op.recordName ?? null,
                requiresFirstMilestone: isConsumption,
                ...(released.length ? { dependentMilestones: released } : {}),
              });
            } else if (op.type === 'create_milestone') {
              // Enrich result for create_milestone: frontend may need milestoneId + recordName
              results.push({
                id: op.id,
                type: 'create_milestone',
                success: true,
                milestoneId: result.data?.milestoneId ?? null,
                recordName: op.recordName ?? null,
                ...(op.resolvedFrom ? { parentOperationId: op.resolvedFrom, opportunityId: op.payload?.opportunityId ?? null } : {}),
              });
            } else {
              results.push({ id: op.id, type: op.type, success: true });
            }
          } else {
            const failMessage = result.data?.message || result.message || 'unknown error';
            const willDeadLetter = (op.retryCount ?? 0) + 1 >= MAX_RETRIES;
            queue.markFailed(op.id, failMessage, result.status);
            // Only write 'failed' record if NOT transitioning to dead-letter (dead-letter listener writes it)
            if (!willDeadLetter) {
              captureAuditRecord(op, { phase: 'failed', result: { ok: false, status: result.status }, error: failMessage }, getCurrentActor(), correlationId);
            }
            results.push({ id: op.id, type: op.type, success: false, reason: failMessage });
          }
        } catch (err) {
          // Batch exception path — record failed result WITHOUT calling markFailed
          captureAuditRecord(op, { phase: 'failed', error: err?.message || 'unexpected error' }, getCurrentActor(), correlationId);
          results.push({ id: op.id, type: op.type, success: false, reason: err?.message || 'unexpected error' });
        }
      }

      const executed = results.filter(r => r.success).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed = results.filter(r => !r.success && !r.skipped).length;
      return text({ executed, failed, skipped, results, correlationId, total: results.length });
    }
  );

  // ── cancel_operation ───────────────────────────────────────
  server.tool(
    'cancel_operation',
    'Cancel/reject a single staged operation by ID. No CRM changes are made. Cancelling a staged opportunity create also cancels the milestones staged with it.',
    {
      id: z.string().describe('Operation ID (e.g. "OP-1")')
    },
    async ({ id }) => {
      const queue = getApprovalQueue();
      const [op, ...dependents] = queue.rejectWithDependents(id);
      if (!op) return error(`Operation ${id} not found or already processed.`);
      return text({ cancelled: id, type: op.type, description: op.description, ...(dependents.length ? { cancelledDependents: dependents.map(d => d.id) } : {}) });
    }
  );

  // ── cancel_all ─────────────────────────────────────────────
  server.tool(
    'cancel_all',
    'Cancel/reject ALL pending staged operations. No CRM changes are made.',
    {},
    async () => {
      const queue = getApprovalQueue();
      const rejected = queue.rejectAll();
      return text({
        cancelled: rejected.length,
        operations: rejected.map(op => ({ id: op.id, type: op.type, description: op.description })),
      });
    }
  );

  // ── list_failed_operations ────────────────────────────────────
  server.tool(
    'list_failed_operations',
    'List all CRM write operations that failed after exhausting retries (dead-letter queue).',
    {},
    async () => {
      const queue = getApprovalQueue();
      const failed = queue.getDeadLetterQueue();
      return text({
        count: failed.length,
        operations: failed.map(op => ({
          id: op.id,
          type: op.type,
          description: op.description,
          stagedAt: op.stagedAt,
          retryCount: op.retryCount,
          lastError: op.lastError,
        })),
      });
    }
  );

  // ── retry_failed_operation ─────────────────────────────────
  server.tool(
    'retry_failed_operation',
    'Move a failed operation from the dead-letter queue back to pending for retry.',
    {
      operationId: z.string().describe('Operation ID (e.g. "OP-1")')
    },
    async ({ operationId }) => {
      const queue = getApprovalQueue();
      const op = queue.retryFromDeadLetter(operationId);
      if (!op) return error(`Operation ${operationId} not found in dead-letter queue.`);
      return text({ retried: op.id, type: op.type, description: op.description, status: op.status });
    }
  );

  // ── crm_auth_status ─────────────────────────────────────────
  server.tool(
    'crm_auth_status',
    'Check authentication status — shows current user, expiry, CRM URL.',
    {},
    async () => {
      const authResult = await crmClient.request('WhoAmI');
      if (!authResult.ok) return error(`Not authenticated: ${authResult.data?.message || authResult.status}`);
      return text({
        authenticated: true,
        userId: authResult.data?.UserId,
        businessUnitId: authResult.data?.BusinessUnitId,
        organizationId: authResult.data?.OrganizationId
      });
    }
  );

  // ── read_skill ──────────────────────────────────────────────
  server.tool(
    'read_skill',
    'Read MCEM domain knowledge. Available skills: mcem-pipeline-azure (Azure consumption pipeline), mcem-pipeline-usage (Usage/M365/BizApps pipeline), mcem-framework (MCEM stages and orchestration), mcaps-glossary (MCAPS terminology), msxiq-data-catalog (what data MSX-IQ can access). Use this when you need detailed pipeline rules, ownership logic, or MCEM methodology beyond the basics in the system prompt.',
    {
      skill_name: z.string().describe('Skill directory name: mcem-pipeline-azure, mcem-pipeline-usage, mcem-framework, mcaps-glossary, or msxiq-data-catalog')
    },
    async ({ skill_name }) => {
      // Sanitize to prevent path traversal
      if (/[/\\]|\.\./.test(skill_name)) {
        return error('Invalid skill name — must not contain path separators or "..".');
      }

      const __dirname = dirname(fileURLToPath(import.meta.url));
      const skillsDir = resolve(__dirname, '..', '..', '..', '.copilot', 'skills');
      const skillFile = join(skillsDir, skill_name, 'SKILL.md');

      try {
        const content = readFileSync(skillFile, 'utf-8');
        return text(content);
      } catch (e) {
        // List available skills so the caller can pick a valid one
        let available = [];
        try {
          available = readdirSync(skillsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        } catch (_) { /* skills dir missing */ }

        return error(
          `Skill "${skill_name}" not found.` +
          (available.length ? ` Available skills: ${available.join(', ')}` : ' No skills directory found.')
        );
      }
    }
  );

  // ── Territory intelligence ──────────────────────────────────

  /** Country normalization map for tolerant country matching.
   *  Maps common variations (codes, native names) to canonical English names. */
  const COUNTRY_ALIASES = {
    // Spain variants
    'spain': 'Spain',
    'españa': 'Spain', // spanish-ok: España is a legitimate country name alias
    'es': 'Spain',
    // France variants
    'france': 'France',
    'fr': 'France',
    // Germany variants
    'germany': 'Germany',
    'deutschland': 'Germany',
    'de': 'Germany', // spanish-ok: 'de' is German country code, not Spanish preposition
    // United States variants
    'united states': 'United States',
    'usa': 'United States',
    'us': 'United States',
    // United Kingdom variants
    'united kingdom': 'United Kingdom',
    'uk': 'United Kingdom',
    'gb': 'United Kingdom',
    // Add more as needed
  };

  /** Normalize a country input to a canonical form for matching. */
  function normalizeCountry(input) {
    if (!input) return null;
    const lower = input.toLowerCase().trim();
    return COUNTRY_ALIASES[lower] || input; // Return alias or original if no mapping
  }

  /** Resolve accounts by geography attributes: territoryCode, country, segment.
   *  Returns account set with truncation signal when the match exceeds the cap.
   *  This is the SHARED account-resolution helper used by both territory and geography tools. */
  // Cache for segment label→code mapping (invalidated every 5 minutes)
  let segmentCodeCache = null;
  let segmentCodeCacheExpiry = 0;

  async function resolveSegmentCode(segmentLabel) {
    const now = Date.now();
    if (!segmentCodeCache || now > segmentCodeCacheExpiry) {
      // Fetch the msp_endcustomersegmentcode optionset metadata from CRM
      const result = await crmClient.request('EntityDefinitions(LogicalName=\'account\')/Attributes(LogicalName=\'msp_endcustomersegmentcode\')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)');
      if (result.ok && result.data?.OptionSet?.Options) {
        segmentCodeCache = new Map();
        for (const opt of result.data.OptionSet.Options) {
          const label = opt.Label?.UserLocalizedLabel?.Label || '';
          const code = opt.Value;
          if (label && code !== null && code !== undefined) {
            segmentCodeCache.set(label.toLowerCase().trim(), code);
          }
        }
        segmentCodeCacheExpiry = now + 5 * 60 * 1000; // 5 minutes
      } else {
        return null; // Metadata fetch failed
      }
    }
    const normalized = segmentLabel.toLowerCase().trim();
    return segmentCodeCache.get(normalized) ?? null;
  }

  async function resolveAccountsByAttributes(filters, options = {}) {
    const { territoryCode, country, segment } = filters;
    const limit = options.limit || 200;

    if (!territoryCode && !country && !segment) {
      return { accountIds: [], accounts: [], truncated: false, totalMatched: 0 };
    }

    // Build OData filter for accounts
    const accountFilters = [];
    let expand = '';
    let select = 'accountid,name,msp_mstopparentid';

    // Territory code filter
    if (territoryCode) {
      accountFilters.push(`territoryid/name eq '${sanitizeODataString(territoryCode)}'`);
      expand = 'territoryid($select=name)';
      select += ',_territoryid_value';
    }

    // Country filter (with tolerant matching)
    if (country) {
      const normalized = normalizeCountry(country);
      // Try exact match first, then contains for fuzzy matching
      accountFilters.push(`address1_country eq '${sanitizeODataString(normalized)}'`);
      select += ',address1_country';
    }

    // Segment filter — prefer server-side by code when possible
    let segmentCode = null;
    if (segment) {
      segmentCode = await resolveSegmentCode(segment);
      if (segmentCode !== null) {
        // Server-side filtering by code
        accountFilters.push(`msp_endcustomersegmentcode eq ${segmentCode}`);
        select += ',msp_endcustomersegmentcode';
      } else {
        // Fallback to client-side FormattedValue matching if code resolution fails
        select += ',msp_endcustomersegmentcode';
      }
    }

    const query = {
      $select: select,
      $top: String(limit + 1), // Fetch one extra to detect truncation
    };

    if (expand) query.$expand = expand;
    if (accountFilters.length > 0) query.$filter = accountFilters.join(' and ');

    // For SERVER-SIDE filter paths, get exact total count before fetching rows
    let exactTotalMatched = null;
    const hasServerSideFilter = accountFilters.length > 0 && (territoryCode || country || (segment && segmentCode !== null));
    if (hasServerSideFilter) {
      const countQuery = { $filter: query.$filter, $count: true, $top: '0' };
      if (expand) countQuery.$expand = expand; // Expand needed for territoryCode filter
      const countResult = await crmClient.request('accounts', { query: countQuery });
      if (countResult.ok && countResult.data?.['@odata.count'] !== undefined) {
        exactTotalMatched = countResult.data['@odata.count'];
      }
      // If count fails, we'll fall back to the list-based estimate below
    }

    const result = await crmClient.requestAllPages('accounts', { query });
    if (!result.ok || !result.data?.value) {
      return { accountIds: [], accounts: [], truncated: false, totalMatched: 0 };
    }

    let accounts = result.data.value;

    // Client-side segment filter using FormattedValue (only if server-side didn't work)
    if (segment && segmentCode === null) {
      const segmentNorm = segment.toLowerCase().trim();
      accounts = accounts.filter(a => {
        const label = fv(a, 'msp_endcustomersegmentcode');
        return label && label.toLowerCase().trim() === segmentNorm;
      });
    }

    // Detect truncation — only claim "complete" when the query truly fetched all matching records
    const fetchedCount = result.data.value.length;
    const afterFilterCount = accounts.length;
    let truncated = false;
    let totalMatched;

    if (exactTotalMatched !== null) {
      // Server-side path with real $count: use exact total
      totalMatched = exactTotalMatched;
      truncated = afterFilterCount < exactTotalMatched;
    } else if (segmentCode !== null) {
      // Server-side filtering (segment by code) but count failed: honest truncation signal
      truncated = fetchedCount > limit;
      totalMatched = truncated ? limit + 1 : fetchedCount; // Signal "at least limit+1" when truncated
    } else if (segment) {
      // Client-side filtering: can only claim complete if we fetched FEWER than limit+1 (no cap hit)
      const hitCap = fetchedCount > limit;
      if (hitCap) {
        // We hit the cap BEFORE filtering — the true total is unknown, so mark truncated
        truncated = true;
        totalMatched = afterFilterCount; // Best we can say is "at least this many"
      } else {
        // We fetched all accounts (no cap hit), so the filtered count is complete
        truncated = false;
        totalMatched = afterFilterCount;
      }
    } else {
      // No segment filter: simple truncation check
      truncated = fetchedCount > limit;
      totalMatched = truncated ? limit + 1 : fetchedCount;
    }

    if (truncated && afterFilterCount > limit) accounts = accounts.slice(0, limit);

    const accountIds = accounts.map(a => a.accountid);

    return {
      accountIds,
      accounts,
      truncated,
      totalMatched, // Exact for server-side paths, honest estimate otherwise
    };
  }

  // Resolve an MSX territory filter (ATU Group / Sales Unit / Sales Group / Area)
  // to its territories and member accounts. Cached for 5 minutes.
  async function resolveTerritory(filters, accountLimit = 200) {
    const { atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment } = filters;
    
    // If geography filters are provided, use the new resolution path
    if (territoryCode || country || segment) {
      const resolved = await resolveAccountsByAttributes(
        { territoryCode, country, segment },
        { limit: accountLimit }
      );
      return {
        atuGroup: '',
        territories: [],
        accountIds: resolved.accountIds,
        accounts: resolved.accounts,
        truncated: resolved.truncated,
        totalMatched: resolved.totalMatched,
      };
    }

    if (!atuGroup && !salesUnit && !salesGroup && !area) {
      return { atuGroup: '', territories: [], accountIds: [], accounts: [], truncated: false, totalMatched: 0 };
    }

    const cacheKey = `terr:${(atuGroup || '').toLowerCase()}:${(salesUnit || '').toLowerCase()}:${(salesGroup || '').toLowerCase()}:${(area || '').toLowerCase()}:${accountLimit}`;
    const cached = territoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    // Area → optionset code lookup (msp_salesgeographyareacode is numeric)
    const areaCodeMap = {
      'north europe': 861980000,
      'germany & austria': 861980001,
      'germany and austria': 861980001,
      'uk & ireland': 861980002,
      'uk and ireland': 861980002,
      'united states': 861980003,
      usa: 861980003,
      japan: 861980004,
      canada: 861980005,
      corphq: 861980008,
      'emea hq': 861980009,
      france: 861980010,
      'greater china': 861980011,
      india: 861980012,
      latam: 861980013,
      anz: 861980016,
      korea: 861980017,
      mea: 861980018,
      netherlands: 861980019,
      switzerland: 861980020,
      asean: 861980021,
      'south europe': 606820000,
    };

    const terrFilters = [];
    if (atuGroup)
      terrFilters.push(`contains(msp_accountteamunitgroupname,'${sanitizeODataString(atuGroup)}')`);
    if (salesUnit)
      terrFilters.push(`contains(msp_salesunitname,'${sanitizeODataString(salesUnit)}')`);
    if (salesGroup)
      terrFilters.push(`contains(msp_salesgroupname,'${sanitizeODataString(salesGroup)}')`);
    if (area) {
      const areaCode = areaCodeMap[area.toLowerCase()];
      if (areaCode !== undefined) {
        terrFilters.push(`msp_salesgeographyareacode eq ${areaCode}`);
      } else {
        return { atuGroup: atuGroup || '', territories: [], accountIds: [], accounts: [] };
      }
    }

    const terrResult = await crmClient.requestAllPages('territories', {
      query: {
        $filter: terrFilters.join(' and '),
        $select:
          'territoryid,name,msp_accountteamunitgroupname,msp_accountteamunitname,msp_salesunitname,msp_salesgroupname',
        $orderby: 'msp_accountteamunitgroupname asc,name asc',
        $top: '200',
      },
    });
    if (!terrResult.ok || !terrResult.data?.value?.length) {
      return { atuGroup: atuGroup || '', territories: [], accountIds: [], accounts: [] };
    }
    const territories = terrResult.data.value;

    const territoryIds = territories.map((t) => t.territoryid).filter(Boolean);
    const terrChunks = chunkArray(territoryIds, 15);
    const accResults = await Promise.all(
      terrChunks.map((chunk) => {
        const orFilter = chunk.map((id) => `_territoryid_value eq '${id}'`).join(' or ');
        return crmClient.requestAllPages('accounts', {
          query: {
            $filter: orFilter,
            $select: 'accountid,name,msp_mstopparentid',
            $top: String(accountLimit),
          },
        });
      }),
    );
    const allAccounts = [];
    for (const accResult of accResults) {
      if (accResult.ok && accResult.data?.value) allAccounts.push(...accResult.data.value);
    }

    const seen = new Set();
    const uniqueAccounts = allAccounts
      .filter((a) => {
        if (seen.has(a.accountid)) return false;
        seen.add(a.accountid);
        return true;
      });

    // Detect truncation
    const totalMatched = uniqueAccounts.length;
    const truncated = totalMatched > accountLimit;
    const limitedAccounts = truncated ? uniqueAccounts.slice(0, accountLimit) : uniqueAccounts;

    const data = {
      atuGroup: territories[0].msp_accountteamunitgroupname || atuGroup || '',
      territories,
      accountIds: limitedAccounts.map((a) => a.accountid),
      accounts: limitedAccounts,
      truncated,
      totalMatched: truncated ? accountLimit + 1 : totalMatched, // Signal "at least accountLimit+1" when truncated
    };

    territoryCache.set(cacheKey, { data, expiresAt: Date.now() + 5 * 60 * 1000 });
    return data;
  }

  const TERRITORY_FILTER_SCHEMA = {
    atuGroup: z
      .string()
      .optional()
      .describe('ATU Group name (e.g. "USA - Healthcare - Provider Major"). Partial match.'),
    salesUnit: z
      .string()
      .optional()
      .describe('Sales Unit name (e.g. "USA - Healthcare"). Partial match.'),
    salesGroup: z
      .string()
      .optional()
      .describe('Sales Group name (e.g. "USA - Health & FinServ"). Partial match.'),
    area: z
      .string()
      .optional()
      .describe(
        'Geography area name. Valid values: United States, Canada, Latam, UK & Ireland, North Europe, South Europe, Germany & Austria, France, Netherlands, Switzerland, EMEA HQ, MEA, India, Japan, Korea, Greater China, ASEAN, ANZ, CorpHQ.',
      ),
    territoryCode: z
      .string()
      .optional()
      .describe('Territory code (e.g. "SE.ES.EC.OCI.01.MG.02"). Exact match on territoryid.name field.'),
    country: z
      .string()
      .optional()
      .describe('Country name or code (e.g. "Spain", "España", "ES"). Tolerant matching with common aliases.'), // spanish-ok: España is a legitimate country name example
    segment: z
      .string()
      .optional()
      .describe('Customer segment label (e.g. "Upper Majors Commercial"). Case-insensitive match on segment FormattedValue.'),
  };

  // ── list_territory_accounts ─────────────────────────────────
  server.tool(
    'list_territory_accounts',
    'List all accounts in an MSX territory or by geography attributes. Scope by ATU Group, Sales Unit, Sales Group, Area, Territory Code (territoryid.name), Country (with tolerant matching), or Segment. At least one filter is required. Use specific ATU Group names (e.g. "USA - Healthcare - Provider Major") or Territory Code (e.g. "SE.ES.EC.OCI.01.MG.02") for narrow results, or broader Sales Group / Area / Country / Segment for wider scope.',
    {
      ...TERRITORY_FILTER_SCHEMA,
      limit: z.number().optional().describe('Maximum number of accounts to return (default 100)'),
    },
    async ({ atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment, limit }) => {
      if (!atuGroup && !salesUnit && !salesGroup && !area && !territoryCode && !country && !segment) {
        return error(
          'At least one territory or geography filter is required: atuGroup, salesUnit, salesGroup, area, territoryCode, country, or segment.',
        );
      }
      const effectiveLimit = Math.min(limit || 100, 500);
      const resolved = await resolveTerritory(
        { atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment },
        effectiveLimit
      );
      auditLog({
        tool: 'list_territory_accounts',
        entitySet: 'accounts',
        params: { atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment },
        recordCount: resolved.accounts.length,
      });

      if (!resolved.accounts.length) {
        const filterDesc = territoryCode || country || segment || atuGroup || salesUnit || salesGroup || area || 'unknown';
        return text({
          count: 0,
          atuGroup: resolved.atuGroup,
          accounts: [],
          truncated: false,
          message: `No accounts found matching filter '${filterDesc}'.`,
        });
      }

      return text({
        count: resolved.accounts.length,
        atuGroup: resolved.atuGroup,
        territoriesResolved: resolved.territories?.length || 0,
        truncated: resolved.truncated || false,
        totalMatched: resolved.totalMatched,
        accounts: resolved.accounts.map((a, i) => ({
          index: i + 1,
          name: a.name,
          tpid: a.msp_mstopparentid || null,
          accountId: a.accountid,
        })),
      });
    },
  );

  // ── list_territory_opportunities ────────────────────────────
  server.tool(
    'list_territory_opportunities',
    'List opportunities across an MSX territory or by geography attributes. Scope by ATU Group, Sales Unit, Sales Group, Area, Territory Code, Country, or Segment. At least one filter is required. Opportunities are aggregated across all matching accounts.' +
      ETAG_RETURNED_NOTE,
    {
      ...TERRITORY_FILTER_SCHEMA,
      status: z
        .enum(['open', 'won', 'lost'])
        .optional()
        .describe('Filter by opportunity status (default: open)'),
      minValue: z.number().optional().describe('Minimum estimated value filter'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of opportunities to return (default 50)'),
    },
    async ({ atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment, status, minValue, limit }) => {
      if (!atuGroup && !salesUnit && !salesGroup && !area && !territoryCode && !country && !segment) {
        return error(
          'At least one territory or geography filter is required: atuGroup, salesUnit, salesGroup, area, territoryCode, country, or segment.',
        );
      }
      const effectiveLimit = Math.min(limit || 50, 200);
      const resolved = await resolveTerritory({ atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment });

      if (!resolved.accountIds.length) {
        const filterDesc = territoryCode || country || segment || atuGroup || salesUnit || salesGroup || area || 'unknown';
        return text({
          count: 0,
          totalOpportunities: 0,
          atuGroup: resolved.atuGroup,
          opportunities: [],
          truncated: false,
          message: `No accounts found matching filter '${filterDesc}', so no opportunities to show.`,
        });
      }

      const stateCode = status === 'won' ? 1 : status === 'lost' ? 2 : 0;
      
      // Build the opportunity filter ONCE (shared by count and list queries for consistency)
      const buildOppFilter = (accountChunk) => {
        let filter = `(${accountChunk.map((id) => `_parentaccountid_value eq '${id}'`).join(' or ')}) and statecode eq ${stateCode}`;
        if (minValue !== undefined) filter += ` and estimatedvalue ge ${minValue}`;
        return filter;
      };
      
      // First, get total count of ALL opportunities across ALL matched accounts (for exact "how many")
      let totalOpportunities = 0;
      let countQueryFailed = false;
      const countChunks = chunkArray(resolved.accountIds, 15);
      const countResults = await Promise.all(
        countChunks.map((chunk) => {
          return crmClient.request('opportunities', {
            query: {
              $filter: buildOppFilter(chunk), // EXACT SAME filter as list query
              $count: true,
              $top: '0', // We only want the count
            },
          });
        }),
      );
      for (const result of countResults) {
        if (result.ok && result.data?.['@odata.count'] !== undefined) {
          totalOpportunities += result.data['@odata.count'];
        } else {
          countQueryFailed = true; // Flag that at least one count request failed
        }
      }

      // Then fetch the display-capped list
      const allOpps = [];
      const terrOppChunks = chunkArray(resolved.accountIds, 15);
      const terrOppResults = await Promise.all(
        terrOppChunks.map((chunk) => {
          return crmClient.requestAllPages('opportunities', {
            query: {
              $filter: buildOppFilter(chunk), // EXACT SAME filter as count query
              $select: OPP_SELECT,
              $orderby: 'estimatedvalue desc',
              $top: String(effectiveLimit),
            },
          });
        }),
      );
      for (const result of terrOppResults) {
        if (result.ok && result.data?.value) allOpps.push(...result.data.value);
      }

      const seen = new Set();
      const unique = allOpps
        .filter((o) => {
          if (seen.has(o.opportunityid)) return false;
          seen.add(o.opportunityid);
          return true;
        })
        .sort((a, b) => (b.estimatedvalue || 0) - (a.estimatedvalue || 0))
        .slice(0, effectiveLimit);

      // Guard: if $count returned 0 but rows exist, use rows as floor and flag discrepancy
      if (totalOpportunities === 0 && unique.length > 0) {
        totalOpportunities = unique.length; // Use list count as floor
        countQueryFailed = true; // Flag the discrepancy
      }

      const base = getCrmBase();
      auditLog({
        tool: 'list_territory_opportunities',
        entitySet: 'opportunities',
        params: { atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment, status, minValue },
        recordCount: unique.length,
      });

      const result = {
        count: unique.length,
        totalOpportunities, // Exact count of ALL matched opps across ALL resolved accounts
        atuGroup: resolved.atuGroup,
        accountsTruncated: resolved.truncated || false,
        totalAccounts: resolved.totalMatched,
        truncated: unique.length < totalOpportunities, // Display was capped
        opportunities: unique.map((o, i) => ({
          index: i + 1,
          opportunityNumber: o.msp_opportunitynumber || null,
          name: o.name,
          customer: fv(o, '_parentaccountid_value') || null,
          estimatedValue: o.estimatedvalue || 0,
          estCompletionDate: o.msp_estcompletiondate || o.estimatedclosedate || null,
          salesPlay: fv(o, 'msp_salesplay') || null,
          solutionArea: fv(o, 'msp_solutionarea') || null,
          stage: fv(o, 'msp_activesalesstage') || null,
          recordUrl: buildRecordUrl(base, 'opportunity', o.opportunityid),
          etag: o['@odata.etag'],
        })),
      };

      // If count query failed or disagreed with rows, add a note (for debugging, not always user-facing)
      if (countQueryFailed) {
        result._countNote = 'Count query failed or returned 0 while rows exist; totalOpportunities may be incomplete. Use list count as floor.';
      }

      return text(result);
    },
  );

  // ── get_territory_overview ──────────────────────────────────
  server.tool(
    'get_territory_overview',
    'Complete territory overview: account count, pipeline summary by stage, top opportunities. Scope by ATU Group, Sales Unit, Sales Group, Area, Territory Code, Country, or Segment. At least one filter is required.' +
      ETAG_RETURNED_NOTE,
    { ...TERRITORY_FILTER_SCHEMA },
    async ({ atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment }) => {
      if (!atuGroup && !salesUnit && !salesGroup && !area && !territoryCode && !country && !segment) {
        return error(
          'At least one territory or geography filter is required: atuGroup, salesUnit, salesGroup, area, territoryCode, country, or segment.',
        );
      }
      const resolved = await resolveTerritory({ atuGroup, salesUnit, salesGroup, area, territoryCode, country, segment });

      if (!resolved.accountIds.length) {
        const filterDesc = territoryCode || country || segment || atuGroup || salesUnit || salesGroup || area || 'unknown';
        return text({
          atuGroup: resolved.atuGroup,
          accountCount: 0,
          truncated: false,
          message: `No accounts found matching filter '${filterDesc}'.`,
        });
      }

      const allOpps = [];
      const overviewOppChunks = chunkArray(resolved.accountIds, 15);
      const overviewOppResults = await Promise.all(
        overviewOppChunks.map((chunk) => {
          const filter = `(${chunk.map((id) => `_parentaccountid_value eq '${id}'`).join(' or ')}) and statecode eq 0`;
          return crmClient.requestAllPages('opportunities', {
            query: {
              $filter: filter,
              $select: OPP_SELECT,
              $orderby: 'estimatedvalue desc',
              $top: '200',
            },
          });
        }),
      );
      for (const result of overviewOppResults) {
        if (result.ok && result.data?.value) allOpps.push(...result.data.value);
      }

      const seen = new Set();
      const opps = allOpps.filter((o) => {
        if (seen.has(o.opportunityid)) return false;
        seen.add(o.opportunityid);
        return true;
      });

      const byStage = {};
      let totalPipeline = 0;
      for (const o of opps) {
        const stage = o.msp_activesalesstage || 'Unknown';
        if (!byStage[stage]) byStage[stage] = { count: 0, totalValue: 0 };
        byStage[stage].count++;
        const val = o.estimatedvalue || 0;
        byStage[stage].totalValue += val;
        totalPipeline += val;
      }

      const top10 = opps
        .sort((a, b) => (b.estimatedvalue || 0) - (a.estimatedvalue || 0))
        .slice(0, 10);

      const accountLookup = {};
      for (const a of resolved.accounts) accountLookup[a.accountid] = a.name;

      auditLog({
        tool: 'get_territory_overview',
        entitySet: 'territories',
        params: { atuGroup },
        recordCount: opps.length,
      });

      return text({
        atuGroup: resolved.atuGroup,
        accountCount: resolved.accounts.length,
        territoryCount: resolved.territories.length,
        openOpportunityCount: opps.length,
        totalPipeline: formatCurrency(totalPipeline),
        pipelineByStage: Object.entries(byStage).map(([stage, data]) => ({
          stage,
          count: data.count,
          totalValue: formatCurrency(data.totalValue),
        })),
        topOpportunities: top10.map((o) => ({
          name: o.name,
          accountName: accountLookup[o._parentaccountid_value] || null,
          estimatedValue: formatCurrency(o.estimatedvalue),
          salesStage: o.msp_activesalesstage,
          closeDate: toIsoDate(o.estimatedclosedate),
          recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', o.opportunityid),
        })),
      });
    },
  );

  // ── get_opportunity_solutions ───────────────────────────────
  server.tool(
    'get_opportunity_solutions',
    'Get the product line items (solutions/products) attached to an opportunity. Shows product name, quantity, pricing, and extended amount.',
    {
      opportunityId: guidSchema.describe('Opportunity GUID'),
    },
    async ({ opportunityId }) => {
      const result = await crmClient.requestAllPages('opportunityproducts', {
        query: {
          $filter: `_opportunityid_value eq '${opportunityId}'`,
          $select:
            'opportunityproductid,productdescription,productname,quantity,priceperunit,extendedamount',
        },
      });

      if (!result.ok) return error(`Query failed (${result.status}): ${result.data?.message}`);
      const products = result.data?.value || [];
      auditLog({
        tool: 'get_opportunity_solutions',
        entitySet: 'opportunityproducts',
        params: { opportunityId },
        recordCount: products.length,
      });

      if (!products.length)
        return text({
          count: 0,
          opportunityId,
          products: [],
          message: 'No products/solutions found for this opportunity.',
        });

      const totalExtended = products.reduce((sum, p) => sum + (p.extendedamount || 0), 0);

      return text({
        count: products.length,
        opportunityId,
        totalExtendedAmount: formatCurrency(totalExtended),
        products: products.map((p) => ({
          productId: p.opportunityproductid,
          name: p.productdescription || p.productname || 'N/A',
          quantity: p.quantity ?? null,
          unitPrice: formatCurrency(p.priceperunit),
          extendedAmount: formatCurrency(p.extendedamount),
        })),
      });
    },
  );

  // ── find_opportunities_by_product ───────────────────────────
  server.tool(
    'find_opportunities_by_product',
    'Find opportunities that have a specific product or solution attached. Searches across opportunity product line items and returns parent opportunities with matched product details.' +
      ETAG_RETURNED_NOTE,
    {
      productName: z.string().describe('Product or solution name to search for (contains match)'),
      accountIds: z.array(z.string()).optional().describe('Optional account GUIDs to narrow scope'),
      status: z
        .enum(['open', 'won', 'lost'])
        .optional()
        .describe('Filter by opportunity status (default: open)'),
      limit: z.number().optional().describe('Maximum results (default 25)'),
    },
    async ({ productName, accountIds, status, limit }) => {
      const effectiveLimit = Math.min(limit || 25, 100);
      const sanitized = sanitizeODataString(productName);

      const productResult = await crmClient.requestAllPages('opportunityproducts', {
        query: {
          $filter: `(contains(productdescription,'${sanitized}') or contains(productname,'${sanitized}'))`,
          $select:
            'opportunityproductid,_opportunityid_value,productdescription,productname,extendedamount',
          $top: '500',
        },
        maxRecords: 500,
      });

      if (!productResult.ok)
        return error(`Product search failed (${productResult.status}): ${productResult.data?.message}`);
      const matchedProducts = productResult.data?.value || [];

      if (!matchedProducts.length)
        return text({
          count: 0,
          productName,
          opportunities: [],
          message: `No opportunities found with product matching "${productName}".`,
        });

      const oppProductMap = new Map();
      for (const p of matchedProducts) {
        const oppId = p._opportunityid_value;
        if (!oppId) continue;
        if (!oppProductMap.has(oppId)) oppProductMap.set(oppId, { products: [], totalAmount: 0 });
        const entry = oppProductMap.get(oppId);
        entry.products.push(p);
        entry.totalAmount += p.extendedamount || 0;
      }

      const oppIds = [...oppProductMap.keys()];
      const stateCode = status === 'won' ? 1 : status === 'lost' ? 2 : 0;
      const prodOppChunks = chunkArray(oppIds, 15);
      const prodOppResults = await Promise.all(
        prodOppChunks.map((chunk) => {
          let filter = `(${chunk.map((id) => `opportunityid eq '${id}'`).join(' or ')}) and statecode eq ${stateCode}`;
          if (accountIds?.length) {
            const validAccounts = accountIds.map(normalizeGuid).filter(isValidGuid);
            if (validAccounts.length) {
              filter += ` and (${validAccounts.map((id) => `_parentaccountid_value eq '${id}'`).join(' or ')})`;
            }
          }
          return crmClient.requestAllPages('opportunities', {
            query: { $filter: filter, $select: OPP_SELECT, $orderby: 'estimatedvalue desc' },
          });
        }),
      );
      const allOpps = [];
      for (const result of prodOppResults) {
        if (result.ok && result.data?.value) allOpps.push(...result.data.value);
      }

      const results = allOpps.slice(0, effectiveLimit).map((o) => {
        const matched = oppProductMap.get(o.opportunityid);
        return {
          opportunityId: o.opportunityid,
          name: o.name,
          estimatedValue: formatCurrency(o.estimatedvalue),
          salesStage: o.msp_activesalesstage,
          closeDate: toIsoDate(o.estimatedclosedate),
          matchedProducts:
            matched?.products.map((p) => ({
              name: p.productdescription || p.productname,
              amount: formatCurrency(p.extendedamount),
            })) || [],
          matchedProductTotal: formatCurrency(matched?.totalAmount),
          recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', o.opportunityid),
        };
      });

      auditLog({
        tool: 'find_opportunities_by_product',
        entitySet: 'opportunityproducts',
        params: { productName, status },
        recordCount: results.length,
      });

      return text({
        count: results.length,
        productName,
        status: status || 'open',
        opportunities: results,
      });
    },
  );

  // ── update_account (staged) ─────────────────────────────────
  server.tool(
    'update_account',
    `Update fields on a customer account (company profile data: name, phone, website, email, address, industry, revenue, headcount, primary contact, owner). Changes are staged for user approval — nothing is written until approved via execute_operation. Allowed fields: ${[...UPDATE_ACCOUNT_FIELDS].join(', ')}.`,
    {
      accountId: guidSchema.describe('Account GUID'),
      fields: z
        .record(z.string(), z.unknown())
        .describe(
          'Object of field name → new value (e.g. { "telephone1": "+1-425-555-1212", "websiteurl": "https://contoso.com" }). Use "primarycontactid@odata.bind": "/contacts(<guid>)" for primary contact and "ownerid@odata.bind": "/systemusers(<guid>)" for owner reassignment.',
        ),
      reason: z.string().optional().describe('Why this change is being made (audited and shown to reviewers)'),
    },
    async ({ accountId, fields, reason }) => {
      if (!fields || !Object.keys(fields).length) return error('No fields provided to update.');

      const rejected = Object.keys(fields).filter((f) => !UPDATE_ACCOUNT_FIELDS.has(f));
      if (rejected.length) {
        return error(
          `Field(s) not allowed: ${rejected.join(', ')}. Permitted: ${[...UPDATE_ACCOUNT_FIELDS].join(', ')}.`,
        );
      }

      const baseSelect = new Set([
        'name',
        'accountid',
        ...Object.keys(fields).map((field) => beforeStateFieldForUpdate(field)),
      ]);
      const current = await crmClient.request(`accounts(${accountId})`, {
        query: { $select: [...baseSelect].join(',') },
      });
      if (!current.ok)
        return error(`Account not found (${current.status}): ${current.data?.message || 'not found'}`);
      const updateAccountEtag = current.data?.['@odata.etag'];
      if (!updateAccountEtag) {
        return error(`Account ${accountId} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      const accountName = current.data?.name || 'Unknown';
      const payload = { ...fields };
      const payloadAllowlistError = validateWritePayloadFields(payload, UPDATE_ACCOUNT_FIELDS);
      if (payloadAllowlistError) return error(payloadAllowlistError);

      const before = {};
      const fieldSummary = {};
      for (const key of Object.keys(fields)) {
        const beforeKey = beforeStateFieldForUpdate(key);
        before[key] = current.data?.[beforeKey] ?? null;
        fieldSummary[key] = { before: current.data?.[beforeKey] ?? null, after: fields[key] };
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_account',
        entitySet: `accounts(${accountId})`,
        method: 'PATCH',
        payload,
        beforeState: before,
        etag: updateAccountEtag,
        description: `Update account "${accountName}" — fields: ${Object.keys(fields).join(', ')}`,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'update_account', entitySet: 'accounts', params: { accountId, fields: Object.keys(fields) }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        identity: { accountId, accountName },
        recordUrl: buildRecordUrl(getCrmBase(), 'account', accountId),
        fieldSummary,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── update_contact (staged) ─────────────────────────────────
  server.tool(
    'update_contact',
    `Update fields on a customer contact (person profile data: name, job title, email, phone, mobile, address, description, parent account, owner). Changes are staged for user approval — nothing is written until approved via execute_operation. Allowed fields: ${[...UPDATE_CONTACT_FIELDS].join(', ')}.`,
    {
      contactId: guidSchema.describe('Contact GUID'),
      fields: z
        .record(z.string(), z.unknown())
        .describe(
          'Object of field name → new value (e.g. { "jobtitle": "VP Engineering", "emailaddress1": "alex@contoso.com" }). Use "parentcustomerid_account@odata.bind": "/accounts(<guid>)" to reparent to a different account and "ownerid@odata.bind": "/systemusers(<guid>)" for owner reassignment.',
        ),
      reason: z.string().optional().describe('Why this change is being made (audited and shown to reviewers)'),
    },
    async ({ contactId, fields, reason }) => {
      if (!fields || !Object.keys(fields).length) return error('No fields provided to update.');

      const rejected = Object.keys(fields).filter((f) => !UPDATE_CONTACT_FIELDS.has(f));
      if (rejected.length) {
        return error(
          `Field(s) not allowed: ${rejected.join(', ')}. Permitted: ${[...UPDATE_CONTACT_FIELDS].join(', ')}.`,
        );
      }

      const baseSelect = new Set([
        'fullname',
        'contactid',
        ...Object.keys(fields).map((field) => beforeStateFieldForUpdate(field)),
      ]);
      const current = await crmClient.request(`contacts(${contactId})`, {
        query: { $select: [...baseSelect].join(',') },
      });
      if (!current.ok)
        return error(`Contact not found (${current.status}): ${current.data?.message || 'not found'}`);
      const updateContactEtag = current.data?.['@odata.etag'];
      if (!updateContactEtag) {
        return error(`Contact ${contactId} read succeeded but no etag returned — cannot stage without optimistic concurrency protection.`);
      }

      const contactName = current.data?.fullname || 'Unknown';
      const payload = { ...fields };
      const payloadAllowlistError = validateWritePayloadFields(payload, UPDATE_CONTACT_FIELDS);
      if (payloadAllowlistError) return error(payloadAllowlistError);

      const before = {};
      const fieldSummary = {};
      for (const key of Object.keys(fields)) {
        const beforeKey = beforeStateFieldForUpdate(key);
        before[key] = current.data?.[beforeKey] ?? null;
        fieldSummary[key] = { before: current.data?.[beforeKey] ?? null, after: fields[key] };
      }

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_contact',
        entitySet: `contacts(${contactId})`,
        method: 'PATCH',
        payload,
        beforeState: before,
        etag: updateContactEtag,
        description: `Update contact "${contactName}" — fields: ${Object.keys(fields).join(', ')}`,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'update_contact', entitySet: 'contacts', params: { contactId, fields: Object.keys(fields) }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        identity: { contactId, contactName },
        recordUrl: buildRecordUrl(getCrmBase(), 'contact', contactId),
        fieldSummary,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── create_contact (staged) ─────────────────────────────────
  server.tool(
    'create_contact',
    `Create a new contact (person) linked to an account. Changes are staged for user approval — nothing is written until approved via execute_operation. Allowed fields: ${[...CREATE_CONTACT_FIELDS].join(', ')}.`,
    {
      accountId: guidSchema.describe('Account GUID to parent the contact to'),
      firstName: z.string().optional().describe('First (given) name'),
      lastName: z.string().describe('Last (family) name — required'),
      jobTitle: z.string().optional().describe('Job title'),
      email: z.string().optional().describe('Primary email address'),
      phone: z.string().optional().describe('Business phone'),
      mobile: z.string().optional().describe('Mobile phone'),
      city: z.string().optional().describe('City'),
      country: z.string().optional().describe('Country'),
      description: z.string().optional().describe('Free-form notes about the contact'),
      reason: z.string().optional().describe('Why this contact is being created (audited and shown to reviewers)'),
    },
    async ({ accountId, firstName, lastName, jobTitle, email, phone, mobile, city, country, description, reason }) => {
      if (!lastName || !lastName.trim()) return error('lastName is required');

      const accLookup = await crmClient.request(`accounts(${accountId})`, { query: { $select: 'name' } });
      if (!accLookup.ok)
        return error(`Account not found (${accLookup.status}): ${accLookup.data?.message || 'not found'}`);
      const accountName = accLookup.data?.name || null;

      const payload = {
        lastname: lastName,
        'parentcustomerid_account@odata.bind': `/accounts(${accountId})`,
      };
      if (firstName) payload.firstname = firstName;
      if (jobTitle) payload.jobtitle = jobTitle;
      if (email) payload.emailaddress1 = email;
      if (phone) payload.telephone1 = phone;
      if (mobile) payload.mobilephone = mobile;
      if (city) payload.address1_city = city;
      if (country) payload.address1_country = country;
      if (description) payload.description = description;

      const payloadAllowlistError = validateWritePayloadFields(payload, CREATE_CONTACT_FIELDS);
      if (payloadAllowlistError) return error(payloadAllowlistError);

      const displayName = [firstName, lastName].filter(Boolean).join(' ');
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'create_contact',
        entitySet: 'contacts',
        method: 'POST',
        payload,
        beforeState: null,
        description: `Create contact "${displayName}" on account ${accountName || accountId}`,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'create_contact', entitySet: 'contacts', params: { accountId, displayName }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        identity: { accountId, accountName, displayName },
        fieldSummary: payload,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── add_opportunity_solution_play (staged) ──────────────────
  // Adds a Solution Play to an opportunity by creating a row in the
  // msp_salesplaychecklists junction entity (what MSX UI Quick Actions →
  // Solution Play → "Add" does). The Solution Play master list lives in
  // msp_accountplansalesplaybooks. After the checklist POST succeeds, the
  // parent opportunity's msp_solutionarea is synced (best-effort) so the UI
  // doesn't flag "Solution Play: Required fields must be filled in".
  server.tool(
    'add_opportunity_solution_play',
    'Add a Solution Play to an opportunity. Looks up the Solution Play by name (contains, case-insensitive) in msp_accountplansalesplaybooks and creates a row in msp_salesplaychecklists linking it to the opportunity. Staged for user approval.',
    {
      opportunityId: guidSchema.describe('Opportunity GUID'),
      solutionPlayName: z
        .string()
        .optional()
        .describe('Solution Play name (e.g. "Copilot and Agents at Work"). Contains-match, case-insensitive. Provide this OR solutionPlayId.'),
      solutionPlayId: guidSchema
        .optional()
        .describe('msp_accountplansalesplaybook GUID. Takes precedence over solutionPlayName when both are provided.'),
      solutionArea: z
        .string()
        .optional()
        .describe('Solution Area to disambiguate when multiple active Solution Plays share the same name. Matched case-insensitively against the play\'s msp_globalsolutionarea formatted label. Ignored when solutionPlayId is provided or only one play matches.'),
      primary: z
        .boolean()
        .optional()
        .describe('Mark this Solution Play as the primary one for the opportunity. Defaults to true when no other primary play exists, otherwise false.'),
      reason: z.string().optional().describe('Why this play is being added (audited and shown to reviewers).'),
    },
    async ({ opportunityId, solutionPlayName, solutionPlayId, solutionArea, primary, reason }) => {
      if (!solutionPlayId && !solutionPlayName) return error('Provide either solutionPlayName or solutionPlayId.');

      const oppLookup = await crmClient.request(`opportunities(${opportunityId})`, {
        query: { $select: 'name,opportunityid,statecode,msp_solutionarea' },
      });
      if (!oppLookup.ok)
        return error(`Opportunity not found (${oppLookup.status}): ${oppLookup.data?.message || 'not found'}`);
      const oppName = oppLookup.data?.name || 'Unknown';
      const currentOppSolutionArea = oppLookup.data?.msp_solutionarea ?? null;
      const currentOppSolutionAreaLabel =
        oppLookup.data?.['msp_solutionarea@OData.Community.Display.V1.FormattedValue'] ?? null;

      let playId = solutionPlayId;
      let playName = null;
      let playSolutionArea = null;

      if (playId) {
        const byId = await crmClient.request(`msp_accountplansalesplaybooks(${playId})`, {
          query: { $select: 'msp_accountplansalesplaybookid,msp_name,msp_salesplayname,msp_globalsolutionarea,statecode' },
        });
        if (!byId.ok)
          return error(`Solution Play ${playId} not found (${byId.status}): ${byId.data?.message || 'not found'}`);
        if (byId.data?.statecode !== 0)
          return error(`Solution Play ${playId} is inactive (statecode=${byId.data?.statecode}). Choose an active Solution Play.`);
        playName = byId.data?.msp_salesplayname || byId.data?.msp_name || null;
        playSolutionArea = byId.data?.msp_globalsolutionarea ?? null;
      } else {
        const needle = solutionPlayName.replace(/'/g, "''");
        const search = await crmClient.requestAllPages('msp_accountplansalesplaybooks', {
          query: {
            $filter: `statecode eq 0 and (contains(msp_name,'${needle}') or contains(msp_salesplayname,'${needle}'))`,
            $select: 'msp_accountplansalesplaybookid,msp_name,msp_salesplayname,msp_globalsolutionarea',
            $top: '5',
          },
        });
        if (!search.ok) return error(`Solution Play search failed (${search.status}): ${search.data?.message}`);
        const matches = search.data?.value || [];
        if (!matches.length) return error(`No Solution Play found matching "${solutionPlayName}".`);

        const exactNameMatches = matches.filter(
          (m) =>
            String(m.msp_name || '').toLowerCase() === solutionPlayName.toLowerCase() ||
            String(m.msp_salesplayname || '').toLowerCase() === solutionPlayName.toLowerCase(),
        );
        const candidates = exactNameMatches.length ? exactNameMatches : matches;
        const describeMatch = (m) =>
          `${m.msp_salesplayname || m.msp_name} [${m['msp_globalsolutionarea@OData.Community.Display.V1.FormattedValue'] || m.msp_globalsolutionarea || 'null'}] (${m.msp_accountplansalesplaybookid})`;

        let chosen = null;
        if (solutionArea && candidates.length > 1) {
          const wanted = solutionArea.toLowerCase().trim();
          const areaMatches = candidates.filter((m) => {
            const areaCode = m.msp_globalsolutionarea;
            if (areaCode === null || areaCode === undefined) return false;
            const oppCode = SOLUTION_AREA_PLAY_TO_OPPORTUNITY[areaCode];
            const playLabel = String(m['msp_globalsolutionarea@OData.Community.Display.V1.FormattedValue'] || '').toLowerCase();
            const cands = [playLabel, String(areaCode)];
            if (oppCode !== undefined) cands.push(String(oppCode));
            return cands.some((c) => c?.includes(wanted));
          });
          if (areaMatches.length === 1) {
            chosen = areaMatches[0];
          } else if (areaMatches.length > 1) {
            return error(`Solution Play "${solutionPlayName}" + Solution Area "${solutionArea}" still matches ${areaMatches.length} plays. Pass solutionPlayId. Matches: ${areaMatches.map(describeMatch).join('; ')}.`);
          } else {
            return error(`Solution Play "${solutionPlayName}" has no candidate matching Solution Area "${solutionArea}". Available: ${candidates.map((m) => `${m.msp_salesplayname || m.msp_name} → ${m['msp_globalsolutionarea@OData.Community.Display.V1.FormattedValue'] || m.msp_globalsolutionarea || 'null'}`).join('; ')}.`);
          }
        }
        if (!chosen) {
          if (candidates.length > 1) {
            return error(`Solution Play name "${solutionPlayName}" matches ${candidates.length} active records — pass solutionArea or solutionPlayId. Matches: ${candidates.map(describeMatch).join('; ')}.`);
          }
          chosen = candidates[0];
        }
        playId = chosen.msp_accountplansalesplaybookid;
        playName = chosen.msp_salesplayname || chosen.msp_name || null;
        playSolutionArea = chosen.msp_globalsolutionarea ?? null;
      }

      // Guard against duplicate checklist rows for the same (opp, play).
      const existing = await crmClient.requestAllPages('msp_salesplaychecklists', {
        query: {
          $filter: `_msp_opportunityid_value eq '${opportunityId}' and _msp_salesplay_value eq '${playId}' and statecode eq 0`,
          $select: 'msp_salesplaychecklistid,msp_primary',
          $top: '1',
        },
      });
      if (!existing.ok)
        return error(`Duplicate check failed (${existing.status}): ${existing.data?.message || 'unknown error'}`);
      if (existing.data?.value?.length) {
        return error(`Solution Play "${playName}" is already attached to this opportunity (checklist ${existing.data.value[0].msp_salesplaychecklistid}).`);
      }

      // Default to primary when no other primary play exists.
      let effectivePrimary = primary;
      if (effectivePrimary === undefined) {
        const primaries = await crmClient.requestAllPages('msp_salesplaychecklists', {
          query: {
            $filter: `_msp_opportunityid_value eq '${opportunityId}' and msp_primary eq true and statecode eq 0`,
            $select: 'msp_salesplaychecklistid',
            $top: '1',
          },
        });
        if (!primaries.ok)
          return error(`Primary Solution Play pre-check failed (${primaries.status}): ${primaries.data?.message || 'unknown error'}`);
        effectivePrimary = !primaries.data?.value?.length;
      }

      const payload = {
        'msp_OpportunityId@odata.bind': `/opportunities(${opportunityId})`,
        'msp_SalesPlay@odata.bind': `/msp_accountplansalesplaybooks(${playId})`,
        msp_primary: effectivePrimary,
      };
      if (playSolutionArea !== null) payload.msp_solutionarea = playSolutionArea;

      // Opportunity-level Solution Area sync (play picklist → opportunity picklist).
      const warnings = [];
      let oppPatchPayload = null;
      const translatedOppArea =
        playSolutionArea !== null ? SOLUTION_AREA_PLAY_TO_OPPORTUNITY[playSolutionArea] ?? null : null;
      if (playSolutionArea === null) {
        warnings.push(`Solution Play "${playName}" has no msp_globalsolutionarea — opportunity Solution Area will not be updated.`);
      } else if (translatedOppArea === null) {
        warnings.push(`Solution Play "${playName}" msp_globalsolutionarea=${playSolutionArea} has no known mapping to opportunity.msp_solutionarea — skipping opportunity PATCH.`);
      } else if (currentOppSolutionArea === translatedOppArea) {
        // Already aligned — no PATCH needed.
      } else if (effectivePrimary) {
        oppPatchPayload = { msp_solutionarea: translatedOppArea };
        if (currentOppSolutionArea !== null && currentOppSolutionArea !== translatedOppArea) {
          warnings.push(`Overwriting opportunity Solution Area ${currentOppSolutionAreaLabel ? `"${currentOppSolutionAreaLabel}" (${currentOppSolutionArea})` : currentOppSolutionArea} → ${translatedOppArea} because this Solution Play is primary.`);
        }
      } else if (currentOppSolutionArea === null) {
        oppPatchPayload = { msp_solutionarea: translatedOppArea };
      }

      const describedOppAreaUpdate = oppPatchPayload ? ` and set opportunity Solution Area to ${translatedOppArea}` : '';

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'add_opportunity_solution_play',
        entitySet: 'msp_salesplaychecklists',
        method: 'POST',
        payload,
        beforeState: null,
        description: `Add Solution Play "${playName}" to opportunity "${oppName}"${effectivePrimary ? ' (primary)' : ''}${describedOppAreaUpdate}`,
      });
      if (reason) op.reason = reason;
      if (oppPatchPayload) {
        op.fallbackEntitySet = `opportunities(${opportunityId})`;
        op.fallbackPayload = oppPatchPayload;
      }

      auditLog({ tool: 'add_opportunity_solution_play', entitySet: 'msp_salesplaychecklists', params: { opportunityId, solutionPlayId: playId, primary: effectivePrimary }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        identity: { opportunityId, opportunityName: oppName, solutionPlayId: playId, solutionPlayName: playName, primary: effectivePrimary },
        recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', opportunityId),
        fieldSummary: payload,
        opportunitySolutionAreaPatch: oppPatchPayload
          ? { from: currentOppSolutionArea, fromLabel: currentOppSolutionAreaLabel, to: translatedOppArea, playValue: playSolutionArea }
          : null,
        warnings: warnings.length ? warnings : undefined,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── set_opportunity_solution_play_primary (staged) ──────────
  // Promote one of the opportunity's existing Solution Plays to primary
  // (MSX UI Quick Actions → Solution Play → "Set As Primary"): PATCH the
  // target row to msp_primary=true, demote any other primary rows, and sync
  // opportunity.msp_solutionarea to the new primary's area.
  server.tool(
    'set_opportunity_solution_play_primary',
    'Promote an existing Solution Play on an opportunity to primary. Demotes any other primary plays and syncs opportunity.msp_solutionarea to the new primary\'s area. Staged for user approval.',
    {
      opportunityId: guidSchema.describe('Opportunity GUID'),
      solutionPlayChecklistId: guidSchema.optional().describe('msp_salesplaychecklists row GUID. Takes precedence over solutionPlayName.'),
      solutionPlayName: z.string().optional().describe('Solution Play name on the existing checklist row. Provide this OR solutionPlayChecklistId.'),
      solutionArea: z.string().optional().describe('Solution Area to disambiguate when the opportunity has multiple checklist rows with the same play name.'),
      reason: z.string().optional().describe('Why this play is being made primary (audited).'),
    },
    async ({ opportunityId, solutionPlayChecklistId, solutionPlayName, solutionArea, reason }) => {
      if (!solutionPlayChecklistId && !solutionPlayName)
        return error('Provide either solutionPlayChecklistId or solutionPlayName.');

      const oppLookup = await crmClient.request(`opportunities(${opportunityId})`, {
        query: { $select: 'name,opportunityid,msp_solutionarea' },
      });
      if (!oppLookup.ok)
        return error(`Opportunity not found (${oppLookup.status}): ${oppLookup.data?.message || 'not found'}`);
      const oppName = oppLookup.data?.name || 'Unknown';
      const currentOppSolutionArea = oppLookup.data?.msp_solutionarea ?? null;

      const rowsResp = await crmClient.requestAllPages('msp_salesplaychecklists', {
        query: {
          $filter: `_msp_opportunityid_value eq '${opportunityId}' and statecode eq 0`,
          $select: 'msp_salesplaychecklistid,_msp_salesplay_value,msp_primary,msp_solutionarea',
          $top: '50',
        },
      });
      if (!rowsResp.ok)
        return error(`Solution Play row lookup failed (${rowsResp.status}): ${rowsResp.data?.message || 'unknown error'}`);
      const rows = rowsResp.data?.value || [];
      if (!rows.length)
        return error('Opportunity has no active Solution Plays — use add_opportunity_solution_play first.');

      const target = await resolveChecklistTarget({
        crmClient,
        rows,
        solutionPlayChecklistId,
        solutionPlayName,
        solutionArea,
      });
      if (target.error) return target.error;
      const chosen = target.row;

      const targetId = chosen.msp_salesplaychecklistid;
      if (chosen.msp_primary)
        return error(`Checklist row ${targetId} is already the primary Solution Play on this opportunity.`);
      
      // Re-read the single row to capture etag for optimistic concurrency
      const targetRead = await crmClient.request(`msp_salesplaychecklists(${targetId})`, {
        query: { $select: 'msp_salesplaychecklistid,_msp_salesplay_value,msp_primary,msp_solutionarea' }
      });
      if (!targetRead.ok || !targetRead.data?.['@odata.etag']) {
        return error(`Failed to read Solution Play row ${targetId} for etag capture (${targetRead.status}): ${targetRead.data?.message || 'not found'}`);
      }
      const targetEtag = targetRead.data['@odata.etag'];

      const targetArea = chosen.msp_solutionarea ?? null;
      const targetAreaLabel = chosen['msp_solutionarea@OData.Community.Display.V1.FormattedValue'] ?? null;
      const demoteIds = rows
        .filter((r) => r.msp_primary === true && r.msp_salesplaychecklistid !== targetId)
        .map((r) => r.msp_salesplaychecklistid);

      let oppPatchPayload = null;
      const translatedOppArea = targetArea !== null ? SOLUTION_AREA_PLAY_TO_OPPORTUNITY[targetArea] ?? null : null;
      if (translatedOppArea !== null && currentOppSolutionArea !== translatedOppArea) {
        oppPatchPayload = { msp_solutionarea: translatedOppArea };
      }

      const description =
        `Set Solution Play row ${targetId}${targetAreaLabel ? ` (${targetAreaLabel})` : ''} as primary on opportunity "${oppName}"` +
        (demoteIds.length ? `; demote ${demoteIds.length} previous primary row${demoteIds.length > 1 ? 's' : ''}` : '') +
        (oppPatchPayload ? `; sync opportunity Solution Area to ${translatedOppArea}` : '');

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'set_opportunity_solution_play_primary',
        entitySet: `msp_salesplaychecklists(${targetId})`,
        method: 'PATCH',
        payload: { msp_primary: true },
        beforeState: chosen,
        etag: targetEtag,
        description,
      });
      if (reason) op.reason = reason;
      if (demoteIds.length) op.demoteChecklistIds = demoteIds;
      if (oppPatchPayload) {
        op.fallbackEntitySet = `opportunities(${opportunityId})`;
        op.fallbackPayload = oppPatchPayload;
      }

      auditLog({ tool: 'set_opportunity_solution_play_primary', entitySet: 'msp_salesplaychecklists', params: { opportunityId, solutionPlayChecklistId: targetId, demoteCount: demoteIds.length }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        identity: { opportunityId, opportunityName: oppName, solutionPlayChecklistId: targetId, demoteChecklistIds: demoteIds },
        recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', opportunityId),
        opportunitySolutionAreaPatch: oppPatchPayload ? { from: currentOppSolutionArea, to: translatedOppArea } : null,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── remove_opportunity_solution_play (staged) ───────────────
  // MSX UI Quick Actions → Solution Play → trash icon. The UI grays out the
  // trash for primary rows; we enforce the same rule — promote another play
  // to primary first via set_opportunity_solution_play_primary.
  server.tool(
    'remove_opportunity_solution_play',
    'Remove a Solution Play from an opportunity by deleting its msp_salesplaychecklists row. Refuses to delete the current primary play — promote another play first via set_opportunity_solution_play_primary. Staged for user approval.',
    {
      opportunityId: guidSchema.describe('Opportunity GUID'),
      solutionPlayChecklistId: guidSchema.optional().describe('msp_salesplaychecklists row GUID. Takes precedence over solutionPlayName.'),
      solutionPlayName: z.string().optional().describe('Solution Play name on the existing checklist row. Provide this OR solutionPlayChecklistId.'),
      solutionArea: z.string().optional().describe('Solution Area to disambiguate when the opportunity has multiple checklist rows with the same play name.'),
      reason: z.string().optional().describe('Why this play is being removed (audited).'),
    },
    async ({ opportunityId, solutionPlayChecklistId, solutionPlayName, solutionArea, reason }) => {
      if (!solutionPlayChecklistId && !solutionPlayName)
        return error('Provide either solutionPlayChecklistId or solutionPlayName.');

      const oppLookup = await crmClient.request(`opportunities(${opportunityId})`, {
        query: { $select: 'name,opportunityid' },
      });
      if (!oppLookup.ok)
        return error(`Opportunity not found (${oppLookup.status}): ${oppLookup.data?.message || 'not found'}`);
      const oppName = oppLookup.data?.name || 'Unknown';

      const rowsResp = await crmClient.requestAllPages('msp_salesplaychecklists', {
        query: {
          $filter: `_msp_opportunityid_value eq '${opportunityId}' and statecode eq 0`,
          $select: 'msp_salesplaychecklistid,_msp_salesplay_value,msp_primary,msp_solutionarea',
          $top: '50',
        },
      });
      if (!rowsResp.ok)
        return error(`Solution Play row lookup failed (${rowsResp.status}): ${rowsResp.data?.message || 'unknown error'}`);
      const rows = rowsResp.data?.value || [];
      if (!rows.length) return error('Opportunity has no active Solution Plays to remove.');

      const target = await resolveChecklistTarget({
        crmClient,
        rows,
        solutionPlayChecklistId,
        solutionPlayName,
        solutionArea,
      });
      if (target.error) return target.error;
      const chosen = target.row;

      const targetId = chosen.msp_salesplaychecklistid;
      if (chosen.msp_primary === true)
        return error(`Checklist row ${targetId} is the primary Solution Play — promote another play first via set_opportunity_solution_play_primary.`);
      
      // Re-read the single row to capture etag for optimistic concurrency
      const targetRead = await crmClient.request(`msp_salesplaychecklists(${targetId})`, {
        query: { $select: 'msp_salesplaychecklistid,_msp_salesplay_value,msp_primary,msp_solutionarea' }
      });
      if (!targetRead.ok || !targetRead.data?.['@odata.etag']) {
        return error(`Failed to read Solution Play row ${targetId} for etag capture (${targetRead.status}): ${targetRead.data?.message || 'not found'}`);
      }
      const targetEtag = targetRead.data['@odata.etag'];

      const targetAreaLabel = chosen['msp_solutionarea@OData.Community.Display.V1.FormattedValue'] ?? null;
      const description = `Remove Solution Play row ${targetId}${targetAreaLabel ? ` (${targetAreaLabel})` : ''} from opportunity "${oppName}"`;

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'remove_opportunity_solution_play',
        entitySet: `msp_salesplaychecklists(${targetId})`,
        method: 'DELETE',
        payload: null,
        beforeState: chosen,
        etag: targetEtag,
        description,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'remove_opportunity_solution_play', entitySet: 'msp_salesplaychecklists', params: { opportunityId, solutionPlayChecklistId: targetId }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        identity: { opportunityId, opportunityName: oppName, solutionPlayChecklistId: targetId },
        recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', opportunityId),
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── manage_deal_team (staged) ───────────────────────────────
  // List, add, or remove deal-team members on an opportunity via D365 Access
  // Teams (the "Deal Team" tab in MSX). Add/remove use the
  // AddUserToRecordTeam / RemoveUserFromRecordTeam bound actions and are
  // staged for user approval.
  server.tool(
    'manage_deal_team',
    'List, add, or remove deal team members on an opportunity via D365 Access Teams. "add" resolves a person by email or systemUserId then stages adding them to the opportunity access team; "list" returns current members; "remove" stages removing a user. Add/remove require approval via execute_operation.',
    {
      action: z.enum(['list', 'add', 'remove']).describe('Action to perform'),
      opportunityId: guidSchema.describe('Opportunity GUID'),
      email: z.string().optional().describe('Email address of the person to add/remove (used to resolve systemuserid)'),
      systemUserId: guidSchema.optional().describe('SystemUser GUID (if known — skips email lookup)'),
      reason: z.string().optional().describe('Optional reasoning for this change (audited and shown in confirmation dialog).'),
    },
    async ({ action, opportunityId, email, systemUserId, reason }) => {
      if (action === 'list') {
        const teamResult = await crmClient.requestAllPages('teams', {
          query: {
            $filter: `_regardingobjectid_value eq '${opportunityId}' and _teamtemplateid_value eq '${OPP_TEAM_TEMPLATE_ID}'`,
            $select: 'teamid,name',
            $expand: 'teammembership_association($select=systemuserid,fullname,title)',
            $top: '1',
          },
        });
        if (!teamResult.ok) return error(`List deal team failed (${teamResult.status}): ${teamResult.data?.message}`);
        const teams = teamResult.data?.value || [];
        if (!teams.length)
          return text({ opportunityId, teamExists: false, count: 0, members: [], message: 'No deal team exists yet (0 members).' });
        const team = teams[0];
        const members = (team.teammembership_association || []).map((m) => ({
          systemUserId: m.systemuserid,
          fullName: m.fullname,
          title: m.title,
        }));
        return text({ opportunityId, teamId: team.teamid, teamExists: true, count: members.length, members });
      }

      const resolved = await resolveSystemUser({ crmClient, systemUserId, email });
      if (resolved.error) return resolved.error;
      const { resolvedUserId, displayName } = resolved;

      const payload = {
        Record: { '@odata.type': 'Microsoft.Dynamics.CRM.opportunity', opportunityid: opportunityId },
        TeamTemplate: { '@odata.type': 'Microsoft.Dynamics.CRM.teamtemplate', teamtemplateid: OPP_TEAM_TEMPLATE_ID },
      };
      const payloadAllowlistError = validateWritePayloadFields(payload, TEAM_ACTION_FIELDS);
      if (payloadAllowlistError) return error(payloadAllowlistError);

      const isAdd = action === 'add';
      const boundAction = isAdd
        ? 'Microsoft.Dynamics.CRM.AddUserToRecordTeam'
        : 'Microsoft.Dynamics.CRM.RemoveUserFromRecordTeam';
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: isAdd ? 'add_deal_team_member' : 'remove_deal_team_member',
        entitySet: `systemusers(${resolvedUserId})/${boundAction}`,
        method: 'POST',
        payload,
        beforeState: null,
        description: `${isAdd ? 'Add' : 'Remove'} ${displayName || resolvedUserId} ${isAdd ? 'to' : 'from'} deal team on opportunity ${opportunityId}`,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'manage_deal_team', entitySet: 'teams', params: { action, opportunityId, resolvedUserId }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        recordUrl: buildRecordUrl(getCrmBase(), 'opportunity', opportunityId),
        resolvedUserId,
        displayName,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── add_me_to_deal_team (staged) ────────────────────────────
  // Convenience wrapper over manage_deal_team "add" for the signed-in user:
  // resolves the caller via WhoAmI and skips staging when already a member.
  server.tool(
    'add_me_to_deal_team',
    'Add the current signed-in user to an opportunity deal team (D365 Access Team, the "Deal Team" tab in MSX). Resolves you via WhoAmI, returns alreadyMember=true if you are already on the team, otherwise stages the add for approval via execute_operation.',
    {
      opportunityId: guidSchema.describe('Opportunity GUID'),
      reason: z.string().optional().describe('Optional reasoning for this change (audited and shown in confirmation dialog).'),
    },
    async ({ opportunityId, reason }) => {
      const who = await crmClient.request('WhoAmI');
      if (!who.ok || !who.data?.UserId)
        return error(`Unable to resolve current CRM user (${who.status}): ${who.data?.message || 'WhoAmI failed'}`);
      const resolvedUserId = normalizeGuid(who.data.UserId);

      const [oppResult, userResult, teamResult] = await Promise.all([
        crmClient.request(`opportunities(${opportunityId})`, { query: { $select: 'opportunityid,name' } }),
        crmClient.request(`systemusers(${resolvedUserId})`, { query: { $select: 'fullname' } }),
        crmClient.requestAllPages('teams', {
          query: {
            $filter: `_regardingobjectid_value eq '${opportunityId}' and _teamtemplateid_value eq '${OPP_TEAM_TEMPLATE_ID}'`,
            $select: 'teamid',
            $expand: 'teammembership_association($select=systemuserid)',
            $top: '1',
          },
        }),
      ]);
      if (!oppResult.ok)
        return error(`Opportunity ${opportunityId} not found or not accessible (${oppResult.status}): ${oppResult.data?.message || 'lookup failed'}`);
      if (!teamResult.ok)
        return error(`Deal team lookup failed (${teamResult.status}): ${teamResult.data?.message}`);

      const opportunityName = oppResult.data?.name || null;
      const displayName = (userResult.ok && userResult.data?.fullname) || null;
      const recordUrl = buildRecordUrl(getCrmBase(), 'opportunity', opportunityId);
      const team = teamResult.data?.value?.[0];
      const alreadyMember = (team?.teammembership_association || [])
        .some((m) => normalizeGuid(m.systemuserid) === resolvedUserId);
      if (alreadyMember) {
        return text({
          staged: false,
          alreadyMember: true,
          opportunityId,
          opportunityName,
          systemUserId: resolvedUserId,
          displayName,
          recordUrl,
          message: `${displayName || 'You'} are already on the deal team for "${opportunityName || opportunityId}".`,
        });
      }

      const payload = {
        Record: { '@odata.type': 'Microsoft.Dynamics.CRM.opportunity', opportunityid: opportunityId },
        TeamTemplate: { '@odata.type': 'Microsoft.Dynamics.CRM.teamtemplate', teamtemplateid: OPP_TEAM_TEMPLATE_ID },
      };
      const payloadAllowlistError = validateWritePayloadFields(payload, TEAM_ACTION_FIELDS);
      if (payloadAllowlistError) return error(payloadAllowlistError);

      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'add_deal_team_member',
        entitySet: `systemusers(${resolvedUserId})/Microsoft.Dynamics.CRM.AddUserToRecordTeam`,
        method: 'POST',
        payload,
        beforeState: null,
        description: `Add ${displayName || resolvedUserId} (me) to deal team on opportunity "${opportunityName || opportunityId}"`,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'add_me_to_deal_team', entitySet: 'teams', params: { opportunityId, resolvedUserId }, operationId: op.id });

      return text({
        staged: true,
        alreadyMember: false,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        opportunityId,
        opportunityName,
        systemUserId: resolvedUserId,
        displayName,
        recordUrl,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── manage_milestone_team (staged) ──────────────────────────
  // List, add, or remove members on an engagement milestone's access team
  // (the "Milestone Team" tab in MSX). Same Access-Teams mechanism as
  // manage_deal_team, keyed on the "Milestone Team" template.
  server.tool(
    'manage_milestone_team',
    'List, add, or remove members on a milestone\'s access team (the "Milestone Team" tab in MSX) via D365 Access Teams. Add/remove require approval via execute_operation.',
    {
      action: z.enum(['list', 'add', 'remove']).describe('Action to perform'),
      milestoneId: guidSchema.describe('Engagement milestone GUID'),
      email: z.string().optional().describe('Email address of the person to add/remove (used to resolve systemuserid)'),
      systemUserId: guidSchema.optional().describe('SystemUser GUID (if known — skips email lookup)'),
      reason: z.string().optional().describe('Optional reasoning for this change (audited and shown in confirmation dialog).'),
    },
    async ({ action, milestoneId, email, systemUserId, reason }) => {
      if (action === 'list') {
        const teamResult = await crmClient.requestAllPages('teams', {
          query: {
            $filter: `_regardingobjectid_value eq '${milestoneId}' and _teamtemplateid_value eq '${MILESTONE_TEAM_TEMPLATE_ID}'`,
            $select: 'teamid,name',
            $expand: 'teammembership_association($select=systemuserid,fullname,title)',
            $top: '1',
          },
        });
        if (!teamResult.ok) return error(`List milestone team failed (${teamResult.status}): ${teamResult.data?.message}`);
        const teams = teamResult.data?.value || [];
        if (!teams.length)
          return text({ milestoneId, teamExists: false, count: 0, members: [], message: 'No milestone team exists yet (0 members).' });
        const team = teams[0];
        const members = (team.teammembership_association || []).map((m) => ({
          systemUserId: m.systemuserid,
          fullName: m.fullname,
          title: m.title,
        }));
        return text({ milestoneId, teamId: team.teamid, teamExists: true, count: members.length, members });
      }

      const resolved = await resolveSystemUser({ crmClient, systemUserId, email });
      if (resolved.error) return resolved.error;
      const { resolvedUserId, displayName } = resolved;

      const payload = {
        Record: { '@odata.type': 'Microsoft.Dynamics.CRM.msp_engagementmilestone', msp_engagementmilestoneid: milestoneId },
        TeamTemplate: { '@odata.type': 'Microsoft.Dynamics.CRM.teamtemplate', teamtemplateid: MILESTONE_TEAM_TEMPLATE_ID },
      };
      const payloadAllowlistError = validateWritePayloadFields(payload, TEAM_ACTION_FIELDS);
      if (payloadAllowlistError) return error(payloadAllowlistError);

      const isAdd = action === 'add';
      const boundAction = isAdd
        ? 'Microsoft.Dynamics.CRM.AddUserToRecordTeam'
        : 'Microsoft.Dynamics.CRM.RemoveUserFromRecordTeam';
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: isAdd ? 'add_milestone_team_member' : 'remove_milestone_team_member',
        entitySet: `systemusers(${resolvedUserId})/${boundAction}`,
        method: 'POST',
        payload,
        beforeState: null,
        description: `${isAdd ? 'Add' : 'Remove'} ${displayName || resolvedUserId} ${isAdd ? 'to' : 'from'} milestone team on ${milestoneId}`,
      });
      if (reason) op.reason = reason;

      auditLog({ tool: 'manage_milestone_team', entitySet: 'teams', params: { action, milestoneId, resolvedUserId }, operationId: op.id });

      return text({
        staged: true,
        operationId: op.id,
        description: op.description,
        reason: op.reason || null,
        recordUrl: buildRecordUrl(getCrmBase(), 'msp_engagementmilestone', milestoneId),
        resolvedUserId,
        displayName,
        message: `Staged ${op.id}: ${op.description}. Approve via execute_operation or from the approval UI.`,
      });
    },
  );

  // ── query_audit_log (read-only) ─────────────────────────────────
  // Query audit log with filters. Returns {total, entries}.
  server.tool(
    'query_audit_log',
    'Query audit log with filters (startDate, endDate, entitySet, method, phase, actor, correlationId, search, source, outcome). Returns {total, entries}.',
    {
      startDate: z.string().optional().describe('Start date (ISO 8601)'),
      endDate: z.string().optional().describe('End date (ISO 8601)'),
      entitySet: z.string().optional().describe('Entity set name (e.g., "opportunities")'),
      method: z.string().optional().describe('HTTP method (GET, POST, PATCH, DELETE)'),
      phase: z.string().optional().describe('Phase (staged, executed)'),
      actor: z.string().optional().describe('Actor email'),
      correlationId: z.string().optional().describe('Correlation ID (batch identifier)'),
      search: z.string().optional().describe('Free-text search in description/recordName'),
      source: z.string().optional().describe('Source filter: "batch" (correlationId != null) | "manual" (correlationId == null)'),
      outcome: z.string().optional().describe('Outcome filter: "ok" (phase === "executed") | "attention" (phase in {failed, stale-conflict, dead-letter, uncertain})'),
      limit: z.number().optional().describe('Max records to return (default 50)'),
      offset: z.number().optional().describe('Offset for pagination (default 0)'),
    },
    async ({ startDate, endDate, entitySet, method, phase, actor, correlationId, search, source, outcome, limit, offset }) => {
      // Coerce blank strings to undefined for optional filters
      if (correlationId === '') correlationId = undefined;
      if (entitySet === '') entitySet = undefined;
      if (method === '') method = undefined;
      if (phase === '') phase = undefined;
      if (actor === '') actor = undefined;
      if (search === '') search = undefined;
      if (startDate === '') startDate = undefined;
      if (endDate === '') endDate = undefined;
      if (source === '') source = undefined;
      if (outcome === '') outcome = undefined;

      const result = queryAuditLog({
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
        limit: limit ?? 50,
        offset: offset ?? 0,
      });
      return text(result);
    },
  );

  // ── get_audit_entry (read-only) ─────────────────────────────────
  // Get a single audit entry by ID.
  server.tool(
    'get_audit_entry',
    'Get a single audit entry by ID (ChangeRecord id, e.g., chg_<uuid>).',
    {
      id: z.string().describe('ChangeRecord id (chg_<uuid>)'),
    },
    async ({ id }) => {
      const entry = getAuditEntry(id);
      if (!entry) return error(`Audit entry not found: ${id}`);
      return text(entry);
    },
  );
}
