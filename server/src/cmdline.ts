// cmdline.ts — Windows 명령줄을 인자로 나눈다.
//
// relay 가 옛 데몬을 가려낼 때와 스택이 Arma 프로세스의 -profiles 를 읽을 때 같이 쓴다.
// 큰따옴표 묶음만 처리한다. node 와 Arma 가 받는 명령줄에는 그것으로 충분하다.

/** Windows 명령행을 인자로 나눈다. 큰따옴표는 묶음 표시로만 쓰고 결과에서 뺀다. */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}
