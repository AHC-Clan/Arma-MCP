import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  resolveRptDir,
  resolveConfigPath,
  resolveWebRoot,
  resolveCaptureDir,
  resolveServerExePath,
  resolveServerImage,
  resolveServerProfilesDir,
  resolveMpMissionsDir,
} from '../src/config.js';

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-cfg-'));
  const p = path.join(dir, 'cfg.json');
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

test('defaults applied when file missing', () => {
  const cfg = loadConfig(path.join(tmpdir(), 'does-not-exist-xyz.json'));
  assert.equal(cfg.pipeName, '\\\\.\\pipe\\arma_mcp');
  assert.equal(cfg.exec.defaultTimeoutMs, 5000);
  assert.equal(cfg.tcp.enabled, false);
});

test('file values parsed', () => {
  const p = tmpConfig({ pipeName: '\\\\.\\pipe\\custom', exec: { defaultTimeoutMs: 1234 } });
  const cfg = loadConfig(p);
  assert.equal(cfg.pipeName, '\\\\.\\pipe\\custom');
  assert.equal(cfg.exec.defaultTimeoutMs, 1234);
});

test('corrupt file falls back to defaults', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-cfg-'));
  const p = path.join(dir, 'bad.json');
  writeFileSync(p, '{ not valid json', 'utf8');
  const cfg = loadConfig(p);
  assert.equal(cfg.pipeName, '\\\\.\\pipe\\arma_mcp');
});

test('env override ARMA_MCP_PIPE wins over file', () => {
  const p = tmpConfig({ pipeName: '\\\\.\\pipe\\fromfile' });
  process.env.ARMA_MCP_PIPE = '\\\\.\\pipe\\fromenv';
  try {
    const cfg = loadConfig(p);
    assert.equal(cfg.pipeName, '\\\\.\\pipe\\fromenv');
  } finally {
    delete process.env.ARMA_MCP_PIPE;
  }
});

test('env ARMA_MCP_TCP_PORT enables tcp', () => {
  const p = tmpConfig({});
  process.env.ARMA_MCP_TCP_PORT = '9999';
  try {
    const cfg = loadConfig(p);
    assert.equal(cfg.tcp.enabled, true);
    assert.equal(cfg.tcp.port, 9999);
  } finally {
    delete process.env.ARMA_MCP_TCP_PORT;
  }
});

test('legacy non-loopback raw TCP host is migrated without discarding other settings', () => {
  const cfg = loadConfig(
    tmpConfig({
      pipeName: '\\\\.\\pipe\\preserved',
      tcp: { enabled: true, host: '0.0.0.0', port: 6123 },
      exec: { defaultTimeoutMs: 9876, maxCodeBytes: 262144 },
      arma: { serverExePath: 'D:\\arma\\arma3server_x64.exe' },
      mcp: { port: 6303, maxSessions: 24 },
    }),
  );

  assert.equal(cfg.tcp.enabled, true);
  assert.equal(cfg.tcp.host, '127.0.0.1');
  assert.equal(cfg.tcp.port, 6123);
  assert.equal(cfg.pipeName, '\\\\.\\pipe\\preserved');
  assert.equal(cfg.exec.defaultTimeoutMs, 9876);
  assert.equal(cfg.exec.maxCodeBytes, 262144);
  assert.equal(cfg.arma.serverExePath, 'D:\\arma\\arma3server_x64.exe');
  assert.equal(cfg.mcp.port, 6303);
  assert.equal(cfg.mcp.maxSessions, 24);
});

test('resolveRptDir uses config value when set', () => {
  const cfg = loadConfig(tmpConfig({ rptDir: 'C:\\custom\\rpt' }));
  assert.equal(resolveRptDir(cfg), 'C:\\custom\\rpt');
});

test('resolveRptDir falls back to LOCALAPPDATA\\Arma 3', () => {
  const cfg = loadConfig(tmpConfig({}));
  const resolved = resolveRptDir(cfg);
  assert.match(resolved, /Arma 3$/);
});

