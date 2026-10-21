// Phase B1.a — getMsFiscalRange / parseFiscalToken regression tests.
// Locks in canonical "FY{YY}-{period}" support without breaking bare/legacy callers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMsFiscalRange, parseFiscalToken } from '../tools.js';

describe('parseFiscalToken', () => {
  beforeEach(() => {
    // Pin "now" to mid-FY26 (Sep 15 2025) so bare-token tests are deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-15T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('parses bare absolute FY27 → fyStartYear 2026, period FY (whole year)', () => {
    expect(parseFiscalToken('FY27')).toEqual({ fyStartYear: 2026, period: 'FY', hasExplicitFy: true });
  });

  it('parses bare absolute FY26 → fyStartYear 2025, period FY (whole year)', () => {
    expect(parseFiscalToken('FY26')).toEqual({ fyStartYear: 2025, period: 'FY', hasExplicitFy: true });
  });

  it('bare absolute FY27 is NOT the same as current FY (even in FY26)', () => {
    // Now is FY26 (Sep 2025), but FY27 should resolve to fyStartYear 2026
    const fy27 = parseFiscalToken('FY27');
    const currentFY = parseFiscalToken('FY');
    expect(fy27.fyStartYear).toBe(2026);
    expect(currentFY.fyStartYear).toBe(2025); // current FY is FY26
    expect(fy27.fyStartYear).not.toBe(currentFY.fyStartYear);
  });

  it('parses canonical FY26-Q1 → fyStartYear 2025, period Q1', () => {
    expect(parseFiscalToken('FY26-Q1')).toEqual({ fyStartYear: 2025, period: 'Q1', hasExplicitFy: true });
  });

  it('parses canonical FY27-H2 → fyStartYear 2026, period H2', () => {
    expect(parseFiscalToken('FY27-H2')).toEqual({ fyStartYear: 2026, period: 'H2', hasExplicitFy: true });
  });

  it('parses canonical FY26-FY → fyStartYear 2025, period FY (full year)', () => {
    expect(parseFiscalToken('FY26-FY')).toEqual({ fyStartYear: 2025, period: 'FY', hasExplicitFy: true });
  });

  it('parses bare Q1 → uses current FY (FY26 for Sep 2025)', () => {
    expect(parseFiscalToken('Q1')).toEqual({ fyStartYear: 2025, period: 'Q1', hasExplicitFy: false });
  });

  it('is case-insensitive', () => {
    expect(parseFiscalToken('fy26-q1')).toEqual({ fyStartYear: 2025, period: 'Q1', hasExplicitFy: true });
  });

  it('throws on unknown period suffix', () => {
    expect(() => parseFiscalToken('FY26-Q9')).toThrow(/Unknown fiscal period/);
    expect(() => parseFiscalToken('garbage')).toThrow(/Unknown fiscal period/);
  });

  it('throws on null/undefined/empty', () => {
    expect(() => parseFiscalToken(null)).toThrow(/Unknown fiscal period/);
    expect(() => parseFiscalToken(undefined)).toThrow(/Unknown fiscal period/);
    expect(() => parseFiscalToken('')).toThrow(/Unknown fiscal period/);
  });
});

describe('getMsFiscalRange — bare (legacy) tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-15T12:00:00Z')); // FY26 Q1
  });
  afterEach(() => { vi.useRealTimers(); });

  it('Q1 → current-FY Q1 (Jul-Sep of fyStartYear)', () => {
    expect(getMsFiscalRange('Q1')).toEqual({ start: '2025-07-01', end: '2025-09-30' });
  });

  it('H2 → current-FY H2 (Jan-Jun of fyStartYear+1)', () => {
    expect(getMsFiscalRange('H2')).toEqual({ start: '2026-01-01', end: '2026-06-30' });
  });

  it('FY → full current FY', () => {
    expect(getMsFiscalRange('FY')).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  });

  it('current-Q in Sep 2025 → Q1 range', () => {
    expect(getMsFiscalRange('current-Q')).toEqual({ start: '2025-07-01', end: '2025-09-30' });
  });
});

describe('getMsFiscalRange — canonical FY{YY}-{period} (Phase B1.a)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" inside FY26 to PROVE canonical tokens ignore "now" for FY derivation.
    vi.setSystemTime(new Date('2025-09-15T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('FY26-Q1 → Jul 1 2025 - Sep 30 2025', () => {
    expect(getMsFiscalRange('FY26-Q1')).toEqual({ start: '2025-07-01', end: '2025-09-30' });
  });

  it('FY27-Q1 → Jul 1 2026 - Sep 30 2026 (FUTURE FY, even though now=FY26)', () => {
    expect(getMsFiscalRange('FY27-Q1')).toEqual({ start: '2026-07-01', end: '2026-09-30' });
  });

  it('FY26-H2 → Jan 1 2026 - Jun 30 2026', () => {
    expect(getMsFiscalRange('FY26-H2')).toEqual({ start: '2026-01-01', end: '2026-06-30' });
  });

  it('FY27-FY → Jul 1 2026 - Jun 30 2027 (full FY27)', () => {
    expect(getMsFiscalRange('FY27-FY')).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

  it('FY27-FY → Jul 1 2026 - Jun 30 2027 (full FY27)', () => {
    expect(getMsFiscalRange('FY27-FY')).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

  it('bare FY27 → Jul 1 2026 - Jun 30 2027 (full FY27, same as FY27-FY)', () => {
    expect(getMsFiscalRange('FY27')).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

  it('bare FY26 → Jul 1 2025 - Jun 30 2026 (full FY26)', () => {
    expect(getMsFiscalRange('FY26')).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  });

  it('FY26-Q3 crosses calendar-year boundary: Jan-Mar 2026', () => {
    expect(getMsFiscalRange('FY26-Q3')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
  });

  it('throws on garbage', () => {
    expect(() => getMsFiscalRange('FY26-XYZ')).toThrow(/Unknown fiscal period/);
    expect(() => getMsFiscalRange('garbage')).toThrow(/Unknown fiscal period/);
  });
});
