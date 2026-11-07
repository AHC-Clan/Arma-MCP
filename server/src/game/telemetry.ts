// telemetry.ts — DLL 이 push 한 미션 정보 캐시.
//
// hello/sessionInfo/telemetry 프레임을 받아 최신 상태를 유지한다.
// 접속(connected) 시 새 미션을 위해 리셋, 단절(disconnected) 시 현재 미션을
// lastKnown 으로 강등하고 disconnectedAt 을 기록한다.

import type { Gateway, GatewayFrame } from '../ipc/gateway.js';

export interface PlayerInfo {
  name: string;
  side: string;
  uid: string;
  isPlayer: boolean;
}

/**
 * getClientStateNumber 값 이름. 애드온은 숫자만 보내고 이름은 여기서 붙인다.
 *
 * 인덱스가 곧 상태 번호다. 엔진의 getClientState 가 숫자를 이름으로 바꾸는 표와 같다
 * (Arma 3 2.22 exe 의 정적 표, 값 0~12 가 이 순서이고 끝은 -1). 로비와 인게임을 가르는
 * 근거이므로 순서를 바꾸면 안 된다.
 *
 * 엔진에서 확인한 쓰임: 서버의 OnAutoSelectRole 훅은 클라가 5(MISSION ASKED)가 될 때 불리고,
 * 로비의 OK 는 6(ROLE ASSIGNED)에서만 먹는다. 7~9 는 미션 받기, 로드, 브리핑이다.
 * 서버 미션이 이미 돌고 있으면 클라는 브리핑 없이 10(BRIEFING READ)으로 간다.
 */
export const CLIENT_STATE_NAMES = [
  'NONE',
  'CREATED',
  'CONNECTED',
  'LOGGED IN',
  'MISSION SELECTED',
  'MISSION ASKED',
  'ROLE ASSIGNED',
  'MISSION RECEIVED',
  'GAME LOADED',
  'BRIEFING SHOWN',
  'BRIEFING READ',
  'GAME FINISHED',
  'DEBRIEFING READ',
];

/** 상태 번호를 사람이 읽는 이름으로. 음수는 값을 못 받은 것이다. */
export function clientStateName(state: number): string {
  if (state < 0) return 'UNKNOWN';
  return CLIENT_STATE_NAMES[state] ?? `STATE ${state}`;
}

/**
 * MP 서버가 본 접속자 하나. getUserInfo 에서 그대로 온다.
 *
 * players 와 다른 점은 로비에 있는 사람도 보인다는 것이다. state 가 화면 단계이고
 * hasUnit 이 슬롯 보유 여부라, 둘을 합쳐야 "로비에 있음" 과 "인게임" 이 갈린다.
 */
export interface ClientInfo {
  name: string;
  /**
   * 엔진의 clientStateNumber. -1 = 값을 못 받음(구버전 PBO 는 문자열을 보냈다).
   * clients 필드 자체의 부재(null)와는 다른 층위다.
   */
  state: number;
  /** state 를 CLIENT_STATE_NAMES 로 옮긴 표시용 이름. */
  stateName: string;
  isHC: boolean;
  hasUnit: boolean;
}

/** diag_activeScripts 의 네 칸. 지금 돌고 있는 스크립트 수다. */
export interface ScriptCounts {
  spawn: number;
  execVM: number;
  exec: number;
  fsm: number;
}

export interface MissionSnapshot {
  world: string;
  mission: string;
  briefing: string;
  dedicated: boolean;
  multiplayer: boolean;
  cba: boolean;
  ace: boolean;
  aceVersion: string;
  aceComponents: string[];
  /**
   * AHC_TacticalMap 로드 여부. null = 애드온이 필드를 보내지 않음(구버전 PBO — 미상).
   * false 를 하드 게이트로 쓰면 PBO 만 구버전인 환경에서 TacMap 이 실제로 로드돼 있는데도
   * 툴이 전부 거부된다. 최종 판정은 항상 조립 SQF 의 isNil 가드가 내린다.
   */
  tacmap: boolean | null;
  /** AHC_ZeusTool 로드 여부(무전 자막의 사운드 유무만 결정). null = 미상. */
  tacmapZeusTool: boolean | null;
  missionTime: number;
  date: number[];
  fps: number;
  /** 최근 프레임 중 가장 낮은 FPS(diag_fpsmin). null = 구버전 PBO 라 받지 못함. */
  fpsMin: number | null;
  /** 돌고 있는 스크립트 수(diag_activeScripts). null = 구버전 PBO 라 받지 못함. */
  scripts: ScriptCounts | null;
  /**
   * 일시정지 메뉴가 열렸는지(isGamePaused). 창이 있는 쪽(SP, 플레이어가 연 서버)만 보낸다.
   * null = 데디 서버이거나 구버전 PBO. SP 는 이때 게임 시간(missionTime)이 멈춘다.
   */
  paused: boolean | null;
  /**
   * 게임 창에 포커스가 있는지(isGameFocused). paused 와 같은 쪽만 보낸다.
   * -autotest 로 띄운 SP 는 비활성이어도 게임 시간이 흐르고 FPS 가 60 아래로 묶였다(실측).
   */
  focused: boolean | null;
  players: PlayerInfo[];
  playerCount: number;
  /** HC(HeadlessClient) 수. 구버전 PBO 는 필드를 보내지 않음 → 0 유지. */
  hcCount: number;
  /**
   * MP 서버가 본 접속자 목록. null = 애드온이 필드를 보내지 않음(구버전 PBO 또는 SP).
   * tacmap 과 같은 3-state 규칙이다 — 빈 배열(아무도 없음)과 미상을 구분해야 한다.
   */
  clients: ClientInfo[] | null;
  receivedAt: number; // epoch ms; 0 = 아직 telemetry 없음
}

