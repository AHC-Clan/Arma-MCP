import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Gateway } from '../src/ipc/gateway.js';
import { TelemetryStore } from '../src/game/telemetry.js';

type Frame = Record<string, unknown>;

function boundStore(): { store: TelemetryStore; emit: (type: string, m: Frame) => void } {
  const store = new TelemetryStore();
  const handlers: Record<string, (m: Frame) => void> = {};
  const fakeGateway = {
    on: (name: string, cb: (m: Frame) => void) => {
      handlers[name] = cb;
    },
  } as unknown as Gateway;
  store.bind(fakeGateway);
  return { store, emit: (type, m) => handlers[type]!(m) };
}

test('telemetry keeps fpsMin, scripts, paused and focused as null until the addon sends them', () => {
  const { store, emit } = boundStore();
  emit('telemetry', { world: 'Altis', mission: 'm', fps: 50, playerCount: 0 });
  const snap = store.current();
  assert.equal(snap.fps, 50);
  assert.equal(snap.fpsMin, null);
  assert.equal(snap.scripts, null);
  assert.equal(snap.paused, null);
  assert.equal(snap.focused, null);
});

test('telemetry reads fpsMin and names the four diag_activeScripts counts', () => {
  const { store, emit } = boundStore();
  emit('telemetry', {
    world: 'VR',
    mission: 'm',
    fps: 48.5,
    fpsMin: 31.2,
    scripts: [4, 1, 0, 2],
    playerCount: 1,
  });
  const snap = store.current();
  assert.equal(snap.fpsMin, 31.2);
  assert.deepEqual(snap.scripts, { spawn: 4, execVM: 1, exec: 0, fsm: 2 });
});

test('telemetry turns the 0|1 window flags into booleans', () => {
  const { store, emit } = boundStore();
  // SP 가 포커스를 잃고 일시정지 메뉴가 열린 상태.
  emit('telemetry', { world: 'VR', mission: 'm', paused: 1, focused: 0, playerCount: 1 });
  assert.equal(store.current().paused, true);
  assert.equal(store.current().focused, false);

  emit('telemetry', { world: 'VR', mission: 'm', paused: 0, focused: 1, playerCount: 1 });
  assert.equal(store.current().paused, false);
  assert.equal(store.current().focused, true);
});

test('a dedicated server frame without window flags leaves them unknown', () => {
  const { store, emit } = boundStore();
  emit('telemetry', {
    world: 'Altis',
    mission: 'm',
    fpsMin: 12,
    scripts: [10, 0, 0, 3],
    playerCount: 2,
    clients: [],
  });
  assert.equal(store.current().paused, null);
  assert.equal(store.current().focused, null);
  assert.equal(store.current().fpsMin, 12);
});

test('a scripts field that is not four numbers parses as unknown', () => {
  const { store, emit } = boundStore();
  emit('telemetry', { world: 'VR', mission: 'm', scripts: [1, 2], playerCount: 0 });
  assert.equal(store.current().scripts, null);
  emit('telemetry', { world: 'VR', mission: 'm', scripts: [1, '2', 3, 4], playerCount: 0 });
  assert.equal(store.current().scripts, null);
});

test('a new connection clears the window flags from the previous mission', () => {
  const { store, emit } = boundStore();
  emit('telemetry', { world: 'VR', mission: 'm', paused: 1, focused: 0, fpsMin: 20, playerCount: 1 });
  emit('connected', {});
  const snap = store.current();
  assert.equal(snap.paused, null);
  assert.equal(snap.focused, null);
  assert.equal(snap.fpsMin, null);
});
