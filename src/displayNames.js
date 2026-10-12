import { isoUtcNow } from './time.js';

// plays.artist / plays.title are normalized lowercase identities (they build the track key).
// track_display stores a readable spelling: the normalized words with the casing recovered from
// Deezer or from the raw station spellings; sources that are all caps/lowercase only count as fallback.

export const DISPLAY_SOURCE_PRIORITY = { fallback: 0, raw: 1, itunes: 2, deezer: 3 };

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'vs.', 'with',
  'und', 'oder', 'der', 'die', 'das', 'dem', 'den', 'des', 'ein', 'eine', 'im', 'in', 'mit', 'von', 'vom', 'zu', 'zum', 'zur', 'auf', 'aus',
  'feat.', 'ft.', 'x'
]);
const UPPER_WORDS = new Set(['dj', 'mc', 'uk', 'usa', 'nyc', 'ok', 'tv', 'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xx', 'abba', 'r&b', 'edm', 'bts']);
// Stylized names whose original form the normalizer can't keep (slashes become dashes).
const KNOWN_SPELLINGS = new Map([['ac-dc', 'AC/DC'], ['huntr-x', 'HUNTR/X'], ['mo-do', 'Mo-Do'], ['jay-z', 'JAY-Z']]);
const EDGE_PUNCT_RE = /^[("'„“‚‘[{]+|[)"'“”‘’\]},.!?:;]+$/gu;

function letters(text) {
  return String(text ?? '').replace(/[^\p{L}]/gu, '');
}

// "Mixed" = has both cases, i.e. somebody chose the spelling on purpose.
export function hasMeaningfulCasing(text) {
  const onlyLetters = letters(text);
  if (onlyLetters.length < 2) return false;
  return onlyLetters !== onlyLetters.toUpperCase() && onlyLetters !== onlyLetters.toLowerCase();
}

function capitalizeWord(word) {
  return word.replace(/\p{L}/u, (ch) => ch.toUpperCase());
}

function smartWord(word, isFirst) {
  const lower = word.toLowerCase();
  const bare = lower.replace(EDGE_PUNCT_RE, '');
  if (KNOWN_SPELLINGS.has(bare)) return lower.replace(bare, KNOWN_SPELLINGS.get(bare));
  if (UPPER_WORDS.has(bare)) return word.toUpperCase();
  if (!isFirst && SMALL_WORDS.has(bare)) return lower;
  // Hyphenated names: "jay-z" → "Jay-Z"; dotted initials: "d.a.n.c.e." → "D.A.N.C.E."
  if (/^\p{L}(\.\p{L})+\.?$/u.test(bare)) return word.toUpperCase();
  return lower.split('-').map((part) => capitalizeWord(part)).join('-');
}

export function smartTitleCase(text) {
  return String(text ?? '')
    .split(' ')
    .filter(Boolean)
    .map((word, index) => smartWord(word, index === 0))
    .join(' ');
}

function tokenKey(token) {
  return token.toLowerCase().replace(EDGE_PUNCT_RE, '');
}

// Rebuilds the normalized string word by word, taking each word's casing from the first source
// (in priority order) that contains it; unknown words are title-cased.
export function restoreCasing(normalized, sources = []) {
  const dictionary = new Map();
  for (const source of sources) {
    if (!hasMeaningfulCasing(source)) continue;
    for (const token of String(source).split(/\s+/)) {
      const key = tokenKey(token);
      if (!key || dictionary.has(key)) continue;
      const cased = token.replace(EDGE_PUNCT_RE, '');
      dictionary.set(key, cased);
      // The normalizer turns "AC/DC" into "ac-dc"; map that back to the original spelling.
      const dashedKey = key.replaceAll('/', '-');
      if (dashedKey !== key && !dictionary.has(dashedKey)) dictionary.set(dashedKey, cased);
    }
  }
  return String(normalized ?? '')
    .split(' ')
    .filter(Boolean)
    .map((word, index) => {
      const key = tokenKey(word);
      const cased = dictionary.get(key);
      if (!cased) return smartWord(word, index === 0);
      // keep punctuation of the normalized word, casing of the source word
      return word.toLowerCase().replace(key, cased);
    })
    .join(' ');
}

export function buildDisplayName({ artistNorm, titleNorm, artistSources = [], titleSources = [] }) {
  const usable = (list) => list.filter((value) => hasMeaningfulCasing(value));
  const artistUsable = usable(artistSources);
  const titleUsable = usable(titleSources);
  return {
    artist: restoreCasing(artistNorm, artistUsable),
    title: restoreCasing(titleNorm, titleUsable),
    hasCasingSource: artistUsable.length > 0 || titleUsable.length > 0
  };
}

export function getTrackDisplay(db, trackKey) {
  return db.prepare('select track_key, artist, title, source from track_display where track_key = ?').get(trackKey) ?? null;
}

// Writes the display spelling unless an equal or better source already exists for the same identity.
export function upsertTrackDisplay(db, { trackKey, artistNorm, titleNorm, artistSources, titleSources, source }) {
  if (!trackKey || !artistNorm || !titleNorm) return false;
  const display = buildDisplayName({ artistNorm, titleNorm, artistSources, titleSources });
  const effectiveSource = display.hasCasingSource ? source : 'fallback';
  const existing = db.prepare('select artist_norm, title_norm, source from track_display where track_key = ?').get(trackKey);
  const sameIdentity = existing && existing.artist_norm === artistNorm && existing.title_norm === titleNorm;
  if (sameIdentity && (DISPLAY_SOURCE_PRIORITY[existing.source] ?? 0) >= (DISPLAY_SOURCE_PRIORITY[effectiveSource] ?? 0)) {
    return false;
  }
  db.prepare(`
    insert into track_display(track_key, artist_norm, title_norm, artist, title, source, updated_at_utc)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(track_key) do update set
      artist_norm = excluded.artist_norm,
      title_norm = excluded.title_norm,
      artist = excluded.artist,
      title = excluded.title,
      source = excluded.source,
      updated_at_utc = excluded.updated_at_utc
  `).run(trackKey, artistNorm, titleNorm, display.artist, display.title, effectiveSource, isoUtcNow());
  return true;
}

function itunesCasingSources(payloadJson) {
  try {
    const payload = JSON.parse(payloadJson || '{}');
    return { artist: payload.topArtist ? [payload.topArtist] : [], title: payload.topTitle ? [payload.topTitle] : [] };
  } catch {
    return { artist: [], title: [] };
  }
}

// Fills/refreshes track_display for tracks without a row or whose identity changed (merges, Deezer corrections).
export function runDisplayNameMaintenance({ db, logger }) {
  const rows = db.prepare(`
    select p.track_key, p.artist, p.title, p.artist_raw, p.title_raw, count(*) as plays, m.payload_json
    from plays p
    left join track_display d on d.track_key = p.track_key
    left join track_metadata m on m.track_key = p.track_key
    where d.track_key is null or d.artist_norm <> p.artist or d.title_norm <> p.title
    group by p.track_key, p.artist_raw, p.title_raw
    order by p.track_key, plays desc
  `).all();

  const byTrack = new Map();
  for (const row of rows) {
    if (!byTrack.has(row.track_key)) {
      byTrack.set(row.track_key, { artistNorm: row.artist, titleNorm: row.title, artistRaw: [], titleRaw: [], payloadJson: row.payload_json });
    }
    const entry = byTrack.get(row.track_key);
    entry.artistRaw.push(row.artist_raw);
    entry.titleRaw.push(row.title_raw);
  }

  let updated = 0;
  db.transaction(() => {
    for (const [trackKey, entry] of byTrack) {
      const itunes = itunesCasingSources(entry.payloadJson);
      const useItunes = itunes.artist.length > 0 || itunes.title.length > 0;
      if (upsertTrackDisplay(db, {
        trackKey,
        artistNorm: entry.artistNorm,
        titleNorm: entry.titleNorm,
        artistSources: [...itunes.artist, ...entry.artistRaw],
        titleSources: [...itunes.title, ...entry.titleRaw],
        source: useItunes ? 'itunes' : 'raw'
      })) updated += 1;
    }
  })();

  const orphans = db.prepare('delete from track_display where track_key not in (select track_key from plays)').run().changes;
  logger?.info?.({ tracks: byTrack.size, updated, orphansRemoved: orphans }, 'display name maintenance finished');
  return { tracks: byTrack.size, updated, orphansRemoved: orphans };
}

// API presentation layer: replaces normalized artist/title in response bodies with the display spelling.
// Rows are recognised by a track key (track_key / trackKey with identity) or, for artist-only rows, by "artist".
export function applyDisplayNames(db, body) {
  const trackRefs = [];
  const artistRefs = [];

  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const key = typeof node.track_key === 'string' ? node.track_key : null;
    if (key && (typeof node.artist === 'string' || typeof node.title === 'string')) {
      trackRefs.push({ key, target: node });
    } else if (typeof node.trackKey === 'string' && node.identity && typeof node.identity === 'object') {
      trackRefs.push({ key: node.trackKey, target: node.identity });
    } else if (!key && typeof node.artist === 'string' && node.title === undefined) {
      artistRefs.push(node);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(body, 0);
  if (!trackRefs.length && !artistRefs.length) return body;

  const displayByKey = new Map();
  const keys = [...new Set(trackRefs.map((ref) => ref.key))];
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = db.prepare(`select track_key, artist_norm, title_norm, artist, title from track_display where track_key in (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const row of rows) displayByKey.set(row.track_key, row);
  }
  for (const { key, target } of trackRefs) {
    const display = displayByKey.get(key);
    // A display row for a different identity (stale after a merge) must not be used.
    if (typeof target.artist === 'string') {
      target.artist = display?.artist_norm === target.artist ? display.artist : smartTitleCase(target.artist);
    }
    if (typeof target.title === 'string') {
      target.title = display?.title_norm === target.title ? display.title : smartTitleCase(target.title);
    }
  }

  if (artistRefs.length) {
    const names = [...new Set(artistRefs.map((node) => node.artist))];
    const artistDisplay = new Map();
    for (let i = 0; i < names.length; i += 500) {
      const chunk = names.slice(i, i + 500);
      const rows = db.prepare(`select artist_norm, artist, source from track_display where artist_norm in (${chunk.map(() => '?').join(',')})`).all(...chunk);
      for (const row of rows) {
        const current = artistDisplay.get(row.artist_norm);
        if (!current || (DISPLAY_SOURCE_PRIORITY[row.source] ?? 0) > (DISPLAY_SOURCE_PRIORITY[current.source] ?? 0)) {
          artistDisplay.set(row.artist_norm, row);
        }
      }
    }
    for (const node of artistRefs) {
      node.artist = artistDisplay.get(node.artist)?.artist ?? smartTitleCase(node.artist);
    }
  }
  return body;
}
