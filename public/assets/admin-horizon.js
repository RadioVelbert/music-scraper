import {
  React,
  createRoot,
  Chakra,
  Icons,
  html,
  horizonTheme,
  apiFetch,
  apiSend,
  formatNumber,
  formatDateTime,
  formatDate,
  formatBytes,
  formatRelative,
  AppShell,
  PanelCard,
  StatTile,
  AppIcons,
  BRAND_GRADIENT,
  LoadingSpinner
} from './horizon-lib.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SOURCE_TYPES = [
  { key: 'onlineradiobox', label: 'onlineradiobox', description: 'Sender suchen, Playlist-URL wird übernommen' },
  { key: 'lautfm', label: 'laut.fm', description: 'Sendername eingeben – Abruf alle 5 Minuten' },
  { key: 'json', label: 'JSON-API', description: 'Beliebige JSON-Playlist mit eigenem Feld-Mapping' },
  { key: 'html', label: 'HTML / Experte', description: 'Andere Parser (DLF Nova, radio.menu, generisch …)' }
];

const SOURCE_BADGES = {
  onlineradiobox: { label: 'onlineradiobox', scheme: 'purple' },
  lautfm: { label: 'laut.fm', scheme: 'orange' },
  json: { label: 'JSON', scheme: 'brand' },
  html: { label: 'HTML', scheme: 'gray' }
};

const HTML_PARSERS = [
  ['generic_html_or_onlineradiobox', 'Automatisch (generisch / onlineradiobox)'],
  ['generic_html', 'Generisches HTML'],
  ['dlf_nova', 'Deutschlandfunk Nova'],
  ['fluxfm', 'FluxFM'],
  ['radiomenu', 'radio.menu'],
  ['nrwlokalradios_json', 'NRW Lokalradios (fest)'],
  ['onlineradiobox', 'onlineradiobox'],
  ['lautfm_json', 'laut.fm (fest)']
];

const TIMEZONES = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/London', 'Europe/Paris'];

const JSON_DEFAULTS = {
  items_path: '',
  artist_path: 'artist',
  title_path: 'title',
  time_path: 'timeslot_iso',
  time_format: 'iso',
  filter_path: '',
  filter_value: '',
  split_separator: ' - ',
  isrc_path: '',
  deezer_id_path: '',
  artwork_path: ''
};

const JSON_PRESETS = [
  {
    key: 'radiovelbert',
    label: 'RadioVelbert API (mit Deezer-ID, ISRC und Cover)',
    // Max. 200 Einträge; {limit:200} holt nur so viele Songs, wie seit dem letzten Abruf nötig sind.
    url: 'https://api.radiovelbert.de/api/songs/history?limit={limit:200}',
    lookback: 90,
    json: {
      ...JSON_DEFAULTS,
      items_path: 'data',
      time_path: 'last_played',
      isrc_path: 'isrc',
      deezer_id_path: 'deezer_id',
      artwork_path: 'artwork',
      artwork_base_url: 'https://api.radiovelbert.de'
    }
  },
  {
    key: 'nrw_window',
    label: 'NRW Lokalradios – Zeitfenster (z. B. Radio Neandertal)',
    url: 'https://www.radioneandertal.de/playlist/title?station=live&req_station=29&datefrom={from:yyyy-MM-dd HH:mm:ss}&dateto={to:yyyy-MM-dd HH:mm:ss}&pagesize=1000',
    json: { ...JSON_DEFAULTS }
  },
  {
    key: 'nrw_latest',
    label: 'NRW Lokalradios – letzte 500 Titel',
    url: 'https://api-prod.nrwlokalradios.com/playlist/latest?station=29&req_station=29&count=500',
    json: { ...JSON_DEFAULTS }
  },
  {
    key: 'lautfm',
    label: 'laut.fm last_songs',
    url: 'https://api.laut.fm/station/SENDERNAME/last_songs',
    json: { ...JSON_DEFAULTS, artist_path: 'artist.name', time_path: 'started_at', time_format: 'yyyy-MM-dd HH:mm:ss ZZZ', filter_path: 'type', filter_value: 'song' }
  }
];

const JOB_STATUS = {
  queued: { label: 'Wartet', scheme: 'gray' },
  running: { label: 'Läuft', scheme: 'brand' },
  success: { label: 'OK', scheme: 'green' },
  failed: { label: 'Fehler', scheme: 'red' },
  cancelled: { label: 'Abgebrochen', scheme: 'orange' },
  aborted: { label: 'Unterbrochen', scheme: 'orange' }
};

const TRIGGER_LABELS = { schedule: 'Zeitplan', manual: 'Manuell', startup: 'Start' };

