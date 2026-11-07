// mcp_smoke.ts — SDK Client 로 실제 MCP 서버를 스폰해 fake_dll 과 E2E 검증.
//
// 흐름: 서버 스폰 → arma_status(미접속) → fake_dll 접속 → status(접속) →
//       mission_info(Altis) → arma_exec 1+1 = SCALAR: 2 → fake_dll 종료 →
//       arma_exec = game not connected.
// 데몬 단계: 데몬 없이 cli 가 종료 코드 3 이고 데몬을 띄우지 않는지 본 뒤, 격리된 설정으로
//       daemon 을 띄우고 fake_dll 을 붙인 뒤 같은 엔트리의 cli 를
//       자식 프로세스로 돌린다. status, exec, stdin exec, call 거부, 대기 중 강제 종료 뒤
//       세션 정리를 보고 /shutdown 으로 끝낸다.
//
// 실행: tsx test/mcp_smoke.ts   (종료코드 0=성공)

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BROADCAST_POLICY_KO } from '../src/mcp/broadcastPolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// 기본은 src(tsx). ARMA_MCP_SMOKE_SERVER 로 번들 등 다른 엔트리를 지정해 스모크 가능.
//   예: ARMA_MCP_SMOKE_SERVER=bundle/index.mjs tsx test/mcp_smoke.ts
const serverEntry = process.env.ARMA_MCP_SMOKE_SERVER
  ? path.resolve(process.env.ARMA_MCP_SMOKE_SERVER)
  : path.join(here, '..', 'src', 'index.ts');
const useTsx = serverEntry.endsWith('.ts');
const fakeDllEntry = path.join(here, 'fake_dll.ts');

// 실제 서버/다른 세션과 충돌하지 않도록 고유 파이프.
const TEST_PIPE = `\\\\.\\pipe\\arma_mcp_test_${process.pid}`;

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    process.stderr.write(`  ✔ ${label}\n`);
  } else {
    failures += 1;
    process.stderr.write(`  x FAIL: ${label}\n`);
  }
}

