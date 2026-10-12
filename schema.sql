create table if not exists stations(
  id text primary key,
  name text,
  url text,
  timezone text
);

create table if not exists plays(
  id integer primary key autoincrement,
  station_id text not null,
  played_at_utc text not null,
  artist_raw text not null,
  title_raw text not null,
  artist text not null,
  title text not null,
  track_key text not null,
  dedup_song_key text,
  source_url text,
  ingested_at_utc text not null,
  unique(station_id, played_at_utc, artist_raw, title_raw),
  foreign key(station_id) references stations(id)
);

create index if not exists idx_plays_station_played_at on plays(station_id, played_at_utc);
create index if not exists idx_plays_track_key on plays(track_key);
create index if not exists idx_plays_track_played_at on plays(track_key, played_at_utc);
create index if not exists idx_plays_track_station_played_at on plays(track_key, station_id, played_at_utc);

create table if not exists play_dedup_events(
  id integer primary key autoincrement,
  station_id text not null,
  played_at_utc text not null,
  artist_raw text not null,
  title_raw text not null,
  artist text not null,
  title text not null,
  track_key text not null,
  dedup_song_key text not null,
  deduped integer not null default 1,
  last_counted_at_utc text,
  delta_seconds integer,
  source_url text,
  ingested_at_utc text not null,
  foreign key(station_id) references stations(id)
);

create index if not exists idx_play_dedup_station_songkey_playedat
  on play_dedup_events(station_id, dedup_song_key, played_at_utc);

create table if not exists daily_station_stats(
  date_berlin text not null,
  station_id text not null,
  total_plays integer not null,
  unique_tracks integer not null,
  primary key(date_berlin, station_id),
  foreign key(station_id) references stations(id)
);

create table if not exists daily_track_stats(
  date_berlin text not null,
  station_id text not null,
  track_key text not null,
  artist text not null,
  title text not null,
  plays integer not null,
  primary key(date_berlin, station_id, track_key),
  foreign key(station_id) references stations(id)
);

create table if not exists daily_overall_track_stats(
  date_berlin text not null,
  track_key text not null,
  artist text not null,
  title text not null,
  plays integer not null,
  primary key(date_berlin, track_key)
);

create table if not exists track_metadata(
  track_key text primary key,
  artist text not null,
  title text not null,
  verified_exists integer,
  verification_source text,
  verification_confidence real,
  external_track_id text,
  external_url text,
  artwork_url text,
  release_date_utc text,
  genre text,
  album text,
  label text,
  duration_ms integer,
  preview_url text,
  isrc text,
  spotify_track_id text,
  spotify_confidence real,
  canonical_source text,
  canonical_id text,
  popularity_score real,
  chart_airplay_rank integer,
  chart_single_rank integer,
  chart_country text,
  social_viral_score real,
  payload_json text,
  last_checked_utc text not null
);


create table if not exists canonical_map(
  canonical_title text not null,
  canonical_primary_artist text not null,
  canonical_track_key text not null,
  updated_at_utc text not null,
  primary key(canonical_title, canonical_primary_artist)
);

create index if not exists idx_canonical_map_title_primary
  on canonical_map(canonical_title, canonical_primary_artist);

-- Scrape status per station (written by every ingest run, shown in the admin area)
create table if not exists station_status(
  station_id text primary key,
  last_started_at_utc text,
  last_finished_at_utc text,
  last_success_at_utc text,
  last_status text,
  last_error text,
  last_source_url text,
  last_plays_found integer,
  last_plays_inserted integer,
  last_duration_ms integer,
  consecutive_failures integer not null default 0,
  total_runs integer not null default 0,
  total_inserted integer not null default 0
);

-- Display spelling per track (plays.artist/title are normalized lowercase identities)
create table if not exists track_display(
  track_key text primary key,
  artist_norm text not null,
  title_norm text not null,
  artist text not null,
  title text not null,
  source text not null,
  updated_at_utc text not null
);

create index if not exists idx_track_display_artist_norm on track_display(artist_norm);

-- Cached Deezer details (track, album, artist, contributors) for the song page
create table if not exists track_enrichment(
  track_key text primary key,
  source text not null,
  source_id text,
  payload_json text,
  fetched_at_utc text not null
);

create table if not exists job_runs(
  id integer primary key autoincrement,
  name text not null,
  label text,
  trigger text,
  status text not null,
  detail_json text,
  error text,
  queued_at_utc text,
  started_at_utc text,
  finished_at_utc text,
  duration_ms integer
);

create table if not exists app_settings(
  key text primary key,
  value_json text not null,
  updated_at_utc text not null
);
