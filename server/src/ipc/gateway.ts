// gateway.ts — DLL 이 접속하는 소켓 엔드포인트.
//
// MCP 서버가 소켓 서버(장수명), DLL 이 미션 로드 시 클라이언트로 접속.
// 로컬 named pipe 는 항상 리스닝, TCP 는 옵션. 동시 접속 1개만 유지한다.
//
// TacMap ipcServer.js 대비 차이점:
//  - EADDRINUSE 에서 process.exit 하지 않는다. MCP 클라이언트는 세션마다 서버를
//    스폰할 수 있으므로, 두 번째 세션이 죽으면 안 된다. degraded 모드로 5s 재시도하고
//    RPT/launch 툴은 계속 동작시킨다.
//  - 프레임을 타입별 이벤트로 방출(hello/sessionInfo/telemetry/execResult/heartbeat).

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { encode, makeDecoder } from './frame.js';
import { log } from '../log.js';
import type { Config } from '../config.js';

const RETRY_MS = 5000;

export interface GatewayFrame {
  v?: number;
  type?: string;
  [k: string]: unknown;
}

export type ListenerState = 'ok' | 'pipe-unavailable';

export interface GatewayStartOptions {
  /** Require exclusive ownership instead of entering degraded/retry mode. */
  requireOwnership?: boolean;
}

export interface Gateway {
  on(event: 'connected', l: (info: { via: string }) => void): this;
  on(event: 'disconnected', l: () => void): this;
  on(event: 'hello', l: (msg: GatewayFrame) => void): this;
  on(event: 'sessionInfo', l: (msg: GatewayFrame) => void): this;
  on(event: 'telemetry', l: (msg: GatewayFrame) => void): this;
  on(event: 'execResult', l: (msg: GatewayFrame) => void): this;
  on(event: 'heartbeat', l: (msg: GatewayFrame) => void): this;
}

export class Gateway extends EventEmitter {
  private cfg: Config;
  private servers: net.Server[] = [];
  private sock: net.Socket | null = null;
  private via = '';
  private connectedAt = 0;
  private lastFrameAt = 0;
  private listenerState: ListenerState = 'ok';
  private retryTimers: NodeJS.Timeout[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private connectionGeneration = 0;
  private gotSessionInfo = false;
  private started = false;
  /** 현재 연결에서 브리지(=미션 SQF)가 살아 있음을 마지막으로 확인한 시각. 0 = 아직 없음. */
  private bridgeAliveAt = 0;
  private lastLinkLogAt = 0;
  private suppressedLinkLogs = 0;

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
  }

  async start(options: GatewayStartOptions = {}): Promise<void> {
    if (this.started) throw new Error('gateway already started');
    this.started = true;
    const requireOwnership = options.requireOwnership === true;
    const listeners = [this.listenPipe(requireOwnership)];
    if (this.cfg.tcp.enabled) listeners.push(this.listenTcp(requireOwnership));
    // half-open 감시: 주기적으로 무수신 링크를 끊고, 정상 링크엔 ping 을 보내
    // 파이프 파손 시 write 실패 → close 를 앞당긴다.
    this.sweepTimer = setInterval(() => this.sweep(), this.cfg.link.sweepMs);
    this.sweepTimer.unref();
    await Promise.all(listeners);
  }

  private sweep(): void {
    if (!this.sock || this.sock.destroyed) return;
    const age = Date.now() - this.lastFrameAt;

    if (this.bridgeAliveAt === 0) {
      // 프리브리지 — DLL 은 접속해 hello 만 보냈고 아직 브리지가 살아난 적이 없다.
      // 미션이 없으면 SQF 애드온도 없어서 telemetry/heartbeat 를 만들 주체가 없고,
      // ping 은 DLL 이 내부에서 소비만 하므로 응답이 영원히 오지 않는다.
      // 여기서 끊으면 재접속 폭주가 나고(실측 69,557회) 그때마다 failAll 이
      // 진행 중이던 exec 를 죽인다. 파이프가 실제로 깨졌는지는 raw write 로만 판정한다.
      const limit = this.cfg.link.preBridgeStaleMs;
      if (limit > 0 && age >= limit) {
        log.debug(`[gateway] pre-bridge link stale (${age}ms) — 연결 종료`);
        this.sock.destroy();
        return;
      }
      this.writeRaw({ v: 1, type: 'ping' });
      return;
    }

    // 한 번이라도 살아 있던 링크가 조용해진 것 — 게임 크래시일 수 있으므로
    // 기존대로 끊어서 exec 가 풀 타임아웃을 소모하지 않게 한다.
    if (age >= this.cfg.link.staleAfterMs) {
      log.warn(`[gateway] link stale (${age}ms 무수신) — 연결 강제 종료`);
      this.sock.destroy();
    } else {
      this.send({ v: 1, type: 'ping' });
    }
  }

