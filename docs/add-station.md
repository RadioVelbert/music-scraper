# Sender hinzufügen und konfigurieren

Sender werden im Browser verwaltet: **Administration → Sender → Sender hinzufügen**. Änderungen gelten sofort, ohne Neustart oder Deployment.

`config.yaml` wird bei jedem Start abgeglichen: Neue Einträge werden angelegt, geänderte übernommen – solange der Sender nicht im Admin-Bereich bearbeitet wurde. Im Admin bearbeitete oder gelöschte Sender bleiben unverändert (der Admin-Bereich hat Vorrang). Manuell auslösen: **Sender → config.yaml abgleichen**.

---

## Quellen

| Quelle | Eingabe | Standard-Intervall |
|---|---|---|
| **onlineradiobox** | Sendernamen suchen und Treffer übernehmen – die Playlist-URL wird automatisch gesetzt | 60 min |
| **laut.fm** | Sendernamen eingeben (z. B. `radiovelbert`) und „Prüfen“ | 5 min |
| **JSON-API** | URL + Feld-Mapping, Vorlagen für NRW Lokalradios und laut.fm | 60 min |
| **HTML / Experte** | Parser wählen (DLF Nova, FluxFM, radio.menu, generisches HTML …) | 60 min |

Vor dem Speichern **„Quelle testen“** klicken: Die Quelle wird einmal abgerufen und die erkannten Titel werden angezeigt. Dabei wird nichts gespeichert. Titel mit dem Hinweis „Wird gefiltert“ (Jingles, Nachrichten, Senderwerbung) landen nicht in der Datenbank.

Nach dem Anlegen startet der erste Abruf sofort. Den Status sieht man unter **Administration → Übersicht**.

---

## Abruf-Intervall

- **Standard** für alle Sender: 60 Minuten, für laut.fm 5 Minuten (laut.fm hält nur die letzten 10 Titel vor). Beides unter **Administration → Einstellungen** änderbar.
- **Pro Sender** lässt sich im Sender-Dialog ein eigener Wert setzen, der den Standard überschreibt.
- Der Zeitplan prüft jede Minute, welche Sender fällig sind. Abrufe laufen in einer eigenen Spur parallel zur Wartung und werden von ihr nicht aufgehalten.

---

## JSON-APIs

Der JSON-Parser bildet beliebige Playlist-APIs ab. Feldpfade nutzen Punkt-Notation (`artist.name`, `data.items`).

