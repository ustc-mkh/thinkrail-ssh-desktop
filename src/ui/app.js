const $ = id => document.getElementById(id);
let current = null;
let selectedId = null;
let initialized = false;
let busy = false;
let localError = '';

function fill(profile) {
  selectedId = profile?.id || null;
  $('ssh-host').value = profile?.host || '';
  $('project').value = profile?.project || '';
  $('port').value = profile?.remotePort || 24242;
  $('binary').value = profile?.binary || 'thinkrail';
  $('auto-start').checked = profile?.autoStart !== false;
  $('form-title').textContent = profile ? '连接设置' : '新建连接';
  $('remove').hidden = !profile;
  $('reset-address').hidden = !profile;
  localError = '';
}

function render(state) {
  current = state;
  if (!initialized) {
    fill(state.profiles.find(p => p.id === state.lastId));
    initialized = true;
  }
  const connection = state.connection;
  const active = ['connecting', 'connected', 'recovering'].includes(connection.status);
  $('status').textContent = connection.stage || '尚未连接';
  $('status-dot').className = `dot ${connection.status}`;
  $('host').textContent = connection.host;
  $('home').hidden = !state.settings;
  $('workspace').hidden = !state.hasWorkspace || !state.settings;
  $('settings').hidden = state.settings;
  $('disconnect').hidden = !active && !state.hasWorkspace;
  $('reconnect').hidden = !state.hasWorkspace;
  $('reload').hidden = !state.hasWorkspace;
  $('connect').disabled = busy || ['connecting', 'recovering'].includes(connection.status);
  const error = localError || connection.error;
  $('error').textContent = error;
  $('error').hidden = !error;
  $('empty').hidden = state.profiles.length > 0;
  $('profiles').replaceChildren(...state.profiles.map(profile => {
    const button = document.createElement('button');
    button.className = `profile${selectedId === profile.id ? ' selected' : ''}`;
    button.textContent = profile.host;
    const detail = document.createElement('small');
    detail.textContent = `127.0.0.1:${profile.remotePort}`;
    button.append(detail);
    button.addEventListener('click', () => { fill(profile); render(current); });
    return button;
  }));
  $('log-count').textContent = state.logs.length ? `(${state.logs.length})` : '';
  $('log').textContent = state.logs.map(entry => `${entry.time}  ${entry.message}`).join('\n') || '暂无日志';
}

async function action(callback) {
  try { localError = ''; await callback(); }
  catch (error) { localError = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  finally { if (current) render(current); }
}

$('form').addEventListener('submit', event => {
  event.preventDefault();
  busy = true;
  void action(async () => {
    const result = await window.connector.connect({
      id: selectedId, host: $('ssh-host').value, project: $('project').value,
      remotePort: Number($('port').value), binary: $('binary').value, autoStart: $('auto-start').checked,
    });
    selectedId = result.lastId;
    fill(result.profiles.find(p => p.id === selectedId));
    current = result;
  }).finally(() => { busy = false; render(current); });
});
$('add').addEventListener('click', () => { fill(null); render(current); $('ssh-host').focus(); });
$('remove').addEventListener('click', () => void action(async () => {
  if (selectedId) await window.connector.remove(selectedId);
  fill(null); render(current);
}));
$('reset-address').addEventListener('click', () => void action(() => window.connector.resetAddress(selectedId)));
$('disconnect').addEventListener('click', () => void action(() => window.connector.disconnect()));
$('settings').addEventListener('click', () => void action(() => window.connector.showSettings()));
$('workspace').addEventListener('click', () => void action(() => window.connector.showWorkspace()));
$('reload').addEventListener('click', () => void action(() => window.connector.reload()));
$('reconnect').addEventListener('click', () => void action(() => window.connector.reconnect()));
window.connector.onState(render);
void window.connector.getState().then(render).catch(error => { $('error').hidden = false; $('error').textContent = error.message; });
