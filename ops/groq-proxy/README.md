# Прокси Groq для РУСПЭТ

Отдельная служба принимает HTTPS CONNECT на порту 8443. Для входа используются логин `ruspet` и случайный пароль. Единственный доступный адрес назначения — `api.groq.com:443`. Аудио и ключ Groq передаются внутри TLS-соединения между РУСПЭТ и Groq. [Контракт CONNECT в клиенте Undici](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md)

## Развёртывание на эстонском сервере

Нужны Node.js 22 или новее, systemd с поддержкой `LoadCredential` и TLS-сертификат на имя, по которому будет доступен прокси. Подойдёт действующий сертификат этого сервера, если он покрывает выбранное имя. Для входящих подключений используйте TCP 8443 и разрешите доступ с адреса рабочего сервера РУСПЭТ. [Настройка LoadCredential](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#LoadCredential=ID:PATH)

Распакуйте архив. Из каталога с `proxy.mjs` выполните от root, указав свой каталог TLS-сертификата.

```bash
(
  set -e
  tls_dir=/etc/letsencrypt/live/proxy.example.org
  test -r "$tls_dir/fullchain.pem"
  test -r "$tls_dir/privkey.pem"
  node --version
  install -d -m 0755 /opt/ruspet-groq-proxy
  install -d -m 0700 /etc/ruspet-groq-proxy
  install -m 0644 proxy.mjs /opt/ruspet-groq-proxy/proxy.mjs
  install -m 0644 ruspet-groq-proxy.service /etc/systemd/system/ruspet-groq-proxy.service
  for name in fullchain.pem privkey.pem; do
    if [ ! -e "/etc/ruspet-groq-proxy/$name" ]; then
      ln -s "$tls_dir/$name" "/etc/ruspet-groq-proxy/$name"
    fi
  done
  if [ ! -s /etc/ruspet-groq-proxy/password ]; then
    (umask 077; node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' > /etc/ruspet-groq-proxy/password)
  fi
  chmod 0600 /etc/ruspet-groq-proxy/password
  systemctl daemon-reload
  systemctl enable --now ruspet-groq-proxy.service
  systemctl status ruspet-groq-proxy.service --no-pager
)
```

После обновления сертификата перезапустите службу, чтобы она прочитала свежие файлы.

## Проверка

На эстонском сервере подставьте имя прокси из сертификата. Команда проверяет CONNECT и ответ Groq, читая пароль из файла.

```bash
(
  proxy_host=proxy.example.org
  printf 'proxy = "https://ruspet:%s@%s:8443"\n' \
    "$(cat /etc/ruspet-groq-proxy/password)" "$proxy_host"
  printf 'url = "https://api.groq.com/openai/v1/models"\n'
) | curl --config - --noproxy '' --silent --show-error --max-time 15 --output /dev/null \
  --write-out 'CONNECT %{http_connect}, Groq %{http_code}\n'
```

`CONNECT 200` подтверждает туннель. `Groq 401` ожидаем для этой команды без ключа Groq. Если Groq возвращает `403`, проверьте доступ к нему с эстонского сервера. Ошибка запуска службы видна в `journalctl -u ruspet-groq-proxy -n 30 --no-pager`.

Для подключения РУСПЭТ передайте имя и порт прокси. Пароль из `/etc/ruspet-groq-proxy/password` передайте защищённым способом. В закрытом окружении Telegram-воркера используется параметр `GROQ_HTTPS_PROXY=https://ruspet:ПАРОЛЬ@ИМЯ_ПРОКСИ:8443`.
