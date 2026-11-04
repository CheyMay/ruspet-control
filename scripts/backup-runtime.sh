#!/usr/bin/env bash
set -euo pipefail
umask 077
archive=/var/backups/ruspet
status=/var/lib/ruspet/maintenance
install -d -m 0700 "$archive"
install -d -m 0755 "$status"
exec 9>"$archive/.lock"
flock 9
mode=${1:?backup or restore}
db=${RUSPET_BACKUP_DB:-ruspet_demo}
[[ $mode == backup || $mode == restore ]]
[[ $db =~ ^[a-z][a-z0-9_]*$ ]]
stamp=$(date -u +%Y%m%dT%H%M%S%N)
tmpdb=
part=
cleanup() {
  result=$?
  trap - EXIT
  if [[ $tmpdb =~ ^ruspet_verify_[0-9]+$ && $tmpdb != "$db" ]]; then
    runuser -u postgres -- dropdb "$tmpdb" || result=1
  fi
  if [[ -n $part ]]; then rm -f -- "$part" "$part.sha256"; fi
  printf '{"at":"%s","ok":%s}\n' "$(date -u +%FT%TZ)" "$([[ $result == 0 ]] && echo true || echo false)" > "$status/$mode.attempt.tmp"
  chmod 0644 "$status/$mode.attempt.tmp"
  mv -f "$status/$mode.attempt.tmp" "$status/$mode.attempt.json"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
shopt -s nullglob
if [[ $mode == backup ]]; then
  file="ruspet-$stamp.dump"
  part="$archive/$file.part"
  runuser -u postgres -- pg_dump -Fc -Z 3 --dbname="$db" > "$part"
  pg_restore --list "$part" >/dev/null
  digest=$(sha256sum "$part")
  printf '%s  %s\n' "${digest%% *}" "$file" > "$part.sha256"
  mv "$part.sha256" "$archive/$file.sha256"
  mv "$part" "$archive/$file"
  files=("$archive"/ruspet-*.dump)
  verified=$(cat "$archive/.verified" 2>/dev/null || true)
  for ((i=0; i<${#files[@]}-14; i++)); do
    old=${files[i]##*/}
    if [[ $old =~ ^ruspet-[0-9]{8}T[0-9]{15}\.dump$ && $old != "$verified" ]]; then
      rm -- "${files[i]}" "${files[i]}.sha256"
    fi
  done
  files=("$archive"/ruspet-*.dump)
  printf '{"at":"%s","copies":%s,"bytes":%s}\n' "$(date -u +%FT%TZ)" "${#files[@]}" "$(stat -c %s "$archive/$file")" > "$status/backup.tmp"
else
  files=("$archive"/ruspet-*.dump)
  (( ${#files[@]} > 0 ))
  file=${files[-1]##*/}
  (cd "$archive"; sha256sum --check --status "$file.sha256")
  candidate="ruspet_verify_$(date -u +%s%N)"
  [[ $candidate != "$db" ]]
  runuser -u postgres -- createdb --template=template0 "$candidate"
  tmpdb=$candidate
  runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges --dbname="$tmpdb" < "$archive/$file"
  counts=$(runuser -u postgres -- psql -XAtq --set=ON_ERROR_STOP=1 --dbname="$tmpdb" -c "SELECT json_build_object('tasks',(SELECT count(*) FROM tasks),'users',(SELECT count(*) FROM users),'events',(SELECT count(*) FROM task_events),'approvals',(SELECT count(*) FROM approvals),'migrations',(SELECT count(*) FROM schema_migrations));")
  runuser -u postgres -- dropdb "$tmpdb"
  tmpdb=
  printf '%s\n' "$file" > "$archive/.verified"
  printf '{"at":"%s","rows":%s}\n' "$(date -u +%FT%TZ)" "$counts" > "$status/restore.tmp"
fi
chmod 0644 "$status/$mode.tmp"
mv -f "$status/$mode.tmp" "$status/$mode.json"
