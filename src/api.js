import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createRequire } from 'node:module';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  openDb,
  listStations,
  searchTracks,
  listTracks,
  getTrackPlays,
  getTrackIdentity,
  getTrackMetadata,
  getTrackStationCounts,
  listNewTitles,
  getNewTracksInWeek,
} from './db.js';
import { BERLIN_TZ, buildWeekRanges } from './time.js';
import { buildTrackSeries, buildTrackSeriesByStation, buildTrackTotals } from './trends.js';
import { runDailyEvaluation, runManualTrackMerge, deleteAndBlockTrack } from './services.js';
import { listStationConfigs, getStationConfig, importStationsFromConfig, saveStationConfig, syncStationsFromConfig } from './stationStore.js';
import { applyDisplayNames } from './displayNames.js';
import { getTrackDetails, getTrackPreview } from './trackDetails.js';
import { createJobRunner, createJobCatalog, initScheduler } from './jobs.js';
import { registerAdminRoutes } from './adminApi.js';
import { buildStationAnalytics } from './analytics.js';
import { TrackVerifier } from './trackVerifier.js';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const ACTIVE_API_DBS = new Set();
const MY_STATION_CACHE_MS = 60 * 60 * 1000;
let API_DB_HOOKS_REGISTERED = false;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_SCHEMA = z.string().regex(ISO_DATE_RE, 'Invalid from/to date range. Use YYYY-MM-DD.');
const BUCKET_SCHEMA = z.enum(['day', 'week', 'month', 'year']);

function safeQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeQuery(query) {
  const normalized = {};
  for (const [key, value] of Object.entries(query || {})) {
    normalized[key] = safeQueryValue(value);
  }
  return normalized;
}

function parseIntQuery(value, { fallback, min, max, fieldName = 'value' }) {
  if (value == null || value === '') return fallback;
  const parsed = z.coerce.number().int({ message: `${fieldName} must be an integer.` }).safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || `Invalid ${fieldName}.`);
  return Math.max(min, Math.min(max, parsed.data));
}

function parseFloatQuery(value, { fallback, min, max, fieldName = 'value' }) {
  if (value == null || value === '') return fallback;
  const parsed = z.coerce.number({ message: `${fieldName} must be numeric.` }).safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || `Invalid ${fieldName}.`);
  return Math.max(min, Math.min(max, parsed.data));
}

function parseBucket(value, fallback = 'day') {
  const parsed = BUCKET_SCHEMA.safeParse(String(value ?? fallback));
  if (!parsed.success) throw new Error('Invalid bucket. Use day|week|month|year.');
  return parsed.data;
}

function registerApiDbHooks(logger) {
  if (API_DB_HOOKS_REGISTERED) return;
  API_DB_HOOKS_REGISTERED = true;
  const closeAll = () => {
    for (const db of ACTIVE_API_DBS) {
      try {
        db.close();
      } catch (error) {
        logger?.warn?.({ err: error instanceof Error ? error.message : String(error) }, 'failed to close api db');
      }
    }
    ACTIVE_API_DBS.clear();
  };
  // SIGINT/SIGTERM are handled by startApiServer (graceful shutdown ending in process.exit, which fires this hook).
  process.once('exit', closeAll);
}

export function parseRange(from, to) {
  let fromValue;
  let toValue;
  try {
    const rawFrom = safeQueryValue(from);
    const rawTo = safeQueryValue(to);
    fromValue = rawFrom == null || rawFrom === '' ? null : ISO_DATE_SCHEMA.parse(String(rawFrom));
    toValue = rawTo == null || rawTo === '' ? null : ISO_DATE_SCHEMA.parse(String(rawTo));
  } catch {
    throw new Error('Invalid from/to date range. Use YYYY-MM-DD.');
  }

  const end = toValue
    ? DateTime.fromISO(String(toValue), { zone: BERLIN_TZ }).plus({ days: 1 }).startOf('day')
    : DateTime.now().setZone(BERLIN_TZ).plus({ days: 1 }).startOf('day');
  const start = fromValue
    ? DateTime.fromISO(String(fromValue), { zone: BERLIN_TZ }).startOf('day')
    : end.minus({ days: 90 });

  if (!start.isValid || !end.isValid || end <= start) {
    throw new Error('Invalid from/to date range. Use YYYY-MM-DD.');
  }

  return {
    startUtcIso: start.toUTC().toISO(),
    endUtcIso: end.toUTC().toISO()
  };
}

function parseNumberInRange(rawValue, fallback, min, max) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function classifyGrowth(growthPercent) {
  if (growthPercent > 30) return 'hot';
  if (growthPercent < -30) return 'dropping';
  return 'stable';
}

function computeTrackTrend(db, trackKey, nowBerlin = DateTime.now().setZone(BERLIN_TZ)) {
  const nowUtcIso = nowBerlin.toUTC().toISO();
  const last48Start = nowBerlin.minus({ hours: 48 }).toUTC().toISO();
  const prev48Start = nowBerlin.minus({ hours: 96 }).toUTC().toISO();
  const prev48End = last48Start;
  const last14Start = nowBerlin.minus({ days: 14 }).toUTC().toISO();

  // Single query with conditional aggregation instead of three separate queries
  const row = db.prepare(`
    select
      count(*) filter (where played_at_utc >= ? and played_at_utc < ?) as last48,
      count(*) filter (where played_at_utc >= ? and played_at_utc < ?) as prev48,
      count(*) filter (where played_at_utc >= ? and played_at_utc < ?) as last14d
    from plays
    where track_key = ?
      and played_at_utc >= ?
      and played_at_utc < ?
  `).get(last48Start, nowUtcIso, prev48Start, prev48End, last14Start, nowUtcIso, trackKey, prev48Start, nowUtcIso);

  const playsLast48h = Number(row?.last48 ?? 0);
  const playsPrev48h = Number(row?.prev48 ?? 0);
  const playsLast14d = Number(row?.last14d ?? 0);

  const avgPlaysLast14d = playsLast14d / 14;
  const currentDailyRate = playsLast48h / 2;
  const growthPercent = avgPlaysLast14d > 0
    ? ((currentDailyRate - avgPlaysLast14d) / avgPlaysLast14d) * 100
    : (currentDailyRate > 0 ? 100 : 0);

  return {
    plays_last_48h: playsLast48h,
    avg_plays_last_14d: Number(avgPlaysLast14d.toFixed(3)),
    growth_percent: Number(growthPercent.toFixed(2)),
    previous_48h: playsPrev48h,
    status: classifyGrowth(growthPercent)
  };
}

