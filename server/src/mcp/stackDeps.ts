// stackDeps.ts — 도구 입력의 stack 을 그 스택의 의존성 묶음으로 바꾼다.
//
// 도구 본문은 전처럼 deps.gateway, deps.exec, deps.rptSources 를 쓴다. 핸들러 첫머리에서
// 이 함수로 고른 스택의 묶음을 얹은 deps 를 받아 그대로 넘기면 된다. stack 이 없거나
// 'default' 면 받은 deps 를 그대로 돌려주므로 기존 동작과 테스트가 바뀌지 않는다.

import { z } from 'zod';
import type { RptCursor } from '../rpt/rptReader.js';
import { DEFAULT_STACK_ID, validateStackId } from '../stack/stackContext.js';
import type { StackBundle } from '../stack/stackRuntime.js';
import { type Deps, jsonContent } from './deps.js';
import type { SessionContext } from './session.js';

export const STACK_INPUT = z
  .string()
  .optional()
  .describe(
    "테스트 스택 이름(기본 'default'). 스택마다 서버, 클라, 포트, RPT, 게임 연결이 따로다. " +
      '다른 에이전트가 쓰는 게임과 겹치지 않게 하려면 자기 스택 이름을 준다.',
  );

export const TEST_MODS_INPUT = z
  .array(z.string())
  .max(32)
  .optional()
  .describe(
    '새로 빌드한 PBO 파일, addons 가 있는 작은 모드 폴더, 또는 PBO 가 든 addons 폴더. ' +
      '스택 전용 @arma_mcp_test 로 복사해 -mod 맨 뒤에 붙이므로 게임이 원본 빌드 출력을 잠그지 않는다. ' +
      '기본 모드에 같은 PBO(같은 prefix 나 이름)가 있으면 그 모드를 스택 폴더에 하드링크로 다시 엮고 원본 PBO 를 뺀다. ' +
      '큰 기본 모드는 여기에 넣지 않고 mods 나 모드셋으로 그대로 싣는다.',
  );

export const CLIENTS_INPUT = z
  .number()
  .int()
  .min(1)
  .max(16)
  .optional()
  .describe(
    '로컬에서 띄워 서버에 붙일 클라 수(기본 1, 상한 stacks.maxClients). 클라마다 제 profiles, 이름, RPT 폴더를 받고 ' +
      '앞 클라가 서버에 붙은 뒤 다음 클라를 띄운다. 둘 이상이면 서버를 LAN 모드로 열어 이 PC 의 클라만 붙는다.',
  );

export type StackDepsResult =
  | { ok: true; deps: Deps; created: boolean }
  | { ok: false; result: ReturnType<typeof jsonContent> };

/**
 * stack 이름을 deps 로 푼다. create 면 없는 스택을 만든다(실행 계열 도구).
 * 아니면 모르는 스택에 오류로 답한다(exec, 조회 계열 도구).
 */
export async function resolveStackDeps(
  deps: Deps,
  rawStack: string | undefined,
  opts: { create?: boolean } = {},
): Promise<StackDepsResult> {
  const check = validateStackId(rawStack);
  if (!check.ok) return { ok: false, result: jsonContent({ ok: false, error: check.error }) };
  if (check.id === DEFAULT_STACK_ID) return { ok: true, deps, created: false };

  const registry = deps.stacks;
  if (!registry) {
    return {
      ok: false,
      result: jsonContent({ ok: false, error: '이 실행 모드에서는 default 가 아닌 스택을 쓸 수 없다' }),
    };
  }
  const known = registry.get(check.id);
  if (known) return { ok: true, deps: withStack(deps, known), created: false };
  if (!opts.create) {
    return {
      ok: false,
      result: jsonContent({
        ok: false,
        error: `모르는 스택: ${check.id}. 실행 도구(arma_play, arma_launch*)에 stack 을 주면 만들어진다`,
        stacks: registry.list().map((b) => b.ctx.id),
      }),
    };
  }
  const ensured = await registry.ensure(check.id);
  if (!ensured.ok) return { ok: false, result: jsonContent({ ok: false, error: ensured.error }) };
  return { ok: true, deps: withStack(deps, ensured.bundle), created: ensured.created };
}

/**
 * 도구 핸들러를 stack 입력으로 감싼다. 핸들러는 고른 스택의 deps 를 첫 인자로 받는다.
 * create 는 실행 계열 도구만 true 다. 스택을 못 고르면 핸들러를 부르지 않고 오류로 답한다.
 */
export function onStack<A extends { stack?: string }, E, R>(
  shared: Deps,
  opts: { create?: boolean },
  handler: (deps: Deps, args: A, extra: E) => Promise<R>,
): (args: A, extra: E) => Promise<R | ReturnType<typeof jsonContent>> {
  return async (args, extra) => {
    const picked = await resolveStackDeps(shared, args.stack, opts);
    if (!picked.ok) return picked.result;
    return handler(picked.deps, args, extra);
  };
}

/** 스택 묶음을 얹은 deps. 세션은 그 스택 전용 exec 커서를 보는 창으로 바꾼다. */
export function withStack(deps: Deps, bundle: StackBundle): Deps {
  if (bundle.ctx.isDefault) return deps;
  return {
    ...deps,
    cfg: bundle.cfg,
    stack: bundle.ctx,
    rptDir: bundle.rptDir,
    rptSources: bundle.rptSources,
    gateway: bundle.gateway,
    telemetry: bundle.telemetry,
    exec: bundle.exec,
    launcher: bundle.launcher,
    mpLauncher: bundle.mpLauncher,
    playOrchestrator: bundle.playOrchestrator,
    missionMarker: bundle.missionMarker,
    operationCoordinator: bundle.operationCoordinator,
    procs: bundle.procs,
    session: sessionForStack(deps.session, bundle.ctx.id),
  };
}

const stackCursors = new WeakMap<SessionContext, Map<string, RptCursor | null>>();

/**
 * 세션의 lastExecCursor 를 스택별로 나눈다. 스택 a 의 exec 커서가 스택 b 의
 * arma_rpt_errors(since:'lastExec') 에 쓰이지 않게 하기 위해서다. 나머지 필드는 원래 세션이다.
 */
function sessionForStack(session: SessionContext, id: string): SessionContext {
  let cursors = stackCursors.get(session);
  if (!cursors) {
    cursors = new Map();
    stackCursors.set(session, cursors);
  }
  const map = cursors;
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === 'lastExecCursor') return map.get(id) ?? null;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === 'lastExecCursor') {
        map.set(id, (value as RptCursor | null) ?? null);
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });
}
