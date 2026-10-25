import {
  berlinTodayIsoDate,
  berlinYesterdayIsoDate,
  shiftBerlinIsoDate
} from './date-berlin.js';
import {
  fillDailySeriesRange,
  formatPlays,
  formatSeriesPeriod,
  toCumulativeSeries
} from './charts.base.js';
import { renderLineChart } from './charts.line.js';
import { renderBarChart, renderDailyBarChart } from './charts.bar.js';
import {
  React,
  createRoot,
  Chakra,
  Icons,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  formatDateTime,
  formatDate,
  formatDuration,
  formatRelative,
  useDebouncedValue,
  AppShell,
  PanelCard,
  StatTile,
  TrackCover,
  PlayButton,
  CopyTrackButton,
  FavoriteButton,
  useFavoriteVersion,
  isFavoriteTrackKey,
  ensureFavoritesLoaded,
  OwnPlayBadge,
  CoverPlay,
  AppIcons,
  BRAND_GRADIENT,
  NIGHT_GRADIENT,
  navigate,
  trackHref,
  useLocationSearch,
  useUiColors,
  LoadingOverlay,
  LoadingSpinner,
  SkeletonRows
} from './horizon-lib.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'plays_per_day_desc', label: 'Plays/Tag ↓' },
  { value: 'plays_per_day_asc', label: 'Plays/Tag ↑' },
  { value: 'total_plays_desc', label: 'Plays gesamt ↓' },
  { value: 'total_plays_asc', label: 'Plays gesamt ↑' },
  { value: 'last_played_desc', label: 'Letztes Play neueste' },
  { value: 'artist_asc', label: 'Interpret A-Z' }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortTracks(rows, sortMode) {
  const data = [...(Array.isArray(rows) ? rows : [])];
  const byDate = (a, b) => (new Date(a).getTime() || 0) - (new Date(b).getTime() || 0);
  data.sort((a, b) => {
    if (sortMode === 'plays_per_day_desc') return Number(b.plays_per_day || 0) - Number(a.plays_per_day || 0);
    if (sortMode === 'plays_per_day_asc') return Number(a.plays_per_day || 0) - Number(b.plays_per_day || 0);
    if (sortMode === 'total_plays_desc') return Number(b.total_plays || 0) - Number(a.total_plays || 0);
    if (sortMode === 'total_plays_asc') return Number(a.total_plays || 0) - Number(b.total_plays || 0);
    if (sortMode === 'last_played_desc') return byDate(b.last_played_at_utc, a.last_played_at_utc);
    return String(a.artist || '').localeCompare(String(b.artist || ''), 'de', { sensitivity: 'base' });
  });
  return data;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dayLabel(period) {
  if (!period) return '-';
  const date = new Date(`${period}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(period);
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function dayCount(fromIso, toIso) {
  const start = Date.parse(`${fromIso}T12:00:00.000Z`);
  const end = Date.parse(`${toIso}T12:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

function toFixedLocale(value, digits = 2) {
  const num = Number(value || 0);
  return num.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}


// ── Track detail data helpers ─────────────────────────────────────────────────

function buildDailyTrackTrendRows(seriesByStation, panelActiveSeries) {
  const stationRows = Array.isArray(seriesByStation?.stations) ? seriesByStation.stations : [];
  const panelRows = Array.isArray(panelActiveSeries) ? panelActiveSeries : [];
  const allPeriods = new Set();
  stationRows.forEach((s) => (s.series || []).forEach((r) => { if (r?.period) allPeriods.add(r.period); }));
  panelRows.forEach((r) => { if (r?.period) allPeriods.add(r.period); });
  const periods = Array.from(allPeriods).sort((a, b) => a.localeCompare(b));
  const activeByPeriod = new Map(panelRows.map((r) => [r.period, Number(r.active_senders || 0)]));
  return periods.map((period) => {
    let rawPlays = 0;
    stationRows.forEach((s) => {
      const pt = (s.series || []).find((r) => r.period === period);
      rawPlays += Number(pt?.plays || 0);
    });
    const activeSenders = Number(activeByPeriod.get(period) || 0);
    return { period, rawPlays, activeSenders, normalizedPlays: activeSenders > 0 ? rawPlays / activeSenders : 0 };
  });
}

function buildDayStationMatrix(seriesByStation) {
  const stations = Array.isArray(seriesByStation?.stations) ? [...seriesByStation.stations] : [];
  const topStations = stations.sort((a, b) => Number(b.totalPlays || 0) - Number(a.totalPlays || 0)).slice(0, 8);
  const periods = Array.isArray(seriesByStation?.periods) ? [...seriesByStation.periods].sort() : [];
  const byPeriod = new Map(periods.map((p) => [p, {
    period: p, total: 0, activeStations: 0,
    byStation: topStations.map((s) => ({ stationId: s.stationId, stationName: s.stationName, plays: 0 }))
  }]));
  topStations.forEach((station, idx) => {
    (station.series || []).forEach((row) => {
      const bucket = byPeriod.get(row.period);
      if (!bucket) return;
      const plays = Number(row.plays || 0);
      bucket.byStation[idx].plays = plays;
      bucket.total += plays;
      if (plays > 0) bucket.activeStations += 1;
    });
  });
  const rows = Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period)).slice(-21).sort((a, b) => b.period.localeCompare(a.period));
  const maxValue = rows.reduce((m, row) => { row.byStation.forEach((s) => { if (s.plays > m) m = s.plays; }); return m; }, 0);
  const stationTotals = topStations.map((s) => ({
    stationId: s.stationId, stationName: s.stationName,
    total: rows.reduce((sum, r) => sum + Number(r.byStation.find((x) => x.stationId === s.stationId)?.plays || 0), 0)
  })).sort((a, b) => b.total - a.total);
  return { rows, stations: topStations, maxValue: Math.max(1, maxValue), stationTotals };
}

function computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays }) {
  if (!selectedTrack) return { score: 0, label: 'Kein Track', popularityPct: 0, momentumPct: 0, spreadPct: 0, dailyStrengthPct: 0 };
  const popularityPct = clamp((Number(selectedTrack.total_plays || 0) / Math.max(1, Number(maxTrackPlays || 1))) * 100, 0, 100);
  const momentumPct = clamp((Number(trend?.growth_percent || 0) + 100) / 2, 0, 100);
  const spreadPct = clamp((matrix.stationTotals.filter((r) => r.total > 0).length / Math.max(1, matrix.stations.length)) * 100, 0, 100);
  const dailyStrengthPct = clamp((Number(totals?.totals?.allTime || 0) / Math.max(1, rangeDays) / 8) * 100, 0, 100);
  const score = Math.round(popularityPct * 0.4 + momentumPct * 0.3 + spreadPct * 0.2 + dailyStrengthPct * 0.1);
  let label = 'Schwach';
  if (score >= 75) label = 'Sehr stark';
  else if (score >= 55) label = 'Gut';
  else if (score >= 35) label = 'Mittel';
  return { score, label, popularityPct, momentumPct, spreadPct, dailyStrengthPct };
}

function MetricLine({ label, value, colorScheme }) {
  const ui = useUiColors();
  return React.createElement(
    Chakra.Box, null,
    React.createElement(Chakra.HStack, { justify: 'space-between', mb: '1' },
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted }, label),
      React.createElement(Chakra.Text, { fontSize: 'sm', fontWeight: '700', color: ui.textPrimary }, `${value}%`)
    ),
    React.createElement(Chakra.Progress, { value: Number(value || 0), colorScheme, size: 'sm', borderRadius: '999px' })
  );
}

// ── TrackTrendLineChart ───────────────────────────────────────────────────────

