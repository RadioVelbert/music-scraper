import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDb, insertPlayIgnore } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import { JsonGenericParser, getPath } from '../src/parsers/jsonGeneric.js';
import { hasTimeWindow, resolveSourceUrl, timeWindowStart } from '../src/sourceUrl.js';
import { applyDisplayNames, buildDisplayName, runDisplayNameMaintenance, smartTitleCase } from '../src/displayNames.js';
import {
  deleteStation,
  effectiveRefreshMinutes,
  getStationConfig,
  importStationsFromConfig,
  listStationConfigs,
  saveStationConfig,
  setStationEnabled
} from '../src/stationStore.js';
import { getSettings, updateSettings } from '../src/settings.js';
import { runIngest, previewStationSource } from '../src/services.js';
import { stationDueInfo } from '../src/jobs.js';

const logger = pino({ level: 'silent' });
const tmpDirs = [];

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-admin-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function jsonDataUrl(payload) {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

const NRW_ROWS = [
  { artist: 'PURPLE DISCO MACHINE X KUNGS', title: 'SUBSTITUTION', timeslot: '2026-10-12 20:56:33', timeslot_iso: '2026-10-12T20:56:33+02:00' },
  { artist: 'MEN AT WORK', title: 'DOWN UNDER', timeslot: '2026-10-12 20:52:52', timeslot_iso: '2026-10-12T20:52:52+02:00' }
];

describe('JsonGenericParser', () => {
  it('maps NRW-Lokalradio rows with ISO timestamps', () => {
    const parser = new JsonGenericParser({ timezone: 'Europe/Berlin', json: { time_path: 'timeslot_iso' } });
    const plays = parser.parse(JSON.stringify(NRW_ROWS), 'https://example.test');
    expect(plays).toHaveLength(2);
    expect(plays[0]).toMatchObject({ artistRaw: 'PURPLE DISCO MACHINE X KUNGS', titleRaw: 'SUBSTITUTION' });
    expect(plays[0].playedAt.toISOString()).toBe('2026-10-12T18:56:33.000Z');
  });

  it('interprets local timestamps without offset in the station timezone', () => {
    const parser = new JsonGenericParser({ timezone: 'Europe/Berlin', json: { time_path: 'timeslot', time_format: 'yyyy-MM-dd HH:mm:ss' } });
    const plays = parser.parse(JSON.stringify(NRW_ROWS), 'https://example.test');
    expect(plays[1].playedAt.toISOString()).toBe('2026-10-12T18:52:52.000Z');
  });

  it('supports nested paths, filters and laut.fm time format', () => {
    const payload = {
      data: [
        { title: 'Mann muss', started_at: '2026-10-12 21:10:03 +0200', artist: { name: 'Apache 207' }, type: 'song' },
        { title: 'Werbung', started_at: '2026-10-12 21:13:00 +0200', artist: { name: 'Radio' }, type: 'ad' }
      ]
    };
    const parser = new JsonGenericParser({
      json: {
        items_path: 'data',
        artist_path: 'artist.name',
        time_path: 'started_at',
        time_format: 'yyyy-MM-dd HH:mm:ss ZZZ',
        filter_path: 'type',
        filter_value: 'song'
      }
    });
    const plays = parser.parse(JSON.stringify(payload), 'u');
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ artistRaw: 'Apache 207', titleRaw: 'Mann muss' });
    expect(plays[0].playedAt.toISOString()).toBe('2026-10-12T19:10:03.000Z');
  });

  it('splits combined "Artist - Title" fields and unix timestamps', () => {
    const parser = new JsonGenericParser({ json: { artist_path: '', title_path: 'song', time_path: 'ts', time_format: 'unix' } });
    const plays = parser.parse(JSON.stringify([{ song: 'Daft Punk - One More Time', ts: 1791000000 }]), 'u');
    expect(plays[0]).toMatchObject({ artistRaw: 'Daft Punk', titleRaw: 'One More Time' });
    expect(plays[0].playedAt.getTime()).toBe(1791000000 * 1000);
  });

  it('reports invalid JSON and missing lists clearly', () => {
    const parser = new JsonGenericParser({ json: { items_path: 'items' } });
    expect(() => parser.parse('<html>', 'u')).toThrow('kein gültiges JSON');
    expect(() => parser.parse('{"items": 5}', 'u')).toThrow('keine Liste');
    expect(getPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1);
  });
});

