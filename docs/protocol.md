# Arma-MCP 와이어 프로토콜 v1

MCP 서버(Node/TS) ↔ `arma_mcp_x64.dll`(인게임 확장) 간 계약 문서. TS·C++·SQF 세 구현이 모두 이 문서를 따른다.

## 전송 계층

- **MCP 서버가 소켓 서버**, DLL이 클라이언트. DLL은 미션 로드 시 접속하고, 소켓 종료 = 미션 종료/게임 종료로 해석한다.
- 로컬 기본: named pipe `\\.\pipe\arma_mcp` (byte 모드). TCP `127.0.0.1:5301`은
  loopback 진단용 옵션이며 기본 비활성이다. 인증이 없는 게임 브리지 TCP를 LAN에 노출하지 않는다.
- DLL은 서버 부재 시 백오프 재접속: 250ms에서 시작, 실패마다 ×2, 상한 5s.
- 파이프 하나에는 동시 접속 1개만 유지: 새 접속이 들어오면 기존 소켓을 destroy하고 대체한다.
- 테스트 스택마다 파이프가 따로다. default 스택은 `\\.\pipe\arma_mcp`, 이름 있는 스택 `<id>` 는
  `\\.\pipe\arma_mcp_s_<id>` 다. 데몬은 자기가 띄우는 게임 프로세스에 환경 변수
  `ARMA_MCP_GAME_PIPE=<그 스택 파이프>` 를 준다. DLL 은 이 값이 `\\.\pipe\` 로 시작하고 256바이트 이하이며
  제어 문자가 없으면 SQF 의 `config` 가 준 파이프 이름 대신 쓴다. 사람이 띄운 게임에는 값이 없어 SQF 이름을 쓴다.
  SQF 는 바뀌지 않았다. 0.5.0 이전 DLL 은 이 값을 무시하므로 데몬은 이름 있는 스택을 띄우기 전에
  배포된 DLL 버전을 확인한다.

## 프레임 형식

```
[4바이트 LE uint32 payload 길이][payload: UTF-8 JSON]
```

- 최대 프레임 크기 `1 MiB`. 길이 프리픽스가 이를 초과하면 스트림이 깨진 것 — 즉시 연결을 끊는다.
- 모든 payload는 JSON 객체이며 `"v": 1` 필드를 반드시 포함한다. 알 수 없는 `type`은 경고 로그 후 무시(전방 호환).

## 게임 → 서버 프레임

| type | 발신 주체 | 시점 |
|---|---|---|
| `hello` | DLL (자동) | 소켓 접속 직후 |
| `sessionInfo` | SQF 애드온 | 접속 상승엣지 + `telemetryRequest` 응답 시 |
| `telemetry` | SQF 애드온 | 주기(기본 5s) + `telemetryRequest` 응답 시 |
| `execResult` | SQF 애드온 | exec를 실행한 머신마다 1건 |
| `heartbeat` | SQF 애드온 | 텔레메트리 주기에 편승 |

### hello
```json
{"v":1,"type":"hello","role":"arma-ext","ver":"ArmaMCP 0.5.13","pid":4242}
```
- `pid`: 게임 프로세스 id(0.5.0 부터). 라우팅에는 쓰지 않고 `arma_status` 의 `dllPid` 진단에만 쓴다.
  이전 DLL 은 보내지 않는다.

### sessionInfo
```json
{"v":1,"type":"sessionInfo","world":"Altis","mission":"co40_op","briefing":"Operation X",
 "server":"hostname","dedicated":1,"multiplayer":1,"cba":1,
 "ace":1,"aceVersion":"3.21.0.110","aceComponents":["ace_common","ace_medical","ace_cargo"],
 "tacmap":1,"tacmapZeusTool":1,"t":123.4}