export function createApiHandlers({ configPath, dbPath, logger }) {
  // Short busy timeout: a write blocked by a running job must not stall the API event loop for long.
  const sharedDb = openDb(dbPath, { busyTimeoutMs: 3000 });
  ACTIVE_API_DBS.add(sharedDb);
  registerApiDbHooks(logger);
  try {
    importStationsFromConfig(sharedDb, configPath, { onlyIfEmpty: true });
  } catch (error) {
    logger?.warn?.({ err: error instanceof Error ? error.message : String(error) }, 'station seed from config failed');
  }

  // "Mein Sender" comparisons are expensive: each result is kept for an hour per station and filter,
  // so reloading the page can't trigger the queries again and again. Changing "Mein Sender" uses a new key.
  const myStationCache = new Map();
  const resolveMyStationId = (query) => {
    const requested = query.stationId ? String(query.stationId).trim() : '';
    if (requested) return requested;
    return listStationConfigs(sharedDb, { includeDisabled: true }).find((station) => station.my_station)?.id ?? null;
  };
  const cacheMeta = (at, cached) => ({
    computedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + MY_STATION_CACHE_MS).toISOString(),
    cached
  });
  const withMyStationCache = (name, handler) => (req, res) => {
    const query = normalizeQuery(req.query);
    const stationId = resolveMyStationId(query);
    if (!stationId) return handler(req, res);
    const { stationId: _stationId, ...params } = query;
    const key = `${name}|${stationId}|${JSON.stringify(Object.entries(params).sort())}`;
    const now = Date.now();
    const hit = myStationCache.get(key);
    if (hit && now - hit.at < MY_STATION_CACHE_MS) {
      // Stored payload already carries display spellings.
      if (res.locals) res.locals.skipDisplayNames = true;
      return res.json({ ...hit.payload, cache: cacheMeta(hit.at, true) });
    }
    for (const [entryKey, entry] of myStationCache) {
      if (now - entry.at >= MY_STATION_CACHE_MS) myStationCache.delete(entryKey);
    }
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400 || !body || typeof body !== 'object') return sendJson(body);
      const payload = { ...body, cache: cacheMeta(now, false) };
      const result = sendJson(payload);
      // No plays of "Mein Sender" in the window yet (e.g. right after setup): don't keep the empty result.
      const days = Math.max(1, Math.min(90, Number(params.days) || 7));
      const since = new Date(now - days * 86400000).toISOString();
      const hasPlays = sharedDb.prepare('select 1 from plays where station_id = ? and played_at_utc >= ? limit 1').get(stationId, since);
      if (hasPlays) myStationCache.set(key, { at: now, payload });
      return result;
    };
    return handler(req, res);
  };

  const closeSharedDb = () => {
    if (!ACTIVE_API_DBS.has(sharedDb)) return;
    ACTIVE_API_DBS.delete(sharedDb);
    try {
      sharedDb.close();
    } catch (error) {
      logger?.warn?.({ err: error instanceof Error ? error.message : String(error) }, 'failed to close shared api db');
    }
  };

  const handlers = {
    __close: closeSharedDb,
    __db: sharedDb,

    // The page asks on every visit which station is "Mein Sender" (configured in the admin area).
    myStationCurrent: (_req, res) => {
      const station = listStationConfigs(sharedDb, { includeDisabled: true }).find((s) => s.my_station) ?? null;
      if (res.locals) res.locals.skipDisplayNames = true;
      res.set?.('Cache-Control', 'no-store');
      return res.json({ station: station ? { id: station.id, name: station.name, enabled: station.enabled } : null });
    },

    myStationSet: (req, res) => {
      try {
        const stationId = String(req.body?.stationId ?? '').trim();
        const station = getStationConfig(sharedDb, stationId);
        if (!station) return res.status(404).json({ error: 'Unbekannter oder nicht konfigurierter Sender.' });
        const saved = saveStationConfig(sharedDb, { ...station, my_station: true });
        logger?.info?.({ station: saved.id }, 'my station changed');
        return res.json({ station: { id: saved.id, name: saved.name, enabled: saved.enabled } });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    health: (_req, res) => {
      res.json({ ok: true, time: new Date().toISOString() });
    },

    docs: (_req, res) => {
      res.json({
        name: 'Music Scraper API',
        pages: ['GET /dashboard', 'GET /new-titles', 'GET /weekly-reports', 'GET /my-station', 'GET /admin'],
        endpoints: [
          'GET /api/health',
          'GET /api/docs',
          'GET /api/stations',
          'GET /api/tracks?limit=100&q=QUERY&stationId=ID&includeTrackKey=TRACK_KEY',
          'GET /api/new-titles?from=YYYY-MM-DD&to=YYYY-MM-DD&station=ID&limit=250&minPlays=1&q=QUERY&requireReleaseDate=1&maxReleaseAgeDays=730&minReleaseConfidence=0.55',
          'GET /api/tracks/search?q=QUERY&limit=30',
          'GET /api/tracks/:trackKey/details?refresh=1  (Deezer: artwork, ISRC, release, contributors, links; plays per station)',
          'GET /api/tracks/:trackKey/preview  (fresh 30s preview URL, Deezer or iTunes)',
          'GET /api/tracks/:trackKey/series?bucket=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/series-by-station?bucket=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=10',
          'GET /api/panel/active-senders?from=YYYY-MM-DD&to=YYYY-MM-DD&minPlays=50',
          'GET /api/tracks/:trackKey/totals?from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/stations?from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/trend',
          'GET /api/tracks/:trackKey/station-divergence',
          'GET /api/tracks/:trackKey/lifecycle',
          'GET /api/tracks/:trackKey/meta',
          'POST /api/tracks/:trackKey/meta/refresh',
          'GET /api/alerts/new-cross-station?days=2&minStations=3',
          'GET /api/artists/momentum?limit=50',
          'GET /api/outliers?days=30&threshold=2.5&limit=100',
          'GET /api/stations/:stationId/profile?days=90',
          'POST /api/admin/merge-tracks {"winnerTrackKey":"...","loserTrackKey":"..."}',
          'GET /api/reports/weekly-overview?weekStart=YYYY-MM-DD&limit=50',
          'GET /api/reports/station/:stationId?weekStart=YYYY-MM-DD',
          'GET /api/insights/new-this-week?weekStart=YYYY-MM-DD&stationId=ID&limit=20&releaseYear=YYYY&maxReleaseAgeDays=730',
          'POST /api/jobs/evaluate-daily {"date":"YYYY-MM-DD"}',
          'GET /api/my-station  (current "Mein Sender" from the station configuration)',
          'PUT /api/my-station {"stationId":"..."}',
          'GET /api/my-station/overview?days=7  (results cached for 1 hour per station and filter)',
          'GET /api/my-station/missed?days=7&minOtherPlays=3&minOtherStations=2&limit=100',
          'GET /api/my-station/exclusives?days=7&maxOtherStations=1&limit=100',
          'GET /api/admin/overview  (DB size and growth, station status, jobs, schedules)',
          'GET|POST /api/admin/stations, PUT|DELETE /api/admin/stations/:id (?deleteData=1), PATCH /api/admin/stations/:id/enabled',
          'POST /api/admin/stations/test {station config}  (fetch + parse preview, nothing is stored)',
          'POST /api/admin/stations/:id/run, POST /api/admin/stations/import-config',
          'GET /api/admin/sources/onlineradiobox?q=QUERY, GET /api/admin/sources/lautfm/:name',
          'GET|PUT /api/admin/settings, GET /api/admin/jobs, POST /api/admin/jobs/:type/run (ingest-all|maintenance|daily|deezer-backfill)',
          'POST /api/admin/db/clear {"scope":"all"|"station","stationId":"...","confirm":"LÖSCHEN"}'
        ]
      });
    },

    stations: (_req, res) => {
      const db = sharedDb;
      try {
        const rows = listStations(db);
        res.json(rows);
      } finally {
        /* shared db: closed on shutdown */
      }
    },

    tracks: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const q = String(query.q ?? '').trim();
        const stationId = query.stationId ? String(query.stationId) : undefined;
        const includeTrackKey = query.includeTrackKey ? String(query.includeTrackKey).trim() : undefined;
        const limitParam = query.limit == null ? '' : String(query.limit).trim().toLowerCase();
        let limit = 100;
        if (limitParam === 'all' || limitParam === '0' || limitParam === 'max') {
          limit = null;
        } else if (limitParam) {
          limit = parseIntQuery(limitParam, { fallback: 100, min: 1, max: 5000, fieldName: 'limit' });
        }

        const rows = listTracks(sharedDb, { query: q, stationId, limit, includeTrackKey });
        res.json(rows);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    newTitles: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const from = query.from ? String(query.from) : DateTime.now().setZone(BERLIN_TZ).minus({ days: 30 }).toISODate();
        const to = query.to ? String(query.to) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const stationId = query.station ? String(query.station) : undefined;
        const searchQuery = String(query.q ?? '').trim();
        const limit = parseIntQuery(query.limit, { fallback: 250, min: 1, max: 5000, fieldName: 'limit' });
        const minPlays = parseIntQuery(query.minPlays, { fallback: 1, min: 1, max: 5000, fieldName: 'minPlays' });
        const requireReleaseDate = String(query.requireReleaseDate ?? '1') !== '0';
        const maxReleaseAgeDays = parseIntQuery(query.maxReleaseAgeDays, { fallback: 730, min: 0, max: 36500, fieldName: 'maxReleaseAgeDays' });
        const minReleaseConfidence = parseFloatQuery(query.minReleaseConfidence, { fallback: 0.55, min: 0, max: 1, fieldName: 'minReleaseConfidence' });
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const rows = listNewTitles(sharedDb, {
          startUtcIso,
          endUtcIso,
          referenceDateIso: to,
          stationId,
          query: searchQuery,
          minPlays,
          limit,
          requireReleaseDate,
          maxReleaseAgeDays,
          minReleaseConfidence
        });
        return res.json({
          from,
          to,
          station: stationId ?? null,
          limit,
          minPlays,
          requireReleaseDate,
          maxReleaseAgeDays,
          minReleaseConfidence,
          rows
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    search: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const q = String(query.q ?? '').trim();
        const limit = parseIntQuery(query.limit, { fallback: 30, min: 1, max: 100, fieldName: 'limit' });
        if (!q) return res.status(400).json({ error: 'Missing q' });
        const rows = searchTracks(sharedDb, q, limit);
        res.json(rows);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackSeries: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const query = normalizeQuery(req.query);
        const stationId = query.stationId ? String(query.stationId) : undefined;
        const bucket = parseBucket(query.bucket, 'day');
        const { startUtcIso, endUtcIso } = parseRange(query.from, query.to);

        const identity = getTrackIdentity(sharedDb, trackKey);
        if (!identity?.artist || !identity?.title) {
          return res.status(404).json({ error: 'Unknown trackKey' });
        }

        const rows = getTrackPlays(sharedDb, { trackKey, stationId, startUtcIso, endUtcIso });
        return res.json({
          trackKey,
          stationId: stationId ?? null,
          bucket,
          identity,
          series: buildTrackSeries(rows, bucket)
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackTotals: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const query = normalizeQuery(req.query);
        const stationId = query.stationId ? String(query.stationId) : undefined;
        const from = query.from ? String(query.from) : '2000-01-01';
        const to = query.to ? String(query.to) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const identity = getTrackIdentity(sharedDb, trackKey);
        if (!identity?.artist || !identity?.title) {
          return res.status(404).json({ error: 'Unknown trackKey' });
        }

        const rows = getTrackPlays(sharedDb, { trackKey, stationId, startUtcIso, endUtcIso });
        return res.json({
          trackKey,
          stationId: stationId ?? null,
          identity,
          totals: buildTrackTotals(rows)
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackSeriesByStation: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const query = normalizeQuery(req.query);
        const bucket = parseBucket(query.bucket, 'day');
        const limit = parseIntQuery(query.limit, { fallback: 10, min: 1, max: 20, fieldName: 'limit' });
        const { startUtcIso, endUtcIso } = parseRange(query.from, query.to);

        const identity = getTrackIdentity(sharedDb, trackKey);
        if (!identity?.artist || !identity?.title) {
          return res.status(404).json({ error: 'Unknown trackKey' });
        }

        const rows = getTrackPlays(sharedDb, { trackKey, startUtcIso, endUtcIso });
        const stationRows = listStations(sharedDb);
        const stationsById = new Map(stationRows.map((row) => [row.id, row.name || row.id]));
        const grouped = buildTrackSeriesByStation(rows, stationsById, bucket);
        return res.json({
          trackKey,
          bucket,
          identity,
          periods: grouped.periods,
          stations: grouped.stations.slice(0, limit)
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    panelActiveSenders: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const from = query.from ? String(query.from) : DateTime.now().setZone(BERLIN_TZ).minus({ days: 30 }).toISODate();
        const to = query.to ? String(query.to) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const minPlays = parseIntQuery(query.minPlays, { fallback: 50, min: 1, max: 10000, fieldName: 'minPlays' });
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const startDay = DateTime.fromISO(from, { zone: BERLIN_TZ }).startOf('day');
        const endDay = DateTime.fromISO(to, { zone: BERLIN_TZ }).startOf('day');
        if (!startDay.isValid || !endDay.isValid || endDay < startDay) {
          return res.status(400).json({ error: 'Invalid from/to date range. Use YYYY-MM-DD.' });
        }

        // Aggregate directly in SQL grouped by Berlin-date + station, then count active stations per day
        const aggRows = sharedDb.prepare(`
          select
            date(datetime(played_at_utc, '+1 hour'), 'start of day') as berlin_date,
            station_id,
            count(*) as plays
          from plays
          where played_at_utc >= ?
            and played_at_utc < ?
          group by berlin_date, station_id
        `).all(startUtcIso, endUtcIso);

        // Note: SQLite's datetime(x, '+1 hour') is an approximation for Berlin time (UTC+1/+2).
        // For accuracy we use a simple +1h offset which covers CET; CEST edge days are acceptable.
        const dayStationCounts = new Map();
        for (const row of aggRows) {
          const period = String(row.berlin_date || '');
          if (!period) continue;
          if (!dayStationCounts.has(period)) dayStationCounts.set(period, []);
          dayStationCounts.get(period).push(Number(row.plays || 0));
        }

        const series = [];
        let cursor = startDay;
        while (cursor <= endDay) {
          const period = cursor.toISODate();
          const stationPlays = dayStationCounts.get(period) || [];
          const active = stationPlays.filter((plays) => plays >= minPlays).length;
          series.push({ period, active_senders: active });
          cursor = cursor.plus({ days: 1 });
        }

        return res.json({ from, to, minPlays, series });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackStations: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const from = req.query.from ? String(safeQueryValue(req.query.from)) : '2000-01-01';
        const to = req.query.to ? String(safeQueryValue(req.query.to)) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const db = sharedDb;
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const rows = getTrackStationCounts(db, { trackKey, startUtcIso, endUtcIso });
          return res.json({
            trackKey,
            identity,
            stations: rows
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackTrend: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const db = sharedDb;
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }
          const trend = computeTrackTrend(db, trackKey);
          return res.json({ trackKey, identity, ...trend });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackStationDivergence: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days: 7 }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();

        const db = sharedDb;
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const trackByStation = db.prepare(`
            select station_id, count(*) as plays
            from plays
            where track_key = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by station_id
          `).all(trackKey, startUtcIso, endUtcIso);
          const totalsByStation = db.prepare(`
            select station_id, count(*) as total_plays
            from plays
            where played_at_utc >= ?
              and played_at_utc < ?
            group by station_id
          `).all(startUtcIso, endUtcIso);
          const stations = listStations(db);
          const stationNameById = new Map(stations.map((row) => [row.id, row.name || row.id]));

          const totalTrackPlays = trackByStation.reduce((sum, row) => sum + Number(row.plays || 0), 0);
          const totalStationPlays = totalsByStation.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
          const overallShare = totalStationPlays > 0 ? totalTrackPlays / totalStationPlays : 0;
          const totalByStationMap = new Map(totalsByStation.map((row) => [row.station_id, Number(row.total_plays || 0)]));

          const rows = trackByStation.map((row) => {
            const stationTotal = Number(totalByStationMap.get(row.station_id) || 0);
            const stationShare = stationTotal > 0 ? Number(row.plays || 0) / stationTotal : 0;
            const deviationPercent = overallShare > 0
              ? ((stationShare - overallShare) / overallShare) * 100
              : 0;
            return {
              station_id: row.station_id,
              station_name: stationNameById.get(row.station_id) || row.station_id,
              track_plays: Number(row.plays || 0),
              station_total_plays: stationTotal,
              station_share: Number((stationShare * 100).toFixed(3)),
              deviation_percent: Number(deviationPercent.toFixed(2))
            };
          }).sort((a, b) => Math.abs(b.deviation_percent) - Math.abs(a.deviation_percent));

          return res.json({
            trackKey,
            identity,
            window_days: 7,
            overall_share_percent: Number((overallShare * 100).toFixed(3)),
            rows
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    alertsNewCrossStation: (req, res) => {
      try {
        const days = Math.floor(parseNumberInRange(safeQueryValue(req.query.days), 2, 1, 30));
        const minStations = Math.floor(parseNumberInRange(safeQueryValue(req.query.minStations), 3, 2, 20));
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).startOf('day').toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();

        const db = sharedDb;
        try {
          const rows = db.prepare(`
            select
              p.track_key,
              min(p.artist) as artist,
              min(p.title) as title,
              min(p.played_at_utc) as first_seen_utc,
              max(p.played_at_utc) as last_seen_utc,
              count(*) as plays,
              count(distinct p.station_id) as station_count
            from plays p
            where p.played_at_utc >= ?
              and p.played_at_utc < ?
            group by p.track_key
            having count(distinct p.station_id) >= ?
            order by station_count desc, plays desc, first_seen_utc asc
            limit 200
          `).all(startUtcIso, endUtcIso, minStations);
          return res.json({ days, minStations, rows });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    artistsMomentum: (req, res) => {
      try {
        const limit = Math.floor(parseNumberInRange(safeQueryValue(req.query.limit), 50, 5, 200));
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const start30 = nowBerlin.minus({ days: 30 }).toUTC().toISO();
        const prev30 = nowBerlin.minus({ days: 60 }).toUTC().toISO();
        const end = nowBerlin.toUTC().toISO();

        const db = sharedDb;
        try {
          const playsNow = db.prepare(`
            select artist, count(*) as plays
            from plays
            where played_at_utc >= ?
              and played_at_utc < ?
            group by artist
          `).all(start30, end);
          const playsPrev = db.prepare(`
            select artist, count(*) as plays
            from plays
            where played_at_utc >= ?
              and played_at_utc < ?
            group by artist
          `).all(prev30, start30);
          const newTracks = db.prepare(`
            select artist, count(*) as new_tracks
            from (
              select min(artist) as artist, track_key, min(played_at_utc) as first_play
              from plays
              group by track_key
              having first_play >= ? and first_play < ?
            ) t
            group by artist
          `).all(start30, end);

          const prevMap = new Map(playsPrev.map((row) => [row.artist, Number(row.plays || 0)]));
          const newMap = new Map(newTracks.map((row) => [row.artist, Number(row.new_tracks || 0)]));
          const artists = playsNow.map((row) => ({
            artist: row.artist,
            plays_now: Number(row.plays || 0),
            plays_prev: Number(prevMap.get(row.artist) || 0),
            new_tracks: Number(newMap.get(row.artist) || 0)
          }));

          const maxPlays = Math.max(1, ...artists.map((row) => row.plays_now));
          const maxNewTracks = Math.max(1, ...artists.map((row) => row.new_tracks));
          const rows = artists.map((row) => {
            const growthRate = row.plays_prev > 0
              ? ((row.plays_now - row.plays_prev) / row.plays_prev)
              : (row.plays_now > 0 ? 1 : 0);
            const normalizedGrowth = Math.max(0, Math.min(1, (growthRate + 1) / 2));
            const score = (
              (row.plays_now / maxPlays) * 0.5 +
              (row.new_tracks / maxNewTracks) * 0.25 +
              normalizedGrowth * 0.25
            ) * 100;
            return {
              ...row,
              growth_rate_percent: Number((growthRate * 100).toFixed(2)),
              score: Number(score.toFixed(2))
            };
          })
            .sort((a, b) => b.score - a.score || b.plays_now - a.plays_now)
            .slice(0, limit);

          return res.json({ window_days: 30, rows });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackLifecycle: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const db = sharedDb;
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }
          const row = db.prepare(`
            select
              min(played_at_utc) as first_played_at_utc,
              max(played_at_utc) as last_played_at_utc,
              count(*) as total_plays
            from plays
            where track_key = ?
          `).get(trackKey);
          const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
          const first = DateTime.fromISO(String(row?.first_played_at_utc || ''), { zone: 'utc' });
          const last = DateTime.fromISO(String(row?.last_played_at_utc || ''), { zone: 'utc' });
          const ageDays = first.isValid ? Math.max(0, Math.floor(nowBerlin.diff(first.setZone(BERLIN_TZ), 'days').days)) : 0;
          const daysSinceLastPlay = last.isValid ? Math.max(0, Math.floor(nowBerlin.diff(last.setZone(BERLIN_TZ), 'days').days)) : null;
          const trend = computeTrackTrend(db, trackKey, nowBerlin);

          let status = 'catalog';
          if (ageDays < 14) status = 'new';
          else if (ageDays < 60) status = 'active';
          if (trend.growth_percent < -30) status = 'declining';

          return res.json({
            trackKey,
            identity,
            first_played_at_utc: row?.first_played_at_utc ?? null,
            last_played_at_utc: row?.last_played_at_utc ?? null,
            total_plays: Number(row?.total_plays || 0),
            age_days: ageDays,
            days_since_last_play: daysSinceLastPlay,
            trend,
            status
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    outliers: (req, res) => {
      try {
        const days = Math.floor(parseNumberInRange(safeQueryValue(req.query.days), 30, 7, 120));
        const threshold = parseNumberInRange(safeQueryValue(req.query.threshold), 2.5, 1, 8);
        const limit = Math.floor(parseNumberInRange(safeQueryValue(req.query.limit), 100, 10, 1000));
        const startDate = DateTime.now().setZone(BERLIN_TZ).minus({ days }).toISODate();

        const db = sharedDb;
        try {
          const rows = db.prepare(`
            select date_berlin, track_key, artist, title, plays
            from daily_overall_track_stats
            where date_berlin >= ?
          `).all(startDate);
          const byTrack = new Map();
          for (const row of rows) {
            if (!byTrack.has(row.track_key)) byTrack.set(row.track_key, []);
            byTrack.get(row.track_key).push(row);
          }

          const outliers = [];
          for (const [trackKey, series] of byTrack.entries()) {
            if (series.length < 5) continue;
            const values = series.map((row) => Number(row.plays || 0));
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
            const std = Math.sqrt(variance);
            if (!Number.isFinite(std) || std <= 0) continue;
            for (const row of series) {
              const z = (Number(row.plays || 0) - mean) / std;
              if (z > threshold) {
                outliers.push({
                  date_berlin: row.date_berlin,
                  track_key: trackKey,
                  artist: row.artist,
                  title: row.title,
                  plays: Number(row.plays || 0),
                  z_score: Number(z.toFixed(3)),
                  mean: Number(mean.toFixed(3)),
                  std: Number(std.toFixed(3))
                });
              }
            }
          }

          outliers.sort((a, b) => b.z_score - a.z_score);
          return res.json({
            days,
            threshold,
            rows: outliers.slice(0, limit)
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    stationProfile: (req, res) => {
      try {
        const stationId = req.params.stationId;
        const days = Math.floor(parseNumberInRange(safeQueryValue(req.query.days), 90, 30, 365));
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();
        const newCutoffUtc = nowBerlin.minus({ days: 30 }).toUTC().toISO();

        const db = sharedDb;
        try {
          const station = listStations(db).find((row) => row.id === stationId);
          if (!station) return res.status(404).json({ error: 'Unknown stationId' });

          const totalPlays = db.prepare(`
            select count(*) as c
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
          `).get(stationId, startUtcIso, endUtcIso)?.c ?? 0;

          const trackRows = db.prepare(`
            select
              track_key,
              min(played_at_utc) as first_played_at_utc,
              max(played_at_utc) as last_played_at_utc,
              count(*) as plays
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by track_key
          `).all(stationId, startUtcIso, endUtcIso);

          const spans = trackRows.map((row) => {
            const first = DateTime.fromISO(row.first_played_at_utc, { zone: 'utc' });
            const last = DateTime.fromISO(row.last_played_at_utc, { zone: 'utc' });
            if (!first.isValid || !last.isValid) return 0;
            return Math.max(0, last.diff(first, 'days').days);
          });
          const avgRotationLifespanDays = spans.length
            ? spans.reduce((sum, value) => sum + value, 0) / spans.length
            : 0;

          const newTracksCount = db.prepare(`
            select count(*) as c
            from (
              select track_key, min(played_at_utc) as first_station_play
              from plays
              where station_id = ?
              group by track_key
              having first_station_play >= ?
            )
          `).get(stationId, newCutoffUtc)?.c ?? 0;
          const totalTracks = trackRows.length;
          const percentNewTracks = totalTracks > 0 ? (newTracksCount / totalTracks) * 100 : 0;

          const genreRows = db.prepare(`
            select coalesce(m.genre, 'Unbekannt') as genre, count(*) as plays
            from plays p
            left join track_metadata m on m.track_key = p.track_key
            where p.station_id = ?
              and p.played_at_utc >= ?
              and p.played_at_utc < ?
            group by coalesce(m.genre, 'Unbekannt')
            order by plays desc
            limit 12
          `).all(stationId, startUtcIso, endUtcIso);
          const genreTotal = genreRows.reduce((sum, row) => sum + Number(row.plays || 0), 0);
          const genres = genreRows.map((row) => ({
            genre: row.genre,
            plays: Number(row.plays || 0),
            share_percent: genreTotal > 0 ? Number(((Number(row.plays || 0) / genreTotal) * 100).toFixed(2)) : 0
          }));

          return res.json({
            station_id: stationId,
            station_name: station.name || stationId,
            window_days: days,
            total_plays: Number(totalPlays),
            total_tracks: Number(totalTracks),
            average_rotation_lifespan_days: Number(avgRotationLifespanDays.toFixed(2)),
            percent_new_tracks: Number(percentNewTracks.toFixed(2)),
            genre_distribution: genres
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackDetails: async (req, res) => {
      try {
        const refresh = String(safeQueryValue(req.query?.refresh) ?? '') === '1';
        const details = await getTrackDetails(sharedDb, req.params.trackKey, { refresh, logger });
        if (!details) return res.status(404).json({ error: 'Unknown trackKey' });
        // Already contains display spellings; Deezer payload fields must not be rewritten.
        res.locals.skipDisplayNames = true;
        return res.json(details);
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackPreview: async (req, res) => {
      try {
        const preview = await getTrackPreview(sharedDb, req.params.trackKey, { logger });
        if (!preview) return res.status(404).json({ error: 'Kein Hörbeispiel gefunden' });
        return res.json(preview);
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    adminMergeTracks: (req, res) => {
      try {
        const winnerTrackKey = String(req.body?.winnerTrackKey || '').trim();
        const loserTrackKey = String(req.body?.loserTrackKey || '').trim();
        const result = runManualTrackMerge({
          dbPath,
          winnerTrackKey,
          loserTrackKey,
          logger
        });
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    adminDeleteTrack: (req, res) => {
      try {
        const trackKey = String(req.params.trackKey || '').trim();
        if (!trackKey) return res.status(400).json({ error: 'trackKey fehlt' });
        const result = deleteAndBlockTrack({ dbPath, trackKey, logger });
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackMeta: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const db = sharedDb;
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }
          const metadata = getTrackMetadata(db, trackKey);
          return res.json({
            trackKey,
            identity,
            metadata: metadata ?? null
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    refreshTrackMeta: async (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const force = String(safeQueryValue(req.query.force) ?? '1') !== '0';
        const db = sharedDb;
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const verifier = new TrackVerifier({ db, logger });
          const result = await verifier.enrichMetadata(
            {
              trackKey,
              artist: identity.artist,
              title: identity.title
            },
            { forceRefresh: force }
          );

          return res.json({
            trackKey,
            identity,
            metadata: result.metadata ?? null,
            fromCache: Boolean(result.fromCache)
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    newThisWeek: (req, res) => {
      try {
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const rawLimit = Number(safeQueryValue(req.query.limit) ?? 20);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
        const rawMaxReleaseAgeDays = Number(safeQueryValue(req.query.maxReleaseAgeDays) ?? 730);
        const maxReleaseAgeDays = Number.isFinite(rawMaxReleaseAgeDays)
          ? Math.max(1, Math.min(rawMaxReleaseAgeDays, 3650))
          : 730;
        const rawReleaseYear = Number(safeQueryValue(req.query.releaseYear) ?? DateTime.now().setZone(BERLIN_TZ).year);
        const releaseYear = Number.isFinite(rawReleaseYear)
          ? Math.max(1970, Math.min(Math.floor(rawReleaseYear), 2100))
          : DateTime.now().setZone(BERLIN_TZ).year;
        const weekStart = req.query.weekStart
          ? String(safeQueryValue(req.query.weekStart))
          : DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();

        const ranges = buildWeekRanges(weekStart);
        const db = sharedDb;
        try {
          const rows = getNewTracksInWeek(db, {
            startUtcIso: ranges.current.startUtcIso,
            endUtcIso: ranges.current.endUtcIso,
            prevStartUtcIso: ranges.previous.startUtcIso,
            prevEndUtcIso: ranges.previous.endUtcIso,
            stationId,
            limit,
            maxReleaseAgeDays,
            releaseYear
          });
          return res.json({ weekStart, stationId: stationId ?? null, maxReleaseAgeDays, releaseYear, rows });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    evaluateDaily: async (req, res) => {
      try {
        const date = req.body?.date ?? DateTime.now().setZone(BERLIN_TZ).toISODate();
        const result = runDailyEvaluation({ configPath, dbPath, date, logger });
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    weeklyOverview: (req, res) => {
      try {
        const weekStart = req.query.weekStart
          ? String(safeQueryValue(req.query.weekStart))
          : DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
        const limit = parseIntQuery(req.query.limit, { fallback: 50, min: 1, max: 200, fieldName: 'limit' });
        const ranges = buildWeekRanges(weekStart);
        const db = sharedDb;
        try {
          const topTracks = db.prepare(`
            select
              track_key,
              min(artist) as artist,
              min(title) as title,
              count(*) as plays,
              count(distinct station_id) as station_count
            from plays
            where played_at_utc >= ? and played_at_utc < ?
            group by track_key
            order by plays desc
            limit ?
          `).all(ranges.current.startUtcIso, ranges.current.endUtcIso, limit);

          const prevPlayMap = new Map(
            db.prepare(`
              select track_key, count(*) as plays
              from plays
              where played_at_utc >= ? and played_at_utc < ?
              group by track_key
            `).all(ranges.previous.startUtcIso, ranges.previous.endUtcIso)
              .map((r) => [r.track_key, Number(r.plays)])
          );

          const stationTotals = db.prepare(`
            select station_id, count(*) as plays, count(distinct track_key) as unique_tracks
            from plays
            where played_at_utc >= ? and played_at_utc < ?
            group by station_id
            order by plays desc
          `).all(ranges.current.startUtcIso, ranges.current.endUtcIso);

          const prevStationTotals = new Map(
            db.prepare(`
              select station_id, count(*) as plays
              from plays
              where played_at_utc >= ? and played_at_utc < ?
              group by station_id
            `).all(ranges.previous.startUtcIso, ranges.previous.endUtcIso)
              .map((r) => [r.station_id, Number(r.plays)])
          );

          const totalPlays = stationTotals.reduce((sum, r) => sum + Number(r.plays), 0);
          const prevTotalPlays = Array.from(prevPlayMap.values()).reduce((a, b) => a + b, 0);

          return res.json({
            weekStart,
            weekEnd: ranges.current.endBerlin.toISODate(),
            totalPlays,
            prevTotalPlays,
            stationCount: stationTotals.length,
            stationTotals: stationTotals.map((r) => ({
              ...r,
              prev_plays: prevStationTotals.get(r.station_id) ?? 0
            })),
            topTracks: topTracks.map((t) => ({
              ...t,
              prev_plays: prevPlayMap.get(t.track_key) ?? 0,
              delta: Number(t.plays) - (prevPlayMap.get(t.track_key) ?? 0)
            }))
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    stationReport: (req, res) => {
      try {
        const stationId = req.params.stationId;
        const weekStart = req.query.weekStart
          ? String(safeQueryValue(req.query.weekStart))
          : DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
        const ranges = buildWeekRanges(weekStart);
        const station = getStationConfig(sharedDb, stationId);
        if (!station) return res.status(404).json({ error: 'Unknown stationId' });

        const db = sharedDb;
        try {
          const currentRows = listTracks(db, { stationId, limit: 1000 });
          const previousRowsRaw = db.prepare(`
            select
              track_key,
              min(artist) as artist,
              min(title) as title,
              count(*) as count
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by track_key
            order by count desc
          `).all(stationId, ranges.previous.startUtcIso, ranges.previous.endUtcIso);

          const currentRowsRange = db.prepare(`
            select
              track_key,
              min(artist) as artist,
              min(title) as title,
              count(*) as count
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by track_key
            order by count desc
          `).all(stationId, ranges.current.startUtcIso, ranges.current.endUtcIso);

          const totalPlays = db.prepare(`
            select count(*) as total
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
          `).get(stationId, ranges.current.startUtcIso, ranges.current.endUtcIso)?.total ?? 0;

          const report = buildStationAnalytics({
            station,
            currentRows: currentRowsRange,
            previousRows: previousRowsRaw,
            currentTotalPlays: totalPlays
          });

          return res.json({
            stationId,
            weekStart,
            report,
            catalogSize: currentRows.length
          });
        } finally {
          /* shared db: closed on shutdown */
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    myStationMissed: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const config = { stations: listStationConfigs(sharedDb, { includeDisabled: true }) };
        const stationIdParam = query.stationId ? String(query.stationId).trim() : null;
        const myStation = stationIdParam
          ? config.stations.find((s) => s.id === stationIdParam)
          : config.stations.find((s) => s.my_station);
        if (!myStation) return res.status(404).json({ error: 'Unbekannter Sender.' });

        const days = parseIntQuery(query.days, { fallback: 7, min: 1, max: 90, fieldName: 'days' });
        const limit = parseIntQuery(query.limit, { fallback: 100, min: 1, max: 1000, fieldName: 'limit' });
        const minOtherPlays = parseIntQuery(query.minOtherPlays, { fallback: 3, min: 1, max: 9999, fieldName: 'minOtherPlays' });
        const minOtherStations = parseIntQuery(query.minOtherStations, { fallback: 2, min: 1, max: 50, fieldName: 'minOtherStations' });

        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();
        const db = sharedDb;

        const rows = db.prepare(`
          select
            p.track_key,
            min(p.artist) as artist,
            min(p.title) as title,
            count(*) as other_plays,
            count(distinct p.station_id) as other_stations,
            min(p.played_at_utc) as first_seen_at_utc,
            max(p.played_at_utc) as last_seen_at_utc
          from plays p
          where p.station_id != ?
            and p.played_at_utc >= ?
            and p.played_at_utc < ?
            and p.track_key not in (
              select distinct track_key
              from plays
              where station_id = ?
                and played_at_utc >= ?
                and played_at_utc < ?
            )
          group by p.track_key
          having other_plays >= ? and other_stations >= ?
          order by other_plays desc
          limit ?
        `).all(
          myStation.id, startUtcIso, endUtcIso,
          myStation.id, startUtcIso, endUtcIso,
          minOtherPlays, minOtherStations, limit
        );

        return res.json({
          my_station_id: myStation.id,
          my_station_name: myStation.name,
          window_days: days,
          tracks: rows.map((r) => ({
            track_key: r.track_key,
            artist: r.artist,
            title: r.title,
            other_plays: Number(r.other_plays),
            other_stations: Number(r.other_stations),
            first_seen_at_utc: r.first_seen_at_utc,
            last_seen_at_utc: r.last_seen_at_utc
          }))
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    myStationExclusives: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const config = { stations: listStationConfigs(sharedDb, { includeDisabled: true }) };
        const stationIdParam = query.stationId ? String(query.stationId).trim() : null;
        const myStation = stationIdParam
          ? config.stations.find((s) => s.id === stationIdParam)
          : config.stations.find((s) => s.my_station);
        if (!myStation) return res.status(404).json({ error: 'Unbekannter Sender.' });

        const days = parseIntQuery(query.days, { fallback: 7, min: 1, max: 90, fieldName: 'days' });
        const limit = parseIntQuery(query.limit, { fallback: 100, min: 1, max: 1000, fieldName: 'limit' });
        const maxOtherStations = parseIntQuery(query.maxOtherStations, { fallback: 1, min: 0, max: 50, fieldName: 'maxOtherStations' });

        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();
        const db = sharedDb;

        const rows = db.prepare(`
          select
            m.track_key,
            min(m.artist) as artist,
            min(m.title) as title,
            count(*) as my_plays,
            (
              select count(distinct station_id)
              from plays o
              where o.track_key = m.track_key
                and o.station_id != ?
                and o.played_at_utc >= ?
                and o.played_at_utc < ?
            ) as other_stations,
            (
              select count(*)
              from plays o
              where o.track_key = m.track_key
                and o.station_id != ?
                and o.played_at_utc >= ?
                and o.played_at_utc < ?
            ) as other_plays,
            min(m.played_at_utc) as first_played_at_utc,
            max(m.played_at_utc) as last_played_at_utc
          from plays m
          where m.station_id = ?
            and m.played_at_utc >= ?
            and m.played_at_utc < ?
          group by m.track_key
          having other_stations <= ?
          order by my_plays desc
          limit ?
        `).all(
          myStation.id, startUtcIso, endUtcIso,
          myStation.id, startUtcIso, endUtcIso,
          myStation.id, startUtcIso, endUtcIso,
          maxOtherStations, limit
        );

        return res.json({
          my_station_id: myStation.id,
          my_station_name: myStation.name,
          window_days: days,
          tracks: rows.map((r) => ({
            track_key: r.track_key,
            artist: r.artist,
            title: r.title,
            my_plays: Number(r.my_plays),
            other_stations: Number(r.other_stations),
            other_plays: Number(r.other_plays),
            first_played_at_utc: r.first_played_at_utc,
            last_played_at_utc: r.last_played_at_utc
          }))
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    myStationOverview: (req, res) => {
      try {
        const query = normalizeQuery(req.query);
        const config = { stations: listStationConfigs(sharedDb, { includeDisabled: true }) };
        const stationIdParam = query.stationId ? String(query.stationId).trim() : null;
        const myStation = stationIdParam
          ? config.stations.find((s) => s.id === stationIdParam)
          : config.stations.find((s) => s.my_station);
        if (!myStation) return res.status(404).json({ error: 'Unbekannter Sender.' });

        const days = parseIntQuery(query.days, { fallback: 7, min: 1, max: 90, fieldName: 'days' });

        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();
        const db = sharedDb;

        const myPlays = db.prepare(`
          select count(*) as c from plays
          where station_id = ? and played_at_utc >= ? and played_at_utc < ?
        `).get(myStation.id, startUtcIso, endUtcIso)?.c ?? 0;

        const myUniqueTracks = db.prepare(`
          select count(distinct track_key) as c from plays
          where station_id = ? and played_at_utc >= ? and played_at_utc < ?
        `).get(myStation.id, startUtcIso, endUtcIso)?.c ?? 0;

        const missedCount = db.prepare(`
          select count(distinct p.track_key) as c
          from plays p
          where p.station_id != ?
            and p.played_at_utc >= ?
            and p.played_at_utc < ?
            and p.track_key not in (
              select distinct track_key from plays
              where station_id = ? and played_at_utc >= ? and played_at_utc < ?
            )
        `).get(
          myStation.id, startUtcIso, endUtcIso,
          myStation.id, startUtcIso, endUtcIso
        )?.c ?? 0;

        const exclusivesCount = db.prepare(`
          select count(distinct m.track_key) as c
          from plays m
          where m.station_id = ?
            and m.played_at_utc >= ?
            and m.played_at_utc < ?
            and (
              select count(distinct station_id) from plays o
              where o.track_key = m.track_key and o.station_id != ?
                and o.played_at_utc >= ? and o.played_at_utc < ?
            ) = 0
        `).get(
          myStation.id, startUtcIso, endUtcIso,
          myStation.id, startUtcIso, endUtcIso
        )?.c ?? 0;

        return res.json({
          my_station_id: myStation.id,
          my_station_name: myStation.name,
          window_days: days,
          my_plays: Number(myPlays),
          my_unique_tracks: Number(myUniqueTracks),
          missed_count: Number(missedCount),
          exclusives_count: Number(exclusivesCount)
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };

  handlers.myStationOverview = withMyStationCache('overview', handlers.myStationOverview);
  handlers.myStationMissed = withMyStationCache('missed', handlers.myStationMissed);
  handlers.myStationExclusives = withMyStationCache('exclusives', handlers.myStationExclusives);
  return handlers;
}

// Optional HTTP Basic Auth for public deployments. /api/health stays open for container health checks.
function createBasicAuthMiddleware({ user, password, realm = 'Music Scraper' }) {
  // Compare fixed-length digests so timingSafeEqual neither throws on length mismatch nor leaks the length.
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  const expectedUser = digest(user);
  const expectedPassword = digest(password);

  return (req, res, next) => {
    if (req.path === '/api/health') return next();
    const match = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        const userOk = crypto.timingSafeEqual(digest(decoded.slice(0, separator)), expectedUser);
        const passwordOk = crypto.timingSafeEqual(digest(decoded.slice(separator + 1)), expectedPassword);
        if (userOk && passwordOk) return next();
      }
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    return res.status(401).send('Authentication required');
  };
}

// Replaces normalized artist/title in JSON responses of GET /api/* with the display spelling.
function createDisplayNameMiddleware(db, logger) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      if (!res.locals.skipDisplayNames && res.statusCode < 400 && body && typeof body === 'object') {
        try {
          applyDisplayNames(db, body);
        } catch (error) {
          logger.warn({ path: req.path, err: error instanceof Error ? error.message : String(error) }, 'display names failed');
        }
      }
      return json(body);
    };
    return next();
  };
}

export function createApiApp({ configPath, dbPath, logger, jobs = null, catalog = null, scheduler = null }) {
  let express;
  try {
    express = require('express');
  } catch {
    throw new Error('API dependency missing: install packages with `npm install`.');
  }

  const app = express();
  const authUser = process.env.BASIC_AUTH_USER || '';
  const authPassword = process.env.BASIC_AUTH_PASSWORD || '';
  if (authUser && authPassword) {
    app.use(createBasicAuthMiddleware({ user: authUser, password: authPassword }));
  } else {
    logger.warn('BASIC_AUTH_USER/BASIC_AUTH_PASSWORD not set: dashboard and admin endpoints are publicly accessible');
  }
  app.use(express.json({ limit: '256kb' }));
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

  const handlers = createApiHandlers({ configPath, dbPath, logger });
  app.locals.closeApiDb = handlers.__close;
  app.use('/api', createDisplayNameMiddleware(handlers.__db, logger));

  app.get('/', (_req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
  app.get('/tracks', (_req, res) => res.redirect('/dashboard'));
  app.get('/new-titles', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'new-titles.html')));
  app.get('/weekly-reports', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'weekly-reports.html')));
  app.get('/my-station', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'my-station.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

  app.get('/api/health', handlers.health);
  app.get('/api/docs', handlers.docs);
  app.get('/api/stations', handlers.stations);
  app.get('/api/tracks', handlers.tracks);
  app.get('/api/new-titles', handlers.newTitles);
  app.get('/api/tracks/search', handlers.search);
  app.get('/api/tracks/:trackKey/details', handlers.trackDetails);
  app.get('/api/tracks/:trackKey/preview', handlers.trackPreview);
  app.get('/api/tracks/:trackKey/series', handlers.trackSeries);
  app.get('/api/tracks/:trackKey/series-by-station', handlers.trackSeriesByStation);
  app.get('/api/panel/active-senders', handlers.panelActiveSenders);
  app.get('/api/tracks/:trackKey/totals', handlers.trackTotals);
  app.get('/api/tracks/:trackKey/stations', handlers.trackStations);
  app.get('/api/tracks/:trackKey/trend', handlers.trackTrend);
  app.get('/api/tracks/:trackKey/station-divergence', handlers.trackStationDivergence);
  app.get('/api/tracks/:trackKey/lifecycle', handlers.trackLifecycle);
  app.get('/api/tracks/:trackKey/meta', handlers.trackMeta);
  app.post('/api/tracks/:trackKey/meta/refresh', handlers.refreshTrackMeta);
  app.get('/api/alerts/new-cross-station', handlers.alertsNewCrossStation);
  app.get('/api/artists/momentum', handlers.artistsMomentum);
  app.get('/api/outliers', handlers.outliers);
  app.get('/api/stations/:stationId/profile', handlers.stationProfile);
  app.post('/api/admin/merge-tracks', handlers.adminMergeTracks);
  app.delete('/api/admin/tracks/:trackKey', handlers.adminDeleteTrack);
  app.get('/api/reports/weekly-overview', handlers.weeklyOverview);
  app.get('/api/reports/station/:stationId', handlers.stationReport);
  app.get('/api/insights/new-this-week', handlers.newThisWeek);
  app.post('/api/jobs/evaluate-daily', handlers.evaluateDaily);
  app.get('/api/my-station', handlers.myStationCurrent);
  app.put('/api/my-station', handlers.myStationSet);
  app.get('/api/my-station/overview', handlers.myStationOverview);
  app.get('/api/my-station/missed', handlers.myStationMissed);
  app.get('/api/my-station/exclusives', handlers.myStationExclusives);
  registerAdminRoutes(app, { db: handlers.__db, dbPath, configPath, logger, jobs, catalog, scheduler });

  return app;
}

function listenOnPort(app, port, logger) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info({ port }, 'API server started');
      resolve(server);
    });
    server.once('error', (err) => reject(err));
  });
}

// Must stay below Docker's default stop timeout (10s) so we exit on our own instead of being SIGKILLed.
const SHUTDOWN_TIMEOUT_MS = 8000;

function registerGracefulShutdown({ server, jobs, scheduler, logger }) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    scheduler.stop();
    await Promise.all([
      jobs.stop(SHUTDOWN_TIMEOUT_MS - 1000),
      new Promise((resolve) => server.close(() => resolve()))
    ]);
    // process.exit triggers the 'exit' hook that closes the API databases.
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

export async function startApiServer({ configPath, dbPath, port = 8787, startupJob = false }) {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  // Control-plane connection for scheduler and job history. Seeds the station table from config.yaml
  // on an empty database (fails fast on a broken config).
  const controlDb = openDb(dbPath, { busyTimeoutMs: 3000 });
  ACTIVE_API_DBS.add(controlDb);
  registerApiDbHooks(logger);
  // config.yaml changes (new or edited entries) are applied on every start unless edited in the admin area.
  const sync = syncStationsFromConfig(controlDb, configPath);
  logger.info(sync, 'stations synced from config');

  const jobs = createJobRunner({ db: controlDb, logger });
  const catalog = createJobCatalog({ jobs, configPath, dbPath });
  const scheduler = initScheduler({ jobs, catalog, db: controlDb, logger });
  const app = createApiApp({ configPath, dbPath, logger, jobs, catalog, scheduler });

  let server;
  let selectedPort = Number(port) || 8787;
  for (let i = 0; i < 20; i += 1) {
    try {
      server = await listenOnPort(app, selectedPort, logger);
      break;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        logger.warn({ portTried: selectedPort }, 'port already in use, trying next port');
        selectedPort += 1;
        continue;
      }
      throw err;
    }
  }
  if (!server) {
    throw new Error(`Could not start API server: no free port found from ${port} to ${selectedPort}`);
  }

  registerGracefulShutdown({ server, jobs, scheduler, logger });

  if (startupJob) {
    // All stations are due after a restart, so the due check fetches them right away;
    // maintenance and reports run in parallel in the maintenance lane.
    scheduler.checkDueStations();
    catalog.startup();
  }

  return server;
}
