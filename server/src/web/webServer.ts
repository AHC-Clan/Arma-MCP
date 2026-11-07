// webServer.ts — LAN 웹 게시: 정적 서빙 + SSE 라이브 리로드.
//
// 목적: 에이전트가 생성한 HTML 을 멀티플레이 전 인원의 브라우저에 띄우고,
// 재게시 시 접속 중인 모든 브라우저를 동시에 갱신한다.
//
// 설계:
//  - 리로드 트리거는 publish() 호출이 아니라 fs.watch(webroot). 다중 MCP 클라이언트 세션
//    (포트를 못 쥔 세션이 publish 해도 포트 소유 세션이 리로드를 대행)과 Edit 툴로
//    webroot 파일을 직접 수정하는 워크플로를 세션 간 조율 없이 해결한다.
//  - SSE(EventSource)만 사용 — 자동 재접속이 내장이라 ws 의존성이 필요 없다.
//  - EADDRINUSE 는 gateway 와 동일하게 비치명: port-busy 상태로 5s 재시도.
//    publish 는 리스너 상태와 무관하게 파일을 쓴다.

import http from 'node:http';
import {
  promises as fsp,
  mkdirSync,
  existsSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import type { Config } from '../config.js';

const RETRY_MS = 5000;
const DEBOUNCE_MS = 150;
const SSE_PING_MS = 20000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

// 브라우저 쪽 리로드 클라이언트. 서빙 시 HTML 의 </body> 앞에 주입된다.
// onerror→onopen 시퀀스(=서버 재시작 후 재접속)에서 리로드해 놓친 갱신을 회수한다.
const RELOAD_SCRIPT =
  '<script>/* arma-mcp live reload (injected) */(function(){' +
  "var slug=location.pathname==='/'?'index':location.pathname.replace(/^\\//,'').replace(/\\.html?$/,'');" +
  "var lost=false;var es=new EventSource('/__events');" +
  "es.addEventListener('reload',function(e){try{var d=JSON.parse(e.data);" +
  "if(d.page==='*'||d.page===slug)location.reload();}catch(_){}});" +
  'es.onopen=function(){if(lost)location.reload();};' +
  'es.onerror=function(){lost=true;};' +
  '})();</script>';

export type WebState = 'ok' | 'port-busy' | 'stopped' | 'disabled';

export interface PublishResult {
  file: string;
  url: string;
  isNew: boolean;
  bytes: number;
}

export interface WebStatusInfo {
  state: WebState;
  url: string;
  host: string;
  port: number;
  sseClients: number;
  webRoot: string;
  note?: string;
}

const LOOPBACK_WEB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * LAN IP 선택: IPv4·비internal 주소를 RFC1918 우선순위로 고른다.
 * 192.168.* > 10.* > 172.16-31.* > 기타 — Hyper-V 기본 스위치(172.x)가
 * 실제 공유기 대역(대개 192.168.x)을 밀어내지 않게 한다. 없으면 null.
 */
export function pickLanIp(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    const m = /^172\.(\d+)\./.exec(ip);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
    return 3;
  };
  let best: string | null = null;
  let bestRank = Infinity;
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const r = rank(addr.address);
      if (r < bestRank) {
        best = addr.address;
        bestRank = r;
      }
    }
  }
  return best;
}

export class WebServer {
  private cfg: Config['web'];
  private root: string;
  private server: http.Server | null = null;
  private state: WebState = 'stopped';
  private boundPort: number | null = null;
  private sse = new Set<http.ServerResponse>();
  private watcher: FSWatcher | null = null;
  private pendingChanges = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(web: Config['web'], webRoot: string) {
    this.cfg = web;
    this.root = path.resolve(webRoot);
  }

  webRoot(): string {
    return this.root;
  }

  getState(): WebState {
    return this.state;
  }

  sseClientCount(): number {
    return this.sse.size;
  }