describe('time window URLs', () => {
  it('fills {from:FORMAT}/{to:FORMAT} in the station timezone', () => {
    const template = 'https://x.test/playlist/title?req_station=29&datefrom={from:yyyy-MM-dd HH:mm:ss}&dateto={to:yyyy-MM-dd%20HH:mm:ss}&ts={to_unix}';
    expect(hasTimeWindow(template)).toBe(true);
    expect(hasTimeWindow('https://x.test/latest?count=500')).toBe(false);
    const url = resolveSourceUrl(template, {
      from: new Date('2026-10-12T18:00:00Z'),
      to: new Date('2026-10-12T19:59:59Z'),
      timezone: 'Europe/Berlin'
    });
    expect(url).toBe('https://x.test/playlist/title?req_station=29&datefrom=2026-10-12%2020%3A00%3A00&dateto=2026-10-12%2021%3A59%3A59&ts=1791835199');
  });

  it('extends the lookback after downtime, capped at 48h', () => {
    const now = new Date('2026-10-12T20:00:00Z');
    const minutesBack = (date) => (now.getTime() - date.getTime()) / 60000;
    expect(minutesBack(timeWindowStart(now, { lookbackMinutes: 120, lastSuccessAtUtc: '2026-10-12T19:00:00Z' }))).toBe(120);
    expect(minutesBack(timeWindowStart(now, { lookbackMinutes: 120, lastSuccessAtUtc: '2026-10-12T14:00:00Z' }))).toBe(375);
    expect(minutesBack(timeWindowStart(now, { lookbackMinutes: 120, lastSuccessAtUtc: '2026-10-01T00:00:00Z' }))).toBe(2880);
    expect(minutesBack(timeWindowStart(now, { lookbackMinutes: 120 }))).toBe(1440);
  });
});

describe('display names', () => {
  it('recovers casing from mixed-case sources and title-cases shouting sources', () => {
    const shouting = normalizeArtistTitle('MEN AT WORK', 'DOWN UNDER');
    expect(buildDisplayName({ artistNorm: shouting.artist, titleNorm: shouting.title, artistSources: ['MEN AT WORK'], titleSources: ['DOWN UNDER'] }))
      .toMatchObject({ artist: 'Men at Work', title: 'Down Under', hasCasingSource: false });

    const mixed = normalizeArtistTitle('Marshmello, Jonas Brothers', 'Leave Before You Love Me (Radio Edit)');
    const display = buildDisplayName({
      artistNorm: mixed.artist,
      titleNorm: mixed.title,
      artistSources: ['MARSHMELLO', 'Marshmello, Jonas Brothers'],
      titleSources: ['Leave Before You Love Me (Radio Edit)']
    });
    expect(display.title).toBe('Leave Before You Love Me');
    expect(display.artist).toContain('Marshmello');
    expect(display.artist).toContain('Jonas Brothers');
    expect(smartTitleCase('dj antoine')).toBe('DJ Antoine');
    expect(smartTitleCase('jay-z')).toBe('JAY-Z');
    expect(smartTitleCase('ac-dc')).toBe('AC/DC');
    expect(smartTitleCase('bon jovi')).toBe('Bon Jovi');
  });

  it('maintains track_display from raw plays and decorates API rows', () => {
    const tmp = mkTmp();
    const db = openDb(path.join(tmp, 'd.sqlite'));
    db.prepare("insert into stations(id, name, url, timezone) values ('s', 'S', 'u', 'Europe/Berlin')").run();
    const add = (artistRaw, titleRaw, at) => {
      const n = normalizeArtistTitle(artistRaw, titleRaw);
      insertPlayIgnore(db, {
        station_id: 's', played_at_utc: at, artist_raw: artistRaw, title_raw: titleRaw,
        artist: n.artist, title: n.title, track_key: n.trackKey, source_url: 'u', ingested_at_utc: at
      });
      return n;
    };
    const n = add('TAYLOR SWIFT', 'PATIENT ZERO', '2026-10-12T10:00:00.000Z');
    add('Taylor Swift', 'Patient Zero', '2026-10-12T11:00:00.000Z');

    const result = runDisplayNameMaintenance({ db, logger });
    expect(result.updated).toBe(1);
    const rows = applyDisplayNames(db, [{ track_key: n.trackKey, artist: n.artist, title: n.title }, { artist: n.artist, plays: 2 }]);
    expect(rows[0]).toMatchObject({ artist: 'Taylor Swift', title: 'Patient Zero' });
    expect(rows[1].artist).toBe('Taylor Swift');
    // A row for an unknown key still gets readable casing.
    expect(applyDisplayNames(db, { trackKey: 'x', identity: { artist: 'the weeknd', title: 'blinding lights' } }).identity)
      .toEqual({ artist: 'The Weeknd', title: 'Blinding Lights' });
    db.close();
  });
});

