// web.ts — arma_web_publish / arma_web_open 툴 등록.
//
// 오픈 전파는 기존 exec 인프라를 그대로 탄다: 서버가 검증·조립한 URL 을
// `[...] call AHC_ArmaMCP_fnc_openUrl` exec 페이로드로 보내면 각 머신의
// fn_openUrl 이 callExtension "openUrl" 로 기본 브라우저를 연다.
// 와이어 프로토콜 변경도, 새 remoteExec 대상 함수도 없다.

import { z } from 'zod';
import { BROADCAST_POLICY_KO } from '../broadcastPolicy.js';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { makeSessionExecContext } from '../execContext.js';
import { sqfString } from '../sqfLiteral.js';

interface OpenedSummary {
  execOk: boolean;
  completedBy?: string;
  durationMs: number;
  /** fn_openUrl 이 true 를 반환한 머신(브라우저를 연 머신). */
  machines: string[];
  /** 응답했지만 열지 않은 머신(데디 서버 등 hasInterface=false, 스킴 거부). */
  skipped: string[];
}

export async function openOnMachines(
  deps: Deps,
  url: string,
  mode: 'all' | 'client',
  target?: string,
): Promise<OpenedSummary> {
  const outcome = await deps.exec.run({
    code: `[${sqfString(url)}] call AHC_ArmaMCP_fnc_openUrl`,
    mode,
    target,
    label: 'web-open',
    timeoutMs: 3000,
    checkRpt: false,
    context: makeSessionExecContext(deps),
  });
  const machines: string[] = [];
  const skipped: string[] = [];
  for (const r of outcome.results) {
    (r.parsed.value === 'true' ? machines : skipped).push(r.machine);
  }
  return {
    execOk: outcome.ok,
    completedBy: outcome.completedBy,
    durationMs: outcome.durationMs,
    machines,
    skipped,
  };
}

