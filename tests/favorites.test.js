import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addFavorite, listFavorites, removeFavoriteBySongKey, clearFavorites, lookupSongKeys } from '../src/favorites.js';

function mkDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-fav-test-'));
  return openDb(path.join(dir, 'test.sqlite'));
}

describe('favorites', () => {
  it('adds a song once and merges spelling variants into it', () => {
    const db = mkDb();
    const first = addFavorite(db, { artist: 'Giant Rooks', title: 'Slow Dance', trackKey: 'a' });
    const second = addFavorite(db, { artist: 'GIANT ROOKS feat. Someone', title: 'Slow Dance (Radio Edit)', trackKey: 'b' });
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    const list = listFavorites(db);
    expect(list).toHaveLength(1);
    expect(list[0].duplicate_count).toBe(1);
    expect(list[0].variants[0].track_key).toBe('b');
  });

  it('recognises a known track_key even when the spelling differs completely', () => {
    const db = mkDb();
    addFavorite(db, { artist: 'Artist One', title: 'Song', trackKey: 'same-id' });
    expect(addFavorite(db, { artist: 'Totally Different', title: 'Name', trackKey: 'same-id' }).added).toBe(false);
  });

  it('does not count the identical click twice as a new variant', () => {
    const db = mkDb();
    addFavorite(db, { artist: 'A', title: 'T', trackKey: 'k' });
    addFavorite(db, { artist: 'A', title: 'T', trackKey: 'k' });
    expect(listFavorites(db)[0].duplicate_count).toBe(0);
  });

  it('rejects empty artist or title', () => {
    expect(() => addFavorite(mkDb(), { artist: '', title: 'x' })).toThrow();
  });

  it('removes one song by key and clears everything', () => {
    const db = mkDb();
    addFavorite(db, { artist: 'A', title: 'One' });
    addFavorite(db, { artist: 'B', title: 'Two' });
    const [key] = lookupSongKeys([{ artist: 'A', title: 'One' }]);
    expect(removeFavoriteBySongKey(db, key)).toBe(1);
    expect(listFavorites(db)).toHaveLength(1);
    expect(clearFavorites(db)).toBe(1);
    expect(listFavorites(db)).toHaveLength(0);
  });
});

describe('favorites done flag', () => {
  it('marks a favorite as processed and back', async () => {
    const { setFavoriteDone } = await import('../src/favorites.js');
    const db = mkDb();
    const { favorite } = addFavorite(db, { artist: 'A', title: 'T' });
    expect(favorite.done).toBe(false);
    const done = setFavoriteDone(db, favorite.id, true);
    expect(done.done).toBe(true);
    expect(done.done_at_utc).toBeTruthy();
    expect(setFavoriteDone(db, favorite.id, false).done).toBe(false);
    expect(setFavoriteDone(db, 9999, true)).toBeNull();
  });
});

describe('favorites csv export', () => {
  it('exports artist, title, isrc, release date, duration and total plays', async () => {
    const { buildFavoritesCsv } = await import('../src/favorites.js');
    const { upsertTrackMetadata, insertPlayIgnore, upsertStation } = await import('../src/db.js');
    const { normalizeArtistTitle } = await import('../src/normalize.js');
    const db = mkDb();
    const n = normalizeArtistTitle('Giant Rooks', 'Slow Dance');
    upsertStation(db, { id: 's1', name: 'S1', playlist_url: 'https://example.test', timezone: 'Europe/Berlin' });
    for (const minute of ['10:00', '11:00']) {
      insertPlayIgnore(db, {
        station_id: 's1', played_at_utc: `2026-02-25T${minute}:00.000Z`, artist_raw: 'Giant Rooks', title_raw: 'Slow Dance',
        artist: n.artist, title: n.title, track_key: n.trackKey, source_url: 'https://example.test', ingested_at_utc: '2026-02-25T12:00:00.000Z'
      });
    }
    db.prepare('insert into track_metadata(track_key, artist, title, isrc, release_date_utc, duration_ms, last_checked_utc) values (?,?,?,?,?,?,?)')
      .run(n.trackKey, n.artist, n.title, 'DEABC1234567', '2025-03-07T00:00:00.000Z', 215000, '2026-02-25T00:00:00.000Z');
    addFavorite(db, { artist: 'Giant Rooks', title: '=Slow Dance', trackKey: n.trackKey });
    addFavorite(db, { artist: 'Giant Rooks', title: 'Slow Dance' });
    const csv = await buildFavoritesCsv(db, { enrich: false });
    expect(csv.startsWith('﻿Artist;Title;ISRC;Release Date;Dauer;Gesamtplays\r\n')).toBe(true);
    expect(csv).toContain("Giant Rooks;'=Slow Dance;DEABC1234567;2025-03-07;3:35;2");
  });
});
