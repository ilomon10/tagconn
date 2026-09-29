import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DockerService, findDocker, type DockerRun } from '../src/docker.ts';
import { LogHub } from '../src/logHub.ts';
import { recorder, tempDir, waitFor } from './helpers.ts';

function make(run: DockerRun) {
  const rec = recorder();
  const calls: string[][] = [];
  const svc = new DockerService({
    logs: new LogHub(),
    onChange: rec.onChange,
    run: (args, o) => {
      calls.push(args);
      return run(args, o);
    },
    composeFile: () => '/bundle/docker-compose.yml',
    env: () => ({ OFFICE_PORT: '4400' }),
    url: () => 'http://127.0.0.1:4400',
  });
  return { svc, rec, calls };
}

describe('DockerService', () => {
  it('is unavailable (docker_unavailable) when docker is missing', async () => {
    const { svc, rec } = make(async () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }));
    await expect(svc.start()).rejects.toMatchObject({ code: 'docker_unavailable', message: 'Docker is not installed.' });
    expect(svc.status()).toMatchObject({ state: 'unavailable' });
    expect(rec.states()).toEqual(['unavailable']);
  });

  it('says so when docker is installed but not running', async () => {
    const { svc } = make(async () => ({ status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }));
    await expect(svc.start()).rejects.toMatchObject({ code: 'docker_unavailable', message: expect.stringContaining('not running') });
  });

  it('up -d then down with the bundled compose file', async () => {
    const { svc, calls } = make(async () => ({ status: 0, stdout: '', stderr: '' }));
    expect((await svc.start()).state).toBe('starting');
    await waitFor(() => svc.status().state === 'running', 2000, 'running');
    expect(svc.status().url).toBe('http://127.0.0.1:4400');
    expect(calls[1]).toEqual(['compose', '-p', 'tagconn-desktop', '-f', '/bundle/docker-compose.yml', 'up', '-d']);
    expect((await svc.stop()).state).toBe('stopped');
    expect(calls[2]).toEqual(['compose', '-p', 'tagconn-desktop', '-f', '/bundle/docker-compose.yml', 'down']);
  });

  it('turns a failed `up` into crashed with the last stderr line', async () => {
    const { svc } = make(async (args) => (args[0] === 'compose' ? { status: 1, stdout: '', stderr: 'pull access denied\nimage not found' } : { status: 0, stdout: '', stderr: '' }));
    await svc.start();
    await waitFor(() => svc.status().state === 'crashed', 2000, 'crashed');
    expect(svc.status().lastError).toContain('image not found');
  });
});

describe('findDocker (N1)', () => {
  const plantDocker = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'docker');
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, 0o755);
    return f;
  };

  it('walks absolute PATH entries only: relative entries and the cwd never win', () => {
    const root = tempDir();
    const cwd = join(root, 'cwd');
    const good = join(root, 'good');
    plantDocker(cwd);
    const goodDocker = plantDocker(good);
    const env = { PATH: ['.', '', 'relbin', cwd, good].join(delimiter) };
    expect(findDocker(env, 'linux', cwd)).toBe(goodDocker);
  });

  it('is undefined when only the cwd or relative entries have a docker', () => {
    const root = tempDir();
    const cwd = join(root, 'cwd');
    plantDocker(cwd);
    expect(findDocker({ PATH: [cwd, '.', 'x'].join(delimiter) }, 'linux', cwd)).toBeUndefined();
    expect(findDocker({}, 'linux', cwd)).toBeUndefined();
  });
});
