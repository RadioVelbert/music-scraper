import { z } from 'zod';
import { isoUtcNow } from './time.js';

// Global settings editable in the admin area. Env vars only provide the initial defaults.
const SettingsSchema = z.object({
  scheduler_enabled: z.boolean(),
  default_refresh_minutes: z.number().int().min(1).max(1440),
  lautfm_refresh_minutes: z.number().int().min(1).max(1440),
  track_hour_start: z.number().int().min(0).max(23),
  track_hour_end: z.number().int().min(0).max(23)
});

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? value : fallback;
}

export function defaultSettings() {
  return {
    scheduler_enabled: true,
    default_refresh_minutes: 60,
    lautfm_refresh_minutes: 5,
    track_hour_start: envInt('YRPA_TRACK_HOUR_START', 6),
    track_hour_end: envInt('YRPA_TRACK_HOUR_END', 20)
  };
}

export function getSettings(db) {
  const settings = defaultSettings();
  for (const row of db.prepare('select key, value_json from app_settings').all()) {
    if (!(row.key in settings)) continue;
    try {
      settings[row.key] = JSON.parse(row.value_json);
    } catch {
      // ignore corrupt values, keep default
    }
  }
  return SettingsSchema.parse(settings);
}

export function updateSettings(db, patch) {
  const next = SettingsSchema.parse({ ...getSettings(db), ...patch });
  const upsert = db.prepare(`
    insert into app_settings(key, value_json, updated_at_utc) values (?, ?, ?)
    on conflict(key) do update set value_json = excluded.value_json, updated_at_utc = excluded.updated_at_utc
  `);
  const now = isoUtcNow();
  db.transaction(() => {
    for (const [key, value] of Object.entries(next)) upsert.run(key, JSON.stringify(value), now);
  })();
  return next;
}