```
- `dedicated`/`multiplayer`/`cba`/`ace`/`tacmap`/`tacmapZeusTool`는 0|1 숫자.
- `aceVersion`: ACE `CfgPatches >> ace_main >> version` (없으면 "").
- `aceComponents`: 감지된 ACE 컴포넌트 CfgPatches 클래스 배열(예 `ace_medical_treatment`). ACE 없으면 `[]`.
  에이전트는 서브시스템 함수를 호출하기 전 해당 컴포넌트가 목록에 있는지 확인한다.
- `tacmap`: `CfgPatches >> AHC_TacticalMap` 존재 여부. TacMap은 CfgPatches에 `version` 항목이 없어 버전은 보고하지 않는다.
- `tacmapZeusTool`: `CfgPatches >> AHC_ZeusTool` 존재 여부. **무전 자막의 동작 여부가 아니라 사운드(`PH_radio_on/off`) 유무만 결정한다** (`docs/tacmap.md` 참조).
- **하위 호환**: 구버전 `@arma_mcp` PBO는 `tacmap`/`tacmapZeusTool`을 보내지 않는다. 서버는 필드 부재를
  `false`가 아니라 **`null`(미상)** 로 유지하며, 툴은 이를 하드 게이트로 쓰지 않는다(최종 판정은 조립 SQF의 `isNil` 가드).

### telemetry
```json
{"v":1,"type":"telemetry","reqId":"","world":"Altis","mission":"co40_op",
 "time":734.2,"date":[2035,7,6,14,30],"fps":48.5,
 "players":[["이름","WEST","76561198...",1]],"playerCount":12,"hcCount":0,"t":123.4,
 "clients":[["이름",10,0,1]],"fpsMin":31.2,"scripts":[4,1,0,2]}
