// config.ts — 설정 파일 로드 + env 오버라이드 + zod 검증.
//
// 로드 우선순위: env > 설정 파일 > 기본값.
// 파일이 없거나 깨져도 서버는 반드시 부팅한다(기본값 + stderr 경고).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { log } from './log.js';
// procs.ts 는 node 내장 모듈만 import 하므로 순환 참조가 생기지 않는다.
import { SERVER_IMAGE } from './procs.js';

const ModSwapSchema = z.object({
  match: z.string(),
  replaceWith: z.string(),
});

const ConfigSchema = z.object({
  pipeName: z.string().default('\\\\.\\pipe\\arma_mcp'),
  tcp: z
    .object({
      enabled: z.boolean().default(false),
      // Raw game bridge TCP has no authentication. Keep it loopback-only;
      // remote administration must use the authenticated MCP HTTP endpoint.
      host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
      port: z.number().int().positive().default(5301),
    })
    .default({ enabled: false, host: '127.0.0.1', port: 5301 }),
  rptDir: z.string().default(''),
  arma: z
    .object({
      exePath: z.string().default(''),
      // '' → exePath 와 같은 폴더의 arma3server_x64.exe 로 자동 유도.
      serverExePath: z.string().default(''),
      baseArgs: z.array(z.string()).default([]),
      fallbackMods: z.array(z.string()).default([]),
      modSwaps: z.array(ModSwapSchema).default([]),
      selfModPath: z.string().default(''),
      missionsDir: z.string().default(''),
      // arma_play 실행 프로필 파일. '' → ~/.arma-mcp/launch-profiles.json.
      profilesFile: z.string().default(''),
    })
    .default({
      exePath: '',
      serverExePath: '',
      baseArgs: [],
      fallbackMods: [],
      modSwaps: [],
      selfModPath: '',
      missionsDir: '',
      profilesFile: '',
    }),
  // 멀티플레이 테스트(arma_launch_mp): 데디 서버 + 클라 -connect.
  // profilesDir '' → ~/.arma-mcp/server/profiles (데디 RPT 도 여기 기록),
  // mpMissionsDir '' → 서버 exe 폴더의 MPMissions (데디는 이 폴더만 읽는다).
  mp: z
    .object({
      port: z.number().int().positive().default(2302),
      password: z.string().default(''),
      adminPassword: z.string().default('armamcp'),
      hostname: z.string().default('arma-mcp test server'),
      maxPlayers: z.number().int().positive().default(8),
      profilesDir: z.string().default(''),
      mpMissionsDir: z.string().default(''),
      serverBaseArgs: z.array(z.string()).default([]),
      extraCfgLines: z.array(z.string()).default([]),
    })
    .default({
      port: 2302,
      password: '',
      adminPassword: 'armamcp',
      hostname: 'arma-mcp test server',
      maxPlayers: 8,
      profilesDir: '',
      mpMissionsDir: '',
      serverBaseArgs: [],
      extraCfgLines: [],
    }),
  // 테스트 스택. default 스택은 위 mp/rptDir/pipeName 을 그대로 쓰고, 그 밖의 스택은
  // root 아래 <id> 폴더에 서버·클라 profiles 와 테스트 애드온을 따로 둔다.
  // root '' → ~/.arma-mcp/stacks. 오버레이 하드링크는 기본 모드와 같은 드라이브에서만
  // 복사 없이 되므로, 고친 기본 모드 PBO 를 시험하려면 root 를 그 드라이브에 둔다.
  // windowWidth/Height 는 창 모드로 뜨는 스택 클라의 창과 렌더 크기다. 실제 플레이와 같은 16:9 가 기본이다.
  // 창 4분할도 이 비율로 칸 안 창의 클라이언트 영역을 정한다.
  stacks: z
    .object({
      root: z.string().default(''),
      max: z.number().int().min(1).max(16).default(4),
      maxClients: z.number().int().min(1).max(16).default(4),
      portStep: z.number().int().min(5).max(1000).default(10),
      testModMaxMB: z.number().int().min(1).default(512),
      overlayCopyMaxMB: z.number().int().min(0).default(1024),
      windowWidth: z.number().int().min(320).max(7680).default(1600),
      windowHeight: z.number().int().min(240).max(4320).default(900),
    })
    .default({
      root: '',
      max: 4,
      maxClients: 4,
      portStep: 10,
      testModMaxMB: 512,
      overlayCopyMaxMB: 1024,
      windowWidth: 1600,
      windowHeight: 900,
    }),
  // 게임 창 4분할. 데몬이 띄운 클라 창이 둘 이상이면 주 모니터 작업 영역을 네 칸으로 나눠 놓는다.
  // 하나뿐이면 손대지 않는다. stacks 는 대상 스택 이름 패턴(`*` 는 아무 글자)이고 비우면 모든 스택이다.
  // focusGuard 는 같은 대상 중 앞에 없는 창 모드 게임에 비활성 알림을 보내 사람이 다른 창에 치는 키를 쓰지 않게 한다.
  windowTiler: z
    .object({
      enabled: z.boolean().default(true),
      stacks: z.array(z.string().min(1)).default([]),
      focusGuard: z.boolean().default(true),
    })
    .default({ enabled: true, stacks: [], focusGuard: true }),
  exec: z
    .object({
      defaultTimeoutMs: z.number().int().positive().default(5000),
      maxCodeBytes: z.number().int().positive().default(131072),
    })
    .default({ defaultTimeoutMs: 5000, maxCodeBytes: 131072 }),
  // 웹 게시(arma_web_publish/open). host 기본은 이 PC 전용이다. 처음 쓰는 사람에게 방화벽 확인 창을
  // 띄우지 않으려는 것이고, 멀티플레이 전원에게 보이려면 0.0.0.0 으로 바꾼다.
  // 로컬 전용으로 잠그려면 '127.0.0.1'. rootDir '' → ~/.arma-mcp/web,
  // publicBaseUrl '' → LAN IP 자동 감지(가상 NIC 오감지 시 여기로 오버라이드).
  web: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(5302),
      rootDir: z.string().default(''),
      publicBaseUrl: z.string().default(''),
    })
    .default({ enabled: true, host: '127.0.0.1', port: 5302, rootDir: '', publicBaseUrl: '' }),
  // 화면 캡처(arma_capture). dir '' → ~/.arma-mcp/captures.
  // keepMax 초과분은 캡처 성공 시마다 오래된 것부터 삭제(디스크 누적 방지).
  capture: z
    .object({
      dir: z.string().default(''),
      keepMax: z.number().int().positive().default(100),
    })
    .default({ dir: '', keepMax: 100 }),
  // half-open 링크 감지. staleAfterMs 는 DLL heartbeat 주기(5s)의 3배가 기본 —
  // 이보다 짧게 잡으면 정상 링크를 오탐으로 끊을 수 있다.
  // preBridgeStaleMs: 아직 브리지가 살아난 적 없는 링크(hello 만 오고 미션이 없어
  // SQF 애드온 자체가 없는 로비 상태)를 끊기까지의 시간. 0 = 끊지 않음(기본).
  // 이 상태에서 끊으면 DLL 이 즉시 재접속해 15초 주기 폭주가 나고, 그때마다
  // ExecManager 의 failAll 이 진행 중이던 exec 를 죽인다.
  link: z
    .object({
      staleAfterMs: z.number().int().min(1000).default(15000),
      sweepMs: z.number().int().min(500).default(5000),
      preBridgeStaleMs: z.number().int().min(0).default(0),
      reconnectLogQuietMs: z.number().int().min(0).default(60000),
    })
    .default({
      staleAfterMs: 15000,
      sweepMs: 5000,
      preBridgeStaleMs: 0,
      reconnectLogQuietMs: 60000,
    }),
  // Long-running MCP daemon. The listener is intentionally fixed to loopback;
  // remote administrators connect through an SSH/VPN local port forward.
  mcp: z
    .object({
      port: z.number().int().min(1).max(65535).default(5303),
      path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/mcp'),
      tokenFile: z.string().default(''),
      allowedOrigins: z.array(z.string()).default([]),
      maxSessions: z.number().int().min(1).max(256).default(16),
      idleTimeoutMs: z.number().int().min(1000).default(30 * 60 * 1000),
      // cli 세션은 명령 하나를 처리하고 끝난다. relay 자리를 먹지 않게 따로 세고,
      // 끝내지 못한 세션은 짧은 유휴 만료로 치운다.
      maxCliSessions: z.number().int().min(1).max(256).default(8),
      cliIdleTimeoutMs: z.number().int().min(1000).default(60_000),
      maxBodyBytes: z.number().int().min(1024).default(6 * 1024 * 1024),
      // 유휴 keep-alive 소켓을 데몬이 닫기까지의 시간. Node 기본값은 5초이고,
      // 그 값이면 툴 호출 간격이 5초만 넘어도 데몬이 소켓을 닫는다. 릴레이가
      // 그 소켓을 재사용하는 순간 ECONNRESET 이 나므로 넉넉히 잡는다.
      // (릴레이는 그래도 남는 경계 레이스를 1회 재시도로 흡수한다.)
      keepAliveTimeoutMs: z.number().int().min(1000).default(65_000),
      // 이 배포에서 쓰지 않는 툴 이름. 등록 자체를 건너뛰므로 스키마가 프롬프트에서 빠진다.
      disableTools: z.array(z.string()).default([]),
    })
    .default({
      port: 5303,
      path: '/mcp',
      tokenFile: '',
      allowedOrigins: [],
      maxSessions: 16,
      idleTimeoutMs: 30 * 60 * 1000,
      maxCliSessions: 8,
      cliIdleTimeoutMs: 60_000,
      maxBodyBytes: 6 * 1024 * 1024,
      keepAliveTimeoutMs: 65_000,
      disableTools: [],
    }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  logFile: z.string().default(''),
});