function TrackTrendLineChart({ rows, mode }) {
  const ui = useUiColors();
  const points = Array.isArray(rows) ? rows : [];
  if (!points.length) return React.createElement(Chakra.Text, { color: ui.textMuted }, 'Keine Trenddaten im gewählten Zeitraum.');
  const values = points.map((r) => (mode === 'normalized' ? Number(r.normalizedPlays || 0) : Number(r.rawPlays || 0)));
  const maxValue = Math.max(1, ...values);
  const width = Math.max(760, points.length * 30);
  const height = 260;
  const margin = { top: 16, right: 16, bottom: 44, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const stepX = points.length > 1 ? plotW / (points.length - 1) : plotW;
  const xStep = Math.max(1, Math.floor(points.length / 8));
  const axisColor = 'var(--chart-axis)';
  const gridColor = 'var(--chart-grid)';
  const textColor = 'var(--chart-text)';
  const lineColor = mode === 'normalized' ? 'var(--chart-series-secondary)' : 'var(--chart-series-primary)';
  const path = points.map((r, i) => {
    const v = mode === 'normalized' ? Number(r.normalizedPlays || 0) : Number(r.rawPlays || 0);
    return `${i === 0 ? 'M' : 'L'} ${margin.left + i * stepX} ${margin.top + plotH - (v / maxValue) * plotH}`;
  }).join(' ');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => maxValue * r);
  return React.createElement(
    Chakra.Box, { overflowX: 'auto' },
    React.createElement('svg', { viewBox: `0 0 ${width} ${height}`, style: { width: '100%', minWidth: `${Math.min(width, 1300)}px`, height: 'auto' } },
      React.createElement('line', { x1: margin.left, y1: margin.top + plotH, x2: margin.left + plotW, y2: margin.top + plotH, stroke: axisColor, strokeWidth: '1.2' }),
      React.createElement('line', { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotH, stroke: axisColor, strokeWidth: '1.2' }),
      ...yTicks.map((tick, i) => {
        const y = margin.top + plotH - (tick / maxValue) * plotH;
        return React.createElement('g', { key: `y-${i}` },
          React.createElement('line', { x1: margin.left, y1: y, x2: margin.left + plotW, y2: y, stroke: gridColor, strokeDasharray: '4 4', strokeWidth: '1' }),
          React.createElement('text', { x: margin.left - 8, y: y + 4, textAnchor: 'end', fontSize: '11', fill: textColor },
            mode === 'normalized' ? toFixedLocale(tick, 2) : formatNumber(Math.round(tick)))
        );
      }),
      React.createElement('path', { d: path, fill: 'none', stroke: lineColor, strokeWidth: '2.5', strokeLinejoin: 'round', strokeLinecap: 'round' }),
      ...points.map((r, i) => {
        const v = mode === 'normalized' ? Number(r.normalizedPlays || 0) : Number(r.rawPlays || 0);
        const x = margin.left + i * stepX;
        const y = margin.top + plotH - (v / maxValue) * plotH;
        return React.createElement('g', { key: `pt-${r.period}` },
          React.createElement('circle', { cx: x, cy: y, r: '3.4', fill: lineColor },
            React.createElement('title', null, `${dayLabel(r.period)} | Roh: ${formatNumber(r.rawPlays)} | Panel: ${toFixedLocale(r.normalizedPlays, 2)}`)),
          (i % xStep === 0 || i === points.length - 1)
            ? React.createElement('text', { x, y: margin.top + plotH + 16, textAnchor: 'middle', fontSize: '10', fill: textColor }, dayLabel(r.period))
            : null
        );
      }),
      React.createElement('text', { x: margin.left + plotW / 2, y: height - 8, textAnchor: 'middle', fontSize: '11', fill: textColor }, 'Tag'),
      React.createElement('text', { x: '14', y: margin.top + plotH / 2, transform: `rotate(-90 14 ${margin.top + plotH / 2})`, textAnchor: 'middle', fontSize: '11', fill: textColor },
        mode === 'normalized' ? 'Plays je aktivem Sender' : 'Roh-Plays')
    )
  );
}

// ── LegacyStatsCharts ─────────────────────────────────────────────────────────

function LegacyStatsCharts({ selectedTrack, from, to, bucket, cumulativeSeries, bucketSeries, stationsByPlays, seriesByStation }) {
  const ui = useUiColors();
  const cumulativeRef = React.useRef(null);
  const periodRef = React.useRef(null);
  const stationBarRef = React.useRef(null);
  const perDayRef = React.useRef(null);

  const availablePeriods = React.useMemo(() => {
    const periods = Array.isArray(seriesByStation?.periods) ? [...seriesByStation.periods] : [];
    return periods.sort((a, b) => b.localeCompare(a));
  }, [seriesByStation]);

  const [selectedPeriod, setSelectedPeriod] = React.useState('');
  React.useEffect(() => { if (availablePeriods.length > 0) setSelectedPeriod(availablePeriods[0]); }, [availablePeriods]);

  const perDayStationRows = React.useMemo(() => {
    if (!selectedPeriod || !Array.isArray(seriesByStation?.stations)) return [];
    return seriesByStation.stations
      .map((s) => {
        const pt = (s.series || []).find((r) => r.period === selectedPeriod);
        return { station_id: s.stationId, station_name: s.stationName, plays: Number(pt?.plays || 0) };
      })
      .filter((r) => r.plays > 0)
      .sort((a, b) => b.plays - a.plays);
  }, [seriesByStation, selectedPeriod]);

  const renderMainCharts = React.useCallback(() => {
    const cN = cumulativeRef.current, pN = periodRef.current, sN = stationBarRef.current;
    if (!cN || !pN || !sN) return;
    const cumRows = toCumulativeSeries(Array.isArray(cumulativeSeries) ? cumulativeSeries : []);
    const cumStart = Number(cumRows[0]?.plays || 0);
    const cumEnd = Number(cumRows[cumRows.length - 1]?.plays || 0);
    renderLineChart(cN, cumRows, bucket, {
      showArea: true,
      stats: [
        { label: 'Stand', value: `${formatPlays(cumEnd)} Einsätze` },
        { label: 'Zuwachs', value: `+${formatPlays(Math.max(0, cumEnd - cumStart))}` },
        { label: 'Punkte', value: formatPlays(cumRows.length) }
      ]
    });
    const raw = Array.isArray(bucketSeries) ? bucketSeries : [];
    const norm = bucket === 'day' ? fillDailySeriesRange(raw, from, to) : raw;
    const total = norm.reduce((s, r) => s + Number(r.plays || 0), 0);
    const avg = norm.length ? total / norm.length : 0;
    const peak = norm.reduce((b, r) => { const p = Number(r.plays || 0); return (!b || p > b.plays) ? { period: r.period, plays: p } : b; }, null);
    renderDailyBarChart(pN, norm, bucket, {
      stats: [
        { label: 'Zeiträume', value: formatPlays(norm.length) },
        { label: bucket === 'day' ? 'Ø Einsätze/Tag' : 'Ø Einsätze/Zeitraum', value: avg.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) },
        { label: 'Spitze', value: peak ? `${formatSeriesPeriod(peak.period, bucket, true)} (${formatPlays(peak.plays)})` : '-' }
      ]
    });
    renderBarChart(sN, Array.isArray(stationsByPlays) ? stationsByPlays : []);
  }, [bucket, bucketSeries, cumulativeSeries, from, selectedTrack, stationsByPlays, to]);

  React.useEffect(() => { const n = perDayRef.current; if (!n) return; renderBarChart(n, perDayStationRows); }, [perDayStationRows]);
  React.useEffect(() => { renderMainCharts(); }, [renderMainCharts]);
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const nodes = [cumulativeRef.current, periodRef.current, stationBarRef.current, perDayRef.current].filter(Boolean);
    const obs = new ResizeObserver(() => window.requestAnimationFrame(renderMainCharts));
    nodes.forEach((n) => obs.observe(n));
    return () => obs.disconnect();
  }, [renderMainCharts]);

  if (!selectedTrack) return React.createElement(Chakra.Text, { color: ui.textMuted }, 'Kein Track ausgewählt.');

  return React.createElement(Chakra.VStack, { align: 'stretch', spacing: '4' },
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted, mb: '2' }, 'Gesamt-Plays (kumuliert)'),
      React.createElement('div', { className: 'legacy-chart', ref: cumulativeRef })
    ),
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted, mb: '2' }, 'Plays pro Zeitraum'),
      React.createElement('div', { className: 'legacy-chart', ref: periodRef })
    ),
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted, mb: '2' }, 'Plays je Sender'),
      React.createElement('div', { className: 'legacy-chart legacy-chart-tall', ref: stationBarRef })
    ),
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.HStack, { justify: 'space-between', align: 'center', mb: '2' },
        React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted }, 'Plays je Sender pro Tag'),
        React.createElement(Chakra.Select, { size: 'sm', w: '160px', value: selectedPeriod, onChange: (e) => setSelectedPeriod(e.target.value) },
          ...availablePeriods.map((p) => React.createElement('option', { key: p, value: p }, dayLabel(p)))
        )
      ),
      React.createElement('div', { className: 'legacy-chart legacy-chart-tall', ref: perDayRef })
    )
  );
}


function openTrackPage(trackKey) {
  navigate(trackHref(trackKey));
}

function playable(row) {
  return { trackKey: row.track_key, artist: row.artist, title: row.title, artworkUrl: row.artwork_url || null };
}

// ── SongPerformanceCard ───────────────────────────────────────────────────────