  /** 실제 바인드된 포트(port 0 = 임시 포트 지원). 리슨 전엔 설정값. */
  private effectivePort(): number {
    return this.boundPort ?? this.cfg.port;
  }

  /** host 가 이 PC 전용이고 공개 주소도 없어서 다른 PC 가 이 게시를 못 여는 상태. */
  isLocalOnly(): boolean {
    return !this.cfg.publicBaseUrl.trim() && LOOPBACK_WEB_HOSTS.has(this.cfg.host.trim().toLowerCase());
  }

  /** 접속 기준 URL. publicBaseUrl > 이 PC 전용 host > LAN IP 자동 감지 > 127.0.0.1 폴백(+경고 note). */
  baseUrl(): { url: string; note?: string } {
    const override = this.cfg.publicBaseUrl.trim().replace(/\/+$/, '');
    if (override) return { url: override };
    const port = this.effectivePort();
    if (this.isLocalOnly()) {
      return {
        url: `http://127.0.0.1:${port}`,
        note: '이 PC 에서만 열립니다. 다른 PC 에 보이려면 config web.host 를 0.0.0.0 으로 바꿉니다.',
      };
    }
    const ip = pickLanIp();
    if (ip) return { url: `http://${ip}:${port}` };
    return {
      url: `http://127.0.0.1:${port}`,
      note: 'LAN IP 감지 실패 — 다른 PC 에서 접속하려면 config web.publicBaseUrl 을 설정하세요.',
    };
  }

  pageUrl(page: string): { url: string; note?: string } {
    const base = this.baseUrl();
    return { url: page === 'index' ? base.url + '/' : `${base.url}/${page}`, note: base.note };
  }