```
- `fpsMin`: 최근 프레임 중 가장 낮은 FPS(`diag_fpsmin`).
- `scripts`: 지금 돌고 있는 스크립트 수 `[spawn, execVM, exec, execFSM]`(`diag_activeScripts`).
- `paused`, `focused`: 0|1. 일시정지 메뉴(`isGamePaused`)와 게임 창 포커스(`isGameFocused`)다.
  창이 있는 머신(SP, 플레이어가 연 서버)만 보낸다. 데디 서버는 둘 다 보내지 않는다.
  SP 는 일시정지 메뉴가 열리면 `time` 이 멈춘다. MP 는 계속 돈다.
- **하위 호환**: 구버전 PBO 는 `fpsMin`, `scripts`, `paused`, `focused` 를 보내지 않는다. 서버는 필드 부재를
  **`null`(미상)** 로 유지한다.
- `players` 항목: `[name, side, uid, isPlayer(0|1)]`. SQF가 중첩 배열째로 JSON을 만들고 DLL은 그대로 봉투만 씌운다.
- `reqId`: `telemetryRequest`에 대한 응답이면 해당 reqId, 주기 push면 빈 문자열.
- `hcCount`: HC(HeadlessClient) 수. 서버가 all 모드 exec의 기대 응답 머신 수(expectN)를
  유도할 때 가산한다. 구버전 PBO는 필드를 보내지 않으며 서버는 0으로 간주한다.
- `clients` 항목: `[displayName, clientStateNumber, isHC(0|1), hasUnit(0|1)]`. `getUserInfo` 에서 온다.
  `players`(allPlayers 기반)와 달리 **슬롯을 고르기 전 로비 접속자도 보인다.** `arma_play` 가
  "로비에 있음" 과 "인게임" 을 가르는 근거다.
- `clientStateNumber`는 **문자열이 아니라 숫자다**(`getUserInfo` 6번 항목 = `getClientStateNumber`).
  0 NONE, 1 CREATED, 2 CONNECTED, 3 LOGGED IN, 4 MISSION SELECTED, 5 MISSION ASKED,
  6 ROLE ASSIGNED, 7 MISSION RECEIVED, 8 GAME LOADED, 9 BRIEFING SHOWN, 10 BRIEFING READ,
  11 GAME FINISHED, 12 DEBRIEFING READ. 서버는 **10(BRIEFING READ)만 인게임으로 판정한다**
  (`playOrchestrator.ts` 의 `IN_GAME_CLIENT_STATE`). 이름 대응표는 `telemetry.ts` 의
  `CLIENT_STATE_NAMES` 하나뿐이다.
- **하위 호환**: 싱글플레이와 구버전 PBO는 `clients`를 보내지 않는다. 서버는 필드 부재를 빈 배열이
  아니라 **`null`(미상)** 로 유지하고, 그때만 `playerCount`로 물러선다. 0.4.1 이전 PBO는 이 자리에
  문자열을 실었고 그 값은 애드온의 타입 오판 탓에 상태와 무관했다. 서버는 숫자가 아닌 값을
  **`-1`(미상)** 로 받고, 그때는 `hasUnit` 만으로 판정한다.

### execResult
```json
{"v":1,"type":"execResult","reqId":"a1b2c3d4e5f6","machine":"server","result":"SCALAR: 2","label":"agent","t":123.4}
```
- `machine`: `"server"` 또는 플레이어 이름.
- `result` 문자열 시맨틱 (fn_execRunLocal 계약과 동일, 500자 캡):
  - `"TYPE: value"` — 성공 (예: `SCALAR: 2`, `ARRAY: [1,2]`)
  - `"<nil> (if unexpected, check RPT for 'Error in expression')"` — 정상 nil **또는** 엔진이 삼킨 soft error. 인밴드 구분 불가, RPT가 유일한 진실.
  - `"ERROR: aborted (see RPT)"` — 하드 중단 (uncaught throw, nil-as-code 호출)
  - `"ERROR: parse failed (see RPT)"` — compile이 CODE가 아닌 값을 반환한 희귀 케이스
  - `"ERROR: empty code"` / `"ERROR: no unit named <name>"` — 디스패치 단계 오류

### heartbeat
```json
{"v":1,"type":"heartbeat","up":734,"t":123.4}
```
- 보내는 주기는 실제 시간(`diag_tickTime`)으로 잰다. SP 게임 시간이 멈춰도(일시정지 메뉴)
  하트비트는 계속 가고 링크는 `link.staleAfterMs` 에 걸리지 않는다. 일시정지 중에도 `EachFrame` 은 돈다.
- `up` 은 게임 시간(`time`)이다. 하트비트가 오는데 `up` 이 그대로면 게임 시간이 멈춘 것이다.

## 서버 → 게임 프레임

| type | 용도 |
|---|---|
| `exec` | SQF 실행 요청 |
| `telemetryRequest` | sessionInfo + telemetry 즉시 push 요청 |
| `ping` | 라이브니스 (DLL 내부 처리, SQF 미전달). 서버가 `link.sweepMs`(기본 5s)마다 능동 전송 — 파이프가 깨져 있으면 write 실패로 단절 감지를 앞당긴다 |

### exec
```json
{"v":1,"type":"exec","reqId":"a1b2c3d4e5f6","mode":"server","target":"","code":"1+1","label":"agent"}
```
- `mode`: `server` | `all` | `client`. `client`면 `target` = 플레이어 이름 필수.
- `label`: 인게임 감사 로그 라벨. `arma_exec` 입력에서 미지정하면 TS 서버가 `"agent"`를 넣고 최대 60자로 제한한다. 명시한 라벨은 그대로 전달하며, 구버전 protocol-v1 송신자가 필드를 생략하면 브리지는 빈 라벨로 수용한다.
- `code`는 서버(TS)에서 이미 주석 제거/검증된 SQF. **exec 경로는 `compile`만 하고 preprocess를 하지 않으므로 `//`, `/* */` 주석이 남아 있으면 코드가 조용히 `<nil>`로 파손된다** — 주석 제거는 TS 서버 책임.
- 크기 상한: 코드 128 KiB (설정 가능), 프레임 전체 1 MiB.

### telemetryRequest
```json
{"v":1,"type":"telemetryRequest","reqId":"a1b2c3d4e5f6"}
```

## DLL 내부 계약

- 인바운드 프레임은 DLL이 `type`을 파싱해 `parseSimpleArray` 안전 문자열 배열로 변환, 큐에 적재:
  - `exec` → 콜백 function `"exec"`, payload `["reqId","mode","target","code","label"]`
  - `telemetryRequest` → 콜백 function `"telemetryReq"`, payload `["reqId"]`
- SQF는 매 프레임 `"arma_mcp" callExtension "poll"`로 큐를 드레인. 엔진 콜백 이름은 `"AHC_ArmaMCP"`.
- 아웃바운드 push 명령(`pushSession`/`pushResult`/`pushTelemetry`/`pushHeartbeat`)은 SQF가 만든 **JSON 객체 body 1개**를 받고, DLL이 `{"v":1,"type":"<고정>", ...body}` 봉투를 스탬프한다(WrapBody). `hello`만 DLL이 자체 생성.
- `openUrl` 은 **로컬 전용 커맨드**(와이어 프레임 무관 — 프로토콜 v1 무변경): `[url]` 을 받아
  스킴 검증(http/https, 공백·제어문자·따옴표·백슬래시 금지, ≤2048B) 후 분리 스레드에서
  기본 브라우저를 연다. Bridge/IPC 와 완전 무관하므로 MCP 서버가 없는 플레이어 머신에서도 동작한다.
