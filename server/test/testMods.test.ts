// testMods.test.ts — 새로 빌드한 PBO 를 스택 전용 테스트 애드온으로 붙이는 계획과 파일 작업.
//
// 임시 폴더에 가짜 PBO(헤더만 있는 파일)로 기본 모드와 빌드 출력을 만들어 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OVERLAY_MARKER,
  parsePboPrefix,
  planTestMods,
  readPboPrefix,
  stageTestMods,
  type PlanInput,
} from '../src/stack/testMods.js';
import { stripStackMods } from '../src/launch/mods.js';

/** 헤더 확장에 prefix 만 있는 PBO 모양 바이트. */
function pboBytes(prefix: string | null, body = 'data'): Buffer {
  const parts: Buffer[] = [Buffer.from([0])];
  const vers = Buffer.alloc(20);
  vers.writeUInt32LE(0x56657273, 0);
  parts.push(vers);
  if (prefix !== null) parts.push(Buffer.from(`prefix\0${prefix}\0`, 'latin1'));
  parts.push(Buffer.from([0]));
  parts.push(Buffer.from(body, 'latin1'));
  return Buffer.concat(parts);
}

function world() {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-testmods-'));
  // 큰 기본 모드. addons 에 PBO 셋, 서명 하나, 루트에 DLL 과 mod.cpp, keys 폴더.
  const big = path.join(base, 'mods', '@big');
  mkdirSync(path.join(big, 'addons'), { recursive: true });
  mkdirSync(path.join(big, 'keys'), { recursive: true });
  writeFileSync(path.join(big, 'addons', 'big_core.pbo'), pboBytes('z\\big\\addons\\core', 'CORE-OLD'));
  writeFileSync(path.join(big, 'addons', 'big_core.pbo.big_1.0.bisign'), 'SIG');
  writeFileSync(path.join(big, 'addons', 'big_ui.pbo'), pboBytes('z\\big\\addons\\ui', 'UI'));
  writeFileSync(path.join(big, 'addons', 'big_misc.pbo'), pboBytes('z\\big\\addons\\misc', 'MISC-OLD'));
  writeFileSync(path.join(big, 'big_ext_x64.dll'), 'DLL-OLD');
  writeFileSync(path.join(big, 'mod.cpp'), 'name="big";');
  writeFileSync(path.join(big, 'keys', 'big.bikey'), 'KEY');
  // 관계없는 모드.
  const other = path.join(base, 'mods', '@other');
  mkdirSync(path.join(other, 'addons'), { recursive: true });
  writeFileSync(path.join(other, 'addons', 'other.pbo'), pboBytes('x\\other', 'OTHER'));
  // 빌드 출력.
  const build = path.join(base, 'build');
  mkdirSync(path.join(build, 'addons'), { recursive: true });
  writeFileSync(path.join(build, 'addons', 'big_core.pbo'), pboBytes('z\\big\\addons\\core', 'CORE-NEW'));
  writeFileSync(path.join(build, 'addons', 'newthing.pbo'), pboBytes('z\\new\\addons\\thing', 'NEW'));
  writeFileSync(path.join(build, 'big_ext_x64.dll'), 'DLL-NEW');
  // 이름을 바꿔 빌드했지만 prefix 가 같은 PBO.
  const renamed = path.join(base, 'renamed_misc.pbo');
  writeFileSync(renamed, pboBytes('Z/BIG/addons/misc/', 'MISC-NEW'));
  const stackRoot = path.join(base, 'stacks', 'b');
  return { base, big, other, build, renamed, stackRoot };
}

function input(w: ReturnType<typeof world>, testMods: string[], extra: Partial<PlanInput> = {}): PlanInput {
  return {
    testMods,
    mods: [w.big, w.other],
    testModDir: path.join(w.stackRoot, '@arma_mcp_test'),
    overlayDir: path.join(w.stackRoot, 'overlay'),
    maxBytes: 1024 * 1024,
    overlayCopyMaxBytes: 1024 * 1024,
    ...extra,
  };
}

test('parsePboPrefix: 헤더 확장의 prefix 를 소문자 역슬래시로 읽는다', async () => {
  assert.equal(parsePboPrefix(pboBytes('Z/Mod/Addons/Core/')), 'z\\mod\\addons\\core');
  assert.equal(parsePboPrefix(pboBytes(null)), null);
  assert.equal(parsePboPrefix(Buffer.from('not a pbo')), null);
  assert.equal(parsePboPrefix(Buffer.alloc(0)), null);
  const w = world();
  assert.equal(await readPboPrefix(path.join(w.big, 'addons', 'big_ui.pbo')), 'z\\big\\addons\\ui');
  assert.equal(await readPboPrefix(path.join(w.base, 'missing.pbo')), null);
});

