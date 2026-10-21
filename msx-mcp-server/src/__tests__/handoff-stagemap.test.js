import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue } from '../approval-queue.js';

function mockCrmClient(responses = {}) {
  return {
    request: vi.fn(async (path) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 200, data: {} };
    }),
    requestAllPages: vi.fn(async (path) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 200, data: { value: [] } };
    }),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com')
  };
}

async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OPP_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeOppAtStage(stage) {
  const STAGE_STRINGS = {
    1: 'Listen & Consult',
    2: 'Inspire & Design',
    3: 'Empower & Achieve',
    4: 'Realize Value',
    5: 'Manage & Optimize'
  };
  return {
    opportunityid: OPP_ID,
    name: `Stage ${stage} Opp`,
    _ownerid_value: USER_ID,
    msp_estcompletiondate: '2027-06-30',
    msp_opportunitynumber: `OPP-S${stage}`,
    '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso',
    msp_activesalesstage: STAGE_STRINGS[stage],
    'msp_activesalesstage@OData.Community.Display.V1.FormattedValue': STAGE_STRINGS[stage]
  };
}

function makeMilestone({ ownerId, committed = false, category = 861980002, status = 'On Track' }) {
  return {
    msp_engagementmilestoneid: 'ms-' + Math.random().toString(36).slice(2),
    msp_milestonenumber: 'MS-TEST',
    msp_name: 'Test Milestone',
    msp_milestonedate: '2027-06-01',
    msp_milestonecategory: category,
    'msp_commitmentrecommendation@OData.Community.Display.V1.FormattedValue': committed ? 'Committed' : 'Uncommitted',
    'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': status,
    msp_milestonestatus: status,
    _msp_opportunityid_value: OPP_ID,
    '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Stage Opp',
    _ownerid_value: ownerId,
    '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Test Person',
    _msp_workloadlkid_value: 'wl-1',
    '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure'
  };
}

/** Set up the standard 3 requestAllPages mocks (opps, ms from opps, ms owned by me) */
function setupBaseMocks(crm, opp, milestones) {
  crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [opp] } });
  crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: milestones } });
  crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
}

// ── handoff_check tests ───────────────────────────────────────────────────────

