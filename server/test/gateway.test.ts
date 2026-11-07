// gateway.test.ts — half-open(stale) 링크 감지 테스트.
//
// 링크는 두 단계로 나뉜다.
//  - pre-bridge: DLL 이 붙어 hello 만 보낸 상태. 미션이 없으면 SQF 애드온도 없어
//    프레임을 만들 주체가 없으므로, 침묵을 죽음으로 보면 안 된다(끊으면 재접속 폭주).
//  - live: 브리지 프레임(sessionInfo/telemetry/execResult/heartbeat)을 한 번이라도 받은 뒤.
//    이후의 침묵은 게임 크래시일 수 있으므로 staleAfterMs 후 강제 단절한다.
// 주의: link.sweepMs 스키마 최소값은 500 — 그보다 작게 주면 config 전체가
// 기본값으로 폴백돼 기본 파이프를 물게 된다(다른 세션과 충돌).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/ipc/gateway.js';
import { loadConfig } from '../src/config.js';
import { encode } from '../src/ipc/frame.js';

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-gw-'));
  const p = path.join(dir, 'cfg.json');
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(pipeName: string): Promise<net.Socket> {
  const sock = net.connect(pipeName);
  await new Promise<void>((resolve, reject) => {
    sock.on('connect', () => resolve());
    sock.on('error', reject);
  });
  sock.on('error', () => {
    /* 서버가 끊을 때의 ECONNRESET 무시 */
  });
  return sock;
}

test('살아 있던 링크가 침묵하면 stale 판정 후 강제 단절된다', async () => {
  const pipeName = `\\\\.\\pipe\\arma_mcp_gwtest_${process.pid}`;
  const cfg = loadConfig(
    tmpConfig({ pipeName, link: { staleAfterMs: 1000, sweepMs: 500 } }),
  );
  assert.equal(cfg.pipeName, pipeName, 'config 검증 통과(폴백 아님) 전제');
  const gw = new Gateway(cfg);
  let sock: net.Socket | null = null;
  try {
    gw.start();
    await sleep(200); // 리스너 준비 대기

    let disconnected = false;
    gw.on('disconnected', () => {
      disconnected = true;
    });

    sock = await connectClient(pipeName);
    sock.write(encode(JSON.stringify({ v: 1, type: 'hello', role: 'arma-ext', ver: 'test' })));
    // 브리지 프레임을 1회 보내 pre-bridge → live 로 승격시킨다.
    // 이게 없으면 로비(미션 없음)와 구분되지 않아 sweep 이 끊지 않는다.
    sock.write(encode(JSON.stringify({ v: 1, type: 'heartbeat', t: 1 })));
    await sleep(300);
    assert.equal(gw.isConnected(), true, 'hello 직후엔 연결로 판정');
    assert.equal(gw.linkPhase(), 'live', '브리지 프레임 수신 후엔 live');
    assert.ok(gw.lastFrameAgeMs() >= 0);

    // 침묵 유지 → staleAfterMs(1000) 경과.
    await sleep(1100);
    assert.equal(gw.isConnected(), false, 'stale 후 isConnected=false');
    assert.equal(gw.send({ v: 1, type: 'exec' }), false, 'stale 링크로는 send 실패');

    // sweep(500ms 주기)이 소켓을 destroy → disconnected 이벤트.
    await sleep(1100);
    assert.equal(disconnected, true, 'sweep 이 죽은 링크를 끊어야 한다');
  } finally {
    await gw.stop();
    sock?.destroy();
  }
});

test('hello 만 온 pre-bridge 링크는 침묵해도 끊지 않는다', async () => {
  // 로비 상태 재현: DLL 은 붙었지만 미션이 없어 SQF 애드온이 telemetry 를 만들지 못한다.
  // 예전 동작은 여기서 15초마다 소켓을 끊었고, 그때마다 ExecManager.failAll 이
  // 진행 중이던 exec 를 죽이면서 daemon.log 를 수십 MB 로 불렸다.
  const pipeName = `\\\\.\\pipe\\arma_mcp_gwtest3_${process.pid}`;
  const cfg = loadConfig(
    tmpConfig({ pipeName, link: { staleAfterMs: 1000, sweepMs: 500 } }),
  );
  assert.equal(cfg.pipeName, pipeName);
  const gw = new Gateway(cfg);
  let sock: net.Socket | null = null;
  try {
    gw.start();
    await sleep(200);

    let disconnected = false;
    gw.on('disconnected', () => {
      disconnected = true;
    });

    sock = await connectClient(pipeName);
    sock.write(encode(JSON.stringify({ v: 1, type: 'hello', role: 'arma-ext', ver: 'test' })));
    await sleep(300);
    assert.equal(gw.linkPhase(), 'pre-bridge', 'hello 만으로는 브리지가 살았다고 보지 않는다');

    // staleAfterMs 의 3배를 침묵으로 보낸다.
    await sleep(3200);
    assert.equal(disconnected, false, 'pre-bridge 링크는 끊기지 않아야 한다');
    assert.equal(gw.linkPhase(), 'pre-bridge', '단계는 그대로 pre-bridge');
    // 다만 SQF 실행은 여전히 불가 — 미션이 없으니 당연하다.
    assert.equal(gw.isConnected(), false, '무수신이므로 exec 용 연결로는 치지 않는다');
    assert.equal(gw.send({ v: 1, type: 'exec' }), false, 'send 는 여전히 실패');
  } finally {
    await gw.stop();
    sock?.destroy();
  }
});

test('preBridgeStaleMs 를 주면 pre-bridge 링크도 그 시간 뒤 끊는다', async () => {
  const pipeName = `\\\\.\\pipe\\arma_mcp_gwtest4_${process.pid}`;
  const cfg = loadConfig(
    tmpConfig({
      pipeName,
      link: { staleAfterMs: 1000, sweepMs: 500, preBridgeStaleMs: 1000 },
    }),
  );
  assert.equal(cfg.pipeName, pipeName);
  assert.equal(cfg.link.preBridgeStaleMs, 1000);
  const gw = new Gateway(cfg);
  let sock: net.Socket | null = null;
  try {
    gw.start();
    await sleep(200);

    let disconnected = false;
    gw.on('disconnected', () => {
      disconnected = true;
    });

    sock = await connectClient(pipeName);
    sock.write(encode(JSON.stringify({ v: 1, type: 'hello', role: 'arma-ext', ver: 'test' })));
    await sleep(2200);
    assert.equal(disconnected, true, 'preBridgeStaleMs 초과 시엔 끊어야 한다');
  } finally {
    await gw.stop();
    sock?.destroy();
  }
});

test('프레임이 계속 오면 stale 로 판정하지 않는다', async () => {
  const pipeName = `\\\\.\\pipe\\arma_mcp_gwtest2_${process.pid}`;
  const cfg = loadConfig(
    tmpConfig({ pipeName, link: { staleAfterMs: 1000, sweepMs: 500 } }),
  );
  assert.equal(cfg.pipeName, pipeName);
  const gw = new Gateway(cfg);
  let sock: net.Socket | null = null;
  let hb: NodeJS.Timeout | null = null;
  try {
    gw.start();
    await sleep(200);

    sock = await connectClient(pipeName);
    hb = setInterval(() => {
      sock?.write(encode(JSON.stringify({ v: 1, type: 'heartbeat', t: 1 })));
    }, 400);

    await sleep(2000);
    assert.equal(gw.isConnected(), true, '주기 프레임 수신 중엔 연결 유지');
  } finally {
    if (hb) clearInterval(hb);
    await gw.stop();
    sock?.destroy();
  }
});
