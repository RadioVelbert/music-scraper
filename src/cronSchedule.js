import { DateTime } from 'luxon';

// Minimal cron scheduler that works on real instants and only converts to the schedule's time zone to
// read hour/minute. The previous node-cron walked wall-clock minutes in Europe/Berlin and looped forever in
// the repeated hour of the DST change (02:59 CEST -> 02:00 CET -> 02:01 CEST -> ...), freezing the process.
//
// Supported: 5-field patterns where only minute and hour vary ("*", "5", "*/15", "1,31", "10-20"); day of month,
// month and weekday must be "*".

const MINUTE_MS = 60_000;
const MAX_CATCH_UP_MINUTES = 15;

function parseField(field, min, max, name) {
  const values = new Set();
  for (const part of String(field).split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!match) throw new Error(`Unsupported cron ${name} field: "${field}"`);
    const step = match[4] ? Number(match[4]) : 1;
    if (step < 1) throw new Error(`Invalid cron step in ${name} field: "${field}"`);
    const from = match[1] === '*' ? min : Number(match[2]);
    const to = match[1] === '*' ? max : match[3] != null ? Number(match[3]) : match[4] ? max : from;
    if (from < min || to > max || from > to) throw new Error(`Cron ${name} out of range: "${field}"`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseSchedule(expression) {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron pattern needs 5 fields: "${expression}"`);
  if (fields.slice(2).some((field) => field !== '*')) {
    throw new Error(`Only minute and hour may be set (day, month, weekday must be "*"): "${expression}"`);
  }
  return { minutes: parseField(fields[0], 0, 59, 'minute'), hours: parseField(fields[1], 0, 23, 'hour') };
}

export function matchesSchedule(schedule, epochMs, timezone) {
  const local = DateTime.fromMillis(epochMs, { zone: timezone });
  return schedule.minutes.has(local.minute) && schedule.hours.has(local.hour);
}

// Next matching minute strictly after `fromMs`, searched in real minutes (so DST can never cause a loop or a skip).
export function nextRun(schedule, timezone, fromMs = Date.now(), horizonMinutes = 60 * 24 * 8) {
  const first = Math.floor(fromMs / MINUTE_MS) + 1;
  for (let i = 0; i < horizonMinutes; i += 1) {
    const candidate = (first + i) * MINUTE_MS;
    if (matchesSchedule(schedule, candidate, timezone)) return new Date(candidate);
  }
  return null;
}

// Runs `task` whenever the pattern matches. If the process was blocked and minutes were skipped, a match inside
// the skipped window still runs once (never once per missed minute).
export function schedule(expression, task, { timezone = 'UTC', logger = null, now = () => Date.now() } = {}) {
  const parsed = parseSchedule(expression);
  let timer = null;
  let stopped = false;
  let lastMinute = Math.floor(now() / MINUTE_MS);

  const run = () => {
    try {
      const result = task();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => logger?.error?.({ err: error instanceof Error ? error.message : String(error), schedule: expression }, 'scheduled task failed'));
      }
    } catch (error) {
      logger?.error?.({ err: error instanceof Error ? error.message : String(error), schedule: expression }, 'scheduled task failed');
    }
  };

  const tick = () => {
    if (stopped) return;
    const current = Math.floor(now() / MINUTE_MS);
    const from = Math.max(lastMinute + 1, current - MAX_CATCH_UP_MINUTES + 1);
    for (let minute = from; minute <= current; minute += 1) {
      if (matchesSchedule(parsed, minute * MINUTE_MS, timezone)) {
        run();
        break;
      }
    }
    lastMinute = Math.max(lastMinute, current);
    arm();
  };

  const arm = () => {
    if (stopped) return;
    const delay = MINUTE_MS - (now() % MINUTE_MS) + 25;
    timer = setTimeout(tick, delay);
  };

  arm();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    getNextRun: () => nextRun(parsed, timezone, now())
  };
}
