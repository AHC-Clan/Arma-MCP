import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Launcher } from '../src/launch/launcher.js';

test('launch dry-run plans mission-specific autotest configs without writing shared temp state', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-launcher-'));
  const rptDir = path.join(root, 'rpt');
  const firstMission = path.join(root, 'first.VR');
  const secondMission = path.join(root, 'second.VR');
  mkdirSync(rptDir);
  mkdirSync(firstMission);
  mkdirSync(secondMission);

  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ arma: { missionsDir: root } }), 'utf8');
  const launcher = new Launcher(loadConfig(configPath), rptDir);

  const first = await launcher.launch({
    mission: firstMission,
    modset: 'none',
    dryRun: true,
  });
  const second = await launcher.launch({
    mission: secondMission,
    modset: 'none',
    dryRun: true,
  });
  const firstCfg = /-autotest="([^"]+)"/.exec(first.argString)?.[1];
  const secondCfg = /-autotest="([^"]+)"/.exec(second.argString)?.[1];

  assert.ok(firstCfg);
  assert.ok(secondCfg);
  assert.notEqual(firstCfg, secondCfg);
  assert.equal(existsSync(firstCfg), false);
  assert.equal(existsSync(secondCfg), false);
});
