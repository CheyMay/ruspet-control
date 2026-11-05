#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
# Run the reviewed script from /root, outside the checkout that it updates.
[[ $EUID == 0 ]] || { echo 'Запустите обновление от root.'; exit 1; }
exec 9>/run/lock/ruspet-update.lock
flock -n 9 || { echo 'Другое обновление уже запущено.'; exit 1; }
repo=/root/ruspet-code
app=/opt/ruspet
backup=/root/ruspet-before-$(date -u +%Y%m%dT%H%M%S)
export GIT_SSH_COMMAND='ssh -i /root/.ssh/ruspet_github -o IdentitiesOnly=yes'
test -f "$app/.env"
test "$(systemctl show ruspet.service -p WorkingDirectory --value)" = "$app"
test "$(systemctl show ruspet.service -p User --value)" = ruspet
cd "$app"
# Verify that the documented backup database names match this installation.
runuser -u ruspet -- node --import tsx --input-type=module <<'JS'
import 'dotenv/config';
import pg from 'pg';
const {pool}=await import('./server/db.ts');
try {
  const database=(await pool.query('SELECT current_database() name')).rows[0].name;
  if(database!=='ruspet_demo') throw Error('Имя рабочей БД отличается: нужна адаптация команды резервного копирования.');
  if(process.env.OKB_DATABASE_URL && new pg.Client({connectionString:process.env.OKB_DATABASE_URL}).connectionParameters.database!=='ruspet_okb')
    throw Error('Имя БД ОКБ отличается: нужна адаптация команды резервного копирования.');
} finally { await pool.end(); }
JS
cd "$repo"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'В репозитории есть несохранённые правки. Остановились до обновления.'
  exit 1
fi
git fetch origin refs/heads/feature/company-delegation:refs/remotes/origin/feature/company-delegation
git switch feature/company-delegation
git pull --ff-only origin feature/company-delegation
systemd-run --scope --quiet -p CPUQuota=60% nice -n 10 env GOMAXPROCS=1 npm ci --no-audit --no-fund
systemd-run --scope --quiet -p CPUQuota=60% nice -n 10 npm run check
systemd-run --scope --quiet -p CPUQuota=60% nice -n 10 env GOMAXPROCS=1 npm run build
services=(ruspet.service)
if systemctl is-active --quiet ruspet-bot-proxy.service; then
  test "$(systemctl show ruspet-bot-proxy.service -p WorkingDirectory --value)" = "$app"
  services+=(ruspet-bot-proxy.service)
fi
install -d -m 700 "$backup"
trap 'echo "Обновление остановлено из-за ошибки. Не выполняйте повторный импорт задач. Резервные файлы: $backup"' ERR
systemctl stop "${services[@]}"
if systemctl is-active --quiet ruspet-bitrix-pilot.service; then
  systemctl stop ruspet-bitrix-pilot.service
fi
runuser -u postgres -- pg_dump -Fc ruspet_demo > "$backup/main.dump"
if runuser -u postgres -- psql -XAtqc "SELECT 1 FROM pg_database WHERE datname='ruspet_okb'" | grep -qx 1; then
  runuser -u postgres -- pg_dump -Fc ruspet_okb > "$backup/okb.dump"
fi
systemd-run --scope --quiet -p CPUQuota=60% nice -n 10 tar --exclude='./node_modules' --exclude='./.git' -czf "$backup/app.tar.gz" -C "$app" .
git archive HEAD | tar -xf - -C "$app"
if [ -d "$app/node_modules" ]; then
  mv "$app/node_modules" "$backup/node_modules"
fi
cp -a "$repo/node_modules" "$app/node_modules"
mkdir -p "$app/dist"
cp -a "$repo/dist/." "$app/dist/"
cd "$app"
runuser -u ruspet -- node --import tsx --input-type=module <<'JS'
import 'dotenv/config';
const {pool}=await import('./server/db.ts');
const {migrate}=await import('./scripts/migrate.ts');
const {migrateOkb,okbConfigured,closeOkb}=await import('./server/okb.ts');
try {
  await migrate();
  if(okbConfigured()) await migrateOkb();
  else console.log('ОКБ не настроена: пока доступен ручной выбор менеджера.');
  await pool.query('UPDATE bitrix_live_config SET enabled=false WHERE id=1');
  console.log('Миграции готовы. Обмен с Битрикс24 выключен.');
} finally {
  await closeOkb();
  await pool.end();
}
JS
systemctl start "${services[@]}"
ready=false
for attempt in {1..15}; do
  if curl -fsS http://127.0.0.1:4310/api/health > "$backup/health.json"; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]]
curl -fsS http://127.0.0.1:4310/ -o "$backup/served-index.html"
cmp "$app/dist/index.html" "$backup/served-index.html"
curl -fsS http://127.0.0.1:4310/theme-init.js -o "$backup/served-theme-init.js"
cmp "$app/dist/theme-init.js" "$backup/served-theme-init.js"
systemctl is-active "${services[@]}"
echo "Обновлено. Резервная копия: $backup"
