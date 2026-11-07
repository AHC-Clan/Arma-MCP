// mission.ts — arma_mission_info 툴 등록.

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';

export function registerMissionTool(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_mission_info',
    {
      title: 'Arma 미션 정보',
      description:
        '진행 중 미션 정보(world, mission, briefing, players, time, fps, fpsMin, scripts, paused, focused)를 반환한다. ' +
        '기본은 서버가 캐시한 최근 텔레메트리(즉답, 프레임 프리즈에도 강건). ' +
        'fresh=true 면 게임에 즉시 갱신을 요청해 라운드트립 후 반환. 미접속 시 lastKnown 반환.',
      inputSchema: {
        stack: STACK_INPUT,
        fresh: z
          .boolean()
          .optional()
          .describe('true 면 telemetryRequest 를 보내 최신값을 받아온 뒤 반환.'),
      },
    },
    onStack(shared, {}, async (deps, args) => {
      const connected = deps.gateway.isConnected();
      if (args.fresh && connected) {
        deps.gateway.send({ v: 1, type: 'telemetryRequest', reqId: '' });
        // push 도착 즉시 반환(상한 1200ms — 프레임 프리즈 대비).
        await deps.telemetry.waitForTelemetry(1200);
      }
      const snap = deps.telemetry.current();
      if (!connected) {
        const last = deps.telemetry.lastKnownSnapshot();
        return jsonContent({
          connected: false,
          lastKnown: last,
          disconnectedAtMs: deps.telemetry.disconnectedAtMs(),
        });
      }
      return jsonContent({
        connected: true,
        world: snap.world,
        mission: snap.mission,
        briefing: snap.briefing,
        dedicated: snap.dedicated,
        multiplayer: snap.multiplayer,
        cba: deps.telemetry.cba(),
        ace: deps.telemetry.ace(),
        aceVersion: deps.telemetry.aceVersion() || null,
        aceComponents: deps.telemetry.aceComponents(),
        tacmap: deps.telemetry.tacmap(),
        tacmapZeusTool: deps.telemetry.tacmapZeusTool(),
        missionTime: snap.missionTime,
        date: snap.date,
        fps: snap.fps,
        fpsMin: snap.fpsMin,
        scripts: snap.scripts,
        // 창이 있는 쪽(SP, 플레이어가 연 서버)만 보낸다. 데디 서버는 null.
        paused: snap.paused,
        focused: snap.focused,
        players: snap.players,
        playerCount: snap.playerCount,
        cacheAgeMs: deps.telemetry.cacheAgeMs(),
      });
    }),
  );
}
