// Tests for the Activity View read-time presenter (audit-present.js).
import { describe, it, expect } from 'vitest';
import {
  parseEntitySet,
  entityLabelOf,
  buildAccountIndex,
  deriveCrmBase,
  resolveCustomer,
  resolveRecordName,
  resolveRecordUrl,
  resolveAction,
  resolveStatus,
  resolveAppliedState,
  resolveSummary,
  presentRecord,
  presentRecords,
} from '../audit-present.js';

const FULL_GUID = '12345678-1234-1234-1234-123456789abc';

function rec(overrides = {}) {
  return {
    id: 'chg_1',
    ts: '2026-07-01T10:00:00.000Z',
    phase: 'executed',
    tool: 'update_opportunity',
    method: 'PATCH',
    entitySet: `opportunities(${FULL_GUID})`,
    recordId: FULL_GUID,
    recordIdFull: FULL_GUID,
    recordName: 'Contoso Q2 Expansion',
    accountName: 'Contoso Ltd',
    correlationId: null,
    description: 'Update stage',
    recordUrl: `https://org.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=opportunity&id=${FULL_GUID}`,
    ...overrides,
  };
}

describe('parseEntitySet', () => {
  it('parses set name, logical name, and guid', () => {
    expect(parseEntitySet(`opportunities(${FULL_GUID})`)).toEqual({
      setName: 'opportunities',
      logicalName: 'opportunity',
      guid: FULL_GUID,
    });
    expect(parseEntitySet(`msp_engagementmilestones(${FULL_GUID})`)).toEqual({
      setName: 'msp_engagementmilestones',
      logicalName: 'msp_engagementmilestone',
      guid: FULL_GUID,
    });
  });

  it('handles missing/garbage input', () => {
    expect(parseEntitySet(null)).toEqual({ setName: null, logicalName: null, guid: null });
    expect(parseEntitySet('opportunities')).toEqual({
      setName: 'opportunities',
      logicalName: 'opportunity',
      guid: null,
    });
  });
});

describe('entityLabelOf', () => {
  it('maps logical names to human labels', () => {
    expect(entityLabelOf(rec())).toBe('Opportunity');
    expect(entityLabelOf(rec({ entitySet: `msp_engagementmilestones(${FULL_GUID})` }))).toBe('Milestone');
  });

  it('falls back to the tool hint when entitySet is unknown', () => {
    expect(entityLabelOf({ entitySet: null, tool: 'create_milestone' })).toBe('Milestone');
  });
});

describe('buildAccountIndex + resolveCustomer (backfill)', () => {
  it('backfills a missing account from another record with the SAME guid', () => {
    const withAccount = rec({ tool: 'update_milestone', accountName: 'Fabrikam Inc' });
    const missing = rec({ tool: 'change_owner', accountName: null });
    const index = buildAccountIndex([withAccount, missing]);
    expect(resolveCustomer(missing, index)).toBe('Fabrikam Inc');
  });

  it('prefers the record own account name', () => {
    const index = buildAccountIndex([rec({ accountName: 'Other' })]);
    expect(resolveCustomer(rec({ accountName: 'Contoso Ltd' }), index)).toBe('Contoso Ltd');
  });

  it('returns null (never fabricates) when truly unknown', () => {
    const missing = rec({ accountName: null, entitySet: `opportunities(${FULL_GUID})` });
    const index = buildAccountIndex([missing]);
    expect(resolveCustomer(missing, index)).toBeNull();
  });

  it('treats sentinel placeholders as blank', () => {
    expect(resolveCustomer(rec({ accountName: 'Unknown' }), new Map())).toBeNull();
    expect(resolveCustomer(rec({ accountName: '  ' }), new Map())).toBeNull();
  });
});

