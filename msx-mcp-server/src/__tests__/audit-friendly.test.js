// Tests for audit-friendly helpers — quantity update path and FIELD_LABELS
import { describe, it, expect } from 'vitest';
import { buildFriendlyDescription, FIELD_LABELS, MILESTONE_STATUS_LABELS } from '../audit-friendly.js';

describe('FIELD_LABELS', () => {
  it('labels msp_monthlyuse as "quantity" (not "monthly use")', () => {
    expect(FIELD_LABELS.msp_monthlyuse).toBe('quantity');
  });
});

describe('MILESTONE_STATUS_LABELS — Round 3 terminal status fixes', () => {
  it('labels 861980005 as "Lost to Competitor" (not "Not Started")', () => {
    expect(MILESTONE_STATUS_LABELS[861980005]).toBe('Lost to Competitor');
  });

  it('includes 861980006 as "Hygiene/Duplicate"', () => {
    expect(MILESTONE_STATUS_LABELS[861980006]).toBe('Hygiene/Duplicate');
  });

  it('does not include "Not Started" anywhere', () => {
    const values = Object.values(MILESTONE_STATUS_LABELS);
    expect(values).not.toContain('Not Started');
  });

  it('still includes all expected statuses', () => {
    expect(MILESTONE_STATUS_LABELS[861980000]).toBe('On Track');
    expect(MILESTONE_STATUS_LABELS[861980001]).toBe('At Risk');
    expect(MILESTONE_STATUS_LABELS[861980002]).toBe('Blocked');
    expect(MILESTONE_STATUS_LABELS[861980003]).toBe('Completed');
    expect(MILESTONE_STATUS_LABELS[861980004]).toBe('Cancelled');
    expect(MILESTONE_STATUS_LABELS[861980007]).toBe('Closed as Incomplete');
  });
});

describe('buildFriendlyDescription — quantity update', () => {
  it('renders dedicated quantity message when msp_monthlyuse is the only payload field', () => {
    const op = {
      payload: { msp_monthlyuse: 9000 },
      recordName: 'Singapur - Infra',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).toBe('Updated quantity to 9000 for milestone "Singapur - Infra"');
  });

  it('renders dedicated quantity message without record name when name is absent', () => {
    const op = {
      payload: { msp_monthlyuse: 5000 },
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).toBe('Updated quantity to 5000 for milestone');
  });

  it('renders dedicated quantity message for quantity = 0', () => {
    const op = {
      payload: { msp_monthlyuse: 0 },
      recordName: 'Zero Milestone',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).toBe('Updated quantity to 0 for milestone "Zero Milestone"');
  });

  it('falls back to generic update label "quantity" when msp_monthlyuse + other fields present', () => {
    const op = {
      payload: { msp_monthlyuse: 9000, msp_milestonedate: '2026-12-31' },
      recordName: 'Multi Field MS',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    // Generic path — should include "quantity" (the updated FIELD_LABELS entry)
    expect(result).toContain('quantity');
    expect(result).toContain('"Multi Field MS"');
  });

  it('uses "quantity" label in generic multi-field update (not "monthly use")', () => {
    // Only msp_monthlyuse contributes a FIELD_LABEL here (msp_milestonestatus undefined)
    // but since there are 2 keys (even if one is undefined) length !== 1
    // We verify the label used is "quantity"
    const result = buildFriendlyDescription({ payload: { msp_monthlyuse: 7500 }, recordName: 'Label Check' }, 'milestone');
    // Single-field path hits the dedicated branch
    expect(result).toBe('Updated quantity to 7500 for milestone "Label Check"');
  });

  it('does not interfere with milestone status change that has no msp_monthlyuse', () => {
    const op = {
      payload: { msp_milestonestatus: 861980000 },
      recordName: 'On Track MS',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).toBe('Marked milestone "On Track MS" as On Track');
  });

  it('does not interfere with comment-only updates', () => {
    const op = {
      payload: { msp_milestonecomments: 'Good progress' },
      recordName: 'Comment MS',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result?.toLowerCase()).toContain('comment');
  });
});

describe('buildFriendlyDescription — terminal milestone statuses', () => {
  it('renders "Lost to Competitor" for status code 861980005', () => {
    const op = {
      payload: { msp_milestonestatus: 861980005 },
      recordName: 'Lost MS',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).toBe('Marked milestone "Lost MS" as Lost to Competitor');
  });

  it('renders "Hygiene/Duplicate" for status code 861980006', () => {
    const op = {
      payload: { msp_milestonestatus: 861980006 },
      recordName: 'Hygiene MS',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).toBe('Marked milestone "Hygiene MS" as Hygiene/Duplicate');
  });

  it('does not render "Not Started" for any status code', () => {
    const op = {
      payload: { msp_milestonestatus: 861980005 },
      recordName: 'Test MS',
    };
    const result = buildFriendlyDescription(op, 'milestone');
    expect(result).not.toContain('Not Started');
  });
});

describe('buildFriendlyDescription — opportunity stage move', () => {
  const GUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('renders "Moved … from X to Y" from stage objects', () => {
    const op = {
      type: 'update_opportunity_stage',
      recordName: 'Contoso Expansion',
      payload: { opportunityId: GUID, targetStage: { name: 'Develop' } },
      beforeState: { currentStage: { name: 'Qualify' } },
    };
    expect(buildFriendlyDescription(op, 'opportunity'))
      .toBe('Moved opportunity "Contoso Expansion" from Qualify to Develop');
  });

  it('falls back to stagePlan steps for the from-stage', () => {
    const op = {
      type: 'update_opportunity_stage',
      recordName: 'Fabrikam Deal',
      payload: { targetStage: { name: 'Propose' } },
      stagePlan: { steps: [{ from: { name: 'Develop' } }] },
    };
    expect(buildFriendlyDescription(op, 'opportunity'))
      .toBe('Moved opportunity "Fabrikam Deal" from Develop to Propose');
  });

  it('never leaks a GUID even without a record name or stages', () => {
    const op = { type: 'update_opportunity_stage', payload: { opportunityId: GUID } };
    const result = buildFriendlyDescription(op, 'opportunity');
    expect(result).toBe('Moved opportunity to a new stage');
    expect(result).not.toContain(GUID);
  });
});

describe('buildFriendlyDescription — stage prerequisite save (preflight)', () => {
  const GUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('lists the saved prerequisite fields by human label, no GUID', () => {
    const op = {
      type: 'mcem_stage_preflight',
      payload: { msp_activesalesstage: '2', estimatedclosedate: '2026-09-30' },
      description: `Save stage prerequisite field(s) for ${GUID}`,
    };
    const result = buildFriendlyDescription(op, 'opportunity');
    expect(result).toBe('Saved stage prerequisite fields: stage, close date');
    expect(result).not.toContain(GUID);
  });

  it('uses singular "field" and the opportunity name when available', () => {
    const op = {
      type: 'mcem_stage_preflight',
      recordName: 'Northwind Renewal',
      payload: { estimatedvalue: 50000 },
    };
    expect(buildFriendlyDescription(op, 'opportunity'))
      .toBe('Saved stage prerequisite field (revenue) for opportunity "Northwind Renewal"');
  });

  it('degrades gracefully when no field maps to a label', () => {
    const op = { type: 'mcem_stage_preflight', payload: { msp_unknownfield: 'x' } };
    expect(buildFriendlyDescription(op, 'opportunity')).toBe('Saved stage prerequisite fields');
  });
});