function emptySnapshot(): MissionSnapshot {
  return {
    world: '',
    mission: '',
    briefing: '',
    dedicated: false,
    multiplayer: false,
    cba: false,
    ace: false,
    aceVersion: '',
    aceComponents: [],
    tacmap: null,
    tacmapZeusTool: null,
    missionTime: 0,
    date: [],
    fps: 0,
    fpsMin: null,
    scripts: null,
    paused: null,
    focused: null,
    players: [],
    playerCount: 0,
    hcCount: 0,
    clients: null,
    receivedAt: 0,
  };
}

function parsePlayers(raw: unknown): PlayerInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: PlayerInfo[] = [];
  for (const p of raw) {
    if (!Array.isArray(p)) continue;
    out.push({
      name: String(p[0] ?? ''),
      side: String(p[1] ?? ''),
      uid: String(p[2] ?? ''),
      isPlayer: Boolean(p[3]),
    });
  }
  return out;
}

function parseClients(raw: unknown): ClientInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientInfo[] = [];
  for (const c of raw) {
    if (!Array.isArray(c)) continue;
    // 0.4.1 이전 PBO 는 이 자리에 문자열을 실었고 그 값은 애드온의 타입 오판으로
    // 상태와 무관한 값이었다. 숫자가 아니면 미상(-1)으로 떨어뜨린다.
    const state = typeof c[1] === 'number' ? c[1] : -1;
    out.push({
      name: String(c[0] ?? ''),
      state,
      stateName: clientStateName(state),
      isHC: Boolean(c[2]),
      hasUnit: Boolean(c[3]),
    });
  }
  return out;
}

/** [spawn, execVM, exec, execFSM]. 네 칸이 모두 숫자가 아니면 미상(null)이다. */
function parseScripts(raw: unknown): ScriptCounts | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  if (!raw.slice(0, 4).every((n) => typeof n === 'number')) return null;
  const [spawn, execVM, exec, fsm] = raw as number[];
  return { spawn: spawn!, execVM: execVM!, exec: exec!, fsm: fsm! };
}

export class TelemetryStore {
  private snap: MissionSnapshot = emptySnapshot();
  private lastKnown: MissionSnapshot | null = null;
  private disconnectedAt = 0;
  private helloVer = '';
  /** hello 의 pid. 0.5 이전 DLL 은 보내지 않아 0 이다. 연결마다 새로 받는다. */
  private helloPid = 0;
  private helloCba = false;
  private waiters: Array<(ok: boolean) => void> = [];

  bind(gateway: Gateway): void {
    gateway.on('connected', () => this.onConnected());
    gateway.on('disconnected', () => this.onDisconnected());
    gateway.on('hello', (m) => this.onHello(m));
    gateway.on('sessionInfo', (m) => this.onSessionInfo(m));
    gateway.on('telemetry', (m) => this.onTelemetry(m));
  }

  private onConnected(): void {
    this.snap = emptySnapshot();
    this.disconnectedAt = 0;
    this.helloPid = 0;
  }

  private onDisconnected(): void {
    if (this.snap.world || this.snap.mission || this.snap.receivedAt) {
      this.lastKnown = this.snap;
    }
    this.snap = emptySnapshot();
    this.disconnectedAt = Date.now();
    this.flushWaiters(false);
  }

  private onHello(m: GatewayFrame): void {
    this.helloVer = String(m.ver ?? '');
    const pid = Number(m.pid);
    this.helloPid = Number.isInteger(pid) && pid > 0 ? pid : 0;
  }

