import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebServer, pickLanIp } from '../src/web/webServer.js';
import type { Config } from '../src/config.js';

function webCfg(over: Partial<Config['web']> = {}): Config['web'] {
  // port 0 = OS 임시 포트(테스트 전용; 실제 설정 스키마는 positive 만 허용).
  return { enabled: true, host: '127.0.0.1', port: 0, rootDir: '', publicBaseUrl: '', ...over };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function startServer(): Promise<{ ws: WebServer; root: string; base: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-web-'));
  const ws = new WebServer(webCfg(), root);
  ws.start();
  for (let i = 0; i < 100 && ws.getState() !== 'ok'; i++) await sleep(20);
  assert.equal(ws.getState(), 'ok');
  const base = `http://127.0.0.1:${ws.statusInfo().port}`;
  return { ws, root, base };
}

// ---- pickLanIp --------------------------------------------------------------

test('pickLanIp: 192.168 > 10.x > 172.16-31 > 기타, internal/IPv6 제외', () => {
  const mk = (address: string, internal = false) =>
    [{ address, family: 'IPv4', internal }] as never;
  assert.equal(
    pickLanIp({
      lo: mk('127.0.0.1', true),
      hyperv: mk('172.20.1.5'),
      wsl: mk('10.0.0.7'),
      eth: mk('192.168.0.10'),
    }),
    '192.168.0.10',
  );
  assert.equal(pickLanIp({ hyperv: mk('172.20.1.5'), wsl: mk('10.0.0.7') }), '10.0.0.7');
  assert.equal(pickLanIp({ pub: mk('203.0.113.9'), hyperv: mk('172.20.1.5') }), '172.20.1.5');
  assert.equal(pickLanIp({ lo: mk('127.0.0.1', true) }), null);
  assert.equal(
    pickLanIp({ v6: [{ address: 'fe80::1', family: 'IPv6', internal: false }] as never }),
    null,
  );
});

// ---- publish ----------------------------------------------------------------

test('publish: 파일 기록 + isNew 판정 + URL 조립', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-web-'));
  const ws = new WebServer(webCfg({ publicBaseUrl: 'http://192.168.0.5:5302/' }), root);
  const r1 = ws.publish('brief', '<html><body>v1</body></html>');
  assert.equal(r1.isNew, true);
  assert.equal(r1.url, 'http://192.168.0.5:5302/brief');
  assert.equal(readFileSync(r1.file, 'utf8'), '<html><body>v1</body></html>');
  const r2 = ws.publish('brief', '<html><body>v2</body></html>');
  assert.equal(r2.isNew, false);
  // index 는 루트 URL 로.
  assert.equal(ws.publish('index', '<html></html>').url, 'http://192.168.0.5:5302/');
});

test('publish: 잘못된 슬러그/과대 HTML 거부', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-web-'));
  const ws = new WebServer(webCfg(), root);
  for (const bad of ['../x', 'UPPER', '_lead', '한글', 'a'.repeat(65), '', 'a/b']) {
    assert.throws(() => ws.publish(bad, '<html></html>'), /invalid page slug/);
  }
  assert.throws(() => ws.publish('big', 'x'.repeat(4 * 1024 * 1024 + 1)), /too large/);
});

// ---- 서빙 -------------------------------------------------------------------

test('serving: 리로드 스크립트 주입 + 라우팅 + 404/405 + MIME', async () => {
  const { ws, root, base } = await startServer();
  try {
    ws.publish('index', '<html><BODY>hello</BODY></html>');
    ws.publish('brief', '<html><body>brief</body></html>');
    writeFileSync(path.join(root, 'style.css'), 'body{}', 'utf8');
    writeFileSync(path.join(root, 'nobody.html'), '<p>no body tag</p>', 'utf8');

    // / → index.html, </BODY>(대문자) 직전 주입.
    const idx = await (await fetch(base + '/')).text();
    assert.match(idx, /arma-mcp live reload/);
    assert.ok(idx.indexOf('live reload') < idx.toLowerCase().indexOf('</body>'));

    // /brief → brief.html (확장자 없는 슬러그).
    const brief = await fetch(base + '/brief');
    assert.equal(brief.status, 200);
    assert.match(await brief.text(), /arma-mcp live reload/);

    // </body> 없는 HTML → 끝에 append.
    const nb = await (await fetch(base + '/nobody.html')).text();
    assert.match(nb, /no body tag[\s\S]*arma-mcp live reload/);

    // css: MIME + 주입 없음.
    const css = await fetch(base + '/style.css');
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(await css.text(), 'body{}');

    assert.equal((await fetch(base + '/nope')).status, 404);
    assert.equal((await fetch(base + '/..%2f..%2fsecret')).status, 404);
    assert.equal((await fetch(base + '/%00x')).status, 404);
    assert.equal((await fetch(base + '/', { method: 'POST', body: 'x' })).status, 405);
  } finally {
    await ws.stop();
  }
});

// ---- SSE + fs.watch 리로드 --------------------------------------------------

interface SseProbe {
  headers: http.IncomingHttpHeaders;
  received(): string;
  close(): void;
}

function sseConnect(base: string): Promise<SseProbe> {
  return new Promise((resolve, reject) => {
    const req = http.get(base + '/__events', (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (buf += c));
      resolve({
        headers: res.headers,
        received: () => buf,
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

test('SSE: 헤더 + 파일 변경 시 reload 브로드캐스트 + 정리', async () => {
  const { ws, root, base } = await startServer();
  try {
    ws.publish('brief', '<html><body>v1</body></html>');
    const probe = await sseConnect(base);
    assert.match(probe.headers['content-type'] ?? '', /text\/event-stream/);
    for (let i = 0; i < 50 && ws.sseClientCount() < 1; i++) await sleep(20);
    assert.equal(ws.sseClientCount(), 1);

    // html 재게시 → 해당 슬러그 리로드 이벤트.
    ws.publish('brief', '<html><body>v2</body></html>');
    for (let i = 0; i < 150 && !probe.received().includes('"brief"'); i++) await sleep(20);
    assert.match(probe.received(), /event: reload/);
    assert.match(probe.received(), /"page":"brief"/);

    // 비 HTML 자산 변경 → 전체('*') 리로드.
    writeFileSync(path.join(root, 'data.json'), '{}', 'utf8');
    for (let i = 0; i < 150 && !probe.received().includes('"*"'); i++) await sleep(20);
    assert.match(probe.received(), /"page":"\*"/);

    probe.close();
    for (let i = 0; i < 50 && ws.sseClientCount() > 0; i++) await sleep(20);
    assert.equal(ws.sseClientCount(), 0);
  } finally {
    await ws.stop();
  }
});

test('statusInfo: 상태/URL/webRoot 노출', async () => {
  const { ws, root } = await startServer();
  try {
    const st = ws.statusInfo();
    assert.equal(st.state, 'ok');
    assert.equal(st.webRoot, path.resolve(root));
    assert.ok(st.port > 0);
    assert.match(st.url, /^http:\/\//);
  } finally {
    await ws.stop();
  }
});

test('disabled: enabled=false 면 리슨하지 않음', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-web-'));
  const ws = new WebServer(webCfg({ enabled: false }), root);
  ws.start();
  assert.equal(ws.getState(), 'disabled');
});
