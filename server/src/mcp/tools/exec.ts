// exec.ts — arma_exec 툴 등록.

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { makeSessionExecContext } from '../execContext.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { withAbortSignals } from '../abort.js';
import { GAME_NOT_CONNECTED, type ExecOutcome } from '../../exec/execManager.js';
import {
  CAPTURE_INPUT,
  captureForTool,
  type CaptureBlock,
  type CaptureIo,
  type CaptureToolArgs,
} from './capture.js';

/** capture 에 delayMs 가 없을 때 실행이 끝난 뒤 찍기 전 대기(ms). */
export const EXEC_CAPTURE_DELAY_MS = 250;
export const CAPTURE_DISABLED_ERROR = 'arma_capture 가 disableTools 로 꺼져 있다';
export const CAPTURE_NOT_CONNECTED_ERROR = '게임이 연결되지 않아 찍지 않았다';
export const CAPTURE_NOT_SENT_ERROR = '코드를 게임에 보내지 않아 찍지 않았다';

/**
 * 실행이 끝난 뒤 화면을 찍어 이미지 블록과 메타를 돌려준다.
 * 캡처가 실패하거나 던져도 exec 결과는 살아야 하므로 여기서는 던지지 않는다.
 */
export async function captureAfterExec(
  deps: Deps,
  outcome: ExecOutcome,
  capture: true | CaptureToolArgs,
  io: CaptureIo = {},
): Promise<{ images: CaptureBlock[]; meta: Record<string, unknown> }> {
  // 운영자가 끈 도구를 exec 옵션으로 우회하지 않는다.
  if (deps.cfg.mcp.disableTools.includes('arma_capture')) {
    return { images: [], meta: { ok: false, error: CAPTURE_DISABLED_ERROR } };
  }
  if (outcome.error === GAME_NOT_CONNECTED) {
    return { images: [], meta: { ok: false, error: CAPTURE_NOT_CONNECTED_ERROR } };
  }
  // reqId 가 비었으면 게임에 보내기 전에 멈춘 실행이다(주석 거부, 크기 초과, 빈 코드 등).
  // 그때 찍은 화면은 코드와 무관한데도 코드의 결과처럼 읽힌다.
  if (outcome.reqId === '') {
    return { images: [], meta: { ok: false, error: CAPTURE_NOT_SENT_ERROR } };
  }
  const opts = capture === true ? {} : capture;
  try {
    const shot = await captureForTool(
      deps,
      { ...opts, delayMs: opts.delayMs ?? EXEC_CAPTURE_DELAY_MS },
      io,
    );
    return { images: shot.content.filter((b) => b.type === 'image'), meta: shot.meta };
  } catch (e) {
    return { images: [], meta: { ok: false, error: '캡처 실패: ' + (e as Error).message } };
  }
}

