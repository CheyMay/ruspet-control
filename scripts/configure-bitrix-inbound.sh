#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  "") [[ $# == 0 && $EUID == 0 && -t 0 ]] || { echo 'Запустите из SSH-консоли под root.'; exit 1; } ;;
  --json-stdin) [[ $# == 1 && $EUID == 0 ]] || { echo 'Передайте JSON в stdin под root.'; exit 1; } ;;
  --check-json-stdin) [[ $# == 1 ]] || exit 2 ;;
  *) echo 'Использование: configure-bitrix-inbound.sh [--json-stdin | --check-json-stdin]'; exit 2 ;;
esac
umask 077
python3 - "$@" 3<&0 <<'PY'
from getpass import GetPassWarning, getpass
import grp
import json
import os
from pathlib import Path
import pwd
import re
import sys
import warnings
from urllib.parse import urlsplit

warnings.simplefilter('error', GetPassWarning)
secrets = Path('/opt/ruspet/.secrets')
config = Path('/etc/ruspet/bitrix-inbound.env')
files = [secrets / name for name in ('bitrix-webhook', 'bitrix-event-token', 'bitrix-balancer.json')]
portal = 'thebest.bitrix24.ru'
fields = {
    'webhook': 'Входящий вебхук Битрикс24 (HTTPS-адрес)',
    'eventToken': 'Токен приложения исходящего вебхука',
    'balancerUrl': 'HTTPS-адрес балансировщика Романа (/send)',
    'publicKey': 'Публичный ключ балансировщика',
    'privateKey': 'Приватный ключ балансировщика',
    'priceField': 'Код поля цены UF_… (Enter, чтобы пока оставить прежние цены)',
}
check = sys.argv[1:] == ['--check-json-stdin']
if not check:
    if any(path.exists() or path.is_symlink() for path in [*files, config]):
        raise SystemExit('Файлы Битрикс24 уже существуют. Уточните настройки перед заменой.')
    for directory in (secrets, config.parent):
        if not directory.is_dir() or directory.is_symlink():
            raise SystemExit('Не найден защищённый каталог РУСПЭТ.')
if len(sys.argv) > 1:
    with os.fdopen(3, 'rb') as stdin:
        raw = stdin.read(16385)
    if len(raw) > 16384:
        raise SystemExit('Размер JSON не должен превышать 16 КБ.')
    try:
        data = json.loads(raw.decode('utf-8-sig'))
    except (ValueError, RecursionError):
        raise SystemExit('Нужен корректный JSON в UTF-8.') from None
    required = set(fields) - {'priceField'}
    if (not isinstance(data, dict) or not required <= data.keys() <= fields.keys()
            or any(not isinstance(value, str) for value in data.values())):
        raise SystemExit('Нужны строковые webhook, eventToken, balancerUrl, publicKey и privateKey. priceField необязателен.')
else:
    data = {key: getpass(f'{prompt}: ') for key, prompt in fields.items()}
webhook, token, gateway, public, private, price = (data.get(key, '').strip() for key in fields)
webhook = webhook.rstrip('/') + '/'

if not re.fullmatch(r'https://' + re.escape(portal) + r'/rest/\d+/[A-Za-z0-9_-]+/', webhook):
    raise SystemExit('Ожидается базовый адрес входящего вебхука портала thebest.bitrix24.ru.')
if not re.fullmatch(r'[^\s\x00-\x1f\x7f]{16,512}', token) or not public or not private:
    raise SystemExit('Нужен токен исходящего вебхука и оба ключа балансировщика.')
try:
    url = urlsplit(gateway)
except ValueError:
    raise SystemExit('Некорректный адрес балансировщика.') from None
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or not url.path.endswith('/send'):
    raise SystemExit('Нужен HTTPS-адрес /send без логина, параметров и фрагмента.')
if price and not re.fullmatch(r'UF_[A-Z0-9_]+', price):
    raise SystemExit('Проверьте код поля цены.')
if check:
    print('Формат настроек проверен. Доступ к порталу проверяется через verify.')
    raise SystemExit(0)

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
