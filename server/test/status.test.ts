import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import type { Deps } from '../src/mcp/deps.js';
import { saveLaunchProfile } from '../src/launch/launchProfiles.js';
import { statusProfiles, statusReadiness } from '../src/mcp/tools/status.js';

function readinessDeps(opts: {
  connected: boolean;
  sessionInfo: boolean;
  world?: string;
  mission?: string;
  dedicated?: boolean;
  receivedAt?: number;
}): Deps {
  return {
    gateway: {
      isConnected: () => opts.connected,
      sessionInfoReceived: () => opts.sessionInfo,
    },
    telemetry: {
      current: () => ({
        world: opts.world ?? '',
        mission: opts.mission ?? '',
        dedicated: opts.dedicated ?? false,
        receivedAt: opts.receivedAt ?? 0,
      }),
    },
  } as unknown as Deps;
}

test('status readiness: raw socket만 연결되면 bridgeReady는 false', () => {
  const ready = statusReadiness(
    readinessDeps({
      connected: true,
      sessionInfo: false,
    }),
  );
  assert.equal(ready.rawConnected, true);
  assert.equal(ready.bridgeReady, false);
  assert.equal(ready.dedicatedReady, false);
});

test('status readiness: sessionInfo와 활성 미션이 있으면 bridgeReady', () => {
  const ready = statusReadiness(
    readinessDeps({
      connected: true,
      sessionInfo: true,
      world: 'Altis',
      mission: 'MCP_Dedicated.Altis',
      receivedAt: Date.now(),
    }),
  );
  assert.equal(ready.bridgeReady, true);
  assert.equal(ready.dedicatedReady, false);
});

test('status readiness: sessionInfo만 있거나 텔레메트리가 오래됐으면 bridgeReady가 아니다', () => {
  const noTelemetry = statusReadiness(
    readinessDeps({
      connected: true,
      sessionInfo: true,
      world: 'Altis',
      mission: 'MCP_Dedicated.Altis',
      receivedAt: 0,
    }),
  );
  assert.equal(noTelemetry.telemetryFresh, false);
  assert.equal(noTelemetry.bridgeReady, false);

  const staleTelemetry = statusReadiness(
    readinessDeps({
      connected: true,
      sessionInfo: true,
      world: 'Altis',
      mission: 'MCP_Dedicated.Altis',
      receivedAt: Date.now() - 60_000,
    }),
  );
  assert.equal(staleTelemetry.telemetryFresh, false);
  assert.equal(staleTelemetry.bridgeReady, false);
});

test('status readiness: dedicated 플래그까지 있어야 dedicatedReady', () => {
  const ready = statusReadiness(
    readinessDeps({
      connected: true,
      sessionInfo: true,
      world: 'Altis',
      mission: 'MCP_Dedicated.Altis',
      dedicated: true,
      receivedAt: Date.now(),
    }),
  );
  assert.equal(ready.bridgeReady, true);
  assert.equal(ready.dedicatedReady, true);
});

function profilesConfig(file: string): Config {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-status-'));
  const cfgPath = path.join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({ arma: { profilesFile: file } }), 'utf8');
  return loadConfig(cfgPath);
}

test('status profiles: 저장된 프로필 이름을 정렬해 돌려준다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-status-'));
  const file = path.join(dir, 'launch-profiles.json');
  const cfg = profilesConfig(file);
  assert.deepEqual(await statusProfiles(cfg), { profiles: [] });

  await saveLaunchProfile(file, 'wc_mp', { mode: 'mp', savedAt: '2026-09-23T00:00:00.000Z' });
  await saveLaunchProfile(file, 'altis', { mode: 'sp', savedAt: '2026-09-23T00:00:00.000Z' });
  assert.deepEqual(await statusProfiles(cfg), { profiles: ['altis', 'wc_mp'] });
});

test('status profiles: 깨진 파일은 빈 목록과 이유를 돌려준다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-status-'));
  const file = path.join(dir, 'launch-profiles.json');
  writeFileSync(file, 'not json', 'utf8');
  const res = await statusProfiles(profilesConfig(file));
  assert.deepEqual(res.profiles, []);
  assert.ok(res.profilesError?.includes(file));
});