const LANE_LABELS = { ingest: 'Abruf', 'ingest-fast': 'Schnellabruf', maintenance: 'Wartung', exclusive: 'Exklusiv' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function useToastError() {
  const toast = Chakra.useToast();
  return React.useCallback((title, error) => toast({ status: 'error', title, description: errorText(error), duration: 6000, isClosable: true }), [toast]);
}

function durationText(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '–';
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
  return `${Math.floor(value / 60000)} min ${Math.round((value % 60000) / 1000)} s`;
}

function stationState(row) {
  if (!row.configured) return { label: 'Nicht konfiguriert', scheme: 'gray' };
  if (row.running) return { label: 'Läuft', scheme: 'brand', pulse: true };
  if (row.queued) return { label: 'Wartet', scheme: 'brand' };
  if (!row.enabled) return { label: 'Inaktiv', scheme: 'gray' };
  const status = row.status?.last_status;
  if (!status) return { label: 'Noch nie', scheme: 'gray' };
  if (status === 'ok') return { label: 'OK', scheme: 'green' };
  if (status === 'empty') return { label: 'Keine Daten', scheme: 'orange' };
  return { label: row.status?.consecutive_failures > 1 ? `Fehler ×${row.status.consecutive_failures}` : 'Fehler', scheme: 'red' };
}

function sinceText(iso) {
  const relative = formatRelative(iso);
  return relative.startsWith('vor ') ? `seit ${relative.slice(4)}` : relative;
}

function SourceBadge({ type }) {
  if (!type) return null;
  const badge = SOURCE_BADGES[type] || SOURCE_BADGES.html;
  return html`<${Chakra.Badge} colorScheme=${badge.scheme} variant="subtle" fontSize="10px">${badge.label}<//>`;
}

// ── Station form model ───────────────────────────────────────────────────────

function emptyForm() {
  return {
    sourceType: 'onlineradiobox',
    id: '',
    idTouched: false,
    name: '',
    playlist_url: '',
    fallback_urls_text: '',
    parser: 'onlineradiobox',
    fetcher: 'http',
    timezone: 'Europe/Berlin',
    my_station: false,
    enabled: true,
    refresh_mode: 'default',
    refresh_minutes: 60,
    lookback_minutes: '',
    json: { ...JSON_DEFAULTS },
    enforce_one_play_per_minute: false,
    min_play_gap_seconds: 0,
    min_daily_hours: 20,
    min_daily_plays: 24
  };
}

function formFromStation(row) {
  const config = row.config;
  const form = emptyForm();
  if (!config) return { ...form, id: row.id, idTouched: true, name: row.name || row.id };
  return {
    ...form,
    sourceType: row.sourceType === 'json' && config.parser !== 'json' ? 'html' : (row.sourceType || 'html'),
    id: config.id,
    idTouched: true,
    name: config.name,
    playlist_url: config.playlist_url,
    fallback_urls_text: (config.fallback_urls || []).join('\n'),
    parser: config.parser,
    fetcher: config.fetcher || 'http',
    timezone: config.timezone || 'Europe/Berlin',
    my_station: Boolean(config.my_station),
    enabled: Boolean(row.enabled),
    refresh_mode: Number.isInteger(config.refresh_minutes) ? 'custom' : 'default',
    refresh_minutes: config.refresh_minutes || row.refreshMinutes || 60,
    lookback_minutes: config.lookback_minutes || '',
    json: { ...JSON_DEFAULTS, ...(config.json || {}) },
    enforce_one_play_per_minute: Boolean(config.enforce_one_play_per_minute),
    min_play_gap_seconds: config.min_play_gap_seconds || 0,
    min_daily_hours: config.min_daily_hours ?? 20,
    min_daily_plays: config.min_daily_plays ?? 24
  };
}

function parserForForm(form) {
  if (form.sourceType === 'onlineradiobox') return 'onlineradiobox';
  if (form.sourceType === 'lautfm') return 'lautfm_json';
  if (form.sourceType === 'json') return 'json';
  return form.parser;
}

function configFromForm(form) {
  const parser = parserForForm(form);
  const config = {
    id: form.id.trim(),
    name: form.name.trim(),
    playlist_url: form.playlist_url.trim(),
    fallback_urls: form.fallback_urls_text.split('\n').map((line) => line.trim()).filter(Boolean),
    parser,
    fetcher: form.sourceType === 'html' ? form.fetcher : 'http',
    timezone: form.timezone,
    my_station: Boolean(form.my_station),
    enabled: Boolean(form.enabled),
    enforce_one_play_per_minute: Boolean(form.enforce_one_play_per_minute),
    min_play_gap_seconds: Number(form.min_play_gap_seconds) || 0,
    min_daily_hours: Number(form.min_daily_hours) || 20,
    min_daily_plays: Number(form.min_daily_plays) || 0
  };
  if (form.refresh_mode === 'custom') config.refresh_minutes = Math.max(1, Math.round(Number(form.refresh_minutes) || 60));
  if (form.lookback_minutes) config.lookback_minutes = Math.round(Number(form.lookback_minutes));
  if (parser === 'json') config.json = { ...form.json };
  return config;
}

// ── Station editor ───────────────────────────────────────────────────────────

function Field({ label, help, children, isRequired }) {
  return html`
    <${Chakra.FormControl} isRequired=${isRequired}>
      <${Chakra.FormLabel} fontSize="sm" mb="1">${label}<//>
      ${children}
      ${help ? html`<${Chakra.FormHelperText} fontSize="xs">${help}<//>` : null}
    <//>
  `;
}

function OnlineradioboxSearch({ onPick }) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const toastError = useToastError();

  const search = async () => {
    if (query.trim().length < 2) return;
    setLoading(true);
    try {
      setResults(await apiFetch(`/api/admin/sources/onlineradiobox?${new URLSearchParams({ q: query.trim() })}`));
    } catch (error) {
      toastError('Suche fehlgeschlagen', error);
    } finally {
      setLoading(false);
    }
  };

  return html`
    <${Chakra.Box}>
      <${Chakra.HStack}>
        <${Chakra.InputGroup}>
          <${Chakra.InputLeftElement} pointerEvents="none" color="textMuted"><${AppIcons.Search} /><//>
          <${Chakra.Input} placeholder="Sender suchen, z. B. WDR 2" value=${query} onChange=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
        <//>
        <${Chakra.Button} onClick=${search} isLoading=${loading} colorScheme="brand">Suchen<//>
      <//>
      ${results ? html`
        <${Chakra.VStack} align="stretch" spacing="1" mt="3" maxH="260px" overflowY="auto" className="horizon-scroll">
          ${results.length === 0 ? html`<${Chakra.Text} fontSize="sm" color="textMuted">Keine Sender gefunden.<//>` : null}
          ${results.map((r) => html`
            <${Chakra.HStack}
              key=${r.playlistUrl}
              as="button"
              type="button"
              textAlign="left"
              spacing="3"
              p="2"
              borderRadius="12px"
              border="1px solid"
              borderColor="lineColor"
              _hover=${{ bg: 'subtleBg', borderColor: 'brand.300' }}
              onClick=${() => onPick(r)}
            >
              <${Chakra.Image} src=${r.logoUrl || '/assets/favicon.png'} boxSize="36px" borderRadius="8px" objectFit="cover" bg="white" />
              <${Chakra.Box} flex="1" minW="0">
                <${Chakra.Text} fontWeight="700" fontSize="sm" noOfLines=${1}>${r.name}<//>
                <${Chakra.Text} fontSize="xs" color="textMuted" noOfLines=${1}>${[r.country.toUpperCase(), r.region].filter(Boolean).join(' · ')} · ${r.slug}<//>
              <//>
              <${Chakra.Text} fontSize="xs" color="accent" fontWeight="700">Übernehmen<//>
            <//>
          `)}
        <//>
      ` : null}
    <//>
  `;
}

function LautfmLookup({ initialName, onFound }) {
  const [name, setName] = React.useState(initialName || '');
  const [info, setInfo] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);

  const check = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setNotFound(false);
    try {
      const result = await apiFetch(`/api/admin/sources/lautfm/${encodeURIComponent(name.trim().toLowerCase())}`);
      setInfo(result);
      onFound(result);
    } catch {
      setInfo(null);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  return html`
    <${Chakra.Box}>
      <${Chakra.HStack}>
        <${Chakra.InputGroup}>
          <${Chakra.InputLeftAddon}>laut.fm/<//>
          <${Chakra.Input} placeholder="radiovelbert" value=${name} onChange=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } }} />
        <//>
        <${Chakra.Button} onClick=${check} isLoading=${loading} colorScheme="brand">Prüfen<//>
      <//>
      ${notFound ? html`<${Chakra.Text} mt="2" fontSize="sm" color="red.400">Kein laut.fm-Sender mit diesem Namen gefunden.<//>` : null}
      ${info ? html`
        <${Chakra.HStack} mt="3" p="3" borderRadius="12px" bg="subtleBg" spacing="3">
          <${Chakra.Flex} boxSize="36px" borderRadius="10px" bg=${BRAND_GRADIENT} color="white" align="center" justify="center"><${AppIcons.Radio} /><//>
          <${Chakra.Box}>
            <${Chakra.Text} fontWeight="700" fontSize="sm">${info.displayName}<//>
            <${Chakra.Text} fontSize="xs" color="textMuted">${[info.location, info.genres?.join(', ')].filter(Boolean).join(' · ')}<//>
          <//>
        <//>
      ` : null}
      <${Chakra.Text} mt="2" fontSize="xs" color="textMuted">laut.fm liefert nur die letzten 10 Titel. Deshalb werden laut.fm-Sender standardmäßig alle 5 Minuten abgefragt.<//>
    <//>
  `;
}

function JsonMappingFields({ form, setJson }) {
  const json = form.json;
  return html`
    <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="3">
      <${Field} label="Pfad zur Liste" help="Leer = Antwort ist direkt eine Liste. Sonst z. B. data.items">
        <${Chakra.Input} size="sm" fontFamily="mono" value=${json.items_path} onChange=${(e) => setJson({ items_path: e.target.value })} placeholder="(Wurzel)" />
      <//>
      <${Field} label="Zeitformat" help="iso, unix, unix_ms oder Luxon-Format wie yyyy-MM-dd HH:mm:ss">
        <${Chakra.Input} size="sm" fontFamily="mono" value=${json.time_format} onChange=${(e) => setJson({ time_format: e.target.value })} />
      <//>
      <${Field} label="Feld Interpret" help="Leer = Titelfeld enthält „Interpret - Titel“">
        <${Chakra.Input} size="sm" fontFamily="mono" value=${json.artist_path} onChange=${(e) => setJson({ artist_path: e.target.value })} />
      <//>
      <${Field} label="Feld Titel">
        <${Chakra.Input} size="sm" fontFamily="mono" value=${json.title_path} onChange=${(e) => setJson({ title_path: e.target.value })} />
      <//>
      <${Field} label="Feld Zeitpunkt">
        <${Chakra.Input} size="sm" fontFamily="mono" value=${json.time_path} onChange=${(e) => setJson({ time_path: e.target.value })} />
      <//>
      <${Field} label="Filter (optional)" help="Nur Einträge, deren Feld diesen Wert hat (z. B. type = song)">
        <${Chakra.HStack}>
          <${Chakra.Input} size="sm" fontFamily="mono" placeholder="Feld" value=${json.filter_path} onChange=${(e) => setJson({ filter_path: e.target.value })} />
          <${Chakra.Input} size="sm" fontFamily="mono" placeholder="Wert" value=${json.filter_value} onChange=${(e) => setJson({ filter_value: e.target.value })} />
        <//>
      <//>
      <${Field} label="Feld Deezer-ID (optional)" help="Wenn vorhanden, wird der Titel ohne Deezer-Suche exakt zugeordnet.">
        <${Chakra.Input} size="sm" fontFamily="mono" placeholder="z. B. deezer_id" value=${json.deezer_id_path} onChange=${(e) => setJson({ deezer_id_path: e.target.value })} />
      <//>
      <${Field} label="Feld ISRC / Cover (optional)" help="Cover-Pfade dürfen relativ sein (/artwork/1.webp).">
        <${Chakra.HStack}>
          <${Chakra.Input} size="sm" fontFamily="mono" placeholder="isrc" value=${json.isrc_path} onChange=${(e) => setJson({ isrc_path: e.target.value })} />
          <${Chakra.Input} size="sm" fontFamily="mono" placeholder="artwork" value=${json.artwork_path} onChange=${(e) => setJson({ artwork_path: e.target.value })} />
        <//>
      <//>
    <//>
  `;
}

function TestResult({ result }) {
  if (!result) return null;
  return html`
    <${Chakra.Box} mt="4" border="1px solid" borderColor=${result.ok ? 'green.300' : 'red.300'} borderRadius="16px" overflow="hidden">
      <${Chakra.Flex} px="4" py="3" bg=${result.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'} gap="4" wrap="wrap" align="center">
        <${Chakra.Badge} colorScheme=${result.ok ? 'green' : 'red'}>${result.ok ? 'Erfolgreich' : 'Fehlgeschlagen'}<//>
        ${result.ok ? html`
          <${Chakra.Text} fontSize="sm"><b>${formatNumber(result.total)}</b> Titel gefunden<//>
          <${Chakra.Text} fontSize="sm" color="textMuted">${formatDateTime(result.oldestPlayedAtUtc)} – ${formatDateTime(result.newestPlayedAtUtc)}<//>
        ` : html`<${Chakra.Text} fontSize="sm" color="red.400">${result.error}<//>`}
        <${Chakra.Text} fontSize="xs" color="textMuted" ml="auto">${durationText(result.durationMs)}<//>
      <//>
      ${result.attempts?.length ? html`
        <${Chakra.Box} px="4" py="2" borderTop="1px solid" borderColor="lineColor">
          ${result.attempts.map((attempt, index) => html`
            <${Chakra.Text} key=${index} fontSize="xs" fontFamily="mono" color=${attempt.error ? 'red.400' : 'textMuted'} noOfLines=${2} wordBreak="break-all">
              ${attempt.error ? '✗' : '✓'} ${attempt.url} ${attempt.error ? `– ${attempt.error}` : `– ${attempt.plays} Titel`}
            <//>
          `)}
        <//>
      ` : null}
      ${result.plays?.length ? html`
        <${Chakra.TableContainer} maxH="280px" overflowY="auto" className="horizon-scroll">
          <${Chakra.Table} size="sm">
            <${Chakra.Thead} position="sticky" top="0" bg="cardBg">
              <${Chakra.Tr}><${Chakra.Th}>Zeit<//><${Chakra.Th}>Interpret<//><${Chakra.Th}>Titel<//><${Chakra.Th}>${result.plays.some((p) => p.isrc || p.deezerId) ? 'Zuordnung' : ''}<//><//>
            <//>
            <${Chakra.Tbody}>
              ${result.plays.map((play, index) => html`
                <${Chakra.Tr} key=${index} opacity=${play.noise ? 0.5 : 1}>
                  <${Chakra.Td} fontSize="xs" whiteSpace="nowrap">${formatDateTime(play.playedAtUtc)}<//>
                  <${Chakra.Td} fontSize="sm">
                    <${Chakra.HStack} spacing="2">
                      ${play.artworkUrl ? html`<${Chakra.Image} src=${play.artworkUrl} boxSize="28px" borderRadius="6px" objectFit="cover" />` : null}
                      <span>${play.artistRaw}</span>
                    <//>
                  <//>
                  <${Chakra.Td} fontSize="sm">${play.titleRaw}<//>
                  <${Chakra.Td}>
                    ${play.noise
                      ? html`<${Chakra.Badge} colorScheme="orange">Wird gefiltert<//>`
                      : play.deezerId
                        ? html`<${Chakra.Tooltip} label=${`Deezer-ID ${play.deezerId}${play.isrc ? ` · ISRC ${play.isrc}` : ''}`}><${Chakra.Badge} colorScheme="green">Deezer<//><//>`
                        : play.isrc ? html`<${Chakra.Badge} colorScheme="green">ISRC<//>` : null}
                  <//>
                <//>
              `)}
            <//>
          <//>
        <//>
      ` : null}
    <//>
  `;
}

function StationEditor({ isOpen, onClose, initial, settings, onSaved }) {
  const isEdit = Boolean(initial?.configured);
  const [form, setForm] = React.useState(emptyForm());
  const [testResult, setTestResult] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState('');
  const toast = Chakra.useToast();

  React.useEffect(() => {
    if (!isOpen) return;
    setForm(initial ? formFromStation(initial) : emptyForm());
    setTestResult(null);
    setFormError('');
  }, [isOpen, initial]);

  const update = (patch) => setForm((prev) => {
    const next = { ...prev, ...patch };
    if ('name' in patch && !prev.idTouched && !isEdit) next.id = slugify(patch.name);
    return next;
  });
  const setJson = (patch) => setForm((prev) => ({ ...prev, json: { ...prev.json, ...patch } }));

  const defaultRefresh = form.sourceType === 'lautfm' ? settings?.lautfm_refresh_minutes : settings?.default_refresh_minutes;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { id: _id, name: _name, enabled: _enabled, ...config } = configFromForm(form);
      setTestResult(await apiSend('/api/admin/stations/test', 'POST', config));
    } catch (error) {
      setTestResult({ ok: false, error: errorText(error), plays: [] });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setFormError('');
    try {
      const config = configFromForm(form);
      const saved = isEdit
        ? await apiSend(`/api/admin/stations/${encodeURIComponent(config.id)}`, 'PUT', config)
        : await apiSend('/api/admin/stations', 'POST', config);
      toast({ status: 'success', title: isEdit ? 'Sender gespeichert' : 'Sender angelegt', description: isEdit ? saved.name : `${saved.name} wird jetzt abgerufen.` });
      onSaved();
      onClose();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (key) => {
    const preset = JSON_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    update({ playlist_url: preset.url, json: { ...preset.json }, ...(preset.lookback ? { lookback_minutes: preset.lookback } : {}) });
  };

  return html`
    <${Chakra.Modal} isOpen=${isOpen} onClose=${onClose} size="4xl" scrollBehavior="inside">
      <${Chakra.ModalOverlay} backdropFilter="blur(4px)" />
      <${Chakra.ModalContent} borderRadius="24px" bg="cardBg">
        <${Chakra.ModalHeader}>
          ${isEdit ? `Sender bearbeiten: ${form.name}` : 'Neuen Sender hinzufügen'}
          <${Chakra.Text} fontSize="sm" fontWeight="400" color="textMuted">Quelle wählen, testen, speichern – der Abruf startet automatisch.<//>
        <//>
        <${Chakra.ModalCloseButton} />
        <${Chakra.ModalBody}>
          <${Chakra.VStack} align="stretch" spacing="6">
            <${Chakra.Box}>
              <${Chakra.Text} fontSize="xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.1em" color="textMuted" mb="2">1 · Quelle<//>
              <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="2">
                ${SOURCE_TYPES.map((type) => html`
                  <${Chakra.Box}
                    key=${type.key}
                    as="button"
                    type="button"
                    textAlign="left"
                    p="3"
                    borderRadius="14px"
                    border="2px solid"
                    borderColor=${form.sourceType === type.key ? 'brand.400' : 'lineColor'}
                    bg=${form.sourceType === type.key ? 'rgba(6, 182, 212, 0.08)' : 'transparent'}
                    _hover=${{ borderColor: 'brand.300' }}
                    onClick=${() => update({ sourceType: type.key, parser: type.key === 'html' ? 'generic_html_or_onlineradiobox' : parserForForm({ sourceType: type.key }) })}
                  >
                    <${Chakra.Text} fontWeight="700" fontSize="sm">${type.label}<//>
                    <${Chakra.Text} fontSize="xs" color="textMuted" mt="1">${type.description}<//>
                  <//>
                `)}
              <//>
            <//>

            <${Chakra.Box}>
              <${Chakra.Text} fontSize="xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.1em" color="textMuted" mb="2">2 · Verbindung<//>
              <${Chakra.VStack} align="stretch" spacing="3">
                ${form.sourceType === 'onlineradiobox' ? html`
                  <${OnlineradioboxSearch} onPick=${(r) => update({ name: form.name || r.name, playlist_url: r.playlistUrl, ...(isEdit || form.idTouched ? {} : { id: slugify(r.name) }) })} />
                ` : null}
                ${form.sourceType === 'lautfm' ? html`
                  <${LautfmLookup}
                    initialName=${(form.playlist_url.match(/station\/([^/]+)\//) || [])[1] || ''}
                    onFound=${(info) => update({ name: form.name || info.displayName, playlist_url: info.playlistUrl, ...(isEdit || form.idTouched ? {} : { id: slugify(info.name) }) })}
                  />
                ` : null}
                ${form.sourceType === 'json' ? html`
                  <${Field} label="Vorlage">
                    <${Chakra.Select} size="sm" placeholder="Vorlage wählen (optional)" onChange=${(e) => applyPreset(e.target.value)} value="">
                      ${JSON_PRESETS.map((p) => html`<option key=${p.key} value=${p.key}>${p.label}</option>`)}
                    <//>
                  <//>
                ` : null}
                ${form.sourceType === 'html' ? html`
                  <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="3">
                    <${Field} label="Parser">
                      <${Chakra.Select} size="sm" value=${form.parser} onChange=${(e) => update({ parser: e.target.value })}>
                        ${HTML_PARSERS.map(([value, label]) => html`<option key=${value} value=${value}>${label}</option>`)}
                      <//>
                    <//>
                    <${Field} label="Abruf" help="Playwright rendert JavaScript-Seiten (nur lokal mit installiertem Playwright)">
                      <${Chakra.Select} size="sm" value=${form.fetcher} onChange=${(e) => update({ fetcher: e.target.value })}>
                        <option value="http">HTTP</option>
                        <option value="playwright">Playwright</option>
                      <//>
                    <//>
                  <//>
                ` : null}
                <${Field}
                  label="Playlist-URL"
                  isRequired
                  help=${form.sourceType === 'json' || form.sourceType === 'html'
                    ? html`<span>Platzhalter für Zeitfenster-APIs: <code>{from:yyyy-MM-dd HH:mm:ss}</code>, <code>{to:yyyy-MM-dd HH:mm:ss}</code>, <code>{from_iso}</code>, <code>{to_unix}</code>. Für „letzte N Titel“-APIs: <code>{limit:200}</code> – so viele Titel wie seit dem letzten Abruf nötig, höchstens 200. Das Fenster umfasst die Rückschau und holt nach einem Ausfall bis zu 48 h nach.</span>`
                    : null}
                >
                  <${Chakra.Input} size="sm" fontFamily="mono" value=${form.playlist_url} onChange=${(e) => update({ playlist_url: e.target.value })} placeholder="https://…" />
                <//>
                ${form.sourceType === 'json' ? html`<${JsonMappingFields} form=${form} setJson=${setJson} />` : null}
                <${Chakra.HStack}>
                  <${Chakra.Button} size="sm" leftIcon=${html`<${AppIcons.Zap} />`} onClick=${runTest} isLoading=${testing} isDisabled=${!form.playlist_url} variant="outline" colorScheme="brand">
                    Quelle testen
                  <//>
                  <${Chakra.Text} fontSize="xs" color="textMuted">Ruft die Quelle einmal ab und zeigt die erkannten Titel – es wird nichts gespeichert.<//>
                <//>
                <${TestResult} result=${testResult} />
              <//>
            <//>

            <${Chakra.Box}>
              <${Chakra.Text} fontSize="xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.1em" color="textMuted" mb="2">3 · Sender<//>
              <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="3">
                <${Field} label="Name" isRequired>
                  <${Chakra.Input} size="sm" value=${form.name} onChange=${(e) => update({ name: e.target.value })} placeholder="z. B. Radio Neandertal" />
                <//>
                <${Field} label="ID" isRequired help=${isEdit ? 'Die ID kann nicht geändert werden.' : 'Wird aus dem Namen erzeugt; nur a–z, 0–9, _ und -'}>
                  <${Chakra.Input} size="sm" fontFamily="mono" value=${form.id} isDisabled=${isEdit} onChange=${(e) => setForm((prev) => ({ ...prev, id: e.target.value, idTouched: true }))} />
                <//>
                <${Field} label="Zeitzone">
                  <${Chakra.Select} size="sm" value=${form.timezone} onChange=${(e) => update({ timezone: e.target.value })}>
                    ${[...new Set([form.timezone, ...TIMEZONES])].map((tz) => html`<option key=${tz} value=${tz}>${tz}</option>`)}
                  <//>
                <//>
                <${Field} label="Abruf-Intervall" help=${form.refresh_mode === 'default' ? `Standard: alle ${defaultRefresh ?? '–'} Minuten (Einstellungen)` : 'Eigener Wert überschreibt den Standard'}>
                  <${Chakra.HStack}>
                    <${Chakra.Select} size="sm" w="150px" value=${form.refresh_mode} onChange=${(e) => update({ refresh_mode: e.target.value })}>
                      <option value="default">Standard</option>
                      <option value="custom">Eigener Wert</option>
                    <//>
                    ${form.refresh_mode === 'custom' ? html`
                      <${Chakra.NumberInput} size="sm" min=${1} max=${1440} value=${form.refresh_minutes} onChange=${(_s, n) => update({ refresh_minutes: Number.isFinite(n) ? n : '' })}>
                        <${Chakra.NumberInputField} />
                      <//>
                      <${Chakra.Text} fontSize="sm" color="textMuted">min<//>
                    ` : null}
                  <//>
                <//>
                <${Chakra.HStack} spacing="6" pt="2">
                  <${Chakra.FormControl} display="flex" alignItems="center" w="auto">
                    <${Chakra.Switch} id="enabled" colorScheme="brand" isChecked=${form.enabled} onChange=${(e) => update({ enabled: e.target.checked })} />
                    <${Chakra.FormLabel} htmlFor="enabled" mb="0" ml="2" fontSize="sm">Aktiv<//>
                  <//>
                  <${Chakra.FormControl} display="flex" alignItems="center" w="auto">
                    <${Chakra.Switch} id="mystation" colorScheme="brand" isChecked=${form.my_station} onChange=${(e) => update({ my_station: e.target.checked })} />
                    <${Chakra.FormLabel} htmlFor="mystation" mb="0" ml="2" fontSize="sm">Mein Sender<//>
                  <//>
                <//>
              <//>
            <//>

            <${Chakra.Accordion} allowToggle>
              <${Chakra.AccordionItem} border="1px solid" borderColor="lineColor" borderRadius="14px">
                <${Chakra.AccordionButton} borderRadius="14px">
                  <${Chakra.Box} flex="1" textAlign="left" fontWeight="600" fontSize="sm">Erweitert: Fallback-URLs, Dubletten, Coverage<//>
                  <${Chakra.AccordionIcon} />
                <//>
                <${Chakra.AccordionPanel}>
                  <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="3">
                    <${Chakra.GridItem} colSpan=${{ base: 1, md: 2 }}>
                      <${Field} label="Fallback-URLs" help="Eine URL pro Zeile; werden der Reihe nach probiert, wenn die Haupt-URL nichts liefert.">
                        <${Chakra.Textarea} size="sm" fontFamily="mono" rows=${3} value=${form.fallback_urls_text} onChange=${(e) => update({ fallback_urls_text: e.target.value })} />
                      <//>
                    <//>
                    <${Field} label="Rückschau für Zeitfenster (Minuten)" help="Nur für URLs mit {from}/{to}; Standard 180">
                      <${Chakra.Input} size="sm" type="number" value=${form.lookback_minutes} onChange=${(e) => update({ lookback_minutes: e.target.value })} placeholder="180" />
                    <//>
                    <${Field} label="Mindestabstand zwischen Plays (Sekunden)" help="0 = aus. Gegen doppelte Einträge mancher Quellen.">
                      <${Chakra.Input} size="sm" type="number" value=${form.min_play_gap_seconds} onChange=${(e) => update({ min_play_gap_seconds: e.target.value })} />
                    <//>
                    <${Field} label="Coverage: Stunden pro Tag">
                      <${Chakra.Input} size="sm" type="number" value=${form.min_daily_hours} onChange=${(e) => update({ min_daily_hours: e.target.value })} />
                    <//>
                    <${Field} label="Coverage: Plays pro Tag">
                      <${Chakra.Input} size="sm" type="number" value=${form.min_daily_plays} onChange=${(e) => update({ min_daily_plays: e.target.value })} />
                    <//>
                    <${Chakra.FormControl} display="flex" alignItems="center">
                      <${Chakra.Switch} id="oneperminute" colorScheme="brand" isChecked=${form.enforce_one_play_per_minute} onChange=${(e) => update({ enforce_one_play_per_minute: e.target.checked })} />
                      <${Chakra.FormLabel} htmlFor="oneperminute" mb="0" ml="2" fontSize="sm">Höchstens ein Play pro Minute<//>
                    <//>
                  <//>
                <//>
              <//>
            <//>
            ${formError ? html`<${Chakra.Alert} status="error" borderRadius="12px"><${Chakra.AlertIcon} />${formError}<//>` : null}
          <//>
        <//>
        <${Chakra.ModalFooter} gap="2">
          <${Chakra.Button} variant="ghost" onClick=${onClose}>Abbrechen<//>
          <${Chakra.Button} colorScheme="brand" onClick=${save} isLoading=${saving} isDisabled=${!form.name || !form.id || !form.playlist_url}>
            ${isEdit ? 'Speichern' : 'Sender anlegen'}
          <//>
        <//>
      <//>
    <//>
  `;
}

function DeleteStationDialog({ station, onClose, onDeleted }) {
  const [deleting, setDeleting] = React.useState(false);
  const toastError = useToastError();
  const remove = async (deleteData) => {
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/stations/${encodeURIComponent(station.id)}${deleteData ? '?deleteData=1' : ''}`, { method: 'DELETE' });
      onDeleted();
      onClose();
    } catch (error) {
      toastError('Löschen fehlgeschlagen', error);
    } finally {
      setDeleting(false);
    }
  };
  return html`
    <${Chakra.Modal} isOpen=${Boolean(station)} onClose=${onClose} isCentered>
      <${Chakra.ModalOverlay} />
      <${Chakra.ModalContent} borderRadius="20px" bg="cardBg">
        <${Chakra.ModalHeader}>„${station?.name}“ entfernen<//>
        <${Chakra.ModalBody}>
          <${Chakra.Text} fontSize="sm" color="textMuted">
            Der Sender hat ${formatNumber(station?.plays || 0)} gespeicherte Plays. Du kannst nur die Konfiguration entfernen (die Daten bleiben in den Statistiken) oder den Sender mit allen Daten löschen.
          <//>
        <//>
        <${Chakra.ModalFooter} gap="2" flexWrap="wrap">
          <${Chakra.Button} variant="ghost" onClick=${onClose}>Abbrechen<//>
          <${Chakra.Button} variant="outline" onClick=${() => remove(false)} isLoading=${deleting}>Nur Konfiguration<//>
          <${Chakra.Button} colorScheme="red" onClick=${() => remove(true)} isLoading=${deleting}>Mit allen Daten löschen<//>
        <//>
      <//>
    <//>
  `;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function JobBadge({ status }) {
  const meta = JOB_STATUS[status] || { label: status, scheme: 'gray' };
  return html`<${Chakra.Badge} colorScheme=${meta.scheme} className=${status === 'running' ? 'rv-pulse' : undefined}>${meta.label}<//>`;
}

function RunningJobs({ jobs }) {
  const items = [...(jobs?.running || []), ...(jobs?.queued || [])];
  if (!items.length) {
    return html`<${Chakra.Text} fontSize="sm" color="textMuted">Gerade läuft nichts. Der Zeitplan prüft jede Minute, welche Sender fällig sind.<//>`;
  }
  return html`
    <${Chakra.VStack} align="stretch" spacing="2">
      ${items.map((job) => html`
        <${Chakra.HStack} key=${job.id} spacing="3" p="3" borderRadius="14px" bg="subtleBg">
          ${job.status === 'running' ? html`<${Chakra.Spinner} size="sm" color="brand.400" />` : html`<${AppIcons.Clock} color="textMuted" />`}
          <${Chakra.Box} flex="1" minW="0">
            <${Chakra.Text} fontSize="sm" fontWeight="700" noOfLines=${1}>${job.label}<//>
            <${Chakra.Text} fontSize="xs" color="textMuted" noOfLines=${1}>
              ${job.status === 'running'
                ? `Schritt ${job.stepIndex}/${job.stepCount || '?'}: ${job.step || '…'} · ${sinceText(job.startedAt)}`
                : `wartet · ${sinceText(job.queuedAt)}`}
              ${job.stationIds?.length > 1 ? ` · ${job.stationIds.join(', ')}` : ''}
            <//>
          <//>
          <${Chakra.Badge} variant="outline" colorScheme=${job.lane.startsWith('ingest') ? 'brand' : 'purple'}>${LANE_LABELS[job.lane] || job.lane}<//>
          <${JobBadge} status=${job.status} />
        <//>
      `)}
    <//>
  `;
}

const STATUS_RANK = { error: 0, empty: 1, never: 2, ok: 3 };

// Sort accessors for the status table; null = keep the custom station order.
const STATUS_SORTS = {
  name: (row) => row.name.toLocaleLowerCase('de'),
  status: (row) => (row.configured && row.enabled ? STATUS_RANK[row.status?.last_status || 'never'] ?? 2 : 9),
  last: (row) => row.status?.last_finished_at_utc || '',
  found: (row) => Number(row.status?.last_plays_inserted ?? -1),
  next: (row) => (row.enabled ? row.nextDueAtUtc || '' : '~'),
  plays: (row) => Number(row.plays || 0),
  plays24h: (row) => Number(row.plays24h || 0)
};

function SortableTh({ label, sortKey, sort, onSort, isNumeric }) {
  const active = sort.key === sortKey;
  return html`
    <${Chakra.Th} py="3" isNumeric=${isNumeric} cursor="pointer" userSelect="none" onClick=${() => onSort(sortKey)} _hover=${{ color: 'accent' }} color=${active ? 'accent' : undefined}>
      ${label}${active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    <//>
  `;
}

function StationStatusTable({ stations, onRun, compact = false }) {
  // Click a header to sort; clicking it a third time returns to the custom order.
  const [sort, setSort] = React.useState({ key: null, dir: 'asc' });
  const onSort = (key) => setSort((prev) => {
    if (prev.key !== key) return { key, dir: key === 'name' || key === 'next' ? 'asc' : 'desc' };
    const firstDir = key === 'name' || key === 'next' ? 'asc' : 'desc';
    return prev.dir === firstDir ? { key, dir: firstDir === 'asc' ? 'desc' : 'asc' } : { key: null, dir: 'asc' };
  });
  const rows = React.useMemo(() => {
    if (!sort.key) return stations;
    const get = STATUS_SORTS[sort.key];
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...stations].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      return 0;
    });
  }, [stations, sort]);
  const th = (label, key, isNumeric) => html`<${SortableTh} label=${label} sortKey=${key} sort=${sort} onSort=${onSort} isNumeric=${isNumeric} />`;

  return html`
    <${Chakra.TableContainer} className="horizon-scroll">
      <${Chakra.Table} size="sm">
        <${Chakra.Thead} bg="subtleBg">
          <${Chakra.Tr}>
            ${th('Sender', 'name')}
            ${th('Status', 'status')}
            ${th('Letzter Abruf', 'last')}
            ${th('Gefunden / neu', 'found', true)}
            ${th('Intervall · nächster', 'next')}
            ${th('Plays gesamt', 'plays', true)}
            ${th('24 h', 'plays24h', true)}
            ${compact ? null : html`
              <${Chakra.Th} py="3" textAlign="right">
                ${sort.key ? html`<${Chakra.Button} size="xs" variant="link" colorScheme="brand" onClick=${() => setSort({ key: null, dir: 'asc' })}>Eigene Reihenfolge<//>` : null}
              <//>
            `}
          <//>
        <//>
        <${Chakra.Tbody}>
          ${rows.map((row) => {
            const state = stationState(row);
            const status = row.status;
            return html`
              <${Chakra.Tr} key=${row.id} opacity=${row.configured && !row.enabled ? 0.6 : 1}>
                <${Chakra.Td} py="2.5">
                  <${Chakra.HStack} spacing="2">
                    <${Chakra.Text} fontWeight="700" fontSize="sm" noOfLines=${1}>${row.name}<//>
                    ${row.config?.my_station ? html`<${Chakra.Tooltip} label="Mein Sender"><span><${Icons.StarIcon} color="yellow.400" boxSize="3" /></span><//>` : null}
                  <//>
                  <${Chakra.HStack} spacing="1" mt="1">
                    <${SourceBadge} type=${row.sourceType} />
                    ${row.timeWindow ? html`<${Chakra.Badge} variant="outline" fontSize="10px">Zeitfenster<//>` : null}
                  <//>
                <//>
                <${Chakra.Td} py="2.5">
                  <${Chakra.Tooltip} label=${status?.last_error || null} isDisabled=${!status?.last_error} hasArrow maxW="420px">
                    <span><${Chakra.Badge} colorScheme=${state.scheme} className=${state.pulse ? 'rv-pulse' : undefined}>${state.label}<//></span>
                  <//>
                <//>
                <${Chakra.Td} py="2.5" fontSize="sm">
                  <${Chakra.Tooltip} label=${status?.last_finished_at_utc ? formatDateTime(status.last_finished_at_utc) : null}>
                    <span>${formatRelative(status?.last_finished_at_utc)}</span>
                  <//>
                  ${status?.last_duration_ms ? html`<${Chakra.Text} fontSize="xs" color="textMuted">${durationText(status.last_duration_ms)}<//>` : null}
                <//>
                <${Chakra.Td} py="2.5" isNumeric fontSize="sm">
                  ${status?.last_status === 'ok' ? html`${formatNumber(status.last_plays_found)} / <b>${formatNumber(status.last_plays_inserted)}</b>` : '–'}
                <//>
                <${Chakra.Td} py="2.5" fontSize="sm">
                  ${row.refreshMinutes ? html`
                    <${Chakra.Text}>${row.refreshMinutes} min${row.refreshOverridden ? ' (eigener Wert)' : ''}<//>
                    <${Chakra.Text} fontSize="xs" color="textMuted">${row.enabled ? (row.running || row.queued ? 'jetzt' : formatRelative(row.nextDueAtUtc)) : 'pausiert'}<//>
                  ` : '–'}
                <//>
                <${Chakra.Td} py="2.5" isNumeric fontWeight="700">${formatNumber(row.plays)}<//>
                <${Chakra.Td} py="2.5" isNumeric fontSize="sm">${formatNumber(row.plays24h)}<//>
                ${compact ? null : html`
                  <${Chakra.Td} py="2.5" textAlign="right">
                    ${row.configured ? html`
                      <${Chakra.Button} size="xs" variant="ghost" colorScheme="brand" leftIcon=${html`<${Icons.RepeatIcon} />`} onClick=${() => onRun(row)} isDisabled=${row.running || row.queued}>
                        Abrufen
                      <//>
                    ` : null}
                  <//>
                `}
              <//>
            `;
          })}
        <//>
      <//>
    <//>
  `;
}