function SongPerformanceCard({ selectedTrack, trend, totals, matrix, maxTrackPlays, from, to }) {
  if (!selectedTrack) return html`<${Chakra.Text} color="textMuted">Kein Track geladen.<//>`;
  const rangeDays = dayCount(from, to);
  const score = computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays });
  const scheme = score.score >= 55 ? 'green' : score.score >= 35 ? 'orange' : 'red';
  return html`
    <${Chakra.VStack} align="stretch" spacing="5">
      <${Chakra.HStack} justify="space-between" align="end">
        <${Chakra.HStack} spacing="3" align="end">
          <${Chakra.Text} fontSize="5xl" lineHeight="1" fontWeight="800" letterSpacing="-0.04em" bgGradient="linear(135deg, brand.600, brand.400)" bgClip="text">
            ${score.score}
          <//>
          <${Chakra.Text} fontSize="md" color="textMuted" pb="1">/ 100<//>
        <//>
        <${Chakra.Badge} colorScheme=${scheme} px="3" py="1" fontSize="sm">${score.label}<//>
      <//>
      <${Chakra.Progress} value=${score.score} colorScheme="brand" borderRadius="full" size="sm" />
      <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacingX="6" spacingY="4">
        <${MetricLine} label="Beliebtheit im Panel" value=${score.popularityPct.toFixed(0)} colorScheme="brand" />
        <${MetricLine} label="Momentum" value=${score.momentumPct.toFixed(0)} colorScheme="green" />
        <${MetricLine} label="Sender-Breite" value=${score.spreadPct.toFixed(0)} colorScheme="purple" />
        <${MetricLine} label="Durchschnitt Plays/Tag" value=${score.dailyStrengthPct.toFixed(0)} colorScheme="orange" />
      <//>
      <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="3">
        ${[
          ['Plays im Zeitraum', formatNumber(totals?.totals?.allTime || 0)],
          ['Heute', formatNumber(totals?.totals?.today || 0)],
          ['Diese Woche', formatNumber(totals?.totals?.thisWeek || 0)],
          ['Letzte 48h', formatNumber(trend?.plays_last_48h || 0)]
        ].map(([label, value]) => html`
          <${Chakra.Box} key=${label} bg="subtleBg" borderRadius="14px" px="4" py="3">
            <${Chakra.Text} fontSize="xs" color="textMuted">${label}<//>
            <${Chakra.Text} fontSize="xl" fontWeight="800">${value}<//>
          <//>
        `)}
      <//>
    <//>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DashboardApp — track catalogue ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const RENDER_STEP = 500;

function DashboardApp() {
  const toast = Chakra.useToast();

  const [search, setSearch] = React.useState('');
  const [stationId, setStationId] = React.useState('');
  const [trackLimit, setTrackLimit] = React.useState('250');
  const [sortMode, setSortMode] = React.useState('plays_per_day_desc');
  const [stations, setStations] = React.useState([]);
  const [tracks, setTracks] = React.useState([]);
  const [loadingTracks, setLoadingTracks] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const [winnerTrackKey, setWinnerTrackKey] = React.useState('');
  const [loserTrackKey, setLoserTrackKey] = React.useState('');
  const [mergeState, setMergeState] = React.useState('');

  const debouncedSearch = useDebouncedValue(search, 250);
  const [favFilter, setFavFilter] = React.useState('all');
  const favVersion = useFavoriteVersion();
  React.useEffect(() => { ensureFavoritesLoaded(); }, []);
  const sortedTracks = React.useMemo(() => {
    const sorted = sortTracks(tracks, sortMode);
    if (favFilter === 'all') return sorted;
    return sorted.filter((row) => isFavoriteTrackKey(row.track_key) === (favFilter === 'only'));
  }, [tracks, sortMode, favFilter, favVersion]);

  // All rows are loaded (KPIs, sorting), but rendered in steps so "Alle" stays fast with many tracks.
  const [visibleCount, setVisibleCount] = React.useState(RENDER_STEP);
  React.useEffect(() => setVisibleCount(RENDER_STEP), [sortedTracks]);
  const visibleTracks = React.useMemo(() => sortedTracks.slice(0, visibleCount), [sortedTracks, visibleCount]);
  const hasMoreRows = visibleCount < sortedTracks.length;
  const sentinelRef = React.useRef(null);
  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMoreRows || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisibleCount((count) => count + RENDER_STEP);
    }, { rootMargin: '800px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreRows, visibleCount]);

  const trackSummary = React.useMemo(() => {
    const totalPlays = tracks.reduce((s, r) => s + Number(r.total_plays || 0), 0);
    const uniqueArtists = new Set(tracks.map((r) => String(r.artist || '').toLowerCase()).filter(Boolean)).size;
    const top = [...tracks].sort((a, b) => Number(b.total_plays || 0) - Number(a.total_plays || 0))[0] || null;
    return { tracks: tracks.length, plays: totalPlays, artists: uniqueArtists, top };
  }, [tracks]);

  const loadStations = React.useCallback(async () => {
    const rows = await apiFetch('/api/stations');
    setStations(Array.isArray(rows) ? rows : []);
  }, []);

  const loadTracks = React.useCallback(async () => {
    setLoadingTracks(true);
    setErrorText('');
    try {
      const params = new URLSearchParams({ q: debouncedSearch, stationId, limit: trackLimit });
      if (!stationId) params.delete('stationId');
      if (!debouncedSearch) params.delete('q');
      const rows = await apiFetch(`/api/tracks?${params}`);
      setTracks(Array.isArray(rows) ? rows : []);
    } catch (error) {
      setTracks([]);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTracks(false);
    }
  }, [debouncedSearch, stationId, trackLimit]);

  const deleteTrack = async (trackKey, artistTitle) => {
    if (!window.confirm(`"${artistTitle}" wirklich löschen und dauerhaft blockieren?\n\nDieser Track wird aus allen Plays entfernt und nie mehr gespeichert.`)) return;
    try {
      await apiFetch(`/api/admin/tracks/${encodeURIComponent(trackKey)}`, { method: 'DELETE' });
      toast({ status: 'success', title: 'Track gelöscht', description: `"${artistTitle}" wurde entfernt und blockiert.` });
      await loadTracks();
    } catch (error) {
      toast({ status: 'error', title: 'Löschen fehlgeschlagen', description: error instanceof Error ? error.message : String(error) });
    }
  };

  const [suggestions, setSuggestions] = React.useState(null);
  const [suggestionsLoading, setSuggestionsLoading] = React.useState(false);
  const [mergingKey, setMergingKey] = React.useState('');

  const loadSuggestions = async () => {
    setSuggestionsLoading(true);
    try {
      const result = await apiFetch('/api/merge-suggestions?limit=50');
      setSuggestions(result.suggestions || []);
    } catch (error) {
      toast({ status: 'error', title: 'Vorschläge nicht ladbar', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSuggestionsLoading(false);
    }
  };

  const acceptSuggestion = async (suggestion) => {
    const names = suggestion.losers.map((l) => `${l.artist} – ${l.title}`).join('\n');
    if (!window.confirm(`Zusammenführen in "${suggestion.winner.artist} – ${suggestion.winner.title}"?\n\n${names}\n\nDie Plays werden dauerhaft auf den Gewinner umgeschrieben.`)) return;
    setMergingKey(suggestion.winner.track_key);
    try {
      for (const loser of suggestion.losers) {
        await apiFetch('/api/admin/merge-tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ winnerTrackKey: suggestion.winner.track_key, loserTrackKey: loser.track_key })
        });
      }
      toast({ status: 'success', title: 'Zusammengeführt', description: `${suggestion.losers.length} Eintrag/Einträge in "${suggestion.winner.title}".` });
      setSuggestions((list) => (list || []).filter((s) => s.winner.track_key !== suggestion.winner.track_key));
      await loadTracks();
    } catch (error) {
      toast({ status: 'error', title: 'Merge fehlgeschlagen', description: error instanceof Error ? error.message : String(error) });
      await loadSuggestions();
    } finally {
      setMergingKey('');
    }
  };

  const ignoreSuggestion = async (suggestion) => {
    try {
      await apiFetch('/api/merge-suggestions/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winnerTrackKey: suggestion.winner.track_key, loserTrackKeys: suggestion.losers.map((l) => l.track_key) })
      });
      setSuggestions((list) => (list || []).filter((s) => s.winner.track_key !== suggestion.winner.track_key));
    } catch (error) {
      toast({ status: 'error', title: 'Nicht gespeichert', description: error instanceof Error ? error.message : String(error) });
    }
  };

  const runMerge = async () => {
    if (!winnerTrackKey.trim() || !loserTrackKey.trim()) {
      setMergeState('Bitte beide Track Keys ausfüllen.');
      return;
    }
    try {
      const result = await apiFetch('/api/admin/merge-tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winnerTrackKey: winnerTrackKey.trim(), loserTrackKey: loserTrackKey.trim() })
      });
      setMergeState(`Merge abgeschlossen: ${formatNumber(result?.updatedPlays || 0)} Plays aktualisiert.`);
      toast({ status: 'success', title: 'Merge abgeschlossen' });
      setWinnerTrackKey('');
      setLoserTrackKey('');
      await loadTracks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setMergeState(`Merge fehlgeschlagen: ${msg}`);
      toast({ status: 'error', title: 'Merge fehlgeschlagen', description: msg });
    }
  };

  React.useEffect(() => { loadStations().catch(() => {}); }, [loadStations]);
  React.useEffect(() => { loadTracks(); }, [loadTracks]);

  const top = trackSummary.top;
  const firstLoad = loadingTracks && tracks.length === 0;
  const kpi = (value) => (firstLoad ? '…' : value);

  return html`
    <${AppShell}
      activeKey="dashboard"
      title="Dashboard"
      subtitle="Track-Katalog aller beobachteten Sender"
      controls=${html`
        <${Chakra.Button} size="sm" leftIcon=${html`<${Icons.RepeatIcon} />`} onClick=${() => loadTracks()} isLoading=${loadingTracks} colorScheme="brand">
          Neu laden
        <//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="6">
        ${errorText ? html`
          <${Chakra.Alert} status="error" borderRadius="14px">
            <${Chakra.AlertIcon} />
            <${Chakra.Text}>${errorText}<//>
          <//>
        ` : null}

        <${Chakra.SimpleGrid} columns=${{ base: 2, xl: 4 }} spacing=${{ base: "3", md: "4" }}>
          <${StatTile} accent label="Gefundene Titel" value=${kpi(formatNumber(trackSummary.tracks))} icon=${AppIcons.Music} hint=${stationId ? 'im gewählten Sender' : 'über alle Sender'} />
          <${StatTile} label="Einsätze gesamt" value=${kpi(formatNumber(trackSummary.plays))} icon=${AppIcons.Activity} />
          <${StatTile} label="Künstler" value=${kpi(formatNumber(trackSummary.artists))} icon=${AppIcons.Users} />
          <${StatTile}
            label="Meistgespielt"
            value=${firstLoad ? '…' : top ? top.title : '–'}
            hint=${top ? `${top.artist} · ${formatNumber(top.total_plays)} Plays` : null}
            icon=${AppIcons.Zap}
          />
        <//>

        <${PanelCard} p="0">
          <${Chakra.Flex} px="5" pt="5" pb="4" gap="3" wrap="wrap" align="end">
            <${Chakra.InputGroup} flex="2 1 260px">
              <${Chakra.InputLeftElement} pointerEvents="none" color="textMuted"><${AppIcons.Search} /><//>
              <${Chakra.Input} placeholder="Interpret oder Titel suchen" value=${search} onChange=${(e) => setSearch(e.target.value)} />
            <//>
            <${Chakra.Select} flex="1 1 180px" value=${stationId} onChange=${(e) => setStationId(e.target.value)}>
              <option value="">Alle Sender</option>
              ${stations.map((s) => html`<option key=${s.id} value=${s.id}>${s.name || s.id}</option>`)}
            <//>
            <${Chakra.Select} flex="1 1 160px" value=${sortMode} onChange=${(e) => setSortMode(e.target.value)}>
              ${SORT_OPTIONS.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
            <//>
            <${Chakra.Select} flex="0 1 170px" value=${favFilter} onChange=${(e) => setFavFilter(e.target.value)} aria-label="Favoriten-Filter">
              <option value="all">Alle Songs</option>
              <option value="only">Nur Favoriten</option>
              <option value="exclude">Ohne Favoriten</option>
            <//>
            <${Chakra.Select} flex="0 1 130px" value=${trackLimit} onChange=${(e) => setTrackLimit(e.target.value)}>
              ${['100', '250', '500', '1000', 'all'].map((v) => html`<option key=${v} value=${v}>${v === 'all' ? 'Alle' : `${v} Titel`}</option>`)}
            <//>
          <//>
          <${Chakra.Flex} px="5" pb="3" justify="space-between" align="center">
            <${Chakra.Text} fontSize="sm" color="textMuted">
              ${loadingTracks ? 'Lade…' : `${formatNumber(sortedTracks.length)} Titel${hasMoreRows ? ` · ${formatNumber(visibleTracks.length)} angezeigt` : ''}`}
            <//>
            ${(winnerTrackKey || loserTrackKey) ? html`
              <${Chakra.HStack} spacing="2">
                ${winnerTrackKey ? html`<${Chakra.Badge} colorScheme="green">Winner gewählt<//>` : null}
                ${loserTrackKey ? html`<${Chakra.Badge} colorScheme="red">Loser gewählt<//>` : null}
              <//>
            ` : null}
          <//>
          <${LoadingOverlay} isLoading=${loadingTracks && sortedTracks.length > 0} label="Titel werden geladen…">
          <${Chakra.TableContainer} className="horizon-scroll" borderTop="1px solid" borderColor="lineColor">
            <${Chakra.Table} size="sm">
              <${Chakra.Thead} bg="subtleBg">
                <${Chakra.Tr}>
                  <${Chakra.Th} w="44px" py="3" textAlign="right">#<//>
                  <${Chakra.Th} py="3">Titel<//>
                  <${Chakra.Th} py="3" isNumeric>Plays<//>
                  <${Chakra.Th} py="3" isNumeric>Plays/Tag<//>
                  <${Chakra.Th} py="3">Zuletzt gespielt<//>
                  <${Chakra.Th} py="3" textAlign="right">Aktionen<//>
                <//>
              <//>
              <${Chakra.Tbody}>
                ${loadingTracks && sortedTracks.length === 0 ? html`<${SkeletonRows} rows=${8} columns=${6} />` : null}
                ${visibleTracks.map((row, index) => html`
                  <${Chakra.Tr}
                    key=${row.track_key}
                    className="rv-row-clickable group"
                    _hover=${{ bg: 'subtleBg' }}
                    onClick=${() => openTrackPage(row.track_key)}
                  >
                    <${Chakra.Td} py="2.5" textAlign="right" color="textMuted" fontSize="xs" fontWeight="600">${index + 1}<//>
                    <${Chakra.Td} py="2.5" w="52%">
                      <${Chakra.HStack} spacing="3" w="100%">
                        <${CoverPlay} track=${playable(row)} size="44px" />
                        <${Chakra.Box} minW="0">
                          <${Chakra.Text} fontWeight="700" fontSize="sm" color="textPrimary" noOfLines=${1}>${row.title}<//>
                          <${Chakra.Text} fontSize="sm" color="textMuted" noOfLines=${1}>${row.artist}<//>
                        <//>
                        <${CopyTrackButton} artist=${row.artist} title=${row.title} />
<${OwnPlayBadge} artist=${row.artist} title=${row.title} trackKey=${row.track_key} />
<${Chakra.Spacer} />
<${FavoriteButton} artist=${row.artist} title=${row.title} trackKey=${row.track_key} artworkUrl=${row.artwork_url} />
                      <//>
                    <//>
                    <${Chakra.Td} py="2.5" isNumeric fontWeight="700">${formatNumber(row.total_plays)}<//>
                    <${Chakra.Td} py="2.5" isNumeric>${Number(row.plays_per_day || 0).toLocaleString('de-DE', { maximumFractionDigits: 1 })}<//>
                    <${Chakra.Td} py="2.5" fontSize="sm" color="textMuted">
                      <${Chakra.Tooltip} label=${formatDateTime(row.last_played_at_utc)}><span>${formatRelative(row.last_played_at_utc)}</span><//>
                    <//>
                    <${Chakra.Td} py="2.5" onClick=${(e) => e.stopPropagation()}>
                      <${Chakra.HStack} spacing="1" justify="flex-end">
                        <${Chakra.Tooltip} label="Als Winner für Merge wählen">
                          <${Chakra.Button}
                            size="xs"
                            variant=${winnerTrackKey === row.track_key ? 'solid' : 'ghost'}
                            colorScheme=${winnerTrackKey === row.track_key ? 'green' : 'gray'}
                            onClick=${() => setWinnerTrackKey(winnerTrackKey === row.track_key ? '' : row.track_key)}
                          >W<//>
                        <//>
                        <${Chakra.Tooltip} label="Als Loser für Merge wählen">
                          <${Chakra.Button}
                            size="xs"
                            variant=${loserTrackKey === row.track_key ? 'solid' : 'ghost'}
                            colorScheme=${loserTrackKey === row.track_key ? 'red' : 'gray'}
                            onClick=${() => setLoserTrackKey(loserTrackKey === row.track_key ? '' : row.track_key)}
                          >L<//>
                        <//>
                        <${Chakra.Tooltip} label="Löschen und sperren">
                          <${Chakra.IconButton}
                            size="xs"
                            variant="ghost"
                            colorScheme="red"
                            aria-label="Löschen"
                            icon=${html`<${Icons.DeleteIcon} />`}
                            onClick=${() => deleteTrack(row.track_key, `${row.artist} – ${row.title}`)}
                          />
                        <//>
                        <${Chakra.IconButton}
                          size="xs"
                          variant="ghost"
                          aria-label="Öffnen"
                          icon=${html`<${Icons.ChevronRightIcon} boxSize="4" />`}
                          onClick=${() => openTrackPage(row.track_key)}
                        />
                      <//>
                    <//>
                  <//>
                `)}
                ${sortedTracks.length === 0 && !loadingTracks ? html`
                  <${Chakra.Tr}><${Chakra.Td} colSpan=${6} color="textMuted" py="10" textAlign="center">Keine Treffer. Filter anpassen.<//><//>
                ` : null}
              <//>
            <//>
          <//>
          <//>
          ${hasMoreRows ? html`
            <${Chakra.Flex} ref=${sentinelRef} justify="center" align="center" gap="3" py="5" borderTop="1px solid" borderColor="lineColor">
              <${Chakra.Spinner} size="sm" color="brand.400" />
              <${Chakra.Button} size="sm" variant="ghost" colorScheme="brand" onClick=${() => setVisibleCount((count) => count + RENDER_STEP)}>
                Weitere ${formatNumber(Math.min(RENDER_STEP, sortedTracks.length - visibleCount))} von ${formatNumber(sortedTracks.length - visibleCount)} Titeln anzeigen
              <//>
            <//>
          ` : null}
        <//>

        <${PanelCard} title="Track-Merge" subtitle="Doppelte Einträge zusammenführen: Vorschläge prüfen, W/L in der Tabelle wählen oder Keys eintragen." icon=${AppIcons.Link}>
          <${Chakra.Box} mb="5">
            <${Chakra.HStack} justify="space-between" mb="2">
              <${Chakra.Text} fontWeight="700" fontSize="sm">Vorschläge<//>
              <${Chakra.Button} size="sm" variant="outline" onClick=${loadSuggestions} isLoading=${suggestionsLoading}>${suggestions ? 'Neu suchen' : 'Dubletten suchen'}<//>
            <//>
            ${suggestions && !suggestions.length ? html`<${Chakra.Text} fontSize="sm" color="textMuted">Keine Dubletten gefunden.<//>` : null}
            <${Chakra.VStack} align="stretch" spacing="2">
              ${(suggestions || []).map((s) => html`
                <${Chakra.Box} key=${s.winner.track_key} border="1px solid" borderColor="lineColor" borderRadius="14px" p="3">
                  <${Chakra.Flex} gap="3" align="center" wrap="wrap">
                    <${Chakra.Box} flex="1 1 320px" minW="0">
                      <${Chakra.HStack} spacing="2" mb="1">
                        <${Chakra.Badge} colorScheme=${s.reason === 'isrc' ? 'green' : 'orange'}>${s.reason === 'isrc' ? 'Gleiche ISRC' : 'Ähnlicher Name'}<//>
                        <${Chakra.Text} fontSize="xs" color="textMuted">${formatNumber(s.total_plays)} Plays insgesamt<//>
                      <//>
                      <${Chakra.Text} fontSize="sm" fontWeight="700">Bleibt: ${s.winner.artist} – ${s.winner.title} <${Chakra.Text} as="span" color="textMuted" fontWeight="500">(${formatNumber(s.winner.plays)} Plays)<//><//>
                      ${s.losers.map((l) => html`
                        <${Chakra.Text} key=${l.track_key} fontSize="sm" color="textMuted">Wird eingefügt: ${l.artist} – ${l.title} (${formatNumber(l.plays)} Plays)<//>
                      `)}
                    <//>
                    <${Chakra.HStack} spacing="2">
                      <${Chakra.Button} size="sm" colorScheme="brand" onClick=${() => acceptSuggestion(s)} isLoading=${mergingKey === s.winner.track_key}>Zusammenführen<//>
                      <${Chakra.Button} size="sm" variant="ghost" onClick=${() => ignoreSuggestion(s)}>Ignorieren<//>
                    <//>
                  <//>
                <//>
              `)}
            <//>
          <//>
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 3 }} spacing="3" alignItems="end">
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Winner Track Key<//>
              <${Chakra.Input} value=${winnerTrackKey} onChange=${(e) => setWinnerTrackKey(e.target.value)} placeholder="winner-key" fontFamily="mono" fontSize="sm" />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Loser Track Key<//>
              <${Chakra.Input} value=${loserTrackKey} onChange=${(e) => setLoserTrackKey(e.target.value)} placeholder="loser-key" fontFamily="mono" fontSize="sm" />
            <//>
            <${Chakra.Button} colorScheme="red" variant="outline" onClick=${runMerge} isDisabled=${!winnerTrackKey || !loserTrackKey}>Merge ausführen<//>
          <//>
          ${mergeState ? html`<${Chakra.Text} mt="3" fontSize="sm" color="textMuted">${mergeState}<//>` : null}
        <//>
      <//>
    <//>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── TrackDetailApp — song page ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const ROLE_LABELS = { Main: 'Hauptkünstler', Featured: 'Featured', Composer: 'Komponist', Producer: 'Produzent' };
