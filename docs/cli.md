# arma-mcp CLI

`arma-mcp` 는 셸에서 이미 떠 있는 Arma-MCP 데몬에 붙어 도구를 부르는 명령이다.
명령마다 데몬에 `cli` 세션 하나를 열고, 도구를 부르고, 닫는다.
데몬을 띄우거나 재시작하거나 끄지 않는다. 게임 게이트웨이도 열지 않는다.

CLI 가 빨라지는 곳은 여러 단계를 셸 한 줄에 묶는 경우다.

- 알고 있는 단계를 잇는다. 예를 들면 kill, 빌드, play 를 한 줄에 둔다. exec 뒤에 wait 를 둔다.
- 2분 넘게 걸릴 수 있는 대기를 셸의 백그라운드 실행으로 돌린다.
- 큰 결과를 파일로 받고 필요한 부분만 읽는다.

도구 한 번으로 끝나는 호출은 MCP 도구가 낫다.
에이전트가 직접 봐야 하는 화면도 MCP 도구가 낫다. CLI 는 이미지를 파일로만 남긴다.

## 설치와 호출

플러그인 루트의 `bin/arma-mcp` 는 LF 셸 스크립트다.
같은 번들을 `cli` 모드로 실행한다.

```sh
node "<플러그인 루트>/server/bundle/index.mjs" cli "$@"
```

플러그인 루트는 설치한 호스트마다 다르다.

| 호스트 | 플러그인 루트 |
|---|---|
| Claude Code | `%USERPROFILE%\.claude\plugins\cache\ahc\arma-mcp\<버전>` |
| Codex | `%USERPROFILE%\.codex\plugins\cache\ahc\arma-mcp\<버전>` |

### Claude Code 의 Bash 도구

Claude Code 는 플러그인의 `bin` 폴더를 Bash 도구의 PATH 에 올린다.
그래서 Bash 도구에서는 이름만으로 부른다.

```sh
arma-mcp status
arma-mcp exec "count allUnits" --raw
```

PATH 에 오르는 `bin` 은 지금 세션의 플러그인 버전이다.
relay 가 데몬을 같은 버전으로 맞추므로 보통은 따로 맞출 것이 없다.

### PowerShell 과 Codex

Claude Code 의 PowerShell 도구 PATH 에는 플러그인 `bin` 이 없다.
이때는 번들을 node 로 직접 부른다. Codex 에서도 이 경로로 부른다.
`<버전>` 은 실행 중인 데몬과 같은 버전 폴더다. Codex 는 표의 `.codex` 루트를 쓴다.

```powershell
$arma = "$env:USERPROFILE\.claude\plugins\cache\ahc\arma-mcp\<버전>\server\bundle\index.mjs"
node $arma cli status
```

Windows PowerShell 5.1 에는 `&&` 가 없다. 앞 명령이 성공했을 때만 다음을 돌리려면 `$LASTEXITCODE` 를 본다.

```powershell
node $arma cli kill --unlock "D:\Mods\@my_mod"; if ($LASTEXITCODE -eq 0) { .\build.bat; if ($LASTEXITCODE -eq 0) { node $arma cli play dev } }
```

### 터널로 붙는 셸

