// Shared audit-description helpers — single source of truth for the
// plain-language friendlyDescription used by BOTH the staging path
// (tools.js → batch drawer via list_pending_operations) and the
// capture path (audit-capture.js → Activity drawer).
//
// Rule: no field codes, GUIDs, HTTP methods, or internal tokens in output.

// ── Field code → human-readable label ─────────────────────────────────────
export const FIELD_LABELS = {
  msp_milestonestatus:               'milestone status',
  msp_milestonestatusreason:         'status reason',
  msp_milestonedate:                 'milestone date',
  msp_monthlyuse:                    'quantity',
  msp_milestonecategory:             'category',
  msp_commitmentrecommendation:      'commitment',
  msp_helpneeded:                    'help needed',
  msp_milestonecomments:             'milestone comments',
  msp_forecastcomments:              'forecast comments',
  msp_forecastcommentsjsonfield:     'forecast comments',
  msp_name:                          'name',
  msp_activesalesstage:              'stage',
  stagecode:                         'stage',
  msp_engagementstatus:              'engagement status',
  estimatedclosedate:                'close date',
  msp_estcompletiondate:             'completion date',
  estimatedvalue:                    'revenue',
  description:                       'description',
  statecode:                         'status',
  statuscode:                        'status',
  '_ownerid_value':                  'owner',
  'ownerid@odata.bind':              'owner',
  msp_milestoneworkload:             'workload type',
  msp_deliveryspecifiedfield:        'delivered by',
  msp_milestonepreferredazureregion: 'preferred Azure region',
  msp_milestoneazurecapacitytype:    'Azure capacity type',
  'transactioncurrencyid@odata.bind':'currency',
  'msp_WorkloadlkId@odata.bind':     'workload',
};

// ── Milestone status code → human label ───────────────────────────────────
// Source: MILESTONE_STATUSES picklist in tools.js, confirmed against live org.
export const MILESTONE_STATUS_LABELS = {
  861980000: 'On Track',
  861980001: 'At Risk',
  861980002: 'Blocked',
  861980003: 'Completed',
  861980004: 'Cancelled',
  861980005: 'Lost to Competitor',
  861980006: 'Hygiene/Duplicate',
  861980007: 'Closed as Incomplete',
};

// ── MSX close-reason token → friendly display phrase ──────────────────────
export const CLOSE_REASON_LABELS = {
  completed:          'Won (Completed)',
  cancelled_customer: 'Lost (Cancelled by Customer)',
  cancelled_delayed:  'Lost (Cancelled/Delayed)',
  hygiene:            'Lost (Hygiene)',
  lost:               'Lost',
  consolidated:       'Lost (Consolidated)',
};

// Rollup-line prefix inserted by buildForecastCommentUpdate: "JPdR - 23/Jun - "
const FORECAST_PREFIX_RE = /^\s*[A-Za-z]{2,6}\s+-\s+\d{1,2}\/[A-Za-z]{3}\s+-\s*/;
const MAX_COMMENT_PREVIEW = 120;

/**
 * Extract the clean comment body from a staged-op payload.
 * Priority:
 *   1. msp_forecastcommentsjsonfield — last entry's .comment (cleanest, no prefix)
 *   2. msp_forecastcomments          — first line, strip "XYZ - DD/Mon - " prefix
 *   3. msp_milestonecomments         — verbatim
 * @param {object} payload
 * @returns {string|null}
 */
function extractCommentText(payload) {
  // 1. JSON field — last (newest) entry carries the raw user text
  if (payload.msp_forecastcommentsjsonfield) {
    try {
      const entries = JSON.parse(payload.msp_forecastcommentsjsonfield);
      if (Array.isArray(entries) && entries.length) {
        const last = entries[entries.length - 1];
        if (last?.comment && typeof last.comment === 'string') {
          return last.comment.trim().slice(0, MAX_COMMENT_PREVIEW) || null;
        }
      }
    } catch { /* fall through */ }
  }

  // 2. Plain-text rollup — strip the auto-prefix, take newest (first) line
  if (typeof payload.msp_forecastcomments === 'string') {
    const firstLine = payload.msp_forecastcomments.split('\n')[0];
    const stripped = firstLine.replace(FORECAST_PREFIX_RE, '').trim();
    if (stripped) return stripped.slice(0, MAX_COMMENT_PREVIEW);
  }

  // 3. Milestone comment — verbatim
  if (typeof payload.msp_milestonecomments === 'string') {
    return payload.msp_milestonecomments.trim().slice(0, MAX_COMMENT_PREVIEW) || null;
  }

  return null;
}

