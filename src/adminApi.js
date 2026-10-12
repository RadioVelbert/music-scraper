import fs from 'node:fs';
import { z } from 'zod';
import { previewStationSource } from './services.js';
import {
  listStationConfigs,
  getStationConfig,
  saveStationConfig,
  setStationEnabled,
  setStationOrder,
  STATION_ORDER_SQL,
  deleteStation,
  syncStationsFromConfig,
  isLautfmStation
} from './stationStore.js';
import { getSettings, updateSettings } from './settings.js';
import { listStationStatuses } from './stationStatus.js';
import { searchOnlineradiobox, lookupLautfmStation } from './sourceSearch.js';
import { stationDueInfo } from './jobs.js';
import { hasTimeWindow } from './sourceUrl.js';
import { StationSchema } from './config.js';

const COUNTED_TABLES = [
  ['plays', 'Plays'],
  ['track_metadata', 'Track-Metadaten'],
  ['track_display', 'Schreibweisen'],
  ['track_enrichment', 'Deezer-Cache'],
  ['canonical_map', 'Kanonische Zuordnungen'],
  ['daily_track_stats', 'Tagesstatistik je Sender'],
  ['daily_overall_track_stats', 'Tagesstatistik gesamt'],
  ['daily_station_stats', 'Tagesstatistik Sender'],
  ['play_dedup_events', 'Dedup-Ereignisse'],
  ['blocked_tracks', 'Gesperrte Tracks'],
  ['job_runs', 'Job-Historie']
];
const STATS_CACHE_MS = 15000;
// dbstat reads every page; skip the per-table breakdown for big files.
const DBSTAT_MAX_BYTES = 512 * 1024 * 1024;

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sourceType(station) {
  if (isLautfmStation(station)) return 'lautfm';
  if (station.parser === 'json' || station.parser === 'nrwlokalradios_json') return 'json';
  if (station.parser === 'onlineradiobox' || /onlineradiobox\.com/i.test(station.playlist_url)) return 'onlineradiobox';
  return 'html';
}

function collectDbStats(db, dbPath) {
  const files = { db: fileSize(dbPath), wal: fileSize(`${dbPath}-wal`), shm: fileSize(`${dbPath}-shm`) };
  const totalBytes = files.db + files.wal + files.shm;
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });
  const freePages = db.pragma('freelist_count', { simple: true });

  const tables = COUNTED_TABLES.map(([name, label]) => ({
    name,
    label,
    rows: db.prepare(`select count(*) as c from ${name}`).get().c,
    bytes: null
  }));

  if (files.db <= DBSTAT_MAX_BYTES) {
    try {
      const sizes = db.prepare(`
        select coalesce(m.tbl_name, s.name) as table_name, sum(s.pgsize) as bytes
        from dbstat s left join sqlite_master m on m.name = s.name
        group by table_name
      `).all();
      const byTable = new Map(sizes.map((row) => [row.table_name, row.bytes]));
      for (const table of tables) table.bytes = byTable.get(table.name) ?? 0;
    } catch {
      // dbstat not compiled in: row counts only
    }
  }

  // Growth: plays per day over the last 7 days (indexed per station) × average bytes per play.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const countSince = db.prepare('select count(*) as c from plays where station_id = ? and played_at_utc >= ?');
  const stationIds = db.prepare('select id from stations').all().map((row) => row.id);
  const playsLast7d = stationIds.reduce((sum, id) => sum + countSince.get(id, since).c, 0);
  const plays = tables.find((table) => table.name === 'plays').rows;
  const usedBytes = (pageCount - freePages) * pageSize;
  const bytesPerPlay = plays > 500 ? usedBytes / plays : null;
  const playsPerDay = playsLast7d / 7;

  return {
    files,
    totalBytes,
    pageSize,
    pageCount,
    freeBytes: freePages * pageSize,
    tables,
    plays,
    tracks: db.prepare('select count(distinct track_key) as c from plays').get().c,
    stations: stationIds.length,
    oldestPlayUtc: db.prepare('select min(played_at_utc) as v from plays').get().v,
    newestPlayUtc: db.prepare('select max(played_at_utc) as v from plays').get().v,
    growth: {
      playsLast7d,
      playsPerDay,
      bytesPerPlay,
      bytesPerMonth: bytesPerPlay ? playsPerDay * 30 * bytesPerPlay : null,
      bytesPerYear: bytesPerPlay ? playsPerDay * 365 * bytesPerPlay : null
    }
  };
}

