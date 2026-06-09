import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey,
  startOfWeekKey,
  startOfMonthKey,
} from '../lib/stats.js';

// ─── dayKey ──────────────────────────────────────────────────────────────────

test('dayKey: ISO timestamp returns YYYY-MM-DD in local time', () => {
  // Pick a timestamp explicit enough that local TZ shouldn't flip the date.
  const result = dayKey('2026-06-15T12:00:00Z');
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('dayKey: same date at noon UTC is the same day everywhere except extreme TZs', () => {
  const result = dayKey('2026-06-15T12:00:00Z');
  // Just verify it stays in the right month — noon UTC in June is June in any populated TZ
  assert.equal(result.slice(0, 7), '2026-06');
});

// ─── startOfMonthKey ─────────────────────────────────────────────────────────

test('startOfMonthKey: mid-month returns 1st of that month', () => {
  const d = new Date(2026, 5, 15); // June 15, 2026
  assert.equal(startOfMonthKey(d), '2026-06-01');
});

test('startOfMonthKey: first of month returns itself', () => {
  const d = new Date(2026, 0, 1); // Jan 1
  assert.equal(startOfMonthKey(d), '2026-01-01');
});

test('startOfMonthKey: last day of month returns 1st of same month', () => {
  const d = new Date(2026, 11, 31); // Dec 31
  assert.equal(startOfMonthKey(d), '2026-12-01');
});

// ─── startOfWeekKey ──────────────────────────────────────────────────────────

test('startOfWeekKey: Monday returns itself', () => {
  // 2026-06-08 is a Monday
  const d = new Date(2026, 5, 8);
  assert.equal(startOfWeekKey(d), '2026-06-08');
});

test('startOfWeekKey: Wednesday returns previous Monday', () => {
  // 2026-06-10 is a Wednesday → expected Monday 2026-06-08
  const d = new Date(2026, 5, 10);
  assert.equal(startOfWeekKey(d), '2026-06-08');
});

test('startOfWeekKey: Sunday returns previous Monday (week ends Sun)', () => {
  // 2026-06-14 is a Sunday → expected Monday 2026-06-08
  const d = new Date(2026, 5, 14);
  assert.equal(startOfWeekKey(d), '2026-06-08');
});

test('startOfWeekKey: handles month boundary', () => {
  // 2026-06-01 is a Monday, so 2026-06-02 (Tue) → 2026-06-01
  const tue = new Date(2026, 5, 2);
  assert.equal(startOfWeekKey(tue), '2026-06-01');
});
