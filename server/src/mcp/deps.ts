// deps.ts — 툴들이 공유하는 의존성 묶음 + 출력 헬퍼.

import type { Config } from '../config.js';
import type { Gateway } from '../ipc/gateway.js';
import type { TelemetryStore } from '../game/telemetry.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ExecManager } from '../exec/execManager.js';

/**
 * 툴 등록에 필요한 최소 표면. 등록 함수들이 McpServer 대신 이걸 받으면
 * buildMcpServer 가 중간에서 필터링해 특정 툴을 아예 등록하지 않을 수 있다.
 * RegisteredTool.disable() 이 아니라 미등록을 쓰는 이유: disable 은
 * notifications/tools/list_changed 를 발생시키는데 이 데몬엔 그 채널이 없다.
 */
export interface ToolHost {
  registerTool: McpServer['registerTool'];
}
import type { Launcher } from '../launch/launcher.js';
import type { MpLauncher } from '../launch/mpLauncher.js';
import type { PlayOrchestrator } from '../launch/playOrchestrator.js';
import type { RptCursor } from '../rpt/rptReader.js';
import type { WebServer } from '../web/webServer.js';
import type { OperationCoordinator } from '../launch/operationCoordinator.js';
import type { SessionContext, SessionsView } from './session.js';
import type { RptSourceResolver } from '../rpt/rptSource.js';
import type { StackContext } from '../stack/stackContext.js';
import type { StackRegistry } from '../stack/stackRegistry.js';
import type { ScopedProcs } from '../stack/processScope.js';

export interface MissionMarker {
  /** 현재 미션 접속 시점의 RPT 커서(없으면 null). */
  cursor(): RptCursor | null;
}

export interface SharedDeps {
  cfg: Config;
  /** exePath 출처. 설정이 없으면 런타임이 Steam 에서 찾았는지 알려준다. */
  armaPathSource?: 'config' | 'steam-auto' | 'none';
  selfModSource?: 'config' | 'game-report' | 'none';
  /** Legacy client RPT directory; prefer rptSources in new code. */
  rptDir: string;
  rptSources: RptSourceResolver;
  gateway: Gateway;
  telemetry: TelemetryStore;
  exec: ExecManager;
  launcher: Launcher;
  mpLauncher: MpLauncher;
  playOrchestrator: PlayOrchestrator;
  missionMarker: MissionMarker;
  web: WebServer;
  serverStartMs: number;
  sessions: SessionsView;
  operationCoordinator: OperationCoordinator;
  /**
   * 이 deps 가 가리키는 스택. 위의 게임 쪽 필드(rptDir 부터 operationCoordinator 까지)가
   * 이 스택의 것이다. 없으면 default 스택이다.
   */
  stack?: StackContext;
  /** 이 스택의 Arma 프로세스만 보는 조회와 종료. 없으면 이미지 이름 방식이다. */
  procs?: ScopedProcs;
  /** 데몬이 아는 모든 스택. 도구는 mcp/stackDeps.ts 의 resolveStackDeps 로 고른다. */
  stacks?: StackRegistry;
}

export interface Deps extends SharedDeps {
  session: SessionContext;
}

export function withSession(shared: SharedDeps, session: SessionContext): Deps {
  return { ...shared, session };
}

/** 객체를 MCP text content 로 감싼다(구조화 출력은 v1 미사용, JSON 문자열 1개).
 * compact 직렬화 — 응답은 사람이 아니라 MCP 클라이언트(모델)가 읽으므로 들여쓰기는
 * 토큰 낭비다. 디버깅용 pretty 출력은 ARMA_MCP_PRETTY_JSON=1 로 켠다. */
const PRETTY = process.env.ARMA_MCP_PRETTY_JSON === '1' ? 2 : undefined;

export function jsonContent(obj: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, PRETTY) }] };
}

/** base64 이미지 + 메타 JSON 텍스트를 MCP content 로 감싼다(이미지 먼저, 메타 뒤). */
export function imageContent(
  base64: string,
  mimeType: 'image/jpeg' | 'image/png',
  meta: unknown,
): {
  content: (
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'text'; text: string }
  )[];
} {
  return {
    content: [
      { type: 'image', data: base64, mimeType },
      { type: 'text', text: JSON.stringify(meta, null, PRETTY) },
    ],
  };
}