describe('handoff_check — MCEM ownership matrix', () => {
  let server;
  let crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: USER_ID } }
    });
    registerTools(server, crm);
  });

  it('registers the handoff_check tool', () => {
    expect(server._registeredTools?.['handoff_check']).toBeDefined();
  });

  it('no milestones → 0 violations, 0 warnings', async () => {
    setupBaseMocks(crm, makeOppAtStage(4), []);
    // No systemusers call needed when no milestones

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 violations');
    expect(md).toContain('0 warnings');
    expect(md).toContain('1 opp checked');
    expect(md).toContain('No ownership violations detected');
  });

  it('Stage 2 uncommitted milestone owned by STU → no violation', async () => {
    const ms = makeMilestone({ ownerId: 'stu-user', committed: false });
    setupBaseMocks(crm, makeOppAtStage(2), [ms]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: 'stu-user', fullname: 'Specialist', msp_rolegroup: 'STU' }] }
    });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 violations');
    expect(md).toContain('No ownership violations detected');
  });

  it('Stage 2 uncommitted milestone owned by ATU → violation, ATU→STU, severity high', async () => {
    const ms = makeMilestone({ ownerId: 'atu-user', committed: false });
    setupBaseMocks(crm, makeOppAtStage(2), [ms]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: 'atu-user', fullname: 'Account Exec', msp_rolegroup: 'ATU' }] }
    });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('1 violation');
    expect(md).toContain('1 high');
    expect(md).toContain('🔴 High Severity Violations');
    expect(md).toContain('ATU');
    expect(md).toContain('STU');
    expect(md).toContain('2 — Inspire & Design');
    expect(md).toContain('uncommitted');
  });

  it('Stage 3 committed milestone owned by CSU → NO violation (MCEM §6 legitimate)', async () => {
    const ms = makeMilestone({ ownerId: 'csu-user', committed: true });
    setupBaseMocks(crm, makeOppAtStage(3), [ms]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: 'csu-user', fullname: 'CSAM', msp_rolegroup: 'CSU' }] }
    });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 violations');
    expect(md).toContain('No ownership violations detected');
  });

  it('Stage 3 uncommitted milestone owned by CSU → violation (expected STU)', async () => {
    const ms = makeMilestone({ ownerId: 'csu-user', committed: false });
    setupBaseMocks(crm, makeOppAtStage(3), [ms]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: 'csu-user', fullname: 'CSAM', msp_rolegroup: 'CSU' }] }
    });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('1 violation');
    expect(md).toContain('STU');
  });

  it('Committed milestone owned by STU → violation, high severity', async () => {
    const ms = makeMilestone({ ownerId: 'stu-user', committed: true });
    setupBaseMocks(crm, makeOppAtStage(4), [ms]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: 'stu-user', fullname: 'Specialist', msp_rolegroup: 'STU' }] }
    });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('1 violation');
    expect(md).toContain('CSU');
    expect(md).toContain('🔴 High Severity Violations');
  });

  it('roleGroupMissing (lookup failed) → warning, NOT violation', async () => {
    const ms = makeMilestone({ ownerId: 'mystery-user', committed: false });
    setupBaseMocks(crm, makeOppAtStage(2), [ms]);
    // Systemusers lookup fails (non-ok)
    crm.requestAllPages.mockResolvedValueOnce({ ok: false, status: 500, data: {} });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 violations');
    expect(md).toContain('1 warning');
    expect(md).toContain('Warnings (Role Data Missing)');
    expect(md).toContain('roleGroupMissing');
  });

  it('terminal milestone → skipped entirely', async () => {
    const ms = makeMilestone({ ownerId: 'atu-user', committed: false, status: 'Completed' });
    ms.msp_milestonestatus = 861980003; // Completed code
    setupBaseMocks(crm, makeOppAtStage(2), [ms]);
    // No systemusers call since no candidates after terminal filter

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 violations');
    expect(md).toContain('0 warnings');
    expect(md).toContain('No ownership violations detected');
  });

  it('null stage opp → milestone skipped safely', async () => {
    const opp = makeOppAtStage(2);
    opp.msp_activesalesstage = null;
    opp['msp_activesalesstage@OData.Community.Display.V1.FormattedValue'] = null;
    const ms = makeMilestone({ ownerId: 'atu-user', committed: false });
    setupBaseMocks(crm, opp, [ms]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: 'atu-user', fullname: 'AE', msp_rolegroup: 'ATU' }] }
    });

    const result = await callTool(server, 'handoff_check', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 violations');
    expect(md).toContain('No ownership violations detected');
  });

  it('WhoAmI failure → returns error', async () => {
    const badCrm = mockCrmClient({
      WhoAmI: { ok: false, status: 401, data: { message: 'Unauthorized' } }
    });
    const srv = new McpServer({ name: 'test', version: '0.0.1' });
    registerTools(srv, badCrm);

    const result = await callTool(srv, 'handoff_check', {});
    expect(result.isError).toBe(true);
  });
});

// ── stage_map tests ───────────────────────────────────────────────────────────