export type Config = z.infer<typeof ConfigSchema>;

/** rptDir 이 비어 있으면 %LOCALAPPDATA%\Arma 3 로 해석. */
export function resolveRptDir(cfg: Config): string {
  if (cfg.rptDir) return cfg.rptDir;
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Arma 3');
}

/** web.rootDir 이 비어 있으면 ~/.arma-mcp/web 으로 해석. */
export function resolveWebRoot(cfg: Config): string {
  if (cfg.web.rootDir) return cfg.web.rootDir;
  return path.join(homedir(), '.arma-mcp', 'web');
}

/** capture.dir 이 비어 있으면 ~/.arma-mcp/captures 로 해석. */
export function resolveCaptureDir(cfg: Config): string {
  if (cfg.capture.dir) return cfg.capture.dir;
  return path.join(homedir(), '.arma-mcp', 'captures');
}

/** serverExePath 가 비어 있으면 exePath 옆의 arma3server_x64.exe 로 유도. */
export function resolveServerExePath(cfg: Config): string {
  if (cfg.arma.serverExePath) return cfg.arma.serverExePath;
  if (!cfg.arma.exePath) return '';
  return path.join(path.dirname(cfg.arma.exePath), 'arma3server_x64.exe');
}

/**
 * 데디 서버 프로세스 이미지명 — serverExePath 의 파일명을 그대로 쓴다.
 * 운영자가 프로파일링 빌드 등 다른 exe 로 서버를 띄우면 고정 상수로는 탐지에 실패한다.
 */
