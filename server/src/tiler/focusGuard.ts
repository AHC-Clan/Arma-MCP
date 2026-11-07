// focusGuard.ts: 앞에 없는 게임 창이 사람이 다른 창에 치는 키를 쓰지 않게 한다.
//
// Arma 3(2.22) 는 키보드 Raw Input 을 RIDEV_INPUTSINK 로 등록해 창이 뒤에 있어도 모든 키를 받는다.
// 창 모드에서는 받은 키를 자기 활성 표시(isGameFocused)가 켜져 있을 때만 쓰고, 그 표시는 메인 창이 받은 WM_ACTIVATE 로만 바뀐다.
// 시작 중에 활성이 바뀌면 그 알림을 놓쳐 표시가 켜진 채 뒤로 가는 창이 생긴다. 그 창은 터미널에 치는 키를 그대로 쓴다.
// 그래서 앞에 없는 대상 창에 WM_ACTIVATE(WA_INACTIVE) 를 보내 표시를 끈다. Windows 의 앞 창과 포커스는 바꾸지 않는다.
//
// 규칙
//   대상은 창 타일러가 보는 게임(데몬이 띄운 클라) 중 제목 표시줄이 있고 최소화되지 않은 게임 창이다.
//   전체 화면 창은 WM_ACTIVATE 로 표시가 바뀌지 않아 보내지 않는다.
//   앞 창이 그 게임 프로세스의 창이면 보내지 않는다. 헬퍼가 보내기 직전에 한 번 더 보고 SendMessageTimeout 으로 보낸다.
//   그래서 그 뒤에 Windows 가 보낸 활성 알림은 이 알림 다음에 처리돼 앞에 온 창은 키를 받는다(agentSource.ts).
//   처음 본 때, 앞에서 뒤로 간 때, 그 뒤로는 FOCUS_REASSERT_MS 마다 보낸다. 이미 꺼진 표시에 다시 보내도 게임은 그대로다.
//   마우스 단추가 눌려 있으면 미룬다. 비활성 알림을 받은 게임은 자기가 눌렸다고 보는 마우스 단추를 SendInput 으로 뗀다.
//   활성 알림은 보내지 않는다. Arma 는 활성 알림마다 화면 보호기 값을 새로 저장해 겹쳐 보내면 그 값을 잃는다.

import type { AgentSnapshot, AgentWindow } from './windowTiler.js';

/** 앞에 없는 창에 비활성 알림을 다시 보내는 간격. */
export const FOCUS_REASSERT_MS = 1000;

const GAME_CLASS = 'Arma 3';

/** 창 타일러가 보는 게임 하나. key 는 pid 와 시작 시각이다. */
export interface FocusTarget {
  key: string;
  pid: number;
  label: string;
  win: AgentWindow | undefined;
}

/** 헬퍼에 보내는 비활성 알림 명령. */
export interface FocusCommand {
  hwnd: number;
  pid: number;
}

export interface FocusGuardOptions {
  send(cmd: FocusCommand): void;
  log?: (msg: string) => void;
  now?: () => number;
}

interface GuardState {
  /** 지난 관찰에서 앞에 있었다. */
  wasFg: boolean;
  /** 마지막 비활성 알림 시각. 0 이면 아직 안 보냈다. */
  lastDeact: number;
}

export class FocusGuard {
  private readonly state = new Map<string, GuardState>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: FocusGuardOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  onSnapshot(snap: AgentSnapshot, targets: readonly FocusTarget[]): void {
    const live = new Set(targets.map((t) => t.key));
    for (const k of this.state.keys()) if (!live.has(k)) this.state.delete(k);
    // 이전 헬퍼는 앞 창을 보내지 않는다. 모르면 아무것도 하지 않는다.
    if (typeof snap.fgPid !== 'number') return;
    const now = this.now();
    for (const t of targets) {
      const w = t.win;
      if (!w || w.cls !== GAME_CLASS || !w.cap || w.min) continue;
      let s = this.state.get(t.key);
      if (!s) {
        s = { wasFg: false, lastDeact: 0 };
        this.state.set(t.key, s);
      }
      if (snap.fgPid === t.pid) {
        s.wasFg = true;
        continue;
      }
      if (snap.btn) continue;
      const first = s.lastDeact === 0;
      if (!first && !s.wasFg && now - s.lastDeact < FOCUS_REASSERT_MS) continue;
      if (first) this.log(`포커스 가드: ${t.label} 가 앞에 없어 비활성 알림을 보냄(그 뒤로 ${FOCUS_REASSERT_MS / 1000}초마다)`);
      this.opts.send({ hwnd: w.h, pid: t.pid });
      s.lastDeact = now;
      s.wasFg = false;
    }
  }
}
