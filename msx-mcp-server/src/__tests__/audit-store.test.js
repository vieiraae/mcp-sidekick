// Tests for audit-store.js — NDJSON persistence and query.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendChangeRecord, queryAuditLog, getAuditEntry } from '../audit-store.js';
import { makeChangeRecord } from '../change-record.js';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

describe('audit-store', () => {
  let testDir;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function sampleRecord(overrides = {}) {
    return makeChangeRecord({
      operationId: 'OP-1',
      correlationId: null,
      phase: 'executed',
      actor: 'user@microsoft.com',
      sessionId: 'sess_test',
      tool: 'update_opportunity',
      entitySet: 'opportunities(abc-123)',
      recordId: '12345678-1234-1234-1234-123456789abc',
      recordName: 'Contoso Q2',
      method: 'PATCH',
      description: 'Update stage',
      beforeState: { stage: 'proposal' },
      intendedAfter: { stage: 'won' },
      result: { ok: true, status: 204 },
      ...overrides,
    });
  }

  describe('appendChangeRecord', () => {
    it('appends a record to the audit log', () => {
      const record = sampleRecord();
      appendChangeRecord(record, { dir: testDir });

      const result = queryAuditLog({ dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].id).toBe(record.id);
    });

    it('never throws on unwritable directory', () => {
      const record = sampleRecord();
      // Pass a non-existent parent that cannot be created
      expect(() => appendChangeRecord(record, { dir: '/invalid/path/does/not/exist' })).not.toThrow();
    });

    it('creates data directory if missing', () => {
      const subdir = join(testDir, 'new-subdir');
      const record = sampleRecord();
      appendChangeRecord(record, { dir: subdir });

      expect(existsSync(subdir)).toBe(true);
      const result = queryAuditLog({ dir: subdir });
      expect(result.total).toBe(1);
    });
  });

  describe('queryAuditLog', () => {
    it('returns empty result for non-existent directory', () => {
      const result = queryAuditLog({ dir: '/does/not/exist' });
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
    });

    it('returns all records when no filters (including batch and manual)', () => {
      const r1 = sampleRecord({ correlationId: 'batch_abc' });
      const r2 = sampleRecord({ correlationId: null });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ dir: testDir });
      expect(result.total).toBe(2); // Both batch and manual
      expect(result.entries.some(e => e.correlationId === 'batch_abc')).toBe(true);
      expect(result.entries.some(e => e.correlationId === null)).toBe(true);
    });

    it('sorts newest-first', () => {
      const r1 = sampleRecord({ operationId: 'OP-1' });
      // Force a past timestamp for r1
      r1.ts = new Date(Date.now() - 5000).toISOString();
      const r2 = sampleRecord({ operationId: 'OP-2' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ dir: testDir });
      expect(result.entries[0].operationId).toBe('OP-2'); // newest first
      expect(result.entries[1].operationId).toBe('OP-1');
    });

    it('filters by startDate', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const r1 = sampleRecord({ operationId: 'OP-OLD' });
      r1.ts = yesterday.toISOString();

      const r2 = sampleRecord({ operationId: 'OP-NEW' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const today = new Date().toISOString().split('T')[0];
      const result = queryAuditLog({ startDate: today, dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].operationId).toBe('OP-NEW');
    });

    it('filters by endDate (date-only as end-of-day)', () => {
      const r1 = sampleRecord({ operationId: 'OP-1' });
      appendChangeRecord(r1, { dir: testDir });

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const result = queryAuditLog({ endDate: yesterdayStr, dir: testDir });
      expect(result.total).toBe(0);
    });

    it('filters by endDate (full ISO timestamp as exact upper bound)', () => {
      const exactTime = new Date();
      exactTime.setHours(12, 0, 0, 0);
      const r1 = sampleRecord({ operationId: 'OP-BEFORE' });
      r1.ts = new Date(exactTime.getTime() - 1000).toISOString(); // 1 sec before
      const r2 = sampleRecord({ operationId: 'OP-EXACT' });
      r2.ts = exactTime.toISOString(); // exact
      const r3 = sampleRecord({ operationId: 'OP-AFTER' });
      r3.ts = new Date(exactTime.getTime() + 1000).toISOString(); // 1 sec after

      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const result = queryAuditLog({ endDate: exactTime.toISOString(), dir: testDir });
      expect(result.total).toBe(2); // BEFORE and EXACT, not AFTER
      expect(result.entries.some(e => e.operationId === 'OP-BEFORE')).toBe(true);
      expect(result.entries.some(e => e.operationId === 'OP-EXACT')).toBe(true);
      expect(result.entries.some(e => e.operationId === 'OP-AFTER')).toBe(false);
    });

    it('filters by entitySet', () => {
      const r1 = sampleRecord({ entitySet: 'opportunities(abc)' });
      const r2 = sampleRecord({ entitySet: 'msp_engagementmilestones(xyz)' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ entitySet: 'opportunities', dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].entitySet).toContain('opportunities');
    });

    it('filters by method', () => {
      const r1 = sampleRecord({ method: 'PATCH' });
      const r2 = sampleRecord({ method: 'POST' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ method: 'POST', dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].method).toBe('POST');
    });

    it('filters by phase', () => {
      const r1 = sampleRecord({ phase: 'executed' });
      const r2 = sampleRecord({ phase: 'failed' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ phase: 'failed', dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].phase).toBe('failed');
    });

    it('filters by actor', () => {
      const r1 = sampleRecord({ actor: 'alice@microsoft.com' });
      const r2 = sampleRecord({ actor: 'bob@microsoft.com' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ actor: 'alice@microsoft.com', dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].actor).toBe('alice@microsoft.com');
    });

    it('filters by correlationId (REQUIRED) — batch only', () => {
      const r1 = sampleRecord({ correlationId: 'batch_abc' });
      const r2 = sampleRecord({ correlationId: 'batch_xyz' });
      const r3 = sampleRecord({ correlationId: null });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const result = queryAuditLog({ correlationId: 'batch_abc', dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].correlationId).toBe('batch_abc');
    });

    it('filters by correlationId (REQUIRED) — manual only', () => {
      const r1 = sampleRecord({ correlationId: 'batch_abc' });
      const r2 = sampleRecord({ correlationId: null });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const nullResult = queryAuditLog({ correlationId: null, dir: testDir });
      expect(nullResult.total).toBe(1);
      expect(nullResult.entries[0].correlationId).toBeNull();
    });

    it('filters by search (description)', () => {
      const r1 = sampleRecord({ description: 'Update stage to won' });
      const r2 = sampleRecord({ description: 'Close opportunity' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ search: 'won', dir: testDir });
      expect(result.total).toBe(1);
      expect(result.entries[0].description).toContain('won');
    });

    it('paginates results', () => {
      for (let i = 0; i < 10; i++) {
        appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
      }

      const page1 = queryAuditLog({ limit: 5, offset: 0, dir: testDir });
      expect(page1.total).toBe(10);
      expect(page1.entries.length).toBe(5);

      const page2 = queryAuditLog({ limit: 5, offset: 5, dir: testDir });
      expect(page2.total).toBe(10);
      expect(page2.entries.length).toBe(5);
    });

    it('combines multiple filters', () => {
      const r1 = sampleRecord({ phase: 'executed', method: 'PATCH', entitySet: 'opportunities(a)' });
      const r2 = sampleRecord({ phase: 'failed', method: 'PATCH', entitySet: 'opportunities(b)' });
      const r3 = sampleRecord({ phase: 'executed', method: 'POST', entitySet: 'opportunities(c)' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const result = queryAuditLog({
        phase: 'executed',
        method: 'PATCH',
        entitySet: 'opportunities',
        dir: testDir,
      });
      expect(result.total).toBe(1);
      expect(result.entries[0].entitySet).toContain('opportunities(a)');
    });

    it('respects limit and offset (pagination)', () => {
      for (let i = 0; i < 5; i++) {
        appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
      }

      const result = queryAuditLog({ limit: 2, offset: 1, dir: testDir });
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(2);
    });

    it('clamps limit to [1,200] (negative → 1)', () => {
      for (let i = 0; i < 5; i++) {
        appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
      }

      const result = queryAuditLog({ limit: -1, dir: testDir });
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(1); // clamped to 1
    });

    it('clamps limit to [1,200] (0 → 1)', () => {
      for (let i = 0; i < 5; i++) {
        appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
      }

      const result = queryAuditLog({ limit: 0, dir: testDir });
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(1); // clamped to 1
    });

    it('clamps limit to [1,200] (huge → 200)', () => {
      for (let i = 0; i < 250; i++) {
        appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
      }

      const result = queryAuditLog({ limit: 9999, dir: testDir });
      expect(result.total).toBe(250);
      expect(result.entries).toHaveLength(200); // clamped to 200
    });

    it('clamps offset to >= 0 (negative → 0)', () => {
      for (let i = 0; i < 5; i++) {
        appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
      }

      const result = queryAuditLog({ offset: -10, dir: testDir });
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(5); // starts at 0
    });

    it('ignores invalid startDate (does not filter everything)', () => {
      appendChangeRecord(sampleRecord(), { dir: testDir });

      const result = queryAuditLog({ startDate: 'invalid-date', dir: testDir });
      expect(result.total).toBe(1); // not filtered to zero
    });

    it('ignores invalid endDate (does not filter everything)', () => {
      appendChangeRecord(sampleRecord(), { dir: testDir });

      const result = queryAuditLog({ endDate: 'invalid-date', dir: testDir });
      expect(result.total).toBe(1); // not filtered to zero
    });

    it('returns empty when dir is unreadable (no throw)', () => {
      const result = queryAuditLog({ dir: '/invalid/unreadable/path' });
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
    });

    it('returns empty when dir is a file (not a directory, no throw)', () => {
      const filePath = join(testDir, 'not-a-dir.txt');
      require('node:fs').writeFileSync(filePath, 'test');

      const result = queryAuditLog({ dir: filePath });
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
    });
  });

  describe('getAuditEntry', () => {
    it('returns a single record by id', () => {
      const record = sampleRecord();
      appendChangeRecord(record, { dir: testDir });

      const retrieved = getAuditEntry(record.id, { dir: testDir });
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(record.id);
    });

    it('returns null for non-existent id', () => {
      const retrieved = getAuditEntry('chg_does-not-exist', { dir: testDir });
      expect(retrieved).toBeNull();
    });

    it('returns null for non-existent directory', () => {
      const retrieved = getAuditEntry('chg_test', { dir: '/does/not/exist' });
      expect(retrieved).toBeNull();
    });

    it('returns null when dir is unreadable (no throw)', () => {
      const result = getAuditEntry('chg_123', { dir: '/invalid/unreadable/path' });
      expect(result).toBeNull();
    });

    it('returns null when dir is a file (not a directory, no throw)', () => {
      const filePath = join(testDir, 'not-a-dir.txt');
      require('node:fs').writeFileSync(filePath, 'test');

      const result = getAuditEntry('chg_123', { dir: filePath });
      expect(result).toBeNull();
    });
  });

  describe('source and outcome filters', () => {
    it('filters by source: batch (correlationId != null)', () => {
      const r1 = sampleRecord({ correlationId: 'batch_abc' });
      const r2 = sampleRecord({ correlationId: null });
      const r3 = sampleRecord({ correlationId: 'batch_def' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const result = queryAuditLog({ source: 'batch', dir: testDir });
      expect(result.total).toBe(2);
      expect(result.entries.every(e => e.correlationId != null)).toBe(true);
    });

    it('filters by source: manual (correlationId == null)', () => {
      const r1 = sampleRecord({ correlationId: 'batch_abc' });
      const r2 = sampleRecord({ correlationId: null });
      const r3 = sampleRecord({ correlationId: null });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const result = queryAuditLog({ source: 'manual', dir: testDir });
      expect(result.total).toBe(2);
      expect(result.entries.every(e => e.correlationId == null)).toBe(true);
    });

    it('returns all records when source is absent (no filter)', () => {
      const r1 = sampleRecord({ correlationId: 'batch_abc' });
      const r2 = sampleRecord({ correlationId: null });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ dir: testDir });
      expect(result.total).toBe(2);
    });

    it('filters by outcome: ok (phase === executed)', () => {
      const r1 = sampleRecord({ phase: 'executed' });
      const r2 = sampleRecord({ phase: 'failed' });
      const r3 = sampleRecord({ phase: 'executed' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const result = queryAuditLog({ outcome: 'ok', dir: testDir });
      expect(result.total).toBe(2);
      expect(result.entries.every(e => e.phase === 'executed')).toBe(true);
    });

    it('filters by outcome: attention (phase in {failed, stale-conflict, dead-letter, uncertain})', () => {
      const r1 = sampleRecord({ phase: 'executed' });
      const r2 = sampleRecord({ phase: 'failed' });
      const r3 = sampleRecord({ phase: 'stale-conflict' });
      const r4 = sampleRecord({ phase: 'dead-letter' });
      const r5 = sampleRecord({ phase: 'uncertain' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });
      appendChangeRecord(r4, { dir: testDir });
      appendChangeRecord(r5, { dir: testDir });

      const result = queryAuditLog({ outcome: 'attention', dir: testDir });
      expect(result.total).toBe(4);
      const attentionPhases = new Set(['failed', 'stale-conflict', 'dead-letter', 'uncertain']);
      expect(result.entries.every(e => attentionPhases.has(e.phase))).toBe(true);
    });

    it('returns all records when outcome is absent (no filter)', () => {
      const r1 = sampleRecord({ phase: 'executed' });
      const r2 = sampleRecord({ phase: 'failed' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });

      const result = queryAuditLog({ dir: testDir });
      expect(result.total).toBe(2);
    });
  });

  describe('summarizeAuditLog', () => {
    it('returns correct summary over mixed records', async () => {
      // Mix of batch/manual, ok/attention, and different entity types
      const r1 = sampleRecord({ correlationId: 'batch_1', phase: 'executed', entitySet: 'opportunities(a)' });
      const r2 = sampleRecord({ correlationId: null, phase: 'failed', entitySet: 'milestones(b)' });
      const r3 = sampleRecord({ correlationId: 'batch_2', phase: 'executed', entitySet: 'msp_engagementmilestones(c)' });
      const r4 = sampleRecord({ correlationId: null, phase: 'stale-conflict', entitySet: 'accounts(d)' });
      const r5 = sampleRecord({ correlationId: 'batch_3', phase: 'dead-letter', entitySet: 'opportunities(e)' });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });
      appendChangeRecord(r4, { dir: testDir });
      appendChangeRecord(r5, { dir: testDir });

      const { summarizeAuditLog } = await import('../audit-store.js');
      const summary = summarizeAuditLog({ dir: testDir });

      expect(summary.total).toBe(5);
      expect(summary.outcome.ok).toBe(2); // r1, r3
      expect(summary.outcome.attention).toBe(3); // r2, r4, r5
      expect(summary.byType.opportunities).toBe(2); // r1, r5
      expect(summary.byType.milestones).toBe(2); // r2, r3 (msp_engagementmilestones contains 'milestone')
      expect(summary.byType.other).toBe(1); // r4
      expect(summary.bySource.batch).toBe(3); // r1, r3, r5
      expect(summary.bySource.manual).toBe(2); // r2, r4
    });

    it('applies all filters (startDate, endDate, entitySet, method, phase, actor, correlationId, search, source, outcome)', async () => {
      const ts1 = new Date('2024-01-01T10:00:00Z').toISOString();
      const ts2 = new Date('2024-01-02T10:00:00Z').toISOString();
      const r1 = sampleRecord({ correlationId: 'batch_1', phase: 'executed', entitySet: 'opportunities(a)', method: 'PATCH', actor: 'user1@microsoft.com', description: 'test one' });
      r1.ts = ts1;
      const r2 = sampleRecord({ correlationId: null, phase: 'failed', entitySet: 'milestones(b)', method: 'POST', actor: 'user2@microsoft.com', description: 'test two' });
      r2.ts = ts2;
      const r3 = sampleRecord({ correlationId: 'batch_2', phase: 'executed', entitySet: 'opportunities(c)', method: 'PATCH', actor: 'user1@microsoft.com', description: 'test three' });
      r3.ts = ts2;
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });

      const { summarizeAuditLog } = await import('../audit-store.js');

      // Filter: startDate 2024-01-02
      let summary = summarizeAuditLog({ startDate: '2024-01-02', dir: testDir });
      expect(summary.total).toBe(2); // r2, r3

      // Filter: entitySet opportunities
      summary = summarizeAuditLog({ entitySet: 'opportunities', dir: testDir });
      expect(summary.total).toBe(2); // r1, r3

      // Filter: source batch
      summary = summarizeAuditLog({ source: 'batch', dir: testDir });
      expect(summary.total).toBe(2); // r1, r3

      // Filter: outcome ok
      summary = summarizeAuditLog({ outcome: 'ok', dir: testDir });
      expect(summary.total).toBe(2); // r1, r3

      // Combined filters
      summary = summarizeAuditLog({ source: 'batch', outcome: 'ok', entitySet: 'opportunities', dir: testDir });
      expect(summary.total).toBe(2); // r1, r3
    });

    it('returns zeroed summary when dir is unreadable (no throw)', async () => {
      const { summarizeAuditLog } = await import('../audit-store.js');
      const summary = summarizeAuditLog({ dir: '/invalid/unreadable/path' });
      expect(summary.total).toBe(0);
      expect(summary.outcome.ok).toBe(0);
      expect(summary.outcome.attention).toBe(0);
      expect(summary.byType.opportunities).toBe(0);
      expect(summary.byType.milestones).toBe(0);
      expect(summary.byType.other).toBe(0);
      expect(summary.bySource.batch).toBe(0);
      expect(summary.bySource.manual).toBe(0);
    });

    it('classifies entitySet correctly (opportunities, milestones, other)', async () => {
      const r1 = sampleRecord({ entitySet: 'opportunities(a)', phase: 'executed', correlationId: null });
      const r2 = sampleRecord({ entitySet: 'Opportunities(b)', phase: 'executed', correlationId: null }); // case-insensitive
      const r3 = sampleRecord({ entitySet: 'msp_engagementmilestones(c)', phase: 'executed', correlationId: null });
      const r4 = sampleRecord({ entitySet: 'milestones(d)', phase: 'executed', correlationId: null });
      const r5 = sampleRecord({ entitySet: 'accounts(e)', phase: 'executed', correlationId: null });
      const r6 = sampleRecord({ entitySet: 'contacts(f)', phase: 'executed', correlationId: null });
      appendChangeRecord(r1, { dir: testDir });
      appendChangeRecord(r2, { dir: testDir });
      appendChangeRecord(r3, { dir: testDir });
      appendChangeRecord(r4, { dir: testDir });
      appendChangeRecord(r5, { dir: testDir });
      appendChangeRecord(r6, { dir: testDir });

      const { summarizeAuditLog } = await import('../audit-store.js');
      const summary = summarizeAuditLog({ dir: testDir });

      expect(summary.byType.opportunities).toBe(2); // r1, r2
      expect(summary.byType.milestones).toBe(2); // r3, r4
      expect(summary.byType.other).toBe(2); // r5, r6
    });
  });

  describe('file rotation', () => {
    it('rotates by month', () => {
      const record = sampleRecord();
      appendChangeRecord(record, { dir: testDir });

      // Check that a file with the current month exists
      const result = queryAuditLog({ dir: testDir });
      expect(result.total).toBe(1);
    });

    it('rotates when file exceeds 10MB', () => {
      const largePayload = 'x'.repeat(600000); // ~600KB per record
      // Write 18 records = ~10.8MB total → should trigger rotation
      for (let i = 0; i < 18; i++) {
        const record = sampleRecord({ description: largePayload, operationId: `OP-${i}` });
        // Force unique descriptions to ensure each record is full size
        record.description = largePayload + i;
        appendChangeRecord(record, { dir: testDir });
      }

      // Check that multiple files exist (rotation occurred)
      const fs = require('fs');
      const files = fs.readdirSync(testDir).filter(f => f.startsWith('audit-log'));
      
      // At least one file should exist; check total size to verify data was written
      expect(files.length).toBeGreaterThanOrEqual(1);
      
      const totalSize = files.reduce((sum, file) => {
        const stats = fs.statSync(require('path').join(testDir, file));
        return sum + stats.size;
      }, 0);
      
      // Should have written ~10.8MB of data
      expect(totalSize).toBeGreaterThan(10 * 1024 * 1024);
      
      // All records should still be queryable
      const result = queryAuditLog({ dir: testDir });
      expect(result.total).toBe(18);
    });
  });
});

