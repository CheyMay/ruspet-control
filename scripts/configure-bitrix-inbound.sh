#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 && -t 0 ]] || { echo 'Запустите из SSH-консоли под root.'; exit 1; }
umask 077
python3 - <<'PY'
from getpass import GetPassWarning, getpass
import grp
import json
import os
from pathlib import Path
import pwd
import re
import warnings
from urllib.parse import urlsplit

warnings.simplefilter('error', GetPassWarning)
secrets = Path('/opt/ruspet/.secrets')
config = Path('/etc/ruspet/bitrix-inbound.env')
files = [secrets / name for name in ('bitrix-webhook', 'bitrix-event-token', 'bitrix-balancer.json')]
if any(path.exists() or path.is_symlink() for path in [*files, config]):
    raise SystemExit('Файлы Битрикс24 уже существуют. Уточните настройки перед заменой.')
for directory in (secrets, config.parent):
    if not directory.is_dir() or directory.is_symlink():
        raise SystemExit('Не найден защищённый каталог РУСПЭТ.')

portal = 'thebest.bitrix24.ru'
webhook = getpass('Входящий вебхук Битрикс24 (HTTPS-адрес): ').strip().rstrip('/') + '/'
token = getpass('Токен приложения исходящего вебхука: ').strip()
gateway = getpass('HTTPS-адрес балансировщика Романа (/send): ').strip()
public = getpass('Публичный ключ балансировщика: ').strip()
private = getpass('Приватный ключ балансировщика: ').strip()
price = getpass('Код поля цены UF_… (Enter, чтобы пока оставить прежние цены): ').strip()

if not re.fullmatch(r'https://' + re.escape(portal) + r'/rest/\d+/[A-Za-z0-9_-]+/', webhook):
    raise SystemExit('Ожидается базовый адрес входящего вебхука портала thebest.bitrix24.ru.')
if len(token) < 16 or not public or not private:
    raise SystemExit('Нужен токен исходящего вебхука и оба ключа балансировщика.')
url = urlsplit(gateway)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or not url.path.endswith('/send'):
    raise SystemExit('Нужен HTTPS-адрес /send без логина, параметров и фрагмента.')
if price and not re.fullmatch(r'UF_[A-Z0-9_]+', price):
    raise SystemExit('Проверьте код поля цены.')

settings = (
    f'BITRIX_PORTAL={portal}\n'
    'BITRIX_WEBHOOK_FILE=/opt/ruspet/.secrets/bitrix-webhook\n'
    'BITRIX_EVENT_TOKEN_FILE=/opt/ruspet/.secrets/bitrix-event-token\n'
    'BITRIX_TRANSPORT=balancer\n'
    'BITRIX_BALANCER_CONFIG_FILE=/opt/ruspet/.secrets/bitrix-balancer.json\n'
    'BITRIX_INBOUND_TASKS=true\n'
    'BITRIX_WRITE_ENABLED=false\n'
    f'BITRIX_INBOUND_PRICE_FIELD={price}\n'
)
contents = [webhook, token, json.dumps(dict(url=gateway, publicKey=public, privateKey=private)), settings]
uid, gid = pwd.getpwnam('ruspet').pw_uid, grp.getgrnam('ruspet').gr_gid
written = []
try:
    for path, content in zip([*files, config], contents):
        with path.open('x', encoding='utf-8') as file:
            written.append(path)
            file.write(content.rstrip('\n') + '\n')
            if path != config:
                os.fchown(file.fileno(), uid, gid)
except OSError:
    for path in written:
        path.unlink(missing_ok=True)
    raise SystemExit('Файлы сохранить не удалось. Проверьте каталог и доступ.')
print('Настройки Битрикс24 сохранены. Службы пока не запускались.')
PY
