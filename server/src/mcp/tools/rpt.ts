// rpt.ts — arma_rpt_* 툴 5개 등록.
//
// source='server' 면 데디 서버 RPT(-profiles 폴더, arma3server_x64_*.rpt)를 조회한다.

import { z } from 'zod';
import path from 'node:path';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { listRptFiles, newestRpt } from '../../rpt/rptFiles.js';
import {
  readRpt,
  searchRpt,
  extractErrorBlocks,
  waitForPattern,
  generalErrorRegex,
  type RptCursor,
} from '../../rpt/rptReader.js';
import type { RptScope } from '../../rpt/rptSource.js';
import { withAbortSignals } from '../abort.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';

export const FROM_OFFSET_NEEDS_FILE =
  'fromOffset 은 file 에 파일명이나 절대경로를 함께 줘야 한다. ' +
  "'newest' 와 'next' 는 가리키는 파일이 바뀔 수 있어 쓸 수 없다.";

/** 오프셋이 뜻을 가지려면 파일이 하나로 정해져 있어야 한다. */
function isConcreteRptFile(file: string | undefined): boolean {
  return file !== undefined && file !== '' && file !== 'newest' && file !== 'next';
}

const sourceSchema = z
  .enum(['auto', 'client', 'server'])
  .optional()
  .describe(
    "RPT 소스. 'auto'(기본)는 라이브 dedicated 세션이면 server, 그 외에는 client. " +
      "'server' = 데디 서버 RPT(-profiles 폴더).",
  );

const clientSchema = z
  .number()
  .int()
  .min(1)
  .max(16)
  .optional()
  .describe('client 소스의 클라 순번(기본 1). 한 스택에 클라를 여럿 띄웠을 때 고른다. 클라마다 RPT 폴더가 따로다.');

function cursorMatchesScope(cursor: RptCursor | null, scope: RptScope): cursor is RptCursor {
  if (!cursor) return false;
  const cursorDir = path.resolve(path.dirname(cursor.file)).toLowerCase();
  const scopeDir = path.resolve(scope.dir).toLowerCase();
  return cursorDir === scopeDir && scope.re.test(path.basename(cursor.file));
}

