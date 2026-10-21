// Tests for audit capture — verify that execution outcomes are recorded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue } from '../approval-queue.js';
import { queryAuditLog } from '../audit-store.js';
import { captureAuditRecord, setCrmBase } from '../audit-capture.js';
import { mkdtempSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock CRM client
function mockCrmClient(responses = {}, authStatus = { userName: 'test@microsoft.com' }) {
  return {
    request: vi.fn(async (path, opts) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 204, data: {} };
    }),
    requestAllPages: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    search: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com'),
    authService: {
      getAuthStatus: vi.fn(() => authStatus),
    },
  };
}

// Call a registered tool
async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

describe('audit capture', () => {
  let server;
  let crm;
  let testDir;
  let originalEnv;

  beforeEach(() => {
    resetApprovalQueue();
    testDir = mkdtempSync(join(tmpdir(), 'audit-capture-test-'));
    originalEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = testDir;

    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'abc-123' } },
    });
    registerTools(server, crm);
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    if (originalEnv !== undefined) {
      process.env.MSX_USER_DATA = originalEnv;
    } else {
      delete process.env.MSX_USER_DATA;
    }
  });

  describe('single operation execution', () => {
    it('captures executed phase on success', async () => {
      // Stage an operation directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        beforeState: { stagecode: 861980000 },
        description: 'Update opportunity stage',
      });

      // Mock successful execution
      crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: {} });

      // Execute
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify audit record
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('executed');
      expect(audits.entries[0].operationId).toBe(op.id);
      expect(audits.entries[0].actor).toBe('test@microsoft.com');
      expect(audits.entries[0].result.ok).toBe(true);
      expect(audits.entries[0].error).toBeNull();
    });

    it('captures failed phase on CRM error', async () => {
      // Stage an operation directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        beforeState: { stagecode: 861980000 },
        description: 'Update opportunity stage',
      });

      // Mock CRM failure
      crm.request.mockResolvedValueOnce({
        ok: false,
        status: 500,
        message: 'Internal server error',
        data: { message: 'Internal server error' },
      });

      // Execute (will fail)
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify audit record
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('failed');
      expect(audits.entries[0].result.ok).toBe(false);
      expect(audits.entries[0].result.status).toBe(500);
      expect(audits.entries[0].error.message).toContain('Internal server error');
    });

    it('captures precheck-abort phase for milestone identity mismatch', async () => {
      // Stage a milestone update with identity
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_milestone',
        entitySet: 'msp_engagementmilestones(abc-123)',
        method: 'PATCH',
        payload: { msp_milestonedate: '2026-06-30' },
        beforeState: { msp_milestonedate: '2026-06-15' },
        description: 'Update milestone date',
      });
      op.identity = { milestoneNumber: '7-100000001' };

      // Mock pre-execution check with mismatch
      crm.request.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { msp_milestonenumber: '7-999999999' }, // Mismatch
      });

      // Execute (will abort)
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify audit record
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('precheck-abort');
      expect(audits.entries[0].error.message).toContain('identity mismatch');
    });

    it('captures precheck-abort phase when milestone no longer accessible', async () => {
      // Stage a milestone update with identity
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_milestone',
        entitySet: 'msp_engagementmilestones(abc-123)',
        method: 'PATCH',
        payload: { msp_milestonedate: '2026-06-30' },
        beforeState: { msp_milestonedate: '2026-06-15' },
        description: 'Update milestone date',
      });
      op.identity = { milestoneNumber: '7-100000001' };

      // Mock pre-execution check failure (404)
      crm.request.mockResolvedValueOnce({ ok: false, status: 404 });

      // Execute (will abort)
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify audit record
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('precheck-abort');
      expect(audits.entries[0].error.message).toContain('milestone no longer accessible');
    });
  });

  describe('batch execution', () => {
    it('captures one record per operation in batch', async () => {
      // Stage multiple operations directly
      const queue = getApprovalQueue();
      queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opp 1',
      });
      queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(22222222-2222-2222-2222-222222222222)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opp 2',
      });

      // Mock all successes
      crm.request.mockResolvedValue({ ok: true, status: 204, data: {} });

      // Execute all
      await callTool(server, 'execute_all');

      // Verify two audit records
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(2);
      expect(audits.entries.every(e => e.phase === 'executed')).toBe(true);
    });

    it('captures mixed success and failure in batch', async () => {
      // Stage two operations directly
      const queue = getApprovalQueue();
      queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opp 1',
      });
      queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(22222222-2222-2222-2222-222222222222)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opp 2',
      });

      // Mock: first succeeds, second fails
      crm.request
        .mockResolvedValueOnce({ ok: true, status: 204, data: {} })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          message: 'Bad request',
          data: { message: 'Bad request' },
        });

      // Execute all
      await callTool(server, 'execute_all');

      // Verify two audit records: one executed, one failed
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(2);
      const phases = audits.entries.map(e => e.phase).sort();
      expect(phases).toEqual(['executed', 'failed']);
    });

    it('captures batch exception path (catch block)', async () => {
      // Stage an operation directly
      const queue = getApprovalQueue();
      queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      // Mock: throw unexpected error
      crm.request.mockRejectedValueOnce(new Error('Network timeout'));

      // Execute all (exception caught in batch loop)
      await callTool(server, 'execute_all');

      // Verify audit record with phase=failed
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('failed');
      expect(audits.entries[0].error.message).toContain('Network timeout');
    });

    it('captures precheck-abort in batch', async () => {
      // Stage a milestone update with identity
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_milestone',
        entitySet: 'msp_engagementmilestones(abc-123)',
        method: 'PATCH',
        payload: { msp_milestonedate: '2026-06-30' },
        beforeState: { msp_milestonedate: '2026-06-15' },
        description: 'Update milestone date',
      });
      // Set identity after staging
      op.identity = { milestoneNumber: '7-100000001' };

      // Mock pre-execution check failure
      crm.request.mockResolvedValueOnce({ ok: false, status: 404 });

      // Execute all
      await callTool(server, 'execute_all');

      // Verify audit record
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('precheck-abort');
    });
  });

  describe('dead-letter capture', () => {
    it('captures dead-letter phase after MAX_RETRIES (deduplicated)', async () => {
      // Stage an operation directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      // Fail it 3 times (MAX_RETRIES)
      crm.request.mockResolvedValue({
        ok: false,
        status: 500,
        message: 'Server error',
        data: { message: 'Server error' },
      });

      for (let i = 0; i < 3; i++) {
        await callTool(server, 'execute_operation', { id: op.id });
      }

      // Verify: 2 failed (retry 1 & 2) + 1 dead-letter (retry 3) = 3 records total
      // The 3rd failure transitions to dead-letter, so only dead-letter record is written
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(3);
      const phases = audits.entries.map(e => e.phase);
      expect(phases.filter(p => p === 'failed').length).toBe(2); // First 2 retries
      expect(phases.filter(p => p === 'dead-letter').length).toBe(1); // Terminal retry
    });
  });

  describe('actor field', () => {
    it('captures actor from auth metadata', async () => {
      // Stage and execute directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: {} });
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify actor
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.entries[0].actor).toBe('test@microsoft.com');
    });

    it('handles missing auth metadata gracefully', async () => {
      // Rebuild with no auth
      server = new McpServer({ name: 'test', version: '0.0.1' });
      crm = mockCrmClient({ WhoAmI: { ok: true, status: 200, data: {} } }, null);
      resetApprovalQueue();
      registerTools(server, crm);

      // Stage and execute directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: {} });
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify actor is null
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.entries[0].actor).toBeNull();
    });
  });

  describe('execution safety', () => {
    it('execution succeeds even when audit dir is unwritable', async () => {
      // Make directory read-only (Windows: remove write permissions)
      try {
        chmodSync(testDir, 0o444);
      } catch {
        // Skip test if chmod fails (e.g., on Windows without admin)
        return;
      }

      // Stage and execute directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: {} });

      // Should not throw
      const result = await callTool(server, 'execute_operation', { id: op.id });
      const resultText = result.content[0].text;
      const parsed = JSON.parse(resultText);
      expect(parsed.success).toBe(true);

      // Restore permissions for cleanup
      try {
        chmodSync(testDir, 0o755);
      } catch {
        // Best-effort
      }
    });

    it('does not double-write on re-execution', async () => {
      // Stage an operation directly
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      // Execute successfully
      crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: {} });
      await callTool(server, 'execute_operation', { id: op.id });

      // Verify single record
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);

      // Try to execute again (should fail — already executed)
      const result = await callTool(server, 'execute_operation', { id: op.id });
      expect(result.content[0].text).toContain('not found');

      // Still only one audit record (no double-write)
      const audits2 = queryAuditLog({ dir: testDir });
      expect(audits2.total).toBe(1);
    });
  });

  describe('thrown exception capture (execute_operation)', () => {
    it('captures uncertain phase on POST network error and re-throws', async () => {
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'create_opportunity',
        entitySet: 'opportunities',
        method: 'POST',
        payload: { name: 'Test Opportunity' },
        description: 'Create opportunity',
      });

      // Mock network error (throw)
      crm.request.mockRejectedValueOnce(new Error('Network timeout'));

      // Execute (should throw)
      await expect(callTool(server, 'execute_operation', { id: op.id })).rejects.toThrow('Network timeout');

      // Verify audit record with phase=uncertain (POST may have succeeded)
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('uncertain');
      expect(audits.entries[0].error.message).toContain('Network timeout');
    });

    it('captures failed phase on PATCH network error and re-throws', async () => {
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { stagecode: 861980001 },
        description: 'Update opportunity',
      });

      // Mock network error (throw)
      crm.request.mockRejectedValueOnce(new Error('Connection refused'));

      // Execute (should throw)
      await expect(callTool(server, 'execute_operation', { id: op.id })).rejects.toThrow('Connection refused');

      // Verify audit record with phase=failed (PATCH did not succeed)
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].phase).toBe('failed');
      expect(audits.entries[0].error.message).toContain('Connection refused');
    });
  });

  describe('CREATE result ID capture', () => {
    it('captures result.id from various ID fields', async () => {
      const queue = getApprovalQueue();
      
      // Test with a simple operation that we can fully control
      const op = queue.stage({
        type: 'test_operation',
        entitySet: 'test_entities',
        method: 'POST',
        payload: { name: 'Test' },
        description: 'Test operation',
      });

      // Mock a successful response with opportunityId (like create_opportunity returns)
      crm.request.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { opportunityId: 'opp-123', name: 'Test Opportunity' }
      });

      await callTool(server, 'execute_operation', { id: op.id });

      // Verify audit record captured the ID
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      expect(audits.entries[0].result.id).toBe('opp-123');
    });

    it('captures milestoneId field variant', async () => {
      const queue = getApprovalQueue();
      
      const op = queue.stage({
        type: 'test_operation',
        entitySet: 'test_entities',
        method: 'POST',
        payload: { name: 'Test' },
        description: 'Test operation',
      });

      // Mock a successful response with milestoneId
      crm.request.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { milestoneId: 'mstone-789', msp_name: 'Test Milestone' }
      });

      await callTool(server, 'execute_operation', { id: op.id });

      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      // Result IDs are redacted to last 8 chars
      expect(audits.entries[0].result.id).toBe('…tone-789');
    });
  });

  describe('field detail capture', () => {
    it('captures beforeState, intendedAfter, recordId, and recordName', async () => {
      const queue = getApprovalQueue();
      const op = queue.stage({
        type: 'update_opportunity',
        entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
        method: 'PATCH',
        payload: { msp_solutionarea: 861980001, description: 'Updated description' },
        beforeState: { msp_solutionarea: 861980000, description: 'Original', name: 'Test Opportunity' },
        description: 'Update opportunity fields',
      });

      crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: {} });
      await callTool(server, 'execute_operation', { id: op.id });

      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBe(1);
      const entry = audits.entries[0];
      
      // Verify recordId extracted and redacted (last 8 chars with ellipsis prefix)
      expect(entry.recordId).toBe('…11111111');
      
      // Verify recordName from beforeState (not hashed since < 1000 chars)
      expect(entry.recordName).toBe('Test Opportunity');
      
      // Verify beforeState captured and redacted (GUIDs redacted)
      expect(entry.beforeState.msp_solutionarea).toBe(861980000);
      expect(entry.beforeState.description).toBe('Original');
      expect(entry.beforeState.name).toBe('Test Opportunity');
      
      // Verify intendedAfter (payload) captured
      expect(entry.intendedAfter.msp_solutionarea).toBe(861980001);
      expect(entry.intendedAfter.description).toBe('Updated description');
    });
  });

  describe('direct CRM write capture', () => {
    it('captures delete_opportunity LoseOpportunity action', async () => {
      // Mock WhoAmI for user check
      crm.request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { UserId: 'abc-123' }
        })
        // Mock validation opportunity lookup
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: {
            opportunityid: '11111111-1111-1111-1111-111111111111',
            name: 'Test Opportunity',
            statecode: 0,
            createdon: new Date().toISOString(),
            _ownerid_value: 'abc-123'
          }
        })
        // Mock LoseOpportunity success
        .mockResolvedValueOnce({ ok: true, status: 204, data: {} })
        // Mock verify
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { opportunityid: '11111111-1111-1111-1111-111111111111', name: 'Test Opportunity', statecode: 2 }
        });

      // Mock milestone query (none)
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });

      await callTool(server, 'delete_opportunity', { opportunityId: '11111111-1111-1111-1111-111111111111' });

      // Verify audit record captured the LoseOpportunity action
      const audits = queryAuditLog({ dir: testDir });
      expect(audits.total).toBeGreaterThanOrEqual(1);
      const deleteRecord = audits.entries.find(e => e.tool === 'delete_opportunity');
      expect(deleteRecord).toBeDefined();
      expect(deleteRecord.phase).toBe('executed');
      expect(deleteRecord.entitySet).toBe('LoseOpportunity');
      expect(deleteRecord.method).toBe('POST');
    });
  });
});

