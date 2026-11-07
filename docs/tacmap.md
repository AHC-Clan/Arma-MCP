# AHC_TacticalMap 연동 레퍼런스

Arma-MCP가 별도 모드 **AHC_TacticalMap**(이하 TacMap)을 구동하는 방법과, 이 레포가 미러하는 크로스 레포 계약.

> **호출 조건이 먼저다 — 이 툴들은 게임 중인 전원에게 보이는 방송이다.**
> `arma_tacmap_subtitle` / `_mark` / `_open` 은 사용자가 "게임에 띄워라/알려라"라고 명시했을 때만 부른다.
> 지시 확인, 진행 보고, 작업 완료 알림, 질문에 대한 답변은 **툴 결과 텍스트로만** 한다 —
> 인게임 자막으로 대답하면 플레이 흐름을 끊는다. 문구는 `server/src/mcp/broadcastPolicy.ts` 가 단일 출처다.

> **두 번째 — 전술지도 화면을 특정 좌표로 포커스하는 SQF/WS API는 존재하지 않는다.**
> 전술지도는 브라우저 페이지(Leaflet)이고 포커싱은 브라우저 UI 동작(항공 상태창 행 클릭)뿐이다.
> "전술지도에 이 위치 띄워줘"의 실행 가능한 최선은 **그 좌표에 마커를 만드는 것**(`arma_tacmap_mark`)이며,
> 뷰어의 시점을 옮길 수는 없다. 에이전트는 이 한계를 사용자에게 그대로 전달해야 한다.

---

## 1. 아키텍처

| 구성 | 정체 |
|---|---|
| 전술지도 | **브라우저 페이지**(Leaflet). 웹페이지·WebSocket·게임 데이터 수신을 모두 포트 **8088** 하나로 처리 |
| 게임 애드온 | 데이터 익스포터 + 인바운드 렌더러. CfgPatches `AHC_TacticalMap`, 함수 태그 `AHC_TacticalMap` |
| 확장 | `ahc_tacmap` (named pipe `\\.\pipe\ahc_tacmap`) — Arma-MCP의 `arma_mcp` 파이프와 완전히 별개 |
| 의존성 | `requiredAddons[] = {"cba_main"}`. `AHC_ZeusTool`은 선택(사운드·색 프리셋만) |

TacMap CfgPatches에는 **`version` 항목이 없다.** 버전을 읽으려 하면 `""`/`0`이 나오므로 시도하지 않는다.

TacMap 자신의 `docs/MISSION_AUTHORING.md`는 **로컬 개발 PC 경로의 정본을 Arma-MCP(`arma_exec`)로 선언**하고
REST `POST /api/admin/exec`을 원격 서버 전용으로 유보한다. 본 문서는 그 계약의 Arma-MCP 측 대응물이다.

---

## 2. 감지

`fn_hasTacMap.sqf`가 서버에서 `isClass (configFile >> "CfgPatches" >> "AHC_TacticalMap")`을 캐시하고,
`fn_pushSession.sqf`가 sessionInfo에 실어 보낸다(`docs/protocol.md` 참조).

| 필드 | 노출 위치 | 의미 |
|---|---|---|
| `tacmap` | `arma_status`, `arma_mission_info` | TacMap 로드 여부 |
| `tacmapZeusTool` | `arma_status`, `arma_mission_info` | `AHC_ZeusTool` 로드 여부 — **자막 동작이 아니라 무전 사운드 유무만** 결정 |

두 필드는 `true` / `false` / **`null`(미상)** 3-state다. `null`은 구버전 `@arma_mcp` PBO가 필드를 보내지 않은
경우이며, **툴은 이를 하드 게이트로 쓰지 않는다.** 최종 판정은 언제나 조립 SQF 안의
`isNil "AHC_TacticalMap_fnc_..."` 가드가 내린다 — sessionInfo는 힌트·note용이다.

---

## 3. 툴 3종

`docs/tools.md`의 「AHC_TacticalMap 연동 툴」 절에 입출력 표가 있다. 요약:

| 툴 | 하는 일 | TacMap 경로 |
|---|---|---|
| `arma_tacmap_subtitle` | 무전 자막(전체/진영/개인) | `AHC_TacticalMap_fnc_cheatZeusTitle` 또는 `CBA_fnc_targetEvent` |
| `arma_tacmap_mark` | 지도 마커 표시/삭제(+선택적 지휘관 핑) | 바닐라 마커 + `fn_cheatPing` + `fn_cheatResync` |
| `arma_tacmap_open` | 웹 전술지도 페이지를 플레이어 브라우저에 열기 | CBA 설정 프로브 + `arma_web_open` 인프라 재사용 |

