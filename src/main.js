import { app, BrowserWindow, WebContentsView, ipcMain, Menu, powerMonitor, session, shell, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ProfileStore } from './core/store.js';
import { validateProfile } from './core/profile.js';
import { Connection } from './core/connection.js';
import { ACCESS_HEADER } from './core/gateway.js';
import { createAskpass } from './core/askpass.js';

const root = fileURLToPath(new URL('.', import.meta.url));
if (process.env.THINKRAIL_SSH_DATA_DIR) app.setPath('userData', process.env.THINKRAIL_SSH_DATA_DIR);
app.setName('Thinkrail SSH');
let window, view, connection, askpass, store;
let data = { profiles: [], lastId: null };
let logs = [];
let settings = true;
let loadedOrigin = null;
let state = { status: 'disconnected', stage: '尚未连接', host: '', error: '' };
let authWindow = null, authPrompt = '', authResolve = null;
let mutations = Promise.resolve();
let configurationError = '';

function snapshot() { return { ...data, connection: state, logs, settings, hasWorkspace: Boolean(view && loadedOrigin) }; }
function broadcast() {
  if (window && !window.isDestroyed()) window.webContents.send('connector:changed', snapshot());
}
function log(message) { logs = [...logs.slice(-99), { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message: String(message).slice(0, 4096) }]; broadcast(); }
function layout() {
  if (!window || !view) return;
  const [width, height] = window.getContentSize();
  view.setBounds({ x: 0, y: 64, width, height: Math.max(0, height - 64) });
  view.setVisible(!settings);
}

function trustedWindow(event) {
  const target = [window, authWindow].find(candidate => candidate && !candidate.isDestroyed() && candidate.webContents === event.sender);
  if (!target || event.senderFrame !== target.webContents.mainFrame) throw new Error('Untrusted window control sender');
  return target;
}

function windowState(target) {
  return { maximized: target.isMaximized() || target.isFullScreen(), focused: target.isFocused() };
}

function attachWindowState(target) {
  const publish = () => {
    if (!target.isDestroyed()) target.webContents.send('window:changed', windowState(target));
  };
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) target.on(event, publish);
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) void shell.openExternal(url).catch(error => log(error.message));
  } catch {}
}

function createWorkspace(profile, origin) {
  const partition = session.fromPartition(`persist:thinkrail-${profile.id}`);
  partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  partition.setPermissionCheckHandler(() => false);
  if (view) { window.contentView.removeChildView(view); view.webContents.close(); }
  view = new WebContentsView({ webPreferences: {
    session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, backgroundThrottling: false, spellcheck: false,
  } });
  const contents = view.webContents;
  partition.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers[ACCESS_HEADER];
    // A cross-origin iframe must never receive a connector credential.
    const initiator = details.initiatorOrigin ?? details.initiator;
    const sameInitiator = details.resourceType === 'mainFrame' || initiator === origin || initiator === `${origin}/`;
    if (details.webContentsId === contents.id && sameInitiator && new URL(details.url).origin.replace(/^ws/, 'http') === origin) {
      if (connection?.gateway.origin === origin) headers[ACCESS_HEADER] = connection.gateway.key;
    }
    callback({ requestHeaders: headers });
  });
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  const guardNavigation = (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('render-process-gone', (_event, details) => {
    settings = true;
    log(`工作页面已退出（${details.reason}），可点击“刷新页面”恢复。`);
    layout(); broadcast();
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) log(`页面加载失败：${description}。连接恢复后可刷新页面。`);
  });
  window.contentView.addChildView(view);
  loadedOrigin = origin;
  layout();
  return contents.loadURL(origin).catch(error => log(error.message));
}

async function connect(input) {
  const previous = data.profiles.find(p => p.id === input?.id);
  const profile = validateProfile(input, previous);
  await stopConnection(false);
  logs = [];
  const next = new Connection(profile, { askpass: askpass.scriptPath });
  connection = next;
  next.on('log', log);
  next.on('state', nextState => { if (connection === next) { state = nextState; broadcast(); } });
  next.on('ready', origin => {
    if (connection !== next) return;
    // Reconnect in place: retain the renderer, its client identity, and unresolved requests.
    if (!view || loadedOrigin !== origin) void createWorkspace(profile, origin);
    settings = false; layout(); broadcast();
  });
  try {
    await next.start();
    data.profiles = [...data.profiles.filter(p => p.id !== profile.id), profile];
    data.lastId = profile.id;
    await store.save(data);
  } catch (error) {
    await next.stop();
    state = { status: 'error', stage: '连接失败', host: profile.host, error: error.message };
    broadcast(); throw error;
  }
  return snapshot();
}

async function stopConnection(destroyView = true) {
  cancelAuthentication();
  const old = connection;
  connection = null;
  if (old) await old.stop();
  if (view && destroyView) {
    window?.contentView.removeChildView(view);
    view.webContents.close(); view = null; loadedOrigin = null;
  }
  state = { status: 'disconnected', stage: '已断开', host: '', error: '' };
}

function cancelAuthentication() {
  if (authResolve) { authResolve(null); authResolve = null; }
  const previous = authWindow;
  authWindow = null;
  if (previous && !previous.isDestroyed()) previous.close();
}