Arma 가 없는 관리 컴퓨터에서는 [SSH 터널](daemon.md#원격-관리-컴퓨터)을 연 뒤 CLI 를 돌릴 셸에 값을 export 한다.
CLI 는 에이전트 세션과 같은 토큰과 설정을 써야 한다.

```sh
export ARMA_MCP_TOKEN='<서버 daemon.token 의 값>'
export ARMA_MCP_CONFIG='<에이전트 세션이 쓰는 설정 파일 경로>'
```

에이전트 세션이 기본 설정 파일(`%USERPROFILE%\.arma-mcp\config.json`)을 쓰면 `ARMA_MCP_CONFIG` 는 없어도 된다.
포트를 바꿨으면 `ARMA_MCP_DAEMON_PORT` 도 같은 값으로 준다.
`ARMA_MCP_TOKEN` 이 있으면 CLI 는 터널 연결로 보고 게임 기계 경로를 더 엄격하게 받는다([한계](#로컬-파일과-게임-기계-경로)).
`--token` 옵션은 없다. 명령줄은 프로세스 목록과 셸 기록에 남기 때문이다.

## 권한

Claude Code 에서는 `settings.json` 의 `permissions.allow` 에 규칙을 더하면 묻지 않고 돈다.

```json
{
  "permissions": {
    "allow": [
      "Bash(arma-mcp:*)",
      "mcp__plugin_arma-mcp_arma"
    ]
  }
}
```

- `Bash(arma-mcp:*)` 는 `arma-mcp` 로 시작하는 Bash 명령을 허용한다.
- `mcp__plugin_arma-mcp_arma` 는 이 플러그인의 MCP 도구를 모두 허용한다.
- `&&` 로 이은 줄은 조각마다 따로 검사한다. 재빌드 레시피를 묻지 않고 돌리려면 빌드 명령도 따로 허용한다.
- PowerShell 도구로 부르면 명령이 `node` 로 시작한다. node 전체를 허용하는 규칙은 범위가 넓어 권하지 않는다.

`Bash(arma-mcp:*)` 는 게임 프로세스를 끄고 켜는 `kill` 과 `play` 도 묻지 않고 돌린다.

## 명령

모든 명령이 `-h` 와 `--help` 를 받는다. `arma-mcp help exec` 도 같은 글을 찍는다.

`doctor` 를 뺀 모든 명령은 `--stack NAME` 을 받는다. 명령 이름 뒤 어디에 두어도 되고 `--stack=NAME` 도 된다.
그 [테스트 스택](tools.md#테스트-스택)의 게임에 도구를 부른다. 없으면 환경 변수 `ARMA_MCP_STACK` 을 쓰고,
그것도 없으면 default 스택이다. `call` 의 JSON 에 `stack` 이 있으면 그 값이 이긴다. `--` 뒤의 `--stack` 은 인자로 본다.
여러 스택이 떠 있으면 `status` 가 `stacks` 줄에 스택마다 포트, 게임 연결 단계, 프로세스 수를 찍고 고른 스택에 `*` 를 단다.

```
stacks   default(2302, live, 2 프로세스), *a(2312, live, 3 프로세스)
```
시간 값은 `1500`, `500ms`, `30s`, `1.5s`, `9m` 처럼 쓴다. 단위가 없으면 ms 다.
값이 `-` 로 시작하는 인자는 `--` 뒤에 둔다.

### status

```
arma-mcp status [--wait game|dedicated] [--timeout 90s] [--json]
```

`arma_status` 한 번을 몇 줄로 요약한다.

| 옵션 | 뜻 |
|---|---|
| `--wait game` | DLL 이 붙을 때까지 기다린다 |
| `--wait dedicated` | 데디 미션 브리지가 설 때까지 기다린다 |
| `--timeout 90s` | `--wait` 의 한도다. 기본 90s, 최대 10m 이다. `--wait` 없이 주면 사용법 오류다 |
| `--json` | 도구 JSON 을 한 줄로 찍는다 |

```
daemon   0.4.3, 가동 2시간 5분, 다른 세션 relay 2
game     live, Altis, co40_test, 브리지 준비됨
process  client 실행 중, server 꺼짐
lease    없음
profiles dev, mp_test
```

`다른 세션` 에는 이 명령이 연 cli 세션을 빼고 센다.
`lease` 줄은 실행 lease 를 쥔 작업과 그 주인 세션, 경과 시간이다.

### exec

```
arma-mcp exec CODE | -f FILE | -  [--mode server|all|client] [--target NAME] [--timeout 5s]
              [--rpt] [--verify EXPR] [--label TEXT] [--capture [--delay 250] [--shot FILE]]
              [--raw | --json] [--out FILE]
```

SQF 를 `arma_exec` 로 한 번 실행한다. 코드는 인자 하나, `-f FILE`, `-` 중 하나로 준다.
`-` 는 표준 입력에서 읽는다. 표준 입력이 터미널이면 읽지 않는다. 파일과 표준 입력의 BOM 은 벗긴다.

| 옵션 | 뜻 |
|---|---|
| `-f`, `--file FILE` | 로컬 파일에서 코드를 읽는다 |
| `--mode` | `server`(기본), `all`, `client` |
| `--target NAME` | `--mode client` 의 대상 플레이어다. client 모드에서는 꼭 준다 |
| `--timeout 5s` | 결과 대기다. 기본은 5s 이고 `all` 은 3s 다. 500ms 에서 10m 사이다 |
| `--rpt` | 성공한 실행도 실행 구간의 RPT 오류를 훑는다. RPT 커서를 stderr 에 `rpt: FILE:OFFSET` 으로 찍는다 |
| `--verify EXPR` | 실행 뒤 따로 평가할 증거식이다. server 모드에서만 쓴다 |
| `--label TEXT` | 인게임 감사 로그 라벨이다. 기본은 `cli` 다 |
| `--capture` | 실행 뒤 게임 화면을 찍어 파일로 쓰고 그 경로를 찍는다 |
| `--delay 250` | `--capture` 가 찍기 전에 기다리는 시간이다. 최대 10s 다 |
| `--shot FILE` | 이미지 경로다. 기본은 `%TEMP%\arma-mcp\shot-<reqId>.jpg` 다. `.jpg` 나 `.jpeg` 면 JPEG, `.png` 면 PNG 로 찍는다. 다른 확장자는 사용법 오류다 |
| `--raw` | 값만 찍는다. STRING 은 바깥 따옴표를 벗기고 SQF 의 `""` 를 `"` 로 되돌린다 |
| `--json` | 도구 JSON 을 한 줄로 찍는다. `rptSince` 에 `FILE:OFFSET` 을, `--capture` 면 `shot` 에 경로를 싣는다 |
| `--out FILE` | stdout 에 갈 출력을 파일에 쓰고 stdout 에는 그 절대 경로만 찍는다 |

`--raw` 와 `--json` 은 함께 쓰지 않는다. `--delay` 와 `--shot` 은 `--capture` 와 함께 쓴다.

기본 출력은 결과 줄이다. `mode all` 이면 줄마다 머신 이름이 붙는다.
`verify` 결과와 RPT 오류 블록 앞쪽 몇 줄이 뒤에 붙는다. 오류 사유와 안내는 stderr 로 간다.
`--raw` 에서는 nil, 오류, 잘림 안내, verify 결과가 stderr 로 간다.

### wait

```
arma-mcp wait rpt PATTERN [--source client|server] [--file NAME] [--since FILE:OFFSET]
arma-mcp wait game|dedicated
arma-mcp wait sqf COND [--sample EXPR] [--interval 250]
공통 옵션: [--timeout 100s] [--deadline D] [--json]
```

RPT 줄, 게임 연결, 게임 안 조건 중 하나를 기다린다. 시간 안에 오지 않으면 종료 코드 5 다.

| 종류 | 부르는 도구 | 기다리는 것 |
|---|---|---|
| `rpt PATTERN` | `arma_rpt_wait` | RPT 에 정규식이 맞는 줄. 대소문자는 가리지 않는다 |
| `game` | `arma_status` | DLL 연결 |
| `dedicated` | `arma_status` | 데디 미션 브리지 |
| `sqf COND` | `arma_watch` | 게임 안에서 COND 가 참이 되는 것 |

| 옵션 | 쓰는 종류 | 뜻 |
|---|---|---|
| `--source` | rpt | `client` 나 `server` 다. 기본은 라이브 데디 세션이면 server, 아니면 client 다 |
| `--file NAME` | rpt | RPT 파일 이름이나 절대 경로다. 기본은 가장 최근 파일이다 |
| `--since FILE:OFFSET` | rpt | 그 위치 뒤에서 찾는다. `--file` 과 함께 쓰지 않는다 |
| `--sample EXPR` | sqf | 매 틱 함께 기록할 식이다. 돌아온 값을 `samples` 줄에 찍는다. 최대 8개이고 넘치면 앞 7개와 마지막 값이다. 조건이 맞은 순간의 값이 마지막이다 |
| `--interval 250` | sqf | 평가 간격이다. 50ms 에서 5s 사이다 |
| `--timeout 100s` | 모두 | 대기 한도다. 기본 100s 다. rpt, game, dedicated 는 최대 10m, sqf 는 1s 에서 60m 사이다 |
| `--deadline D` | 모두 | 명령이 이 시간 안에 끝나야 한다. 한도에 여유 5초를 더해 넘으면 기다리지 않고 종료 코드 2 로 끝낸다 |
| `--json` | 모두 | 도구 JSON 을 한 줄로 찍는다 |

다른 종류의 옵션을 주면 사용법 오류다. 예를 들어 `wait game --sample` 은 종료 코드 2 다.

`--since` 가 없으면 파일 끝 64KB 에 이미 있는 줄도 찾는다. 그때는 stderr 에 대기 전 줄이라고 알린다.
새 줄만 기다리려면 `exec --rpt` 가 stderr 에 찍은 값이나 `exec --json` 의 `rptSince` 를 그대로 넘긴다.
애드온의 exec 감사 줄(`[ArmaMCP] [EXEC] ...`)에는 맞추지 않는다. 그 줄은 보낸 코드와 결과를 그대로 싣는다. 거기에 맞추면 코드 속 마커가 실제로 찍히기 전에 대기가 끝난다.

```sh
arma-mcp exec -f test/fire.sqf --rpt
# stderr: rpt: C:\Users\me\AppData\Local\Arma 3\Arma3_x64_2026-09-23_10-00-00.rpt:48213
arma-mcp wait rpt 'MYMOD.*impact' --since 'C:\Users\me\AppData\Local\Arma 3\Arma3_x64_2026-09-23_10-00-00.rpt:48213'
```

`wait sqf` 는 `arma_watch` 를 300초 조각으로 이어 부른다. 그래서 60분까지 기다릴 수 있다.
Ctrl+C 로 끊으면 게임 안의 루프에 정지 신호를 보낸 뒤 130 으로 끝낸다.
조건식이 오류를 내거나 다른 호출이 워치를 멈추면 종료 코드 1 이다.

```
met 3.2초, 13회
samples [0,12] ~ [4,0]
```

### kill

```
arma-mcp kill [all|client|server] [--unlock PATH]... [--wait 15s] [--preempt] [--json]
```

`arma_kill` 한 번으로 그 스택의 Arma 를 끝내고 프로세스가 사라질 때까지 기다린다. 기본 대상은 `all` 이다.
다른 스택의 게임은 끄지 않는다. 0.4 는 같은 이미지의 Arma 를 모두 껐다.

| 옵션 | 뜻 |
|---|---|
| `--unlock PATH` | 끝낸 뒤 이 파일이나 모드 폴더의 PBO, DLL 이 쓰기 가능해질 때까지 기다린다. 여러 번 준다. 32개까지다 |
| `--wait 15s` | 종료와 잠금 해제를 기다리는 한도다. 기본 15s, 최대 60s 다. `0` 이면 기다리지 않는다 |
| `--preempt` | 다른 세션의 launch 나 play 가 돌고 있어도 끊고 끝낸다 |
| `--json` | 도구 JSON 을 한 줄로 찍는다 |

MCP 도구 `arma_kill` 의 기본은 돌고 있는 작업을 끊는 것이다. CLI 는 늘 `preempt` 를 보낸다.
`--preempt` 가 없으면 `preempt:false` 다. 다른 세션의 작업이 lease 를 쥐고 있으면 끝내지 않고 종료 코드 4 로 멈춘다.

```
client   끝냈다, 1.8초
server   실행 중이 아니었다
unlock   D:\Mods\@my_mod 풀림, 420ms
```

```
다른 작업이 실행 lease 를 쥐고 있어 끝내지 않았다: arma_play, 주인 relay a1b2c3d4, 12초째.
그 작업이 끝난 뒤 다시 하거나 --preempt 로 끊는다.
```

### play

```
arma-mcp play [PROFILE] [--mode sp|mp] [--mission PATH] [--mod PATH]... [--mods-file FILE]
              [--modset rpt|none] [--test-mod PATH]... [--clients N] [--role ROLE]... [--kill] [--ready PATTERN] [--ready-source client|server]
              [--ready-timeout 60s] [--setup FILE] [--save NAME] [--dry-run] [--deadline D] [--json]
```

`arma_play` 한 번으로 게임을 띄워 인게임까지 들어간다.
준 옵션만 보낸다. 그래서 저장된 프로필은 준 옵션만 덮인다.

| 옵션 | 뜻 |
|---|---|
| `PROFILE` | 저장된 실행 프로필 이름이다 |
| `--mode` | `sp` 는 싱글이고 기본이다. `mp` 는 데디 서버와 클라이언트다 |
| `--mission PATH` | 언팩 미션 폴더다. 경로 구분자가 없는 이름은 현재 폴더에 그 폴더가 없으면 `missionsDir` 아래 이름으로 보낸다 |
| `--mod PATH` | 모드 폴더다. 여러 번 준다. 주면 프로필과 최근 RPT 의 모드 대신 그 모드만 쓴다 |
| `--mods-file FILE` | 모드 경로 목록 파일이다. 줄이나 `;` 로 나눈다. 빈 줄과 `#`, `//` 로 시작하는 줄은 건너뛴다. `-mod=` 접두어는 벗긴다 |
| `--modset` | `rpt` 는 최근 RPT 의 모드를 쓴다. `none` 은 모드 없이 띄운다. `--mod`, `--mods-file`, 모드가 저장된 프로필과는 함께 쓰지 않는다 |
| `--test-mod PATH` | 새로 빌드한 PBO, `addons` 가 있는 작은 모드 폴더, PBO 가 든 `addons` 폴더다. 여러 번 준다. 스택 전용 테스트 애드온으로 복사해 붙이므로 빌드 출력이 잠기지 않는다 |
| `--clients N` | mp 에서 로컬로 붙일 클라 수다. 기본은 `--role` 을 준 수이고, 그것도 없으면 1 이다. sp 와는 함께 쓰지 않는다 |
| `--role ROLE` | mp 에서 서버가 클라에게 배정할 역할이다. 여러 번 주면 클라 1, 2 순서다. 숫자만 있으면 역할 번호(로비 목록의 역할 순서, 진영을 가로질러 0부터)다. 그 밖은 유닛 변수 이름이 같은 빈 슬롯, 없으면 역할 설명에 대소문자 무시 부분 일치하는 빈 슬롯이다. `""` 와 `--role` 을 받지 못한 클라는 서버 기본 배정이다. `arma_play` 의 `roles` 로 간다. `--clients` 보다 많이 줄 수 없고 큰따옴표는 넣을 수 없다 |
| `--kill` | 이미 떠 있는 그 스택의 Arma 를 끝내고 띄운다 |
| `--ready PATTERN` | 인게임 뒤 이번 실행의 새 RPT 에서 이 정규식을 기다린다 |
| `--ready-source` | `client` 가 기본이다. `server` 는 mp 에서만 쓴다 |
| `--ready-timeout 60s` | ready 대기 한도다. 1s 에서 5m 사이다 |
| `--setup FILE` | ready 뒤에 실행할 로컬 SQF 파일이다. 호출할 때마다 새로 읽어 `then.code` 로 보낸다 |
| `--save NAME` | 인게임과 ready 가 성공하면 이 이름으로 프로필을 저장한다 |
| `--dry-run` | 띄우지 않고 인자만 계산한다. 미션 폴더는 실제로 만든다 |
| `--deadline D` | 이 시간 안에 돌아오도록 데몬의 대기 한도를 줄여 보낸다. 그래도 넘기면 호출을 끊는다 |
| `--json` | 도구 JSON 을 한 줄로 찍는다 |

`--mods-file` 의 항목이 먼저 오고 `--mod` 값이 그 뒤에 붙는다.
파일 안의 상대 경로는 그 파일이 있는 폴더 기준으로 푼다.

`--deadline` 에는 기본값이 없다. 주면 여유 5초를 먼저 뗀다. `--kill` 은 15초, `--setup` 은 10초를 더 뗀다.
남은 시간 안에 들어가도록 모드별 대기 단계와 ready 한도를 같은 비율로 줄인다. 남은 시간이 30초보다 짧으면 사용법 오류다.
그래도 넘기면 종료 코드 5 로 끝낸다. 이때 떠 있는 게임은 그대로 둔다.
프로필만 주고 `--deadline` 을 쓰면 CLI 가 이 기계의 프로필 파일에서 mode 와 ready 를 읽는다.
`--deadline` 이 ready 한도를 줄여야 하면 `--save` 와 함께 쓸 수 없다. 줄인 한도가 프로필에 남기 때문이다. 이때는 종료 코드 2 다.

```
play dev sp: in-game 34초 (VR, 14 mods, pid 1234)
ready "\[MYMOD\] ready" 800ms
rpt errors 0
then BOOL: true
```

mp 는 인게임 줄 다음에 클라마다 로비 자동 배정 결과를 한 줄로 적는다. 상태(`assigned`, `fallback`, `no-evidence`, `mission-lobby`) 뒤의 글자는 서버에서 읽은 그 클라의 실제 역할이다.
`--dry-run` 이면 상태 대신 지정(`auto`, `#<번호>`, 역할 글자)을 적는다. 자동 배정을 끈 실행은 이 줄이 없다.

```
play mp: in-game 2분 3초 (VR, 1 mods, pid 5678)
slot 1 assigned "OPFOR Rifleman", 2 assigned "Alpha Rifleman"
```

mp 의 rpt 줄은 `rpt errors client 0, server 2` 처럼 나온다. 경고와 실패 사유, 다음 조치는 stderr 로 간다.

### call

```
arma-mcp call TOOL [JSON | - | key=value...] [--json]
```

MCP 도구 하나를 부르고 결과 JSON 을 들여 써서 찍는다. `--json` 이면 한 줄로 찍는다.
인자는 JSON 객체 하나, 표준 입력(`-`), `key=value` 목록 중 하나로 준다.
`key=value` 의 값은 JSON 으로 읽히면 JSON 이고, 아니면 문자열이다.

```sh
arma-mcp call arma_mission_info
arma-mcp call arma_rpt_search pattern=MYDUMP maxMatches=200 contextLines=0
```

다음 도구는 부르지 않고 종료 코드 2 로 끝낸다.

- 프로세스를 바꾸는 도구: `arma_kill`, `arma_launch`, `arma_launch_mp`, `arma_launch_server`, `arma_play`. 보이는 `kill` 과 `play` 명령으로 부른다.
- 미션 파일을 만드는 `arma_scaffold_mission`. `play` 로 부른다.
- 플레이어나 LAN 에 보이는 `arma_web_*`, `arma_tacmap_*`. 에이전트 세션의 MCP 도구로 부른다.

이미지를 주는 도구는 이미지를 찍지 않고 stderr 에 개수만 알린다.

### doctor, help, --version

```
arma-mcp doctor
arma-mcp help [COMMAND]
arma-mcp --version
```

- `doctor` 는 게임 파이프, 데몬 포트, 토큰, 최근 `daemon.log` 와 `relay.log` 를 한 화면에 모은다. 데몬에 세션을 열지 않는다.
- `help` 는 명령 목록을 찍는다. 명령 이름을 붙이면 그 명령의 도움말을 찍는다.
- `--version` 은 CLI 버전을 찍는다. `-v` 와 `version` 도 같다.

## 출력과 종료 코드

- stdout 에는 명령 결과만 쓴다.
- 사람이 읽는 오류와 안내는 stderr 에 한 줄씩 쓴다.
- 진단 로그는 warn 수준으로 stderr 에 나간다. 더 보려면 `ARMA_MCP_LOG_LEVEL=debug` 를 준다. 로그 파일은 쓰지 않는다.

출력은 세 가지다.

| 모양 | 옵션 | 내용 |
|---|---|---|
| 사람이 읽는 몇 줄 | 기본 | 명령마다 위 예시 모양 |
| 값만 | `exec --raw` | 결과 값을 한 줄에 하나씩 |
| 도구 JSON 한 줄 | `--json` | 도구가 준 JSON 그대로. 명령에 따라 필드가 더 붙는다 |

`exec --json` 은 `rptSince` 와 `shot` 을 더한다. `wait sqf --json` 은 `slices` 와 `totalElapsedMs` 를 더한다.

종료 코드가 셸과의 계약이다. `&&` 로 이으면 성공했을 때만 다음 단계가 돈다.

| 코드 | 뜻 | 예 |
|---|---|---|
| 0 | 성공 | 결과가 왔다. 기다리던 것이 왔다 |
| 1 | 도구나 게임 실패 | exec 의 ERROR 결과, RPT 오류가 붙은 nil, 캡처 실패, kill 뒤 남은 프로세스, play 실패, 조건식 오류 |
| 2 | 사용법 오류 | 모르는 옵션, 잘못된 시간 값, call 이 거부한 도구, 풀 수 없는 경로 |
| 3 | 데몬 연결 문제 | 아무도 듣지 않음, 30초 안에 initialize 응답이 없음, 401 토큰 불일치, 409 버전 차이, 429 세션 상한, 503 데몬 종료 중, 명령 도중 끊긴 연결 |
| 4 | lease 사용 중 | 다른 세션의 launch 나 play 가 돌고 있다 |
| 5 | 대기 시간 초과 | wait 한도, `status --wait` 한도, play 의 `--deadline` |
| 70 | 내부 오류 | CLI 버그다. stderr 줄을 이슈에 붙인다 |
| 130 | 중단 | Ctrl+C 나 SIGTERM. 두 번째 신호나 3초 뒤에는 곧바로 끝낸다 |

- exec 가 결과 없이 시간을 넘기면 5 가 아니라 1 이다. 하드 SQF 오류로 스크립트가 죽었을 수 있기 때문이다.
- RPT 오류 블록이 없는 nil 은 정상 nil 로 보고 0 이다. stderr 에 안내가 한 줄 붙는다.
- 종료 코드 3 의 stderr 에는 고치는 방법이 함께 온다. 셸 샌드박스가 127.0.0.1 연결을 막아도 3 이다.
- 종료 코드 3 이 늘 명령이 돌지 않았다는 뜻은 아니다. 503 의 `the tool may or may not have run` 과 명령 도중 끊긴 연결은 명령이 게임에서 이미 돌았을 수 있다. 다시 실행하기 전에 읽기 전용 exec 나 RPT 로 게임 상태를 확인한다.

## 레시피

### 재빌드 한 줄

처음 한 번은 프로필을 저장한다.

```sh
arma-mcp play --mission D:/Missions/test.VR --mods-file mods.txt --ready '\[MYMOD\] ready' --save dev
```

그 뒤로는 고칠 때마다 한 줄로 돌린다.

```sh
arma-mcp kill --unlock D:/Mods/@my_mod && ./build.sh && arma-mcp play dev --setup test/setup.sqf
```

- `kill --unlock` 은 게임이 끝나고 모드 폴더의 PBO 가 쓰기 가능해질 때까지 기다린다. 따로 기다리는 루프가 필요 없다.
- 빌드 명령(`./build.sh`)은 저장소에 맞게 바꾼다. 빌드가 실패하면 play 는 돌지 않는다.
- `--setup` 파일은 호출마다 새로 읽힌다. 셋업 코드를 고쳐도 같은 줄을 다시 돌리면 된다.
- 셋업 코드 끝에는 `; true` 처럼 값을 둔다. nil 결과는 관계없는 RPT 오류 블록에도 실패로 잡힌다.
- 이 줄은 종료 대기, 빌드, 부팅, 준비 마커까지 2분을 넘기기 쉽다. 셸 도구에 시간 한도가 있으면 백그라운드 실행으로 돌리고, 끝난 뒤 출력과 종료 코드를 읽는다.
- 시간 상한이 꼭 필요하면 `play --deadline` 을 준다.

### 다른 스택이 도는 동안 시험하기

다른 에이전트가 default 스택의 게임을 쓰고 있으면 자기 스택 이름으로 띄운다. 공유 기본 모드는 다시 빌드하지 않고
새로 빌드한 것만 `--test-mod` 로 넘긴다. 게임은 복사본을 잠그므로 빌드를 다시 돌려도 잠금 오류가 없다.

```sh
export ARMA_MCP_STACK=a
./build.sh && arma-mcp play --mode mp --clients 2 --test-mod ./.hemttout/build --kill
arma-mcp exec 'count allPlayers'
arma-mcp kill
```

- `kill` 은 스택 `a` 의 서버와 클라만 끈다. default 스택의 게임은 남는다.
- 다 쓴 스택은 MCP 도구 `arma_kill { stack:"a", forget:true }` 로 지운다. CLI 의 `call` 은 `arma_kill` 을 부르지 않는다.

### exec 뒤에 게임 안 조건 기다리기

```sh
arma-mcp exec -f test/arm.sqf && arma-mcp wait sqf "!isNil 'X_done'" --sample X_result --timeout 60s
```

- exec 가 실패하면 wait 는 돌지 않는다.
- 조건이 참이 되면 0, 60초 안에 안 되면 5 다.
- `--sample` 은 조건이 안 맞을 때 원인을 보는 값이다. 돌아온 값이 `samples` 줄에 찍힌다.

### 결과를 파일로 받기

```sh
arma-mcp exec "str (getPosATL player)" --raw --out out/pos.txt
arma-mcp exec -f test/scenario.sqf --json --out out/scenario.json
arma-mcp call arma_rpt_search pattern=MYDUMP maxMatches=200 contextLines=0 > out/dump.json
```

- `--out` 을 주면 stdout 에는 파일의 절대 경로만 찍힌다. 에이전트는 필요한 부분만 읽는다.
- `--json --out` 은 RPT 오류 블록까지 담은 전체 결과를 남긴다.
- 게임 안 결과는 500자에서 잘린다. 더 긴 데이터는 SQF 에서 `diag_log` 로 RPT 에 쓰고 `call arma_rpt_search` 로 받는다.

### 다른 세션이 띄운 게임 기다리기

```sh
arma-mcp wait dedicated --timeout 3m && arma-mcp exec "count allPlayers"
```

## 한계

### 이미지는 파일로만 남는다

`exec --capture` 는 이미지를 파일에 쓰고 그 경로를 찍는다. 에이전트는 그 파일을 따로 읽어야 화면을 본다.
화면을 보고 판단해야 하면 MCP 도구 `arma_exec` 의 `capture` 나 `arma_capture` 를 쓴다. 같은 호출 안에 이미지가 온다.

### 게임 안 결과는 500자에서 잘린다

애드온이 결과 문자열을 500자에서 자르고 끝에 ` ...(truncated)` 를 붙인다.
`--raw` 는 잘린 값을 찍고 stderr 에 잘렸다고 알린다. 긴 데이터는 RPT 로 받는다.

### 로컬 파일과 게임 기계 경로

경로 플래그는 두 종류다.

| 종류 | 플래그 | 읽고 쓰는 곳 |
|---|---|---|
| 로컬 파일 | `-f`, `--setup`, `--shot`, `--out`, `--mods-file` | CLI 를 돌리는 셸의 기계 |
| 게임 기계 경로 | `--mission`, `--mod`, `--unlock`, `--mods-file` 안의 항목 | 데몬과 게임이 도는 기계 |

- 같은 기계에서 돌면 두 종류 모두 절대 경로로 바꿔 보낸다. 상대 경로는 셸의 현재 폴더 기준이다. `--mods-file` 안의 항목은 그 파일의 폴더 기준이다.
- `wait rpt --file` 과 `--since` 의 파일은 경로 플래그가 아니다. RPT 파일 이름이나 게임 기계의 절대 경로이고, 셸 기준으로 풀지 않고 그대로 보낸다. 이름만 주면 데몬이 RPT 폴더에서 찾는다.
- Git Bash 의 `/d/x` 는 위 플래그 모두에서 `D:\x` 로 바꾼다.
- `bin/arma-mcp` 는 Git Bash 의 인자 변환을 끈다([따옴표](#따옴표)). 그래서 `/tmp` 처럼 드라이브로 바꿀 수 없는 `/` 경로는 바뀌지 않고 들어온다. CLI 는 이런 경로를 거부하고 `cygpath -w` 를 안내한다. `mktemp` 가 준 경로도 같다.
- 터널로 붙으면 게임 기계 경로는 `D:\...` 나 `/d/...` 같은 절대 경로로 준다. 상대 경로는 종료 코드 2 다.
- 이름만 준 `--mission` 은 터널에서도 그대로 보낸다. 데몬이 `missionsDir` 아래에서 찾는다.
- 터널에서는 프로필 파일이 게임 기계에 있어 CLI 가 읽지 못한다. 그래서 `PROFILE` 과 `--modset` 을 함께 쓸 수 없다. `PROFILE` 과 `--deadline` 을 함께 쓰려면 `--mode` 를 준다.

### 터널에서는 재빌드 레시피가 뜻이 없다

빌드는 이 셸의 기계에서 돌고 kill 과 play 는 게임 기계에서 돈다.
여기서 만든 PBO 는 게임 기계의 모드 폴더로 가지 않는다. 재빌드 한 줄은 게임 기계의 셸에서 돌린다.

### 따옴표

- 셸 인자로 넘기는 SQF 의 문자열은 작은따옴표로 쓴다. 예를 들면 `"!isNil 'X_done'"` 이다. SQF 는 두 따옴표를 모두 받는다.
- Windows PowerShell 5.1 은 네이티브 프로그램에 넘기는 인자 안의 큰따옴표를 지운다. SQF 문자열을 큰따옴표로 쓰면 코드가 깨진다.
- 사람이 대화형 Bash 에 칠 때는 큰따옴표 안의 `!` 가 기록 확장으로 풀린다. 그때는 인자 전체를 작은따옴표로 감싸고 SQF 문자열은 큰따옴표로 쓴다.
- PowerShell 에서는 `call` 의 JSON 인자도 같은 이유로 깨진다. `key=value` 나 `-` 로 넘긴다.
- 여러 줄이거나 두 따옴표가 다 필요한 코드는 `-f FILE` 이나 `-` 로 넘긴다.
- `bin/arma-mcp` 는 Git Bash 의 인자 변환을 끈다(`MSYS2_ARG_CONV_EXCL='*'`). 켜 두면 `/` 로 시작하는 값을 경로로 바꾼다. 예를 들어 `pattern=/foo` 는 `pattern=C:/Program Files/Git/foo` 가 되고 `'^/ahc'` 는 `^C:/Program Files/Git/ahc` 가 된다.
- 그래서 SQF, 정규식, `call` 의 `key=value` 는 쓴 그대로 간다. `call` 에 넘기는 경로 값도 바꾸지 않는다. 그런 값은 `C:\...` 모양으로 준다.

```sh
arma-mcp exec - <<'SQF'
private _n = count allUnits;
format ["units %1", _n]
SQF
```

### 세션과 버전

- 명령마다 세션을 새로 연다. 그래서 `since:'lastExec'` 가 명령 사이에 이어지지 않는다. `exec --rpt` 의 커서를 `wait rpt --since` 로 넘긴다.
- 동시에 열 수 있는 cli 세션은 `mcp.maxCliSessions`(기본 8)개다. 넘치면 종료 코드 3 이고 stderr 에 그 설정 이름이 나온다.
- CLI 와 데몬은 버전이 같아야 한다. 다르면 종료 코드 3 이다. 플러그인을 업데이트한 직후라면 에이전트 세션을 새로 열어 relay 가 데몬을 맞추게 한다.
- 아무도 데몬 포트를 듣지 않으면 종료 코드 3 이다. CLI 는 데몬을 띄우지 않는다. 에이전트 세션의 MCP 연결을 열면 relay 가 띄운다.
- 명령 도중 데몬이 멈추면 종료 코드 3 이다. stderr 에 데몬 문구가 그대로 온다. `this request was not run` 이면 도구는 돌지 않았다. `the tool may or may not have run` 이면 돌았을 수 있다. CLI 는 그 명령을 다시 보내지 않는다. 돌았을 수 있으면 stderr 도 다시 실행하라고 하지 않고 게임 상태부터 확인하라고 안내한다.
- CLI 가 응답을 받기 전에 죽으면 데몬이 그 세션을 닫는다. 진행 중인 exec, 대기, lease 가 함께 풀린다. 떠 있는 게임은 그대로 남는다.
- `wait sqf` 를 Ctrl+C 가 아니라 프로세스 종료로 끊으면 게임 안의 루프는 그 조각의 한도(최대 300초)까지 돈다.