/**
 * Extract a user-facing close-reason phrase from a staged operation.
 * @param {object} op
 * @returns {string}
 */
function extractCloseReason(op) {
  // close_msx_opportunity stores the reason token in afterState and fieldSummary
  const token = op.afterState?.closeReason || op.fieldSummary?.closeReason || null;
  if (token && CLOSE_REASON_LABELS[token]) return CLOSE_REASON_LABELS[token];

  // close_opportunity stores 'Won' or 'Lost' in afterState.statecode
  const sc = op.afterState?.statecode;
  if (sc === 'Won' || sc === 1) return 'Won';
  if (sc === 'Lost' || sc === 2) return 'Lost';

  // Fallback: derive from _closeStatus set during staging
  if (op._closeStatus === 'won') return 'Won';
  if (op._closeStatus === 'lost') return 'Lost';

  return 'closed';
}

/**
 * Generate a plain-language description of a staged CRM operation.
 * No field codes, GUIDs, HTTP methods, or raw tokens in the output.
 *
 * Called at BOTH staging time (tools.js) and capture time (audit-capture.js)
 * to ensure the batch drawer and Activity drawer always show the same text.
 *
 * @param {object} op          - StagedOperation (may be partial at capture time)
 * @param {string|null} entityType - 'opportunity' | 'milestone' | 'task' | etc.
 * @returns {string|null}
 */