describe('station store', () => {
  it('seeds from config.yaml once and manages stations', () => {
    const tmp = mkTmp();
    const db = openDb(path.join(tmp, 's.sqlite'));
    const configPath = path.join(tmp, 'config.yaml');
    fs.writeFileSync(configPath, [
      'stations:',
      '  - id: "a"', '    name: "Alpha"', '    playlist_url: "https://onlineradiobox.com/de/a/playlist/"', '    parser: "onlineradiobox"', '    my_station: true',
      '  - id: "b"', '    name: "Beta"', '    playlist_url: "https://api.laut.fm/station/beta/last_songs"', '    parser: "lautfm_json"'
    ].join('\n'));

    expect(importStationsFromConfig(db, configPath, { onlyIfEmpty: true })).toEqual({ imported: 2, skipped: 0 });
    expect(importStationsFromConfig(db, configPath, { onlyIfEmpty: true })).toEqual({ imported: 0, skipped: 0 });

    expect(() => saveStationConfig(db, { id: 'a', name: 'X', playlist_url: 'u', parser: 'json' }, { isNew: true })).toThrow('existiert bereits');
    expect(() => saveStationConfig(db, { id: 'Bad Id', name: 'X', playlist_url: 'u', parser: 'json' }, { isNew: true })).toThrow();

    saveStationConfig(db, { id: 'c', name: 'Gamma', playlist_url: 'u', parser: 'json', my_station: true, refresh_minutes: 15 }, { isNew: true });
    expect(getStationConfig(db, 'a').my_station).toBe(false);
    expect(getStationConfig(db, 'c').my_station).toBe(true);

    const settings = getSettings(db);
    expect(effectiveRefreshMinutes(getStationConfig(db, 'a'), settings)).toBe(60);
    expect(effectiveRefreshMinutes(getStationConfig(db, 'b'), settings)).toBe(5);
    expect(effectiveRefreshMinutes(getStationConfig(db, 'c'), settings)).toBe(15);
    updateSettings(db, { default_refresh_minutes: 30 });
    expect(effectiveRefreshMinutes(getStationConfig(db, 'a'), getSettings(db))).toBe(30);
    expect(() => updateSettings(db, { default_refresh_minutes: 0 })).toThrow();

    setStationEnabled(db, 'b', false);
    expect(listStationConfigs(db).map((s) => s.id)).toEqual(['a', 'c']);
    expect(listStationConfigs(db, { includeDisabled: true })).toHaveLength(3);

    deleteStation(db, 'c');
    expect(getStationConfig(db, 'c')).toBeNull();
    expect(db.prepare("select count(*) as c from stations where id = 'c'").get().c).toBe(1);
    deleteStation(db, 'c', { deleteData: true });
    expect(db.prepare("select count(*) as c from stations where id = 'c'").get().c).toBe(0);
    db.close();
  });

  it('computes due times from the last start', () => {
    const settings = { default_refresh_minutes: 60, lautfm_refresh_minutes: 5 };
    const now = Date.parse('2026-10-12T12:00:00Z');
    const station = { id: 'a', parser: 'onlineradiobox', playlist_url: 'u' };
    expect(stationDueInfo(station, null, settings, now).due).toBe(true);
    expect(stationDueInfo(station, { last_started_at_utc: '2026-10-12T11:30:00Z' }, settings, now).due).toBe(false);
    expect(stationDueInfo(station, { last_started_at_utc: '2026-10-12T10:59:40Z' }, settings, now).due).toBe(true);
  });
});

