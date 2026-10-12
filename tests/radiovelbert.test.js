import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDb, getTrackMetadata } from '../src/db.js';
import { JsonGenericParser } from '../src/parsers/jsonGeneric.js';
import { limitForWindow, resolveSourceUrl, hasTimeWindow, timeWindowStart } from '../src/sourceUrl.js';
import { isLikelyNoiseTrack, matchesBlockedTerm, normalizeArtistTitle } from '../src/normalize.js';
import { getSettings, updateSettings } from '../src/settings.js';
import { deleteStation, getStationConfig, saveStationConfig, syncStationsFromConfig } from '../src/stationStore.js';
import { runIngest, runNoisePlayCleanup } from '../src/services.js';
import { insertPlayIgnore } from '../src/db.js';

const logger = pino({ level: 'silent' });
const tmpDirs = [];

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-rv-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RV_MAPPING = {
  items_path: 'data',
  time_path: 'last_played',
  deezer_id_path: 'deezer_id',
  isrc_path: 'isrc',
  artwork_path: 'artwork'
};

const RV_PAYLOAD = {
  success: true,
  data: [
    { artist: 'Post Malone', title: 'Circles', deezer_id: 742744952, isrc: 'usum71915699', artwork: '/artwork/407.webp', last_played: '2026-10-12T10:52:49.000Z' },
    { artist: 'RadioVelbert', title: 'News Update', deezer_id: null, isrc: null, artwork: 'https://cms.radiovelbert.de/assets/x.webp', last_played: '2026-10-12T10:05:48.000Z' },
    { artist: 'Zara Larsson', title: 'Lush Life', deezer_id: 144389048, isrc: 'SEWEE1500509', artwork: '/artwork/551.webp', last_played: '2026-10-12T09:49:35.000Z' }
  ],
  meta: { count: 3 }
};

describe('{limit} placeholder for "last N songs" APIs', () => {
  it('requests only as many songs as the window needs, capped at the API maximum', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const url = 'https://api.radiovelbert.de/api/songs/history?limit={limit:200}';
    expect(hasTimeWindow(url)).toBe(true);
    // hourly run with 90 min lookback → 45 songs
    const hourly = timeWindowStart(now, { lookbackMinutes: 90, lastSuccessAtUtc: '2026-10-12T11:00:00Z' });
    expect(resolveSourceUrl(url, { from: hourly, to: now })).toBe('https://api.radiovelbert.de/api/songs/history?limit=45');
    // 5 h downtime → more, first run → capped at 200
    const catchUp = timeWindowStart(now, { lookbackMinutes: 90, lastSuccessAtUtc: '2026-10-12T07:00:00Z' });
    expect(resolveSourceUrl(url, { from: catchUp, to: now })).toBe('https://api.radiovelbert.de/api/songs/history?limit=158');
    const firstRun = timeWindowStart(now, { lookbackMinutes: 90 });
    expect(resolveSourceUrl(url, { from: firstRun, to: now })).toBe('https://api.radiovelbert.de/api/songs/history?limit=200');
    expect(limitForWindow(new Date(now - 5 * 60000), now)).toBe(10);
    expect(resolveSourceUrl('https://x.test/?count={limit}', { from: firstRun, to: now })).toBe('https://x.test/?count=500');
  });
});

describe('JSON parser extras', () => {
  it('reads Deezer ID, ISRC and resolves relative artwork against the API URL', () => {
    const parser = new JsonGenericParser({ json: RV_MAPPING });
    const plays = parser.parse(JSON.stringify(RV_PAYLOAD), 'https://api.radiovelbert.de/api/songs/history?limit=45');
    expect(plays[0]).toMatchObject({
      artistRaw: 'Post Malone',
      titleRaw: 'Circles',
      deezerId: '742744952',
      isrc: 'USUM71915699',
      artworkUrl: 'https://api.radiovelbert.de/artwork/407.webp'
    });
    expect(plays[1]).toMatchObject({ deezerId: null, isrc: null, artworkUrl: 'https://cms.radiovelbert.de/assets/x.webp' });
    // without mapping the extras are absent
    expect(new JsonGenericParser({ json: { items_path: 'data', time_path: 'last_played' } }).parse(JSON.stringify(RV_PAYLOAD), 'u')[0].deezerId).toBeUndefined();
  });
});