  private onSessionInfo(m: GatewayFrame): void {
    this.snap.world = String(m.world ?? this.snap.world);
    this.snap.mission = String(m.mission ?? this.snap.mission);
    this.snap.briefing = String(m.briefing ?? this.snap.briefing);
    this.snap.dedicated = m.dedicated ? true : this.snap.dedicated;
    this.snap.multiplayer = m.multiplayer ? true : this.snap.multiplayer;
    if (typeof m.cba !== 'undefined') {
      this.snap.cba = Boolean(m.cba);
      this.helloCba = Boolean(m.cba);
    }
    if (typeof m.ace !== 'undefined') this.snap.ace = Boolean(m.ace);
    if (typeof m.aceVersion !== 'undefined') this.snap.aceVersion = String(m.aceVersion);
    if (Array.isArray(m.aceComponents)) {
      this.snap.aceComponents = (m.aceComponents as unknown[]).map((c) => String(c));
    }
    // 구버전 PBO 는 이 두 필드를 보내지 않는다 → false 로 단정하지 않고 null(미상) 유지.
    if (typeof m.tacmap !== 'undefined') this.snap.tacmap = Boolean(m.tacmap);
    if (typeof m.tacmapZeusTool !== 'undefined') {
      this.snap.tacmapZeusTool = Boolean(m.tacmapZeusTool);
    }
  }

  private onTelemetry(m: GatewayFrame): void {
    this.snap.world = String(m.world ?? this.snap.world);
    this.snap.mission = String(m.mission ?? this.snap.mission);
    if (typeof m.briefing !== 'undefined') this.snap.briefing = String(m.briefing);
    if (typeof m.time === 'number') this.snap.missionTime = m.time;
    if (Array.isArray(m.date)) this.snap.date = m.date as number[];
    if (typeof m.fps === 'number') this.snap.fps = m.fps;
    if (typeof m.fpsMin === 'number') this.snap.fpsMin = m.fpsMin;
    if (typeof m.scripts !== 'undefined') this.snap.scripts = parseScripts(m.scripts);
    // 데디 서버와 구버전 PBO 는 두 필드를 보내지 않는다 → false 로 단정하지 않고 null 유지.
    if (typeof m.paused !== 'undefined') this.snap.paused = Boolean(m.paused);
    if (typeof m.focused !== 'undefined') this.snap.focused = Boolean(m.focused);
    this.snap.players = parsePlayers(m.players);
    this.snap.playerCount =
      typeof m.playerCount === 'number' ? m.playerCount : this.snap.players.length;
    if (typeof m.hcCount === 'number') this.snap.hcCount = m.hcCount;
    // 구버전 PBO 와 SP 는 이 필드를 보내지 않는다 → 빈 배열로 단정하지 않고 null 유지.
    if (typeof m.clients !== 'undefined') this.snap.clients = parseClients(m.clients);
    this.snap.receivedAt = Date.now();
    this.flushWaiters(true);
  }

  /**
   * 다음 telemetry 프레임 도착까지 대기. 도착 시 true, 타임아웃/단절 시 false.
   * 스냅샷 갱신 후 resolve 되므로 대기 직후 current() 는 항상 새 값이다.
   */
  waitForTelemetry(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private flushWaiters(ok: boolean): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(ok);
  }

  /** 현재(라이브) 스냅샷. */
  current(): MissionSnapshot {
    return this.snap;
  }

  lastKnownSnapshot(): MissionSnapshot | null {
    return this.lastKnown;
  }

  disconnectedAtMs(): number {
    return this.disconnectedAt;
  }

  cacheAgeMs(): number {
    return this.snap.receivedAt ? Date.now() - this.snap.receivedAt : -1;
  }

  dllVersion(): string {
    return this.helloVer;
  }

  /** 지금 연결된 게임 프로세스의 pid. 모르면 0. */
  dllPid(): number {
    return this.helloPid;
  }

  cba(): boolean {
    return this.helloCba || this.snap.cba;
  }

  ace(): boolean {
    return this.snap.ace;
  }

  aceVersion(): string {
    return this.snap.aceVersion;
  }

  aceComponents(): string[] {
    return this.snap.aceComponents;
  }

  /** AHC_TacticalMap 로드 여부. null = 미상(구버전 PBO). */
  tacmap(): boolean | null {
    return this.snap.tacmap;
  }

  /** AHC_ZeusTool 로드 여부(무전 자막 사운드). null = 미상. */
  tacmapZeusTool(): boolean | null {
    return this.snap.tacmapZeusTool;
  }
}