export function registerWebTools(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_web_publish',
    {
      title: '웹 페이지 게시(전 인원 브라우저)',
      description:
        'HTML 을 LAN 웹 서버에 게시한다. 접속 중인 브라우저는 SSE 로 즉시 자동 갱신(리로드 ' +
        '스크립트는 서빙 시 자동 주입). open 정책에 따라 게임 내 전파로 모든 플레이어의 기본 ' +
        '브라우저를 자동으로 연다(@arma_mcp 모드 설치 클라이언트만). 반환된 url 을 플레이어에게 ' +
        '수동 안내할 수도 있다.',
      inputSchema: {
        stack: STACK_INPUT,
        html: z
          .string()
          .describe('완전한 HTML 문서(4 MiB 캡). 리로드 스크립트는 서빙 시 자동 주입되므로 불필요.'),
        page: z
          .string()
          .optional()
          .describe("페이지 슬러그(^[a-z0-9][a-z0-9_-]{0,63}$). 기본 'index' → 루트 URL."),
        open: z
          .enum(['auto', 'always', 'never'])
          .optional()
          .describe(
            "브라우저 자동 오픈 정책. 'auto'(기본)=이 슬러그 첫 게시일 때만 전 클라 오픈" +
              "(재게시는 SSE 리로드가 처리해 중복 팝업 없음), 'always'=매번, 'never'=안 염.",
          ),
      },
    },
    onStack(shared, {}, async (deps, args) => {
      let pub;
      try {
        pub = deps.web.publish(args.page ?? 'index', args.html);
      } catch (e) {
        return jsonContent({ ok: false, error: (e as Error).message });
      }

      const notes: string[] = [];
      const baseNote = deps.web.pageUrl(args.page ?? 'index').note;
      if (baseNote) notes.push(baseNote);

      const policy = args.open ?? 'auto';
      const shouldOpen = policy === 'always' || (policy === 'auto' && pub.isNew);
      let opened: OpenedSummary | null = null;
      if (shouldOpen) {
        const mission = deps.telemetry.current();
        if (policy === 'auto' && mission.dedicated && mission.playerCount === 0) {
          notes.push('dedicated 서버에 접속한 플레이어가 없어 브라우저 자동 오픈 생략');
        } else if (deps.web.isLocalOnly() && mission.multiplayer) {
          // 다른 플레이어의 브라우저에 127.0.0.1 을 띄우면 그 사람 PC 의 빈 주소가 열린다.
          notes.push('이 PC 전용 주소라 멀티플레이 전체 자동 오픈 생략');
        } else if (deps.gateway.isConnected()) {
          opened = await openOnMachines(deps, pub.url, 'all');
        } else {
          notes.push('game not connected — 자동 오픈 생략(게시는 완료, url 수동 안내 가능)');
        }
      }

      return jsonContent({
        ok: true,
        page: args.page ?? 'index',
        url: pub.url,
        file: pub.file,
        bytes: pub.bytes,
        isNew: pub.isNew,
        webState: deps.web.getState(),
        sseClients: deps.web.sseClientCount(),
        opened,
        note: notes.length > 0 ? notes.join(' / ') : undefined,
      });
    }),
  );

  server.registerTool(
    'arma_web_open',
    {
      title: '웹 페이지 열기(플레이어 브라우저)',
      description:
        BROADCAST_POLICY_KO +
        ' 이미 게시된 페이지(또는 임의 http/https URL)를 플레이어들의 기본 브라우저에 연다. ' +
        '늦게 접속한 플레이어 재오픈, 특정 플레이어 타게팅, webroot 에 직접 쓴 파일 열기에 사용. ' +
        '@arma_mcp 모드가 없는 클라이언트에서는 열리지 않는다(opened.machines 로 확인). ' +
        'AHC_TacticalMap 전술지도 페이지는 주소를 손으로 찾지 말고 arma_tacmap_open 을 쓴다.',
      inputSchema: {
        stack: STACK_INPUT,
        page: z
          .string()
          .optional()
          .describe("열 페이지 슬러그. url 과 택일, 둘 다 없으면 'index'."),
        url: z.string().optional().describe('임의 http/https 절대 URL(스킴은 SQF/DLL 이중 검증).'),
        mode: z
          .enum(['all', 'client'])
          .optional()
          .describe("전파 대상. 기본 'all'. 'client'면 target 필수."),
        target: z.string().optional().describe("mode='client' 대상 플레이어 이름."),
      },
    },
    onStack(shared, {}, async (deps, args) => {
      const mode = args.mode ?? 'all';
      if (mode === 'client' && !args.target) {
        return jsonContent({ ok: false, error: "mode 'client' requires target (player name)" });
      }

      let url: string;
      let note: string | undefined;
      if (args.url) {
        if (!/^https?:\/\//i.test(args.url)) {
          return jsonContent({ ok: false, error: 'url must be http:// or https://' });
        }
        url = args.url;
      } else {
        const p = deps.web.pageUrl(args.page ?? 'index');
        url = p.url;
        note = p.note;
      }

      if (!deps.gateway.isConnected()) {
        return jsonContent({ ok: false, error: 'game not connected', url });
      }
      const mission = deps.telemetry.current();
      if (mode === 'all' && mission.dedicated && mission.playerCount === 0) {
        return jsonContent({
          ok: false,
          error: 'no player clients connected — dedicated server browser open skipped',
          url,
          mode,
        });
      }
      if (!args.url && deps.web.isLocalOnly() && mission.multiplayer) {
        return jsonContent({
          ok: false,
          error:
            '이 PC 전용 주소라 다른 플레이어가 열 수 없습니다. config web.host 를 0.0.0.0 으로 바꾼 뒤 데몬을 다시 시작합니다.',
          url,
          mode,
        });
      }
      const opened = await openOnMachines(deps, url, mode, args.target);
      return jsonContent({ ok: opened.execOk, url, mode, opened, note });
    }),
  );
}