export function buildFriendlyDescription(op, entityType) {
  if (!op) return null;
  try {
    const type = (op.type || '').toLowerCase();
    const payload = op.payload || {};
    const entity = entityType || 'record';

    // Best record display name — prefer explicitly populated fields first
    const recordName =
      op.recordName ||
      op.identity?.milestoneName ||
      op.changeOwner?.recordName ||
      op.identity?.opportunityName ||
      op.beforeState?.msp_name ||
      op.beforeState?.name ||
      null;
    const nameRef = recordName ? `"${recordName}"` : null;

    // ── Opportunity stage move ────────────────────────────────────────────
    // Payload/beforeState carry stage objects; never emit GUIDs.
    if (type === 'update_opportunity_stage') {
      const fromStage = op.beforeState?.currentStage?.name || op.stagePlan?.steps?.[0]?.from?.name || null;
      const toStage = op.payload?.targetStage?.name || op.stagePlan?.targetStage?.name || null;
      if (nameRef && fromStage && toStage) return `Moved opportunity ${nameRef} from ${fromStage} to ${toStage}`;
      if (nameRef && toStage) return `Moved opportunity ${nameRef} to ${toStage}`;
      if (toStage) return `Moved opportunity to ${toStage}`;
      return nameRef ? `Moved opportunity ${nameRef} to a new stage` : 'Moved opportunity to a new stage';
    }

    // ── Stage prerequisite field save (MCEM preflight) ────────────────────
    // Describe WHICH prerequisite fields were saved; never emit the GUID that
    // the raw description carries ("…for <GUID>").
    if (type === 'mcem_stage_preflight') {
      const prereqLabels = [...new Set(
        Object.keys(payload).map(k => FIELD_LABELS[k]).filter(Boolean)
      )].slice(0, 4);
      const fieldWord = prereqLabels.length === 1 ? 'field' : 'fields';
      if (prereqLabels.length && nameRef) return `Saved stage prerequisite ${fieldWord} (${prereqLabels.join(', ')}) for opportunity ${nameRef}`;
      if (prereqLabels.length) return `Saved stage prerequisite ${fieldWord}: ${prereqLabels.join(', ')}`;
      return nameRef ? `Saved stage prerequisite fields for opportunity ${nameRef}` : 'Saved stage prerequisite fields';
    }

    // ── Forecast / milestone comment ──────────────────────────────────────
    const hasComment =
      payload.msp_forecastcomments !== undefined ||
      payload.msp_forecastcommentsjsonfield !== undefined ||
      payload.msp_milestonecomments !== undefined;

    // Status change is the primary action; treat a combined status+comment as a
    // status-change description (the comment is captured in beforeState/payload).
    const isPureComment = hasComment && payload.msp_milestonestatus === undefined;

    if (isPureComment) {
      const commentText = extractCommentText(payload);
      const preview = commentText ? `"${commentText}"` : null;

      // Milestone-only comment (msp_milestonecomments but no forecast update)
      if (payload.msp_milestonecomments !== undefined && payload.msp_forecastcomments === undefined) {
        return preview && nameRef
          ? `Commented on milestone ${nameRef}: ${preview}`
          : nameRef ? `Added comment to milestone ${nameRef}` : 'Added comment to milestone';
      }

      // Forecast comment (opportunity or milestone)
      const entityLabel = entity === 'milestone' ? 'milestone' : 'opportunity';
      return preview && nameRef
        ? `Added forecast comment to ${entityLabel} ${nameRef}: ${preview}`
        : nameRef ? `Added forecast comment to ${entityLabel} ${nameRef}` : `Added forecast comment to ${entityLabel}`;
    }

    // ── Milestone status change ───────────────────────────────────────────
    if (payload.msp_milestonestatus !== undefined) {
      const code = typeof payload.msp_milestonestatus === 'string'
        ? parseInt(payload.msp_milestonestatus, 10)
        : payload.msp_milestonestatus;
      const statusLabel = MILESTONE_STATUS_LABELS[code] || `status ${payload.msp_milestonestatus}`;
      return nameRef
        ? `Marked milestone ${nameRef} as ${statusLabel}`
        : `Marked milestone as ${statusLabel}`;
    }

    // ── Close opportunity ─────────────────────────────────────────────────
    if (type === 'close_opportunity' || type === 'close_msx_opportunity') {
      const reasonPhrase = extractCloseReason(op);
      return nameRef
        ? `Closed opportunity ${nameRef} as ${reasonPhrase}`
        : `Closed opportunity as ${reasonPhrase}`;
    }

    // ── Reactivate opportunity ────────────────────────────────────────────
    if (type === 'reactivate_msx_opportunity' || type === 'reactivate_opportunity') {
      return nameRef ? `Reactivated opportunity ${nameRef}` : 'Reactivated opportunity';
    }

    // ── Create ────────────────────────────────────────────────────────────
    if (type.includes('create_milestone')) {
      return nameRef ? `Created milestone ${nameRef}` : 'Created milestone';
    }
    if (type.includes('create')) {
      return nameRef ? `Created ${entity} ${nameRef}` : `Created ${entity}`;
    }

    // ── Owner change ──────────────────────────────────────────────────────
    if (type === 'change_owner') {
      const newOwner = op.changeOwner?.newOwnerName || null;
      if (newOwner && nameRef) return `Changed owner of ${entity} ${nameRef} to "${newOwner}"`;
      if (newOwner) return `Changed owner of ${entity} to "${newOwner}"`;
      return nameRef ? `Changed owner of ${entity} ${nameRef}` : `Changed owner of ${entity}`;
    }

    // ── Close task ────────────────────────────────────────────────────────
    if (type === 'close_task') {
      return nameRef ? `Closed task ${nameRef}` : 'Closed task';
    }

    // ── Quantity update (msp_monthlyuse only) ────────────────────────────────
    if (payload.msp_monthlyuse !== undefined && Object.keys(payload).length === 1) {
      const qty = payload.msp_monthlyuse;
      return nameRef
        ? `Updated quantity to ${qty} for milestone ${nameRef}`
        : `Updated quantity to ${qty} for milestone`;
    }

    // ── Generic update — map payload keys to human labels ─────────────────
    const labels = [...new Set(
      Object.keys(payload)
        .map(k => FIELD_LABELS[k])
        .filter(Boolean)
    )].slice(0, 3);

    if (labels.length > 0 && nameRef) {
      return `Updated ${labels.join(', ')} for ${entity} ${nameRef}`;
    }
    if (labels.length > 0) {
      return `Updated ${entity}: ${labels.join(', ')}`;
    }
    if (nameRef) return `Updated ${entity} ${nameRef}`;
    return null;
  } catch {
    return null;
  }
}
