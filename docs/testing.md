# Arma-MCP 검증 절차

## 게임 없이 (자동)

### TS 서버
```powershell
cd server
npm install
npx tsx --test test/*.test.ts     # 유닛: daemon/session/auth/relay/selfupdate + 기존 런처/RPT/exec/gateway/web
npx tsx test/mcp_smoke.ts         # E2E: standalone 서버 + fake_dll 접속, 툴 호출 검증
```

`selfupdate.test.ts` 는 세션 시작 자동 업데이트를 네트워크 없이 검증한다: 순수 판정 함수(쿨다운·원격
게이트·설치 판정·1회성 알림·URL 불일치 안내)와 host adapter 판별(Claude/Codex 캐시 경로, 경로 경계,
Codex `config.toml` 파싱), 그리고 io 를 주입해 **실제로 실행될 호스트 CLI argv 시퀀스**를 그대로
검증한다 — 원격 무변동 시 CLI 0회, 버전 미변동 시 갱신만 1회, 버전 상승 시 갱신+설치 2회,
스냅샷 선행 시 git 0회. 마지막 두 케이스는 실제 프로세스를 띄워 `selfupdate hook` 의 stdout 계약
(알릴 것이 없으면 0바이트, 있으면 정확히 한 줄 JSON, 어느 쪽이든 exit 0)을 확인한다.
상태 폴더는 `ARMA_MCP_TOKEN_FILE` 로 임시 경로에 격리된다.

자동 업데이트를 손으로 확인하려면(쿨다운 무시, **실제로 설치까지 수행할 수 있다**):

```powershell
$p = "$env:USERPROFILE\.claude\plugins\cache\ahc\arma-mcp\<버전>"
node "$p\server\bundle\index.mjs" selfupdate check --root "$p" --cli claude --json
```
`mcp_smoke.ts` 는 실제 MCP 서버를 `standalone` stdio 모드로 스폰하고, `fake_dll.ts`(모의 DLL 클라이언트)를
파이프에 접속시켜 다음을 검증한다: 툴 23개 등록 → 미접속 status → 접속 후 status →
mission_info(Altis) → TacMap 감지(`tacmap`/`tacmapZeusTool` + 유도 힌트) → `arma_tacmap_subtitle`/`arma_tacmap_mark`
ack 해석 → exec `1+1`=`SCALAR: 2` → 주석 제거 → nil 처리 → 단절 후 exec 실패.
`arma_capture` 는 데디 서버 미실행 시 우아한 실패(`ok:false`)를 조건부로 확인한다.
`fake_dll.ts --no-tacmap` 으로 TacMap 부재 경로를 수동 탐색할 수 있다.

스모크는 이어서 이름 있는 스택 b 를 dryRun 실행으로 만들고, 그 파이프에 태그 B 인 fake_dll 을 붙여
mission_info 와 exec 가 스택마다 제 게임에서 답하는지, 스택 b 가 끊겨도 default 가 도는지 본다.

daemon 통합 테스트는 임시 loopback 포트와 token을 사용해 두 stdio relay와 한 직접 HTTP 클라이언트를
동시에 연결한다. 한 세션의 DELETE/stdio 종료가 다른 세션과 공유 game gateway를 닫지 않는지,
잘못된 bearer·Host·Origin·과대 본문·세션 ID와 idle/max-session 제한을 거부하는지 확인한다.

수동 탐색:
```powershell
npm run fake        # fake_dll 을 파이프에 붙여 두고
npm run inspect     # @modelcontextprotocol/inspector 로 툴 직접 호출
```
`fake_dll.ts` 플래그: `--tcp <host> <port>`, `--machines server,Alice`(all 모드 다중 결과),
`--no-telemetry`, `--reconnect`(미션 재시작 시뮬).

### C++ 확장
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build\test-cpp.ps1
```
- 유닛: `test_utf8` / `test_safearray`(주입 방어) / `test_json` / `test_queue`(90/frame 백프레셔) / `test_wrapbody`(봉투 + 인바운드 라우팅)
- **loopback**: 실제 named pipe 로 C++ Bridge(DLL 클라이언트) ↔ Node peer(서버) 상호운용 —
  hello/sessionInfo/execResult 프레임 봉투 검증 + 인바운드 exec 라우팅.

CMake 로도 유닛 테스트 가능:
```powershell
cd extension; cmake -B build -A x64; cmake --build build; ctest --test-dir build
```

## 실게임 E2E

전제: `build\build-all.ps1` 로 만든 모드를 `arma.selfModPath` 에 지정,
`arma-mcp.config.json` 작성, 서버 컴퓨터에서 `node server\bundle\index.mjs daemon` 실행,
MCP relay가 클라이언트(Claude/Codex)에 등록됨.

```
1. arma_launch { mission: "<VR 미션>", killRunning: true }
2. arma_rpt_wait { file: "next", pattern: "\\[ArmaMCP\\].*server bridge" }
3. arma_status                                   # dllConnected: true
4. arma_exec { code: "1 + 1" }                   # results[0].result == "SCALAR: 2"
5. arma_exec { code: "_undef + 1" }              # parsed.kind=nil, rptErrors 에 "Error in expression"
6. arma_exec { code: "1+1 // 주석" }             # sanitized:true, 여전히 SCALAR: 2
7. arma_mission_info                             # world/mission/players
8. arma_exec { code: "systemChat \"hi\"", mode: "all" }   # 리슨 호스트에서 다중 결과
9. arma_kill
```

### arma_capture (게임 화면 캡처)

exec 와 무관한 독립 경로라 브리지 접속 없이도 동작 — 실게임 어느 상태에서든 검증 가능.

```
1. arma_launch { worldEmpty: true }              # 또는 임의 미션
2. (메인메뉴/로딩 중) arma_capture               # exec 불가 상태에서도 이미지 반환 확인 — 이 도구의 존재 이유
3. (미션 진입 후) arma_capture                   # 게임 창 캡처, method=printwindow 확인
4. arma_capture { scope: "screen" }              # 주 모니터 전체
5. arma_capture { delayMs: 500, format: "png" }  # 대기 + png
6. (게임 창 최소화 후) arma_capture              # stage=minimized 로 실패해야 정상
7. arma_kill
```

체크포인트:
- 최초 호출은 C# 헬퍼를 `csc.exe` 로 컴파일하므로 느리다(~수백 ms). 이후 `~/.arma-mcp/bin/` 캐시로 즉답.
- 비디오 설정이 창모드/테두리없는 → `method:printwindow`, 독점 전체화면 → 검정 감지 후 `method:screen` + `note`.
- 캡처 파일은 `~/.arma-mcp/captures/`, `capture.keepMax`(기본 100) 초과분 자동 정리.
- AMSI: PowerShell 이 아니라 컴파일된 exe 라 Defender 스크린 그래버 오탐(ScriptContainedMaliciousContent)을 피한다.

체크포인트:
- DLL 접속 = `[ArmaMCP] server bridge starting on <world>` 이후 `hello`/`sessionInfo` 수신.
- exec 감사 로그: RPT 에 `[ArmaMCP] [EXEC] mode=... reqId=... code=...` 와 `[EXEC] result <- ...`.
- 텔레메트리: 접속 상태에서 5s 주기로 `arma_mission_info` 의 `cacheAgeMs` 가 갱신됨.
- 서버 재시작 후에도 DLL 이 백오프 재접속하는지(게임 켠 채 MCP 서버만 재시작) 확인.

## 실게임 E2E — 멀티플레이 (`arma_launch_mp`)

전제는 위와 동일 + `arma.exePath` 옆에 `arma3server_x64.exe` 존재(또는 `arma.serverExePath` 설정).

```
1. arma_launch_mp { mission: "<미션 경로>", dryRun: true }   # 서버/클라 인자·server.cfg·배치 계획 확인
2. arma_scaffold_mission { launch: false }                   # 테스트 미션 생성만
3. arma_launch_mp { mission: "<missionPath>", killRunning: true }
   # → 미션 MPMissions 배치 → server.cfg 생성 → 서버 spawn → 부팅 감지 → 클라 spawn
