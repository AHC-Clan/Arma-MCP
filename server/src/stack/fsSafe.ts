// fsSafe.ts — 스택 폴더를 지울 때 원본 모드를 건드리지 않게 하는 도우미.
//
// 오버레이는 기본 모드 파일의 하드링크다. 하드링크 이름을 지워도 원본은 남는다.
// 링크(심볼릭 링크, 정션)는 오버레이가 만들지 않지만, 누가 넣었더라도 따라 들어가지 않고
// 링크 자체만 지운다. 지울 경로는 반드시 정해 둔 상위 폴더 안이어야 한다.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

function normalize(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** child 가 parent 아래(같은 경로 제외)에 있는지. */
export function isStrictlyInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + '/');
}

/**
 * target 을 지운다. 링크는 따라가지 않고 링크만 지운다.
 * target 이 mustBeUnder 안이 아니면 아무것도 지우지 않고 던진다. 없는 경로는 조용히 넘어간다.
 */
export async function removeTreeNoFollow(target: string, mustBeUnder: string): Promise<void> {
  if (!isStrictlyInside(target, mustBeUnder)) {
    throw new Error(`지울 경로가 ${mustBeUnder} 밖이다: ${target}`);
  }
  await removeEntry(path.resolve(target));
}

async function removeEntry(entry: string): Promise<void> {
  let st;
  try {
    st = await fsp.lstat(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    // Windows 에서 디렉터리 링크와 정션은 rmdir 로, 파일 링크는 unlink 로 지운다.
    await fsp.unlink(entry).catch(async () => fsp.rmdir(entry));
    return;
  }
  if (st.isDirectory()) {
    const children = await fsp.readdir(entry);
    for (const child of children) await removeEntry(path.join(entry, child));
    await fsp.rmdir(entry);
    return;
  }
  await fsp.unlink(entry);
}
