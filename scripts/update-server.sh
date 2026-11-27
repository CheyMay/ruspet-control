#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ $EUID == 0 ]] || { echo 'Запустите от root.'; exit 1; }
mode=${1:---apply}
case "$mode:$#" in
 --apply:0|--apply:1|--prepare:1|--rollback:2|--prune-builds:1) ;;
 *) echo 'Использование: update-server.sh --apply | --prepare | --rollback SHA | --prune-builds'; exit 2 ;;
esac
exec 9>/run/lock/ruspet-update.lock
flock -n 9 || { echo 'Другое обновление уже запущено.'; exit 1; }
repo=/root/ruspet-code
app=/opt/ruspet
branch=pilot/november-13
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/ruspet_github -o IdentitiesOnly=yes -o BatchMode=yes}"
marker=$app/.voice-tasks-release
panel=ruspet.service
telegram=ruspet-bot-proxy.service

if [[ "$mode" == --prune-builds ]]; then
 for old_stage in /root/ruspet-launch/git-release.??????; do
  [[ -d "$old_stage" && ! -L "$old_stage" && ! -L "$old_stage/previous" ]] || continue
  rm -rf --one-file-system -- "$old_stage/next" "$old_stage/previous/node_modules" "$old_stage/previous/dist" \
   "$old_stage/failed-node_modules" "$old_stage/failed-dist"
 done
 df -h "$app" /root
 exit 0
fi

test -f "$app/.env"
test -s "$marker"
for unit in "$panel" "$telegram"; do
 test "$(systemctl show "$unit" -p WorkingDirectory --value)" = "$app"
 test "$(systemctl show "$unit" -p User --value)" = ruspet
 if [[ "$mode" != --rollback ]]; then systemctl is-active --quiet "$unit"; fi
done
units=("$panel" "$telegram")
for unit in ruspet-bitrix-pilot.service ruspet-bitrix-import.service ruspet-bitrix-inbound.service; do
 if systemctl is-active --quiet "$unit"; then
  test "$(systemctl show "$unit" -p WorkingDirectory --value)" = "$app"
  units+=("$unit")
 fi
done

git -C "$repo" fetch origin "refs/heads/$branch"
revision=$(git -C "$repo" rev-parse FETCH_HEAD)
previous=$(git -C "$repo" rev-parse "$(cat "$marker")^{commit}")
if [[ "$mode" == --rollback ]]; then
 revision=$(git -C "$repo" rev-parse --verify --end-of-options "$2^{commit}")
 git -C "$repo" merge-base --is-ancestor "$revision" FETCH_HEAD
 git -C "$repo" merge-base --is-ancestor "$revision" "$previous"
else
 git -C "$repo" merge-base --is-ancestor "$previous" "$revision"
fi
[[ -z ${RUSPET_UPDATE_REVISION:-} || $RUSPET_UPDATE_REVISION == "$revision" ]] || { echo "Выбран другой коммит: $revision"; exit 1; }
if [[ "$previous" == "$revision" ]]; then
 echo "Уже установлен $revision"
 exit 0
fi
echo "Выпуск $revision. Сейчас установлен $previous"
df -h "$app"

stage=$(mktemp -d "$app/.deploy.XXXXXX")
keep_stage=false
trap 'if [[ "$keep_stage" == false ]]; then rm -rf --one-file-system -- "$stage"; fi' EXIT
mkdir "$stage/next" "$stage/previous"
git -C "$repo" archive "$revision" | tar -xf - -C "$stage/next"
git -C "$repo" diff --no-renames --name-only -z "$previous" "$revision" -- server shared scripts web ops .agents package.json package-lock.json vite.config.ts tsconfig.json > "$stage/paths"
cd "$stage/next"
build() { systemd-run --scope --quiet -p CPUQuota=60% nice -n 10 env GOMAXPROCS=1 "$@"; }
new_dependencies=true
if cmp -s package.json "$app/package.json" &&
   cmp -s package-lock.json "$app/package-lock.json" &&
   [[ -x "$app/node_modules/.bin/vite" && -x "$app/node_modules/.bin/tsc" && -x "$app/node_modules/.bin/tsx" ]]; then
 ln -s "$app/node_modules" node_modules
 new_dependencies=false
else
 build npm ci --no-audit --no-fund --cache "$stage/npm-cache"
 rm -rf -- "$stage/npm-cache"
fi
build npm run check
build npm run build
test -s dist/index.html
if [[ "$mode" == --prepare ]]; then
 echo "Готово к установке: $revision"
 exit 0
