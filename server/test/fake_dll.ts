// fake_dll.ts — Arma 없이 서버를 테스트하는 모의 DLL 클라이언트.
//
// MCP 서버(소켓 서버)에 클라이언트로 접속해 hello/sessionInfo/telemetry 를 보내고,
// exec 프레임에 패턴별로 응답한다.
//
// 사용:
//   tsx test/fake_dll.ts                      # 기본 pipe 접속
//   tsx test/fake_dll.ts --tcp 127.0.0.1 5301 # TCP 접속
//   tsx test/fake_dll.ts --machines server,Alice  # all 모드 다중 결과 시뮬
//   tsx test/fake_dll.ts --no-telemetry
//   tsx test/fake_dll.ts --reconnect          # 20s 마다 끊고 재접속(미션 재시작 시뮬)
//   tsx test/fake_dll.ts --no-tacmap          # AHC_TacticalMap 미로드 시뮬
//   tsx test/fake_dll.ts --pipe <이름> --pid 1111 --tag A  # 스택 파이프에 붙는 게임 흉내.
//     hello 에 pid 를 싣고, world 와 mission 이 태그가 되며, mcp_whoami 를 담은 exec 에 태그로 답한다.

import net from 'node:net';
import { encode, makeDecoder } from '../src/ipc/frame.js';

interface Args {
  pipe: string;
  tcp?: { host: string; port: number };
  machines: string[];
  telemetry: boolean;
  reconnect: boolean;
  /** false 면 sessionInfo 의 tacmap/tacmapZeusTool 을 0 으로 보낸다(TacMap 부재 경로 탐색용). */
  tacmap: boolean;
  /** hello 에 실을 pid. 없으면 싣지 않는다(0.5 이전 DLL 흉내). */
  pid?: number;
  /** 스택 구분용 표시. world 와 mission 이 되고 mcp_whoami 에 답한다. */
  tag?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = {
    pipe: process.env.ARMA_MCP_PIPE ?? '\\\\.\\pipe\\arma_mcp',
    machines: ['server'],
    telemetry: true,
    reconnect: false,
    tacmap: true,
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--tcp') {
      out.tcp = { host: a[++i] ?? '127.0.0.1', port: Number(a[++i] ?? 5301) };
    } else if (a[i] === '--machines') {
      out.machines = (a[++i] ?? 'server').split(',');
    } else if (a[i] === '--no-telemetry') {
      out.telemetry = false;
    } else if (a[i] === '--reconnect') {
      out.reconnect = true;
    } else if (a[i] === '--no-tacmap') {
      out.tacmap = false;
    } else if (a[i] === '--pipe') {
      out.pipe = a[++i] ?? out.pipe;
    } else if (a[i] === '--pid') {
      out.pid = Number(a[++i]);
    } else if (a[i] === '--tag') {
      out.tag = a[++i];
    }
  }
  return out;
}

