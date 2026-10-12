import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

export const PARSER_IDS = [
  'dlf_nova',
  'fluxfm',
  'onlineradiobox',
  'generic_html_or_onlineradiobox',
  'generic_html',
  'nrwlokalradios_json',
  'lautfm_json',
  'radiomenu',
  'json'
];

// Field mapping for the configurable JSON parser. Paths use dot notation ("artist.name", "data.items").
export const JsonSourceSchema = z.object({
  items_path: z.string().trim().optional().default(''),
  artist_path: z.string().trim().optional().default('artist'),
  title_path: z.string().trim().min(1).default('title'),
  time_path: z.string().trim().min(1).default('timeslot'),
  // iso | unix | unix_ms | any Luxon format such as "yyyy-MM-dd HH:mm:ss"
  time_format: z.string().trim().min(1).default('iso'),
  filter_path: z.string().trim().optional().default(''),
  filter_value: z.string().trim().optional().default(''),
  // Used when artist_path is empty and the title field contains "Artist - Title"
  split_separator: z.string().optional().default(' - '),
  // Optional extras some APIs deliver (e.g. RadioVelbert): exact identity without a Deezer search, cover art.
  isrc_path: z.string().trim().optional().default(''),
  deezer_id_path: z.string().trim().optional().default(''),
  artwork_path: z.string().trim().optional().default(''),
  // Base for relative cover paths when the API is fetched via an internal address the browser can't reach.
  artwork_base_url: z.string().trim().optional().default('')
});

export const StationSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, 'ID: nur Kleinbuchstaben, Ziffern, "_" und "-"'),
  name: z.string().min(1),
  playlist_url: z.string().min(1),
  fallback_urls: z.array(z.string().min(1)).optional().default([]),
  parser: z.enum(PARSER_IDS),
  fetcher: z.enum(['http', 'playwright']).default('http'),
  timezone: z.string().min(1).default('Europe/Berlin'),
  enforce_one_play_per_minute: z.boolean().optional().default(false),
  min_play_gap_seconds: z.number().int().min(0).optional().default(0),
  min_daily_hours: z.number().int().min(1).max(24).optional().default(20),
  min_daily_plays: z.number().int().min(0).optional().default(24),
  my_station: z.boolean().optional().default(false),
  // Per-station override of the scheduler interval; unset = global default (laut.fm: 5 min).
  refresh_minutes: z.number().int().min(1).max(1440).optional(),
  // Time window for URLs with {from}/{to} placeholders.
  lookback_minutes: z.number().int().min(5).max(2880).optional(),
  json: JsonSourceSchema.optional()
});

const ConfigSchema = z.object({
  stations: z.array(StationSchema).min(1)
});

export function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = yaml.load(raw);
  return ConfigSchema.parse(parsed);
}
