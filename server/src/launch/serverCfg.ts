// serverCfg.ts — 데디케이트 서버 server.cfg 생성 + 미션 MPMissions 배치.
//
// server.cfg 는 매 런치 재생성한다(writeAutotestCfg 와 같은 철학 — 수동 편집 금지).
// 데디 서버는 <서버 exe 폴더>\MPMissions 의 template(폴더/PBO 이름)만 읽으므로
// 미션 폴더를 거기로 복사한다. 게임 폴더 쓰기 권한이 없으면 디렉토리 정션(mklink /J,
// 관리자 불필요)으로 폴백하고, 그래도 실패하면 침묵하지 않고 행동 지침과 함께 실패시킨다.

import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { splitBattlEyeLines } from './battlEye.js';
import { autoSlotCfgLines, type AutoSlotEntry } from './autoSlot.js';

export interface ServerCfgOptions {
  hostname: string;
  password: string; // '' 이면 라인 생략
  adminPassword: string;
  maxPlayers: number;
  template: string; // "<name>.<world>" — MPMissions 하위 폴더/PBO 이름
  autoInit: boolean; // true 면 persistent=1 (-autoInit 과 세트로 즉시 미션 시작)
  /** true 면 LAN 모드. 이 PC 의 클라만 붙고 같은 Steam ID 클라 여럿이 Steam 티켓 검사에 걸리지 않는다. */
  loopback?: boolean;
  /**
   * 주면 서버가 로비 역할을 배정한다: skipLobby = 1 과 OnAutoSelectRole 훅(autoSlot.ts).
   * 빈 배열이면 훅은 모든 클라를 서버 기본 배정에 맡기고 줄만 남긴다.
   */
  autoSlot?: readonly AutoSlotEntry[];
  /** BattlEye 를 정하는 줄은 넣지 않는다. server.cfg 의 BattlEye 는 0 하나다. */
  extraCfgLines?: string[];
}

/** server.cfg 본문 생성(순수 함수). */
export function buildServerCfg(opts: ServerCfgOptions): string {
  const esc = (s: string): string => s.replace(/"/g, '""');
  const lines: string[] = [
    '// arma-mcp generated — 멀티플레이 테스트용. 수동 편집 금지(런치마다 재생성).',
    `hostname = "${esc(opts.hostname)}";`,
  ];
  if (opts.password) lines.push(`password = "${esc(opts.password)}";`);
  lines.push(
    `passwordAdmin = "${esc(opts.adminPassword)}";`,
    `maxPlayers = ${opts.maxPlayers};`,
    `persistent = ${opts.autoInit ? 1 : 0};`,
    'verifySignatures = 0;', // 로컬 모드 서명 검사 생략(테스트 전용)
    // 한 PC 의 로컬 클라는 모두 같은 Steam ID 다. 둘째 클라가 첫 클라를 밀어내지 않게 한다.
    'kickDuplicate = 0;',
    'BattlEye = 0;',
    'allowedFilePatching = 2;',
    'disableVoN = 1;',
    'upnp = 0;',
  );
  // kickDuplicate = 0 만으로는 둘째 클라가 "Same Steam user already in game" 으로 Steam 티켓 검사에 걸린다.
  if (opts.loopback) lines.push('loopback = true;');
  lines.push(
    'class Missions',
    '{',
    '    class MCPTest',
    '    {',
    `        template = "${esc(opts.template)}";`,
    '        difficulty = "Regular";',
    '    };',
    '};',
  );
  if (opts.autoSlot) lines.push(...autoSlotCfgLines(opts.autoSlot));
  if (opts.extraCfgLines?.length) lines.push(...splitBattlEyeLines(opts.extraCfgLines).kept);
  return lines.join('\n') + '\n';
}

/** server.cfg 를 ~/.arma-mcp/server/server.cfg 에 기록하고 경로 반환. */
export function writeServerCfg(text: string, dir = path.join(homedir(), '.arma-mcp', 'server')): string {
  mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'server.cfg');
  writeFileSync(cfgPath, text, 'utf8');
  return cfgPath;
}

export interface DeployResult {
  ok: boolean;
  template: string;
  deployedPath: string;
  method?: 'copy' | 'junction' | 'in-place';
  error?: string;
}

/**
 * 언팩 미션 폴더를 MPMissions 로 배치. template = 폴더명("<name>.<world>").
 * copy 실패(EPERM/EACCES) 시 정션 폴백, 그것도 실패하면 명시 에러.
 */
export function deployMissionToMpMissions(
  missionPath: string,
  mpMissionsDir: string,
  /** MPMissions 안의 이름. 기본은 미션 폴더 이름이다. 스택은 이름을 달리 준다. */
  templateName?: string,
): DeployResult {
  const template = templateName ?? path.basename(missionPath);
  const resolvedMpDir = path.resolve(mpMissionsDir || '.');
  const source = path.resolve(missionPath);
  const dest = path.join(resolvedMpDir, template);
  const fail = (error: string): DeployResult => ({ ok: false, template, deployedPath: dest, error });

  if (!mpMissionsDir) return fail('MPMissions 경로를 결정하지 못함(serverExePath/mp.mpMissionsDir 설정 필요)');
  if (!existsSync(source)) return fail(`미션 경로 없음: ${source}`);
  if (path.dirname(dest) !== resolvedMpDir) return fail('안전하지 않은 미션 template 경로');

  try {
    mkdirSync(resolvedMpDir, { recursive: true });
  } catch (e) {
    return fail(`MPMissions 폴더 생성 실패: ${(e as Error).message} — 게임 폴더 쓰기 권한 부여 또는 mp.mpMissionsDir 재설정 필요`);
  }

  // 소스가 이미 MPMissions의 최종 위치이거나 그 위치를 가리키는 정션이면 복사하지 않는다.
  try {
    if (
      samePath(source, dest) ||
      (existsSync(dest) && samePath(realpathSync(source), realpathSync(dest)))
    ) {
      return { ok: true, template, deployedPath: dest, method: 'in-place' };
    }
  } catch {
    // 깨진 정션 등은 아래의 staged replacement가 정리한다.
  }

  // 소스 전체를 먼저 같은 부모의 staging 경로에 복사한 뒤 교체한다. 기존
  // destination에 바로 덮어쓰지 않으므로 소스에서 삭제된 stale 파일이 남지 않고,
  // 복사 도중 실패해도 마지막 정상 배치를 보존한다.
  const staging = path.join(
    resolvedMpDir,
    `.${template}.arma-mcp-tmp-${process.pid}-${Date.now()}-${nextDeployId++}`,
  );
  try {
    cpSync(source, staging, { recursive: true, force: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    return { ok: true, template, deployedPath: dest, method: 'copy' };
  } catch (e) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') {
      return fail(`미션 복사 실패: ${(e as Error).message}`);
    }
  }

  // 권한 폴백: 디렉토리 정션(관리자 불필요). 기존 잔여물은 제거 시도.
  try {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    execFileSync('cmd', ['/c', 'mklink', '/J', dest, source], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return { ok: true, template, deployedPath: dest, method: 'junction' };
  } catch (e) {
    return fail(
      `MPMissions 쓰기 권한 없음(copy·junction 모두 실패: ${(e as Error).message}) — ` +
        '게임 폴더 권한 부여 또는 config 의 mp.mpMissionsDir 를 쓰기 가능한 경로로 설정 필요',
    );
  }
}

let nextDeployId = 1;

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}