function fakeResult(code: string, tag?: string): string {
  const c = code.trim();
  if (/mcp_whoami/.test(c)) return `STRING: "${tag ?? 'untagged'}"`;
  if (c === '1+1' || c === '1 + 1') return 'SCALAR: 2';
  if (/^sleep/i.test(c)) return '__SLEEP__'; // 타임아웃 경로용 마커
  if (/throwme/i.test(c)) return 'ERROR: aborted (see RPT)';
  if (/nilplease/i.test(c)) return "<nil> (if unexpected, check RPT for 'Error in expression')";
  // arma_watch 조립 SQF. 인게임 루프를 흉내내지는 않고 최종 ack 형태만 되돌려준다 —
  // 서버측 조립·파싱 경로가 종단으로 도는지 확인하는 게 목적이다.
  // 사용자 조건식이 문자열 리터럴로 박혀 들어오므로 아래의 코드 패턴 분기들보다 먼저 본다.
  // arma_zeus_* 조립 SQF. 사용자 query 가 문자열 리터럴로 박혀 들어오므로 일반 패턴보다 먼저 본다.
  // Zeus 플레이어가 없는 데디 서버를 흉내낸다. find 는 2쪽으로 나눠 페이지 경로까지 돈다.
  if (c.endsWith('[isMultiplayer, isDedicated, _z]')) return 'ARRAY: [true,true,[]]';
  if (/AHC_MCP_zm deleteAt/.test(c)) return 'ARRAY: ["OK",false,false,0,false,false,""]';
  if (/addCuratorEditableObjects/.test(c)) return 'ARRAY: ["OK",1]';
  if (/isCuratorModuleGroup/.test(c)) {
    return 'ARRAY: ["OK","ModuleLightning_F","Lightning Bolt","Effects","2:77",[100,200],0,""]';
  }
  if (/"DRY", _cls/.test(c)) {
    return 'ARRAY: ["DRY","ModuleLightning_F","Lightning Bolt","Effects","",[100,200],0,""]';
  }
  if (/getVariable \["AHC_MCP_pg", createHashMap\]\) getOrDefault/.test(c)) {
    return 'ARRAY: [2,[["unit","2:2","Rifleman","Rifleman","B_Soldier_F","Bob","","Alpha 1-1","","WEST","045123",4512,1234,0,"",40,-1]]]';
  }
  if (/AHC_MCP_zp/.test(c)) {
    return 'ARRAY: [1,1,[["module","ModuleLightning_F","Lightning Bolt","Effects","",0,60]],["English",false,false]]';
  }
  if (/allMissionObjects "Module_F"|curatorSelected/.test(c)) {
    return 'ARRAY: [2,2,[["unit","2:1","Rifleman","Rifleman","B_Soldier_F","Alice","","Alpha 1-1","","WEST","045123",4500,1230,2,"",60,-1]],["English",false,false]]';
  }

  if (/AHC_MCP_watch/.test(c)) {
    if (!/deleteAt/.test(c)) return 'STRING: "OK:1"'; // 정지 신호 경로
    // 조건이 참인 상태를 흉내낸다: 1틱 만에 met, 샘플 2건.
    return 'STRING: "WATCH|met|1|120|2|0|SCALAR: 1 ~ SCALAR: 2"';
  }

  // arma_exec.verify 래핑. 본문/증거를 길이 접두 프레임으로 돌려준다.
  if (/MCPV\|/.test(c)) {
    const main = 'BOOL: true';
    const ack = /round allUnits/.test(c) ? 'ERROR: aborted (see RPT)' : 'SCALAR: 12';
    return `STRING: "MCPV|30|${main.length}|${main}${ack}"`;
  }

  if (/count allunits/i.test(c)) return 'SCALAR: 12';

  // arma_tacmap_* 조립 SQF. 모두 문자열 ack 로 끝나므로 STRING 으로 흉내낸다.
  if (/AHC_TacticalMap_host/.test(c)) return 'STRING: "|8088|1"';
  if (/AHC_TacticalMap_fnc_cheatZeusTitle/.test(c)) {
    return /CBA_fnc_targetEvent/.test(c) ? 'STRING: "OK:3"' : 'STRING: "OK:all"';
  }
  const mark = /"(mcp_mark_[a-z0-9][a-z0-9_-]*)"/.exec(c);
  if (mark) {
    if (!/createMarker/.test(c)) return `STRING: "OK:${mark[1]}"`; // remove 경로
    // 지휘관 좌석은 비어 있는 것으로 흉내낸다(핑 게이트 경로가 실제로 드러나게).
    const ping = /AHC_TacticalMap_fnc_cheatPing/.test(c) ? 'no-commander' : 'skip';
    return `STRING: "OK:${mark[1]}|042073|${ping}"`;
  }
  if (/mcp_mark_/.test(c)) return 'STRING: "OK:2"';

  return 'STRING: "ok"';
}