function OverviewTab({ data, onRunStation }) {
  const db = data.db;
  const stations = data.stations;
  const configured = stations.filter((s) => s.configured);
  const active = configured.filter((s) => s.enabled);
  const failing = active.filter((s) => s.status?.last_status === 'error');
  return html`
    <${Chakra.VStack} align="stretch" spacing="6">
      <${Chakra.SimpleGrid} columns=${{ base: 2, xl: 4 }} spacing=${{ base: "3", md: "4" }}>
        <${StatTile} accent label="Plays in der Datenbank" value=${formatNumber(db.plays)} icon=${AppIcons.Activity} hint=${`${formatNumber(db.growth.playsLast7d)} in den letzten 7 Tagen`} />
        <${StatTile} label="Verschiedene Titel" value=${formatNumber(db.tracks)} icon=${AppIcons.Music} hint=${db.oldestPlayUtc ? `seit ${formatDate(db.oldestPlayUtc)}` : 'noch keine Daten'} />
        <${StatTile} label="Sender aktiv" value=${`${active.length} / ${configured.length}`} icon=${AppIcons.Radio} hint=${failing.length ? `${failing.length} mit Fehler` : 'alle ohne Fehler'} />
        <${StatTile} label="Datenbank" value=${formatBytes(db.totalBytes)} icon=${AppIcons.Database} hint=${db.growth.bytesPerMonth ? `≈ +${formatBytes(db.growth.bytesPerMonth)} pro Monat` : 'Wachstum wird ermittelt'} />
      <//>
      <${PanelCard} title="Jobs" subtitle="Laufende und wartende Hintergrund-Jobs" icon=${AppIcons.Zap}>
        <${RunningJobs} jobs=${data.jobs} />
      <//>
      <${PanelCard} title="Sender-Status" subtitle="Wann wurde welcher Sender zuletzt ausgelesen und wie viele Daten kamen dabei heraus" icon=${AppIcons.Radio} p="0">
        <${StationStatusTable} stations=${stations} onRun=${onRunStation} />
      <//>
    <//>
  `;
}

