import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateProfile } from './profile.js';

export class ProfileStore {
  constructor(path) { this.path = path; }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      const profiles = Array.isArray(data.profiles) ? data.profiles : [];
      return {
        profiles: profiles.map(p => {
          const valid = validateProfile(p, p);
          if (!/^[a-zA-Z0-9-]{1,80}$/.test(valid.id)) throw new Error('无效的配置 ID');
          if (!Number.isInteger(valid.localPort) || valid.localPort < 0 || valid.localPort > 65535) valid.localPort = 0;
          return valid;
        }),
        lastId: typeof data.lastId === 'string' ? data.lastId : null,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { profiles: [], lastId: null };
      throw new Error(`无法读取连接配置：${error.message}。文件：${this.path}`);
    }
  }

  async save(data) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