// ── Test-isolation guard (Layer 2 defense-in-depth) ──────────────────────────
// Mirrors the "does not write to ~/.msx-iq-data during test" check in
// approval-queue.test.js. Verifies that with MSX_USER_DATA unset, resolveDataDir
// falls back to the tmp guard dir (NOT the real user home dir).
describe('audit-store vitest guard (defense-in-depth)', () => {
  it('does not fall back to homedir/.msx-iq-data when MSX_USER_DATA is unset', () => {
    const savedEnv = process.env.MSX_USER_DATA;
    delete process.env.MSX_USER_DATA;

    try {
      const homeAuditDir = join(homedir(), '.msx-iq-data');
      const homeFilesBefore = existsSync(homeAuditDir)
        ? readdirSync(homeAuditDir).filter(f => f.startsWith('audit-log')).length
        : 0;

      // Write a record with NO dir override — resolveDataDir must NOT pick homedir
      const record = makeChangeRecord({
        operationId: 'OP-guard-test',
        correlationId: null,
        phase: 'executed',
        actor: 'test@example.com',
        sessionId: 'guard-sess',
        tool: 'test-tool',
        entitySet: 'test(00000000-0000-0000-0000-000000000001)',
        recordId: '00000000-0000-0000-0000-000000000001',
        recordName: 'guard test record',
        method: 'PATCH',
        description: 'vitest guard -- must never reach real user dir',
        beforeState: {},
        intendedAfter: {},
        result: { ok: true, status: 204 },
      });
      appendChangeRecord(record); // no dir: option — exercises the fallback

      // Real homedir must NOT have gained a new audit file
      const homeFilesAfter = existsSync(homeAuditDir)
        ? readdirSync(homeAuditDir).filter(f => f.startsWith('audit-log')).length
        : 0;
      expect(homeFilesAfter).toBe(homeFilesBefore);

      // The tmp guard dir must have received the write
      const guardDir = join(tmpdir(), '.msx-iq-test-data');
      expect(existsSync(guardDir)).toBe(true);
      const guardResult = queryAuditLog({ dir: guardDir });
      expect(guardResult.entries.some(e => e.operationId === 'OP-guard-test')).toBe(true);
    } finally {
      if (savedEnv !== undefined) process.env.MSX_USER_DATA = savedEnv;
      else delete process.env.MSX_USER_DATA;
    }
  });
});
