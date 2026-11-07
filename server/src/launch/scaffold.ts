// scaffold.ts — 최소 테스트 미션을 즉석에서 생성한다.
//
// 월드(terrain)는 미션 폴더의 확장자(<name>.<world>)로 결정된다. mission.sqm 은
// 월드 무관하게 "West 그룹 1개 + 플레이어 유닛 1개"만 있으면 로드된다.
//
// 범용 도구 원칙: 생성 산출물에 특정 조직 브랜딩(AHC 등)이나 특정 맵 전제를 넣지 않는다.
// world 는 완전 가변(VR 은 편의 기본값), author/이름/기본 마커는 중립("mcp_test", "arma-mcp").
//
// 좌표와 스폰 보정은 safeSpawn.ts 가 맡는다. position 은 SQF getPos 순서
// [동, 북, 높이] 로 받고, mission.sqm 의 [동, 고도, 북] 순서로는 거기서 한 번만 바꾼다.

import { writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  buildInitSqf,
  normalizePosition,
  type PositionPlan,
  type SafeSpawnMode,
} from './safeSpawn.js';
import { sqfNumber } from '../mcp/sqfLiteral.js';

export interface ScaffoldOptions {
  world?: string; // terrain 클래스명(폴더 확장자). 기본 'VR'. 어떤 terrain 도 허용.
  name?: string; // 미션/폴더 기본명. 기본 'mcp_test'.
  playerType?: string; // 플레이어 유닛 클래스. 기본 'B_Soldier_F'(바닐라).
  // 플레이어 위치 [동, 북] 또는 [동, 북, 높이]. SQF getPos 와 같은 순서다.
  // mission.sqm 의 [동, 고도, 북] 이 아니다 — safeSpawn.ts 가 변환한다.
  position?: readonly number[];
  safeSpawn?: SafeSpawnMode; // 바다와 공중 스폰 보정. 기본 'land'.
  initSqf?: string; // init.sqf 내용(엔진이 preprocess — 주석 OK). 미지정 시 중립 마커.
  targetDir?: string; // <name>.<world> 를 생성할 상위 디렉토리.
  overwrite?: boolean; // 기존 폴더 덮어쓰기. 기본 true.
  // 플레이 가능한 슬롯 수. 기본 1. 한 스택에 클라를 여럿 붙일 때 그 수만큼 만든다.
  slots?: number;
}

export interface ScaffoldResult {
  missionPath: string;
  world: string;
  name: string;
  files: string[];
  safeSpawn: SafeSpawnMode;
  position: { requested: [number, number, number]; sqm: [number, number, number] };
  warnings: string[];
}

/** 기본 스캐폴드 상위 디렉토리: missionsDir 설정 없으면 ~/.arma-mcp/missions. */
export function defaultScaffoldDir(missionsDir?: string): string {
  if (missionsDir) return missionsDir;
  return path.join(homedir(), '.arma-mcp', 'missions');
}

// 미션 폴더/파일명에 안전한 이름으로 정규화(공백·구분자 제거).
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'mcp_test';
}

// world 문자열도 폴더 확장자로 안전하게(영숫자/언더스코어).
function sanitizeWorld(world: string): string {
  const cleaned = world.replace(/[^A-Za-z0-9_]+/g, '');
  return cleaned || 'VR';
}

/** 슬롯 사이 간격(m). 여러 클라가 한 점에 겹쳐 서지 않게 동쪽으로 벌린다. */
export const SLOT_SPACING_M = 3;
/** 둘째 슬롯부터 붙는 유닛 변수 이름의 접두어. 스폰 보정이 순번을 여기서 읽는다. */
export const SLOT_VAR_PREFIX = 'mcp_slot_';

function buildUnitItem(index: number, playerType: string, sqmPos: [number, number, number], slots: number): string {
  // 부동소수 잔여물(0.30000000000000004)과 지수 표기가 파일에 새지 않게 고정 소수로 찍는다.
  const [x, y, z] = [sqmPos[0] + SLOT_SPACING_M * index, sqmPos[1], sqmPos[2]].map(sqfNumber);
  // 슬롯이 하나면 0.4 와 같은 파일을 만든다. 여럿이면 이름으로 순번을 남긴다.
  const nameLine = slots > 1 ? `\n\t\t\t\t\t\tname="${SLOT_VAR_PREFIX}${index}";` : '';
  const isPlayer = index === 0 ? '\n\t\t\t\t\t\tisPlayer=1;' : '';
  return `				class Item${index}
				{
					dataType="Object";
					class PositionInfo
					{
						position[]={${x},${y},${z}};
					};
					side="West";
					flags=7;
					class Attributes
					{${isPlayer}${nameLine}
						isPlayable=1;
					};
					id=${index + 1};
					type="${playerType}";
				};`;
}

