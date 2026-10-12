import {
  React,
  createRoot,
  Chakra,
  html,
  horizonTheme,
  apiFetch,
  apiSend,
  formatNumber,
  formatRelative,
  AppShell,
  PanelCard,
  StatTile,
  AppIcons,
  useUiColors,
  Icons,
  PlayButton,
  LoadingSpinner
} from './horizon-lib.js';

// "Mein Sender" comes from the station configuration (admin area) and is checked on every visit.
// Earlier versions kept the choice in a cookie for a year, which hid later changes – remove it.
document.cookie = 'my_station_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';

function formatClock(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function DaySelector({ value, onChange }) {
  return html`
    <${Chakra.HStack} spacing="2">
      ${[7, 14].map((d) => html`
        <${Chakra.Button}
          key=${d}
          size="sm"
          variant=${value === d ? 'solid' : 'outline'}
          colorScheme=${value === d ? 'blue' : 'gray'}
          borderRadius="999px"
          onClick=${() => onChange(d)}
        >${d} Tage<//>
      `)}
    <//>
  `;
}

function TrackRow({ track, badge, badgeScheme = 'blue' }) {
  const ui = useUiColors();
  const href = `/dashboard?trackKey=${encodeURIComponent(track.track_key)}`;
  return html`
    <${Chakra.Tr}
      cursor="pointer"
      _hover=${{ bg: ui.hoverBg ?? (ui.cardBg + '99') }}
      onClick=${() => { window.location.href = href; }}
    >
      <${Chakra.Td} py="2" px="3">
        <${Chakra.HStack} spacing="3">
          <${PlayButton} track=${{ trackKey: track.track_key, artist: track.artist, title: track.title, artworkUrl: track.artwork_url || null }} size="xs" />
          <${Chakra.VStack} align="start" spacing="0" minW="0">
            <${Chakra.Text} fontWeight="700" fontSize="sm" noOfLines=${1}>${track.title}<//>
            <${Chakra.Text} fontSize="xs" color=${ui.textSecondary} noOfLines=${1}>${track.artist}<//>
          <//>
        <//>
      <//>
      <${Chakra.Td} py="2" px="3" isNumeric>
        <${Chakra.Badge} colorScheme=${badgeScheme} borderRadius="999px" px="2">${badge}<//>
      <//>
      <${Chakra.Td} py="2" px="2" w="8">
        <${Chakra.Icon} as=${Icons.ChevronRightIcon} color=${ui.textSecondary} boxSize="4" />
      <//>
    <//>
  `;
}

// ─── Sender-Auswahl Setup ────────────────────────────────────────────────────

function StationSetup({ stations, current, onSelect, onCancel }) {
  const ui = useUiColors();
  const [selected, setSelected] = React.useState(current || '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await apiSend('/api/my-station', 'PUT', { stationId: selected });
      onSelect(result.station);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return html`
    <${Chakra.VStack} align="stretch" spacing="6" maxW="480px" mx="auto" py="8">
      <${Chakra.VStack} align="start" spacing="1">
        <${Chakra.Heading} size="md">Welcher ist dein Sender?<//>
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>
          Die Auswahl wird als „Mein Sender“ in der Senderkonfiguration gespeichert (auch unter Administration → Sender änderbar) und gilt für alle.
        <//>
      <//>

      <${Chakra.Select}
        placeholder="Sender wählen…"
        value=${selected}
        onChange=${(e) => setSelected(e.target.value)}
        size="md"
        borderRadius="10px"
      >
        ${stations.map((s) => html`
          <option key=${s.id} value=${s.id}>${s.name}</option>
        `)}
      <//>

      ${error ? html`<${Chakra.Alert} status="error" borderRadius="12px"><${Chakra.AlertIcon} />${error}<//>` : null}

      <${Chakra.HStack}>
        <${Chakra.Button} colorScheme="brand" isDisabled=${!selected} isLoading=${saving} onClick=${save} flex="1">
          Sender festlegen
        <//>
        ${onCancel ? html`<${Chakra.Button} variant="ghost" onClick=${onCancel}>Abbrechen<//>` : null}
      <//>
    <//>
  `;
}

// ─── Missed Tab ──────────────────────────────────────────────────────────────

function MissedTab({ days, stationId }) {
  const ui = useUiColors();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [minOtherStations, setMinOtherStations] = React.useState(2);

  React.useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/my-station/missed?days=${days}&minOtherStations=${minOtherStations}&minOtherPlays=3&limit=100&stationId=${encodeURIComponent(stationId)}`)
      .then((data) => setRows(data.tracks ?? []))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [days, minOtherStations, stationId]);

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.HStack} spacing="3" flexWrap="wrap">
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>Mindestens bei<//>
        ${[2, 3, 5].map((n) => html`
          <${Chakra.Button}
            key=${n}
            size="xs"
            variant=${minOtherStations === n ? 'solid' : 'outline'}
            colorScheme=${minOtherStations === n ? 'orange' : 'gray'}
            borderRadius="999px"
            onClick=${() => setMinOtherStations(n)}
          >${n} Sendern<//>
        `)}
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>gespielt, bei deinem Sender nicht.<//>
      <//>

      ${error ? html`
        <${Chakra.Alert} status="error" borderRadius="12px">
          <${Chakra.AlertIcon} />${error}
        <//>
      ` : null}

      ${loading ? html`
        <${LoadingSpinner} label="Lade verpasste Titel…" py="8" />
      ` : html`
        <${PanelCard}
          title="Verpasste Tracks"
          subtitle=${`${rows.length} Tracks laufen bei anderen, aber nicht bei deinem Sender`}
          right=${html`<${Chakra.Badge} colorScheme="orange" borderRadius="999px" px="3" py="1">${rows.length} Tracks<//>`}
        >
          ${rows.length === 0 ? html`
            <${Chakra.Text} color=${ui.textSecondary} fontSize="sm">
              Keine Tracks gefunden – entweder sind die Daten noch frisch oder dein Sender spielt alles mit!
            <//>
          ` : html`
            <${Chakra.TableContainer}>
              <${Chakra.Table} size="sm" variant="simple">
                <${Chakra.Thead}>
                  <${Chakra.Tr}>
                    <${Chakra.Th}>Artist / Titel<//>
                    <${Chakra.Th} isNumeric>Plays bei anderen<//>
                    <${Chakra.Th} w="8" />
                  <//>
                <//>
                <${Chakra.Tbody}>
                  ${rows.map((t) => html`
                    <${TrackRow}
                      key=${t.track_key}
                      track=${t}
                      badge=${`${t.other_plays}× / ${t.other_stations} Sender`}
                      badgeScheme="orange"
                    />
                  `)}
                <//>
              <//>
            <//>
          `}
        <//>
      `}
    <//>
  `;
}

