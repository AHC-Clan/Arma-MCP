import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Gateway } from '../src/ipc/gateway.js';
import { encode } from '../src/ipc/frame.js';
import { loadConfig } from '../src/config.js';

function configFor(pipeName: string): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-owner-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ pipeName }), 'utf8');
  return loadConfig(file);
}

function waitForEvent(emitter: Gateway, event: 'sessionInfo'): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

test('strict gateway ownership fails while legacy mode remains degraded', async () => {
  const pipeName = `\\\\.\\pipe\\arma_mcp_owner_${process.pid}_${Date.now()}`;
  const cfg = configFor(pipeName);
  const owner = new Gateway(cfg);
  const strictContender = new Gateway(cfg);
  const legacyContender = new Gateway(cfg);
  try {
    await owner.start({ requireOwnership: true });
    await assert.rejects(
      strictContender.start({ requireOwnership: true }),
      /cannot own .*already in use/,
    );
    await legacyContender.start();
    assert.equal(legacyContender.getListenerState(), 'pipe-unavailable');
  } finally {
    await strictContender.stop();
    await legacyContender.stop();
    await owner.stop();
  }
});

test('gateway exposes a monotonic connection generation and sessionInfo readiness', async () => {
  const pipeName = `\\\\.\\pipe\\arma_mcp_generation_${process.pid}_${Date.now()}`;
  const gateway = new Gateway(configFor(pipeName));
  let socket: net.Socket | null = null;
  try {
    await gateway.start({ requireOwnership: true });
    const accepted = new Promise<void>((resolve) =>
      gateway.once('connected', () => resolve()),
    );
    socket = net.connect(pipeName);
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', resolve);
      socket!.once('error', reject);
    });
    await accepted;
    assert.equal(gateway.generation(), 1);
    assert.equal(gateway.sessionInfoReceived(), false);
    const received = waitForEvent(gateway, 'sessionInfo');
    socket.write(
      encode(JSON.stringify({ v: 1, type: 'sessionInfo', dedicated: true })),
    );
    await received;
    assert.equal(gateway.sessionInfoReceived(), true);
  } finally {
    socket?.destroy();
    await gateway.stop();
  }
});

test('frames queued by a replaced socket cannot mutate the current generation', async () => {
  class FakeSocket extends EventEmitter {
    destroyed = false;
    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.emit('close');
      return this;
    }
    write(): boolean {
      return !this.destroyed;
    }
  }

  const gateway = new Gateway(
    configFor(`\\\\.\\pipe\\arma_mcp_stale_socket_${process.pid}_${Date.now()}`),
  );
  const inject = (
    gateway as unknown as {
      onConnection(socket: net.Socket, via: string): void;
    }
  ).onConnection.bind(gateway);
  const oldSocket = new FakeSocket();
  const currentSocket = new FakeSocket();
  let sessionInfoFrames = 0;
  gateway.on('sessionInfo', () => {
    sessionInfoFrames += 1;
  });

  inject(oldSocket as unknown as net.Socket, 'old');
  inject(currentSocket as unknown as net.Socket, 'current');
  assert.equal(gateway.generation(), 2);

  oldSocket.emit(
    'data',
    encode(JSON.stringify({ v: 1, type: 'sessionInfo', mission: 'stale' })),
  );
  assert.equal(sessionInfoFrames, 0);
  assert.equal(gateway.sessionInfoReceived(), false);

  currentSocket.emit(
    'data',
    encode(JSON.stringify({ v: 1, type: 'sessionInfo', mission: 'current' })),
  );
  assert.equal(sessionInfoFrames, 1);
  assert.equal(gateway.sessionInfoReceived(), true);
  await gateway.stop();
});