세 툴 모두 **와이어 프로토콜을 바꾸지 않는다.** 서버가 조립한 SQF를 기존 `exec` 프레임으로
`mode: 'server'` 전송할 뿐이다(`arma_web_open` → `fn_openUrl`과 같은 구조).

### 조립 SQF의 3대 규칙

1. **주석 금지.** exec 경로는 `compile`만 하고 preprocess하지 않는다. `//` 하나가 남으면 코드 전체가
   조용히 `<nil>`로 파손되고 부작용도 실행되지 않는다.
2. **문자열 ack로 끝난다.** TacMap 치트는 **전부 반환값이 없다.** 검증 표현식이 없으면 성공이
   `<nil>`과 구분되지 않는다. 이 레포의 조립 SQF는 항상 `"OK:..."` / `"ERR:..."`를 돌려준다.
3. **관측 기반 검증.** 조용한 게이트(좌석·쿨다운)에 걸린 호출은 예외도 로그도 남기지 않으므로,
   호출 전후의 관측값(예: `ahc_ping_*` 마커 수)을 비교해 실효 여부를 판정한다.

---

## 4. 치트 카탈로그 (전체 27종)

툴이 감싸지 않는 기능은 `arma_exec { "mode": "server", "code": "[...] call AHC_TacticalMap_fnc_cheat<Name>; true" }`
로 직접 호출한다. **파라미터는 전부 위치 인자**이며 아래 순서·기본값은 TacMap 0.1.0.0의
`fn_cheat*.sqf` `params [...]` 줄을 그대로 미러한 것이다.

**모든 핸들러는 `if (!isServer) exitWith {}` 이고 반환값이 없다.** 반드시 코드 끝에 검증 표현식을 붙일 것.

| 레지스트리 | `AHC_TacticalMap_fnc_…` | 위치 파라미터(기본값) | 좌석 | 쿨다운 |
|---|---|---|:---:|:---:|
| `setTime` | `cheatSetTime` | `hour=12, minute=0` | – | – |
| `setWeather` | `cheatWeather` | `overcast=0.5, rain=0, fog=0, transition=5` | – | – |
| `setInvuln` | `cheatInvuln` | `playerName="", on=0` | – | – |
| `setFaction` | `cheatFaction` | `playerName="", sideTag="WEST"` | – | – |
| `showTitle` | `cheatTitle` | `text="", effect="PLAIN DOWN", target="", duration=4, color="#ffffff", size=1` | – | – |
| `sayChat` | `cheatSayChat` | `who="", text=""` | – | – |
| `resync` | `cheatResync` | *(없음)* | – | – |
| `uavDeploy` | `cheatUavDeploy` | `x=0, y=0, alt=500, radius=500, dirCW=1, ttl=600, class="", sensor=1800` | ✔ | – |
| `uavRecall` | `cheatUavRecall` | `uavId=""` | – | – |
| `uavUpdate` | `cheatUavUpdate` | `uavId="", alt=-1, radius=-1, dir=0` | ✔ | – |
| `uavRelocate` | `cheatUavRelocate` | `uavId="", x=0, y=0` | ✔ | – |
| `heliDeploy` | `cheatHeliDeploy` | `sx=0, sy=0, ax=0, ay=0, bx=0, by=0, wantClass=""` | ✔ | – |
| `heliRecall` | `cheatHeliRecall` | `heliId=""` | – | – |
| `heliTakeoff` | `cheatHeliTakeoff` | `heliId=""` | – | – |
| `heliReassignLz` | `cheatHeliReassignLz` | `heliId="", x=0, y=0` | ✔ | – |
| `ping` | `cheatPing` | `x=0, y=0, type="move", side=""` | ✔ | 1.5 s |
| `pingClear` | `cheatPingClear` | *(없음)* | ✔ | – |
| `supplyDrop` | `cheatSupplyDrop` | `x=0, y=0, crate="", mode="arsenal"` | ✔ | 5 s |
| `vehicleDrop` | `cheatVehicleDrop` | `x=0, y=0, veh="", count=1` | ✔ | 10 s |
| `taskCreate` | `cheatTaskCreate` | `taskId="", side="", title="", desc="", x=0, y=0` | ✔ | – |
| `taskSetState` | `cheatTaskSetState` | `taskId="", state=""` | ✔ | – |
| `artillery` | `cheatArtillery` | `x=0, y=0, rounds=6, spread=50` | ✔ | 5 s |
| `triggerZone` | `cheatTriggerZone` | `id="", varName="", shape="", data=[]` | – | – |
| `triggerZoneDelete` | `cheatTriggerZoneDelete` | `id=""` | – | – |
| `zeusTitle` | `cheatZeusTitle` | `name="", text="", color="yellow"` | – | – |
| `randomPick` | `cheatRandomPick` | `pool=[]` | – | – |
| `execScript` | `cheatExecScript` | `mode="server", target="", code="", label=""` | – | – |

