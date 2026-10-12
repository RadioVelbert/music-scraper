import { fetch } from 'undici';
import {
  normalizeArtistTitle,
  primaryArtist,
  artistOverlapRatioLoose
} from '../normalize.js';

// Deezer public API: ~50 requests / 5 seconds
const SEARCH_ENDPOINT = 'https://api.deezer.com/search';
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT_PER_WINDOW = 45; // stay under the 50/5s cap with margin

const requestTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleDeezer() {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length && (now - requestTimestamps[0]) >= RATE_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_PER_WINDOW) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = Math.max(1, RATE_WINDOW_MS - (now - requestTimestamps[0]));
    await sleep(waitMs);
  }
}

function durationMatchScore(expectedMs, actualMs) {
  if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs) || expectedMs <= 0 || actualMs <= 0) {
    return 1;
  }
  const diff = Math.abs(expectedMs - actualMs);
  if (diff > 5000) return 0;
  return Math.max(0, 1 - (diff / 5000));
}

export function calculateConfidence(match) {
  const titleScore = Number(match?.titleScore ?? 0);
  const primaryScore = Number(match?.primaryArtistScore ?? 0);
  const overlapScore = Number(match?.artistOverlap ?? 0);
  const durationScore = Number(match?.durationScore ?? 1);
  return (titleScore * 0.45) + (primaryScore * 0.25) + (overlapScore * 0.2) + (durationScore * 0.1);
}

async function fetchSearchItems(query, limit) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  await throttleDeezer();
  let res;
  try {
    res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
      headers: { 'user-agent': 'music-scraper/1.0 (+deezer)' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new Error(`Deezer search network error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!res.ok) {
    throw new Error(`Deezer search failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

function bestStrictMatch(items, normalizedInput, inputPrimary, durationMs) {
  let best = null;
  for (const item of items) {
    const itemTitle = String(item?.title || '').trim();
    const itemArtistName = String(item?.artist?.name || '').trim();
    if (!itemTitle || !itemArtistName) continue;

    const normalizedItem = normalizeArtistTitle(itemArtistName, itemTitle);
    if (!normalizedItem.artist || !normalizedItem.title) continue;

    const titleScore = normalizedItem.title === normalizedInput.title ? 1 : 0;
    const itemPrimary = primaryArtist(normalizedItem.artist);
    const primaryArtistScore = itemPrimary === inputPrimary ? 1 : 0;
    const artistOverlap = artistOverlapRatioLoose(normalizedInput.artist, normalizedItem.artist);
    const itemDurationMs = Number(item?.duration) > 0 ? Number(item.duration) * 1000 : null;
    const durationScore = durationMatchScore(durationMs, itemDurationMs);

    const confidence = calculateConfidence({ titleScore, primaryArtistScore, artistOverlap, durationScore });

    const durationDiff = Number.isFinite(durationMs) && Number.isFinite(itemDurationMs)
      ? Math.abs(durationMs - itemDurationMs)
      : 0;
    const durationAllowed =
      !Number.isFinite(durationMs) || !Number.isFinite(itemDurationMs) || durationDiff <= 5000;

    if (!durationAllowed) continue;
    if (titleScore < 1) continue;
    if (primaryArtistScore < 1) continue;
    if (artistOverlap < 0.6) continue;

    const candidate = {
      deezerId: String(item?.id || '').trim() || null,
      isrc: String(item?.isrc || '').trim() || null,
      confidence,
      durationMs: Number.isFinite(itemDurationMs) ? itemDurationMs : null,
      artist: itemArtistName,
      title: itemTitle,
      coverUrl: item?.album?.cover_medium || item?.album?.cover || null
    };
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  }
  return best && best.confidence >= 0.8 ? best : null;
}

// Deezer's advanced "artist:" filter returns no results (as of 2026-10), so the plain search comes first
// and "track:" (still working) is the fallback. Only strict matches are accepted either way.
export async function searchTrackOnDeezer(artist, title, { durationMs = null } = {}) {
  const normalizedInput = normalizeArtistTitle(artist, title);
  if (!normalizedInput.artist || !normalizedInput.title) return null;
  const inputPrimary = primaryArtist(normalizedInput.artist);
  if (!inputPrimary) return null;

  const queries = [
    [`${artist} ${title}`, 10],
    [`track:"${title}"`, 25]
  ];
  for (const [query, limit] of queries) {
    const match = bestStrictMatch(await fetchSearchItems(query, limit), normalizedInput, inputPrimary, durationMs);
    if (match) return match;
  }
  return null;
}

const API_BASE = 'https://api.deezer.com';

// Throttled GET against the public Deezer API. Deezer reports errors (quota, unknown id) as HTTP 200 + {error}.
export async function deezerGet(pathAndQuery) {
  await throttleDeezer();
  let res;
  try {
    res = await fetch(`${API_BASE}${pathAndQuery}`, {
      headers: { 'user-agent': 'music-scraper/1.0 (+deezer)' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new Error(`Deezer network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new Error(`Deezer request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) {
    const err = new Error(`Deezer error: ${body.error.message || body.error.type || 'unknown'}`);
    err.code = body.error.code;
    throw err;
  }
  return body;
}

export function getDeezerTrack(id) {
  return deezerGet(`/track/${encodeURIComponent(id)}`);
}

export function getDeezerAlbum(id) {
  return deezerGet(`/album/${encodeURIComponent(id)}`);
}

export function getDeezerArtist(id) {
  return deezerGet(`/artist/${encodeURIComponent(id)}`);
}

// Strict match first (same rules as the ingest correction); otherwise the best plain-search hit whose
// title matches and whose artists overlap. Returns a Deezer track id or null.
export async function findDeezerTrackId(artist, title) {
  const strict = await searchTrackOnDeezer(artist, title).catch(() => null);
  if (strict?.deezerId) return strict.deezerId;

  const input = normalizeArtistTitle(artist, title);
  if (!input.artist || !input.title) return null;
  const body = await deezerGet(`/search?${new URLSearchParams({ q: `${artist} ${title}`, limit: '10' })}`);
  for (const item of Array.isArray(body?.data) ? body.data : []) {
    const candidates = [item?.title, item?.title_short].filter(Boolean);
    const titleMatches = candidates.some((candidate) => normalizeArtistTitle(item?.artist?.name || '', candidate).title === input.title);
    if (!titleMatches) continue;
    const itemArtist = normalizeArtistTitle(item?.artist?.name || '', item?.title || '').artist;
    if (artistOverlapRatioLoose(input.artist, itemArtist) >= 0.5) return String(item.id);
  }
  return null;
}
