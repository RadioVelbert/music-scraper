import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDb, insertPlayIgnore } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import { createApiApp } from '../src/api.js';

const cleanups = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function startApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-admin-api-'));
  const dbPath = path.join(tmp, 'api.sqlite');
  const configPath = path.join(tmp, 'config.yaml');
  fs.writeFileSync(configPath, [
    'stations:',
    '  - id: "alpha"',
    '    name: "Alpha FM"',
    '    playlist_url: "https://onlineradiobox.com/de/alpha/playlist/"',
    '    parser: "onlineradiobox"',
    '  - id: "velbert"',
    '    name: "RadioVelbert"',
    '    playlist_url: "https://api.laut.fm/station/radiovelbert/last_songs"',
    '    parser: "lautfm_json"'
  ].join('\n'));

  const db = openDb(dbPath);
  db.prepare("insert into stations(id, name, url, timezone) values ('alpha', 'Alpha FM', 'u', 'Europe/Berlin')").run();
  const n = normalizeArtistTitle('MEN AT WORK', 'DOWN UNDER');
  insertPlayIgnore(db, {
    station_id: 'alpha', played_at_utc: new Date().toISOString(), artist_raw: 'MEN AT WORK', title_raw: 'DOWN UNDER',
    artist: n.artist, title: n.title, track_key: n.trackKey, source_url: 'u', ingested_at_utc: new Date().toISOString()
  });
  db.close();

  const app = createApiApp({ configPath, dbPath, logger: pino({ level: 'silent' }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.closeApiDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, trackKey: n.trackKey, dbPath };
}

describe('admin API', () => {
  it('seeds stations, reports status and database stats', async () => {
    const { call } = await startApp();
    const overview = await call('GET', '/api/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.db.plays).toBe(1);
    expect(overview.body.db.totalBytes).toBeGreaterThan(0);
    expect(overview.body.db.tables.find((t) => t.name === 'plays').rows).toBe(1);
    const byId = Object.fromEntries(overview.body.stations.map((s) => [s.id, s]));
    expect(byId.alpha).toMatchObject({ configured: true, enabled: true, sourceType: 'onlineradiobox', refreshMinutes: 60, plays: 1 });
    expect(byId.velbert).toMatchObject({ sourceType: 'lautfm', refreshMinutes: 5 });
    expect(overview.body.settings.default_refresh_minutes).toBe(60);
  });

  it('creates, updates, toggles and deletes stations', async () => {
    const { call } = await startApp();
    const created = await call('POST', '/api/admin/stations', {
      id: 'neandertal', name: 'Radio Neandertal', parser: 'json', json: { time_path: 'timeslot_iso' },
      playlist_url: 'https://example.test/title?from={from:yyyy-MM-dd HH:mm:ss}&to={to:yyyy-MM-dd HH:mm:ss}', refresh_minutes: 30
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: 'neandertal', enabled: true, refresh_minutes: 30 });

    expect((await call('POST', '/api/admin/stations', { id: 'neandertal', name: 'X', playlist_url: 'u', parser: 'json' })).status).toBe(400);
    expect((await call('PUT', '/api/admin/stations/neandertal', { id: 'other', name: 'X', playlist_url: 'u', parser: 'json' })).status).toBe(400);
    expect((await call('PUT', '/api/admin/stations/unknown', { name: 'X', playlist_url: 'u', parser: 'json' })).status).toBe(404);

    const updated = await call('PUT', '/api/admin/stations/neandertal', { ...created.body, name: 'Radio Neandertal 2' });
    expect(updated.body.name).toBe('Radio Neandertal 2');

    const disabled = await call('PATCH', '/api/admin/stations/neandertal/enabled', { enabled: false });
    expect(disabled.body.enabled).toBe(false);

    const stations = await call('GET', '/api/admin/stations');
    expect(stations.body.find((s) => s.id === 'neandertal')).toMatchObject({ timeWindow: true, refreshOverridden: true, enabled: false });

    expect((await call('DELETE', '/api/admin/stations/neandertal?deleteData=1')).body).toMatchObject({ deleteData: true });
    expect((await call('GET', '/api/admin/stations')).body.some((s) => s.id === 'neandertal')).toBe(false);
  });

  it('validates settings and needs the job system for jobs and clearing', async () => {
    const { call } = await startApp();
    expect((await call('PUT', '/api/admin/settings', { track_hour_start: 30 })).status).toBe(400);
    expect((await call('PUT', '/api/admin/settings', { lautfm_refresh_minutes: 3 })).body.lautfm_refresh_minutes).toBe(3);
    expect((await call('POST', '/api/admin/jobs/maintenance/run')).status).toBe(503);
    expect((await call('POST', '/api/admin/db/clear', { scope: 'all', confirm: 'nein' })).status).toBe(503);
  });

  it('loads every track with limit=all (the API default is 100)', async () => {
    const { call, dbPath } = await startApp();
    const db = openDb(dbPath);
    for (let i = 0; i < 130; i += 1) {
      const n = normalizeArtistTitle(`Artist ${i}`, `Song ${i}`);
      insertPlayIgnore(db, {
        station_id: 'alpha', played_at_utc: new Date(Date.now() - i * 60000).toISOString(), artist_raw: `Artist ${i}`, title_raw: `Song ${i}`,
        artist: n.artist, title: n.title, track_key: n.trackKey, source_url: 'u', ingested_at_utc: new Date().toISOString()
      });
    }
    db.close();
    expect((await call('GET', '/api/tracks')).body).toHaveLength(100);
    expect((await call('GET', '/api/tracks?limit=1000')).body).toHaveLength(131);
    expect((await call('GET', '/api/tracks?limit=all')).body).toHaveLength(131);
  });

  it('resolves "Mein Sender" from the configuration and caches comparisons for an hour', async () => {
    const { call } = await startApp();
    // config.yaml has no my_station flag yet
    expect((await call('GET', '/api/my-station')).body).toEqual({ station: null });
    expect((await call('PUT', '/api/my-station', { stationId: 'nope' })).status).toBe(404);

    expect((await call('PUT', '/api/my-station', { stationId: 'alpha' })).body.station).toMatchObject({ id: 'alpha', name: 'Alpha FM' });
    expect((await call('GET', '/api/my-station')).body.station.id).toBe('alpha');

    const first = await call('GET', '/api/my-station/overview?days=7');
    expect(first.body).toMatchObject({ my_station_id: 'alpha', my_plays: 1, cache: { cached: false } });
    const second = await call('GET', '/api/my-station/overview?days=7');
    expect(second.body.cache).toMatchObject({ cached: true, computedAt: first.body.cache.computedAt });
    expect(Date.parse(second.body.cache.expiresAt) - Date.parse(second.body.cache.computedAt)).toBe(60 * 60 * 1000);
    // Other filters are cached separately.
    expect((await call('GET', '/api/my-station/overview?days=14')).body.cache.cached).toBe(false);

    // Switching "Mein Sender" must not serve the old station's cached comparison.
    await call('PUT', '/api/my-station', { stationId: 'velbert' });
    const switched = await call('GET', '/api/my-station/overview?days=7');
    expect(switched.body).toMatchObject({ my_station_id: 'velbert', my_plays: 0, cache: { cached: false } });
    const stations = (await call('GET', '/api/admin/stations')).body;
    expect(stations.filter((s) => s.config?.my_station).map((s) => s.id)).toEqual(['velbert']);
  });

  it('applies the custom station order to all station lists', async () => {
    const { call } = await startApp();
    expect((await call('GET', '/api/stations')).body.map((s) => s.id)).toEqual(['alpha', 'velbert']);

    const saved = await call('PUT', '/api/admin/stations/order', { ids: ['velbert', 'alpha'] });
    expect(saved.status).toBe(200);
    expect((await call('GET', '/api/stations')).body.map((s) => s.id)).toEqual(['velbert', 'alpha']);
    expect((await call('GET', '/api/admin/stations')).body.map((s) => s.id)).toEqual(['velbert', 'alpha']);

    // New stations are appended at the end.
    await call('POST', '/api/admin/stations', { id: 'aaa', name: 'AAA Radio', playlist_url: 'u', parser: 'json' });
    expect((await call('GET', '/api/stations')).body.map((s) => s.id)).toEqual(['velbert', 'alpha', 'aaa']);

    expect((await call('PUT', '/api/admin/stations/order', { ids: ['ghost'] })).status).toBe(400);
    expect((await call('PUT', '/api/admin/stations/order', {})).status).toBe(400);
  });

  it('returns display spellings in track lists', async () => {
    const { call, trackKey } = await startApp();
    const tracks = await call('GET', '/api/tracks?limit=10');
    expect(tracks.body.find((t) => t.track_key === trackKey)).toMatchObject({ artist: 'Men at Work', title: 'Down Under' });
  });
});
