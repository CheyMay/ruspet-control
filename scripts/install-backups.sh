#!/usr/bin/env bash
set -euo pipefail
profile=${1:-main}
case "$profile" in
  main) unit=ruspet-db; backup='03:30:00'; restore='04:15:00' ;;
  okb) unit=ruspet-okb; backup='03:45:00'; restore='04:30:00' ;;
  *) exit 2 ;;
esac
src=$(dirname "$(realpath "$0")")
install -D -o root -g root -m 0755 "$src/backup-runtime.sh" /usr/local/lib/ruspet/backup-runtime.sh
for mode in backup restore; do
  schedule="*-*-* $backup Europe/Moscow"
  if [[ $mode == restore ]]; then schedule="Sun *-*-* $restore Europe/Moscow"; fi
  cat > "/etc/systemd/system/$unit-$mode.service" <<UNIT
[Unit]
Description=RUSPET PostgreSQL $mode
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/ruspet/backup-runtime.sh $mode $profile
Nice=15
CPUQuota=35%
TimeoutStartSec=45min
UNIT
  cat > "/etc/systemd/system/$unit-$mode.timer" <<UNIT
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
systemctl enable --now "$unit-backup.timer" "$unit-restore.timer"
