# Arma-MCP daemon 운영

Arma-MCP 0.3부터 게임 파이프와 공유 상태는 서버 컴퓨터의 daemon 한 개가 소유한다.
Claude Code와 Codex 플러그인은 각각 작은 stdio relay를 실행하고, relay마다 독립된
Streamable HTTP MCP 세션을 만든다.

## 서버 컴퓨터

`%USERPROFILE%\.arma-mcp\config.json`에 Arma와 전용 서버 경로를 설정한다.

```json
{
  "arma": {
    "exePath": "J:\\Steam\\steamapps\\common\\Arma 3\\Arma3_x64.exe",
    "serverExePath": "J:\\Steam\\steamapps\\common\\Arma 3\\arma3server_x64.exe",
    "selfModPath": "D:\\Mods\\@arma_mcp",
    "missionsDir": "E:\\ArmaMissions"
  },
  "mp": {
    "profilesDir": "E:\\ArmaServer\\profiles",
    "mpMissionsDir": "J:\\Steam\\steamapps\\common\\Arma 3\\MPMissions"
  },
  "mcp": {
    "port": 5303,
    "path": "/mcp",
    "tokenFile": "",
    "allowedOrigins": [],
    "maxSessions": 16,
    "idleTimeoutMs": 1800000,
    "maxCliSessions": 8,
    "cliIdleTimeoutMs": 60000,
    "maxBodyBytes": 6291456
  }
}
```

`arma.selfModPath` 를 비워 두면 데몬은 시작할 때 `<상태 폴더>\bridge-mod.json` 을 읽는다. 사람이 띄운 게임의 DLL 이 메인 화면에서 자기 모드 폴더를 적어 둔 파일이다. 적어 둔 설정값이 항상 우선이고, 어느 쪽을 쓰는지는 `arma_status` 의 `config.selfModSource` 가 알려 준다(`config`, `game-report`, `none`).

`arma.baseArgs`(기본 `[]`)는 daemon 이 띄우는 클라 모두에 붙는 인자다. daemon 은 클라마다 `-noPause` 를 넣으므로
여기 적지 않아도 된다. 적어 두면 한 번만 들어간다. `-noPauseAudio` 는 넣지 않으니 창이 포커스를 잃어도 소리를 내려면
`"baseArgs": ["-skipIntro", "-noSplash", "-noPauseAudio"]` 처럼 여기 둔다.

daemon을 foreground로 실행한다.

```powershell
node server\bundle\index.mjs daemon
```

최초 실행 시 bearer token을 `%LOCALAPPDATA%\Arma-MCP\daemon.token`에 생성한다.
`ARMA_MCP_TOKEN`을 지정하면 파일보다 우선한다. 사용자 지정 token은 UTF-8 기준 최소 32바이트여야
하며 256-bit 난수 사용을 권장한다. token을 명령행 인자, URL, 로그에 넣지 않는다.