4. 반환 확인: server.ready=true. 로비 대기라 서버 브리지가 없어 lobby 는 없고 nextSteps 가 판정하지 않았다고 적는다
5. (사람) 로비에서 슬롯 선택 → 미션 시작
6. arma_status                                   # dllConnected: true (서버 브리지), dedicated
7. arma_exec { code: "count allPlayers" }        # 서버 컨텍스트로 실행
8. arma_rpt_read { source: "server" }            # 데디 서버 RPT tail
9. arma_kill { target: "all" }                   # 클라+서버 정리
```

autoInit 실행은 서버가 역할을 배정한다. 사람 손 없이 인게임까지 가는지 본다.

| # | 단계 | 기대 |
|---|---|---|
| 1 | `arma_launch_mp { stack:"<id>", mission:"<미션 경로>", autoInit:true, clients:2, killRunning:true }` | `ok:true`, `autoSlot.entries` 가 `[]` 다. 생성된 `server.cfg` 에 `skipLobby = 1;` 이 있다. `nextSteps` 가 서버 배정을 적는다 |
| 2 | `arma_status { stack:"<id>", waitFor:"dedicated" }` 뒤 `arma_exec { stack:"<id>", mode:"server", code:"count allPlayers" }` | 사람이 슬롯을 고르지 않았는데 `2` 다. 서버 RPT 에 클라마다 `[ArmaMCP] autoSelectRole|pick=-1|match=none` 줄이 있다 |
| 3 | `arma_launch_mp { ..., autoInit:true, roles:["<역할 설명>"] }` | 클라 1 의 `roleDescription` 이 지정 역할이다. 훅 줄이 `match=desc` 다 |
| 4 | `arma_launch_mp { ..., autoInit:true, autoSlot:false }` | `server.cfg` 에 `skipLobby` 가 없고 클라가 로비에 선다 |
| 5 | `arma_launch_server { mission:"<미션 경로>" }` 뒤 클라 하나를 `-connect` 로 붙인다 | 로비 없이 서버 기본 배정으로 들어간다 |

2026-10-24 결과(저장소 번들 0.5.7, 격리 데몬, 이름 있는 스택, 2슬롯 즉석 VR 미션, 브리지 0.5.5):

- 1, 2: 클라 둘이 접속 9초 안에 `mcp_slot_0`, `mcp_slot_1` 로 들어갔고 `getUserInfo` 상태가 둘 다 10 이었다.
- 3: `roles:["mcp_slot_1", null]` 로 클라 1 이 `match=var` 로 `mcp_slot_1`, 클라 2 가 기본 배정으로 `mcp_slot_0` 에 들어갔다.
- 4, 5 는 아직 안 돌렸다.

체크포인트:
- 서버 부팅 = 서버 RPT(`arma_rpt_wait { source: "server", ... }`)에 `Initializing Steam server - Game Port`,
  `Connected to Steam servers` 중 하나. LAN 모드(`loopback = true;`) 서버는 Steam 초기화를 건너뛰어 둘 다 없고 서버 브리지로 판정한다.
- 클라 접속 = 서버 텔레메트리의 `clients` 나 `players` 에 클라 이름이 보이는 것. `autoInit` 서버에서만 본다.
  `Host identity created`, `Player <name> connecting.`, `Player <name> connected` 는 서버 콘솔에만 찍히고 RPT 에는 없다(엔진 분석).
  로비 대기에서 사람 눈으로 확인하려면 서버 콘솔 창을 본다.
- 스캐폴드 미션 유닛이 데디 로비에서 선택 가능한 슬롯으로 보이는지 — 안 보이면 scaffold 의
  mission.sqm 에 `isPlayable=1` 병기 필요(후속 수정).
- 로비 대기 상태에선 브리지 미접속(`dllConnected:false`)이 정상 — 미션 시작 후 접속된다.

## 실게임 E2E — 클라이언트 없는 전용 서버와 다중 세션

서버 컴퓨터에는 Arma 클라이언트를 실행하지 않는다. Claude와 Codex를 동시에 연결하고 필요하면
원격 관리 PC에서는 `ssh -N -L 5303:127.0.0.1:5303 user@arma-server` 터널을 연다.

```
1. arma_launch_server { mission: "<미션 경로>", dryRun: true }
2. arma_launch_server { mission: "<미션 경로>", killRunning: true }
3. 반환: server.ready=true, missionStarted=true, bridgeReady=true
4. arma_status { waitFor: "dedicated", timeoutMs: 120000 }
5. dedicated=true, playerCount=0, rawConnected=true, bridgeReady=true 확인
6. Claude: arma_exec { code: "1 + 1", mode: "server" }
7. Codex:  arma_exec { code: "2 + 2", mode: "server" }       # 병렬 실행
8. 각 세션 결과가 SCALAR: 2 / SCALAR: 4로 올바르게 귀속되는지 확인
9. 한 MCP 세션 종료 후 다른 세션의 status/exec와 DLL 연결이 유지되는지 확인
10. daemon 재시작 후 실행 중 전용 서버 애드온이 백오프로 재접속하는지 확인
```

외부 attach도 검증한다: daemon 없이 전용 서버를 먼저 실행하고 미션을 시작한 다음 daemon을 켜서
`arma_status { waitFor:"dedicated" }`가 새 연결과 서버 profiles RPT를 선택하는지 확인한다.

체크포인트:
- `arma3_x64.exe` 프로세스가 없어야 한다.
- 이전 연결 generation이나 이전 RPT를 새 실행 성공으로 오인하지 않아야 한다.
- 준비 timeout 시 `arma3server_x64.exe`는 유지되고 진단 정보가 반환되어야 한다.
- `mode:"all"`은 플레이어 0명일 때 서버 결과 하나로 완료하고, `mode:"client"`는 명확히 실패해야 한다.
- `arma_rpt_read { source:"auto" }`의 `resolvedSource`가 `server`여야 한다.

## 실게임 E2E — AHC_TacticalMap 연동 (`arma_tacmap_*`)

전제: 서버에 `@AHC_TacticalMap`(+선택 `@AHC_ZeusTool`)과 `@arma_mcp` 가 함께 로드되고 TacMap 웹서버(8088)가 기동 중.
계약 배경은 `docs/tacmap.md`.

```
 1. arma_status                                   # tacmap:true, hints 에 arma_tacmap_* 유도문
 2. arma_tacmap_subtitle { "text":"무전 테스트", "speaker":"지휘부", "color":"hq" }
 3. arma_tacmap_subtitle { "text":"블루포만", "audience":"side", "side":"WEST" }
 4. arma_tacmap_open {}                           # url/source 확인 후 전 클라 브라우저에 전술지도
 5. arma_tacmap_mark { "pos":[<x>,<y>], "text":"적 집결지", "iconType":"mil_destroy", "ttlSec":120 }
 6. arma_tacmap_mark { "pos":[<x>,<y>], "ping":true, "pingType":"attack" }
 7. 6 을 "commanderOverride": true 로 재실행
 8. 7 을 1.5초 안에 재실행
 9. arma_tacmap_mark { "action":"clearAll" }