function StationsTab({ data, reload, onRunStation }) {
  const [editing, setEditing] = React.useState(null);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(null);
  const [importing, setImporting] = React.useState(false);
  const [pendingOrder, setPendingOrder] = React.useState(null);
  const [dragId, setDragId] = React.useState(null);
  const [overId, setOverId] = React.useState(null);
  const toast = Chakra.useToast();
  const toastError = useToastError();

  // Show the new order immediately; the server copy arrives with the next reload.
  const rows = React.useMemo(() => {
    if (!pendingOrder) return data.stations;
    const byId = new Map(data.stations.map((row) => [row.id, row]));
    const ordered = pendingOrder.map((id) => byId.get(id)).filter(Boolean);
    return [...ordered, ...data.stations.filter((row) => !pendingOrder.includes(row.id))];
  }, [data.stations, pendingOrder]);

  const saveOrder = async (ids) => {
    setPendingOrder(ids);
    try {
      await apiSend('/api/admin/stations/order', 'PUT', { ids });
      await reload();
    } catch (error) {
      toastError('Reihenfolge nicht gespeichert', error);
    } finally {
      setPendingOrder(null);
    }
  };

  const move = (index, delta) => {
    const ids = rows.map((row) => row.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    saveOrder(ids);
  };

  const dropOn = (targetId) => {
    if (!dragId || dragId === targetId) return;
    const ids = rows.map((row) => row.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    saveOrder(ids);
  };

  const sortAlphabetically = () => {
    saveOrder([...rows].sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })).map((row) => row.id));
  };

  const openEditor = (row) => {
    setEditing(row);
    setEditorOpen(true);
  };

  const toggle = async (row, enabled) => {
    try {
      await apiSend(`/api/admin/stations/${encodeURIComponent(row.id)}/enabled`, 'PATCH', { enabled });
      reload();
    } catch (error) {
      toastError('Änderung fehlgeschlagen', error);
    }
  };

  const importConfig = async () => {
    setImporting(true);
    try {
      const result = await apiSend('/api/admin/stations/import-config', 'POST');
      toast({
        status: 'success',
        title: 'Abgleich abgeschlossen',
        description: `${result.imported} neu, ${result.updated} aktualisiert, ${result.unchanged} unverändert${result.keptAdminChanges ? `, ${result.keptAdminChanges} mit Admin-Änderungen beibehalten` : ''}`
      });
      reload();
    } catch (error) {
      toastError('Import fehlgeschlagen', error);
    } finally {
      setImporting(false);
    }
  };

  return html`
    <${Chakra.VStack} align="stretch" spacing="6">
      <${PanelCard}
        title="Sender"
        subtitle="Quellen direkt im Browser verwalten. Die Reihenfolge (ziehen oder Pfeile) gilt für alle Sender-Auswahllisten."
        icon=${AppIcons.Radio}
        p="0"
        right=${html`
          <${Chakra.HStack} pr="5" pt="5">
            <${Chakra.Tooltip} label="Reihenfolge alphabetisch nach Namen setzen">
              <${Chakra.Button} size="sm" variant="ghost" onClick=${sortAlphabetically} isDisabled=${Boolean(pendingOrder)}>A–Z<//>
            <//>
            <${Chakra.Tooltip} label="Neue und geänderte Einträge aus config.yaml übernehmen (passiert auch bei jedem Start). Im Admin bearbeitete oder gelöschte Sender bleiben unverändert.">
              <${Chakra.Button} size="sm" variant="ghost" onClick=${importConfig} isLoading=${importing}>config.yaml abgleichen<//>
            <//>
            <${Chakra.Button} size="sm" colorScheme="brand" leftIcon=${html`<${AppIcons.Plus} />`} onClick=${() => openEditor(null)}>Sender hinzufügen<//>
          <//>
        `}
      >
        <${Chakra.TableContainer} className="horizon-scroll">
          <${Chakra.Table} size="sm">
            <${Chakra.Thead} bg="subtleBg">
              <${Chakra.Tr}>
                <${Chakra.Th} py="3" w="1%">Reihenfolge<//>
                <${Chakra.Th} py="3">Aktiv<//>
                <${Chakra.Th} py="3">Sender<//>
                <${Chakra.Th} py="3">Quelle<//>
                <${Chakra.Th} py="3">Intervall<//>
                <${Chakra.Th} py="3" isNumeric>Plays<//>
                <${Chakra.Th} py="3" textAlign="right">Aktionen<//>
              <//>
            <//>
            <${Chakra.Tbody}>
              ${rows.map((row, index) => html`
                <${Chakra.Tr}
                  key=${row.id}
                  draggable
                  onDragStart=${(event) => {
                    setDragId(row.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', row.id);
                  }}
                  onDragOver=${(event) => {
                    event.preventDefault();
                    if (overId !== row.id) setOverId(row.id);
                  }}
                  onDrop=${(event) => {
                    event.preventDefault();
                    dropOn(row.id);
                    setDragId(null);
                    setOverId(null);
                  }}
                  onDragEnd=${() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  opacity=${dragId === row.id ? 0.4 : 1}
                  boxShadow=${dragId && overId === row.id && dragId !== row.id ? 'inset 0 2px 0 0 #06b6d4' : undefined}
                >
                  <${Chakra.Td} py="2.5">
                    <${Chakra.HStack} spacing="1">
                      <${Chakra.Tooltip} label="Ziehen zum Verschieben" openDelay=${500}>
                        <span style=${{ cursor: 'grab', display: 'inline-flex' }}><${Icons.DragHandleIcon} color="textMuted" /></span>
                      <//>
                      <${Chakra.Text} fontSize="xs" color="textMuted" w="18px" textAlign="right">${index + 1}<//>
                      <${Chakra.IconButton} size="xs" variant="ghost" aria-label="Nach oben" icon=${html`<${Icons.ChevronUpIcon} />`} isDisabled=${index === 0 || Boolean(pendingOrder)} onClick=${() => move(index, -1)} />
                      <${Chakra.IconButton} size="xs" variant="ghost" aria-label="Nach unten" icon=${html`<${Icons.ChevronDownIcon} />`} isDisabled=${index === rows.length - 1 || Boolean(pendingOrder)} onClick=${() => move(index, 1)} />
                    <//>
                  <//>
                  <${Chakra.Td} py="2.5">
                    ${row.configured
                      ? html`<${Chakra.Switch} colorScheme="brand" isChecked=${row.enabled} onChange=${(e) => toggle(row, e.target.checked)} />`
                      : html`<${Chakra.Badge}>ohne Konfig.<//>`}
                  <//>
                  <${Chakra.Td} py="2.5">
                    <${Chakra.HStack} spacing="2">
                      <${Chakra.Text} fontWeight="700" fontSize="sm">${row.name}<//>
                      ${row.config?.my_station ? html`<${Chakra.Badge} colorScheme="yellow">Mein Sender<//>` : null}
                    <//>
                    <${Chakra.Text} fontSize="xs" color="textMuted" fontFamily="mono">${row.id}<//>
                  <//>
                  <${Chakra.Td} py="2.5" maxW="380px">
                    <${SourceBadge} type=${row.sourceType} />
                    <${Chakra.Text} fontSize="xs" color="textMuted" fontFamily="mono" noOfLines=${1} title=${row.config?.playlist_url}>${row.config?.playlist_url || '–'}<//>
                  <//>
                  <${Chakra.Td} py="2.5" fontSize="sm">${row.refreshMinutes ? `${row.refreshMinutes} min` : '–'}${row.refreshOverridden ? html` <${Chakra.Badge} variant="outline" fontSize="9px">eigen<//>` : null}<//>
                  <${Chakra.Td} py="2.5" isNumeric fontWeight="700">${formatNumber(row.plays)}<//>
                  <${Chakra.Td} py="2.5">
                    <${Chakra.HStack} spacing="1" justify="flex-end">
                      ${row.configured ? html`
                        <${Chakra.Tooltip} label="Jetzt abrufen">
                          <${Chakra.IconButton} size="sm" variant="ghost" aria-label="Jetzt abrufen" icon=${html`<${Icons.RepeatIcon} />`} onClick=${() => onRunStation(row)} isDisabled=${row.running || row.queued} />
                        <//>
                      ` : null}
                      <${Chakra.Tooltip} label=${row.configured ? 'Bearbeiten' : 'Konfigurieren'}>
                        <${Chakra.IconButton} size="sm" variant="ghost" aria-label="Bearbeiten" icon=${html`<${Icons.EditIcon} />`} onClick=${() => openEditor(row)} />
                      <//>
                      <${Chakra.Tooltip} label="Entfernen">
                        <${Chakra.IconButton} size="sm" variant="ghost" colorScheme="red" aria-label="Entfernen" icon=${html`<${Icons.DeleteIcon} />`} onClick=${() => setDeleting(row)} />
                      <//>
                    <//>
                  <//>
                <//>
              `)}
            <//>
          <//>
        <//>
      <//>
      <${StationEditor} isOpen=${editorOpen} onClose=${() => setEditorOpen(false)} initial=${editing} settings=${data.settings} onSaved=${reload} />
      <${DeleteStationDialog} station=${deleting} onClose=${() => setDeleting(null)} onDeleted=${reload} />
    <//>
  `;
}

const SCHEDULE_LABELS = {
  dueCheck: ['Fällige Sender prüfen', 'jede Minute – ruft Sender ab, deren Intervall abgelaufen ist'],
  maintenance: ['Wartung + Tagesauswertung', 'stündlich – Dubletten, Schreibweisen, Release-Daten, Statistik'],
  daily: ['Coverage-Audit + Wochenreport', 'täglich 04:20 Uhr']
};

function JobsTab({ data, reload }) {
  const [busy, setBusy] = React.useState('');
  const toast = Chakra.useToast();
  const toastError = useToastError();
  const run = async (type, label) => {
    setBusy(type);
    try {
      const result = await apiSend(`/api/admin/jobs/${type}/run`, 'POST');
      toast({ status: result.skipped ? 'info' : 'success', title: result.skipped ? `${label} läuft bereits` : `${label} gestartet` });
      reload();
    } catch (error) {
      toastError(`${label} fehlgeschlagen`, error);
    } finally {
      setBusy('');
    }
  };
  const actions = [
    ['ingest-all', 'Alle Sender abrufen', AppIcons.Radio],
    ['maintenance', 'Wartung', AppIcons.Sliders],
    ['daily', 'Wochenreport', AppIcons.Report],
    ['deezer-backfill', 'Deezer-Abgleich', AppIcons.Disc]
  ];
  return html`
    <${Chakra.VStack} align="stretch" spacing="6">
      <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 2 }} spacing="6">
        <${PanelCard} title="Aktuell" subtitle="Abrufe, Schnellabrufe (≤ 15 min, z. B. laut.fm) und Wartung laufen in getrennten Spuren parallel" icon=${AppIcons.Activity}>
          <${RunningJobs} jobs=${data.jobs} />
        <//>
        <${PanelCard} title="Zeitplan" subtitle=${data.settings.scheduler_enabled ? 'Automatik aktiv' : 'Automatik pausiert (Einstellungen)'} icon=${AppIcons.Clock}>
          <${Chakra.VStack} align="stretch" spacing="3">
            ${Object.entries(SCHEDULE_LABELS).map(([key, [label, help]]) => html`
              <${Chakra.HStack} key=${key} justify="space-between" align="start">
                <${Chakra.Box}>
                  <${Chakra.Text} fontSize="sm" fontWeight="700">${label}<//>
                  <${Chakra.Text} fontSize="xs" color="textMuted">${help}<//>
                <//>
                <${Chakra.Text} fontSize="sm" color="textMuted" whiteSpace="nowrap">${data.schedules?.[key] ? formatRelative(data.schedules[key]) : '–'}<//>
              <//>
            `)}
          <//>
        <//>
      <//>
      <${PanelCard} title="Manuell starten" icon=${AppIcons.Zap}>
        <${Chakra.Wrap} spacing="3">
          ${actions.map(([type, label, icon]) => html`
            <${Chakra.Button} key=${type} leftIcon=${html`<${icon} />`} variant="outline" colorScheme="brand" onClick=${() => run(type, label)} isLoading=${busy === type}>${label}<//>
          `)}
        <//>
      <//>
      <${PanelCard} title="Verlauf" subtitle="Die letzten Jobs" icon=${AppIcons.Report} p="0">
        <${Chakra.TableContainer} className="horizon-scroll">
          <${Chakra.Table} size="sm">
            <${Chakra.Thead} bg="subtleBg">
              <${Chakra.Tr}>
                <${Chakra.Th} py="3">Job<//>
                <${Chakra.Th} py="3">Auslöser<//>
                <${Chakra.Th} py="3">Status<//>
                <${Chakra.Th} py="3">Gestartet<//>
                <${Chakra.Th} py="3" isNumeric>Dauer<//>
                <${Chakra.Th} py="3">Fehler<//>
              <//>
            <//>
            <${Chakra.Tbody}>
              ${(data.jobs?.recent || []).map((job) => html`
                <${Chakra.Tr} key=${job.id}>
                  <${Chakra.Td} py="2" fontSize="sm" fontWeight="600" maxW="320px"><${Chakra.Text} noOfLines=${1}>${job.label || job.name}<//><//>
                  <${Chakra.Td} py="2" fontSize="sm">${TRIGGER_LABELS[job.trigger] || job.trigger}<//>
                  <${Chakra.Td} py="2"><${JobBadge} status=${job.status} /><//>
                  <${Chakra.Td} py="2" fontSize="sm"><${Chakra.Tooltip} label=${formatDateTime(job.started_at_utc || job.queued_at_utc)}><span>${formatRelative(job.started_at_utc || job.queued_at_utc)}</span><//><//>
                  <${Chakra.Td} py="2" isNumeric fontSize="sm">${durationText(job.duration_ms)}<//>
                  <${Chakra.Td} py="2" fontSize="xs" color="red.400" maxW="320px"><${Chakra.Text} noOfLines=${2}>${job.error || ''}<//><//>
                <//>
              `)}
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

function SettingsTab({ data, reload }) {
  const [values, setValues] = React.useState(data.settings);
  const [saving, setSaving] = React.useState(false);
  const toast = Chakra.useToast();
  const toastError = useToastError();
  // The overview is polled every 5s; only reset the form when the stored settings actually change.
  const settingsKey = JSON.stringify(data.settings);
  const [noiseText, setNoiseText] = React.useState((data.settings.noise_terms || []).join('\n'));
  React.useEffect(() => {
    setValues(data.settings);
    setNoiseText((data.settings.noise_terms || []).join('\n'));
  }, [settingsKey]);

  const save = async () => {
    setSaving(true);
    try {
      const noiseTerms = String(noiseText).split('\n').map((term) => term.trim()).filter((term) => term.length >= 2);
      await apiSend('/api/admin/settings', 'PUT', { ...values, noise_terms: noiseTerms });
      toast({ status: 'success', title: 'Einstellungen gespeichert' });
      reload();
    } catch (error) {
      toastError('Speichern fehlgeschlagen', error);
    } finally {
      setSaving(false);
    }
  };

  const numberField = (key, min, max) => html`
    <${Chakra.NumberInput} size="sm" maxW="160px" min=${min} max=${max} value=${values[key]} onChange=${(_s, n) => setValues((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : prev[key] }))}>
      <${Chakra.NumberInputField} />
      <${Chakra.NumberInputStepper}><${Chakra.NumberIncrementStepper} /><${Chakra.NumberDecrementStepper} /><//>
    <//>
  `;

  return html`
    <${PanelCard} title="Aktualisierung" subtitle="Standardwerte für alle Sender. Jeder Sender kann sein Intervall in der Sender-Verwaltung überschreiben." icon=${AppIcons.Sliders}>
      <${Chakra.VStack} align="stretch" spacing="6" maxW="720px">
        <${Chakra.FormControl} display="flex" alignItems="center" justifyContent="space-between">
          <${Chakra.Box}>
            <${Chakra.FormLabel} mb="0" fontWeight="700">Automatische Abrufe<//>
            <${Chakra.Text} fontSize="sm" color="textMuted">Aus = keine geplanten Abrufe, Wartung oder Reports. Manuelle Starts funktionieren weiter.<//>
          <//>
          <${Chakra.Switch} size="lg" colorScheme="brand" isChecked=${values.scheduler_enabled} onChange=${(e) => setValues((prev) => ({ ...prev, scheduler_enabled: e.target.checked }))} />
        <//>
        <${Chakra.Divider} />
        <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="5">
          <${Field} label="Standard-Intervall (Minuten)" help="Gilt für alle Sender ohne eigenen Wert. Standard: 60">${numberField('default_refresh_minutes', 1, 1440)}<//>
          <${Field} label="laut.fm-Intervall (Minuten)" help="laut.fm hält nur die letzten 10 Titel vor. Standard: 5">${numberField('lautfm_refresh_minutes', 1, 1440)}<//>
          <${Field} label="Erfassung ab (Uhr, Ortszeit des Senders)" help="Plays davor werden nicht gespeichert.">${numberField('track_hour_start', 0, 23)}<//>
          <${Field} label="Erfassung bis (Uhr, einschließlich)" help="20 = bis 20:59 Uhr.">${numberField('track_hour_end', 0, 23)}<//>
        <//>
        <${Chakra.Divider} />
        <${Field}
          label="Immer ausfiltern"
          help="Ein Begriff pro Zeile. Einträge, deren Interpret oder Titel einen Begriff enthält, werden bei allen Sendern verworfen – unabhängig von Groß-/Kleinschreibung, Leerzeichen und Bindestrichen („RadioVelbert“ trifft auch „Radio Velbert“). Bereits gespeicherte Treffer entfernt die nächste Wartung."
        >
          <${Chakra.Textarea} size="sm" rows=${4} maxW="420px" fontFamily="mono" value=${noiseText} onChange=${(e) => setNoiseText(e.target.value)} placeholder="RadioVelbert" />
        <//>
        <${Chakra.HStack}>
          <${Chakra.Button} colorScheme="brand" onClick=${save} isLoading=${saving}>Speichern<//>
        <//>
      <//>
    <//>
  `;
}

function DatabaseTab({ data, reload }) {
  const db = data.db;
  const [scope, setScope] = React.useState('all');
  const [stationId, setStationId] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [clearing, setClearing] = React.useState(false);
  const toast = Chakra.useToast();
  const toastError = useToastError();
  const clearRunning = [...(data.jobs?.running || []), ...(data.jobs?.queued || [])].some((job) => job.name === 'clear-db');

  const clear = async () => {
    setClearing(true);
    try {
      await apiSend('/api/admin/db/clear', 'POST', { scope, stationId: scope === 'station' ? stationId : undefined, confirm });
      toast({ status: 'success', title: 'Löschen gestartet', description: 'Läuft als Job, sobald laufende Abrufe beendet sind.' });
      setConfirm('');
      reload(true);
    } catch (error) {
      toastError('Löschen fehlgeschlagen', error);
    } finally {
      setClearing(false);
    }
  };

  const maxTableBytes = Math.max(1, ...db.tables.map((t) => Number(t.bytes || 0)));
  return html`
    <${Chakra.VStack} align="stretch" spacing="6">
      <${Chakra.SimpleGrid} columns=${{ base: 2, xl: 4 }} spacing=${{ base: "3", md: "4" }}>
        <${StatTile} accent label="Größe auf der Platte" value=${formatBytes(db.totalBytes)} icon=${AppIcons.Database} hint=${`Datei ${formatBytes(db.files.db)} · WAL ${formatBytes(db.files.wal)}`} />
        <${StatTile} label="Plays" value=${formatNumber(db.plays)} icon=${AppIcons.Activity} hint=${db.growth.bytesPerPlay ? `≈ ${formatBytes(db.growth.bytesPerPlay)} pro Play inkl. Indizes` : null} />
        <${StatTile} label="Wachstum" value=${db.growth.bytesPerMonth ? `+${formatBytes(db.growth.bytesPerMonth)}` : '–'} icon=${AppIcons.Zap} hint=${db.growth.bytesPerYear ? `pro Monat · ≈ +${formatBytes(db.growth.bytesPerYear)} pro Jahr (${formatNumber(Math.round(db.growth.playsPerDay))} Plays/Tag)` : 'noch zu wenige Daten'} />
        <${StatTile} label="Zeitraum" value=${db.oldestPlayUtc ? formatDate(db.oldestPlayUtc) : '–'} icon=${AppIcons.Calendar} hint=${db.newestPlayUtc ? `bis ${formatDateTime(db.newestPlayUtc)}` : null} />
      <//>
      <${PanelCard} title="Tabellen" subtitle=${`Seitengröße ${formatBytes(db.pageSize)} · ${formatBytes(db.freeBytes)} frei (wird beim Leeren zurückgegeben)`} icon=${AppIcons.Database} p="0">
        <${Chakra.TableContainer}>
          <${Chakra.Table} size="sm">
            <${Chakra.Thead} bg="subtleBg"><${Chakra.Tr}><${Chakra.Th} py="3">Tabelle<//><${Chakra.Th} py="3" isNumeric>Einträge<//><${Chakra.Th} py="3">Speicher inkl. Indizes<//><//><//>
            <${Chakra.Tbody}>
              ${db.tables.map((table) => html`
                <${Chakra.Tr} key=${table.name}>
                  <${Chakra.Td} py="2"><${Chakra.Text} fontSize="sm" fontWeight="600">${table.label}<//><${Chakra.Text} fontSize="xs" color="textMuted" fontFamily="mono">${table.name}<//><//>
                  <${Chakra.Td} py="2" isNumeric fontWeight="700">${formatNumber(table.rows)}<//>
                  <${Chakra.Td} py="2" minW="220px">
                    ${table.bytes == null ? html`<${Chakra.Text} fontSize="xs" color="textMuted">–<//>` : html`
                      <${Chakra.HStack} spacing="3">
                        <${Chakra.Box} flex="1" h="6px" bg="subtleBg" borderRadius="full" overflow="hidden">
                          <${Chakra.Box} h="100%" w=${`${(Number(table.bytes) / maxTableBytes) * 100}%`} bg=${BRAND_GRADIENT} />
                        <//>
                        <${Chakra.Text} fontSize="xs" minW="70px" textAlign="right">${formatBytes(table.bytes)}<//>
                      <//>
                    `}
                  <//>
                <//>
              `)}
            <//>
          <//>
        <//>
      <//>
      <${PanelCard} title="Daten löschen" subtitle="Senderkonfiguration, Einstellungen, gesperrte Tracks und Job-Verlauf bleiben erhalten." icon=${Icons.WarningTwoIcon}>
        <${Chakra.VStack} align="stretch" spacing="4" maxW="720px">
          <${Chakra.RadioGroup} value=${scope} onChange=${setScope} colorScheme="red">
            <${Chakra.Stack} direction=${{ base: 'column', md: 'row' }} spacing="6">
              <${Chakra.Radio} value="all">Alle gesammelten Daten (Plays, Statistiken, Metadaten)<//>
              <${Chakra.Radio} value="station">Nur Daten eines Senders<//>
            <//>
          <//>
          ${scope === 'station' ? html`
            <${Chakra.Select} placeholder="Sender wählen" value=${stationId} onChange=${(e) => setStationId(e.target.value)} maxW="360px">
              ${data.stations.map((s) => html`<option key=${s.id} value=${s.id}>${s.name} (${formatNumber(s.plays)} Plays)</option>`)}
            <//>
          ` : null}
          <${Chakra.Alert} status="warning" borderRadius="14px" fontSize="sm">
            <${Chakra.AlertIcon} />
            Das lässt sich nicht rückgängig machen. Vorher ein Backup ziehen (siehe docs/coolify.md). Der Job wartet, bis laufende Abrufe beendet sind, und gibt den Speicher danach frei (VACUUM).
          <//>
          <${Field} label='Zur Bestätigung "LÖSCHEN" eingeben'>
            <${Chakra.Input} value=${confirm} onChange=${(e) => setConfirm(e.target.value)} maxW="240px" placeholder="LÖSCHEN" />
          <//>
          <${Chakra.HStack}>
            <${Chakra.Button}
              colorScheme="red"
              leftIcon=${html`<${Icons.DeleteIcon} />`}
              onClick=${clear}
              isLoading=${clearing || clearRunning}
              loadingText=${clearRunning ? 'Löschen läuft' : undefined}
              isDisabled=${confirm !== 'LÖSCHEN' || (scope === 'station' && !stationId)}
            >
              ${scope === 'all' ? 'Alle Daten löschen' : 'Daten des Senders löschen'}
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TABS = [
  ['overview', 'Übersicht', AppIcons.Activity],
  ['stations', 'Sender', AppIcons.Radio],
  ['jobs', 'Jobs', AppIcons.Zap],
  ['settings', 'Einstellungen', AppIcons.Sliders],
  ['database', 'Datenbank', AppIcons.Database]
];

function AdminApp() {
  const initialTab = Math.max(0, TABS.findIndex(([key]) => key === new URLSearchParams(window.location.search).get('tab')));
  const [tabIndex, setTabIndex] = React.useState(initialTab);
  const [data, setData] = React.useState(null);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const toast = Chakra.useToast();
  const toastError = useToastError();

  // silent: the 5s background refresh doesn't show loading indicators.
  const load = React.useCallback(async (fresh = false, silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await apiFetch(`/api/admin/overview${fresh ? '?fresh=1' : ''}`, { silent }));
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(false, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const selectTab = (index) => {
    setTabIndex(index);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', TABS[index][0]);
    window.history.replaceState({}, '', url);
  };

  const runStation = async (row) => {
    try {
      const result = await apiSend(`/api/admin/stations/${encodeURIComponent(row.id)}/run`, 'POST');
      toast({ status: 'success', title: result.alreadyQueued ? 'Abruf läuft bereits' : `Abruf gestartet: ${row.name}`, duration: 2500 });
      load();
    } catch (error) {
      toastError('Abruf fehlgeschlagen', error);
    }
  };

  return html`
    <${AppShell}
      activeKey="admin"
      title="Administration"
      subtitle="Sender, Jobs, Einstellungen und Datenbank"
      controls=${html`
        <${Chakra.Button} size="sm" leftIcon=${html`<${Icons.RepeatIcon} />`} onClick=${() => load(true)} isLoading=${loading} variant="ghost">Aktualisieren<//>
      `}
    >
      ${errorMessage ? html`<${Chakra.Alert} status="error" borderRadius="14px" mb="6"><${Chakra.AlertIcon} />${errorMessage}<//>` : null}
      ${!data ? html`
        <${LoadingSpinner} label="Lade Administration…" size="lg" py="24" />
      ` : html`
        <${Chakra.Tabs} index=${tabIndex} onChange=${selectTab} variant="soft-rounded" colorScheme="brand" isLazy>
          <${Chakra.TabList} mb="6" overflowX="auto" className="horizon-scroll" pb="1">
            ${TABS.map(([key, label, icon]) => html`
              <${Chakra.Tab} key=${key} gap="2" flexShrink="0"><${icon} boxSize="16px" />${label}<//>
            `)}
          <//>
          <${Chakra.TabPanels}>
            <${Chakra.TabPanel} p="0"><${OverviewTab} data=${data} onRunStation=${runStation} /><//>
            <${Chakra.TabPanel} p="0"><${StationsTab} data=${data} reload=${load} onRunStation=${runStation} /><//>
            <${Chakra.TabPanel} p="0"><${JobsTab} data=${data} reload=${load} /><//>
            <${Chakra.TabPanel} p="0"><${SettingsTab} data=${data} reload=${load} /><//>
            <${Chakra.TabPanel} p="0"><${DatabaseTab} data=${data} reload=${load} /><//>
          <//>
        <//>
      `}
    <//>
  `;
}

createRoot(document.getElementById('app')).render(html`
  <${Chakra.ChakraProvider} theme=${horizonTheme}>
    <${AdminApp} />
  <//>
`);
