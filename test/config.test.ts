import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, loadConfig } from '../src/config.js';
import { UsageError } from '../src/errors.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-atomic-config-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns an empty config when the file is absent', async () => {
    expect(await loadConfig(dir)).toEqual({});
  });

  it('parses a valid config file', async () => {
    await fs.writeFile(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ base: 'main', branch: 'atomic', maxCommits: 5, ignore: ['dist/**'] }),
    );
    const config = await loadConfig(dir);
    expect(config.base).toBe('main');
    expect(config.maxCommits).toBe(5);
    expect(config.ignore).toEqual(['dist/**']);
  });

  it('rejects unknown keys', async () => {
    await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ nope: true }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects invalid JSON', async () => {
    await fs.writeFile(path.join(dir, CONFIG_FILENAME), '{ not json');
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(UsageError);
  });

  it('fails when an explicit path is missing', async () => {
    await expect(loadConfig(dir, path.join(dir, 'missing.json'))).rejects.toBeInstanceOf(UsageError);
  });
});
