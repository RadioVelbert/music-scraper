import * as cheerio from 'cheerio';
import { fetch } from 'undici';
import { openDb } from './db.js';
import { normalizeArtistTitle, primaryArtist } from './normalize.js';
import { isoUtcNow } from './time.js';

// External charts shown on the "Charts" page. offiziellecharts.de is not included: it blocks
// automated access (Akamai bot protection) and the data is licensed.
export const CHARTS = [
  {
    id: 'radiocharts_de',
    name: 'Radio-Charts Deutschland',
    provider: 'MusicTrace / radiocharts.com',
    url: 'https://radiocharts.com/html/charts_de_main.htm',
    parse: parseRadiocharts
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
      try {
        const parsed = chart.parse(await fetchDecoded(chart.url));
        const resolve = createTrackResolver(db);
        const insert = db.prepare(`
          insert into chart_entries(chart_id, chart_week, position, prev_position, peak_position, weeks, trend, artist, title, label, track_key, fetched_at_utc)
          values (@chart_id, @chart_week, @position, @prev_position, @peak_position, @weeks, @trend, @artist, @title, @label, @track_key, @fetched_at_utc)
        `);
        db.transaction(() => {
          db.prepare('delete from chart_entries where chart_id = ? and chart_week = ?').run(chart.id, parsed.week);
          for (const entry of parsed.entries) {
            insert.run({ ...entry, chart_id: chart.id, chart_week: parsed.week, track_key: resolve(entry.artist, entry.title), fetched_at_utc: now });
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
  if (results.every((r) => r.error)) throw new Error('Alle Charts fehlgeschlagen');
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
  return { week: chartWeek, myStationId: myStation, entries };
}
