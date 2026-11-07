# Arma-MCP 툴 레퍼런스

모든 툴은 JSON 텍스트 1개를 반환한다. 게임이 필요한 툴은 미접속 시 예외 없이
`{ok:false, error:...}` 형태로 응답하므로 에이전트가 상황에 맞게 대응할 수 있다.

셸에서 이 툴들을 이어 부르는 `arma-mcp` 명령은 [CLI 안내](cli.md)에 있다.

## 호출 취소

클라이언트가 `notifications/cancelled` 로 호출 하나를 취소하면 그 호출의 대기가 멈춘다. 세션은 그대로다.
cli 세션은 응답 전에 연결이 끊겨도 같다. 그때는 세션도 닫힌다.

- 멈추는 툴: `arma_exec`, `arma_watch`, `arma_status` 의 `waitFor`, `arma_rpt_wait`, `arma_launch`, `arma_launch_mp`, `arma_launch_server`, `arma_play`, `arma_scaffold_mission`, `arma_kill`, `arma_zeus_find`, `arma_zeus_module`.
- 취소된 `arma_zeus_module` 은 이미 만든 모듈을 지우지 않는다. 결과 관찰만 멈춘다.
- 실행 lease 를 쥔 툴은 멈출 때 lease 를 푼다. 이미 띄운 게임 프로세스는 끄지 않는다.
- 취소된 `arma_exec` 는 `capture` 를 찍지 않는다.
- `arma_watch` 는 데몬 쪽 대기만 멈춘다. 게임 안의 루프는 제 `timeoutMs` 까지 돈다. 바로 멈추려면 `watchId` 를 정해 두고 `stop` 을 보낸다.
- 취소된 `arma_kill` 은 이미 보낸 종료 신호를 되돌리지 않는다. 프로세스 종료와 잠금 해제 대기만 멈춘다.
- `arma_capture` 는 취소해도 끝까지 돈다.

## 테스트 스택

스택은 전용 서버 1대와 클라이언트 N대를 묶은 단위다. 한 PC 에서 스택 여러 개를 동시에 돌릴 수 있다.
에이전트 A 가 스택 `a` 에서 애드온 X 를, 에이전트 B 가 스택 `b` 에서 애드온 Y 를 같은 때 시험하는 식이다.

- 게임 도구는 모두 `stack` 입력을 받는다. 없으면 `default` 스택이다.
- `default` 스택은 0.4 의 파이프(`\\.\pipe\arma_mcp`), 포트(`mp.port`), 서버 profiles(`mp.profilesDir`),
  클라 RPT 폴더(`%LOCALAPPDATA%\Arma 3`)를 그대로 쓰고 클라 1 은 사용자 프로필로 뜬다. 스택을 모르는 호출은 전과 같다.
- 이름 있는 스택은 실행 계열 도구(`arma_launch`, `arma_launch_mp`, `arma_launch_server`, `arma_play`,
  `arma_scaffold_mission`)가 그 이름을 처음 받을 때 만든다. 이름은 소문자, 숫자, `_` 로 1~16자이고 소문자나 숫자로 시작한다.
  그 밖의 도구는 모르는 스택이면 `모르는 스택` 오류와 있는 스택 목록으로 답한다.
