import * as cheerio from 'cheerio';
import { fetch } from 'undici';
import { HttpFetcher } from './fetchers/httpFetcher.js';
import { lautfmLastSongsUrl } from './stationStore.js';

const ORB_BASE = 'https://onlineradiobox.com';

// Search onlineradiobox.com so stations can be added without looking up their playlist URL by hand.
export async function searchOnlineradiobox(query, { limit = 20 } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const html = await new HttpFetcher().fetchHtml(`${ORB_BASE}/search?${new URLSearchParams({ q })}`);
  const $ = cheerio.load(html);
  const results = [];
  $('li.stations__station').each((_i, el) => {
    if (results.length >= limit) return;
    const link = $(el).find('figure a[href]').first();
    const href = link.attr('href') || '';
    const match = href.match(/^\/([a-z]{2})\/([^/]+)\/?$/i);
    if (!match) return;
    const [, country, slug] = match;
    const logo = link.find('img').attr('src') || null;
    results.push({
      name: link.find('figcaption').text().trim() || slug,
      country: country.toLowerCase(),
      slug,
      region: $(el).find('.stations__station__info a').not('.i-flag').first().text().trim() || null,
      logoUrl: logo ? (logo.startsWith('//') ? `https:${logo}` : logo) : null,
      playlistUrl: `${ORB_BASE}/${country.toLowerCase()}/${slug}/playlist/`
    });
  });
  return results;
}

// Checks a laut.fm station name and returns its metadata plus the last_songs URL.
export async function lookupLautfmStation(name) {
  const slug = String(name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(slug)) return null;
  const res = await fetch(`https://api.laut.fm/station/${encodeURIComponent(slug)}`, {
    headers: { 'user-agent': 'music-scraper/1.0 (+laut.fm)', accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`laut.fm: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.name) return null;
  return {
    name: body.name,
    displayName: body.display_name || body.name,
    description: body.format || body.description || null,
    location: body.location || null,
    genres: Array.isArray(body.genres) ? body.genres : [],
    pageUrl: body.page_url || `https://laut.fm/${body.name}`,
    playlistUrl: lautfmLastSongsUrl(body.name)
  };
}