// ── Unit tests for audit-capture derivation helpers ──────────────────────────
// These test captureAuditRecord directly (not through tool execution).

describe('audit-capture: new structural fields', () => {
  it('derives entityType=opportunity from opportunities(...)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-UNIT-1',
      type: 'update_opportunity',
      entitySet: 'opportunities(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 1 },
      description: 'Update opportunity "Deal A" (Contoso) — stage',
      beforeState: { name: 'Deal A' },
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.total).toBe(1);
    const entry = audits.entries[0];
    expect(entry.entityType).toBe('opportunity');
    expect(entry.recordIdFull).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(entry.recordId).toBe('…eeeeeeee'); // last 8 chars redacted
    // Bug 9 fix: accountName is null when not explicitly set (no description parse)
    expect(entry.accountName).toBeNull();
    expect(entry.friendlyDescription).toContain('Deal A');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives entityType=milestone from msp_engagementmilestones(...)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-UNIT-2',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(11112222-3333-4444-5555-666677778888)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980001 },
      description: 'Update milestone 7-100 ("M1") on "Deal B": msp_milestonestatus',
      beforeState: { msp_name: 'M1' },
      identity: { opportunityName: 'Deal B', milestoneNumber: '7-100' },
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.total).toBe(1);
    const entry = audits.entries[0];
    expect(entry.entityType).toBe('milestone');
    expect(entry.recordIdFull).toBe('11112222-3333-4444-5555-666677778888');
    expect(entry.recordId).toBe('…77778888'); // redacted
    // Status 861980001 = "At Risk"; name comes from identity.opportunityName
    expect(entry.friendlyDescription).toBe('Marked milestone "Deal B" as At Risk');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds recordUrl when crmBase is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    setCrmBase('https://testorg.crm.dynamics.com');

    const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const op = {
      id: 'OP-UNIT-3',
      type: 'update_opportunity',
      entitySet: `opportunities(${guid})`,
      method: 'PATCH',
      payload: { stagecode: 1 },
      description: 'Update opportunity',
      beforeState: null,
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    const entry = audits.entries[0];
    expect(entry.recordUrl).toBe(
      `https://testorg.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=opportunity&id=${guid}`
    );

    setCrmBase(null);
    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('recordUrl is null when crmBase is not set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    setCrmBase(null);

    const op = {
      id: 'OP-UNIT-4',
      type: 'update_opportunity',
      entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
      method: 'PATCH',
      payload: {},
      description: 'Update',
      beforeState: null,
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].recordUrl).toBeNull();

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers op.accountName over description parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-UNIT-5',
      type: 'update_opportunity',
      entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
      method: 'PATCH',
      payload: {},
      description: 'Update opportunity "Deal" (Parsed From Desc)',
      accountName: 'Set On Op Directly',
      beforeState: null,
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].accountName).toBe('Set On Op Directly');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives entityType=task from CloseTask action endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-UNIT-6',
      type: 'close_task',
      entitySet: 'CloseTask',
      method: 'POST',
      payload: { TaskClose: { subject: 'done' }, Status: 5 },
      description: 'Close task',
      beforeState: null,
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].entityType).toBe('task');
    expect(audits.entries[0].recordIdFull).toBeNull(); // no GUID in CloseTask path
    expect(audits.entries[0].friendlyDescription).toContain('Closed task');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  // ── FIX 1: accountName must NOT capture quoted milestone names ────────────
  it('does NOT grab quoted milestone name as accountName (FIX 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    // This is the exact description format update_milestone generates.
    // Before the fix, ("Singapur - Infra") was grabbed as the account name.
    const op = {
      id: 'OP-FIX1',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(aaaaaaaa-0000-0000-0000-000000000001)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980003 },
      description: 'Update milestone 7-100 ("Singapur - Infra") on "OppName": msp_milestonestatus',
      beforeState: {},
      retryCount: 0,
      // accountName is NOT explicitly set — simulates a milestone op without a pre-set accountName
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    const entry = audits.entries[0];
    // accountName must be null, not "Singapur - Infra"
    expect(entry.accountName).toBeNull();

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses op.accountName (company name) when set on milestone op (FIX 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-FIX1B',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(aaaaaaaa-0000-0000-0000-000000000002)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980003 },
      description: 'Update milestone 7-100 ("Singapur - Infra") on "OppName": msp_milestonestatus',
      beforeState: {},
      accountName: 'GRUPO CATALANA OCCIDENTE TECNOLOGIA Y SERVICIOS AIE',
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    const entry = audits.entries[0];
    expect(entry.accountName).toBe('GRUPO CATALANA OCCIDENTE TECNOLOGIA Y SERVICIOS AIE');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  // ── FIX 2: recordName uses op.recordName / identity.milestoneName ─────────
  it('captures recordName from op.recordName for milestones (FIX 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-FIX2',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(aaaaaaaa-0000-0000-0000-000000000003)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980003 },
      description: 'Update milestone',
      beforeState: {},
      recordName: 'Singapur - Infra',
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].recordName).toBe('Singapur - Infra');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures recordName from identity.milestoneName as fallback (FIX 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-FIX2B',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(aaaaaaaa-0000-0000-0000-000000000004)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980003 },
      description: 'Update milestone',
      beforeState: {},
      identity: { milestoneNumber: '7-200', milestoneName: 'Atradius Prod' },
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].recordName).toBe('Atradius Prod');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  // ── FIX 3: rich friendlyDescription ──────────────────────────────────────
  it('friendlyDescription: milestone status change shows human label (FIX 3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-FIX3-STATUS',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(aaaaaaaa-0000-0000-0000-000000000005)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980003 },
      description: 'Update milestone',
      beforeState: {},
      recordName: 'Singapur - Infra',
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    // Must say "Completed" (861980003), not a raw code or generic "Update..."
    expect(audits.entries[0].friendlyDescription).toBe('Marked milestone "Singapur - Infra" as Completed');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('friendlyDescription: milestone forecast comment shows actual text (FIX 3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const commentText = 'Waiting for customer sign-off on capacity plan';
    const op = {
      id: 'OP-FIX3-COMMENT',
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(aaaaaaaa-0000-0000-0000-000000000006)',
      method: 'PATCH',
      payload: {
        msp_milestonecomments: commentText,
        msp_forecastcomments: `JPdR - 23/Jun - ${commentText}\nOld line`,
        msp_forecastcommentsjsonfield: JSON.stringify([
          { userId: 'Joaquin Perez del Real', modifiedOn: '2026-06-23T10:00:00Z', comment: commentText }
        ])
      },
      description: 'Update milestone',
      beforeState: {},
      recordName: 'Singapur - Infra',
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    const fd = audits.entries[0].friendlyDescription;
    expect(fd).toContain('Singapur - Infra');
    expect(fd).toContain(commentText);
    expect(fd).toMatch(/^Added forecast comment to milestone/);

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('friendlyDescription: close_msx_opportunity as Lost (Hygiene) (FIX 3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-FIX3-CLOSE',
      type: 'close_msx_opportunity',
      entitySet: 'opportunities(aaaaaaaa-0000-0000-0000-000000000007)',
      method: 'PATCH',
      payload: {},
      description: 'Close MSX opportunity',
      beforeState: {},
      recordName: '[SCI][Atradius] External ID',
      afterState: { statecode: 'Lost', closeReason: 'hygiene' },
      fieldSummary: { closeReason: 'hygiene' },
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].friendlyDescription)
      .toBe('Closed opportunity "[SCI][Atradius] External ID" as Lost (Hygiene)');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('friendlyDescription: change_owner shows new owner name (FIX 3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const op = {
      id: 'OP-FIX3-OWNER',
      type: 'change_owner',
      entitySet: 'opportunities(aaaaaaaa-0000-0000-0000-000000000008)',
      method: 'PATCH',
      payload: { 'ownerid@odata.bind': '/systemusers(new-owner-guid)' },
      description: 'Change owner',
      beforeState: {},
      recordName: '[SCI][Atradius] External ID',
      changeOwner: { newOwnerName: 'Maria Garcia', recordName: '[SCI][Atradius] External ID' },
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    expect(audits.entries[0].friendlyDescription)
      .toBe('Changed owner of opportunity "[SCI][Atradius] External ID" to "Maria Garcia"');

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('friendlyDescription: forecast comment on opportunity shows text (FIX 3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cap-unit-'));
    const savedEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = dir;

    const comment = 'Customer confirmed Q3 delivery target';
    const op = {
      id: 'OP-FIX3-OPPCOMMENT',
      type: 'update_opportunity',
      entitySet: 'opportunities(aaaaaaaa-0000-0000-0000-000000000009)',
      method: 'PATCH',
      payload: {
        msp_forecastcomments: `JPdR - 23/Jun - ${comment}`,
        msp_forecastcommentsjsonfield: JSON.stringify([
          { userId: 'Joaquin Perez del Real', modifiedOn: '2026-06-23T10:00:00Z', comment }
        ])
      },
      description: 'Update opportunity',
      beforeState: {},
      recordName: '[SCI][Atradius] External ID',
      retryCount: 0,
    };

    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

    const audits = queryAuditLog({ dir });
    const fd = audits.entries[0].friendlyDescription;
    expect(fd).toMatch(/^Added forecast comment to opportunity/);
    expect(fd).toContain('[SCI][Atradius] External ID');
    expect(fd).toContain(comment);

    process.env.MSX_USER_DATA = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('Bug 9: Customer resolution (never pronouns)', () => {
    it('uses authoritative op.accountName when set, ignoring description tokens', () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-bug9-'));
      const savedEnv = process.env.MSX_USER_DATA;
      process.env.MSX_USER_DATA = dir;

      const op = {
        id: 'OP-BUG9-1',
        type: 'change_owner',
        entitySet: 'opportunities(22222222-2222-2222-2222-222222222222)',
        method: 'PATCH',
        payload: { 'ownerid@odata.bind': '/systemusers(33333333-3333-3333-3333-333333333333)' },
        accountName: 'Contoso Corporation',  // Authoritative account
        description: 'Change owner for opportunity "Test Opp" from John Doe (He/Him) to Jane Smith (She/Her)',
        recordName: 'Test Opp',
        beforeState: { owner: 'John Doe (He/Him)' },
        afterState: { owner: 'Jane Smith (She/Her)' },
      };

      captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

      const audits = queryAuditLog({ dir });
      expect(audits.entries).toHaveLength(1);
      expect(audits.entries[0].accountName).toBe('Contoso Corporation');
      expect(audits.entries[0].accountName).not.toContain('He/Him');
      expect(audits.entries[0].accountName).not.toContain('She/Her');

      process.env.MSX_USER_DATA = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns null accountName when not set (no description parse)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-bug9-null-'));
      const savedEnv = process.env.MSX_USER_DATA;
      process.env.MSX_USER_DATA = dir;

      const op = {
        id: 'OP-BUG9-2',
        type: 'change_owner',
        entitySet: 'opportunities(44444444-4444-4444-4444-444444444444)',
        method: 'PATCH',
        payload: { 'ownerid@odata.bind': '/systemusers(55555555-5555-5555-5555-555555555555)' },
        accountName: null,  // No account available
        description: 'Change owner for opportunity "Test Opp" from Alex (They/Them) to Sam',
        recordName: 'Test Opp',
        beforeState: { owner: 'Alex (They/Them)' },
        afterState: { owner: 'Sam' },
      };

      captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

      const audits = queryAuditLog({ dir });
      expect(audits.entries).toHaveLength(1);
      expect(audits.entries[0].accountName).toBeNull();
      expect(audits.entries[0].accountName).not.toBe('They/Them');

      process.env.MSX_USER_DATA = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    });

    it('milestone operations use parent opportunity account (not pronoun)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-bug9-milestone-'));
      const savedEnv = process.env.MSX_USER_DATA;
      process.env.MSX_USER_DATA = dir;

      const op = {
        id: 'OP-BUG9-3',
        type: 'update_milestone',
        entitySet: 'msp_engagementmilestones(66666666-6666-6666-6666-666666666666)',
        method: 'PATCH',
        payload: { msp_milestonestatus: 861980001 },
        accountName: 'Fabrikam Inc',  // Authoritative parent account
        description: 'Update milestone "Deploy Phase 1" (owned by Chris Lee (He/Him))',
        recordName: 'Deploy Phase 1',
        beforeState: { msp_milestonestatus: 861980000 },
      };

      captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

      const audits = queryAuditLog({ dir });
      expect(audits.entries).toHaveLength(1);
      expect(audits.entries[0].accountName).toBe('Fabrikam Inc');
      expect(audits.entries[0].accountName).not.toContain('He/Him');

      process.env.MSX_USER_DATA = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('Bug 10: Created records link with name and CRM URL', () => {
    it('create_opportunity: captures recordId, recordName, recordUrl when explicitly set', () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-bug10-opp-'));
      const savedEnv = process.env.MSX_USER_DATA;
      process.env.MSX_USER_DATA = dir;
      setCrmBase('https://test.crm.dynamics.com');

      const op = {
        id: 'OP-BUG10-1',
        type: 'create_opportunity',
        entitySet: 'opportunities',  // No GUID at stage time
        method: 'POST',
        payload: { create: { name: 'New Big Deal' } },
        // Bug 10 fix: These are set by executeCreateOpportunity after CRM returns the new ID
        recordId: '77777777-7777-7777-7777-777777777777',
        recordName: 'New Big Deal',
        recordUrl: 'https://test.crm.dynamics.com/main.aspx?etn=opportunity&id=77777777-7777-7777-7777-777777777777&pagetype=entityrecord',
        accountName: 'Adventure Works',
        beforeState: null,
      };

      captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 200 } });

      const audits = queryAuditLog({ dir });
      expect(audits.entries).toHaveLength(1);
      const entry = audits.entries[0];
      expect(entry.recordId).toContain('…77777777'); // redacted
      expect(entry.recordName).toBe('New Big Deal');
      expect(entry.recordUrl).toContain('77777777-7777-7777-7777-777777777777');
      expect(entry.recordUrl).toContain('opportunity');

      process.env.MSX_USER_DATA = savedEnv;
      setCrmBase(null);
      rmSync(dir, { recursive: true, force: true });
    });

    it('create_milestone: captures recordId, recordName, recordUrl when explicitly set', () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-bug10-ms-'));
      const savedEnv = process.env.MSX_USER_DATA;
      process.env.MSX_USER_DATA = dir;
      setCrmBase('https://test.crm.dynamics.com');

      const op = {
        id: 'OP-BUG10-2',
        type: 'create_milestone',
        entitySet: 'msp_engagementmilestones',  // No GUID at stage time
        method: 'POST',
        payload: { create: { msp_name: 'Phase 2 Deployment' } },
        // Bug 10 fix: These are set by executeCreateMilestone after CRM returns the new ID
        recordId: '88888888-8888-8888-8888-888888888888',
        recordName: 'Phase 2 Deployment',
        recordUrl: 'https://test.crm.dynamics.com/main.aspx?etn=msp_engagementmilestone&id=88888888-8888-8888-8888-888888888888&pagetype=entityrecord',
        accountName: 'Northwind Traders',
        beforeState: null,
      };

      captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 200 } });

      const audits = queryAuditLog({ dir });
      expect(audits.entries).toHaveLength(1);
      const entry = audits.entries[0];
      expect(entry.recordId).toContain('…88888888'); // redacted
      expect(entry.recordName).toBe('Phase 2 Deployment');
      expect(entry.recordUrl).toContain('88888888-8888-8888-8888-888888888888');
      expect(entry.recordUrl).toContain('msp_engagementmilestone');

      process.env.MSX_USER_DATA = savedEnv;
      setCrmBase(null);
      rmSync(dir, { recursive: true, force: true });
    });

    it('create without explicit fields falls back to entitySet derivation (legacy path)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-bug10-fallback-'));
      const savedEnv = process.env.MSX_USER_DATA;
      process.env.MSX_USER_DATA = dir;
      setCrmBase('https://test.crm.dynamics.com');

      const op = {
        id: 'OP-BUG10-3',
        type: 'update_opportunity',
        entitySet: 'opportunities(99999999-9999-9999-9999-999999999999)',  // GUID in entitySet
        method: 'PATCH',
        payload: { stagecode: 1 },
        // No explicit recordId/recordName/recordUrl (old path — still works)
        accountName: 'Tailspin Toys',
        beforeState: { stagecode: 0 },
      };

      captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });

      const audits = queryAuditLog({ dir });
      expect(audits.entries).toHaveLength(1);
      const entry = audits.entries[0];
      // Falls back to entitySet derivation
      expect(entry.recordId).toContain('…99999999');
      expect(entry.recordUrl).toContain('99999999-9999-9999-9999-999999999999');

      process.env.MSX_USER_DATA = savedEnv;
      setCrmBase(null);
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

