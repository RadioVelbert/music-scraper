import * as cheerio from 'cheerio';
import { fetch } from 'undici';
import { openDb } from './db.js';
import { normalizeArtistTitle, primaryArtist } from './normalize.js';
import { DateTime } from 'luxon';
import { isoUtcNow } from './time.js';

// External charts shown on the "Charts" page. offiziellecharts.de is not included: it blocks
// automated access (Akamai bot protection) and the data is licensed.
// kind "songs" links entries to tracks; kind "albums" (Billboard 200) links by artist.
// minIntervalHours: Billboard only changes weekly and the page is ~5 MB, so it isn't fetched every hour.
export const CHARTS = [
  {
    id: 'radiocharts_de',
    name: 'Radio-Charts Deutschland',
    provider: 'MusicTrace / radiocharts.com',
    url: 'https://radiocharts.com/html/charts_de_main.htm',
    kind: 'songs',
    minIntervalHours: 0,
    parse: parseRadiocharts
  },
  {
    id: 'billboard_200',
    name: 'Billboard 200',
    provider: 'Billboard',
    url: 'https://www.billboard.com/charts/billboard-200/',
    kind: 'albums',
    minIntervalHours: 6,
    parse: parseBillboard
  }
];

// The page is ISO-8859-15; undici's res.text() would always decode UTF-8 and break umlauts.
export async function fetchDecoded(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; RadioVelbert-MusicScraper/1.0)',
      'accept-language': 'de-DE,de;q=0.9'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} while fetching ${url}`);
  const buffer = await res.arrayBuffer();
  const headerCharset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1];
  const head = new TextDecoder('latin1').decode(buffer.slice(0, 2048));
  const metaCharset = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (metaCharset || headerCharset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// radiocharts lists some artists as "Schulz, Robin x Watermät" → "Robin Schulz x Watermät".
const COMMA_BAND_NAMES = /earth, wind|crosby, stills|emerson, lake/i;
export function fixReversedNames(artist) {
  if (COMMA_BAND_NAMES.test(artist)) return artist;
  return artist
    .split(/( x | & | feat\. | ft\. | vs\. )/i)
    .map((part) => (/^[^,\s][^,]*, [^,\s]+$/.test(part) ? part.split(', ').reverse().join(' ') : part))
    .join('');
}

function toInt(value) {
  const match = String(value ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

export function parseRadiocharts(html) {
  const $ = cheerio.load(html);
  const weekText = $('h4').filter((_i, el) => /Chartwoche/i.test($(el).text())).first().text();
  const weekMatch = /(\d{1,2})\s*\/\s*(\d{4})/.exec(weekText);
  if (!weekMatch) throw new Error('Chartwoche nicht gefunden');
  const week = `${weekMatch[2]}-W${weekMatch[1].padStart(2, '0')}`;

  const entries = [];
  $('table.chartTable tbody tr').each((_i, row) => {
    const cell = (title) => $(row).find(`td[title="${title}"]`).first();
    const position = toInt(cell('Chart-Position in der aktuell angezeigten Chartwoche').text());
    const title = cell('Titel').text().replace(/\s+/g, ' ').trim();
    const artist = fixReversedNames(cell('Interpret').text().replace(/\s+/g, ' ').trim());
    if (!position || !title || !artist) return;
    const trendSrc = cell('Trend').find('img').attr('src') || '';
    const trend = /up/i.test(trendSrc) ? 'up' : /down/i.test(trendSrc) ? 'down' : /new|neu/i.test(trendSrc) ? 'new' : 'same';
    entries.push({
      position,
      prev_position: toInt(cell('Chart-Position in der Vorwoche').text()),
      peak_position: toInt(cell('Höchste Chart-Position').text()),
      weeks: toInt(cell('Anzahl der Wochen in den TOP100 Charts').text()),
      trend,
      artist,
      title,
      label: cell('Label').text().replace(/\s+/g, ' ').trim() || null
    });
  });
  if (!entries.length) throw new Error('Keine Chart-Einträge gefunden');
  return { week, weekLabel: `${weekMatch[1]}/${weekMatch[2]}`, entries };
}

export function parseBillboard(html) {
  const $ = cheerio.load(html);
  const weekMatch = /Week of ([A-Za-z]+ \d{1,2}, \d{4})/.exec($.root().text());
  const date = weekMatch ? DateTime.fromFormat(weekMatch[1], 'LLLL d, yyyy', { locale: 'en' }) : null;
  if (!date?.isValid) throw new Error('Chartwoche nicht gefunden');
  const week = `${date.weekYear}-W${String(date.weekNumber).padStart(2, '0')}`;

  const entries = [];
  $('.o-chart-results-list-row-container').each((_i, el) => {
    const row = $(el);
    const position = toInt(row.find('span.c-label').first().text());
    const titleEl = row.find('h3#title-of-a-story').first();
    const title = titleEl.text().replace(/\s+/g, ' ').trim();
    const artist = titleEl.nextAll('span').first().text().replace(/\s+/g, ' ').trim();
    if (!position || !title || !artist) return;
    // Mobile block: "LW" label followed by last week, peak, weeks on chart
    const items = row.find('li').toArray();
    const lwIndex = items.findIndex((li) => $(li).children('span').first().text().trim() === 'LW');
    const values = lwIndex >= 0
      ? items.slice(lwIndex + 1).filter((li) => ($(li).attr('class') || '').includes('o-chart-results-list__item'))
        .slice(0, 3).map((li) => $(li).children('span').first().text().trim())
      : [];
    const prev = toInt(values[0]);
    const img = row.find('img').first();
    const image = [img.attr('data-lazy-src'), img.attr('src')].find((src) => src && /^https?:/.test(src) && !/lazyload|fallback/i.test(src)) || null;
    entries.push({
      position,
      prev_position: prev,
      peak_position: toInt(values[1]),
      weeks: toInt(values[2]),
      trend: !prev ? 'new' : prev > position ? 'up' : prev < position ? 'down' : 'same',
      artist,
      title,
      label: null,
      image_url: image
    });
  });
  if (!entries.length) throw new Error('Keine Chart-Einträge gefunden');
  return { week, weekLabel: date.toFormat('dd.LL.yyyy'), entries };
}

// Links a chart entry to our track identity: exact normalized key, else title + primary artist.
function createTrackResolver(db) {
  const exact = db.prepare('select 1 from plays where track_key = ? limit 1');
  const byTitle = db.prepare(`
    select track_key, artist, count(*) as plays from plays where title = ? group by track_key order by plays desc
  `);
  return (artist, title) => {
    const normalized = normalizeArtistTitle(artist, title);
    if (!normalized.artist || !normalized.title) return null;
    if (exact.get(normalized.trackKey)) return normalized.trackKey;
    const primary = primaryArtist(normalized.artist);
    const candidate = byTitle.all(normalized.title).find((row) => primaryArtist(row.artist) === primary);
    return candidate?.track_key ?? null;
  };
}

export async function runChartsFetch({ dbPath, logger }) {
  const db = openDb(dbPath);
  const results = [];
  try {
    for (const chart of CHARTS) {
      const now = isoUtcNow();
      const lastRun = db.prepare('select last_fetched_at_utc, last_status from chart_runs where chart_id = ?').get(chart.id);
      if (chart.minIntervalHours && lastRun?.last_status === 'ok'
        && Date.now() - Date.parse(lastRun.last_fetched_at_utc) < chart.minIntervalHours * 3600000) {
        results.push({ chart: chart.id, skipped: true });
        continue;
      }
      try {
        const parsed = chart.parse(await fetchDecoded(chart.url));
        const resolve = createTrackResolver(db);
        const insert = db.prepare(`
          insert into chart_entries(chart_id, chart_week, position, prev_position, peak_position, weeks, trend, artist, title, label, track_key, image_url, fetched_at_utc)
          values (@chart_id, @chart_week, @position, @prev_position, @peak_position, @weeks, @trend, @artist, @title, @label, @track_key, @image_url, @fetched_at_utc)
        `);
        db.transaction(() => {
          db.prepare('delete from chart_entries where chart_id = ? and chart_week = ?').run(chart.id, parsed.week);
          for (const entry of parsed.entries) {
            insert.run({
              ...entry,
              image_url: entry.image_url ?? null,
              chart_id: chart.id,
              chart_week: parsed.week,
              // Album titles don't identify a track; album charts are linked by artist when read.
              track_key: chart.kind === 'songs' ? resolve(entry.artist, entry.title) : null,
              fetched_at_utc: now
            });
          }
          db.prepare(`
            insert into chart_runs(chart_id, last_fetched_at_utc, last_week, last_status, last_error, entries) values (?, ?, ?, 'ok', null, ?)
            on conflict(chart_id) do update set last_fetched_at_utc = excluded.last_fetched_at_utc, last_week = excluded.last_week,
              last_status = 'ok', last_error = null, entries = excluded.entries
          `).run(chart.id, now, parsed.week, parsed.entries.length);
        })();
        logger?.info?.({ chart: chart.id, week: parsed.week, entries: parsed.entries.length }, 'chart fetched');
        results.push({ chart: chart.id, week: parsed.week, entries: parsed.entries.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`
          insert into chart_runs(chart_id, last_fetched_at_utc, last_status, last_error) values (?, ?, 'error', ?)
          on conflict(chart_id) do update set last_fetched_at_utc = excluded.last_fetched_at_utc, last_status = 'error', last_error = excluded.last_error
        `).run(chart.id, now, message);
        logger?.error?.({ chart: chart.id, error: message }, 'chart fetch failed');
        results.push({ chart: chart.id, error: message });
      }
    }
  } finally {
    db.close();
  }
  if (results.length && results.every((r) => r.error)) throw new Error('Alle Charts fehlgeschlagen');
  return results;
}

export function listCharts(db) {
  const runs = new Map(db.prepare('select * from chart_runs').all().map((row) => [row.chart_id, row]));
  const weeks = db.prepare('select distinct chart_week from chart_entries where chart_id = ? order by chart_week desc limit 52');
  return CHARTS.map(({ parse: _parse, ...chart }) => ({
    ...chart,
    run: runs.get(chart.id) ?? null,
    weeks: weeks.all(chart.id).map((row) => row.chart_week)
  }));
}

function artistKey(artist) {
  return primaryArtist(normalizeArtistTitle(artist, 'x').artist);
}

// Album charts: plays of the artist (primary artist) at our stations, plus their most played track.
function artistAirplay(db, since, myStation) {
  const rows = db.prepare(`
    select artist, track_key, station_id, count(*) as plays from plays
    where played_at_utc >= ? group by artist, track_key, station_id
  `).all(since);
  const byArtist = new Map();
  for (const row of rows) {
    const key = primaryArtist(row.artist);
    if (!key) continue;
    if (!byArtist.has(key)) byArtist.set(key, { plays: 0, my: 0, stations: new Set(), tracks: new Map() });
    const entry = byArtist.get(key);
    entry.plays += row.plays;
    entry.stations.add(row.station_id);
    if (row.station_id === myStation) entry.my += row.plays;
    entry.tracks.set(row.track_key, (entry.tracks.get(row.track_key) || 0) + row.plays);
  }
  return byArtist;
}

// Chart entries plus our own airplay over the last 7 days.
export function getChartEntries(db, chartId, week) {
  const chartWeek = week || db.prepare('select max(chart_week) as w from chart_entries where chart_id = ?').get(chartId)?.w;
  if (!chartWeek) return { week: null, entries: [] };
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const myStation = db.prepare('select id, config_json from stations where config_json is not null').all()
    .find((row) => { try { return JSON.parse(row.config_json).my_station; } catch { return false; } })?.id ?? null;
  const entries = db.prepare(`
    select e.*,
      m.artwork_url,
      (select count(*) from plays p where p.track_key = e.track_key and p.played_at_utc >= ?) as plays_7d,
      (select count(distinct p.station_id) from plays p where p.track_key = e.track_key and p.played_at_utc >= ?) as stations_7d,
      (select count(*) from plays p where p.track_key = e.track_key and p.station_id = ? and p.played_at_utc >= ?) as my_plays_7d
    from chart_entries e
    left join track_metadata m on m.track_key = e.track_key
    where e.chart_id = ? and e.chart_week = ?
    order by e.position
  `).all(since, since, myStation, since, chartId, chartWeek);
  const chart = CHARTS.find((c) => c.id === chartId);
  if (chart?.kind === 'albums') {
    const airplay = artistAirplay(db, since, myStation);
    const artwork = db.prepare('select artwork_url from track_metadata where track_key = ?');
    for (const entry of entries) {
      const stats = airplay.get(artistKey(entry.artist));
      entry.plays_7d = stats?.plays ?? 0;
      entry.stations_7d = stats?.stations.size ?? 0;
      entry.my_plays_7d = stats?.my ?? 0;
      const top = stats ? [...stats.tracks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : null;
      entry.top_track_key = top ?? null;
      entry.top_track_artwork = top ? artwork.get(top)?.artwork_url ?? null : null;
      entry.matched = Boolean(stats);
    }
  } else {
    for (const entry of entries) entry.matched = Boolean(entry.track_key);
  }
  return { week: chartWeek, kind: chart?.kind ?? 'songs', myStationId: myStation, entries };
}
