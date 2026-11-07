// play.ts — arma_play 툴 등록.
//
// 한 번의 호출로 게임 안에 들어가 있는 상태를 만든다. 미션 준비, 실행, 접속,
// 인게임 진입 확인까지가 한 흐름이다. 오케스트레이션은 PlayOrchestrator 가 한다.
//
// 인게임 뒤의 준비 마커 대기와 셋업 SQF 는 playFollowUps.ts 가, 프로필 저장과 병합은
// launchProfiles.ts 가 맡는다. 둘 다 실행 lease 를 쥔 채로 돈다.

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { combineAbortSignals } from '../abort.js';
import { operationBusy, operationOwner } from '../operationOwner.js';
import { CLIENTS_INPUT, STACK_INPUT, TEST_MODS_INPUT, onStack } from '../stackDeps.js';
import type { PlayResult } from '../../launch/playOrchestrator.js';
import { ROLE_ROW_MAX, ROLE_TEXT_MAX } from '../../launch/autoSlot.js';
import {
  PROFILE_NAME_RE,
  READY_TIMEOUT_MAX_MS,
  READY_TIMEOUT_MIN_MS,
  findProfile,
  loadLaunchProfiles,
  mergeProfile,
  profileFromPlay,
  resolveLaunchProfilesFile,
  saveLaunchProfile,
  unknownProfileError,
  type LaunchProfilesFile,
} from '../../launch/launchProfiles.js';
import {
  READY_DEFAULT_TIMEOUT_MS,
  THEN_DEFAULT_TIMEOUT_MS,
  readySpecProblem,
  runPlayFollowUps,
  thenSpecProblem,
  type PlayFollowUps,
} from '../../launch/playFollowUps.js';

// __proto__ 같은 예약 이름은 저장과 조회 단계(isProfileName, findProfile)가 거른다.
const profileName = z.string().regex(PROFILE_NAME_RE);