백그라운드 시작과 상태·종료·재시작은 저장소의 운영 스크립트를 사용할 수 있다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build\daemon.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File build\daemon.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File build\daemon.ps1 restart
powershell -NoProfile -ExecutionPolicy Bypass -File build\daemon.ps1 stop
```

서버 재부팅 후 자동 시작하려면 같은 Windows 계정으로 `build\daemon.ps1 start`를 실행하는
Task Scheduler 작업을 등록한다. daemon과 Arma 전용 서버는 같은 계정으로 실행해야 기본 token 파일,
profiles 경로와 named-pipe 권한이 일치한다.

daemon은 구성과 관계없이 `127.0.0.1`에만 바인딩한다. MCP 관리자 endpoint와
`web.host`의 LAN HTML 게시 endpoint는 서로 다른 포트와 보안 정책을 사용한다.

### 종료

`/shutdown`, `build\daemon.ps1 stop`, Ctrl+C 는 같은 순서로 끝난다.

1. 새 연결을 받지 않는다. 이미 열린 연결로 들어온 요청은 세션에 넘기지 않고 HTTP 503 과
   `Arma-MCP daemon is stopping; this request was not run` 으로 답한다.
2. 진행 중이던 툴 호출이 끝나기를 최대 2초 기다린다. 그 안에 끝난 호출은 실제 결과로 답한다.
3. MCP 세션을 모두 닫는다. 그때까지 끝나지 않은 툴 호출에는 HTTP 503 과
   `Arma-MCP daemon stopped before this request finished; the tool may or may not have run` 으로 답한다.
   툴은 이미 실행됐을 수 있다.
4. 종료를 시작하고 2초가 지나도 남은 HTTP 연결은 끊는다. 본문을 다 보내지 않은 요청처럼 세션에 닿기 전에 멈춘 연결이다.
   `daemon.log` 에 `connection(s) still open 2000ms after stop; closing them` 을 남긴다.
5. 게임 파이프와 웹 게시 서버를 닫고 `daemon stopped` 를 남긴 뒤 프로세스가 끝난다.

정리가 10초 안에 끝나지 않으면 `daemon shutdown did not finish within 10000ms` 를 남기고 바로 끝낸다.
0.4.1 이하는 진행 중 툴 호출에 답하지 않은 채 그 연결이 끝나기를 끝없이 기다렸다.
HTTP 포트는 닫혔는데 프로세스가 게임 파이프를 쥔 채 남아 다음 daemon 이
`cannot own pipe \\.\pipe\arma_mcp: already in use` 로 뜨지 못했다.

`/health` 는 0.4.2 부터 daemon 의 `pid` 를 함께 알린다.

## 같은 컴퓨터의 Claude/Codex

플러그인 manifest는 다음 relay 명령을 자동으로 실행한다.

```powershell
node server\bundle\index.mjs relay
```

relay는 연결 직전에 daemon 상태를 확인하고 필요한 만큼만 개입한다.

| 관측 | 동작 |
|---|---|
| 같은 버전 daemon이 응답 | 그대로 붙는다 |
| 아무도 5303을 듣지 않음 | 같은 번들을 daemon 모드로 detached 실행하고 준비될 때까지 기다린다 |
| daemon이 더 낮은 버전 | `/shutdown` 으로 내리고 현재 번들로 다시 띄운다(업그레이드) |
| daemon이 더 높은 버전 | 띄우지 않고 "플러그인을 업데이트하라"는 오류 |
| 다른 token으로 뜬 daemon(401) / 남이 쓰는 포트 | 띄우지 않고 사유를 회신 |

그래서 새 컴퓨터는 **플러그인 설치만으로 연결된다**. 최초 기동이 token 파일도 만든다.
자동 기동된 daemon은 detached라 relay가 끝나도 살아 있고, 로그는
`%LOCALAPPDATA%\Arma-MCP\daemon.log` 와 `daemon.stdout.log` 에 이어 쓴다.

업그레이드에서 옛 daemon 이 `/shutdown` 을 받아들이고도 남아 있으면 relay 가 그 프로세스를 강제로 끝낸 뒤
새 daemon 을 띄운다. 기다리는 시간은 0.4.1 이하 daemon 이 3초, 0.4.2 이후 daemon 이 8초다.
0.4.1 이하 daemon 은 진행 중 툴 호출이 있으면 스스로 끝나지 않아 오래 기다려도 얻는 것이 없다.
`relay.log` 에 `acknowledged shutdown but is still running after 3000ms; killing it` 처럼 남는다.

끝낼 프로세스는 `/shutdown` 을 보내기 전에 정한다. relay 는 프로세스 목록을 먼저 읽고 `/health` 를 다시 본다.
그사이 다른 relay 가 업그레이드를 마쳐 같거나 높은 버전 daemon 이 답하면 그 daemon 을 내리지 않는다.
`/health` 의 `pid` 를 먼저 보고, 0.4.1 이하처럼 없으면 MCP 포트를 LISTEN 하는 프로세스를 본다.
그 프로세스의 명령행이 arma-mcp 번들 `index.mjs` 를 `daemon` 인자로 실행한 node 여야 한다.
relay, `cli`, `selfupdate`, `doctor` 처럼 다른 모드로 실행한 같은 번들과 relay 자신은 끝내지 않는다.
daemon 이 종료 요청을 받아들이지 않았으면 아무것도 끝내지 않는다.
끝내기 직전에 목록을 한 번 더 읽는다. 그 pid 의 명령행이 처음과 다르면 끝내지 않는다. 옛 daemon 이 끝난 뒤 pid 가 재사용됐을 수 있다.

새 daemon 은 게임 파이프가 풀린 뒤에 띄운다. 끝낼 프로세스를 집어내지 못했어도 옛 daemon 이 파이프를 쥐고 남아 있을 수 있다.
다른 relay 가 띄운 새 daemon 이 먼저 답하면 띄우지 않고 그 daemon 에 붙는다.
파이프가 끝내 풀리지 않으면 `still holds the game pipe` 로 답한다.

relay 가 시작할 때 파이프는 잡혀 있는데 MCP 포트에 아무도 없고 pre-0.3 서버로 보이는 프로세스도 없으면,
다른 relay 가 내리는 옛 daemon 이 끝나기를 최대 5초 기다린다. 그 사이 파이프가 풀리면 daemon 을 띄우고,
새 daemon 이 답하면 붙는다. 그대로면 `A previous Arma-MCP daemon may still be shutting down, or a pre-0.3 Arma-MCP server holds the pipe` 로 답한다.

세션 중에 daemon 이 사라지면 다음 툴 호출이 `ECONNREFUSED` 를 맞는다. 0.4.2 부터 relay 는 이때 daemon 을
다시 띄우고 세션을 다시 세운 뒤 그 호출을 한 번 재전송한다. 새 연결이 곧바로 거절된 호출은 daemon 에 닿은 적이 없어 재전송해도 안전하다.
daemon 에 닿았을 수 있는 호출은 재전송하지 않는다. 툴 호출은 멱등이 아니다. 해당하는 경우는 셋이다.

- daemon 이 멈추면서 503 으로 답한 호출. relay 는 daemon 의 문구 뒤에 `The next call reconnects and starts the daemon again if it is not running.` 을 붙여 답한다.
- 진행 중에 연결이 끊긴 호출. `was lost while this request was running; the tool may or may not have run` 으로 답한다.
- keep-alive 연결로 보낸 호출이 끊겨 새 연결로 다시 보냈는데 거절된 호출. daemon 이 그 호출을 받아 실행하다 죽었을 수 있어 바로 위와 같이 답한다.

어느 경우든 다음 호출이 daemon 을 다시 띄우거나 새 daemon 에 붙는다.
띄우기 전에 MCP 포트가 스스로 다시 열리는지 최대 5초 본다. 다른 relay 가 업그레이드하느라 daemon 을
내렸다 올리는 중이면 그 daemon 에 붙는다. 그 daemon 이 더 높은 버전이면 "플러그인을 업데이트하라"는 오류로 답한다.
다시 띄우는 시도는 15초에 한 번까지다. 아래 억제 신호가 있으면 띄우지 않고 이전과 같은 연결 오류로 답한다.
그래서 세션이 열린 relay 가 있으면 `build\daemon.ps1 stop` 으로 내린 daemon 도 그 relay 의 다음 툴 호출에서 다시 뜬다.
계속 내려 두려면 그 세션들을 닫는다.

동시에 여러 relay가 기동을 시도해도 파이프와 5303 포트를 먼저 잡은 daemon 하나만 살아남고
나머지는 스스로 종료한다. relay는 자식이 죽어도 곧바로 실패로 단정하지 않고 health를 다시 확인한다.
살아남은 daemon 이 이 relay 보다 낮은 버전이면 업그레이드 도중 옛 relay 가 같은 순간 띄운 것이다.
relay 는 그 daemon 을 위의 업그레이드 절차로 한 번 내리고 다시 띄운다. 다시 띄워도 낮은 버전이 이기면
`won the start race` 로 답한다. 옛 플러그인을 쓰는 에이전트 세션을 업데이트하거나 닫은 뒤 다시 연결한다.
더 높은 버전이 이겼으면 "플러그인을 업데이트하라"는 오류로 답한다.

자동 기동을 끄는 신호는 둘이다.

- `ARMA_MCP_NO_AUTOSTART=1` — 명시적 비활성화
- `ARMA_MCP_TOKEN` — 원격 터널 사용 신호. Arma가 없는 관리 PC에서 빈 로컬 daemon이 뜨는 것을 막는다

각 relay 종료는 자신의 HTTP 세션만 닫으며 게임 파이프와 다른 세션은 유지한다.

daemon을 직접 통제하고 싶으면 `build\daemon.ps1` 을 그대로 쓰면 된다. 자동 기동과 같은 번들,
같은 token 파일, 같은 로그 위치를 사용한다.

## 셸 CLI

`arma-mcp` 명령은 명령마다 daemon 에 `cli` 세션 하나를 열고, 도구를 부르고, 닫는다.
요청 헤더 `x-arma-mcp-transport: cli` 로 relay 와 구분된다.
명령과 출력은 [CLI 안내](cli.md)에 있다.

- CLI 는 이미 떠 있는 daemon 에 붙기만 한다. daemon 을 띄우거나 재시작하거나 끄지 않는다.
- 아무도 포트를 듣지 않으면 CLI 는 종료 코드 3 으로 끝난다. daemon 은 relay 나 `build\daemon.ps1` 이 띄운다.
- CLI 는 게임 게이트웨이를 열지 않는다. 게임 파이프는 계속 daemon 하나가 소유한다.
- cli 세션의 GET 스트림은 relay 처럼 405 로 막는다.
- `/health` 와 `arma_status` 의 `sessions.byTransport.cli` 가 지금 열린 cli 세션 수다.
- daemon 이 [종료](#종료) 중이면 CLI 도 503 을 받고 종료 코드 3 으로 끝난다. stderr 에 그 절의 문구가 그대로 온다. CLI 는 그 명령을 다시 보내지 않는다.
- 상한, 유휴 만료, 끊김 처리는 [세션과 보안 기본값](#세션과-보안-기본값)에 있다.

## 원격 관리 컴퓨터

서버의 5303 포트를 LAN이나 인터넷에 직접 노출하지 않는다. SSH 로컬 포워딩을 연다.

```powershell
ssh -N -L 5303:127.0.0.1:5303 user@arma-server
$env:ARMA_MCP_TOKEN = '<서버 daemon.token의 값>'
```

원격 컴퓨터의 플러그인 relay도 기본 URL `http://127.0.0.1:5303/mcp`를 사용하므로 추가 URL 변경이
필요 없다. 포트를 변경한다면 서버 daemon, SSH 포워딩의 양쪽 포트, 원격 relay의
`ARMA_MCP_DAEMON_PORT`를 모두 같은 값으로 설정한다.

