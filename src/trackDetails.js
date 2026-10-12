import { getTrackIdentity, getTrackMetadata } from './db.js';
import { getTrackDisplay, upsertTrackDisplay, smartTitleCase } from './displayNames.js';
import { findDeezerTrackId, getDeezerAlbum, getDeezerArtist, getDeezerTrack } from './integrations/deezer.js';
import { isoUtcNow } from './time.js';

const ENRICHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
// Deezer preview links expire after ~15 minutes.
const PREVIEW_CACHE_MS = 5 * 60 * 1000;
const previewCache = new Map();

function readEnrichment(db, trackKey) {
  const row = db.prepare('select source_id, payload_json, fetched_at_utc from track_enrichment where track_key = ? and source = ?').get(trackKey, 'deezer');
  if (!row) return null;
  try {
    return { sourceId: row.source_id, payload: JSON.parse(row.payload_json || 'null'), fetchedAt: row.fetched_at_utc };
  } catch {
    return null;
  }
}

function writeEnrichment(db, trackKey, sourceId, payload, logger) {
  try {
    db.prepare(`
      insert into track_enrichment(track_key, source, source_id, payload_json, fetched_at_utc)
      values (?, 'deezer', ?, ?, ?)
      on conflict(track_key) do update set
        source = excluded.source, source_id = excluded.source_id,
        payload_json = excluded.payload_json, fetched_at_utc = excluded.fetched_at_utc
    `).run(trackKey, sourceId, JSON.stringify(payload), isoUtcNow());
  } catch (error) {
    // Cache writes are best effort: a busy database (running job) must not break the song page.
    logger?.warn?.({ trackKey, err: error instanceof Error ? error.message : String(error) }, 'track enrichment cache write failed');
  }
}

function pickDeezerPayload(track, album, artist) {
  return {
    track: {
      id: track.id,
      title: track.title,
      title_short: track.title_short,
      title_version: track.title_version || null,
      isrc: track.isrc || null,
      link: track.link,
      duration: track.duration,
      track_position: track.track_position,
      disk_number: track.disk_number,
      rank: track.rank,
      release_date: track.release_date || null,
      bpm: track.bpm || null,
      gain: track.gain ?? null,
      explicit_lyrics: Boolean(track.explicit_lyrics)
    },
    contributors: (Array.isArray(track.contributors) ? track.contributors : []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      link: c.link,
      picture: c.picture_medium || c.picture || null
    })),
    album: album ? {
      id: album.id,
      title: album.title,
      link: album.link,
      cover: album.cover_xl || album.cover_big || album.cover_medium || null,
      cover_small: album.cover_medium || album.cover || null,
      label: album.label || null,
      upc: album.upc || null,
      release_date: album.release_date || null,
      record_type: album.record_type || null,
      nb_tracks: album.nb_tracks ?? null,
      genres: (album.genres?.data || []).map((g) => g.name),
      explicit_lyrics: Boolean(album.explicit_lyrics)
    } : null,
    artist: artist ? {
      id: artist.id,
      name: artist.name,
      link: artist.link,
      picture: artist.picture_xl || artist.picture_big || artist.picture_medium || null,
      nb_album: artist.nb_album ?? null,
      nb_fan: artist.nb_fan ?? null
    } : null
  };
}

async function loadDeezerDetails(deezerId) {
  const track = await getDeezerTrack(deezerId);
  const [album, artist] = await Promise.all([
    track.album?.id ? getDeezerAlbum(track.album.id).catch(() => null) : null,
    track.artist?.id ? getDeezerArtist(track.artist.id).catch(() => null) : null
  ]);
  return { track, payload: pickDeezerPayload(track, album, artist) };
}

function knownDeezerId(db, trackKey, meta) {
  const cached = readEnrichment(db, trackKey);
  if (cached?.sourceId) return cached.sourceId;
  if (meta?.canonical_source === 'deezer' && meta.canonical_id) return meta.canonical_id;
  return null;
}

// Returns cached Deezer details (7 days), refreshing them from the API when missing, stale or requested.
export async function getDeezerEnrichment(db, trackKey, { artist, title, refresh = false, logger } = {}) {
  const cached = readEnrichment(db, trackKey);
  const ageMs = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  const ttl = cached?.payload ? ENRICHMENT_TTL_MS : NOT_FOUND_TTL_MS;
  if (!refresh && cached && ageMs < ttl) return cached.payload;

  const meta = getTrackMetadata(db, trackKey);
  try {
    const deezerId = knownDeezerId(db, trackKey, meta) || await findDeezerTrackId(artist, title);
    if (!deezerId) {
      writeEnrichment(db, trackKey, null, null, logger);
      return null;
    }
    const { track, payload } = await loadDeezerDetails(deezerId);
    writeEnrichment(db, trackKey, String(deezerId), payload, logger);

    // Deezer spelling is the best display source for this identity.
    const identity = getTrackIdentity(db, trackKey);
    if (identity?.artist && identity?.title) {
      try {
        upsertTrackDisplay(db, {
          trackKey,
          artistNorm: identity.artist,
          titleNorm: identity.title,
          artistSources: [track.artist?.name, ...payload.contributors.map((c) => c.name)].filter(Boolean),
          titleSources: [track.title_short, track.title].filter(Boolean),
          source: 'deezer'
        });
      } catch (error) {
        logger?.warn?.({ trackKey, err: error instanceof Error ? error.message : String(error) }, 'display name update failed');
      }
    }
    if (track.preview) previewCache.set(trackKey, { url: track.preview, at: Date.now() });
    if (payload.album?.cover_small) {
      try {
        // Lists show track_metadata.artwork_url; fill it when iTunes had no cover.
        db.prepare('update track_metadata set artwork_url = ? where track_key = ? and artwork_url is null').run(payload.album.cover_small, trackKey);
      } catch {
        // best effort
      }
    }
    return payload;
  } catch (error) {
    logger?.warn?.({ trackKey, err: error instanceof Error ? error.message : String(error) }, 'deezer enrichment failed');
    return cached?.payload ?? null;
  }
}

