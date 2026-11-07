import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateProfile, shellQuote } from '../src/core/profile.js';
import { ProfileStore } from '../src/core/store.js';
import { sshArgs, startScript } from '../src/core/ssh.js';

test('shell arguments cannot execute project or executable path contents', () => {
  const input = "a'b; $(printf owned) `printf owned` \" /空 格";
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(input)}`], { encoding: 'utf8' }), input);
  const profile = validateProfile({ host: 'user@dev', project: input, binary: input });
  execFileSync('sh', ['-n'], { input: startScript(profile, 'TEST_MARKER') });
  assert.ok(sshArgs(profile, 12345).includes('user@dev'));
  assert.equal(sshArgs(profile, 12345).at(-1), 'sh');
});

test('rejects option injection and invalid ports; keeps local address only for the same endpoint', () => {
  for (const host of ['-oProxyCommand=evil', 'a\nb', 'a b', 'dev;touch', '$(evil)', '']) {
    assert.throws(() => validateProfile({ host }));
  }
  for (const remotePort of [0, 65536, 1.1, 'bad']) assert.throws(() => validateProfile({ host: 'dev', remotePort }));
  const previous = { ...validateProfile({ host: 'dev' }), localPort: 34567 };
  assert.equal(validateProfile({ host: 'dev' }, previous).localPort, 34567);
  assert.equal(validateProfile({ host: 'other' }, previous).localPort, 0);
  assert.equal(validateProfile({ host: 'dev', remotePort: 24243 }, previous).localPort, 0);
});

test('profiles persist atomically with private permissions; corrupt data is not silently overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trssh-store-'));
  try {
    const path = join(directory, 'profiles.json');
    const store = new ProfileStore(path);
    assert.deepEqual(await store.load(), { profiles: [], lastId: null });
    const profile = { ...validateProfile({ host: 'dev' }), localPort: 34567 };
    await store.save({ profiles: [profile], lastId: profile.id });
    assert.deepEqual((await store.load()).profiles, [profile]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, '{broken');
    await assert.rejects(store.load(), /无法读取/);
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
