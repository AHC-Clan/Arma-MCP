// doctor.test.ts — 진단 모드가 실제 상황을 한 화면으로 설명하는지.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

async function reserveUnusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function runDoctor(configPath: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ARMA_MCP_TOKEN;
  delete env.ARMA_MCP_NO_AUTOSTART;
  env.ARMA_MCP_CONFIG = configPath;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', path.join(here, '..', 'src', 'index.ts'), 'doctor'],
    { cwd: path.join(here, '..'), env, encoding: 'utf8' },
  );
  return stdout;
}

test('doctor: 파이프 점유를 원인으로 지목하고 조치를 제시한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-doctor-'));
  const configPath = path.join(dir, 'config.json');
  const port = await reserveUnusedPort();
  const pipeName = `\\\\.\\pipe\\arma_mcp_doctor_${process.pid}_${port}`;
  writeFileSync(
    configPath,
    JSON.stringify({
      pipeName,
      web: { enabled: false },
      mcp: { port, tokenFile: path.join(dir, 'daemon.token') },
    }),
    'utf8',
  );

  const legacy = net.createServer();
  await new Promise<void>((resolve) => legacy.listen(pipeName, resolve));
  let report: string;
  try {
    report = await runDoctor(configPath);
  } finally {
    await new Promise<void>((resolve) => legacy.close(() => resolve()));
  }

  assert.match(report, /Arma-MCP doctor/);
  assert.match(report, /game pipe/);
  assert.match(report, /점유됨/);
  assert.match(report, /mcp endpoint/);
  assert.match(report, /판정/);
  assert.match(report, /pre-0\.3 서버가 게임 파이프를 점유/);
  assert.match(report, /세션을 닫거나/);
});

test('doctor: 아무것도 없으면 자동 기동 예정으로 판정한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-doctor-clean-'));
  const configPath = path.join(dir, 'config.json');
  const port = await reserveUnusedPort();
  writeFileSync(
    configPath,
    JSON.stringify({
      pipeName: `\\\\.\\pipe\\arma_mcp_doctor_free_${process.pid}_${port}`,
      web: { enabled: false },
      mcp: { port, tokenFile: path.join(dir, 'daemon.token') },
    }),
    'utf8',
  );

  const report = await runDoctor(configPath);
  assert.match(report, /비어 있음/);
  assert.match(report, /daemon 미기동/);
  assert.match(report, /자동으로 띄운다/);
  assert.match(report, /token file .*없음/);
});
