#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
config=/etc/ruspet-offsite
status=/var/lib/ruspet/offsite-maintenance
install -d -m 0755 "$status"
exec 9>"$status/.lock"
flock -n 9
work=
cleanup() {
 result=$?
 trap - EXIT
 if [[ -n $work ]]; then
  rm -f -- "$work/main.dump" "$work/okb.dump" "$work/checksums" "$work/bundle.tar" "$work/bundle.cms"
  rmdir -- "$work"
 fi
 ok=false; if ((result==0)); then ok=true; fi
 printf '{"at":"%s","ok":%s}\n' "$(date -u +%FT%TZ)" "$ok" > "$status/backup.attempt.tmp"
 chmod 0644 "$status/backup.attempt.tmp"
 mv -T -- "$status/backup.attempt.tmp" "$status/backup.attempt.json"
 exit "$result"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
day=$(TZ=Europe/Moscow date +%Y%m%d)
work=$(mktemp -d)
copy_dump() (
 local source=$1 name=$2 file
 cd "$source"
 exec 8<.lock
 flock -w 60 -s 8
 shopt -s nullglob
 local files=(ruspet-"$day"T*.dump)
 if ((${#files[@]}==0)); then echo "Missing current $name database dump" >&2; return 1; fi
 file=${files[-1]}
 sha256sum --check --status "$file.sha256"
 cp -- "$file" "$work/$name.dump"
)
copy_dump /var/backups/ruspet main
copy_dump /var/backups/ruspet-okb okb
cd "$work"
sha256sum main.dump okb.dump > checksums
pair=$(sha256sum checksums); pair=${pair%% *}
tar -cf bundle.tar main.dump okb.dump checksums
openssl cms -encrypt -aes-256-gcm -binary -outform DER -in bundle.tar -out bundle.cms "$config/recipient-cert.pem"
digest=$(sha256sum bundle.cms); digest=${digest%% *}
size=$(stat -c %s bundle.cms)
reply=$(ssh -F "$config/ssh.conf" ruspet-offsite "store $day $pair $digest $size" < bundle.cms)
[[ $reply == "Stored ruspet-$day-$pair.cms" ]]
printf '{"at":"%s","bytes":%s}\n' "$(date -u +%FT%TZ)" "$size" > "$status/backup.tmp"
chmod 0644 "$status/backup.tmp"
mv -T -- "$status/backup.tmp" "$status/backup.json"
printf '%s\n' "$reply"
