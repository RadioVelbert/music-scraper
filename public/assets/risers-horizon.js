import {
  React,
  createRoot,
  Chakra,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  formatRelative,
  AppShell,
  PanelCard,
  AppIcons,
  CoverPlay,
  CopyTrackButton,
  FavoriteButton,
  OwnPlayBadge,
  LoadingSpinner,
  trackHref,
  navigate
} from './horizon-lib.js';

function RisersApp() {
  const [days, setDays] = React.useState('3');
  const [minStations, setMinStations] = React.useState('2');
  const [onlyNew, setOnlyNew] = React.useState(true);
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    setError('');
    const params = new URLSearchParams({ days, minStations, limit: '200', excludeOwn: onlyNew ? '1' : '0' });
    apiFetch(`/api/risers?${params}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((e) => { if (!cancelled) { setData(null); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { cancelled = true; };
  }, [days, minStations, onlyNew]);

  const tracks = data?.tracks || [];
  const hasOwn = Boolean(data?.own_station_id);

  return html`
    <${AppShell}
      activeKey="risers"
      title="Aufsteiger"
      subtitle="Songs, die gerade bei immer mehr Sendern anlaufen"
      controls=${html`
        <${Chakra.HStack} spacing="2">
          <${Chakra.Select} size="sm" w="150px" borderRadius="10px" value=${days} onChange=${(e) => setDays(e.target.value)} aria-label="Zeitraum">
            <option value="1">Letzte 24 Std.</option>
            <option value="3">Letzte 3 Tage</option>
            <option value="7">Letzte 7 Tage</option>
            <option value="14">Letzte 14 Tage</option>
          <//>
          <${Chakra.Select} size="sm" w="150px" borderRadius="10px" value=${minStations} onChange=${(e) => setMinStations(e.target.value)} aria-label="Mindestens Sender">
            <option value="2">ab 2 Sendern</option>
            <option value="3">ab 3 Sendern</option>
            <option value="5">ab 5 Sendern</option>
          <//>
        <//>
      `}
    >
      <${PanelCard}
        title=${data ? `${formatNumber(tracks.length)} Aufsteiger` : 'Aufsteiger'}
        subtitle="Verglichen wird der gewählte Zeitraum mit dem gleich langen Zeitraum davor: mehr Sender = stärkerer Aufsteiger."
        icon=${AppIcons.TrendUp}
        right=${hasOwn ? html`
          <${Chakra.FormControl} display="flex" alignItems="center" w="auto">
            <${Chakra.FormLabel} htmlFor="only-new" mb="0" fontSize="sm">Nur was bei uns noch nicht lief<//>
            <${Chakra.Switch} id="only-new" colorScheme="brand" isChecked=${onlyNew} onChange=${(e) => setOnlyNew(e.target.checked)} />
          <//>
        ` : null}
      >
        ${error ? html`<${Chakra.Text} color="red.400" fontSize="sm">${error}<//>` : null}
        ${!data && !error ? html`<${LoadingSpinner} label="Lade Aufsteiger…" />` : null}
        ${data && !tracks.length ? html`
          <${Chakra.Text} color="textMuted" fontSize="sm" py="6" textAlign="center">
            Keine Aufsteiger für diese Einstellung. Probier einen längeren Zeitraum oder weniger Mindest-Sender.
          <//>
        ` : null}
        ${tracks.length ? html`
          <${Chakra.TableContainer}>
            <${Chakra.Table} size="sm" variant="simple">
              <${Chakra.Thead}>
                <${Chakra.Tr}>
                  <${Chakra.Th} w="8">#<//>
                  <${Chakra.Th}>Titel<//>
                  <${Chakra.Th} isNumeric>Sender jetzt<//>
                  <${Chakra.Th} isNumeric>Davor<//>
                  <${Chakra.Th} isNumeric>Plays<//>
                  <${Chakra.Th}>Zuletzt<//>
                <//>
              <//>
              <${Chakra.Tbody}>
                ${tracks.map((row, index) => html`
                  <${Chakra.Tr} key=${row.track_key} className="rv-row-clickable group" _hover=${{ bg: 'subtleBg' }} onClick=${() => navigate(trackHref(row.track_key))}>
                    <${Chakra.Td} py="2.5" color="textMuted" fontSize="xs" fontWeight="600">${index + 1}<//>
                    <${Chakra.Td} py="2.5" w="50%">
                      <${Chakra.HStack} spacing="3" w="100%">
                        <${CoverPlay} track=${{ trackKey: row.track_key, artist: row.artist, title: row.title, artworkUrl: row.artwork_url }} size="44px" />
                        <${Chakra.Box} minW="0">
                          <${Chakra.HStack} spacing="2">
                            <${Chakra.Text} fontWeight="700" fontSize="sm" noOfLines=${1}>${row.title}<//>
                            ${row.is_new ? html`<${Chakra.Badge} colorScheme="purple" borderRadius="999px" flexShrink="0">Neu<//>` : null}
                          <//>
                          <${Chakra.Text} fontSize="sm" color="textMuted" noOfLines=${1}>${row.artist}<//>
                        <//>
                        <${CopyTrackButton} artist=${row.artist} title=${row.title} />
                        <${OwnPlayBadge} artist=${row.artist} title=${row.title} trackKey=${row.track_key} />
                        <${Chakra.Spacer} />
                        <${FavoriteButton} artist=${row.artist} title=${row.title} trackKey=${row.track_key} artworkUrl=${row.artwork_url} />
                      <//>
                    <//>
                    <${Chakra.Td} py="2.5" isNumeric>
                      <${Chakra.HStack} spacing="2" justify="flex-end">
                        <${Chakra.Text} fontWeight="700">${formatNumber(row.stations_now)}<//>
                        <${Chakra.Badge} colorScheme="green" borderRadius="999px">+${formatNumber(row.station_delta)}<//>
                      <//>
                    <//>
                    <${Chakra.Td} py="2.5" isNumeric color="textMuted">${formatNumber(row.stations_prev)}<//>
                    <${Chakra.Td} py="2.5" isNumeric>${formatNumber(row.plays_now)}<//>
                    <${Chakra.Td} py="2.5" fontSize="sm" color="textMuted">${formatRelative(row.last_played_at_utc)}<//>
                  <//>
                `)}
              <//>
            <//>
          <//>
        ` : null}
      <//>
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(html`
  <${Chakra.ChakraProvider} theme=${horizonTheme}>
    <${RisersApp} />
  <//>
`);
