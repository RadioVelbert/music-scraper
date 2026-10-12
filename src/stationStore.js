import fs from 'node:fs';
import { loadConfig, StationSchema } from './config.js';
import { isoUtcNow } from './time.js';

// Station configuration lives in the database (editable in the admin area).
// config.yaml only seeds an empty database and can be imported again from the admin area.

export function isLautfmStation(station) {
  return station?.parser === 'lautfm_json' || /^https?:\/\/api\.laut\.fm\//i.test(String(station?.playlist_url ?? ''));
}

export function lautfmLastSongsUrl(name) {
  return `https://api.laut.fm/station/${encodeURIComponent(String(name).trim().toLowerCase())}/last_songs`;
}

export function effectiveRefreshMinutes(station, settings) {
  if (Number.isInteger(station?.refresh_minutes)) return station.refresh_minutes;
  return isLautfmStation(station) ? settings.lautfm_refresh_minutes : settings.default_refresh_minutes;
}

function parseRow(row) {
  if (!row?.config_json) return null;
  try {
    return { ...StationSchema.parse(JSON.parse(row.config_json)), enabled: row.enabled !== 0 };
  } catch {
    return null;
  }
}

export const STATION_ORDER_SQL = 'sort_order is null, sort_order, name collate nocase';

export function listStationConfigs(db, { includeDisabled = false } = {}) {
  return db.prepare(`select id, config_json, enabled from stations where config_json is not null order by ${STATION_ORDER_SQL}`)
    .all()
    .map(parseRow)
    .filter((station) => station && (includeDisabled || station.enabled));
}

export function getStationConfig(db, id) {
  return parseRow(db.prepare('select id, config_json, enabled from stations where id = ?').get(id));
}

export function saveStationConfig(db, input, { isNew = false, enabled } = {}) {
  const { enabled: inputEnabled, ...rest } = input ?? {};
  const station = StationSchema.parse(rest);
  const existing = db.prepare('select id, config_json, enabled from stations where id = ?').get(station.id);
  if (isNew && existing?.config_json) {
    throw new Error(`Ein Sender mit der ID "${station.id}" existiert bereits.`);
  }
  const now = isoUtcNow();
  const enabledValue = enabled ?? inputEnabled ?? (existing ? existing.enabled !== 0 : true);

  db.transaction(() => {
    // Only one station can be "my station".
    if (station.my_station) {
      for (const other of listStationConfigs(db, { includeDisabled: true })) {
        if (other.id !== station.id && other.my_station) {
          const { enabled: _enabled, ...otherConfig } = other;
          db.prepare('update stations set config_json = ? where id = ?')
            .run(JSON.stringify({ ...otherConfig, my_station: false }), other.id);
        }
      }
    }
    // New stations are appended at the end of the custom order.
    db.prepare(`
      insert into stations(id, name, url, timezone, config_json, enabled, created_at_utc, updated_at_utc, sort_order)
      values (@id, @name, @url, @timezone, @config_json, @enabled, @now, @now,
        (select max(sort_order) + 1 from stations))
      on conflict(id) do update set
        name = excluded.name,
        url = excluded.url,
        timezone = excluded.timezone,
        config_json = excluded.config_json,
        enabled = excluded.enabled,
        created_at_utc = coalesce(stations.created_at_utc, excluded.created_at_utc),
        updated_at_utc = excluded.updated_at_utc
    `).run({
      id: station.id,
      name: station.name,
      url: station.playlist_url,
      timezone: station.timezone,
      config_json: JSON.stringify(station),
      enabled: enabledValue ? 1 : 0,
      now
    });
  })();
  return getStationConfig(db, station.id);
}

// ids: the new order (stations missing from the list keep their relative order after the listed ones).
export function setStationOrder(db, ids) {
  const order = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))];
  const known = new Set(db.prepare('select id from stations').all().map((row) => row.id));
  const unknown = order.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unbekannte Sender: ${unknown.join(', ')}`);
  const rest = db.prepare(`select id from stations order by ${STATION_ORDER_SQL}`).all()
    .map((row) => row.id)
    .filter((id) => !order.includes(id));
  const update = db.prepare('update stations set sort_order = ? where id = ?');
  db.transaction(() => {
    [...order, ...rest].forEach((id, index) => update.run(index, id));
  })();
  return [...order, ...rest];
}

export function setStationEnabled(db, id, enabled) {
  const result = db.prepare('update stations set enabled = ?, updated_at_utc = ? where id = ? and config_json is not null')
    .run(enabled ? 1 : 0, isoUtcNow(), id);
  if (!result.changes) throw new Error(`Unbekannter Sender: ${id}`);
  return getStationConfig(db, id);
}

// deleteData=false keeps the plays and only removes the configuration (station is no longer scraped).
export function deleteStation(db, id, { deleteData = false } = {}) {
  const row = db.prepare('select id from stations where id = ?').get(id);
  if (!row) throw new Error(`Unbekannter Sender: ${id}`);
  let deletedPlays = 0;
  db.transaction(() => {
    if (deleteData) {
      deletedPlays = db.prepare('delete from plays where station_id = ?').run(id).changes;
      db.prepare('delete from play_dedup_events where station_id = ?').run(id);
      db.prepare('delete from daily_track_stats where station_id = ?').run(id);
      db.prepare('delete from daily_station_stats where station_id = ?').run(id);
      db.prepare('delete from station_status where station_id = ?').run(id);
      db.prepare('delete from stations where id = ?').run(id);
    } else {
      db.prepare('update stations set config_json = null, enabled = 0, updated_at_utc = ? where id = ?').run(isoUtcNow(), id);
    }
  })();
  return { id, deleteData, deletedPlays };
}

export function importStationsFromConfig(db, configPath, { onlyIfEmpty = false } = {}) {
  if (!configPath || !fs.existsSync(configPath)) return { imported: 0, skipped: 0 };
  if (onlyIfEmpty) {
    const configured = db.prepare('select count(*) as c from stations where config_json is not null').get().c;
    if (configured > 0) return { imported: 0, skipped: 0 };
  }
  const config = loadConfig(configPath);
  let imported = 0;
  let skipped = 0;
  for (const station of config.stations) {
    if (getStationConfig(db, station.id)) {
      skipped += 1;
      continue;
    }
    saveStationConfig(db, station, { enabled: true });
    imported += 1;
  }
  return { imported, skipped };
}

// Stations used by ingest/report/evaluation. Seeds an empty database from config.yaml first.
export function loadStationConfigs(db, configPath, options) {
  importStationsFromConfig(db, configPath, { onlyIfEmpty: true });
  return listStationConfigs(db, options);
}
