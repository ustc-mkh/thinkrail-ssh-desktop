import { app, BrowserWindow, webContents } from 'electron';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellQuote } from '../src/core/profile.js';
import { sshFixture } from './support/ssh-host.js';

async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function run() {
  if (!process.env.TRSSH_UPSTREAM_BINARY) throw new Error('Set TRSSH_UPSTREAM_BINARY to a verified official CLI executable');
  const fixture = await sshFixture();
  process.env.THINKRAIL_SSH_DATA_DIR = await mkdtemp(join(tmpdir(), 'trssh-upstream-desktop-'));
  process.env.PATH = fixture.directory + ':' + process.env.PATH;
  await writeFile(fixture.binary, `#!/bin/sh\nexport THINKRAIL_DATA_DIR=${shellQuote(join(fixture.directory, 'upstream-data'))}\nexport PI_CODING_AGENT_DIR=${shellQuote(join(fixture.directory, 'upstream-pi'))}\nexport XDG_CACHE_HOME=${shellQuote(join(fixture.directory, 'upstream-cache'))}\nexec ${shellQuote(process.env.TRSSH_UPSTREAM_BINARY)} --no-analytics "$@"\n`);
  await import('../src/main.js');
  let mainWindow;
  let failed = false;
  try {
    mainWindow = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html')), 'Desktop did not open');
    await until(() => mainWindow.webContents.executeJavaScript('Boolean(window.connector)'), 'Desktop not initialized');
    await mainWindow.webContents.executeJavaScript(`window.connector.connect(${JSON.stringify({ host: 'fixture', remotePort: fixture.remotePort, binary: fixture.binary })})`);
    const workspace = await until(() => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://127.0.0.1:')), 'Official Thinkrail workspace did not open');
    await until(() => workspace.executeJavaScript("Boolean(document.querySelector('#root')?.children.length)"), 'Official frontend did not mount');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const info = await workspace.executeJavaScript(`({title:document.title, text:document.body.innerText.slice(0,2000), failures:performance.getEntriesByType('resource').filter(e=>e.name.startsWith(location.origin)&&e.responseStatus>=400).map(e=>({url:e.name,status:e.responseStatus}))})`);
    if (info.failures.length) throw new Error(JSON.stringify(info.failures));
    if (process.env.TRSSH_UPSTREAM_SCREENSHOT) await writeFile(process.env.TRSSH_UPSTREAM_SCREENSHOT, (await workspace.capturePage()).toPNG());
    console.log('UPSTREAM_SMOKE_PASS', JSON.stringify(info));
  } catch (error) {
    failed = true;
    console.error(error);
    if (mainWindow) console.error(await mainWindow.webContents.executeJavaScript('window.connector.getState()'));
    try { console.error(await readFile(join(fixture.directory, 'remote-cache/thinkrail-ssh', `port-${fixture.remotePort}.log`), 'utf8')); } catch {}
  } finally {
    try {
      await writeFile(join(fixture.directory, 'host.pid'), await readFile(join(fixture.directory, 'remote-cache/thinkrail-ssh', `port-${fixture.remotePort}.pid`)));
    } catch {}
    if (mainWindow) await mainWindow.webContents.executeJavaScript('window.connector.disconnect()');
    await fixture.close();
    if (failed) app.exit(1); else app.quit();
  }
}
void run().catch(error => { console.error(error); app.exit(1); });