### 값 제약

- `ping.type` — `rally`(집결) / `move`(이동, 기본) / `attack`(공격) / `warn`(주의) / `recon`(정찰). 알 수 없으면 `move`.
- `ping.side`, `taskCreate.side` — `""`(전체) / `WEST` / `EAST` / `GUER` / `CIV`.
- `showTitle.effect` — `PLAIN DOWN` / `PLAIN` / `BLACK IN` / `BLACK OUT` / `DYNAMIC`(색·크기·시간은 DYNAMIC 전용).
- `taskSetState.state` — `Succeeded` / `Failed` / `Canceled` / `Assigned` / `Created`.
- `artillery` — rounds는 1..12, spread는 10..200 m로 **핸들러가 클램프**한다.
- `vehicleDrop` — count는 1..3으로 클램프, Air 클래스는 거부(항공기는 uav/heliDeploy 담당).
- `uavUpdate` — alt·radius는 `-1`, dir은 `0`이 "변경 없음". dir `1`=시계, `-1`=반시계.
- `uavDeploy` — alt는 선회 고도(AGL m), radius는 선회 반경(m), ttl은 자동 복귀까지의 초, sensor는 경사 탐지 거리(m).
- `triggerZone.shape`/`data` — `circle`=`[x,y,r]`, `rect`=`[x,y,a,b,angleDeg]`(**a/b는 반축**), `poly`=`[[x,y],...]`.
- `sayChat` — 전 클라이언트 `systemChat`으로 `[웹] <who>: <text>` 형태. 웹에서 200자 클램프.

### ⚠ `execScript`는 쓰지 말 것

`cheatExecScript`는 TacMap의 **웹 관리자 SQF 콘솔**(서버 RCE)이다. Arma-MCP에서 임의 SQF를 실행할
때는 반드시 `arma_exec`를 쓴다 — 주석 제거, 128 KiB 상한, `reqId` 상관, RPT 오류 자동 첨부,
세션별 커서, 세션 취소 같은 이 레포의 안전장치가 전부 붙는 유일한 경로다.

---

## 5. 조용한 게이트

### 5.1 지휘관 좌석 (12종)

`AHC_TacticalMap_commander`가 nil이거나 `""`면 아래 12종은 **조용히 exitWith** 한다 — 예외도, 반환값도,
클라이언트 반응도 없다. 에이전트가 "실행했다"고 잘못 보고하는 가장 흔한 원인이다.

```
artillery  heliDeploy  heliReassignLz  ping  pingClear  supplyDrop
taskCreate taskSetState uavDeploy      uavRelocate uavUpdate vehicleDrop
```

좌석은 웹(Node)이 단일 진실 소스인 **서버 로컬 미러 변수**로, `fn_onCommander.sqf`에서만 기록되고
게임→웹 역방향 프레임이 없다. 그래서 `arma_tacmap_mark`의 `commanderOverride`는

1. 좌석이 **비어 있을 때만** `"mcp-agent"`로 임시 점유하고,
2. 치트 호출 **직후** 원래 값으로 되돌린다(`fn_execRun`이 unscheduled `call`로 실행하므로 한 프레임 내 원자적).

**실제 지휘관이 앉아 있으면 절대 빼앗지 않는다.** 그리고 **쿨다운은 우회하지 못한다.**

### 5.2 서버측 쿨다운 (4종)

| 치트 | 변수 | 창 |
|---|---|---|
| `ping` | `AHC_TacticalMap_lastPing` | 1.5 s |
| `artillery` | `AHC_TacticalMap_lastArty` | 5 s |
| `supplyDrop` | `AHC_TacticalMap_lastSupply` | 5 s |
| `vehicleDrop` | `AHC_TacticalMap_lastVehicleDrop` | 10 s |

역시 조용히 exitWith 한다. `arma_tacmap_mark`는 호출 전후의 `ahc_ping_*` 마커 수를 비교해
`ping.status = "no-effect"`로 구분해 준다.

---

## 6. ⚠ ZeusTool 게이트 정정

TacMap의 `docs/ADMIN.md`는 무전 자막에 대해 *"AHC_ZeusTool 미설치 서버에서는 호출해도 아무 일도
일어나지 않습니다"* 라고 적는다. **이것은 웹 UI 경로에 한정된 서술이다.**

- `fn_cheatRegistry.sqf`의 `isClass (configFile >> "CfgPatches" >> "AHC_ZeusTool")` 검사는
  **웹 디스패처(`fn_onCheat`의 해시맵)에 이름 `zeusTitle`/`randomPick`을 등록할지만** 결정한다.