export function resolveServerImage(cfg: Config): string {
  const exe = resolveServerExePath(cfg);
  return exe ? path.basename(exe) : SERVER_IMAGE;
}

/** 데디 서버 -profiles 디렉토리(서버 RPT 도 여기 기록). '' → ~/.arma-mcp/server/profiles. */
export function resolveServerProfilesDir(cfg: Config): string {
  if (cfg.mp.profilesDir) return cfg.mp.profilesDir;
  return path.join(homedir(), '.arma-mcp', 'server', 'profiles');
}

/** 테스트 스택 폴더들의 상위. '' → ~/.arma-mcp/stacks. */
export function resolveStacksRoot(cfg: Config): string {
  if (cfg.stacks?.root) return path.resolve(cfg.stacks.root);
  return path.join(homedir(), '.arma-mcp', 'stacks');
}

/** 데디 서버가 미션 template 을 읽는 MPMissions. '' → 서버 exe 폴더의 MPMissions. */
export function resolveMpMissionsDir(cfg: Config): string {
  if (cfg.mp.mpMissionsDir) return cfg.mp.mpMissionsDir;
  const exe = resolveServerExePath(cfg);
  if (!exe) return '';
  return path.join(path.dirname(exe), 'MPMissions');
}

/** MCP daemon bearer-token file. The token itself never belongs in config. */
export function resolveMcpTokenFile(cfg: Config): string {
  if (cfg.mcp.tokenFile) return cfg.mcp.tokenFile;
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Arma-MCP', 'daemon.token');
}

