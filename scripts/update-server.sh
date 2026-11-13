#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ $EUID == 0 ]] || { echo 'Запустите от root.'; exit 1; }
mode=${1:---apply}
[[ $# -le 1 && ( "$mode" == --prepare || "$mode" == --apply ) ]] || { echo 'Использование: update-server.sh --prepare|--apply'; exit 2; }
exec 9>/run/lock/ruspet-update.lock
flock -n 9 || { echo 'Другое обновление уже запущено.'; exit 1; }
repo=/root/ruspet-code
app=/opt/ruspet
branch=pilot/november-13
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/ruspet_github -o IdentitiesOnly=yes -o BatchMode=yes}"
marker=$app/.voice-tasks-release
panel=ruspet.service
telegram=ruspet-bot-proxy.service
test -f "$app/.env"
test -s "$marker"
for unit in "$panel" "$telegram"; do
 test "$(systemctl show "$unit" -p WorkingDirectory --value)" = "$app"
 test "$(systemctl show "$unit" -p User --value)" = ruspet
 systemctl is-active --quiet "$unit"
done
workers=()
for unit in ruspet-bitrix-pilot.service ruspet-bitrix-import.service; do
 if systemctl is-active --quiet "$unit"; then
  test "$(systemctl show "$unit" -p WorkingDirectory --value)" = "$app"
  workers+=("$unit")
 fi
done
git -C "$repo" fetch origin "refs/heads/$branch"
revision=$(git -C "$repo" rev-parse FETCH_HEAD)
previous=$(git -C "$repo" rev-parse "$(cat "$marker")^{commit}")
git -C "$repo" merge-base --is-ancestor "$previous" "$revision"
[[ -z ${RUSPET_UPDATE_REVISION:-} || $RUSPET_UPDATE_REVISION == "$revision" ]] || { echo "Ветка указывает на другой коммит: $revision"; exit 1; }
if [[ "$previous" == "$revision" ]]; then
 echo "Уже установлен $revision"
 exit 0
fi
stage=$(mktemp -d /root/ruspet-launch/git-release.XXXXXX)
echo "Выпуск $revision · резервная копия $stage"
mkdir "$stage/next" "$stage/previous"
git -C "$repo" archive "$revision" | tar -xf - -C "$stage/next"
git -C "$repo" diff --no-renames --name-only -z "$previous" "$revision" -- server shared scripts web ops .agents package.json package-lock.json vite.config.ts tsconfig.json > "$stage/paths"
cd "$stage/next"
build() { systemd-run --scope --quiet -p CPUQuota=60% nice -n 10 env GOMAXPROCS=1 "$@"; }
build npm ci --no-audit --no-fund
build npm run check
build npm run build
test -s dist/index.html
if [[ "$mode" == --prepare ]]; then
 echo "Готово к установке: $revision"
 exit 0
fi
cp -a "$marker" "$stage/previous/release"
while IFS= read -r -d '' path; do
 if [[ -f "$app/$path" ]]; then
  mkdir -p "$stage/previous/$(dirname "$path")"
  cp -a "$app/$path" "$stage/previous/$path"
 fi
done < "$stage/paths"
if [[ -d "$app/dist/assets" ]]; then cp -a --update=none "$app/dist/assets/." "$stage/next/dist/assets/"; fi
cd "$app"
runuser -u ruspet -- node --import tsx --input-type=module <<'JS'
import {pool} from './server/db.ts';
try {
 if((await pool.query('SELECT current_database() AS name')).rows[0].name!=='ruspet_demo')throw Error('Unexpected application database');
} finally {await pool.end();}
JS
runuser -u postgres -- pg_dump -Fc ruspet_demo > "$stage/previous/main.dump"
if runuser -u postgres -- psql -XAtqc "SELECT 1 FROM pg_database WHERE datname='ruspet_okb'" | grep -qx 1; then
 runuser -u postgres -- pg_dump -Fc ruspet_okb > "$stage/previous/okb.dump"
fi
chmod 600 "$stage"/previous/*.dump
rollback() {
 local status=$?
 trap - ERR
 set +e
 echo "Сбой установки. Восстанавливаем предыдущий выпуск из $stage/previous"
 systemctl stop "$panel" "$telegram" "${workers[@]}"
 while IFS= read -r -d '' path; do
  if [[ -f "$stage/previous/$path" ]]; then cp -a "$stage/previous/$path" "$app/$path"
  elif [[ -f "$app/$path" ]]; then unlink "$app/$path"; fi
 done < "$stage/paths"
 for dir in dist node_modules; do
  if [[ -d "$stage/previous/$dir" ]]; then
   if [[ -d "$app/$dir" ]]; then mv "$app/$dir" "$stage/failed-$dir"; fi
   mv "$stage/previous/$dir" "$app/$dir"
  fi
 done
 cp -a "$stage/previous/release" "$marker"
 systemctl start "$panel" "$telegram" "${workers[@]}"
 exit "$status"
}
trap rollback ERR
systemctl stop "$telegram" "${workers[@]}"
while IFS= read -r -d '' path; do
 if [[ -f "$stage/next/$path" ]]; then
  install -D -m "$(stat -c %a "$stage/next/$path")" "$stage/next/$path" "$app/$path"
 elif [[ -f "$app/$path" ]]; then unlink "$app/$path"; fi
done < "$stage/paths"
mv "$app/node_modules" "$stage/previous/node_modules"
mv "$stage/next/node_modules" "$app/node_modules"
runuser -u ruspet -- env PGOPTIONS='-c lock_timeout=5000' node --import tsx --input-type=module <<'JS'
import {pool} from './server/db.ts';
import {migrate} from './scripts/migrate.ts';
import {createApp} from './server/app.ts';
try {
 const status=(await pool.query("SELECT enabled FROM bitrix_live_config WHERE id=1")).rows[0]?.enabled;
 await migrate();
 createApp();
 if((await pool.query("SELECT enabled FROM bitrix_live_config WHERE id=1")).rows[0]?.enabled!==status)throw Error('Bitrix exchange switch changed during migration.');
} finally {await pool.end();}
JS
mv "$app/dist" "$stage/previous/dist"
mv "$stage/next/dist" "$app/dist"
systemctl restart "$panel"
systemctl start "$telegram" "${workers[@]}"
ready=false
for attempt in {1..20}; do
 if curl --max-time 3 -fsS http://127.0.0.1:4310/api/health > "$stage/health.json" 2>/dev/null; then ready=true; break; fi
 sleep 1
done
[[ "$ready" == true ]]
curl --max-time 5 -fsS http://127.0.0.1:4310/ | cmp -s - "$app/dist/index.html"
systemctl is-active --quiet "$panel" "$telegram" "${workers[@]}"
printf '%s\n' "$revision" > "$marker"
trap - ERR
cat "$stage/health.json"
printf '\nУстановлен %s. Резервная копия: %s/previous\n' "$revision" "$stage"
