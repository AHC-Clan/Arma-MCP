import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { readReportedModPath, resolveSelfModSource } from '../src/game/bridgeMod.js';

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-bridgemod-'));
  const stateDir = path.join(root, 'state');
  const modDir = path.join(root, 'Program Files (x86)', '@mod');
  mkdirSync(stateDir);
  mkdirSync(modDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ mcp: { tokenFile: path.join(stateDir, 'daemon.token') } }));
  const cfg = loadConfig(configFile, { quiet: true, env: {} });
  return { root, stateDir, modDir, cfg, file: path.join(stateDir, 'bridge-mod.json') };
}

test('readReportedModPath: 있는 폴더만 돌려준다', () => {
  const { root, file, modDir } = setup();
  try {
    assert.equal(readReportedModPath(file), null);
    writeFileSync(file, 'not json');
    assert.equal(readReportedModPath(file), null);
    writeFileSync(file, JSON.stringify({ modPath: 7 }));
    assert.equal(readReportedModPath(file), null);
    writeFileSync(file, JSON.stringify({ modPath: path.join(root, 'gone') }));
    assert.equal(readReportedModPath(file), null);
    writeFileSync(file, JSON.stringify({ modPath: modDir }));
    assert.equal(readReportedModPath(file), modDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSelfModSource: 비어 있을 때만 게임이 알려 준 경로로 채운다', () => {
  const { root, file, modDir, cfg } = setup();
  try {
    assert.equal(resolveSelfModSource(cfg), 'none');
    assert.equal(cfg.arma.selfModPath, '');

    writeFileSync(file, JSON.stringify({ modPath: modDir }));
    assert.equal(resolveSelfModSource(cfg), 'game-report');
    assert.equal(cfg.arma.selfModPath, modDir);

    cfg.arma.selfModPath = 'D:\\mine';
    assert.equal(resolveSelfModSource(cfg), 'config');
    assert.equal(cfg.arma.selfModPath, 'D:\\mine');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