function connect(args: Args): void {
  const onConnect = (sock: net.Socket): void => {
    log('connected to server');
    const decode = makeDecoder();

    const send = (obj: Record<string, unknown>): void => {
      sock.write(encode(JSON.stringify(obj)));
    };

    // 1) hello 즉시.
    send({
      v: 1,
      type: 'hello',
      role: 'arma-ext',
      ver: 'FakeDLL 0.3.8',
      ...(args.pid ? { pid: args.pid } : {}),
    });
    // 2) sessionInfo.
    send({
      v: 1,
      type: 'sessionInfo',
      world: args.tag ?? 'Altis',
      mission: args.tag ? `co40_fake_${args.tag}` : 'co40_fake',
      briefing: 'Fake Operation',
      server: 'FAKE',
      dedicated: 0,
      multiplayer: 1,
      cba: 1,
      ace: 1,
      aceVersion: '3.21.0.110',
      aceComponents: ['ace_common', 'ace_medical', 'ace_medical_treatment', 'ace_interaction', 'ace_cargo'],
      tacmap: args.tacmap ? 1 : 0,
      tacmapZeusTool: args.tacmap ? 1 : 0,
      t: 0,
    });

    // 3) 텔레메트리 주기.
    let telemetryTimer: NodeJS.Timeout | null = null;
    if (args.telemetry) {
      let tick = 0;
      const pushTelemetry = (reqId = ''): void => {
        tick += 1;
        send({
          v: 1,
          type: 'telemetry',
          reqId,
          world: args.tag ?? 'Altis',
          mission: args.tag ? `co40_fake_${args.tag}` : 'co40_fake',
          briefing: 'Fake Operation',
          time: 100 + tick,
          date: [2035, 7, 6, 14, 30],
          fps: 48.5,
          fpsMin: 31.2,
          scripts: [4, 1, 0, 2],
          // 플레이어가 연 서버(dedicated 0)라 창 상태도 보낸다.
          paused: 0,
          focused: 1,
          players: [
            ['Alice', 'WEST', '76561198000000001', 1],
            ['Bob', 'WEST', '76561198000000002', 1],
          ],
          playerCount: 2,
          t: 100 + tick,
        });
      };
      pushTelemetry();
      telemetryTimer = setInterval(() => pushTelemetry(), 5000);
    }

    sock.on('data', (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = decode(chunk);
      } catch (e) {
        log('decode error: ' + (e as Error).message);
        sock.destroy();
        return;
      }
      for (const payload of frames) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(payload);
        } catch {
          continue;
        }
        if (msg.type === 'exec') {
          const reqId = String(msg.reqId ?? '');
          const code = String(msg.code ?? '');
          const result = fakeResult(code, args.tag);
          log(`exec reqId=${reqId} mode=${msg.mode} code=${JSON.stringify(code)}`);
          if (result === '__SLEEP__') {
            // 응답을 늦게 보내 타임아웃을 유발.
            setTimeout(() => {
              for (const m of args.machines) {
                send({ v: 1, type: 'execResult', reqId, machine: m, result: 'SCALAR: 0', t: 0 });
              }
            }, 10000);
          } else {
            for (const m of args.machines) {
              send({ v: 1, type: 'execResult', reqId, machine: m, result, t: 0 });
            }
          }
        } else if (msg.type === 'telemetryRequest') {
          const reqId = String(msg.reqId ?? '');
          send({
            v: 1,
            type: 'telemetry',
            reqId,
            world: args.tag ?? 'Altis',
            mission: args.tag ? `co40_fake_${args.tag}` : 'co40_fake',
            time: 200,
            date: [2035, 7, 6, 14, 30],
            fps: 50,
            fpsMin: 31.2,
            scripts: [4, 1, 0, 2],
            paused: 0,
            focused: 1,
            // 주기 push 와 같은 로스터 — expectN 유도가 요청 경로에서만 다른 값을
            // 보면 조기완료로 결과가 유실된다.
            players: [
              ['Alice', 'WEST', '76561198000000001', 1],
              ['Bob', 'WEST', '76561198000000002', 1],
            ],
            playerCount: 2,
            hcCount: 0,
            t: 200,
          });
        }
      }
    });

    sock.on('close', () => {
      log('disconnected');
      if (telemetryTimer) clearInterval(telemetryTimer);
      if (args.reconnect) {
        setTimeout(() => connect(args), 1500);
      } else {
        process.exit(0);
      }
    });
    sock.on('error', (e) => log('sock error: ' + e.message));

    if (args.reconnect) {
      setTimeout(() => {
        log('reconnect: dropping socket');
        sock.destroy();
      }, 20000);
    }
  };

  let sock: net.Socket;
  if (args.tcp) {
    sock = net.connect(args.tcp.port, args.tcp.host, () => onConnect(sock));
  } else {
    sock = net.connect(args.pipe, () => onConnect(sock));
  }
  sock.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      log('서버 미기동 — 1.5s 후 재시도');
      setTimeout(() => connect(args), 1500);
    } else {
      log('connect error: ' + e.message);
    }
  });
}

function log(msg: string): void {
  process.stderr.write(`[fake_dll] ${msg}\n`);
}

connect(parseArgs());