function collectStationOverview(db, { jobs }) {
  const settings = getSettings(db);
  const statusById = new Map(listStationStatuses(db).map((row) => [row.station_id, row]));
  const totals = new Map(db.prepare(`
    select station_id, count(*) as plays, max(played_at_utc) as last_played_at_utc
    from plays group by station_id
  `).all().map((row) => [row.station_id, row]));
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const count24h = db.prepare('select count(*) as c from plays where station_id = ? and played_at_utc >= ?');
  // Station -> active ingest job. In a multi-station job, stations already fetched show their result.
  const jobByStation = new Map();
  if (jobs) {
    const { running, queued } = jobs.getStatus({ historyLimit: 0 });
    for (const job of [...queued, ...running]) {
      for (const id of job.stationIds ?? []) jobByStation.set(id, job);
    }
  }
  const configs = new Map(listStationConfigs(db, { includeDisabled: true }).map((station) => [station.id, station]));

  return db.prepare(`select id, name, url, enabled, sort_order from stations order by ${STATION_ORDER_SQL}`).all().map((row) => {
    const config = configs.get(row.id) ?? null;
    const status = statusById.get(row.id) ?? null;
    const due = config ? stationDueInfo(config, status, settings) : null;
    const job = jobByStation.get(row.id);
    const startedInJob = job?.status === 'running' && Boolean(status?.last_started_at_utc) && status.last_started_at_utc >= job.startedAt;
    const running = startedInJob && (!status.last_finished_at_utc || status.last_started_at_utc > status.last_finished_at_utc);
    return {
      id: row.id,
      name: config?.name ?? row.name ?? row.id,
      configured: Boolean(config),
      enabled: Boolean(config?.enabled),
      config,
      sourceType: config ? sourceType(config) : null,
      timeWindow: config ? hasTimeWindow(config.playlist_url) : false,
      refreshMinutes: due?.refreshMinutes ?? null,
      refreshOverridden: Number.isInteger(config?.refresh_minutes),
      nextDueAtUtc: config?.enabled ? due?.nextDueAtUtc ?? null : null,
      queued: Boolean(job) && !startedInJob,
      running,
      status,
      plays: totals.get(row.id)?.plays ?? 0,
      plays24h: count24h.get(row.id, since24h).c,
      lastPlayedAtUtc: totals.get(row.id)?.last_played_at_utc ?? null
    };
  });
}

const ClearSchema = z.object({
  scope: z.enum(['all', 'station']),
  stationId: z.string().optional(),
  confirm: z.literal('LÖSCHEN', { errorMap: () => ({ message: 'Zur Bestätigung "LÖSCHEN" eingeben.' }) })
});

const SettingsPatchSchema = z.object({
  scheduler_enabled: z.boolean().optional(),
  default_refresh_minutes: z.number().int().min(1).max(1440).optional(),
  lautfm_refresh_minutes: z.number().int().min(1).max(1440).optional(),
  track_hour_start: z.number().int().min(0).max(23).optional(),
  track_hour_end: z.number().int().min(0).max(23).optional(),
  noise_terms: z.array(z.string().trim().min(2).max(60)).max(50).optional()
});

