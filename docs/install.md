# 설치와 연결

## 준비물

| 항목 | 설명 |
|---|---|
| Windows | 브리지 DLL 이 Windows 전용이다 |
| Arma 3 | 브리지 모드를 켜고 BattlEye 없이 시작한다 |
| Claude Code 또는 Codex | 둘 다 있으면 둘 다 연결할 수 있다 |
| Node.js | 플러그인이 `node` 로 돈다 |
| Git | 플러그인을 저장소에서 받을 때 쓴다 |

## 브리지 모드

메인 화면의 연결 단추와 게임 안 SQF 실행은 브리지 모드가 맡는다.

1. [최신 릴리스](https://github.com/AHC-Clan/Arma-MCP/releases/latest)에서 `arma-mcp-mod-<버전>.zip` 을 받아 압축을 푼다.
2. 나온 `@arma_mcp` 폴더를 Arma 3 Launcher 의 로컬 모드로 추가하고 켠다.
3. BattlEye 를 끄고 게임을 시작한다. BattlEye 가 켜져 있으면 브리지 DLL 이 불리지 않는다.

플러그인을 업데이트해도 모드는 그대로다. 메이저와 마이너 버전이 같으면 함께 쓸 수 있다. 소스에서 만들려면 [개발 문서](development.md#브리지)를 본다.

## 메인 화면에서 연결

1. 메인 화면 오른쪽 아래 SITREP 위의 **AI 에이전트 연결** 을 누른다.
2. **연결** 을 누른다. 이 PC 에 있는 앱에 플러그인을 설치한다.
3. 앱에서 새 대화를 연다. 이미 열어 둔 대화에는 적용되지 않는다.

해제도 같은 창에서 한다. 플러그인만 지우고 마켓플레이스 등록은 남긴다. 다시 연결하면 그 등록을 쓴다.
이미 `ahc` 마켓플레이스를 다른 주소로 등록했다면 그 등록을 그대로 쓴다.

창이 무엇을 실행하는지와 호출 제한은 [프로토콜 문서](protocol.md#메인-화면-연결-명령)에 있다.

## 명령어로 설치

Claude Code 와 Codex 는 같은 마켓플레이스 `.claude-plugin/marketplace.json` 을 쓰고, 각자 전용 매니페스트에서 같은 `server/bundle/index.mjs relay` 를 실행한다.
쓰는 앱의 절차 하나만 따르면 같은 Arma 도구가 등록된다.

### Claude Code

```bash
claude plugin marketplace add https://github.com/AHC-Clan/Arma-MCP.git
claude plugin install arma-mcp@ahc
```

앱 안에서는 `/plugin marketplace add` 와 `/plugin install` 로 같은 일을 한다.
로컬 클론을 설치하려면 저장소 루트에서 주소 대신 `.` 을 준다.

확인은 `/plugin list` 로 한다. 열어 둔 세션에 반영하려면 `/reload-plugins` 를 부른다.

### Codex

```bash
codex plugin marketplace add https://github.com/AHC-Clan/Arma-MCP.git
codex plugin add arma-mcp@ahc
```

로컬 클론을 설치하려면 저장소 루트에서 주소 대신 `.` 을 준다.

확인은 `codex plugin list` 로 한다. 설치하거나 업데이트한 플러그인의 도구는 새 대화에서 보인다.

### 중복 등록

같은 `ahc` 마켓플레이스를 원격 주소와 로컬 경로로 함께 등록하지 않는다.
같은 앱에 플러그인과 수동 MCP 설정을 함께 켜면 같은 도구가 두 번 보인다.

플러그인 설치는 저장소를 받기만 하고 빌드하지 않는다. MCP 서버는 의존성까지 묶은 파일 하나 `server/bundle/index.mjs` 로 커밋되어 있어 `node` 만 있으면 돈다.

## 자동 업데이트

세션이 시작될 때마다 새 버전을 백그라운드로 확인하고, 있으면 조용히 설치해 둔다.
현재 세션은 그대로 돌고 다음 세션부터 적용된다. 확인 간격은 기본 6시간이고, 실패해도 세션을 막지 않는다.

- 끄기: `ARMA_MCP_NO_AUTOUPDATE=1`
- 간격 조정: `ARMA_MCP_AUTOUPDATE_COOLDOWN_H`
- 지금 확인: `node <플러그인 루트>/server/bundle/index.mjs selfupdate check --root <플러그인 루트> --cli claude`

저장소를 직접 클론해 쓰는 개발 체크아웃은 작업 트리를 건드리지 않도록 제외된다.
자세한 동작은 [데몬 문서](daemon.md)의 "자동 업데이트" 절에 있다.

### 마켓플레이스 주소가 바뀌었을 때

자동 업데이트는 등록을 대신 고치지 않는다. 안내가 뜨면 직접 다시 등록한다.
마켓플레이스를 지우면 플러그인도 지워지므로 다시 설치까지 한다.

```powershell
claude plugin marketplace remove ahc
claude plugin marketplace add https://github.com/AHC-Clan/Arma-MCP.git
claude plugin install arma-mcp@ahc
```

## 플러그인 없이 등록

Codex 는 `~/.codex/config.toml` 에서 번들을 직접 가리킬 수 있다.

```toml
[mcp_servers.arma]
command = "node"
args = ["C:\\path\\to\\Arma-MCP\\server\\bundle\\index.mjs", "relay"]
env = { ARMA_MCP_TOKEN = "replace-with-daemon-token" }
```

## Arma 가 없는 다른 PC 에서 쓰기

평문 LAN 포트를 열지 않고 SSH 로컬 포워딩을 쓴다.

```powershell
ssh -N -L 5303:127.0.0.1:5303 user@arma-server
$env:ARMA_MCP_TOKEN = '<서버의 daemon.token 값>'
```

그 PC 의 릴레이는 터널의 `http://127.0.0.1:5303/mcp` 로 접속한다.
`ARMA_MCP_TOKEN` 이 있으면 릴레이는 로컬 데몬을 띄우지 않는다.
서버 컴퓨터에서 도는 릴레이는 같은 계정의 토큰 파일을 자동으로 읽는다.

## 연결이 안 될 때

릴레이가 사유를 MCP 오류 메시지로 돌려주고 `%LOCALAPPDATA%\Arma-MCP\relay.log` 에도 남긴다.
메인 화면 연결 창의 기록은 같은 폴더의 `connect.log` 에 있다.
원인과 조치를 한 번에 보려면 진단 모드를 쓴다.

```powershell
node server\bundle\index.mjs doctor
```

자세한 내용은 [데몬 문서의 문제 해결](daemon.md#문제-해결)에 있다.
