// operationOwner.ts — 실행 lease 의 주인 표시.
//
// 실행 계열 도구는 lease 를 잡을 때 호출한 세션을 주인으로 남기고, 이미 잡혀 있으면
// 같은 모양의 busy 결과를 돌려준다. 기다리는 쪽은 owner 로 누가 잡고 있는지 알고,
// mine 으로 자기 세션의 이전 호출인지 가린다.

import type { OperationOwner, OperationSnapshot } from '../launch/operationCoordinator.js';
import { type Deps, jsonContent } from './deps.js';

export function operationOwner(deps: Pick<Deps, 'session'>): OperationOwner {
  return { session: deps.session.shortId, transport: deps.session.transport };
}

/** lease 를 못 잡았을 때의 결과. 에러 문장은 예전 그대로 두고 busy 에 주인을 싣는다. */
export function operationBusy(
  deps: Pick<Deps, 'session'>,
  busy: OperationSnapshot,
): ReturnType<typeof jsonContent> {
  const mine = busy.owner !== undefined && busy.owner.session === deps.session.shortId;
  return jsonContent({
    ok: false,
    error: 'another launch operation is already in progress',
    busy: mine ? { ...busy, mine: true } : busy,
  });
}
