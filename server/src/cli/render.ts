// render.ts: 도구 결과를 셸 출력으로 바꾼다.
//
// 기본 출력은 사람이 읽는 몇 줄, --raw 는 값만, --json 은 도구 JSON 한 줄이다.
// 여기 함수는 문자열만 만들고 쓰지 않는다. 쓰는 곳은 명령이다.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EXIT, type ExitCode } from './errors.js';

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ImageBlock {
  data: string;
  mimeType: string;
}

export interface ToolPayload {
  isError: boolean;
  /** 마지막 text 블록. 도구는 JSON 한 개를 여기에 싣는다. */
  text: string;
  /** text 를 JSON 으로 읽은 값. 읽지 못하면 undefined. */
  json: unknown;
  images: ImageBlock[];
}

export function readToolResult(result: CallToolResult): ToolPayload {
  let text = '';
  const images: ImageBlock[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') text = block.text;
    else if (block.type === 'image') images.push({ data: block.data, mimeType: block.mimeType });
  }
  let json: unknown;
  try {
    json = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json, images };
}

/** 도구 JSON 을 한 줄로. 데몬이 pretty 로 보내도 한 줄로 다시 쓴다. */
export function jsonLine(payload: ToolPayload, extra: Json = {}): string {
  if (payload.json === undefined) return payload.text.replace(/\r?\n/g, ' ');
  const value =
    isRecord(payload.json) && Object.keys(extra).length > 0
      ? { ...payload.json, ...extra }
      : payload.json;
  return JSON.stringify(value);
}

/**
 * 어느 도구에나 쓰는 종료 코드 판정.
 * lease 를 못 잡았으면 4, 대기가 시간 안에 안 끝났으면 5, 그 밖의 실패는 1 이다.
 */
export function toolExitCode(payload: ToolPayload): ExitCode {
  if (payload.isError) return EXIT.failure;
  const json = payload.json;
  if (!isRecord(json)) return EXIT.ok;
  if (json.ok === false && isRecord(json.busy)) return EXIT.busy;
  if (isRecord(json.wait) && json.wait.timedOut === true) return EXIT.timeout;
  // arma_rpt_wait 는 ok 없이 found 만 준다. error 가 있으면 기다리지도 못한 것이다.
  if (json.found === false) return json.error === undefined ? EXIT.timeout : EXIT.failure;
  if (json.met === false && json.reason === 'timeout') return EXIT.timeout;
  if (json.ok === false) return EXIT.failure;
  return EXIT.ok;
}

/** 12ms, 3.2초, 45초, 3분 5초, 2시간 5분. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}초`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}초`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}분 ${totalSec % 60}초`;
  return `${Math.floor(totalMin / 60)}시간 ${totalMin % 60}분`;
}

/** 유한한 숫자면 그 값, 아니면 NaN. */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

/** 문자열이면 그 값, 아니면 빈 문자열. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 이 명령이 연 cli 세션 하나는 빼고 센다. */
function otherSessions(sessions: unknown): string {
  const byTransport = isRecord(sessions) && isRecord(sessions.byTransport) ? sessions.byTransport : {};
  const parts: string[] = [];
  for (const [kind, raw] of Object.entries(byTransport)) {
    const count = num(raw) - (kind === 'cli' ? 1 : 0);
    if (count > 0) parts.push(`${kind} ${count}`);
  }
  return parts.length > 0 ? `다른 세션 ${parts.join(', ')}` : '다른 세션 없음';
}

function gameLine(status: Json): string {
  const phase = str(status.linkPhase) || (status.dllConnected === true ? 'live' : 'none');
  if (phase === 'none') return 'game     연결 없음';
  if (phase === 'pre-bridge') return 'game     pre-bridge, DLL 은 붙었고 미션이 없다';
  const mission = isRecord(status.mission) ? status.mission : {};
  const parts = [phase];
  if (str(mission.world)) parts.push(str(mission.world));
  if (str(mission.mission)) parts.push(str(mission.mission));
  if (status.dedicatedReady === true) parts.push('데디 준비됨');
  else if (status.bridgeReady === true) parts.push('브리지 준비됨');
  else parts.push('브리지 준비 안 됨');
  return `game     ${parts.join(', ')}`;
}

function processLine(status: Json): string {
  const client = status.armaProcessRunning === true ? '실행 중' : '꺼짐';
  const image = str(status.serverProcessImage);
  const server =
    status.serverProcessRunning === true ? `실행 중${image ? `(${image})` : ''}` : '꺼짐';
  return `process  client ${client}, server ${server}`;
}

