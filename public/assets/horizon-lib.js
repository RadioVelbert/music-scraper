import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import * as Chakra from 'https://esm.sh/@chakra-ui/react@2.10.9?deps=react@18.3.1,react-dom@18.3.1';
import * as Icons from 'https://esm.sh/@chakra-ui/icons@2.1.1?deps=react@18.3.1,react-dom@18.3.1';
import htm from 'https://esm.sh/htm@3.1.1';

export const html = htm.bind(React.createElement);

// ── RadioVelbert theme ────────────────────────────────────────────────────────
// Brand colours from radiovelbert.de: cyan (#0891b2 → #06b6d4 → #22d3ee) on slate/navy.

const BRAND = {
  50: '#ecfeff',
  100: '#cffafe',
  200: '#a5f3fc',
  300: '#67e8f9',
  400: '#22d3ee',
  500: '#06b6d4',
  600: '#0891b2',
  700: '#0e7490',
  800: '#155e75',
  900: '#164e63'
};

export const BRAND_GRADIENT = 'linear-gradient(135deg, #0891b2 0%, #06b6d4 55%, #22d3ee 100%)';
export const NIGHT_GRADIENT = 'linear-gradient(160deg, #020617 0%, #0b1224 55%, #0c1929 100%)';

export const horizonTheme = Chakra.extendTheme({
  config: {
    initialColorMode: 'light',
    useSystemColorMode: false
  },
  fonts: {
    heading: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
    body: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif'
  },
  colors: {
    brand: BRAND,
    // Existing pages use colorScheme "blue"/"teal" – both follow the brand.
    blue: BRAND,
    teal: BRAND,
    navy: {
      50: '#f4f7fb',
      100: '#e2e8f0',
      200: '#cbd5e1',
      300: '#94a3b8',
      400: '#64748b',
      500: '#475569',
      600: '#334155',
      700: '#1e293b',
      800: '#0f172a',
      900: '#020617'
    }
  },
  radii: {
    card: '20px'
  },
  shadows: {
    outline: '0 0 0 3px rgba(34, 211, 238, 0.45)'
  },
  semanticTokens: {
    colors: {
      appBg: { default: '#f4f7fb', _dark: '#050a16' },
      shellBg: { default: 'rgba(255, 255, 255, 0.82)', _dark: 'rgba(5, 10, 22, 0.82)' },
      cardBg: { default: '#ffffff', _dark: '#0b1224' },
      subtleBg: { default: '#f1f5f9', _dark: 'rgba(255, 255, 255, 0.04)' },
      lineColor: { default: '#e2e8f0', _dark: 'rgba(148, 163, 184, 0.14)' },
      textPrimary: { default: '#0f172a', _dark: '#e2e8f0' },
      textMuted: { default: '#64748b', _dark: '#94a3b8' },
      accent: { default: '#0891b2', _dark: '#22d3ee' }
    }
  },
  styles: {
    global: {
      body: {
        bg: 'appBg',
        color: 'textPrimary',
        fontFeatureSettings: '"cv11", "ss01"'
      }
    }
  },
  components: {
    Button: {
      baseStyle: { borderRadius: '12px', fontWeight: '600' }
    },
    Input: { defaultProps: { focusBorderColor: 'brand.400' } },
    Select: { defaultProps: { focusBorderColor: 'brand.400' } },
    Textarea: { defaultProps: { focusBorderColor: 'brand.400' } },
    Table: {
      baseStyle: {
        th: { letterSpacing: '0.06em', fontWeight: '700', color: 'textMuted' }
      }
    },
    Badge: { baseStyle: { borderRadius: '999px', px: '2', textTransform: 'none', fontWeight: '600' } },
    Tabs: { defaultProps: { colorScheme: 'brand' } }
  }
});

// ── Icons (stroke icons, 24px grid) ───────────────────────────────────────────