// eslint-disable-next-line no-control-regex
const ROLE_CONTROL_RE = /[\u0000-\u001f\u007f"]/;
/** 역할 지정 하나. arma_launch_mp 의 roles 도 같은 꼴이다. */
export const ROLE_INPUT = z.union([
  z.number().int().min(0).max(ROLE_ROW_MAX),
  z
    .string()
    .trim()
    .min(1)
    .max(ROLE_TEXT_MAX)
    .refine((s) => !ROLE_CONTROL_RE.test(s), { message: '역할 글자에 제어 문자와 큰따옴표를 넣을 수 없다' }),
  z.null(),
]);

export const PLAY_INPUT = {
  stack: STACK_INPUT,
  mode: z
    .enum(['sp', 'mp'])
    .optional()
    .describe("'sp'(기본) 싱글플레이 자동 로드 | 'mp' 데디 서버와 클라이언트 자동 접속."),
  mission: z
    .string()
    .optional()
    .describe('언팩 미션 폴더 절대경로 또는 missionsDir 하위 이름. 미지정 시 즉석 생성.'),
  modset: z
    .enum(['rpt', 'explicit', 'none'])
    .optional()
    .describe("모드셋 소스(기본 'rpt'). mp 는 서버와 클라에 동일 적용."),
  mods: z.array(z.string()).optional().describe("modset='explicit' 일 때 모드 경로 배열."),
  testMods: TEST_MODS_INPUT,
  clients: CLIENTS_INPUT,
  killRunning: z.boolean().optional().describe('이미 실행 중이면 강제 종료 후 실행(기본 false).'),
  clientExtraArgs: z.array(z.string()).optional().describe('클라이언트 추가 실행 인자.'),
  dryRun: z.boolean().optional().describe('실행하지 않고 인자와 계획만 반환.'),
  inGameTimeoutMs: z
    .number()
    .optional()
    .describe('mp 인게임 진입 대기(ms, 기본 180000). 사람이 슬롯을 고를 시간도 여기 포함된다.'),

  world: z.string().optional().describe('즉석 생성 시 terrain 클래스명(기본 VR).'),
  name: z.string().optional().describe('즉석 생성 시 미션 이름(기본 mcp_play).'),
  playerType: z.string().optional().describe('즉석 생성 시 플레이어 유닛 클래스.'),
  position: z
    .array(z.number())
    .min(2)
    .max(3)
    .optional()
    .describe('즉석 생성 시 플레이어 위치 [동, 북, 높이]. SQF getPos 와 같은 순서다.'),
  safeSpawn: z
    .enum(['off', 'ground', 'land'])
    .optional()
    .describe("즉석 생성 시 바다와 공중 스폰 보정(기본 'land')."),
  initSqf: z.string().optional().describe('즉석 생성 시 init.sqf 내용.'),

  waitForNewRptMs: z.number().optional().describe('sp 전용. 새 RPT 대기(ms, 기본 30000).'),

  port: z.number().optional().describe('mp 전용. 서버 포트(기본 설정값).'),
  password: z.string().optional().describe('mp 전용. 서버 비밀번호(기본 설정값).'),
  serverExtraArgs: z.array(z.string()).optional().describe('mp 전용. 서버 추가 실행 인자.'),
  serverReadyTimeoutMs: z.number().optional().describe('mp 전용. 서버 부팅 대기(ms, 기본 60000).'),
  bridgeReadyTimeoutMs: z
    .number()
    .optional()
    .describe('브리지 대기(ms). mp 기본 120000, sp 기본 180000.'),
  clientConnectTimeoutMs: z
    .number()
    .optional()
    .describe('mp 전용. 클라 접속(로비 도달) 대기(ms, 기본 180000).'),
  autoSlot: z
    .boolean()
    .optional()
    .describe(
      'mp 전용. 서버가 로비 역할을 배정해 클라가 로비 없이 들어가게 한다(기본 true). ' +
        '데몬이 만드는 server.cfg 에 skipLobby = 1 과 OnAutoSelectRole 훅을 넣는다. 클라와 애드온은 건드리지 않는다. ' +
        'false 면 로비에서 사람이 고른다.',
    ),
  lobbyProbe: z
    .boolean()
    .optional()
    .describe(
      '쓰지 않는다. 로비 배정을 서버가 하게 되면서 클라 로비 덤프가 없어졌다. 주면 무시하고 경고한다.',
    ),
  roles: z
    .array(ROLE_INPUT)
    .max(16)
    .optional()
    .describe(
      'mp 전용. 클라마다 서버가 배정할 역할. roles[0] 이 클라 1 이다. ' +
        '수는 역할 번호(로비 목록의 역할 순서, 진영을 가로질러 0부터), 글자는 유닛 변수 이름과 같은 빈 슬롯, ' +
        '없으면 역할 설명에 대소문자 무시 부분 일치하는 빈 슬롯이다. null 과 모자라는 클라는 서버 기본 배정' +
        '(사람이 가장 적은 진영의 첫 빈 슬롯)이다. 못 찾거나 찬 슬롯이면 기본 배정으로 들어간다. ' +
        'clients 를 안 주면 roles 길이만큼 띄운다. 실제로 받은 역할은 결과 autoSlot.clients[].role 에 남는다.',
    ),
  expectPlayers: z
    .number()
    .optional()
    .describe('mp 전용. 인게임으로 인정할 최소 플레이어 수(기본 clients).'),

  profile: profileName
    .optional()
    .describe('저장된 실행 프로필 이름. 명시한 인자가 프로필 값보다 우선한다.'),
  saveProfile: profileName
    .optional()
    .describe(
      '이 이름으로 실행 프로필을 저장한다. 인게임 진입과 ready 가 성공했을 때만 저장한다. ' +
        '실제로 쓴 미션과 모드를 적는다. killRunning, password, then 은 적지 않는다.',
    ),
  ready: z
    .object({
      rpt: z.string().min(1).describe('기다릴 줄의 정규식(대소문자 무시).'),
      source: z
        .enum(['client', 'server'])
        .optional()
        .describe("찾을 RPT. 기본 'client'. 'server' 는 mp 전용이다."),
      timeoutMs: z
        .number()
        .int()
        .min(READY_TIMEOUT_MIN_MS)
        .max(READY_TIMEOUT_MAX_MS)
        .optional()
        .describe(`대기 상한(ms, 기본 ${READY_DEFAULT_TIMEOUT_MS}).`),
    })
    .optional()
    .describe(
      '인게임 진입 뒤 이번 실행이 만든 새 RPT 에서 이 패턴을 기다린다. ' +
        '새 RPT 가 없으면 기다리지 않고 실패한다.',
    ),
  then: z
    .object({
      code: z
        .string()
        .min(1)
        .describe(
          '실행할 SQF 셋업 코드. 끝에 ; true 처럼 값을 둔다. ' +
            '<nil> 이면 실행 구간 RPT 의 오류 블록도 실패로 본다.',
        ),
      mode: z
        .enum(['server', 'all', 'client'])
        .optional()
        .describe(
          "실행 대상. 기본 'server'. 'client'면 target 필수다. 없으면 게임을 띄우기 전에 거절한다.",
        ),
      target: z.string().optional().describe("mode='client' 일 때 대상 플레이어 이름."),
      timeoutMs: z
        .number()
        .int()
        .min(500)
        .max(600000)
        .optional()
        .describe(`결과 대기(ms, 기본 ${THEN_DEFAULT_TIMEOUT_MS}).`),
    })
    .optional()
    .describe(
      'ready 가 끝난 뒤 arma_exec 와 같은 경로로 실행할 SQF. 결과는 then.exec 에 담긴다. ' +
        '프로필에 저장하지 않는다.',
    ),
};

const PlayInputSchema = z.object(PLAY_INPUT);
export type PlayToolArgs = z.infer<typeof PlayInputSchema>;

interface ProfileSection {
  file: string;
  /** 불러온 프로필 이름. */
  name?: string;
  /** dryRun 에서만. 프로필을 얹은 뒤 실제로 쓸 인자. */
  merged?: Record<string, unknown>;
  /** 저장한 프로필 이름. */
  saved?: string;
  /** 저장하지 않은 이유. */
  notSaved?: string;
}

/** dryRun 에 보여 줄 병합 인자. 비밀번호는 값 대신 표시만 한다. */
function shownArgs(opts: Record<string, unknown>): Record<string, unknown> {
  const shown = { ...opts };
  if (shown.password !== undefined) shown.password = '(숨김)';
  return shown;
}

/**
 * arma_play 한 번. 프로필 병합, lease, 실행, 뒤처리, 프로필 저장 순이다.
 * 등록 함수와 분리한 이유는 테스트가 스키마를 거치지 않고 부르기 위해서다.
 * requestSignal 은 이 호출 하나의 취소 신호다(SDK 의 extra.signal).
 */
export async function handlePlay(
  deps: Deps,
  args: PlayToolArgs,
  requestSignal?: AbortSignal,
): Promise<ReturnType<typeof jsonContent>> {
  const { profile: profileNameArg, saveProfile, then, stack: _stack, ...rest } = args;
  const profilesFile = resolveLaunchProfilesFile(deps.cfg);
  const namedStack = deps.stack !== undefined && !deps.stack.isDefault;

  // 프로필은 lease 전에 읽는다. 읽기만 하므로 다른 세션을 기다리게 하지 않는다.
  let opts = rest;
  if (profileNameArg !== undefined) {
    let data: LaunchProfilesFile;
    try {
      data = await loadLaunchProfiles(profilesFile);
    } catch (e) {
      return jsonContent({ ok: false, error: (e as Error).message, profilesFile });
    }
    const profile = findProfile(data, profileNameArg);
    if (!profile) {
      const known = Object.keys(data.profiles).sort();
      return jsonContent({
        ok: false,
        error: unknownProfileError(profileNameArg, known),
        profiles: known,
        profilesFile,
      });
    }
    opts = mergeProfile(opts, profile);
    // 이름 있는 스택의 포트는 스택이 정한다. 프로필에 적힌 포트는 default 스택의 것이다.
    if (namedStack && rest.port === undefined) {
      const { port: _port, ...withoutPort } = opts;
      opts = withoutPort;
    }
  }

  const { ready, ...playOpts } = opts;
  // 게임을 띄운 뒤에야 드러날 인자 오류는 띄우기 전에 거른다. 부팅만 1~2분이다.
  if (ready) {
    const problem = readySpecProblem(ready, playOpts.mode ?? 'sp');
    if (problem) return jsonContent({ ok: false, error: problem });
  }
  if (then) {
    const problem = thenSpecProblem(then);
    if (problem) return jsonContent({ ok: false, error: problem });
  }

  // dryRun 도 lease 를 잡는다. 미션 폴더 생성이 공유 파일시스템 변경이라
  // 다른 세션의 launch 직전 내용을 덮을 수 있다.
  const acquired = deps.operationCoordinator.tryAcquire('arma_play', operationOwner(deps));
  if (!acquired.acquired) return operationBusy(deps, acquired.busy);
  const combined = combineAbortSignals(
    acquired.lease.signal,
    deps.session.abortController.signal,
    requestSignal,
  );
  try {
    const result = await deps.playOrchestrator.play(playOpts, combined.signal);
    const followStartedAt = Date.now();
    const follow = result.dryRun
      ? undefined
      : await runPlayFollowUps(deps, result, { ready, then }, combined.signal);

    const out: Record<string, unknown> = { ...result };
    if (follow) {
      out.ok = result.ok && follow.ok;
      out.error = result.error ?? follow.error;
      if (follow.ready) out.ready = follow.ready;
      if (follow.then) out.then = follow.then;
      out.rpt = follow.rpt;
      if (result.ok && !follow.ok) {
        out.nextSteps =
          '인게임에는 들어갔다. 게임은 그대로 두었다. ready, then, rpt 로 원인을 확인하라.';
      }
      out.totalMs = result.totalMs + (Date.now() - followStartedAt);
    }

    if (profileNameArg !== undefined || saveProfile !== undefined) {
      const section: ProfileSection = { file: profilesFile };
      if (profileNameArg !== undefined) section.name = profileNameArg;
      if (result.dryRun && profileNameArg !== undefined) {
        section.merged = shownArgs({ ...opts, ...(then ? { then } : {}) });
      }
      if (saveProfile !== undefined) {
        const skip = saveSkipReason(result, follow);
        if (skip) {
          section.notSaved = skip;
        } else {
          try {
            await saveLaunchProfile(
              profilesFile,
              saveProfile,
              profileFromPlay(deps.cfg, opts, result),
            );
            section.saved = saveProfile;
          } catch (e) {
            section.notSaved = `저장하지 못했다: ${(e as Error).message}`;
          }
        }
      }
      out.profile = section;
    }
    return jsonContent(out);
  } finally {
    combined.dispose();
    acquired.lease.release();
  }
}

/** 저장하지 않을 이유. then 의 실패는 막지 않는다. then 은 저장하지 않는 값이기 때문이다. */
function saveSkipReason(result: PlayResult, follow: PlayFollowUps | undefined): string | undefined {
  if (result.dryRun) return 'dryRun 이라 저장하지 않았다';
  if (!result.ok) return '인게임 진입을 확인하지 못해 저장하지 않았다';
  if (follow?.ready && !follow.ready.ok) return 'ready 가 실패해 저장하지 않았다';
  return undefined;
}

export function registerPlayTool(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_play',
    {
      title: 'Arma 인게임 진입',
      description:
        '한 번의 호출로 게임 안까지 들어간다. mode="sp"(기본)는 -autotest 로 미션을 바로 로드하고, ' +
        'mode="mp" 는 데디 서버를 -autoInit 으로 띄운 뒤 클라이언트를 -connect 로 붙이고 로비 슬롯까지 넘긴다. ' +
        'mission 을 주면 그 미션을 쓰고, 안 주면 최소 테스트 미션을 즉석에서 만든다(스캐폴드 인자는 ' +
        'arma_scaffold_mission 과 같은 이름이며 바다와 공중 스폰 보정이 기본으로 켜진다). ' +
        '성공 판정은 서버 텔레메트리이며, 자동 슬롯 선택이 실패해도 사람이 직접 고를 때까지 기다렸다가 ' +
        '무슨 일이 있었는지 그대로 보고한다. 실행 lease 를 오래 점유하는 긴 호출이다. ' +
        '실행만 최악 8분이고, ready 와 then 의 timeoutMs 가 같은 lease 안에서 더해진다(최악 23분). ' +
        'dryRun 으로 인자만 확인할 수 있다(이때도 미션 폴더는 실제로 만든다). ' +
        'profile 은 저장된 미션과 모드를 불러온다. 명시한 인자가 프로필보다 우선한다. ' +
        'saveProfile 은 성공한 실행의 미션과 모드를 그 이름으로 저장한다. ' +
        'ready 는 인게임 뒤 이번 실행의 새 RPT 에서 준비 마커를 기다린다. ' +
        'then 은 그 뒤 SQF 셋업 코드를 arma_exec 와 같은 경로로 실행한다. ' +
        '실제 실행이면 결과의 rpt 에 이번 실행 RPT 의 오류 블록 수와 Warning Message 수가 붙는다. ' +
        'ready 나 then 이 실패해도 게임은 끄지 않는다.',
      inputSchema: PLAY_INPUT,
    },
    onStack(shared, { create: true }, async (deps, args, extra) =>
      handlePlay(deps, args, extra?.signal),
    ),
  );
}
