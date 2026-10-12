import { isoUtcNow } from './time.js';

export function getStationStatus(db, stationId) {
  return db.prepare('select * from station_status where station_id = ?').get(stationId) ?? null;
}

export function listStationStatuses(db) {
  return db.prepare('select * from station_status').all();
}

export function markStationRunStarted(db, stationId) {
  db.prepare(`
    insert into station_status(station_id, last_started_at_utc) values (?, ?)
    on conflict(station_id) do update set last_started_at_utc = excluded.last_started_at_utc
  `).run(stationId, isoUtcNow());
}

// status: 'ok' (plays parsed), 'empty' (source reachable, nothing parsed) or 'error'
export function markStationRunFinished(db, stationId, { status, error = null, sourceUrl = null, playsFound = 0, playsInserted = 0, durationMs = 0 }) {
  const now = isoUtcNow();
  const success = status === 'ok';
  db.prepare(`
    insert into station_status(
      station_id, last_started_at_utc, last_finished_at_utc, last_success_at_utc, last_status, last_error, last_source_url,
      last_plays_found, last_plays_inserted, last_duration_ms, consecutive_failures, total_runs, total_inserted
    ) values (@stationId, @now, @now, @successAt, @status, @error, @sourceUrl, @playsFound, @playsInserted, @durationMs, @failures, 1, @playsInserted)
    on conflict(station_id) do update set
      last_finished_at_utc = excluded.last_finished_at_utc,
      last_success_at_utc = coalesce(excluded.last_success_at_utc, station_status.last_success_at_utc),
      last_status = excluded.last_status,
      last_error = excluded.last_error,
      last_source_url = coalesce(excluded.last_source_url, station_status.last_source_url),
      last_plays_found = excluded.last_plays_found,
      last_plays_inserted = excluded.last_plays_inserted,
      last_duration_ms = excluded.last_duration_ms,
      consecutive_failures = case when @success then 0 else station_status.consecutive_failures + 1 end,
      total_runs = station_status.total_runs + 1,
      total_inserted = station_status.total_inserted + excluded.last_plays_inserted
  `).run({
    stationId,
    now,
    successAt: success ? now : null,
    status,
    error,
    sourceUrl,
    playsFound,
    playsInserted,
    durationMs: Math.round(durationMs),
    failures: success ? 0 : 1,
    success: success ? 1 : 0
  });
}
