# 설정

설정 파일 없이도 돈다. 다른 설치본을 쓰거나 기본값을 바꿀 때만 적는다.

| 항목 | 설정이 없을 때 | 확인 |
|---|---|---|
| Arma 실행 파일 | Steam 레지스트리와 `libraryfolders.vdf` 에서 찾는다 | `arma_status` 의 `config.exeSource` |
| 전용 서버 실행 파일 | `exePath` 옆의 `arma3server_x64.exe` | `config.serverExePath` |
| 브리지 모드 경로 | 사람이 띄운 게임이 메인 화면에서 알려 준 폴더 | `config.selfModSource` |
| RPT 폴더 | `%LOCALAPPDATA%\Arma 3` | `config.rptDir` |

`arma_exec`, `arma_rpt_*`, `arma_status`, `arma_mission_info` 는 설정 없이 동작한다.

## 설정 파일 위치

다음 순서로 찾는다.

1. `ARMA_MCP_CONFIG` 환경 변수
2. `%USERPROFILE%\.arma-mcp\config.json`. 플러그인을 업데이트해도 남으므로 이 자리를 권한다
3. 저장소의 `arma-mcp.config.json`. 개발용이다

```powershell
mkdir "$env:USERPROFILE\.arma-mcp"
copy arma-mcp.config.example.json "$env:USERPROFILE\.arma-mcp\config.json"
```

항목 전체는 [`arma-mcp.config.example.json`](../arma-mcp.config.example.json) 에 있다.
멀티플레이는 `mp` 블록(포트, 비밀번호, profiles 경로)을 쓰고 모두 기본값이 있다.

데몬 운영은 [데몬 문서](daemon.md)에 있다. 데몬은 릴레이가 자동으로 띄우고 항상 `127.0.0.1:5303` 에만 바인딩한다.

## 웹 게시

에이전트가 만든 브리핑이나 미션 정보 HTML 을 내장 웹 서버에 게시한다. 다시 게시하면 열린 브라우저가 SSE 로 함께 새로 고친다.
파일은 `~/.arma-mcp/web` 에 쌓인다.

```
arma_web_publish { "page": "brief", "html": "<html>...</html>" }
arma_web_publish { "page": "brief", "html": "<html>v2</html>" }
```

| 설정 | 동작 |
|---|---|
| `web.host: "127.0.0.1"` (기본) | 이 PC 에서만 열린다. 방화벽 확인 창이 뜨지 않고 멀티플레이 자동 오픈은 하지 않는다 |
| `web.host: "0.0.0.0"` | LAN 에 열린다. 첫 게시 때 모든 플레이어의 기본 브라우저를 연다 |
| `web.enabled: false` | 기능을 끈다 |

- `0.0.0.0` 은 믿을 수 있는 LAN 에서만 쓴다. 인증이 없으므로 인터넷에 노출하지 않는다.
- 자동 오픈은 브리지 모드가 있는 PC 에서만 동작한다. 모드가 없는 클라이언트에는 주소를 따로 알려 준다.
- 주소는 LAN IP 를 찾아 만든다. 가상 네트워크 카드를 잘못 고르면 `web.publicBaseUrl` 로 지정한다.