export function registerExecTool(server: ToolHost, shared: Deps, io: CaptureIo = {}): void {
  server.registerTool(
    'arma_exec',
    {
      title: 'Arma SQF 실행',
      description:
        '라이브 미션에서 SQF 코드를 실행하고 결과를 반환한다. mode=server(기본)/all/client. ' +
        '주석(//, /* */)은 전송 전 자동 제거된다(compile-not-preprocess 파손 방지). ' +
        '결과가 <nil>/ERROR 면 실행 시점 이후 RPT 의 "Error in expression" 블록을 자동 첨부(rptErrors). ' +
        '결과 없이 타임아웃돼도 같은 블록을 첨부한다. ' +
        'capture 를 주면 실행이 끝난 뒤 게임 화면을 찍어 이미지로 함께 돌려준다. ' +
        'arma_capture 를 따로 부르지 않는다. ' +
        '결과 문자열은 "TYPE: value" | "<nil> ..." | "ERROR: ..." (500자 캡). ' +
        'AHC_TacticalMap 이 로드된 런타임(arma_status 의 tacmap)에서 사용자가 자막·전술지도를 ' +
        '요청하면 여기서 직접 구현하지 말고 arma_tacmap_* 툴을 쓴다. 요청이 없었다면 자막·마커를 ' +
        '만들지 않는다 — 작업 보고는 이 툴의 반환값으로 한다.',
      inputSchema: {
        stack: STACK_INPUT,
        code: z.string().describe('실행할 SQF 소스. 마지막 표현식이 성공 증거값이 되게 작성.'),
        mode: z
          .enum(['server', 'all', 'client'])
          .optional()
          .describe("실행 대상. 기본 'server'. 'client'면 target 필수."),
        target: z.string().optional().describe("mode='client' 일 때 대상 플레이어 이름."),
        timeoutMs: z
          .number()
          .optional()
          .describe('결과 대기(ms). 기본 server/client=5000, all=3000. [500,600000] 클램프.'),
        expectN: z
          .number()
          .optional()
          .describe(
            "mode='all' 에서 N개 결과 수집 시 조기 완료. 미지정 시 텔레메트리로 유도 시도, " +
              '실패하면 allQuietMs 정지 창으로 완료.',
          ),
        allQuietMs: z
          .number()
          .optional()
          .describe(
            "mode='all' 에서 마지막 결과 후 이 시간(ms) 무응답이면 조기 완료. " +
              '기본 800, 0=비활성(타임아웃까지 수집). [100,timeoutMs] 클램프.',
          ),
        label: z
          .string()
          .optional()
          .describe('인게임 감사 로그에 남길 라벨(기본 agent, 최대 60자).'),
        comments: z
          .enum(['strip', 'reject'])
          .optional()
          .describe("주석 처리: 'strip'(기본, 제거) 또는 'reject'(발견 시 오류)."),
        checkRpt: z
          .boolean()
          .optional()
          .describe(
            'true 면 성공한 실행에서도 실행 구간 RPT 에러 블록을 스캔한다(기본 false). ' +
              '결과가 <nil>/ERROR 이거나 결과 없이 타임아웃되면 이 값과 무관하게 항상 스캔한다.',
          ),
        verify: z
          .string()
          .optional()
          .describe(
            'code 실행 후 격리 실행할 증거 표현식. 변이 후 확인을 별도 호출로 나누지 말고 여기에 넣는다. ' +
              '여기서 타입 오류가 나도 code 의 결과는 반드시 돌아온다(verify 에만 ERROR 로 보고). ' +
              'code 와 verify 는 별개 스크립트라 지역변수를 공유하지 않는다 — 교차 상태는 ' +
              'missionNamespace setVariable 로 넘긴다. mode=server 에서만 적용된다.',
          ),
        capture: z
          .union([
            z.boolean(),
            z.object({
              ...CAPTURE_INPUT,
              delayMs: CAPTURE_INPUT.delayMs.describe(
                `실행이 끝난 뒤 찍기 전 대기(ms). 기본 ${EXEC_CAPTURE_DELAY_MS}.`,
              ),
            }),
          ])
          .optional()
          .describe(
            '실행이 끝난 뒤 게임 화면을 찍는다. true 면 기본값으로 찍는다. ' +
              '객체면 arma_capture 와 같은 옵션을 쓴다. ' +
              '이미지가 먼저 오고 캡처 메타는 결과 JSON 의 capture 에 담긴다. ' +
              '코드를 게임에 보내지 못했으면 찍지 않는다.',
          ),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) => {
        const outcome = await deps.exec.run({
          code: args.code,
          mode: args.mode,
          target: args.target,
          timeoutMs: args.timeoutMs,
          expectN: args.expectN,
          allQuietMs: args.allQuietMs,
          label: args.label,
          comments: args.comments,
          checkRpt: args.checkRpt,
          verify: args.verify,
          context: makeSessionExecContext(
            deps,
            (cursor) => {
              deps.session.lastExecCursor = cursor;
            },
            signal,
          ),
        });
        if (args.capture === undefined || args.capture === false) return jsonContent(outcome);
        // 취소된 호출의 응답은 버려진다. 화면을 찍을 이유가 없다.
        if (signal.aborted) return jsonContent(outcome);

        const shot = await captureAfterExec(deps, outcome, args.capture, io);
        return {
          content: [...shot.images, ...jsonContent({ ...outcome, capture: shot.meta }).content],
        };
      })),
  );
}