- 모든 export는 즉시 반환. 소켓 I/O는 워커 스레드 전담. 예외는 절대 C ABI를 넘지 않는다.

## 메인 화면 연결 명령

메인 화면의 **AI 에이전트 연결** 창이 쓰는 로컬 전용 명령이다. 프로토콜 프레임과 무관하고 게임 파이프에 붙지 않는다.
파이프는 새 접속이 기존 접속을 끊으므로 메인 화면에서는 건드리지 않는다. 메인 화면에는 미션이 없고 스케줄러를 믿을 수 없어 SQF 는 화면 이벤트로 돈다.

| 명령 | 인자 | 하는 일 |
|---|---|---|
| `connectState` | 없음 | 상태 배열을 돌려준다. 검사하지 않는다 |
| `connectProbe` | 없음 | Node.js, Git, 호스트 CLI 를 찾고 연결 상태를 읽는다. `bridge-mod.json` 도 적는다 |
| `connectRun` | 호스트 id 여럿 | 마켓플레이스가 없으면 등록하고 플러그인을 설치한다 |
| `connectRemove` | 호스트 id | 플러그인을 지운다. 마켓플레이스 등록은 남긴다 |
| `copyText` | 글 | 클립보드에 넣는다. SQF `copyToClipboard` 는 클립보드를 바꾸지 않는다 |

- 상태 배열은 문자열만 든 평평한 `parseSimpleArray` 배열이다. `[phase, nodeFound, gitFound]` 뒤에 호스트마다 `id, found, connected, activity, percent, failed, failText` 가 온다. `failText` 의 줄바꿈은 `|` 다.
- `connectState` 를 뺀 명령은 엔진이 `RVExtensionContext` 로 알려 준 호출자가 메인 화면의 `fn_connect*.sqf` 일 때만 실행한다. `missionName`, `serverName`, `remoteExecutedOwner` 가 있으면 거절한다. 거절은 `err:denied` 로 돌려주고 `%LOCALAPPDATA%\Arma-MCP\connect.log` 에 까닭을 남긴다. SQF 검사는 경계가 되지 못한다. 어떤 SQF 든 확장을 직접 부를 수 있기 때문이다.
- 명령행의 인자는 모두 DLL 안의 상수다. SQF 에서 온 글은 명령행에 들어가지 않는다. 호스트 id 는 고정 표에서 고르는 데만 쓴다.
- DLL 이 실행하는 CLI 는 작업 스레드에서 돌고, Git 로그인 창이 뜨지 않게 `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` 를 준다. 게임을 꺼도 CLI 를 끊지 않는다.
- 데몬이 띄운 게임(`ARMA_MCP_GAME_PIPE` 가 있는 게임)은 `bridge-mod.json` 을 적지 않는다. 그 모드 경로는 스택의 임시 폴더일 수 있다.

## 라이프사이클

1. 미션 postInit → SQF가 `config`(pipe/tcp 설정) → `shutdown` → `start` (미션마다 새 소켓 강제).
2. DLL 워커가 접속 성공 → `hello` 즉시 송신.
3. SQF 텔레메트리 루프가 `status`로 접속 상승엣지 감지 → `sessionInfo` push. (서버가 게임보다 늦게 떠도 스냅샷 수신 보장)
4. 서버 재시작 → DLL이 백오프 재접속 → 2~3 반복.
5. 미션 종료("Ended" 이벤트) → SQF가 `shutdown` → 소켓 종료 → 서버는 pending exec 실패 처리, 미션 정보를 lastKnown으로 강등.
6. half-open 방어: 서버는 마지막 수신 프레임 후 `link.staleAfterMs`(기본 15s = heartbeat 3회 상실) 경과 시
   링크를 죽은 것으로 간주해 강제 단절한다(5 참조 경로 재사용). 게임 크래시 등으로 FIN 없이 끊겨도
   exec 가 풀 타임아웃을 소모하지 않는다.
