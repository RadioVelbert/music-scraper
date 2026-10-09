# Deployment mit Coolify

Music Scraper läuft in Coolify als **ein** Docker-Compose-Service. Das Repo bringt alles mit:

| Datei | Zweck |
|---|---|
| `Dockerfile` | Baut das Image (Node 22, `better-sqlite3` inkl. Build-Fallback für ARM) |
| `docker-compose.yaml` | Service `app`, Volume für Datenbank + Reports, Umgebungsvariablen |
| `docker/entrypoint.sh` | Korrigiert Volume-Rechte und startet die App als unprivilegierter User |

---

## Einrichtung

1. **Neue Resource anlegen**
   Coolify → Projekt → **+ New** → *Private Repository (with GitHub App)* bzw. *Public Repository* → `RadioVelbert/music-scraper`, Branch `main`.

2. **Build Pack** auf **Docker Compose** stellen.
   - Base Directory: `/`
   - Docker Compose Location: `/docker-compose.yaml`

3. **Domain setzen** (Service `app`):

   ```
   https://musik.example.de:8787
   ```

   Das `:8787` ist **Pflicht** – es sagt dem Coolify-Proxy, auf welchen Container-Port er weiterleiten soll. Öffentlich bleibt die Seite unter `https://musik.example.de` (Port 443) erreichbar. Ohne eigene Domain erzeugt Coolify automatisch eine (über `SERVICE_URL_APP_8787` in der Compose-Datei).

   **Ohne Domain (Test über IP):** Die Compose-Datei veröffentlicht Port 8787 direkt auf dem Server, die App ist also auch unter `http://<server-ip>:8787` erreichbar. Dafür muss Port 8787 in der Firewall des Hosters offen sein. Das ist unverschlüsseltes HTTP, das Login-Passwort geht also im Klartext übers Netz. Sobald eine Domain eingerichtet ist, den `ports:`-Block aus `docker-compose.yaml` entfernen.

4. **Umgebungsvariablen prüfen** (Tab *Environment Variables*):
   - `SERVICE_PASSWORD_APP` – von Coolify generiert, das ist das **Login-Passwort** fürs Dashboard
   - `BASIC_AUTH_USER` – Login-Name, Standard `radio`
   - optional `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`

5. **Deploy** klicken.
   Das Dashboard ist nach wenigen Sekunden erreichbar. Der erste Scan aller Sender (Ingest, Wartung, Auswertung, Report) läuft danach im Hintergrund und dauert einige Minuten – Fortschritt unter *Logs*.

---

## Betrieb

### Automatische Jobs

Alle Jobs laufen im Container, nacheinander (nie parallel, weil sie dieselbe SQLite-Datei schreiben). Zeiten in Europe/Berlin.

| Wann | Was |
|---|---|
| Nach jedem Start/Deploy | `daily-job`: Ingest, komplette Wartung, Auswertung von gestern, Coverage-Audit, Wochenreport |
| Stündlich zur vollen Stunde | Ingest, `maintain-db`, Auswertung von gestern |
| Täglich 04:20 | Coverage-Audit für gestern, Wochenreport (Markdown + CSV) |

Externe Cronjobs oder GitHub Actions werden nicht mehr gebraucht.

### Daten

Datenbank und Reports liegen im Volume `music-scraper-data` (im Container unter `/data`):

```
/data/music-scraper.sqlite
/data/reports/...
```

Das Volume bleibt bei Redeploys erhalten. **Nicht** unter *Persistent Storage* löschen – dann sind alle Daten weg.

### Sender ändern

`config.yaml` im Repo bearbeiten, committen, pushen. Coolify deployt neu (bei aktiviertem Auto-Deploy automatisch) und übernimmt die Sender beim Start.

### CLI-Befehle im Container

Coolify → Resource → *Terminal* (Container `app`). Datenbank- und Config-Pfad sind per Umgebungsvariable gesetzt, `--db`/`--config` können entfallen. Mit `gosu node` laufen die Befehle als derselbe User wie die App:

```bash
gosu node node src/cli.js backfill-deezer --dry-run --limit 200
gosu node node src/cli.js backfill-deezer --no-dry-run --limit 500
gosu node node src/cli.js report --week-start 2026-10-05 --csv
```

---

## Bestehende Datenbank übernehmen

Wenn lokal schon eine Datenbank mit Historie existiert (`yrpa.sqlite` oder `music-scraper.sqlite`):