test('planTestMods: 겹치지 않는 새 PBO 는 테스트 애드온에만 들어가고 기본 모드는 그대로다', async () => {
  const w = world();
  const res = await planTestMods(input(w, [path.join(w.build, 'addons', 'newthing.pbo')]));
  assert.ok(res.ok, !res.ok ? res.error : '');
  const plan = res.plan;
  assert.deepEqual(plan.pbos.map((f) => f.name), ['newthing.pbo']);
  assert.deepEqual(plan.overlays, []);
  assert.deepEqual(plan.mods, [w.big, w.other, path.join(w.stackRoot, '@arma_mcp_test')]);
});

test('planTestMods: 모드 폴더를 주면 addons 의 PBO 와 루트 DLL 을 가져오고 겹친 기본 모드를 오버레이로 바꾼다', async () => {
  const w = world();
  const res = await planTestMods(input(w, [w.build, w.renamed]));
  assert.ok(res.ok, !res.ok ? res.error : '');
  const plan = res.plan;
  assert.deepEqual(plan.pbos.map((f) => f.name).sort(), ['big_core.pbo', 'newthing.pbo', 'renamed_misc.pbo']);
  assert.deepEqual(plan.rootFiles.map((f) => f.name), ['big_ext_x64.dll']);
  assert.equal(plan.overlays.length, 1);
  const o = plan.overlays[0]!;
  assert.equal(o.base, path.resolve(w.big));
  assert.equal(o.method, 'hardlink');
  assert.deepEqual(o.exclude.sort(), ['addons/big_core.pbo', 'addons/big_misc.pbo', 'big_ext_x64.dll']);
  assert.deepEqual(plan.mods, [o.path, w.other, path.join(w.stackRoot, '@arma_mcp_test')]);
});

test('planTestMods: 없는 경로, PBO 아닌 파일, 빈 폴더, 이름 중복, 크기 상한을 실행 전에 거절한다', async () => {
  const w = world();
  const missing = await planTestMods(input(w, [path.join(w.base, 'nope.pbo')]));
  assert.match(!missing.ok ? missing.error : '', /없다/);
  const notPbo = await planTestMods(input(w, [path.join(w.big, 'mod.cpp')]));
  assert.match(!notPbo.ok ? notPbo.error : '', /PBO 파일이 아니다/);
  const empty = path.join(w.base, 'empty');
  mkdirSync(empty);
  const none = await planTestMods(input(w, [empty]));
  assert.match(!none.ok ? none.error : '', /찾지 못했다/);
  const dup = await planTestMods(
    input(w, [path.join(w.build, 'addons', 'big_core.pbo'), path.join(w.big, 'addons', 'big_core.pbo')]),
  );
  assert.match(!dup.ok ? dup.error : '', /같은 이름/);
  const big = await planTestMods(input(w, [w.build], { maxBytes: 10 }));
  assert.match(!big.ok ? big.error : '', /testModMaxMB/);
});

test('planTestMods: 다른 드라이브의 기본 모드는 상한 안이면 복사, 넘으면 드라이브를 알려 주며 거절', async () => {
  const w = world();
  const far = (cap: number): PlanInput =>
    input(w, [path.join(w.build, 'addons', 'big_core.pbo')], {
      overlayDir: 'Z:\\stacks\\b\\overlay',
      testModDir: 'Z:\\stacks\\b\\@arma_mcp_test',
      overlayCopyMaxBytes: cap,
    });
  const copy = await planTestMods(far(1024 * 1024));
  assert.ok(copy.ok);
  assert.equal(copy.plan.overlays[0]?.method, 'copy');
  const refused = await planTestMods(far(1));
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.error : '', /stacks\.root/);
});

test('planTestMods: 테스트 애드온 원본 폴더를 기본 모드로도 주면 기본 모드에서 뺀다', async () => {
  const w = world();
  const res = await planTestMods({ ...input(w, [w.build]), mods: [w.other, w.build] });
  assert.ok(res.ok);
  assert.ok(!res.plan.mods.includes(w.build));
});