fi

migrate_main=false
migrate_okb=false
if [[ "$mode" == --apply ]]; then
 if ! git -C "$repo" diff --quiet "$previous" "$revision" -- server/migrations scripts/migrate.ts; then migrate_main=true; fi
 if ! git -C "$repo" diff --quiet "$previous" "$revision" -- server/okb-schema.sql; then migrate_okb=true; fi
fi
cd "$app"
while IFS= read -r -d '' path; do
 if [[ -f "$app/$path" ]]; then
  mkdir -p "$stage/previous/$(dirname "$path")"
  cp -a "$app/$path" "$stage/previous/$path"
 fi
done < "$stage/paths"

copy_paths() {
 local source=$1 path
 while IFS= read -r -d '' path; do
  if [[ -f "$source/$path" ]]; then
   mkdir -p "$(dirname "$app/$path")" && cp -a -- "$source/$path" "$app/$path" || return 1
  elif [[ -f "$app/$path" ]]; then
   unlink "$app/$path" || return 1
  fi
 done < "$stage/paths"
}
check_service() {
 local attempt unit ready=false
 for attempt in {1..20}; do
  if curl --max-time 3 -fsS http://127.0.0.1:4310/api/health > "$stage/health.json" 2>/dev/null; then
   ready=true
   break
  fi
  sleep 1
 done
 [[ "$ready" == true ]] || return 1
 curl --max-time 5 -fsS http://127.0.0.1:4310/ | cmp -s - "$app/dist/index.html" || return 1
 for unit in "${units[@]}"; do systemctl is-active --quiet "$unit" || return 1; done
}
write_release() {
 printf '%s\n' "$1" > "$stage/revision" && mv -f -- "$stage/revision" "$marker"
}
restore_previous() {
 local dir
 systemctl stop "${units[@]}" || return 1
 copy_paths "$stage/previous" || return 1
 for dir in dist node_modules; do
  if [[ -d "$stage/previous/$dir" ]]; then
   if [[ -d "$app/$dir" ]]; then mv "$app/$dir" "$stage/failed-$dir" || return 1; fi
   mv "$stage/previous/$dir" "$app/$dir" || return 1
  fi
 done
 write_release "$previous" || return 1
 systemctl start "${units[@]}" && check_service
}
rollback() {
 local status=$1
 trap - ERR INT TERM
 echo "Сбой установки. Возвращаем выпуск $previous."
 if restore_previous; then
  keep_stage=false
  echo "Восстановлен $previous."
 else
  echo "Автоматический откат не завершён. Временные файлы сохранены в $stage." >&2
 fi
 exit "$status"
}

keep_stage=true
trap 'rollback "$?"' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
systemctl stop "${units[@]}"
copy_paths "$stage/next"
if [[ "$new_dependencies" == true ]]; then
 if [[ -d "$app/node_modules" ]]; then mv "$app/node_modules" "$stage/previous/node_modules"; fi
 mv "$stage/next/node_modules" "$app/node_modules"
fi
runuser -u ruspet -- env PGOPTIONS='-c lock_timeout=5000' node --import tsx --input-type=module - "$migrate_main" "$migrate_okb" <<'JS'
import {pool} from './server/db.ts';
import {migrate} from './scripts/migrate.ts';
import {migrateOkb,okbConfigured,closeOkb} from './server/okb.ts';
import {createApp} from './server/app.ts';
const [, , main, okb]=process.argv;
try {
 if((await pool.query('SELECT current_database() AS name')).rows[0].name!=='ruspet_demo')throw Error('Unexpected application database');
 const status=(await pool.query("SELECT enabled FROM bitrix_live_config WHERE id=1")).rows[0]?.enabled;
 if(main==='true')await migrate();
 if(okb==='true'&&okbConfigured())await migrateOkb();
 createApp();
 if((await pool.query("SELECT enabled FROM bitrix_live_config WHERE id=1")).rows[0]?.enabled!==status)throw Error('Bitrix exchange switch changed during migration.');
} finally {await closeOkb();await pool.end();}
JS
if [[ -d "$app/dist" ]]; then mv "$app/dist" "$stage/previous/dist"; fi
mv "$stage/next/dist" "$app/dist"
systemctl start "${units[@]}"
check_service
write_release "$revision"
trap - ERR INT TERM
keep_stage=false
cat "$stage/health.json"
printf '\nУстановлен %s\n' "$revision"