| Feld | Bedeutung | Beispiel |
|---|---|---|
| Pfad zur Liste | Wo die Einträge stehen; leer = Antwort ist direkt eine Liste | `data.items` |
| Feld Interpret | leer = Titelfeld enthält „Interpret - Titel“ | `artist.name` |
| Feld Titel | | `title` |
| Feld Zeitpunkt | | `timeslot_iso` |
| Zeitformat | `iso`, `unix`, `unix_ms` oder ein [Luxon-Format](https://moment.github.io/luxon/#/formatting?id=table-of-tokens) | `yyyy-MM-dd HH:mm:ss ZZZ` |
| Filter | Nur Einträge, deren Feld diesen Wert hat | `type` = `song` |
| Deezer-ID (optional) | Titel wird ohne Deezer-Suche exakt zugeordnet | `deezer_id` |
| ISRC / Cover (optional) | Cover-Pfade dürfen relativ sein (`/artwork/1.webp`) | `isrc`, `artwork` |

Zeitangaben ohne Zeitzone werden in der Zeitzone des Senders interpretiert.

### Zeitfenster-APIs (z. B. NRW Lokalradios)

Manche APIs liefern Titel für einen Zeitraum. Platzhalter in der URL werden bei jedem Abruf ersetzt:

| Platzhalter | Ergebnis |
|---|---|
| `{from:yyyy-MM-dd HH:mm:ss}` / `{to:…}` | Beginn/Ende im angegebenen Format (Ortszeit des Senders) |
| `{from_iso}` / `{to_iso}` | ISO 8601 |
| `{from_unix}` / `{to_unix}` | Unix-Sekunden (`_unix_ms` für Millisekunden) |
| `{limit:200}` | Für „letzte N Titel“-APIs: so viele Titel, wie seit dem letzten Abruf nötig sind (ca. 1 pro 2 Minuten), höchstens die angegebene API-Grenze |

Das Fenster umfasst die **Rückschau** (Standard 180 Minuten, im Sender-Dialog unter „Erweitert“ einstellbar). War der Sender länger nicht erreichbar, wird automatisch ab dem letzten erfolgreichen Abruf nachgeholt, höchstens 48 Stunden. Beim ersten Abruf werden die letzten 24 Stunden geholt. Doppelte Einträge aus überlappenden Fenstern werden erkannt.

Beispiel **Radio Neandertal** (in `config.yaml` bereits enthalten):

```
https://www.radioneandertal.de/playlist/title?station=live&req_station=29&datefrom={from:yyyy-MM-dd HH:mm:ss}&dateto={to:yyyy-MM-dd HH:mm:ss}&pagesize=1000
```

Mapping: Feld Interpret `artist`, Feld Titel `title`, Feld Zeitpunkt `timeslot_iso`, Zeitformat `iso`. Andere NRW-Lokalradios funktionieren genauso; nur Domain und `req_station` ändern sich.

Beispiel **RadioVelbert** (eigene API, Vorlage „RadioVelbert API“ im Sender-Dialog):

```
https://api.radiovelbert.de/api/songs/history?limit={limit:200}
```

Die API liefert höchstens 200 Einträge (ca. 10 Stunden), hält aber 30 Tage vor. Bei stündlichem Abruf mit 90 Minuten Rückschau werden nur etwa 45 Titel geholt; nach einem Ausfall entsprechend mehr, höchstens 200. Deezer-ID, ISRC und Cover kommen direkt mit: Mapping Liste `data`, Zeitpunkt `last_played`, Deezer-ID `deezer_id`, ISRC `isrc`, Cover `artwork`.

---

## Weitere Optionen (Sender-Dialog → Erweitert)

| Option | Standard | Beschreibung |
|---|---|---|
| Fallback-URLs | – | Werden der Reihe nach probiert, wenn die Haupt-URL nichts liefert |
| Mindestabstand zwischen Plays | 0 s | Gegen doppelte Einträge mancher Quellen |
| Höchstens ein Play pro Minute | aus | Für Quellen, die Titel mehrfach pro Minute melden |
| Coverage: Stunden / Plays pro Tag | 20 / 24 | Schwellen für den täglichen Coverage-Audit |
| Mein Sender | aus | Nur ein Sender kann „Mein Sender“ sein; wird auf der Seite „Mein Sender“ verglichen |

Erfasst werden nur Titel zwischen 06:00 und 20:59 Uhr Ortszeit des Senders. Das Zeitfenster ist unter **Administration → Einstellungen** änderbar.

Unter **Einstellungen → Immer ausfiltern** stehen Begriffe, die nie Musik sind (Standard: `RadioVelbert`). Enthält Interpret oder Titel einen davon, wird der Eintrag bei allen Sendern verworfen – auch „Radio Velbert“ oder „RADIO-VELBERT Lokalnachrichten“. Bereits gespeicherte Treffer entfernt die nächste Wartung.

---

## config.yaml

Format eines Eintrags (alle Felder wie im Sender-Dialog):

```yaml
stations:
  - id: "radiovelbert"
    name: "RadioVelbert"
    playlist_url: "https://api.radiovelbert.de/api/songs/history?limit={limit:200}"
    parser: "json"                   # onlineradiobox | lautfm_json | json | nrwlokalradios_json | dlf_nova | fluxfm | radiomenu | generic_html | generic_html_or_onlineradiobox
    fetcher: "http"                  # http | playwright
    timezone: "Europe/Berlin"
    # optional:
    refresh_minutes: 60              # eigenes Intervall (sonst Standard aus den Einstellungen)
    lookback_minutes: 90             # Rückschau für {from}/{to}/{limit}
    fallback_urls: []
    my_station: true
    json:                            # nur für parser: "json"
      items_path: "data"
      artist_path: "artist"
      title_path: "title"
      time_path: "last_played"
      time_format: "iso"
      deezer_id_path: "deezer_id"    # optional
      isrc_path: "isrc"              # optional
      artwork_path: "artwork"        # optional
```

Die ID darf nur Kleinbuchstaben, Ziffern, `_` und `-` enthalten und kann später nicht geändert werden.

---

## Wenn keine Titel ankommen

1. **Administration → Übersicht**: Status-Badge des Senders. Die Fehlermeldung erscheint beim Darüberfahren.
2. Im Sender-Dialog **„Quelle testen“**: Zeigt, welche URL geantwortet hat und was erkannt wurde.
3. Bei onlineradiobox: Manche Sender haben mehrere Seiten; über die Suche den richtigen Eintrag wählen oder eine Fallback-URL ergänzen.
4. Bei JSON: Die API-URL im Browser öffnen und den Pfad zur Liste bzw. die Feldnamen vergleichen.
