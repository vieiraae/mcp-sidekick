// Phase 2.5 — correlationId stamping in execute_all
// Verifies that every PLAY run stamps ONE shared correlationId on all audit records,
// two runs produce different correlationIds, and execute_operation (manual) stays null.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue, MAX_RETRIES } from '../approval-queue.js';
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

describe('execute_all correlationId stamping (Phase 2.5)', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-correlationid-'));
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

  it('execute_all returns a non-null correlationId matching /^batch_/ in the summary', async () => {
    const queue = getApprovalQueue();
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-aaa)',
      method: 'PATCH',
      payload: { subject: 'Updated A' },
      beforeState: { subject: 'Original A' },
      description: 'Update task A',
    });

    crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result = await callTool(server, 'execute_all', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.correlationId).toBeTruthy();
    expect(parsed.correlationId).toMatch(/^batch_/);
  });

  it('execute_all stamps the SAME correlationId on every audit record of a single run', async () => {
    const queue = getApprovalQueue();

    // Stage two ops so we get two audit records
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-1)',
      method: 'PATCH',
      payload: { subject: 'Task 1 updated' },
      beforeState: { subject: 'Task 1 original' },
      description: 'Update task 1',
    });
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-2)',
      method: 'PATCH',
      payload: { subject: 'Task 2 updated' },
      beforeState: { subject: 'Task 2 original' },
      description: 'Update task 2',
    });

    crm.request
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
      .mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);
    const runCorrelationId = summary.correlationId;

    expect(runCorrelationId).toMatch(/^batch_/);

    // Read the audit log and assert every entry from this run shares the same correlationId
    const logResult = await callTool(server, 'query_audit_log', { limit: 20 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const runEntries = entries.filter(e => e.correlationId === runCorrelationId);
    expect(runEntries.length).toBe(2); // one per staged op

    // All must be non-null and all must match the summary's correlationId
    for (const entry of runEntries) {
      expect(entry.correlationId).toBe(runCorrelationId);
    }
  });

  it('two separate execute_all runs produce DIFFERENT correlationIds', async () => {
    const queue = getApprovalQueue();

    // First run: one op
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-run1)',
      method: 'PATCH',
      payload: { subject: 'Run 1' },
      beforeState: { subject: 'Original' },
      description: 'Run 1 op',
    });
    crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result1 = await callTool(server, 'execute_all', {});
    const summary1 = JSON.parse(result1.content[0].text);
    const cid1 = summary1.correlationId;

    // Second run: one op
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-run2)',
      method: 'PATCH',
      payload: { subject: 'Run 2' },
      beforeState: { subject: 'Original' },
      description: 'Run 2 op',
    });
    crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result2 = await callTool(server, 'execute_all', {});
    const summary2 = JSON.parse(result2.content[0].text);
    const cid2 = summary2.correlationId;

    expect(cid1).toMatch(/^batch_/);
    expect(cid2).toMatch(/^batch_/);
    expect(cid1).not.toBe(cid2);
  });

  it('execute_all summary includes correlationId, executed, failed, total, results', async () => {
    const queue = getApprovalQueue();
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-summary)',
      method: 'PATCH',
      payload: { subject: 'Summary test' },
      beforeState: { subject: 'Before' },
      description: 'Summary test op',
    });

    crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result = await callTool(server, 'execute_all', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty('correlationId');
    expect(parsed).toHaveProperty('executed');
    expect(parsed).toHaveProperty('failed');
    expect(parsed).toHaveProperty('total');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.total).toBe(parsed.results.length);
    expect(parsed.executed + parsed.failed).toBe(parsed.total);
  });

  it('execute_all stamps correlationId on failed audit records too', async () => {
    const queue = getApprovalQueue();
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-fail)',
      method: 'PATCH',
      payload: { subject: 'Will fail' },
      beforeState: { subject: 'Before' },
      description: 'Failing op',
    });

    // Return a non-412, non-ok response to trigger the 'failed' path
    crm.request.mockResolvedValueOnce({ ok: false, status: 500, data: { message: 'Server error' } });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);

    expect(summary.correlationId).toMatch(/^batch_/);
    expect(summary.failed).toBe(1);

    const logResult = await callTool(server, 'query_audit_log', { limit: 20 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const failEntry = entries.find(e => e.phase === 'failed' && e.correlationId === summary.correlationId);
    expect(failEntry).toBeDefined();
    expect(failEntry.correlationId).toBe(summary.correlationId);
  });
});

describe('execute_operation correlationId stays null (manual path)', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-manual-corr-'));
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

  it('execute_operation stamps correlationId null on the audit record (manual = no batch id)', async () => {
    const queue = getApprovalQueue();
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-manual)',
      method: 'PATCH',
      payload: { subject: 'Manual update' },
      beforeState: { subject: 'Before' },
      description: 'Manual op',
    });

    crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: null });

    await callTool(server, 'execute_operation', { id: 'OP-1' });

    const logResult = await callTool(server, 'query_audit_log', { limit: 10 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const manualEntry = entries.find(e => e.phase === 'executed');
    expect(manualEntry).toBeDefined();
    expect(manualEntry.correlationId).toBeNull();
  });
});