- 이름 있는 스택의 것은 모두 `stacks.root`(기본 `~/.arma-mcp/stacks`) 아래 `<id>\` 에 있다.

| 항목 | 이름 있는 스택 `<id>` |
|---|---|
| 게임 파이프 | `\\.\pipe\arma_mcp_s_<id>` |
| 게임 포트 | 만들 때 `mp.port + 10*k` 중 UDP 로 비어 있는 첫 자리. `stack.json` 에 적어 두고 계속 쓴다 |
| 서버 | `server\profiles`(RPT 가 여기 쌓인다), `server\server.cfg` |
| 클라 i | `client<i>\` 가 `-profiles` 이고 클라 RPT 도 여기 쌓인다. `-name=<id>_c<i>`, `-window`. 클라가 둘 이상이면 `-posX`, `-posY` |
| MPMissions 배치 | `<name>__<id>.<world>`. 다른 스택이 돌리는 같은 이름 미션을 지우지 않는다 |
| 즉석 미션 | `missions\` |
| 테스트 애드온 | `@arma_mcp_test\`, 겹친 기본 모드는 `overlay\<모드 폴더명>\` |

- 데몬은 자기가 띄우는 게임에 환경 변수 `ARMA_MCP_GAME_PIPE` 로 그 스택의 파이프를 준다. 0.5.0 DLL 은 그 파이프로 붙는다.
  배포된 DLL 이 0.5.0 보다 낮으면 이름 있는 스택 실행은 게임을 띄우기 전에 거절된다. 이전 DLL 은 기본 파이프로 붙어
  default 스택의 연결을 빼앗기 때문이다.
- 게임이 어느 스택 것인지는 명령줄의 `-profiles` 경로로 가린다. `stacks.root\<id>\` 아래면 그 스택, 그 밖(사람이 띄운 게임 포함)은
  default 다. 이름 있는 스택에서는 `-profiles`, `-name`, `-port`, `-config` 를 `clientExtraArgs` 나 `serverExtraArgs` 로 줄 수 없고,
  `arma.baseArgs` 와 `mp.serverBaseArgs` 에 있으면 빼고 쓴다. `port` 도 스택이 정한 값만 받는다.
- 실행 lease 는 스택마다 하나다. 스택 `a` 의 `arma_play` 가 도는 동안에도 스택 `b` 를 띄우고 끌 수 있다.
- `arma_kill` 은 그 스택의 프로세스만 pid 로 끈다. 다른 스택의 게임은 건드리지 않는다.
  `forget:true` 면 그 스택의 게임을 모두 끈 뒤 파이프를 닫고 스택 폴더를 지운다(default 는 지울 수 없다).
- 데몬이 다시 뜨면 `stack.json` 이 있는 스택의 파이프를 다시 연다. 돌던 서버가 제 파이프로 다시 붙는다.
- 스택 수 상한은 `stacks.max`(기본 4), 스택당 클라 수 상한은 `stacks.maxClients`(기본 4)다.
- 세션의 `lastExecCursor`(`arma_rpt_errors` 의 `since:'lastExec'`)는 스택마다 따로다.

### 다중 클라(`clients`)

`arma_launch_mp` 와 `arma_play`(mp)는 `clients` 를 받는다(기본 1). 클라마다 제 profiles 폴더, 이름, RPT 폴더를 받고,
앞 클라가 서버 텔레메트리의 `clients` 나 `players` 에 제 이름으로 보인 뒤 다음 클라를 띄운다. `clientConnectTimeoutMs` 는 클라마다 적용된다.
서버 브리지가 없는 로비 대기(`arma_launch_mp` 의 `autoInit:false`)는 접속을 판정하지 않고, 앞 클라의 RPT 가 생기면 다음 클라를 띄운다.

- `server.cfg` 에 `kickDuplicate = 0;` 이 들어간다. 한 PC 의 로컬 클라는 모두 같은 Steam ID 다. `maxPlayers` 는 클라 수 이상으로 올린다.
- 클라가 둘 이상이면 `server.cfg` 에 `loopback = true;` 도 들어간다. 이것이 없으면 둘째 클라가
  `Steam ticket check failed: Same Steam user already in game` 으로 킥된다. 서버가 LAN 모드로 열려 이 PC 의 클라만 붙는다.
  클라가 하나거나 서버만 띄우면 넣지 않는다.
- 클라마다 프로필이 다르다. 제 profiles 폴더를 받는 클라(default 스택은 둘째부터, 이름 있는 스택은 모두)는
  `arma.baseArgs` 의 `-profiles`, `-name` 을 쓰지 않는다. 클라가 둘 이상이면 `clientExtraArgs` 의 `-profiles`, `-name` 은
  모든 클라에 붙어 프로필이 겹치므로 실행 전에 거절한다.
- `arma_play` 는 로비 역할을 서버에 맡긴다. 서버 훅이 클라 이름(`-name`)으로 클라마다 `roles` 의 지정을 찾는다
  (아래 `arma_play` 의 로비 역할 자동 배정). `expectPlayers` 기본값은 클라 수다.
- 미션을 주지 않으면 즉석 미션에 플레이 가능한 슬롯을 클라 수만큼 만든다(`mcp_slot_0` 부터, 3m 간격).
- 클라를 띄울 때마다 사용자 문서 폴더(OneDrive 로 옮겨졌으면 그 자리)의 `Arma 3\Arma3.cfg` 를
  `client<i>\Users\<Windows 사용자>\Arma3.cfg` 로 가져온다. `-profiles` 를 받은 Arma 는 화면 설정을 이 자리에서 읽는다.
  창과 렌더 크기는 `stacks.windowWidth`, `stacks.windowHeight`(기본 1600x900, 16:9)로 바꿔 적는다. 사용자 파일이 없으면 크기만 적는다.
- 클라가 둘 이상이면 창 모드 클라마다 `-posX`, `-posY` 를 붙여 주 모니터 작업 영역(작업 표시줄을 뺀 자리) 안에 창을 겹치지 않는 격자로 놓는다.
  설정 크기로 다 안 들어가면 그 실행의 창을 설정 비율(기본 16:9)대로 들어갈 만큼 줄인다. 다 들어가면 설정 크기 그대로다.
  예: 2560x1440 화면(작업 영역 2560x1392)에 1600x900 둘은 1264x711 로 줄여 `-posX=8`, `-posX=1288` 에 놓는다.
  셋과 넷은 1168x657 로 2열 2행이고, 1920x1080 화면에 둘은 944x531 이다.
  줄인 폭이 640 보다 작아야 들어가면 줄이지 않는다. 그때는 설정 크기로 칸 간격을 좁혀 겹치되 화면 밖으로 나가지 않게 놓고 `warning` 에 적는다.
  `-posX`, `-posY` 는 클라이언트 영역의 자리라 바깥 창은 왼쪽 8, 위 31, 오른쪽과 아래 8 만큼 더 크다(Windows 11, 96 DPI 실측). 계산에 이 몫을 넣는다.
  Arma 는 DPI 를 인식하지 않아 배율이 100% 를 넘으면 논리 픽셀로 놓는다.
  `arma.baseArgs`, `clientExtraArgs` 에 `-x`, `-y`, `-posX`, `-posY` 중 하나라도 있으면 창 크기를 줄이지 않고, `-posX`, `-posY` 가 있으면 그 값을 따른다.
  default 스택 클라 1 은 창 모드가 아니라 크기와 자리를 받지 않는다.
- 창 4분할(`windowTiler.enabled`, 기본 켬)이 켜져 있으면 클라 둘에서 넷까지는 위 격자 대신 데몬의 창 타일러가 창을 놓는다.
  그때 클라는 칸 크기로 뜨고 `-posX`, `-posY` 를 받지 않는다. 칸 크기는 칸에 들어가는 가장 큰 설정 비율(기본 16:9) 클라이언트 영역이다.
  2560x1392 작업 영역이면 칸 1280x696, 클라이언트 영역 1168x657 이다. 칸이 다른 모니터면 그 모니터 칸 크기다.
  클라가 하나여도 다른 대상 게임 창이 떠 있으면 타일러가 놓으므로 칸 크기로 뜬다. `arma_launch` 와 `arma_play` 의 SP 도 같다.
  Arma 는 로딩 중에 바뀐 창 크기를 렌더 해상도에 반영하지 않아, 설정 크기로 띄운 뒤 줄이면 그 해상도로 칸에 눌려 그려진다.
  사용자가 `-x`, `-y` 를 줬으면 그 크기로 뜨지만 타일러가 칸에 놓으면서 칸 크기로 바꾼다. 클라가 다섯 이상이면 위 격자로 뜨고,
  뜬 뒤 타일러가 주 모니터 네 칸과 다른 모니터 칸에 놓는다. `windowTiler.stacks` 가 그 스택을 빼면 위 격자 그대로다.
  타일러는 [daemon 문서의 창 4분할](daemon.md#창-4분할)에 있다.
- 결과의 `client` 는 첫 클라이고 클라가 둘 이상이면 `clients[]` 에 모두 있다. 각 항목은 `{ index, launched, pid, argString, rpt, lobby?, window? }` 다.
  `lobby` 는 서버 텔레메트리로 접속을 판정했을 때만 있다. `window` 는 데몬이 정한 `{ width, height, x?, y? }`(창 크기와 `-posX`, `-posY`)이고 dryRun 에도 있다.
  클라가 둘 이상이면 결과의 `windowLayout` 이 `{ area, configured, size, mode, userArgs? }` 다. `mode` 는 `configured`(설정 크기로 들어감),
  `shrunk`(줄임), `floor`(하한에 걸려 겹침), `userArgs`(사용자 창 인자가 있어 손대지 않음), `tiled`(창 타일러의 칸 크기) 중 하나다.
- 둘째 클라부터의 RPT 는 `arma_rpt_* { client: <i> }` 로, 창은 `arma_capture { client: <i> }` 로 본다.

### 테스트 애드온(`testMods`)

큰 기본 모드는 원래 자리에서 모든 스택이 읽기 전용으로 함께 로드한다. 새로 빌드한 것만 `testMods` 로 준다.
`arma_launch`, `arma_launch_mp`, `arma_launch_server`, `arma_play` 가 받는다. 항목은 PBO 파일, `addons` 가 있는 작은 모드 폴더,
PBO 가 든 `addons` 폴더 중 하나다.

1. 스택의 게임이 꺼진 뒤 `<스택>\@arma_mcp_test` 로 복사하고 `-mod` 맨 뒤에 붙인다. 모드 폴더면 루트 DLL 도 복사한다.
   게임은 복사본을 잠그므로 원본 빌드 출력은 게임이 도는 동안에도 다시 빌드할 수 있다.
2. 새 PBO 의 헤더 `prefix` 나 파일 이름이 어떤 기본 모드의 `addons\*.pbo` 와 같으면, 그 기본 모드를 `<스택>\overlay\<모드 폴더명>` 으로
   다시 엮는다. 폴더는 새로 만들고 파일은 하드링크로 잇되 겹친 PBO 와 그 `.bisign` 과 겹친 DLL 은 뺀다. `-mod` 의 그 자리를 오버레이로 바꾼다.
3. 하드링크는 같은 드라이브에서만 된다. 다른 드라이브면 그 모드가 `stacks.overlayCopyMaxMB`(기본 1024) 이하일 때만 복사한다.
   넘으면 게임을 띄우기 전에 거절하고 `stacks.root` 를 둘 드라이브를 알려 준다. 고친 모드 PBO 를 시험하려면 `stacks.root` 를
   그 모드와 같은 드라이브에 둔다.
4. 테스트 애드온 전체가 `stacks.testModMaxMB`(기본 512)를 넘거나, 경로가 없거나, 같은 이름 파일이 둘이면 실행 전에 거절한다.
5. 결과의 `testMods` 는 `{ ok, dir, files[{source,name,bytes}], overlays[{base,path,excluded,method,files}] }` 다. dryRun 은 계획만 싣고 복사하지 않는다.

`modset:'rpt'` 가 RPT 헤더를 다시 읽을 때 오버레이는 원래 기본 모드로 되돌리고 스냅샷은 뺀다. 저장한 프로필도 같다.
`arma_play` 의 RPT 요약 `rpt.client` 와 `rpt.server` 에는 `conflictingAddons`(`Conflicting addon` 줄 수)가 붙는다.

```
arma_play { "stack": "a", "mode": "mp", "clients": 2, "testMods": ["E:\\src\\my_addon\\.hemttout\\build"] }
arma_play { "stack": "b", "mode": "sp", "testMods": ["E:\\src\\other\\.hemttout\\build\\addons\\other_main.pbo"] }
arma_exec { "stack": "a", "code": "count allPlayers" }
arma_kill { "stack": "b" }
arma_kill { "stack": "b", "forget": true }
```

## arma_exec — SQF 실행

라이브 미션에서 SQF 를 실행하고 결과를 반환한다.

| 입력 | 설명 |
|---|---|
| `code` (필수) | SQF 소스. 마지막 표현식이 성공 증거값이 되게 작성. |
| `mode` | `server`(기본) / `all` / `client` |
| `target` | `mode='client'` 일 때 대상 플레이어 이름 |
| `timeoutMs` | 결과 대기(ms). 기본 server/client=5000, all=3000. [500,600000] 클램프 |
| `expectN` | `all` 에서 N개 결과 수집 시 조기 완료. 미지정 시 텔레메트리로 유도(dedicated 는 `1+playerCount+hcCount`, listen/SP 는 `max(1, playerCount+hcCount)`). 캐시가 10s 이상 낡았으면 유도 실패 → `allQuietMs` 로 폴백 |
| `allQuietMs` | `all` 에서 마지막 결과 후 이 시간(ms) 무응답이면 조기 완료. 기본 800, 0=비활성(타임아웃까지 수집). [100,timeoutMs] 클램프 |
| `label` | 인게임 감사 로그 라벨(기본 `agent`, 최대 60자) |
| `comments` | `strip`(기본, 주석 제거) / `reject`(주석 발견 시 오류) |
| `checkRpt` | true 면 성공한 실행에서도 실행 구간 RPT 에러 블록을 스캔(기본 false). 결과가 `<nil>`/`ERROR` 이거나 결과 없이 타임아웃되면 이 값과 무관하게 항상 스캔한다 |
| `capture` | 실행이 끝난 뒤 게임 화면을 찍는다. `true` 면 기본값으로 찍는다. 객체면 `arma_capture` 와 같은 옵션(`target`, `scope`, `delayMs`, `format`, `quality`, `maxWidth`, `returnImage`)을 쓴다. `delayMs` 기본은 250 이다 |

출력: `{ ok, timedOut, completedBy?, durationMs, reqId, results:[{machine,result,parsed:{kind,type,value}}], rptErrors:[{line,block}], rptCursor, sanitized, note?, capture? }`

`rptCursor` 는 이 실행이 보내기 직전에 잡은 RPT 위치다. 모양은 `{ file, offset }` 이고 `file` 은 절대경로다.
RPT 파일이 없거나 빈 코드, 주석 거부, 크기 초과로 커서를 잡기 전에 멈췄으면 `null` 이다.
`arma_rpt_wait` 에 `file` 과 `fromOffset` 으로 넘기면 이 실행 뒤에 기록된 줄에서 패턴을 찾는다.
호출마다 세션을 새로 여는 클라이언트는 `since:'lastExec'` 가 이어지지 않으므로 이 값으로 잇는다.

`completedBy` 는 무엇이 대기를 끝냈는지: `first`(server/client 첫 결과) / `expectN`(목표 수 도달) /
`quiet`(정지 창) / `timeout` / `disconnect`. 유도는 HC(HeadlessClient)를 `hcCount` 로 포함하므로
보통은 `expectN` 을 직접 줄 필요가 없다 — 텔레메트리를 못 믿을 상황(구버전 PBO 라 `hcCount` 가
오지 않거나, 캐시가 10s 이상 낡은 경우)에만 명시한다.

`rptAttribution` 은 첨부된 `rptErrors` 가 있을 때만 실린다. 깨끗한 성공 결과에는 붙지 않는다.

`result` 문자열: `"TYPE: value"` 성공 | `"<nil> ..."` (정상 nil 또는 삼킨 soft error) |
`"ERROR: aborted (see RPT)"` | `"ERROR: parse failed (see RPT)"`. 500자 캡.
`parsed.kind` 이 `nil`/`error` 면 `rptErrors` 로 RPT 의 `Error in expression` 블록을 확인한다.
결과를 받은 뒤 RPT 를 훑을 때는 애드온 감사 줄(`[EXEC] result <- <machine> (reqId=...)`)이 RPT 에 보일 때까지
최대 1.5초 기다린다. 오류 블록이 그 줄보다 먼저 기록되므로 늦게 기록된 블록도 담긴다.
`nil`, `error` 결과와 `checkRpt:true` 가 모두 그렇다. 결과의 `machine` 은 가리지 않는다.
감사 줄은 늘 서버 쪽 RPT 에 남는다. sp 와 호스트 게임에서는 클라 RPT 가 곧 서버 RPT 이고 `machine` 은 플레이어 이름이다.
결과를 받은 시점에 RPT 가 아직 한 줄도 자라지 않았어도 기다린다. Arma 는 결과를 보낸 뒤에 RPT 를 쓰기 때문이다.
`-noLogs` 처럼 RPT 가 끝내 자라지 않으면 1.5초를 다 쓴다. 이 비용은 RPT 를 훑는 결과(`nil`, `error`, `checkRpt:true`)에만 든다.
결과 없이 타임아웃되면 하드 SQF 오류일 수 있어 실행 구간 블록을 담는다. 블록이 있으면 `note` 로 알린다.
그 `note` 는 `결과가 오지 않았다.` 로 시작한다. `mode:'all'` 에서 결과를 받은 뒤 끝난 타임아웃에는 붙지 않는다.

`capture` 를 주면 이미지 블록이 먼저 오고, 뒤의 JSON 에 `capture` 로 `arma_capture` 메타가 담긴다.
캡처가 실패해도 exec 결과는 그대로 오고 `capture` 는 `{ok:false, error}` 다.
게임이 연결되지 않았으면 찍지 않는다. `mcp.disableTools` 에 `arma_capture` 가 있어도 찍지 않는다.
주석 거부, 크기 초과, 빈 코드처럼 게임에 보내기 전에 멈춘 실행(`reqId` 가 빈 문자열)도 찍지 않는다.

```
arma_exec { "code": "count allUnits" }
arma_exec { "code": "_g = createGroup west; _g createUnit [\"B_Soldier_F\", position player, [], 0, \"FORM\"]; count units _g", "label": "spawn" }
arma_exec { "code": "systemChat \"hi\"", "mode": "all", "expectN": 2 }
arma_exec { "code": "openMap true; visibleMap", "capture": { "delayMs": 500 } }
```

### verify — 증거식을 격리 실행

변이와 확인을 두 번의 호출로 나누지 말고 `verify` 에 넣는다. 관측된 30초 타임아웃은 전부
**마지막 검증식의 타입 오류**가 원인이었다(`round <배열>`, `taskState "<문자열>"`). 그런 오류는
`fn_execRun` 의 `call` 가드를 뚫고 스폰된 스크립트 전체를 죽이므로 결과 프레임이 아예 나가지 않고,
서버는 변이가 이미 성공했는데도 전체 `timeoutMs` 를 태운다. `verify` 는 본문과 증거를 각각
자식 `spawn` 에서 돌리므로 죽는 것은 그 자식뿐이다.

- `results` 는 평소 모양 그대로 본문 값을 담는다 — 호출부가 분기할 필요가 없다.
- `verify: { result, parsed, truncated }` 가 증거 결과를 따로 보고한다. 증거가 실패해도 `ok` 는
  본문 기준을 유지한다(변이는 성공했으므로).
- **두 단계는 지역변수를 공유하지 않는다**(별개 스크립트). 교차 상태는 `missionNamespace setVariable` 로 넘긴다.
- 래핑된 본문 안에서 `_this` 는 `[]` 다. `verify` 를 쓰지 않으면 전송 코드는 종전과 바이트 동일하다.
- `mode=server` 에서만 적용된다. 본문 380자 / 증거 100자에서 잘린다(인게임 500자 캡).

```
arma_exec { "code": "missionNamespace setVariable [\"g\", createGroup west]; true",
            "verify": "count units (missionNamespace getVariable \"g\")" }
