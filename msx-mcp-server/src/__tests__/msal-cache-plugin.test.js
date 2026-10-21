import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMsalCachePlugin,
  writeMsalCacheFileAtomic,
} from '../msal-cache-plugin.js';

const temporaryDirectories = [];

function makeCachePath() {
  const directory = mkdtempSync(join(tmpdir(), 'msx-iq-msal-cache-'));
  temporaryDirectories.push(directory);
  return join(directory, 'cache.json');
}

function makeContext({
  cacheHasChanged = false,
  serialized = '{}',
} = {}) {
  return {
    cacheHasChanged,
    tokenCache: {
      deserialize: vi.fn(),
      serialize: vi.fn(() => serialized),
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MSAL cache persistence', () => {
  it('resets concatenated JSON instead of passing it to MSAL', async () => {
    const cachePath = makeCachePath();
    writeFileSync(cachePath, '{"Account":{}}{"RefreshToken":{}}', 'utf-8');
    const onCacheCorruption = vi.fn();
    const plugin = createMsalCachePlugin({ cachePath, onCacheCorruption });
    const context = makeContext();

    await plugin.beforeCacheAccess(context);
    await plugin.afterCacheAccess(context);

    expect(context.tokenCache.deserialize).toHaveBeenCalledOnce();
    expect(context.tokenCache.deserialize).toHaveBeenCalledWith('{}');
    expect(onCacheCorruption).toHaveBeenCalledOnce();

    const nextContext = makeContext();
    await plugin.beforeCacheAccess(nextContext);
    await plugin.afterCacheAccess(nextContext);
    expect(nextContext.tokenCache.deserialize).toHaveBeenCalledWith('{}');
    expect(onCacheCorruption).toHaveBeenCalledOnce();
  });

  it('atomically replaces an existing cache without leaving temp files', () => {
    const cachePath = makeCachePath();
    writeFileSync(cachePath, '{"old":true}', 'utf-8');

    writeMsalCacheFileAtomic(cachePath, '{"new":true}');

    expect(JSON.parse(readFileSync(cachePath, 'utf-8'))).toEqual({ new: true });
    expect(readdirSync(dirname(cachePath))).toEqual(['cache.json']);
  });

  it('serializes services sharing the same cache path', async () => {
    const cachePath = makeCachePath();
    writeFileSync(cachePath, '{"version":0}', 'utf-8');
    const first = createMsalCachePlugin({ cachePath });
    const second = createMsalCachePlugin({ cachePath });
    const firstContext = makeContext({
      cacheHasChanged: true,
      serialized: '{"version":1}',
    });
    const secondContext = makeContext();

    await first.beforeCacheAccess(firstContext);
    let secondEntered = false;
    const secondBefore = second.beforeCacheAccess(secondContext).then(() => {
      secondEntered = true;
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);

    await first.afterCacheAccess(firstContext);
    await secondBefore;
    await second.afterCacheAccess(secondContext);

    expect(secondContext.tokenCache.deserialize).toHaveBeenCalledWith(
      '{"version":1}',
    );
  });

  it('surfaces non-JSON filesystem errors', async () => {
    const cachePath = makeCachePath();
    const plugin = createMsalCachePlugin({
      cachePath: join(cachePath, '..'),
      onCacheCorruption: vi.fn(),
    });
    const context = makeContext();

    await expect(plugin.beforeCacheAccess(context)).rejects.toThrow();
  });
});