/** 실행 lease 한 건을 한 줄로. 예: arma_play, 주인 relay a1b2c3d4, 12초째 */
export function operationText(operation: Json): string {
  const owner = isRecord(operation.owner)
    ? `주인 ${str(operation.owner.transport)} ${str(operation.owner.session)}`
    : '주인 알 수 없음';
  return `${str(operation.operation)}, ${owner}, ${formatDuration(num(operation.elapsedMs))}째`;
}

/**
 * lease 를 못 잡은 결과의 안내. 누가 무엇을 얼마나 돌리고 있는지 알려 준다.
 * busy 가 없으면 null 이다.
 */
export function busyMessage(result: unknown, refused: string): string | null {
  if (!isRecord(result) || !isRecord(result.busy)) return null;
  return `다른 작업이 실행 lease 를 쥐고 있어 ${refused}: ${operationText(result.busy)}.`;
}

function leaseLine(status: Json): string {
  const operation = status.operation;
  if (!isRecord(operation)) return 'lease    없음';
  return `lease    ${operationText(operation)}`;
}

/** arma_status 결과를 4줄, 프로필이 있으면 5줄로 요약한다. */
/**
 * 스택이 default 하나뿐이면 줄을 더하지 않는다. 여럿이면 고른 스택에 * 을 달고
 * 스택마다 포트, 게임 연결 단계, 프로세스 수를 한 줄에 모은다.
 */
function stacksLine(status: Json): string {
  const list = Array.isArray(status.stacks) ? status.stacks.filter(isRecord) : [];
  const selected = str(status.stack) || 'default';
  if (list.length <= 1 && selected === 'default') return '';
  const parts = list.map((s) => {
    const id = str(s.id);
    const procs = Array.isArray(s.processes) ? `${s.processes.length} 프로세스` : '프로세스 모름';
    return `${id === selected ? '*' : ''}${id}(${num(s.port)}, ${str(s.linkPhase) || 'none'}, ${procs})`;
  });
  return `stacks   ${parts.join(', ')}`;
}

export function renderStatus(status: Json): string[] {
  const daemon = isRecord(status.daemon) ? status.daemon : {};
  const version = str(daemon.version) || str(status.daemonVersion);
  const uptime = num(daemon.uptimeMs ?? status.daemonUptimeMs);
  const lines = [
    `daemon   ${version}, 가동 ${formatDuration(uptime)}, ${otherSessions(status.sessions)}`,
    gameLine(status),
    processLine(status),
    leaseLine(status),
  ];
  const wait = isRecord(status.wait) ? status.wait : null;
  if (wait && wait.satisfied === true && str(wait.requested) !== 'none') {
    lines[1] += `, ${formatDuration(num(wait.elapsedMs))} 기다림`;
  }
  const stacks = stacksLine(status);
  if (stacks) lines.push(stacks);
  const profiles = Array.isArray(status.profiles) ? status.profiles.map(String) : [];
  if (str(status.profilesError)) lines.push(`profiles 읽지 못함: ${str(status.profilesError)}`);
  else if (profiles.length > 0) lines.push(`profiles ${profiles.join(', ')}`);
  return lines;
}

/** fn_execRun 이 500자를 넘는 결과 끝에 붙이는 표시. */
export const TRUNCATION_MARK = ' ...(truncated)';

export interface ExecEntry {
  machine: string;
  result: string;
  parsed: { kind: 'value' | 'nil' | 'error'; type?: string; value?: string };
}

export interface RawValue {
  kind: 'value' | 'nil' | 'error';
  text: string;
  truncated: boolean;
}

/**
 * 결과 하나의 값만 꺼낸다. STRING 은 바깥 따옴표를 벗기고 SQF 의 "" 를 " 로 되돌린다.
 * 잘린 STRING 은 닫는 따옴표가 잘려 나갔으므로 여는 따옴표만 벗긴다.
 */
export function rawValue(entry: ExecEntry): RawValue {
  const kind = entry.parsed.kind;
  if (kind === 'nil') return { kind, text: '', truncated: false };
  if (kind === 'error') return { kind, text: entry.result, truncated: false };
  let value = entry.parsed.value ?? entry.result;
  let truncated = false;
  if (value.endsWith(TRUNCATION_MARK)) {
    truncated = true;
    value = value.slice(0, -TRUNCATION_MARK.length);
  }
  if (entry.parsed.type === 'STRING' && value.startsWith('"')) {
    let inner = value.slice(1);
    if (!truncated && inner.endsWith('"')) inner = inner.slice(0, -1);
    value = inner.replace(/""/g, '"');
  }
  return { kind, text: value, truncated };
}

