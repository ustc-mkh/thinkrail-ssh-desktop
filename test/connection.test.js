import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Connection } from '../src/core/connection.js';
import { validateProfile } from '../src/core/profile.js';

class Session extends EventEmitter {
  closed = false;
  starts = 0;
  async open() { return 12345; }
  async startHost() { this.starts++; }
  close() { if (!this.closed) { this.closed = true; this.emit('close', 'closed'); } }
}

test('cancelling authentication ends the attempt instead of entering automatic retry', async () => {
  const current = new Session();
  current.open = signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  let count = 0;
  const connection = new Connection(validateProfile({ host: 'dev' }), {
    sessionFactory: () => { count++; return current; },
  });
  await connection.start();
  connection.cancelAuthentication();
  await connection.loopTask;
  assert.equal(count, 1);
  assert.equal(connection.state.status, 'error');
  assert.equal(connection.state.stage, '认证已取消');
  assert.equal(connection.gateway.target, null);
  await connection.stop();
});

test('a wrong or unresponsive service is never treated as permission to launch another host', async () => {
  for (const code of ['WRONG_SERVICE', 'SERVICE_UNRESPONSIVE']) {
    const session = new Session();
    const connection = new Connection(validateProfile({ host: 'dev' }), {
      sessionFactory: () => session,
      probe: async () => { throw Object.assign(new Error(code), { code }); },
    });
    try {
      await connection.start();
      await connection.loopTask;
      assert.equal(session.starts, 0);
      assert.equal(connection.state.status, 'error');
    } finally { await connection.stop(); }
  }
});

test('health degradation does not restart SSH or the host; manual disconnect cancels recovery', async () => {
  let sessions = 0;
  let probes = 0;
  const current = new Session();
  const connection = new Connection(validateProfile({ host: 'dev' }), {
    sessionFactory: () => { sessions++; return current; },
    healthInterval: 10,
    probe: async () => {
      probes++;
      if (probes === 1) return true;
      throw new Error('temporary timeout');
    },
  });
  const ready = once(connection, 'ready');
  await connection.start(); await ready;
  const deadline = Date.now() + 1000;
  while (connection.state.stage !== '等待远端响应…' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(connection.state.stage, '等待远端响应…');
  assert.equal(sessions, 1);
  assert.equal(current.starts, 0);
  await connection.stop();
  assert.equal(connection.state.status, 'disconnected');
  assert.equal(connection.gateway.server.listening, false);
});