describe('owner reassignment — intended-after reconciliation (P0-2)', () => {
  let testDir;
  let originalEnv;

  beforeEach(() => {
    resetApprovalQueue();
    testDir = mkdtempSync(join(tmpdir(), 'audit-owner-test-'));
    originalEnv = process.env.MSX_USER_DATA;
    process.env.MSX_USER_DATA = testDir;
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (originalEnv !== undefined) process.env.MSX_USER_DATA = originalEnv;
    else delete process.env.MSX_USER_DATA;
  });

  // Both change_owner and reassign_opportunity stage the same shape:
  //   payload:    { 'ownerid@odata.bind': '/systemusers(<guid>)' }
  //   beforeState:{ owner: <old name> }   afterState:{ owner: <new name> }
  function ownerOp(type) {
    return {
      id: `op-${type}`,
      type,
      entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
      method: 'PATCH',
      payload: { 'ownerid@odata.bind': '/systemusers(22222222-2222-2222-2222-222222222222)' },
      beforeState: { owner: 'Jane Doe' },
      afterState: { owner: 'John Roe' },
      description: 'Change owner from Jane Doe to John Roe',
    };
  }

  it('stores a single friendly { owner } field, not the raw @odata.bind, for change_owner', () => {
    captureAuditRecord(ownerOp('change_owner'), { phase: 'executed', result: { ok: true, status: 204 } });
    const rec = queryAuditLog({ dir: testDir }).entries[0];
    expect(rec.intendedAfter).toEqual({ owner: 'John Roe' });
    expect('ownerid@odata.bind' in rec.intendedAfter).toBe(false);
    // before/after now key on the SAME field → one "modified" row, no false removal.
    expect(Object.keys(rec.beforeState)).toEqual(['owner']);
  });

  it('applies the same reconciliation to reassign_opportunity (type "update")', () => {
    captureAuditRecord(ownerOp('update'), { phase: 'executed', result: { ok: true, status: 204 } });
    const rec = queryAuditLog({ dir: testDir }).entries[0];
    expect(rec.intendedAfter).toEqual({ owner: 'John Roe' });
  });

  it('leaves a non-owner payload verbatim (no accidental remap)', () => {
    const op = {
      id: 'op-stage',
      type: 'update',
      entitySet: 'opportunities(11111111-1111-1111-1111-111111111111)',
      method: 'PATCH',
      payload: { stagecode: 861980001 },
      beforeState: { stagecode: 861980000 },
      description: 'Update stage',
    };
    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });
    const rec = queryAuditLog({ dir: testDir }).entries[0];
    expect(rec.intendedAfter).toEqual({ stagecode: 861980001 });
  });

  it('keeps the raw payload when afterState.owner is absent (never fabricates a name)', () => {
    const op = ownerOp('change_owner');
    delete op.afterState;
    captureAuditRecord(op, { phase: 'executed', result: { ok: true, status: 204 } });
    const rec = queryAuditLog({ dir: testDir }).entries[0];
    expect('ownerid@odata.bind' in rec.intendedAfter).toBe(true);
  });
});