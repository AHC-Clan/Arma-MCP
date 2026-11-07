// execCapture.test.ts — arma_exec capture 옵션과 captureForTool 유닛 (게임과 컴파일러 불필요).
//
// 캡처 헬퍼는 capture.test.ts 처럼 HelperRunner 를 주입해 흉내 낸다.
// 프로세스 확인도 주입하므로 이 기계에 게임이 떠 있어도 실제 화면을 찍지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { HelperRunner } from '../src/capture/capture.js';
import { ExecManager, GAME_NOT_CONNECTED, type ExecOutcome } from '../src/exec/execManager.js';
import type { Gateway } from '../src/ipc/gateway.js';
import type { Deps, ToolHost } from '../src/mcp/deps.js';
import { createSessionContext } from '../src/mcp/session.js';
import { captureForTool, registerCaptureTool, type CaptureIo } from '../src/mcp/tools/capture.js';
import {
  CAPTURE_DISABLED_ERROR,
  CAPTURE_NOT_CONNECTED_ERROR,
  CAPTURE_NOT_SENT_ERROR,
  EXEC_CAPTURE_DELAY_MS,
  registerExecTool,
} from '../src/mcp/tools/exec.js';

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Block[] }>;

/** 등록된 핸들러를 모아 두는 ToolHost. 스키마 검증 없이 핸들러를 바로 부른다. */
function fakeHost(): { host: ToolHost; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const host = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ToolHost;
  return { host, handlers };
}

const IMAGE_BYTES = Buffer.from('fake-jpeg-bytes');

/** 성공하는 헬퍼. 받은 env 를 남기고 출력 파일을 만든다. */
function okRunner(calls: Record<string, string>[]): HelperRunner {
  return async (_exe, env) => {
    calls.push(env);
    writeFileSync(env.ARMA_CAP_OUT, IMAGE_BYTES);
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        method: 'printwindow',
        windowRect: { x: 0, y: 0, w: 800, h: 600 },
        imageW: 800,
        imageH: 600,
      }),
      stderr: '',
    };
  };
}

function running(value: boolean, seen: { image: string; force?: boolean }[] = []): CaptureIo['isRunning'] {
  return async (image, force) => {
    seen.push({ image, force });
    return value;
  };
}

function outcome(over: Partial<ExecOutcome> = {}): ExecOutcome {
  return {
    ok: true,
    timedOut: false,
    completedBy: 'first',
    durationMs: 12,
    reqId: 'abcd1234-000000000001',
    results: [{ machine: 'server', result: 'SCALAR: 2', parsed: { kind: 'value', type: 'SCALAR', value: '2' } }],
    rptErrors: [],
    rptCursor: null,
    sanitized: false,
    ...over,
  };
}

function makeDeps(over: { outcome?: ExecOutcome; disableTools?: string[]; exec?: unknown } = {}): {
  deps: Deps;
  runs: Record<string, unknown>[];
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-execcap-'));
  const runs: Record<string, unknown>[] = [];
  const deps = {
    cfg: {
      mcp: { disableTools: over.disableTools ?? [] },
      capture: { dir: path.join(dir, 'captures'), keepMax: 100 },
    },
    exec: over.exec ?? {
      run: async (opts: Record<string, unknown>) => {
        runs.push(opts);
        return over.outcome ?? outcome();
      },
    },
    session: createSessionContext('relay', 'abcd1234-0000-0000-0000-000000000000'),
    rptSources: { resolve: () => ({ source: 'client', dir, re: /\.rpt$/i }) },
  } as unknown as Deps;
  return { deps, runs };
}

function execHandler(deps: Deps, io: CaptureIo): Handler {
  const { host, handlers } = fakeHost();
  registerExecTool(host, deps, io);
  return handlers.get('arma_exec')!;
}

function captureHandler(deps: Deps, io: CaptureIo): Handler {
  const { host, handlers } = fakeHost();
  registerCaptureTool(host, deps, io);
  return handlers.get('arma_capture')!;
}

function lastJson(res: { content: Block[] }): Record<string, unknown> {
  const text = res.content[res.content.length - 1];
  assert.equal(text?.type, 'text');
  return JSON.parse(String(text?.text)) as Record<string, unknown>;
}

// ------------------------------------------------------------ arma_exec capture

