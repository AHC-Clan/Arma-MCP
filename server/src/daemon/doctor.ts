// doctor.ts — 연결이 안 될 때 사람이 손으로 치던 진단을 한 번에 출력한다.
//
// MCP transport 모드가 아니므로 stdout 을 써도 된다. 단 main() 이 console.* 을 stderr 로
// 돌려놓기 때문에 반드시 process.stdout.write 로 직접 쓴다.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import {
  resolveConfigPath,
  resolveMcpEndpoint,
  resolveMcpTokenFile,
  resolveStateDir,
} from '../config.js';
import { tryLoadMcpToken } from './token.js';
import {
  autostartSuppressed,
  compareVersions,
  isPipeBusy,
  isPortOpen,
  legacyOwnerPids,
  logTail,
  probeDaemon,
  type DaemonProbe,
} from './autostart.js';
import { ARMA_MCP_VERSION } from '../version.js';

interface Verdict {
  state: string;
  action: string;
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function section(title: string): void {
  out();
  out(`── ${title} ─────────────────────────────`.slice(0, 60));
}

function describeProbe(probe: DaemonProbe): string {
  switch (probe.kind) {
    case 'healthy':
      return `daemon ${probe.version} 응답`;
    case 'legacy-pipe':
      return 'pre-0.3 서버가 게임 파이프 점유';
    case 'listening':
      return '누군가 포트를 열고 있으나 token 이 없어 확인 불가';
    case 'unauthorized':
      return 'daemon 이 있으나 bearer token 불일치(401)';
    case 'foreign':
      return `Arma-MCP 가 아닌 서비스가 응답(HTTP ${probe.status})`;
    case 'none':
      return '아무도 듣고 있지 않음';
  }
}

function verdictFor(probe: DaemonProbe, suppressed: boolean): Verdict {
  switch (probe.kind) {
    case 'healthy': {
      const diff = compareVersions(ARMA_MCP_VERSION, probe.version);
      if (diff === 0) return { state: '정상', action: '조치 불필요.' };
      if (diff > 0) {
        return {
          state: `구버전 daemon ${probe.version} 실행 중`,
          action: '다음 연결에서 relay 가 자동으로 교체한다. 기다리거나 다시 연결하면 된다.',
        };
      }
      return {
        state: `이 번들(${ARMA_MCP_VERSION})이 daemon ${probe.version} 보다 낮다`,
        action: '이 컴퓨터의 플러그인을 업데이트한다.',
      };
    }
    case 'legacy-pipe':
      return {
        state: 'pre-0.3 서버가 게임 파이프를 점유해 daemon 이 뜨지 못한다',
        action:
          '플러그인 업데이트 전에 열어둔 에이전트 세션을 닫거나 위 PID 를 종료한 뒤 다시 연결한다.',
      };
    case 'unauthorized':
      return {
        state: '실행 중인 daemon 과 token 이 다르다',
        action: 'daemon 을 종료하거나 ARMA_MCP_TOKEN 을 그 daemon 의 값으로 맞춘다.',
      };
    case 'foreign':
      return {
        state: '다른 서비스가 MCP 포트를 쓰고 있다',
        action: 'mcp.port 를 바꾸거나 그 서비스를 종료한다.',
      };
    case 'listening':
      return {
        state: '포트는 열려 있는데 token 을 못 읽었다',
        action: 'token 파일 경로를 확인하거나 ARMA_MCP_TOKEN 을 설정한다.',
      };
    case 'none':
      return suppressed
        ? {
            state: 'daemon 미기동이고 자동 기동이 억제돼 있다',
            action:
              'ARMA_MCP_NO_AUTOSTART 를 지우거나(로컬 사용), 원격이라면 SSH 터널을 먼저 연결한다.',
          }
        : {
            state: 'daemon 미기동',
            action: '다음 연결에서 relay 가 자동으로 띄운다. 조치 불필요.',
          };
  }
}

/** 연결 실패를 사람이 읽을 수 있는 한 화면으로 요약한다. */
export async function runDoctor(cfg: Config): Promise<void> {
  const endpoint = resolveMcpEndpoint(cfg);
  const tokenFile = resolveMcpTokenFile(cfg);
  const dir = resolveStateDir(cfg);
  const token = tryLoadMcpToken(cfg);
  const suppressed = autostartSuppressed();

  out(`Arma-MCP doctor ${ARMA_MCP_VERSION}`);
  out(`entry   : ${process.argv[1] ?? '(unknown)'}`);
  const configPath = resolveConfigPath();
  out(`config  : ${configPath}${existsSync(configPath) ? '' : ' (파일 없음, 기본값 사용)'}`);
  out(`state   : ${dir}`);

  section('game pipe');
  const pipeBusy = isPipeBusy(cfg.pipeName);
  out(`${cfg.pipeName} — ${pipeBusy ? '점유됨' : '비어 있음'}`);
  if (pipeBusy) {
    const pids = await legacyOwnerPids();
    out(
      pids.length
        ? `pre-0.3 후보 프로세스: ${pids.join(', ')}`
        : 'pre-0.3 후보 프로세스: 없음(0.3.x daemon 이 정상 소유 중일 수 있다)',
    );
  }

  section('mcp endpoint');
  const probe = await probeDaemon(endpoint, token, cfg.pipeName);
  out(`${endpoint.href} — ${describeProbe(probe)}`);
  if (probe.kind === 'legacy-pipe' && probe.pids.length) {
    out(`점유 PID: ${probe.pids.join(', ')}`);
  }

  section('web endpoint');
  const webUrl = new URL(`http://127.0.0.1:${cfg.web.port}`);
  const webOpen = cfg.web.enabled ? await isPortOpen(webUrl) : false;
  out(
    cfg.web.enabled
      ? `${webUrl.origin} — ${webOpen ? 'LISTENING' : '응답 없음'}`
      : 'web.enabled=false — 사용 안 함',
  );

  section('auth / env');
  out(`token file : ${tokenFile} — ${existsSync(tokenFile) ? '있음' : '없음'}`);
  out(`ARMA_MCP_TOKEN          : ${process.env.ARMA_MCP_TOKEN ? '설정됨' : '미설정'}`);
  out(`ARMA_MCP_NO_AUTOSTART   : ${process.env.ARMA_MCP_NO_AUTOSTART ?? '미설정'}`);
  out(`자동 기동 : ${suppressed ? '억제됨' : '가능'}`);

  for (const name of ['daemon.log', 'relay.log']) {
    const file = path.join(dir, name);
    section(name);
    const tail = logTail(file, 12);
    out(tail || `(${existsSync(file) ? '비어 있음' : '파일 없음'})`);
  }

  const verdict = verdictFor(probe, suppressed);
  section('판정');
  out(`상태: ${verdict.state}`);
  out(`조치: ${verdict.action}`);
}
