import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationCoordinator } from '../src/launch/operationCoordinator.js';
import { createSessionContext } from '../src/mcp/session.js';
import { operationBusy, operationOwner } from '../src/mcp/operationOwner.js';

test('operation coordinator fails fast while a lease is active and releases idempotently', () => {
  const coordinator = new OperationCoordinator();
  const first = coordinator.tryAcquire('arma_launch_server');
  assert.equal(first.acquired, true);
  if (!first.acquired) return;

  const second = coordinator.tryAcquire('arma_launch_mp');
  assert.equal(second.acquired, false);
  if (!second.acquired) {
    assert.equal(second.busy.operation, 'arma_launch_server');
    assert.ok(second.busy.elapsedMs >= 0);
  }

  first.lease.release();
  first.lease.release();
  const third = coordinator.tryAcquire('arma_launch_mp');
  assert.equal(third.acquired, true);
  if (third.acquired) third.lease.release();
});

test('abortActive signals the owner but retains exclusivity until finally release', () => {
  const coordinator = new OperationCoordinator();
  const active = coordinator.tryAcquire('arma_scaffold_mission');
  assert.equal(active.acquired, true);
  if (!active.acquired) return;

  const interrupted = coordinator.abortActive('killed by test');
  assert.equal(interrupted?.operation, 'arma_scaffold_mission');
  assert.equal(active.lease.signal.aborted, true);
  assert.match(String((active.lease.signal.reason as Error).message), /killed by test/);
  assert.equal(coordinator.tryAcquire('arma_launch').acquired, false);

  active.lease.release();
  assert.equal(coordinator.snapshot(), null);
});

test('arma_play holds the same exclusive lease as the launch family', () => {
  const coordinator = new OperationCoordinator();
  const play = coordinator.tryAcquire('arma_play');
  assert.equal(play.acquired, true);
  if (!play.acquired) return;

  const launch = coordinator.tryAcquire('arma_launch');
  assert.equal(launch.acquired, false);
  if (!launch.acquired) assert.equal(launch.busy.operation, 'arma_play');

  // arma_play 는 실행만 최악 8분이고 ready 와 then 까지 더하면 최악 23분을 쥔다.
  // arma_kill 이 그것을 끊을 수 있어야 한다.
  const kill = coordinator.preemptWithKill('stopped by test');
  assert.equal(kill.acquired, true);
  if (!kill.acquired) return;
  assert.equal(kill.interrupted?.operation, 'arma_play');
  assert.equal(play.lease.signal.aborted, true);
  kill.lease.release();
});

test('arma_kill is a valid exclusive operation when no launch is active', () => {
  const coordinator = new OperationCoordinator();
  const kill = coordinator.tryAcquire('arma_kill');
  assert.equal(kill.acquired, true);
  assert.equal(coordinator.snapshot()?.operation, 'arma_kill');
  if (kill.acquired) kill.lease.release();
});

test('preemptWithKill atomically replaces a launch lease until kill finishes', () => {
  const coordinator = new OperationCoordinator();
  const launch = coordinator.tryAcquire('arma_launch_server');
  assert.equal(launch.acquired, true);
  if (!launch.acquired) return;

  const kill = coordinator.preemptWithKill('emergency stop');
  assert.equal(kill.acquired, true);
  if (!kill.acquired) return;
  assert.equal(kill.interrupted?.operation, 'arma_launch_server');
  assert.equal(launch.lease.signal.aborted, true);
  assert.equal(coordinator.snapshot()?.operation, 'arma_kill');

  // The old launch finally block must not clear the replacement kill lease.
  launch.lease.release();
  assert.equal(coordinator.snapshot()?.operation, 'arma_kill');
  assert.equal(coordinator.tryAcquire('arma_launch').acquired, false);
  assert.equal(coordinator.preemptWithKill().acquired, false);

  kill.lease.release();
  assert.equal(coordinator.snapshot(), null);
});

test('lease owner is exposed in the snapshot, the busy result and a kill preemption', () => {
  const coordinator = new OperationCoordinator();
  const owner = { session: 'aaaa1111', transport: 'relay' as const };
  const play = coordinator.tryAcquire('arma_play', owner);
  assert.equal(play.acquired, true);
  if (!play.acquired) return;
  assert.deepEqual(coordinator.snapshot()?.owner, owner);

  const busy = coordinator.tryAcquire('arma_launch', {
    session: 'bbbb2222',
    transport: 'remote-http',
  });
  assert.equal(busy.acquired, false);
  if (!busy.acquired) assert.deepEqual(busy.busy.owner, owner);

  const killer = { session: 'cccc3333', transport: 'standalone' as const };
  const kill = coordinator.preemptWithKill('stopped by test', killer);
  assert.equal(kill.acquired, true);
  if (!kill.acquired) return;
  assert.deepEqual(kill.interrupted?.owner, owner);
  assert.deepEqual(coordinator.snapshot()?.owner, killer);
  play.lease.release();
  kill.lease.release();

  // 주인 없이 잡은 lease 는 owner 키가 없다.
  const bare = coordinator.tryAcquire('arma_kill');
  assert.equal('owner' in (coordinator.snapshot() ?? {}), false);
  if (bare.acquired) bare.lease.release();
});

test('the snapshot owner is a copy the caller cannot mutate', () => {
  const coordinator = new OperationCoordinator();
  const owner = { session: 'aaaa1111', transport: 'relay' as const };
  const lease = coordinator.tryAcquire('arma_launch_mp', owner);
  owner.session = 'changed';
  const snap = coordinator.snapshot();
  assert.equal(snap?.owner?.session, 'aaaa1111');
  snap!.owner!.session = 'mutated';
  assert.equal(coordinator.snapshot()?.owner?.session, 'aaaa1111');
  if (lease.acquired) lease.lease.release();
});

test('operationBusy keeps the error sentence and marks the caller own lease with mine', () => {
  const coordinator = new OperationCoordinator();
  const me = createSessionContext('relay');
  const other = createSessionContext('remote-http');
  const held = coordinator.tryAcquire('arma_play', operationOwner({ session: me }));
  assert.equal(held.acquired, true);
  const busy = coordinator.tryAcquire('arma_launch');
  assert.equal(busy.acquired, false);
  if (busy.acquired) return;

  const mine = JSON.parse(operationBusy({ session: me }, busy.busy).content[0]!.text);
  assert.equal(mine.ok, false);
  assert.equal(mine.error, 'another launch operation is already in progress');
  assert.equal(mine.busy.operation, 'arma_play');
  assert.deepEqual(mine.busy.owner, { session: me.shortId, transport: 'relay' });
  assert.equal(mine.busy.mine, true);

  const theirs = JSON.parse(operationBusy({ session: other }, busy.busy).content[0]!.text);
  assert.equal(theirs.busy.mine, undefined);
  assert.deepEqual(theirs.busy.owner, { session: me.shortId, transport: 'relay' });
  if (held.acquired) held.lease.release();
});