  /**
   * stale 판정을 건너뛰고 소켓 생존만 확인해 쓴다.
   * send() 는 isConnected() 가 false 면 조기 반환하는데, 프리브리지 링크는 정의상
   * 무수신이라 항상 false 다 — raw 경로가 없으면 파이프 파손 감지까지 같이 죽는다.
   */
  private writeRaw(obj: Record<string, unknown>): boolean {
    if (!this.sock || this.sock.destroyed) return false;
    try {
      this.sock.write(encode(JSON.stringify(obj)));
      return true;
    } catch (e) {
      log.warn('[gateway] raw write failed: ' + (e as Error).message);
      return false;
    }
  }

  private listenPipe(requireOwnership = false): Promise<void> {
    const label = 'pipe ' + this.cfg.pipeName;
    const srv = net.createServer((sock) => this.onConnection(sock, label));
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      srv.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          this.listenerState = 'pipe-unavailable';
          this.dropServer(srv);
          if (requireOwnership && !settled) {
            settled = true;
            reject(new Error(`[gateway] cannot own ${label}: already in use`));
            return;
          }
          log.warn(`[gateway] ${label} 사용 중 — degraded 모드, ${RETRY_MS}ms 후 재시도`);
          const t = setTimeout(() => void this.listenPipe(false), RETRY_MS);
          t.unref();
          this.retryTimers.push(t);
        } else {
          log.error(`[gateway] server error (${label}): ${e.message}`);
          if (requireOwnership && !settled) {
            settled = true;
            reject(e);
            return;
          }
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      srv.listen(this.cfg.pipeName, () => {
        this.listenerState = 'ok';
        log.info('[gateway] listening on ' + label);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
    this.servers.push(srv);
    return ready;
  }

  private listenTcp(requireOwnership = false): Promise<void> {
    const { host, port } = this.cfg.tcp;
    const label = `tcp ${host}:${port}`;
    const srv = net.createServer((sock) => this.onConnection(sock, label));
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      srv.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          this.dropServer(srv);
          if (requireOwnership && !settled) {
            settled = true;
            reject(new Error(`[gateway] cannot own ${label}: already in use`));
            return;
          }
          log.warn(`[gateway] ${label} 사용 중 — ${RETRY_MS}ms 후 재시도`);
          const t = setTimeout(() => void this.listenTcp(false), RETRY_MS);
          t.unref();
          this.retryTimers.push(t);
        } else {
          log.error(`[gateway] server error (${label}): ${e.message}`);
          if (requireOwnership && !settled) {
            settled = true;
            reject(e);
            return;
          }
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      srv.listen(port, host, () => {
        log.info('[gateway] listening on ' + label);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
    this.servers.push(srv);
    return ready;
  }

  private dropServer(srv: net.Server): void {
    this.servers = this.servers.filter((s) => s !== srv);
    try {
      srv.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * 접속/해제 로그를 짧은 창 안에서 묶는다. 정상 상태에선 몇 줄뿐이지만,
   * 파이프가 실제로 깨져 재접속이 반복되면 로그 파일만 수십 MB 로 불어난다.
   */
  private logLink(message: string): void {
    const quiet = this.cfg.link.reconnectLogQuietMs;
    const now = Date.now();
    if (quiet > 0 && this.lastLinkLogAt && now - this.lastLinkLogAt < quiet) {
      this.suppressedLinkLogs += 1;
      log.debug(message + ' (억제)');
      return;
    }
    if (this.suppressedLinkLogs > 0) {
      const secs = Math.round((now - this.lastLinkLogAt) / 1000);
      log.info(`[gateway] 직전 ${secs}s 동안 링크 이벤트 ${this.suppressedLinkLogs}건 억제됨`);
      this.suppressedLinkLogs = 0;
    }
    this.lastLinkLogAt = now;
    log.info(message);
  }

  private onConnection(sock: net.Socket, via: string): void {
    this.logLink('[gateway] DLL connected via ' + via);
    // 동시 접속 1개: 이전 소켓 대체.
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sock = sock;
    this.via = via;
    this.connectedAt = Date.now();
    this.lastFrameAt = Date.now();
    this.connectionGeneration += 1;
    this.gotSessionInfo = false;
    // 새 연결은 항상 프리브리지에서 시작한다 — 미션이 붙어 프레임이 와야 live 가 된다.
    this.bridgeAliveAt = 0;

    const decode = makeDecoder();
    sock.on('data', (chunk: Buffer) => {
      // A newer DLL connection may have replaced this socket while already
      // queued data events are still draining. Never let an old generation
      // mutate current telemetry/readiness state.
      if (this.sock !== sock) return;
      let frames: string[];
      try {
        frames = decode(chunk);
      } catch (e) {
        log.error('[gateway] decode error: ' + (e as Error).message);
        sock.destroy();
        return;
      }
      for (const payload of frames) {
        if (this.sock !== sock) break;
        this.onFrame(payload);
      }
    });
    sock.on('error', (e) => log.warn('[gateway] sock error: ' + e.message));
    sock.on('close', () => {
      if (this.sock === sock) {
        this.logLink('[gateway] DLL disconnected');
        this.sock = null;
        this.via = '';
        this.connectedAt = 0;
        this.bridgeAliveAt = 0;
        this.emit('disconnected');
      }
    });

    this.emit('connected', { via });
  }

  private onFrame(payload: string): void {
    let msg: GatewayFrame;
    try {
      msg = JSON.parse(payload) as GatewayFrame;
    } catch {
      log.warn('[gateway] bad JSON frame');
      return;
    }
    this.lastFrameAt = Date.now();
    // hello 는 DLL 이 붙었다는 뜻일 뿐 미션 SQF 가 살아 있다는 증거가 아니다 —
    // 브리지 생존 표시는 실제로 애드온이 만들어 보내는 프레임에서만 갱신한다.
    switch (msg.type) {
      case 'hello':
        this.logLink('[gateway] hello from DLL ' + (msg.ver ?? '?'));
        this.emit('hello', msg);
        break;
      case 'sessionInfo':
        this.gotSessionInfo = true;
        this.bridgeAliveAt = Date.now();
        this.emit('sessionInfo', msg);
        break;
      case 'telemetry':
        this.bridgeAliveAt = Date.now();
        this.emit('telemetry', msg);
        break;
      case 'execResult':
        this.bridgeAliveAt = Date.now();
        this.emit('execResult', msg);
        break;
      case 'heartbeat':
        this.bridgeAliveAt = Date.now();
        this.emit('heartbeat', msg);
        break;
      default:
        log.warn('[gateway] unknown frame type: ' + String(msg.type));
    }
  }

  isConnected(): boolean {
    if (!this.sock || this.sock.destroyed) return false;
    // half-open 방어: staleAfterMs 이상 무수신이면 죽은 링크로 간주해
    // exec 가 풀 타임아웃을 소모하지 않게 한다(sweep 이 곧 destroy).
    return Date.now() - this.lastFrameAt < this.cfg.link.staleAfterMs;
  }

  /** 마지막 프레임 수신 후 경과(ms). 연결 없으면 -1. */
  lastFrameAgeMs(): number {
    if (!this.sock || this.sock.destroyed) return -1;
    return Date.now() - this.lastFrameAt;
  }

  connectedForMs(): number {
    return this.connectedAt ? Date.now() - this.connectedAt : 0;
  }

  connectedVia(): string {
    return this.via;
  }

  getListenerState(): ListenerState {
    return this.listenerState;
  }

  /** Monotonic generation of accepted DLL connections. */
  generation(): number {
    return this.connectionGeneration;
  }

  /** Whether sessionInfo has arrived on the current DLL connection. */
  sessionInfoReceived(): boolean {
    return this.isConnected() && this.gotSessionInfo;
  }

  /**
   * 링크 단계 — 운영자가 "소켓은 붙었는데 미션이 없음"과 "아무것도 없음"을 구분할 수 있게.
   * none: 소켓 없음 / pre-bridge: DLL 은 붙었으나 미션 SQF 가 아직 없음 /
   * live: 브리지 프레임 수신 중 / stale: 살아 있었는데 조용해짐(곧 sweep 이 끊는다).
   */
  linkPhase(): 'none' | 'pre-bridge' | 'live' | 'stale' {
    if (!this.sock || this.sock.destroyed) return 'none';
    if (this.bridgeAliveAt === 0) return 'pre-bridge';
    return this.isConnected() ? 'live' : 'stale';
  }

  /** 게임으로 프레임 1개 전송. 라이브 소켓 없거나 stale 이면 false. */
  send(obj: Record<string, unknown>): boolean {
    if (!this.isConnected()) return false;
    if (!this.sock || this.sock.destroyed) return false;
    try {
      this.sock.write(encode(JSON.stringify(obj)));
      return true;
    } catch (e) {
      log.warn('[gateway] send failed: ' + (e as Error).message);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers = [];
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {
        /* ignore */
      }
      this.sock = null;
      this.gotSessionInfo = false;
    }
    const servers = this.servers;
    this.servers = [];
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolve) => {
            try {
              srv.close(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
  }
}
