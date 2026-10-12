#!/usr/bin/env node
import { Command } from 'commander';
import pino from 'pino';
import { DateTime } from 'luxon';
import { BERLIN_TZ } from './time.js';
import {
  runIngest,
  runReport,
  runDailyEvaluation,
  runStationReport,
  runCoverageAudit,
  runCanonicalArtistMaintenance,
  runItunesCanonicalMaintenance,
  runMergeDuplicateTracksMaintenance,
  runCanonicalMapRefreshMaintenance,
  runTrackOrientationMaintenance,
  runNoisePlayCleanup,
  runPromoMarkerMaintenance,
  runReleaseDateBackfillMaintenance,
  runAllMaintenance,
  runBackfillDeezer,
  runDisplayNamesMaintenance,
  clearDatabase
} from './services.js';
import { openDb, dedupeStationToOnePlayPerMinute, dedupeStationByMinGapSeconds } from './db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Explicit CLI flags win; the env vars let the Docker image (and `docker exec` sessions) use the volume paths without repeating them.
const DEFAULT_DB_PATH = process.env.DB_PATH || 'music-scraper.sqlite';
const DEFAULT_CONFIG_PATH = process.env.CONFIG_PATH || undefined;

const program = new Command();
program.name('music-scraper').description('Music Scraper').version('1.0.0');

function parseStationIds(value) {
  const ids = String(value ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

program
  .command('ingest')
  .requiredOption('--config <path>', 'Path to config.yaml (only used to seed an empty database)', DEFAULT_CONFIG_PATH)
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--stations <ids>', 'Comma-separated station ids (default: all enabled stations)')
  .action((opts) => {
    runIngest({ configPath: opts.config, dbPath: opts.db, stationIds: parseStationIds(opts.stations), logger }).catch((err) => {
      logger.error({ err: err.message }, 'ingest failed');
      process.exitCode = 1;
    });
  });

program
  .command('report')
  .requiredOption('--config <path>', 'Path to config.yaml', DEFAULT_CONFIG_PATH)
  .requiredOption('--week-start <YYYY-MM-DD>', 'Week start date in Europe/Berlin')
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--csv', 'Write CSV exports')
  .option('--gzip', 'Also write .gz compressed artifacts')
  .option('--gzip-only', 'Keep only .gz artifacts (remove plain .md/.csv)')
  .action((opts) => {
    try {
      runReport({
        configPath: opts.config,
        dbPath: opts.db,
        weekStart: opts.weekStart,
        csv: Boolean(opts.csv),
        gzip: Boolean(opts.gzip),
        gzipOnly: Boolean(opts.gzipOnly),
        logger
      });
    } catch (err) {
      logger.error({ err: err.message }, 'report failed');
      process.exitCode = 1;
    }
  });

program
  .command('report-station')
  .requiredOption('--config <path>', 'Path to config.yaml', DEFAULT_CONFIG_PATH)
  .requiredOption('--station-id <id>', 'Station id, e.g. dlf_nova')
  .requiredOption('--week-start <YYYY-MM-DD>', 'Week start date in Europe/Berlin')
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--gzip', 'Also write .gz compressed artifact')
  .option('--gzip-only', 'Keep only .gz artifact (remove plain .md)')
  .action((opts) => {
    try {
      runStationReport({
        configPath: opts.config,
        dbPath: opts.db,
        stationId: opts.stationId,
        weekStart: opts.weekStart,
        gzip: Boolean(opts.gzip),
        gzipOnly: Boolean(opts.gzipOnly),
        logger
      });
    } catch (err) {
      logger.error({ err: err.message }, 'station report failed');
      process.exitCode = 1;
    }
  });

program
  .command('evaluate-daily')
  .requiredOption('--config <path>', 'Path to config.yaml', DEFAULT_CONFIG_PATH)
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--date <YYYY-MM-DD>', 'Berlin date to evaluate (default: today in Europe/Berlin)')
  .action((opts) => {
    try {
      runDailyEvaluation({ configPath: opts.config, dbPath: opts.db, date: opts.date, logger });
    } catch (err) {
      logger.error({ err: err.message }, 'daily evaluation failed');
      process.exitCode = 1;
    }
  });

program
  .command('audit-coverage')
  .requiredOption('--config <path>', 'Path to config.yaml', DEFAULT_CONFIG_PATH)
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--date <YYYY-MM-DD>', 'Berlin day to audit (default: yesterday in Europe/Berlin)')
  .action((opts) => {
    try {
      runCoverageAudit({ configPath: opts.config, dbPath: opts.db, date: opts.date, logger });
    } catch (err) {
      logger.error({ err: err.message }, 'coverage audit failed');
      process.exitCode = 1;
    }
  });

program
  .command('maintain-db')
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--dry-run', 'Only report candidate merges, do not write changes')
  .option('--max-pairs <number>', 'Maximum swapped pairs to process in one run', '5000')
  .option('--min-score-gap <number>', 'Minimum score difference to merge a swapped pair', '0.35')
  .option('--min-play-ratio <number>', 'Minimum play-count ratio fallback for close scores', '1.2')
  .option('--release-max-lookups <number>', 'Maximum release metadata backfill lookups per run', '80')
  .option('--release-min-plays <number>', 'Minimum plays required for release metadata backfill candidates', '1')
  .option('--release-min-confidence <number>', 'Minimum release confidence target (0-1)', '0.55')
  .option('--release-stale-hours <number>', 'Minimum hours before a failed/missing metadata candidate is retried', '12')
  .action(async (opts) => {
    try {
      runNoisePlayCleanup({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        logger
      });
      runPromoMarkerMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      runItunesCanonicalMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      runCanonicalArtistMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      runMergeDuplicateTracksMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      if (!Boolean(opts.dryRun)) {
        runCanonicalMapRefreshMaintenance({
          dbPath: opts.db,
          logger
        });
      }
      const result = runTrackOrientationMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        minScoreGap: Number(opts.minScoreGap),
        minPlayRatio: Number(opts.minPlayRatio),
        logger
      });
      await runReleaseDateBackfillMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxLookups: Number(opts.releaseMaxLookups),
        minPlays: Number(opts.releaseMinPlays),
        minConfidence: Number(opts.releaseMinConfidence),
        staleHours: Number(opts.releaseStaleHours),
        includeChart: false,
        logger
      });
      if (!Boolean(opts.dryRun)) runDisplayNamesMaintenance({ dbPath: opts.db, logger });
      logger.info(result, 'database maintenance finished');
    } catch (err) {
      logger.error({ err: err.message }, 'database maintenance failed');
      process.exitCode = 1;
    }
  });

