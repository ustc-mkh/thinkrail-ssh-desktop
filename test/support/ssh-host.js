import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { freePort } from '../../src/core/ssh.js';
import { shellQuote } from '../../src/core/profile.js';

export async function sshFixture({ passphrase = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'trssh-integration-'));
  const sshPort = await freePort();
  const remotePort = await freePort();
  const hostFile = fileURLToPath(new URL('fixture-host.mjs', import.meta.url));
  const node = process.env.TRSSH_TEST_NODE || process.execPath;
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host-key')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', join(directory, 'client-key')]);
  await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')));
  await writeFile(join(directory, 'known_hosts'), `[127.0.0.1]:${sshPort} ${await readFile(join(directory, 'host-key.pub'), 'utf8')}`);
  const config = join(directory, 'sshd_config');
  await writeFile(config, [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${directory}/host-key`,
    `PidFile ${directory}/sshd.pid`, `AuthorizedKeysFile ${directory}/authorized_keys`,
    'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'AllowTcpForwarding local', 'PermitRootLogin yes', 'LogLevel ERROR',
  ].join('\n') + '\n');
  const sshConfig = join(directory, 'ssh_config');
  await writeFile(sshConfig, [
    'Host fixture', '  HostName 127.0.0.1', `  Port ${sshPort}`, `  User ${userInfo().username}`,
    `  IdentityFile ${directory}/client-key`, '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${directory}/known_hosts`, '  StrictHostKeyChecking yes', `  BatchMode ${passphrase ? 'no' : 'yes'}`,
  ].join('\n') + '\n');
  let diagnostics = '';
  const daemon = ['/usr/sbin/sshd', '/usr/bin/sshd'].find(path => existsSync(path));
  if (!daemon) throw new Error('Tests require the OpenSSH server package (sshd)');
  const sshd = spawn(daemon, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  sshd.stderr.on('data', chunk => { diagnostics += chunk; });
  sshd.on('error', error => { diagnostics += error.message; });
  const fixture = {
    directory, remotePort, sshConfig,
    binary: join(directory, 'thinkrail-fixture'),
    spawnProcess: (_command, args, options) => spawn('/usr/bin/ssh', [
      '-F', sshConfig, ...args.slice(0, -1), `env XDG_CACHE_HOME=${shellQuote(join(directory, 'remote-cache'))} sh`,
    ], options),
    async close() {
      try { const pid = Number(await readFile(join(directory, 'host.pid'), 'utf8')); if (pid > 1) process.kill(pid, 'SIGTERM'); } catch {}
      sshd.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 100));
      await rm(directory, { recursive: true, force: true });
    },
  };
  try {
    await writeFile(fixture.binary, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(hostFile)} --fixture-directory ${shellQuote(directory)} "$@"\n`);
    await chmod(fixture.binary, 0o700);
    await writeFile(join(directory, 'ssh-wrapper.mjs'), `import {spawn} from 'node:child_process';\nconst args=process.argv.slice(2);\nconst child=spawn('/usr/bin/ssh',['-F',${JSON.stringify(sshConfig)},...args.slice(0,-1),${JSON.stringify(`env XDG_CACHE_HOME=${shellQuote(join(directory, 'remote-cache'))} sh`)}],{stdio:'inherit'});\nprocess.on('SIGTERM',()=>child.kill('SIGTERM'));\nchild.on('exit',code=>process.exit(code??1));\n`);
    await writeFile(join(directory, 'ssh'), `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(join(directory, 'ssh-wrapper.mjs'))} "$@"\n`);
    await chmod(join(directory, 'ssh'), 0o700);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (sshd.exitCode !== null || diagnostics) throw new Error(`Fixture sshd: ${diagnostics}`);
      const listening = await new Promise(resolve => {
        const socket = net.connect(sshPort, '127.0.0.1');
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
      });
      if (listening) return fixture;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Fixture sshd did not start: ${diagnostics}`);
  } catch (error) { await fixture.close(); throw error; }
}