describe('resolveRecordName', () => {
  it('uses recordName, then quoted description, then short id', () => {
    expect(resolveRecordName(rec())).toBe('Contoso Q2 Expansion');
    expect(
      resolveRecordName(rec({ recordName: null, description: 'Move opportunity "Alpha Deal" from A to B' }))
    ).toBe('Alpha Deal');
    const fallback = resolveRecordName(rec({ recordName: null, description: 'no name here' }));
    expect(fallback).toMatch(/^Opportunity …/);
    expect(fallback).not.toMatch(/Unknown/);
  });
});

describe('resolveRecordUrl', () => {
  it('keeps a usable stored URL', () => {
    expect(resolveRecordUrl(rec(), null)).toContain(`id=${FULL_GUID}`);
  });

  it('rebuilds from guid + crm base when the stored URL is missing', () => {
    const url = resolveRecordUrl(rec({ recordUrl: null }), 'https://org.crm.dynamics.com');
    expect(url).toBe(
      `https://org.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=opportunity&id=${FULL_GUID}`
    );
  });

  it('returns null rather than a broken link when no full guid is available', () => {
    expect(
      resolveRecordUrl({ entitySet: 'opportunities(abc)', recordUrl: null, recordIdFull: null }, 'https://x')
    ).toBeNull();
  });
});

describe('deriveCrmBase', () => {
  it('extracts the origin from any record with a usable URL', () => {
    expect(deriveCrmBase([rec({ recordUrl: null }), rec()])).toBe('https://org.crm.dynamics.com');
  });
  it('returns null when no URL is present', () => {
    expect(deriveCrmBase([rec({ recordUrl: null })])).toBeNull();
  });
});

describe('resolveAction', () => {
  it('maps tools to human verbs', () => {
    expect(resolveAction(rec({ tool: 'update_opportunity_stage' }))).toBe('Update stage');
    expect(resolveAction(rec({ tool: 'mcem_stage_preflight' }))).toBe('Update stage');
    expect(resolveAction(rec({ tool: 'change_owner' }))).toBe('Change owner');
    expect(resolveAction(rec({ tool: 'create_milestone' }))).toBe('Create milestone');
    expect(resolveAction(rec({ tool: 'close_msx_opportunity' }))).toBe('Close');
  });
  it('falls back to the HTTP method', () => {
    expect(resolveAction({ tool: null, method: 'POST' })).toBe('Create');
    expect(resolveAction({ tool: null, method: 'DELETE' })).toBe('Delete');
  });
});

describe('resolveStatus', () => {
  it('maps every known phase to a toned label', () => {
    expect(resolveStatus('executed')).toEqual({ key: 'executed', label: 'Executed', tone: 'success' });
    expect(resolveStatus('failed')).toEqual({ key: 'failed', label: 'Failed', tone: 'danger' });
    expect(resolveStatus('stale-conflict').tone).toBe('warning');
    expect(resolveStatus('override-abort-reread-failed')).toEqual({
      key: 'override-abort-reread-failed',
      label: 'Aborted (re-read failed)',
      tone: 'warning',
    });
    expect(resolveStatus('precheck-abort')).toEqual({
      key: 'precheck-abort',
      label: 'Skipped (precheck)',
      tone: 'neutral',
    });
  });

  it('humanises an unknown phase instead of showing the raw token', () => {
    expect(resolveStatus('some-new-phase')).toEqual({
      key: 'some-new-phase',
      label: 'Some New Phase',
      tone: 'neutral',
    });
    expect(resolveStatus('override-abort-weird').label).toBe('Aborted');
  });
});

