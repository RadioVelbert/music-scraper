import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { BERLIN_TZ, isoUtcNow } from './time.js';
import { getSettings } from './settings.js';
import { effectiveRefreshMinutes, listStationConfigs } from './stationStore.js';
import { listStationStatuses } from './stationStatus.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, 'cli.js');
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const SCHEDULES = {
  dueCheck: '* * * * *',
  maintenance: '0 * * * *',
  charts: '15 * * * *',
  daily: '20 4 * * *'
};

const LANES = ['ingest', 'ingest-fast', 'maintenance'];
// Stations with an interval up to this value (laut.fm: 5 min) are fetched in their own lane, so a long
// batch of hourly stations can't delay them past the end of their short history.
export const FAST_LANE_MAX_MINUTES = 15;

// Runs CLI commands as child processes so long jobs never block the API event loop.
// Three lanes run in parallel: "ingest" (hourly stations), "ingest-fast" (short intervals such as laut.fm,
// manual single-station runs) and "maintenance" (cleanup, evaluation, reports). Jobs within a lane run
// one after another; exclusive jobs (database clear) wait for and block all lanes.
// Every job is recorded in job_runs for the admin area.
export function createJobRunner({ db, logger }) {
  const lanes = new Map(LANES.map((lane) => [lane, Promise.resolve()]));
  const active = new Map();
  const children = new Set();
  let stopping = false;
  let fallbackId = 0;

  const persist = (fn) => {
    try {
      return fn();
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'job history write failed');
      return null;
    }
  };

  // Jobs that were queued or running when the previous process stopped never finished.
  persist(() => db.prepare("update job_runs set status = 'aborted', finished_at_utc = ? where status in ('queued', 'running')").run(isoUtcNow()));

  const runCliCommand = (job, commandName, args, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, commandName, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit']
    });
    children.add(child);
    job.child = child;
    const done = () => {
      children.delete(child);
      job.child = null;
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      done();
      if (code === 0) resolve();
      else reject(new Error(`${commandName} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });

  const finish = (job, status, error = null) => {
    job.status = status;
    job.finishedAt = isoUtcNow();
    const durationMs = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
    active.delete(job.id);
    persist(() => db.prepare('update job_runs set status = ?, finished_at_utc = ?, duration_ms = ?, error = ? where id = ?')
      .run(status, job.finishedAt, durationMs, error, job.id));
    const log = status === 'failed' ? logger.error.bind(logger) : logger.info.bind(logger);
    log({ job: job.name, jobId: job.id, status, durationMs, err: error ?? undefined }, `job ${status}`);
  };

  const execute = async (job, buildSteps) => {
    if (stopping) {
      finish(job, 'cancelled');
      return;
    }
    job.status = 'running';
    job.startedAt = isoUtcNow();
    persist(() => db.prepare("update job_runs set status = 'running', started_at_utc = ? where id = ?").run(job.startedAt, job.id));
    logger.info({ job: job.name, jobId: job.id, trigger: job.trigger }, 'job started');
    try {
      // Evaluated at start time, so date arguments refer to the actual run.
      const steps = buildSteps();
      job.stepCount = steps.length;
      for (const [index, [commandName, args, env]] of steps.entries()) {
        if (stopping) throw new Error('Server wird beendet');
        job.stepIndex = index + 1;
        job.step = commandName;
        await runCliCommand(job, commandName, args, env);
      }
      finish(job, 'success');
    } catch (error) {
      finish(job, stopping ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
    }
  };

  // dedupe: skip when a job with the same name is already queued or running.
  const enqueue = ({ name, label, lane = 'maintenance', exclusive = false, trigger = 'schedule', stationIds = null, dedupe = true, buildSteps }) => {
    if (stopping) return null;
    if (dedupe && [...active.values()].some((job) => job.name === name)) {
      logger.info({ job: name }, 'job skipped: already queued or running');
      return null;
    }
    const job = {
      id: null,
      name,
      label: label || name,
      lane: exclusive ? 'exclusive' : lane,
      trigger,
      stationIds,
      status: 'queued',
      queuedAt: isoUtcNow(),
      startedAt: null,
      finishedAt: null,
      step: null,
      stepIndex: 0,
      stepCount: 0,
      child: null
    };
    const inserted = persist(() => db.prepare(`
      insert into job_runs(name, label, trigger, status, detail_json, queued_at_utc) values (?, ?, ?, 'queued', ?, ?)
    `).run(name, job.label, trigger, JSON.stringify({ stationIds, lane: job.lane }), job.queuedAt));
    job.id = inserted ? Number(inserted.lastInsertRowid) : `local-${(fallbackId += 1)}`;
    active.set(job.id, job);

    const jobLanes = exclusive ? LANES : [lane];
    const previous = Promise.all(jobLanes.map((laneName) => lanes.get(laneName)));
    const run = previous.then(() => execute(job, buildSteps));
    for (const laneName of jobLanes) lanes.set(laneName, run);
    return job;
  };

  const publicJob = (job) => ({
    id: job.id,
    name: job.name,
    label: job.label,
    lane: job.lane,
    trigger: job.trigger,
    stationIds: job.stationIds,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    step: job.step,
    stepIndex: job.stepIndex,
    stepCount: job.stepCount
  });

  const getStatus = ({ historyLimit = 40 } = {}) => {
    const jobs = [...active.values()].map(publicJob);
    const recent = persist(() => db.prepare(`
      select id, name, label, trigger, status, detail_json, error, queued_at_utc, started_at_utc, finished_at_utc, duration_ms
      from job_runs order by id desc limit ?
    `).all(historyLimit)) ?? [];
    return {
      running: jobs.filter((job) => job.status === 'running'),
      queued: jobs.filter((job) => job.status === 'queued'),
      recent: recent.map((row) => {
        let detail = null;
        try {
          detail = JSON.parse(row.detail_json || 'null');
        } catch {
          detail = null;
        }
        return { ...row, detail_json: undefined, stationIds: detail?.stationIds ?? null, lane: detail?.lane ?? null };
      })
    };
  };

  const inflightStationIds = () => {
    const ids = new Set();
    for (const job of active.values()) {
      for (const id of job.stationIds ?? []) ids.add(id);
    }
    return ids;
  };

  const stop = (timeoutMs) => {
    stopping = true;
    const running = [...children];
    if (!running.length) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      let remaining = running.length;
      for (const child of running) {
        child.once('exit', () => {
          remaining -= 1;
          if (remaining === 0) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.kill('SIGTERM');
      }
    });
  };

  return { enqueue, getStatus, inflightStationIds, stop };
}

const berlinYesterday = () => DateTime.now().setZone(BERLIN_TZ).minus({ days: 1 }).toISODate();
const berlinToday = () => DateTime.now().setZone(BERLIN_TZ).toISODate();
const berlinWeekStart = () => DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();

// Job catalogue shared by the scheduler and the admin "Jetzt starten" buttons.
export function createJobCatalog({ jobs, configPath, dbPath }) {
  const base = ['--config', configPath, '--db', dbPath];
  return {
    ingest(stationIds, { trigger = 'schedule', label, fast = false } = {}) {
      if (!stationIds.length) return null;
      return jobs.enqueue({
        name: 'ingest',
        label: label || (stationIds.length === 1 ? `Abruf: ${stationIds[0]}` : `Abruf: ${stationIds.length} Sender`),
        lane: fast ? 'ingest-fast' : 'ingest',
        trigger,
        stationIds,
        dedupe: false,
        buildSteps: () => [['ingest', [...base, '--stations', stationIds.join(',')]]]
      });
    },
    maintenance({ trigger = 'schedule' } = {}) {
      return jobs.enqueue({
        name: 'maintenance',
        label: 'Wartung + Tagesauswertung',
        trigger,
        buildSteps: () => [
          ['maintain-db', ['--db', dbPath]],
          ['evaluate-daily', [...base, '--date', berlinYesterday()]],
          ['evaluate-daily', [...base, '--date', berlinToday()]]
        ]
      });
    },
    daily({ trigger = 'schedule' } = {}) {
      return jobs.enqueue({
        name: 'daily',
        label: 'Coverage-Audit + Wochenreport',
        trigger,
        buildSteps: () => [
          ['audit-coverage', [...base, '--date', berlinYesterday()]],
          ['report', [...base, '--week-start', berlinWeekStart(), '--csv']]
        ]
      });
    },
    startup() {
      return jobs.enqueue({
        name: 'startup',
        label: 'Start: Wartung, Auswertung, Report',
        trigger: 'startup',
        buildSteps: () => [
          ['daily-job', [...base, '--skip-ingest', '--make-report', '--audit-coverage'], {
            YRPA_RELEASE_BACKFILL_DAILY_LOOKUPS: process.env.YRPA_RELEASE_BACKFILL_STARTUP_LOOKUPS || '260'
          }]
        ]
      });
    },
    charts({ trigger = 'schedule' } = {}) {
      return jobs.enqueue({
        name: 'charts',
        label: 'Charts abrufen (radiocharts.com)',
        trigger,
        buildSteps: () => [['fetch-charts', ['--db', dbPath]]]
      });
    },
    deezerBackfill({ trigger = 'manual' } = {}) {
      return jobs.enqueue({
        name: 'deezer-backfill',
        label: 'Deezer-Abgleich (500 Tracks)',
        trigger,
        buildSteps: () => [['backfill-deezer', ['--db', dbPath, '--no-dry-run', '--limit', '500']]]
      });
    },
    clearDb({ scope, stationId }) {
      return jobs.enqueue({
        name: 'clear-db',
        label: scope === 'station' ? `Daten löschen: ${stationId}` : 'Datenbank leeren',
        exclusive: true,
        trigger: 'manual',
        buildSteps: () => [['clear-db', ['--db', dbPath, '--scope', scope, '--yes', ...(stationId ? ['--station-id', stationId] : [])]]]
      });
    }
  };
}

export function stationDueInfo(station, status, settings, now = Date.now()) {
  const refreshMinutes = effectiveRefreshMinutes(station, settings);
  const lastStartedMs = status?.last_started_at_utc ? Date.parse(status.last_started_at_utc) : NaN;
  const nextDueMs = Number.isFinite(lastStartedMs) ? lastStartedMs + refreshMinutes * 60000 : now;
  // 30s tolerance so a 5-minute interval isn't pushed to 6 minutes by the minute tick.
  return { refreshMinutes, nextDueAtUtc: new Date(nextDueMs).toISOString(), due: nextDueMs - 30000 <= now };
}

export function initScheduler({ jobs, catalog, db, logger }) {
  const cron = require('node-cron');

  const checkDueStations = () => {
    try {
      const settings = getSettings(db);
      if (!settings.scheduler_enabled) return;
      const statusById = new Map(listStationStatuses(db).map((row) => [row.station_id, row]));
      const inflight = jobs.inflightStationIds();
      const fast = [];
      const normal = [];
      for (const station of listStationConfigs(db)) {
        if (inflight.has(station.id)) continue;
        const info = stationDueInfo(station, statusById.get(station.id), settings);
        if (!info.due) continue;
        (info.refreshMinutes <= FAST_LANE_MAX_MINUTES ? fast : normal).push(station.id);
      }
      catalog.ingest(fast, { fast: true });
      catalog.ingest(normal);
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'scheduler due check failed');
    }
  };

  const whenEnabled = (fn) => () => {
    try {
      if (getSettings(db).scheduler_enabled) fn();
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'scheduler task failed');
    }
  };

  const tasks = {
    dueCheck: cron.schedule(SCHEDULES.dueCheck, checkDueStations, { timezone: BERLIN_TZ }),
    maintenance: cron.schedule(SCHEDULES.maintenance, whenEnabled(() => catalog.maintenance()), { timezone: BERLIN_TZ }),
    charts: cron.schedule(SCHEDULES.charts, whenEnabled(() => catalog.charts()), { timezone: BERLIN_TZ }),
    daily: cron.schedule(SCHEDULES.daily, whenEnabled(() => catalog.daily()), { timezone: BERLIN_TZ })
  };
  logger.info({ ...SCHEDULES, timezone: BERLIN_TZ }, 'scheduler initialised');

  const nextRuns = () => Object.fromEntries(Object.entries(tasks).map(([name, task]) => {
    const next = typeof task.getNextRun === 'function' ? task.getNextRun() : null;
    return [name, next ? new Date(next).toISOString() : null];
  }));

  return {
    checkDueStations,
    nextRuns,
    stop: () => Object.values(tasks).forEach((task) => task.stop())
  };
}