test('exec capture: 이미지가 먼저 오고 JSON 에 exec 결과와 capture 메타가 함께 담긴다', async () => {
  const { deps, runs } = makeDeps();
  const calls: Record<string, string>[] = [];
  const res = await execHandler(deps, { runner: okRunner(calls), isRunning: running(true) })({
    code: '1 + 1',
    capture: true,
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.code, '1 + 1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.ARMA_CAP_DELAY, String(EXEC_CAPTURE_DELAY_MS), 'capture:true 는 기본 250ms 뒤에 찍는다');
  assert.equal(calls[0]?.ARMA_CAP_SCOPE, 'window');

  assert.equal(res.content.length, 2);
  assert.equal(res.content[0]?.type, 'image');
  assert.equal(res.content[0]?.mimeType, 'image/jpeg');
  assert.equal(res.content[0]?.data, IMAGE_BYTES.toString('base64'));

  const json = lastJson(res);
  assert.equal(json.ok, true);
  assert.equal(json.reqId, 'abcd1234-000000000001');
  assert.deepEqual(json.results, outcome().results);
  const cap = json.capture as Record<string, unknown>;
  assert.equal(cap.ok, true);
  assert.equal(cap.method, 'printwindow');
  assert.equal(cap.imageW, 800);
  assert.equal(cap.bytes, IMAGE_BYTES.length);
  assert.match(String(cap.file), /capture_\d{8}_\d{6}_[a-z0-9]+\.jpg$/);
});

test('exec capture: 객체 옵션은 arma_capture 옵션으로 전달되고 returnImage:false 면 메타만 온다', async () => {
  const { deps } = makeDeps();
  const calls: Record<string, string>[] = [];
  const seen: { image: string; force?: boolean }[] = [];
  const res = await execHandler(deps, { runner: okRunner(calls), isRunning: running(true, seen) })({
    code: 'true',
    capture: { delayMs: 0, target: 'server', format: 'png', quality: 90, maxWidth: 640, returnImage: false },
  });

  assert.equal(calls[0]?.ARMA_CAP_DELAY, '0');
  assert.equal(calls[0]?.ARMA_CAP_PROC, 'arma3server_x64.exe');
  assert.equal(calls[0]?.ARMA_CAP_FORMAT, 'png');
  assert.equal(calls[0]?.ARMA_CAP_QUALITY, '90');
  assert.equal(calls[0]?.ARMA_CAP_MAXW, '640');
  assert.equal(seen[0]?.image, 'arma3server_x64.exe');

  assert.equal(res.content.length, 1, 'returnImage:false 면 이미지 블록이 없다');
  const cap = lastJson(res).capture as Record<string, unknown>;
  assert.equal(cap.ok, true);
  assert.match(String(cap.file), /\.png$/);
});

test('exec capture: 캡처가 실패해도 exec JSON 은 그대로 오고 capture 에 실패가 담긴다', async () => {
  const failing: HelperRunner = async () => ({
    code: 0,
    stdout: '{"ok":false,"stage":"minimized","error":"window is minimized"}',
    stderr: '',
  });
  const failed = outcome({
    ok: false,
    error: 'no result (timed out)',
    timedOut: true,
    completedBy: 'timeout',
    results: [],
  });
  const { deps } = makeDeps({ outcome: failed });
  const res = await execHandler(deps, { runner: failing, isRunning: running(true) })({
    code: 'while {true} do {}',
    capture: true,
  });

  assert.equal(res.content.length, 1);
  const json = lastJson(res);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'no result (timed out)');
  assert.equal(json.timedOut, true);
  const cap = json.capture as Record<string, unknown>;
  assert.equal(cap.ok, false);
  assert.equal(cap.stage, 'minimized');
  assert.match(String(cap.error), /minimized/);
});

test('exec capture: 캡처가 예외를 던져도 exec 결과는 남는다', async () => {
  const { deps } = makeDeps();
  const res = await execHandler(deps, {
    runner: okRunner([]),
    isRunning: async () => {
      throw new Error('tasklist 스폰 실패');
    },
  })({ code: '1', capture: {} });

  assert.equal(res.content.length, 1);
  const json = lastJson(res);
  assert.equal(json.ok, true);
  assert.deepEqual(json.results, outcome().results);
  assert.deepEqual(json.capture, { ok: false, error: '캡처 실패: tasklist 스폰 실패' });
});

test('exec capture: disableTools 에 arma_capture 가 있으면 찍지 않고 이유를 담는다', async () => {
  const { deps } = makeDeps({ disableTools: ['arma_capture'] });
  const calls: Record<string, string>[] = [];
  const seen: { image: string; force?: boolean }[] = [];
  const res = await execHandler(deps, { runner: okRunner(calls), isRunning: running(true, seen) })({
    code: '1',
    capture: true,
  });

  assert.equal(calls.length, 0);
  assert.equal(seen.length, 0);
  assert.equal(res.content.length, 1);
  const json = lastJson(res);
  assert.equal(json.ok, true);
  assert.deepEqual(json.capture, { ok: false, error: CAPTURE_DISABLED_ERROR });
  assert.equal(CAPTURE_DISABLED_ERROR, 'arma_capture 가 disableTools 로 꺼져 있다');
});

test('exec capture: 게임이 연결되지 않았으면 찍지 않는다 (실제 ExecManager)', async () => {
  class OfflineGateway extends EventEmitter {
    send(): boolean {
      return false;
    }
    isConnected(): boolean {
      return false;
    }
  }
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-execcap-rpt-'));
  const exec = new ExecManager(
    new OfflineGateway() as unknown as Gateway,
    rptDir,
    { defaultTimeoutMs: 5000, maxCodeBytes: 131072 },
    () => null,
  );
  const { deps } = makeDeps({ exec });
  const calls: Record<string, string>[] = [];
  const res = await execHandler(deps, { runner: okRunner(calls), isRunning: running(true) })({
    code: '1',
    capture: true,
  });

  assert.equal(calls.length, 0);
  assert.equal(res.content.length, 1);
  const json = lastJson(res);
  assert.equal(json.error, GAME_NOT_CONNECTED);
  assert.deepEqual(json.capture, { ok: false, error: CAPTURE_NOT_CONNECTED_ERROR });
});

test('exec capture: 게임에 보내기 전에 멈춘 실행은 찍지 않는다 (실제 ExecManager)', async () => {
  class OnlineGateway extends EventEmitter {
    sent: unknown[] = [];
    send(frame: unknown): boolean {
      this.sent.push(frame);
      return true;
    }
    isConnected(): boolean {
      return true;
    }
  }
  const gw = new OnlineGateway();
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-execcap-rpt-'));
  const exec = new ExecManager(
    gw as unknown as Gateway,
    rptDir,
    { defaultTimeoutMs: 5000, maxCodeBytes: 64 },
    () => null,
  );
  const { deps } = makeDeps({ exec });
  const calls: Record<string, string>[] = [];
  const seen: { image: string; force?: boolean }[] = [];
  const handler = execHandler(deps, { runner: okRunner(calls), isRunning: running(true, seen) });
  const cases: { args: Record<string, unknown>; error: RegExp }[] = [
    { args: { code: '// x\nhint "a"', comments: 'reject' }, error: /^comment rejected/ },
    { args: { code: 'x'.repeat(65) }, error: /^code too large/ },
    { args: { code: '   ' }, error: /^empty code$/ },
    { args: { code: 'hint "a"', mode: 'client' }, error: /requires target/ },
  ];
  for (const c of cases) {
    const res = await handler({ ...c.args, capture: true });
    assert.equal(res.content.length, 1, `이미지 블록이 없어야 한다: ${String(c.args.code)}`);
    const json = lastJson(res);
    assert.equal(json.ok, false);
    assert.match(String(json.error), c.error);
    assert.equal(json.reqId, '');
    assert.deepEqual(json.capture, { ok: false, error: CAPTURE_NOT_SENT_ERROR });
  }
  assert.equal(gw.sent.length, 0, '게임에는 아무것도 보내지 않았다');
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 0);
});

