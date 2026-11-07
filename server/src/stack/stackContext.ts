// stackContext.ts — 테스트 스택 하나가 쓰는 이름, 포트, 파이프, 폴더.
//
// 스택은 전용 서버 1대와 클라이언트 N대를 묶은 단위다. 스택마다 게임 포트,
// profiles 폴더(RPT 가 여기 쌓인다), 게임 파이프, 테스트 애드온 폴더가 따로다.
//
// default 스택은 0.4 의 경로를 그대로 쓴다. mp.port, mp.profilesDir, 클라 RPT 폴더,
// cfg.pipeName 이 그대로이고 클라 1 은 사용자 프로필로 뜬다. 그래서 스택을 모르는
// 호출은 전과 똑같이 동작한다.

import path from 'node:path';
import type { Config } from '../config.js';
import { resolveRptDir, resolveServerProfilesDir, resolveStacksRoot } from '../config.js';
import { defaultScaffoldDir } from '../launch/scaffold.js';

export const DEFAULT_STACK_ID = 'default';

/** 스택 이름. 폴더, 파이프, 미션 template, -name 에 들어가므로 좁게 잡는다. */
export const STACK_ID_RE = /^[a-z0-9][a-z0-9_]{0,15}$/;

// Windows 가 장치로 해석하는 이름은 폴더로 만들 수 없다.
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** 테스트 애드온 스냅샷 폴더 이름. RPT 헤더에서 이 이름을 보고 다음 모드셋에서 뺀다. */
export const TEST_MOD_DIR_NAME = '@arma_mcp_test';

export interface StackContext {
  id: string;
  isDefault: boolean;
  /** <stacks.root>\<id>. default 스택도 테스트 애드온과 오버레이는 여기 둔다. */
  root: string;
  port: number;
  pipeName: string;
  /** 서버 -profiles. server.cfg 는 그 부모 폴더에 쓴다(MpLauncher 의 기존 규칙). */
  serverProfilesDir: string;
  /** 클라 i(1부터)의 -profiles. null 이면 인자를 붙이지 않는다(default 스택 클라 1). */
  clientProfilesDir(index: number): string | null;
  /** 클라 i 의 RPT 가 쌓이는 폴더. */
  clientRptDir(index: number): string;
  /** 클라 i 의 -name. null 이면 붙이지 않는다(사용자 프로필 그대로). */
  clientName(index: number): string | null;
  testModDir: string;
  overlayDir: string;
  /** 즉석 스캐폴드 미션을 만드는 폴더. */
  scaffoldDir: string;
  /** MPMissions 에 배치할 template 이름. 다른 스택의 같은 이름 미션과 겹치지 않게 한다. */
  templateFor(template: string): string;
}

export type StackIdCheck = { ok: true; id: string } | { ok: false; error: string };

/** 입력 스택 이름 검사. 빈 값은 default 다. */
export function validateStackId(raw: string | undefined | null): StackIdCheck {
  const id = (raw ?? '').trim();
  if (id === '' || id === DEFAULT_STACK_ID) return { ok: true, id: DEFAULT_STACK_ID };
  if (!STACK_ID_RE.test(id)) {
    return {
      ok: false,
      error: `스택 이름이 규칙에 맞지 않는다: "${id}". 소문자, 숫자, _ 로 1~16자이고 소문자나 숫자로 시작한다`,
    };
  }
  if (RESERVED_DEVICE_RE.test(id)) {
    return { ok: false, error: `Windows 예약 장치명은 스택 이름으로 쓸 수 없다: "${id}"` };
  }
  return { ok: true, id };
}

export function stackPipeName(cfg: Config, id: string): string {
  return id === DEFAULT_STACK_ID ? cfg.pipeName : `${cfg.pipeName}_s_${id}`;
}

/** default 스택. 0.4 의 경로와 포트와 파이프를 그대로 쓴다. */
export function defaultStackContext(cfg: Config): StackContext {
  const root = path.join(resolveStacksRoot(cfg), DEFAULT_STACK_ID);
  const clientRptDir = resolveRptDir(cfg);
  return {
    id: DEFAULT_STACK_ID,
    isDefault: true,
    root,
    port: cfg.mp.port,
    pipeName: cfg.pipeName,
    serverProfilesDir: resolveServerProfilesDir(cfg),
    clientProfilesDir: (index) => (index <= 1 ? null : path.join(root, `client${index}`)),
    clientRptDir: (index) => (index <= 1 ? clientRptDir : path.join(root, `client${index}`)),
    clientName: (index) => (index <= 1 ? null : `${DEFAULT_STACK_ID}_c${index}`),
    testModDir: path.join(root, TEST_MOD_DIR_NAME),
    overlayDir: path.join(root, 'overlay'),
    scaffoldDir: defaultScaffoldDir(cfg.arma.missionsDir || undefined),
    templateFor: (template) => template,
  };
}

/** default 가 아닌 스택. 모든 경로가 <stacks.root>\<id> 아래다. */
export function namedStackContext(cfg: Config, id: string, port: number): StackContext {
  const root = path.join(resolveStacksRoot(cfg), id);
  const clientDir = (index: number): string => path.join(root, `client${Math.max(1, index)}`);
  return {
    id,
    isDefault: false,
    root,
    port,
    pipeName: stackPipeName(cfg, id),
    serverProfilesDir: path.join(root, 'server', 'profiles'),
    clientProfilesDir: clientDir,
    clientRptDir: clientDir,
    clientName: (index) => `${id}_c${Math.max(1, index)}`,
    testModDir: path.join(root, TEST_MOD_DIR_NAME),
    overlayDir: path.join(root, 'overlay'),
    scaffoldDir: path.join(root, 'missions'),
    templateFor: (template) => suffixTemplate(template, id),
  };
}

/**
 * "<name>.<world>" 를 "<name>__<id>.<world>" 로 바꾼다. world 는 그대로라 서버가 같은 맵을 연다.
 * PBO 미션("<name>.<world>.pbo")은 확장자 앞 world 를 기준으로 한다.
 */
export function suffixTemplate(template: string, id: string): string {
  const pbo = /\.pbo$/i.test(template) ? template.slice(-4) : '';
  const bare = pbo ? template.slice(0, -4) : template;
  const dot = bare.lastIndexOf('.');
  if (dot <= 0) return `${bare}__${id}${pbo}`;
  return `${bare.slice(0, dot)}__${id}${bare.slice(dot)}${pbo}`;
}

/**
 * 스택 전용 설정 사본. MpLauncher 와 RptSourceResolver 가 cfg 에서 읽는 값 중
 * 스택마다 다른 것만 덮는다. default 스택은 같은 객체를 돌려준다.
 */
export function stackCfg(cfg: Config, ctx: StackContext): Config {
  if (ctx.isDefault) return cfg;
  return {
    ...cfg,
    pipeName: ctx.pipeName,
    // 스택 파이프에는 TCP 게이트웨이를 붙이지 않는다. 원시 TCP 는 default 하나다.
    tcp: { ...cfg.tcp, enabled: false },
    rptDir: ctx.clientRptDir(1),
    mp: { ...cfg.mp, port: ctx.port, profilesDir: ctx.serverProfilesDir },
  };
}