```

## arma_watch — 인게임 조건 대기

조건이 참이 될 때까지 **게임 안에서** 폴링하고 충족 즉시(또는 타임아웃/정지에) 한 번만 반환한다.
`arma_exec` 를 반복 호출하거나 셸 `sleep` 으로 기다리지 않는다 — 실측으로 헬기 착륙 감시 하나에
4분간 13콜을 썼다.

| 파라미터 | 설명 |
|---|---|
| `condition` | 매 틱 평가할 SQF 불리언 식. `stop`/`stopAll` 이 아니면 필수 |
| `sample` | 매 틱 함께 기록할 SQF 식(`str` 직렬화). 조건 미충족 원인 추적용 |
| `intervalMs` | 평가 간격(ms). 기본 250, [50,5000] |
| `timeoutMs` | 최대 대기(ms). 기본 30000, [1000,300000] |
| `maxSamples` | 반환 샘플 최대 개수. 기본 8, 상한 8(인게임 500자 캡). 넘치면 앞의 개수-1 개와 마지막 값을 돌려주고 그 사이는 `samplesDropped` 로 개수만 센다. 충족 순간의 값이 마지막 샘플이다 |
| `watchId` | 워치 키를 호출자가 정한다. 영문, 숫자, `_`, `-` 로 1~64자. 응답을 받기 전에도 이 키로 `stop` 할 수 있다. 기본은 세션 태그와 시각으로 만든다 |
| `stop` / `stopAll` | 진행 중인 워치에 정지 신호. `condition` 없이 단독 사용 |

출력: `{ ok, met, reason, watchId, iterations, gameElapsedMs, sampleCount, samplesDropped, samples[], stopHint, exec, rptErrors }`

`reason`: `met` / `timeout` / `stopped` / `nil`(조건식이 nil 반환) / `type:<T>`(불리언이 아님) /
`threw:cond` · `threw:sample`(식이 예외로 종료) / `hung`.

**조건식은 매 틱 실행되므로 가볍게 유지한다.** 조건식이 죽어도 자식 `spawn` 격리 덕분에
전체 타임아웃을 태우지 않고 1~2틱 만에 `threw:` 로 돌아온다. 대기는 `sleep` 이 아니라 `uiSleep` 이라
`setAccTime` 변경에 영향받지 않는다.

```
arma_watch { "condition": "!alive HELI || (getPos HELI select 2) < 2",
             "sample": "[round (getPos HELI select 2), round (speed HELI)]",
             "intervalMs": 2000, "timeoutMs": 240000 }
arma_watch { "stop": "w_ab12cd_m1x2y3" }
```

## arma_mission_info — 미션 정보

캐시된 텔레메트리(즉답)를 반환한다. `fresh:true` 면 게임에 즉시 갱신을 요청해 push 도착 즉시 반환
(상한 1200ms — 프레임 프리즈 시에만 상한까지 대기). 미접속 시 `lastKnown`.

출력: `{ connected, world, mission, briefing, dedicated, multiplayer, cba, ace, aceVersion, aceComponents, tacmap, tacmapZeusTool, missionTime, date, fps, fpsMin, scripts, paused, focused, players:[{name,side,uid,isPlayer}], playerCount, cacheAgeMs }`

`fpsMin` 은 최근 프레임 중 가장 낮은 FPS(`diag_fpsmin`)다. `scripts` 는 지금 돌고 있는 스크립트 수
`{ spawn, execVM, exec, fsm }`(`diag_activeScripts`)다. 구버전 PBO 는 둘을 보내지 않아 `null` 이다.

`paused` 는 일시정지 메뉴(`isGamePaused`), `focused` 는 게임 창 포커스(`isGameFocused`)다.
창이 있는 쪽(SP, 플레이어가 연 서버)만 보내고 데디 서버와 구버전 PBO 는 `null` 이다.
SP 는 일시정지 메뉴가 열리면 `missionTime` 이 멈춘다. 이때 `sleep` 과 `waitUntil` 도 멈춘다.
브리지 하트비트는 실제 시간으로 돌아서 링크는 끊기지 않는다.
`focused:false` 는 창이 비활성이라는 뜻이다. `arma_play` 로 띄운 SP(`-autotest`)는 비활성이어도
게임 시간이 흐르고 FPS 가 60 아래로 묶였다(2026-10-15 실측).
`focused` 는 Windows 의 앞 창이 아니라 게임 창이 받은 활성 알림을 따른다. `focused:true` 인 창 모드 게임은 뒤에 있어도
사람이 다른 창에 치는 키를 쓴다. daemon 의 포커스 가드가 뒤에 있는 창을 1초 안에 `focused:false` 로 되돌린다([daemon 문서](daemon.md#포커스-가드)).

## arma_zeus_find: Zeus 이름으로 대상 찾기

사용자가 대상을 Zeus 화면에 보이는 이름으로 말하면 `arma_exec` 전에 이 툴로 찾는다.
유닛 종류명, 플레이어 이름, 그룹 콜사인, 차량, 모듈, 마커, 에디터 변수명이 모두 검색 대상이다.
결과 행의 `sqf` 식을 `arma_exec` 코드에 그대로 넣어 쓴다. 게임을 바꾸지 않는다.

| 파라미터 | 설명 |
|---|---|
| `source` | `mission`(기본): 맵에 있는 것. `selected`: 지금 Zeus 에서 선택한 것(`curatorSelected`). `palette`: Zeus 생성 패널(유닛 종류, 차량, 오브젝트, 모듈, 그룹 편성) |
| `query` | 이름 조각. 대소문자를 가리지 않는다. 공백으로 나눈 낱말이 모두 들어 있어도 맞는다. 비우면 목록 |
| `kind` | 하나나 배열. mission, selected: `unit`, `group`, `vehicle`, `module`, `object`, `marker`. palette: `unit`, `vehicle`, `object`, `module`, `groupTemplate` |
| `side` | `WEST`, `EAST`, `GUER`, `CIV` |
| `zeusOnly` | mission 에서 curator 편집 대상만 |
| `near` | `[x,y]` 또는 `"camera"`(Zeus 카메라). 같은 점수는 가까운 순이고 행에 `dist`(m)가 붙는다 |
| `limit` | 최대 결과 수. 기본 20, 최대 100 |
| `on` | 이름을 계산할 머신. `auto`(기본), `server`, 플레이어 이름 |

점수: 정확 일치 100, 앞부분 일치 60, 포함 40, 낱말이 모두 들어 있으면 25.

출력: `{ ok, source, machine, language, zeusOpen, hasCurator, total, returned, results[], note, exec:{count,durationMs} }`

mission, selected 행: `{ kind, label, ref, sqf, class, type, name, leader, var, group, role, side, grid, pos, zeus, local, player, units, crew, score, dist }`.
빈 필드는 빠진다. `label` 은 Zeus 엔티티 목록과 같다. 플레이어는 `소총수 (이름)`, AI 유닛과 차량과 모듈은 종류명, 그룹은 콜사인, 마커는 텍스트다. `type` 은 `label` 과 다를 때만 붙는다.
`ref` 는 netId(마커는 이름)다. `sqf` 는 그것을 되찾는 식이다.

- 객체: `("2:345" call BIS_fnc_objectFromNetId)`. 변수명이 있어도 이 식이다. `var` 는 이름을 계산한 머신에서 읽은 값이라 서버에는 없을 수 있다.
- 그룹: `("2:12" call BIS_fnc_groupFromNetId)`.
- 마커: `"marker_1"`.

`BIS_fnc_netId` 계열은 SP 에서도 동작한다. `local` 은 이름을 계산한 머신 기준이다.

palette 행: `{ kind, label, class, path, side, sqf, canAttach, attributeDialog, opensDialog, score }`.
`path` 는 진영과 하위 분류, 모듈은 카테고리다. groupTemplate 의 `sqf` 는 `configFile >> "CfgGroups" >> ...` 식이라 `BIS_fnc_spawnGroup` 에 바로 넣는다.
palette 색인은 Zeus 처럼 curator 의 `curatorAddons` 에 든 `CfgPatches >> units[]` 중 `scopeCurator == 2` 만 담는다. curator 가 없으면 전체 `CfgPatches` 를 본다. 색인은 그 머신에서 미션 동안 캐시되므로 첫 호출만 잠깐 멈출 수 있다.

머신(`on: auto`):

- 종류명과 모듈 이름은 계산한 머신의 게임 언어로 나온다. 그래서 Zeus 를 쓰는 플레이어의 클라이언트에서 계산한다.
- SP 는 그 한 대다.
- MP 에서 Zeus 플레이어가 하나면 그 클라이언트(`client` 모드)이고, 호스트면 서버다.
- 여럿이면 mission 과 palette 는 첫 사람의 머신을 쓰고 `note` 로 알린다. selected 는 `on` 을 요구한다.
- 없으면 mission 과 palette 는 서버에서 계산하고 서버 언어일 수 있다고 알린다. selected 는 오류다.

결과는 인게임 500자 캡 안에서 행 단위 페이지로 나눠 받는다. 쪽마다 exec 가 한 번 더 돈다(`exec.count`).

```
arma_zeus_find { "query": "알파 1-2", "kind": "group" }
arma_zeus_find { "source": "selected" }
arma_zeus_find { "query": "소총수", "near": "camera", "limit": 5 }
arma_zeus_find { "source": "palette", "kind": "module", "query": "치료" }
arma_exec { "code": "(\"2:12\" call BIS_fnc_groupFromNetId) move [4500,1200,0]" }
```

## arma_zeus_module: Zeus 모듈 실행

Zeus 모듈을 Zeus 에서 놓은 것과 같은 경로로 실행한다. 사용자가 모듈 실행을 명시적으로 요청했을 때만 쓴다.

| 파라미터 | 설명 |
|---|---|
| `module` | 클래스명 또는 Zeus 에 보이는 모듈 이름 |
| `pos` | 월드 좌표 `[x,y]`. 생략하면 `target` 위치, 그것도 없으면 Zeus 화면 중앙(`screenToWorld [0.5,0.5]`) |
| `target` | `arma_zeus_find` 의 `ref`. 부착형 모듈(`curatorCanAttach`)의 대상이자 커서 아래 대상 |
| `on` | `auto`(기본, Zeus 를 쓰는 플레이어), `server`, 플레이어 이름 |
| `dryRun` | 이름 해석과 위치만 보고 만들지 않는다 |
| `observeMs` | 만든 뒤 결과를 보기까지 기다리는 시간. 기본 1500, 최대 10000 |

이름 해석: 클래스명이면 그대로 쓴다. 아니면 palette 의 module 검색에서 단독 최고점만 받는다.
여러 모듈이 같은 점수로 걸리면 만들지 않고 `candidates:[{class,label}]` 를 돌려준다.

출력: `{ ok, outcome, machine, module:{class,label,category,canAttach,attributeDialog,opensDialog}, pos, target, targetKind, logicRef, dialogOpened, zeusOpen, curatorAdded, note, rptErrors }`

`outcome`:

- `consumed`: 모듈 함수가 돌고 로직이 스스로 지워졌다.
- `persistent`: 로직이 남았다. 서버에서 그 플레이어의 curator 편집 대상에 넣는다(`curatorAdded`).
- `dialog`: 그 플레이어 화면에 창이 떴다. 입력은 그 사람이 한다.

흉내 내는 Zeus 배치 경로(BIS `fn_moduleInit`, `fn_curatorObjectPlaced`, `fn_curatorAttachObject` 기준):

1. `createGroup [sideLogic, true]` 의 그룹에 `isCuratorModuleGroup` 을 전역으로 둔다. `bis_fnc_moduleInit` 이 이 표시를 보고 Zeus 배치로 판단해 바로 활성화한다.
2. `createUnit` 으로 모듈을 만든다.
3. `bis_fnc_curatorObjectPlaced_mouseOver` 에 대상을 남긴다.
4. 부착형이고 대상이 객체면 `bis_fnc_curatorAttachObject_object` 를 두고 `attachTo` 한다.

이 넷을 `isNil` 안에서 한 번에 한다. `bis_fnc_moduleInit` 은 함수를 spawn 뒤에 부르므로 함수보다 먼저 끝난다.
모듈은 Zeus 를 쓰는 플레이어의 머신에서 만든다. 그래야 `local _Logic` 과 `player` 에 기대는 모듈이 Zeus 배치와 같게 돈다.

흉내 내지 못하는 것:

- Zeus 에서 놓을 때 뜨는 속성 창(`curatorInfoType`). 모듈은 기본값으로 돈다. `attributeDialog` 로 알린다.
- 엔진의 `CuratorObjectPlaced` 이벤트. 이 이벤트에 붙은 다른 모드 동작은 일어나지 않는다.
- 실시간 `curatorMouseOver` 를 직접 읽는 모듈은 대상을 못 볼 수 있다.

```
arma_zeus_module { "module": "주변 10m 완전 치료", "target": "2:345" }
arma_zeus_module { "module": "PH_Mission_VarName", "target": "2:9" }
arma_zeus_module { "module": "번개", "dryRun": true }
```

## arma_status — 상태

입력: `{ stack?, waitFor?: 'none'|'game'|'dedicated', timeoutMs? }`. `waitFor`를 지정하면 현재 HTTP 세션만
해당 준비 상태를 기다리며, 다른 세션이나 데몬 수명에는 영향을 주지 않는다.

`stack` 을 주면 아래 게임 쪽 필드(연결, 미션, 프로세스, RPT, `operation`)가 그 스택의 것이다. 출력의 `stack` 이 고른 스택이다.
`stacks` 는 모든 스택의 요약이다. 항목은 `{ id, port, pipe, root, listener, linkPhase, dllPid, dllVersion, mission,
processes[{pid,image,role,index}], operation, testMods, overlays }` 다. `processes` 는 목록을 읽지 못했으면 `null` 이다.
`dllPid` 는 hello 가 알린 게임 프로세스 pid 이고 0.5.0 이전 DLL 이면 `null` 이다.
`windowTiler` 는 창 4분할이 보는 게임 창 목록 `[{ pid, stack, label, slot, manual, windowed }]` 이다. `slot` 은 0(주 모니터 왼쪽 위)부터이고
0 에서 3 이 주 모니터, 4 에서 7 이 다음 모니터(주 모니터 밖에서 가장 왼쪽)다. 칸이 없으면 `null`, `manual` 은 사람이 옮겨 타일러가 손대지 않는 창이다.
창 4분할과 포커스 가드가 모두 꺼져 있으면 `windowTiler` 가 `null` 이다.
포커스 가드만 켜져 있으면 같은 목록이 나오고 `slot` 은 늘 `null` 이다.

출력에는 기존 필드와 함께 `daemonVersion`, `daemonUptimeMs`, `sessions`, `operation`,
`gameConnectionGeneration`, `rawConnected`, `bridgeReady`가 포함된다.

`rawConnected`는 DLL 소켓 연결, `bridgeReady`는 hello/sessionInfo와 미션 텔레메트리까지 받은 상태다.
`waitFor:'dedicated'`는 여기에 `mission.dedicated=true`와 비어 있지 않은 world/mission까지 요구한다.
`serverProcessRunning`/`newestServerRpt` 는 데디 서버 상태. 프로세스 탐지는 설정된
`arma.serverExePath` 의 파일명을 먼저 보고, 없으면 알려진 대체 이미지(`arma3serverprofiling_x64.exe`,
`arma3server.exe`)까지 확인한다 — 실제로 실행 중인 이름은 `serverProcessImage` 로 나온다.

`linkPhase` 는 게임 링크 단계다: `none`(소켓 없음) / `pre-bridge`(DLL 은 붙었지만 미션이 없어
SQF 브리지가 없음 — 로비다, 연결 실패가 아니다) / `live` / `stale`(살아 있었는데 조용해짐).
`pre-bridge` 상태에서는 SQF 툴을 쓸 수 없고, 미션이 뜨면 자동으로 `live` 가 된다.
`bridgeCompatible` 은 배포된 DLL 과 데몬의 major.minor 가 같은지다 — patch 차이만으로는
DLL/PBO 를 재배포할 이유가 없다(exec 경로가 호환된다).

`sessions` 는 `{ total, byTransport, sessions[] }` 다. `byTransport` 는 `relay`, `remote-http`, `standalone`, `cli` 별 세션 수다.
`cli` 는 셸의 `arma-mcp` 명령이 연 세션이고 명령이 끝나면 닫힌다.

`operation` 은 실행 lease 를 쥔 작업이다. 모양은 `{ operation, startedAt, elapsedMs, owner? }` 이고,
lease 가 비어 있으면 `null` 이다. `operation.owner` 는 그 lease 를 잡은 세션이다.
모양은 `{ session, transport }` 이고, `session` 은 `sessions[].shortId` 와 같다.
실행 계열 도구(`arma_launch`, `arma_launch_mp`, `arma_launch_server`, `arma_play`,
`arma_scaffold_mission`, `arma_kill`)가 lease 를 못 잡으면 `busy` 에 같은 스냅샷을 싣는다.
그 lease 가 호출한 세션의 것이면 `busy.mine: true` 가 붙는다. 에러 문장은 전과 같다.
`arma_launch`, `arma_launch_mp`, `arma_launch_server` 의 `dryRun` 은 lease 를 잡지 않아 `busy` 가 오지 않는다.
`arma_play` 는 `dryRun` 에서도 lease 를 잡는다.

```
{ "ok": false, "error": "another launch operation is already in progress",
  "busy": { "operation": "arma_play", "startedAt": 1790000000000, "elapsedMs": 41250,
            "owner": { "session": "a1b2c3d4", "transport": "relay" } } }
