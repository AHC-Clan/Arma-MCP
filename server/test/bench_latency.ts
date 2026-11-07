// bench_latency.ts — MCP 툴 왕복 지연 실측 벤치.
//
// 모드:
//   --fake (기본): 고유 파이프에 서버 스폰 + fake_dll(server,Alice) 접속.
//                  서버 측 지연(B/C/D)을 게임 없이 격리 측정. fake 는 즉답이라
//                  DLL 워커 게이팅(A)은 여기 안 나타난다.
//   --live:        기본 파이프로 서버 스폰, 실게임 DLL 접속 대기 후 E2E 측정(A 포함).
//                  사전에 arma_scaffold_mission 등으로 미션이 떠 있어야 한다.
//                  다른 세션의 MCP 서버가 파이프를 쥐고 있으면 EADDRINUSE — 종료 후 실행.
//
// 실행: tsx test/bench_latency.ts [--live] [--n 20] [--json out.json] [--server bundle/index.mjs]
// 출력: min/p50/p95/max/avg 표(stdout) + --json 파일(before/after 비교용).

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  live: boolean;
  launch: boolean;
  killAfter: boolean;
  n: number;
  json?: string;
  server?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = { live: false, launch: false, killAfter: false, n: 20 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--live') out.live = true;
    else if (a[i] === '--launch') out.launch = true; // live: 미접속이면 VR 씬 스캐폴드 후 게임 기동
    else if (a[i] === '--kill-after') out.killAfter = true;
    else if (a[i] === '--n') out.n = Math.max(1, Number(a[++i] ?? 20));
    else if (a[i] === '--json') out.json = a[++i];
    else if (a[i] === '--server') out.server = a[++i];
  }
  return out;
}

interface Stat {
  name: string;
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
  note?: string;
}

