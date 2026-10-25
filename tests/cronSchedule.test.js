import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSchedule, matchesSchedule, nextRun, schedule } from '../src/cronSchedule.js';

const BERLIN = 'Europe/Berlin';
const iso = (date) => (date ? date.toISOString() : null);

afterEach(() => {
  vi.useRealTimers();
});

describe('cron patterns', () => {
  it('parses minute and hour fields', () => {
    expect([...parseSchedule('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseSchedule('1,31 8-10 * * *').hours]).toEqual([8, 9, 10]);
    expect(parseSchedule('* * * * *').minutes.size).toBe(60);
  });

  it('rejects what it cannot honour', () => {
    expect(() => parseSchedule('0 0 1 * *')).toThrow();
    expect(() => parseSchedule('0 0 * * 1')).toThrow();
    expect(() => parseSchedule('* * * *')).toThrow();
    expect(() => parseSchedule('61 * * * *')).toThrow();
  });

  it('finds the next run in the schedule time zone', () => {
    // 04:20 Berlin = 03:20 UTC in winter time, 02:20 UTC in summer time
    const daily = parseSchedule('20 4 * * *');
    expect(iso(nextRun(daily, BERLIN, Date.parse('2026-01-10T00:00:00Z')))).toBe('2026-01-10T03:20:00.000Z');
    expect(iso(nextRun(daily, BERLIN, Date.parse('2026-07-10T00:00:00Z')))).toBe('2026-07-10T02:20:00.000Z');
  });
});

describe('daylight saving time change (Europe/Berlin, 2026-10-25: 03:00 CEST -> 02:00 CET)', () => {
  it('hourly pattern fires once per real hour, including both 02:00s', () => {
    const hourly = parseSchedule('0 * * * *');
    let at = Date.parse('2026-10-24T22:30:00Z'); // 00:30 CEST
    const runs = [];
    for (let i = 0; i < 6; i += 1) {
      const next = nextRun(hourly, BERLIN, at);
      runs.push(iso(next));
      at = next.getTime();
    }
    expect(runs).toEqual([
      '2026-10-24T23:00:00.000Z', // 01:00 CEST
      '2026-10-25T00:00:00.000Z', // 02:00 CEST
      '2026-10-25T01:00:00.000Z', // 02:00 CET (the repeated hour)
      '2026-10-25T02:00:00.000Z', // 03:00 CET
      '2026-10-25T03:00:00.000Z',
      '2026-10-25T04:00:00.000Z'
    ]);
  });

  it('every-minute pattern never goes backwards and does not skip minutes across the change', () => {
    const everyMinute = parseSchedule('* * * * *');
    let at = Date.parse('2026-10-24T23:50:00Z');
    for (let i = 0; i < 180; i += 1) {
      const next = nextRun(everyMinute, BERLIN, at);
      expect(next.getTime() - at).toBe(60_000);
      at = next.getTime();
    }
    expect(matchesSchedule(everyMinute, Date.parse('2026-10-25T01:30:00Z'), BERLIN)).toBe(true);
  });

  it('daily 04:20 runs once on the 25-hour day', () => {
    const daily = parseSchedule('20 4 * * *');
    expect(iso(nextRun(daily, BERLIN, Date.parse('2026-10-25T00:00:00Z')))).toBe('2026-10-25T03:20:00.000Z');
    expect(iso(nextRun(daily, BERLIN, Date.parse('2026-10-25T03:20:00Z')))).toBe('2026-10-26T03:20:00.000Z');
  });

  it('keeps firing every minute through the repeated hour instead of freezing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T00:58:10Z')); // 02:58 CEST
    const task = vi.fn();
    const handle = schedule('* * * * *', task, { timezone: BERLIN });
    vi.advanceTimersByTime(5 * 60_000); // through 02:00 CET and beyond
    expect(task).toHaveBeenCalledTimes(5);
    handle.stop();
  });
});

describe('schedule()', () => {
  it('runs a due task once and stops cleanly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:59:30Z'));
    const task = vi.fn();
    const handle = schedule('0 * * * *', task, { timezone: 'UTC' });
    vi.advanceTimersByTime(20_000);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(iso(handle.getNextRun())).toBe('2026-03-01T12:00:00.000Z');
    handle.stop();
    vi.advanceTimersByTime(3 * 3_600_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing task', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:59:30Z'));
    const errors = [];
    const handle = schedule('* * * * *', () => { throw new Error('boom'); }, { timezone: 'UTC', logger: { error: (...args) => errors.push(args) } });
    vi.advanceTimersByTime(3 * 60_000);
    expect(errors.length).toBe(3);
    handle.stop();
  });

  it('runs a missed match once when the process was blocked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:59:30Z'));
    const task = vi.fn();
    let clock = Date.now();
    const handle = schedule('0 * * * *', task, { timezone: 'UTC', now: () => clock });
    // simulate a 5 minute block: the timer fires late and the clock jumped past 11:00
    clock = Date.parse('2026-03-01T11:04:30Z');
    vi.advanceTimersByTime(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