```

`profiles` 는 `arma_play` 의 `profile` 로 부를 수 있는 저장된 프로필 이름이다.
프로필 파일이 깨졌으면 목록은 비고 `profilesError` 에 파일 경로와 이유가 담긴다.

`web: { state, url, host, port, sseClients, webRoot, note? }` — 웹 게시 서버 상태.
`state: 'port-busy'` 는 다른 세션이 웹 포트를 쥔 상태(5s 재시도; webroot 공유라 publish 는 그 세션이 서빙·리로드를 대행).

운영 daemon은 게임 파이프를 독점한다. 이미 다른 daemon이 파이프를 쥐고 있으면 시작 자체가 실패한다.
여러 MCP 세션은 각자 파이프를 열지 않고 같은 daemon을 공유한다.
이름 있는 스택의 파이프도 이 daemon 이 연다. 스택 파이프가 이미 쓰이고 있으면 그 스택만 열리지 않고(`listener:'pipe-unavailable'`) daemon 은 계속 돈다.
`lastFrameAgeMs` 는 DLL 로부터 마지막 프레임을 받은 후 경과(ms, 미접속 -1). `link.staleAfterMs`(기본 15000)
이상 무수신이면 half-open 으로 간주해 연결을 끊는다(죽은 링크에서 exec 가 풀 타임아웃을 소모하지 않도록).
`armaProcessRunning` 은 3s TTL 캐시(비동기 tasklist).

`game` 은 최근 텔레메트리의 `{ missionTime, fps, fpsMin, paused, focused }` 다. 연결이 없거나 텔레메트리를
아직 못 받았으면 `null` 이다. 각 값의 뜻은 `arma_mission_info` 와 같다. SP 에서 `paused:true` 면
게임 시간이 멈춰 있어 `sleep` 과 `waitUntil` 을 쓰는 SQF 가 진행하지 않는다.

**모드 감지 (CBA / ACE / TacMap)**: `cba`/`ace` 는 각 모드 로드 여부. ACE 로드 시 `aceVersion`(예 "3.21.0.110")과
`aceComponents`(감지된 ACE 컴포넌트 CfgPatches 클래스 배열)를 보고하고, `hints` 로 능동 활용을 유도한다.
**에이전트는 `ace=true` 면 `arma_exec` 로 `ace_*` 함수를 적극 활용하되, 서브시스템 함수는 `aceComponents` 에
해당 컴포넌트가 있는지 확인 후 호출한다** (예: `ace_medical_treatment` 있으면 `ace_medical_treatment_fnc_*`).
CBA/ACE 는 게임 안 애드온이 접속해야 채워진다.

`tacmap`/`tacmapZeusTool` 은 **AHC_TacticalMap** / **AHC_ZeusTool** 로드 여부다(`true`/`false`/`null`=미상 3-state,
`null` 은 구버전 `@arma_mcp` PBO 가 필드를 보내지 않은 경우). `tacmap=true` 면 `hints` 가 `arma_tacmap_*` 툴로
유도한다. `tacmapZeusTool` 은 **무전 자막의 동작 여부가 아니라 사운드 유무만** 결정한다 — `docs/tacmap.md` 참조.

**자동 업데이트 대기**: 세션 시작 자동 업데이트가 받아둔 버전이 실행 중인 데몬보다 높으면 `hints` 에
"세션을 새로 열면 적용됩니다" 한 줄이 실린다. 적용되고 나면 저절로 사라진다. SessionStart 훅이 없는
호스트에서는 이것이 유일한 가시 채널이다 — `docs/daemon.md` 의 "자동 업데이트" 절 참조.

## RPT 툴

| 툴 | 입력 | 용도 |
|---|---|---|
| `arma_rpt_list` | `limit?`, `source?`, `client?` | RPT 파일 목록(최신=파일명 정렬 최대) |
| `arma_rpt_read` | `file?`(newest), `tailLines?`(80), `fromOffset?`, `maxBytes?`(65536), `source?` | tail/오프셋 커서 읽기. `endOffset`→`fromOffset` 재전달로 증분 폴링 |
| `arma_rpt_search` | `pattern`, `file?`, `fromOffset?`, `maxMatches?`(50), `contextLines?`(2), `caseSensitive?`, `source?` | 정규식 검색(스트리밍, 대용량 안전) |
| `arma_rpt_errors` | `since?`(lastExec/missionStart/fileStart), `file?`, `fromOffset?`, `source?` | SQF 오류 블록 그룹핑 |
| `arma_rpt_wait` | `pattern`, `file?`(newest/next/이름), `timeoutMs?`(30000), `fromEnd?`(true), `fromOffset?`, `source?` | 패턴 대기(250ms 폴링). `file:'next'`=런치 후 새 RPT 대기 |

모든 RPT 툴은 `stack` 과 `client` 도 받는다. `client` 는 client 소스의 클라 순번(기본 1)이다.

`source`: `'auto'`(기본) | `'client'` | `'server'`. `auto`는 현재 라이브 텔레메트리가
`dedicated:true`이면 서버 `-profiles`의 `arma3server_x64_*.rpt`, 그 외에는
`%LOCALAPPDATA%\Arma 3`의 `Arma3_x64_*.rpt`를 선택한다. 프로파일링 exe 의 RPT(`arma3profiling_x64_*.rpt`,
`arma3serverprofiling_x64_*.rpt`)도 같은 쪽에서 찾는다. 이름 앞부분이 exe 마다 달라서 최신 판정은 이름 뒤의 시각으로 한다.
모든 응답은 실제 선택값인
`resolvedSource`를 반환한다. 연결 전 외부 서버를 진단할 때는 `source:'server'`를 명시한다.

`lastExec` 커서는 MCP 세션별로 분리된다. 병렬 SQF가 같은 RPT 구간에 오류를 기록하면 엔진 로그 자체에는
세션 식별자가 없으므로, 서로의 오류 블록이 겹칠 가능성이 있다는 `note`가 응답에 포함될 수 있다.

`arma_rpt_search`/`arma_rpt_errors(fileStart)` 는 `fromOffset` 미지정 시 파일 처음부터 스캔한다 —
수백 MB RPT 에선 `arma_rpt_list` 의 `sizeBytes` 나 이전 응답의 `endOffset` 으로 `fromOffset` 을 주는 것을 권장.

`arma_rpt_wait` 의 `fromOffset` 은 그 바이트 위치부터 감시한다. 대기 전에 이미 기록된 줄도 그 위치 뒤면 찾는다.
`file` 에 파일명이나 절대경로를 함께 준다. `newest` 와 `next` 는 가리키는 파일이 바뀔 수 있어 쓸 수 없다.
그런 `file` 과 함께 주거나 `file` 없이 주면 기다리지 않고 `{found:false, error}` 로 돌아온다.
`fromOffset` 을 주면 `fromEnd` 와 프리스캔은 쓰지 않는다.
`arma_exec` 결과의 `rptCursor` 를 그대로 넘기는 것이 주된 쓰임이다.

```
arma_rpt_wait { "pattern": "MY_MARKER", "file": "<rptCursor.file>", "fromOffset": <rptCursor.offset>, "timeoutMs": 60000 }
```

`arma_rpt_wait` 는 애드온의 exec 감사 줄(`"[ArmaMCP] [EXEC] ...`)에 맞추지 않는다. 커서 뒤에는 exec 한 코드를 그대로 실은 감사 줄과
결과 감사 줄이 먼저 기록된다. 코드 속 `MY_MARKER` 나 nil 결과 줄의 `Error in expression` 이 거기서 먼저 맞으면
기다리던 일이 일어나기 전에 답하게 된다. `[EXEC]` 가 아닌 `[ArmaMCP]` 줄(예: `server bridge` 준비 마커)은 그대로 맞는다.
애드온은 여러 줄 코드와 결과를 감사 줄 한 줄에 찍는다. 줄바꿈은 공백으로 바뀐다.

