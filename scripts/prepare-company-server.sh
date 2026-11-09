#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ $EUID == 0 ]] || { echo 'Запустите от root.'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Этот блок подготовлен для Ubuntu 24.04.'; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { echo 'Нужна архитектура amd64.'; exit 1; }
exec 9>/run/lock/ruspet-company-prepare.lock
flock -n 9 || { echo 'Подготовка уже запущена.'; exit 1; }

# All package installation and child processes stay within this bounded scope.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get install -y ca-certificates curl gnupg git rsync unzip build-essential python3
install -d -m 0755 /etc/apt/keyrings
key_tmp=$(mktemp -d)
trap 'rm -rf -- "$key_tmp"' EXIT
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_tmp/node.asc"
gpg --batch --yes --dearmor -o "$key_tmp/node.gpg" "$key_tmp/node.asc"
install -m 0644 "$key_tmp/node.gpg" /etc/apt/keyrings/ruspet-node.gpg
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$key_tmp/postgresql.asc"
gpg --batch --show-keys "$key_tmp/postgresql.asc" >/dev/null
install -m 0644 "$key_tmp/postgresql.asc" /etc/apt/keyrings/ruspet-postgresql.asc
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/ruspet-node.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
 > /etc/apt/sources.list.d/ruspet-node22.list
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/ruspet-postgresql.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' \
 > /etc/apt/sources.list.d/ruspet-postgresql17.list
apt-get update
apt-get install -y nodejs postgresql-17 postgresql-client-17 nginx certbot python3-certbot-nginx

# No firewall, Docker, SSH authentication or existing application configuration changes.
systemctl enable --now ssh postgresql nginx
id -u ruspet >/dev/null 2>&1 || useradd --system --user-group \
 --home-dir /opt/ruspet --shell /usr/sbin/nologin ruspet
install -d -o root -g root -m 0755 /opt/ruspet
install -d -o ruspet -g ruspet -m 0700 /opt/ruspet/.local /opt/ruspet/.secrets
install -d -o root -g root -m 0700 /root/.ssh /root/ruspet-code

if [[ -z $(swapon --show=NAME --noheadings) && ! -e /swapfile ]]; then
 fallocate -l 2G /swapfile
 chmod 0600 /swapfile
 mkswap /swapfile
 swapon /swapfile
 cp -a /etc/fstab "/root/fstab-before-ruspet-$(date -u +%Y%m%dT%H%M%S)"
 grep -qE '^/swapfile[[:space:]]' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi

cd /
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ruspet') THEN
  CREATE ROLE ruspet LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
END
$role$;
SQL
if ! runuser -u postgres -- psql -XAtq -d postgres \
 -c "SELECT 1 FROM pg_database WHERE datname='ruspet_demo'" | grep -qx 1; then
 runuser -u postgres -- createdb --owner=ruspet --encoding=UTF8 --template=template0 ruspet_demo
fi

if [[ ! -e /root/.ssh/ruspet_github ]]; then
 ssh-keygen -q -t ed25519 -N '' -C ruspet-company-server -f /root/.ssh/ruspet_github
fi
if [[ ! -s /root/.ssh/ruspet_github.pub ]]; then
 ssh-keygen -y -f /root/.ssh/ruspet_github > /root/.ssh/ruspet_github.pub
fi
chmod 0600 /root/.ssh/ruspet_github
chmod 0644 /root/.ssh/ruspet_github.pub

# Obtain public GitHub host keys over authenticated HTTPS, before the first clone.
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
 https://api.github.com/meta -o "$key_tmp/github-meta.json"
python3 - "$key_tmp/github-meta.json" <<'PY'
import json,sys
from pathlib import Path
keys=json.loads(Path(sys.argv[1]).read_text()).get('ssh_keys',[])
if not keys or not all(isinstance(k,str) and k.startswith(('ssh-ed25519 ','ecdsa-sha2-nistp256 ','ssh-rsa ')) and '\n' not in k for k in keys):
    raise SystemExit('Не удалось проверить публичные SSH-ключи GitHub.')
path=Path('/root/.ssh/known_hosts')
existing=path.read_text().splitlines() if path.exists() else []
new=['github.com '+key for key in keys]
path.write_text('\n'.join(existing+[line for line in new if line not in existing])+'\n')
path.chmod(0o600)
PY

node --version
npm --version
psql --version
nginx -v
free -h
printf '\nПУБЛИЧНЫЙ deploy key для GitHub (разрешение только чтения):\n'
cat /root/.ssh/ruspet_github.pub
printf '\nПодготовка завершена. Приложение, база со старого VPS и бот ещё не перенесены.\n'
