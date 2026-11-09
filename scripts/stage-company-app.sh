#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ $EUID == 0 ]] || { echo 'Запустите от root.'; exit 1; }
repo=/root/ruspet-code
app=/opt/ruspet
exec 9>/run/lock/ruspet-update.lock
flock -n 9 || { echo 'Другая установка или обновление уже запущены.'; exit 1; }
for unit in ruspet.service ruspet-bot-proxy.service ruspet-bitrix-pilot.service ruspet-bitrix-import.service; do
 if systemctl is-active --quiet "$unit"; then
  echo 'На сервере уже работает РУСПЭТ. Используйте штатный updater вместо первоначальной установки.'
  exit 1
 fi
done
[[ -d "$repo/.git" && -d "$app" && ! -L "$app" ]]
for target in node_modules dist; do [[ ! -L "$app/$target" ]]; done
id -u ruspet >/dev/null
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major!==22||minor<12)process.exit(1)'
cd "$repo"
git diff --quiet
git diff --cached --quiet
[[ $(git rev-parse --show-toplevel) == "$repo" ]]

npm ci --no-audit --no-fund
npm run check
npm run build

git archive HEAD | tar -xf - -C "$app"
install -d -o root -g root -m 0755 "$app/node_modules" "$app/dist"
rsync -a --delete --chown=root:root "$repo/node_modules/" "$app/node_modules/"
rsync -a --delete --chown=root:root "$repo/dist/" "$app/dist/"
cmp "$repo/dist/index.html" "$app/dist/index.html"
cmp "$repo/dist/theme-init.js" "$app/dist/theme-init.js"
git rev-parse --short HEAD
printf '\nКод собран и установлен в /opt/ruspet.\n'
printf 'Следующий этап: перенос действующей БД и приватной конфигурации со старого сервера.\n'
printf 'Панель, Telegram и Bitrix на новом сервере пока не запущены.\n'
