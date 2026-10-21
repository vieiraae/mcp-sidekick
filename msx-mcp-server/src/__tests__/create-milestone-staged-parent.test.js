// Batch Mode: a new opportunity and its milestones are staged together. The milestones wait for
// the opportunity create (dependsOn) and run right after it, linked to the record it creates.
// Every CRM call goes to an in-memory fake — nothing leaves the process.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue } from '../approval-queue.js';

const OPP_ID = '0a0a0a0a-1111-2222-3333-444444444444';
const WORKLOAD_ID = '0b0b0b0b-1111-2222-3333-444444444444';
const CURRENCY_ID = '0c0c0c0c-1111-2222-3333-444444444444';
const msId = (n) => `0d0d0d0d-1111-2222-3333-00000000000${n}`;
const TASK_ID = '0e0e0e0e-1111-2222-3333-444444444444';

/** Answers this flow's requests like Dataverse would, and records every call. */
function fakeCrm() {
  const calls = [];
  const options = { opportunityCreate: 'ok' };
  let createdOpportunity = null;
  const milestones = new Map();
  return {
    calls,
    options,
    request: vi.fn(async (path, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ path, method, body: opts.body ?? null });
      if (path === 'opportunities' && method === 'POST') {
        if (options.opportunityCreate === 'fail') return { ok: false, status: 500, data: { message: 'Create plugin failed' } };
        createdOpportunity = { opportunityid: OPP_ID, ...opts.body };
        return { ok: true, status: 201, data: { opportunityid: OPP_ID, name: opts.body.name } };
      }
      if (path === `opportunities(${OPP_ID})` && method === 'GET') {
        return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: createdOpportunity?.name ?? null, msp_eststartdate: createdOpportunity?.msp_eststartdate ?? null, msp_estcompletiondate: createdOpportunity?.msp_estcompletiondate ?? null } };
      }
      if (path === `opportunities(${OPP_ID})` && method === 'PATCH') return { ok: true, status: 204, data: null };
      if (path === 'msp_engagementmilestones' && method === 'POST') {
        const id = msId(milestones.size + 1);
        milestones.set(id, opts.body);
        return { ok: true, status: 201, data: { msp_engagementmilestoneid: id, msp_name: opts.body.msp_name } };
      }
      const msMatch = path.match(/^msp_engagementmilestones\(([^)]+)\)$/);
      if (msMatch && method === 'GET' && milestones.has(msMatch[1])) {
        return { ok: true, status: 200, data: { msp_engagementmilestoneid: msMatch[1], msp_name: milestones.get(msMatch[1]).msp_name, _msp_opportunityid_value: OPP_ID } };
      }
      if (path === `msp_workloads(${WORKLOAD_ID})`) return { ok: true, status: 200, data: { msp_workloadid: WORKLOAD_ID, msp_name: 'Azure Migrate' } };
      if (path === `tasks(${TASK_ID})` && method === 'PATCH') return { ok: true, status: 204, data: null };
      return { ok: false, status: 404, data: { message: `Unexpected request: ${method} ${path}` } };
    }),
    requestAllPages: vi.fn(async (path) => {
      calls.push({ path, method: 'GET', body: null });
      if (path === 'transactioncurrencies') return { ok: true, status: 200, data: { value: [{ transactioncurrencyid: CURRENCY_ID, currencyname: 'Euro', isocurrencycode: 'EUR' }] } };
      return { ok: true, status: 200, data: { value: [] } };
    }),
    search: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com')
  };
}

async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

const parse = (result) => JSON.parse(result.content[0].text);

/** Stage an opportunity create the way create_opportunity does. */
function stageOpportunity({ dates = true } = {}) {
  const op = getApprovalQueue().stage({
    type: 'create_opportunity',
    entitySet: 'opportunities',
    method: 'POST',
    payload: {
      create: { name: 'Contoso Migration', msp_opportunitytype: '606820001' },
      postCreatePatch: dates ? { msp_eststartdate: '2026-11-01', msp_estcompletiondate: '2027-06-30' } : {},
      plays: null
    },
    beforeState: null,
    description: 'Create opportunity "Contoso Migration" for Contoso'
  });
  op.accountName = 'Contoso';
  return op;
}

const milestoneArgs = (overrides = {}) => ({
  name: 'Landing zone',
  milestoneDate: '2026-12-15',
  monthlyUse: 5000,
  milestoneCategory: 861980002,
  customerCommitment: 861980000,
  milestoneStatus: 861980000,
  milestoneComments: 'Created via MSX-IQ',
  workloadId: WORKLOAD_ID,
  deliveredBy: 606820000,
  preferredAzureRegion: 861980036,
  azureCapacityType: '861980000',
  ...overrides
});

