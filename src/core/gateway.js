import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_HEADER = 'x-thinkrail-connector-key';

/** HTTP and upgrade bytes only. No Thinkrail messages, routes, or assets are rewritten. */
export class Gateway {
  constructor() {
    this.key = randomBytes(32).toString('hex');
    this.target = null;
    this.sockets = new Set();
    this.upstreams = new Set();
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('connection', socket => {
      socket.setNoDelay(true);
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  async listen(port = 0) {
    await new Promise((resolve, reject) => {
      const fail = error => { this.server.off('listening', ready); reject(error); };
      const ready = () => { this.server.off('error', fail); resolve(); };
      this.server.once('error', fail);
      this.server.once('listening', ready);
      this.server.listen(port, '127.0.0.1');
    });
    this.port = this.server.address().port;
    this.origin = `http://127.0.0.1:${this.port}`;
    this.server.on('error', () => {});
    return this.origin;
  }

  authorized(req) {
    const supplied = req.headers[ACCESS_HEADER];
    const expectedHost = `127.0.0.1:${this.port}`;
    if (req.headers.host !== expectedHost || typeof supplied !== 'string') return false;
    const left = Buffer.from(supplied);
    const right = Buffer.from(this.key);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  options(req) {
    const headers = { ...req.headers };
    delete headers[ACCESS_HEADER];
    // Keep Host and Origin consistent for same-origin checks, while dialling the SSH endpoint.
    return { hostname: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers, agent: false };
  }

  track(request) {
    this.upstreams.add(request);
    request.on('close', () => this.upstreams.delete(request));
    request.on('socket', socket => socket.setNoDelay(true));
    return request;
  }

  forward(req, res) {
    if (!this.authorized(req)) { res.writeHead(403).end('Forbidden'); return; }
    if (!this.target) { res.writeHead(503, { 'Cache-Control': 'no-store' }).end('SSH connection is unavailable'); return; }
    const upstream = this.track(http.request(this.options(req), response => {
      res.writeHead(response.statusCode, response.statusMessage, response.headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    }));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' }).end('Remote host is unavailable');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  upgrade(req, socket, head) {
    if (!this.authorized(req) || !this.target) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = this.track(http.request(this.options(req)));
    upstream.on('upgrade', (response, remote, remoteHead) => {
      const lines = [`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.setNoDelay(true);
      const close = () => { socket.destroy(); remote.destroy(); };
      socket.on('error', close);
      remote.on('error', close);
      socket.on('close', () => remote.destroy());
      remote.on('close', () => socket.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  }

  setTarget(port) {
    if (this.target === port) return;
    this.target = port;
    for (const request of this.upstreams) request.destroy();
    // A dead backend must close old WS pipes so the unmodified UI can reconnect itself.
    for (const socket of this.sockets) socket.destroy();
  }

  async close() {
    this.setTarget(null);
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
