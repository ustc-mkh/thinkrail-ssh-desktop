import { app, BrowserWindow, webContents } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sshFixture } from './support/ssh-host.js';

async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function run() {
 const fixture = await sshFixture();
 process.env.THINKRAIL_SSH_DATA_DIR = await mkdtemp(join(tmpdir(), 'trssh-desktop-'));
 process.env.PATH = fixture.directory + ':' + process.env.PATH;
 await import('../src/main.js');
 let mainWindow;
 try {
  mainWindow = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html')), 'Desktop did not open');
  await until(() => mainWindow.webContents.executeJavaScript("Boolean(window.connector && document.querySelector('#form'))"), 'Desktop did not initialize');
  if (process.env.TRSSH_SMOKE_SCREENSHOT) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const image = await mainWindow.webContents.capturePage();
    await writeFile(process.env.TRSSH_SMOKE_SCREENSHOT, image.toPNG());
  }
  const profile = { host: 'fixture', remotePort: fixture.remotePort, binary: fixture.binary, project: '/tmp/example', autoStart: true };
  await mainWindow.webContents.executeJavaScript(`window.connector.connect(${JSON.stringify(profile)})`);
  const workspace = await until(() => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://127.0.0.1:')), 'Workspace did not open');
  await until(() => workspace.executeJavaScript('window.echoes?.length > 0'), 'WebSocket did not connect through the desktop gateway');
  const identity = await workspace.executeJavaScript('window.pageIdentity');
  assert.equal(await workspace.executeJavaScript('typeof window.connector'), 'undefined');
  assert.equal(await workspace.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await workspace.executeJavaScript('window.echoes[0]'), 'unchanged-message');
  await mainWindow.webContents.executeJavaScript('window.connector.reconnect()');
  await until(() => workspace.executeJavaScript('window.echoes?.length >= 2'), 'WebSocket did not recover after reconnect');
  assert.equal(await workspace.executeJavaScript('window.pageIdentity'), identity);
  assert.equal(await workspace.executeJavaScript("localStorage.getItem('fixture')"), 'retained');
  const state = await mainWindow.webContents.executeJavaScript('window.connector.getState()');
  assert.equal(state.connection.status, 'connected');
  await mainWindow.webContents.executeJavaScript('window.connector.disconnect()');
  console.log('DESKTOP_SMOKE_PASS: real SSH, host start, HTTP/WS, isolated renderer, reconnect without page reload, local preferences retained');
  await fixture.close();
  app.quit();
 } catch (error) {
  console.error(error);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.error(await mainWindow.webContents.executeJavaScript('window.connector.getState()'));
      await mainWindow.webContents.executeJavaScript('window.connector.disconnect()');
    }
  } catch {}
  await fixture.close();
  app.exit(1);
 }
}
// Electron must finish evaluating the entry module before it emits app.ready.
void run().catch(error => { console.error(error); app.exit(1); });
