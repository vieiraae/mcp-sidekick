import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalQueue, resetApprovalQueue } from '../approval-queue.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

describe('ApprovalQueue', () => {
  let queue;
  let testDir;

  beforeEach(() => {
    resetApprovalQueue();
    testDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    queue = new ApprovalQueue({ ttlMs: 5000, dataDir: testDir });
  });

  afterEach(() => {
    queue.dispose();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function sampleOp(overrides = {}) {
    return {
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(abc-123)',
      method: 'PATCH',
      payload: { msp_milestonedate: '2026-04-15' },
      beforeState: { msp_milestonedate: '2026-03-20' },
      description: 'Update milestone date',
      ...overrides,
    };
  }

  describe('stage', () => {
    it('assigns sequential IDs', () => {
      const op1 = queue.stage(sampleOp());
      const op2 = queue.stage(sampleOp());
      expect(op1.id).toBe('OP-1');
      expect(op2.id).toBe('OP-2');
    });

    it('sets status to pending', () => {
      const op = queue.stage(sampleOp());
      expect(op.status).toBe('pending');
    });

    it('emits staged event', () => {
      const handler = vi.fn();
      queue.on('staged', handler);
      const op = queue.stage(sampleOp());
      expect(handler).toHaveBeenCalledWith(op);
    });

    it('stores all provided fields', () => {
      const input = sampleOp();
      const op = queue.stage(input);
      expect(op.type).toBe(input.type);
      expect(op.entitySet).toBe(input.entitySet);
      expect(op.method).toBe(input.method);
      expect(op.payload).toEqual(input.payload);
      expect(op.beforeState).toEqual(input.beforeState);
      expect(op.description).toBe(input.description);
      expect(op.stagedAt).toBeTruthy();
      expect(op.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('approve', () => {
    it('approves a pending op', () => {
      const op = queue.stage(sampleOp());
      const approved = queue.approve(op.id);
      expect(approved).not.toBeNull();
      expect(approved.status).toBe('approved');
    });

    it('emits approved event', () => {
      const handler = vi.fn();
      queue.on('approved', handler);
      const op = queue.stage(sampleOp());
      queue.approve(op.id);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: op.id, status: 'approved' }));
    });

    it('returns null for non-existent ID', () => {
      expect(queue.approve('OP-999')).toBeNull();
    });

    it('returns null for already approved op', () => {
      const op = queue.stage(sampleOp());
      queue.approve(op.id);
      expect(queue.approve(op.id)).toBeNull();
    });
  });

  describe('reject', () => {
    it('rejects a pending op', () => {
      const op = queue.stage(sampleOp());
      const rejected = queue.reject(op.id);
      expect(rejected).not.toBeNull();
      expect(rejected.status).toBe('rejected');
    });

    it('emits rejected event', () => {
      const handler = vi.fn();
      queue.on('rejected', handler);
      const op = queue.stage(sampleOp());
      queue.reject(op.id);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: op.id }));
    });

    it('removes the op from the queue', () => {
      const op = queue.stage(sampleOp());
      queue.reject(op.id);
      expect(queue.get(op.id)).toBeNull();
    });

    it('returns null for non-existent ID', () => {
      expect(queue.reject('OP-999')).toBeNull();
    });
  });

  describe('markExecuted', () => {
    it('marks an approved op as executed', () => {
      const op = queue.stage(sampleOp());
      queue.approve(op.id);
      const executed = queue.markExecuted(op.id, { success: true });
      expect(executed.status).toBe('executed');
    });

    it('emits executed event with result', () => {
      const handler = vi.fn();
      queue.on('executed', handler);
      const op = queue.stage(sampleOp());
      queue.approve(op.id);
      queue.markExecuted(op.id, { data: 'ok' });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: op.id }),
        { data: 'ok' }
      );
    });

    it('removes the op from the queue', () => {
      const op = queue.stage(sampleOp());
      queue.approve(op.id);
      queue.markExecuted(op.id, {});
      expect(queue.get(op.id)).toBeNull();
    });
  });

  describe('markFailed', () => {
    it('resets op to pending for retry', () => {
      const op = queue.stage(sampleOp());
      queue.approve(op.id);
      queue.markFailed(op.id, 'CRM unavailable');
      const retrieved = queue.get(op.id);
      expect(retrieved.status).toBe('pending');
    });

    it('emits error event', () => {
      const handler = vi.fn();
      queue.on('op:error', handler);
      const op = queue.stage(sampleOp());
      queue.markFailed(op.id, 'fail');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: op.id }),
        'fail'
      );
    });
  });

  describe('listPending', () => {
    it('returns only pending ops', () => {
      queue.stage(sampleOp());
      queue.stage(sampleOp());
      const op3 = queue.stage(sampleOp());
      queue.approve(op3.id);
      expect(queue.listPending()).toHaveLength(2);
    });
  });

  describe('approveAll / rejectAll', () => {
    it('approves all pending ops', () => {
      queue.stage(sampleOp());
      queue.stage(sampleOp());
      queue.stage(sampleOp());
      const approved = queue.approveAll();
      expect(approved).toHaveLength(3);
      expect(queue.listPending()).toHaveLength(0);
    });

    it('rejects all pending ops', () => {
      queue.stage(sampleOp());
      queue.stage(sampleOp());
      const rejected = queue.rejectAll();
      expect(rejected).toHaveLength(2);
      expect(queue.listPending()).toHaveLength(0);
    });
  });

  describe('dependent ops (dependsOn)', () => {
    const parentOp = () => sampleOp({ type: 'create_opportunity', entitySet: 'opportunities', method: 'POST', payload: { create: { name: 'New opp' } }, beforeState: null });
    const childOp = (parentId, name = 'MS 1') => sampleOp({ type: 'create_milestone', entitySet: 'msp_engagementmilestones', method: 'POST', payload: { opportunityId: null, create: { msp_name: name } }, beforeState: null, dependsOn: parentId });

    it('records what an op waits for, and is null otherwise', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      expect(parent.dependsOn).toBeNull();
      expect(child.dependsOn).toBe(parent.id);
      expect(queue.listDependents(parent.id).map(op => op.id)).toEqual([child.id]);
    });

    it('refuses to stage after an op that is not pending', () => {
      expect(() => queue.stage(childOp('OP-999'))).toThrow(/not a pending operation/);
      const parent = queue.stage(parentOp());
      queue.approve(parent.id);
      expect(() => queue.stage(childOp(parent.id))).toThrow(/not a pending operation/);
    });

    it('cannot be approved while it is still waiting', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      expect(queue.approve(child.id)).toBeNull();
      expect(queue.get(child.id).status).toBe('pending');
    });

    it('does not time out on its own while what it waits for is still queued', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      child.expiresAt = Date.now() - 1;
      expect(queue.get(child.id)).not.toBeNull();
      expect(queue.listPending().map(op => op.id)).toEqual([parent.id, child.id]);
    });

    it('expires with the op it waits for — in the same sweep', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      const expired = vi.fn();
      queue.on('expired', expired);
      parent.expiresAt = Date.now() - 1;
      expect(queue.listPending()).toHaveLength(0);
      expect(expired.mock.calls.map(([op]) => op.id)).toEqual([parent.id, child.id]);
    });

    it('expires once what it waits for leaves the queue without releasing it', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      queue.approve(parent.id);
      queue.markExecuted(parent.id, { ok: true });
      expect(queue.listPending()).toHaveLength(0);
      expect(queue.get(child.id)).toBeNull();
    });

    it('rejecting an op also rejects the ops waiting for it', () => {
      const parent = queue.stage(parentOp());
      const child1 = queue.stage(childOp(parent.id, 'MS 1'));
      const other = queue.stage(sampleOp());
      const child2 = queue.stage(childOp(parent.id, 'MS 2'));
      const rejectedEvents = vi.fn();
      queue.on('rejected', rejectedEvents);
      const rejected = queue.rejectWithDependents(parent.id);
      expect(rejected.map(op => op.id)).toEqual([parent.id, child1.id, child2.id]);
      expect(rejectedEvents).toHaveBeenCalledTimes(3);
      expect(queue.listPending().map(op => op.id)).toEqual([other.id]);
    });

    it('reject() keeps returning just the op it was asked to reject', () => {
      const parent = queue.stage(parentOp());
      queue.stage(childOp(parent.id));
      expect(queue.reject(parent.id).id).toBe(parent.id);
      expect(queue.listPending()).toHaveLength(0);
    });

    it('rejecting a dependent leaves the op it waits for alone', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      expect(queue.rejectWithDependents(child.id).map(op => op.id)).toEqual([child.id]);
      expect(queue.listPending().map(op => op.id)).toEqual([parent.id]);
    });

    it('rejectAll lists each cascaded op exactly once', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      const other = queue.stage(sampleOp());
      expect(queue.rejectAll().map(op => op.id)).toEqual([parent.id, child.id, other.id]);
      expect(queue.listPending()).toHaveLength(0);
    });

    it('releaseDependents fills each waiting op in and lets it run', () => {
      const parent = queue.stage(parentOp());
      const child1 = queue.stage(childOp(parent.id, 'MS 1'));
      const child2 = queue.stage(childOp(parent.id, 'MS 2'));
      const unrelatedParent = queue.stage(parentOp());
      const unrelatedChild = queue.stage(childOp(unrelatedParent.id));
      child1.expiresAt = Date.now() - 1;

      const released = queue.releaseDependents(parent.id, (op) => { op.payload.opportunityId = 'new-opp-id'; });

      expect(released.map(op => op.id)).toEqual([child1.id, child2.id]);
      for (const op of released) {
        expect(op.dependsOn).toBeNull();
        expect(op.resolvedFrom).toBe(parent.id);
        expect(op.payload.opportunityId).toBe('new-opp-id');
        expect(op.expiresAt).toBeGreaterThan(Date.now());
      }
      expect(queue.listDependents(parent.id)).toEqual([]);
      expect(queue.approve(child1.id)?.status).toBe('approved');
      expect(unrelatedChild.dependsOn).toBe(unrelatedParent.id);
    });

    it('a dead-lettered op parks its dependents: back with it on retry, expired once it is cleared', () => {
      const parent = queue.stage(parentOp());
      const child = queue.stage(childOp(parent.id));
      const other = queue.stage(sampleOp());
      for (let i = 0; i < 3; i += 1) queue.markFailed(parent.id, 'boom', 500);
      expect(queue.get(parent.id).status).toBe('failed');
      // Parked: it can't run, so PLAY never reports it as skipped again, and cancel-all leaves it.
      expect(queue.listPending().map(op => op.id)).toEqual([other.id]);
      expect(queue.pendingCount).toBe(1);
      expect(queue.rejectAll().map(op => op.id)).toEqual([other.id]);
      expect(queue.get(child.id)?.status).toBe('pending');

      queue.retryFromDeadLetter(parent.id);
      expect(queue.listPending().map(op => op.id)).toEqual([parent.id, child.id]);

      for (let i = 0; i < 3; i += 1) queue.markFailed(parent.id, 'boom', 500);
      queue.clearDeadLetter(parent.id);
      expect(queue.listPending()).toHaveLength(0);
      expect(queue.get(child.id)).toBeNull();
    });

    it('survives a restart', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        const parent = queue1.stage(parentOp());
        const child = queue1.stage(childOp(parent.id));
        queue1.dispose();

        const queue2 = new ApprovalQueue({ dataDir: tempDir });
        expect(queue2.get(child.id).dependsOn).toBe(parent.id);
        expect(queue2.listDependents(parent.id).map(op => op.id)).toEqual([child.id]);
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('TTL expiry', () => {
    it('expires operations past TTL on get()', () => {
      const shortTestDir = mkdtempSync(join(tmpdir(), 'queue-ttl-test-'));
      const shortQueue = new ApprovalQueue({ ttlMs: 1, dataDir: shortTestDir });
      const op = shortQueue.stage(sampleOp());

      // Wait just enough for expiry
      return new Promise(resolve => {
        setTimeout(() => {
          const handler = vi.fn();
          shortQueue.on('expired', handler);
          const result = shortQueue.get(op.id);
          expect(result).toBeNull();
          expect(handler).toHaveBeenCalled();
          shortQueue.dispose();
          rmSync(shortTestDir, { recursive: true, force: true });
          resolve();
        }, 10);
      });
    });

    it('returns null when approving an expired op', () => {
      const shortTestDir = mkdtempSync(join(tmpdir(), 'queue-ttl-test-'));
      const shortQueue = new ApprovalQueue({ ttlMs: 1, dataDir: shortTestDir });
      const op = shortQueue.stage(sampleOp());

      return new Promise(resolve => {
        setTimeout(() => {
          const result = shortQueue.approve(op.id);
          expect(result).toBeNull();
          shortQueue.dispose();
          rmSync(shortTestDir, { recursive: true, force: true });
          resolve();
        }, 10);
      });
    });
  });

  describe('pendingCount', () => {
    it('returns the number of pending ops', () => {
      expect(queue.pendingCount).toBe(0);
      queue.stage(sampleOp());
      queue.stage(sampleOp());
      expect(queue.pendingCount).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all operations', () => {
      queue.stage(sampleOp());
      queue.stage(sampleOp());
      queue.clear();
      expect(queue.listAll()).toHaveLength(0);
    });
  });

  describe('persistence (Phase 2.2)', () => {
    it('survives rehydration after restart', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        // Create queue, stage ops
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        const op1 = queue1.stage(sampleOp({ description: 'First op' }));
        const op2 = queue1.stage(sampleOp({ description: 'Second op', actor: 'alice@example.com' }));
        queue1.approve(op2.id);
        queue1.dispose();

        // Simulate restart: new instance rehydrates
        const queue2 = new ApprovalQueue({ dataDir: tempDir });
        const pending = queue2.listPending({});
        expect(pending).toHaveLength(1);
        expect(pending[0].id).toBe(op1.id);
        expect(pending[0].description).toBe('First op');

        const approved = queue2.get(op2.id);
        expect(approved).not.toBeNull();
        expect(approved.status).toBe('approved');
        expect(approved.actor).toBe('alice@example.com');
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('counter continues without ID collision', () => {
      resetApprovalQueue(); // Reset global counter for isolation
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        queue1.stage(sampleOp());
        queue1.stage(sampleOp());
        queue1.dispose();

        resetApprovalQueue(); // Reset global counter to simulate fresh start
        const queue2 = new ApprovalQueue({ dataDir: tempDir });
        const op3 = queue2.stage(sampleOp());
        expect(op3.id).toBe('OP-3');
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rehydrates dead-letter queue', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        const op = queue1.stage(sampleOp());
        queue1.approve(op.id);
        queue1.markFailed(op.id, 'fail1');
        queue1.markFailed(op.id, 'fail2');
        queue1.markFailed(op.id, 'fail3'); // exhausts retries
        queue1.dispose();

        const queue2 = new ApprovalQueue({ dataDir: tempDir });
        const dlq = queue2.getDeadLetterQueue();
        expect(dlq).toHaveLength(1);
        expect(dlq[0].id).toBe(op.id);
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('survives abrupt respawn without dispose() (sync durability)', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        // Stage an op
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        const op = queue1.stage(sampleOp({ description: 'Durability test' }));
        
        // Immediately create new instance WITHOUT calling dispose() or waiting
        // This simulates an abrupt MCP respawn
        const queue2 = new ApprovalQueue({ dataDir: tempDir });
        const rehydrated = queue2.get(op.id);
        
        expect(rehydrated).not.toBeNull();
        expect(rehydrated.id).toBe(op.id);
        expect(rehydrated.description).toBe('Durability test');
        expect(rehydrated.status).toBe('pending');
        
        queue1.dispose();
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('scoped operations (Phase 2.2)', () => {
    it('stores actor and sessionId fields', () => {
      const op = queue.stage(sampleOp({ actor: 'bob@example.com', sessionId: 'sess-123' }));
      expect(op.actor).toBe('bob@example.com');
      expect(op.sessionId).toBe('sess-123');
    });

    it('stores correlationId field', () => {
      const op = queue.stage(sampleOp({ correlationId: 'batch-456' }));
      expect(op.correlationId).toBe('batch-456');
    });

    it('persists and rehydrates correlationId', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        const op = queue1.stage(sampleOp({ correlationId: 'batch-789', description: 'Batch op' }));
        queue1.dispose();

        const queue2 = new ApprovalQueue({ dataDir: tempDir });
        const rehydrated = queue2.get(op.id);
        expect(rehydrated).not.toBeNull();
        expect(rehydrated.correlationId).toBe('batch-789');
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('filters by actor', () => {
      queue.stage(sampleOp({ actor: 'alice@example.com' }));
      queue.stage(sampleOp({ actor: 'bob@example.com' }));
      queue.stage(sampleOp({ actor: 'alice@example.com' }));

      const aliceOps = queue.listPending({ actor: 'alice@example.com' });
      expect(aliceOps).toHaveLength(2);
      aliceOps.forEach(op => expect(op.actor).toBe('alice@example.com'));
    });

    it('filters by sessionId', () => {
      queue.stage(sampleOp({ sessionId: 'sess-1' }));
      queue.stage(sampleOp({ sessionId: 'sess-2' }));
      queue.stage(sampleOp({ sessionId: 'sess-1' }));

      const sess1Ops = queue.listPending({ sessionId: 'sess-1' });
      expect(sess1Ops).toHaveLength(2);
      sess1Ops.forEach(op => expect(op.sessionId).toBe('sess-1'));
    });
  });

  describe('real TTL (Phase 2.3)', () => {
    it('setTtl(null) disables expiry for new ops', () => {
      queue.setTtl(null);
      const op = queue.stage(sampleOp());
      expect(op.expiresAt).toBeNull();
    });

    it('setNoExpiry(true) disables expiry', () => {
      queue.setNoExpiry(true);
      const op = queue.stage(sampleOp());
      expect(op.expiresAt).toBeNull();
      expect(queue.noExpiry).toBe(true);
    });

    it('noExpiry ops do not expire during sweep', () => {
      const shortTestDir = mkdtempSync(join(tmpdir(), 'queue-ttl-test-'));
      const shortQueue = new ApprovalQueue({ ttlMs: 1, dataDir: shortTestDir });
      shortQueue.setNoExpiry(true);
      const op = shortQueue.stage(sampleOp());

      return new Promise(resolve => {
        setTimeout(() => {
          const retrieved = shortQueue.get(op.id);
          expect(retrieved).not.toBeNull();
          expect(retrieved.status).toBe('pending');
          shortQueue.dispose();
          rmSync(shortTestDir, { recursive: true, force: true });
          resolve();
        }, 10);
      });
    });

    it('rehydrated ops with expiresAt=null do not expire', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      try {
        const queue1 = new ApprovalQueue({ dataDir: tempDir });
        queue1.setNoExpiry(true);
        queue1.stage(sampleOp());
        queue1.dispose();

        // Wait and rehydrate
        const queue2 = new ApprovalQueue({ dataDir: tempDir, ttlMs: 1 });
        const pending = queue2.listPending({});
        expect(pending).toHaveLength(1);
        expect(pending[0].expiresAt).toBeNull();
        queue2.dispose();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('janitor removes genuinely old ops (7+ days)', () => {
      const oldOp = queue.stage(sampleOp());
      // Manually set stagedAt to 8 days ago
      oldOp.stagedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      oldOp.expiresAt = null; // even with no expiry

      // Manually sweep
      queue.listPending({});
      expect(queue.get(oldOp.id)).toBeNull();
    });

    it('does not write to ~/.msx-iq-data during test', () => {
      // This test ensures test isolation — all tests should use temp dirs
      const homeDataDir = join(homedir(), '.msx-iq-data', 'approval-queue.json');
      const existsBefore = existsSync(homeDataDir);
      
      // Run some operations
      const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      const testQueue = new ApprovalQueue({ dataDir: tempDir });
      testQueue.stage(sampleOp());
      testQueue.dispose();
      rmSync(tempDir, { recursive: true, force: true });
      
      const existsAfter = existsSync(homeDataDir);
      
      // If it didn't exist before, it shouldn't exist after
      if (!existsBefore) {
        expect(existsAfter).toBe(false);
      }
    });
  });
});

// Phase 2.4 second ring — B4: markStaleConflict must persist synchronously
describe('Phase 2.4 B4: markStaleConflict synchronous persist', () => {
  let testDir;
  let queue;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'queue-b4-test-'));
    queue = new ApprovalQueue({ dataDir: testDir });
  });

  afterEach(() => {
    queue.dispose();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it('immediately writes stale-conflict status to disk after markStaleConflict', () => {
    const op = queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(abc-123)',
      method: 'PATCH',
      payload: { msp_milestonedate: '2026-04-15' },
      beforeState: { msp_milestonedate: '2026-03-20' },
      description: 'Update milestone date',
      etag: 'W/"pre-conflict-etag"'
    });

    // Status is pending on disk before markStaleConflict
    const beforeFile = join(testDir, 'approval-queue.json');
    const beforeState = JSON.parse(readFileSync(beforeFile, 'utf8'));
    const beforeOp = beforeState.ops.find(o => o.id === op.id);
    expect(beforeOp.status).toBe('pending');

    queue.markStaleConflict(op.id);

    // Verify immediate disk write — no async wait needed
    const afterState = JSON.parse(readFileSync(beforeFile, 'utf8'));
    const afterOp = afterState.ops.find(o => o.id === op.id);
    expect(afterOp).toBeDefined();
    expect(afterOp.status).toBe('stale-conflict');
  });

  it('markStaleConflict status survives a rehydration cycle', () => {
    const op = queue.stage({
      type: 'update_milestone',
      entitySet: 'msp_engagementmilestones(xyz-456)',
      method: 'PATCH',
      payload: { msp_milestonestatus: 861980001 },
      beforeState: {},
      description: 'Rehydration test',
      etag: 'W/"rehydrate-etag"'
    });

    queue.markStaleConflict(op.id);
    queue.dispose();

    // Rehydrate from disk
    const queue2 = new ApprovalQueue({ dataDir: testDir });
    const reloaded = queue2.get(op.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded.status).toBe('stale-conflict');
    queue2.dispose();
  });
});

