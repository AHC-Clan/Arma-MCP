import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecManager } from '../src/exec/execManager.js';
import { createSessionContext } from '../src/mcp/session.js';
import { openOnMachines } from '../src/mcp/tools/web.js';
import type { Gateway } from '../src/ipc/gateway.js';
import type { Deps } from '../src/mcp/deps.js';

class FakeGateway extends EventEmitter {
  sent: Record<string, unknown>[] = [];

  send(frame: Record<string, unknown>): boolean {
    this.sent.push(frame);
    return true;
  }
}

test('web-open execution is tagged and cancelled with only its MCP session', async () => {
  const gateway = new FakeGateway();
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-web-tool-'));
  const exec = new ExecManager(
    gateway as unknown as Gateway,
    rptDir,
    { defaultTimeoutMs: 5000, maxCodeBytes: 131072 },
    () => null,
  );
  const session = createSessionContext('relay', 'abcd1234-0000-0000-0000-000000000000');
  session.lastExecCursor = { file: 'preserve-this-cursor.rpt', offset: 42 };

  const deps = {
    exec,
    session,
    rptSources: {
      resolve: () => ({ source: 'server', dir: rptDir, re: /\.rpt$/i }),
    },
  } as unknown as Deps;

  const pending = openOnMachines(deps, 'http://127.0.0.1:5302/', 'all');
  // exec 는 보내기 전에 RPT 커서를 비동기로 잡는다. 부하가 크면 한 틱 안에 끝나지 않는다.
  for (let i = 0; i < 400 && gateway.sent.length === 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  assert.match(String(gateway.sent[0]?.reqId), /^abcd1234-[0-9a-f]{12}$/);
  assert.equal(gateway.sent[0]?.label, '[abcd1234] web-open');
  session.abortController.abort(new Error('session deleted'));

  const result = await pending;
  assert.equal(result.execOk, false);
  assert.equal(result.completedBy, 'cancelled');
  assert.equal(exec.pendingCount(), 0);
  assert.deepEqual(session.lastExecCursor, { file: 'preserve-this-cursor.rpt', offset: 42 });
});