describe('execute_all dead-letter: audit record carries the run correlationId', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-batch-dl-'));
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

  it('execute_all dead-letter: dead-letter audit record carries the run correlationId (not null)', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-dl-batch)',
      method: 'PATCH',
      payload: { subject: 'Will dead-letter in batch' },
      beforeState: { subject: 'Before' },
      description: 'Dead-letter op from PLAY',
    });
    // Force op to be one failure away from dead-lettering on next attempt
    op.retryCount = MAX_RETRIES - 1;

    crm.request.mockResolvedValueOnce({ ok: false, status: 500, data: { message: 'CRM unavailable' } });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);
    expect(summary.correlationId).toMatch(/^batch_/);

    const logResult = await callTool(server, 'query_audit_log', { limit: 20 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const dlEntry = entries.find(e => e.phase === 'dead-letter');
    expect(dlEntry).toBeDefined();
    // The dead-letter record MUST carry the run's correlationId, not null
    expect(dlEntry.correlationId).toBe(summary.correlationId);
    expect(dlEntry.correlationId).not.toBeNull();
  });
});

describe('execute_operation dead-letter: audit record correlationId is null (manual path)', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-manual-dl-'));
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

  it('execute_operation dead-letter: audit record has correlationId null (manual op has no batch id)', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-manual-dl)',
      method: 'PATCH',
      payload: { subject: 'Manual dead-letter' },
      beforeState: { subject: 'Before' },
      description: 'Manual op that will dead-letter',
    });
    // Force op to be one failure away from dead-lettering on next attempt
    op.retryCount = MAX_RETRIES - 1;

    crm.request.mockResolvedValueOnce({ ok: false, status: 500, data: { message: 'CRM unavailable' } });

    await callTool(server, 'execute_operation', { id: op.id });

    const logResult = await callTool(server, 'query_audit_log', { limit: 20 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const dlEntry = entries.find(e => e.phase === 'dead-letter');
    expect(dlEntry).toBeDefined();
    // Manual (non-batch) dead-letter MUST have correlationId null
    expect(dlEntry.correlationId).toBeNull();
  });
});

describe('execute_all precheck-abort dead-letter: correlationId propagates through milestone recheck paths', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-precheck-dl-'));
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

  it('precheck recheck not ok: dead-letter record carries the run correlationId (not null)', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_milestones(milestone-precheck-fail)',
      method: 'PATCH',
      payload: { msp_name: 'Updated name' },
      beforeState: { msp_name: 'Original name' },
      description: 'Milestone update that fails precheck',
    });
    // identity must be set directly — queue.stage() does not accept it as a param
    op.identity = { milestoneNumber: 'MS-001' };
    // One failure away from dead-letter — markFailed inside the precheck block will push it over
    op.retryCount = MAX_RETRIES - 1;

    // Recheck request returns not-ok so the 'milestone no longer accessible' path fires
    crm.request.mockResolvedValueOnce({ ok: false, status: 404, data: { message: 'Not found' } });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);
    expect(summary.correlationId).toMatch(/^batch_/);

    const logResult = await callTool(server, 'query_audit_log', { limit: 20 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const dlEntry = entries.find(e => e.phase === 'dead-letter');
    expect(dlEntry).toBeDefined();
    expect(dlEntry.correlationId).toBe(summary.correlationId);
    expect(dlEntry.correlationId).not.toBeNull();
  });

  it('precheck milestone number mismatch: dead-letter record carries the run correlationId (not null)', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_milestones(milestone-mismatch)',
      method: 'PATCH',
      payload: { msp_name: 'Renamed' },
      beforeState: { msp_name: 'Original' },
      description: 'Milestone update that triggers identity mismatch',
    });
    // identity must be set directly — queue.stage() does not accept it as a param
    op.identity = { milestoneNumber: 'MS-001' };
    // One failure away from dead-letter
    op.retryCount = MAX_RETRIES - 1;

    // Recheck returns ok but with a DIFFERENT milestone number — triggers the mismatch path
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { msp_milestonenumber: 'MS-999', msp_name: 'Some other milestone' },
    });

    const result = await callTool(server, 'execute_all', {});
    const summary = JSON.parse(result.content[0].text);
    expect(summary.correlationId).toMatch(/^batch_/);

    const logResult = await callTool(server, 'query_audit_log', { limit: 20 });
    const { entries } = JSON.parse(logResult.content[0].text);

    const dlEntry = entries.find(e => e.phase === 'dead-letter');
    expect(dlEntry).toBeDefined();
    expect(dlEntry.correlationId).toBe(summary.correlationId);
    expect(dlEntry.correlationId).not.toBeNull();
  });
});
