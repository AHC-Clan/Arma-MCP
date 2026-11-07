import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractErrorBlocks,
  searchRpt,
  readRpt,
  waitForPattern,
  waitForTextAfter,
} from '../src/rpt/rptReader.js';
import {
  CLIENT_RPT_RE,
  compareRptNames,
  listRptFiles,
  newestRpt,
  newestRptAsync,
  rptAfter,
  SERVER_RPT_RE,
} from '../src/rpt/rptFiles.js';
import {
  CLIENT_IMAGE_CANDIDATES,
  SERVER_IMAGE_CANDIDATES,
  rptPrefixOf,
} from '../src/armaImages.js';
import { createDirWatcher } from '../src/rpt/rptWatch.js';
import type { Deps, ToolHost } from '../src/mcp/deps.js';
import { createSessionContext } from '../src/mcp/session.js';
import { FROM_OFFSET_NEEDS_FILE, registerRptTools } from '../src/mcp/tools/rpt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures');
const fixture = path.join(fixtureDir, 'sample.rpt');

test('extractErrorBlocks groups Error in expression + follow-up lines', async () => {
  const { errors } = await extractErrorBlocks(fixture, 0);
  // 두 개의 "Error in expression" 블록.
  assert.equal(errors.length, 2);
  assert.match(errors[0]!.block[0]!, /Error in expression <_undef \+ 1>/);
  // 후속 Error position / Error 줄이 같은 블록에 포함.
  assert.ok(errors[0]!.block.some((l) => /Error position/.test(l)));
  assert.ok(errors[0]!.block.some((l) => /Undefined variable/.test(l)));
  assert.match(errors[1]!.block[0]!, /throw "boom"/);
});

test('extractErrorBlocks: 한국어 클라이언트의 상세 줄도 같은 블록에 묶는다', async () => {
  // 실게임 한국어 클라이언트 RPT 에서 옮긴 순서다. 상세 줄이 한글로 시작해도 블록이 끊기면 안 된다.
  const dir = mkdtempSync(path.join(tmpdir(), 'rpt-ko-'));
  const file = path.join(dir, 'Arma3_x64_ko.rpt');
  writeFileSync(
    file,
    [
      '17:49:27 "[ArmaMCP] [EXEC] mode=server target= reqId=900097e4-d60282092902 label=[900097e4] agent code=_undef + 1"',
      '17:49:27 Error in expression <_undef + 1>',
      '17:49:27   Error position: <_undef + 1>',
      '17:49:27   Error 표현식에 정의되지 않은 변수(_undef)가 있습니다.',
      // 감사 줄은 "Error in expression" 문구를 품지만 블록의 일부가 아니다.
      '17:49:27 "[ArmaMCP] [EXEC] result <- server (reqId=900097e4-d60282092902): <nil> (if unexpected, check RPT for \'Error in expression\')"',
      '17:49:28 Error in expression <round allUnits>',
      '17:49:28   Error position: <round allUnits>',
      '17:49:28   Error round: 집합체 유형이 사용되었습니다.(요구: 숫자,숫자 아님)',
      '17:49:29 다음 줄',
      '',
    ].join('\r\n'),
    'utf8',
  );
  const { errors } = await extractErrorBlocks(file, 0);
  assert.equal(errors.length, 2);
  assert.equal(errors[0]!.block.length, 3);
  assert.match(errors[0]!.block[2]!, /정의되지 않은 변수\(_undef\)/);
  assert.equal(errors[1]!.block.length, 3);
  assert.match(errors[1]!.block[2]!, /Error round: 집합체/);
});

test('extractErrorBlocks respects fromOffset (skip first block)', async () => {
  // 두 번째 오류 줄의 시작(라인 경계)부터 스캔 → 두 번째 블록만.
  // (실제 exec 커서는 EOF=라인 경계에 놓이므로 중간 바이트가 아니라 줄 시작을 쓴다.)
  const full = await readRpt(fixtureDir, { file: 'sample.rpt', fromOffset: 0, maxBytes: 1_000_000 });
  assert.ok(full);
  const marker = 'Error in expression <call';
  const idx = full!.text.indexOf(marker);
  const lineStart = full!.text.lastIndexOf('\n', idx) + 1;
  const offset = Buffer.byteLength(full!.text.slice(0, lineStart), 'utf8');
  const { errors } = await extractErrorBlocks(fixture, offset);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.block[0]!, /throw "boom"/);
});

