import { randomUUID } from 'node:crypto';

function text(value, label, max = 2048) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}格式不正确`);
  }
  return value.trim();
}

export function validateProfile(input, previous = {}) {
  if (!input || typeof input !== 'object') throw new Error('连接配置不正确');
  const host = text(input.host, 'SSH 主机', 256);
  if (!host || host.startsWith('-') || !/^[\p{L}\p{N}_.@:%+\[\]-]+$/u.test(host)) {
    throw new Error('请输入 SSH 主机别名或 user@host；端口和跳板机请配置在 ~/.ssh/config 中');
  }
  const remotePort = Number(input.remotePort ?? 24242);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error('远端端口必须在 1–65535 之间');
  }
  const binary = text(input.binary ?? 'thinkrail', 'Thinkrail 可执行文件');
  if (!binary || binary.startsWith('-')) throw new Error('请输入可执行文件名称或路径，不包含命令参数');
  return {
    id: previous.id || randomUUID(),
    host,
    remotePort,
    project: text(input.project ?? '', '项目路径'),
    binary,
    autoStart: input.autoStart !== false,
    // A port belongs to an endpoint, not a temporary SSH connection.
    localPort: previous.host === host && previous.remotePort === remotePort ? previous.localPort || 0 : 0,
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