Codex에서 HTTP MCP를 직접 등록하는 경우:

```toml
[mcp_servers.arma]
url = "http://127.0.0.1:5303/mcp"
bearer_token_env_var = "ARMA_MCP_TOKEN"
```

Claude Code에서 직접 등록하는 경우에도 같은 URL과
`Authorization: Bearer ${ARMA_MCP_TOKEN}` 헤더를 사용한다. 직접 HTTP 등록과 플러그인 relay를
동시에 켜면 툴이 중복 표시되므로 하나만 선택한다.

## 테스트 스택

daemon 하나가 테스트 스택 여러 개를 함께 돌린다. 스택마다 게임 파이프, 게임 포트, profiles 폴더, 실행 lease 가 따로다.
도구 입력과 폴더 구조는 [툴 레퍼런스의 테스트 스택](tools.md#테스트-스택)에 있다.

- default 스택은 `pipeName`(기본 `\\.\pipe\arma_mcp`)을 쓴다. daemon 이 시작할 때 이 파이프가 이미 쓰이면 지금처럼 시작이 실패한다.
- 이름 있는 스택 `<id>` 는 `<pipeName>_s_<id>` 를 쓴다. 이 파이프가 이미 쓰이면 그 스택만 열리지 않는다.
- 스택 폴더의 상위는 설정 `stacks.root` 다. 비우면 `~/.arma-mcp/stacks` 다. 기본 모드의 PBO 를 고쳐 시험할 때는 오버레이를
  하드링크로 만들 수 있게 그 모드와 같은 드라이브에 둔다.

```json
{
  "stacks": {
    "root": "D:\\ArmaMcpStacks",
    "max": 4,
    "maxClients": 4,
    "portStep": 10,
    "testModMaxMB": 512,
    "overlayCopyMaxMB": 1024,
    "windowWidth": 1600,
    "windowHeight": 900
  }
}
```

- `windowWidth`, `windowHeight` 는 창 모드로 뜨는 스택 클라의 창 크기다. 기본값은 실제 플레이와 같은 16:9 인 1600x900 이다.
  클라가 둘 이상이고 창 4분할(아래)을 껐거나 클라가 다섯 이상이면 daemon 이 `-posX`, `-posY` 로 창을 주 모니터 작업 영역 안에 겹치지 않게 나란히 놓는다.
  이 크기로 다 안 들어가면 그 실행만 같은 비율로 줄인다. 2560x1440 화면에 클라 둘이면 1264x711 이다.
  줄인 폭이 640 보다 작아야 하면 줄이지 않고 이 크기로 겹쳐 놓는다. 설정 파일의 값은 바꾸지 않는다.
  창 4분할은 이 비율로 칸 안 창의 클라이언트 영역을 정한다.

- daemon 이 다시 뜨면 `<stacks.root>\<id>\stack.json` 이 있는 스택의 파이프를 다시 연다. 돌던 전용 서버가 제 파이프로 다시 붙는다.
- 이름 있는 스택의 게임은 0.5.0 이상 브리지 DLL 이 필요하다. DLL 은 daemon 이 준 환경 변수 `ARMA_MCP_GAME_PIPE` 로 스택 파이프를 고른다.
- `/health` 의 `game` 과 `doctor` 는 default 스택만 본다. 스택 전체는 `arma_status` 의 `stacks` 로 본다.

### 창 4분할

daemon 이 띄운 게임 창이 둘 이상이면 daemon 이 모니터마다 작업 영역을 네 칸으로 나눠 창을 놓는다. 스택을 가리지 않는다.

```json
{ "windowTiler": { "enabled": true, "stacks": [] } }
```

- 대상은 daemon 이 띄운 클라와 `-profiles` 가 `stacks.root` 아래인 클라다. 사람이 직접 띄운 Arma 와 서버는 보지 않는다.
  `stacks` 에 스택 이름 패턴(`*` 는 아무 글자)을 적으면 그 스택만 본다. 비우면 모든 스택이다. 예: `["default", "llm*"]`.
- 대상 창이 하나뿐이면 손대지 않는다. 둘 이상이 되면 시작 시각이 이른 창부터 왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래 칸을 받는다.
  주 모니터 네 칸이 먼저 차고, 다섯째부터는 나머지 모니터를 왼쪽부터(왼쪽 끝이 같으면 위부터) 네 칸씩 채운다.
  모니터가 셋이면 열둘까지 놓고 그 뒤 창은 칸 없이 그대로 둔다. 칸은 그 모니터 작업 영역의 4분의 1 이라 모니터마다 다를 수 있다.
  창이 닫히면 그 칸이 비고, 같은 창은 같은 칸에 둔다. 둘에서 하나로 줄면 남은 창은 그 자리에 둔다.
  모니터를 빼서 칸이 없어진 창은 다음에 맞출 때 빈 칸을 다시 받는다.
- 칸 안의 창은 클라이언트 영역이 `stacks.windowWidth:windowHeight` 비율(기본 16:9)인 가장 큰 크기다. 한 모니터의 네 창은 크기가 같고
  작업 영역 가운데에 붙어 모이며, 남는 자리는 모니터 가장자리 쪽에 생긴다.
  2560x1392 작업 영역이면 클라이언트 1168x657, 바깥 창 1184x696 이고 왼쪽 위 창이 (96,0) 에 놓인다.
  Arma 는 3D 화면 비율을 프로필의 `fovLeft`, `fovTop`(새 프로필은 16:9)으로 정하고 창 크기를 따라 바꾸지 않는다. 클라이언트 영역이 이 비율과 다르면 화면이 늘어나 보인다.
  바깥 창과 클라이언트 영역의 차이(테두리와 제목 표시줄)는 헬퍼가 창마다 잰다.
- daemon 이 놓은 그대로인 창은 칸 사각형이 바뀌면(작업 표시줄, 모니터 배율, 비율 설정, 이전 daemon 이 1280x696 으로 놓은 창) 한 번 다시 맞춘다.
  사람이 옮긴 창과 daemon 이 꺼진 사이 옮겨진 창은 그대로 둔다.
- 창이 처음 창 모드로 보일 때와 게임이 스스로 자리나 크기를 바꿨을 때만 칸에 맞춘다(120초에 6번을 넘기면 그 창은 포기).
  사람이 끌거나 크기를 바꾸거나 최대화한 창은 다시 끌어오지 않는다. 끄는 중 표시와 직전 1초 안의 마우스 왼쪽 버튼이나 Win 키로 가른다.
  게임 안에서 마우스 왼쪽 버튼을 누르는 중에 게임이 바꾼 것도 사람이 한 것으로 본다.
- 전체 화면 창은 옮기지 못한다. default 스택 클라 1 처럼 창 모드가 아닌 클라는 `-window` 를 줘야 놓인다.
- 창을 옮길 때 포커스를 빼앗거나 창을 앞으로 가져오지 않는다. 키 입력도 보내지 않는다. 뒤에 있는 게임에 활성 표시만 알린다(아래 포커스 가드).
- 새로 뜨는 게임은 시작 중에 창 메시지를 늦게 처리한다. 옮긴 뒤 목표에 닿을 때까지 최대 8초 기다린다.
- 창을 보고 옮기는 일은 C# 헬퍼 `~/.arma-mcp/bin/arma-tiler-<해시>.exe` 가 한다. daemon 이 처음 쓸 때 .NET Framework 의 csc 로 만든다.
  헬퍼는 daemon 의 자식이고 daemon 이 끝나면 함께 끝난다. 칸 배정과 daemon 이 띄운 pid 는 상태 폴더의 `window-tiler.json` 에 남아
  daemon 이 다시 떠도 이어받는다. 같은 pid 라도 시작 시각이 다르면 다른 프로세스로 본다.
  daemon 이 꺼진 사이 자리가 바뀐 창은 누가 옮겼는지 몰라 끌어오지 않고 그 자리를 받는다.
  이전 daemon 이 띄운 default 클라 1 은 `-mod` 에 `stacks.root` 아래 경로(테스트 애드온, 오버레이)가 있을 때만 대상으로 본다.
- 창 크기는 늘 칸 크기로 바꾼다. 사용자가 `-x`, `-y` 로 준 크기도 칸 크기가 된다.
- Arma 는 시작 중(로딩 화면)에 바뀐 창 크기를 렌더 해상도에 반영하지 않는다. 그 창은 Arma3.cfg 크기로 그린 화면을 칸에 줄여 보인다.
  인게임에서 바뀐 크기는 바로 반영한다. 그래서 daemon 은 칸에 놓일 클라를 처음부터 그 칸 크기로 띄운다.
  대상 스택에서 클라가 둘에서 넷인 실행, 다른 대상 게임 창이 떠 있을 때 띄우는 클라 하나(`arma_launch`, `arma_play` 의 SP 와 MP)가 그렇다.
  칸이 다른 모니터면 그 모니터 칸 크기다. 같은 스택의 떠 있는 창은 이번 실행이 끄므로 세지 않는다. 사용자가 `-x`, `-y` 를 줬으면 그 크기로 띄운다.
  이때 `-posX`, `-posY` 는 붙이지 않는다([툴 레퍼런스](tools.md)). daemon 로그에 `[launch]` 나 `[launchMp]` 의 `창 타일러 칸 크기로 띄움` 이 남는다.
  끄면(`enabled: false`) 0.5.5 처럼 클라를 겹치지 않는 격자로 나란히 놓는다.
- 다른 창 배치 도구와 함께 돌리지 않는다. 둘이 같은 창을 서로 옮긴다.
- 놓는 일은 daemon 로그의 `[tiler]` 줄과 `arma_status` 의 `windowTiler` 로 본다.

### 포커스 가드

daemon 은 앞에 없는 창 모드 게임에 `WM_ACTIVATE(WA_INACTIVE)` 를 보내, 사람이 다른 창에 치는 키를 그 게임이 쓰지 않게 한다.

```json
{ "windowTiler": { "enabled": true, "stacks": [], "focusGuard": true } }
```

- 까닭: Arma 3(2.22)는 키보드 Raw Input 을 `RIDEV_INPUTSINK` 로 등록해 창이 뒤에 있어도 모든 키를 받는다.
  창 모드에서는 받은 키를 자기 활성 표시(`isGameFocused`)가 켜져 있을 때 쓴다. 그 표시는 메인 창이 받은 `WM_ACTIVATE` 로만 바뀐다.
  시작 중에 활성이 바뀌면 그 알림을 놓쳐 표시가 켜진 채 뒤로 가는 창이 생긴다. 그 창은 터미널에 치는 키를 그대로 쓴다.
  1인칭 화면이면 마우스를 자기 창 안에 가두기도 한다(`ClipCursor`).
- 대상은 창 4분할과 같다(daemon 이 띄운 클라, `stacks` 패턴). 그중 제목 표시줄이 있고 최소화되지 않은 게임 창만 본다.
  전체 화면 창은 이 알림으로 표시가 바뀌지 않아 보내지 않는다.
- 앞 창이 그 게임 프로세스의 창이면 보내지 않는다. 처음 본 때와 앞에서 뒤로 간 때 보내고, 뒤에 있는 동안은 1초마다 다시 보낸다.
  이미 꺼진 표시에 다시 보내도 게임은 그대로다. 그 게임의 눌린 채 남은 키도 이때 풀린다.
- 마우스 단추가 눌려 있으면 미룬다. 비활성 알림을 받은 게임은 자기가 눌렸다고 보는 마우스 단추를 `SendInput` 으로 떼기 때문이다.
- 알림은 `PostMessage` 가 아니라 `SendMessageTimeout`(100 ms)으로, 관찰과 따로 도는 스레드에서 보낸다.
  게임은 보낸 메시지를 게시된 메시지보다 먼저, 보낸 메시지끼리는 온 순서대로 처리한다. 앞 창이 아님을 본 바로 뒤에 보내므로,
  그 뒤에 사람이 게임을 앞으로 가져와도 Windows 의 활성 알림이 이 알림 다음에 처리돼 그 게임은 키를 받는다.
  남는 틈은 확인과 보내기 사이의 짧은 순간이다. 그 순간에 게임이 앞으로 오면 앞에 있는데 키를 안 받을 수 있고, 다른 창에 갔다 오면 풀린다.
  활성 알림(`WA_ACTIVE`)은 보내지 않는다. Arma 는 활성 알림마다 화면 보호기 값을 새로 저장해, 겹쳐 보내면 사람이 정한 값을 잃는다.
- 시간 안에 처리되지 않은 알림은 게임이 아직 꺼내지 않았으면 취소되고, 처리하던 중이면 끝까지 간다. 다음 관찰이 다시 보낸다.
  같은 창 알림이 아직 줄에 있으면 겹쳐 넣지 않는다.
- Arma 는 활성 알림마다 그때의 화면 보호기 값을 저장하고 비활성 알림 때 되돌린다. 한 번도 활성이 된 적 없는 게임은 저장값이 0 이다.
  헬퍼는 비활성 알림 앞의 값을 잡아 두고, 마지막 알림 뒤 2초 동안 앞 창이 그대로면 그 값으로 되돌린다. 그동안 다시 보내면 처음 잡은 값을 이어 쓴다.
  앞 창이 바뀌면 다른 게임의 활성 처리가 바꾼 값일 수 있어 지켜보기를 그만둔다.
- Windows 의 앞 창과 포커스는 바꾸지 않고, 키와 마우스 입력도 보내지 않는다. 사람이나 도구가 게임을 앞으로 가져오면 그 게임은 키를 받는다.
- 뒤에 있는 창 모드 게임은 비활성이 되어 `-noPause` 로도 약 60 FPS 로 묶인다. 표시가 켜진 채 뒤에 있던 창은 그보다 빨리 그렸다.
- `enabled` 가 `false` 여도 `focusGuard` 가 `true` 면 같은 헬퍼가 돌고 창은 옮기지 않는다. 둘 다 끄면 헬퍼를 띄우지 않는다.
- 알림은 daemon 로그의 `[tiler] 포커스 가드:` 줄로 본다. 게임마다 처음 한 번만 남기고, 처리하지 못한 까닭이 뜻밖이면 경고를 남긴다.

## 전용 서버

클라이언트 없이 새 서버를 실행:

```text
arma_launch_server {
  mission: "mcp_test.VR",
  killRunning: true,
  serverReadyTimeoutMs: 60000,
  bridgeReadyTimeoutMs: 120000
}
```

외부 프로세스 관리자가 전용 서버를 먼저 시작해도 addon DLL은 daemon에 백오프로 재접속한다.
이 경우 `mp.profilesDir`를 실제 `-profiles`와 맞추고 다음으로 준비를 기다린다.

```text
arma_status { waitFor: "dedicated", timeoutMs: 120000 }
```

활성 미션의 addon postInit 이후에만 SQF 브리지가 생긴다. 로비에서는 서버 프로세스와
`arma_rpt_* { source:"server" }` 진단만 가능하다. 시작된 미션에서는 플레이어가 0명이어도
`mode:"server"` 실행과 텔레메트리가 동작한다.

## 세션과 보안 기본값

- 모든 세션은 같은 신뢰 관리자이며 별도 RBAC나 실행 lease가 없다.
- relay 와 원격 HTTP 세션은 합쳐 최대 16개(`mcp.maxSessions`)다. 유휴 만료는 30분이다.
- HTTP 본문 상한은 6MiB다.
- `x-arma-mcp-transport: cli` 로 붙은 세션은 따로 센다. 상한은 `mcp.maxCliSessions`(기본 8)이다.
  cli 세션이 몰려도 relay 와 원격 HTTP 가 쓰는 `mcp.maxSessions` 자리는 줄지 않는다.
  상한에 걸리면 429 응답에 그 설정 이름이 실린다.
- cli 세션의 유휴 만료는 `mcp.cliIdleTimeoutMs`(기본 60초)다. 청소는 두 만료 중 짧은 쪽의 절반마다 돈다.
- cli 가 응답을 받기 전에 연결을 끊으면 데몬이 그 세션을 바로 닫는다. 진행 중인 exec, 대기, lease 가 함께 풀린다.
  이때 로그에 `[mcp-daemon] cli session <id> closed: client disconnected mid-request` 가 남는다.
  relay 와 원격 HTTP 세션은 이 규칙을 쓰지 않는다.
- 클라이언트가 `notifications/cancelled` 로 호출 하나를 취소하면 그 호출의 대기와 exec 가 멈춘다. 세션은 그대로다.
- 동시에 여러 `arma_exec`를 실행할 수 있다. 런치와 종료 계열은 스택마다 직렬화된다. 다른 스택끼리는 동시에 띄우고 끈다.
- 세션 ID는 연결 추적용이며 사용자 신원이 아니다.
- `Origin`이 없으면 native MCP client로 허용하고, 있으면 `mcp.allowedOrigins`의 정확한 값만 허용한다.
- token을 바꾼 뒤에는 daemon과 relay를 재시작한다.

## 자동 업데이트

세션이 시작될 때 플러그인이 최신인지 백그라운드로 확인하고, 새 버전이 있으면 조용히 설치해 둔다.
**현재 세션은 구버전 그대로 계속 돌고, 다음 세션부터 적용된다.** 어떤 실패도 세션을 막지 않는다.

트리거는 둘이다. relay 기동은 host-neutral 경로이므로 훅 메커니즘이 없는 호스트에서도 동작하고,
Claude Code 에서는 `hooks/hooks.json` 의 SessionStart 훅이 추가로 붙어 지난 세션의 결과를
화면에 알린다. 둘 다 실제 작업은 detached 자식에게 넘기고 즉시 끝나며, 쿨다운 기록과 배타 락으로
겹쳐 돌지 않는다.

판정은 **마켓플레이스 항목의 `version` 과 설치 버전 비교**다. 호스트 CLI 가 실제로 참조하는 값이
그것이기 때문이다. 순서는 네 단계다.

1. 스냅샷 버전이 이미 설치본보다 높으면 곧바로 설치한다(지난번 갱신은 됐는데 설치가 실패한 상태를 복구).
2. `git ls-remote` 로 원격 HEAD 를 보고 스냅샷과 같으면 여기서 끝낸다. 객체를 받지 않는 1 RTT다.
3. 다르면 마켓플레이스를 갱신하고 버전을 다시 읽는다. 버전이 그대로면 설치하지 않는다.
4. 올랐으면 호스트 CLI 로 설치한다.

문서만 고친 커밋은 3단계에서 멈추고, 그 뒤로는 스냅샷 HEAD 가 원격과 같아져 2단계에서 무료로 끝난다.

| 환경변수 | 기본 | 의미 |
| --- | --- | --- |
| `ARMA_MCP_NO_AUTOUPDATE` | 없음 | `1`/`true`/`yes`/`on` 이면 완전히 끈다. `0`/`false` 는 끄지 않는다 |
| `ARMA_MCP_AUTOUPDATE_COOLDOWN_H` | `6` | 확인 간격(시간). `[1, 24]` 로 클램프 |

`ARMA_MCP_TOKEN` 이 설정된 원격 터널 세션에서는 자동 기동과 마찬가지로 자동 업데이트도 억제된다 —
원격 관리자가 서버 컴퓨터의 플러그인을 갈아치우면 안 된다. **개발 체크아웃(플러그인 루트가 호스트
설치 캐시가 아니고 `.git` 이 있는 경우)도 자동으로 제외**되므로 작업 트리가 건드려지지 않는다.

상태는 `%LOCALAPPDATA%\Arma-MCP\selfupdate.json` 에 남는다. 쿨다운을 무시하고 지금 확인하려면:

```powershell
$p = "$env:USERPROFILE\.claude\plugins\cache\ahc\arma-mcp\<버전>"
node "$p\server\bundle\index.mjs" selfupdate check --root "$p" --cli claude --json
```

이 명령은 확인만 하는 것이 아니라 **실제로 업데이트를 수행할 수 있다.**

등록된 마켓플레이스 URL 이 플러그인이 명시한 저장소와 다르고 원격 접근이 연속으로 실패하면,
복구 명령을 담은 안내를 한 번 띄운다. **자동으로 재등록하지는 않는다** — 백그라운드 프로세스가
호스트 전역 상태를 바꾸는 일이고, 받은 매니페스트가 자기 소스를 다시 가리킬 수 있으면 한 번의
잘못된 릴리스가 스스로 전파되기 때문이다. 안내대로 직접 실행한다.

```powershell
claude plugin marketplace remove ahc
claude plugin marketplace add <새 저장소 URL>
claude plugin install arma-mcp@ahc
```

## 문제 해결

### 먼저 `doctor`

원인 판정과 조치를 한 화면으로 출력한다. 파이프 점유·포트·token·환경변수·로그 tail을 한 번에 본다.

```powershell
$root = "$env:USERPROFILE\.claude\plugins\cache\ahc\arma-mcp"
Get-ChildItem $root                              # 설치된 버전 폴더 확인
$p = Join-Path $root '<버전>'
node "$p\server\bundle\index.mjs" doctor
```

셸에서는 `arma-mcp doctor` 가 같은 글을 찍는다.

### `arma-mcp` 가 종료 코드 3 으로 끝난다

CLI 가 daemon 에 붙지 못했거나 daemon 이 요청을 끝내지 못했다. stderr 한 줄에 사유와 조치가 함께 온다.

| 사유 | 조치 |
|---|---|
| 아무도 포트를 듣지 않는다 | 에이전트 세션의 MCP 연결을 열어 relay 가 daemon 을 띄우게 한다. 손으로 띄우려면 `build\daemon.ps1 start` 를 쓴다 |
| HTTP 401 | 이 셸의 token 이 daemon 과 다르다. 터널이면 에이전트 세션과 같은 `ARMA_MCP_TOKEN` 을 export 한다 |
| HTTP 409 또는 버전 차이 | CLI 와 daemon 의 버전이 다르다. CLI 가 낮으면 PATH 의 `arma-mcp` 가 옛 플러그인 폴더를 가리킨다. daemon 이 낮으면 에이전트 세션을 새로 열어 relay 가 맞추게 한다 |
| HTTP 429 | cli 세션이 `mcp.maxCliSessions` 만큼 열려 있다. 다른 `arma-mcp` 명령이 끝난 뒤 다시 한다 |
| HTTP 503 | daemon 이 [종료](#종료) 중이다. `this request was not run` 이면 도구는 돌지 않았다. `arma-mcp status` 로 daemon 이 다시 떴는지 본 뒤 다시 한다. `the tool may or may not have run` 이면 명령이 게임에서 이미 돌았을 수 있다. `arma-mcp status` 는 SQF 가 돌았는지 보여 주지 않는다. 다시 하기 전에 읽기 전용 exec 나 RPT 로 게임 상태를 확인한다 |
| 명령 도중 연결이 끊겼다 | daemon 이 끝났거나 재시작됐다. 명령이 게임에서 이미 돌았을 수 있어 503 의 `the tool may or may not have run` 과 같이 다룬다 |

CLI 는 어느 경우에도 daemon 을 재시작하지 않는다. 다른 세션이 같은 daemon 을 쓰고 있기 때문이다.

### 재연결이 `-32000`으로 실패한다

`-32000`은 MCP SDK의 `ConnectionClosed` 코드이자 relay가 설명형 오류에 쓰는 코드다.
**코드 자체에는 정보가 없고 사유는 같은 응답의 `message` 필드에 실려 있다.** host UI가 코드만
표시하면 그 문구가 화면에서 사라지므로, 0.3.3부터 relay는 같은 사유를
`%LOCALAPPDATA%\Arma-MCP\relay.log`에도 남긴다.

원인은 다음 중 하나다.

- **pre-0.3 서버가 게임 파이프를 점유** — 플러그인을 올리기 전에 열어둔 에이전트 세션이 구버전
  서버를 자식으로 붙들고 있다. 그 서버가 `\\.\pipe\arma_mcp`를 쥐고 있는 한 새 daemon은 뜨지 못한다.
  0.3.3부터 relay가 spawn 전에 이 상태를 판별해 조치와 함께 실패한다. 해당 세션을 닫거나 그
  node 프로세스를 종료한 뒤 다시 연결한다.
- 남이 5303을 쓰고 있다 / 다른 token으로 뜬 daemon이 있다
- `%LOCALAPPDATA%\Arma-MCP\daemon.log`에 기록된 daemon 기동 실패(잘못된 설정 등)
- 플러그인이 daemon보다 낮은 버전이다 → 그 컴퓨터의 플러그인을 업데이트한다
- 자동 기동이 억제돼 있다(`ARMA_MCP_NO_AUTOSTART` 또는 `ARMA_MCP_TOKEN`)

0.3.8부터 relay는 **세션이 한 번 선 뒤의 실패로는 죽지 않는다.** 데몬이 세션을 수확했으면
세션을 다시 세우고 그 요청을 재전송한 뒤 계속 서비스한다.
0.4.2 부터 재전송은 그 요청이 실행되지 않았다고 확실할 때만 한다. 데몬이 세션을 모르거나(404) 새 연결이 거절된(`ECONNREFUSED`) 경우다.
그 밖의 실패와 재전송마저 실패한 경우는 그 호출 하나만 `-32000`으로 답하고 다음 호출에서 다시 붙는다.
위 목록처럼 **세션이 아예 서지 못하는 경우**에만 relay가 사유를 답하고 종료한다.

2026-07-28 프로토콜을 아는 MCP 클라이언트는 `initialize` 전에 `server/discover` 로 먼저 떠본다.
0.4.3 이하 relay 는 이 요청을 데몬에 넘겼고, 데몬은 세션이 없어 400 `A valid MCP session ID or initialize request is required` 로 거절했다.
relay 는 이것을 세션이 서지 못한 실패로 보고 종료해, 클라이언트에는 `CONNECTION_CLOSED` 만 보였다.
`relay.log` 에는 `forwarding stdio` 바로 뒤에 그 400 두 줄이 남는다.
0.4.4 부터 relay 는 세션이 서기 전에 `initialize` 만 데몬에 보낸다.
나머지 요청에는 직접 답한다. `ping` 은 빈 결과, 그 밖은 `-32601` 이다. 이때 `answered server/discover before initialize` 줄이 남는다.

0.4.1 이하 relay 는 세션 중 daemon 이 사라지면 `connect ECONNREFUSED 127.0.0.1:5303` 로 계속 실패했다.
daemon 을 시작할 때만 확인했기 때문이다. 0.4.2 는 그 자리에서 daemon 을 다시 띄운다(위 [같은 컴퓨터의 Claude/Codex](#같은-컴퓨터의-claudecodex) 참고).
억제 신호가 있는 세션은 여전히 이 오류로 답한다. 서버 컴퓨터의 daemon 을 직접 올린다.

### 업그레이드 뒤 새 daemon 이 `cannot own pipe` 로 뜨지 못한다

`daemon.log` 에 `[gateway] cannot own pipe \\.\pipe\arma_mcp: already in use` 가 남는다.
옛 daemon 이 `/shutdown` 에 202 로 답하고 HTTP 포트는 닫았지만 프로세스가 파이프를 쥔 채 남은 경우다.
0.4.1 이하 daemon 은 진행 중 툴 호출이 남아 있으면 이렇게 남았다.
0.4.2 relay 는 이 프로세스를 강제로 끝내고(0.4.1 이하 daemon 은 3초 뒤, 0.4.2 이후는 8초 뒤) 파이프가 풀린 뒤에
새 daemon 을 띄우므로 보통은 다시 볼 일이 없다.
끝낼 프로세스를 집어내지 못해 파이프가 끝내 풀리지 않으면 relay 가 `still holds the game pipe` 로 답한다.
그러면 `/health` 의 `pid` 나 아래 명령으로 그 프로세스를 찾아 끝낸다.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*arma-mcp*index.mjs* daemon*' } |
  Select-Object ProcessId, CommandLine
```

### 유휴 후 또는 긴 툴 실행 중에 연결이 끊긴다

0.3.7 이하에서 나던 증상이다. `relay.log`에 다음 중 하나가 남는다.

- `daemon transport error: fetch failed` — 원인은 둘이다. ① 5분을 넘기는 툴 호출(`arma_rpt_wait`
  최대 10분, `arma_watch` 최대 303초)이 HTTP 클라이언트의 300초 기본 타임아웃에 걸렸다.
  ② 데몬이 유휴 keep-alive 소켓을 닫은 뒤(구버전은 Node 기본값 5초) relay가 그 소켓을 재사용했다.
- `A valid MCP session ID or initialize request is required` — relay가 initialize 응답으로 세션 ID를
  받기 전에 후속 메시지를 먼저 보냈다.

0.3.8이 셋 다 고쳤다. relay는 응답 대기에 타임아웃을 걸지 않고, 데몬의 keep-alive 수명은
`mcp.keepAliveTimeoutMs`(기본 65초)로 명시되며, 세션이 서기 전에는 메시지를 순서대로 보낸다.
남는 소켓 경계는 relay가 한 번 재시도해 흡수하고, 그때 `daemon closed an idle keep-alive socket`을
남긴다. 이 줄은 정상 복구 기록이지 장애가 아니다.

pre-0.3 점유 프로세스를 손으로 찾아 정리하려면 아래 명령을 쓴다.
`index.mjs` 뒤에 모드 인자가 없거나 `standalone` 인 프로세스만 잡는다.
`relay`, `daemon`, `cli`, `selfupdate`, `doctor` 프로세스는 잡지 않는다.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $cmd = [string]$_.CommandLine
    $at = $cmd.ToLower().IndexOf('index.mjs')
    $at -ge 0 -and $cmd.Substring(0, $at) -like '*arma-mcp*' -and
      $cmd.Substring($at + 9).TrimStart('"') -match '^\s*("?(--mode=)?standalone\b.*)?$'
  } |
  Select-Object ProcessId, CommandLine
# 확인 후: ... | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
[System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*arma*' }   # 비어야 한다
```

종료한 프로세스를 쓰던 다른 세션은 arma 툴을 잃는다. 그 세션에서 `/reload-plugins` 하면 새
daemon에 정상 합류한다.

daemon을 손으로 통제해야 하면 저장소 체크아웃이 없어도 플러그인 루트 안의 스크립트를 그대로 쓸 수 있다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$p\build\daemon.ps1" status
powershell -NoProfile -ExecutionPolicy Bypass -File "$p\build\daemon.ps1" restart
```

원격 관리 컴퓨터라면 SSH 터널을 열고 서버의 token을 환경변수로 준 뒤, 그 환경을 상속하는
셸에서 MCP client를 실행한다. `ARMA_MCP_TOKEN`은 token 파일보다 우선하며 UTF-8 32바이트 이상이어야 한다.

### 플러그인을 업데이트했다

보통은 자동으로 처리된다(위 [자동 업데이트](#자동-업데이트) 참고). 아래는 자동 업데이트를 껐거나,
오프라인이거나, pre-0.3 에서 올라오는 경우의 수동 절차다. 자동 업데이트를 쓰더라도 **설치는
백그라운드에서 끝나고 적용은 다음 세션부터**이므로, 이미 열려 있던 세션에 대한 아래 설명은 그대로 유효하다.

**열려 있는 모든 에이전트 세션에서 `/reload-plugins` 하거나 그 세션을 닫는다.** 0.3.x 끼리라면
새 relay가 구버전 daemon을 알아서 재시작하므로 그것만으로 끝난다. 그러나 **pre-0.3에서 올라오는
경우에는 반드시 필요하다** — 옛 세션이 붙들고 있는 구버전 서버가 게임 파이프를 쥐고 있으면 새
daemon이 아예 뜨지 못한다(위 `-32000` 절 참고).

버전 문자열이 같으면 host가 플러그인 캐시를 갱신하지 않을 수 있으니, 릴리스마다 버전을 올리고
캐시에 새 버전 폴더가 생겼는지 확인한다.

```powershell
Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json"   # version/gitCommitSha 확인
```

daemon 재시작은 이미 실행 중인 Arma 전용 서버를 종료하지 않는다. addon DLL이 백오프로 다시 붙는다.
같은 컴퓨터의 다른 host가 아직 구버전 relay를 쓰고 있다면 그 세션은 끊기며, 그 host의 플러그인을
업데이트하면 다시 붙는다.