const RECORD_TYPES = { single: 'Single', album: 'Album', ep: 'EP', compile: 'Compilation' };

function searchLinks(artist, title, isrc, itunesUrl) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return [
    { label: 'Spotify', href: `https://open.spotify.com/search/${q}` },
    { label: 'Apple Music', href: itunesUrl || `https://music.apple.com/de/search?term=${q}` },
    { label: 'YouTube', href: `https://www.youtube.com/results?search_query=${q}` },
    { label: 'Genius', href: `https://genius.com/search?q=${q}` },
    { label: 'MusicBrainz', href: isrc ? `https://musicbrainz.org/isrc/${encodeURIComponent(isrc)}` : `https://musicbrainz.org/search?query=${q}&type=recording` }
  ];
}

function HeroChip({ icon, label, value, href, onCopy }) {
  if (!value) return null;
  const IconComponent = icon;
  const content = html`
    <${Chakra.HStack}
      spacing="2"
      px="3"
      py="2"
      borderRadius="12px"
      bg="whiteAlpha.100"
      border="1px solid"
      borderColor="whiteAlpha.200"
      color="white"
      _hover=${href || onCopy ? { bg: 'whiteAlpha.200' } : undefined}
      transition="background 0.15s ease"
    >
      ${IconComponent ? html`<${IconComponent} boxSize="14px" color="brand.300" />` : null}
      <${Chakra.Box} lineHeight="1.2">
        <${Chakra.Text} fontSize="10px" textTransform="uppercase" letterSpacing="0.1em" color="whiteAlpha.600" fontWeight="700">${label}<//>
        <${Chakra.Text} fontSize="sm" fontWeight="600" noOfLines=${1}>${value}<//>
      <//>
      ${onCopy ? html`<${Icons.CopyIcon} boxSize="3" color="whiteAlpha.600" />` : null}
    <//>
  `;
  if (href) return html`<${Chakra.Link} href=${href} isExternal _hover=${{ textDecoration: 'none' }}>${content}<//>`;
  if (onCopy) return html`<${Chakra.Box} as="button" onClick=${onCopy} textAlign="left">${content}<//>`;
  return content;
}

