// server.ts — McpServer 생성 + 전체 툴 등록.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps, ToolHost } from './deps.js';
import { log } from '../log.js';
import { registerExecTool } from './tools/exec.js';
import { registerWatchTool } from './tools/watch.js';
import { registerMissionTool } from './tools/mission.js';
import { registerStatusTool } from './tools/status.js';
import { registerRptTools } from './tools/rpt.js';
import { registerLaunchTools } from './tools/launch.js';
import { registerScaffoldTool } from './tools/scaffold.js';
import { registerPlayTool } from './tools/play.js';
import { registerWebTools } from './tools/web.js';
import { registerCaptureTool } from './tools/capture.js';
import { registerTacMapTools } from './tools/tacmap.js';
import { registerZeusTools } from './tools/zeus.js';
import { BROADCAST_POLICY_EN } from './broadcastPolicy.js';
import { ARMA_MCP_VERSION } from '../version.js';

export const SERVER_INSTRUCTIONS =
  "Arma-MCP runs Arma 3 stacks; tools take stack (default 'default'). Call arma_status first unless it is fresh. " +
  'Use arma_play/arma_launch* to start a requested runtime, arma_mission_info for state, arma_zeus_find for Zeus names, ' +
  'arma_exec with verify for SQF, arma_watch for waits, arma_rpt_* and arma_capture for evidence. SQF needs an active mission bridge; ' +
  'do not launch or mutate for source-only work. ' +
  BROADCAST_POLICY_EN;

/** 이 빌드가 등록할 수 있는 전체 툴 이름 — disableTools 오타 검증용. */
export const ALL_TOOL_NAMES: readonly string[] = [
  'arma_exec',
  'arma_watch',
  'arma_mission_info',
  'arma_status',
  'arma_rpt_list',
  'arma_rpt_read',
  'arma_rpt_search',
  'arma_rpt_errors',
  'arma_rpt_wait',
  'arma_launch',
  'arma_launch_mp',
  'arma_launch_server',
  'arma_kill',
  'arma_play',
  'arma_scaffold_mission',
  'arma_web_open',
  'arma_web_publish',
  'arma_capture',
  'arma_tacmap_subtitle',
  'arma_tacmap_mark',
  'arma_tacmap_open',
  'arma_zeus_find',
  'arma_zeus_module',
];

/**
 * 비활성 목록에 든 툴은 아예 등록하지 않는다.
 * 모든 툴 스키마는 매 요청 프롬프트에 실리므로, 이 배포에서 안 쓰는 툴을 끄면
 * 컨텍스트가 그만큼 줄어든다. disable() 이 아니라 미등록인 이유는 deps.ts 의 ToolHost 주석 참고.
 */
function gatedHost(server: McpServer, disabled: ReadonlySet<string>): ToolHost {
  if (disabled.size === 0) return server;
  return {
    registerTool: ((name: string, ...rest: unknown[]) =>
      disabled.has(name)
        ? undefined
        : (server.registerTool as unknown as (...a: unknown[]) => unknown)(
            name,
            ...rest,
          )) as ToolHost['registerTool'],
  };
}

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({
    name: 'arma-mcp',
    version: ARMA_MCP_VERSION,
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });

  const disabled = new Set(deps.cfg.mcp.disableTools);
  const unknown = [...disabled].filter((n) => !ALL_TOOL_NAMES.includes(n));
  if (unknown.length > 0) {
    log.warn(`[mcp] disableTools 에 알 수 없는 툴 이름: ${unknown.join(', ')}`);
  }
  if (disabled.has('arma_status')) {
    log.warn('[mcp] arma_status 를 비활성화했습니다 — 브리지 진단 수단이 사라집니다.');
  }
  const host = gatedHost(server, disabled);

  registerExecTool(host, deps);
  registerWatchTool(host, deps);
  registerMissionTool(host, deps);
  registerStatusTool(host, deps);
  registerRptTools(host, deps);
  registerLaunchTools(host, deps);
  registerScaffoldTool(host, deps);
  registerPlayTool(host, deps);
  registerWebTools(host, deps);
  registerCaptureTool(host, deps);
  registerTacMapTools(host, deps);
  registerZeusTools(host, deps);

  return server;
}