10. arma_rpt_read { "source":"server" }           # [TacMap] cheat ... 감사 로그 확인
```

체크포인트:
- 2번 자막이 화면 하단에 7초 표시되고 무전음이 난다. **`@AHC_ZeusTool` 이 없는 서버에서도 자막은 보여야 한다**
  (사운드만 빠짐) — TacMap 웹 UI 경로와 달라지는 지점이며 응답 `note` 가 이를 설명해야 한다.
- 2번 이후 웹 전술지도 채팅 로그에 한 줄이 남는다(`webChatMirrored:true`). 3번은 남지 않는다.
- 3번의 `recipients` 가 실제 WEST 플레이어 수와 일치한다.
- 5번 마커가 인게임 지도에 즉시, 웹 전술지도에 `resync` 로 즉시 나타난다. 마커 이름은 `mcp_mark_*` 다
  (`ahc_web_`/`ahc_text_` 였다면 수집에서 스킵돼 웹에 안 보인다).
- 6번은 지휘관 좌석이 비어 있으면 `ping.status:"no-commander"` 로 **이유를 명시해** 실패해야 한다 — 절대 `<nil>` 이 아니다.
- 7번은 `ping.status:"ok"`, 그리고 **호출 후 웹 UI 의 지휘관 좌석이 여전히 비어 있어야** 한다(임시 점유 복원 검증).
- 8번은 `ping.status:"no-effect"`(쿨다운은 override 로 우회 불가).
- 9번은 `mcp_mark_*` 만 지우고 TacMap/미션 마커는 그대로 남아야 한다.
- 전술지도 화면 자체는 어느 단계에서도 이동하지 않는다 — 포커스 API 부재가 정상 동작이다.

## 실게임 E2E — `arma_watch` / `arma_exec.verify` / 링크 단계 (0.3.6)

**전제: PBO·DLL 을 재빌드하지 않는다.** exec 경로 SQF(`fn_execDispatch`/`fn_execRun`/
`fn_execRunRemote`/`fn_execResultIn`/`fn_pushResult`)는 최초 커밋 이후 변경된 적이 없으므로
배포된 구버전 애드온에서 그대로 동작해야 한다. **증거로 각 단계에서 `arma_status` 의
`dllVersion` 을 기록한다** — 구버전 그대로여야 이 전제가 검증된 것이다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | `arma_watch { condition: "count allUnits > 0" }` | `met:true`, `iterations ≤ 3`, `gameElapsedMs < 800` |
| 2 | `arma_watch { condition: "round allUnits", timeoutMs: 10000 }` | **1.5초 안에** `reason:"threw:cond"`. 10초 타임아웃이 **아니어야** 한다 — 자식 spawn 격리의 수용 시험이다 |
| 3 | `arma_watch { condition: "false", timeoutMs: 5000, sample: "count allUnits", intervalMs: 250 }` | `reason:"timeout"`, `iterations ≈ 18~20`, 샘플 8건 + `samplesDropped > 0` |
| 4 | 세션1에서 장기 워치 → 세션2에서 `arma_watch { stop: "<watchId>" }` | 세션1이 한 인터벌 안에 `reason:"stopped"` |
| 5 | `arma_exec { code: "systemChat \"x\"; true", verify: "round allUnits" }` | `ok:true`, `results[0].result = "BOOL: true"`, `verify.parsed.kind = "error"`, **총 1초 미만** |
| 6 | `arma_exec { code: "sleep 30; true", verify: "true", timeoutMs: 6000 }` | 본문은 step timeout, `verify.result = "BOOL: true"` |
| 7 | 워치·verify 실행 후 `arma_exec { code: "count (allVariables missionNamespace select {_x find ""AHC_MCP_"" == 0})" }` | **0** — 래퍼가 만든 전역을 모두 정리했는지 |
| 8 | 전용 서버를 로비에 1시간 방치 | `daemon.log` 의 `link stale` 증가 **0줄**, `/health` 의 `generation` 증가 **0회**, `arma_status.linkPhase = "pre-bridge"`. 이후 미션 시작 시 한 텔레메트리 주기 안에 `live` 로 전환 |
| 9 | relay 2개를 1시간 유지 | `relay.log` 의 `SSE stream disconnected` 증가 **0줄**, 두 세션 모두 툴 정상 |
| 10 | `arma3serverprofiling_x64.exe` 가동 중 `arma_status` | `serverProcessRunning:true`, `serverProcessImage:"arma3serverprofiling_x64.exe"`. 이어서 `arma_launch_server` 는 중복 실행을 거부해야 한다 |

2번과 5번이 이 릴리스의 핵심이다 — 관측된 30초 타임아웃 10건이 전부 이 경로였다.
8번은 `daemon.log` 를 21MB 로 불린 재접속 폭주(69,557회)의 수용 시험이다.

## 실게임 E2E — relay 연결 안정성 (0.3.8)

**전제: PBO·DLL 재빌드 불필요.** 이 릴리스는 relay↔daemon HTTP 구간만 바꿨다.
각 항목의 증거는 `%LOCALAPPDATA%\Arma-MCP\relay.log` 와 `daemon.log` 다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | `arma_rpt_wait { pattern: "<안 뜨는 패턴>", timeoutMs: 420000 }` | 7분을 **완주**해 `timeout` 으로 답한다. 0.3.7 이하에서는 5분에 `fetch failed` 로 연결이 끊겼다 |
| 2 | `arma_watch { condition: "false", timeoutMs: 300000 }` | 5분 + grace 를 완주. `relay.log` 에 `fetch failed` **0줄** |
| 3 | 툴 호출 없이 10분 방치 후 `arma_status` | 첫 호출에 성공. 재시도가 걸렸다면 `relay.log` 에 `daemon closed an idle keep-alive socket` 1줄이 남고 그래도 결과는 정상이어야 한다 |
| 4 | 한 세션을 1시간 유지하며 간헐 호출 | `relay.log` 에 `A valid MCP session ID` **0줄**, `downstream request failed` **0줄**, MCP 서버가 한 번도 disconnected 로 떨어지지 않는다 |
| 5 | 세션 유지 중 `build\daemon.ps1 restart` | 다음 툴 호출이 **성공**한다(세션 재수립). `relay.log` 에 `daemon session re-established` 가 남고 relay 프로세스는 살아 있어야 한다 |

4번이 이 릴리스의 수용 기준이다 — 보고된 증상(유휴 후·긴 툴 실행 중 disconnected)이
`relay.log` 에서 `fetch failed` 3건과 400 세션 오류 다수로 관측된 것을 그대로 뒤집는다.

## 실게임 E2E — 바다와 공중 스폰 방지 (`arma_scaffold_mission`, 0.4.0)

전제: PBO 와 DLL 재빌드 없이도 검증된다. 보정 프렐류드는 서버가 생성하는 미션 파일에만 들어간다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | `arma_scaffold_mission { world:"VR" }` | RPT 에 `result=ok reason=none`, `to == from`. **VR 회귀 방지가 첫 관문이다.** 여기서 `moved` 가 나오면 `_isLand` 의 `-0.5` 임계를 재검토한다 |
| 2 | `arma_scaffold_mission { world:"Altis", position:[3000,4000], killRunning:true }` 뒤 `arma_rpt_wait { pattern:"\\[arma-mcp\\]\\[safeSpawn\\] result=", fromEnd:true }` | `result=` 줄이 뜬다 |
| 3 | `arma_exec { code:"str [getPosATL player, getPosASL player, surfaceIsWater (getPosWorld player), damage player]" }` | 로그와 독립적으로 육지 지면임을 교차 확인 |
| 4 | `position:[3000,4000,4000]` 로 만들고 `arma_watch { condition:"(getPosATL player select 2) < 2", sample:"str [round (getPosATL player select 2), damage player]" }` | `result=moved reason=air`, `gameElapsedMs` 가 낙하 시간보다 훨씬 작고 `damage` 가 계속 0 |
| 5 | 바다 좌표로 스캐폴드 | `result=moved reason=water`, `to` 가 출발점에서 멀고 `land=true` |
| 6 | `arma_scaffold_mission { world:"Altis" }` (position 미지정) | `to` 가 맵 중앙 근처 육지 |
| 7 | `position:[3000,4000,4000], safeSpawn:"off"` | `result=` 줄이 **없다**(대조군) |
| 8 | `arma_launch_server { mission:"<스캐폴드된 Altis 미션>" }` 뒤 `arma_rpt_wait { source:"server", pattern:"\\[arma-mcp\\]\\[safeSpawn\\] result=" }` | `hasInterface=false` 인데도 `isServer` 경로로 playable AI 를 보정한 줄이 나온다 |

체크포인트.

- 5번의 바다 좌표는 **추측하지 말고 실측한다**. Altis 가 떠 있는 상태에서
  `arma_exec { code:"str [surfaceIsWater [8000,8000], getTerrainHeightASL [8000,8000]]" }` 로 확인한 뒤
  값을 이 표에 적는다.
- 7번의 `getPosATL select 2` 로 mission.sqm 가운데 값의 의미(절대 ASL 인지 지면 스냅인지)를 확정하고
  결과를 여기에 기록한다. VR 은 지형 높이가 0 이라 세 해석이 모두 같은 값을 설명해 구분되지 않는다.
- 4번의 `damage` 가 0 이 아니면 `HandleDamage` 창이 짧거나 `setVelocity` 가 안 먹은 것이다.
- `arma_watch` 는 `mode: 'server'` 고정이라(`server/src/mcp/tools/watch.ts`) 데디케이트 서버에서
  `player` 를 쓰는 조건은 항상 objNull 이다. 데디에서는 `playableUnits select 0` 으로 바꾼다.

## 실게임 E2E — 원콜 인게임 진입 (`arma_play`, 0.4.0)

| # | 실행 | 기대 |
|---|---|---|
| 1 | `arma_play { mode:"sp", dryRun:true }` | `-autotest` cfg 경로와 인자 확인. 미션 폴더가 생긴다 |
| 2 | `arma_play { mode:"sp", killRunning:true }` | `phase:"in-game"`, `inGame.evidence:"simProgress"` |
| 3 | `arma_play { mode:"mp", dryRun:true }` | 서버 인자에 `-autoInit`, `server.cfg` 에 `persistent = 1`, `skipLobby = 1;`, `OnAutoSelectRole = "..."`. 클라 인자에는 `-connect` 만 있고 `-init` 이 없다 |
| 4 | `arma_play { mode:"mp", autoSlot:false, killRunning:true }` | 사람이 직접 슬롯 선택. `phase:"in-game"` 과 `humanWait.waited:true`. 인게임에서 `inGame.clients[].state` 가 10 이다 |
| 5 | `arma_play { mode:"mp", roles:["<다른 진영 역할 설명>"], killRunning:true }` | `phase:"in-game"`, `autoSlot.clients[0]` 이 `state:"assigned"`, `match:"desc"` 이고 `role`, `side` 가 지정한 역할이다. 서버 RPT 에 `[ArmaMCP] autoSelectRole|pick=` 줄이 있다 |
| 6 | `arma_play { mode:"mp", killRunning:true }` | `autoSlot.state:"assigned"` 와 `phase:"in-game"`. 클라가 로비를 보지 않고 들어간다 |
| 7 | 런처로 Arma 를 직접 켜고 같은 서버에 접속 | `arma_mcp` 애드온이 로비에서 아무것도 하지 않는다(클라 RPT 에 `[ArmaMCP] lobby:` 줄이 없다). 서버가 `skipLobby` 로 배정하고, 이름이 지정에 없으면 기본 배정이다 |
| 8 | `arma_kill { target:"all" }` | 정리 |

체크포인트.

- `playOrchestrator.ts` 의 `IN_GAME_CLIENT_STATE = 10`(BRIEFING READ)은 엔진 기준과 같다(닫음, 2026-10-15).
  Arma 3 2.22 exe 에서 월드 시뮬레이션은 MP 일 때 서버 상태 7 이나 8 이고 클라 상태 10 일 때만 게임 시간을 진행한다.
  `getClientState` 의 이름 표도 값 0~12 가 `telemetry.ts` 의 `CLIENT_STATE_NAMES` 와 같은 순서다.
  실측도 맞았다. 아래 서버 배정 실측에서 인게임 클라는 모두 상태 10 이었다.
  로비 역할 화면은 5(MISSION ASKED)와 6(ROLE ASSIGNED)이다. 서버 훅 `OnAutoSelectRole` 은 클라가 5 가 될 때 불리고,
  로비 OK 는 6 에서만 먹는다(엔진 분석). 7~9 는 미션 받기, 로드, 브리핑이고, 서버 미션이 이미 돌면 클라는 브리핑 없이 10 으로 간다.
  이전 문서의 "로비 단계에서는 6~9" 는 근거가 없었다.
- 4번 도중과 직후에 최신 `Arma3_x64_*.rpt` 에 `fn_jsonEsc.sqf` 오류가 한 줄도 없어야 한다.
  0.4.1 이전에는 텔레메트리 push 마다 접속자 수만큼 `Error toarray` 가 쌓였다.
- 로비 역할은 서버가 배정한다. 2.22 에서 클라 SQF 의 `lbSetCurSel` 과 `ctrlActivate` 로는 배정 요청이 나가지 않는다(실측).
  꺼진 OK 버튼에 `ctrlActivate` 를 하면 역할 없이 넘어가 갈매기가 된다(`NetworkClient::PrepareGame - no role assigned`).
- 7번이 이 기능의 수용 기준이다. 사람이 직접 켠 클라의 로비 화면을 애드온이 건드리면 안 된다.

2026-10-15 서버 배정으로 바꾼 뒤 실측(Arma 3 2.22 profiling, 저장소 빌드 `@AHC_ArmaMCP` 하나만, 격리 데몬의 스택 `lobby`).
시험 미션은 청군 3역할(그룹 둘)과 대항군 2역할이고 `disabledAI = 1` 이다. 대항군 소총수에 변수 이름 `opf_rifle` 을 붙였다.

| 실행 | 결과 |
|---|---|
| 클라 1개, `roles:["OPFOR Rifleman"]` | 19초에 상태 10. 서버 `OPFOR Rifleman`, `O_Soldier_F`, `EAST`. 훅 `pick=4 match=desc` |
| 클라 2개, `roles:["Alpha Rifleman","opf_rifle"]` | 27초에 둘 다 상태 10. 클라 1 `Alpha Rifleman`, `WEST`(`desc`, 1번), 클라 2 `OPFOR Rifleman`, `EAST`(`var`, 4번) |
| 클라 2개, `roles:[4,4]` | 클라 2 는 서버 RPT `Error, OnSelectRole tried to select a role that is occupied` 뒤 기본 배정 `Alpha Squad Leader`. 결과 `fallback` |
| 클라 2개, 지정 없음 | 기본 배정. 클라 1 `Alpha Squad Leader`(`WEST`), 클라 2 `OPFOR Squad Leader`(`EAST`). 진영 균형이다 |
| 클라 1개 위에 런처 대역(`Arma3_x64.exe` 를 직접, `-name=human_test`) | 대역 클라 RPT 에 `[ArmaMCP] lobby:` 줄 0개. 서버가 로비 없이 기본 배정 `OPFOR Squad Leader`. 훅 `match=none` |

- `getRoles` 원소는 `[진영, 그룹 id, 유닛 id, 클래스, bool, 차지한 플레이어 id(빈 슬롯 ""), 역할 설명, 변수 이름, 플래그]` 였다.
  역할 번호는 이 배열 순서이고 로비 역할 행의 `lbValue` 와 같다(청군 0~2, 대항군 3~4).
- `OnAutoSelectRole` 의 `_this` 는 `[플레이어 이름, 플레이어 id]` 였다. `getUserInfo` 의 3번도 `-name` 과 같았다.
- 클라 둘 이상(`loopback = true`) 서버 RPT 에는 Steam 서버 줄이 없고 `Starting mission:` 은 있다. 준비는 브리지로 판정됐다
  (`steps` 의 server 가 `MCP 서버 브리지 준비(서버 RPT 의 준비 줄 없이)`). 둘째 클라도 붙어 인게임까지 갔다.
- 바꾸기 전 클라 SQF 방식은 로비 훅(숨은 컨트롤 onLoad)까지는 돌았지만 `lbSetCurSel`, 목록 `ctrlActivate` 로 배정되지 않았다.
- 못 본 것: 미션이 `skipLobby = 0;` 을 정한 실행. 데몬이 읽어 경고하는 것은 단위 테스트로만 확인했다.

## 실게임 E2E: 재실행 사이클 단축 (0.4.2)

전제: PBO 와 DLL 재빌드는 필요 없다. 이 릴리스의 동작 변경은 서버에만 있다.
nil 결과 대기가 기다리는 `[EXEC] result <- ... (reqId=...)` 줄은 이전 애드온도 남긴다.
공유 게임을 끄고 켜므로 돌리기 전에 사용자에게 묻는다. 다른 세션의 실행과 겹치지 않을 때 한다.
`arma_status` 의 `operation` 이 `null` 인지 먼저 본다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | `arma_launch_server { mission:"<미션 경로>", killRunning:true }` | `server.ready:true`. `server.readyLine` 이 `Initializing Steam server - Game Port` 나 `Connected to Steam servers` 줄이고 끝에 `\r` 이 없다. 0.4.1 이하는 `Host identity created` 만 기다려 이 빌드에서 늘 준비 시간 초과였다 |
| 2 | 1번 서버가 떠 있는 채로 `arma_kill { target:"all", unlockPaths:["<서버가 로드한 모드 폴더>"] }` | `ok:true`, `server.gone:true`. `unlock[]` 이 모두 `ok:true` 다. 폴더는 그 안과 `addons` 안의 `*.pbo`, `*.dll` 로 펼쳐진다. 이어서 PBO 빌드가 잠금 오류 없이 바로 끝난다 |
| 3 | `arma_kill { unlockPaths:["<없는 경로>"] }` | 떠 있는 프로세스가 없어 아무것도 끄지 않는다. `ok:false`, `unlock[0].code:"ENOENT"` |
| 4 | `arma_play { mission:"<미션 경로>", saveProfile:"e2e", ready:{ rpt:"\\[ArmaMCP\\].*server bridge" } }` | `phase:"in-game"`, `ready.ok:true`, `profile.saved:"e2e"`. `rpt.client` 에 `errorBlocks` 와 `warningMessages` 가 있다 |
| 5 | `arma_status` | `profiles` 에 `e2e` 가 있다 |
| 6 | `arma_exec { code:"openMap true; visibleMap", capture:true }` | 이미지 블록이 JSON 보다 먼저 온다. `results[0].result:"BOOL: true"`, `capture.ok:true`. 이미지에 지도가 열려 있다 |
| 7 | 게임 창을 최소화하고 `arma_exec { code:"1 + 1", capture:true }` | `results[0].result:"SCALAR: 2"` 는 그대로 온다. `capture.ok:false`, `capture.stage:"minimized"` |
| 8 | `arma_exec { code:"_undef + 1" }` 와 `arma_exec { code:"_undef + 1", mode:"all" }` | 둘 다 `parsed.kind:"nil"` 이다. `rptErrors` 에 `Error in expression` 블록이 하나 이상 있다. `mode:"all"` 의 `machine` 은 플레이어 이름이다 |
| 9 | `arma_exec { code:"round allUnits", timeoutMs:3000 }` | `ok:false`, `timedOut:true`. `rptErrors` 에 `round` 오류 블록이 있고 `note` 가 `결과가 오지 않았다.` 로 시작한다 |
| 10 | `arma_play { profile:"e2e", killRunning:true, then:{ code:"missionNamespace setVariable [\"E2E_SETUP\", true]; true" } }` | 미션과 모드를 다시 적지 않아도 같은 미션으로 들어간다. 저장된 `ready` 가 다시 돌아 `ready.ok:true` 다. `then.ok:true`, `then.exec.results[0].result:"BOOL: true"` |
| 11 | `arma_play { profile:"e2e", killRunning:true, then:{ code:"round allUnits", timeoutMs:3000 } }` | `ok:false`, `error` 가 `then 실패:` 로 시작한다. 게임은 떠 있다(`arma_status.armaProcessRunning:true`) |
| 12 | `arma_play { profile:"nope" }` | 게임을 건드리지 않고 `ok:false` 로 답한다. `profiles` 에 `e2e` 가 있다 |
| 13 | 세션1의 `arma_play` 가 도는 동안 세션2에서 `arma_status` 와 `arma_play { dryRun:true }` | `operation.owner.session` 이 세션1의 `shortId` 다. 세션2의 `arma_play` 는 `busy.owner` 가 세션1이고 `busy.mine` 이 없다. `arma_launch` 의 dryRun 은 lease 를 잡지 않아 `busy` 가 오지 않으므로 이 확인에 쓰지 않는다 |
| 14 | 세션1에서 `arma_rpt_wait { pattern:"<안 뜨는 패턴>", timeoutMs:120000 }` 를 거는 동안 셸에서 `build\daemon.ps1 stop` | 세션1의 호출이 2초 남짓 뒤 오류로 끝난다. 문구에 `the tool may or may not have run` 과 `The next call reconnects` 가 있고 `ECONNREFUSED` 는 없다. `daemon.log` 에 `daemon stopped` 가 남고 daemon 프로세스가 5초 안에 사라진다. 게임 파이프가 비어 있다 |
| 15 | 14번 직후 세션1에서 `arma_status` | 성공한다. `relay.log` 에 `starting it again` 과 `daemon session re-established` 가 남고 새 daemon 의 `/health` `pid` 가 14번과 다르다. 5초 남짓 걸린다 |
| 16 | 0.4.1 daemon 과 0.4.1 세션이 떠 있고 그 세션이 `arma_rpt_wait` 를 거는 동안 0.4.2 세션을 연다 | 새 relay 가 옛 daemon 을 내린다. 옛 daemon 이 남으면 3초 뒤 `relay.log` 에 `acknowledged shutdown but is still running after 3000ms; killing it` 이 남고, 새 daemon 이 `cannot own pipe` 없이 뜬다. 새 세션의 기동이 10초 안에 끝난다 |
| 17 | `arma_kill { target:"all" }` | 정리 |

체크포인트.

- 1번이 준비 판정 수정의 수용 기준이다. 0.4.1 이하 기록에서 전용 서버 준비 판정은 64회 중 한 번도 성공하지 못했다.
- 2번의 `unlock[].waitedMs` 를 기록한다. 에이전트가 셸 대기 루프 없이 바로 빌드로 넘어가면 이 기능이 동작한 것이다.
- 8번에서 오류 블록이 결과보다 늦게 기록되면 0.4.1 이하는 빈 `rptErrors` 를 돌려줬다.
  0.4.2 초기 빌드도 결과를 받은 시점에 RPT 가 자라지 않았으면 기다리지 않아 두 모드 모두 빈 `rptErrors` 였다.
  실행 구간에 블록이 있는데 비어 있으면 RPT 커서와 감사 줄의 `reqId` 를 대조한다.
- 14번에서 16번은 daemon 을 내리므로 다른 세션도 잠시 끊긴다. 돌리기 전에 사용자에게 묻는다.
  0.4.1 이하 daemon 은 14번에서 90초 넘게 파이프를 쥔 채 남았고, 0.4.1 이하 relay 는 15번에서 `ECONNREFUSED` 로 계속 실패했다.
- 10번이 재실행 사이클의 수용 기준이다. 한 호출로 인게임 진입, 준비 마커, 셋업 SQF 까지 간다.
- 끝나면 프로필 파일(`arma.profilesFile`, 기본 `~/.arma-mcp/launch-profiles.json`)에서 `e2e` 항목을 지운다.

## 실게임 E2E: 셸 CLI (0.4.3)

전제: 이 릴리스의 동작 변경은 서버와 CLI, 애드온의 exec 감사 줄에 있다.
애드온은 여러 줄 코드와 결과를 감사 줄 한 줄에 찍도록 바뀌어 PBO 를 다시 배포한다. DLL 은 버전 문자열만 바뀌어 재배포하지 않아도 된다.
공유 게임을 끄고 켜므로 돌리기 전에 사용자에게 묻는다. 다른 세션의 실행과 겹치지 않을 때 한다.
명령은 플러그인 `bin` 이 PATH 에 있는 셸에서 돌린다. 명령과 출력 모양은 [CLI 안내](cli.md)에 있다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | `arma-mcp status` | 종료 코드 0. `daemon` 줄의 버전이 `arma-mcp --version` 과 같다. `lease` 줄이 `없음` 이다 |
| 2 | `arma-mcp play --mission "<미션 경로>" --mods-file <모드 목록 파일> --ready '<준비 마커>' --save e2e` | 종료 코드 0. `in-game`, `ready`, `profile e2e 저장` 줄이 나온다 |
| 3 | 셸 한 번으로 `arma-mcp kill --unlock "<모드 폴더>" && <빌드 명령> && arma-mcp play e2e --setup <셋업 SQF 파일>` | 종료 코드 0. `unlock` 줄이 `풀림` 이다. 빌드가 잠금 오류 없이 끝난다. `then` 줄에 셋업 결과가 나온다 |
| 4 | `E2E_DONE` 을 몇 초 뒤에 세우는 파일로 `arma-mcp exec -f <파일> && arma-mcp wait sqf "!isNil 'E2E_DONE'" --timeout 60s` | 종료 코드 0. `met` 줄이 나온다 |
| 5 | `arma-mcp exec "openMap true; visibleMap" --capture` | 종료 코드 0. `BOOL: true` 와 `shot:` 경로가 나온다. 그 파일에 지도가 열린 화면이 있다 |
| 6 | `arma-mcp exec --rpt '[] spawn { sleep 5; diag_log "E2E_MARKER done" }'` 로 받은 `rpt:` 값으로 `arma-mcp wait rpt E2E_MARKER --since '<rpt 값>'` | 종료 코드 0. 5초 남짓 뒤 `"E2E_MARKER done"` 줄로 끝난다. `[ArmaMCP] [EXEC]` 감사 줄로 곧바로 끝나면 실패다 |
| 7 | 세 줄짜리 SQF 파일로 `arma-mcp exec -f <파일> --rpt` | 종료 코드 0. RPT 의 `[ArmaMCP] [EXEC] mode=` 감사 줄이 한 줄이고 줄바꿈 자리가 공백이다. 그 뒤에 접두어 없는 코드 줄이 없다 |
| 8 | 다른 에이전트 세션의 `arma_play` 가 도는 동안 `arma-mcp kill` | 종료 코드 4. stderr 에 lease 주인이 나온다. 게임은 그대로다 |
| 9 | 포그라운드 `arma-mcp play e2e --kill` 이 부팅을 기다리는 동안 그 셸의 node 프로세스를 죽인다 | 2초 안에 `arma-mcp status` 의 `lease` 가 `없음` 이다. 게임 프로세스는 살아 있다. `daemon.log` 에 `cli session <id> closed: client disconnected mid-request` 줄이 있다 |
| 10 | `arma-mcp wait rpt '<안 뜨는 패턴>' --timeout 2m` 이 기다리는 동안 셸에서 `build\daemon.ps1 stop` | 2초 남짓 뒤 종료 코드 3. stderr 가 `데몬이 멈추는 중이다(HTTP 503` 으로 시작하고 `the tool may or may not have run` 이 있다. stderr 는 다시 실행하라고 하지 않고 게임 상태부터 확인하라고 안내한다. `daemon.log` 에 `client disconnected mid-request` 줄이 없다 |
| 11 | 에이전트 세션에서 `arma_status` 를 한 번 부른 뒤 `arma-mcp kill` | relay 가 daemon 을 다시 띄운다. 이어서 정리 |

체크포인트.

- 3번이 이 릴리스의 수용 기준이다. 수정, 빌드, 재실행 사이클이 셸 호출 한 번으로 인게임과 셋업까지 간다.
- 3번이 2분을 넘기면 셸의 백그라운드 실행으로 돌렸는지 기록한다.
- 6번이 exec 커서 대기의 수용 기준이다. 0.4.3 초기 빌드는 감사 줄에 찍힌 코드 속 마커에 곧바로 맞아 5초를 기다리지 않았다.
- 9번이 끊김 처리의 수용 기준이다. 죽은 CLI 가 lease 를 쥔 채 남으면 다음 kill 과 play 가 종료 코드 4 로 막힌다.
- 10번은 daemon 을 내리므로 다른 세션도 잠시 끊긴다. 돌리기 전에 사용자에게 묻는다. CLI 는 daemon 을 다시 띄우지 않으므로 11번의 에이전트 호출이 띄운다.
- 끝나면 프로필 파일에서 `e2e` 항목을 지운다.

## 실게임 E2E: 탐색 요청을 먼저 보내는 클라이언트 (0.4.4)

전제: 이 릴리스는 relay 만 바꿨다. PBO 와 DLL 은 버전 문자열만 바뀌어 재배포하지 않아도 된다.
클라이언트는 `initialize` 전에 `server/discover` 를 보내는 MCP 클라이언트다(Claude Code 2.1.283 이상).
증거는 `%LOCALAPPDATA%\Arma-MCP\relay.log` 와 클라이언트의 MCP 로그다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | 새 에이전트 세션을 연다 | arma 서버가 연결된다. `relay.log` 에 `answered server/discover before initialize` 1줄이 남고 `A valid MCP session ID` 는 없다 |
| 2 | 1번 세션에서 `/mcp` 로 arma 를 reconnect 한 뒤 `arma_status` | 성공한다. reconnect 가 `CONNECTION_CLOSED` 로 실패하지 않는다 |
| 3 | 다른 호스트의 세션(Codex 등)을 함께 열고 양쪽에서 `arma_status` | 둘 다 성공한다. `sessions.byTransport.relay` 가 2 이상이다 |

체크포인트.

- 2번이 이 릴리스의 수용 기준이다. 0.4.3 이하 relay 는 1번과 2번에서 `CONNECTION_CLOSED` 로 끝났다.

## 실게임 E2E: 다중 스택 (0.5.0)

전제: 0.5.0 DLL 과 PBO 가 `selfModPath` 에 배포되어 있다. 배포 전이면 이름 있는 스택 실행이 "브리지를 다시 배포하라" 로 거절된다.
공유 게임을 끄고 켜므로 돌리기 전에 사용자에게 묻는다. default 스택으로 이미 떠 있는 게임이 있으면 그대로 두고 시작한다.
6번이 그 게임을 건드리지 않는지 보는 확인이다. 기본 모드의 PBO 를 고쳐 시험하는 5번은 `stacks.root` 가 그 모드와 같은 드라이브여야 한다.

| # | 실행 | 기대 |
|---|---|---|
| 1 | 기본 스택으로 지금 하던 `arma_play` | 결과와 경로가 0.4.4 와 같다. `arma_status.stack` 이 `default` 다 |
| 2 | `arma_play { stack:"a", mode:"mp", clients:2, testMods:[<새 PBO>] }` | `phase:"in-game"`, `inGame.playing:2`. `stacks.root\a\client1`, `client2` 에 RPT 가 따로 생긴다. `autoSlot.clients` 가 둘 다 `assigned` 다 |
| 3 | 2 가 도는 동안 `arma_play { stack:"b", mode:"sp", testMods:[<다른 PBO>] }` | 둘 다 in-game. `arma_exec { stack:"a", code:"worldName" }` 와 `{ stack:"b" }` 가 각자 제 게임에서 답한다 |
| 4 | 2 가 도는 동안 2 의 테스트 PBO 원본 빌드를 다시 돌린다 | 잠금 오류 없이 끝난다 |
| 5 | 기본 모드에 있는 PBO 를 고쳐 `testMods` 로 실행 | `testMods.overlays[].excluded` 에 원본이 있고 `method:"hardlink"` 다. 게임 안에서 고친 쪽 설정 값이 보인다. `rpt.client.conflictingAddons` 가 늘지 않는다 |
| 6 | `arma_kill { stack:"b" }` | b 의 프로세스만 사라진다. a 와 default 스택 프로세스는 남는다(`arma_status.stacks[].processes`) |
| 7 | `build\daemon.ps1 restart` | a 의 서버가 제 파이프로 다시 붙는다(`stacks[a].linkPhase:"live"`) |
| 8 | `arma_capture { stack:"a", client:2 }` | 두 번째 클라 창이 찍힌다 |
| 9 | 0.4.4 DLL 이 배포된 채로 이름 있는 스택 실행 | 게임을 띄우기 전에 "브리지를 다시 배포하라" 로 거절한다 |
| 10 | `arma_kill { stack:"a", forget:true }` | 파이프가 닫히고 `stacks.root\a` 가 사라진다. 기본 모드 원본 파일은 모두 남는다 |
| 11 | 셸에서 `arma-mcp status --stack a` 와 `ARMA_MCP_STACK=a arma-mcp exec "worldName"` | 스택 줄에 `*a` 가 있고 exec 가 a 의 게임에서 답한다 |

이 시나리오에서 처음 확인하고 결과를 표에 적을 것.

2026-09-28 첫 실행(0.5.0, default 스택에 사람이 띄운 서버와 클라가 떠 있는 채로 스택 a 를 mp, clients:2, testMods 로 실행)에서 확인한 것.

- 스택 a 서버가 `ARMA_MCP_GAME_PIPE` 로 `\\.\pipe\arma_mcp_s_a` 에 붙었다. hello 의 pid 가 서버 프로세스 pid 와 같았다. default 게임의 연결은 그대로였다.
- 클라 `-profiles` 가 클라 RPT 를 `stacks\a\client1` 로 옮겼다.
- `-name=a_c1` 이 그대로 플레이어 이름이 됐다. 첫 클라는 자동 슬롯으로 인게임까지 갔다.
- 서버 RPT 에 `@arma_mcp_test\addons\arma_mcp.pbo` 만 로드됐고 `Conflicting addon AHC_ArmaMCP` 줄이 없었다. 오버레이(복사, 131개 파일)가 원본 PBO 를 뺐다.
- 게임이 도는 동안 원본 `build\bin\arma_mcp.pbo` 를 다시 빌드했고 잠금 오류가 없었다(4번).
- 데몬을 다시 띄우자 1초 안에 스택 a 서버와 default 서버가 각자 제 파이프로 다시 붙었다(7번).
- 서버 RPT 에 `Player <이름> connecting` 줄이 끝내 없어 클라 1 이 인게임인데도 로비 대기가 180초 시간 초과로 끝났다.
  0.5.1 부터 autoInit 실행은 서버 텔레메트리로도 클라 접속을 본다. 엔진 분석으로 보니 이 줄은 버퍼 지연이 아니라
  서버 콘솔에만 찍히고 RPT 에는 쓰이지 않는 줄이었다. 0.5.4 다음 릴리스부터 접속은 서버 텔레메트리로만 본다.
- 아직 못 본 것: 클라 2 의 `-init` 문장 두 개와 슬롯 행, `kickDuplicate = 0` 으로 같은 Steam ID 클라 둘 접속, 스택 둘 동시 실행(메모리 여유 때문에 이번에는 하나만 띄웠다).

2026-10-04 클라 창 크기 확인(모드 없이 `-profiles=<임시 폴더> -name=cfgtest -window` 로 클라 하나).

- `-profiles` 를 받은 Arma 는 `Arma3.cfg` 를 `<profiles>\Users\<Windows 사용자>\` 에서 읽고 쓴다. `-name` 이 달라도 이 자리다.
  0.5.1 은 `<profiles>\Arma3.cfg` 에 복사했고, 원본도 OneDrive 로 옮겨진 문서 폴더에서 못 찾아 클라가 기본값 1024x768 로 떴다.
- `winWidth=1600`, `winHeight=900`, `renderWidth=1600`, `renderHeight=900` 을 적고 띄우자 창 클라이언트 영역이 1600x900 이었다.
  사용자 파일의 `displayMode=2` 는 `-window` 를 이기지 않았다. 사용자 파일의 `language="Korean"` 이 메뉴에 그대로 보였다.


2026-10-06 스택 `screenshot` 에서 clients:2 실행(0.5.2).

- 둘째 클라 `screenshot_c2` 가 `Steam ticket check failed: Same Steam user already in game` 으로 킥됐다. `kickDuplicate = 0` 만으로는 같은 Steam ID 클라 둘이 붙지 않는다.
  다음 릴리스는 클라가 둘 이상이면 `server.cfg` 에 `loopback = true;` 를 넣는다. 그 뒤 2번을 다시 돌려 둘째 클라가 붙는지, 서버 부팅 줄(`SERVER_READY_PATTERN`)이 LAN 모드에서도 찍히는지 본다.

2026-10-15 창 자리, `-noPause`, 텔레메트리 접속 판정(Arma 3 2.22, 저장소 빌드 `@AHC_ArmaMCP` 하나, 격리 데몬의 스택 `lobby`,
`cli play --mode mp --clients 2`, 주 모니터 2560x1440 배율 100%, `stacks.windowWidth` 1260, `windowHeight` 709, `baseArgs` 에 `-noPause` 없음).

- 21초에 `phase:"in-game"`, 두 클라 모두 상태 10. 클라마다 `lobby.line` 이 `telemetry: lobby_c<i> 접속` 이었고 둘 다 띄운 뒤 약 6.8초였다.
- 클라 RPT 셋째 줄(명령줄)에 `-posX=8 -posY=31 -noPause`, `-posX=1284 -posY=31 -noPause` 가 한 번씩 있었다.
- `arma_capture` 의 `windowRect` 가 `(0,0) 1276x748`, `(1276,0) 1276x748` 이었다. 두 창이 맞닿고 겹치지 않았으며 작업 영역 2560x1392 안이다.
- 처음에는 바깥 창 자리를 `-posX=0 -posY=0` 으로 줬는데 창이 `(-8,-31)` 에 떠 제목 표시줄이 화면 위로 나갔다.
  `-posX`, `-posY` 는 클라이언트 영역의 자리다. 그래서 테두리 몫(왼쪽 8, 위 31)을 더해 준다.
- 클라 1 화면 왼쪽 아래에 `플레이어 lobby_c2: 접속 중`, `접속` 채팅 줄이 보였다. 이 줄은 화면과 서버 콘솔에만 있고 RPT 에는 없다.

같은 날 창 자동 축소(같은 조건에서 `stacks.windowWidth`, `windowHeight` 를 빼 기본 1600x900 으로).

- `windowLayout` 이 `mode:"shrunk"`, `size` 1264x711 이었다. 클라 항목 `window` 가 `{1264,711,8,31}`, `{1264,711,1288,31}` 이었다.
- 두 클라의 `Users\<사용자>\Arma3.cfg` 에 `winWidth=1264; winHeight=711; renderWidth=1264; renderHeight=711;` 이 적혔다. 설정 파일은 그대로다.
- `arma_capture` 의 `windowRect` 가 `(0,0) 1280x750`, `(1280,0) 1280x750` 이었다. 둘이 맞닿고 오른쪽 끝이 작업 영역 폭 2560 이다.
- 20초에 둘 다 상태 10 이었다.

- 클라 `-profiles` 가 RPT 와 `Arma3.cfg` 위치를 옮기는지. 옮기지 않으면 2번의 클라 RPT 가 `%LOCALAPPDATA%\Arma 3` 에 섞인다.
- 서버 훅이 클라 이름으로 지정 역할을 고르는지. `autoSlot.clients[].match` 와 서버 RPT 의 `[ArmaMCP] autoSelectRole` 줄로 본다.
- `kickDuplicate = 0` 으로 같은 Steam ID 클라 둘이 붙는지.
- 새 프로필 이름(`a_c1`)이 서버 텔레메트리의 `clients[].name` 에 그대로 보이는지. 다르면 2번이 클라 접속 시간 초과로 끝난다.
- 클라 창이 겹치지 않는지. `arma_capture { stack:"a", client:<i> }` 의 `windowRect` 와 클라 RPT 첫 줄의 `-posX`, `-posY` 로 본다.

체크포인트.

- 2번과 3번이 이 릴리스의 수용 기준이다. 한 PC 에서 스택 둘이 서로의 게임을 건드리지 않고 동시에 돈다.
- 4번이 폴더 충돌 대응의 수용 기준이다. 0.4 에서는 게임을 끄고 잠금이 풀리기를 기다려야 다시 빌드할 수 있었다.
- 끝나면 `arma_kill { stack:"a", forget:true }` 처럼 만든 스택을 지운다.

## 실게임 E2E: Zeus 이름과 모듈 (`arma_zeus_find`, `arma_zeus_module`)

전제: 데몬만 새 빌드다. 애드온과 DLL 은 바뀌지 않았으므로 배포된 PBO 그대로 돈다.
`zeustool_mp` 프로필(데디 서버와 클라 하나, AHC_ZeusTool)을 쓴다. 클라 게임 언어는 한국어다.
Zeus 를 쓰는 클라가 받은 curator 가 있어야 한다. 없으면 0번에서 만든다.

| # | 실행 | 기대 |
|---|---|---|
| 0 | `arma_exec { code:"allCurators apply {[_x, getAssignedCuratorUnit _x]}" }`. 비었으면 서버에서 `ModuleCurator_F` 를 만들어 클라 플레이어에 `assignCurator` | 클라 플레이어에 curator 가 하나 배정된다 |
| 1 | 클라에서 Zeus 를 열고 `arma_exec { mode:"client", target:<클라 이름>, code:<findDisplay 312 의 트리 컨트롤 tvText 덤프> }` | Zeus 가 유닛, 그룹, 모듈을 어떤 이름으로 보여 주는지 적는다. `label` 규칙(플레이어는 `종류명 (이름)`, AI 와 차량과 모듈은 종류명, 그룹은 콜사인)과 다르면 고친다 |
| 2 | Zeus 로 분대 하나와 차량 하나를 놓고 `arma_zeus_find { query:<한국어 종류명> }`, `{ query:<콜사인>, kind:"group" }` | `machine` 이 클라 이름, `language:"Korean"`. 놓은 것이 `zeus:true` 로 나온다. 받은 `sqf` 를 `arma_exec` 에 넣어 `move` 하고 `arma_watch` 로 위치가 바뀌는지 본다 |
| 3 | 유닛 30개 이상이 있는 상태에서 `arma_zeus_find { limit:100 }` | `exec.count` 가 2 이상이고 `returned` 가 `total` 과 같다(100 이하일 때). 한국어 이름이 깨지지 않는다 |
| 4 | Zeus 에서 유닛 둘을 선택하고 `arma_zeus_find { source:"selected" }` | 그 둘이 나온다. Zeus 를 닫고 다시 부르면 `zeusOpen:false` 와 안내가 붙는다 |
| 5 | `arma_zeus_find { source:"palette", query:"소총수", kind:"unit" }`, `{ source:"palette", kind:"module", query:"치료" }` | 클래스명이 Zeus 생성 패널과 맞는다. 두 번째 호출이 첫 호출보다 빠르다(색인 캐시) |
| 6 | 다친 플레이어 위치에 `arma_zeus_module { module:"주변 10m 완전 치료" }` | `outcome:"consumed"`. 플레이어 체력이 회복되고 Zeus 피드백 메시지가 뜬다 |
| 7 | 차량 `ref` 로 `arma_zeus_module { module:"2_변수명 지정", target:<ref> }` | `outcome:"dialog"`. 클라에 이름 입력 창이 뜨고 대상 목록 첫 줄이 그 차량이다 |
| 8 | `arma_zeus_module { module:"텔레포트" }` | 만들지 않고 `candidates` 에 텔레포트 모듈 둘이 나온다 |
| 9 | ZEN 모듈 하나를 `dryRun` 으로 본 뒤 실행 | `opensDialog` 와 실제 `outcome` 을 적는다. ZEN 모듈이 `createUnit` 경로에서 창을 띄우는지가 이 단계의 확인 대상이다 |
| 10 | SP(`zeustool_ui`)에서 `ModuleCurator_F` 를 만들어 플레이어에 배정한 뒤 2, 5, 6 | SP 에서 `BIS_fnc_netId` 와 `objectFromNetId` 경로가 돈다. 모든 exec 가 server 모드다 |

각 단계 뒤 `arma_rpt_errors` 로 서버 RPT 를, 클라 RPT 는 `arma_rpt_errors { source:"client" }` 로 본다. `Error in expression` 이 없어야 한다.

2026-10-09 첫 실행. 공유 데몬을 건드리지 않으려고 저장소 번들을 격리 데몬(포트, 파이프, 스택 폴더를 따로 둔 설정)으로 띄우고 CLI 로 불렀다.
모드는 ACE 와 ZEN, AHC_ZeusTool 을 모은 작은 폴더다. 큰 모드 묶음을 통째로 넣으면 없는 클래스를 찾느라 서버 RPT 가 500MB 로 불어나고 서버가 꺼질 수 있다.
`zeustool_opt.VR` 에는 Zeus 모듈이 없어 0번에서 서버가 `ModuleCurator_F` 를 만들고 `addCuratorAddons activatedAddons` 뒤 배정했다. 클라 게임 언어는 `Korean` 이었다.

- 1번: Zeus 창의 IDC 251 이 엔티티 목록이었다. `청군 > 알파 1-1 > 소총수 (zdev_c1)`, `독수리 1 > 조장`, `비어있음 > M-ATV` 처럼 보였다. 플레이어는 종류명 뒤 괄호에 이름이 붙는다. 변수명을 준 차량도 종류명만 보인다. IDC 270~274 는 생성 패널 유닛(진영 > 하위 분류 > 종류명, 데이터는 클래스명), 275~277 은 그룹 편성, 280 은 모듈(카테고리 > 이름)이다.
- 2번: `소총수` 로 세 개(정확 일치 100, 앞부분 60, 포함 40), `독수리` 로 그룹 하나가 클라 머신에서 나왔다. 받은 그룹 식으로 서버 exec 에서 `move` 가 됐다.
  플레이어에는 다른 모드가 붙인 변수명이 있었다. 처음에는 `sqf` 가 그 변수명이었으나 클라에서만 확인한 값이라 netId 식으로 바꿨다. 서버에서 `setVehicleVarName` 한 차량은 클라에서 `var` 가 비었다.
- 3번: 유닛 37개, 그룹 6개를 `limit:100` 으로 받았다. 47행이 한국어 그대로 왔다. 쪽 상한 380 에서 18번 왕복에 2.9초가 걸려 상한을 440 으로 올리고 `label` 과 같은 종류명은 보내지 않게 했다.
- 4번: Zeus 선택을 만드는 명령이 없어 엔티티 트리에서 `tvSetCurSel` 로 골랐다. 그러자 `curatorSelected` 와 `source:"selected"` 에 그 유닛 하나가 나왔다. 고르기 전에는 빈 결과와 안내가 나왔다.
- 5번: palette `소총수` 가 34개, 모듈 `치료` 가 `PH_Mission_HealArea` 하나, groupTemplate `화력조` 가 `configFile >> "CfgGroups" >> ...` 식으로 나왔다.
- 6번: `주변 10m 완전 치료` 가 `consumed` 였고 플레이어 피해가 0.4 에서 0 이 됐다.
- 7번: `PH_Mission_VarName` 을 차량 ref 로 실행하자 `dialog` 였다. 창의 `PH_VarName_Target` 이 그 차량이었다.
- 8번: `텔레포트` 는 만들지 않고 후보 둘을 돌려줬다.
- 9번: ZEN `회복`(`zen_modules_moduleHeal`)을 AI 대상으로 실행하자 `consumed` 이고 피해가 0.5 에서 0 이 됐다. ZEN `무적으로 만들기` 는 `opensDialog:true`, 실행 결과 `dialog` 였고 클라에 IDD -1 창이 하나 늘었다.
- 지속형 모듈 `양`(`ModuleAnimalsSheep_F`)은 `persistent`, `curatorAdded:1` 이었고 서버 curator 편집 대상에 들어갔다.
- 10번: 스캐폴드 VR 미션 SP 에서 같은 방식으로 curator 를 배정했다. 모든 exec 가 server 모드였고 결과 `machine` 은 `server` 였다.
  ref 는 `0:2` 꼴이었고 `BIS_fnc_groupFromNetId`, `BIS_fnc_objectFromNetId` 로 되찾아졌다. `주변 10m 완전 치료` 는 `consumed`(피해 0.4 에서 0), `2_변수명 지정` 은 `dialog` 이고 창 대상이 그 차량이었다.

## 실게임 E2E: 게임 시간 정지와 하트비트

격리 데몬의 이름 있는 스택으로 SP 를 띄운다. `baseArgs` 에서 `-noPauseAudio` 를 뺀다.
0.5.4 다음 릴리스부터 데몬이 `-noPause` 를 늘 넣는다. 아래 2026-10-15 실측은 `-noPause` 없이 했다.
4번의 일시정지 메뉴는 포커스와 상관없는 일시정지라 `-noPause` 로 풀리지 않을 것으로 보지만, `-noPause` 를 넣고 다시 재지는 않았다.

1. `cli play --stack <id> --mode sp --mod <저장소 빌드 모드>` 로 인게임까지 간다.
2. `arma_mission_info { fresh:true }` 에 `fpsMin`, `scripts`, `paused`, `focused` 가 있어야 한다.
3. exec 로 `EachFrame` 에서 5초(`diag_tickTime`)마다 `time`, `isGamePaused`, `isGameFocused`, `diag_fpsMin`, `diag_activeScripts` 를 `diag_log` 하게 둔다.
4. exec 로 `(findDisplay 46) createDisplay "RscDisplayInterrupt"` 를 열고, 같은 `EachFrame` 에서 실제 시간 25초 뒤 닫게 한다.
   일시정지 중에는 스케줄러가 멈춰서 닫는 exec 를 따로 보낼 수 없다.
5. 일시정지 동안 `arma_status` 를 5초마다 본다. `linkPhase:'live'`, 같은 `gameGeneration`, `game.paused:true` 와 멈춘 `game.missionTime` 이 15초 넘게 이어져야 한다.

2026-10-15 실측(Arma 3 2.22, 저장소 빌드 `@AHC_ArmaMCP` 하나, 스택 `lobby`):

- 2번: `fpsMin` 100, `scripts` `{spawn:0,execVM:0,exec:0,fsm:1}`, `paused:false`, `focused:true`.
- 5번: 25초 동안 `missionTime` 189.7 고정, `paused:true`, `linkPhase:'live'`, 세대 1 그대로, `lastFrameAgeMs` 최대 4.6초. 데몬 로그에 끊김 줄이 없었다.
  클라 RPT 의 3번 줄은 그동안 `tick` 이 198 에서 223 으로 늘고 `time=189.702` 그대로였다. 일시정지 중에도 `EachFrame` 이 돈다.
- 창에 `WM_ACTIVATEAPP` false 만 보내자 `focused:false` 가 됐지만 게임 시간은 흘렀고 FPS 가 약 56 으로 묶였다. `-autotest` SP 는 비활성이어도 멈추지 않는다.
- Windows 전경 창이 브라우저였는데도 처음에는 `focused:true`, FPS 115 였다. `isGameFocused` 는 전경 창이 아니라 창이 받은 활성 메시지를 따른다.

## 실게임 E2E: 창 4분할

게임 창을 놓을 데몬 하나로 한다. 창 타일러는 데몬 하나에 하나만 돌고 다른 창 배치 도구와 함께 돌리지 않는다.
주 모니터 작업 영역이 2560x1392 이면 칸은 1280x696 이고, 칸 안의 창은 클라이언트 1168x657(16:9), 바깥 창 1184x696 이다.
다른 모니터 칸은 그 모니터 작업 영역의 4분의 1 이다. 창의 렌더 해상도는 `getResolution` 의 앞 두 값으로 본다. 클라이언트 영역과 같아야 한다.

1. 스택 하나에 SP 클라 하나를 띄운다. 창이 띄운 크기와 자리 그대로여야 하고 데몬 로그에 `[tiler] 옮김` 줄이 없어야 한다.
2. 다른 스택에 클라 하나를 더 띄운다. 먼저 뜬 창이 왼쪽 위, 나중 창이 오른쪽 위로 가야 한다. `arma_status` 의 `windowTiler` 에서 `slot` 0, 1 을 본다.
   `arma_capture { stack }` 의 `windowRect` 가 칸 안 창 크기여야 하고, 앞 창(foreground)이 바뀌지 않아야 한다.
   나중 창은 데몬 로그에 `창 타일러 칸 크기로 띄움` 이 남고, 두 창 모두 인게임에서 `getResolution` 이 클라이언트 영역 크기여야 한다.
3. 클라 넷이 되게 더 띄운다(스택 하나의 `clients:2` 도 된다). 네 칸이 다 차야 한다. `clients:2` 실행의 `windowLayout.mode` 는 `tiled` 다.
4. 다섯째를 띄운다. 모니터가 둘 이상이면 그 창이 주 모니터 밖에서 가장 왼쪽 모니터의 왼쪽 위(`slot` 4)로 가야 한다.
   모니터가 하나면 옮기지 않고 데몬 로그에 `칸이 없음` 이 한 번 남아야 한다.
5. 한 창을 마우스로 끌어 옮긴다. 데몬 로그에 `손대지 않음` 이 남고 그 창이 칸으로 돌아오지 않아야 한다.
6. 한 창을 닫는다. 그 칸이 비고, 칸 없던 창이 다음 관찰에서 그 칸을 받아야 한다.
7. 사람이 직접 띄운 Arma 가 함께 떠 있으면 데몬 로그에 `무시: pid <그 pid> 데몬이 띄운 스택 게임이 아님` 이 남고 그 창은 그대로여야 한다.

2026-10-18 실측(Arma 3 2.22, 격리 데몬, `windowTiler.stacks` `["t56*"]`, 주 모니터 2560x1440 배율 100%, 작업 영역 2560x1392, `--modset none`).

- 1번: `t56a` SP 창이 `(0,461) 1616x939` 그대로였다. 로그에 `옮김` 이 없었다.
- 2번: `t56b` 를 띄우자 `t56a` 가 `(0,0) 1280x696`, `t56b` 가 `(1280,0) 1280x696` 으로 갔다. `옮김` 뒤 0.3초와 2.4초에 `맞춤` 이 찍혔다.
  `arma_capture` 이미지가 둘 다 1280x696 이었고 앞 창(foreground) pid 는 띄우기 전과 같았다.
- 3번: `t56c` 에 `--mode mp --clients 2` 로 넷을 채웠다. `windowLayout` 이 `mode:"tiled"`, `size` 1264x657 이었고 클라 둘이 왼쪽 아래, 오른쪽 아래로 갔다.
  서버 콘솔 창은 옮기지 않았다. 클라 2 는 `Addon 'AHC_ArsenalExt' requires addon 'ace_arsenal'` 대화상자(381x159)에서 멈췄고 타일러는 그 작은 창을 옮기지 않았다.
- 6번: `t56a` 를 끄자 `칸 1 비움` 이 찍혔고, 다시 띄운 `t56a` 가 왼쪽 위를 받았다.
- 5번(사람이 끌기)과 4번(다섯째)은 단위 시험으로 갈음했다. 동시 게임 창을 넷으로 묶은 규칙 때문이다.
- 이때 찾은 두 가지를 고쳤다. 시작 화면(512x256, 제목 표시줄 없음)을 전체 화면으로 적었고,
  시작 화면이 닫히고 게임 창이 뜨는 사이 창 수가 2에서 1로 깜빡였다. 이제 게임 프로세스를 센다.

2026-11-02 16:9 칸과 렌더 해상도(Arma 3 2.22, 격리 데몬, `windowTiler.stacks` `[]`, 스택 폴더는 공유 데몬과 다른 곳, 같은 주 모니터, `--modset none`, Stratis).

- 0.5.9 의 칸 1280x696 은 클라이언트 1264x657(1.92:1)이었다. 새 프로필의 `fovLeft/fovTop` 은 1.33333/0.75(16:9)이고 화면 비율 설정은 `Auto (Stretch)` 였다.
  사람이 그 창을 1630x946 으로 다시 끌어 키운 기록이 공유 데몬 로그에 두 번 있었다.
- 1번: `a169` 가 1600x900 으로 떴고 `getResolution` 이 `[1600,900,1020,765,1.77778,0.85,0.75,1.33333]` 이었다.
- 2번: `b169` 를 띄우자 `a169` 가 `(96,0) 1184x696`, `b169` 가 `(1280,0) 1184x696` 으로 갔다. 두 캡처 모두 1184x696 이었다.
  인게임이던 `a169` 는 `getResolution` 이 1168x657 로 바뀌었다. 로딩 중에 줄어든 `b169` 는 인게임이 된 뒤에도 1600x900 그대로였다.
  `b169` 를 인게임에서 한 번 더 옮기자(타일러가 칸으로 되돌림) 1168x657 이 됐다. 그래서 칸에 놓일 클라를 칸 크기로 띄우게 했다.
- 데몬을 새 번들로 다시 띄웠을 때 두 창은 이어받았고 옮기지 않았다.
- 3번 대신 `c169` 를 SP 로 더 띄웠다. 로그에 `[launch] 창 타일러 칸 크기로 띄움: 1168x657` 이 남았고 `Arma3.cfg` 의 창과 렌더 크기가 1168x657 이었다.
  타일러는 자리만 `(96,696)` 으로 옮겼고, 인게임 첫 `getResolution` 이 1168x657, `samplingPercentage` 100 이었다.

## 실게임 E2E: 포커스 가드

뒤에 있는 창 모드 게임이 다른 창에 친 키를 쓰지 않는지 본다. 공유 데몬을 두고 격리 데몬 하나로 한다.
격리 데몬 설정은 `windowTiler` 를 `{ "enabled": false, "stacks": ["<시험 스택 패턴>"], "focusGuard": true }` 로 둔다.
공유 데몬의 타일러와 같은 창을 다투지 않게 시험 스택 이름은 공유 데몬의 `windowTiler.stacks` 밖으로 고른다.
키는 사람이 쓰는 창에 절대 보내지 않는다. 자기가 만든 빈 창을 앞에 두고, 보내기 직전에 앞 창 pid 가 그 창인지 확인한다.
사람의 입력이 20초 넘게 없을 때만 그 창을 앞으로 가져오고, 끝나면 앞 창과 커서 자리를 되돌린다.

1. `cli play --stack <id> --mode mp --clients 2 --modset none` 으로 클라 창 둘을 띄운다. 데몬 로그에 클라마다
   `[tiler] 포커스 가드: <이름> 가 앞에 없어 비활성 알림을 보냄` 이 한 번 남아야 한다.
2. 클라마다 `(findDisplay 46) displayAddEventHandler ["KeyDown", ...]` 로 키와 `isGameFocused` 를, `EachFrame` 으로
   `isGameFocused` 가 바뀌는 때를 `systemTimeUTC` 와 함께 `diag_log` 하게 둔다(`exec --mode client --target <이름>`).
3. 두 창 다 뒤에 있을 때 `isGameFocused` 가 `false` 여야 한다.
4. 두 창에 `WM_ACTIVATE(WA_ACTIVE)` 를 `PostMessage` 로 넣어 표시가 켜진 채 뒤에 있는 상태를 만든다. 바로 RPT 에 `isGameFocused` 가 `true` 로 남는다.
   1.25초 안에 `false` 로 돌아와야 한다.
5. 4번 뒤 0.1초와 1.6초에 자기 빈 창으로 F13(VK 0x7C, DIK 100)을 보낸다. 0.1초 것은 받을 수 있고 1.6초 것은 두 클라 모두 받지 않아야 한다.
6. 창 하나를 앞으로 가져와 키를 누른다. 그 창이 `isGameFocused:true` 로 키를 받아야 한다. 다른 창으로 Alt+Tab 하면 눌린 채 남은 Alt 가 1초 안에 풀려야 한다.

포커스 가드가 없는 데몬(0.5.6)에서 같은 4번과 5번을 하면, 뒤에 있는 창이 F13 을 받고 `WM_ACTIVATE(WA_INACTIVE)` 를 넣기 전까지 계속 받는다.

2026-10-18 실측(Arma 3 2.22, 주 모니터 2560x1440, `--modset none`).

- 가드 없는 공유 데몬 0.5.6, 스택 `llm4` SP: 뒤에 있는 창에 `WA_ACTIVE` 를 넣자 20 ms 안에 `isGameFocused` 가 `true` 가 됐고,
  자기 빈 창에 보낸 F13 을 그 창이 `KeyDown 100` 으로 받았다. `WA_INACTIVE` 를 넣자 14 ms 안에 `false` 가 됐고 다음 F13 은 받지 않았다.
  그 전 8분 동안 눌린 채 남아 매 프레임 `KeyDown 56` 을 내던 Alt 도 이때 풀렸다.
- 같은 창에 `WA_INACTIVE` 를 18초 동안 100번 넣어도 FPS 가 56.3 에서 55.9 였고 창 자리와 크기는 그대로였다.
- 가드 있는 격리 데몬, 스택 `t90a`: SP 클라 하나를 12분, mp 클라 둘을 20분 넘게 뒤에 두는 동안 사람이 터미널에 계속 키를 쳤다.
  그동안 뒤에 있는 창에 기록된 `KeyDown` 은 없었다. 사람이 창을 앞으로 가져와 누른 키만 `focused=true` 로 남았다.
  Alt+Tab 으로 떠난 창에 눌린 채 남은 Alt 는 `KeyDown 56` 세 번(0.2초) 뒤 멈췄다.
  이때 빌드는 `PostMessage` 로 알리고 앞으로 온 창에 활성 알림을 다시 보냈다. 그 활성 알림이 화면 보호기 저장값을 덮고,
  늦게 처리되면 떠난 창을 다시 켤 수 있어 `SendMessageTimeout` 으로 바꾸고 활성 알림을 뺐다.
- 바꾼 빌드로 격리 데몬을 다시 띄우자 떠 있던 클라 둘을 이어받아 바로 비활성 알림을 보냈다. 헬퍼에 `deact` 를 직접 넣으면
  두 창 모두 `ok:true`(게임이 처리를 마침)였고, 같은 창을 곧바로 다시 넣으면 `why:"queued"` 로 겹쳐 넣지 않았다.
- 마지막 빌드(헬퍼가 알림을 따로 도는 스레드에서 보내고 활성 알림을 안 보냄)로 SP 클라 하나를 새로 띄웠다. 뒤에 있는 동안
  `isGameFocused` 는 `false` 였고, `deact` 를 직접 넣으면 `ok:true` 였으며 데몬 로그에 실패 줄이 없었다.
- 이 PC 는 화면 보호기 프로그램이 없어 `SPI_GETSCREENSAVEACTIVE` 가 늘 0 이었다. 화면 보호기 되돌리기는 실게임으로 보지 못했다.

## 실게임 E2E: 메인 화면 연결 창

호스트 CLI 설정을 건드리지 않도록 `CLAUDE_CONFIG_DIR` 과 `CODEX_HOME` 을 임시 폴더로 준 환경에서 게임을 직접 띄운다. 그 환경은 DLL 이 실행하는 CLI 까지 이어진다.
`-mod` 에는 `dist\release\@AHC_ArmaMCP` 의 절대 경로를 준다. 상대 경로를 주면 게임 폴더 기준으로 찾아 모드가 빈 채로 뜬다.
Arma 는 메시지로 보낸 클릭을 받지 않는다. 화면 도구로 누를 때는 실제 커서로 보낸다.

| 시험 | 방법 | 확인할 것 |
|---|---|---|
| 메인 화면 줄 | 게임을 띄운다. `-skipIntro` 있을 때와 없을 때 모두 | SITREP 바로 위에 뜬다. 연결되면 "연결됨" 으로 바뀌고 흐려진다 |
| 연결 | 연결을 누른다 | `connect.log` 에 marketplace list, add, install, list 가 차례로 남고 연결됨이 된다 |
| 기존 등록 | `ahc` 마켓플레이스를 다른 주소로 등록해 두고 연결한다 | add 를 부르지 않고 등록을 그대로 둔다 |
| 해제 | 해제를 누른다 | uninstall 뒤 체크 칸으로 돌아온다. 마켓플레이스는 남는다 |
| 복사 | 복사를 누른다 | 클립보드에 한글이 그대로 들어간다 |
| 실패 | 없는 저장소를 받게 하거나 네트워크를 끊는다 | 오래 멈추지 않고 실패 화면과 CLI 원문이 뜬다. 원문에 사용자 이름이 없다 |
| 진행 | 느린 `claude.cmd` 대역을 Path 앞에 둔다 | 단계 글과 막대가 움직이고 `.cmd` 호스트도 실행된다 |
| 준비 필요 | `ARMA_MCP_CONNECT_HIDE=node,git` | Node.js, Git 줄과 받기가 뜬다 |
| 앱 없음 | `ARMA_MCP_CONNECT_HIDE=claude,codex` | Claude Code, Codex 줄과 받기가 뜬다 |
| 확장 막힘 | DLL 없이 PBO 만 든 모드로 띄운다 | BattlEye 안내와 닫기만 뜬다 |
| 미션에서 호출 | 미션 안에서 `"arma_mcp" callExtension ["connectRun", ["claude"]]` 와 `["copySay", [controlNull]] call AHC_ArmaMCP_fnc_connectAction` | 모두 `err:denied` 이고 `connect.log` 에 `refused ...: called in mission` 이 남는다. 클립보드가 안 바뀐다 |
| 브리지 회귀 | 같은 빌드로 `arma-mcp play --modset none` | 모드 하나로 인게임까지 들어가고 RPT 오류가 없다 |

`ARMA_MCP_CONNECT_HIDE` 는 시험 전용이다. 쉼표로 나눈 이름을 찾지 못한 것으로 친다.

## 알려진 한계

- `<nil>` 은 정상 nil 과 엔진이 삼킨 soft error 를 인밴드로 구분할 수 없다 — RPT 가 유일한 진실(`rptErrors` 자동 첨부로 대응).
- 전술지도 뷰어의 화면을 특정 좌표로 이동시키는 SQF/WS API 가 없다 — 마커·자막으로만 유도할 수 있다.
- TacMap 치트는 전부 반환값이 없고 지휘관 좌석·쿨다운 게이트를 조용히 통과시키므로, 툴이 관측값(마커 수)으로 실효를 추정한다.
- `all` 모드의 결과 개수는 CBA 없이는 사전에 알 수 없다 — `timeoutMs` 가 수집 창(또는 `expectN` 지정).
- 동시 SQF 실행의 RPT 오류는 같은 엔진 로그 구간에 섞일 수 있다 — reqId·세션 태그로 상관하고 응답 note를 확인한다.
- 활성 미션 전 로비에서는 애드온 postInit이 실행되지 않으므로 프로세스/RPT 도구 외의 SQF 기능은 사용할 수 없다.
- `arma_play` 의 로비 역할 자동 배정은 2.22 의 서버 훅 `OnAutoSelectRole` 과 `getRoles` 에 기댄다. 그보다 오래된 서버는
  훅을 모르므로 `skipLobby` 기본 배정만 된다. 미션 `description.ext` 가 `skipLobby = 0;` 이면 로비에서 사람이 고른다.
  `skipLobby` 는 시험 서버에 들어오는 모든 사람에게 적용된다.
- 스캐폴드 미션의 `respawn = 2`(INSTANT)는 죽은 자리에서 부활한다. 물에서 죽으면 물에서 부활하며
  스폰 보정은 미션 시작 시점에만 돈다.
- 배포 시 Arma 가 실행 중이면 DLL 파일이 잠긴다. 게임을 끈 뒤 다시 넣는다.
