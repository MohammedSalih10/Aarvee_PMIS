#!/bin/sh
# Consistent online backup of the SQLite DB (safe in WAL mode, app keeps running).
# Run from the project folder (where docker-compose.yml is), e.g. daily from cron:
#   15 2 * * * cd /opt/aarvee-pmis && ./deploy/backup.sh >> data/backups/backup.log 2>&1
# Backups land in data/backups/. Uploads already live in data/uploads/, so copy the
# whole data/ folder (or at least backups/ + uploads/) off the server as well.
set -eu
KEEP_DAYS=14
STAMP=$(date +%Y%m%d-%H%M%S)

docker compose exec -T app node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
fs.mkdirSync('data/backups', { recursive: true });
const db = new Database('data/pmis.db');
db.backup('data/backups/pmis-$STAMP.db').then(() => { console.log('backup ok: pmis-$STAMP.db'); db.close(); })
  .catch((e) => { console.error(e); process.exit(1); });
"
find data/backups -name 'pmis-*.db' -mtime +"$KEEP_DAYS" -delete
