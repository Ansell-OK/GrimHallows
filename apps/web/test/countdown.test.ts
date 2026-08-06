/**
 * Countdown tests.
 *
 * A spawn's countdown is the only warning a player gets that a dungeon is about
 * to close, so the two failure modes worth guarding are: showing time that has
 * already passed, and deciding urgency from something other than the clock.
 */

import { describe, expect, it } from 'vitest';
import {
  EXPIRING_SOON_MS,
  formatCountdown,
  isExpiringSoon,
  msRemaining,
} from '../src/lib/countdown';

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

describe('msRemaining', () => {
  it('measures the gap to the expiry', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(msRemaining('2026-01-01T00:10:00Z', now)).toBe(600_000);
  });

  it('floors at zero rather than going negative', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(msRemaining('2025-12-31T23:00:00Z', now)).toBe(0);
  });

  it('treats an unparseable expiry as closed', () => {
    // Better to hide a marker than to show one that can't be entered.
    expect(msRemaining('whenever')).toBe(0);
  });

  it('defaults to the current time', () => {
    expect(msRemaining(iso(60_000))).toBeGreaterThan(59_000);
    expect(msRemaining(iso(-60_000))).toBe(0);
  });
});

describe('formatCountdown', () => {
  it.each([
    [1_632_000, '27m 12s'],
    [485_000, '8m 05s'],
    [1_053_000, '17m 33s'],
    [59_000, '0m 59s'],
    [1_000, '0m 01s'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });

  it('switches to hours rather than showing a three-digit minute count', () => {
    expect(formatCountdown(3_900_000)).toBe('1h 05m');
  });

  it('says Closed at and below zero', () => {
    expect(formatCountdown(0)).toBe('Closed');
    expect(formatCountdown(-5_000)).toBe('Closed');
  });
});

describe('isExpiringSoon', () => {
  it('is driven by time remaining, not by the label text', () => {
    // The screen this replaced parsed the leading integer out of a string, so
    // "8m 05s" counted as urgent and "1h 02m" did not.
    expect(isExpiringSoon(msRemaining(iso(8 * 60_000)))).toBe(true);
    expect(isExpiringSoon(msRemaining(iso(62 * 60_000)))).toBe(false);
  });

  it('includes the boundary and excludes anything past it', () => {
    expect(isExpiringSoon(EXPIRING_SOON_MS)).toBe(true);
    expect(isExpiringSoon(EXPIRING_SOON_MS + 1)).toBe(false);
  });

  it('is false once closed — an expired spawn is gone, not urgent', () => {
    expect(isExpiringSoon(0)).toBe(false);
  });
});
