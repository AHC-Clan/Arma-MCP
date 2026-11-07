import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createRelayFetch,
  describeError,
  failedAfterSocketReset,
} from '../src/daemon/relayFetch.js';

async function listen(server: http.Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function shutdown(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

test('릴레이 fetch 는 느린 응답에 타임아웃을 걸지 않는다', async () => {
  // 전역 fetch(undici) 는 headersTimeout 기본 300초로 이 대기를 끊는다.
  // 툴 하나가 몇 분씩 걸리는 arma_rpt_wait(최대 10분) 의 축소판.
  const DELAY_MS = 1200;
  const server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, DELAY_MS);
  });
  const url = await listen(server);
  const relayFetch = createRelayFetch();
  try {
    const started = Date.now();
    const response = await relayFetch(url, post({ method: 'tools/call' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.ok(
      Date.now() - started >= DELAY_MS,
      'response must not have been short-circuited',
    );
  } finally {
    await shutdown(server);
  }
});

test('릴레이 fetch 는 데몬이 닫은 재사용 소켓을 한 번만 재시도한다', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    // 두 번째 요청은 keep-alive 로 재사용한 소켓을 탄다. 본문을 읽지 않고 끊어
    // 데몬이 유휴 소켓을 먼저 닫은 상황(ECONNRESET)을 만든다.
    if (requests === 2) {
      req.socket.destroy();
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seq: requests }));
  });
  const url = await listen(server);
  const relayFetch = createRelayFetch();
  try {
    const first = await relayFetch(url, post({ method: 'initialize' }));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { seq: 1 });

    // 소켓이 free pool 로 돌아갈 틈을 준다.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await relayFetch(url, post({ method: 'tools/list' }));
    assert.equal(second.status, 200);
    assert.deepEqual(
      await second.json(),
      { seq: 3 },
      'the retry must have been served as a third request on a fresh socket',
    );
    assert.equal(requests, 3);
  } finally {
    await shutdown(server);
  }
});

test('릴레이 fetch 는 새 연결 실패를 재시도하지 않고 그대로 전달한다', async () => {
  // 데몬이 아예 없는 경우다. 재시도는 결과를 바꾸지 못하고 종료만 늦춘다.
  const server = http.createServer();
  const url = await listen(server);
  await shutdown(server);

  const relayFetch = createRelayFetch();
  const started = Date.now();
  await assert.rejects(
    () => relayFetch(url, post({ method: 'initialize' })),
    (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNREFUSED' && !failedAfterSocketReset(error),
  );
  assert.ok(Date.now() - started < 2000, 'a missing daemon must fail fast');
});

test('릴레이 fetch 는 재사용 소켓이 끊긴 뒤 재시도까지 실패하면 그 오류에 표시를 남긴다', async () => {
  // 데몬이 요청을 받아 실행하다 죽은 경우다. 재시도의 ECONNREFUSED 는 첫 시도가 닿지 않았다는 근거가 아니다.
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (requests === 2) {
      server.close();
      req.socket.destroy();
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const url = await listen(server);
  const relayFetch = createRelayFetch();
  try {
    assert.equal((await relayFetch(url, post({ method: 'initialize' }))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(
      () => relayFetch(url, post({ method: 'tools/call' })),
      (error: NodeJS.ErrnoException) =>
        error.code === 'ECONNREFUSED' && failedAfterSocketReset(error),
    );
    assert.equal(requests, 2, 'the retry must not have reached any server');
  } finally {
    server.closeAllConnections();
  }
});

test('릴레이 fetch 는 AbortSignal 로 취소된다', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => res.end('{}'), 5000);
  });
  const url = await listen(server);
  const relayFetch = createRelayFetch();
  const controller = new AbortController();
  try {
    const pending = relayFetch(url, { ...post({}), signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => pending);
  } finally {
    await shutdown(server);
  }
});

test('describeError 는 cause 체인의 code 를 펼친다', () => {
  const cause = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
    syscall: 'read',
  });
  const wrapped = new Error('fetch failed', { cause });
  const described = describeError(wrapped);
  assert.match(described, /fetch failed/);
  assert.match(described, /ECONNRESET/);
  assert.match(described, /read/);
  assert.equal(describeError('plain string'), 'plain string');
});

test('릴레이 fetch 는 호출자가 준 agent 를 쓰고 그 agent 를 끊으면 진행 중인 요청도 끊긴다', async () => {
  // CLI 는 자기 agent 를 쥐고 있다가 끝날 때 destroy 한다. 데몬은 그 끊김으로 세션을 닫는다.
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url?.endsWith('/hold')) {
      held.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const url = await listen(server);
  const agent = new http.Agent({ keepAlive: true });
  const relayFetch = createRelayFetch({ agent });
  try {
    const response = await relayFetch(url, post({ method: 'ping' }));
    assert.equal(response.status, 200);
    assert.equal(
      Object.values(agent.freeSockets).flat().length,
      1,
      'keep-alive socket must return to the caller-owned agent',
    );
    // 유휴 소켓을 치운다. 재사용 소켓에서 난 ECONNRESET 은 한 번 재시도하므로,
    // 끊김이 호출자에게 그대로 전해지는지 보려면 새 연결로 보낸다.
    agent.destroy();

    const settled = relayFetch(new URL('/mcp/hold', url), post({ method: 'tools/call' })).then(
      () => 'resolved',
      () => 'rejected',
    );
    const deadline = Date.now() + 2000;
    while (held.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(held.length, 1, 'request did not reach the server');
    const closed = new Promise<void>((resolve) => held[0]!.once('close', () => resolve()));
    agent.destroy();
    assert.equal(await settled, 'rejected');
    await closed;
    assert.equal(held.length, 1, 'a caller-destroyed request on a fresh socket is not retried');
  } finally {
    agent.destroy();
    await shutdown(server);
  }
});