test('searchRpt finds mod header line with context', async () => {
  const res = await searchRpt(fixtureDir, { pattern: '-mod=', file: 'sample.rpt' });
  assert.ok(res);
  assert.ok(res!.matches.length >= 1);
  assert.match(res!.matches[0]!.line, /-mod="D:\\Mods\\@core/);
});

test('mod= header parse extracts modset', async () => {
  const res = await searchRpt(fixtureDir, { pattern: '-mod=', file: 'sample.rpt' });
  const line = res!.matches[0]!.line;
  const m = line.match(/-mod=("?)([^"]*)\1/);
  assert.ok(m);
  const mods = m![2]!.split(';');
  assert.equal(mods[0], 'D:\\Mods\\@core');
  assert.match(mods[1]!, /@RHSAFRF$/);
});

test('listRptFiles ignores non-Arma3 files', async () => {
  const files = listRptFiles(fixtureDir);
  // sample.rpt 는 Arma3_x64_ 접두사가 아니므로 목록에 없어야 한다.
  assert.equal(files.find((f) => f.name === 'sample.rpt'), undefined);
});

test('SERVER_RPT_RE: 클라/서버 RPT 패턴 분리', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptre-'));
  writeFileSync(path.join(dir, 'Arma3_x64_2026-07-18_10-00-00.rpt'), 'client', 'utf8');
  writeFileSync(path.join(dir, 'arma3server_x64_2026-07-18_10-00-00.rpt'), 'server1', 'utf8');
  writeFileSync(path.join(dir, 'arma3server_x64_2026-07-18_11-00-00.rpt'), 'server2', 'utf8');

  // 기본(클라 패턴)은 서버 RPT 를 무시.
  const clientFiles = listRptFiles(dir);
  assert.deepEqual(
    clientFiles.map((f) => f.name),
    ['Arma3_x64_2026-07-18_10-00-00.rpt'],
  );

  // 서버 패턴은 서버 RPT 만, 이름 정렬 = 시간순 → 최신은 11시 파일.
  const serverFiles = listRptFiles(dir, SERVER_RPT_RE);
  assert.equal(serverFiles.length, 2);
  const newest = newestRpt(dir, SERVER_RPT_RE);
  assert.equal(newest!.name, 'arma3server_x64_2026-07-18_11-00-00.rpt');
});

test('RPT 이름 규칙: 프로파일링 exe 의 RPT 도 클라와 서버로 갈린다', () => {
  // 엔진은 exe 모듈 이름을 접두어로 쓴다(2.22 profiling 실측 이름).
  assert.ok(CLIENT_RPT_RE.test('Arma3_x64_2026-10-15_22-43-36.rpt'));
  assert.ok(CLIENT_RPT_RE.test('arma3profiling_x64_2026-10-15_22-43-36.rpt'));
  assert.ok(SERVER_RPT_RE.test('arma3server_x64_2026-10-15_22-43-36.rpt'));
  assert.ok(SERVER_RPT_RE.test('arma3serverprofiling_x64_2026-10-15_22-43-36.rpt'));

  // 서로의 RPT 를 집지 않는다.
  assert.equal(CLIENT_RPT_RE.test('arma3serverprofiling_x64_2026-10-15_22-43-36.rpt'), false);
  assert.equal(CLIENT_RPT_RE.test('arma3server_x64_2026-10-15_22-43-36.rpt'), false);
  assert.equal(SERVER_RPT_RE.test('arma3profiling_x64_2026-10-15_22-43-36.rpt'), false);
  assert.equal(SERVER_RPT_RE.test('Arma3_x64_2026-10-15_22-43-36.rpt'), false);
});

