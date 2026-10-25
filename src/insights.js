import { artistOverlapRatioLoose, compactTerm } from './normalize.js';
import { isoUtcNow } from './time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Everything the own station has played, per track_key (all time). Used for the "läuft schon bei uns" badge.
export function listOwnStationPlays(db, stationId) {
  if (!stationId) return [];
  return db.prepare(`
    select track_key, count(*) as plays, max(played_at_utc) as last_played_at_utc
    from plays
    where station_id = ?
    group by track_key
  `).all(stationId);
}

// Songs that reach more stations now than in the window before: the strongest "this is taking off" signal.
export function listRisers(db, { days = 3, limit = 100, minStations = 2, ownStationId = null, excludeOwn = false, now = Date.now() } = {}) {
  const windowDays = Math.max(1, Math.min(Number(days) || 3, 30));
  const curStart = new Date(now - windowDays * DAY_MS).toISOString();
  const prevStart = new Date(now - 2 * windowDays * DAY_MS).toISOString();
  const rows = db.prepare(`
    select
      p.track_key,
      min(p.artist) as artist,
      min(p.title) as title,
      sum(case when p.played_at_utc >= @curStart then 1 else 0 end) as plays_now,
      sum(case when p.played_at_utc < @curStart then 1 else 0 end) as plays_prev,
      count(distinct case when p.played_at_utc >= @curStart then p.station_id end) as stations_now,
      count(distinct case when p.played_at_utc < @curStart then p.station_id end) as stations_prev,
      max(p.played_at_utc) as last_played_at_utc,
      min(m.artwork_url) as artwork_url,
      min(m.release_date_utc) as release_date_utc
    from plays p
    left join track_metadata m on m.track_key = p.track_key
    where p.played_at_utc >= @prevStart
    group by p.track_key
    having stations_now >= @minStations and stations_now > stations_prev
    order by (stations_now - stations_prev) desc, plays_now desc, artist asc
  `).all({ curStart, prevStart, minStations: Math.max(1, Number(minStations) || 2) });

  const firstSeen = db.prepare('select min(played_at_utc) as first_played_at_utc from plays where track_key = ?');
  const own = ownStationId
    ? db.prepare('select count(*) as plays, max(played_at_utc) as last from plays where station_id = ? and track_key = ?')
    : null;

  const out = [];
  for (const row of rows) {
    const ownRow = own ? own.get(ownStationId, row.track_key) : null;
    const ownPlays = Number(ownRow?.plays || 0);
    if (excludeOwn && ownPlays > 0) continue;
    out.push({
      ...row,
      station_delta: row.stations_now - row.stations_prev,
      is_new: !firstSeen.get(row.track_key).first_played_at_utc || firstSeen.get(row.track_key).first_played_at_utc >= curStart,
      own_plays: ownPlays,
      own_last_played_at_utc: ownRow?.last || null
    });
    if (out.length >= limit) break;
  }
  return { window_days: windowDays, since_utc: curStart, tracks: out };
}

// ── Merge suggestions ────────────────────────────────────────────────────────

function pairKey(winnerKey, loserKey) {
  return `${winnerKey}>${loserKey}`;
}

export function ignoreMergePairs(db, winnerKey, loserKeys) {
  const insert = db.prepare('insert or ignore into merge_ignored(pair_key, created_at_utc) values (?, ?)');
  const now = isoUtcNow();
  db.transaction(() => {
    for (const loserKey of loserKeys) insert.run(pairKey(winnerKey, loserKey), now);
  })();
}

// Tracks that are probably the same song under different ids: same ISRC, or the same title with overlapping artists.
export function findMergeCandidates(db, { limit = 50 } = {}) {
  const tracks = db.prepare(`
    select p.track_key, min(p.artist) as artist, min(p.title) as title, count(*) as plays,
      count(distinct p.station_id) as stations, min(m.isrc) as isrc, min(m.artwork_url) as artwork_url
    from plays p
    left join track_metadata m on m.track_key = p.track_key
    group by p.track_key
  `).all();

  const parent = new Map(tracks.map((t) => [t.track_key, t.track_key]));
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(key, root);
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const reason = new Map();
  const note = (a, b, why) => {
    reason.set(a, reason.get(a) === 'isrc' ? 'isrc' : why);
    reason.set(b, reason.get(b) === 'isrc' ? 'isrc' : why);
  };

  const byIsrc = new Map();
  const byTitle = new Map();
  for (const track of tracks) {
    if (track.isrc) {
      if (!byIsrc.has(track.isrc)) byIsrc.set(track.isrc, []);
      byIsrc.get(track.isrc).push(track);
    }
    const title = compactTerm(track.title);
    if (title.length >= 4) {
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push(track);
    }
  }
  for (const group of byIsrc.values()) {
    for (let i = 1; i < group.length; i += 1) {
      union(group[0].track_key, group[i].track_key);
      note(group[0].track_key, group[i].track_key, 'isrc');
    }
  }
  for (const group of byTitle.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (artistOverlapRatioLoose(group[i].artist, group[j].artist) >= 0.5) {
          union(group[i].track_key, group[j].track_key);
          note(group[i].track_key, group[j].track_key, 'name');
        }
      }
    }
  }

  const groups = new Map();
  for (const track of tracks) {
    const root = find(track.track_key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(track);
  }

  const ignored = new Set(db.prepare('select pair_key from merge_ignored').all().map((row) => row.pair_key));
  const suggestions = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.plays - a.plays || b.stations - a.stations);
    const [winner, ...rest] = members;
    const losers = rest.filter((loser) => !ignored.has(pairKey(winner.track_key, loser.track_key)));
    if (!losers.length) continue;
    const viaIsrc = members.some((m) => reason.get(m.track_key) === 'isrc');
    suggestions.push({
      reason: viaIsrc ? 'isrc' : 'name',
      total_plays: members.reduce((sum, m) => sum + m.plays, 0),
      winner,
      losers
    });
  }
  suggestions.sort((a, b) => (a.reason === b.reason ? b.total_plays - a.total_plays : a.reason === 'isrc' ? -1 : 1));
  return suggestions.slice(0, limit);
}
