#!/usr/bin/env bash
# Firestore automated backup (production projects).
#
# Wraps `gcloud firestore export` so zero data loss doesn't depend on someone
# remembering the console. Schedule it (Cloud Scheduler -> Cloud Run job, or
# cron on any machine with gcloud + Firestore Owner/IAM rights):
#
#   PROJECT_ID=mediflow-prod BACKUP_BUCKET=gs://mediflow-prod-backups \
#     bash tools/firestore-backup.sh
#
# Env:
#   PROJECT_ID     (required) Firebase/GCP project id
#   BACKUP_BUCKET  (required) gs:// bucket for exports (must exist, versioned)
#   COLLECTIONS    (optional) comma-separated collection ids to export; empty = all
#   RETENTION_DAYS (optional, default 30) delete exports older than N days
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to the Firebase project id.}"
: "${BACKUP_BUCKET:?Set BACKUP_BUCKET to a gs:// bucket for exports.}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="${BACKUP_BUCKET}/${PROJECT_ID}/${STAMP}"

if [ -n "${COLLECTIONS:-}" ]; then
  # shellcheck disable=SC2206
  IDS=( ${COLLECTIONS//,/ } )
  gcloud firestore export "$DEST" --project="$PROJECT_ID" --collection-ids="${IDS[*]}" --quiet
else
  gcloud firestore export "$DEST" --project="$PROJECT_ID" --quiet
fi
echo "firestore export ok: $DEST"

# Prune exports older than retention (export dirs are named YYYYMMDD-HHMMSS).
if [ "$RETENTION_DAYS" -ge 0 ]; then
  CUTOFF="$(date -u -d "$RETENTION_DAYS days ago" +%Y%m%d 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y%m%d)"
  gcloud storage ls "${BACKUP_BUCKET}/${PROJECT_ID}/" 2>/dev/null | while read -r line; do
    name="$(basename "$line")"
    day="${name:0:8}"
    if [[ "$day" =~ ^[0-9]{8}$ ]] && [[ "$day" < "$CUTOFF" ]]; then
      gcloud storage rm --recursive "$line" --quiet && echo "pruned: $line"
    fi
  done
fi