/** daemon token·로그가 함께 사는 상태 폴더. 운영 스크립트와 자동 기동이 같은 경로를 쓴다. */
export function resolveStateDir(cfg: Config): string {
  return path.dirname(resolveMcpTokenFile(cfg));
}

/** Canonical local endpoint used by the stdio relay and SSH port forwards. */
export function resolveMcpEndpoint(cfg: Config): URL {
  return new URL(`http://127.0.0.1:${cfg.mcp.port}${cfg.mcp.path}`);
}

const LOOPBACK_TCP_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * v0.2 allowed the unauthenticated raw game TCP gateway to bind to arbitrary
 * interfaces (the example/default was commonly 0.0.0.0). Migrate only that
 * field before schema validation so upgrading does not discard otherwise valid
 * user configuration.
 */
function migrateRawTcpHost(raw: Record<string, unknown>): Record<string, unknown> {
  const tcpValue = raw.tcp;
  if (typeof tcpValue !== 'object' || tcpValue === null || Array.isArray(tcpValue)) {
    return raw;
  }

  const tcp = tcpValue as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(tcp, 'host')) return raw;
  if (typeof tcp.host === 'string' && LOOPBACK_TCP_HOSTS.has(tcp.host)) return raw;

  log.warn(
    'config: tcp.host must be loopback; migrating',
    String(tcp.host),
    'to 127.0.0.1',
  );
  return {
    ...raw,
    tcp: {
      ...tcp,
      host: '127.0.0.1',
    },
  };
}

function applyEnvOverrides(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const out = { ...raw };
  if (env.ARMA_MCP_PIPE) out.pipeName = env.ARMA_MCP_PIPE;
  if (env.ARMA_MCP_RPT_DIR) out.rptDir = env.ARMA_MCP_RPT_DIR;
  if (env.ARMA_MCP_LOG_LEVEL) out.logLevel = env.ARMA_MCP_LOG_LEVEL;
  if (env.ARMA_MCP_LOG_FILE) out.logFile = env.ARMA_MCP_LOG_FILE;
  if (env.ARMA_MCP_STALE_MS) {
    const stale = Number(env.ARMA_MCP_STALE_MS);
    if (Number.isFinite(stale) && stale >= 1000) {
      const link = (typeof out.link === 'object' && out.link) || {};
      out.link = { ...link, staleAfterMs: stale };
    }
  }

  if (env.ARMA_MCP_TCP_PORT) {
    const port = Number(env.ARMA_MCP_TCP_PORT);
    if (Number.isFinite(port) && port > 0) {
      const tcp = (typeof out.tcp === 'object' && out.tcp) || {};
      out.tcp = { ...tcp, enabled: true, port };
    }
  }
  if (env.ARMA_MCP_EXE) {
    const arma = (typeof out.arma === 'object' && out.arma) || {};
    out.arma = { ...arma, exePath: env.ARMA_MCP_EXE };
  }
  if (env.ARMA_MCP_SERVER_EXE) {
    const arma = (typeof out.arma === 'object' && out.arma) || {};
    out.arma = { ...arma, serverExePath: env.ARMA_MCP_SERVER_EXE };
  }
  if (env.ARMA_MCP_MP_PORT) {
    const port = Number(env.ARMA_MCP_MP_PORT);
    if (Number.isFinite(port) && port > 0) {
      const mp = (typeof out.mp === 'object' && out.mp) || {};
      out.mp = { ...mp, port };
    }
  }
  if (env.ARMA_MCP_WEB_PORT) {
    const port = Number(env.ARMA_MCP_WEB_PORT);
    if (Number.isFinite(port) && port > 0) {
      const web = (typeof out.web === 'object' && out.web) || {};
      out.web = { ...web, port };
    }
  }
  if (env.ARMA_MCP_WEB_URL) {
    const web = (typeof out.web === 'object' && out.web) || {};
    out.web = { ...web, publicBaseUrl: env.ARMA_MCP_WEB_URL };
  }
  if (env.ARMA_MCP_DAEMON_PORT) {
    const port = Number(env.ARMA_MCP_DAEMON_PORT);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      const mcp = (typeof out.mcp === 'object' && out.mcp) || {};
      out.mcp = { ...mcp, port };
    }
  }
  if (env.ARMA_MCP_TOKEN_FILE) {
    const mcp = (typeof out.mcp === 'object' && out.mcp) || {};
    out.mcp = { ...mcp, tokenFile: env.ARMA_MCP_TOKEN_FILE };
  }
  if (env.ARMA_MCP_ALLOWED_ORIGINS) {
    const mcp = (typeof out.mcp === 'object' && out.mcp) || {};
    out.mcp = {
      ...mcp,
      allowedOrigins: env.ARMA_MCP_ALLOWED_ORIGINS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    };
  }
  return out;
}

