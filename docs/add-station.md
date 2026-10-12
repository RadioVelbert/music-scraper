# Sender hinzufügen und konfigurieren

Sender werden im Browser verwaltet: **Administration → Sender → Sender hinzufügen**. Änderungen gelten sofort, ohne Neustart oder Deployment.

`config.yaml` wird nur beim allerersten Start in eine leere Datenbank übernommen. Danach ist die Datenbank die Quelle. Neue Einträge aus `config.yaml` lassen sich jederzeit über **Sender → config.yaml importieren** nachziehen (vorhandene Sender werden dabei nicht verändert).

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

Zeitangaben ohne Zeitzone werden in der Zeitzone des Senders interpretiert.

### Zeitfenster-APIs (z. B. NRW Lokalradios)

Manche APIs liefern Titel für einen Zeitraum. Platzhalter in der URL werden bei jedem Abruf ersetzt:

| Platzhalter | Ergebnis |
|---|---|
| `{from:yyyy-MM-dd HH:mm:ss}` / `{to:…}` | Beginn/Ende im angegebenen Format (Ortszeit des Senders) |
| `{from_iso}` / `{to_iso}` | ISO 8601 |
| `{from_unix}` / `{to_unix}` | Unix-Sekunden (`_unix_ms` für Millisekunden) |

Das Fenster umfasst die **Rückschau** (Standard 180 Minuten, im Sender-Dialog unter „Erweitert“ einstellbar). War der Sender länger nicht erreichbar, wird automatisch ab dem letzten erfolgreichen Abruf nachgeholt, höchstens 48 Stunden. Beim ersten Abruf werden die letzten 24 Stunden geholt. Doppelte Einträge aus überlappenden Fenstern werden erkannt.

Beispiel **Radio Neandertal** (in `config.yaml` bereits enthalten):

```
https://www.radioneandertal.de/playlist/title?station=live&req_station=29&datefrom={from:yyyy-MM-dd HH:mm:ss}&dateto={to:yyyy-MM-dd HH:mm:ss}&pagesize=1000
```

Mapping: Feld Interpret `artist`, Feld Titel `title`, Feld Zeitpunkt `timeslot_iso`, Zeitformat `iso`. Andere NRW-Lokalradios funktionieren genauso; nur Domain und `req_station` ändern sich.

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

---

## config.yaml (Startwerte)

Format eines Eintrags (alle Felder wie im Sender-Dialog):

```yaml
stations:
  - id: "radiovelbert"
    name: "RadioVelbert"
    playlist_url: "https://api.laut.fm/station/radiovelbert/last_songs"
    parser: "lautfm_json"            # onlineradiobox | lautfm_json | json | nrwlokalradios_json | dlf_nova | fluxfm | radiomenu | generic_html | generic_html_or_onlineradiobox
    fetcher: "http"                  # http | playwright
    timezone: "Europe/Berlin"
    # optional:
    refresh_minutes: 5               # eigenes Intervall
    lookback_minutes: 180            # Rückschau für {from}/{to}
    fallback_urls: []
    my_station: false
    json:                            # nur für parser: "json"
      items_path: ""
      artist_path: "artist"
      title_path: "title"
      time_path: "timeslot_iso"
      time_format: "iso"
```

Die ID darf nur Kleinbuchstaben, Ziffern, `_` und `-` enthalten und kann später nicht geändert werden.

---

## Wenn keine Titel ankommen

1. **Administration → Übersicht**: Status-Badge des Senders. Die Fehlermeldung erscheint beim Darüberfahren.
2. Im Sender-Dialog **„Quelle testen“**: Zeigt, welche URL geantwortet hat und was erkannt wurde.
3. Bei onlineradiobox: Manche Sender haben mehrere Seiten; über die Suche den richtigen Eintrag wählen oder eine Fallback-URL ergänzen.
4. Bei JSON: Die API-URL im Browser öffnen und den Pfad zur Liste bzw. die Feldnamen vergleichen.