describe('blocked terms ("Immer ausfiltern")', () => {
  it('drops every entry containing a blocked term, regardless of spacing and case', () => {
    const terms = ['RadioVelbert'];
    expect(matchesBlockedTerm('Radio Velbert', 'Wetter', terms)).toBe(true);
    expect(matchesBlockedTerm('DJ Mike', 'RadioVelbert Mix', terms)).toBe(true);
    expect(matchesBlockedTerm('RADIO-VELBERT', 'Lokalnachrichten', terms)).toBe(true);
    expect(matchesBlockedTerm('Velbert Boys', 'Radio', terms)).toBe(false);
    expect(isLikelyNoiseTrack('Radio Velbert', 'Wetter', { blockedTerms: terms })).toBe(true);
    expect(isLikelyNoiseTrack('Radio Velbert', 'Wetter')).toBe(false);
  });

  it('is a setting with RadioVelbert as default and also cleans stored plays', () => {
    const tmp = mkTmp();
    const dbPath = path.join(tmp, 'n.sqlite');
    const db = openDb(dbPath);
    expect(getSettings(db).noise_terms).toEqual(['RadioVelbert']);
    db.prepare("insert into stations(id, name, url, timezone) values ('other', 'Other FM', 'u', 'Europe/Berlin')").run();
    const add = (artist, title) => {
      const n = normalizeArtistTitle(artist, title);
      insertPlayIgnore(db, { station_id: 'other', played_at_utc: '2026-10-12T10:00:00.000Z', artist_raw: artist, title_raw: title, artist: n.artist, title: n.title, track_key: n.trackKey, source_url: 'u', ingested_at_utc: '2026-10-12T10:00:00.000Z' });
    };
    add('Radio Velbert', 'Lokalnachrichten');
    add('Post Malone', 'Circles');
    updateSettings(db, { noise_terms: ['RadioVelbert', 'Werbung XY'] });
    db.close();

    runNoisePlayCleanup({ dbPath, logger });
    const check = openDb(dbPath);
    expect(check.prepare('select artist_raw from plays').all().map((r) => r.artist_raw)).toEqual(['Post Malone']);
    check.close();
  });
});