function errorMessage(error) {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.') || 'Eingabe'}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}

// Admin endpoints. jobs/catalog/scheduler are only present when running as server (not in unit tests).
export function registerAdminRoutes(app, { db, dbPath, configPath, logger, jobs, catalog, scheduler }) {
  let statsCache = null;
  const handle = (fn) => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      const status = error?.status ?? (error instanceof z.ZodError ? 400 : 400);
      res.status(status).json({ error: errorMessage(error) });
    }
  };
  const requireJobs = () => {
    if (!jobs || !catalog) {
      const error = new Error('Job-System nicht verfügbar');
      error.status = 503;
      throw error;
    }
  };
  const noStore = (res) => {
    res.locals.skipDisplayNames = true;
    res.set('Cache-Control', 'no-store');
  };

  app.get('/api/admin/overview', handle((req, res) => {
    noStore(res);
    const fresh = String(req.query.fresh ?? '') === '1';
    if (fresh || !statsCache || Date.now() - statsCache.at > STATS_CACHE_MS) {
      statsCache = { at: Date.now(), value: collectDbStats(db, dbPath) };
    }
    return {
      generatedAt: new Date().toISOString(),
      settings: getSettings(db),
      db: statsCache.value,
      stations: collectStationOverview(db, { jobs }),
      jobs: jobs ? jobs.getStatus() : { running: [], queued: [], recent: [] },
      schedules: scheduler ? scheduler.nextRuns() : {}
    };
  }));

  app.get('/api/admin/stations', handle((_req, res) => {
    noStore(res);
    return collectStationOverview(db, { jobs });
  }));

  app.post('/api/admin/stations', handle((req) => {
    const station = saveStationConfig(db, req.body, { isNew: true });
    logger.info({ station: station.id }, 'station created');
    if (catalog && station.enabled) catalog.ingest([station.id], { trigger: 'manual', fast: true });
    return station;
  }));

  // Custom order used by all station dropdowns and lists. Registered before "/:id" so "order" isn't taken as an id.
  app.put('/api/admin/stations/order', handle((req) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) throw new Error('ids fehlt');
    return { ids: setStationOrder(db, ids) };
  }));

  app.put('/api/admin/stations/:id', handle((req) => {
    if (req.body?.id && req.body.id !== req.params.id) throw new Error('Die ID eines Senders kann nicht geändert werden.');
    if (!getStationConfig(db, req.params.id) && !db.prepare('select 1 from stations where id = ?').get(req.params.id)) {
      throw Object.assign(new Error('Unbekannter Sender'), { status: 404 });
    }
    const station = saveStationConfig(db, { ...req.body, id: req.params.id });
    logger.info({ station: station.id }, 'station updated');
    return station;
  }));

  app.patch('/api/admin/stations/:id/enabled', handle((req) => setStationEnabled(db, req.params.id, Boolean(req.body?.enabled))));

  app.delete('/api/admin/stations/:id', handle((req) => {
    const deleteData = String(req.query.deleteData ?? '') === '1';
    const result = deleteStation(db, req.params.id, { deleteData });
    statsCache = null;
    logger.info(result, 'station deleted');
    return result;
  }));

  app.post('/api/admin/stations/test', handle(async (req) => {
    const { enabled: _enabled, ...config } = req.body ?? {};
    // Validate like a save, but with a placeholder id/name so unsaved forms can be tested.
    const station = StationSchema.parse({ id: 'test', name: 'Test', ...config });
    return previewStationSource(station, { logger, blockedTerms: getSettings(db).noise_terms });
  }));

  app.post('/api/admin/stations/:id/run', handle((req) => {
    requireJobs();
    if (!getStationConfig(db, req.params.id)) throw Object.assign(new Error('Unbekannter Sender'), { status: 404 });
    if (jobs.inflightStationIds().has(req.params.id)) return { ok: true, alreadyQueued: true };
    // Single-station runs use the fast lane so they don't wait behind a scheduled batch.
    const job = catalog.ingest([req.params.id], { trigger: 'manual', fast: true });
    return { ok: true, jobId: job?.id ?? null };
  }));

  app.post('/api/admin/stations/import-config', handle(() => {
    const result = syncStationsFromConfig(db, configPath);
    logger.info(result, 'stations synced from config');
    return result;
  }));

  app.get('/api/admin/sources/onlineradiobox', handle(async (req, res) => {
    noStore(res);
    return searchOnlineradiobox(String(req.query.q ?? ''));
  }));

  app.get('/api/admin/sources/lautfm/:name', handle(async (req, res) => {
    noStore(res);
    const station = await lookupLautfmStation(req.params.name);
    if (!station) throw Object.assign(new Error('laut.fm-Sender nicht gefunden'), { status: 404 });
    return station;
  }));

  app.get('/api/admin/settings', handle((_req, res) => {
    noStore(res);
    return getSettings(db);
  }));

  app.put('/api/admin/settings', handle((req) => {
    const settings = updateSettings(db, SettingsPatchSchema.parse(req.body ?? {}));
    logger.info(settings, 'settings updated');
    return settings;
  }));

  app.get('/api/admin/jobs', handle((_req, res) => {
    noStore(res);
    return { ...(jobs ? jobs.getStatus({ historyLimit: 100 }) : {}), schedules: scheduler ? scheduler.nextRuns() : {} };
  }));

  app.post('/api/admin/jobs/:type/run', handle((req) => {
    requireJobs();
    const type = req.params.type;
    let job;
    if (type === 'ingest-all') {
      const inflight = jobs.inflightStationIds();
      const ids = listStationConfigs(db).map((station) => station.id).filter((id) => !inflight.has(id));
      job = catalog.ingest(ids, { trigger: 'manual', label: `Abruf: alle Sender (${ids.length})` });
    } else if (type === 'maintenance') job = catalog.maintenance({ trigger: 'manual' });
    else if (type === 'daily') job = catalog.daily({ trigger: 'manual' });
    else if (type === 'deezer-backfill') job = catalog.deezerBackfill({ trigger: 'manual' });
    else if (type === 'charts') job = catalog.charts({ trigger: 'manual' });
    else throw Object.assign(new Error(`Unbekannter Job: ${type}`), { status: 404 });
    return { ok: true, jobId: job?.id ?? null, skipped: !job };
  }));

  app.post('/api/admin/db/clear', handle((req) => {
    requireJobs();
    const input = ClearSchema.parse(req.body ?? {});
    if (input.scope === 'station' && !db.prepare('select 1 from stations where id = ?').get(input.stationId ?? '')) {
      throw new Error('Unbekannter Sender');
    }
    const job = catalog.clearDb({ scope: input.scope, stationId: input.stationId });
    statsCache = null;
    logger.warn({ scope: input.scope, stationId: input.stationId ?? null }, 'database clear requested');
    return { ok: true, jobId: job?.id ?? null };
  }));
}