export function execEntries(outcome: Json): ExecEntry[] {
  if (!Array.isArray(outcome.results)) return [];
  return outcome.results.filter(isRecord).map((entry) => {
    const parsed = isRecord(entry.parsed) ? entry.parsed : {};
    const kind = parsed.kind === 'nil' || parsed.kind === 'error' ? parsed.kind : 'value';
    return {
      machine: str(entry.machine),
      result: str(entry.result),
      parsed: {
        kind,
        type: typeof parsed.type === 'string' ? parsed.type : undefined,
        value: typeof parsed.value === 'string' ? parsed.value : undefined,
      },
    };
  });
}

/** rptCursor 를 wait 가 받는 FILE:OFFSET 으로. 커서가 없으면 null. */
export function rptSince(outcome: Json): string | null {
  const cursor = outcome.rptCursor;
  if (!isRecord(cursor) || !str(cursor.file) || !Number.isFinite(num(cursor.offset))) return null;
  return `${str(cursor.file)}:${num(cursor.offset)}`;
}

/**
 * exec 결과의 종료 코드. 실행 실패와 ERROR 결과는 1 이다.
 * RPT 오류 블록이 붙은 nil 도 소프트 오류이므로 1 이다. 블록 없는 nil 은 정상 nil 로 본다.
 */
export function execExitCode(outcome: Json): ExitCode {
  if (outcome.ok !== true) return EXIT.failure;
  const entries = execEntries(outcome);
  if (entries.some((entry) => entry.parsed.kind === 'error')) return EXIT.failure;
  const rptErrors = Array.isArray(outcome.rptErrors) ? outcome.rptErrors.length : 0;
  if (rptErrors > 0 && entries.some((entry) => entry.parsed.kind === 'nil')) return EXIT.failure;
  if (isRecord(outcome.verify) && isRecord(outcome.verify.parsed)) {
    if (outcome.verify.parsed.kind === 'error') return EXIT.failure;
  }
  return EXIT.ok;
}

/** 오류 블록을 몇 줄만 보여준다. 전부는 --json 에 있다. */
const RPT_BLOCKS_SHOWN = 2;
const RPT_LINES_PER_BLOCK = 6;

export interface Rendered {
  stdout: string[];
  stderr: string[];
}

/** exec 기본 출력. 결과 줄은 stdout, 실패 사유와 안내는 stderr 로 나눈다. */
export function renderExec(outcome: Json, mode?: string): Rendered {
  const out: Rendered = { stdout: [], stderr: [] };
  const entries = execEntries(outcome);
  const many = entries.length > 1 || mode === 'all';
  for (const entry of entries) {
    out.stdout.push(many ? `${entry.machine}: ${entry.result}` : entry.result);
  }
  if (isRecord(outcome.verify)) out.stdout.push(`verify: ${str(outcome.verify.result)}`);
  const blocks = Array.isArray(outcome.rptErrors) ? outcome.rptErrors.filter(isRecord) : [];
  if (blocks.length > 0) {
    out.stdout.push(`RPT 오류 ${blocks.length}건`);
    for (const block of blocks.slice(0, RPT_BLOCKS_SHOWN)) {
      const lines = Array.isArray(block.block) ? block.block.map(String) : [];
      for (const line of lines.slice(0, RPT_LINES_PER_BLOCK)) out.stdout.push(`  ${line.trim()}`);
    }
    if (blocks.length > RPT_BLOCKS_SHOWN) {
      out.stdout.push(`  나머지 ${blocks.length - RPT_BLOCKS_SHOWN}건은 --json 으로 본다.`);
    }
  }
  if (outcome.ok !== true) out.stderr.push(`exec 실패: ${str(outcome.error) || '결과 없음'}`);
  if (str(outcome.note)) out.stderr.push(str(outcome.note));
  return out;
}

/** --raw 출력. 값은 한 줄에 하나씩 stdout 으로, nil 과 오류와 잘림 안내는 stderr 로. */
export function renderExecRaw(outcome: Json): Rendered {
  const out: Rendered = { stdout: [], stderr: [] };
  for (const entry of execEntries(outcome)) {
    const value = rawValue(entry);
    if (value.kind === 'nil') {
      out.stderr.push(entry.result);
      continue;
    }
    if (value.kind === 'error') {
      out.stderr.push(value.text);
      continue;
    }
    out.stdout.push(value.text);
    if (value.truncated) {
      out.stderr.push('결과가 500자에서 잘렸다. 긴 값은 RPT 나 파일로 받는다.');
    }
  }
  if (isRecord(outcome.verify)) out.stderr.push(`verify: ${str(outcome.verify.result)}`);
  if (outcome.ok !== true) out.stderr.push(`exec 실패: ${str(outcome.error) || '결과 없음'}`);
  return out;
}