## Launch 툴

데몬이 띄우는 클라(`arma_launch`, `arma_launch_mp`, `arma_play` 의 SP 와 MP, 모든 스택)는 `-noPause` 를 늘 받는다.
`arma.baseArgs` 나 호출 인자에 이미 있으면 한 번만 들어간다. 엔진은 창이 포커스를 잃으면 SP 게임 시간을 멈추고
프레임을 약 20 FPS 로 늦춘다. `-noPause` 는 창 모드 인게임(클라 상태 10)에서 이것을 풀고 60 FPS 로 묶는다.
로비와 브리핑의 배경 창은 `-noPause` 가 있어도 20 FPS 다. `-noPauseAudio` 는 넣지 않으니 필요하면 `arma.baseArgs` 에 둔다.

### arma_launch
```
{ stack?, mission?, modset?('rpt'|'explicit'|'none'), mods?, testMods?, worldEmpty?, killRunning?, extraArgs?, dryRun?, waitForNewRptMs? }
```
- `modset='rpt'`(기본): 최신 RPT 헤더의 `-mod=` 재사용(`-noLogs` 제거). 실패 시 `fallbackMods`.
- `modSwaps`(워크샵→로컬)와 `selfModPath`(@arma_mcp) 자동 적용 — MCP 애드온이 항상 로드.
- `mission` 지정 시 `-autotest` cfg 로 자동 로드.
- 출력: `{ ok, launched, pid, modSource, modCount, mods, argString, prevNewestRpt, newRpt?, warning? }`
- `dryRun:true` 로 실행 없이 최종 인자 확인 권장(첫 사용 시).

### arma_launch_mp — 멀티플레이 테스트 (데디 서버 + 클라 자동 접속)

"멀티플레이에서 테스트해보자" 워크플로우: 데디 서버(`arma3server_x64.exe`)를 미션·모드셋과 함께
실행하고, 클라이언트를 `-connect=127.0.0.1` 로 자동 접속시킨다.
`autoInit:true` 면 서버가 로비 역할을 배정해 클라가 슬롯 선택 없이 미션에 들어간다.
`autoInit:false` 는 로비(슬롯 선택 화면)에서 멈추고, 슬롯 선택과 미션 시작은 수동이다(CLI 로 불가).
인게임 판정까지 한 번에 하려면 `arma_play`(`mode:"mp"`)를 쓴다.

```
{ stack?, mission(필수), modset?('rpt'|'explicit'|'none'), mods?, testMods?, clients?(1), port?(2302), password?,
  autoInit?(false), autoSlot?(autoInit), roles?, serverOnly?, killRunning?, serverExtraArgs?, clientExtraArgs?,
  dryRun?, serverReadyTimeoutMs?(60000), clientConnectTimeoutMs?(180000, 클라마다) }
```

- **자동 처리**: 미션 폴더를 `<서버 exe 폴더>\MPMissions` 로 복사(권한 실패 시 정션 폴백),
  `server.cfg` 자동 생성(`verifySignatures=0`, `BattlEye=0` — 테스트 전용), `-profiles` 디렉토리 준비.
- **BattlEye**: 데몬이 띄우는 서버와 클라는 BattlEye 를 늘 끈다. 서버는 MCP 가 만든 `server.cfg` 만 읽는다.
  `serverExtraArgs` 의 `-config` 는 거절하고, `mp.serverBaseArgs` 의 `-config` 와 `mp.extraCfgLines` 의 `BattlEye` 줄은
  빼고 띄운 뒤 `warning` 에 적는다. 클라는 `arma.exePath` 의 게임 exe 를 바로 띄운다.
  `arma.exePath` 가 `arma3battleye.exe` 같은 BattlEye 실행기면 `arma_launch` 와 클라를 띄우는 실행을 거절한다.
- **모드셋**: `arma_launch` 와 동일 규칙(기본 rpt 헤더 재사용 + modSwaps + selfModPath) —
  서버·클라에 **동일한** `-mod=` 적용. `@arma_mcp` 브리지가 서버에도 로드된다.
- **서버 부팅 감지**: 서버 RPT(`source:'server'`)의 `Initializing Steam server - Game Port` 나 `Connected to Steam servers`,
  또는 `autoInit` 서버 브리지 준비 중 먼저 오는 쪽이다. 클라가 둘 이상인 LAN 모드(`loopback = true;`) 서버는
  Steam 초기화를 건너뛰어 이 두 줄이 없으니 브리지로 판정된다(`readyLine` 이 `MCP 서버 브리지 준비(...)`).
- **클라 접속 감지**: 서버 텔레메트리 하나다. `clients` 나 `players` 에 그 클라 이름(모르는 이름이면 띄우기 전에 없던 새 이름)이
  보이면 접속으로 치고 `lobby.line` 은 `telemetry: <이름> 접속` 이다. 엔진은 `Host identity created`,
  `Player <이름> connecting`, `Player <이름> connected` 를 서버 콘솔에만 쓰고 RPT 에는 쓰지 않는다.
- 브리지 DLL 은 미션 시작 후에야 접속하므로 `autoInit:false` 로비 대기에서는 `arma_exec` 를 쓸 수 없고 접속도 판정하지 않는다.
  그때 결과에 `lobby` 가 없고 `nextSteps` 가 그 사실을 적는다.
- `autoInit:true` 면 `persistent=1` + `-autoInit` 로 로비 대기 없이 미션 즉시 시작.
- **로비 역할 자동 배정**: `autoInit:true` 면 `autoSlot` 이 기본 true 다. `arma_play` 와 같은 `skipLobby = 1;` 과
  `OnAutoSelectRole` 훅을 `server.cfg` 에 넣는다(아래 `arma_play` 의 로비 역할 자동 배정).
  `roles` 를 주면 클라마다 그 역할을 고르고, 지정이 없는 클라는 서버 기본 배정이다.
  `autoSlot:false` 면 두 줄을 넣지 않아 로비에서 사람이 고른다.
  로비 대기(`autoInit:false`)에 `autoSlot:true` 나 `roles` 를 주면 띄우지 않고 오류를 돌려준다.
  미션 `description.ext` 의 `skipLobby = 0;` 과 설정 `mp.extraCfgLines` 의 배정 줄은 `arma_play` 와 같이 다룬다.
- 출력: `{ ok, mission:{source,template,deployedPath,deployMethod}, modSource, mods,
  server:{pid,port,argString,cfgPath,profilesDir,rpt,ready,readyLine}, client:{pid,argString,rpt},
  clients?[], lobby?:{reached,line,elapsedMs}, autoSlot?:{entries,cfgLines,userCfgLines?,missionSkipLobby?},
  testMods?, nextSteps, warning? }`. `clients` 는 클라가 둘 이상일 때만 있다.
  `autoSlot` 은 서버가 역할을 배정할 때만 있다. 들어간 역할은 판정하지 않는다. 서버 RPT 의
  `[ArmaMCP] autoSelectRole` 줄로 보거나 `arma_play` 를 쓴다.
- 첫 사용 시 `dryRun:true` 로 서버/클라 인자와 server.cfg 본문 확인 권장.

```
arma_launch_mp { "mission": "E:\\...\\mcp_test.VR", "killRunning": true }
arma_launch_mp { "mission": "mcp_test.VR", "serverOnly": true }     # 서버만(수동 접속 테스트)
arma_launch_mp { "mission": "mcp_test.VR", "autoInit": true }       # 미션 즉시 시작, 서버가 역할 배정
arma_launch_mp { "mission": "op.Altis", "autoInit": true, "clients": 2, "roles": ["Squad Leader", null] }
arma_launch_mp { "mission": "mcp_test.VR", "autoInit": true, "autoSlot": false }   # 로비에서 사람이
```

미션 시작 → 서버 브리지가 pipe 접속 → `arma_status`(`dedicated:true`)·`arma_exec` 사용 가능.
정리는 `arma_kill { "target": "all" }`.

### arma_launch_server — 클라이언트 없는 전용 서버

서버 컴퓨터에서 `arma3server_x64.exe`만 실행하고 `persistent=1`과 `-autoInit`으로 미션을 시작한다.
Arma 클라이언트나 게임 접속 없이 새 서버 RPT, 새 DLL 연결, sessionInfo, dedicated 텔레메트리까지 확인한 뒤
성공을 반환한다.

```
{ stack?, mission(필수), modset?('rpt'|'explicit'|'none'), mods?, testMods?, port?, password?,
  killRunning?, serverExtraArgs?, dryRun?, autoSlot?(true),
  serverReadyTimeoutMs?(60000), bridgeReadyTimeoutMs?(120000) }
```

- `serverOnly`와 `autoInit`은 입력받지 않고 항상 true다.
- `autoSlot` 이 기본 true 라 `server.cfg` 에 `skipLobby = 1;` 과 지정 없는 `OnAutoSelectRole` 훅이 들어간다.
  나중에 붙는 클라(`arma_launch` 의 `-connect`, 사람)는 로비 없이 서버 기본 배정으로 들어간다. `autoSlot:false` 면 로비에서 고른다.
- 실행 전 서버 실행 파일, `selfModPath`, 게임 파이프 소유 상태를 검사한다.
- 이전 게임 연결 generation은 성공으로 인정하지 않는다.
- timeout은 서버를 종료하지 않고 프로세스 생존·listener·RPT 진단과 `ok:false`를 반환한다.
- 출력에는 `missionStarted`, `bridgeReady`, 준비 경과 시간, 서버 PID/인자/profiles/RPT와 실제 텔레메트리가 포함된다.

```
arma_launch_server { "mission": "mcp_test.VR", "killRunning": true }
arma_status { "waitFor": "dedicated", "timeoutMs": 120000 }
arma_exec { "code": "1 + 1", "mode": "server" }
```

외부에서 이미 시작한 서버도 애드온이 같은 파이프로 재접속한다. 데몬의 `mp.profilesDir`를 그 서버의
`-profiles` 경로와 맞춘 뒤 `arma_status { "waitFor":"dedicated" }`로 준비를 확인한다.
활성 미션 전 로비에서는 postInit 브리지가 없으므로 SQF 도구는 사용할 수 없다.

### arma_kill
그 스택의 Arma 프로세스를 pid 로 강제 종료한다. 다른 스택의 게임은 건드리지 않는다. `target: 'all'(기본, 클라+서버) | 'client' | 'server'`.

```
{ stack?, target?('all'), waitMs?(15000, 0~60000), unlockPaths?(최대 32개), preempt?(true), forget? }
```

- 죽이기 직전에 프로세스 목록을 다시 읽고 그 스택의 `-profiles` 를 가진 pid 만 끈다. 목록을 읽지 못하면 default 스택만,
  다른 스택이 조용할 때만 이미지 이름 종료로 물러선다.
- `forget:true` 는 이름 있는 스택에만 쓴다. 서버와 클라를 모두 끈 뒤 파이프를 닫고 스택 폴더를 지운다. 결과에 `forgot` 이 붙는다.
- 다른 스택이 로드 중인 기본 모드 폴더를 `unlockPaths` 로 기다리면 그 스택이 끝날 때까지 잠금이 풀리지 않는다.
  공유 기본 모드는 다시 빌드하지 말고 새로 빌드한 것을 `testMods` 로 넘긴다.

- `preempt` 기본 `true` 는 실행 중인 launch, play 작업을 끊고 종료한다. 끊긴 작업은 `interruptedOperation` 에 실린다.
- `preempt:false` 면 다른 세션의 작업이 lease 를 쥐고 있을 때 종료하지 않는다.
  결과는 다른 실행 계열 도구가 lease 를 못 잡았을 때와 같은 모양이다. `{ ok:false, error, busy:{operation, startedAt, elapsedMs, owner} }` 로 온다.
  lease 가 비었거나 호출한 세션의 것이면 평소처럼 종료한다.