describe('create_milestone with parentOperationId (new opportunity + milestones in one batch)', () => {
  let server, crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = fakeCrm();
    registerTools(server, crm);
  });

  it('stages a milestone that waits for the staged opportunity, without reading CRM for it', async () => {
    const parent = stageOpportunity();
    const res = await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id }));
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body).toMatchObject({ staged: true, dependsOn: parent.id });
    expect(body.message).toContain(`right after ${parent.id}`);

    const op = getApprovalQueue().get(body.operationId);
    expect(op).toMatchObject({ status: 'pending', dependsOn: parent.id, accountName: 'Contoso' });
    expect(op.description).toBe('Create milestone "Landing zone" on new opportunity "Contoso Migration"');
    expect(op.payload.opportunityId).toBeNull();
    expect(op.payload.parentOperationId).toBe(parent.id);
    expect(op.payload.create['msp_OpportunityId@odata.bind']).toBeUndefined();
    // The staged create already carries both dates, so the milestone has none to fill.
    expect(op.payload.opportunityPatch).toEqual({});
    expect(crm.calls.some(c => c.path.startsWith('opportunities'))).toBe(false);
  });

  it('fills the new opportunity dates from the milestone when the staged create has none', async () => {
    const parent = stageOpportunity({ dates: false });
    const body = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));
    expect(getApprovalQueue().get(body.operationId).payload.opportunityPatch)
      .toEqual({ msp_eststartdate: '2026-12-15', msp_estcompletiondate: '2026-12-15' });
  });

  it('execute_all creates the opportunity, then each milestone linked to the new record', async () => {
    const parent = stageOpportunity();
    const first = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));
    const second = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, name: 'Production go-live', milestoneDate: '2027-03-01' })));
    crm.calls.length = 0;

    const out = parse(await callTool(server, 'execute_all'));
    expect(out).toMatchObject({ executed: 3, failed: 0, skipped: 0, total: 3 });

    const posts = crm.calls.filter(c => c.method === 'POST');
    expect(posts.map(c => c.path)).toEqual(['opportunities', 'msp_engagementmilestones', 'msp_engagementmilestones']);
    expect(posts.slice(1).map(c => c.body.msp_name)).toEqual(['Landing zone', 'Production go-live']);
    for (const post of posts.slice(1)) expect(post.body['msp_OpportunityId@odata.bind']).toBe(`/opportunities(${OPP_ID})`);
    // The new opportunity already has its dates: no parent date PATCH.
    expect(crm.calls.some(c => c.method === 'PATCH')).toBe(false);

    const [oppRow, ms1, ms2] = out.results;
    expect(oppRow).toMatchObject({ id: parent.id, type: 'create_opportunity', success: true, opportunityId: OPP_ID, dependentMilestones: [first.operationId, second.operationId] });
    expect(ms1).toMatchObject({ id: first.operationId, type: 'create_milestone', success: true, milestoneId: msId(1), recordName: 'Landing zone', parentOperationId: parent.id, opportunityId: OPP_ID });
    expect(ms2).toMatchObject({ id: second.operationId, type: 'create_milestone', success: true, milestoneId: msId(2), recordName: 'Production go-live', parentOperationId: parent.id, opportunityId: OPP_ID });
    expect(getApprovalQueue().listPending()).toHaveLength(0);
  });

  it('execute_all runs the milestones right after their opportunity, ahead of anything staged in between', async () => {
    const parent = stageOpportunity();
    const first = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));
    const between = getApprovalQueue().stage({
      type: 'update_task',
      entitySet: `tasks(${TASK_ID})`,
      method: 'PATCH',
      payload: { subject: 'Send the pilot plan' },
      description: 'Update task "Send the pilot plan"',
      etag: 'W/"1"'
    });
    const second = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, name: 'Production go-live', milestoneDate: '2027-03-01' })));
    crm.calls.length = 0;

    const out = parse(await callTool(server, 'execute_all'));
    expect(out).toMatchObject({ executed: 4, failed: 0, skipped: 0, total: 4 });
    expect(out.results.map(r => r.id)).toEqual([parent.id, first.operationId, second.operationId, between.id]);
    expect(crm.calls.filter(c => c.method !== 'GET').map(c => c.path))
      .toEqual(['opportunities', 'msp_engagementmilestones', 'msp_engagementmilestones', `tasks(${TASK_ID})`]);
  });

  it('lets only the first milestone fill the dates the new opportunity lacks', async () => {
    const parent = stageOpportunity({ dates: false });
    await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id }));
    await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, name: 'Production go-live', milestoneDate: '2027-03-01' }));

    const out = parse(await callTool(server, 'execute_all'));
    expect(out).toMatchObject({ executed: 3, failed: 0 });
    expect(crm.calls.filter(c => c.method === 'PATCH')).toEqual([
      { path: `opportunities(${OPP_ID})`, method: 'PATCH', body: { msp_eststartdate: '2026-12-15', msp_estcompletiondate: '2026-12-15' } }
    ]);
  });

  it('skips the milestones when the opportunity create fails, and runs them on the retry', async () => {
    crm.options.opportunityCreate = 'fail';
    const parent = stageOpportunity();
    const ms = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));

    const out = parse(await callTool(server, 'execute_all'));
    expect(out).toMatchObject({ executed: 0, failed: 1, skipped: 1, total: 2 });
    expect(out.results[1]).toMatchObject({ id: ms.operationId, success: false, skipped: true, dependsOn: parent.id });
    expect(crm.calls.some(c => c.path === 'msp_engagementmilestones')).toBe(false);
    expect(getApprovalQueue().get(ms.operationId)).toMatchObject({ status: 'pending', dependsOn: parent.id });

    crm.options.opportunityCreate = 'ok';
    const retry = parse(await callTool(server, 'execute_all'));
    expect(retry).toMatchObject({ executed: 2, failed: 0, skipped: 0 });
    expect(retry.results[1]).toMatchObject({ id: ms.operationId, success: true, opportunityId: OPP_ID });
  });

  it('execute_operation on the opportunity runs its milestones right after it', async () => {
    const parent = stageOpportunity();
    const ms = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));

    const out = parse(await callTool(server, 'execute_operation', { id: parent.id }));
    expect(out).toMatchObject({ success: true, executed: parent.id, opportunityId: OPP_ID });
    expect(out.dependentMilestones).toEqual([
      expect.objectContaining({ id: ms.operationId, type: 'create_milestone', success: true, milestoneId: msId(1), recordName: 'Landing zone' })
    ]);
    const msPost = crm.calls.find(c => c.method === 'POST' && c.path === 'msp_engagementmilestones');
    expect(msPost.body['msp_OpportunityId@odata.bind']).toBe(`/opportunities(${OPP_ID})`);
    expect(getApprovalQueue().listPending()).toHaveLength(0);
  });

  it('execute_operation refuses a milestone still waiting for its opportunity', async () => {
    const parent = stageOpportunity();
    const ms = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));

    const res = await callTool(server, 'execute_operation', { id: ms.operationId });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(`runs right after ${parent.id}`);
    expect(crm.calls.some(c => c.method === 'POST')).toBe(false);
    expect(getApprovalQueue().get(ms.operationId)).toMatchObject({ status: 'pending', dependsOn: parent.id });

    // Its opportunity left the queue some other way: say so instead of creating an orphan.
    getApprovalQueue().getAll().delete(parent.id);
    const orphan = await callTool(server, 'execute_operation', { id: ms.operationId });
    expect(orphan.isError).toBe(true);
    expect(orphan.content[0].text).toContain('no longer queued');
  });

  it('cancelling the opportunity cancels its milestones', async () => {
    const parent = stageOpportunity();
    const a = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));
    const b = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, name: 'Production go-live' })));

    const out = parse(await callTool(server, 'cancel_operation', { id: parent.id }));
    expect(out).toMatchObject({ cancelled: parent.id, cancelledDependents: [a.operationId, b.operationId] });
    expect(getApprovalQueue().listPending()).toHaveLength(0);
  });

  it('blocks a second milestone with the same name on the same new opportunity', async () => {
    const parent = stageOpportunity();
    const first = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));

    const pre = parse(await callTool(server, 'create_milestone_preflight', milestoneArgs({ parentOperationId: parent.id, name: '  landing ZONE ' })));
    expect(pre.canCreate).toBe(false);
    expect(pre.duplicates).toEqual([expect.objectContaining({ staged: true, operationId: first.operationId, name: 'Landing zone' })]);

    const dup = await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, name: 'landing zone' }));
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain('Duplicate candidates found');

    const allowed = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, name: 'landing zone', allowDuplicate: true })));
    expect(allowed.staged).toBe(true);
  });

  it('preflight validates against the staged opportunity instead of requiring an id', async () => {
    const parent = stageOpportunity();
    const pre = parse(await callTool(server, 'create_milestone_preflight', milestoneArgs({ parentOperationId: parent.id })));
    expect(pre.canCreate).toBe(true);
    expect(pre.validation.blockers).toEqual([]);
    expect(crm.calls.some(c => c.path.startsWith('opportunities'))).toBe(false);
  });

  it('rejects an ambiguous, unknown or non-opportunity parent', async () => {
    const parent = stageOpportunity();

    const both = await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id, opportunityId: OPP_ID }));
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain('not both');

    const unknown = await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: 'OP-999' }));
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('OP-999 is not a staged opportunity create');

    const ms = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));
    const chained = await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: ms.operationId, name: 'Follow-up' }));
    expect(chained.isError).toBe(true);
    expect(getApprovalQueue().listPending()).toHaveLength(2);
  });

  it('list_pending_operations shows what each milestone waits for, and its parent\'s clock', async () => {
    const parent = stageOpportunity();
    const ms = parse(await callTool(server, 'create_milestone', milestoneArgs({ parentOperationId: parent.id })));
    parent.expiresAt = Date.now() + 60_000;

    const list = parse(await callTool(server, 'list_pending_operations'));
    const msRow = list.operations.find(o => o.id === ms.operationId);
    const oppRow = list.operations.find(o => o.id === parent.id);
    expect(msRow.dependsOn).toBe(parent.id);
    expect(oppRow.dependsOn).toBeUndefined();
    expect(msRow.expiresInMs).toBeLessThanOrEqual(60_000);
    expect(msRow.expiresInMs).toBe(oppRow.expiresInMs);
  });
});
