import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {connect} from 'node:net';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const groqHost = 'api.groq.com';
const groqPort = 443;
const destination = `${groqHost}:${groqPort}`;
const connectTimeout = 8000;
const idleTimeout = 45000;
const maxTunnels = 16;
const digest = value => createHash('sha256').update(value).digest();

function reject(socket, status, extra = '') {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
}

export function createGroqProxy({key, cert, password}, dial = () => connect(groqPort, groqHost)) {
  if (!/^[a-f0-9]{64}$/i.test(password)) throw new Error('Generate a 32-byte hexadecimal proxy password');
  const expected = digest('Basic ' + Buffer.from('ruspet:' + password).toString('base64'));
  const tunnels = new Set();
  const server = createServer({
    key, cert, minVersion: 'TLSv1.2', maxHeaderSize: 8192,
    handshakeTimeout: 10000, headersTimeout: 10000, requestTimeout: 12000,
  }, (_request, response) => {
    response.writeHead(405, {Allow: 'CONNECT', Connection: 'close', 'Content-Length': '0'});
    response.end();
  });
  server.maxConnections = 64;
  server.setTimeout(15000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());

  server.on('connect', (request, client, head) => {
    client.on('error', () => client.destroy());
    if (!timingSafeEqual(expected, digest(request.headers['proxy-authorization'] || ''))) {
      reject(client, '407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="RUSPET Groq"\r\n');
      return;
    }
    if (request.url?.toLowerCase() !== destination) {
      reject(client, '403 Forbidden');
      return;
    }
    if (request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0') ||
        head.length > 32768) {
      reject(client, '400 Bad Request');
      return;
    }
    if (tunnels.size >= maxTunnels) {
      reject(client, '503 Service Unavailable');
      return;
    }

    const upstream = dial();
    let connected = false;
    tunnels.add(client);
    client.once('close', () => {
      tunnels.delete(client);
      upstream.destroy();
    });
    upstream.once('error', () => {
      if (connected) client.destroy();
      else reject(client, '502 Bad Gateway');
    });
    upstream.once('close', () => {
      if (connected && !client.writableEnded) client.end();
    });
    upstream.on('timeout', () => {
      if (connected) client.destroy();
      else reject(client, '504 Gateway Timeout');
      upstream.destroy();
    });
    upstream.setTimeout(connectTimeout);
    upstream.once('connect', () => {
      if (client.destroyed || client.writableEnded) {
        upstream.destroy();
        return;
      }
      connected = true;
      upstream.setTimeout(idleTimeout);
      client.setTimeout(idleTimeout, () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  return {
    server,
    close() {
      const closing = new Promise((resolve, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolve());
      });
      for (const client of tunnels) client.destroy();
      server.closeAllConnections();
      return closing;
    },
  };
}

async function main() {
  const credentials = process.env.CREDENTIALS_DIRECTORY || '/etc/ruspet-groq-proxy';
  const host = process.env.GROQ_PROXY_HOST || '127.0.0.1';
  const port = Number(process.env.GROQ_PROXY_PORT || 8443);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid listen port');
  const [key, cert, password] = await Promise.all([
    readFile(join(credentials, 'privkey.pem')),
    readFile(join(credentials, 'fullchain.pem')),
    readFile(join(credentials, 'password'), 'utf8'),
  ]);
  const proxy = createGroqProxy({key, cert, password: password.trim()});
  await new Promise((resolve, rejectStart) => {
    proxy.server.once('error', rejectStart);
    proxy.server.listen(port, host, resolve);
  });
  console.log(`Groq HTTPS proxy listening on ${host}:${port}`);
  const stop = () => { void proxy.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error('Groq proxy startup failed. Check the TLS files, password and listen address.', error.code || '');
    process.exitCode = 1;
  });
}