- 종료 뒤 프로세스가 사라질 때까지 최대 `waitMs` 동안 기다린다. 사라지는 즉시 돌아온다. `0` 이면 기다리지 않는다.
- taskkill 이 실패해도 프로세스가 남아 있으면 같은 `waitMs` 동안 기다린다. 이미 끝나는 중인 프로세스에는 taskkill 이 실패하기 때문이다.
- `unlockPaths` 를 주면 그 뒤 쓰기 가능해질 때까지도 기다린다. 대기 시간은 `waitMs` 하나를 나눠 쓴다.
  폴더는 그 안과 `addons` 안의 `*.pbo`, `*.dll` 로 펼친다. 파일은 `r+` 로 열었다 닫기만 하고 쓰지 않는다.
- 잠금(EBUSY)만 다시 시도한다. 권한 오류(EPERM, EACCES)는 바로 `쓰기 불가` 로 실패한다. 없는 경로는 `ENOENT` 실패다.
- 호출이 취소되거나 세션이 닫히면 대기를 멈추고 lease 를 푼다. 확인하지 못한 프로세스는 `gone:false`, 아직 잠긴 경로는 `code:'ABORTED'` 다.
- 출력 `{ ok, client?:{killed,gone?,waitedMs,detail}, server?:{...}, unlock?:[{path,ok,waitedMs,code?,reason?}], interruptedOperation }`.
  `ok` 는 프로세스가 남아 있거나 `unlock` 중 하나라도 `ok:false` 면 false 다.
  `gone` 은 `waitMs:0` 으로 종료한 뒤 확인하지 않았을 때만 빠진다.
  taskkill 이 실패했는데 프로세스가 남아 있으면 `waitMs:0` 이어도 `gone:false` 이고 `ok` 는 false 다.

```
arma_kill { "target": "all", "unlockPaths": ["D:\\mods\\@my_mod\\addons"] }   # 재빌드 전에 PBO 잠금까지 기다림
```

### arma_play — 한 번의 호출로 인게임 진입

`arma_launch` 는 게임을 띄우고 `arma_launch_mp` 는 클라 접속까지 본다. 인게임 확인은 매번 따로 했다.
`arma_play` 는 미션 준비부터 인게임 진입 확인까지를 한 흐름으로 묶는다.

```
{ stack?, mode?('sp'|'mp', 'sp' 기본), mission?, modset?, mods?, testMods?, killRunning?, clientExtraArgs?,
  dryRun?, inGameTimeoutMs?(180000),
  world?, name?('mcp_play'), playerType?, position?, safeSpawn?, initSqf?,   # mission 미지정 시
  waitForNewRptMs?,                                                          # sp
  port?, password?, serverExtraArgs?, serverReadyTimeoutMs?, bridgeReadyTimeoutMs?,
  clientConnectTimeoutMs?, autoSlot?(true), roles?, clients?(roles 수, 없으면 1), expectPlayers?(clients),  # mp
  profile?, saveProfile?,                                                     # 실행 프로필
  ready?: { rpt, source?('client'), timeoutMs?(60000) },                      # 준비 마커
  then?: { code, mode?('server'), target?, timeoutMs?(10000) } }              # 셋업 SQF
```
- **mode='sp'**: `-autotest` 로 미션을 바로 로드한다. 진입 판정은 시뮬레이션 진행(`missionTime` 증가)이다.
- **mode='mp'**: 데디 서버를 `-autoInit` 으로 띄워 미션을 먼저 시작하고, 클라이언트를 `-connect` 로
  붙인 뒤 로비 슬롯까지 넘긴다. `autoInit` 과 `serverOnly` 는 입력받지 않고 고정한다.
- **mission**: 주면 그 미션을 쓴다. 안 주면 `arma_scaffold_mission` 과 같은 인자로 최소 테스트 미션을
  즉석에서 만든다(바다와 공중 스폰 보정이 기본으로 켜진다).
- 출력의 `steps` 가 어디까지 갔는지 순서대로 담는다. `phase` 는 도달한 가장 먼 단계다.
  sp 는 `mission → launched → bridge → in-game`, mp 는
  `mission → server → serverBridge → client → lobby → autoSlot → in-game`.
- 실패해도 프로세스를 죽이지 않는다. `arma_launch_server` 와 같은 규칙이다.
- **긴 호출이다.** 기본 대기값이면 실행 자체가 실행 lease 를 최악 8분까지 점유한다.
  `ready` 와 `then` 도 같은 lease 안에서 돌아 각자의 `timeoutMs` 가 더해진다.
  둘 다 상한으로 주면 최악 23분(실행 8분, `ready` 5분, `then` 10분)이다.
  다른 세션은 `arma_status` 의 `operation` 으로 이유를 볼 수 있고, `arma_kill` 이 선점해 끊을 수 있다.
  `elapsedMs` 가 8분을 넘었다고 멈춘 작업으로 단정하지 않는다.
- `dryRun` 은 인자만 계산하지만 **미션 폴더는 실제로 만든다**. 런처가 dryRun 분기보다 먼저 미션 경로를
  검사하기 때문이며, `arma_scaffold_mission` 의 dryRun 도 같은 동작이다.

성공 판정은 항상 서버 텔레메트리다. 자동 배정이 지정한 역할을 못 찾아도 서버 기본 배정으로 들어가고,
미션이 로비를 강제하면 사람이 고를 때 같은 신호가 온다. 도구는 `inGameTimeoutMs` 까지 기다렸다가 무슨 일이
있었는지 그대로 보고한다(`autoSlot.state`, `autoSlot.clients`, `autoSlot.log`, `humanWait.waited`).

**로비 역할 자동 배정**은 서버가 한다. 클라와 애드온은 로비에서 아무것도 하지 않는다.
2.22 엔진에서 로비 역할 배정 요청은 역할 목록 더블클릭과 Space 키에서만 나가고, SQF 의 `lbSetCurSel` 과
`ctrlActivate` 로는 닿지 않는다(실측과 엔진 분석). 그래서 `autoSlot`(기본 true)이면 데몬이 만드는 `server.cfg` 에
두 줄을 넣는다.

- `skipLobby = 1;` 서버가 접속한 클라를 로비 없이 바로 역할에 넣는다. 클라는 로딩 화면을 보다가 배정되면 스스로 넘어가고,
  `-autoInit` 미션은 이미 돌고 있어 브리핑 화면 없이 들어간다.
- `OnAutoSelectRole = "...";` 2.22 의 서버 훅이다. 서버가 클라를 배정할 때 부른다. 훅은 클라 이름(`-name`)으로 그 클라의
  지정을 찾아 역할 번호를 돌려주고, 못 찾으면 아무 값도 돌려주지 않아 서버 기본 배정에 맡긴다. 매 호출을 서버 RPT 에
  `[ArmaMCP] autoSelectRole|pick=..|match=..|role=..|who=..|name=..` 한 줄로 남긴다. 못 찾으면 비교한 역할 목록도 남긴다.

`roles` 는 클라마다의 지정이다. `roles[0]` 이 클라 1 이다.

| 지정 | 고르는 역할 |
|---|---|
| 수 `n` | 역할 번호 n. 로비 목록의 역할 순서이고 진영을 가로질러 0부터 센다(서버 `getRoles` 순서, 로비 행의 `lbValue`) |
| 글자 | 유닛 변수 이름이 같은 빈 슬롯. 없으면 역할 설명(`description`)에 대소문자 무시 부분 일치하는 첫 빈 슬롯 |
| `null`, 빈 칸 | 서버 기본 배정. 사람이 가장 적은 진영의 첫 빈 슬롯이다 |

- 다른 진영 역할도 그대로 고른다. 역할 번호가 진영을 가로지르므로 진영 탭이 따로 없다.
- 지정한 역할이 이미 찼거나 없는 번호면 엔진이 서버 RPT 에 `Error, OnSelectRole ...` 를 남기고 기본 배정으로 보낸다.
  글자 지정은 빈 슬롯만 찾으므로 못 찾으면 기본 배정이다. 이때 `autoSlot.clients[].state` 는 `fallback` 이다.
- 클라는 이름으로 가린다. 한 PC 의 클라는 Steam ID 가 같기 때문이다. 이름 있는 스택의 클라 i 는 `<스택>_c<i>`,
  default 스택의 둘째부터는 `default_c<i>` 다. default 스택 클라 1 은 `-name` 이 없어 이름을 모른다.
  그 클라의 지정은 훅에서 "다른 지정에 없는 이름" 항목이 된다.
- 같은 시험 서버에 사람이 직접 들어와도 `skipLobby` 때문에 로비를 건너뛰고 서버가 배정한다. 이름이 지정에 없으면 기본 배정이다.
  default 스택 클라 1 에 지정을 주면 그 지정은 이름 모르는 사람에게도 적용될 수 있다.
- 미션 `description.ext` 가 `skipLobby` 를 정하면 그 값이 `server.cfg` 보다 앞선다. `skipLobby = 0;` 이면 훅이 불리지 않아
  로비에서 사람이 고른다. 데몬은 실행 전에 그 파일을 읽어 경고하고 `autoSlot.state` 를 `mission-lobby` 로 둔다.
- 설정의 `mp.extraCfgLines` 가 `skipLobby` 나 `OnAutoSelectRole` 을 이미 정했으면 데몬 줄은 넣지 않고 경고한다.
  `server.cfg` 에 같은 키가 둘이면 서버가 읽지 못한다.
- `autoSlot:false` 면 두 줄을 넣지 않는다. 로비에서 사람이 고른다.
- `lobbyProbe` 는 더 쓰지 않는다. 주면 무시하고 경고한다. 클라 로비 덤프 대신 서버 RPT 의 훅 줄을 본다.

결과의 `autoSlot` 은 이렇다.

```
autoSlot: {
  requested, state: 'assigned'|'fallback'|'no-evidence'|'mission-lobby'|'disabled', humanNeeded,
  clients: [{ index, name?, requested: 'auto'|'#n'|<글자>, state, roleIndex?, match?: 'number'|'var'|'desc'|'nomatch'|'none',
              role?, type?, side?, varName? }],
  log: [<서버 RPT 의 훅 줄과 OnSelectRole 오류 줄>], serverRpt? }
```

- `role`, `type`, `side`, `varName` 은 인게임 뒤 서버에서 읽은 실제 값이다(`roleDescription`, `typeOf`, `side`, `vehicleVarName`).
- `assigned` 는 훅이 고른 역할과 실제 역할이 같은 것이다. 지정이 없는 클라는 인게임이면 `assigned` 다.
- `state` 는 모든 클라가 `assigned` 면 `assigned`, 아니면 처음 어긋난 클라의 상태다.

```
arma_play { "mode": "sp", "world": "Altis", "position": [3000,4000] }
arma_play { "mode": "mp", "mission": "mcp_test.VR" }
arma_play { "mode": "mp", "mission": "op.Altis", "roles": ["Squad Leader", "opf_rifle"] }  # 클라 2개, 역할 지정
arma_play { "mode": "mp", "mission": "mcp_test.VR", "autoSlot": false }   # 로비에서 사람이
arma_play { "mode": "mp", "dryRun": true }                               # 인자만 확인
```

#### 프로필, 준비 마커, 셋업 SQF

재실행 사이클의 반복 입력과 뒤처리를 한 호출에 담는다.

- **saveProfile**: 실행이 인게임까지 가고 `ready` 도 성공하면 그 이름으로 프로필을 저장한다.
  `then` 의 실패는 저장을 막지 않는다. 이름은 `^[A-Za-z0-9_-]{1,40}$` 다.
- 저장하는 값은 해석이 끝난 값이다. 미션은 절대경로로, 모드는 실제로 쓴 목록으로 적는다.
  `modset:'rpt'` 로 띄웠어도 그때 RPT 헤더에서 읽은 목록이 들어간다.
  런처가 늘 붙이는 `selfModPath` 는 빼고 적는다.
- 즉석 생성 미션은 경로 대신 스캐폴드 인자(`world`, `name`, `playerType`, `position`, `safeSpawn`,
  `initSqf`)를 적는다. 공유 스캐폴드 폴더는 다음 호출이 덮어쓰기 때문이다.
