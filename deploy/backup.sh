#!/bin/sh
# Complete backup of everything the app stores, as ONE archive (safe in WAL mode, app keeps running):
#   pmis.db        consistent copy of the database (projects, financials, users, all logs, cell status history)
#   uploads/       every attachment file
#   change-logs-*.json   portable export of the change history (see src/logTransfer.js)
# The DB copy is integrity-checked before it is archived; the script fails loudly if anything is off.
# Run from the project folder (where docker-compose.yml is), e.g. daily from cron:
#   15 2 * * * cd /opt/aarvee-pmis && ./deploy/backup.sh >> data/backups/backup.log 2>&1
# Archives land in data/backups/ -- the SAME disk as the live data. Set OFFSITE_DIR (a mounted share /
# synced folder / rsync-able path on another machine) to also copy each archive there, and still copy
# data/backups/ off the server some other way if OFFSITE_DIR is not set.
# Restore: stop the app, extract the archive, put pmis.db and uploads/ back into data/, start the app.
set -eu
KEEP_DAYS=14
STAMP=$(date +%Y%m%d-%H%M%S)
WORK="data/backups/.work-$STAMP"
ARCHIVE="data/backups/pmis-full-$STAMP.tar.gz"

mkdir -p data/backups

docker compose exec -T app node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
fs.mkdirSync('data/backups/.work-$STAMP', { recursive: true });
const db = new Database('data/pmis.db');
db.backup('data/backups/.work-$STAMP/pmis.db').then(() => {
  db.close();
  const copy = new Database('data/backups/.work-$STAMP/pmis.db', { readonly: true });
  const r = copy.pragma('integrity_check', { simple: true });
  copy.close();
  for (const ext of ['-wal', '-shm']) fs.rmSync('data/backups/.work-$STAMP/pmis.db' + ext, { force: true });
  if (r !== 'ok') { console.error('integrity_check failed: ' + r); process.exit(1); }
  console.log('database copy ok');
}).catch((e) => { console.error(e); process.exit(1); });
"
docker compose exec -T app node src/logTransfer.js export "data/backups/.work-$STAMP/change-logs-$STAMP.json"

# uploads/ is copied from the host side of the bind mount (cp -a keeps names/times)
[ -d data/uploads ] && cp -a data/uploads "$WORK/uploads"

tar -czf "$ARCHIVE" -C "$WORK" .
rm -rf "$WORK"
tar -tzf "$ARCHIVE" > /dev/null   # archive must be readable
echo "backup ok: $ARCHIVE"

if [ -n "${OFFSITE_DIR:-}" ]; then
  cp "$ARCHIVE" "$OFFSITE_DIR/" && echo "off-site copy ok: $OFFSITE_DIR/$(basename "$ARCHIVE")"
fi

find data/backups -name 'pmis-full-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
