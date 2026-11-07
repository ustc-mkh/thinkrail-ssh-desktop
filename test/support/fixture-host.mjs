import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const directory = args[args.indexOf('--fixture-directory') + 1];
const page = `<!doctype html><html><head><title>Fixture Thinkrail</title></head><body><h1 id="title">Thinkrail integration fixture</h1><script>
window.pageIdentity = Math.random().toString(36);
localStorage.setItem('fixture', 'retained');
window.echoes = [];
function connect() {
  const ws = window.fixtureSocket = new WebSocket('ws://' + location.host + '/ws?client=fixture&protocol=999');
  ws.onopen = () => ws.send('unchanged-message');
  ws.onmessage = event => window.echoes.push(event.data);
  ws.onclose = () => setTimeout(connect, 100);
}
connect();
</script></body></html>`;
const sockets = new Set();
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.on('upgrade', (req, socket, head) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffered = head;
  const receive = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const length = buffered[1] & 127;
      if (length > 125 || !(buffered[1] & 128)) { socket.destroy(); return; }
      if (buffered.length < length + 6) return;
      const mask = buffered.subarray(2, 6);
      const payload = Buffer.from(buffered.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const opcode = buffered[0] & 15;
      buffered = buffered.subarray(6 + length);
      if (opcode === 8) { socket.end(); return; }
      socket.write(Buffer.concat([Buffer.from([opcode === 9 ? 0x8a : 0x81, payload.length]), payload]));
    }
  };
  socket.on('data', receive);
  socket.on('error', () => {});
  if (head.length) receive(Buffer.alloc(0));
});
server.listen(port, '127.0.0.1', async () => {
  await writeFile(join(directory, 'host.pid'), String(process.pid));
  await writeFile(join(directory, 'host-args.json'), JSON.stringify(args));
});
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