test('RPT 이름 규칙은 프로세스 이미지 목록에서 나온다', () => {
  for (const image of CLIENT_IMAGE_CANDIDATES) {
    const name = `${rptPrefixOf(image)}_2026-10-15_22-00-00.rpt`;
    assert.ok(CLIENT_RPT_RE.test(name), name);
    assert.equal(SERVER_RPT_RE.test(name), false, name);
  }
  for (const image of SERVER_IMAGE_CANDIDATES) {
    const name = `${rptPrefixOf(image)}_2026-10-15_22-00-00.rpt`;
    assert.ok(SERVER_RPT_RE.test(name), name);
    assert.equal(CLIENT_RPT_RE.test(name), false, name);
  }
});

test('접두어가 다른 RPT 가 섞여도 최신과 다음은 시각으로 고른다', () => {
  // 이름 전체로 비교하면 'A' < 'a' 라서 arma3profiling 쪽이 늘 최신으로 잡힌다.
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rpt-profiling-'));
  writeFileSync(path.join(dir, 'arma3profiling_x64_2026-10-15_21-00-00.rpt'), 'p1', 'utf8');
  writeFileSync(path.join(dir, 'Arma3_x64_2026-10-15_22-00-00.rpt'), 'c1', 'utf8');
  writeFileSync(path.join(dir, 'arma3profiling_x64_2026-10-15_23-00-00.rpt'), 'p2', 'utf8');

  assert.deepEqual(
    listRptFiles(dir).map((f) => f.name),
    [
      'arma3profiling_x64_2026-10-15_21-00-00.rpt',
      'Arma3_x64_2026-10-15_22-00-00.rpt',
      'arma3profiling_x64_2026-10-15_23-00-00.rpt',
    ],
  );
  assert.equal(newestRpt(dir)!.name, 'arma3profiling_x64_2026-10-15_23-00-00.rpt');
  assert.equal(
    rptAfter(dir, 'arma3profiling_x64_2026-10-15_21-00-00.rpt')!.name,
    'Arma3_x64_2026-10-15_22-00-00.rpt',
  );
  assert.equal(
    rptAfter(dir, 'Arma3_x64_2026-10-15_22-00-00.rpt')!.name,
    'arma3profiling_x64_2026-10-15_23-00-00.rpt',
  );
  assert.equal(rptAfter(dir, 'arma3profiling_x64_2026-10-15_23-00-00.rpt'), null);
  // 이전 RPT 가 없으면(빈 이름) 가장 오래된 것부터 다음으로 본다.
  assert.equal(rptAfter(dir, '')!.name, 'arma3profiling_x64_2026-10-15_21-00-00.rpt');
});

test('서버 RPT 도 프로파일링 이름과 섞여 시간순으로 고른다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-srpt-profiling-'));
  writeFileSync(path.join(dir, 'arma3server_x64_2026-10-15_22-00-00.rpt'), 's1', 'utf8');
  writeFileSync(path.join(dir, 'arma3serverprofiling_x64_2026-10-15_21-00-00.rpt'), 's0', 'utf8');
  assert.equal(newestRpt(dir, SERVER_RPT_RE)!.name, 'arma3server_x64_2026-10-15_22-00-00.rpt');
  assert.equal(
    (await newestRptAsync(dir, SERVER_RPT_RE))!.name,
    'arma3server_x64_2026-10-15_22-00-00.rpt',
  );
  assert.ok(
    compareRptNames(
      'arma3serverprofiling_x64_2026-10-15_21-00-00.rpt',
      'arma3server_x64_2026-10-15_22-00-00.rpt',
    ) < 0,
  );
});

test('newestRptAsync: 동기판과 동일한 최신 파일 선택', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-newest-async-'));
  writeFileSync(path.join(dir, 'arma3server_x64_2026-07-18_10-00-00.rpt'), 'old', 'utf8');
  writeFileSync(path.join(dir, 'arma3server_x64_2026-07-18_11-00-00.rpt'), 'new', 'utf8');
  const viaAsync = await newestRptAsync(dir, SERVER_RPT_RE);
  assert.equal(viaAsync!.name, newestRpt(dir, SERVER_RPT_RE)!.name);
  assert.equal(await newestRptAsync(path.join(tmpdir(), 'no-such-dir-xyz')), null);
});

test('createDirWatcher: 없는 디렉터리는 순수 폴링(시간 만기)으로 강등', async () => {
  const w = createDirWatcher(path.join(tmpdir(), 'no-such-watch-dir-abc'));
  const t0 = Date.now();
  await w.wait(60);
  assert.ok(Date.now() - t0 >= 40);
  w.dispose();
});

