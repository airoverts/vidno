#!/bin/sh
set -eu

mkdir -p /backups

while true; do
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    temporary="/backups/vidno-${stamp}.dump.tmp"
    destination="/backups/vidno-${stamp}.dump"
    pg_dump --format=custom --file="$temporary"
    pg_restore --list "$temporary" >/dev/null
    mv "$temporary" "$destination"
    find /backups -maxdepth 1 -type f -name 'vidno-*.dump' | sort -r | tail -n +9 | xargs -r rm -f
    restore_check="$(find /backups -maxdepth 1 -name '.last-restore-check' -mtime -28 -print)"
    if [ -z "$restore_check" ]; then
        test_database="vidno_restore_check"
        if [ "$PGDATABASE" = "$test_database" ]; then
            exit 1
        fi
        dropdb --if-exists "$test_database"
        createdb "$test_database"
        if pg_restore --dbname="$test_database" "$destination" && psql --dbname="$test_database" --command='SELECT 1' >/dev/null; then
            dropdb "$test_database"
            touch /backups/.last-restore-check
        else
            dropdb --if-exists "$test_database"
            exit 1
        fi
    fi
    sleep 604800
done