- `killRunning`, `password`, `then` 은 저장하지 않는다.
- **profile**: 저장된 프로필을 불러온다. 명시한 인자가 프로필보다 우선하고, 프로필이 기본값보다 우선한다.
  프로필에 모드 목록이 있으면 `modset` 은 `explicit` 이다. 모르는 이름이면 실행 전에 있는 이름을 알려 주며 실패한다.
  `dryRun` 과 함께 쓰면 `profile.merged` 에 합친 인자를 보여 주고 저장은 하지 않는다.
  mp 프로필을 `mode:'sp'` 로 부르면 mp 전용 값은 얹지 않는다.
  `serverExtraArgs`, `port`, `autoSlot`, `roles` 와 `source:'server'` 인 `ready` 가 여기에 든다.
- 프로필 파일은 `arma.profilesFile` 이고, 비어 있으면 `~/.arma-mcp/launch-profiles.json` 이다.
  모양은 `{ v: 1, profiles: { <이름>: { mode, mission | scaffold, mods?, modset?, clientExtraArgs?,
  serverExtraArgs?, port?, autoSlot?, roles?, clients?, testMods?, ready?, savedAt } } }` 다.
  `testMods` 는 준 원본 경로로, `clients` 는 2 이상일 때만 적는다. 이름 있는 스택에서 부르면 프로필의 `port` 는 쓰지 않는다. 임시 파일에 쓴 뒤 rename 으로 바꾼다.
- **ready**: 인게임 진입 뒤 이번 실행이 만든 새 RPT 에서 `rpt` 정규식을 기다린다(대소문자 무시).
  `source` 는 `client`(기본) 또는 `server`(mp 전용)다. 파일의 처음부터 찾는다.
  새 RPT 가 없으면 기다리지 않고 `reason: 'newRpt 없음'` 으로 실패한다.
  이전 실행의 RPT 에 남은 같은 마커를 준비 완료로 오인하지 않기 위해서다.
- **then**: `ready` 가 끝난 뒤 SQF 를 `arma_exec` 와 같은 경로로 실행한다. 주석 제거와 RPT 오류 첨부가
  그대로 적용되고, 결과는 `then.exec` 에 담긴다. 결과가 없거나, `ERROR` 이거나, 실행 구간 RPT 에
  오류 블록이 남으면 실패다.
  RPT 오류 블록으로 실패하는 것은 결과가 `<nil>` 일 때뿐이다. 그 구간에는 같은 때 돈 모드나 미션 스크립트의 오류도 섞일 수 있다.
  셋업 코드는 끝에 `; true` 처럼 값을 두어 `<nil>` 이 나오지 않게 쓴다.
  `mode:'client'` 에 `target` 이 없으면 게임을 띄우기 전에 거절한다.
- 실제 실행이면 결과에 `rpt: { client?, server? }` 가 붙는다. 이번 실행 RPT 마다
  `{ file, errorBlocks, first(앞 3개 블록), warningMessages }` 다. 인게임 진입에 실패해도 붙는다.
- `ready` 나 `then` 이 실패하면 `ok` 는 false 이고 `error` 가 `ready 실패:` 나 `then 실패:` 로 시작한다.
  게임은 끄지 않는다. 인게임 진입에 실패한 실행에서는 둘 다 건너뛴다(`skipped: true`).
  `ready` 가 실패하면 `then` 도 건너뛴다.
- 결과에 더해지는 필드는 아래와 같다. `totalMs` 는 뒤처리 시간까지 센다.

```
ready?:   { ok, source, pattern, file?, line?, lineNumber?, elapsedMs, skipped?, aborted?, reason? }
then?:    { ok, skipped?, reason?, exec?(arma_exec 결과) }
rpt?:     { client?, server? }                                  # 각 { file, errorBlocks, first, warningMessages, error? }
profile?: { file, name?, merged?(dryRun), saved?, notSaved? }   # profile 이나 saveProfile 을 줬을 때
```

- `saveProfile` 을 줬는데 저장하지 않았으면 `profile.notSaved` 에 이유가 담긴다.
- 모르는 프로필이면 실행 전에 `{ ok:false, error, profiles, profilesFile }` 로 답한다.
- `profile` 을 줬는데 프로필 파일이 깨졌으면 실행 전에 파일 경로와 이유를 담아 실패한다.
  깨진 파일은 `saveProfile` 로도 덮어쓰지 않는다. 그때는 `profile.notSaved` 에 이유가 담긴다.

```
arma_play { "mission": "D:/missions/wc_test.Altis", "saveProfile": "wc",
            "ready": { "rpt": "\\[WC\\] init done" } }
arma_play { "profile": "wc", "killRunning": true,
            "then": { "code": "[] call WC_fnc_testSetup; true" } }
arma_play { "profile": "wc", "dryRun": true }                            # 합친 인자만 확인
```

## arma_scaffold_mission — 테스트 미션 생성·실행

최소 테스트 미션(빈 씬 또는 `initSqf` 로 셋업된 씬)을 즉석에서 생성하고, 기본으로 바로 실행한다.
손으로 mission.sqm 을 작성하지 않고 신선한 테스트 환경을 띄운다.

```
{ world?('VR' 기본), name?('mcp_test' 기본), playerType?('B_Soldier_F'),
  position?([동,북,높이]), safeSpawn?('land' 기본),
  initSqf?, launch?(true 기본), killRunning?, waitForNewRptMs?, dryRun?, overwrite?(true) }
```
- **world**: terrain 클래스명(폴더 확장자). 자유 지정 — `VR`, `Altis`, `Stratis`, `Malden`, `Tanoa`,
  `Enoch`(Livonia), 모드 맵 클래스명. VR 은 편의 기본값일 뿐 강제 아님.
- **position**: `[동, 북]` 또는 `[동, 북, 높이]`. **SQF `getPos` 와 같은 순서이며 mission.sqm 의
  `[동, 고도, 북]` 이 아니다.** 생성기가 변환한다. 높이를 생략하거나 0 이면 지면이다.
  미지정 시 `safeSpawn` 이 맵 중앙 근처 육지를 찾는다.
  **0.4.0 파괴적 변경**: 이전에는 이 값이 sqm 순서로 그대로 들어가, `[3000,4000,0]` 이 고도 4000m
  공중 스폰이 되었다. 옛 순서로 부르던 호출은 값을 바꿔야 한다.
- **safeSpawn**: 바다와 공중 스폰 보정.
  `'land'`(기본) 물 위면 가까운 육지로 옮기고 지면에 놓는다. 공중이면 내리고 지하면 올린다.
  `'ground'` 수직만 보정하고 가로 좌표를 유지한다.
  `'off'` 보정하지 않는다. init.sqf 가 `initSqf` 와 바이트 동일이 된다.
  켜져 있으면 **최종 고도는 항상 지면이다**. 공중 시작을 원하면 `'off'` 를 쓴다.
- **initSqf**: 미션 init.sqf 내용(엔진이 preprocess 하므로 주석 OK). "특정 미션" 은 여기에 셋업 SQF 를 넣어 만든다.
- **launch=true**: 생성 후 `arma_launch` 로 바로 로드(`-autotest`). `dryRun` 으로 인자만 확인 가능.
- 생성 미션에는 playable 슬롯과 `respawn=2`가 포함되어 플레이어 0명인 전용 서버에서도 미션이 유지된다.
- 출력: `{ ok, missionPath, world, name, files, safeSpawn,
  position:{requested,sqm}, warnings, launch?: <arma_launch 결과> }`

생성 위치: `arma.missionsDir` 설정 시 그 하위, 없으면 `~/.arma-mcp/missions/`. 산출물은 특정 조직 브랜딩 없이 중립.

```
arma_scaffold_mission { "world": "VR" }                        # 빈 VR 씬 만들어 바로 실행
arma_scaffold_mission { "world": "Altis", "position": [14000,16000], "initSqf": "player allowDamage false;" }
arma_scaffold_mission { "world": "Stratis", "launch": false }  # 생성만
```

### 바다와 공중 스폰 방지

`safeSpawn` 이 켜져 있으면 생성기가 init.sqf 앞에 보정 프렐류드를 넣는다. 미션이 시작되면
이 기계에서 local 인 플레이어 유닛이 물 위나 공중이나 지하에 있는지 보고 육지 지면으로 옮긴다.
지형별 좌표 테이블을 쓰지 않고 `worldSize`, `surfaceIsWater`, `getTerrainHeightASL`,
`BIS_fnc_findSafePos` 만 쓰므로 모드 맵에서도 같게 동작한다. 애드온에도 의존하지 않아
`@arma_mcp` 없는 바닐라 클라이언트에서도 미션이 자립한다.

낙하 피해는 되돌릴 수 있는 `HandleDamage` 이벤트로 막고 착지 후 뗀다. `allowDamage` 를 쓰지 않는
이유는 `initSqf` 의 `player allowDamage false` 를 되돌려 놓지 않기 위해서다.

검증은 RPT 한 줄로 한다. 판정 사유와 출발점과 도착점이 모두 들어 있다.

```
[arma-mcp][safeSpawn] result=moved reason=air mode=land world=Altis worldSize=30720
  from=[3000,4000,4000] to=[3000,4000,0.2] land=true water=false damage=0 elapsed=3.4
```
```
arma_rpt_wait   { "pattern": "\\[arma-mcp\\]\\[safeSpawn\\] result=", "fromEnd": true }
arma_rpt_search { "pattern": "\\[arma-mcp\\]\\[safeSpawn\\]" }
```
- `result`: `ok`(옮길 필요 없었음) | `moved` | `skip`(대상 유닛 없음, 항공기) | `failed`.
- 미션 변수 `arma_mcp_safeSpawn` 이 `"pending"` 에서 위 값 중 하나로 바뀐다. 보정 완료를 기다릴 때
  `waitUntil { (missionNamespace getVariable ["arma_mcp_safeSpawn", "pending"]) != "pending" };` 를 쓴다.
  최종 좌표는 `arma_mcp_safeSpawnPos` 에 들어간다.
- 데디케이트 서버에서는 `player` 가 없으므로 서버가 자기에게 local 인 playable 유닛을 보정한다.
  사람이 잡은 슬롯은 그 클라이언트에 local 이라 서버가 건드리지 않는다.

## 웹 게시 툴 — 전 인원 브라우저 동시 표시

에이전트가 생성한 HTML(브리핑, 미션 정보 등)을 MCP 서버 내장 LAN 웹 서버에 게시하고,
게임 내 전파로 **모든 플레이어의 기본 브라우저를 자동으로 연다**. 재게시하면 접속 중인
브라우저가 SSE 로 **동시에 자동 리로드**된다 — 리로드 스크립트는 서빙 시 자동 주입되므로
HTML 에 넣을 필요 없다. webroot(기본 `~/.arma-mcp/web`)의 파일을 Edit 로 직접 수정해도
같은 방식으로 리로드된다.

전제: 자동 오픈은 `@arma_mcp` 모드(DLL 포함)가 설치된 머신에서만 동작한다. 모드 없는
클라이언트는 열리지 않으므로 `opened.machines` 에 빠진 이름으로 감지하고 url 을 수동
안내한다. 데디케이티드 서버/HC 는 no-op(`opened.skipped` 에 나타남). 웹 서버는 신뢰
기본값 `web.host: "127.0.0.1"` 은 이 PC 전용이다. 이때 멀티플레이 미션에서는 `arma_web_publish` 가 전체 자동 오픈을 건너뛰고 `arma_web_open` 은 거절한다. `0.0.0.0` 으로 바꾸면 LAN 에 열리고 인증이 없으므로 외부에 노출하지 않는다.

### arma_web_publish

| 입력 | 설명 |
|---|---|
| `html` (필수) | 완전한 HTML 문서(4 MiB 캡) |
| `page` | 페이지 슬러그 `^[a-z0-9][a-z0-9_-]{0,63}$`. 기본 `index` → 루트 URL |
| `open` | `auto`(기본: 이 슬러그 **첫 게시일 때만** 전 클라 오픈 — 재게시는 SSE 리로드가 처리해 중복 팝업 없음) / `always` / `never` |

출력: `{ ok, page, url, file, bytes, isNew, webState, sseClients, opened: null|{execOk,completedBy,durationMs,machines,skipped}, note? }`