function stats(name: string, times: number[], note?: string): Stat {
  const s = [...times].sort((x, y) => x - y);
  const pick = (q: number): number => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  const avg = s.reduce((acc, v) => acc + v, 0) / s.length;
  return {
    name,
    n: s.length,
    min: round(s[0]),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(s[s.length - 1]),
    avg: round(avg),
    note,
  };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function parseToolResult(res: { content?: unknown }): any {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  const textPart = content.find((c) => c.type === 'text');
  return textPart?.text ? JSON.parse(textPart.text) : null;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return parseToolResult(res as { content?: unknown });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function measure(
  name: string,
  n: number,
  fn: () => Promise<string | undefined>,
): Promise<Stat> {
  const times: number[] = [];
  let note: string | undefined;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const extra = await fn();
    times.push(performance.now() - t0);
    if (extra) note = extra;
  }
  const st = stats(name, times, note);
  process.stdout.write(
    `  ${st.name.padEnd(34)} n=${String(st.n).padStart(2)}  min=${fmt(st.min)} p50=${fmt(st.p50)} p95=${fmt(st.p95)} max=${fmt(st.max)} avg=${fmt(st.avg)}${st.note ? '  (' + st.note + ')' : ''}\n`,
  );
  return st;
}

function fmt(v: number): string {
  return (v + 'ms').padStart(9);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const serverEntry = args.server
    ? path.resolve(args.server)
    : path.join(here, '..', 'src', 'index.ts');
  const useTsx = serverEntry.endsWith('.ts');
  const testPipe = `\\\\.\\pipe\\arma_mcp_bench_${process.pid}`;

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!args.live) {
    env.ARMA_MCP_PIPE = testPipe;
    env.ARMA_MCP_CONFIG = 'nonexistent-use-defaults';
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: useTsx ? ['--import', 'tsx', serverEntry] : [serverEntry],
    env,
  });
  const client = new Client({ name: 'bench', version: '0.0.1' });
  await client.connect(transport);
  process.stdout.write(`server spawned (${args.live ? 'live' : 'fake'} mode)\n`);

  let fake: ChildProcess | null = null;
  if (!args.live) {
    fake = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(here, 'fake_dll.ts'), '--machines', 'server,Alice'],
      { env: { ...process.env, ARMA_MCP_PIPE: testPipe }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }

  // --launch: 미접속이면 VR 테스트 씬을 만들어 게임을 기동(바닐라+selfMod 만 — 빠른 부팅).
  if (args.live && args.launch) {
    const st = await callJson(client, 'arma_status', {});
    if (st?.listener === 'pipe-unavailable') {
      process.stdout.write('FATAL: 파이프 점유(EADDRINUSE). 다른 세션 종료 후 재실행.\n');
      process.exit(2);
    }
    if (!st?.dllConnected) {
      const scaf = await callJson(client, 'arma_scaffold_mission', {
        world: 'VR',
        name: 'bench',
        launch: false,
        overwrite: true,
      });
      if (!scaf?.ok) {
        process.stdout.write(`FATAL: scaffold 실패: ${scaf?.error}\n`);
        process.exit(2);
      }
      process.stdout.write(`scaffold: ${scaf.missionPath} — 게임 기동 중(modset none)...\n`);
      const launch = await callJson(client, 'arma_launch', {
        mission: scaf.missionPath,
        modset: 'none',
        killRunning: true,
        waitForNewRptMs: 30000,
      });
      if (!launch?.ok) {
        process.stdout.write(`FATAL: launch 실패: ${launch?.error}\n`);
        process.exit(2);
      }
      process.stdout.write(`launched pid=${launch.pid} newRpt=${launch.newRpt?.name}\n`);
    }
  }

  // DLL(또는 fake) 접속 대기. live 는 게임 부팅+미션 로드 감안 6분.
  const connectDeadline = Date.now() + (args.live ? (args.launch ? 360000 : 30000) : 15000);
  let connected = false;
  let lastStatus: any = null;
  while (Date.now() < connectDeadline) {
    lastStatus = await callJson(client, 'arma_status', {});
    if (lastStatus?.dllConnected) {
      connected = true;
      break;
    }
    if (lastStatus?.listener === 'pipe-unavailable') {
      process.stdout.write(
        'FATAL: 파이프가 다른 MCP 서버에 점유됨(EADDRINUSE). 다른 MCP 클라이언트 세션을 닫고 재실행하세요.\n',
      );
      process.exit(2);
    }
    await sleep(args.live ? 2000 : 500);
  }
  if (!connected) {
    process.stdout.write(
      `FATAL: DLL 미접속 (${args.live ? '게임/미션이 떠 있는지 확인' : 'fake_dll 접속 실패'}).\n`,
    );
    process.exit(2);
  }
  process.stdout.write(`dllConnected=true — 측정 시작 (n=${args.n})\n\n`);

  const results: Stat[] = [];
  const n = args.n;
  const nAll = Math.min(n, 5); // all 모드는 회당 최대 3s — 반복 축소.

  results.push(await measure('arma_status', n, async () => {
    await callJson(client, 'arma_status', {});
    return undefined;
  }));

  results.push(await measure('arma_mission_info (cached)', n, async () => {
    await callJson(client, 'arma_mission_info', {});
    return undefined;
  }));

  results.push(await measure('arma_mission_info (fresh)', n, async () => {
    await callJson(client, 'arma_mission_info', { fresh: true });
    return undefined;
  }));

  const execDur: number[] = [];
  results.push(await measure('arma_exec server 1+1', n, async () => {
    const r = await callJson(client, 'arma_exec', { code: '1+1' });
    if (typeof r?.durationMs === 'number') execDur.push(r.durationMs);
    return r?.ok ? `server durationMs avg=${round(execDur.reduce((a, v) => a + v, 0) / execDur.length)}` : 'FAIL';
  }));

  const allBy: string[] = [];
  results.push(await measure('arma_exec all (expectN 미지정)', nAll, async () => {
    const r = await callJson(client, 'arma_exec', { code: '1+1', mode: 'all' });
    if (typeof r?.completedBy === 'string') allBy.push(r.completedBy);
    return allBy.length ? `completedBy=${[...new Set(allBy)].join(',')}` : undefined;
  }));

  if (!args.live) {
    results.push(await measure('arma_exec all expectN=2', nAll, async () => {
      const r = await callJson(client, 'arma_exec', { code: '1+1', mode: 'all', expectN: 2 });
      return r?.results?.length === 2 ? undefined : 'FAIL: results!=2';
    }));
  }

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify({ mode: args.live ? 'live' : 'fake', at: new Date().toISOString(), results }, null, 2),
    );
    process.stdout.write(`\nJSON 저장: ${args.json}\n`);
  }

  if (args.killAfter && args.live) {
    const kill = await callJson(client, 'arma_kill', {});
    process.stdout.write(`arma_kill: ${JSON.stringify(kill)}\n`);
  }

  await client.close();
  if (fake) {
    try {
      fake.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write('bench error: ' + (e?.stack ?? String(e)) + '\n');
  process.exit(1);
});