function TrackHero({ details, fallbackTrack, trackKey, loading, onRefresh, refreshing }) {
  const toast = Chakra.useToast();
  const deezer = details?.deezer || null;
  const title = details?.title || fallbackTrack?.title || '…';
  const artist = details?.artist || fallbackTrack?.artist || '';
  const artwork = details?.artwork || fallbackTrack?.artwork_url || null;
  const isrc = deezer?.track?.isrc || details?.metadata?.isrc || null;
  const releaseDate = deezer?.track?.release_date || deezer?.album?.release_date || details?.metadata?.release_date_utc || null;
  const durationSeconds = deezer?.track?.duration || (details?.metadata?.duration_ms ? details.metadata.duration_ms / 1000 : null);
  const album = deezer?.album?.title || details?.metadata?.album || null;
  const label = deezer?.album?.label || details?.metadata?.label || null;
  const genres = deezer?.album?.genres?.length ? deezer.album.genres.join(', ') : details?.metadata?.genre || null;
  const contributors = deezer?.contributors || [];
  const collabs = contributors.length > 1 ? contributors : [];

  const copyIsrc = async () => {
    try {
      await navigator.clipboard.writeText(isrc);
      toast({ status: 'success', title: 'ISRC kopiert', description: isrc, duration: 2000 });
    } catch {
      toast({ status: 'warning', title: 'Kopieren nicht möglich', description: isrc });
    }
  };

  return html`
    <${Chakra.Box} position="relative" overflow="hidden" borderRadius="28px" bg=${NIGHT_GRADIENT} color="white" boxShadow="0 24px 60px rgba(2, 6, 23, 0.35)">
      ${artwork ? html`<${Chakra.Box} className="rv-hero-backdrop" style=${{ backgroundImage: `url("${artwork}")` }} />` : null}
      <${Chakra.Box} position="absolute" inset="0" bg="linear-gradient(90deg, rgba(2,6,23,0.92) 0%, rgba(2,6,23,0.72) 55%, rgba(2,6,23,0.55) 100%)" />
      <${Chakra.Flex} position="relative" direction=${{ base: 'column', md: 'row' }} gap=${{ base: '6', md: '8' }} p=${{ base: '5', md: '8' }} align=${{ base: 'stretch', md: 'center' }}>
        <${Chakra.Box} position="relative" alignSelf=${{ base: 'center', md: 'auto' }}>
          ${loading && !artwork
            ? html`<${Chakra.Skeleton} boxSize=${{ base: '200px', md: '230px' }} borderRadius="22px" startColor="whiteAlpha.200" endColor="whiteAlpha.400" />`
            : html`<${Chakra.Box} boxShadow="0 24px 50px rgba(0,0,0,0.5)" borderRadius="22px"><${TrackCover} src=${artwork} size="230px" radius="22px" alt=${album || title} /><//>`}
          <${Chakra.Box} position="absolute" right="-12px" bottom="-12px">
            <${PlayButton} track=${{ trackKey, artist, title, artworkUrl: details?.artworkSmall || artwork }} size="lg" />
          <//>
        <//>

        <${Chakra.VStack} align="stretch" spacing="4" flex="1" minW="0">
          <${Chakra.HStack} spacing="2" flexWrap="wrap">
            <${Chakra.Badge} bg="whiteAlpha.200" color="brand.200" fontSize="10px" letterSpacing="0.12em" textTransform="uppercase">Song<//>
            ${deezer?.album?.record_type ? html`<${Chakra.Badge} bg="whiteAlpha.200" color="whiteAlpha.900">${RECORD_TYPES[deezer.album.record_type] || deezer.album.record_type}<//>` : null}
            ${deezer?.track?.explicit_lyrics ? html`<${Chakra.Badge} colorScheme="red" variant="solid">Explicit<//>` : null}
            ${deezer ? html`<${Chakra.Badge} bg="whiteAlpha.200" color="whiteAlpha.800">Deezer-Daten<//>` : loading ? html`<${Chakra.Badge} bg="whiteAlpha.200" color="whiteAlpha.700" className="rv-pulse">Lade Deezer-Daten…<//>` : null}
          <//>
          <${Chakra.Box}>
            <${Chakra.HStack} align="flex-start" spacing="2" w="100%">
              <${Chakra.Heading} size="2xl" letterSpacing="-0.03em" lineHeight="1.1" noOfLines=${2}>${title}<//>
              ${artist ? html`
                <${Chakra.Box} color="whiteAlpha.800" pt="1"><${CopyTrackButton} artist=${artist} title=${title} size="md" color="whiteAlpha.800" _hover=${{ bg: 'whiteAlpha.200' }} /><//>
                <${OwnPlayBadge} artist=${artist} title=${title} trackKey=${trackKey} />
                <${Chakra.Spacer} />
                <${Chakra.Box} color="whiteAlpha.800" pt="1"><${FavoriteButton} artist=${artist} title=${title} trackKey=${trackKey} artworkUrl=${details?.artworkSmall || artwork} size="md" color="whiteAlpha.800" _hover=${{ bg: 'whiteAlpha.200' }} /><//>
              ` : null}
            <//>
            <${Chakra.Text} mt="2" fontSize="xl" color="whiteAlpha.800" fontWeight="500" noOfLines=${2}>
              ${deezer?.artist?.link
                ? html`<${Chakra.Link} href=${deezer.artist.link} isExternal _hover=${{ color: 'brand.300' }}>${artist}<//>`
                : artist}
            <//>
          <//>

          ${collabs.length ? html`
            <${Chakra.HStack} spacing="2" flexWrap="wrap">
              <${Chakra.Text} fontSize="xs" color="whiteAlpha.600" fontWeight="700" textTransform="uppercase" letterSpacing="0.1em">Mitwirkende<//>
              ${collabs.map((c) => html`
                <${Chakra.Link} key=${c.id} href=${c.link} isExternal _hover=${{ textDecoration: 'none' }}>
                  <${Chakra.HStack} spacing="2" pl="1" pr="3" py="1" borderRadius="full" bg="whiteAlpha.100" _hover=${{ bg: 'whiteAlpha.200' }}>
                    <${Chakra.Avatar} size="xs" name=${c.name} src=${c.picture || undefined} />
                    <${Chakra.Text} fontSize="sm" fontWeight="600">${c.name}<//>
                    ${c.role && c.role !== 'Main' ? html`<${Chakra.Text} fontSize="xs" color="brand.300">${ROLE_LABELS[c.role] || c.role}<//>` : null}
                  <//>
                <//>
              `)}
            <//>
          ` : null}

          <${Chakra.Wrap} spacing="2">
            <${HeroChip} icon=${AppIcons.Disc} label="Album" value=${album} href=${deezer?.album?.link} />
            <${HeroChip} icon=${AppIcons.Calendar} label="Erschienen" value=${releaseDate ? formatDate(releaseDate) : null} />
            <${HeroChip} icon=${AppIcons.Clock} label="Dauer" value=${durationSeconds ? formatDuration(durationSeconds) : null} />
            <${HeroChip} icon=${AppIcons.Tag} label="ISRC" value=${isrc} onCopy=${isrc ? copyIsrc : null} />
            <${HeroChip} icon=${AppIcons.Report} label="Label" value=${label} />
            <${HeroChip} icon=${AppIcons.Music} label="Genre" value=${genres} />
            <${HeroChip} icon=${AppIcons.Activity} label="BPM" value=${deezer?.track?.bpm ? Math.round(deezer.track.bpm) : null} />
            <${HeroChip} icon=${AppIcons.Zap} label="Deezer-Rang" value=${deezer?.track?.rank ? formatNumber(deezer.track.rank) : null} />
          <//>

          <${Chakra.Wrap} spacing="2">
            ${deezer?.track?.link ? html`
              <${Chakra.Button} as="a" href=${deezer.track.link} target="_blank" rel="noreferrer" size="sm" bg=${BRAND_GRADIENT} color="white" _hover=${{ filter: 'brightness(1.1)' }} rightIcon=${html`<${Icons.ExternalLinkIcon} />`}>
                Auf Deezer öffnen
              <//>
            ` : null}
            ${(artist || title ? searchLinks(artist, title, isrc, details?.metadata?.external_url) : []).map((link) => html`
              <${Chakra.Button} key=${link.label} as="a" href=${link.href} target="_blank" rel="noreferrer" size="sm" variant="outline" color="white" borderColor="whiteAlpha.300" _hover=${{ bg: 'whiteAlpha.200' }}>
                ${link.label}
              <//>
            `)}
            <${Chakra.Tooltip} label="Deezer-Daten neu abrufen">
              <${Chakra.IconButton} size="sm" variant="ghost" color="whiteAlpha.700" _hover=${{ bg: 'whiteAlpha.200', color: 'white' }} aria-label="Neu abrufen" icon=${html`<${Icons.RepeatIcon} />`} onClick=${onRefresh} isLoading=${refreshing} />
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

function StationsCard({ stations, total, loading }) {
  const max = Math.max(1, ...stations.map((s) => Number(s.plays || 0)));
  return html`
    <${PanelCard} title="Läuft bei" subtitle=${loading ? 'Lade…' : `${stations.length} Sender · ${formatNumber(total)} Plays insgesamt`} icon=${AppIcons.Radio}>
      ${loading ? html`<${LoadingSpinner} label="Lade Sender…" py="10" />` : stations.length ? html`
        <${Chakra.VStack} align="stretch" spacing="3" maxH="420px" overflowY="auto" className="horizon-scroll" pr="1">
          ${stations.map((s) => html`
            <${Chakra.Box} key=${s.station_id}>
              <${Chakra.HStack} justify="space-between" mb="1">
                <${Chakra.Text} fontSize="sm" fontWeight="600" noOfLines=${1}>${s.station_name}<//>
                <${Chakra.Text} fontSize="sm" fontWeight="700">${formatNumber(s.plays)}<//>
              <//>
              <${Chakra.Box} h="6px" borderRadius="full" bg="subtleBg" overflow="hidden">
                <${Chakra.Box} h="100%" w=${`${(Number(s.plays) / max) * 100}%`} bg=${BRAND_GRADIENT} borderRadius="full" />
              <//>
              <${Chakra.Text} mt="1" fontSize="xs" color="textMuted">Zuletzt ${formatRelative(s.last_played_at_utc)} · seit ${formatDate(s.first_played_at_utc)}<//>
            <//>
          `)}
        <//>
      ` : html`<${Chakra.Text} color="textMuted">Noch keine Plays.<//>`}
    <//>
  `;
}

function RecentPlaysCard({ plays, loading }) {
  return html`
    <${PanelCard} title="Zuletzt gespielt" subtitle="Die letzten Einsätze im Radio" icon=${AppIcons.Clock}>
      ${loading ? html`<${LoadingSpinner} label="Lade Einsätze…" py="10" />` : plays.length ? html`
        <${Chakra.VStack} align="stretch" spacing="0" maxH="420px" overflowY="auto" className="horizon-scroll" pr="1">
          ${plays.map((p, index) => html`
            <${Chakra.HStack} key=${`${p.played_at_utc}-${p.station_id}-${index}`} spacing="3" py="2.5" borderBottom=${index === plays.length - 1 ? 'none' : '1px solid'} borderColor="lineColor">
              <${Chakra.Box} w="8px" h="8px" borderRadius="full" bg=${index === 0 ? 'brand.400' : 'navy.200'} flexShrink="0" />
              <${Chakra.Box} flex="1" minW="0">
                <${Chakra.Text} fontSize="sm" fontWeight="600" noOfLines=${1}>${p.station_name}<//>
                <${Chakra.Text} fontSize="xs" color="textMuted" noOfLines=${1}>„${p.artist_raw} – ${p.title_raw}“<//>
              <//>
              <${Chakra.Box} textAlign="right" flexShrink="0">
                <${Chakra.Text} fontSize="sm" fontWeight="600">${formatRelative(p.played_at_utc)}<//>
                <${Chakra.Text} fontSize="xs" color="textMuted">${formatDateTime(p.played_at_utc)}<//>
              <//>
            <//>
          `)}
        <//>
      ` : html`<${Chakra.Text} color="textMuted">Noch keine Plays.<//>`}
    <//>
  `;
}

function ArtistCard({ deezer }) {
  const artist = deezer?.artist;
  if (!artist) return null;
  return html`
    <${PanelCard} title="Über den Künstler" icon=${AppIcons.Users}>
      <${Chakra.HStack} spacing="4" align="center">
        <${Chakra.Avatar} size="xl" name=${artist.name} src=${artist.picture || undefined} />
        <${Chakra.Box} minW="0">
          <${Chakra.Heading} size="md" noOfLines=${1}>${artist.name}<//>
          <${Chakra.HStack} mt="2" spacing="4" color="textMuted" fontSize="sm">
            ${artist.nb_fan != null ? html`<${Chakra.Text}><b>${formatNumber(artist.nb_fan)}</b> Fans<//>` : null}
            ${artist.nb_album != null ? html`<${Chakra.Text}><b>${formatNumber(artist.nb_album)}</b> Veröffentlichungen<//>` : null}
          <//>
          <${Chakra.Link} mt="2" display="inline-flex" alignItems="center" gap="1" href=${artist.link} isExternal color="accent" fontSize="sm" fontWeight="600">
            Künstlerseite auf Deezer <${Icons.ExternalLinkIcon} />
          <//>
        <//>
      <//>
      ${deezer?.album ? html`
        <${Chakra.HStack} mt="5" spacing="3" p="3" borderRadius="14px" bg="subtleBg">
          <${TrackCover} src=${deezer.album.cover_small} size="56px" />
          <${Chakra.Box} minW="0">
            <${Chakra.Text} fontSize="xs" color="textMuted">${RECORD_TYPES[deezer.album.record_type] || 'Album'}${deezer.album.nb_tracks ? ` · ${deezer.album.nb_tracks} Titel` : ''}<//>
            <${Chakra.Link} href=${deezer.album.link} isExternal fontWeight="700" noOfLines=${1}>${deezer.album.title}<//>
            <${Chakra.Text} fontSize="xs" color="textMuted">
              ${[deezer.album.label, deezer.album.release_date ? formatDate(deezer.album.release_date) : null, deezer.album.upc ? `UPC ${deezer.album.upc}` : null].filter(Boolean).join(' · ')}
            <//>
          <//>
        <//>
      ` : null}
    <//>
  `;
}

function SpellingsCard({ spellings }) {
  if (!spellings?.length) return null;
  return html`
    <${PanelCard} title="Schreibweisen der Sender" subtitle="So liefern die Quellen diesen Titel – zusammengeführt zu einem Track" icon=${AppIcons.Tag}>
      <${Chakra.VStack} align="stretch" spacing="2">
        ${spellings.map((s, index) => html`
          <${Chakra.HStack} key=${index} justify="space-between" spacing="3" px="3" py="2" borderRadius="12px" bg="subtleBg">
            <${Chakra.Text} fontSize="sm" noOfLines=${1} fontFamily="mono">${s.artist_raw} – ${s.title_raw}<//>
            <${Chakra.Text} fontSize="xs" color="textMuted" flexShrink="0">${formatNumber(s.plays)}× · ${s.stations} Sender<//>
          <//>
        `)}
      <//>
    <//>
  `;
}

function TrackDetailApp({ trackKey }) {
  const defaultTo = berlinYesterdayIsoDate();
  const defaultFrom = shiftBerlinIsoDate(defaultTo, -29);
  const [from, setFrom] = React.useState(defaultFrom);
  const [to, setTo] = React.useState(defaultTo);
  const [bucket, setBucket] = React.useState('day');
  const [includeToday, setIncludeToday] = React.useState(true);

  const [track, setTrack] = React.useState(null);
  const [details, setDetails] = React.useState(null);
  const [detailsLoading, setDetailsLoading] = React.useState(true);
  const [detailsRefreshing, setDetailsRefreshing] = React.useState(false);
  const [totals, setTotals] = React.useState(null);
  const [trend, setTrend] = React.useState(null);
  const [seriesByStation, setSeriesByStation] = React.useState(null);
  const [stationsByPlays, setStationsByPlays] = React.useState([]);
  const [cumulativeSeries, setCumulativeSeries] = React.useState([]);
  const [activeSenderSeries, setActiveSenderSeries] = React.useState([]);
  const [bucketSeries, setBucketSeries] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [errorText, setErrorText] = React.useState('');

  const effectiveTo = includeToday ? berlinTodayIsoDate() : to;
  const matrix = React.useMemo(() => buildDayStationMatrix(seriesByStation), [seriesByStation]);
  const dailyTrendRows = React.useMemo(() => buildDailyTrackTrendRows(seriesByStation, activeSenderSeries), [seriesByStation, activeSenderSeries]);

  const loadDetails = React.useCallback(async (refresh = false) => {
    if (refresh) setDetailsRefreshing(true);
    else setDetailsLoading(true);
    try {
      const result = await apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/details${refresh ? '?refresh=1' : ''}`);
      setDetails(result);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailsLoading(false);
      setDetailsRefreshing(false);
    }
  }, [trackKey]);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setErrorText('');
    try {
      const detailParams = new URLSearchParams({ from, to: effectiveTo });
      const stationParams = new URLSearchParams({ from, to: effectiveTo, bucket: 'day', limit: '12' });
      const stationsByPlaysParams = new URLSearchParams({ from, to: effectiveTo });
      const bucketParams = new URLSearchParams({ from, to: effectiveTo, bucket });
      const cumulativeParams = new URLSearchParams({ from: '2000-01-01', to: effectiveTo, bucket });
      const panelParams = new URLSearchParams({ from, to: effectiveTo, minPlays: '50' });

      const [trackRes, totalsRes, trendRes, stationRes, stationsByPlaysRes, bucketRes, cumulativeRes, panelRes] = await Promise.all([
        apiFetch(`/api/tracks?${new URLSearchParams({ includeTrackKey: trackKey, limit: '1' })}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/totals?${detailParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/trend`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series-by-station?${stationParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/stations?${stationsByPlaysParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${bucketParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${cumulativeParams}`),
        apiFetch(`/api/panel/active-senders?${panelParams}`)
      ]);

      const trackRow = Array.isArray(trackRes) ? trackRes.find((r) => r.track_key === trackKey) || trackRes[0] : null;
      setTrack(trackRow || null);
      setTotals(totalsRes || null);
      setTrend(trendRes || null);
      setSeriesByStation(stationRes || null);
      setStationsByPlays(Array.isArray(stationsByPlaysRes?.stations) ? stationsByPlaysRes.stations : []);
      setCumulativeSeries(Array.isArray(cumulativeRes?.series) ? cumulativeRes.series : []);
      setActiveSenderSeries(Array.isArray(panelRes?.series) ? panelRes.series : []);
      setBucketSeries(Array.isArray(bucketRes?.series) ? bucketRes.series : []);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [trackKey, from, effectiveTo, bucket]);

  React.useEffect(() => { loadData(); }, [loadData]);
  React.useEffect(() => { loadDetails(false); }, [loadDetails]);
  React.useEffect(() => {
    const name = details?.title || track?.title;
    if (name) document.title = `${name} · RadioVelbert Music Scraper`;
  }, [details, track]);

  const applyQuickRange = (rangeKey) => {
    const end = includeToday ? berlinTodayIsoDate() : berlinYesterdayIsoDate();
    let start = end;
    if (rangeKey === '7') start = shiftBerlinIsoDate(end, -6);
    if (rangeKey === '30') start = shiftBerlinIsoDate(end, -29);
    if (rangeKey === '90') start = shiftBerlinIsoDate(end, -89);
    if (rangeKey === 'ytd') start = `${Number(end.slice(0, 4))}-01-01`;
    setFrom(start);
    setTo(end);
  };

  const maxTrackPlays = Number(track?.total_plays || 0);
  const detailTotals = details?.totals;
  // Placeholder instead of "0" / "–" while the song details are still loading.
  const pendingValue = (value) => (detailsLoading && !details ? '…' : value);

  return html`
    <${AppShell}
      activeKey="dashboard"
      title=${details?.title || track?.title || 'Song'}
      subtitle=${details?.artist || track?.artist || 'Lade…'}
      controls=${html`
        <${Chakra.HStack} spacing="2">
          <${Chakra.Button} size="sm" variant="ghost" leftIcon=${html`<${Icons.ArrowBackIcon} />`} onClick=${() => (window.history.length > 1 ? window.history.back() : navigate('/dashboard'))}>Zurück<//>
          <${Chakra.Button} size="sm" leftIcon=${html`<${Icons.RepeatIcon} />`} onClick=${() => loadData()} isLoading=${loading} colorScheme="brand">Aktualisieren<//>
        <//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="6">
        ${errorText ? html`
          <${Chakra.Alert} status="error" borderRadius="14px">
            <${Chakra.AlertIcon} />
            <${Chakra.Text}>${errorText}<//>
          <//>
        ` : null}

        <${TrackHero}
          details=${details}
          fallbackTrack=${track}
          trackKey=${trackKey}
          loading=${detailsLoading}
          refreshing=${detailsRefreshing}
          onRefresh=${() => loadDetails(true)}
        />

        <${Chakra.SimpleGrid} columns=${{ base: 2, xl: 4 }} spacing=${{ base: "3", md: "4" }}>
          <${StatTile} accent label="Plays gesamt" value=${pendingValue(formatNumber(detailTotals?.total_plays ?? track?.total_plays ?? 0))} icon=${AppIcons.Activity} hint=${track?.plays_per_day ? `${Number(track.plays_per_day).toLocaleString('de-DE', { maximumFractionDigits: 1 })} pro aktivem Tag` : null} />
          <${StatTile} label="Sender" value=${pendingValue(formatNumber(detailTotals?.station_count ?? 0))} icon=${AppIcons.Radio} hint="haben den Titel gespielt" />
          <${StatTile} label="Erstes Play" value=${pendingValue(detailTotals?.first_played_at_utc ? formatDate(detailTotals.first_played_at_utc) : '–')} icon=${AppIcons.Calendar} hint=${detailTotals?.first_played_at_utc ? formatRelative(detailTotals.first_played_at_utc) : null} />
          <${StatTile} label="Zuletzt gespielt" value=${pendingValue(detailTotals?.last_played_at_utc ? formatRelative(detailTotals.last_played_at_utc) : '–')} icon=${AppIcons.Clock} hint=${detailTotals?.last_played_at_utc ? formatDateTime(detailTotals.last_played_at_utc) : null} />
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 2 }} spacing="6">
          <${StationsCard} stations=${details?.stations || []} total=${detailTotals?.total_plays || 0} loading=${detailsLoading && !details} />
          <${RecentPlaysCard} plays=${details?.recentPlays || []} loading=${detailsLoading && !details} />
        <//>

        ${details?.deezer?.artist || details?.spellings?.length ? html`
          <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 2 }} spacing="6">
            <${ArtistCard} deezer=${details?.deezer} />
            <${SpellingsCard} spellings=${details?.spellings} />
          <//>
        ` : null}

        <${PanelCard} title="Zeitraum für Statistiken" icon=${AppIcons.Calendar}>
          <${Chakra.Wrap} spacing="3" align="end">
            <${Chakra.FormControl} w="auto" minW="120px">
              <${Chakra.FormLabel} fontSize="sm">Aggregation<//>
              <${Chakra.Select} size="sm" value=${bucket} onChange=${(e) => setBucket(e.target.value)}>
                <option value="day">Tag</option>
                <option value="week">Woche</option>
                <option value="month">Monat</option>
                <option value="year">Jahr</option>
              <//>
            <//>
            <${Chakra.FormControl} w="auto">
              <${Chakra.FormLabel} fontSize="sm">Von<//>
              <${Chakra.Input} size="sm" type="date" value=${from} onChange=${(e) => setFrom(e.target.value)} />
            <//>
            <${Chakra.FormControl} w="auto">
              <${Chakra.FormLabel} fontSize="sm">Bis<//>
              <${Chakra.Input} size="sm" type="date" value=${to} onChange=${(e) => setTo(e.target.value)} isDisabled=${includeToday} />
            <//>
            <${Chakra.ButtonGroup} size="sm" isAttached variant="outline">
              ${['7', '30', '90', 'ytd'].map((r) => html`<${Chakra.Button} key=${r} onClick=${() => applyQuickRange(r)}>${r === 'ytd' ? 'Jahr' : `${r} Tage`}<//>`)}
            <//>
            <${Chakra.Checkbox} isChecked=${includeToday} onChange=${(e) => setIncludeToday(e.target.checked)} colorScheme="brand">bis heute<//>
          <//>
        <//>

        <${LoadingOverlay} isLoading=${loading} label="Statistiken werden berechnet…">
        <${Chakra.VStack} align="stretch" spacing="6">
        <${PanelCard} title="Song-Performance" subtitle="Score aus Beliebtheit, Momentum, Sender-Breite und Plays pro Tag" icon=${AppIcons.Zap}>
          <${SongPerformanceCard} selectedTrack=${track} trend=${trend} totals=${totals} matrix=${matrix} maxTrackPlays=${maxTrackPlays} from=${from} to=${effectiveTo} />
        <//>

        <${PanelCard} title="Statistiken" subtitle="Kumuliert · Zeitraum · Plays je Sender · Plays je Sender pro Tag" icon=${AppIcons.Activity}>
          <${LegacyStatsCharts} selectedTrack=${track} from=${from} to=${effectiveTo} bucket=${bucket} cumulativeSeries=${cumulativeSeries} bucketSeries=${bucketSeries} stationsByPlays=${stationsByPlays} seriesByStation=${seriesByStation} />
        <//>

        <${PanelCard} title="Trend: Rohsumme vs. panelbereinigt" subtitle="Roh = absolute Plays · Bereinigt = Plays pro aktivem Sender je Tag" icon=${AppIcons.Report}>
          <${Chakra.Tabs} variant="soft-rounded" colorScheme="brand" size="sm">
            <${Chakra.TabList}>
              <${Chakra.Tab}>Rohsumme<//>
              <${Chakra.Tab}>Panelbereinigt<//>
            <//>
            <${Chakra.TabPanels}>
              <${Chakra.TabPanel} px="0" pb="0"><${TrackTrendLineChart} rows=${dailyTrendRows} mode="raw" /><//>
              <${Chakra.TabPanel} px="0" pb="0"><${TrackTrendLineChart} rows=${dailyTrendRows} mode="normalized" /><//>
            <//>
          <//>
        <//>
        <//>
        <//>
      <//>
    <//>
  `;
}

// ── Root — client-side switch between catalogue and song page ────────────────

function Root() {
  const search = useLocationSearch();
  const trackKey = new URLSearchParams(search).get('trackKey');
  React.useEffect(() => {
    if (!trackKey) document.title = 'Dashboard · RadioVelbert Music Scraper';
  }, [trackKey]);
  return html`
    <${Chakra.ChakraProvider} theme=${horizonTheme}>
      ${trackKey ? html`<${TrackDetailApp} key=${trackKey} trackKey=${trackKey} />` : html`<${DashboardApp} />`}
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(html`<${Root} />`);