describe('ingest with database stations', () => {
  it('fetches only requested stations and records their status and display names', async () => {
    const tmp = mkTmp();
    const dbPath = path.join(tmp, 'i.sqlite');
    const db = openDb(dbPath);
    const today = new Date();
    const at = (hour, minute) => {
      const d = new Date(today);
      d.setUTCHours(hour, minute, 0, 0);
      return d.toISOString();
    };
    saveStationConfig(db, {
      id: 'json_station',
      name: 'JSON Station',
      playlist_url: jsonDataUrl([
        { artist: 'MEN AT WORK', title: 'DOWN UNDER', timeslot_iso: at(10, 0) },
        { artist: 'Taylor Swift', title: 'Patient Zero', timeslot_iso: at(10, 5) }
      ]),
      parser: 'json',
      json: { time_path: 'timeslot_iso' }
    }, { isNew: true });
    saveStationConfig(db, {
      id: 'broken',
      name: 'Broken',
      playlist_url: 'data:application/json,not-json',
      parser: 'json'
    }, { isNew: true });
    db.close();

    process.env.NODE_ENV = 'test';
    await runIngest({ dbPath, stationIds: ['json_station'], logger });

    const check = openDb(dbPath);
    const status = check.prepare("select * from station_status where station_id = 'json_station'").get();
    expect(status).toMatchObject({ last_status: 'ok', last_plays_found: 2, last_plays_inserted: 2, consecutive_failures: 0, total_runs: 1 });
    expect(check.prepare("select count(*) as c from station_status where station_id = 'broken'").get().c).toBe(0);
    const display = check.prepare('select artist, title from track_display order by artist').all();
    expect(display).toEqual([{ artist: 'Men at Work', title: 'Down Under' }, { artist: 'Taylor Swift', title: 'Patient Zero' }]);
    check.close();

    await expect(runIngest({ dbPath, stationIds: ['broken'], logger })).rejects.toThrow('All stations failed');
    const after = openDb(dbPath);
    expect(after.prepare("select last_status, consecutive_failures from station_status where station_id = 'broken'").get())
      .toEqual({ last_status: 'error', consecutive_failures: 1 });
    after.close();
  });

  it('previews a source without writing', async () => {
    const preview = await previewStationSource({
      id: 'test', name: 'Test', timezone: 'Europe/Berlin', parser: 'json', fetcher: 'http', fallback_urls: [],
      playlist_url: jsonDataUrl(NRW_ROWS), json: { time_path: 'timeslot_iso' }
    }, { logger });
    expect(preview.ok).toBe(true);
    expect(preview.total).toBe(2);
    expect(preview.plays[0]).toMatchObject({ artistRaw: 'PURPLE DISCO MACHINE X KUNGS', titleRaw: 'SUBSTITUTION' });

    const failed = await previewStationSource({
      id: 'test', name: 'Test', timezone: 'Europe/Berlin', parser: 'json', fetcher: 'http', fallback_urls: [],
      playlist_url: 'data:application/json,%7B%7D', json: { items_path: 'items' }
    }, { logger });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('keine Liste');
  });
});