async function authenticate(prompt) {
  cancelAuthentication();
  if (!window || window.isDestroyed()) return null;
  authPrompt = prompt;
  return new Promise(resolve => {
    authResolve = resolve;
    const promptWindow = new BrowserWindow({
      parent: window, modal: true, width: 520, height: 330, resizable: false, minimizable: false,
      title: 'SSH 认证', frame: false, maximizable: false, autoHideMenuBar: true,
      webPreferences: { preload: join(root, 'auth-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    authWindow = promptWindow;
    attachWindowState(promptWindow);
    promptWindow.on('closed', () => {
      if (authWindow !== promptWindow) return;
      if (authResolve) { authResolve(null); connection?.cancelAuthentication(); }
      authResolve = null; authWindow = null;
    });
    void promptWindow.loadFile(join(root, 'ui/auth.html'));
  });
}

function handler(name, action, { serialize = false } = {}) {
  ipcMain.handle(`connector:${name}`, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted sender');
    if (configurationError && ['connect', 'remove', 'reset-address'].includes(name)) throw new Error(configurationError);
    if (!serialize) return action(...args);
    const next = mutations.then(() => action(...args));
    mutations = next.catch(() => {});
    return next;
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    store = new ProfileStore(join(app.getPath('userData'), 'profiles.json'));
    try { data = await store.load(); } catch (error) {
      configurationError = error.message;
      state = { ...state, status: 'error', stage: '配置读取失败', error: configurationError };
      log(configurationError);
    }
    askpass = await createAskpass(authenticate);
    window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 780, minHeight: 600, title: 'Thinkrail SSH',
      backgroundColor: '#101316', frame: false, autoHideMenuBar: true,
      webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    attachWindowState(window);
    ipcMain.handle('window:state', event => windowState(trustedWindow(event)));
    ipcMain.handle('window:action', (event, action) => {
      const target = trustedWindow(event);
      switch (action) {
        case 'minimize': if (target.isMinimizable()) target.minimize(); break;
        case 'maximize':
          if (target.isFullScreen()) target.setFullScreen(false);
          else if (target.isMaximizable()) {
            if (target.isMaximized()) target.unmaximize(); else target.maximize();
          }
          break;
        case 'close': target.close(); break;
        default: throw new Error('Unknown window action');
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '连接', submenu: [
        { label: '连接设置', accelerator: 'CommandOrControl+,', click: () => { settings = true; layout(); broadcast(); } },
        { label: '刷新工作页面', accelerator: 'CommandOrControl+R', click: () => view?.webContents.reloadIgnoringCache() },
        { type: 'separator' }, { role: 'quit' },
      ] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
    ]));
    window.on('resize', layout);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    handler('state', snapshot);
    handler('connect', connect, { serialize: true });
    handler('disconnect', async () => { await stopConnection(); settings = true; layout(); broadcast(); return snapshot(); }, { serialize: true });
    handler('settings', () => { settings = true; layout(); broadcast(); });
    handler('workspace', () => { if (view) { settings = false; layout(); broadcast(); } });
    handler('reload', () => view?.webContents.reloadIgnoringCache());
    handler('reconnect', async () => {
      if (!connection) return;
      const profile = connection.profile;
      await connect(profile);
    }, { serialize: true });
    handler('remove', async id => {
      if (connection?.profile.id === id) { await stopConnection(); settings = true; layout(); }
      data.profiles = data.profiles.filter(p => p.id !== id);
      if (data.lastId === id) data.lastId = data.profiles[0]?.id || null;
      await store.save(data); broadcast();
    }, { serialize: true });
    handler('reset-address', async id => {
      if (connection?.profile.id === id) await stopConnection();
      const profile = data.profiles.find(p => p.id === id);
      if (profile) { profile.localPort = 0; await store.save(data); }
      settings = true; layout(); broadcast();
    }, { serialize: true });
    ipcMain.handle('authentication:prompt', event => {
      if (event.sender !== authWindow?.webContents || event.senderFrame !== authWindow.webContents.mainFrame) throw new Error('Untrusted sender');
      return authPrompt;
    });
    ipcMain.handle('authentication:answer', (event, answer) => {
      if (event.sender !== authWindow?.webContents || event.senderFrame !== authWindow.webContents.mainFrame) throw new Error('Untrusted sender');
      if (typeof answer !== 'string' && answer !== null) throw new Error('Invalid response');
      authResolve?.(typeof answer === 'string' ? answer.slice(0, 8192) : null);
      authResolve = null;
      if (answer === null) connection?.cancelAuthentication();
      authWindow.close();
    });
    powerMonitor.on('resume', () => {
      log('电脑已唤醒，正在恢复连接');
      if (connection && connection.state.status !== 'error') connection.retryNow();
    });
    await window.loadFile(join(root, 'ui/index.html'));
  }).catch(error => { dialog.showErrorBox('Thinkrail SSH 启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void (async () => {
      cancelAuthentication();
      try {
        await stopConnection(false);
        await askpass?.close();
      } catch (error) { console.error('Connection cleanup failed:', error.message); }
      finally { app.quit(); }
    })();
  });
}