describe('config.yaml sync', () => {
  function writeConfig(file, stations) {
    const lines = ['stations:'];
    for (const s of stations) {
      lines.push(`  - id: "${s.id}"`, `    name: "${s.name}"`, `    playlist_url: "${s.url}"`, `    parser: "${s.parser || 'onlineradiobox'}"`);
      if (s.my) lines.push('    my_station: true');
    }
    fs.writeFileSync(file, lines.join('\n'));
  }

  it('imports new entries, updates unedited ones and keeps admin changes and deletions', () => {
    const tmp = mkTmp();
    const db = openDb(path.join(tmp, 's.sqlite'));
    const configPath = path.join(tmp, 'config.yaml');
    writeConfig(configPath, [
      { id: 'a', name: 'Alpha', url: 'https://a/v1', my: true },
      { id: 'b', name: 'Beta', url: 'https://b/v1' },
      { id: 'c', name: 'Gamma', url: 'https://c/v1' }
    ]);
    expect(syncStationsFromConfig(db, configPath)).toMatchObject({ imported: 3, updated: 0 });
    expect(syncStationsFromConfig(db, configPath)).toMatchObject({ imported: 0, updated: 0, unchanged: 3 });

    // Admin: edit Beta, delete Gamma, choose Beta as "Mein Sender"
    saveStationConfig(db, { ...getStationConfig(db, 'b'), refresh_minutes: 15, my_station: true });
    deleteStation(db, 'c');

    // config.yaml: all three change, a new station appears
    writeConfig(configPath, [
      { id: 'a', name: 'Alpha', url: 'https://a/v2', my: true },
      { id: 'b', name: 'Beta', url: 'https://b/v2' },
      { id: 'c', name: 'Gamma', url: 'https://c/v2' },
      { id: 'd', name: 'Delta', url: 'https://d/v1' }
    ]);
    expect(syncStationsFromConfig(db, configPath)).toMatchObject({ imported: 1, updated: 1, keptAdminChanges: 1, skippedDeleted: 1 });
    expect(getStationConfig(db, 'a').playlist_url).toBe('https://a/v2');
    // my_station unchanged in config.yaml → the admin choice (Beta) stays
    expect(getStationConfig(db, 'a').my_station).toBe(false);
    expect(getStationConfig(db, 'b')).toMatchObject({ playlist_url: 'https://b/v1', refresh_minutes: 15, my_station: true });
    expect(getStationConfig(db, 'c')).toBeNull();
    expect(getStationConfig(db, 'd').playlist_url).toBe('https://d/v1');

    // my_station changed in config.yaml → applied
    writeConfig(configPath, [
      { id: 'a', name: 'Alpha', url: 'https://a/v2' },
      { id: 'b', name: 'Beta', url: 'https://b/v2' },
      { id: 'c', name: 'Gamma', url: 'https://c/v2' },
      { id: 'd', name: 'Delta', url: 'https://d/v1', my: true }
    ]);
    syncStationsFromConfig(db, configPath);
    expect(getStationConfig(db, 'd').my_station).toBe(true);
    expect(getStationConfig(db, 'b').my_station).toBe(false);
    db.close();
  });

  it('updates stations imported before seeds were tracked (existing deployments)', () => {
    const tmp = mkTmp();
    const db = openDb(path.join(tmp, 'm.sqlite'));
    const configPath = path.join(tmp, 'config.yaml');
    saveStationConfig(db, { id: 'radiovelbert', name: 'RadioVelbert', playlist_url: 'https://api.laut.fm/station/radiovelbert/last_songs', parser: 'lautfm_json' }, { isNew: true });
    saveStationConfig(db, { id: 'juka', name: 'JUKA', playlist_url: 'https://j', parser: 'onlineradiobox', my_station: true }, { isNew: true });
    writeConfig(configPath, [
      { id: 'juka', name: 'JUKA', url: 'https://j' },
      { id: 'radiovelbert', name: 'RadioVelbert', url: 'https://api.radiovelbert.de/api/songs/history?limit={limit:200}', parser: 'json', my: true }
    ]);
    expect(syncStationsFromConfig(db, configPath)).toMatchObject({ updated: 2 });
    expect(getStationConfig(db, 'radiovelbert')).toMatchObject({ parser: 'json', my_station: true });
    expect(getStationConfig(db, 'juka').my_station).toBe(false);
    db.close();
  });
});

describe('ingest with Deezer IDs from the source', () => {
  it('stores the delivered Deezer identity without searching', async () => {
    const tmp = mkTmp();
    const dbPath = path.join(tmp, 'i.sqlite');
    const db = openDb(dbPath);
    const at = new Date();
    at.setUTCHours(10, 52, 0, 0);
    const payload = { data: [{ artist: 'Post Malone', title: 'Circles', deezer_id: 742744952, isrc: 'USUM71915699', artwork: 'https://api.radiovelbert.de/artwork/407.webp', last_played: at.toISOString() }] };
    saveStationConfig(db, {
      id: 'radiovelbert', name: 'RadioVelbert', parser: 'json', json: RV_MAPPING,
      playlist_url: `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`
    }, { isNew: true });
    db.close();

    // Verification on (as in production) – the Deezer ID path must not need the network.
    const env = { NODE_ENV: process.env.NODE_ENV, YRPA_VERIFY_ALL_TRACKS: process.env.YRPA_VERIFY_ALL_TRACKS };
    process.env.NODE_ENV = 'development';
    delete process.env.YRPA_VERIFY_ALL_TRACKS;
    try {
      await runIngest({ dbPath, stationIds: ['radiovelbert'], logger });
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.YRPA_VERIFY_ALL_TRACKS !== undefined) process.env.YRPA_VERIFY_ALL_TRACKS = env.YRPA_VERIFY_ALL_TRACKS;
    }

    const check = openDb(dbPath);
    const key = normalizeArtistTitle('Post Malone', 'Circles').trackKey;
    expect(getTrackMetadata(check, key)).toMatchObject({
      canonical_source: 'deezer',
      canonical_id: '742744952',
      isrc: 'USUM71915699',
      artwork_url: 'https://api.radiovelbert.de/artwork/407.webp'
    });
    expect(check.prepare('select artist, title, source from track_display where track_key = ?').get(key))
      .toEqual({ artist: 'Post Malone', title: 'Circles', source: 'deezer' });
    check.close();
  });
});