program
  .command('daily-job')
  .requiredOption('--config <path>', 'Path to config.yaml', DEFAULT_CONFIG_PATH)
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--make-report', 'Also generate weekly report for current week')
  .option('--audit-coverage', 'Also run coverage audit for yesterday (Europe/Berlin)')
  .option('--skip-ingest', 'Skip the ingest step (the API scheduler fetches stations itself)')
  .action(async (opts) => {
    (opts.skipIngest ? Promise.resolve() : runIngest({ configPath: opts.config, dbPath: opts.db, logger }))
      .then(async () => {
        await runAllMaintenance({
          dbPath: opts.db,
          releaseMaxLookups: Number(process.env.YRPA_RELEASE_BACKFILL_DAILY_LOOKUPS || 180),
          logger
        });
        const berlinYesterday = DateTime.now().setZone(BERLIN_TZ).minus({ days: 1 }).toISODate();
        runDailyEvaluation({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinYesterday,
          logger
        });

        if (opts.auditCoverage) {
          runCoverageAudit({
            configPath: opts.config,
            dbPath: opts.db,
            date: berlinYesterday,
            logger
          });
        }

        if (opts.makeReport) {
          const weekStart = DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
          runReport({ configPath: opts.config, dbPath: opts.db, weekStart, csv: true, logger });
        }
      })
      .catch((err) => {
        logger.error({ err: err.message }, 'daily job failed');
        process.exitCode = 1;
      });
  });

program
  .command('cleanup-station')
  .requiredOption('--station-id <id>', 'Station id, e.g. dlf_nova')
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--min-gap-seconds <number>', 'Minimum seconds between two counted plays', '60')
  .option('--one-per-minute', 'Legacy mode: keep only one play per minute')
  .action((opts) => {
    try {
      const db = openDb(opts.db);
      const result = opts.onePerMinute
        ? dedupeStationToOnePlayPerMinute(db, opts.stationId)
        : dedupeStationByMinGapSeconds(db, opts.stationId, Number(opts.minGapSeconds));
      db.close();
      logger.info({ stationId: opts.stationId, ...result }, 'station cleanup finished');
    } catch (err) {
      logger.error({ err: err.message }, 'station cleanup failed');
      process.exitCode = 1;
    }
  });

program
  .command('api')
  .requiredOption('--config <path>', 'Path to config.yaml', DEFAULT_CONFIG_PATH)
  .option('--db <path>', 'Path to SQLite database', process.env.DB_PATH || 'yrpa.sqlite')
  .option('--port <number>', 'API port', process.env.PORT || '8787')
  .option('--no-startup-report', 'Skip automatic ingest + evaluation + weekly report at API startup')
  .action(async (opts) => {
    try {
      // The startup ingest/evaluation/report runs in the background after the server is listening,
      // so health checks (Docker/Coolify) pass while the initial scrape is still running.
      const { startApiServer } = await import('./api.js');
      await startApiServer({
        configPath: opts.config,
        dbPath: opts.db,
        port: Number(opts.port),
        startupJob: Boolean(opts.startupReport)
      });
    } catch (err) {
      logger.error({ err: err.message }, 'api failed');
      process.exitCode = 1;
    }
  });

program
  .command('clear-db')
  .description('Delete collected data (station configuration, settings and blocked tracks are kept)')
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--scope <scope>', 'all | station', 'all')
  .option('--station-id <id>', 'Station id for --scope station')
  .option('--yes', 'Confirm deletion')
  .action((opts) => {
    if (!opts.yes) {
      logger.error('clear-db needs --yes to confirm');
      process.exitCode = 1;
      return;
    }
    try {
      clearDatabase({ dbPath: opts.db, scope: opts.scope, stationId: opts.stationId, logger });
    } catch (err) {
      logger.error({ err: err.message }, 'clear-db failed');
      process.exitCode = 1;
    }
  });

program
  .command('backfill-deezer')
  .option('--db <path>', 'Path to SQLite database', DEFAULT_DB_PATH)
  .option('--dry-run', 'Print planned changes without writing anything (default: true for safety)')
  .option('--no-dry-run', 'Actually write changes to the database')
  .option('--limit <number>', 'Maximum number of tracks to process in this run')
  .option('--cache-days <number>', 'Skip tracks whose Deezer result is younger than this many days', '30')
  .action(async (opts) => {
    const dryRun = opts.dryRun !== false;
    try {
      const stats = await runBackfillDeezer({
        dbPath: opts.db,
        dryRun,
        limit: opts.limit != null ? Number(opts.limit) : null,
        cacheDays: Number(opts.cacheDays) || 30,
        logger
      });
      logger.info(stats, dryRun ? 'backfill-deezer dry-run complete' : 'backfill-deezer complete');
    } catch (err) {
      logger.error({ err: err.message }, 'backfill-deezer failed');
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
