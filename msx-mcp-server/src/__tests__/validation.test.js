import { describe, it, expect } from 'vitest';
import { isValidGuid, normalizeGuid, isValidTpid, sanitizeODataString } from '../validation.js';

describe('isValidGuid', () => {
  it('accepts a valid lowercase GUID', () => {
    expect(isValidGuid('12345678-1234-1234-1234-123456789abc')).toBe(true);
  });

  it('accepts a valid uppercase GUID', () => {
    expect(isValidGuid('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(true);
  });

  it('rejects null/empty', () => {
    expect(isValidGuid(null)).toBe(false);
    expect(isValidGuid('')).toBe(false);
    expect(isValidGuid(undefined)).toBe(false);
  });

  it('rejects GUIDs with braces', () => {
    expect(isValidGuid('{12345678-1234-1234-1234-123456789abc}')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidGuid('1234567g-1234-1234-1234-123456789abc')).toBe(false);
  });
});

describe('normalizeGuid', () => {
  it('strips braces and lowercases', () => {
    expect(normalizeGuid('{ABCDEF01-2345-6789-ABCD-EF0123456789}'))
      .toBe('abcdef01-2345-6789-abcd-ef0123456789');
  });

  it('handles null/undefined gracefully', () => {
    expect(normalizeGuid(null)).toBe('');
    expect(normalizeGuid(undefined)).toBe('');
  });
});

describe('isValidTpid', () => {
  it('accepts numeric strings', () => {
    expect(isValidTpid('12345')).toBe(true);
    expect(isValidTpid('1')).toBe(true);
  });

  it('rejects non-numeric', () => {
    expect(isValidTpid('abc')).toBe(false);
    expect(isValidTpid('')).toBe(false);
    expect(isValidTpid(null)).toBe(false);
  });
});

describe('sanitizeODataString', () => {
  it('escapes single quotes', () => {
    expect(sanitizeODataString("O'Brian")).toBe("O''Brian");
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeODataString(null)).toBe('');
    expect(sanitizeODataString(undefined)).toBe('');
  });

  it('caps output to 100 chars when maxLength:100 is passed', () => {
    const long = 'a'.repeat(200);
    const result = sanitizeODataString(long, { maxLength: 100 });
    expect(result.length).toBe(100);
    expect(result).toBe('a'.repeat(100));
  });

  it('strips ASCII control characters (0x00–0x1F and DEL 0x7F)', () => {
    const dirty = 'hello\x01\x0A\x1Fworld\x7F';
    const result = sanitizeODataString(dirty);
    expect(result).toBe('helloworld');
    expect(result).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it('strips control chars and then caps length', () => {
    // 'a'.repeat(50) + control + 'b'.repeat(60) → after strip → 110 chars → cap at 100
    const input = 'a'.repeat(50) + '\x05' + 'b'.repeat(60);
    const result = sanitizeODataString(input, { maxLength: 100 });
    expect(result.length).toBe(100);
    expect(result).toBe('a'.repeat(50) + 'b'.repeat(50));
  });

  it('still escapes quotes after stripping control chars (O\'Brian)', () => {
    expect(sanitizeODataString("O'Brian", { maxLength: 100 })).toBe("O''Brian");
  });

  it('returns empty string for empty string input', () => {
    expect(sanitizeODataString('')).toBe('');
  });
});
