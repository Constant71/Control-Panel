#!/bin/sh
# Make sure the data folder (a Docker volume, created owned by root) is writable by the
# unprivileged "node" user, then drop to that user. Without this, nothing the panel saves
# (roles, stations, crafting queues, naming) survives a restart.
set -e
DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  chown -R node:node "$DIR"
  exec su node -s /bin/sh -c 'exec "$0" "$@"' -- "$@"
fi
exec "$@"
