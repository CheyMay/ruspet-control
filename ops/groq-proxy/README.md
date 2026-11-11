# HTTPS-прокси для Groq

`CONNECT api.groq.com:443` через TLS 1.2+. В unit указан `0.0.0.0:8443`. Basic auth с логином `ruspet`. Ключ Groq передаёт клиент внутри TLS-туннеля.

## Развёртывание

Node.js ≥22 и systemd с `LoadCredential`. Из каталога архива выполнить от root.

```bash
install -d -m 0755 /opt/ruspet-groq-proxy
install -m 0644 proxy.mjs /opt/ruspet-groq-proxy/
install -m 0644 ruspet-groq-proxy.service /etc/systemd/system/
install -d -m 0700 /etc/ruspet-groq-proxy
```

В `/etc/ruspet-groq-proxy/` нужны `fullchain.pem` и `privkey.pem` для имени прокси. Подойдут симлинки на действующий сертификат и ключ. Пароль создать один раз.

```bash
(umask 077; set -C; node -p 'require("node:crypto").randomBytes(32).toString("hex")' > /etc/ruspet-groq-proxy/password)
systemctl daemon-reload
systemctl enable --now ruspet-groq-proxy.service
```

Входящий TCP 8443 нужен с адреса сервера РУСПЭТ. После обновления сертификата перезапустить unit.

## Проверка

```bash
proxy_host=proxy.example.org
printf 'proxy = "https://ruspet:%s@%s:8443"\n' "$(cat /etc/ruspet-groq-proxy/password)" "$proxy_host" |
  curl -K - --noproxy '' -sS -m 15 -o /dev/null -w 'CONNECT %{http_connect}, Groq %{http_code}\n' \
  https://api.groq.com/openai/v1/models
```

Ожидаемый результат проверки — `CONNECT 200, Groq 401`. Для подключения передать имя, порт и пароль прокси. Параметр РУСПЭТ — `GROQ_HTTPS_PROXY=https://ruspet:ПАРОЛЬ@ИМЯ:8443`.