/**
 * 설정 파일 경로 결정. 우선순위:
 *   1) ARMA_MCP_CONFIG env (명시 오버라이드)
 *   2) ~/.arma-mcp/config.json (사용자 홈 — 플러그인 설치·업데이트에도 유지되는 안정 위치)
 *   3) 저장소 루트 arma-mcp.config.json (개발용; import.meta.url 로 추정)
 *
 * 플러그인으로 설치하면 서버는 호스트가 관리하는 플러그인 루트 아래에서 실행되고 업데이트 시
 * 재클론되므로 그 안의 설정은 휘발한다. (2) 사용자 홈 위치가 배포본을 건드리지 않고
 * 사용자별 설정을 담는다.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARMA_MCP_CONFIG) return env.ARMA_MCP_CONFIG;

  // 2) 사용자 홈 — 존재할 때만 채택(없으면 개발용 경로로 폴백).
  const homeConfig = path.join(homedir(), '.arma-mcp', 'config.json');
  if (existsSync(homeConfig)) return homeConfig;

  // 3) 저장소 로컬(개발). dist/bundle 실행 시 import.meta.url 기준 상위로 추정.
  //    server/dist/config.js 또는 server/bundle/index.mjs → ../../arma-mcp.config.json
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.resolve(here, '..', '..', 'arma-mcp.config.json');
}

export interface LoadConfigOptions {
  /**
   * true 면 설정 파일이 없을 때 경고하지 않는다. CLI 는 명령마다 설정을 읽으므로
   * 파일 없이 쓰는 사용자에게 매번 같은 줄을 찍지 않는다. 없는 파일은 doctor 가 알린다.
   * 파일이 깨졌거나 검증에 실패하면 quiet 여도 경고한다.
   */
  quiet?: boolean;
  /** 경로 결정과 env 오버라이드에 쓸 환경. 기본은 process.env 다. */
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(configPath?: string, opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const file = configPath ?? resolveConfigPath(env);
  let raw: Record<string, unknown> = {};
  try {
    const text = readFileSync(file, 'utf8');
    raw = JSON.parse(text) as Record<string, unknown>;
    log.info('config: loaded', file);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (opts.quiet && missing) log.debug('config: 파일이 없어 기본값 사용', file);
    else log.warn('config: 파일을 읽지 못해 기본값 사용', file, String(err));
  }

  const merged = migrateRawTcpHost(applyEnvOverrides(raw, env));
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    log.warn('config: 검증 실패, 기본값 사용', parsed.error.message);
    return ConfigSchema.parse({});
  }
  return parsed.data;
}
