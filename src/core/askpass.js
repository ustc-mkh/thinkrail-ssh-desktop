import net from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './profile.js';

export async function createAskpass(request) {
  const directory = await mkdtemp(join(tmpdir(), 'trssh-'));
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'auth.sock');
  const clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let handled = false;
    socket.setTimeout(120000, () => socket.destroy());
    socket.on('data', async chunk => {
      if (handled) return;
      buffer += chunk.toString();
      if (buffer.length > 16384) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      try {
        const data = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (typeof data.prompt !== 'string') throw new Error('Invalid prompt');
        const result = await request(data.prompt.slice(0, 8000));
        if (!socket.destroyed) socket.end(JSON.stringify({ answer: result }) + '\n');
      } catch { socket.end(JSON.stringify({ answer: null }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const scriptPath = join(directory, 'askpass');
  const helper = fileURLToPath(new URL('../askpass-helper.mjs', import.meta.url));
  await writeFile(scriptPath,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(socketPath)} "$@"\n`,
    { mode: 0o700 });
  return {
    scriptPath,
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
