import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { freePort } from '../src/core/ssh.js';
import { sshFixture } from './support/ssh-host.js';

async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(description);
}

async function debuggerFor(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error || reply.result?.exceptionDetails) request.reject(new Error(JSON.stringify(reply)));
    else request.resolve(reply.result?.result?.value);
  };
  return {
    eval(expression) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger request timed out')); }, 20000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    },
    close: () => socket.close(),
  };
}

const secret = 'fixture-key-passphrase';
const fixture = await sshFixture({ passphrase: secret });
const dataDir = await mkdtemp(join(tmpdir(), 'trssh-packaged-'));
const debugPort = await freePort();
const executable = resolve(`dist/thinkrail-ssh-linux-${process.arch}/start.sh`);
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', '--ozone-platform=x11'], {
  env: { ...process.env, THINKRAIL_SSH_DATA_DIR: dataDir, PATH: `${fixture.directory}:${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
child.on('error', error => { diagnostics += error.message; });
const clients = [];
let main;
const targets = async () => (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
try {
  const mainTarget = await until(async () => (await targets()).find(t => t.url.endsWith('/ui/index.html')), 'Packaged desktop did not open');
  main = await debuggerFor(mainTarget); clients.push(main);
  await until(() => main.eval('Boolean(window.connector)'), 'Packaged preload did not initialize');
  await main.eval(`document.querySelector('#ssh-host').value='fixture';document.querySelector('#port').value=${fixture.remotePort};document.querySelector('#binary').value=${JSON.stringify(fixture.binary)};document.querySelector('#form').requestSubmit();true`);
  const answerPrompt = async () => {
    const target = await until(async () => (await targets()).find(t => t.url.endsWith('/ui/auth.html')), 'SSH passphrase dialog did not open');
    const auth = await debuggerFor(target); clients.push(auth);
    const prompt = await auth.eval('window.authentication.getPrompt()');
    assert.match(prompt, /passphrase/i);
    // Closing the modal may destroy its debugger connection before the invoke reply.
    void auth.eval(`window.authentication.answer(${JSON.stringify(secret)})`).catch(() => {});
  };
  await answerPrompt();
  const workspaceTarget = await until(async () => (await targets()).find(t => t.url.startsWith('http://127.0.0.1:')), 'Packaged workspace did not open');
  const workspace = await debuggerFor(workspaceTarget); clients.push(workspace);
  await until(() => workspace.eval('window.echoes?.length > 0'), 'Packaged WebSocket did not connect');
  const identity = await workspace.eval('window.pageIdentity');
  await main.eval("document.querySelector('#reconnect').click();true");
  await answerPrompt();
  await until(() => workspace.eval('window.echoes?.length > 1'), 'Packaged reconnect did not restore WebSocket');
  assert.equal(await workspace.eval('window.pageIdentity'), identity);
  assert.equal(await workspace.eval('typeof window.connector'), 'undefined');
  console.log('PACKAGED_SMOKE_PASS: launcher, encrypted SSH key prompt, form submission, HTTP/WS, reconnect without page reload');
} catch (error) {
  console.error(error, diagnostics);
  process.exitCode = 1;
} finally {
  if (main) await main.eval('window.connector.disconnect()').catch(() => {});
  for (const client of clients) client.close();
  child.kill('SIGTERM');
  await fixture.close();
}
