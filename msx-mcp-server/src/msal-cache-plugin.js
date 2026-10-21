import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const cacheAccessLocks = new Map();

function cacheLockKey(cachePath) {
  const key = resolve(cachePath);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

async function acquireCacheAccess(cachePath) {
  const key = cacheLockKey(cachePath);
  const previous = cacheAccessLocks.get(key);
  let unlock;
  const current = new Promise((resolveLock) => {
    unlock = resolveLock;
  });
  cacheAccessLocks.set(key, current);
  if (previous) await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (cacheAccessLocks.get(key) === current) cacheAccessLocks.delete(key);
  };
}

export function writeMsalCacheFileAtomic(cachePath, serialized) {
  JSON.parse(serialized);
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
    renameSync(temporaryPath, cachePath);
  } finally {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original persistence error; a uniquely named temp file is harmless.
    }
  }
}

export function createMsalCachePlugin({ cachePath, onCacheCorruption } = {}) {
  if (!cachePath) throw new Error('An MSAL cache path is required.');
  const releases = new WeakMap();

  function resetCorruptedCache(cacheContext) {
    cacheContext.tokenCache.deserialize('{}');
    writeMsalCacheFileAtomic(cachePath, '{}');
    onCacheCorruption?.();
  }

  return {
    beforeCacheAccess: async (cacheContext) => {
      const release = await acquireCacheAccess(cachePath);
      releases.set(cacheContext, release);

      try {
        if (!existsSync(cachePath)) return;
        const serialized = readFileSync(cachePath, 'utf-8');
        if (!serialized.trim()) {
          resetCorruptedCache(cacheContext);
          return;
        }

        try {
          JSON.parse(serialized);
        } catch {
          // Never pass partial or concatenated JSON into MSAL. The next successful
          // sign-in can now proceed from a known-empty persistent cache.
          resetCorruptedCache(cacheContext);
          return;
        }
        cacheContext.tokenCache.deserialize(serialized);
      } catch (error) {
        releases.delete(cacheContext);
        release();
        throw error;
      }
    },
    afterCacheAccess: async (cacheContext) => {
      const release = releases.get(cacheContext);
      try {
        if (cacheContext.cacheHasChanged) {
          writeMsalCacheFileAtomic(
            cachePath,
            cacheContext.tokenCache.serialize(),
          );
        }
      } finally {
        releases.delete(cacheContext);
        release?.();
      }
    },
  };
}

export async function removeMsalCacheFile(cachePath) {
  const release = await acquireCacheAccess(cachePath);
  try {
    if (existsSync(cachePath)) unlinkSync(cachePath);
  } finally {
    release();
  }
}