1. **Lokal** den Server sauber beenden (CTRL+C), damit SQLite alles in die Hauptdatei schreibt. Liegt danach noch eine `…-wal`-Datei daneben, diese mitkopieren.
2. Datei auf den Coolify-Server kopieren, z. B. `scp yrpa.sqlite root@server:/root/import.sqlite`.
3. In Coolify die Resource **stoppen**.
4. Auf dem Server per SSH:

   ```bash
   # Volume-Namen finden (Coolify setzt eine ID davor)
   docker volume ls | grep music-scraper-data

   # Alte WAL-/SHM-Dateien entfernen und Datenbank einspielen
   docker run --rm \
     -v <VOLUME-NAME>:/data \
     -v /root/import.sqlite:/import.sqlite:ro \
     alpine sh -c 'rm -f /data/music-scraper.sqlite-wal /data/music-scraper.sqlite-shm && cp /import.sqlite /data/music-scraper.sqlite'
   ```

   Die alten `-wal`/`-shm`-Dateien **müssen** weg: Eine übrig gebliebene WAL-Datei der leeren Datenbank würde sonst auf die importierte angewendet und sie beschädigen.

5. Resource in Coolify wieder **starten**. Dateirechte werden beim Start automatisch korrigiert.

---

## Backup

Coolify sichert nur seine eigenen Datenbank-Resources automatisch, **nicht** dieses Volume. Konsistentes Backup im laufenden Betrieb:

```bash
docker exec <CONTAINER> gosu node node -e "require('better-sqlite3')(process.env.DB_PATH).backup('/data/backup.sqlite').then(() => console.log('ok'))"
docker cp <CONTAINER>:/data/backup.sqlite ./music-scraper-$(date +%F).sqlite
```

Den Container-Namen zeigt `docker ps | grep app-`. Den Befehl kann man als Cronjob auf dem Server oder als *Scheduled Task* in Coolify einrichten.

---

## Umgebungsvariablen

| Variable | Beschreibung | Standard im Container |
|---|---|---|
| `BASIC_AUTH_USER` | Login-Name. Leer = kein Login | `radio` |
| `BASIC_AUTH_PASSWORD` | Login-Passwort. In Coolify = `SERVICE_PASSWORD_APP` | generiert |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify-API (optional) | — |
| `YRPA_VERIFY_ALL_TRACKS` | Alle Tracks gegen iTunes/Spotify prüfen | `1` |
| `YRPA_TRACK_VERIFY` | Track-Verifikation (`0` = aus) | `1` |
| `YRPA_DEDUP_COOLDOWN_SECONDS` | Dedup-Fenster in Sekunden | `900` |
| `LOG_LEVEL` | `info`, `debug`, … | `info` |
| `DB_PATH` | SQLite-Datei | `/data/music-scraper.sqlite` |
| `REPORTS_DIR` | Ausgabeordner für Reports | `/data/reports` |
| `CONFIG_PATH` | Sender-Konfiguration | `/app/config.yaml` |
| `PORT` | HTTP-Port im Container | `8787` |

`DB_PATH`, `REPORTS_DIR`, `CONFIG_PATH` und `PORT` sind im Image gesetzt und müssen normalerweise nicht angefasst werden. Wird `PORT` geändert, muss auch der Port im Domain-Feld angepasst werden.

---

## Lokal testen

```bash
docker build -t music-scraper .
docker run --rm -p 8787:8787 -v music-scraper-data:/data music-scraper
```

→ <http://localhost:8787> (ohne Login, weil keine Auth-Variablen gesetzt sind).

---

## Typische Probleme

**„No Available Server" / 404 vom Proxy**
- Fehlt `:8787` im Domain-Feld? Ohne Port leitet Coolify auf Port 80 weiter.
- Ist der Container *healthy*? Coolify leitet erst weiter, wenn der Healthcheck (`/api/health`) einmal erfolgreich war – nach dem Start ca. 10 Sekunden.

**Browser fragt dauernd nach Login**
Benutzer = `BASIC_AUTH_USER`, Passwort = Wert von `SERVICE_PASSWORD_APP` in den Environment Variables.

**Nach einem Deploy sind alle Daten weg**
- Build Pack muss *Docker Compose* sein. Mit *Nixpacks* oder *Dockerfile* fehlt das Volume aus der Compose-Datei.
- Wurde das Volume unter *Persistent Storage* gelöscht?

**Nicht skalieren**
Immer genau **eine** Instanz betreiben. Mehrere Replicas würden jeden Sender mehrfach scrapen und gleichzeitig in dieselbe SQLite-Datei schreiben.

**Kein Netzwerk-Speicher**
Das Volume muss auf einem lokalen Dateisystem liegen. SQLite im WAL-Modus funktioniert nicht zuverlässig auf NFS/SMB.