test('createDirWatcher: 디렉터리 변경 이벤트로 조기 기상', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-watch-'));
  const w = createDirWatcher(dir);
  const t0 = Date.now();
  setTimeout(() => writeFileSync(path.join(dir, 'Arma3_x64_2026-07-25_00-00-05.rpt'), 'x'), 30);
  await w.wait(5000);
  assert.ok(Date.now() - t0 < 4000, '이벤트 없이 만기까지 잤다면 watch 가 동작하지 않은 것');
  w.dispose();
});

test('waitForPattern stops promptly when its MCP session is aborted', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-'));
  writeFileSync(path.join(dir, 'Arma3_x64_2026-07-25_00-00-00.rpt'), 'waiting\n', 'utf8');
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 20);

  const result = await waitForPattern(dir, {
    pattern: 'never appears',
    timeoutMs: 5000,
    pollMs: 250,
    fromEnd: false,
    signal: controller.signal,
  });
  assert.equal(result.found, false);
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - startedAt < 1000);
});

test('waitForPattern: fromEnd 미지정이면 기존 내용 프리스캔 즉답 (preExisting)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-pre-'));
  writeFileSync(
    path.join(dir, 'Arma3_x64_2026-07-25_00-00-02.rpt'),
    'boot\nBRIDGE READY marker\ntail\n',
    'utf8',
  );
  const startedAt = Date.now();
  const result = await waitForPattern(dir, { pattern: 'BRIDGE READY', timeoutMs: 5000 });
  assert.equal(result.found, true);
  assert.equal(result.preExisting, true);
  assert.match(result.line!, /BRIDGE READY/);
  assert.ok(Date.now() - startedAt < 1000);
});

test('waitForPattern: fromEnd:true 명시는 기존 내용을 무시하고 새 출력만 기다린다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-fromend-'));
  writeFileSync(path.join(dir, 'Arma3_x64_2026-07-25_00-00-03.rpt'), 'OLD MATCH\n', 'utf8');
  const result = await waitForPattern(dir, {
    pattern: 'OLD MATCH',
    timeoutMs: 300,
    pollMs: 50,
    fromEnd: true,
  });
  assert.equal(result.found, false);
  assert.equal(result.preExisting, undefined);
});

test('waitForPattern: 프리스캔은 마지막 64KB 로 한정된다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-lookback-'));
  // 매치 라인을 앞에 두고 뒤에 64KB 넘게 채워 프리스캔 범위 밖으로 밀어낸다.
  const filler = ('x'.repeat(1023) + '\n').repeat(70); // 71,680 bytes > 65,536
  writeFileSync(
    path.join(dir, 'Arma3_x64_2026-07-25_00-00-04.rpt'),
    'EARLY MATCH\n' + filler,
    'utf8',
  );
  const result = await waitForPattern(dir, { pattern: 'EARLY MATCH', timeoutMs: 300, pollMs: 50 });
  assert.equal(result.found, false);
});

test('waitForPattern: CRLF RPT 의 매치 줄에 끝 \\r 이 남지 않는다', async () => {
  // 실제 전용 서버 RPT 의 준비 줄 모양. 0.4.2 초기 빌드의 readyLine 은 "2303\r" 로 끝났다.
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-crlf-'));
  const file = path.join(dir, 'Arma3_x64_2026-09-23_17-46-00.rpt');
  const ready = '17:46:13 Initializing Steam server - Game Port: 2302, Steam Query Port: 2303';
  writeFileSync(file, '17:46:10 boot\r\n' + ready + '\r\n', 'utf8');

  // 프리스캔 경로.
  const pre = await waitForPattern(dir, { pattern: 'Initializing Steam server', timeoutMs: 2000 });
  assert.equal(pre.preExisting, true);
  assert.equal(pre.line, ready);

  // 새 출력을 폴링하는 경로. 줄 끝 앵커도 \r 없이 맞아야 한다.
  setTimeout(() => appendFileSync(file, ready + '\r\n'), 100);
  const polled = await waitForPattern(dir, {
    pattern: 'Steam Query Port: \\d+$',
    timeoutMs: 3000,
    pollMs: 50,
    fromEnd: true,
  });
  assert.equal(polled.found, true);
  assert.equal(polled.line, ready);

  // 타임아웃 뒤 마지막 부분 줄 경로. 줄바꿈 없이 \r 까지만 기록된 경우다.
  const partialDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-crlf-tail-'));
  writeFileSync(path.join(partialDir, 'Arma3_x64_2026-09-23_17-46-01.rpt'), ready + '\r', 'utf8');
  const partial = await waitForPattern(partialDir, {
    pattern: 'Initializing Steam server',
    timeoutMs: 200,
    pollMs: 50,
    fromEnd: false,
  });
  assert.equal(partial.found, true);
  assert.equal(partial.line, ready);
});

