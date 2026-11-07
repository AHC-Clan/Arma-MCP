// launch.ts — arma_launch / arma_launch_mp / arma_kill 툴 등록.

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { combineAbortSignals } from '../abort.js';
import { killSucceeded } from '../../launch/mpLauncher.js';
import { operationBusy, operationOwner } from '../operationOwner.js';
import { CLIENTS_INPUT, STACK_INPUT, TEST_MODS_INPUT, onStack } from '../stackDeps.js';
import { ROLE_INPUT } from './play.js';

const AUTO_SLOT_INPUT = z
  .boolean()
  .optional()
  .describe(
    '서버가 로비 역할을 배정해 클라가 슬롯 선택 없이 들어가게 한다. autoInit 서버면 기본 true. ' +
      '데몬이 만드는 server.cfg 에 skipLobby = 1 과 OnAutoSelectRole 훅을 넣는다. false 면 로비에서 사람이 고른다.',
  );

export function registerLaunchTools(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_launch',
    {
      title: 'Arma 실행',
      description:
        'Arma 3 를 실행한다. modset="rpt"(기본, 최신 RPT 헤더의 -mod= 재사용, -noLogs 제거)/"explicit"/"none". ' +
        'modSwaps(워크샵→로컬 치환)과 selfModPath(@arma_mcp) 자동 추가 적용. ' +
        'mission 지정 시 -autotest 로 자동 로드. dryRun 으로 인자만 확인 가능. 실행 후 새 RPT 감지.',
      inputSchema: {
        stack: STACK_INPUT,
        mission: z
          .string()
          .optional()
          .describe('언팩 미션 폴더 절대경로 또는 missionsDir 하위 이름.'),
        modset: z
          .enum(['rpt', 'explicit', 'none'])
          .optional()
          .describe("모드셋 소스(기본 'rpt')."),
        mods: z.array(z.string()).optional().describe("modset='explicit' 일 때 모드 경로 배열."),
        worldEmpty: z.boolean().optional().describe('-world=empty 추가(메인메뉴 정지).'),
        killRunning: z.boolean().optional().describe('이미 실행 중이면 강제 종료 후 실행.'),
        extraArgs: z.array(z.string()).optional().describe('추가 실행 인자.'),
        dryRun: z.boolean().optional().describe('실행하지 않고 인자만 반환.'),
        waitForNewRptMs: z.number().optional().describe('새 RPT 대기(ms, 기본 30000, 0=대기 안함).'),
        testMods: TEST_MODS_INPUT,
      },
    },
    onStack(shared, { create: true }, async (deps, args, extra) => {
      if (args.dryRun) return jsonContent(await deps.launcher.launch(args));
      const acquired = deps.operationCoordinator.tryAcquire(
        'arma_launch',
        operationOwner(deps),
      );
      if (!acquired.acquired) return operationBusy(deps, acquired.busy);
      const combined = combineAbortSignals(
        acquired.lease.signal,
        deps.session.abortController.signal,
        extra?.signal,
      );
      try {
        const res = await deps.launcher.launch({ ...args, signal: combined.signal });
        return jsonContent(res);
      } finally {
        combined.dispose();
        acquired.lease.release();
      }
    }),
  );

  server.registerTool(
    'arma_launch_mp',
    {
      title: 'Arma 멀티플레이 테스트 실행',
      description:
        '멀티플레이 테스트: 데디 서버(arma3server_x64)를 미션·모드셋과 함께 실행하고 클라이언트를 ' +
        '-connect 로 자동 접속시킨다. autoInit:true 면 서버가 로비 역할을 배정해(autoSlot 기본 true) 클라가 ' +
        '슬롯 선택 없이 미션에 들어간다. autoInit:false 는 로비 대기이고 슬롯 선택은 수동이다. ' +
        '미션은 MPMissions 로 자동 배치, server.cfg 자동 생성(verifySignatures=0, BattlEye=0). ' +
        '모드셋은 arma_launch 와 동일 규칙(기본 rpt)이며 서버·클라에 동일 적용. ' +
        '로비 상태에선 브리지 미접속(arma_exec 불가) — 미션 시작 후 서버 브리지가 접속된다. ' +
        '인게임 판정까지 한 번에 하려면 arma_play(mode:"mp")를 쓴다. ' +
        '서버 로그는 arma_rpt_*(source:"server") 로 조회.',
      inputSchema: {
        stack: STACK_INPUT,
        mission: z.string().describe('언팩 미션 폴더 절대경로 또는 missionsDir 하위 이름(필수).'),
        modset: z
          .enum(['rpt', 'explicit', 'none'])
          .optional()
          .describe("모드셋 소스(기본 'rpt' — 서버·클라 동일 적용)."),
        mods: z.array(z.string()).optional().describe("modset='explicit' 일 때 모드 경로 배열."),
        port: z.number().optional().describe('서버 포트(기본 설정값 2302).'),
        password: z.string().optional().describe('서버 비밀번호(기본 설정값).'),
        autoInit: z
          .boolean()
          .optional()
          .describe('true 면 persistent=1 + -autoInit 로 로비 없이 즉시 미션 시작(기본 false=로비 대기).'),
        serverOnly: z.boolean().optional().describe('서버만 실행(클라 접속 생략).'),
        killRunning: z.boolean().optional().describe('실행 중인 서버/클라를 강제 종료 후 실행.'),
        serverExtraArgs: z.array(z.string()).optional().describe('서버 추가 실행 인자.'),
        clientExtraArgs: z.array(z.string()).optional().describe('클라 추가 실행 인자.'),
        dryRun: z.boolean().optional().describe('실행하지 않고 인자·server.cfg·배치 계획만 반환.'),
        serverReadyTimeoutMs: z.number().optional().describe('서버 부팅 대기(ms, 기본 60000).'),
        bridgeReadyTimeoutMs: z
          .number()
          .optional()
          .describe('autoInit 미션의 새 MCP 브리지·전용 서버 텔레메트리 대기(ms, 기본 120000).'),
        clientConnectTimeoutMs: z
          .number()
          .optional()
          .describe('클라 접속(로비 도달) 대기(ms, 클라마다, 기본 180000).'),
        clients: CLIENTS_INPUT,
        autoSlot: AUTO_SLOT_INPUT,
        roles: z
          .array(ROLE_INPUT)
          .max(16)
          .optional()
          .describe(
            '클라마다 서버가 배정할 역할. roles[0] 이 클라 1 이다. 꼴과 규칙은 arma_play 의 roles 와 같다. ' +
              'null 과 모자라는 클라는 서버 기본 배정이다. clients 보다 많이 줄 수 없다.',
          ),
        testMods: TEST_MODS_INPUT,
      },
    },
    onStack(shared, { create: true }, async (deps, rawArgs, extra) => {
      const { roles, ...rest } = rawArgs;
      const args = { ...rest, ...(roles ? { autoSlotRoles: roles } : {}) };
      if (args.dryRun) return jsonContent(await deps.mpLauncher.launchMp(args));
      const acquired = deps.operationCoordinator.tryAcquire(
        'arma_launch_mp',
        operationOwner(deps),
      );
      if (!acquired.acquired) return operationBusy(deps, acquired.busy);
      const combined = combineAbortSignals(
        acquired.lease.signal,
        deps.session.abortController.signal,
        extra?.signal,
      );
      try {
        const res = await deps.mpLauncher.launchMp(args, combined.signal);
        return jsonContent(res);
      } finally {
        combined.dispose();
        acquired.lease.release();
      }
    }),
  );

  server.registerTool(
    'arma_launch_server',
    {
      title: 'Arma 전용 서버 미션 실행',
      description:
        'Arma 클라이언트를 실행하지 않고 데디케이트 서버를 -autoInit/persistent=1 로 시작한다. ' +
        '새 서버 RPT의 부팅 줄("Initializing Steam server - Game Port", "Connected to Steam servers" 중 하나) ' +
        '또는 서버 브리지, 새 DLL 연결 generation, hello/sessionInfo, ' +
        'dedicated 텔레메트리와 활성 mission/world까지 검증한 뒤 성공을 반환한다. ' +
        '나중에 붙는 클라는 서버가 역할을 기본 배정해 로비 없이 들어간다(autoSlot 기본 true). ' +
        '준비 타임아웃에도 서버는 진단을 위해 실행 상태로 둔다.',
      inputSchema: {
        stack: STACK_INPUT,
        mission: z.string().describe('언팩 미션 폴더 절대경로 또는 missionsDir 하위 이름(필수).'),
        modset: z
          .enum(['rpt', 'explicit', 'none'])
          .optional()
          .describe("모드셋 소스(기본 'rpt'). MCP selfModPath는 항상 포함됨."),
        mods: z.array(z.string()).optional().describe("modset='explicit' 일 때 모드 경로 배열."),
        port: z.number().optional().describe('서버 포트(기본 설정값 2302).'),
        password: z.string().optional().describe('서버 비밀번호(기본 설정값).'),
        killRunning: z.boolean().optional().describe('실행 중인 서버/클라를 강제 종료 후 실행.'),
        serverExtraArgs: z.array(z.string()).optional().describe('서버 추가 실행 인자.'),
        dryRun: z.boolean().optional().describe('실행하지 않고 인자·server.cfg·배치 계획만 반환.'),
        serverReadyTimeoutMs: z.number().optional().describe('새 서버 RPT·부팅 대기(ms, 기본 60000).'),
        bridgeReadyTimeoutMs: z
          .number()
          .optional()
          .describe('새 브리지와 전용 서버 텔레메트리 대기(ms, 기본 120000).'),
        autoSlot: AUTO_SLOT_INPUT,
        testMods: TEST_MODS_INPUT,
      },
    },
    onStack(shared, { create: true }, async (deps, args, extra) => {
      if (args.dryRun) return jsonContent(await deps.mpLauncher.launchServer(args));
      const acquired = deps.operationCoordinator.tryAcquire(
        'arma_launch_server',
        operationOwner(deps),
      );
      if (!acquired.acquired) return operationBusy(deps, acquired.busy);
      const combined = combineAbortSignals(
        acquired.lease.signal,
        deps.session.abortController.signal,
        extra?.signal,
      );
      try {
        const res = await deps.mpLauncher.launchServer(args, combined.signal);
        return jsonContent(res);
      } finally {
        combined.dispose();
        acquired.lease.release();
      }
    }),
  );

  server.registerTool(
    'arma_kill',
    {
      title: 'Arma 종료',
      description:
        'stack 의 Arma 프로세스를 강제 종료한다(pid 로 taskkill /F). 다른 스택의 게임은 건드리지 않는다. ' +
        "target: 'all'(기본, 클라+데디 서버) | 'client'(arma3_x64) | 'server'(arma3server_x64). " +
        '종료 뒤 프로세스가 사라질 때까지 최대 waitMs 동안 기다린다. ' +
        'unlockPaths 를 주면 그 파일이나 모드 폴더의 PBO, DLL 이 쓰기 가능해질 때까지도 기다린다. ' +
        '재빌드 전에 쓰면 잠금 대기 루프가 필요 없다. ok 가 false 면 남은 프로세스나 잠긴 경로가 있다.',
      inputSchema: {
        stack: STACK_INPUT,
        target: z
          .enum(['client', 'server', 'all'])
          .optional()
          .describe("종료 대상(기본 'all')."),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe('프로세스 종료와 잠금 해제를 기다리는 상한(ms, 기본 15000). 0 이면 기다리지 않는다.'),
        unlockPaths: z
          .array(z.string())
          .max(32)
          .optional()
          .describe(
            '종료 뒤 쓰기 가능해질 때까지 기다릴 경로. 폴더는 그 안과 addons 안의 *.pbo, *.dll 을 본다.',
          ),
        preempt: z
          .boolean()
          .optional()
          .describe(
            '기본 true 는 실행 중인 launch, play 작업을 끊고 종료한다. ' +
              'false 면 다른 세션의 작업이 실행 중일 때 종료하지 않고 busy 로 주인을 알려 준다.',
          ),
        forget: z
          .boolean()
          .optional()
          .describe(
            'true 면 그 스택의 서버와 클라를 모두 끈 뒤 게임 파이프를 닫고 스택 폴더(profiles, RPT, 테스트 애드온)를 지운다. ' +
              '이름 있는 스택에만 쓴다. 프로세스가 남으면 지우지 않는다.',
          ),
      },
    },
    onStack(shared, {}, async (deps, args, extra) => {
      const forgetting = args.forget === true;
      if (forgetting && (!deps.stack || deps.stack.isDefault)) {
        return jsonContent({ ok: false, error: 'default 스택은 지울 수 없다. forget 은 이름 있는 스택에만 쓴다' });
      }
      // 선점하지 않는 호출은 다른 세션의 작업을 건드리지 않는다.
      // 확인과 선점 사이에 await 가 없으므로 그 사이에 lease 주인이 바뀌지 않는다.
      if (args.preempt === false) {
        const active = deps.operationCoordinator.snapshot();
        if (active && active.owner?.session !== deps.session.shortId) {
          return operationBusy(deps, active);
        }
      }
      const acquired = deps.operationCoordinator.preemptWithKill(
        `arma_kill(target:${args.target ?? 'all'}) interrupted the active launch`,
        operationOwner(deps),
      );
      if (!acquired.acquired) return operationBusy(deps, acquired.busy);
      // 취소되거나 세션이 닫히면 종료와 잠금 해제 대기를 멈추고 lease 를 푼다.
      // 이미 보낸 종료 신호는 되돌리지 않는다.
      const combined = combineAbortSignals(
        acquired.lease.signal,
        deps.session.abortController.signal,
        extra?.signal,
      );
      try {
        // 스택을 지울 때는 서버와 클라를 모두 끈다.
        const res = await deps.mpLauncher.killMp(forgetting ? 'all' : (args.target ?? 'all'), {
          waitMs: args.waitMs,
          unlockPaths: args.unlockPaths,
          signal: combined.signal,
        });
        const killed = killSucceeded(res);
        let forgot: { ok: boolean; error?: string; removed?: string } | undefined;
        if (forgetting) {
          forgot =
            killed && deps.stacks
              ? await deps.stacks.forget(deps.stack?.id)
              : { ok: false, error: '프로세스나 잠긴 경로가 남아 스택을 지우지 않았다' };
        }
        return jsonContent({
          ok: killed && (forgot?.ok ?? true),
          ...(deps.stack ? { stack: deps.stack.id } : {}),
          ...res,
          ...(forgot ? { forgot } : {}),
          interruptedOperation: acquired.interrupted,
        });
      } finally {
        combined.dispose();
        acquired.lease.release();
      }
    }),
  );
}
