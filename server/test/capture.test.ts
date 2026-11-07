// capture.test.ts — 캡처 오케스트레이션 유닛 (게임/컴파일러 불필요, HelperRunner 주입).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPTURE_CS_SOURCE, helperHash } from '../src/capture/helperSource.js';
import {
  captureWindow,
  parseCaptureStdout,
  pruneCaptures,
  type CaptureOptions,
  type HelperRunner,
} from '../src/capture/capture.js';

function opts(outFile: string): CaptureOptions {
  return {
    processImage: 'arma3_x64.exe',
    scope: 'window',
    delayMs: 0,
    format: 'jpeg',
    quality: 80,
    maxWidth: 1568,
    outFile,
  };
}

test('helperHash: 결정적 12자 hex, 소스와 연동', () => {
  assert.match(helperHash(), /^[0-9a-f]{12}$/);
  assert.equal(helperHash(), helperHash());
  assert.ok(CAPTURE_CS_SOURCE.includes('PrintWindow'));
});

test('helperSource 원문에 템플릿 리터럴 위험 문자 없음 (백틱, ${)', () => {
  // TS 템플릿 리터럴 안의 C# 원문 — 백틱/보간이 섞이면 조용히 원문이 변형된다.
  assert.ok(!CAPTURE_CS_SOURCE.includes('`'));
  assert.ok(!CAPTURE_CS_SOURCE.includes('${'));
});

test('parseCaptureStdout: 마지막 비공백 줄만 JSON 파싱', () => {
  assert.deepEqual(parseCaptureStdout('{"ok":true,"method":"screen"}'), { ok: true, method: 'screen' });
  const mixed = 'noise line\r\n{"ok":false,"stage":"find-window","error":"x"}\r\n';
  assert.deepEqual(parseCaptureStdout(mixed), { ok: false, stage: 'find-window', error: 'x' });
  assert.equal(parseCaptureStdout('garbage not json'), null);
  assert.equal(parseCaptureStdout(''), null);
  assert.equal(parseCaptureStdout('[1,2]'), null); // 객체 아님
});

test('captureWindow: 성공 경로 — 파일 검증 + 필드 매핑 (runner 주입 → 컴파일 우회)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-cap-'));
  const outFile = path.join(dir, 'capture_test.jpg');
  const runner: HelperRunner = async (_exe, env, _timeout) => {
    writeFileSync(env.ARMA_CAP_OUT, Buffer.alloc(1234));
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        file: env.ARMA_CAP_OUT,
        method: 'printwindow',
        windowRect: { x: 10, y: 20, w: 800, h: 600 },
        imageW: 800,
        imageH: 600,
      }),
      stderr: '',
    };
  };
  const res = await captureWindow(opts(outFile), runner);
  assert.ok(res.ok);
  assert.equal(res.method, 'printwindow');
  assert.deepEqual(res.windowRect, { x: 10, y: 20, w: 800, h: 600 });
  assert.equal(res.bytes, 1234);
});

test('captureWindow: 옵션이 ARMA_CAP_* env 로 전달됨', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-cap-'));
  const outFile = path.join(dir, 'capture_env.png');
  let seen: Record<string, string> = {};
  const runner: HelperRunner = async (_exe, env) => {
    seen = env;
    writeFileSync(env.ARMA_CAP_OUT, Buffer.alloc(1));
    return { code: 0, stdout: '{"ok":true,"method":"screen","imageW":1,"imageH":1}', stderr: '' };
  };
  await captureWindow(
    { processImage: 'arma3server_x64.exe', scope: 'screen', delayMs: 250, format: 'png', quality: 90, maxWidth: 640, outFile },
    runner,
  );
  assert.equal(seen.ARMA_CAP_SCOPE, 'screen');
  assert.equal(seen.ARMA_CAP_PROC, 'arma3server_x64.exe');
  assert.equal(seen.ARMA_CAP_FORMAT, 'png');
  assert.equal(seen.ARMA_CAP_QUALITY, '90');
  assert.equal(seen.ARMA_CAP_MAXW, '640');
  assert.equal(seen.ARMA_CAP_DELAY, '250');
});

test('captureWindow: 헬퍼가 보고한 stage/error 전달', async () => {
  const runner: HelperRunner = async () => ({
    code: 0,
    stdout: '{"ok":false,"stage":"minimized","error":"window is minimized"}',
    stderr: '',
  });
  const res = await captureWindow(opts('unused.jpg'), runner);
  assert.ok(!res.ok);
  assert.equal(res.stage, 'minimized');
  assert.match(res.error, /minimized/);
});

test('captureWindow: exit != 0 → stderrTail 포함 실패', async () => {
  const runner: HelperRunner = async () => ({ code: 1, stdout: '', stderr: 'boom happened' });
  const res = await captureWindow(opts('unused.jpg'), runner);
  assert.ok(!res.ok);
  assert.match(res.error, /exited 1/);
  assert.equal(res.stderrTail, 'boom happened');
});

test('captureWindow: code null(타임아웃/킬) → 타임아웃 실패', async () => {
  const runner: HelperRunner = async () => ({ code: null, stdout: '', stderr: '' });
  const res = await captureWindow(opts('unused.jpg'), runner);
  assert.ok(!res.ok);
  assert.match(res.error, /did not complete/);
});

test('captureWindow: ok 보고했지만 파일 없음 → 실패', async () => {
  const runner: HelperRunner = async () => ({
    code: 0,
    stdout: '{"ok":true,"method":"screen","imageW":1,"imageH":1}',
    stderr: '',
  });
  const res = await captureWindow(opts(path.join(tmpdir(), 'no-such-capture-xyz.jpg')), runner);
  assert.ok(!res.ok);
  assert.match(res.error, /file missing/);
});

test('captureWindow: 러너 reject → spawn 실패로 수렴', async () => {
  const runner: HelperRunner = async () => {
    throw new Error('spawn EACCES');
  };
  const res = await captureWindow(opts('unused.jpg'), runner);
  assert.ok(!res.ok);
  assert.match(res.error, /spawn/);
});

test('pruneCaptures: mtime 최신 keepMax 개 유지', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-prune-'));
  const base = Date.now() / 1000 - 100;
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, `capture_f${i}.jpg`);
    writeFileSync(p, 'x');
    utimesSync(p, base + i, base + i); // f4 가 최신
  }
  writeFileSync(path.join(dir, 'other.txt'), 'keep'); // capture_ 아닌 파일은 불가침
  const deleted = await pruneCaptures(dir, 3);
  assert.equal(deleted, 2);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, ['capture_f2.jpg', 'capture_f3.jpg', 'capture_f4.jpg', 'other.txt']);
});

test('pruneCaptures: 없는 디렉터리 → 0', async () => {
  assert.equal(await pruneCaptures(path.join(tmpdir(), 'no-such-dir-abc'), 10), 0);
});
