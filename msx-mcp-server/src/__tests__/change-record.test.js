// Tests for change-record.js — ChangeRecord schema and redaction.
import { describe, it, expect } from 'vitest';
import { redactGuid, hashLargeText, redactObject, makeChangeRecord } from '../change-record.js';

describe('change-record', () => {
  describe('redactGuid', () => {
    it('redacts GUID to last 8 chars', () => {
      const guid = '12345678-1234-1234-1234-123456789abc';
      expect(redactGuid(guid)).toBe('…56789abc');
    });

    it('handles short strings', () => {
      expect(redactGuid('abc')).toBe('abc');
    });

    it('handles null/undefined', () => {
      expect(redactGuid(null)).toBeNull();
      expect(redactGuid(undefined)).toBeUndefined();
    });
  });

  describe('hashLargeText', () => {
    it('returns text unchanged if under threshold', () => {
      const short = 'Short description';
      expect(hashLargeText(short)).toBe(short);
    });

    it('hashes large text', () => {
      const large = 'x'.repeat(1001);
      const hashed = hashLargeText(large);
      expect(hashed).toMatch(/^<hash:[0-9a-f]{16}…>$/);
    });

    it('handles null/undefined', () => {
      expect(hashLargeText(null)).toBeNull();
      expect(hashLargeText(undefined)).toBeUndefined();
    });
  });

  describe('redactObject', () => {
    it('redacts GUID fields', () => {
      const obj = {
        opportunityid: '12345678-1234-1234-1234-123456789abc',
        name: 'Contoso Q2',
      };
      const redacted = redactObject(obj);
      expect(redacted.opportunityid).toBe('…56789abc');
      expect(redacted.name).toBe('Contoso Q2');
    });

    it('hashes large text fields', () => {
      const obj = {
        description: 'x'.repeat(1001),
      };
      const redacted = redactObject(obj);
      expect(redacted.description).toMatch(/^<hash:[0-9a-f]{16}…>$/);
    });

    it('strips secret-looking keys and values', () => {
      const obj = {
        name: 'Contoso',
        bearer_token: 'secret123',
        password: 'hunter2',
        api_key: 'abc',
        authorization: 'Bearer xyz',
        cookie: 'sessionid=abc123',
        normalHeader: 'Bearer sk-1234567890123456789012345678901234567890',
      };
      const redacted = redactObject(obj);
      expect(redacted.name).toBe('Contoso');
      expect(redacted.bearer_token).toBeUndefined();
      expect(redacted.password).toBeUndefined();
      expect(redacted.api_key).toBeUndefined();
      expect(redacted.authorization).toBeUndefined();
      expect(redacted.cookie).toBeUndefined();
      expect(redacted.normalHeader).toBeUndefined(); // Bearer token in value
    });

    it('redacts nested objects', () => {
      const obj = {
        parent: {
          childid: '12345678-1234-1234-1234-123456789abc',
          name: 'Nested',
        },
      };
      const redacted = redactObject(obj);
      expect(redacted.parent.childid).toBe('…56789abc');
      expect(redacted.parent.name).toBe('Nested');
    });

    it('redacts nested Bearer tokens in headers', () => {
      const obj = {
        request: {
          headers: {
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
            'Content-Type': 'application/json',
          },
        },
        data: { name: 'Test' },
      };
      const redacted = redactObject(obj);
      expect(redacted.request.headers.Authorization).toBeUndefined(); // JWT redacted
      expect(redacted.request.headers['Content-Type']).toBe('application/json');
      expect(redacted.data.name).toBe('Test');
    });

    it('does not mutate input object', () => {
      const obj = {
        opportunityid: '12345678-1234-1234-1234-123456789abc',
        name: 'Contoso',
      };
      const original = { ...obj };
      redactObject(obj);
      expect(obj).toEqual(original); // unchanged
    });
  });

  describe('makeChangeRecord', () => {
    it('generates a normalized ChangeRecord', () => {
      const input = {
        operationId: 'OP-42',
        correlationId: 'batch_abc123',
        phase: 'executed',
        actor: 'user@microsoft.com',
        sessionId: 'sess_xyz',
        tool: 'update_opportunity',
        entitySet: 'opportunities(abc-123)',
        recordId: '12345678-1234-1234-1234-123456789abc',
        recordName: 'Contoso Q2',
        method: 'PATCH',
        description: 'Update stage to won',
        beforeState: { stage: 'proposal' },
        intendedAfter: { stage: 'won' },
        actualAfter: { stage: 'won', closeDate: '2026-06-30' },
        etag: 'W/"12345"',
        result: { ok: true, status: 204, id: '12345678-1234-1234-1234-123456789abc' },
        error: null,
        retryCount: 0,
      };

      const record = makeChangeRecord(input);

      expect(record.schemaVersion).toBe(1);
      expect(record.id).toMatch(/^chg_[0-9a-f-]{36}$/);
      expect(record.operationId).toBe('OP-42');
      expect(record.correlationId).toBe('batch_abc123');
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(record.phase).toBe('executed');
      expect(record.actor).toBe('user@microsoft.com');
      expect(record.sessionId).toBe('sess_xyz');
      expect(record.tool).toBe('update_opportunity');
      expect(record.entitySet).toBe('opportunities(abc-123)');
      expect(record.recordId).toBe('…56789abc'); // redacted
      expect(record.recordName).toBe('Contoso Q2');
      expect(record.method).toBe('PATCH');
      expect(record.description).toBe('Update stage to won');
      expect(record.beforeState.stage).toBe('proposal');
      expect(record.intendedAfter.stage).toBe('won');
      expect(record.actualAfter.stage).toBe('won');
      expect(record.etag).toBe('W/"12345"');
      expect(record.result.ok).toBe(true);
      expect(record.result.status).toBe(204);
      expect(record.result.id).toBe('…56789abc'); // redacted
      expect(record.error).toBeNull();
      expect(record.retryCount).toBe(0);
    });

    it('handles one-by-one (no correlationId)', () => {
      const input = {
        operationId: 'OP-1',
        phase: 'executed',
        actor: 'user@microsoft.com',
        sessionId: 'sess_xyz',
        tool: 'create_opportunity',
        entitySet: 'opportunities',
        method: 'POST',
        description: 'Create new opportunity',
        intendedAfter: { name: 'New Opp' },
        result: { ok: true, status: 201, id: 'new-guid-123' },
      };

      const record = makeChangeRecord(input);
      expect(record.correlationId).toBeNull();
    });

    it('redacts large descriptions', () => {
      const input = {
        operationId: 'OP-1',
        phase: 'executed',
        actor: 'user@microsoft.com',
        sessionId: 'sess_xyz',
        tool: 'update_opportunity',
        entitySet: 'opportunities(abc)',
        method: 'PATCH',
        description: 'x'.repeat(1001),
        intendedAfter: {},
        result: { ok: true, status: 204 },
      };

      const record = makeChangeRecord(input);
      expect(record.description).toMatch(/^<hash:[0-9a-f]{16}…>$/);
    });

    it('handles failures with error', () => {
      const input = {
        operationId: 'OP-2',
        phase: 'failed',
        actor: 'user@microsoft.com',
        sessionId: 'sess_xyz',
        tool: 'update_opportunity',
        entitySet: 'opportunities(abc)',
        method: 'PATCH',
        description: 'Update failed',
        intendedAfter: {},
        result: { ok: false, status: 500 },
        error: { message: 'Internal server error', code: 500 },
        retryCount: 3,
      };

      const record = makeChangeRecord(input);
      expect(record.phase).toBe('failed');
      expect(record.result.ok).toBe(false);
      expect(record.error.message).toBe('Internal server error');
      expect(record.error.code).toBe(500);
      expect(record.retryCount).toBe(3);
    });

    it('includes new fields when provided: accountName, entityType, recordIdFull, recordUrl, friendlyDescription', () => {
      const fullGuid = '12345678-1234-1234-1234-123456789abc';
      const input = {
        operationId: 'OP-99',
        phase: 'executed',
        actor: 'user@microsoft.com',
        sessionId: 'sess_xyz',
        tool: 'update_opportunity',
        entitySet: `opportunities(${fullGuid})`,
        recordId: fullGuid,
        method: 'PATCH',
        description: 'Update opportunity',
        intendedAfter: { stagecode: 1 },
        result: { ok: true, status: 204 },
        accountName: 'Contoso Ltd.',
        entityType: 'opportunity',
        recordIdFull: fullGuid,
        recordUrl: `https://org.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=opportunity&id=${fullGuid}`,
        friendlyDescription: 'Update stage for "Contoso Deal Q3"',
      };

      const record = makeChangeRecord(input);

      expect(record.accountName).toBe('Contoso Ltd.');
      expect(record.entityType).toBe('opportunity');
      // recordIdFull must be the FULL GUID — not redacted
      expect(record.recordIdFull).toBe(fullGuid);
      // recordId must still be redacted
      expect(record.recordId).toBe('…56789abc');
      expect(record.recordUrl).toContain('pagetype=entityrecord');
      expect(record.recordUrl).toContain(fullGuid);
      expect(record.friendlyDescription).toBe('Update stage for "Contoso Deal Q3"');
    });

    it('new fields are null when not provided (backward compat)', () => {
      const input = {
        operationId: 'OP-1',
        phase: 'executed',
        actor: 'user@microsoft.com',
        sessionId: 'sess_xyz',
        tool: 'update_opportunity',
        entitySet: 'opportunities(abc)',
        method: 'PATCH',
        description: 'Update something',
        intendedAfter: {},
        result: { ok: true, status: 204 },
      };

      const record = makeChangeRecord(input);

      expect(record.accountName).toBeNull();
      expect(record.entityType).toBeNull();
      expect(record.recordIdFull).toBeNull();
      expect(record.recordUrl).toBeNull();
      expect(record.friendlyDescription).toBeNull();
    });

    it('recordId is redacted while recordIdFull is the full GUID', () => {
      const fullGuid = 'aabbccdd-1234-5678-9012-abcdef012345';
      const input = {
        operationId: 'OP-55',
        phase: 'executed',
        actor: 'user@microsoft.com',
        sessionId: 'sess',
        tool: 'update_opportunity',
        entitySet: `opportunities(${fullGuid})`,
        recordId: fullGuid,
        recordIdFull: fullGuid,
        method: 'PATCH',
        description: 'Update',
        intendedAfter: {},
        result: { ok: true, status: 204 },
      };

      const record = makeChangeRecord(input);

      expect(record.recordId).toBe('…ef012345'); // last 8 chars
      expect(record.recordIdFull).toBe(fullGuid); // never redacted
    });
  });
});
