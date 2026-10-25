import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, upsertStation, insertPlayIgnore } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import { addFavorite, updateFavorite, listFavorites, favoriteTrackKeys } from '../src/favorites.js';
import { listOwnStationPlays, listRisers, findMergeCandidates, ignoreMergePairs } from '../src/insights.js';

function mkDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-insights-test-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  for (const id of ['s1', 's2', 's3', 'own']) upsertStation(db, { id, name: id, playlist_url: 'https://example.test', timezone: 'Europe/Berlin' });
  return db;
}

function play(db, stationId, playedAt, artistRaw, titleRaw, { trackKey } = {}) {
  const n = normalizeArtistTitle(artistRaw, titleRaw);
  insertPlayIgnore(db, {
    station_id: stationId, played_at_utc: playedAt, artist_raw: artistRaw, title_raw: titleRaw,
    artist: n.artist, title: n.title, track_key: trackKey || n.trackKey, source_url: 'https://example.test', ingested_at_utc: playedAt
  });
  return trackKey || n.trackKey;
}

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

describe('favorite status and note', () => {
  it('walks through the statuses, keeps the note and syncs the legacy done flag', () => {
    const db = mkDb();
    const { favorite } = addFavorite(db, { artist: 'A', title: 'T', trackKey: 'k1' });
    expect(favorite.status).toBe('open');
    expect(updateFavorite(db, favorite.id, { status: 'requested', note: ' Promo-Mail raus ' })).toMatchObject({ status: 'requested', note: 'Promo-Mail raus', done: false });
    const done = updateFavorite(db, favorite.id, { status: 'in_programm' });
    expect(done).toMatchObject({ status: 'in_programm', done: true });
    expect(done.done_at_utc).toBeTruthy();
    expect(updateFavorite(db, favorite.id, { done: false })).toMatchObject({ status: 'open', note: 'Promo-Mail raus' });
    expect(() => updateFavorite(db, favorite.id, { status: 'kaputt' })).toThrow();
    expect(updateFavorite(db, 999, { status: 'open' })).toBeNull();
  });

  it('lists every id a favorite is known under', () => {
    const db = mkDb();
    addFavorite(db, { artist: 'A', title: 'T', trackKey: 'k1' });
    addFavorite(db, { artist: 'A feat. B', title: 'T (Radio Edit)', trackKey: 'k2' });
    const keys = favoriteTrackKeys(listFavorites(db));
    expect(keys).toEqual(expect.arrayContaining(['k1', 'k2']));
  });
});

describe('own station plays', () => {
  it('counts plays per track for the own station only', () => {
    const db = mkDb();
    const key = play(db, 'own', hoursAgo(5), 'Giant Rooks', 'Slow Dance');
    play(db, 'own', hoursAgo(2), 'Giant Rooks', 'Slow Dance');
    play(db, 's1', hoursAgo(1), 'Other', 'Song');
    const rows = listOwnStationPlays(db, 'own');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ track_key: key, plays: 2 });
    expect(listOwnStationPlays(db, null)).toEqual([]);
  });
});

describe('risers', () => {
  it('ranks songs that reached more stations than in the window before, and can hide own songs', () => {
    const db = mkDb();
    const rising = play(db, 's1', hoursAgo(10), 'Rising', 'Hit');
    play(db, 's2', hoursAgo(8), 'Rising', 'Hit');
    play(db, 's3', hoursAgo(6), 'Rising', 'Hit');
    const steady = play(db, 's1', hoursAgo(10), 'Steady', 'Song');
    play(db, 's2', hoursAgo(9), 'Steady', 'Song');
    play(db, 's1', hoursAgo(100), 'Steady', 'Song');
    play(db, 's2', hoursAgo(100), 'Steady', 'Song');
    play(db, 'own', hoursAgo(4), 'Rising', 'Hit');

    const all = listRisers(db, { days: 3, now: NOW, ownStationId: 'own' });
    expect(all.tracks.map((t) => t.track_key)).toEqual([rising]);
    expect(all.tracks[0]).toMatchObject({ stations_now: 4, stations_prev: 0, station_delta: 4, own_plays: 1, is_new: true });
    expect(all.tracks.some((t) => t.track_key === steady)).toBe(false);
    expect(listRisers(db, { days: 3, now: NOW, ownStationId: 'own', excludeOwn: true }).tracks).toHaveLength(0);
  });
});

describe('merge suggestions', () => {
  it('suggests tracks with the same title and overlapping artists, the busiest one wins', () => {
    const db = mkDb();
    const winner = play(db, 's1', hoursAgo(5), 'Calum Scott', 'Rise');
    play(db, 's2', hoursAgo(4), 'Calum Scott', 'Rise');
    const loser = play(db, 's3', hoursAgo(3), 'Calum Scott & Someone', 'Rise', { trackKey: 'other-id' });
    play(db, 's1', hoursAgo(2), 'Different Artist', 'Rise');

    const [suggestion, ...rest] = findMergeCandidates(db);
    expect(rest).toHaveLength(0);
    expect(suggestion.winner.track_key).toBe(winner);
    expect(suggestion.losers.map((l) => l.track_key)).toEqual([loser]);
    expect(suggestion.reason).toBe('name');
  });

  it('groups by ISRC and stops suggesting dismissed pairs', () => {
    const db = mkDb();
    const a = play(db, 's1', hoursAgo(5), 'Artist One', 'Alpha');
    play(db, 's2', hoursAgo(4), 'Artist One', 'Alpha');
    const b = play(db, 's1', hoursAgo(3), 'Totally Other', 'Beta');
    for (const key of [a, b]) {
      db.prepare('insert into track_metadata(track_key, artist, title, isrc, last_checked_utc) values (?,?,?,?,?)').run(key, 'x', 'y', 'DE1234567890', hoursAgo(1));
    }
    const [suggestion] = findMergeCandidates(db);
    expect(suggestion.reason).toBe('isrc');
    expect(suggestion.winner.track_key).toBe(a);

    ignoreMergePairs(db, a, [b]);
    expect(findMergeCandidates(db)).toHaveLength(0);
  });
});

describe('favorites bulk actions', () => {
  it('changes the status of many favorites at once and removes selected ones', async () => {
    const { bulkSetFavoriteStatus, removeFavoritesByIds } = await import('../src/favorites.js');
    const db = mkDb();
    const ids = ['One', 'Two', 'Three'].map((t) => addFavorite(db, { artist: 'A', title: t }).favorite.id);
    expect(bulkSetFavoriteStatus(db, [ids[0], ids[1], 9999, 'x'], 'requested')).toBe(2);
    expect(listFavorites(db).filter((f) => f.status === 'requested')).toHaveLength(2);
    expect(bulkSetFavoriteStatus(db, ids, 'in_programm')).toBe(3);
    expect(listFavorites(db).every((f) => f.done)).toBe(true);
    expect(() => bulkSetFavoriteStatus(db, ids, 'kaputt')).toThrow();
    expect(removeFavoritesByIds(db, [ids[0], ids[2], 123456])).toBe(2);
    expect(listFavorites(db)).toHaveLength(1);
    expect(removeFavoritesByIds(db, [])).toBe(0);
  });
});