test('waitForPattern gives cancellation priority over an unterminated matching line', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-remainder-'));
  writeFileSync(
    path.join(dir, 'Arma3_x64_2026-07-25_00-00-01.rpt'),
    'MATCH_WITHOUT_NEWLINE',
    'utf8',
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const result = await waitForPattern(dir, {
    pattern: 'MATCH_WITHOUT_NEWLINE',
    timeoutMs: 5000,
    pollMs: 250,
    fromEnd: false,
    signal: controller.signal,
  });
  assert.equal(result.found, false);
  assert.equal(result.aborted, true);
});

test('waitForTextAfter: 폴 경계에 걸쳐 나뉘어 기록된 문자열도 찾는다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rpttext-'));
  const file = path.join(dir, 'Arma3_x64_2026-09-23_10-00-00.rpt');
  writeFileSync(file, 'reqId=abc) 커서 앞의 줄은 보지 않는다\n', 'utf8');
  const offset = statSync(file).size;
  setTimeout(() => appendFileSync(file, '10:00:03 "[ArmaMCP] [EXEC] result <- server (req'), 50);
  setTimeout(() => appendFileSync(file, 'Id=abc): SCALAR: 2"\n'), 250);
  const res = await waitForTextAfter(file, offset, 'reqId=abc)', 2000, 20);
  assert.equal(res.found, true);
  assert.ok(res.elapsedMs >= 200, `두 번째 조각까지 기다린다 (실제 ${res.elapsedMs}ms)`);
});

test('waitForTextAfter: 커서 앞의 문자열은 무시하고 상한에서 멈춘다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rpttext-'));
  const file = path.join(dir, 'Arma3_x64_2026-09-23_10-00-01.rpt');
  writeFileSync(file, 'reqId=abc)\n', 'utf8');
  const res = await waitForTextAfter(file, statSync(file).size, 'reqId=abc)', 200, 50);
  assert.equal(res.found, false);
  assert.ok(res.elapsedMs >= 190 && res.elapsedMs < 1000, `상한(200ms)에서 멈춘다 (${res.elapsedMs}ms)`);
});

test('waitForPattern fromOffset: 그 위치 뒤에 이미 기록된 줄을 찾고 앞의 줄은 보지 않는다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-offset-'));
  const file = path.join(dir, 'Arma3_x64_2026-09-23_10-00-02.rpt');
  writeFileSync(file, 'MARKER before exec\n', 'utf8');
  const offset = statSync(file).size;
  // exec 뒤 대기를 시작하기 전에 이미 기록된 줄이다. fromEnd 였다면 놓친다.
  appendFileSync(file, 'MARKER after exec\n');

  const startedAt = Date.now();
  const hit = await waitForPattern(dir, {
    pattern: 'MARKER',
    file,
    fromOffset: offset,
    timeoutMs: 2000,
    pollMs: 50,
  });
  assert.equal(hit.found, true);
  assert.equal(hit.line, 'MARKER after exec');
  assert.equal(hit.preExisting, undefined, '프리스캔 경로가 아니다');
  assert.ok(Date.now() - startedAt < 1000);

  // 위치 뒤에 매치가 없으면 앞의 줄로 답하지 않는다.
  const miss = await waitForPattern(dir, {
    pattern: 'before exec',
    file,
    fromOffset: offset,
    timeoutMs: 300,
    pollMs: 50,
  });
  assert.equal(miss.found, false);
});