// ─── Exclusives Tab ──────────────────────────────────────────────────────────

function ExclusivesTab({ days, stationId }) {
  const ui = useUiColors();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [maxOtherStations, setMaxOtherStations] = React.useState(0);

  React.useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/my-station/exclusives?days=${days}&maxOtherStations=${maxOtherStations}&limit=100&stationId=${encodeURIComponent(stationId)}`)
      .then((data) => setRows(data.tracks ?? []))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [days, maxOtherStations, stationId]);

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.HStack} spacing="3" flexWrap="wrap">
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>Max. bei anderen Sendern:<//>
        ${[0, 1, 2].map((n) => html`
          <${Chakra.Button}
            key=${n}
            size="xs"
            variant=${maxOtherStations === n ? 'solid' : 'outline'}
            colorScheme=${maxOtherStations === n ? 'green' : 'gray'}
            borderRadius="999px"
            onClick=${() => setMaxOtherStations(n)}
          >${n === 0 ? 'nur mein Sender' : `≤ ${n} Sender`}<//>
        `)}
      <//>

      ${error ? html`
        <${Chakra.Alert} status="error" borderRadius="12px">
          <${Chakra.AlertIcon} />${error}
        <//>
      ` : null}

      ${loading ? html`
        <${LoadingSpinner} label="Lade Exklusiv-Titel…" py="8" />
      ` : html`
        <${PanelCard}
          title="Geheimtipps"
          subtitle=${`${rows.length} Tracks die dein Sender spielt, aber kaum jemand sonst`}
          right=${html`<${Chakra.Badge} colorScheme="green" borderRadius="999px" px="3" py="1">${rows.length} Tracks<//>`}
        >
          ${rows.length === 0 ? html`
            <${Chakra.Text} color=${ui.textSecondary} fontSize="sm">
              Keine exklusiven Tracks im gewählten Zeitraum.
            <//>
          ` : html`
            <${Chakra.TableContainer}>
              <${Chakra.Table} size="sm" variant="simple">
                <${Chakra.Thead}>
                  <${Chakra.Tr}>
                    <${Chakra.Th}>Artist / Titel<//>
                    <${Chakra.Th} isNumeric>Plays<//>
                    <${Chakra.Th} w="8" />
                  <//>
                <//>
                <${Chakra.Tbody}>
                  ${rows.map((t) => html`
                    <${TrackRow}
                      key=${t.track_key}
                      track=${t}
                      badge=${`${t.my_plays}×`}
                      badgeScheme="green"
                    />
                  `)}
                <//>
              <//>
            <//>
          `}
        <//>
      `}
    <//>
  `;
}

