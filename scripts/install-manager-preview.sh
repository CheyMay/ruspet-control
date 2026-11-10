#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
exec 9>/run/lock/ruspet-update.lock
flock -n 9 || { echo 'Идёт другое обновление РУСПЭТ.'; exit 1; }
[[ $EUID == 0 ]] || { echo 'Запустите на старом сервере от root.'; exit 1; }
systemctl is-active --quiet ruspet.service || { echo 'Нужен старый сервер с работающим РУСПЭТ.'; exit 1; }
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
(( available_kb >= 393216 )) || { echo 'Для отдельного стенда нужно хотя бы 384 МБ доступной памяти.'; exit 1; }
src=/opt/ruspet
passwords_stdin=false
while (( $# )); do
 case "$1" in
  --source) src=${2:?Укажите каталог подготовленного выпуска.}; shift 2 ;;
  --passwords-stdin) passwords_stdin=true; shift ;;
  *) echo 'Неизвестный параметр установки.'; exit 1 ;;
 esac
done
if [[ "$src" != /opt/ruspet ]]; then
 [[ "$src" =~ ^/root/ruspet-manager-release\.[a-zA-Z0-9]+$ && ! -L "$src" && $(stat -c '%u:%a' "$src") == 0:700 ]] || {
  echo 'Нужен закрытый каталог подготовленного выпуска в /root.'; exit 1;
 }
fi
home=/opt/ruspet-manager-preview
[[ -f "$src/scripts/seed.ts" && -d "$src/node_modules" && -f "$src/dist/index.html" ]]
required_bytes=$(du -sb "$src/node_modules" "$src/server" "$src/shared" "$src/scripts" "$src/dist" | awk '{sum+=$1} END{print sum}')
available_bytes=$(df -PB1 /opt | awk 'NR==2 {print $4}')
(( available_bytes > required_bytes + 1073741824 )) || { echo 'Для копии кода и запаса нужен дополнительный свободный диск.'; exit 1; }
[[ ! -e "$home" && ! -e /etc/systemd/system/ruspet-manager-preview.service ]] || {
 echo 'Тестовый стенд уже существует. Автоматически перезаписывать его данные нельзя.'; exit 1;
}
[[ -z $(ss -H -lnt 'sport = :4320') ]] || { echo 'Порт 4320 уже занят.'; exit 1; }
cd /
if runuser -u postgres -- psql -XAtq -d postgres -c "SELECT 1 FROM pg_database WHERE datname='ruspet_manager_preview'" | grep -qx 1; then
 echo 'Тестовая БД уже существует. Она не изменена.'; exit 1;
fi
if id -u ruspetpreview >/dev/null 2>&1 || runuser -u postgres -- psql -XAtq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='ruspetpreview'" | grep -qx 1; then
 echo 'Имя служебного пользователя уже занято. Установка остановлена.'; exit 1;
fi
if $passwords_stdin; then
 IFS= read -r preview_password
 IFS= read -r admin_password
 preview_confirm=$preview_password
 [[ ${#admin_password} -ge 12 && ${#admin_password} -le 200 && "$admin_password" != "$preview_password" ]] || {
  echo 'Пароль учебного администратора должен отличаться от пароля менеджера и содержать 12–200 символов.'; exit 1;
 }
else
 IFS= read -r -s -p 'Задайте пароль для test.manager (минимум 12 символов): ' preview_password </dev/tty
 printf '\n' >/dev/tty
 IFS= read -r -s -p 'Повторите пароль: ' preview_confirm </dev/tty
 printf '\n' >/dev/tty
fi
[[ ${#preview_password} -ge 12 && ${#preview_password} -le 200 && "$preview_password" == "$preview_confirm" ]] || {
 echo 'Пароли различаются или длина не подходит. Данные не менялись.'; exit 1;
}
printf '%s' "$preview_password" | node -e 'let v="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>v+=c);process.stdin.on("end",()=>{if(v.length<12||v.length>200)process.exit(1)});'
useradd --system --user-group --home-dir "$home" --shell /usr/sbin/nologin ruspetpreview
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres \
 -c 'CREATE ROLE ruspetpreview LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 8;'
runuser -u postgres -- createdb --owner=ruspetpreview --encoding=UTF8 --template=template0 ruspet_manager_preview
install -d -o root -g root -m 0755 "$home"
install -d -o ruspetpreview -g ruspetpreview -m 0700 "$home/.local"
for part in server shared scripts dist node_modules; do
 cp -a "$src/$part" "$home/$part"
 chown -R root:ruspetpreview "$home/$part"
 chmod -R u+rwX,g+rX,o-rwx "$home/$part"
done
install -o root -g ruspetpreview -m 0640 "$src/package.json" "$home/package.json"
if [[ -f "$src/.release-version" ]]; then
 install -o root -g ruspetpreview -m 0640 "$src/.release-version" "$home/.release-version"
fi
cat > "$home/.env" <<'ENV'
DATABASE_URL=postgresql:///ruspet_manager_preview?host=/var/run/postgresql&user=ruspetpreview
HOST=127.0.0.1
PORT=4320
NODE_ENV=production
DEMO_AUTH=false
TASK_PROVIDER=mock
TELEGRAM_WORKER_DISABLED=true
BITRIX_WRITE_ENABLED=false
ENV
chown root:ruspetpreview "$home/.env"
chmod 0640 "$home/.env"
cd "$home"
if $passwords_stdin; then
 printf '%s\n%s' "$preview_password" "$admin_password"
else
 printf '%s' "$preview_password"
fi | runuser -u ruspetpreview -- \
 env DOTENV_CONFIG_PATH="$home/.env" GOMAXPROCS=1 \
 node --import tsx "$home/scripts/setup-manager-preview.ts"
unset preview_password preview_confirm admin_password
cat > /etc/systemd/system/ruspet-manager-preview.service <<'UNIT'
[Unit]
Description=RUSPET isolated manager demonstration
After=network.target postgresql.service

[Service]
Type=simple
User=ruspetpreview
Group=ruspetpreview
WorkingDirectory=/opt/ruspet-manager-preview
EnvironmentFile=/opt/ruspet-manager-preview/.env
Environment=DOTENV_CONFIG_PATH=/opt/ruspet-manager-preview/.env
Environment=NODE_OPTIONS=--max-old-space-size=192
Environment=GOMAXPROCS=1
ExecStart=/usr/bin/env node --import tsx /opt/ruspet-manager-preview/scripts/manager-preview-server.ts
Restart=on-failure
RestartSec=5
CPUQuota=35%
MemoryMax=384M
Nice=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
InaccessiblePaths=-/opt/ruspet
ReadWritePaths=/opt/ruspet-manager-preview/.local

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ruspet-manager-preview.service
ready=false
for attempt in {1..15}; do
 if curl -fsS http://127.0.0.1:4320/api/health >/dev/null; then ready=true; break; fi
 sleep 1
done
[[ $ready == true ]]
echo 'Стенд готов: 127.0.0.1:4320. Логин менеджера: test.manager.'
echo 'Откройте порт 4320 через SSH-туннель PuTTY. Основной сайт и бот продолжают работать.'