describe('resolveAppliedState', () => {
  it('marks an executed write as applied', () => {
    expect(resolveAppliedState('executed')).toBe('applied');
  });

  it('marks staged writes as pending (not yet written)', () => {
    expect(resolveAppliedState('staged')).toBe('pending');
    expect(resolveAppliedState('staged-approval')).toBe('pending');
  });

  it('marks a precheck abort as skipped (nothing attempted)', () => {
    expect(resolveAppliedState('precheck-abort')).toBe('skipped');
  });

  it('keeps genuine ambiguity as uncertain', () => {
    expect(resolveAppliedState('uncertain')).toBe('uncertain');
  });

  it('marks failed / stale / aborted writes as not-applied so they never read as applied', () => {
    expect(resolveAppliedState('failed')).toBe('not-applied');
    expect(resolveAppliedState('dead-letter')).toBe('not-applied');
    expect(resolveAppliedState('stale-conflict')).toBe('not-applied');
    expect(resolveAppliedState('override-abort-404')).toBe('not-applied');
    expect(resolveAppliedState('')).toBe('not-applied');
  });
});

describe('resolveSummary', () => {
  it('rebuilds a preflight summary with field labels and NO guid', () => {
    const s = resolveSummary(
      rec({
        tool: 'mcem_stage_preflight',
        description: `Save stage prerequisite field(s) for ${FULL_GUID}`,
        intendedAfter: { msp_activesalesstage: 2, estimatedclosedate: '2026-08-01' },
        friendlyDescription: null,
      })
    );
    expect(s).not.toContain(FULL_GUID);
    expect(s).toMatch(/stage prerequisites/i);
    expect(s).toContain('Contoso Q2 Expansion');
  });

  it('uses the clean raw description for a stage move', () => {
    const s = resolveSummary(
      rec({
        tool: 'update_opportunity_stage',
        description: 'Move opportunity "Contoso Q2 Expansion" from Qualify to Propose',
        friendlyDescription: null,
      })
    );
    expect(s).toBe('Move opportunity "Contoso Q2 Expansion" from Qualify to Propose');
  });

  it('prefers a clean stored friendly description', () => {
    const s = resolveSummary(rec({ tool: 'change_owner', friendlyDescription: 'Changed owner of opportunity "X" to "Alfonso del Valle"' }));
    expect(s).toBe('Changed owner of opportunity "X" to "Alfonso del Valle"');
  });

  it('never returns a guid-laden or empty summary', () => {
    const s = resolveSummary(rec({ tool: null, method: 'PATCH', description: null, friendlyDescription: null }));
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe('presentRecord / presentRecords', () => {
  it('preserves raw fields and adds a complete view', () => {
    const out = presentRecord(rec(), { index: new Map(), crmBase: null });
    // raw preserved (router tests depend on this)
    expect(out.entitySet).toBe(`opportunities(${FULL_GUID})`);
    expect(out.phase).toBe('executed');
    expect(out.description).toBe('Update stage');
    // view added
    expect(out.view.customer).toBe('Contoso Ltd');
    expect(out.view.recordName).toBe('Contoso Q2 Expansion');
    expect(out.view.entityLabel).toBe('Opportunity');
    expect(out.view.status).toEqual({ key: 'executed', label: 'Executed', tone: 'success' });
    expect(out.view.appliedState).toBe('applied');
    expect(out.view.source).toEqual({ kind: 'manual', label: 'Manual', correlationShort: null });
    expect(out.view.recordUrl).toContain(`id=${FULL_GUID}`);
  });

  it('tags batch records with a short correlation', () => {
    const out = presentRecord(rec({ correlationId: 'batch_abcdef123456' }), {});
    expect(out.view.source.kind).toBe('batch');
    expect(out.view.source.correlationShort).toBe('123456');
  });

  it('backfills customer across a list using the full corpus as index source', () => {
    const withAccount = rec({ id: 'a', tool: 'update_milestone', entitySet: `msp_engagementmilestones(${FULL_GUID})`, accountName: 'Northwind Traders' });
    const missing = rec({ id: 'b', tool: 'change_owner', entitySet: `msp_engagementmilestones(${FULL_GUID})`, accountName: null });
    const presented = presentRecords([missing], [withAccount, missing]);
    expect(presented[0].view.customer).toBe('Northwind Traders');
  });
});
