// errors.ts: CLI 종료 코드와 사람이 읽는 오류.
//
// 명령은 실패를 CliError 로 던지고 main 이 message 를 stderr 에 한 줄로 찍은 뒤
// exitCode 로 끝낸다. 셸에서 && 로 이어 쓰므로 종료 코드가 곧 계약이다.

export const EXIT = {
  ok: 0,
  /** 도구가 실패했거나 게임이 오류를 냈다. */
  failure: 1,
  /** 인자나 옵션이 틀렸다. */
  usage: 2,
  /**
   * 데몬에 붙지 못했거나 데몬이 명령 도중 멈췄다. 연결 거부, 401, 409 버전 차이, 429 상한,
   * 503 데몬 종료, 명령 도중 끊긴 연결이 모두 여기다.
   * 503 의 "may or may not have run" 과 도중 끊김은 명령이 게임에서 이미 돌았을 수 있다.
   */
  connection: 3,
  /** 다른 세션이 실행 lease 를 쥐고 있다. */
  busy: 4,
  /** 기다리던 것이 시간 안에 오지 않았다. */
  timeout: 5,
  internal: 70,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function usageError(message: string): CliError {
  return new CliError(EXIT.usage, message);
}