- `AHC_TacticalMap_fnc_cheatZeusTitle`은 CfgFunctions가 **무조건 컴파일**하므로 직접 호출은 항상 동작한다.
- 클라이언트 렌더러 `AHC_TacticalMap_zeusTitle`(`fn_initClient.sqf`)도 **무조건 등록**된다
  (레이어 911, y=0.85, 7초, 구조화 텍스트 이스케이프 포함).
- ZeusTool이 없을 때 실제로 빠지는 것은 **`PH_radio_on` / `PH_radio_off` 사운드뿐**이다.

즉 **Arma-MCP 경로(`arma_tacmap_subtitle`)는 웹 UI 경로보다 엄밀히 더 유능하다.**
`arma_status`의 `tacmapZeusTool`이 `false`면 툴이 응답 note로 사운드 부재를 명시한다.

### 색 프리셋

`fn_cheatZeusTitle.sqf`의 매핑 테이블(서버가 TS에서 같은 값으로 미러한다 — `side`/`players` 타게팅
경로는 `cheatZeusTitle`을 거치지 않으므로 두 경로의 색을 맞추려면 필요하다):

| 토큰 | hex |
|---|---|
| `red` | `#FF0000` |
| `green` | `#1DDB16` |
| `blue` | `#0054FF` |
| `yellow` | `#FFE400` (기본) |
| `hq` | `#0054FF` |
| `enemy` | `#FF0000` |

그 외 값은 `#rrggbb`로만 허용한다(TacMap은 알 수 없는 값을 그대로 통과시키지만, 이 레포는 거부한다).

---

## 7. 마커 이름 규약

`fn_gatherMarkers.sqf`는 **모든** 게임 마커를 주기적으로(`AHC_TacticalMap_markerInterval`, 기본 5초)
웹 지도로 수집한다. 단 아래 프리픽스는 예외다.

| 프리픽스 | 왜 쓰면 안 되는가 |
|---|---|
| `ahc_web_` | 웹에서 그린 것 — 수집에서 **스킵**(에코 루프 방지). 웹 지도에 안 뜬다 |
| `ahc_text_` | 웹 텍스트 마커 — 동일 |
| `ahc_heli` | 헬기 경로가 별도 프레임으로 emit — 동일 |
| `ahc_ping_` | 수집은 되지만 `fn_cheatPingClear`가 **일괄 삭제**한다(남의 수명주기에 얽힘) |

**Arma-MCP는 `mcp_mark_*`만 쓴다.** `arma_tacmap_mark`의 `id`는 `[a-z0-9_-]`로 새니타이즈되어
`mcp_mark_<id>`가 되고, 생략하면 `mcp_mark_<세션ID>_<seq>`가 된다.
`action: "clearAll"`은 **`mcp_mark_*`만** 지운다 — TacMap 마커나 미션 마커는 건드리지 않는다.

웹 반영 지연은 `resync`(기본 `true`)가 `cheatResync`(좌석 게이트 없음)를 호출해 없앤다.
`resync: false`면 최대 `markerInterval`초 지연된다.

---

## 8. 크로스 레포 계약

TacMap은 이 레포에 들어 있지 않은 별도 프로젝트다.
위 카탈로그는 **TacMap 0.1.0.0**(HEMTT `project.toml` 기준; CfgPatches에는 `version` 없음)의 미러다.

### 드리프트 방지 장치

- 모든 조립 SQF가 `if (isNil "AHC_TacticalMap_fnc_...") exitWith {"ERR:tacmap-absent"};`로 시작한다 →
  TacMap이 함수 이름을 바꾸면 조용한 `<nil>`이 아니라 **명시적 오류**로 드러난다.
- 툴은 sessionInfo를 하드 게이트로 쓰지 않는다 → PBO 버전이 어긋나도 기능이 막히지 않는다.
- `arma_tacmap_mark`는 TacMap이 없어도 바닐라 마커로 우아하게 축퇴한다(인게임 지도에만 표시).

### 갱신 절차

1. 좌석 게이트 목록 재확인
   ```powershell
   Select-String -Path <TacMap 저장소>\addon\addons\tacmap\functions\fn_cheat*.sqf `
     -Pattern 'AHC_TacticalMap_commander isEqualTo ""' -List | Select-Object -Expand Filename
   ```
2. 위치 파라미터 재확인 — 각 `fn_cheat*.sqf`의 `params [...]` 줄과 4절 표를 대조.
3. 쿨다운 재확인 — `time - AHC_TacticalMap_last* <` 패턴.
4. 4·5절 표를 갱신하고, 색 프리셋이 바뀌었으면 `server/src/mcp/tools/tacmap.ts`의 `ZEUS_COLORS`도 함께.
   (`server/test/tacmapTool.test.ts`가 프리셋과 마커 프리픽스 규약을 고정하고 있다.)
