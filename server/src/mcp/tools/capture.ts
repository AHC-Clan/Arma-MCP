// capture.ts — arma_capture 툴 등록.
//
// 게임 브리지(exec)를 타지 않는 서버 측 캡처 — 메인메뉴/로딩/에디터 등 DLL 미접속
// 상태에서도 동작한다. 에이전트가 반환된 이미지를 직접 보고 UI/씬 상태를 검증하는 용도.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent, imageContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { resolveCaptureDir } from '../../config.js';
import { CLIENT_IMAGE, SERVER_IMAGE, isProcRunningAsync } from '../../procs.js';
import { captureWindow, pruneCaptures, type HelperRunner } from '../../capture/capture.js';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** arma_capture 입력 필드. arma_exec 의 capture 옵션도 같은 정의를 쓴다. */
export const CAPTURE_INPUT = {
  target: z
    .enum(['client', 'server'])
    .optional()
    .describe("캡처할 프로세스. 기본 'client'(arma3_x64). 'server'=데디 서버 콘솔 창."),
  client: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe("target='client' 일 때 클라 순번(기본 1). 한 스택에 클라를 여럿 띄웠을 때 고른다."),
  scope: z
    .enum(['window', 'screen'])
    .optional()
    .describe("기본 'window'(게임 창만). 'screen'=주 모니터 전체(다이얼로그 등)."),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('캡처 전 대기(ms). 씬 전환/UI 표시를 기다릴 때. 기본 0.'),
  format: z.enum(['jpeg', 'png']).optional().describe("기본 'jpeg'(작음). 'png'=무손실."),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('jpeg 품질. 기본 80.'),
  maxWidth: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe('이 폭 초과 시 다운스케일. 기본 1568(비전 토큰 최적).'),
  returnImage: z
    .boolean()
    .optional()
    .describe('기본 true(이미지 인라인 반환). false=파일 경로 메타만(연속 캡처/아카이빙용).'),
};

export interface CaptureToolArgs {
  target?: 'client' | 'server';
  client?: number;
  scope?: 'window' | 'screen';
  delayMs?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
  maxWidth?: number;
  returnImage?: boolean;
}

/** 테스트 주입용. 비우면 실제 헬퍼와 프로세스 확인을 쓴다. */
export interface CaptureIo {
  runner?: HelperRunner;
  isRunning?: (image: string, force?: boolean) => Promise<boolean>;
}

export type CaptureBlock =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'text'; text: string };

export interface CaptureToolResult {
  /** arma_capture 가 그대로 돌려주는 블록. 이미지가 있으면 앞에 온다. */
  content: CaptureBlock[];
  /** 텍스트 블록에 담긴 메타. 실패하면 ok 가 false 이고 error 가 있다. */
  meta: Record<string, unknown>;
}

function metaOnly(meta: Record<string, unknown>): CaptureToolResult {
  return { ...jsonContent(meta), meta };
}

/** arma_capture 본문. arma_exec 의 capture 옵션도 이 함수로 찍는다. */
export async function captureForTool(
  deps: Pick<Deps, 'cfg'> & Partial<Pick<Deps, 'procs' | 'stack'>>,
  args: CaptureToolArgs,
  io: CaptureIo = {},
): Promise<CaptureToolResult> {
  const isRunning = io.isRunning ?? isProcRunningAsync;
  const target = args.target ?? 'client';
  let image = target === 'server' ? SERVER_IMAGE : CLIENT_IMAGE;
  const scope = args.scope ?? 'window';
  const clientIndex = args.client ?? 1;
  let pid: number | undefined;

  if (scope === 'window') {
    // 스택 프로세스 목록이 있으면 그 스택의 그 프로세스 창만 찍는다.
    // 같은 이미지가 여럿 떠 있을 때 이미지명으로 찾으면 아무 창이나 잡힌다.
    const procs = deps.procs ? await deps.procs.list(true) : null;
    if (procs) {
      const pick =
        target === 'server'
          ? procs.find((p) => p.role === 'server')
          : procs.find((p) => p.role === 'client' && p.index === clientIndex);
      if (!pick) {
        const stackName = deps.stack?.id ?? 'default';
        const which = target === 'server' ? '서버' : `클라 ${clientIndex}`;
        return metaOnly({
          ok: false,
          error: `스택 ${stackName} 의 ${which} 가 실행 중이 아니다. arma_status 의 stacks 로 떠 있는 프로세스를 확인`,
        });
      }
      pid = pick.pid;
      image = pick.image;
    } else if (!(await isRunning(image)) && !(await isRunning(image, true))) {
      // PS 스폰(1~2s) 전에 즉답. TTL 캐시 양성이면 그대로 믿고(방금 죽었어도
      // captureWindow 실패로 수렴), 음성일 때만 force 재확인으로 오탐을 막는다.
      return metaOnly({
        ok: false,
        error: `${image} not running — arma_launch 로 게임을 먼저 실행`,
      });
    }
  }

  const dir = resolveCaptureDir(deps.cfg);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return metaOnly({ ok: false, error: 'capture dir 생성 실패: ' + (e as Error).message });
  }

  const format = args.format ?? 'jpeg';
  const rand = Math.random().toString(36).slice(2, 6);
  const outFile = path.join(dir, `capture_${stamp()}_${rand}.${format === 'png' ? 'png' : 'jpg'}`);

  const res = await captureWindow(
    {
      processImage: image,
      scope,
      delayMs: args.delayMs ?? 0,
      format,
      quality: args.quality ?? 80,
      maxWidth: args.maxWidth ?? 1568,
      outFile,
      pid,
    },
    io.runner,
  );
  if (!res.ok) return metaOnly({ ...res });

  const pruned = await pruneCaptures(dir, deps.cfg.capture.keepMax);
  const meta = {
    ok: true,
    file: res.file,
    method: res.method,
    windowRect: res.windowRect,
    imageW: res.imageW,
    imageH: res.imageH,
    bytes: res.bytes,
    elapsedMs: res.elapsedMs,
    note: res.note,
    pruned: pruned > 0 ? pruned : undefined,
  };
  if (args.returnImage === false) return metaOnly(meta);

  let base64: string;
  try {
    base64 = (await readFile(res.file)).toString('base64');
  } catch (e) {
    return metaOnly({ ok: false, error: '캡처 파일 읽기 실패: ' + (e as Error).message });
  }
  return { ...imageContent(base64, format === 'png' ? 'image/png' : 'image/jpeg', meta), meta };
}

export function registerCaptureTool(server: ToolHost, shared: Deps, io: CaptureIo = {}): void {
  server.registerTool(
    'arma_capture',
    {
      title: '게임 화면 캡처',
      description:
        'Arma 창을 스크린샷으로 찍어 이미지로 반환한다. 게임 브리지(exec)와 무관하게 동작하므로 ' +
        '메인메뉴/로딩/에디터 등 어떤 상태에서든 캡처 가능 — UI 표시·씬 상태를 에이전트가 직접 ' +
        "눈으로 검증하는 용도. scope='screen' 은 주 모니터 전체를 찍는다(크래시 다이얼로그·런처 등 " +
        '게임 창 밖 확인용). 메타의 method 가 screen 이면 화면 그대로를 찍은 것이라 게임 창이 ' +
        '다른 창에 가려져 있으면 그 내용이 나온다.',
      inputSchema: { stack: STACK_INPUT, ...CAPTURE_INPUT },
    },
    onStack(shared, {}, async (deps, args) => {
      const { content } = await captureForTool(deps, args, io);
      return { content };
    }),
  );
}
