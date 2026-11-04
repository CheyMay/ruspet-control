#!/usr/bin/env bash
set -euo pipefail
src=$(dirname "$(realpath "$0")")
install -D -o root -g root -m 0755 "$src/backup-runtime.sh" /usr/local/lib/ruspet/backup-runtime.sh
for mode in backup restore; do
  schedule='*-*-* 03:30:00 Europe/Moscow'
  if [[ $mode == restore ]]; then schedule='Sun *-*-* 04:15:00 Europe/Moscow'; fi
  cat > "/etc/systemd/system/ruspet-db-$mode.service" <<UNIT
[Unit]
Description=RUSPET PostgreSQL $mode
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/ruspet/backup-runtime.sh $mode
Nice=15
CPUQuota=35%
TimeoutStartSec=45min
UNIT
  cat > "/etc/systemd/system/ruspet-db-$mode.timer" <<UNIT
[Unit]
Description=Schedule RUSPET PostgreSQL $mode

[Timer]
OnCalendar=$schedule
Persistent=true

[Install]
WantedBy=timers.target
UNIT
done
systemctl daemon-reload
systemctl enable --now ruspet-db-backup.timer ruspet-db-restore.timer
