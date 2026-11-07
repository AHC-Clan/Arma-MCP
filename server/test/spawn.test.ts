import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnDetached } from '../src/launch/spawn.js';

test('spawnDetached rejects an asynchronous missing-executable error', async () => {
  const missing = path.join(tmpdir(), `arma-mcp-missing-${process.pid}-${Date.now()}.exe`);
  await assert.rejects(spawnDetached(missing, []), /ENOENT|not found/i);
});

test('spawnDetached exposes an early child exit as an abort signal', async () => {
  const processRef = await spawnDetached(process.execPath, ['-e', 'process.exit(7)']);
  if (!processRef.exitSignal.aborted) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child exit was not observed')), 3000);
      processRef.exitSignal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  assert.equal(processRef.exitInfo()?.code, 7);
  assert.match((processRef.exitSignal.reason as Error).message, /exit code 7/);
});
