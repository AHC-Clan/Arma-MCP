import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import type { TelemetryStore } from '../src/game/telemetry.js';
import { RptSourceResolver } from '../src/rpt/rptSource.js';
import { CLIENT_RPT_RE, SERVER_RPT_RE } from '../src/rpt/rptFiles.js';

function makeResolver(dedicated: boolean): {
  resolver: RptSourceResolver;
  clientDir: string;
  serverDir: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rpt-source-'));
  const configPath = path.join(root, 'config.json');
  const clientDir = path.join(root, 'client');
  const serverDir = path.join(root, 'server');
  writeFileSync(
    configPath,
    JSON.stringify({ rptDir: clientDir, mp: { profilesDir: serverDir } }),
    'utf8',
  );
  const cfg = loadConfig(configPath);
  const telemetry = {
    current: () => ({ dedicated }),
  } as unknown as TelemetryStore;
  return {
    resolver: new RptSourceResolver(cfg, clientDir, telemetry),
    clientDir,
    serverDir,
  };
}

test('RPT source auto: 상태 미상/비데디이면 기존 client 소스', () => {
  const { resolver, clientDir } = makeResolver(false);
  const scope = resolver.resolve();
  assert.equal(scope.source, 'client');
  assert.equal(scope.dir, clientDir);
  assert.equal(scope.re, CLIENT_RPT_RE);
});

test('RPT source auto: 라이브 dedicated이면 server profiles 소스', () => {
  const { resolver, serverDir } = makeResolver(true);
  const scope = resolver.resolve('auto');
  assert.equal(scope.source, 'server');
  assert.equal(scope.dir, serverDir);
  assert.equal(scope.re, SERVER_RPT_RE);
});

test('RPT source 명시값은 auto 상태보다 우선', () => {
  const dedicated = makeResolver(true);
  assert.equal(dedicated.resolver.resolve('client').source, 'client');

  const client = makeResolver(false);
  assert.equal(client.resolver.resolve('server').source, 'server');
});