// sqmPos 는 이미 mission.sqm 순서 [동, 고도, 북] 이다. 여기서 순서를 바꾸지 않는다.
// 변환은 safeSpawn.ts 의 normalizePosition 이 한 번만 한다.
function buildMissionSqm(
  name: string,
  playerType: string,
  sqmPos: [number, number, number],
  slots = 1,
): string {
  const units = Array.from({ length: slots }, (_, i) =>
    buildUnitItem(i, playerType, sqmPos, slots),
  ).join('\n');
  // 최소 텍스트 mission.sqm — 1 West 그룹 + 플레이어 슬롯. 브랜딩 없음.
  return `version=54;
binarizationWanted=0;
sourceName="${name}";
addons[]=
{
	"A3_Characters_F"
};
class AddonsMetaData
{
	class List
	{
		items=1;
		class Item0
		{
			className="A3_Characters_F";
			name="Arma 3 Alpha - Characters and Clothing";
			author="Bohemia Interactive";
			url="https://www.arma3.com";
		};
	};
};
randomSeed=1;
class ScenarioData
{
	author="arma-mcp";
};
class Mission
{
	class Intel
	{
		startWeather=0;
		startWind=0.1;
		startFog=0;
		year=2035;
		month=6;
		day=24;
		hour=12;
		minute=0;
	};
	class Entities
	{
		items=1;
		class Item0
		{
			dataType="Group";
			side="West";
			class Entities
			{
				items=${slots};
${units}
			};
			class Attributes
			{
			};
			id=0;
		};
	};
};
`;
}

function buildDescriptionExt(name: string): string {
  // 브리핑/디브리핑을 건너뛰어 init 이 즉시 실행되게(자동 테스트용). 중립 author.
  return `author = "arma-mcp";
onLoadName = "${name}";
onLoadMission = "arma-mcp scaffolded test mission";
briefing = 0;
debriefing = 0;
respawn = 2;
respawnDelay = 3;
respawnOnStart = -1;

// 브리핑 화면을 건너뛰어 미션이 바로 시작되도록.
class Params {};
`;
}

/**
 * 최소 테스트 미션을 <targetDir>/<name>.<world>/ 에 생성한다.
 * 반환: 생성된 미션 폴더의 절대경로 등.
 */
export function scaffoldMission(opts: ScaffoldOptions): ScaffoldResult {
  const world = sanitizeWorld(opts.world ?? 'VR');
  const name = sanitizeName(opts.name ?? 'mcp_test');
  const playerType = (opts.playerType ?? 'B_Soldier_F').trim() || 'B_Soldier_F';
  const safeSpawn: SafeSpawnMode = opts.safeSpawn ?? 'land';
  // 좌표 검증은 스테이징 디렉토리를 만들기 전에 끝낸다. 거부된 호출이
  // 임시 폴더를 남기지 않게 하기 위해서다.
  const plan: PositionPlan = normalizePosition(opts.position, { world, safeSpawn });
  const baseDir = opts.targetDir ?? defaultScaffoldDir();
  const overwrite = opts.overwrite ?? true;
  const slots = Math.max(1, Math.min(16, Math.floor(opts.slots ?? 1)));

  const resolvedBaseDir = path.resolve(baseDir);
  const missionPath = path.join(resolvedBaseDir, `${name}.${world}`);
  if (path.dirname(missionPath) !== resolvedBaseDir) {
    throw new Error('refusing to scaffold outside targetDir');
  }

  if (existsSync(missionPath)) {
    if (!overwrite) {
      throw new Error(`mission dir already exists: ${missionPath} (overwrite=false)`);
    }
  }
  mkdirSync(resolvedBaseDir, { recursive: true });
  const stagingPath = path.join(
    resolvedBaseDir,
    `.${name}.${world}.arma-mcp-tmp-${process.pid}-${Date.now()}-${nextStagingId++}`,
  );
  mkdirSync(stagingPath, { recursive: false });

  const initSqf =
    typeof opts.initSqf === 'string' && opts.initSqf.length > 0
      ? opts.initSqf
      : 'diag_log "arma-mcp: scaffold init";\n';

  const files: string[] = [];
  const write = (rel: string, content: string): void => {
    const full = path.join(stagingPath, rel);
    // init.sqf/description.ext/mission.sqm 모두 UTF-8(BOM 없이). 엔진이 UTF-8 로 읽는다.
    writeFileSync(full, content, 'utf8');
    files.push(rel);
  };

  try {
    write('mission.sqm', buildMissionSqm(name, playerType, plan.sqm, slots));
    write('description.ext', buildDescriptionExt(name));
    write('init.sqf', buildInitSqf(initSqf, { mode: safeSpawn, want: plan.wantXY, slots }));
    if (existsSync(missionPath)) rmSync(missionPath, { recursive: true, force: true });
    renameSync(stagingPath, missionPath);
  } catch (error) {
    if (existsSync(stagingPath)) rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }

  return {
    missionPath,
    world,
    name,
    files,
    safeSpawn,
    position: { requested: plan.requested, sqm: plan.sqm },
    warnings: plan.warnings,
  };
}

let nextStagingId = 1;
