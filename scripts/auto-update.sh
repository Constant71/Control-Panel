#!/bin/sh
# Auto-update for the Docker host: run from cron every few minutes.
#   */5 * * * * /path/to/Control-Panel/scripts/auto-update.sh >> /path/to/Control-Panel/auto-update.log 2>&1
#
# Pulls main and rebuilds only when it changed. The image build runs the type check and the
# test suite; if either fails, the running panel is left as it is and that commit is skipped
# (it is retried only when a newer commit lands). Your .env and the panel-data volume are untouched.
set -eu
cd "$(dirname "$0")/.."

# One run at a time.
exec 9>.auto-update.lock
if command -v flock >/dev/null 2>&1; then flock -n 9 || exit 0; fi

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
git fetch --quiet origin main
remote=$(git rev-parse origin/main)
deployed=$(cat .deployed-sha 2>/dev/null || true)
failed=$(cat .failed-sha 2>/dev/null || true)
[ "$remote" = "$deployed" ] && exit 0
[ "$remote" = "$failed" ] && exit 0

echo "$(stamp) update to ${remote}"
if ! git merge --ff-only --quiet origin/main; then
  echo "$(stamp) can't fast-forward: local changes in the checkout. Run 'git status' on the server."
  echo "$remote" > .failed-sha
  exit 1
fi

export GIT_SHA="$remote"
if docker compose build; then
  docker compose up -d
  echo "$remote" > .deployed-sha
  rm -f .failed-sha
  docker image prune -f >/dev/null 2>&1 || true
  echo "$(stamp) deployed ${remote}"
else
  echo "$remote" > .failed-sha
  echo "$(stamp) build or tests failed for ${remote}; the running panel was left as it is"
  exit 1
fi