test('stageTestMods: 스냅샷과 하드링크 오버레이를 만들고, 다시 부르면 바꾸며, 원본은 그대로다', async () => {
  const w = world();
  const planned = await planTestMods(input(w, [w.build, w.renamed]));
  assert.ok(planned.ok);
  const staged = await stageTestMods(planned.plan, { stackRoot: w.stackRoot });
  assert.equal(staged.ok, true, staged.error);

  const snap = path.join(w.stackRoot, '@arma_mcp_test');
  assert.equal(readFileSync(path.join(snap, 'addons', 'big_core.pbo')).includes(Buffer.from('CORE-NEW')), true);
  assert.equal(readFileSync(path.join(snap, 'big_ext_x64.dll'), 'utf8'), 'DLL-NEW');

  const overlay = planned.plan.overlays[0]!.path;
  assert.equal(existsSync(path.join(overlay, 'addons', 'big_core.pbo')), false, '겹친 PBO 는 뺀다');
  assert.equal(existsSync(path.join(overlay, 'addons', 'big_core.pbo.big_1.0.bisign')), false, '그 서명도 뺀다');
  assert.equal(existsSync(path.join(overlay, 'addons', 'big_misc.pbo')), false, 'prefix 가 같은 PBO 도 뺀다');
  assert.equal(existsSync(path.join(overlay, 'big_ext_x64.dll')), false);
  const ui = path.join(overlay, 'addons', 'big_ui.pbo');
  assert.equal(statSync(ui).ino, statSync(path.join(w.big, 'addons', 'big_ui.pbo')).ino, '하드링크');
  assert.equal(readFileSync(path.join(overlay, 'keys', 'big.bikey'), 'utf8'), 'KEY');
  assert.equal(staged.overlays[0]?.method, 'hardlink');
  assert.equal(staged.overlays[0]?.files, 3, 'big_ui.pbo, mod.cpp, keys/big.bikey');
  const marker = JSON.parse(readFileSync(path.join(overlay, OVERLAY_MARKER), 'utf8'));
  assert.equal(marker.source, path.resolve(w.big));

  // 다시 빌드한 뒤 다시 붙인다.
  writeFileSync(path.join(w.build, 'addons', 'newthing.pbo'), pboBytes('z\\new\\addons\\thing', 'NEW-2'));
  const again = await stageTestMods(planned.plan, { stackRoot: w.stackRoot });
  assert.equal(again.ok, true, again.error);
  assert.ok(readFileSync(path.join(snap, 'addons', 'newthing.pbo')).includes(Buffer.from('NEW-2')));

  // 원본 기본 모드는 모두 남는다.
  for (const f of ['big_core.pbo', 'big_core.pbo.big_1.0.bisign', 'big_misc.pbo', 'big_ui.pbo']) {
    assert.ok(existsSync(path.join(w.big, 'addons', f)), f);
  }
  assert.ok(readFileSync(path.join(w.big, 'addons', 'big_core.pbo')).includes(Buffer.from('CORE-OLD')));
});

test('stageTestMods: 복사하다 실패하면 이전 스냅샷을 남긴다', async () => {
  const w = world();
  const first = await planTestMods(input(w, [path.join(w.build, 'addons', 'newthing.pbo')]));
  assert.ok(first.ok);
  assert.equal((await stageTestMods(first.plan, { stackRoot: w.stackRoot })).ok, true);
  const gone = path.join(w.base, 'vanishing.pbo');
  writeFileSync(gone, pboBytes('z\\v', 'V'));
  const second = await planTestMods(input(w, [gone]));
  assert.ok(second.ok);
  rmSync(gone);
  const res = await stageTestMods(second.plan, { stackRoot: w.stackRoot });
  assert.equal(res.ok, false);
  assert.ok(existsSync(path.join(w.stackRoot, '@arma_mcp_test', 'addons', 'newthing.pbo')), '이전 스냅샷 유지');
});

test('stripStackMods: 오버레이는 표시 파일로 원래 모드로 되돌리고 스냅샷은 뺀다', async () => {
  const w = world();
  const planned = await planTestMods(input(w, [w.build]));
  assert.ok(planned.ok);
  assert.equal((await stageTestMods(planned.plan, { stackRoot: w.stackRoot })).ok, true);
  const res = stripStackMods(planned.plan.mods.join(';'), path.join(w.base, 'stacks'));
  assert.equal(res.modString, [path.resolve(w.big), w.other].join(';'));
  assert.deepEqual(res.restored, [path.resolve(w.big)]);
  assert.equal(res.removed.length, 1);
});