// ─── Main App ────────────────────────────────────────────────────────────────

function MyStationApp() {
  const ui = useUiColors();
  const [days, setDays] = React.useState(7);
  const [tab, setTab] = React.useState(0);
  const [stations, setStations] = React.useState([]);
  // undefined = still checking, null = no "Mein Sender" configured
  const [myStation, setMyStation] = React.useState(undefined);
  const [changing, setChanging] = React.useState(false);
  const [overview, setOverview] = React.useState(null);
  const [overviewLoading, setOverviewLoading] = React.useState(false);
  const [fetchState, setFetchState] = React.useState('');
  const stationId = myStation?.id ?? '';

  React.useEffect(() => {
    apiFetch('/api/my-station')
      .then((data) => setMyStation(data.station ?? null))
      .catch(() => setMyStation(null));
    apiFetch('/api/stations').then((data) => setStations(Array.isArray(data) ? data : []));
  }, []);

  React.useEffect(() => {
    if (!stationId) return;
    setOverviewLoading(true);
    apiFetch(`/api/my-station/overview?days=${days}&stationId=${encodeURIComponent(stationId)}`)
      .then((data) => setOverview(data))
      .catch(() => setOverview(null))
      .finally(() => setOverviewLoading(false));
  }, [days, stationId]);

  if (myStation === undefined) {
    return html`
      <${AppShell} activeKey="my-station" title="Mein Sender" subtitle="Sender wird ermittelt">
        <${LoadingSpinner} label="Prüfe, welcher Sender „Mein Sender“ ist…" size="lg" py="24" />
      <//>
    `;
  }

  // No "Mein Sender" configured, or switching → selection
  if (!myStation || changing) {
    return html`
      <${AppShell} activeKey="my-station" title="Mein Sender" subtitle="Sender festlegen">
        <${StationSetup}
          stations=${stations}
          current=${myStation?.id}
          onSelect=${(station) => {
            setOverview(null);
            setMyStation(station);
            setChanging(false);
          }}
          onCancel=${myStation ? () => setChanging(false) : null}
        />
      <//>
    `;
  }

  const cache = overview?.cache;
  const noPlays = !overviewLoading && overview && Number(overview.my_plays || 0) === 0;
  const fetchNow = async () => {
    try {
      await apiSend(`/api/admin/stations/${encodeURIComponent(myStation.id)}/run`, 'POST');
      setFetchState('Abruf gestartet – in ein paar Sekunden neu laden.');
    } catch (e) {
      setFetchState(String(e?.message ?? e));
    }
  };
  const value = (v) => (overviewLoading ? '…' : formatNumber(v ?? 0));

  return html`
    <${AppShell}
      activeKey="my-station"
      title=${myStation.name}
      subtitle="Vergleich mit anderen Sendern: was verpasst dein Sender, was ist exklusiv?"
      controls=${html`
        <${Chakra.HStack} spacing="3">
          <${DaySelector} value=${days} onChange=${setDays} />
          <${Chakra.Button}
            size="sm"
            variant="ghost"
            leftIcon=${React.createElement(Icons.SettingsIcon)}
            onClick=${() => setChanging(true)}
            title="Anderen Sender als „Mein Sender“ festlegen"
          >Ändern<//>
        <//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">

        <${Chakra.HStack} spacing="2" color="textMuted" fontSize="sm" flexWrap="wrap">
          <${AppIcons.Clock} />
          ${overviewLoading
            ? html`<${Chakra.Text}>Gleiche ${myStation.name} mit den anderen Sendern ab – das kann ein paar Sekunden dauern…<//>`
            : cache
              ? html`<${Chakra.Text}>Abgleich von ${formatClock(cache.computedAt)} Uhr${cache.cached ? ' (gespeichert)' : ''} · nächster Abgleich ab ${formatClock(cache.expiresAt)} Uhr (${formatRelative(cache.expiresAt)})<//>`
              : null}
        <//>

        ${noPlays ? html`
          <${Chakra.Alert} status="warning" borderRadius="14px" alignItems="flex-start">
            <${Chakra.AlertIcon} />
            <${Chakra.Box} flex="1">
              <${Chakra.Text} fontWeight="700">Für ${myStation.name} sind in den letzten ${days} Tagen noch keine Plays gespeichert.<//>
              <${Chakra.Text} fontSize="sm">Den Abrufstatus siehst du unter Administration → Übersicht. Erfasst werden nur Titel zwischen den eingestellten Uhrzeiten (Standard 6–21 Uhr).<//>
              ${fetchState ? html`<${Chakra.Text} fontSize="sm" mt="1">${fetchState}<//>` : null}
            <//>
            <${Chakra.HStack} spacing="2">
              <${Chakra.Button} size="sm" colorScheme="brand" onClick=${fetchNow}>Jetzt abrufen<//>
              <${Chakra.Button} size="sm" variant="ghost" as="a" href="/admin">Status<//>
            <//>
          <//>
        ` : null}

        <${Chakra.SimpleGrid} columns=${{ base: 2, xl: 4 }} spacing=${{ base: '3', md: '4' }}>
          <${StatTile} accent label="Plays gesamt" value=${value(overview?.my_plays)} icon=${AppIcons.Activity} hint=${`letzte ${days} Tage`} />
          <${StatTile} label="Einzigartige Titel" value=${value(overview?.my_unique_tracks)} icon=${AppIcons.Music} />
          <${StatTile} label="Verpasste Titel" value=${value(overview?.missed_count)} icon=${AppIcons.Search} hint="laufen woanders, hier nicht" />
          <${StatTile} label="Nur dein Sender" value=${value(overview?.exclusives_count)} icon=${AppIcons.Sparkle} hint="Geheimtipps" />
        <//>

        <${PanelCard}
          title="So liest du diese Seite"
          subtitle="Zeitraum oben rechts wählbar: 7 oder 14 Tage · Auf einen Track klicken öffnet die Detailseite"
        >
          <${Chakra.SimpleGrid} columns=${[1, 2]} spacing="4">
            <${Chakra.HStack} align="start" spacing="3">
              <${Chakra.Box} w="10px" h="10px" borderRadius="999px" bg="orange.400" mt="1" flexShrink="0" />
              <${Chakra.Box}>
                <${Chakra.Text} fontWeight="600" fontSize="sm">Verpasste Tracks<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>
                  Tracks, die andere Sender oft gespielt haben, dein Sender aber nicht.
                  Gute Kandidaten für neue Musik im Programm.
                <//>
              <//>
            <//>
            <${Chakra.HStack} align="start" spacing="3">
              <${Chakra.Box} w="10px" h="10px" borderRadius="999px" bg="green.400" mt="1" flexShrink="0" />
              <${Chakra.Box}>
                <${Chakra.Text} fontWeight="600" fontSize="sm">Geheimtipps<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>
                  Tracks die dein Sender spielt, aber kaum andere Sender kennen.
                  Das sind deine Alleinstellungsmerkmale.
                <//>
              <//>
            <//>
          <//>
        <//>

        <${Chakra.Tabs}
          index=${tab}
          onChange=${setTab}
          colorScheme="blue"
          variant="line"
          isLazy
        >
          <${Chakra.TabList} borderColor=${ui.lineColor}>
            <${Chakra.Tab} fontWeight="600">
              <${Chakra.HStack} spacing="2">
                <${Chakra.Box} w="8px" h="8px" borderRadius="999px" bg="orange.400" />
                <${Chakra.Text}>Verpasste Tracks<//>
              <//>
            <//>
            <${Chakra.Tab} fontWeight="600">
              <${Chakra.HStack} spacing="2">
                <${Chakra.Box} w="8px" h="8px" borderRadius="999px" bg="green.400" />
                <${Chakra.Text}>Geheimtipps<//>
              <//>
            <//>
          <//>
          <${Chakra.TabPanels}>
            <${Chakra.TabPanel} px="0">
              <${MissedTab} days=${days} stationId=${stationId} />
            <//>
            <${Chakra.TabPanel} px="0">
              <${ExclusivesTab} days=${days} stationId=${stationId} />
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(html`
  <${Chakra.ChakraProvider} theme=${horizonTheme}>
    <${MyStationApp} />
  <//>
`);