게임 미접속이어도 게시는 성공한다(`opened:null` + note) — url 을 수동 안내하면 된다.

### arma_web_open

이미 게시된 페이지(또는 임의 http/https URL)를 다시 연다. 늦게 접속한 플레이어 재오픈,
특정 플레이어 타게팅, webroot 에 직접 쓴 파일 열기에 사용.

| 입력 | 설명 |
|---|---|
| `page` | 열 페이지 슬러그. `url` 과 택일, 둘 다 없으면 `index` |
| `url` | 임의 http/https 절대 URL(스킴은 SQF/DLL 이중 검증) |
| `mode` | `all`(기본) / `client` |
| `target` | `mode='client'` 대상 플레이어 이름 |

출력: `{ ok, url, mode, opened:{...}, note? }`

```
arma_web_publish { "page": "brief", "html": "<html>...</html>" }        # 첫 게시 → 전원 자동 오픈
arma_web_publish { "page": "brief", "html": "<html>...v2</html>" }      # 재게시 → 팝업 없이 전원 리로드
arma_web_open { "page": "brief", "mode": "client", "target": "Bornsoul" }  # 늦참 플레이어에게만
```

## AHC_TacticalMap 연동 툴 — 무전 자막 / 전술지도

별도 모드 **AHC_TacticalMap**(브라우저 전술지도 + 인게임 데이터 익스포터)이 로드된 런타임에서 쓴다.

> **세 툴 모두 게임 중인 전원에게 보이는 방송이다.** 사용자가 "게임에 띄워라/알려라"라고 명시했을
> 때만 호출한다. 지시 확인·진행 보고·완료 알림·질문 답변은 툴 결과 텍스트로만 하고 인게임으로
> 방송하지 않는다(`arma_web_open` 도 같다).

`arma_status` 의 `tacmap` 이 `true` 고 그런 요청을 받았다면 **원시 SQF 로 재구현하지 말고 이 툴들을 쓴다.**
전체 배경·치트 카탈로그 27종·게이트 목록은 **`docs/tacmap.md`**.

세 툴 모두 와이어 프로토콜을 바꾸지 않는다 — 서버가 조립·검증한 SQF 를 기존 `exec` 프레임으로
`mode=server` 전송할 뿐이다(`arma_web_open` → `fn_openUrl` 과 같은 구조).

> **전술지도 화면을 특정 좌표로 포커스하는 SQF API 는 존재하지 않는다.** 포커싱은 브라우저 UI 동작뿐이다.
> "그 위치 띄워줘" 는 `arma_tacmap_mark` 로 마커를 찍는 것이 최선이고, 뷰어의 시점은 옮길 수 없다 —
> 에이전트는 이 한계를 사용자에게 그대로 전달한다. 자막으로 따로 알릴지는 사용자가 요청했을 때만 정한다.

### arma_tacmap_subtitle — 무전 자막

TacMap 의 zeusTitle 경로(화면 하단 레이어 911, 7초, `PH_radio_on/off` 무전 사운드)로 자막을 띄운다.

| 입력 | 설명 |
|---|---|
| `text` (필수) | 자막 본문. 제어문자·개행은 공백으로 접히고 300자 캡 |
| `speaker` | 발화자 라벨(32자 캡). 지정하면 `<발화자> : <본문>`, 생략하면 본문만 |
| `color` | `red`/`green`/`blue`/`yellow`(기본)/`hq`/`enemy` 또는 `#rrggbb`. 그 외는 거부 |
| `audience` | `all`(기본, 전원) / `side`(진영) / `players`(개인 지정) |
| `side` | `audience='side'` 대상 — `WEST`/`EAST`/`GUER`/`CIV`. 그룹 side 기준 |
| `players` | `audience='players'` 대상 이름 배열. 매칭 실패분은 출력 `missing` 에 |
| `timeoutMs` | 결과 대기(ms). 기본 5000 |

출력: `{ ok, audience, recipients(전원이면 null), missing, speaker, text, color, ack, zeusToolSfx, webChatMirrored, exec:{...}, rptErrors, note? }`

`audience='all'` 만 `fn_cheatZeusTitle` 을 거치므로 **웹 전술지도 채팅 로그에도 한 줄이 남는다**(`webChatMirrored`).
`side`/`players` 는 클라 로컬 효과라 `CBA_fnc_targetEvent` 로 플레이어 유닛을 직접 타게팅한다.
`AHC_ZeusTool` 이 없어도 자막은 정상 표시되고 **사운드만** 빠진다(웹 UI 경로와 달리 무시되지 않는다).

### arma_tacmap_mark — 전술지도 위치 표시

좌표에 마커를 만든다. 인게임 지도에는 즉시, 웹 전술지도에는 수집(harvest)으로 반영된다.
마커 이름은 항상 `mcp_mark_*` 라 TacMap 예약 프리픽스(`ahc_web_`/`ahc_text_`/`ahc_heli`/`ahc_ping_`)와 겹치지 않는다.

| 입력 | 설명 |
|---|---|
| `action` | `add`(기본) / `remove`(id 필수) / `clearAll`(이 툴이 만든 `mcp_mark_*` 만 삭제) |
| `pos` | 월드 좌표 `[x,y]` 또는 `[x,y,z]`(m). `add` 필수 |
| `text` | 마커 라벨(64자 캡) |
| `kind` | `icon`(기본) / `ellipse` / `rectangle` |
| `iconType` | `kind='icon'` 마커 타입(CfgMarkers). 기본 `mil_objective` |
| `color` | 마커 색 클래스(CfgMarkerColors). 기본 `ColorRed` |
| `size` | 영역 마커 `[a,b]` — **반축** 길이(m). 기본 `[200,200]` |
| `dir` / `brush` | 회전(도, 기본 0) / 채움 패턴(기본 `Border`) |
| `ttlSec` | 자동 삭제까지 초. `0`(기본)=미션 종료까지 유지 |
| `id` | 마커 식별자 → `mcp_mark_<id>`. 같은 id 재호출 시 덮어씀. 생략 시 자동 |
| `ping` | `true` 면 `fn_cheatPing`(지휘관 지시 핑 + 자막 + 20초 마커)도 호출 |
| `pingType` / `pingSide` | `rally`/`move`(기본)/`attack`/`warn`/`recon` · `''`(전체)/`WEST`/`EAST`/`GUER`/`CIV` |
| `commanderOverride` | 기본 false. 지휘관 좌석이 **비어 있을 때만** 임시 점유해 게이트를 통과하고 즉시 복원 |
| `resync` | 기본 true. TacMap `resync` 로 웹 지도에 즉시 반영(false 면 최대 5초 지연) |

출력: `{ ok, action, marker, grid, pos, kind, text, ttlSec, resynced, ping:{requested,delivered,status,reason,cooldownSec,commanderOverride}, ack, exec:{...}, rptErrors, focusNote, removeHint, note? }`

`ping.status` 는 `ok` / `skip`(미요청) / `no-tacmap` / `no-commander` / `no-effect`(쿨다운 등).
**TacMap 은 좌석이 비면 조용히 무시**하므로 이 툴이 호출 전후의 `ahc_ping_*` 마커 수를 실측해 이유를 돌려준다.
쿨다운(1.5초)은 `commanderOverride` 로도 우회되지 않는다.

### arma_tacmap_open — 웹 전술지도 열기

전술지도 페이지를 플레이어들의 기본 브라우저에 연다. 주소는 게임의 CBA 설정
`AHC_TacticalMap_host`/`_port` 를 프로브해 자동 해석한다.

| 입력 | 설명 |
|---|---|
| `mode` | `all`(기본) / `client` |
| `target` | `mode='client'` 대상 플레이어 이름 |
| `baseUrl` | 주소 직접 지정(http/https). 자동 해석이 틀릴 때만 |
| `path` | 루트 이후 경로. 기본 `/` |

출력: `{ ok, url, source, tacmapHost, tacmapPort, mode, opened:{execOk,completedBy,durationMs,machines,skipped}, note? }`

`source` 는 `override`(baseUrl) / `setting`(Host 설정값) / `lan-fallback`(Host 가 빈칸 = 웹서버가 게임 서버와
같은 머신 → 데몬 머신의 LAN IP 로 추정. 다르면 `baseUrl` 로 지정). `arma_web_open` 과 같은 전파 경로라
`@arma_mcp` 모드가 없는 클라이언트에서는 열리지 않는다(`opened.machines` 로 확인).

```
arma_tacmap_subtitle { "text": "적 기갑 접근중", "speaker": "지휘부", "color": "hq" }
arma_tacmap_subtitle { "text": "이동 개시", "audience": "side", "side": "WEST" }
arma_tacmap_mark { "pos": [4211,7302], "text": "적 집결지", "iconType": "mil_destroy", "ttlSec": 300 }
arma_tacmap_mark { "pos": [4211,7302], "ping": true, "pingType": "attack", "commanderOverride": true }
arma_tacmap_mark { "action": "clearAll" }
arma_tacmap_open {}
# 툴이 감싸지 않는 기능은 카탈로그(docs/tacmap.md)를 보고 arma_exec 로 — 반환값이 없으니 검증식 필수
arma_exec { "mode": "server", "code": "[12,30] call AHC_TacticalMap_fnc_cheatSetTime; str date" }
```

## arma_capture — 게임 화면 캡처

Arma 창을 스크린샷으로 찍어 **이미지로 반환**한다(MCP image content + 메타 JSON). 게임 브리지(exec)와
무관한 **서버 측 독립 경로**라 메인메뉴/로딩/에디터 등 DLL 미접속 상태에서도 동작한다 — 에이전트가
UI 표시·씬 상태를 직접 눈으로 검증하는 용도.

| 입력 | 설명 |
|---|---|
| `stack` | 찍을 스택(기본 `default`). 그 스택의 프로세스 창만 찍는다 |
| `target` | `client`(기본, `arma3_x64`) / `server`(데디 서버 콘솔 창) |
| `client` | `target='client'` 일 때 클라 순번(기본 1) |
| `scope` | `window`(기본, 게임 창만) / `screen`(주 모니터 전체 — 크래시 다이얼로그·런처 등 창 밖 확인용) |
| `delayMs` | 캡처 전 대기(ms). 씬 전환/UI 표시 대기. 기본 0. [0,10000] |
| `format` | `jpeg`(기본, 작음) / `png`(무손실) |
| `quality` | jpeg 품질. 기본 80. [1,100] |
| `maxWidth` | 이 폭 초과 시 다운스케일. 기본 1568(비전 토큰 최적). [320,3840] |

출력(메타): `{ ok, file, method:'printwindow'|'screen', windowRect:{x,y,w,h}|null, imageW, imageH, bytes, elapsedMs, note?, pruned? }`

`method` 는 실제 사용된 캡처 방식이다. `window` 요청이라도 PrintWindow 가 검은 프레임을 주면(독점
전체화면일 때 흔함) 화면에서 직접 캡처하며 `method:'screen'` + `note` 로 알린다 — 이 경우 게임 창이
다른 창에 가려져 있으면 그 내용이 찍힌다. 게임 최소화 시엔 `stage:'minimized'` 로 실패한다(바탕화면을
게임 화면으로 오인시키지 않기 위해). 창모드로 캡처가 안정적이려면 `arma.baseArgs` 에 `-window` 를 권장.

구현: 캡처 로직은 C# 헬퍼 exe(`~/.arma-mcp/bin/`, 최초 1회 `csc.exe` 로 컴파일·캐시)로 실행한다.
PowerShell 인라인은 창 탐색+PrintWindow+CopyFromScreen 조합이 Windows Defender AMSI 에 스크린 그래버로
오탐되어 차단되기 때문(.NET Framework 4 내장 `csc.exe` 필요 — 모든 최신 Windows 기본 제공).
저장 경로는 `capture.dir`(기본 `~/.arma-mcp/captures`), `capture.keepMax`(기본 100) 초과분은 자동 정리.

```
arma_capture {}                                              # 게임 창 캡처(jpeg)
arma_capture { "scope": "screen" }                           # 주 모니터 전체(다이얼로그 등)
arma_capture { "delayMs": 500, "format": "png" }             # 0.5s 대기 후 png
arma_capture { "target": "server", "scope": "screen" }       # 데디 서버 화면
```