describe('stage_map — MCEM stage grouping and ownership alerts', () => {
  let server;
  let crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: USER_ID } }
    });
    registerTools(server, crm);
  });

  it('registers the stage_map tool', () => {
    expect(server._registeredTools?.['stage_map']).toBeDefined();
  });

  it('no opps → all stages empty, meta.total_opps = 0', async () => {
    // No opps → no milestones
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } }); // owned opps
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } }); // ms from opps
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } }); // ms owned by me

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('0 opps');
    expect(md).toContain('No coverage: Stages 1, 2, 3, 4, 5');
    expect(md).toContain('No opportunities in this stage');
    // All 5 stage headings should appear
    for (const s of [1, 2, 3, 4, 5]) {
      expect(md).toContain(`Stage ${s} —`);
    }
  });

  it('Stage 4 opp owned by CSU → ownershipAlert false', async () => {
    const opp = makeOppAtStage(4);
    setupBaseMocks(crm, opp, []);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'CSAM', msp_rolegroup: 'CSU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('Stage 4 — Realize Value (Expected: CSU)');
    expect(md).toContain('CSU');
    // Opp row should not have ⚠️ in it (no ownership alert)
    const lines = md.split('\n');
    const oppRow = lines.find(l => l.includes('Stage 4 Opp'));
    expect(oppRow).toBeDefined();
    expect(oppRow).not.toContain('⚠️');
  });

  it('Stage 2 opp owned by ATU → ownershipAlert true (expected STU)', async () => {
    const opp = makeOppAtStage(2);
    setupBaseMocks(crm, opp, []);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'AE', msp_rolegroup: 'ATU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('Stage 2 — Inspire & Design (Expected: STU)');
    // Opp row should have ⚠️ for ownership alert
    const lines = md.split('\n');
    const oppRow = lines.find(l => l.includes('Stage 2 Opp'));
    expect(oppRow).toBeDefined();
    expect(oppRow).toContain('⚠️');
  });

  it('Stage 2 opp owned by STU → ownershipAlert false', async () => {
    const opp = makeOppAtStage(2);
    setupBaseMocks(crm, opp, []);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'Specialist', msp_rolegroup: 'STU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    const lines = md.split('\n');
    const oppRow = lines.find(l => l.includes('Stage 2 Opp'));
    expect(oppRow).toBeDefined();
    expect(oppRow).not.toContain('⚠️');
  });

  it('milestone counts — committed and uncommitted tracked separately', async () => {
    const opp = makeOppAtStage(4);
    const ms1 = makeMilestone({ ownerId: USER_ID, committed: true });
    const ms2 = makeMilestone({ ownerId: USER_ID, committed: true });
    const ms3 = makeMilestone({ ownerId: USER_ID, committed: false });
    setupBaseMocks(crm, opp, [ms1, ms2, ms3]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'CSAM', msp_rolegroup: 'CSU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    // Row format: | ... | 2 | 1 | 3 |
    const lines = md.split('\n');
    const oppRow = lines.find(l => l.includes('Stage 4 Opp'));
    expect(oppRow).toBeDefined();
    expect(oppRow).toMatch(/\|\s*2\s*\|\s*1\s*\|\s*3\s*\|/);
  });

  it('terminal milestones excluded from counts', async () => {
    const opp = makeOppAtStage(4);
    const activeMs = makeMilestone({ ownerId: USER_ID, committed: true });
    const completedMs = makeMilestone({ ownerId: USER_ID, committed: true, status: 'Completed' });
    completedMs.msp_milestonestatus = 861980003;
    setupBaseMocks(crm, opp, [activeMs, completedMs]);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'CSAM', msp_rolegroup: 'CSU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    // Row should show 1 committed, 0 uncommitted, 1 total (completed excluded)
    const lines = md.split('\n');
    const oppRow = lines.find(l => l.includes('Stage 4 Opp'));
    expect(oppRow).toBeDefined();
    expect(oppRow).toMatch(/\|\s*1\s*\|\s*0\s*\|\s*1\s*\|/);
  });

  it('stages_with_coverage and stages_without_coverage correctly derived', async () => {
    const opp = makeOppAtStage(3);
    setupBaseMocks(crm, opp, []);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'Specialist', msp_rolegroup: 'STU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('Coverage: Stages 3');
    expect(md).toContain('No coverage: Stages 1, 2, 4, 5');
  });

  it('opp with null stage → captured in unknownStage, not dropped', async () => {
    const opp = makeOppAtStage(2);
    opp.msp_activesalesstage = null;
    opp['msp_activesalesstage@OData.Community.Display.V1.FormattedValue'] = null;
    setupBaseMocks(crm, opp, []);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'AE', msp_rolegroup: 'ATU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    expect(md).toContain('Unknown Stage');
    expect(md).toContain('No coverage: Stages 1, 2, 3, 4, 5');
  });

  it('stage_map output has all 5 stage keys', async () => {
    setupBaseMocks(crm, makeOppAtStage(1), []);
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: USER_ID, fullname: 'AE', msp_rolegroup: 'ATU' }] }
    });

    const result = await callTool(server, 'stage_map', {});
    expect(result.isError).toBeUndefined();
    const md = result.content[0].text;
    const STAGE_NAMES = {
      1: 'Listen & Consult', 2: 'Inspire & Design', 3: 'Empower & Achieve',
      4: 'Realize Value', 5: 'Manage & Optimize'
    };
    const STAGE_ROLES = { 1: 'ATU', 2: 'STU', 3: 'STU', 4: 'CSU', 5: 'CSU' };
    for (const s of [1, 2, 3, 4, 5]) {
      expect(md).toContain(`Stage ${s} — ${STAGE_NAMES[s]} (Expected: ${STAGE_ROLES[s]})`);
    }
  });

  it('WhoAmI failure → returns error', async () => {
    const badCrm = mockCrmClient({
      WhoAmI: { ok: false, status: 401, data: { message: 'Unauthorized' } }
    });
    const srv = new McpServer({ name: 'test', version: '0.0.1' });
    registerTools(srv, badCrm);

    const result = await callTool(srv, 'stage_map', {});
    expect(result.isError).toBe(true);
  });
});