function strokeIcon(displayName, paths) {
  const Component = (props) => React.createElement(
    Chakra.Icon,
    { viewBox: '0 0 24 24', ...props },
    React.createElement(
      'g',
      { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ...paths.map((d, index) => React.createElement('path', { key: index, d }))
    )
  );
  Component.displayName = displayName;
  return Component;
}

function fillIcon(displayName, paths) {
  const Component = (props) => React.createElement(
    Chakra.Icon,
    { viewBox: '0 0 24 24', ...props },
    ...paths.map((d, index) => React.createElement('path', { key: index, d, fill: 'currentColor' }))
  );
  Component.displayName = displayName;
  return Component;
}

const CIRCLE = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const AppIcons = {
  Grid: strokeIcon('GridIcon', ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M14 14h7v7h-7z', 'M3 14h7v7H3z']),
  Sparkle: strokeIcon('SparkleIcon', ['M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z', 'M19 17v4', 'M17 19h4']),
  Report: strokeIcon('ReportIcon', ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8']),
  Radio: strokeIcon('RadioIcon', [CIRCLE(12, 12, 2), 'M16.24 7.76a6 6 0 0 1 0 8.49', 'M7.76 16.24a6 6 0 0 1 0-8.49', 'M19.07 4.93a10 10 0 0 1 0 14.14', 'M4.93 19.07a10 10 0 0 1 0-14.14']),
  Sliders: strokeIcon('SlidersIcon', ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6']),
  Code: strokeIcon('CodeIcon', ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6']),
  Music: strokeIcon('MusicIcon', ['M9 18V5l12-2v13', CIRCLE(6, 18, 3), CIRCLE(18, 16, 3)]),
  Volume: strokeIcon('VolumeIcon', ['M11 5L6 9H2v6h4l5 4V5z', 'M19.07 4.93a10 10 0 0 1 0 14.14', 'M15.54 8.46a5 5 0 0 1 0 7.07']),
  VolumeOff: strokeIcon('VolumeOffIcon', ['M11 5L6 9H2v6h4l5 4V5z', 'M23 9l-6 6', 'M17 9l6 6']),
  Close: strokeIcon('CloseIcon', ['M18 6L6 18', 'M6 6l12 12']),
  Database: strokeIcon('DatabaseIcon', ['M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3z', 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3', 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5']),
  Activity: strokeIcon('ActivityIcon', ['M22 12h-4l-3 9L9 3l-3 9H2']),
  Disc: strokeIcon('DiscIcon', [CIRCLE(12, 12, 10), CIRCLE(12, 12, 3)]),
  Users: strokeIcon('UsersIcon', ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', CIRCLE(9, 7, 4), 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75']),
  Clock: strokeIcon('ClockIcon', [CIRCLE(12, 12, 10), 'M12 6v6l4 2']),
  Calendar: strokeIcon('CalendarIcon', ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18']),
  Tag: strokeIcon('TagIcon', ['M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z', 'M7 7h.01']),
  Link: strokeIcon('LinkIcon', ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71']),
  Zap: strokeIcon('ZapIcon', ['M13 2L3 14h9l-1 8 10-12h-9l1-8z']),
  Search: strokeIcon('SearchIcon', [CIRCLE(11, 11, 8), 'M21 21l-4.35-4.35']),
  Plus: strokeIcon('PlusIcon', ['M12 5v14', 'M5 12h14']),
  Chart: strokeIcon('ChartIcon', ['M18 20V10', 'M12 20V4', 'M6 20v-6']),
  Play: fillIcon('PlayIcon', ['M8 5.14v13.72a1 1 0 0 0 1.52.85l11.02-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z']),
  Pause: fillIcon('PauseIcon', ['M6 4h4v16H6z', 'M14 4h4v16h-4z'])
};

export const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', key: 'dashboard', icon: AppIcons.Grid },
  { href: '/new-titles', label: 'Neue Titel', key: 'new-titles', icon: AppIcons.Sparkle },
  { href: '/weekly-reports', label: 'Wochenberichte', key: 'weekly-reports', icon: AppIcons.Report },
  { href: '/charts/radio', label: 'Radio-Charts', key: 'charts-radio', icon: AppIcons.Chart },
  { href: '/charts/billboard', label: 'Billboard 200', key: 'charts-billboard', icon: AppIcons.Disc },
  { href: '/my-station', label: 'Mein Sender', key: 'my-station', icon: AppIcons.Radio },
  { href: '/admin', label: 'Administration', key: 'admin', icon: AppIcons.Sliders },
  { href: '/api/docs', label: 'API', key: 'api', icon: AppIcons.Code, external: true }
];

// ── Formatting helpers ────────────────────────────────────────────────────────

// Requests in flight drive the loading bar at the top of every page.
let pendingRequests = 0;
const requestListeners = new Set();

function setPendingRequests(delta) {
  pendingRequests = Math.max(0, pendingRequests + delta);
  requestListeners.forEach((listener) => listener());
}

// options.silent: background polling that should not show the loading bar.
export async function apiFetch(url, options = {}) {
  const { silent = false, ...fetchOptions } = options || {};
  if (!silent) setPendingRequests(1);
  try {
    const res = await fetch(url, fetchOptions);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return body;
  } finally {
    if (!silent) setPendingRequests(-1);
  }
}

export function useRequestsPending() {
  return React.useSyncExternalStore(
    (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    () => pendingRequests > 0
  );
}

export function apiSend(url, method, payload) {
  return apiFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** exponent).toLocaleString('de-DE', { maximumFractionDigits: exponent >= 2 ? 1 : 0 })} ${units[exponent]}`;
}

// "vor 5 Min." / "in 12 Min." / "vor 3 Tagen"
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return '–';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '–';
  const diffSeconds = Math.round((time - now) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return diffSeconds <= 0 ? 'gerade eben' : 'gleich';
  let value;
  let unit;
  if (abs < 3600) {
    value = Math.max(1, Math.round(abs / 60));
    unit = 'Min.';
  } else if (abs < 86400) {
    value = Math.round(abs / 3600);
    unit = 'Std.';
  } else if (abs < 30 * 86400) {
    value = Math.round(abs / 86400);
    unit = value === 1 ? 'Tag' : 'Tagen';
  } else {
    return formatDate(iso);
  }
  return diffSeconds < 0 ? `vor ${value} ${unit}` : `in ${value} ${unit}`;
}

export function useDebouncedValue(value, delayMs = 300) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function readStorage(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode): setting just isn't remembered
  }
}

// ── Player (one audio element for the whole page, docked at the bottom) ──────

const audio = typeof Audio === 'undefined' ? null : new Audio();
let playerState = {
  track: null,
  status: 'idle',
  currentTime: 0,
  duration: 0,
  volume: readStorage('rv.player.volume', 0.85),
  muted: false,
  source: null,
  error: null
};
const playerListeners = new Set();

function setPlayerState(patch) {
  playerState = { ...playerState, ...patch };
  playerListeners.forEach((listener) => listener());
}

if (audio) {
  audio.preload = 'none';
  audio.volume = playerState.volume;
  audio.addEventListener('timeupdate', () => setPlayerState({ currentTime: audio.currentTime }));
  audio.addEventListener('durationchange', () => setPlayerState({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }));
  audio.addEventListener('playing', () => setPlayerState({ status: 'playing', error: null }));
  audio.addEventListener('pause', () => {
    if (playerState.status === 'playing') setPlayerState({ status: 'paused' });
  });
  audio.addEventListener('waiting', () => setPlayerState({ status: 'loading' }));
  audio.addEventListener('ended', () => setPlayerState({ status: 'ended', currentTime: 0 }));
  audio.addEventListener('error', () => {
    if (playerState.track) setPlayerState({ status: 'error', error: 'Hörbeispiel konnte nicht geladen werden' });
  });
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.title || '',
      artist: track.artist || '',
      album: 'RadioVelbert Music Scraper',
      artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: '300x300' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => player.toggle());
    navigator.mediaSession.setActionHandler('pause', () => player.toggle());
  } catch {
    // Media Session is optional
  }
}

export const player = {
  // track: { trackKey, artist, title, artworkUrl }
  async play(track) {
    if (!audio || !track?.trackKey) return;
    if (playerState.track?.trackKey === track.trackKey && playerState.status !== 'error') {
      player.toggle();
      return;
    }
    audio.pause();
    setPlayerState({ track, status: 'loading', currentTime: 0, duration: 0, error: null, source: null });
    updateMediaSession(track);
    try {
      const preview = await apiFetch(`/api/tracks/${encodeURIComponent(track.trackKey)}/preview`);
      if (playerState.track?.trackKey !== track.trackKey) return;
      audio.src = preview.url;
      setPlayerState({ source: preview.source });
      await audio.play();
    } catch (error) {
      if (playerState.track?.trackKey !== track.trackKey) return;
      setPlayerState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  },
  toggle() {
    if (!audio || !audio.src) return;
    if (audio.paused) audio.play().catch(() => setPlayerState({ status: 'error', error: 'Wiedergabe nicht möglich' }));
    else audio.pause();
  },
  seek(seconds) {
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = seconds;
    setPlayerState({ currentTime: seconds });
  },
  setVolume(volume) {
    if (!audio) return;
    audio.volume = volume;
    audio.muted = false;
    writeStorage('rv.player.volume', volume);
    setPlayerState({ volume, muted: false });
  },
  toggleMute() {
    if (!audio) return;
    audio.muted = !audio.muted;
    setPlayerState({ muted: audio.muted });
  },
  close() {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setPlayerState({ track: null, status: 'idle', currentTime: 0, duration: 0, error: null, source: null });
  }
};

function subscribePlayer(listener) {
  playerListeners.add(listener);
  return () => playerListeners.delete(listener);
}

// selector must return a primitive or the state object itself (useSyncExternalStore compares by identity).
export function usePlayer(selector = (state) => state) {
  return React.useSyncExternalStore(subscribePlayer, () => selector(playerState));
}

// ── Navigation within the dashboard (keeps the player running) ───────────────

export function navigate(url) {
  if (window.location.pathname === new URL(url, window.location.origin).pathname) {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new Event('app:navigate'));
    window.scrollTo({ top: 0 });
  } else {
    window.location.href = url;
  }
}

export function useLocationSearch() {
  const [search, setSearch] = React.useState(window.location.search);
  React.useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener('popstate', update);
    window.addEventListener('app:navigate', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('app:navigate', update);
    };
  }, []);
  return search;
}

export function trackHref(trackKey) {
  return `/dashboard?trackKey=${encodeURIComponent(trackKey)}`;
}

// ── Loading indicators ───────────────────────────────────────────────────────

// Equalizer bars – the RadioVelbert loading animation (CSS in horizon-ui.css).
export function Equalizer({ size = 'md', color }) {
  return html`
    <span className=${`rv-eq rv-eq-${size}`} style=${color ? { color } : undefined} aria-hidden="true">
      <span /><span /><span /><span /><span />
    </span>
  `;
}

export function LoadingSpinner({ label = 'Lade Daten…', py = '12', size = 'md' }) {
  return html`
    <${Chakra.Flex} direction="column" align="center" justify="center" gap="3" py=${py} color="accent" role="status" aria-live="polite">
      <${Equalizer} size=${size} />
      ${label ? html`<${Chakra.Text} fontSize="sm" fontWeight="600" color="textMuted">${label}<//>` : null}
    <//>
  `;
}

// Keeps existing content visible but dimmed while it is being refreshed.
export function LoadingOverlay({ isLoading, label = 'Lädt…', children, minH }) {
  return html`
    <${Chakra.Box} position="relative" minH=${minH}>
      <${Chakra.Box}
        opacity=${isLoading ? 0.4 : 1}
        filter=${isLoading ? 'saturate(0.6)' : 'none'}
        pointerEvents=${isLoading ? 'none' : 'auto'}
        transition="opacity 0.2s ease"
      >${children}<//>
      ${isLoading ? html`
        <${Chakra.Flex} position="absolute" inset="0" align="flex-start" justify="center" pt="16" zIndex="5" pointerEvents="none">
          <${Chakra.HStack}
            spacing="3"
            px="5"
            py="3"
            borderRadius="full"
            bg="cardBg"
            border="1px solid"
            borderColor="lineColor"
            boxShadow="0 12px 32px rgba(15, 23, 42, 0.18)"
            color="accent"
            position="sticky"
            top="96px"
          >
            <${Equalizer} size="sm" />
            <${Chakra.Text} fontSize="sm" fontWeight="700" color="textPrimary">${label}<//>
          <//>
        <//>
      ` : null}
    <//>
  `;
}

export function SkeletonRows({ rows = 8, columns = 5 }) {
  return Array.from({ length: rows }, (_, row) => html`
    <${Chakra.Tr} key=${`skeleton-${row}`}>
      ${Array.from({ length: columns }, (_c, column) => html`
        <${Chakra.Td} key=${column} py="3">
          ${column === 1
            ? html`
              <${Chakra.HStack} spacing="3">
                <${Chakra.Skeleton} boxSize="40px" borderRadius="10px" />
                <${Chakra.Box} flex="1"><${Chakra.SkeletonText} noOfLines=${2} spacing="2" skeletonHeight="2.5" /><//>
              <//>
            `
            : html`<${Chakra.Skeleton} h="12px" borderRadius="6px" w=${column === 0 ? '18px' : '70%'} />`}
        <//>
      `)}
    <//>
  `);
}

// Thin animated bar at the top of the window while API requests are running.
// Shown after a short delay so fast requests don't flicker.
function TopLoadingBar() {
  const pending = useRequestsPending();
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    if (!pending) {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [pending]);
  if (!visible) return null;
  return html`<div className="rv-loading-bar" role="progressbar" aria-label="Daten werden geladen"><span /></div>`;
}

// ── Shared components ────────────────────────────────────────────────────────

export function TrackCover({ src, size = '44px', radius = '12px', alt = '' }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    return html`
      <${Chakra.Image}
        src=${src}
        alt=${alt}
        boxSize=${size}
        minW=${size}
        objectFit="cover"
        borderRadius=${radius}
        loading="lazy"
        onError=${() => setFailed(true)}
      />
    `;
  }
  return html`
    <${Chakra.Flex} boxSize=${size} minW=${size} borderRadius=${radius} bg=${BRAND_GRADIENT} align="center" justify="center" color="white">
      <${AppIcons.Music} boxSize="45%" />
    <//>
  `;
}

export function PlayButton({ track, size = 'sm', variant = 'solid' }) {
  const status = usePlayer((state) => (state.track?.trackKey === track?.trackKey ? state.status : 'idle'));
  const isPlaying = status === 'playing';
  const isLoading = status === 'loading';
  const label = isPlaying ? 'Pause' : 'Anhören';
  const dimension = { xs: '26px', sm: '32px', md: '40px', lg: '56px' }[size] || '32px';
  return html`
    <${Chakra.Tooltip} label=${status === 'error' ? 'Kein Hörbeispiel' : label} openDelay=${400}>
      <${Chakra.IconButton}
        aria-label=${label}
        isRound
        minW=${dimension}
        h=${dimension}
        w=${dimension}
        variant=${variant === 'solid' ? 'solid' : 'ghost'}
        bg=${variant === 'solid' ? BRAND_GRADIENT : undefined}
        color=${variant === 'solid' ? 'white' : 'accent'}
        boxShadow=${variant === 'solid' ? '0 6px 18px rgba(8, 145, 178, 0.35)' : undefined}
        _hover=${variant === 'solid' ? { filter: 'brightness(1.08)', transform: 'scale(1.04)' } : { bg: 'subtleBg' }}
        _active=${{ transform: 'scale(0.96)' }}
        transition="all 0.15s ease"
        onClick=${(event) => {
          event.stopPropagation();
          player.play(track);
        }}
        icon=${isLoading
          ? html`<${Chakra.Spinner} size="xs" />`
          : isPlaying
            ? html`<${AppIcons.Pause} boxSize="45%" />`
            : html`<${AppIcons.Play} boxSize="48%" ml="2px" />`}
      />
    <//>
  `;
}

// Cover with play overlay. With real artwork the button appears on hover of the
// surrounding ".group" element (and stays visible while this track is active).
export function CoverPlay({ track, size = '44px' }) {
  const active = usePlayer((state) => state.track?.trackKey === track?.trackKey && state.status !== 'idle' && state.status !== 'ended');
  const hasArt = Boolean(track?.artworkUrl);
  return html`
    <${Chakra.Box} position="relative" boxSize=${size} minW=${size}>
      <${TrackCover} src=${track?.artworkUrl} size=${size} />
      <${Chakra.Flex}
        position="absolute"
        inset="0"
        align="center"
        justify="center"
        borderRadius="12px"
        bg=${hasArt ? 'rgba(2, 6, 23, 0.45)' : 'transparent'}
        opacity=${active || !hasArt ? 1 : 0}
        _groupHover=${{ opacity: 1 }}
        transition="opacity 0.15s ease"
      >
        <${PlayButton} track=${track} size="xs" />
      <//>
    <//>
  `;
}

function PlayerBar() {
  const state = usePlayer();
  if (!state.track) return null;
  const { track, status, currentTime, duration, volume, muted, error, source } = state;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  return html`
    <${Chakra.Box}
      position="fixed"
      bottom=${{ base: '0', lg: '16px' }}
      left=${{ base: '0', lg: '284px' }}
      right=${{ base: '0', lg: '24px' }}
      zIndex="40"
      bg="rgba(2, 6, 23, 0.92)"
      color="white"
      backdropFilter="blur(14px)"
      borderRadius=${{ base: '0', lg: '20px' }}
      border="1px solid rgba(34, 211, 238, 0.18)"
      boxShadow="0 18px 50px rgba(2, 6, 23, 0.45)"
      overflow="hidden"
      className="rv-player"
    >
      <${Chakra.Box} h="3px" bg="rgba(255,255,255,0.08)">
        <${Chakra.Box} h="100%" w=${`${progress}%`} bg=${BRAND_GRADIENT} transition="width 0.25s linear" />
      <//>
      <${Chakra.Flex} align="center" gap=${{ base: '3', md: '5' }} px=${{ base: '3', md: '5' }} py="3">
        <${Chakra.HStack} spacing="3" minW="0" flex=${{ base: '1', md: '0 1 340px' }}>
          <${TrackCover} src=${track.artworkUrl} size="48px" radius="10px" />
          <${Chakra.Box} minW="0">
            <${Chakra.Link}
              href=${trackHref(track.trackKey)}
              onClick=${(event) => {
                event.preventDefault();
                navigate(trackHref(track.trackKey));
              }}
              fontWeight="700"
              fontSize="sm"
              noOfLines=${1}
              color="white"
              _hover=${{ color: 'brand.300' }}
            >${track.title}<//>
            <${Chakra.Text} fontSize="xs" color="whiteAlpha.700" noOfLines=${1}>
              ${status === 'error' ? error : track.artist}
            <//>
          <//>
        <//>

        <${Chakra.HStack} spacing="3" flex="1" justify="center" minW="0">
          <${Chakra.IconButton}
            aria-label=${status === 'playing' ? 'Pause' : 'Abspielen'}
            isRound
            size="md"
            bg=${BRAND_GRADIENT}
            color="white"
            _hover=${{ filter: 'brightness(1.1)' }}
            onClick=${() => (status === 'error' ? player.play(track) : player.toggle())}
            icon=${status === 'loading'
              ? html`<${Chakra.Spinner} size="sm" />`
              : status === 'playing'
                ? html`<${AppIcons.Pause} boxSize="18px" />`
                : html`<${AppIcons.Play} boxSize="20px" ml="2px" />`}
          />
          <${Chakra.HStack} spacing="3" flex="1" maxW="520px" display=${{ base: 'none', md: 'flex' }}>
            <${Chakra.Text} fontSize="xs" color="whiteAlpha.700" minW="34px" textAlign="right" fontVariantNumeric="tabular-nums">
              ${formatDuration(currentTime)}
            <//>
            <${Chakra.Slider}
              aria-label="Position"
              value=${currentTime}
              min=${0}
              max=${duration || 30}
              step=${0.1}
              focusThumbOnChange=${false}
              onChange=${(value) => player.seek(value)}
              isDisabled=${!duration}
            >
              <${Chakra.SliderTrack} bg="whiteAlpha.200" h="4px" borderRadius="full">
                <${Chakra.SliderFilledTrack} bg=${BRAND_GRADIENT} />
              <//>
              <${Chakra.SliderThumb} boxSize="12px" />
            <//>
            <${Chakra.Text} fontSize="xs" color="whiteAlpha.700" minW="34px" fontVariantNumeric="tabular-nums">
              ${formatDuration(duration)}
            <//>
          <//>
        <//>

        <${Chakra.HStack} spacing="2" display=${{ base: 'none', md: 'flex' }} w="170px" justify="flex-end">
          ${source ? html`<${Chakra.Badge} bg="whiteAlpha.200" color="whiteAlpha.800" fontSize="10px">${source === 'deezer' ? 'Deezer' : 'iTunes'} · 30s<//>` : null}
          <${Chakra.IconButton}
            aria-label=${muted ? 'Ton an' : 'Stumm'}
            size="sm"
            variant="ghost"
            color="whiteAlpha.800"
            _hover=${{ bg: 'whiteAlpha.200' }}
            onClick=${() => player.toggleMute()}
            icon=${muted ? html`<${AppIcons.VolumeOff} />` : html`<${AppIcons.Volume} />`}
          />
          <${Chakra.Slider} aria-label="Lautstärke" w="70px" value=${muted ? 0 : volume} min=${0} max=${1} step=${0.01} onChange=${(value) => player.setVolume(value)}>
            <${Chakra.SliderTrack} bg="whiteAlpha.200" h="3px">
              <${Chakra.SliderFilledTrack} bg="brand.400" />
            <//>
            <${Chakra.SliderThumb} boxSize="10px" />
          <//>
        <//>
        <${Chakra.IconButton}
          aria-label="Player schließen"
          size="sm"
          variant="ghost"
          color="whiteAlpha.700"
          _hover=${{ bg: 'whiteAlpha.200', color: 'white' }}
          onClick=${() => player.close()}
          icon=${html`<${AppIcons.Close} />`}
        />
      <//>
    <//>
  `;
}

function ThemeToggleButton() {
  const { colorMode, toggleColorMode } = Chakra.useColorMode();
  return html`
    <${Chakra.Tooltip} label=${colorMode === 'light' ? 'Dunkles Design' : 'Helles Design'}>
      <${Chakra.IconButton}
        size="sm"
        variant="ghost"
        aria-label="Design wechseln"
        onClick=${toggleColorMode}
        icon=${colorMode === 'light' ? html`<${Icons.MoonIcon} />` : html`<${Icons.SunIcon} />`}
      />
    <//>
  `;
}

function BrandMark({ compact = false }) {
  return html`
    <${Chakra.HStack} as="a" href="/dashboard" spacing="3" _hover=${{ textDecoration: 'none' }}>
      <${Chakra.Image} src="/assets/rv-logo.png" alt="RadioVelbert" h=${compact ? '30px' : '38px'} w="auto" />
      <${Chakra.Box} lineHeight="1.1">
        <${Chakra.Text} fontWeight="800" fontSize=${compact ? 'md' : 'lg'} letterSpacing="-0.02em" color=${compact ? 'textPrimary' : 'white'}>
          RadioVelbert
        <//>
        <${Chakra.Text} fontSize="10px" fontWeight="700" letterSpacing="0.18em" textTransform="uppercase" color=${compact ? 'accent' : 'brand.300'}>
          Music Scraper
        <//>
      <//>
    <//>
  `;
}

export function AppShell({ activeKey, title, subtitle, controls, children }) {
  const hasTrack = usePlayer((state) => Boolean(state.track));

  return html`
    <${Chakra.Flex} className="horizon-app-shell" minH="100vh" bg="appBg">
      <${TopLoadingBar} />
      <${Chakra.Box}
        as="aside"
        display=${{ base: 'none', lg: 'flex' }}
        flexDirection="column"
        w="260px"
        minW="260px"
        position="sticky"
        top="0"
        h="100vh"
        bg=${NIGHT_GRADIENT}
        color="white"
        px="5"
        py="6"
        borderRight="1px solid rgba(34, 211, 238, 0.08)"
      >
        <${Chakra.Box} px="2" mb="9"><${BrandMark} /><//>
        <${Chakra.Text} px="3" mb="2" fontSize="10px" fontWeight="700" letterSpacing="0.16em" color="whiteAlpha.500" textTransform="uppercase">
          Navigation
        <//>
        <${Chakra.VStack} align="stretch" spacing="1" flex="1">
          ${NAV_ITEMS.map((item) => {
            const active = item.key === activeKey;
            return html`
              <${Chakra.Link}
                key=${item.key}
                href=${item.href}
                target=${item.external ? '_blank' : undefined}
                rel=${item.external ? 'noreferrer' : undefined}
                display="flex"
                alignItems="center"
                gap="3"
                px="3"
                py="2.5"
                borderRadius="12px"
                fontWeight="600"
                fontSize="sm"
                color=${active ? 'white' : 'whiteAlpha.700'}
                bg=${active ? BRAND_GRADIENT : 'transparent'}
                boxShadow=${active ? '0 10px 24px rgba(8, 145, 178, 0.35)' : 'none'}
                _hover=${{ textDecoration: 'none', bg: active ? BRAND_GRADIENT : 'whiteAlpha.100', color: 'white' }}
                transition="all 0.15s ease"
              >
                <${item.icon} boxSize="18px" />
                <${Chakra.Text} as="span" flex="1">${item.label}<//>
                ${item.external ? html`<${Icons.ExternalLinkIcon} boxSize="3" opacity="0.6" />` : null}
              <//>
            `;
          })}
        <//>
        <${Chakra.Box}
          mt="6"
          p="4"
          borderRadius="16px"
          bg="rgba(34, 211, 238, 0.06)"
          border="1px solid rgba(34, 211, 238, 0.14)"
        >
          <${Chakra.HStack} spacing="2" mb="1">
            <${Chakra.Box} w="8px" h="8px" borderRadius="full" bg="green.400" boxShadow="0 0 0 3px rgba(74, 222, 128, 0.2)" />
            <${Chakra.Text} fontSize="xs" fontWeight="700">On Air Analytics<//>
          <//>
          <${Chakra.Text} fontSize="xs" color="whiteAlpha.600" lineHeight="1.5">
            Playlists, Charts & Trends aus dem Radio – gesammelt für RadioVelbert.
          <//>
        <//>
      <//>

      <${Chakra.Box} flex="1" minW="0" pb=${hasTrack ? { base: '96px', lg: '110px' } : '6'}>
        <${Chakra.Flex}
          as="header"
          px=${{ base: '4', md: '8' }}
          py="4"
          align="center"
          justify="space-between"
          gap="4"
          borderBottom="1px solid"
          borderColor="lineColor"
          bg="shellBg"
          backdropFilter="saturate(160%) blur(12px)"
          position="sticky"
          top="0"
          zIndex="20"
        >
          <${Chakra.HStack} spacing="4" minW="0">
            <${Chakra.Box} display=${{ base: 'block', lg: 'none' }}><${BrandMark} compact /><//>
            <${Chakra.Box} minW="0" display=${{ base: 'none', sm: 'block' }}>
              <${Chakra.Heading} size="md" letterSpacing="-0.02em" color="textPrimary" noOfLines=${1}>${title}<//>
              ${subtitle ? html`<${Chakra.Text} mt="0.5" fontSize="sm" color="textMuted" noOfLines=${1}>${subtitle}<//>` : null}
            <//>
          <//>
          <${Chakra.HStack} spacing="2">
            ${controls || null}
            <${ThemeToggleButton} />
          <//>
        <//>

        <${Chakra.Box} display=${{ base: 'block', lg: 'none' }} bg="shellBg" borderBottom="1px solid" borderColor="lineColor" px="4" py="3">
          <${Chakra.Box} display=${{ base: 'block', sm: 'none' }} mb="3">
            <${Chakra.Heading} size="md" color="textPrimary">${title}<//>
            ${subtitle ? html`<${Chakra.Text} mt="0.5" fontSize="sm" color="textMuted">${subtitle}<//>` : null}
          <//>
          <${Chakra.HStack} spacing="2" overflowX="auto" className="horizon-scroll">
            ${NAV_ITEMS.map((item) => html`
              <${Chakra.Button}
                key=${item.key}
                as="a"
                href=${item.href}
                target=${item.external ? '_blank' : undefined}
                rel=${item.external ? 'noreferrer' : undefined}
                size="sm"
                flexShrink="0"
                leftIcon=${html`<${item.icon} />`}
                variant=${item.key === activeKey ? 'solid' : 'outline'}
                colorScheme=${item.key === activeKey ? 'brand' : 'gray'}
              >${item.label}<//>
            `)}
          <//>
        <//>

        <${Chakra.Box} px=${{ base: '4', md: '8' }} py="6" maxW="1600px" mx="auto">${children}<//>
      <//>
      <${PlayerBar} />
    <//>
  `;
}

export function PanelCard({ title, subtitle, right, children, p = '5', icon }) {
  const shadow = Chakra.useColorModeValue('0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.06)', '0 12px 32px rgba(0, 0, 0, 0.35)');
  const IconComponent = icon;
  return html`
    <${Chakra.Box}
      bg="cardBg"
      borderRadius="card"
      border="1px solid"
      borderColor="lineColor"
      boxShadow=${shadow}
      p=${p}
      minW="0"
    >
      ${(title || subtitle || right) ? html`
        <${Chakra.Flex} align="start" justify="space-between" mb="4" gap="3" px=${p === '0' ? '5' : '0'} pt=${p === '0' ? '5' : '0'} wrap="wrap">
          <${Chakra.HStack} spacing="3" align="start" minW="0">
            ${IconComponent ? html`
              <${Chakra.Flex} boxSize="36px" minW="36px" borderRadius="12px" bg="rgba(6, 182, 212, 0.12)" color="accent" align="center" justify="center">
                <${IconComponent} boxSize="18px" />
              <//>
            ` : null}
            <${Chakra.Box} minW="0">
              ${title ? html`<${Chakra.Heading} size="sm" letterSpacing="-0.01em" color="textPrimary">${title}<//>` : null}
              ${subtitle ? html`<${Chakra.Text} mt="1" fontSize="sm" color="textMuted">${subtitle}<//>` : null}
            <//>
          <//>
          ${right || null}
        <//>
      ` : null}
      ${children}
    <//>
  `;
}

export function StatTile({ label, value, hint, icon, accent = false }) {
  const IconComponent = icon;
  return html`
    <${Chakra.Box}
      position="relative"
      overflow="hidden"
      borderRadius="card"
      p=${{ base: '4', md: '5' }}
      bg=${accent ? BRAND_GRADIENT : 'cardBg'}
      color=${accent ? 'white' : 'textPrimary'}
      border="1px solid"
      borderColor=${accent ? 'transparent' : 'lineColor'}
      boxShadow=${accent ? '0 16px 36px rgba(8, 145, 178, 0.3)' : '0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.05)'}
      minW="0"
    >
      <${Chakra.HStack} justify="space-between" align="start" spacing="3">
        <${Chakra.Box} minW="0">
          <${Chakra.Text} fontSize="xs" fontWeight="600" textTransform="uppercase" letterSpacing="0.08em" color=${accent ? 'whiteAlpha.800' : 'textMuted'}>
            ${label}
          <//>
          <${Chakra.Text} mt="2" fontSize=${{ base: 'xl', md: '2xl' }} fontWeight="800" letterSpacing="-0.02em" noOfLines=${1}>${value}<//>
          ${hint ? html`<${Chakra.Text} mt="1" fontSize="xs" color=${accent ? 'whiteAlpha.800' : 'textMuted'} noOfLines=${2}>${hint}<//>` : null}
        <//>
        ${IconComponent ? html`
          <${Chakra.Flex}
            boxSize="40px"
            minW="40px"
            borderRadius="12px"
            align="center"
            justify="center"
            bg=${accent ? 'whiteAlpha.200' : 'rgba(6, 182, 212, 0.12)'}
            color=${accent ? 'white' : 'accent'}
          >
            <${IconComponent} boxSize="20px" />
          <//>
        ` : null}
      <//>
    <//>
  `;
}

export function useUiColors() {
  return {
    textPrimary: 'textPrimary',
    textMuted: 'textMuted',
    textSecondary: 'textMuted',
    hoverBg: 'subtleBg',
    lineColor: 'lineColor',
    subtleBg: 'subtleBg',
    accentBg: Chakra.useColorModeValue('brand.600', 'brand.400'),
    cardBg: 'cardBg'
  };
}

export { React, createRoot, Chakra, Icons };
