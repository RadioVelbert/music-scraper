import {
  React,
  createRoot,
  Chakra,
  html,
  horizonTheme,
  apiFetch,
  formatDateTime,
  formatNumber,
  AppShell,
  PanelCard,
  AppIcons,
  PlayButton,
  CopyTrackButton,
  OwnPlayBadge,
  TrackCover,
  LoadingSpinner,
  setFavoriteKeys,
  trackHref,
  navigate
} from './horizon-lib.js';

const STATUSES = [
  { value: 'open', label: 'Offen', scheme: 'gray' },
  { value: 'requested', label: 'Angefragt', scheme: 'orange' },
  { value: 'in_programm', label: 'Im Programm', scheme: 'green' }
];
const STATUS_ORDER = { open: 0, requested: 1, in_programm: 2 };

const COLUMNS = [
  { key: 'title', label: 'Titel' },
  { key: 'artist', label: 'Interpret' },
  { key: 'status', label: 'Status' },
  { key: 'note', label: 'Notiz', sortable: false },
  { key: 'added', label: 'Hinzugefügt' }
];

function compareBy(key) {
  const text = (a, b) => String(a || '').localeCompare(String(b || ''), 'de', { sensitivity: 'base' });
  switch (key) {
    case 'title': return (a, b) => text(a.title, b.title);
    case 'artist': return (a, b) => text(a.artist, b.artist) || text(a.title, b.title);
    case 'status': return (a, b) => (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0) || text(a.artist, b.artist);
    default: return (a, b) => String(a.created_at_utc).localeCompare(String(b.created_at_utc));
  }
}

