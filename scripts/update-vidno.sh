#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="${VIDNO_PROJECT_DIR:-$HOME/projects/vidno/vidno}"
cd "$project_dir"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Working tree contains tracked changes. Update stopped."
    exit 1
fi

git pull --ff-only origin main
docker compose up -d --build
docker compose restart frontend

for _ in {1..20}; do
    if curl --fail --silent --show-error http://127.0.0.1/api/health >/dev/null; then
        echo "Vidno is updated and healthy."
        exit 0
    fi
    sleep 3
done

echo "Containers started, but the health check did not pass."
exit 1
