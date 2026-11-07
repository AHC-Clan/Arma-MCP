// armaImages.ts — Arma exe 이미지 이름 목록. 프로세스 탐지와 RPT 탐색이 같이 쓴다.
//
// 엔진은 RPT 파일 이름 앞에 exe 모듈 이름을 붙인다(Arma3_x64_2026-10-15_21-53-00.rpt).
// 그래서 프로파일링 exe 의 RPT 는 arma3profiling_x64_, arma3serverprofiling_x64_ 로 시작한다.
// 이미지를 이 목록에 더하면 rpt/rptFiles.ts 의 RPT 이름 규칙도 같이 넓어진다.

export const CLIENT_IMAGE = 'arma3_x64.exe';
export const SERVER_IMAGE = 'arma3server_x64.exe';

/**
 * 클라 RPT 를 남길 수 있는 이미지. RPT 탐색만 이 목록을 쓴다.
 * 클라 프로세스 탐지와 종료는 아직 CLIENT_IMAGE 하나만 본다.
 */
export const CLIENT_IMAGE_CANDIDATES: readonly string[] = [CLIENT_IMAGE, 'arma3profiling_x64.exe'];

// 데디 서버로 쓰일 수 있는 알려진 이미지명. 운영자가 프로파일링 빌드로 서버를 띄우는 경우가
// 있는데, 고정 이름 하나만 보면 "실행 중"을 놓쳐 launch 가드가 뚫리고 서버가 이중 실행된다.
// 탐지는 이 목록까지 넓히되, 종료는 실제로 실행 중이라고 확인된 이미지에만 한다 —
// 와일드카드 매칭으로 kill 하면 설정 실수 하나가 프로덕션 서버를 내린다.
export const SERVER_IMAGE_CANDIDATES: readonly string[] = [
  SERVER_IMAGE,
  'arma3serverprofiling_x64.exe',
  'arma3server.exe',
];

/** 이미지가 남기는 RPT 이름의 접두어. exe 모듈 이름, 곧 확장자를 뗀 이미지 이름이다. */
export function rptPrefixOf(image: string): string {
  return image.replace(/\.exe$/i, '');
}
