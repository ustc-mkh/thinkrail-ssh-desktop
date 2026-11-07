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

test('sequential HTTP requests reuse one upstream socket, and changing target closes the old pool', async t => {
  const sockets = [new Set(), new Set()];
  const opened = [0, 0];
  const backends = [0, 1].map(index => {
    const backend = http.createServer((_req, res) => res.end(`backend-${index}`));
    backend.on('connection', socket => {
      opened[index]++;
      sockets[index].add(socket);
      socket.on('close', () => sockets[index].delete(socket));
    });
    return backend;
  });
  await Promise.all(backends.map(async backend => { backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); }));
  const gateway = new Gateway(); await gateway.listen();
  t.after(async () => {
    await gateway.close();
    await Promise.all(backends.map(backend => new Promise(resolve => backend.close(resolve))));
  });
  const headers = { [ACCESS_HEADER]: gateway.key, Connection: 'keep-alive' };
  gateway.setTarget(backends[0].address().port);
  for (let i = 0; i < 5; i++) {
    const response = await request(gateway.port, { path: `/future-route-${i}`, headers });
    assert.equal(response.body.toString(), 'backend-0');
  }
  assert.equal(opened[0], 1, 'five requests should use one forwarded TCP channel');
  gateway.setTarget(backends[1].address().port);
  await waitFor(() => sockets[0].size === 0);
  assert.equal((await request(gateway.port, { headers })).body.toString(), 'backend-1');
  assert.equal(opened[1], 1);
  gateway.setTarget(null);
  await waitFor(() => sockets[1].size === 0);
  assert.equal(gateway.agent, null);
});

test('WebSocket upgrades bypass a saturated HTTP pool', async t => {
  let release;
  const backend = http.createServer((_req, res) => { release = () => res.end('released'); });
  const remoteSockets = new Set();
  backend.on('connection', socket => { remoteSockets.add(socket); socket.on('close', () => remoteSockets.delete(socket)); });
  backend.on('upgrade', (_req, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nready'));
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const gateway = new Gateway(); await gateway.listen(); gateway.setTarget(backend.address().port);
  gateway.agent.maxSockets = 1;
  gateway.agent.maxTotalSockets = 1;
  const socket = net.connect(gateway.port, '127.0.0.1');
  t.after(async () => {
    release?.(); socket.destroy(); await gateway.close();
    for (const remote of remoteSockets) remote.destroy();
    await new Promise(resolve => backend.close(resolve));
  });
  const pending = request(gateway.port, { headers: { [ACCESS_HEADER]: gateway.key } });
  await waitFor(() => Boolean(release));
  let received = '';
  socket.on('data', chunk => { received += chunk; });
  if (socket.connecting) await once(socket, 'connect');
  socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${ACCESS_HEADER}: ${gateway.key}\r\n\r\n`);
  await waitFor(() => received.includes('ready'));
  release();
  assert.equal((await pending).body.toString(), 'released');
});

test('respects upstream Connection: close instead of retaining an unusable socket', async t => {
  let opened = 0;
  const backend = http.createServer((_req, res) => { res.setHeader('Connection', 'close'); res.end('ok'); });
  backend.on('connection', () => { opened++; });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const gateway = new Gateway(); await gateway.listen(); gateway.setTarget(backend.address().port);
  t.after(async () => { await gateway.close(); await new Promise(resolve => backend.close(resolve)); });
  for (let i = 0; i < 2; i++) {
    const response = await request(gateway.port, { headers: { [ACCESS_HEADER]: gateway.key } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.connection, 'close');
  }
  assert.equal(opened, 2);
});

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
