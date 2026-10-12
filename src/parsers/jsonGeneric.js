import { DateTime } from 'luxon';
import { BaseParser } from './base.js';
import { JsonSourceSchema } from '../config.js';

export function getPath(value, pathExpr) {
  if (!pathExpr) return value;
  let current = value;
  for (const part of String(pathExpr).split('.')) {
    if (current == null) return undefined;
    current = current[Array.isArray(current) && /^\d+$/.test(part) ? Number(part) : part];
  }
  return current;
}

export function parseTimeValue(raw, format, timezone) {
  if (raw == null || raw === '') return null;
  const kind = String(format || 'iso').trim();
  let dt;
  if (kind === 'unix' || kind === 'unix_ms') {
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    dt = kind === 'unix' ? DateTime.fromSeconds(num) : DateTime.fromMillis(num);
  } else if (kind === 'iso') {
    const text = String(raw).trim();
    // Strings without offset are interpreted in the station timezone.
    dt = DateTime.fromISO(text, { zone: timezone, setZone: true });
    if (!dt.isValid) dt = DateTime.fromSQL(text, { zone: timezone, setZone: true });
  } else {
    dt = DateTime.fromFormat(String(raw).trim(), kind, { zone: timezone, setZone: true });
  }
  return dt?.isValid ? dt.toUTC().toJSDate() : null;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

// Configurable parser for arbitrary JSON playlist APIs (field mapping comes from the station config).
export class JsonGenericParser extends BaseParser {
  constructor({ timezone = 'Europe/Berlin', json = {} } = {}) {
    super({ timezone });
    this.options = JsonSourceSchema.parse(json ?? {});
  }

  parse(raw, sourceUrl) {
    let payload;
    try {
      payload = JSON.parse(String(raw ?? ''));
    } catch {
      throw new Error('Antwort ist kein gültiges JSON');
    }

    const { items_path, artist_path, title_path, time_path, time_format, filter_path, filter_value, split_separator } = this.options;
    let items = getPath(payload, items_path);
    if (items && !Array.isArray(items) && typeof items === 'object') items = [items];
    if (!Array.isArray(items)) {
      throw new Error(`Unter "${items_path || '(Wurzel)'}" wurde keine Liste gefunden`);
    }

    const plays = [];
    const seen = new Set();
    for (const item of items) {
      if (filter_path && asText(getPath(item, filter_path)) !== filter_value) continue;

      let artistRaw = artist_path ? asText(getPath(item, artist_path)) : '';
      let titleRaw = asText(getPath(item, title_path));
      if (!artist_path && titleRaw && split_separator) {
        const index = titleRaw.indexOf(split_separator);
        if (index > 0) {
          artistRaw = titleRaw.slice(0, index).trim();
          titleRaw = titleRaw.slice(index + split_separator.length).trim();
        }
      }
      if (!artistRaw || !titleRaw) continue;

      const playedAt = parseTimeValue(getPath(item, time_path), time_format, this.timezone);
      if (!playedAt) continue;

      const key = `${playedAt.toISOString()}|${artistRaw}|${titleRaw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plays.push({ playedAt, artistRaw, titleRaw, sourceUrl });
    }
    return plays;
  }
}
