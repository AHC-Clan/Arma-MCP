# 개발

저장소 규칙의 정본은 [`AGENTS.md`](../AGENTS.md) 이다.

## 구조

```
Claude/Codex ─ stdio ─ relay ─┐
원격 MCP ─ SSH 터널 ─ HTTP ───┼─ 공유 daemon (Streamable HTTP, 세션별 MCP 서버)
다른 세션 ─ stdio ─ relay ────┘       │
                                      │ named pipe \\.\pipe\arma_mcp
                                 arma_mcp_x64.dll
                                      │ callExtension, ExtensionCallback
                                 @arma_mcp SQF 애드온
```

공유 데몬이 게임 파이프의 서버이고, DLL 이 미션을 불러올 때 클라이언트로 접속한다.
MCP 세션을 닫아도 데몬과 게임 연결은 유지된다. 데몬을 끄거나 미션이 끝나야 파이프가 끊긴다.
DLL 은 서버가 없으면 250ms 에서 시작해 두 배씩 늘려 5초까지 기다리며 다시 접속한다.
프로토콜 전체는 [프로토콜 문서](protocol.md)에 있다.

| 단계 | 내용 | 설치 |
|---|---|---|
| MCP 클라이언트 어댑터 | Arma 도구를 앱에 등록하고 데몬으로 중계한다 | 플러그인 설치로 끝난다 |
| 공유 데몬 | 게임 파이프, 텔레메트리, 런처를 한 번만 소유하고 여러 세션을 받는다 | 첫 연결 때 릴레이가 띄운다. 구버전이면 새 버전으로 바꾼다. 수동 운영은 [데몬 문서](daemon.md) |
| 인게임 브리지 | `arma_mcp_x64.dll` 과 PBO 로 게임 안에서 SQF 를 실행한다 | 모드에 들어 있다 |

브리지가 없어도 `arma_rpt_*` 와 `arma_launch`, `arma_kill` 은 동작한다. `arma_exec` 와 `arma_mission_info` 는 브리지가 접속해야 결과가 온다.

| 경로 | 내용 |
|---|---|
| `.claude-plugin/plugin.json` | Claude Code 용 MCP 실행 어댑터 |
| `.codex-plugin/plugin.json` | Codex 용 MCP 실행 어댑터와 표시 정보 |
| `.claude-plugin/marketplace.json` | 두 앱이 함께 쓰는 마켓플레이스 |
| `server/` | TypeScript MCP 서버. 배포물은 `bundle/index.mjs` |
| `extension/` | C++ 확장 DLL |
| `addon/` | SQF 애드온과 메인 화면 연결 창. CBA 는 선택이다 |
| `build/` | 빌드, 배포, 공개 스크립트 |
| `docs/` | 사용자 안내와 데몬, 프로토콜, 도구, 시험 문서 |

## 서버

```powershell
cd server
npm install
npm run build                  # tsc, 개발용 dist
npm run bundle                 # esbuild, 플러그인이 실행하는 bundle/index.mjs
node dist/index.js daemon      # 공유 런타임
node dist/index.js relay       # stdio 어댑터. 보통 플러그인이 실행한다
npm test                       # 단위 테스트
npm run smoke                  # 가짜 DLL 로 도는 E2E
```

서버 코드를 바꾸면 커밋 전에 `npm run bundle` 로 번들을 갱신한다. 플러그인은 이 번들을 실행한다.

이 저장소에서 서버를 개발할 때는 `copy .mcp.json.example .mcp.json` 뒤 경로를 고친다. `.mcp.json` 은 커밋하지 않는다.

매니페스트는 실행 경로만 잇는 얇은 어댑터다. 도구 이름, 스키마, 결과 형식과 런타임 로직은 `server/src` 에만 둔다.

## 브리지

Windows 와 MSVC(VS 2019 이상 C++ 도구)가 필요하다.

```powershell
powershell build\get-hemtt.ps1                 # hemtt.exe 준비, 처음 한 번
powershell build\test-cpp.ps1                  # C++ 단위 시험과 DLL, Node 루프백
powershell build\build-all.ps1                 # DLL 둘, PBO, dist\release\@AHC_ArmaMCP 조립
```

DLL 은 두 개를 만든다. `arma_mcp_x64.dll` 은 `arma3_x64.exe` 용이고, `arma_mcp.dll` 은 `arma3.exe` 용이다. 32비트 쪽은 Steam Workshop 게시 요건이라 늘 함께 만든다.

`dist\release\@AHC_ArmaMCP` 를 `-mod` 로 실으면 브리지가 돈다. Arma 를 켠 동안에는 DLL 이 잠긴다.
Workshop 에 올리려면 두 DLL 외에 서명된 PBO 가 필요하다. 저장소 스크립트는 서명하지 않는다.

## 릴리스

1. 매니페스트, 마켓플레이스, 서버 패키지, 애드온, DLL, 프로토콜 예시의 버전을 함께 올린다.
2. 서버, C++, 번들을 다시 빌드하고 시험한다.
3. `build\publish-github.ps1` 로 공개 저장소에 올린다.
4. DLL 이나 애드온 코드가 바뀌었으면 `dist\release\arma-mcp-mod-<버전>.zip` 을 GitHub 릴리스에 올린다.

공개 저장소는 자체 기록을 쓴다. 스크립트가 커밋된 트리를 커밋 하나로 올리고, 버전을 올리지 않은 공개는 거절한다.

## 알아 둘 점

- **SQF 주석**: 게임 안 실행 경로는 `compile` 만 하고 전처리를 하지 않아 주석이 코드를 조용히 `<nil>` 로 망가뜨린다. 서버가 보내기 전에 문자열을 가려 주석을 지운다. `comments:'reject'` 로 거부할 수도 있다.
- **`<nil>`**: 정상 nil 이거나 엔진이 삼킨 오류다. `arma_exec` 는 이때 실행 구간 RPT 의 `Error in expression` 블록을 `rptErrors` 로 붙인다. 판단은 RPT 로 한다.
- **메인 화면 SQF**: 미션이 없어 함수를 `uiNamespace` 에서 읽고, `spawn` 대신 화면 이벤트로 돈다.