test('exec capture: capture 를 안 주거나 false 면 지금과 같은 JSON 한 블록이다', async () => {
  const { deps } = makeDeps();
  const calls: Record<string, string>[] = [];
  const handler = execHandler(deps, { runner: okRunner(calls), isRunning: running(true) });
  for (const args of [{ code: '1' }, { code: '1', capture: false }]) {
    const res = await handler(args);
    assert.equal(res.content.length, 1);
    assert.deepEqual(lastJson(res), outcome());
  }
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ arma_capture 동작 유지

test('arma_capture: 게임 창이 없으면 force 재확인 뒤 JSON 한 블록으로 실패한다', async () => {
  const { deps } = makeDeps();
  const calls: Record<string, string>[] = [];
  const seen: { image: string; force?: boolean }[] = [];
  const res = await captureHandler(deps, { runner: okRunner(calls), isRunning: running(false, seen) })({});

  assert.deepEqual(
    seen.map((s) => s.force === true),
    [false, true],
    '캐시 음성이면 force 로 한 번 더 확인한다',
  );
  assert.equal(calls.length, 0);
  assert.equal(res.content.length, 1);
  const json = lastJson(res);
  assert.equal(json.ok, false);
  assert.match(String(json.error), /^arma3_x64\.exe not running/);
});

test('arma_capture: 성공하면 이미지 먼저, 메타 뒤. 핸들러 결과는 captureForTool 의 content 와 같다', async () => {
  const { deps } = makeDeps();
  const calls: Record<string, string>[] = [];
  const io = { runner: okRunner(calls), isRunning: running(true) };
  const res = await captureHandler(deps, io)({ format: 'png' });

  assert.deepEqual(Object.keys(res), ['content'], '도구 결과에 meta 가 새지 않는다');
  assert.equal(res.content.length, 2);
  assert.equal(res.content[0]?.type, 'image');
  assert.equal(res.content[0]?.mimeType, 'image/png');
  assert.equal(calls[0]?.ARMA_CAP_DELAY, '0', 'arma_capture 의 delayMs 기본은 0 이다');
  const meta = lastJson(res);
  assert.equal(meta.ok, true);
  assert.equal(meta.method, 'printwindow');
  assert.ok(!('pruned' in meta), 'pruned 는 지운 파일이 있을 때만 실린다');

  const direct = await captureForTool(deps, { format: 'png' }, io);
  assert.equal(direct.content.length, 2);
  assert.equal(direct.content[0]?.type, 'image');
  assert.equal(direct.meta.ok, true);
  assert.deepEqual(
    JSON.parse((direct.content[1] as { text: string }).text),
    JSON.parse(JSON.stringify(direct.meta)),
  );
});

test('arma_capture: screen 은 프로세스를 확인하지 않고, returnImage:false 는 메타만, 헬퍼 실패는 그대로', async () => {
  const { deps } = makeDeps();
  const seen: { image: string; force?: boolean }[] = [];
  const res = await captureHandler(deps, { runner: okRunner([]), isRunning: running(false, seen) })({
    scope: 'screen',
    returnImage: false,
  });
  assert.equal(seen.length, 0);
  assert.equal(res.content.length, 1);
  assert.equal(lastJson(res).ok, true);

  const failing: HelperRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  const failed = await captureHandler(deps, { runner: failing, isRunning: running(true) })({});
  assert.equal(failed.content.length, 1);
  const meta = lastJson(failed);
  assert.equal(meta.ok, false);
  assert.match(String(meta.error), /exited 1/);
  assert.equal(meta.stderrTail, 'boom');
});

// ------------------------------------------------------------ SDK 왕복

test('SDK 왕복: capture 는 boolean 과 객체를 받고, 범위를 넘으면 실행 전에 거부된다', async () => {
  const { deps, runs } = makeDeps();
  const calls: Record<string, string>[] = [];
  const io = { runner: okRunner(calls), isRunning: running(true) };
  const server = new McpServer({ name: 'test', version: '0' });
  registerExecTool(server, deps, io);
  registerCaptureTool(server, deps, io);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientSide);
  try {
    const listed = await client.listTools();
    const exec = listed.tools.find((t) => t.name === 'arma_exec');
    const capture = (exec?.inputSchema.properties as Record<string, { anyOf?: { type?: string }[] }>)
      .capture;
    assert.deepEqual(
      capture?.anyOf?.map((s) => s.type),
      ['boolean', 'object'],
    );

    const ok = (await client.callTool({
      name: 'arma_exec',
      arguments: { code: '1 + 1', capture: { delayMs: 0, format: 'png' } },
    })) as { content: Block[]; isError?: boolean };
    assert.notEqual(ok.isError, true);
    assert.equal(ok.content[0]?.type, 'image');
    assert.equal(ok.content[0]?.mimeType, 'image/png');
    assert.equal((lastJson(ok).capture as Record<string, unknown>).ok, true);

    const before = runs.length;
    const bad = (await client
      .callTool({ name: 'arma_exec', arguments: { code: '1', capture: { delayMs: 20000 } } })
      .catch(() => ({ isError: true, content: [] }))) as { isError?: boolean };
    assert.equal(bad.isError, true);
    assert.equal(runs.length, before, '잘못된 capture 는 SQF 를 보내기 전에 막힌다');
  } finally {
    await client.close();
    await server.close();
  }
});