test('resolveConfigPath: ARMA_MCP_CONFIG env wins', () => {
  process.env.ARMA_MCP_CONFIG = 'C:\\explicit\\config.json';
  try {
    assert.equal(resolveConfigPath(), 'C:\\explicit\\config.json');
  } finally {
    delete process.env.ARMA_MCP_CONFIG;
  }
});

test('web defaults', () => {
  const cfg = loadConfig(tmpConfig({}));
  assert.equal(cfg.web.enabled, true);
  assert.equal(cfg.web.host, '127.0.0.1');
  assert.equal(cfg.web.port, 5302);
  assert.equal(cfg.web.publicBaseUrl, '');
});

test('env ARMA_MCP_WEB_PORT overrides file port', () => {
  const p = tmpConfig({ web: { port: 6000 } });
  process.env.ARMA_MCP_WEB_PORT = '7777';
  try {
    const cfg = loadConfig(p);
    assert.equal(cfg.web.port, 7777);
    assert.equal(cfg.web.enabled, true);
  } finally {
    delete process.env.ARMA_MCP_WEB_PORT;
  }
});

test('env ARMA_MCP_WEB_URL sets publicBaseUrl', () => {
  process.env.ARMA_MCP_WEB_URL = 'http://192.168.1.5:5302';
  try {
    const cfg = loadConfig(tmpConfig({}));
    assert.equal(cfg.web.publicBaseUrl, 'http://192.168.1.5:5302');
  } finally {
    delete process.env.ARMA_MCP_WEB_URL;
  }
});

test('resolveWebRoot: config value wins, else ~/.arma-mcp/web', () => {
  const custom = loadConfig(tmpConfig({ web: { rootDir: 'C:\\custom\\web' } }));
  assert.equal(resolveWebRoot(custom), 'C:\\custom\\web');
  const def = loadConfig(tmpConfig({}));
  assert.equal(resolveWebRoot(def), path.join(homedir(), '.arma-mcp', 'web'));
});

test('capture defaults + resolveCaptureDir', () => {
  const cfg = loadConfig(tmpConfig({}));
  assert.equal(cfg.capture.dir, '');
  assert.equal(cfg.capture.keepMax, 100);
  assert.equal(resolveCaptureDir(cfg), path.join(homedir(), '.arma-mcp', 'captures'));
  const custom = loadConfig(tmpConfig({ capture: { dir: 'D:\\shots', keepMax: 5 } }));
  assert.equal(custom.capture.keepMax, 5);
  assert.equal(resolveCaptureDir(custom), 'D:\\shots');
});

test('mp block defaults', () => {
  const cfg = loadConfig(tmpConfig({}));
  assert.equal(cfg.mp.port, 2302);
  assert.equal(cfg.mp.password, '');
  assert.equal(cfg.mp.maxPlayers, 8);
  assert.equal(cfg.mp.profilesDir, '');
  assert.deepEqual(cfg.mp.serverBaseArgs, []);
});

test('resolveServerExePath: 명시값 우선, 없으면 exePath 옆 arma3server_x64.exe 유도', () => {
  const explicit = loadConfig(
    tmpConfig({ arma: { serverExePath: 'D:\\srv\\arma3server_x64.exe' } }),
  );
  assert.equal(resolveServerExePath(explicit), 'D:\\srv\\arma3server_x64.exe');

  const derived = loadConfig(tmpConfig({ arma: { exePath: 'C:\\game\\arma3_x64.exe' } }));
  assert.equal(resolveServerExePath(derived), 'C:\\game\\arma3server_x64.exe');

  const empty = loadConfig(tmpConfig({}));
  assert.equal(resolveServerExePath(empty), '');
});

test('resolveServerProfilesDir: 기본 ~/.arma-mcp/server/profiles', () => {
  const cfg = loadConfig(tmpConfig({}));
  assert.equal(
    resolveServerProfilesDir(cfg),
    path.join(homedir(), '.arma-mcp', 'server', 'profiles'),
  );
  const custom = loadConfig(tmpConfig({ mp: { profilesDir: 'D:\\srv\\profiles' } }));
  assert.equal(resolveServerProfilesDir(custom), 'D:\\srv\\profiles');
});

