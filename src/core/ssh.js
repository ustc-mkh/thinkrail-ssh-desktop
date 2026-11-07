import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import http from 'node:http';
import { shellQuote } from './profile.js';

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function sshArgs(profile, localPort) {
  return [
    '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    // Own this connection: do not attach to / terminate the user's unrelated SSH master.
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`,
    profile.host, 'sh',
  ];
}

/** This is our small POSIX launcher, not an integration with Thinkrail internals. */
export function startScript(profile, marker) {
  return `
trssh_start() (
  umask 077
  bin=${shellQuote(profile.binary)}
  project=${shellQuote(profile.project)}
  case "$bin" in '~/'*) bin="$HOME/\${bin#??}" ;; esac
  case "$project" in '~/'*) project="$HOME/\${project#??}" ;; esac
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [ "$bin" = thinkrail ] && [ -x "$HOME/.local/bin/thinkrail" ]; then
      bin="$HOME/.local/bin/thinkrail"
    else
      printf '%s\\n' 'Thinkrail executable not found; install the official CLI or set its absolute path.' >&2
      return 127
    fi
  fi
  slot="\${XDG_CACHE_HOME:-$HOME/.cache}/thinkrail-ssh/port-${profile.remotePort}"
  mkdir -p "\${slot%/*}" || return 1
  lock="$slot.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    printf '%s\\n' "Another start is in progress. If stale, remove: $lock" >&2
    return 75
  fi
  trap 'rmdir "$lock" 2>/dev/null' 0
  if [ -f "$slot.pid" ]; then
    pid=$(cat "$slot.pid")
    case "$pid" in ''|*[!0-9]*) ;; *)
      if kill -0 "$pid" 2>/dev/null; then
        printf '%s\\n' "Keeping existing process $pid. Log: $slot.log"
        return 0
      fi ;;
    esac
  fi
  set -- --no-open --host 127.0.0.1 --port ${profile.remotePort}
  if [ -n "$project" ]; then set -- "$@" "$project"; fi
  nohup "$bin" "$@" < /dev/null > "$slot.log" 2>&1 &
  pid=$!
  printf '%s\\n' "$pid" > "$slot.pid"
  printf '%s\\n' "Started PID $pid. Log: $slot.log"
)
trssh_start
trssh_code=$?
printf '%s:%s\\n' ${shellQuote(marker)} "$trssh_code"
`;
}

export function probeHealth(port, { signal, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', agent: false, signal }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(new Error('远端健康检查返回了意外内容')); });
      res.on('end', () => {
        if (res.statusCode === 200 && body.trim() === 'ok') resolve(true);
        else reject(Object.assign(new Error(`端口 ${port} 的服务不是预期的 Thinkrail（HTTP ${res.statusCode}）`), { code: 'WRONG_SERVICE' }));
      });
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('远端服务已建立连接但健康检查超时；请检查其负载或日志，连接器不会重复启动它'), { code: 'SERVICE_UNRESPONSIVE' })));
    req.on('error', reject);
  });
}

export class SshSession extends EventEmitter {
  constructor(profile, { askpass, spawnProcess = spawn } = {}) {
    super();
    this.profile = profile;
    this.askpass = askpass;
    this.spawnProcess = spawnProcess;
    this.closed = false;
    this.pending = new Map();
    this.lastError = '';
  }

  async open(signal) {
    this.port = await freePort();
    if (signal?.aborted || this.closed) throw new Error('连接已取消');
    this.child = this.spawnProcess('ssh', sshArgs(this.profile, this.port), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...(this.askpass ? {
        SSH_ASKPASS: this.askpass, SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY || ':0',
      } : {}) },
    });
    this.child.stdin.on('error', error => this.rejectPending(error));
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        let consumed = false;
        for (const [marker, pending] of this.pending) {
          if (line === marker || line.startsWith(`${marker}:`)) {
            this.pending.delete(marker);
            pending.resolve(line);
            consumed = true;
            break;
          }
        }
        if (!consumed && line) this.emit('log', line);
      }
    });
    this.child.stderr.on('data', chunk => {
      const message = chunk.toString().trim().replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-4096);
      this.lastError = message;
      if (message) this.emit('log', message);
    });
    this.child.on('error', error => {
      this.lastError = error.code === 'ENOENT' ? '未找到系统 ssh，请安装 OpenSSH 客户端' : error.message;
      this.rejectPending(new Error(this.lastError));
    });
    this.child.on('close', code => {
      this.closed = true;
      this.rejectPending(new Error(this.lastError || `SSH 已断开（${code}）`));
      this.emit('close', this.lastError || `SSH 已断开（${code}）`);
    });
    const abort = () => this.close();
    signal?.addEventListener('abort', abort, { once: true });
    this.child.once('close', () => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) { this.close(); throw new Error('连接已取消'); }
    const marker = `TRSSH_READY_${randomBytes(12).toString('hex')}`;
    await this.command(`printf '%s\\n' ${shellQuote(marker)}\n`, marker, 120000, signal);
    return this.port;
  }

  async startHost(signal) {
    const marker = `TRSSH_BOOT_${randomBytes(12).toString('hex')}`;
    const result = await this.command(startScript(this.profile, marker), marker, 30000, signal);
    if (result !== `${marker}:0`) throw new Error(`远端启动失败（${result.split(':').at(-1)}）。${this.lastError}`);
  }

  command(script, marker, timeout, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('SSH 连接已关闭'));
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(marker);
        callback(value);
      };
      const abort = () => finish(reject, new Error('连接已取消'));
      const timer = setTimeout(() => finish(reject, new Error('SSH 操作超时，请检查认证提示或连接日志')), timeout);
      this.pending.set(marker, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(script);
    });
  }

  rejectPending(error) {
    for (const pending of [...this.pending.values()]) pending.reject(error);
  }

  close() {
    this.closed = true;
    this.rejectPending(new Error('SSH 连接已关闭'));
    if (this.child) {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  }
}