  statusInfo(): WebStatusInfo {
    const base = this.baseUrl();
    return {
      state: this.state,
      url: base.url,
      host: this.cfg.host,
      port: this.effectivePort(),
      sseClients: this.sse.size,
      webRoot: this.root,
      note: base.note,
    };
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.state = 'disabled';
      return;
    }
    mkdirSync(this.root, { recursive: true });
    this.startWatcher();
    this.listen();
    this.pingTimer = setInterval(() => this.pingSse(), SSE_PING_MS);
    this.pingTimer.unref();
  }

  private listen(): void {
    const label = `web http://${this.cfg.host}:${this.cfg.port}`;
    const srv = http.createServer((req, res) => {
      this.onRequest(req, res).catch((e) => {
        log.warn('[web] request error: ' + (e as Error).message);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    srv.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        // 비치명: 다른 세션이 포트를 쥐고 있을 수 있다(webroot 공유로 기능은 유지).
        this.state = 'port-busy';
        log.warn(`[web] ${label} 사용 중 — port-busy, ${RETRY_MS}ms 후 재시도`);
        try {
          srv.close();
        } catch {
          /* ignore */
        }
        if (this.server === srv) this.server = null;
        this.retryTimer = setTimeout(() => this.listen(), RETRY_MS);
        this.retryTimer.unref();
      } else {
        log.error(`[web] server error (${label}): ${e.message}`);
      }
    });
    srv.listen(this.cfg.port, this.cfg.host, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') this.boundPort = addr.port;
      this.state = 'ok';
      log.info('[web] listening on ' + label);
    });
    this.server = srv;
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        this.pendingChanges.add(String(filename).replace(/\\/g, '/'));
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.flushChanges(), DEBOUNCE_MS);
      });
      this.watcher.on('error', (e) => log.warn('[web] watcher error: ' + e.message));
    } catch (e) {
      log.warn('[web] fs.watch 실패 — 라이브 리로드 비활성: ' + (e as Error).message);
    }
  }

  private flushChanges(): void {
    const changed = [...this.pendingChanges];
    this.pendingChanges.clear();
    if (changed.length === 0) return;
    const allHtml = changed.every((f) => /\.html?$/i.test(f));
    if (allHtml) {
      // 페이지별 리로드: 해당 페이지를 보고 있는 브라우저만 갱신.
      for (const f of changed) {
        this.broadcastReload(f.replace(/\.html?$/i, ''));
      }
    } else {
      // 자산(css/img/js)이 섞이면 어느 페이지가 참조하는지 추적하지 않고 전체 리로드.
      this.broadcastReload('*');
    }
  }

  private broadcastReload(page: string): void {
    const payload = `event: reload\ndata: ${JSON.stringify({ page })}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(payload);
      } catch {
        /* close 핸들러가 정리 */
      }
    }
    if (this.sse.size > 0) log.debug(`[web] reload broadcast page=${page} clients=${this.sse.size}`);
  }

  private pingSse(): void {
    for (const res of this.sse) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * HTML 을 webroot 에 기록. 리로드는 fs.watch 가 브로드캐스트한다.
   * 리스너 상태와 무관하게 동작(포트를 쥔 다른 세션이 서빙을 대행할 수 있음).
   */
  publish(page: string, html: string): PublishResult {
    if (!SLUG_RE.test(page)) {
      throw new Error(`invalid page slug '${page}' (요구 형식: ${SLUG_RE.source})`);
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html too large: ${bytes} bytes (max ${MAX_HTML_BYTES})`);
    }
    mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, `${page}.html`);
    const isNew = !existsSync(file);
    // sync IO 인 이유: 툴 호출당 1회의 소량 기록이고, isNew 판정과 기록 사이의
    // 레이스를 없앤다.
    writeFileSync(file, html, 'utf8');
    return { file, url: this.pageUrl(page).url, isNew, bytes };
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (rawPath === '/__events') {
      this.onSse(res);
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      this.notFound(res);
      return;
    }
    if (pathname.includes('\0')) {
      this.notFound(res);
      return;
    }

    const rel = pathname.replace(/^\/+/, '');
    // 확장자 없는 경로는 페이지 요청: <slug>.html → <slug>/index.html 순으로 탐색.
    const candidates =
      rel === ''
        ? ['index.html']
        : path.posix.basename(rel).includes('.')
          ? [rel]
          : [`${rel}.html`, `${rel}/index.html`];

    for (const cand of candidates) {
      const abs = path.resolve(this.root, cand);
      if (abs !== this.root && !abs.startsWith(this.root + path.sep)) continue; // traversal
      let real: string;
      try {
        real = await fsp.realpath(abs);
      } catch {
        continue; // 없음
      }
      // 심링크로 webroot 밖을 가리키는 파일 차단.
      const realRoot = await fsp.realpath(this.root);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;

      const st = await fsp.stat(real);
      if (!st.isFile()) continue;
      await this.serveFile(res, real, method === 'HEAD');
      return;
    }
    this.notFound(res);
  }

  private async serveFile(res: http.ServerResponse, file: string, headOnly: boolean): Promise<void> {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    let body = await fsp.readFile(file);

    if (ext === '.html' || ext === '.htm') {
      const text = body.toString('utf8');
      const lower = text.toLowerCase();
      const at = lower.lastIndexOf('</body>');
      const injected =
        at >= 0
          ? text.slice(0, at) + RELOAD_SCRIPT + text.slice(at)
          : text + RELOAD_SCRIPT;
      body = Buffer.from(injected, 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(headOnly ? undefined : body);
  }

  private onSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    this.sse.add(res);
    res.on('close', () => this.sse.delete(res));
  }

  private notFound(res: http.ServerResponse): void {
    // 존재 여부·거부 사유를 구분하지 않는다(경로 탐색에 정보를 주지 않음).
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = this.debounceTimer = this.pingTimer = null;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    for (const res of this.sse) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.sse.clear();
    const srv = this.server;
    this.server = null;
    if (srv) {
      await new Promise<void>((resolve) => {
        try {
          srv.closeAllConnections?.();
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
}
