import { DateTime } from 'luxon';

// Placeholders for history APIs, filled per fetch from the time window (see timeWindowStart):
//   {from:yyyy-MM-dd HH:mm:ss}  {to:yyyy-MM-dd HH:mm:ss}   Luxon format, station timezone, URL-encoded
//   {from_iso} {to_iso}  {from_unix} {to_unix}  {from_unix_ms} {to_unix_ms}
//   {limit} / {limit:200}   number of entries for count-based APIs ("last N songs"): enough songs to
//                           cover the window (one per 2 minutes, generous), capped at the given API maximum
const PLACEHOLDER_RE = /\{(from|to)(?::([^}]+)|_(iso|unix_ms|unix))?\}|\{limit(?::(\d+))?\}/g;

const DEFAULT_LOOKBACK_MINUTES = 180;
const FIRST_RUN_LOOKBACK_MINUTES = 24 * 60;
const MAX_LOOKBACK_MINUTES = 48 * 60;
const CATCH_UP_OVERLAP_MINUTES = 15;
const MINUTES_PER_SONG_ESTIMATE = 2;
const MIN_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 500;

export function hasTimeWindow(url) {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(String(url ?? ''));
}

export function limitForWindow(from, to, maxLimit = DEFAULT_MAX_LIMIT) {
  const minutes = Math.max(0, (to.getTime() - from.getTime()) / 60000);
  const max = Math.max(MIN_LIMIT, Number(maxLimit) || DEFAULT_MAX_LIMIT);
  return Math.min(max, Math.max(MIN_LIMIT, Math.ceil(minutes / MINUTES_PER_SONG_ESTIMATE)));
}

export function resolveSourceUrl(url, { from, to, timezone = 'Europe/Berlin' }) {
  const text = String(url ?? '');
  if (!hasTimeWindow(text)) return text;
  const values = {
    from: DateTime.fromJSDate(from).setZone(timezone),
    to: DateTime.fromJSDate(to).setZone(timezone)
  };
  return text.replace(PLACEHOLDER_RE, (match, which, format, kind, maxLimit) => {
    if (match.startsWith('{limit')) return String(limitForWindow(from, to, maxLimit));
    const dt = values[which];
    if (kind === 'iso') return encodeURIComponent(dt.toISO({ suppressMilliseconds: true }));
    if (kind === 'unix') return String(Math.floor(dt.toSeconds()));
    if (kind === 'unix_ms') return String(dt.toMillis());
    return encodeURIComponent(dt.toFormat(decodeURIComponent(format || "yyyy-MM-dd'T'HH:mm:ss")));
  });
}

// Window start: the configured lookback, extended to cover the gap since the newest stored play
// (downtime, or runs that fetched too little), capped at 48h. A station without plays fetches the last 24h.
export function timeWindowStart(now, { lookbackMinutes, lastPlayAtUtc } = {}) {
  const lookback = Number(lookbackMinutes) || DEFAULT_LOOKBACK_MINUTES;
  let minutes = lookback;
  const lastPlayMs = lastPlayAtUtc ? Date.parse(lastPlayAtUtc) : NaN;
  if (Number.isFinite(lastPlayMs)) {
    minutes = Math.max(lookback, (now.getTime() - lastPlayMs) / 60000 + CATCH_UP_OVERLAP_MINUTES);
  } else {
    minutes = Math.max(lookback, FIRST_RUN_LOOKBACK_MINUTES);
  }
  minutes = Math.min(minutes, MAX_LOOKBACK_MINUTES);
  return new Date(now.getTime() - minutes * 60000);
}
