// scaffold.ts — arma_scaffold_mission 툴 등록.
//
// 최소 테스트 미션(빈 씬 또는 initSqf 로 셋업된 씬)을 즉석에서 만들고, 기본으로 바로 실행한다.
// 로드는 기존 Launcher.launch({mission}) 재사용(-autotest cfg).

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { scaffoldMission, defaultScaffoldDir } from '../../launch/scaffold.js';
import { combineAbortSignals } from '../abort.js';
import { operationBusy, operationOwner } from '../operationOwner.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';

export function registerScaffoldTool(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_scaffold_mission',
    {
      title: 'Arma 테스트 미션 생성·실행',
      description:
        '최소 테스트 미션(빈 씬 또는 initSqf 로 셋업된 씬)을 즉석에서 생성하고, 기본으로 바로 실행한다. ' +
        '월드는 폴더 확장자로 결정되며 자유롭게 지정(예: VR, Altis, Stratis, Malden, Tanoa, Enoch(Livonia), 모드 맵). ' +
        'VR 은 편의 기본값일 뿐 강제가 아니다. launch=true(기본)면 스캐폴드 후 arma_launch 로 로드해 결과를 첨부한다. ' +
        'position 은 SQF getPos 순서 [동, 북, 높이] 이고, safeSpawn 이 미션 시작 시 바다와 공중 스폰을 보정한다.',
      inputSchema: {
        stack: STACK_INPUT,
        world: z
          .string()
          .optional()
          .describe('terrain 클래스명(폴더 확장자). 기본 VR. 어떤 terrain 도 허용.'),
        name: z.string().optional().describe('미션/폴더 기본명(기본 mcp_test). 안전한 이름으로 정규화됨.'),
        playerType: z.string().optional().describe('플레이어 유닛 클래스(기본 B_Soldier_F).'),
        position: z
          .array(z.number())
          .min(2)
          .max(3)
          .optional()
          .describe(
            '플레이어 위치 [동, 북, 높이]. SQF getPos 와 같은 순서다(mission.sqm 의 ' +
              '[동, 고도, 북] 이 아니다 — 생성기가 변환한다). 높이를 생략하거나 0 이면 지면이다. ' +
              '미지정 시 safeSpawn 이 맵 중앙 근처 육지를 찾는다.',
          ),
        safeSpawn: z
          .enum(['off', 'ground', 'land'])
          .optional()
          .describe(
            "바다와 공중 스폰 보정. 'land'(기본)는 물 위면 가까운 육지로 옮기고 지면에 놓는다. " +
              "'ground' 는 수직만 보정하고 가로 좌표를 유지한다. 'off' 는 보정하지 않는다. " +
              '켜져 있으면 최종 고도는 항상 지면이다 — 공중 시작을 원하면 off 를 쓴다.',
          ),
        initSqf: z.string().optional().describe('init.sqf 내용(엔진이 preprocess — 주석 OK).'),
        launch: z.boolean().optional().describe('true(기본)면 생성 후 바로 실행.'),
        killRunning: z.boolean().optional().describe('실행 시 이미 켜져 있으면 강제 종료 후 실행.'),
        waitForNewRptMs: z.number().optional().describe('실행 시 새 RPT 대기(ms, 기본 30000).'),
        dryRun: z.boolean().optional().describe('실행 인자만 확인(게임 미실행).'),
        overwrite: z.boolean().optional().describe('기존 미션 폴더 덮어쓰기(기본 true).'),
      },
    },
    onStack(shared, { create: true }, async (deps, args, extra) => {
      const doLaunch = args.launch ?? true;
      const run = async (signal?: AbortSignal): Promise<ReturnType<typeof jsonContent>> => {
        let result;
        try {
          result = scaffoldMission({
            world: args.world,
            name: args.name,
            playerType: args.playerType,
            position: args.position,
            safeSpawn: args.safeSpawn,
            initSqf: args.initSqf,
            // 이름 있는 스택은 제 폴더에 만든다. 다른 스택이 돌리는 미션 폴더를 덮지 않는다.
            targetDir:
              deps.stack?.scaffoldDir ?? defaultScaffoldDir(deps.cfg.arma.missionsDir || undefined),
            overwrite: args.overwrite,
          });
        } catch (e) {
          return jsonContent({ ok: false, error: (e as Error).message });
        }

        if (!doLaunch) {
          return jsonContent({
            ok: true,
            missionPath: result.missionPath,
            world: result.world,
            name: result.name,
            files: result.files,
            safeSpawn: result.safeSpawn,
            position: result.position,
            warnings: result.warnings,
            note: 'launch=false — 생성만 함. arma_launch { mission: missionPath } 로 실행 가능.',
          });
        }

        const launch = await deps.launcher.launch({
          mission: result.missionPath,
          modset: 'rpt',
          killRunning: args.killRunning,
          waitForNewRptMs: args.waitForNewRptMs,
          dryRun: args.dryRun,
          signal,
        });

        return jsonContent({
          ok: launch.ok,
          missionPath: result.missionPath,
          world: result.world,
          name: result.name,
          files: result.files,
          safeSpawn: result.safeSpawn,
          position: result.position,
          warnings: result.warnings,
          launch,
        });
      };

      // 미션 폴더 생성/교체도 공유 파일시스템 변경이다. launch 여부와 관계없이
      // 같은 전역 lease 안에서 직렬화해야 다른 세션이 launch 직전 내용을 덮지 않는다.
      const acquired = deps.operationCoordinator.tryAcquire(
        'arma_scaffold_mission',
        operationOwner(deps),
      );
      if (!acquired.acquired) return operationBusy(deps, acquired.busy);
      const combined = combineAbortSignals(
        acquired.lease.signal,
        deps.session.abortController.signal,
        extra?.signal,
      );
      try {
        return await run(combined.signal);
      } finally {
        combined.dispose();
        acquired.lease.release();
      }
    }),
  );
}
