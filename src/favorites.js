import crypto from 'node:crypto';
import { normalizeArtistTitle } from './normalize.js';
import { isoUtcNow } from './time.js';
import { getDeezerEnrichment } from './trackDetails.js';

const MAX_TEXT = 300;
const MAX_NOTE = 1000;
export const FAVORITE_STATUSES = ['open', 'requested', 'in_programm'];

export function favoriteSongKey(artist, title) {
  const normalized = normalizeArtistTitle(artist, title);
  if (normalized.artist && normalized.title) return normalized.trackKey;
  return crypto.createHash('sha1').update(`raw||${String(artist).toLowerCase()}||${String(title).toLowerCase()}`, 'utf8').digest('hex');
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function parseVariants(json) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toApi(row) {
  const variants = parseVariants(row.variants_json);
  return {
    id: row.id,
    song_key: row.song_key,
    artist: row.artist,
    title: row.title,
    track_key: row.track_key || null,
    artwork_url: row.artwork_url || null,
    created_at_utc: row.created_at_utc,
    done: row.status === 'in_programm',
    done_at_utc: row.done_at_utc || null,
    status: row.status || 'open',
    note: row.note || '',
    // every extra spelling / id that was recognised as the same song
    variants: variants.slice(1),
    duplicate_count: Math.max(0, variants.length - 1)
  };
}

export function listFavorites(db) {
  return db.prepare('select * from favorites order by id desc').all().map(toApi);
}

// Resolves the dedup key for each artist/title pair so the UI can mark songs without knowing the normalisation rules.
export function lookupSongKeys(items) {
  return items.map((item) => favoriteSongKey(cleanText(item?.artist), cleanText(item?.title)));
}

function sameVariant(a, b) {
  return String(a.artist || '').toLowerCase() === String(b.artist || '').toLowerCase()
    && String(a.title || '').toLowerCase() === String(b.title || '').toLowerCase()
    && (a.track_key || null) === (b.track_key || null);
}

// Returns { added, favorite }. added=false means the song (or an alias of it) was already a favorite.
export function addFavorite(db, { artist, title, trackKey, artworkUrl }) {
  const cleanArtist = cleanText(artist);
  const cleanTitle = cleanText(title);
  if (!cleanArtist || !cleanTitle) throw new Error('Interpret und Titel sind erforderlich.');
  const key = cleanText(trackKey) || null;
  const songKey = favoriteSongKey(cleanArtist, cleanTitle);
  const variant = { artist: cleanArtist, title: cleanTitle, track_key: key };

  const run = db.transaction(() => {
    let existing = db.prepare('select * from favorites where song_key = ?').get(songKey);
    if (!existing && key) {
      // same id seen before under another spelling (e.g. merged tracks)
      existing = db.prepare('select * from favorites').all()
        .find((row) => row.track_key === key || parseVariants(row.variants_json).some((v) => v.track_key === key));
    }
    if (existing) {
      const variants = parseVariants(existing.variants_json);
      if (!variants.some((v) => sameVariant(v, variant))) variants.push(variant);
      db.prepare('update favorites set variants_json = ?, artwork_url = coalesce(artwork_url, ?), track_key = coalesce(track_key, ?) where id = ?')
        .run(JSON.stringify(variants), artworkUrl || null, key, existing.id);
      return { added: false, row: db.prepare('select * from favorites where id = ?').get(existing.id) };
    }
    const info = db.prepare(`
      insert into favorites(song_key, artist, title, track_key, artwork_url, variants_json, created_at_utc)
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(songKey, cleanArtist, cleanTitle, key, artworkUrl || null, JSON.stringify([variant]), isoUtcNow());
    return { added: true, row: db.prepare('select * from favorites where id = ?').get(info.lastInsertRowid) };
  });
  const { added, row } = run();
  return { added, favorite: toApi(row) };
}

// Partial update: any of status ('open' | 'requested' | 'in_programm'), note, done (legacy: true = in_programm).
export function updateFavorite(db, id, { status, note, done } = {}) {
  const current = db.prepare('select * from favorites where id = ?').get(Number(id));
  if (!current) return null;
  let nextStatus = current.status || 'open';
  if (status !== undefined) {
    if (!FAVORITE_STATUSES.includes(status)) throw new Error('Unbekannter Status.');
    nextStatus = status;
  } else if (done !== undefined) {
    nextStatus = done ? 'in_programm' : 'open';
  }
  const nextNote = note === undefined ? current.note : String(note ?? '').trim().slice(0, MAX_NOTE);
  const finished = nextStatus === 'in_programm';
  const doneAt = finished ? (current.status === 'in_programm' ? current.done_at_utc : isoUtcNow()) : null;
  db.prepare('update favorites set status = ?, note = ?, done = ?, done_at_utc = ? where id = ?')
    .run(nextStatus, nextNote, finished ? 1 : 0, doneAt, current.id);
  return toApi(db.prepare('select * from favorites where id = ?').get(current.id));
}

export function setFavoriteDone(db, id, done) {
  return updateFavorite(db, id, { done: Boolean(done) });
}

// All ids a favorite is known under (dedup key, track keys, merged variants) so lists can be filtered by track_key.
export function favoriteTrackKeys(favorites) {
  const keys = new Set();
  for (const f of favorites) {
    keys.add(f.song_key);
    if (f.track_key) keys.add(f.track_key);
    for (const v of f.variants) if (v.track_key) keys.add(v.track_key);
  }
  return [...keys];
}

function cleanIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// Sets the status of many favorites at once (same rules as updateFavorite). Returns the number of changed rows.
export function bulkSetFavoriteStatus(db, ids, status) {
  if (!FAVORITE_STATUSES.includes(status)) throw new Error('Unbekannter Status.');
  let changed = 0;
  db.transaction(() => {
    for (const id of cleanIds(ids)) {
      if (updateFavorite(db, id, { status })) changed += 1;
    }
  })();
  return changed;
}

export function removeFavoritesByIds(db, ids) {
  let removed = 0;
  db.transaction(() => {
    const stmt = db.prepare('delete from favorites where id = ?');
    for (const id of cleanIds(ids)) removed += stmt.run(id).changes;
  })();
  return removed;
}

export function removeFavoriteById(db, id) {
  return db.prepare('delete from favorites where id = ?').run(Number(id)).changes;
}

export function removeFavoriteBySongKey(db, songKey) {
  return db.prepare('delete from favorites where song_key = ?').run(String(songKey)).changes;
}

export function clearFavorites(db) {
  return db.prepare('delete from favorites').run().changes;
}

// ── CSV export ───────────────────────────────────────────────────────────────

const CSV_HEADER = ['Artist', 'Title', 'ISRC', 'Release Date', 'Dauer', 'Gesamtplays'];

// Semicolon + BOM so German Excel opens the file correctly; leading =,+,-,@ are neutralised against formula injection.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatDuration(ms, seconds) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  if (total == null) return '';
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function candidateKeys(favorite) {
  const keys = [favorite.song_key, favorite.track_key, ...favorite.variants.map((v) => v.track_key)];
  return [...new Set(keys.filter(Boolean))];
}

function readEnrichmentPayload(db, keys) {
  for (const key of keys) {
    const row = db.prepare('select payload_json from track_enrichment where track_key = ?').get(key);
    if (!row?.payload_json) continue;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      // ignore broken cache row
    }
  }
  return null;
}

export async function buildFavoritesCsv(db, { enrich = true, logger } = {}) {
  const lines = [CSV_HEADER.map(csvCell).join(';')];
  for (const favorite of listFavorites(db).reverse()) {
    const keys = candidateKeys(favorite);
    const marks = keys.map(() => '?').join(',');
    const plays = db.prepare(`select count(*) as n from plays where track_key in (${marks})`).get(...keys).n;
    const meta = db.prepare(`select isrc, release_date_utc, duration_ms from track_metadata where track_key in (${marks}) order by (isrc is null), (release_date_utc is null)`).all(...keys)[0] || {};

    let payload = readEnrichmentPayload(db, keys);
    const missing = !meta.isrc || !meta.release_date_utc || !meta.duration_ms;
    if (missing && !payload && enrich) {
      const playedKey = keys.find((key) => db.prepare('select 1 from plays where track_key = ? limit 1').get(key)) || favorite.song_key;
      payload = await getDeezerEnrichment(db, playedKey, { artist: favorite.artist, title: favorite.title, logger }).catch(() => null);
    }

    const releaseDate = String(meta.release_date_utc || payload?.track?.release_date || payload?.album?.release_date || '').slice(0, 10);
    lines.push([
      favorite.artist,
      favorite.title,
      meta.isrc || payload?.track?.isrc || '',
      releaseDate,
      formatDuration(meta.duration_ms, payload?.track?.duration),
      plays
    ].map(csvCell).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
