import { DateTime } from 'luxon';

// Placeholders for time-window APIs, evaluated in the station timezone and URL-encoded:
//   {from:yyyy-MM-dd HH:mm:ss}  {to:yyyy-MM-dd HH:mm:ss}   Luxon format
//   {from_iso} {to_iso}  {from_unix} {to_unix}  {from_unix_ms} {to_unix_ms}
const PLACEHOLDER_RE = /\{(from|to)(?::([^}]+)|_(iso|unix_ms|unix))?\}/g;

const DEFAULT_LOOKBACK_MINUTES = 180;
const FIRST_RUN_LOOKBACK_MINUTES = 24 * 60;
const MAX_LOOKBACK_MINUTES = 48 * 60;
const CATCH_UP_OVERLAP_MINUTES = 15;

export function hasTimeWindow(url) {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(String(url ?? ''));
}

export function resolveSourceUrl(url, { from, to, timezone = 'Europe/Berlin' }) {
  const text = String(url ?? '');
  if (!hasTimeWindow(text)) return text;
  const values = {
    from: DateTime.fromJSDate(from).setZone(timezone),
    to: DateTime.fromJSDate(to).setZone(timezone)
  };
  return text.replace(PLACEHOLDER_RE, (_match, which, format, kind) => {
    const dt = values[which];
    if (kind === 'iso') return encodeURIComponent(dt.toISO({ suppressMilliseconds: true }));
    if (kind === 'unix') return String(Math.floor(dt.toSeconds()));
    if (kind === 'unix_ms') return String(dt.toMillis());
    return encodeURIComponent(dt.toFormat(decodeURIComponent(format || "yyyy-MM-dd'T'HH:mm:ss")));
  });
}

// Window start: the configured lookback, extended to cover the gap since the last successful run
// (e.g. after downtime), capped at 48h. The first run fetches the last 24h.
export function timeWindowStart(now, { lookbackMinutes, lastSuccessAtUtc } = {}) {
  const lookback = Number(lookbackMinutes) || DEFAULT_LOOKBACK_MINUTES;
  let minutes = lookback;
  const lastSuccessMs = lastSuccessAtUtc ? Date.parse(lastSuccessAtUtc) : NaN;
  if (Number.isFinite(lastSuccessMs)) {
    minutes = Math.max(lookback, (now.getTime() - lastSuccessMs) / 60000 + CATCH_UP_OVERLAP_MINUTES);
  } else {
    minutes = Math.max(lookback, FIRST_RUN_LOOKBACK_MINUTES);
  }
  minutes = Math.min(minutes, MAX_LOOKBACK_MINUTES);
  return new Date(now.getTime() - minutes * 60000);
}
