import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOL_NAMES, SERVER_INSTRUCTIONS } from '../src/mcp/server.js';

test('MCP 공통 지침은 짧고 라이브 런타임 작업을 올바르게 라우팅한다', () => {
  assert.ok(
    SERVER_INSTRUCTIONS.length <= 512,
    `server instructions must stay within 512 characters; got ${SERVER_INSTRUCTIONS.length}`,
  );

  for (const route of [
    'arma_status',
    'arma_play/arma_launch*',
    'arma_mission_info',
    'arma_zeus_find',
    'arma_exec with verify',
    'arma_watch',
    'arma_rpt_*',
    'arma_capture',
  ]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(route), `missing route: ${route}`);
  }

  assert.match(SERVER_INSTRUCTIONS, /active mission bridge/);
  assert.match(SERVER_INSTRUCTIONS, /do not launch or mutate for source-only work/);
  assert.match(SERVER_INSTRUCTIONS, /explicit visible-output requests/);
  assert.match(SERVER_INSTRUCTIONS, /never for reports/);
});

test('MCP 도구 카탈로그는 23개 공개 도구를 그대로 유지한다', () => {
  assert.deepEqual(ALL_TOOL_NAMES, [
    'arma_exec',
    'arma_watch',
    'arma_mission_info',
    'arma_status',
    'arma_rpt_list',
    'arma_rpt_read',
    'arma_rpt_search',
    'arma_rpt_errors',
    'arma_rpt_wait',
    'arma_launch',
    'arma_launch_mp',
    'arma_launch_server',
    'arma_kill',
    'arma_play',
    'arma_scaffold_mission',
    'arma_web_open',
    'arma_web_publish',
    'arma_capture',
    'arma_tacmap_subtitle',
    'arma_tacmap_mark',
    'arma_tacmap_open',
    'arma_zeus_find',
    'arma_zeus_module',
  ]);
});
