// Stale-conflict self-recovery for same-record multiple ops in one PLAY run.
// Reproduces Joaquin's live bug: staging a comment update + status update on the
// SAME milestone, then hitting PLAY, caused the second op to return "Stale".
//
// Root cause: op2 carried the staging-time ETag (V0) but op1 already bumped the
// record to V1. execute_all now detects this via writtenThisPlay and auto-retries
// with a fresh etag instead of marking the second op as stale-conflict.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue } from '../approval-queue.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function mockCrmClient(responses = {}) {
  return {
    request: vi.fn(async (path, opts) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 200, data: {} };
    }),
    requestAllPages: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    search: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com'),
  };
}

async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

// ── shared setup ───────────────────────────────────────────────
describe('execute_all same-record stale self-recovery', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-stale-recovery-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'abc-123', BusinessUnitId: 'bu-1' } },
    });
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  // ── happy path: two ops on the same milestone both succeed ──
  it('two ops on same milestone both succeed — second auto-recovers from self-inflicted 412', async () => {
    const queue = getApprovalQueue();
    const MILESTONE = 'msp_engagementmilestones(ms-guid-aaa)';

    // Op1: add comment (will succeed, bumping the record to V1)
    queue.stage({
      type: 'update_milestone',
      entitySet: MILESTONE,
      method: 'PATCH',
      payload: { msp_comments: 'Great progress' },
      beforeState: { msp_comments: '' },
      description: 'Add milestone comment',
      etag: 'W/"V0"',
    });

    // Op2: update status (carries stale V0 — should self-recover)
    queue.stage({
      type: 'update_milestone',
      entitySet: MILESTONE,
      method: 'PATCH',
      payload: { msp_statuscode: 2 },
      beforeState: { msp_statuscode: 1 },
      description: 'Update milestone status',
      etag: 'W/"V0"',
    });

    crm.request
      // Op1 PATCH succeeds; CRM returns the new etag V1
      .mockResolvedValueOnce({ ok: true, status: 204, data: { '@odata.etag': 'W/"V1"' } })
      // Op2 PATCH with stale V0 -> 412
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} })
      // Self-recovery: GET refetch returns fresh V1
      .mockResolvedValueOnce({ ok: true, status: 200, data: { '@odata.etag': 'W/"V1"' } })
      // Self-recovery: retry PATCH with V1 succeeds
      .mockResolvedValueOnce({ ok: true, status: 204, data: {} });

    const result = await callTool(server, 'execute_all', {});
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0].text);

    // Both ops must succeed — zero stale-conflict
    expect(summary.executed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(2);

    // The second op result must be flagged as self-recovered
    const op2Result = summary.results[1];
    expect(op2Result.success).toBe(true);
    expect(op2Result.note).toBe('self-recovered');

    // Verify the retry path fired: 4 calls = PATCH1, PATCH2(412), GET, PATCH-retry
    expect(crm.request).toHaveBeenCalledTimes(4);
  });

  // ── genuine stale conflict is preserved ───────────────────
  it('genuine stale conflict: op on a record NOT written by us still marks stale-conflict', async () => {
    const queue = getApprovalQueue();

    // Single op on a record we never wrote in this play
    queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(ms-guid-bbb)',
      method: 'PATCH',
      payload: { msp_statuscode: 3 },
      beforeState: { msp_statuscode: 2 },
      description: 'Status update — genuine stale',
      etag: 'W/"V0"',
    });

    // CRM returns 412 (another user edited the record between stage and play)
    crm.request.mockResolvedValueOnce({ ok: false, status: 412, data: {} });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);

    expect(summary.executed).toBe(0);
    expect(summary.failed).toBe(1);

    const opResult = summary.results[0];
    expect(opResult.success).toBe(false);
    expect(opResult.reason).toMatch(/stale-conflict/);

    // No retry or GET attempted — exactly 1 CRM call
    expect(crm.request).toHaveBeenCalledTimes(1);
  });

  // ── self-recovery: refetch GET fails → fall back to stale-conflict ──
  it('self-recovery falls back to stale-conflict when refetch GET fails', async () => {
    const queue = getApprovalQueue();
    const MILESTONE = 'msp_engagementmilestones(ms-guid-ccc)';

    queue.stage({
      type: 'update_milestone',
      entitySet: MILESTONE,
      method: 'PATCH',
      payload: { msp_comments: 'First edit' },
      beforeState: {},
      description: 'First edit',
      etag: 'W/"V0"',
    });

    queue.stage({
      type: 'update_milestone',
      entitySet: MILESTONE,
      method: 'PATCH',
      payload: { msp_statuscode: 2 },
      beforeState: { msp_statuscode: 1 },
      description: 'Status update',
      etag: 'W/"V0"',
    });

    crm.request
      // Op1 succeeds (no etag in response — null stored in writtenThisPlay)
      .mockResolvedValueOnce({ ok: true, status: 204, data: {} })
      // Op2 412
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} })
      // GET refetch returns error — self-recovery cannot proceed
      .mockResolvedValueOnce({ ok: false, status: 503, data: { message: 'Service unavailable' } });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);

    // Op1 succeeded, Op2 fell back to stale-conflict
    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);

    const op2Result = summary.results[1];
    expect(op2Result.success).toBe(false);
    expect(op2Result.reason).toMatch(/stale-conflict/);

    // 3 calls: PATCH1, PATCH2(412), GET(failed)
    expect(crm.request).toHaveBeenCalledTimes(3);
  });

  // ── self-recovery: retry itself 412s (genuine third-party race) ──
  it('self-recovery: if retry PATCH also 412, falls back to stale-conflict', async () => {
    const queue = getApprovalQueue();
    const MILESTONE = 'msp_engagementmilestones(ms-guid-ddd)';

    queue.stage({
      type: 'update_milestone',
      entitySet: MILESTONE,
      method: 'PATCH',
      payload: { msp_comments: 'First' },
      beforeState: {},
      description: 'First op',
      etag: 'W/"V0"',
    });

    queue.stage({
      type: 'update_milestone',
      entitySet: MILESTONE,
      method: 'PATCH',
      payload: { msp_statuscode: 2 },
      beforeState: { msp_statuscode: 1 },
      description: 'Second op',
      etag: 'W/"V0"',
    });

    crm.request
      .mockResolvedValueOnce({ ok: true, status: 204, data: {} })               // Op1 success
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} })              // Op2 412
      .mockResolvedValueOnce({ ok: true, status: 200, data: { '@odata.etag': 'W/"V2"' } }) // GET refetch #1
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} })              // Retry #1 also 412
      .mockResolvedValueOnce({ ok: false, status: 500, data: { message: 'refetch failed' } }); // GET refetch #2 fails → give up

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);

    // Op1 succeeded; Op2's retry also 412'd and the next refetch failed. Self-recovery
    // now retries with backoff (to ride out churn) and falls back to stale-conflict.
    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);

    const op2Result = summary.results[1];
    expect(op2Result.success).toBe(false);
    expect(op2Result.reason).toMatch(/stale-conflict/);

    // 5 calls: PATCH1, PATCH2(412), GET#1, retry(412), GET#2(fails → give up)
    expect(crm.request).toHaveBeenCalledTimes(5);
  });

  // ── three ops on same milestone: all succeed ──────────────
  it('three ops on the same milestone: all three succeed via progressive self-recovery', async () => {
    const queue = getApprovalQueue();
    const MILESTONE = 'msp_engagementmilestones(ms-guid-eee)';

    for (const [i, payload] of [
      [1, { msp_comments: 'Comment' }],
      [2, { msp_statuscode: 2 }],
      [3, { msp_forecastamount: 500 }],
    ]) {
      queue.stage({
        type: 'update_milestone',
        entitySet: MILESTONE,
        method: 'PATCH',
        payload,
        beforeState: {},
        description: `Op ${i}`,
        etag: 'W/"V0"',
      });
    }

    crm.request
      .mockResolvedValueOnce({ ok: true, status: 204, data: { '@odata.etag': 'W/"V1"' } }) // Op1 PATCH ok
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} })                          // Op2 PATCH 412
      .mockResolvedValueOnce({ ok: true, status: 200, data: { '@odata.etag': 'W/"V1"' } }) // Op2 GET
      .mockResolvedValueOnce({ ok: true, status: 204, data: { '@odata.etag': 'W/"V2"' } }) // Op2 retry ok
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} })                          // Op3 PATCH 412
      .mockResolvedValueOnce({ ok: true, status: 200, data: { '@odata.etag': 'W/"V2"' } }) // Op3 GET
      .mockResolvedValueOnce({ ok: true, status: 204, data: {} });                          // Op3 retry ok

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);

    expect(summary.executed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.results[1].note).toBe('self-recovered');
    expect(summary.results[2].note).toBe('self-recovered');

    expect(crm.request).toHaveBeenCalledTimes(7);
  });

  // ── two ops on DIFFERENT records: no cross-contamination ──
  it('412 on a DIFFERENT record is never auto-recovered (different entitySets)', async () => {
    const queue = getApprovalQueue();

    // Op1 on record A — will succeed
    queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(ms-guid-fff)',
      method: 'PATCH',
      payload: { msp_comments: 'Comment on A' },
      beforeState: {},
      description: 'Op on record A',
      etag: 'W/"V0"',
    });

    // Op2 on record B — will 412, NOT self-recovered because B was not written by us
    queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(ms-guid-ggg)',
      method: 'PATCH',
      payload: { msp_statuscode: 2 },
      beforeState: { msp_statuscode: 1 },
      description: 'Op on record B',
      etag: 'W/"V0"',
    });

    crm.request
      .mockResolvedValueOnce({ ok: true, status: 204, data: {} })  // Op1 on A succeeds
      .mockResolvedValueOnce({ ok: false, status: 412, data: {} }); // Op2 on B 412 — genuine

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);

    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);

    const op2Result = summary.results[1];
    expect(op2Result.success).toBe(false);
    expect(op2Result.reason).toMatch(/stale-conflict/);

    // Only 2 calls — no GET attempted for B
    expect(crm.request).toHaveBeenCalledTimes(2);
  });
});