function upscaleItunesArtwork(url, size = 600) {
  if (!url) return null;
  return String(url).replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}x${size}bb.$1`);
}

export async function getTrackDetails(db, trackKey, { refresh = false, logger } = {}) {
  const identity = getTrackIdentity(db, trackKey);
  if (!identity?.artist || !identity?.title) return null;
  const display = getTrackDisplay(db, trackKey);
  const artist = display?.artist ?? smartTitleCase(identity.artist);
  const title = display?.title ?? smartTitleCase(identity.title);
  const meta = getTrackMetadata(db, trackKey);

  const totals = db.prepare(`
    select count(*) as total_plays, count(distinct station_id) as station_count,
      min(played_at_utc) as first_played_at_utc, max(played_at_utc) as last_played_at_utc
    from plays where track_key = ?
  `).get(trackKey);
  const stations = db.prepare(`
    select p.station_id, coalesce(s.name, p.station_id) as station_name, count(*) as plays,
      min(p.played_at_utc) as first_played_at_utc, max(p.played_at_utc) as last_played_at_utc
    from plays p left join stations s on s.id = p.station_id
    where p.track_key = ?
    group by p.station_id
    order by plays desc
  `).all(trackKey);
  const recentPlays = db.prepare(`
    select p.played_at_utc, p.station_id, coalesce(s.name, p.station_id) as station_name, p.artist_raw, p.title_raw
    from plays p left join stations s on s.id = p.station_id
    where p.track_key = ?
    order by p.played_at_utc desc
    limit 30
  `).all(trackKey);
  const spellings = db.prepare(`
    select artist_raw, title_raw, count(*) as plays, count(distinct station_id) as stations
    from plays where track_key = ?
    group by artist_raw, title_raw
    order by plays desc
    limit 12
  `).all(trackKey);

  const deezer = await getDeezerEnrichment(db, trackKey, { artist, title, refresh, logger });
  const refreshedDisplay = getTrackDisplay(db, trackKey);

  return {
    trackKey,
    artist: refreshedDisplay?.artist ?? artist,
    title: refreshedDisplay?.title ?? title,
    identity,
    artwork: deezer?.album?.cover || upscaleItunesArtwork(meta?.artwork_url),
    artworkSmall: deezer?.album?.cover_small || meta?.artwork_url || null,
    totals,
    stations,
    recentPlays,
    spellings,
    metadata: meta ? {
      isrc: meta.isrc,
      release_date_utc: meta.release_date_utc,
      genre: meta.genre,
      album: meta.album,
      label: meta.label,
      duration_ms: meta.duration_ms,
      external_url: meta.external_url,
      verification_source: meta.verification_source,
      verification_confidence: meta.verification_confidence,
      canonical_source: meta.canonical_source
    } : null,
    deezer
  };
}

// Deezer preview URLs are signed and expire, so they are resolved fresh (memory cache 5 min).
export async function getTrackPreview(db, trackKey, { logger } = {}) {
  const cached = previewCache.get(trackKey);
  if (cached && Date.now() - cached.at < PREVIEW_CACHE_MS) return { url: cached.url, source: 'deezer' };

  const meta = getTrackMetadata(db, trackKey);
  const display = getTrackDisplay(db, trackKey);
  const identity = getTrackIdentity(db, trackKey);
  if (!identity?.artist) return null;
  try {
    let deezerId = knownDeezerId(db, trackKey, meta);
    if (!deezerId) {
      await getDeezerEnrichment(db, trackKey, {
        artist: display?.artist ?? identity.artist,
        title: display?.title ?? identity.title,
        logger
      });
      deezerId = knownDeezerId(db, trackKey, meta);
    }
    if (deezerId) {
      const track = await getDeezerTrack(deezerId);
      if (track.preview) {
        previewCache.set(trackKey, { url: track.preview, at: Date.now() });
        return { url: track.preview, source: 'deezer' };
      }
    }
  } catch (error) {
    logger?.warn?.({ trackKey, err: error instanceof Error ? error.message : String(error) }, 'deezer preview lookup failed');
  }
  if (meta?.preview_url) return { url: meta.preview_url, source: 'itunes' };
  return null;
}
