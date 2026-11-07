# 기능

도구마다의 인자와 결과는 [도구 레퍼런스](tools.md)에 있다.

## 게임 실행

| 기능 | 도구 | 설명 |
|---|---|---|
| 한 번에 인게임 진입 | `arma_play` | 미션 준비, 실행, 접속, 로비 슬롯, 인게임 확인까지 한 흐름이다. 싱글과 멀티 모두 된다 |
| 게임 실행과 종료 | `arma_launch`, `arma_kill` | 최근 모드셋을 다시 쓰고 미션을 자동으로 불러온다 |
| 멀티플레이 시험 | `arma_launch_mp` | 전용 서버를 미션, 모드셋과 함께 띄우고 클라이언트를 로비까지 접속시킨다. `server.cfg` 와 MPMissions 배치도 자동이다 |
| 클라이언트 없는 전용 서버 | `arma_launch_server` | 미션을 자동으로 시작하고 브리지 준비까지 확인한다 |
| 시험 미션 즉석 생성 | `arma_scaffold_mission` | 어떤 맵이든 빈 씬이나 셋업 씬을 만들어 바로 불러온다. 물 위나 공중에서 시작하면 육지 지면으로 옮긴다 |
| 시험 스택 동시 실행 | 모든 게임 도구의 `stack` | 한 PC 에서 스택마다 서버 1대와 클라이언트 여러 대를 따로 띄운다. 새로 빌드한 PBO 는 `testMods` 로 복사본을 실어 빌드 출력이 잠기지 않는다. [자세히](tools.md#테스트-스택) |

## 게임 안 작업

| 기능 | 도구 | 설명 |
|---|---|---|
| SQF 실행 | `arma_exec` | 서버, 전체, 특정 클라이언트에서 실행하고 결과를 모은다. 주석은 자동으로 지운다 |
| 미션 정보 | `arma_mission_info`, `arma_status` | 맵, 미션, 플레이어, 시간, fps 와 CBA, ACE, 전술지도 로드 여부를 본다 |
| Zeus | `arma_zeus_find`, `arma_zeus_module` | Zeus 화면의 이름으로 대상을 찾고, 모듈을 Zeus 배치와 같은 경로로 실행한다 |

## 결과 확인

| 기능 | 도구 | 설명 |
|---|---|---|
| RPT 로그 | `arma_rpt_read`, `arma_rpt_search`, `arma_rpt_errors`, `arma_rpt_wait` | 읽기, 검색, 오류 블록, 패턴 대기를 한다 |
| 화면 캡처 | `arma_capture` | 게임 창을 이미지로 돌려준다. 메인 화면과 로딩처럼 SQF 를 못 쓰는 상태에서도 된다 |
| 조건 대기 | `arma_watch` | 게임 안 조건이 찰 때까지 기다린다 |

## 공유

| 기능 | 도구 | 설명 |
|---|---|---|
| 웹 게시 | `arma_web_publish`, `arma_web_open` | 에이전트가 만든 HTML 을 게시하고, 다시 게시하면 열린 브라우저가 함께 새로 고친다. [설정](configuration.md#웹-게시) |
| 여러 세션 동시 연결 | 데몬 | 세션마다 독립 MCP 세션을 만들고 게임 브리지와 런타임은 하나를 함께 쓴다 |

## 사용 흐름

싱글플레이:

```
arma_launch { mission, killRunning: true }
arma_rpt_wait { file: "next", pattern: "\\[ArmaMCP\\].*server bridge" }
arma_status                       # dllConnected: true 확인
arma_exec { code: "1 + 1" }       # -> SCALAR: 2
arma_mission_info                 # 맵, 미션, 플레이어
```

전용 서버와 클라이언트 자동 접속:

```
arma_launch_mp { mission, killRunning: true }   # 서버 실행, 클라이언트 접속, 로비까지 자동
# 사람이 슬롯을 고르면 미션이 시작된다
arma_status                       # dllConnected: true, dedicated 확인
arma_exec { code: "count allPlayers" }
arma_rpt_read { source: "server" }
arma_kill { target: "all" }
```

클라이언트 없이 서버 컴퓨터에서 미션 자동 시작:

```
arma_launch_server { mission, killRunning: true }
arma_status { waitFor: "dedicated", timeoutMs: 120000 }
arma_exec { code: "1 + 1", mode: "server" }
arma_rpt_read { source: "auto" }
```

브리지는 활성 미션의 postInit 뒤에 연결된다. 로비에만 있으면 RPT 와 프로세스 진단은 되지만 SQF 는 실행할 수 없다.
플레이어가 0명이어도 시작된 전용 서버 미션의 서버 SQF 와 텔레메트리는 동작한다.

셸 한 줄에서 종료, 빌드, 실행을 잇는 방법은 [CLI 안내](cli.md)에 있다.
