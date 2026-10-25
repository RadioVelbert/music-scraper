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
  formatRelative,
  AppShell,
  PanelCard,
  StatTile,
  AppIcons,
  CoverPlay,
  CopyTrackButton,
  FavoriteButton,
  OwnPlayBadge,
  LoadingSpinner,
  LoadingOverlay,
  navigate,
  trackHref
} from './horizon-lib.js';

const TREND = {
  up: { icon: Icons.TriangleUpIcon, color: 'green.400', label: 'gestiegen' },
  down: { icon: Icons.TriangleDownIcon, color: 'red.400', label: 'gefallen' },
  new: { icon: AppIcons.Sparkle, color: 'brand.400', label: 'neu' },
  same: { icon: Icons.MinusIcon, color: 'textMuted', label: 'gleich' }
};

// URL slug → chart id and sidebar entry
const PAGES = {
  radio: { chartId: 'radiocharts_de', navKey: 'charts-radio' },
  billboard: { chartId: 'billboard_200', navKey: 'charts-billboard' }
};
const PAGE = PAGES[window.location.pathname.split('/').filter(Boolean)[1]] || PAGES.radio;

function weekLabel(week) {
  const match = /^(\d{4})-W(\d{2})$/.exec(week || '');
  return match ? `KW ${Number(match[2])}/${match[1]}` : week || '–';
}

function Movement({ entry }) {
  const trend = TREND[entry.trend] || TREND.same;
  const delta = entry.prev_position ? entry.prev_position - entry.position : null;
  return html`
    <${Chakra.Tooltip} label=${entry.prev_position ? `Vorwoche: Platz ${entry.prev_position}` : 'Neu in den Charts'}>
      <${Chakra.HStack} spacing="1" color=${trend.color} justify="center">
        <${trend.icon} boxSize="3" />
        <${Chakra.Text} fontSize="xs" fontWeight="700">${delta ? (delta > 0 ? `+${delta}` : delta) : entry.prev_position ? '' : 'NEU'}<//>
      <//>
    <//>
  `;
}

