#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
archive=/var/backups/ruspet-offsite
pattern='^store ([0-9]{8}) ([a-f0-9]{64}) ([a-f0-9]{64}) ([1-9][0-9]{0,8})$'
[[ ${SSH_ORIGINAL_COMMAND:-} =~ $pattern ]] || exit 2
day=${BASH_REMATCH[1]} pair=${BASH_REMATCH[2]} digest=${BASH_REMATCH[3]} size=${BASH_REMATCH[4]}
[[ $day == "$(TZ=Europe/Moscow date +%Y%m%d)" && $size -le 134217728 ]] || exit 2

cd "$archive"
exec 9>.lock
flock -w 15 9
tmp=$(mktemp .incoming.XXXXXX)
trap 'rm -f -- "$tmp" "$tmp.sha256"' EXIT
timeout 120 head -c "$((size+1))" > "$tmp"
[[ $(stat -c %s "$tmp") == "$size" ]]
printf '%s  %s\n' "$digest" "$tmp" | sha256sum --check --status
file=ruspet-$day-$pair.cms
if [[ -e $file ]]; then
 sha256sum --check --status "$file.sha256"
else
 printf '%s  %s\n' "$digest" "$file" > "$tmp.sha256"
 sync -d "$tmp" "$tmp.sha256"
 mv -T -- "$tmp.sha256" "$file.sha256"
 mv -T -- "$tmp" "$file"
 sync -f .
fi
printf 'Stored %s\n' "$file"
