import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SshSession, probeHealth } from '../src/core/ssh.js';
import { Connection } from '../src/core/connection.js';
import { createAskpass } from '../src/core/askpass.js';
import { validateProfile } from '../src/core/profile.js';
import { sshFixture } from './support/ssh-host.js';

test('askpass returns a response through a private socket without storing it', async () => {
  const askpass = await createAskpass(async prompt => {
    assert.equal(prompt, 'Enter passphrase:');
    return 'test-secret';
  });
  try {
    const child = spawn(askpass.scriptPath, ['Enter passphrase:']);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0); assert.equal(output, 'test-secret\n');
  } finally { await askpass.close(); }
});

test('real OpenSSH: starts detached host, reconnects without restarting it, retains origin, disconnect leaves host running', { timeout: 20000 }, async t => {
  const fixture = await sshFixture();
  t.after(() => fixture.close());
  const project = "/a project/with 'quotes' and $(unexecuted)";
  const profile = validateProfile({ host: 'fixture', remotePort: fixture.remotePort, binary: fixture.binary, project });
  let current;
  const make = () => {
    current = new SshSession(profile, { spawnProcess: fixture.spawnProcess });
    return current;
  };
  const connection = new Connection(profile, { sessionFactory: make, retryBase: 20, healthInterval: 100 });
  t.after(() => connection.stop());
  const ready = once(connection, 'ready');
  const origin = await connection.start();
  await ready;
  const pid = await readFile(join(fixture.directory, 'host.pid'), 'utf8');
  const args = JSON.parse(await readFile(join(fixture.directory, 'host-args.json'), 'utf8'));
  assert.equal(args.at(-1), project);
  const restored = once(connection, 'ready');
  current.child.kill('SIGTERM');
  await restored;
  assert.equal(connection.gateway.origin, origin);
  assert.equal(await readFile(join(fixture.directory, 'host.pid'), 'utf8'), pid);
  await connection.stop();
  assert.equal(await probeHealth(fixture.remotePort), true);
});