function FavoriteRow({ favorite: f, number, selected, onSelect, onPatch, onRemove }) {
  const [note, setNote] = React.useState(f.note || '');
  React.useEffect(() => setNote(f.note || ''), [f.note]);
  const status = STATUSES.find((s) => s.value === f.status) || STATUSES[0];
  const saveNote = () => {
    if (note.trim() !== (f.note || '')) onPatch(f, { note });
  };
  return html`
    <${Chakra.Tr} bg=${selected ? 'subtleBg' : undefined} _hover=${{ bg: 'subtleBg' }} opacity=${f.status === 'in_programm' ? 0.7 : 1}>
      <${Chakra.Td} py="2.5" w="1">
        <${Chakra.Checkbox}
          colorScheme="brand"
          size="lg"
          isChecked=${selected}
          onChange=${() => onSelect(f)}
          aria-label=${`${f.artist} – ${f.title} auswählen`}
        />
      <//>
      <${Chakra.Td} py="2.5" color="textMuted" fontSize="xs" fontWeight="600">${number}<//>
      <${Chakra.Td} py="2.5" w="30%">
        <${Chakra.HStack} spacing="3" w="100%">
          <${PlayButton} track=${{ trackKey: f.track_key || undefined, artist: f.artist, title: f.title, artworkUrl: f.artwork_url }} size="sm" />
          <${TrackCover} src=${f.artwork_url} size="40px" />
          <${Chakra.HStack} spacing="2" minW="0">
            ${f.track_key
              ? html`<${Chakra.Link} href=${trackHref(f.track_key)} onClick=${(e) => { e.preventDefault(); navigate(trackHref(f.track_key)); }} fontWeight="700" fontSize="sm" noOfLines=${2}>${f.title}<//>`
              : html`<${Chakra.Text} fontWeight="700" fontSize="sm" noOfLines=${2}>${f.title}<//>`}
            ${f.duplicate_count ? html`
              <${Chakra.Tooltip} label=${f.variants.map((v) => `${v.artist} – ${v.title}`).join('\n')}>
                <${Chakra.Badge} colorScheme="orange" borderRadius="999px" flexShrink="0">Dublette ×${f.duplicate_count}<//>
              <//>
            ` : null}
          <//>
          <${CopyTrackButton} artist=${f.artist} title=${f.title} />
          <${OwnPlayBadge} artist=${f.artist} title=${f.title} trackKey=${f.track_key} />
        <//>
      <//>
      <${Chakra.Td} py="2.5" fontSize="sm" maxW="220px"><${Chakra.Text} noOfLines=${2}>${f.artist}<//><//>
      <${Chakra.Td} py="2.5">
        <${Chakra.Select}
          size="sm"
          w="150px"
          fontWeight="600"
          borderRadius="10px"
          borderColor=${`${status.scheme}.300`}
          value=${f.status}
          onChange=${(e) => onPatch(f, { status: e.target.value })}
          aria-label="Status"
        >
          ${STATUSES.map((s) => html`<option key=${s.value} value=${s.value}>${s.label}</option>`)}
        <//>
      <//>
      <${Chakra.Td} py="2.5" minW="180px">
        <${Chakra.Input}
          size="sm"
          borderRadius="10px"
          placeholder="Notiz …"
          value=${note}
          maxLength=${1000}
          onChange=${(e) => setNote(e.target.value)}
          onBlur=${saveNote}
          onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          aria-label="Notiz"
        />
      <//>
      <${Chakra.Td} py="2.5" fontSize="sm" color="textMuted" whiteSpace="nowrap">${formatDateTime(f.created_at_utc)}<//>
      <${Chakra.Td} py="2.5" w="1">
        <${Chakra.Tooltip} label="Aus Favoriten entfernen">
          <${Chakra.IconButton}
            size="sm"
            variant="ghost"
            color="yellow.400"
            aria-label="Aus Favoriten entfernen"
            icon=${html`<${AppIcons.StarFilled} boxSize="5" />`}
            onClick=${() => onRemove(f)}
          />
        <//>
      <//>
    <//>
  `;
}

function FavoritesApp() {
  const toast = Chakra.useToast();
  const [favorites, setFavorites] = React.useState(null);
  const [error, setError] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState({ key: 'added', dir: 'desc' });
  const [selected, setSelected] = React.useState(() => new Set());
  const [confirm, setConfirm] = React.useState(null); // 'clear' | 'bulk-delete'
  const lastClicked = React.useRef(null);
  const shiftDown = React.useRef(false);
  React.useEffect(() => {
    const track = (e) => { shiftDown.current = e.shiftKey; };
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('blur', () => { shiftDown.current = false; });
    return () => { window.removeEventListener('keydown', track); window.removeEventListener('keyup', track); };
  }, []);
  const cancelRef = React.useRef();

  const apply = (list) => {
    setFavorites(list);
    setFavoriteKeys(list.map((f) => f.song_key));
  };

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch('/api/favorites');
      setFavorites(data.favorites || []);
      setFavoriteKeys(data.keys || [], data.track_keys || []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const fail = (title) => (e) => toast({ status: 'error', title, description: e instanceof Error ? e.message : String(e) });

  const all = favorites || [];
  const counts = { all: all.length };
  for (const s of STATUSES) counts[s.value] = all.filter((f) => f.status === s.value).length;
  const needle = search.trim().toLowerCase();
  const visible = React.useMemo(() => {
    const rows = all.filter((f) => (statusFilter === 'all' || f.status === statusFilter)
      && (!needle || `${f.artist} ${f.title} ${f.note || ''}`.toLowerCase().includes(needle)));
    const cmp = compareBy(sort.key);
    rows.sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : cmp(b, a)));
    return rows;
  }, [all, statusFilter, needle, sort]);

  // Only rows that are currently shown count as selected, so bulk actions never touch hidden rows.
  const selectedRows = visible.filter((f) => selected.has(f.id));
  const allSelected = visible.length > 0 && selectedRows.length === visible.length;
  const someSelected = selectedRows.length > 0 && !allSelected;

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((f) => f.id)));

  const selectRow = (favorite) => {
    const shift = shiftDown.current;
    const index = visible.findIndex((f) => f.id === favorite.id);
    setSelected((current) => {
      const next = new Set(current);
      const on = !next.has(favorite.id);
      if (shift && lastClicked.current != null) {
        const [from, to] = [lastClicked.current, index].sort((a, b) => a - b);
        for (const row of visible.slice(from, to + 1)) (on ? next.add(row.id) : next.delete(row.id));
      } else if (on) {
        next.add(favorite.id);
      } else {
        next.delete(favorite.id);
      }
      return next;
    });
    lastClicked.current = index;
  };

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'added' ? 'desc' : 'asc' }));

  const patch = async (favorite, changes) => {
    const previous = favorites;
    setFavorites((list) => list.map((f) => (f.id === favorite.id ? { ...f, ...changes } : f)));
    try {
      const result = await apiFetch(`/api/favorites/${favorite.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes)
      });
      setFavorites((list) => list.map((f) => (f.id === favorite.id ? result.favorite : f)));
    } catch (e) {
      setFavorites(previous);
      fail('Nicht gespeichert')(e);
    }
  };

  const remove = async (favorite) => {
    try {
      await apiFetch(`/api/favorites/${favorite.id}`, { method: 'DELETE' });
      apply(all.filter((f) => f.id !== favorite.id));
    } catch (e) {
      fail('Entfernen fehlgeschlagen')(e);
    }
  };

  const bulkStatus = async (status) => {
    const ids = selectedRows.map((f) => f.id);
    try {
      const result = await apiFetch('/api/favorites/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, action: 'status', status })
      });
      await load();
      toast({ status: 'success', title: 'Status geändert', description: `${formatNumber(result.changed)} Songs → ${STATUSES.find((s) => s.value === status).label}`, duration: 2500 });
    } catch (e) {
      fail('Status nicht geändert')(e);
    }
  };

  const bulkDelete = async () => {
    setConfirm(null);
    const ids = selectedRows.map((f) => f.id);
    try {
      const result = await apiFetch('/api/favorites/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, action: 'delete' })
      });
      setSelected(new Set());
      await load();
      toast({ status: 'success', title: 'Entfernt', description: `${formatNumber(result.removed)} Songs aus den Favoriten entfernt.`, duration: 2500 });
    } catch (e) {
      fail('Entfernen fehlgeschlagen')(e);
    }
  };

  const clearAll = async () => {
    setConfirm(null);
    try {
      const result = await apiFetch('/api/favorites', { method: 'DELETE' });
      setSelected(new Set());
      apply([]);
      toast({ status: 'success', title: 'Favoriten geleert', description: `${formatNumber(result.removed)} Songs entfernt.`, duration: 3000 });
    } catch (e) {
      fail('Löschen fehlgeschlagen')(e);
    }
  };

  const copyRows = async (rows) => {
    const text = rows.map((f) => `${f.artist} – ${f.title}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast({ status: 'success', title: 'Liste kopiert', description: `${rows.length} Songs`, duration: 2000 });
    } catch {
      toast({ status: 'warning', title: 'Kopieren nicht möglich' });
    }
  };

  const count = all.length;
  const mergedCount = all.reduce((sum, f) => sum + (f.duplicate_count || 0), 0);
  const sortArrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  return html`
    <${AppShell}
      activeKey="favorites"
      title="Favoriten"
      subtitle="Songs, die wir bei uns aufnehmen wollen"
      controls=${html`
        <${Chakra.HStack} spacing="2">
          <${Chakra.Button} as="a" href="/api/favorites/export.csv" download size="sm" variant="outline" isDisabled=${!count} pointerEvents=${count ? 'auto' : 'none'}>CSV exportieren<//>
          <${Chakra.Button} size="sm" variant="outline" onClick=${() => copyRows(visible)} isDisabled=${!visible.length}>Liste kopieren<//>
          <${Chakra.Button} size="sm" colorScheme="red" variant="outline" onClick=${() => setConfirm('clear')} isDisabled=${!count}>Alle löschen<//>
        <//>
      `}
    >
      <${PanelCard}
        title=${`${formatNumber(count)} ${count === 1 ? 'Song' : 'Songs'}`}
        subtitle=${[
          `${formatNumber(counts.in_programm || 0)} im Programm · ${formatNumber(counts.requested || 0)} angefragt · ${formatNumber(counts.open || 0)} offen`,
          mergedCount ? `${formatNumber(mergedCount)} Dublette${mergedCount === 1 ? '' : 'n'} zusammengeführt` : 'Doppelte Songs werden automatisch zusammengeführt'
        ].join(' · ')}
        icon=${AppIcons.Star}
      >
        ${error ? html`<${Chakra.Text} color="red.400" fontSize="sm">${error}<//>` : null}
        ${favorites === null && !error ? html`<${LoadingSpinner} label="Lade Favoriten…" />` : null}
        ${favorites && !count ? html`
          <${Chakra.Text} color="textMuted" fontSize="sm" py="6" textAlign="center">
            Noch keine Favoriten. Mit dem Stern neben einem Song legst du ihn hier ab.
          <//>
        ` : null}
        ${count ? html`
          <${Chakra.Flex} gap="3" wrap="wrap" align="center" mb="3">
            <${Chakra.ButtonGroup} size="sm" isAttached variant="outline">
              ${[{ value: 'all', label: 'Alle' }, ...STATUSES].map((s) => html`
                <${Chakra.Button}
                  key=${s.value}
                  colorScheme=${statusFilter === s.value ? 'brand' : 'gray'}
                  variant=${statusFilter === s.value ? 'solid' : 'outline'}
                  onClick=${() => setStatusFilter(s.value)}
                >${s.label} (${counts[s.value] ?? 0})<//>
              `)}
            <//>
            <${Chakra.Input} size="sm" maxW="260px" borderRadius="10px" placeholder="Suchen (Interpret, Titel, Notiz)" value=${search} onChange=${(e) => setSearch(e.target.value)} />
          <//>

          ${selectedRows.length ? html`
            <${Chakra.Flex} gap="3" wrap="wrap" align="center" mb="3" p="3" borderRadius="14px" bg="subtleBg" border="1px solid" borderColor="lineColor" role="toolbar" aria-label="Sammelaktionen">
              <${Chakra.Text} fontWeight="700" fontSize="sm">${formatNumber(selectedRows.length)} ausgewählt<//>
              <${Chakra.Select}
                size="sm"
                w="190px"
                borderRadius="10px"
                value=""
                onChange=${(e) => { if (e.target.value) bulkStatus(e.target.value); }}
                aria-label="Status für Auswahl setzen"
              >
                <option value="">Status setzen …</option>
                ${STATUSES.map((s) => html`<option key=${s.value} value=${s.value}>${s.label}</option>`)}
              <//>
              <${Chakra.Button} size="sm" variant="outline" onClick=${() => copyRows(selectedRows)}>Auswahl kopieren<//>
              <${Chakra.Button} size="sm" variant="outline" colorScheme="red" onClick=${() => setConfirm('bulk-delete')}>Auswahl entfernen<//>
              <${Chakra.Button} size="sm" variant="ghost" onClick=${() => setSelected(new Set())}>Auswahl aufheben<//>
            <//>
          ` : null}

          <${Chakra.TableContainer}>
            <${Chakra.Table} size="sm" variant="simple">
              <${Chakra.Thead}>
                <${Chakra.Tr}>
                  <${Chakra.Th} w="1">
                    <${Chakra.Checkbox} colorScheme="brand" size="lg" isChecked=${allSelected} isIndeterminate=${someSelected} onChange=${toggleAll} aria-label="Alle auswählen" />
                  <//>
                  <${Chakra.Th} w="8">#<//>
                  ${COLUMNS.map((c) => html`
                    <${Chakra.Th}
                      key=${c.key}
                      cursor=${c.sortable === false ? 'default' : 'pointer'}
                      userSelect="none"
                      onClick=${c.sortable === false ? undefined : () => toggleSort(c.key)}
                      aria-sort=${sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    >${c.label}${sortArrow(c.key)}<//>
                  `)}
                  <${Chakra.Th} w="1" />
                <//>
              <//>
              <${Chakra.Tbody}>
                ${visible.map((f, index) => html`
                  <${FavoriteRow}
                    key=${f.id}
                    favorite=${f}
                    number=${index + 1}
                    selected=${selected.has(f.id)}
                    onSelect=${selectRow}
                    onPatch=${patch}
                    onRemove=${remove}
                  />
                `)}
                ${!visible.length ? html`<${Chakra.Tr}><${Chakra.Td} colSpan=${9} textAlign="center" color="textMuted" py="8">Keine Treffer für diesen Filter.<//><//>` : null}
              <//>
            <//>
          <//>
          <${Chakra.Text} mt="3" fontSize="xs" color="textMuted">Tipp: Mit gedrückter Umschalttaste markierst du mehrere Zeilen auf einmal.<//>
        ` : null}
      <//>

      <${Chakra.AlertDialog} isOpen=${confirm !== null} leastDestructiveRef=${cancelRef} onClose=${() => setConfirm(null)} isCentered>
        <${Chakra.AlertDialogOverlay}>
          <${Chakra.AlertDialogContent}>
            <${Chakra.AlertDialogHeader}>${confirm === 'bulk-delete' ? 'Auswahl entfernen?' : 'Alle Favoriten löschen?'}<//>
            <${Chakra.AlertDialogBody}>
              ${confirm === 'bulk-delete'
                ? `${formatNumber(selectedRows.length)} ausgewählte Songs werden aus den Favoriten entfernt, samt Status und Notizen.`
                : `Alle ${formatNumber(count)} Songs werden aus den Favoriten entfernt, samt Status und Notizen. Die Markierungen auf den anderen Seiten verschwinden damit ebenfalls.`}
            <//>
            <${Chakra.AlertDialogFooter}>
              <${Chakra.Button} ref=${cancelRef} onClick=${() => setConfirm(null)}>Abbrechen<//>
              <${Chakra.Button} colorScheme="red" ml="3" onClick=${confirm === 'bulk-delete' ? bulkDelete : clearAll}>${confirm === 'bulk-delete' ? 'Entfernen' : 'Alle löschen'}<//>
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
    <${FavoritesApp} />
  <//>
`);