function ChartsApp() {
  const [charts, setCharts] = React.useState(null);
  const chartId = PAGE.chartId;
  const [week, setWeek] = React.useState('');
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState('all');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    apiFetch('/api/charts')
      .then((rows) => setCharts(rows))
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  React.useEffect(() => {
    if (!chartId) return;
    setLoading(true);
    apiFetch(`/api/charts/${encodeURIComponent(chartId)}${week ? `?week=${encodeURIComponent(week)}` : ''}`)
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [chartId, week]);

  const chart = charts?.find((c) => c.id === chartId);
  const entries = data?.entries || [];
  const isAlbums = data?.kind === 'albums';
  // Album charts link to the artist's most played track.
  const linkKey = (e) => (isAlbums ? e.top_track_key : e.track_key);
  const visible = entries.filter((e) => {
    if (filter === 'mine') return e.my_plays_7d > 0;
    if (filter === 'missing') return !e.my_plays_7d;
    if (filter === 'unknown') return !e.matched;
    return true;
  });
  const mineCount = entries.filter((e) => e.my_plays_7d > 0).length;
  const matchedCount = entries.filter((e) => e.matched).length;
  const newCount = entries.filter((e) => !e.prev_position).length;

  return html`
    <${AppShell}
      activeKey=${PAGE.navKey}
      title=${chart?.name || 'Charts'}
      subtitle=${chart ? `${chart.provider} · ${weekLabel(data?.week)}` : 'Externe Charts im Vergleich mit unseren Sendern'}
      controls=${chart?.weeks?.length ? html`
        <${Chakra.Select} size="sm" w="150px" value=${week || chart.weeks[0]} onChange=${(e) => setWeek(e.target.value === chart.weeks[0] ? '' : e.target.value)}>
          ${chart.weeks.map((w) => html`<option key=${w} value=${w}>${weekLabel(w)}</option>`)}
        <//>
      ` : null}
    >
      ${error ? html`<${Chakra.Alert} status="error" borderRadius="14px" mb="6"><${Chakra.AlertIcon} />${error}<//>` : null}
      ${!charts ? html`<${LoadingSpinner} label="Lade Charts…" size="lg" py="24" />` : html`
        <${Chakra.VStack} align="stretch" spacing="6">
          ${chart && !chart.weeks.length ? html`
            <${Chakra.Alert} status=${chart.run?.last_status === 'error' ? 'error' : 'info'} borderRadius="14px">
              <${Chakra.AlertIcon} />
              ${chart.run?.last_status === 'error'
                ? `Abruf fehlgeschlagen: ${chart.run.last_error}`
                : 'Noch keine Daten – die Charts werden stündlich abgerufen (Administration → Jobs → „Charts abrufen“ startet sofort).'}
            <//>
          ` : null}

          <${Chakra.SimpleGrid} columns=${{ base: 2, xl: 4 }} spacing=${{ base: '3', md: '4' }}>
            <${StatTile} accent label="Chartwoche" value=${weekLabel(data?.week)} icon=${AppIcons.Calendar} hint=${chart?.run?.last_fetched_at_utc ? `abgerufen ${formatRelative(chart.run.last_fetched_at_utc)}` : null} />
            <${StatTile} label="Bei Mein Sender" value=${`${mineCount} / ${entries.length}`} icon=${AppIcons.Radio} hint="in den letzten 7 Tagen gespielt" />
            <${StatTile} label="In unseren Daten" value=${`${matchedCount} / ${entries.length}`} icon=${AppIcons.Music} hint="von allen beobachteten Sendern" />
            <${StatTile} label="Neueinsteiger" value=${formatNumber(newCount)} icon=${AppIcons.Sparkle} />
          <//>

          <${PanelCard}
            title=${chart?.name || 'Charts'}
            subtitle=${chart ? html`Quelle: <${Chakra.Link} href=${chart.url} isExternal color="accent">${chart.provider}<//> · ${isAlbums ? 'Album-Chart: Plays = alle Titel des Interpreten, letzte 7 Tage bei unseren Sendern' : 'Plays = letzte 7 Tage bei unseren Sendern'}` : null}
            icon=${AppIcons.Chart}
            p="0"
            right=${html`
              <${Chakra.ButtonGroup} size="sm" isAttached variant="outline" pr="5" pt="5">
                ${[['all', 'Alle'], ['mine', 'Läuft bei Mein Sender'], ['missing', 'Fehlt bei Mein Sender'], ['unknown', 'Nicht in unseren Daten']].map(([key, label]) => html`
                  <${Chakra.Button} key=${key} onClick=${() => setFilter(key)} variant=${filter === key ? 'solid' : 'outline'} colorScheme=${filter === key ? 'brand' : 'gray'}>${label}<//>
                `)}
              <//>
            `}
          >
            <${LoadingOverlay} isLoading=${loading && entries.length > 0} label="Lade Chartwoche…">
              ${loading && !entries.length ? html`<${LoadingSpinner} label="Lade Charts…" />` : html`
                <${Chakra.TableContainer} className="horizon-scroll">
                  <${Chakra.Table} size="sm">
                    <${Chakra.Thead} bg="subtleBg">
                      <${Chakra.Tr}>
                        <${Chakra.Th} py="3" w="1%">Platz<//>
                        <${Chakra.Th} py="3" w="1%" textAlign="center">Trend<//>
                        <${Chakra.Th} py="3">${isAlbums ? 'Album' : 'Titel'}<//>
                        ${isAlbums ? null : html`<${Chakra.Th} py="3">Label<//>`}
                        <${Chakra.Th} py="3" isNumeric>Wochen<//>
                        <${Chakra.Th} py="3" isNumeric>${isAlbums ? 'Interpret-Plays' : 'Plays'}<//>
                        <${Chakra.Th} py="3" isNumeric>Sender<//>
                        <${Chakra.Th} py="3" isNumeric>Mein Sender<//>
                      <//>
                    <//>
                    <${Chakra.Tbody}>
                      ${visible.map((entry) => html`
                        <${Chakra.Tr}
                          key=${entry.position}
                          className=${linkKey(entry) ? 'rv-row-clickable group' : 'group'}
                          _hover=${{ bg: 'subtleBg' }}
                          onClick=${() => linkKey(entry) && navigate(trackHref(linkKey(entry)))}
                        >
                          <${Chakra.Td} py="2.5" fontSize="lg" fontWeight="800" textAlign="right">${entry.position}<//>
                          <${Chakra.Td} py="2.5"><${Movement} entry=${entry} /><//>
                          <${Chakra.Td} py="2.5" w="45%">
                            <${Chakra.HStack} spacing="3" w="100%">
                              ${linkKey(entry) || !isAlbums
                                ? html`<${CoverPlay} track=${{ trackKey: linkKey(entry) || undefined, artist: entry.artist, title: entry.title, artworkUrl: entry.image_url || entry.artwork_url || entry.top_track_artwork }} size="40px" />`
                                : entry.image_url
                                  ? html`<${Chakra.Image} src=${entry.image_url} boxSize="40px" minW="40px" borderRadius="10px" objectFit="cover" loading="lazy" />`
                                  : html`<${Chakra.Box} boxSize="40px" minW="40px" borderRadius="10px" bg="subtleBg" />`}
                              <${Chakra.Box} minW="0">
                                <${Chakra.Text} fontWeight="700" fontSize="sm" noOfLines=${1}>${entry.title}<//>
                                <${Chakra.Text} fontSize="sm" color="textMuted" noOfLines=${1}>${entry.artist}<//>
                              <//>
                              <${CopyTrackButton} artist=${entry.artist} title=${entry.title} />
<${OwnPlayBadge} artist=${entry.artist} title=${entry.title} trackKey=${entry.track_key} />
<${Chakra.Spacer} />
<${FavoriteButton} artist=${entry.artist} title=${entry.title} trackKey=${entry.track_key} artworkUrl=${entry.image_url} />
                            <//>
                          <//>
                          ${isAlbums ? null : html`<${Chakra.Td} py="2.5" fontSize="xs" color="textMuted" maxW="200px"><${Chakra.Text} noOfLines=${1}>${entry.label || '–'}<//><//>`}
                          <${Chakra.Td} py="2.5" isNumeric fontSize="sm">
                            ${entry.weeks ?? '–'}
                            ${entry.peak_position ? html`<${Chakra.Text} fontSize="10px" color="textMuted">Höchst: ${entry.peak_position}<//>` : null}
                          <//>
                          <${Chakra.Td} py="2.5" isNumeric fontWeight="700">${entry.matched ? formatNumber(entry.plays_7d) : '–'}<//>
                          <${Chakra.Td} py="2.5" isNumeric fontSize="sm">${entry.matched ? formatNumber(entry.stations_7d) : '–'}<//>
                          <${Chakra.Td} py="2.5" isNumeric>
                            ${entry.my_plays_7d > 0
                              ? html`<${Chakra.Badge} colorScheme="green">${formatNumber(entry.my_plays_7d)}×<//>`
                              : html`<${Chakra.Badge} colorScheme=${entry.matched ? 'orange' : 'gray'}>${entry.matched ? 'fehlt' : '–'}<//>`}
                          <//>
                        <//>
                      `)}
                      ${visible.length === 0 && entries.length ? html`<${Chakra.Tr}><${Chakra.Td} colSpan=${8} py="10" textAlign="center" color="textMuted">Keine Titel für diesen Filter.<//><//>` : null}
                    <//>
                  <//>
                <//>
              `}
            <//>
          <//>
          ${chart?.run?.last_fetched_at_utc ? html`<${Chakra.Text} fontSize="xs" color="textMuted">Letzter Abruf: ${formatDateTime(chart.run.last_fetched_at_utc)} · stündlich aktualisiert · © ${chart.provider}<//>` : null}
        <//>
      `}
    <//>
  `;
}

createRoot(document.getElementById('app')).render(html`
  <${Chakra.ChakraProvider} theme=${horizonTheme}>
    <${ChartsApp} />
  <//>
`);
