#!/bin/sh
set -e

# Volumes can arrive owned by root (bind mounts, volumes created by an older image).
# Fix ownership of the data locations, then drop privileges to the unprivileged "node" user.
if [ "$(id -u)" = "0" ]; then
  data_dir="$(dirname "${DB_PATH:-/data/music-scraper.sqlite}")"
  reports_dir="${REPORTS_DIR:-/data/reports}"
  mkdir -p "$data_dir" "$reports_dir"
  for dir in "$data_dir" "$reports_dir"; do
    if [ "$dir" != "/" ]; then
      chown -R node:node "$dir"
    fi
  done
  exec gosu node "$@"
fi

exec "$@"