function parseToolResult(res: { content?: unknown }): any {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  const textPart = content.find((c) => c.type === 'text');
  return textPart?.text ? JSON.parse(textPart.text) : null;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return parseToolResult(res as { content?: unknown });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const smokeRoot = mkdtempSync(path.join(tmpdir(), 'arma-mcp-smoke-'));
  const smokeConfig = path.join(smokeRoot, 'config.json');
  writeFileSync(
    smokeConfig,
    JSON.stringify({
      arma: {
        missionsDir: path.join(smokeRoot, 'missions'),
        profilesFile: path.join(smokeRoot, 'launch-profiles.json'),
      },
      stacks: { root: path.join(smokeRoot, 'stacks') },
      web: { enabled: false },
      // 격리 데몬이 사용자 화면의 게임 창을 보지 않게 한다.
      windowTiler: { enabled: false, focusGuard: false },
    }),
    'utf8',
  );

  // Windows 에서 npx.cmd 스폰 문제를 피하려 node + tsx 로더를 직접 사용.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: useTsx
      ? ['--import', 'tsx', serverEntry, 'standalone']
      : [serverEntry, 'standalone'],
    env: { ...process.env, ARMA_MCP_PIPE: TEST_PIPE, ARMA_MCP_CONFIG: smokeConfig },
  });
  const client = new Client({ name: 'smoke', version: '0.0.1' });
  await client.connect(transport);
  process.stderr.write('server connected\n');

  // 툴 목록 확인.
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(names.includes('arma_exec'), 'arma_exec 등록됨');
  check(names.includes('arma_mission_info'), 'arma_mission_info 등록됨');
  check(names.includes('arma_scaffold_mission'), 'arma_scaffold_mission 등록됨');
  check(names.includes('arma_launch_mp'), 'arma_launch_mp 등록됨');
  check(names.includes('arma_launch_server'), 'arma_launch_server 등록됨');
  check(names.includes('arma_capture'), 'arma_capture 등록됨');
  check(names.includes('arma_tacmap_subtitle'), 'arma_tacmap_subtitle 등록됨');
  check(names.includes('arma_tacmap_mark'), 'arma_tacmap_mark 등록됨');
  check(names.includes('arma_tacmap_open'), 'arma_tacmap_open 등록됨');
  check(names.includes('arma_watch'), 'arma_watch 등록됨');
  check(names.includes('arma_play'), 'arma_play 등록됨');
  check(names.includes('arma_zeus_find'), 'arma_zeus_find 등록됨');
  check(names.includes('arma_zeus_module'), 'arma_zeus_module 등록됨');
  check(names.length === 23, `툴 23개 등록됨 (실제 ${names.length}: ${names.join(',')})`);

  // 플레이어 눈에 보이는 툴은 전부 "요청받았을 때만" 규칙을 달고 나가야 한다.
  const BROADCAST_TOOLS = [
    'arma_tacmap_subtitle',
    'arma_tacmap_mark',
    'arma_tacmap_open',
    'arma_web_open',
  ];
  for (const name of BROADCAST_TOOLS) {
    const tool = tools.tools.find((t) => t.name === name);
    check(
      (tool?.description ?? '').includes(BROADCAST_POLICY_KO),
      `${name} description 에 무단 방송 금지 규칙 포함`,
    );
  }

  // 미접속 상태.
  let status = await callJson(client, 'arma_status', {});
  check(status.dllConnected === false, '초기 dllConnected=false');
  check(
    Array.isArray(status.profiles) && status.profiles.length === 0,
    'arma_status profiles 가 빈 목록',
  );

  // 캡처 우아한 실패 — 데디 서버 프로세스는 스모크 중 떠 있을 일이 없다.
  // (클라 arma3_x64 는 개발 머신에서 떠 있을 수 있어 비결정적 — server 타겟으로만 검증.)
  if (status.serverProcessRunning === false) {
    const cap = await callJson(client, 'arma_capture', { target: 'server' });
    check(cap?.ok === false && typeof cap?.error === 'string', 'arma_capture 미실행 시 우아한 실패');
  }

  // fake_dll 접속.
  const fake: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', fakeDllEntry, '--machines', 'server'],
    {
      env: { ...process.env, ARMA_MCP_PIPE: TEST_PIPE },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  await sleep(3000);

  status = await callJson(client, 'arma_status', {});
  check(status.dllConnected === true, 'fake_dll 접속 후 dllConnected=true');
  // ACE 감지 보고.
  check(status.ace === true, 'status.ace=true');
  check(status.aceVersion === '3.21.0.110', `status.aceVersion (실제 ${status.aceVersion})`);
  check(
    Array.isArray(status.aceComponents) && status.aceComponents.includes('ace_medical'),
    'status.aceComponents 에 ace_medical 포함',
  );
  check(
    Array.isArray(status.hints) && status.hints.some((h: string) => h.includes('ACE')),
    'ACE 로드 시 hints 존재',
  );
  // AHC_TacticalMap 감지 보고 + 전용 툴 유도 힌트.
  check(status.tacmap === true, 'status.tacmap=true');
  check(status.tacmapZeusTool === true, 'status.tacmapZeusTool=true');
  check(
    Array.isArray(status.hints) && status.hints.some((h: string) => h.includes('AHC_TacticalMap')),
    'TacMap 로드 시 arma_tacmap_* 유도 힌트 존재',
  );

  const mission = await callJson(client, 'arma_mission_info', {});
  check(mission.connected === true, 'mission connected=true');
  check(mission.world === 'Altis', `mission world=Altis (실제 ${mission.world})`);
  check(mission.ace === true, 'mission_info.ace=true');
  check(mission.tacmap === true, 'mission_info.tacmap=true');
  check(mission.fpsMin === 31.2, `mission_info.fpsMin=31.2 (실제 ${mission.fpsMin})`);
  check(
    JSON.stringify(mission.scripts) === JSON.stringify({ spawn: 4, execVM: 1, exec: 0, fsm: 2 }),
    `mission_info.scripts (실제 ${JSON.stringify(mission.scripts)})`,
  );
  check(mission.paused === false && mission.focused === true, 'mission_info paused=false focused=true');
  check(
    status.game?.focused === true && status.game?.fpsMin === 31.2,
    `status.game 에 창 상태와 fpsMin (실제 ${JSON.stringify(status.game)})`,
  );

  // 전술지도 무전 자막 — 조립 SQF 가 문자열 ack 로 끝나고 서버가 그걸 해석하는지.
  const sub = await callJson(client, 'arma_tacmap_subtitle', {
    text: '무전 스모크',
    speaker: '지휘부',
    color: 'hq',
  });
  check(sub.ok === true, `arma_tacmap_subtitle ok (실제 ${JSON.stringify(sub.error ?? sub.ack)})`);
  check(sub.ack === 'OK:all', `자막 ack=OK:all (실제 ${sub.ack})`);
  check(sub.color === '#0054FF', `hq → #0054FF (실제 ${sub.color})`);

  // 지도 마커 — 이름이 TacMap 예약 프리픽스와 겹치지 않아야 웹 수집에 잡힌다.
  const mark = await callJson(client, 'arma_tacmap_mark', {
    pos: [4211, 7302],
    text: 'SMOKE',
    id: 'smoke1',
  });
  check(mark.ok === true, `arma_tacmap_mark ok (실제 ${JSON.stringify(mark.error ?? mark.ack)})`);
  check(mark.marker === 'mcp_mark_smoke1', `마커 이름 mcp_mark_smoke1 (실제 ${mark.marker})`);
  check(mark.ping?.requested === false, '핑 미요청 시 requested=false');

  // 입력 검증은 게임을 거치지 않고 즉시 거부.
  const badColor = await callJson(client, 'arma_tacmap_subtitle', { text: 'x', color: 'purple' });
  check(badColor.ok === false, '알 수 없는 색은 거부');

  const exec1 = await callJson(client, 'arma_exec', { code: '1+1' });
  check(exec1.ok === true, 'exec 1+1 ok');
  check(
    exec1.results?.[0]?.result === 'SCALAR: 2',
    `exec 1+1 결과 SCALAR: 2 (실제 ${exec1.results?.[0]?.result})`,
  );
  check(exec1.results?.[0]?.parsed?.kind === 'value', 'exec 결과 parsed.kind=value');
  // 깨끗한 성공에는 RPT 귀속 주의를 달지 않는다 — 읽을 블록이 없는데 붙이면
  // 에이전트를 헛된 RPT 조회로 유인한다(실측 515콜 중 유효 블록 0건).
  check(
    exec1.rptAttribution === undefined && (exec1.rptErrors?.length ?? 0) === 0,
    `성공 결과에 rptAttribution 없음 (실제 ${String(exec1.rptAttribution)})`,
  );

  // arma_watch: 조립 → 전송 → ack 파싱까지 종단으로 돈다(인게임 루프는 fake_dll 이 흉내).
  const watch = (await callJson(client, 'arma_watch', {
    condition: 'count allUnits > 0',
    sample: 'count allUnits',
    timeoutMs: 5000,
  })) as {
    ok?: boolean;
    met?: boolean;
    reason?: string;
    iterations?: number;
    samples?: string[];
    watchId?: string;
  };
  check(watch.ok === true, 'arma_watch ok');
  check(watch.met === true && watch.reason === 'met', `watch met (실제 ${watch.reason})`);
  check(watch.iterations === 1, `watch iterations=1 (실제 ${watch.iterations})`);
  check(
    (watch.samples?.length ?? 0) === 2,
    `watch 샘플 2건 파싱 (실제 ${watch.samples?.length})`,
  );
  check(typeof watch.watchId === 'string' && watch.watchId.length > 0, 'watchId 반환');

  // arma_zeus_find: 감지 → 조립 → 첫 쪽 → 남은 쪽까지 종단으로 돈다(fake_dll 이 2쪽으로 답한다).
  const zf = (await callJson(client, 'arma_zeus_find', { query: 'rifle', kind: 'unit' })) as {
    ok?: boolean;
    machine?: string;
    total?: number;
    results?: { ref?: string; sqf?: string; label?: string }[];
    exec?: { count?: number };
  };
  check(zf.ok === true, `arma_zeus_find ok (실제 ${JSON.stringify(zf).slice(0, 200)})`);
  check(zf.total === 2 && zf.results?.length === 2, `zeus find 2쪽 이어 받기 (실제 ${zf.results?.length})`);
  check(zf.exec?.count === 2, `zeus find exec 2회 (실제 ${zf.exec?.count})`);
  check(
    zf.results?.[1]?.sqf === '("2:2" call BIS_fnc_objectFromNetId)',
    `zeus find sqf 식 (실제 ${zf.results?.[1]?.sqf})`,
  );

  // arma_zeus_module: auto 는 Zeus 플레이어가 없으면 거절하고, dryRun 은 아무것도 만들지 않는다.
  const zmAuto = (await callJson(client, 'arma_zeus_module', { module: 'Lightning' })) as { ok?: boolean };
  check(zmAuto.ok === false, 'zeus module 은 Zeus 플레이어 없이 auto 로 돌지 않는다');
  const zmDry = (await callJson(client, 'arma_zeus_module', {
    module: 'Lightning',
    on: 'server',
    dryRun: true,
  })) as { ok?: boolean; dryRun?: boolean; module?: { class?: string } };
  check(
    zmDry.ok === true && zmDry.dryRun === true && zmDry.module?.class === 'ModuleLightning_F',
    `zeus module dryRun 해석 (실제 ${JSON.stringify(zmDry).slice(0, 200)})`,
  );

  // verify: 증거식이 죽어도 본문 결과는 돌아온다 — 30초 타임아웃 10건의 근본 원인이 이거였다.
  const verified = (await callJson(client, 'arma_exec', {
    code: 'doStuff',
    verify: 'round allUnits',
  })) as {
    ok?: boolean;
    results?: { result?: string }[];
    verify?: { result?: string; parsed?: { kind?: string } };
  };
  check(verified.ok === true, 'verify 실패해도 exec 는 ok');
  check(
    verified.results?.[0]?.result === 'BOOL: true',
    `본문 결과가 평소 모양으로 온다 (실제 ${verified.results?.[0]?.result})`,
  );
  check(
    verified.verify?.parsed?.kind === 'error',
    `verify 는 error 로 분리 보고 (실제 ${verified.verify?.parsed?.kind})`,
  );

  // 주석 제거 검증.
  const exec2 = await callJson(client, 'arma_exec', { code: '1+1 // 코멘트\n' });
  check(exec2.sanitized === true, '주석 포함 코드가 sanitized=true');
  check(exec2.results?.[0]?.result === 'SCALAR: 2', '주석 제거 후에도 SCALAR: 2');

  // nil 모호성.
  const exec3 = await callJson(client, 'arma_exec', { code: 'nilplease' });
  check(exec3.results?.[0]?.parsed?.kind === 'nil', 'nilplease → parsed.kind=nil');

  // 미션 스캐폴딩 (launch:false — 게임 불필요).
  const scaf = await callJson(client, 'arma_scaffold_mission', {
    world: 'VR',
    name: 'smoke_scene',
    launch: false,
  });
  check(scaf.ok === true, 'scaffold ok');
  check(
    typeof scaf.missionPath === 'string' && scaf.missionPath.endsWith('smoke_scene.VR'),
    `scaffold missionPath (실제 ${scaf.missionPath})`,
  );
  check(Array.isArray(scaf.files) && scaf.files.length === 3, 'scaffold files 3개');

  // dryRun 런치: 스캐폴드 → -autotest cfg 가 스캐폴드된 미션을 가리키는지.
  const scafDry = await callJson(client, 'arma_scaffold_mission', {
    world: 'VR',
    name: 'smoke_dry',
    launch: true,
    dryRun: true,
  });
  check(scafDry.launch?.dryRun === true, 'scaffold dryRun launch');
  check(
    typeof scafDry.launch?.argString === 'string' && scafDry.launch.argString.includes('-autotest='),
    'dryRun argString 에 -autotest 포함',
  );

  // arma_play dryRun: 미션을 즉석 생성하고 -autotest 인자를 계산하는지.
  const playDry = await callJson(client, 'arma_play', {
    mode: 'sp',
    world: 'VR',
    name: 'smoke_play',
    dryRun: true,
  });
  check(playDry.dryRun === true, 'arma_play dryRun');
  check(playDry.mission?.origin === 'scaffolded', 'arma_play 가 미션을 즉석 생성');
  check(
    typeof playDry.launch?.argString === 'string' &&
      playDry.launch.argString.includes('-autotest='),
    'arma_play dryRun argString 에 -autotest 포함',
  );

  await stackPhase(client, scaf.missionPath);

  // 테스트 산출물 정리(사용자 홈 ~/.arma-mcp/missions 에 남기지 않도록).
  for (const mp of [scaf.missionPath, scafDry.missionPath, playDry.mission?.path]) {
    if (typeof mp === 'string') {
      try {
        rmSync(mp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // fake_dll 종료 → 미접속.
  fake.kill();
  await sleep(1500);
  const exec4 = await callJson(client, 'arma_exec', { code: '1+1' });
  check(exec4.ok === false, 'fake_dll 종료 후 exec ok=false');
  check(
    typeof exec4.error === 'string' && exec4.error.includes('not connected'),
    `exec 오류 메시지 game not connected (실제 ${exec4.error})`,
  );

  await client.close();
  try {
    fake.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(smokeRoot, { recursive: true, force: true });

  await daemonPhase();

  process.stderr.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAIL'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── 스택 단계 ─────────────────────────────────────────
//
// 이름 있는 스택 b 를 dryRun 실행으로 만들고, 그 파이프에 태그 B 인 fake_dll 을 붙인다.
// default 스택의 fake_dll(태그 없음)과 섞이지 않고 각자 제 게임에서 답하는지 본다.
async function stackPhase(client: Client, missionPath: string): Promise<void> {
  const dry = await callJson(client, 'arma_launch_server', {
    stack: 'b',
    mission: missionPath,
    dryRun: true,
  });
  check(dry?.dryRun === true, `스택 b dryRun 실행 (실제 ${dry?.error ?? 'ok'})`);
  check(
    typeof dry?.server?.argString === 'string' && dry.server.argString.includes(path.join('stacks', 'b', 'server')),
    `스택 b 서버 -profiles 가 스택 폴더 (실제 ${dry?.server?.argString})`,
  );
  check(
    dry?.mission?.template === 'smoke_scene__b.VR',
    `스택 b 미션 template 에 접미사 (실제 ${dry?.mission?.template})`,
  );

  const st = await callJson(client, 'arma_status', { stack: 'b' });
  const b = (st?.stacks ?? []).find((s: { id: string }) => s.id === 'b');
  check(st?.stack === 'b' && b !== undefined, 'arma_status 가 스택 b 를 안다');
  check(b?.pipe === `${TEST_PIPE}_s_b`, `스택 b 파이프 (실제 ${b?.pipe})`);
  check(b?.port !== st?.stacks?.[0]?.port, '스택 b 포트가 default 와 다르다');

  const fakeB: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', fakeDllEntry, '--pipe', b?.pipe ?? '', '--pid', '2222', '--tag', 'B'],
    { env: { ...process.env }, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  await sleep(3000);

  const infoB = await callJson(client, 'arma_mission_info', { stack: 'b' });
  const infoA = await callJson(client, 'arma_mission_info', {});
  check(infoB?.world === 'B', `스택 b world=B (실제 ${infoB?.world})`);
  check(infoA?.world === 'Altis', `default world 는 그대로 Altis (실제 ${infoA?.world})`);

  const whoB = await callJson(client, 'arma_exec', { stack: 'b', code: 'mcp_whoami' });
  const whoA = await callJson(client, 'arma_exec', { code: 'mcp_whoami' });
  check(whoB?.results?.[0]?.result === 'STRING: "B"', `스택 b exec 가 B 에서 답함 (실제 ${whoB?.results?.[0]?.result})`);
  check(
    whoA?.results?.[0]?.result === 'STRING: "untagged"',
    `default exec 가 default 게임에서 답함 (실제 ${whoA?.results?.[0]?.result})`,
  );

  const both = await callJson(client, 'arma_status', {});
  const sb = (both?.stacks ?? []).find((s: { id: string }) => s.id === 'b');
  const sd = (both?.stacks ?? []).find((s: { id: string }) => s.id === 'default');
  check(sb?.dllPid === 2222 && sb?.linkPhase === 'live', `stacks[b] dllPid 2222, live (실제 ${sb?.dllPid}, ${sb?.linkPhase})`);
  check(sd?.dllPid === null && sd?.linkPhase === 'live', `stacks[default] pid 없는 옛 hello, live (실제 ${sd?.dllPid}, ${sd?.linkPhase})`);

  const unknown = await callJson(client, 'arma_exec', { stack: 'zzz', code: '1+1' });
  check(unknown?.ok === false && /모르는 스택/.test(unknown?.error ?? ''), '모르는 스택 exec 는 오류');
  const bad = await callJson(client, 'arma_exec', { stack: 'Bad-Name', code: '1+1' });
  check(bad?.ok === false, '규칙 밖 스택 이름은 오류');

  fakeB.kill();
  await sleep(1500);
  const afterB = await callJson(client, 'arma_exec', { code: '1+1' });
  check(afterB?.results?.[0]?.result === 'SCALAR: 2', '스택 b 게임이 끊겨도 default exec 는 돈다');
  const goneB = await callJson(client, 'arma_exec', { stack: 'b', code: '1+1' });
  check(goneB?.ok === false, '끊긴 스택 b exec 는 not connected');
}

// ── 데몬 단계 ─────────────────────────────────────────
//
// 격리된 설정만 쓴다. 자기 포트, 자기 파이프, 임시 폴더의 토큰 파일, rptDir, 프로필 파일이고
// web 은 끈다. 공유 데몬(5303)과 게임 파이프(\\.\pipe\arma_mcp)는 건드리지 않는다.
// CLI 는 데몬과 같은 엔트리(src 나 ARMA_MCP_SMOKE_SERVER 의 번들)에서 돈다.

function entryArgs(mode: string, rest: string[] = []): string[] {
  return useTsx ? ['--import', 'tsx', serverEntry, mode, ...rest] : [serverEntry, mode, ...rest];
}

/** ARMA_MCP_* 를 모두 뺀 환경. 이 셸의 토큰이나 파이프 설정이 격리된 데몬과 CLI 에 새지 않게 한다. */
function isolatedEnv(config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('ARMA_MCP_')) env[key] = value;
  }
  env.ARMA_MCP_CONFIG = config;
  return env;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 격리된 설정으로 cli 를 한 번 돌린다. stdin 을 주면 그 내용을 넘기고 닫는다. */
function runCli(args: string[], env: NodeJS.ProcessEnv, stdin = ''): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, entryArgs('cli', args), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin!.end(stdin);
  });
}

async function daemonPhase(): Promise<void> {
  process.stderr.write('\ndaemon phase\n');
  const root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-smoke-daemon-'));
  const port = await freePort();
  const pipe = `\\\\.\\pipe\\arma_mcp_cli_test_${process.pid}`;
  const token = randomBytes(32).toString('hex');
  const tokenFile = path.join(root, 'daemon.token');
  writeFileSync(tokenFile, token + '\n', 'utf8');
  const rptDir = path.join(root, 'rpt');
  mkdirSync(rptDir);
  const config = path.join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      pipeName: pipe,
      rptDir,
      arma: {
        missionsDir: path.join(root, 'missions'),
        profilesFile: path.join(root, 'launch-profiles.json'),
      },
      stacks: { root: path.join(root, 'stacks') },
      web: { enabled: false },
      windowTiler: { enabled: false, focusGuard: false },
      mcp: { port, tokenFile },
    }),
    'utf8',
  );
  const env = isolatedEnv(config);
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}` };
  const health = async (): Promise<any> => {
    const res = await fetch(`${base}/health`, { headers: auth });
    return res.ok ? res.json() : null;
  };

  // 데몬이 없을 때 CLI 는 종료 코드 3 으로 끝나고 데몬을 띄우지 않는다.
  // 띄웠다면 포트가 열리거나, spawnDaemon 이 상태 폴더(토큰 파일 옆)에 로그를 연다.
  const lonely = await runCli(['status'], env);
  check(
    lonely.code === 3 && /CLI 는 데몬을 띄우지 않는다/.test(lonely.stderr),
    `데몬이 없으면 cli status 는 종료 코드 3 (code ${lonely.code}, ${JSON.stringify(lonely.stderr)})`,
  );
  await sleep(1000);
  check(!(await portOpen(port)), `cli 뒤 1초가 지나도 127.0.0.1:${port} 는 닫혀 있음`);
  const spawnLogs = readdirSync(root).filter((name) => /^daemon(\.stdout)?\.log$/.test(name));
  check(spawnLogs.length === 0, `cli 가 상태 폴더에 데몬 로그를 만들지 않음 (${spawnLogs.join(', ')})`);

  const daemon = spawn(process.execPath, entryArgs('daemon'), {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let daemonLog = '';
  daemon.stderr!.on('data', (chunk: Buffer) => (daemonLog += chunk.toString('utf8')));
  let fake: ChildProcess | null = null;
  try {
    const up = await waitFor(async () => (await health())?.ok === true, 30_000);
    check(up, `격리된 데몬이 127.0.0.1:${port} 에서 뜸`);
    if (!up) {
      process.stderr.write(daemonLog);
      return;
    }

    fake = spawn(process.execPath, ['--import', 'tsx', fakeDllEntry, '--machines', 'server'], {
      env: { ...env, ARMA_MCP_PIPE: pipe },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const linked = await waitFor(async () => (await health())?.game?.connected === true, 15_000);
    check(linked, 'fake_dll 이 격리된 파이프로 데몬에 붙음');

    const status = await runCli(['status'], env);
    check(
      status.code === 0 && /^daemon {3}\d+\.\d+\.\d+, /m.test(status.stdout) && /^game {5}live/m.test(status.stdout),
      `cli status (code ${status.code}, ${JSON.stringify(status.stdout + status.stderr)})`,
    );

    const exec = await runCli(['exec', '1+1', '--raw'], env);
    check(
      exec.code === 0 && exec.stdout === '2\n',
      `cli exec "1+1" --raw 가 2 (code ${exec.code}, ${JSON.stringify(exec.stdout + exec.stderr)})`,
    );

    const piped = await runCli(['exec', '-', '--raw'], env, '1+1');
    check(
      piped.code === 0 && piped.stdout === '2\n',
      `cli exec - 가 표준 입력 코드를 실행 (code ${piped.code}, ${JSON.stringify(piped.stdout + piped.stderr)})`,
    );

    // --stack: play dryRun 이 스택 c 를 만들고(게임은 띄우지 않는다), status 가 그 스택을 고른다.
    const stackPlay = await runCli(['play', '--mode', 'sp', '--dry-run', '--stack', 'c', '--json'], env);
    let stackArg = '';
    try {
      stackArg = String(JSON.parse(stackPlay.stdout).launch?.argString ?? '');
    } catch {
      // 아래 check 가 실패로 적는다.
    }
    check(
      stackPlay.code === 0 && stackArg.includes(path.join('stacks', 'c', 'client1')),
      `cli play --stack c --dry-run 이 스택 c 클라 인자를 만든다 (code ${stackPlay.code}, ${stackPlay.stderr})`,
    );
    const stackStatus = await runCli(['status', '--stack', 'c'], env);
    check(
      stackStatus.code === 0 && /^stacks {3}default\(.*\*c\(/m.test(stackStatus.stdout),
      `cli status --stack c 가 스택 줄에 c 를 고른다 (${JSON.stringify(stackStatus.stdout)})`,
    );

    const refused = await runCli(['call', 'arma_kill', '{}'], env);
    check(
      refused.code === 2 && refused.stdout === '' && /call 로 부를 수 없다/.test(refused.stderr),
      `cli call arma_kill 은 종료 코드 2 (code ${refused.code})`,
    );

    // 대기 중에 CLI 프로세스를 죽이면 데몬이 끊긴 요청을 보고 세션을 닫는다.
    const waiting = spawn(process.execPath, entryArgs('cli', ['wait', 'dedicated', '--timeout', '60s']), {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const opened = await waitFor(
      async () => (await health())?.sessions?.byTransport?.cli === 1,
      15_000,
    );
    check(opened, 'cli wait dedicated 가 cli 세션 하나를 엶');
    await sleep(1000);
    check(waiting.exitCode === null, 'cli wait dedicated 가 아직 기다리는 중');
    // SIGKILL 로 죽인다. POSIX 에서 SIGTERM 이면 CLI 가 세션을 스스로 닫아 이 단계를 거치지 않는다.
    waiting.kill('SIGKILL');
    const killedAt = Date.now();
    const cleared = await waitFor(
      async () => (await health())?.sessions?.byTransport?.cli === 0,
      2000,
    );
    check(cleared, `CLI 를 죽이면 2초 안에 cli 세션이 0 (${Date.now() - killedAt}ms)`);
    await waitExit(waiting, 5000);
    // lease 를 쥐는 play 와 kill 은 게임 프로세스를 건드려 스모크에서 돌리지 않는다.
    // lease 가 풀리는지는 daemon.test 가 가짜 play, launch, kill 로 본다. 여기서는 남은 lease 가 없는지 본다.
    const after = await runCli(['status', '--json'], env);
    let operation: unknown = 'unparsed';
    try {
      operation = JSON.parse(after.stdout).operation;
    } catch {
      // 아래 check 가 실패로 적는다.
    }
    check(
      after.code === 0 && operation === null,
      `죽인 CLI 뒤 status 의 operation 이 null (code ${after.code}, ${JSON.stringify(operation)})`,
    );
  } finally {
    fake?.kill();
    const res = await fetch(`${base}/shutdown`, { method: 'POST', headers: auth }).catch(() => null);
    check(res?.status === 202, `격리된 데몬 /shutdown 202 (실제 ${res?.status})`);
    const exited = await waitExit(daemon, 10_000);
    check(exited, '격리된 데몬이 /shutdown 뒤 종료됨');
    if (!exited) daemon.kill();
    if (fake) await waitExit(fake, 5000);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write('smoke error: ' + (e?.stack ?? String(e)) + '\n');
  process.exit(1);
});