test('waitForPattern: exec 감사 줄에 찍힌 코드와 결과 문구에는 맞추지 않는다', async () => {
  // exec --rpt 뒤 wait rpt --since 의 모양이다. 커서 뒤에 애드온 감사 줄 둘이 먼저 기록되고,
  // 기다리는 마커는 spawn 한 코드가 나중에 찍는다.
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-audit-'));
  const file = path.join(dir, 'Arma3_x64_2026-09-23_10-00-04.rpt');
  writeFileSync(file, '10:00:00 boot\r\n', 'utf8');
  const offset = statSync(file).size;
  appendFileSync(
    file,
    '10:00:01 "[ArmaMCP] [EXEC] mode=server target= reqId=abc label=[abc] agent sum=123 ' +
      'code=[] spawn { sleep 5; diag_log ""MY_MARKER done"" }"\r\n' +
      '10:00:01 "[ArmaMCP] [EXEC] result <- server (reqId=abc): <nil> ' +
      '(if unexpected, check RPT for \'Error in expression\')"\r\n',
  );
  const marker = '10:00:06 "MY_MARKER done"';
  setTimeout(() => appendFileSync(file, marker + '\r\n'), 300);

  const startedAt = Date.now();
  const hit = await waitForPattern(dir, {
    pattern: 'MY_MARKER',
    file,
    fromOffset: offset,
    timeoutMs: 3000,
    pollMs: 50,
  });
  assert.equal(hit.found, true);
  assert.equal(hit.line, marker);
  assert.ok(Date.now() - startedAt >= 250, `마커가 찍힐 때까지 기다린다 (${Date.now() - startedAt}ms)`);

  // 결과 감사 줄의 안내 문구와 error 가 든 패턴(대소문자 무시)도 감사 줄에 맞지 않는다.
  for (const pattern of ['Error in expression', 'error']) {
    const miss = await waitForPattern(dir, {
      pattern,
      file,
      fromOffset: offset,
      timeoutMs: 200,
      pollMs: 50,
    });
    assert.equal(miss.found, false, pattern);
  }

  // 프리스캔도 감사 줄을 건너뛴다. [EXEC] 가 아닌 [ArmaMCP] 줄(준비 마커)은 그대로 맞는다.
  appendFileSync(file, '10:00:07 "[ArmaMCP] server bridge starting on VR"\r\n');
  const pre = await waitForPattern(dir, { pattern: 'reqId=abc', file, timeoutMs: 200, pollMs: 50 });
  assert.equal(pre.found, false);
  const bridge = await waitForPattern(dir, {
    pattern: '\\[ArmaMCP\\].*server bridge',
    file,
    timeoutMs: 1000,
  });
  assert.equal(bridge.found, true);
  assert.equal(bridge.preExisting, true);
  assert.equal(bridge.line, '10:00:07 "[ArmaMCP] server bridge starting on VR"');
});

test('arma_rpt_wait fromOffset: exec 커서를 받아 이어 찾고 file 없이는 거부한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-rptwait-tool-'));
  const file = path.join(dir, 'Arma3_x64_2026-09-23_10-00-03.rpt');
  writeFileSync(file, 'READY old\n', 'utf8');
  const cursor = { file, offset: statSync(file).size };
  appendFileSync(file, 'READY new\n');

  type Handler = (args: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>;
  const handlers = new Map<string, Handler>();
  const host = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ToolHost;
  const deps = {
    rptSources: { resolve: () => ({ source: 'client', dir, re: /\.rpt$/i }) },
    session: createSessionContext('cli'),
  } as unknown as Deps;
  registerRptTools(host, deps);
  const wait = handlers.get('arma_rpt_wait')!;
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(String((await wait(args)).content[0]?.text)) as Record<string, unknown>;

  const hit = await call({ pattern: 'READY', file: cursor.file, fromOffset: cursor.offset, timeoutMs: 2000 });
  assert.equal(hit.found, true);
  assert.equal(hit.line, 'READY new');

  for (const file of [undefined, 'newest', 'next']) {
    const refused = await call({ pattern: 'READY', file, fromOffset: 0, timeoutMs: 2000 });
    assert.equal(refused.found, false);
    assert.equal(refused.error, FROM_OFFSET_NEEDS_FILE, `file=${String(file)}`);
  }
});