test('resolveMpMissionsDir: 서버 exe 폴더의 MPMissions 유도', () => {
  const cfg = loadConfig(tmpConfig({ arma: { exePath: 'C:\\game\\arma3_x64.exe' } }));
  assert.equal(resolveMpMissionsDir(cfg), 'C:\\game\\MPMissions');
  const custom = loadConfig(tmpConfig({ mp: { mpMissionsDir: 'D:\\missions' } }));
  assert.equal(resolveMpMissionsDir(custom), 'D:\\missions');
});

test('env ARMA_MCP_SERVER_EXE overrides serverExePath', () => {
  process.env.ARMA_MCP_SERVER_EXE = 'E:\\env\\arma3server_x64.exe';
  try {
    const cfg = loadConfig(tmpConfig({ arma: { serverExePath: 'D:\\file\\srv.exe' } }));
    assert.equal(cfg.arma.serverExePath, 'E:\\env\\arma3server_x64.exe');
  } finally {
    delete process.env.ARMA_MCP_SERVER_EXE;
  }
});

test('env ARMA_MCP_MP_PORT overrides mp.port', () => {
  process.env.ARMA_MCP_MP_PORT = '2444';
  try {
    const cfg = loadConfig(tmpConfig({ mp: { port: 2302 } }));
    assert.equal(cfg.mp.port, 2444);
  } finally {
    delete process.env.ARMA_MCP_MP_PORT;
  }
});

test('resolveConfigPath: home config wins if present, else repo-local fallback', () => {
  // 머신 상태에 의존하지 않게: ~/.arma-mcp/config.json 이 있으면 그것, 없으면 repo-local.
  delete process.env.ARMA_MCP_CONFIG;
  const homeConfig = path.join(homedir(), '.arma-mcp', 'config.json');
  const p = resolveConfigPath();
  if (existsSync(homeConfig)) {
    assert.equal(p, homeConfig);
  } else {
    assert.match(p, /arma-mcp\.config\.json$/);
  }
});

test('link: pre-bridge / 재접속 로그 억제 기본값', () => {
  const cfg = loadConfig(tmpConfig({}));
  assert.equal(cfg.link.staleAfterMs, 15000);
  assert.equal(cfg.link.sweepMs, 5000);
  // 0 = 미션이 붙기 전 링크는 끊지 않는다. 끊으면 로비에서 재접속 폭주가 난다.
  assert.equal(cfg.link.preBridgeStaleMs, 0);
  assert.equal(cfg.link.reconnectLogQuietMs, 60000);
});

test('resolveServerImage: serverExePath 의 파일명을 그대로 쓴다', () => {
  // 고정 상수 대신 실제 exe 이름을 봐야 프로파일링 빌드로 띄운 서버를 놓치지 않는다.
  const profiling = loadConfig(
    tmpConfig({ arma: { serverExePath: 'D:\\A3\\arma3serverprofiling_x64.exe' } }),
  );
  assert.equal(resolveServerImage(profiling), 'arma3serverprofiling_x64.exe');

  // serverExePath 미설정 + exePath 있음 → exePath 옆의 기본 서버 exe 로 유도.
  const derived = loadConfig(tmpConfig({ arma: { exePath: 'D:\\A3\\arma3_x64.exe' } }));
  assert.equal(resolveServerImage(derived), 'arma3server_x64.exe');

  // 아무것도 없으면 기본 이미지명.
  assert.equal(resolveServerImage(loadConfig(tmpConfig({}))), 'arma3server_x64.exe');
});

test('mcp.disableTools: 기본 빈 배열, 파일 값 반영', () => {
  assert.deepEqual(loadConfig(tmpConfig({})).mcp.disableTools, []);
  const trimmed = loadConfig(
    tmpConfig({ mcp: { disableTools: ['arma_capture', 'arma_scaffold_mission'] } }),
  );
  assert.deepEqual(trimmed.mcp.disableTools, ['arma_capture', 'arma_scaffold_mission']);
});
