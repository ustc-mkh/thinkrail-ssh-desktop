import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Gateway, ACCESS_HEADER } from '../src/core/gateway.js';

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('streams unknown future routes and binary bodies unchanged; strips connector credential', async t => {
  let captured;
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(201, { 'Content-Type': 'application/octet-stream', 'X-Future-Header': 'kept', 'Cache-Control': 'no-store' });
    res.end(captured.body);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const gateway = new Gateway(); await gateway.listen(); gateway.setTarget(backend.address().port);
  t.after(async () => { await gateway.close(); await new Promise(resolve => backend.close(resolve)); });
  const body = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => i % 256));
  const response = await request(gateway.port, {
    method: 'PUT', path: '/a-future-api/%E4%B8%AD?x=1&x=2', body,
    headers: { [ACCESS_HEADER]: gateway.key, 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, body);
  assert.equal(captured.path, '/a-future-api/%E4%B8%AD?x=1&x=2');
  assert.equal(captured.method, 'PUT');
  assert.equal(captured.headers[ACCESS_HEADER], undefined);
  assert.equal(response.headers['x-future-header'], 'kept');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await request(gateway.port)).status, 403);
  assert.equal((await request(gateway.port, { headers: { [ACCESS_HEADER]: gateway.key, Host: 'evil.example' } })).status, 403);
});

test('upgrade preserves query, early bytes, and full-duplex stream; target loss closes pipes', async t => {
  let url;
  const backend = http.createServer();
  const backendSockets = new Set();
  backend.on('connection', socket => { backendSockets.add(socket); socket.on('close', () => backendSockets.delete(socket)); });
  backend.on('upgrade', (req, socket, head) => {
    url = req.url;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nearly');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const gateway = new Gateway(); await gateway.listen(); gateway.setTarget(backend.address().port);
  const socket = net.connect(gateway.port, '127.0.0.1');
  t.after(async () => {
    socket.destroy(); await gateway.close(); for (const s of backendSockets) s.destroy();
    await new Promise(resolve => backend.close(resolve));
  });
  let received = '';
  socket.on('data', chunk => { received += chunk.toString(); });
  await once(socket, 'connect');
  socket.write(`GET /ws?client=old-client&protocol=999 HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${ACCESS_HEADER}: ${gateway.key}\r\n\r\nfrom-client`);
  await waitFor(() => received.includes('early') && received.includes('from-client'));
  assert.equal(url, '/ws?client=old-client&protocol=999');
  socket.write('next-payload');
  await waitFor(() => received.includes('next-payload'));
  const closed = once(socket, 'close'); gateway.setTarget(null); await closed;
  assert.equal((await request(gateway.port, { headers: { [ACCESS_HEADER]: gateway.key } })).status, 503);
});

test('the stable loopback address can be rebound after disconnect', async () => {
  const gateway = new Gateway(); const origin = await gateway.listen(); const port = gateway.port;
  await gateway.close();
  const next = new Gateway();
  try { assert.equal(await next.listen(port), origin); }
  finally { await next.close(); }
});

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