export function registerRptTools(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_rpt_list',
    {
      title: 'RPT 파일 목록',
      description: 'RPT 로그 파일 목록(이름/경로/크기/수정시각). 최신 = 파일명 정렬 최대.',
      inputSchema: {
        stack: STACK_INPUT,
        limit: z.number().optional().describe('반환 개수 상한(최신부터).'),
        source: sourceSchema,
        client: clientSchema,
      },
    },
    onStack(shared, {}, async (deps, args) => {
      const scope = deps.rptSources.resolve(args.source, args.client);
      const files = listRptFiles(scope.dir, scope.re);
      // listRptFiles 는 이름 오름차순 정렬 — 마지막 원소가 곧 최신(재스캔 불필요).
      const newest = files.length ? files[files.length - 1]! : null;
      const limit = args.limit ?? files.length;
      const sliced = files.slice(-limit).reverse();
      return jsonContent({
        resolvedSource: scope.source,
        rptDir: scope.dir,
        count: files.length,
        files: sliced.map((f) => ({
          name: f.name,
          path: f.path,
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
          isNewest: newest ? f.name === newest.name : false,
        })),
      });
    }),
  );

  server.registerTool(
    'arma_rpt_read',
    {
      title: 'RPT 읽기',
      description:
        'RPT 내용을 tail 또는 오프셋 커서 기반으로 읽는다. endOffset 을 fromOffset 으로 재전달하면 이후 증분만 폴링 가능.',
      inputSchema: {
        stack: STACK_INPUT,
        file: z.string().optional().describe("'newest'(기본) | 파일명 | 절대경로."),
        tailLines: z.number().optional().describe('fromOffset 미지정 시 마지막 N줄(기본 80).'),
        fromOffset: z.number().optional().describe('바이트 오프셋부터 읽기.'),
        maxBytes: z.number().optional().describe('최대 읽기 바이트(기본 65536).'),
        source: sourceSchema,
        client: clientSchema,
      },
    },
    onStack(shared, {}, async (deps, args) => {
      const scope = deps.rptSources.resolve(args.source, args.client);
      const res = await readRpt(scope.dir, {
        file: args.file,
        tailLines: args.tailLines ?? (args.fromOffset === undefined ? 80 : undefined),
        fromOffset: args.fromOffset,
        maxBytes: args.maxBytes,
        rptRe: scope.re,
      });
      if (!res) {
        return jsonContent({
          ok: false,
          error: 'RPT 파일을 찾지 못함',
          resolvedSource: scope.source,
        });
      }
      return jsonContent({ ok: true, resolvedSource: scope.source, ...res });
    }),
  );

  server.registerTool(
    'arma_rpt_search',
    {
      title: 'RPT 정규식 검색',
      description: 'RPT 를 정규식으로 검색(라인 스트리밍, 대용량 안전). 컨텍스트 라인 포함.',
      inputSchema: {
        stack: STACK_INPUT,
        pattern: z.string().describe('정규식 패턴.'),
        file: z.string().optional().describe("'newest'(기본) | 파일명 | 절대경로."),
        fromOffset: z.number().optional().describe('시작 바이트 오프셋.'),
        maxMatches: z.number().optional().describe('최대 매치 수(기본 50).'),
        contextLines: z.number().optional().describe('매치 전후 컨텍스트 줄(기본 2).'),
        caseSensitive: z.boolean().optional().describe('대소문자 구분(기본 false).'),
        source: sourceSchema,
        client: clientSchema,
      },
    },
    onStack(shared, {}, async (deps, args) => {
      const scope = deps.rptSources.resolve(args.source, args.client);
      const res = await searchRpt(scope.dir, { ...args, rptRe: scope.re });
      if (!res) {
        return jsonContent({
          ok: false,
          error: 'RPT 파일을 찾지 못함',
          resolvedSource: scope.source,
        });
      }
      return jsonContent({ ok: true, resolvedSource: scope.source, ...res });
    }),
  );

  server.registerTool(
    'arma_rpt_errors',
    {
      title: 'RPT 오류 블록',
      description:
        'SQF 오류 블록("Error in expression" + 후속 Error position/File 줄)을 그룹핑해 반환. ' +
        "since='lastExec'(기본, 이 MCP 세션의 마지막 exec 시점 이후) | 'missionStart' | 'fileStart'. " +
        '선택한 RPT 소스와 커서 파일이 다르면 해당 소스의 fileStart 로 안전하게 대체.',
      inputSchema: {
        stack: STACK_INPUT,
        since: z
          .enum(['lastExec', 'missionStart', 'fileStart'])
          .optional()
          .describe('스캔 시작 기준(기본 lastExec, server 소스는 fileStart).'),
        file: z.string().optional().describe("파일 지정(기본: 기준에 맞는 RPT)."),
        fromOffset: z.number().optional().describe('명시 오프셋(since 무시).'),
        source: sourceSchema,
        client: clientSchema,
      },
    },
    onStack(shared, {}, async (deps, args) => {
      const scope = deps.rptSources.resolve(args.source, args.client);
      const since = args.since ?? 'lastExec';
      let filePath: string | undefined;
      let offset = 0;
      let cursorFallback: 'fileStart' | undefined;

      if (typeof args.fromOffset === 'number') {
        offset = args.fromOffset;
        const newest = newestRpt(scope.dir, scope.re);
        filePath = args.file ?? newest?.path;
      } else if (since === 'lastExec') {
        const cur = deps.session.lastExecCursor;
        if (cursorMatchesScope(cur, scope)) {
          filePath = cur.file;
          offset = cur.offset;
        } else {
          const newest = newestRpt(scope.dir, scope.re);
          filePath = newest?.path;
          offset = 0;
          cursorFallback = 'fileStart';
        }
      } else if (since === 'missionStart') {
        const cur = deps.missionMarker.cursor();
        const newest = newestRpt(scope.dir, scope.re);
        if (cursorMatchesScope(cur, scope)) {
          filePath = cur.file;
          offset = cur.offset;
        } else {
          filePath = newest?.path;
          offset = 0;
          cursorFallback = 'fileStart';
        }
      } else {
        const newest = newestRpt(scope.dir, scope.re);
        filePath = newest?.path;
        offset = 0;
      }

      if (!filePath) {
        return jsonContent({
          ok: false,
          error: 'RPT 파일을 찾지 못함',
          resolvedSource: scope.source,
        });
      }
      const ext = await extractErrorBlocks(filePath, offset);
      return jsonContent({
        ok: true,
        resolvedSource: scope.source,
        since,
        cursorFallback,
        file: filePath,
        sinceOffset: offset,
        count: ext.errors.length,
        errors: ext.errors,
        scannedToOffset: ext.scannedToOffset,
        pattern: generalErrorRegex().source,
      });
    }),
  );

  server.registerTool(
    'arma_rpt_wait',
    {
      title: 'RPT 패턴 대기',
      description:
        '패턴이 RPT 에 나타날 때까지 폴링 대기(기본 250ms 간격). ' +
        'fromEnd 미지정 시 마지막 64KB 를 먼저 프리스캔해 이미 기록된 패턴이면 즉시 반환한다' +
        '(preExisting:true) — 새 출력만 기다리려면 fromEnd:true 를 명시. ' +
        "file='next' 면 현재 최신보다 뒤 이름의 새 RPT 가 생길 때까지 먼저 기다린 뒤 스캔(런치 직후 init 마커 대기용). " +
        'arma_exec 결과의 rptCursor 를 file 과 fromOffset 으로 넘기면 그 실행 뒤 출력에서 찾는다.',
      inputSchema: {
        stack: STACK_INPUT,
        pattern: z.string().describe('대기할 정규식 패턴.'),
        file: z
          .string()
          .optional()
          .describe("'newest'(기본) | 'next' | 파일명 | 절대경로."),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(600000)
          .optional()
          .describe('타임아웃(기본 30000, 최대 600000).'),
        fromEnd: z
          .boolean()
          .optional()
          .describe('true(기본)면 현재 EOF 부터 감시. 미지정 시에만 tail 프리스캔 즉답이 동작.'),
        fromOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            '이 바이트 위치부터 감시한다. file 에 파일명이나 절대경로를 함께 준다. ' +
              '이미 기록된 줄도 이 위치 뒤면 찾는다. fromEnd 는 무시한다.',
          ),
        source: sourceSchema,
        client: clientSchema,
      },
    },
    onStack(shared, {}, async (deps, args, extra) => {
      const scope = deps.rptSources.resolve(args.source, args.client);
      if (args.fromOffset !== undefined && !isConcreteRptFile(args.file)) {
        return jsonContent({
          found: false,
          file: '',
          elapsedMs: 0,
          error: FROM_OFFSET_NEEDS_FILE,
          resolvedSource: scope.source,
        });
      }
      const res = await withAbortSignals(
        [deps.session.abortController.signal, extra?.signal],
        (signal) => waitForPattern(scope.dir, { ...args, rptRe: scope.re, signal }),
      );
      return jsonContent({ ...res, resolvedSource: scope.source });
    }),
  );
}
