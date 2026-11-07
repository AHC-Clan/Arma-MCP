// broadcastPolicy.ts — 인게임 방송 툴의 호출 조건을 한 문장으로 고정한다.
//
// 자막·마커·브라우저 열기는 게임 중인 사람 전원에게 보인다. 에이전트는 기본적으로 "작업했으면
// 알린다"는 성향이 있어서, 안내 문구가 조건 없이 툴을 소개하면 지시에 대한 응답을 인게임으로
// 방송해 버린다. 답변 채널은 MCP 툴 결과 하나뿐이라는 것을 모든 표면에서 같은 문장으로 말한다.

/** MCP instructions 용(영문). */
export const BROADCAST_POLICY_EN =
  'Broadcast tools affect players; use them only for explicit visible-output requests, never for reports.';

/** 툴 description·hints 용(국문). */
export const BROADCAST_POLICY_KO =
  '이 툴은 게임 중인 전원에게 보이는 인게임 방송이다. 사용자가 "게임에 띄워라/알려라"라고 명시한 ' +
  '경우에만 호출한다. 지시 확인·진행 보고·작업 완료 알림·질문 답변은 툴 결과 텍스트로만 하고 ' +
  '절대 인게임으로 방송하지 않는다.';
