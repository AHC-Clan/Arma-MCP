// agentSource.ts: 창 타일러가 쓰는 Win32 관찰 헬퍼의 C# 소스.
//
// 헬퍼는 판단하지 않는다. 데몬(windowTiler.ts, focusGuard.ts)이 무엇을 할지 정하고 헬퍼는 보고 옮기고 알리기만 한다.
//   stdout: 한 줄에 JSON 하나.
//     {"t":"snap","area":[l,t,r,b],"mons":[[l,t,r,b,<주 모니터면 1>],...],"human":<마지막 사람 입력 뒤 ms, 없으면 -1>,
//      "fg":<앞 창>,"fgPid":<앞 창 pid, 없으면 0>,"btn":<지금 마우스 단추가 눌려 있다>,"procs":[...]}
//       area 는 주 모니터 작업 영역이고 mons 는 모든 모니터의 작업 영역이다. 칸을 채울 모니터 순서는 데몬이 정한다.
//       procs 항목 {"pid","start":<시작 시각 epoch ms>,"cmd"?:<명령줄, 처음 한 번>,"cmdFail"?:true,"wins":[...]}
//       wins 항목 {"h","cls","r":[l,t,r,b],"cap":<제목 표시줄>,"min","max","mv":<끌거나 크기를 바꾸는 중>,"c"?:[클라이언트 영역 l,t,r,b]}
//     {"t":"moved","h","ok","err"}
//     {"t":"focus","op":"deact","h","ok","why":<안 보냈거나 처리를 못 본 까닭, 처리됐으면 null>}
//   stdin: 한 줄에 명령 하나. 창 주인이 pid 일 때만 한다.
//     "move <hwnd> <pid> <x> <y> <w> <h>" 는 창을 옮긴다.
//     "deact <hwnd> <pid>" 는 앞 창이 그 프로세스 것이 아니고 마우스 단추가 눌려 있지 않을 때 WM_ACTIVATE(WA_INACTIVE) 를 보낸다.
//     stdin 이 닫히면(데몬이 죽으면) 헬퍼도 끝난다.
//
// 좌표계: 매니페스트 없는 exe 는 DPI 를 인식하지 않는다. Arma 도 DPI 를 인식하지 않아 배율이 100% 를 넘으면
// 창 좌표가 논리 픽셀이다. 작업 영역과 창 사각형과 옮길 자리를 모두 이 좌표계로 읽고 쓴다(screenArea.ts 와 같다).
// 옮길 때는 SWP_NOACTIVATE, SWP_NOZORDER, SWP_ASYNCWINDOWPOS 만 쓴다. 포커스를 빼앗거나 창을 앞으로 가져오지 않는다.
// WM_ACTIVATE 는 그 창에만 알린다. Windows 의 앞 창과 포커스는 바뀌지 않는다.
// PostMessage 가 아니라 SendMessageTimeout 으로 보낸다. 게임은 보낸 메시지를 게시된 메시지보다 먼저, 보낸 메시지끼리는 온 순서대로
// 처리한다. 게시로 보내면 그 사이 Windows 가 보낸 활성 알림이 먼저 처리되고 이 비활성 알림이 뒤에 처리돼 앞에 있는 창이 키를 안 받는다.
// 앞 창이 아님을 본 바로 뒤에 보내므로 그 뒤에 온 활성 알림은 이 알림 다음에 처리된다. 남는 틈은 확인과 보내기 사이의 짧은 순간뿐이다.
// 활성 알림은 보내지 않는다. Arma 는 활성 알림마다 화면 보호기 값을 새로 저장해, 겹쳐 보내면 사람이 정한 값을 잃는다.
// 보내기는 따로 도는 스레드가 한다. 시간 안에 처리되지 않는 창이 관찰과 옮기기를 막지 않는다.
// 사람 입력은 마우스 왼쪽 버튼과 Win 키를 30 ms 마다 본다. 관찰 사이에 끝나는 짧은 끌기와 Win+방향키 스냅도 잡는다.

export const TILER_AGENT_CS_SOURCE: string = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class TilerAgent {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
    public int cbSize; public uint flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  delegate bool MonitorEnumProc(IntPtr m, IntPtr hdc, IntPtr rc, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeoutMs, out IntPtr result);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, ref int value, uint winIni);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);

  const string ExeName = "arma3_x64";
  const int GWL_STYLE = -16;
  const int WS_CAPTION = 0xC00000;
  const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_ASYNCWINDOWPOS = 0x4000;
  const uint GUI_INMOVESIZE = 0x2;
  const uint WM_ACTIVATE = 0x6;
  const int WA_INACTIVE = 0;
  const uint SMTO_ABORTIFHUNG = 0x2;
  const uint FocusTimeoutMs = 100;
  // 마지막 비활성 알림 뒤 이만큼 화면 보호기 값을 지켜본다. 시간이 넘은 알림을 게임이 처리하던 중이면 그 처리는 끝까지 간다.
  const int ScreenSaverWatchMs = 2000;
  const uint SPI_GETSCREENSAVEACTIVE = 0x10, SPI_SETSCREENSAVEACTIVE = 0x11;
  const int CmdTries = 5;
  const int CmdRetryMs = 2000;

  static readonly object outLock = new object();
  static readonly object queueLock = new object();
  static readonly Queue<string> commands = new Queue<string>();
  static readonly AutoResetEvent wake = new AutoResetEvent(false);
  static volatile bool quit = false;
  static long lastHumanTicks = 0;
  static TextWriter output;

  // 명령줄은 pid 와 시작 시각마다 한 번만 읽어 보낸다.
  static readonly Dictionary<string, int> cmdTries = new Dictionary<string, int>();
  // 비활성 알림 줄. 같은 창이 이미 줄에 있으면 다시 넣지 않는다.
  static readonly object focusLock = new object();
  static readonly Queue<long[]> focusQueue = new Queue<long[]>();
  static readonly HashSet<long> focusQueued = new HashSet<long>();
  static readonly AutoResetEvent focusWake = new AutoResetEvent(false);
  // 비활성 알림 앞의 화면 보호기 값. 앞 창이 그대로인 동안은 처음 읽은 값을 이어 쓰고 그 값으로 되돌린다.
  static int ssBase = -1;
  static IntPtr ssBaseFg = IntPtr.Zero;
  static DateTime ssBaseUntil = DateTime.MinValue;
  static readonly Dictionary<string, DateTime> cmdNext = new Dictionary<string, DateTime>();
  static readonly HashSet<string> cmdDone = new HashSet<string>();

  static int Main(string[] args) {
    int tickMs = 250;
    for (int i = 0; i < args.Length - 1; i++) {
      if (args[i] == "--tick") int.TryParse(args[i + 1], out tickMs);
    }
    if (tickMs < 50) tickMs = 50;
    // 이 스레드는 DPI 를 인식하지 않게 둔다(매니페스트가 없어 기본도 그렇다). 함수가 없는 옛 Windows 는 넘어간다.
    try { SetThreadDpiAwarenessContext(new IntPtr(-1)); } catch { }
    Stream stdout = Console.OpenStandardOutput();
    StreamWriter w = new StreamWriter(stdout, new UTF8Encoding(false));
    w.AutoFlush = true;
    w.NewLine = "\n";
    output = w;

    Thread sampler = new Thread(SampleInput); sampler.IsBackground = true; sampler.Start();
    Thread reader = new Thread(ReadCommands); reader.IsBackground = true; reader.Start();
    Thread focus = new Thread(FocusWorker); focus.IsBackground = true; focus.Start();

    while (!quit) {
      try { Snap(); } catch (Exception e) { Emit("{\"t\":\"error\",\"msg\":" + Js(e.Message) + "}"); }
      DateTime until = DateTime.UtcNow.AddMilliseconds(tickMs);
      while (!quit) {
        RunCommands();
        int left = (int)(until - DateTime.UtcNow).TotalMilliseconds;
        if (left <= 0) break;
        wake.WaitOne(left);
      }
    }
    return 0;
  }

  static void ReadCommands() {
    try {
      TextReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      string line;
      while ((line = r.ReadLine()) != null) {
        lock (queueLock) commands.Enqueue(line);
        wake.Set();
      }
    } catch { }
    // 데몬이 끝났다. 주 스레드가 WMI 조회에 막혀 있어도 바로 끝낸다.
    quit = true;
    Environment.Exit(0);
  }

  static void RunCommands() {
    while (true) {
      string line;
      lock (queueLock) {
        if (commands.Count == 0) return;
        line = commands.Dequeue();
      }
      string[] p = line.Trim().Split(' ');
      if (p.Length == 1 && p[0] == "quit") { quit = true; return; }
      if (p.Length == 7 && p[0] == "move") Move(p);
      if (p.Length == 3 && p[0] == "deact") QueueDeactivate(p);
    }
  }

  static uint ForegroundPid(out IntPtr fg) {
    fg = GetForegroundWindow();
    uint pid = 0;
    if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out pid);
    return pid;
  }

  static bool ButtonDown() { return Down(0x01) || Down(0x02) || Down(0x04); }

  static int ScreenSaverActive() { int v = -1; return SystemParametersInfo(SPI_GETSCREENSAVEACTIVE, 0, ref v, 0) ? v : -1; }

  static void QueueDeactivate(string[] p) {
    long h, pid;
    if (!long.TryParse(p[1], out h) || !long.TryParse(p[2], out pid)) return;
    bool added;
    lock (focusLock) {
      added = focusQueued.Add(h);
      if (added) focusQueue.Enqueue(new long[] { h, pid });
    }
    if (!added) {
      Emit("{\"t\":\"focus\",\"op\":\"deact\",\"h\":" + h + ",\"ok\":false,\"why\":\"queued\"}");
      return;
    }
    focusWake.Set();
  }

  static void FocusWorker() {
    while (!quit) {
      long[] item = null;
      lock (focusLock) {
        if (focusQueue.Count > 0) item = focusQueue.Dequeue();
      }
      if (item == null) {
        WatchScreenSaver();
        focusWake.WaitOne(100);
        continue;
      }
      try { Deactivate(item[0], (int)item[1]); }
      catch (Exception e) { Emit("{\"t\":\"error\",\"msg\":" + Js(e.Message) + "}"); }
      finally { lock (focusLock) focusQueued.Remove(item[0]); }
      WatchScreenSaver();
    }
  }

  // 게임에 비활성이 됐다고 알린다. 앞 창과 포커스는 건드리지 않는다.
  // 비활성 알림을 받은 Arma 는 자기가 눌렸다고 보는 마우스 단추를 SendInput 으로 뗀다. 사람이 단추를 누르는 중이면 보내지 않는다.
  // Arma 는 비활성 알림마다 화면 보호기를 활성 알림 때 저장한 값으로 되돌린다(한 번도 활성이 된 적 없으면 0).
  // 이 알림은 뒤에 있는 게임의 표시만 맞추는 것이라 화면 보호기를 바꿀 까닭이 없다. 앞 창이 그대로면 보내기 전 값으로 되돌린다.
  // 앞 창이 바뀌었으면 다른 게임의 활성 처리가 바꾼 값일 수 있어 건드리지 않는다.
  static void Deactivate(long h, int pid) {
    IntPtr hwnd = new IntPtr(h);
    uint owner = 0;
    if (IsWindow(hwnd)) GetWindowThreadProcessId(hwnd, out owner);
    string why = null;
    bool ok = false;
    IntPtr fg0;
    uint fgPid = ForegroundPid(out fg0);
    if (owner == 0 || (int)owner != pid) why = "owner";
    else if ((int)fgPid == pid) why = "foreground";
    else if (ButtonDown()) why = "button";
    else {
      HoldScreenSaver(fg0);
      IntPtr res;
      // 앞 창을 본 바로 뒤에 보낸다. 그 사이에 다른 일을 넣지 않는다.
      if ((int)ForegroundPid(out fg0) == pid) why = "foreground";
      else {
        ok = SendMessageTimeout(hwnd, WM_ACTIVATE, new IntPtr(WA_INACTIVE), IntPtr.Zero, SMTO_ABORTIFHUNG, FocusTimeoutMs, out res) != IntPtr.Zero;
        // 게임이 아직 꺼내지 않은 알림은 취소되고, 처리하던 알림은 끝까지 간다. 다음 관찰이 다시 보낸다.
        if (!ok) { int err = Marshal.GetLastWin32Error(); why = err == 1460 ? "timeout" : "send " + err; }
      }
    }
    Emit("{\"t\":\"focus\",\"op\":\"deact\",\"h\":" + h + ",\"ok\":" + (ok ? "true" : "false") + ",\"why\":" + Js(why) + "}");
  }

  static void SetScreenSaver(int v) { SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, (uint)v, IntPtr.Zero, 0); }

  // 비활성 알림 앞의 화면 보호기 값을 잡는다. 앞 창이 그대로이고 지켜보는 중이면 처음 잡은 값을 이어 쓴다.
  static void HoldScreenSaver(IntPtr fg) {
    lock (focusLock) {
      DateTime now = DateTime.UtcNow;
      if (ssBase < 0 || fg != ssBaseFg || now > ssBaseUntil) {
        ssBase = ScreenSaverActive();
        ssBaseFg = fg;
      }
      ssBaseUntil = now.AddMilliseconds(ScreenSaverWatchMs);
    }
  }

  static void WatchScreenSaver() {
    lock (focusLock) {
      if (ssBase < 0) return;
      IntPtr fg;
      ForegroundPid(out fg);
      if (DateTime.UtcNow > ssBaseUntil || fg != ssBaseFg) { ssBase = -1; return; }
      if (ScreenSaverActive() != ssBase) SetScreenSaver(ssBase);
    }
  }

  static void Move(string[] p) {
    long h; int pid, x, y, cw, ch;
    if (!long.TryParse(p[1], out h) || !int.TryParse(p[2], out pid) || !int.TryParse(p[3], out x) ||
        !int.TryParse(p[4], out y) || !int.TryParse(p[5], out cw) || !int.TryParse(p[6], out ch)) return;
    IntPtr hwnd = new IntPtr(h);
    bool ok = false; int err = 0;
    uint owner = 0;
    // 창 핸들은 다시 쓰일 수 있다. 지금 주인이 그 pid 일 때만 옮긴다.
    if (IsWindow(hwnd)) GetWindowThreadProcessId(hwnd, out owner);
    if (owner != 0 && (int)owner == pid) {
      ok = SetWindowPos(hwnd, IntPtr.Zero, x, y, cw, ch, SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
      if (!ok) err = Marshal.GetLastWin32Error();
    } else {
      err = -1;
    }
    Emit("{\"t\":\"moved\",\"h\":" + h + ",\"ok\":" + (ok ? "true" : "false") + ",\"err\":" + err + "}");
  }

  static void SampleInput() {
    while (true) {
      if (Down(0x01) || Down(0x5B) || Down(0x5C)) Interlocked.Exchange(ref lastHumanTicks, DateTime.UtcNow.Ticks);
      Thread.Sleep(30);
    }
  }

  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static void Snap() {
    Process[] ps = Process.GetProcessesByName(ExeName);
    Dictionary<int, List<IntPtr>> wins = new Dictionary<int, List<IntPtr>>();
    HashSet<int> pids = new HashSet<int>();
    foreach (Process p in ps) pids.Add(p.Id);
    if (pids.Count > 0) {
      EnumWindows(delegate(IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (!pids.Contains((int)pid)) return true;
        List<IntPtr> list;
        if (!wins.TryGetValue((int)pid, out list)) { list = new List<IntPtr>(); wins[(int)pid] = list; }
        list.Add(h);
        return true;
      }, IntPtr.Zero);
    }

    StringBuilder sb = new StringBuilder();
    RECT a = WorkArea();
    long human = Interlocked.Read(ref lastHumanTicks);
    long humanMs = human == 0 ? -1 : (DateTime.UtcNow.Ticks - human) / 10000;
    sb.Append("{\"t\":\"snap\",\"area\":[").Append(a.L).Append(',').Append(a.T).Append(',').Append(a.R).Append(',').Append(a.B)
      .Append("],\"mons\":[");
    AppendMonitors(sb);
    sb.Append("],\"human\":").Append(humanMs);
    IntPtr fgWin;
    uint fgPid = ForegroundPid(out fgWin);
    sb.Append(",\"fg\":").Append(fgWin.ToInt64()).Append(",\"fgPid\":").Append(fgPid)
      .Append(",\"btn\":").Append(ButtonDown() ? "true" : "false").Append(",\"procs\":[");
    bool firstProc = true;
    HashSet<string> alive = new HashSet<string>();
    foreach (Process p in ps) {
      long start = StartMs(p);
      string key = p.Id + ":" + start;
      alive.Add(key);
      if (!firstProc) sb.Append(',');
      firstProc = false;
      sb.Append("{\"pid\":").Append(p.Id).Append(",\"start\":").Append(start);
      if (!cmdDone.Contains(key)) {
        DateTime next;
        if (!cmdNext.TryGetValue(key, out next) || DateTime.UtcNow >= next) {
          string cmd = CommandLine(p.Id);
          if (cmd != null) {
            cmdDone.Add(key);
            sb.Append(",\"cmd\":").Append(Js(cmd));
          } else {
            int n; cmdTries.TryGetValue(key, out n); cmdTries[key] = n + 1;
            cmdNext[key] = DateTime.UtcNow.AddMilliseconds(CmdRetryMs);
            if (n + 1 >= CmdTries) { cmdDone.Add(key); sb.Append(",\"cmdFail\":true"); }
          }
        }
      }
      sb.Append(",\"wins\":[");
      List<IntPtr> hs;
      if (wins.TryGetValue(p.Id, out hs)) {
        bool firstWin = true;
        foreach (IntPtr h in hs) {
          if (!firstWin) sb.Append(',');
          firstWin = false;
          AppendWindow(sb, h);
        }
      }
      sb.Append("]}");
    }
    sb.Append("]}");
    foreach (Process p in ps) p.Dispose();
    Forget(cmdDone, alive);
    List<string> stale = new List<string>();
    foreach (string k in cmdTries.Keys) if (!alive.Contains(k)) stale.Add(k);
    foreach (string k in stale) { cmdTries.Remove(k); cmdNext.Remove(k); }
    Emit(sb.ToString());
  }

  static void Forget(HashSet<string> set, HashSet<string> alive) {
    List<string> stale = new List<string>();
    foreach (string k in set) if (!alive.Contains(k)) stale.Add(k);
    foreach (string k in stale) set.Remove(k);
  }

  static void AppendWindow(StringBuilder sb, IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    int style = GetWindowLong(h, GWL_STYLE);
    StringBuilder cls = new StringBuilder(64); GetClassName(h, cls, 64);
    uint pid; uint tid = GetWindowThreadProcessId(h, out pid);
    bool moving = false;
    GUITHREADINFO gi = new GUITHREADINFO();
    gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (GetGUIThreadInfo(tid, ref gi) && (gi.flags & GUI_INMOVESIZE) != 0) moving = true;
    sb.Append("{\"h\":").Append(h.ToInt64())
      .Append(",\"cls\":").Append(Js(cls.ToString()))
      .Append(",\"r\":[").Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R).Append(',').Append(r.B).Append(']')
      .Append(",\"cap\":").Append((style & WS_CAPTION) == WS_CAPTION ? "true" : "false")
      .Append(",\"min\":").Append(IsIconic(h) ? "true" : "false")
      .Append(",\"max\":").Append(IsZoomed(h) ? "true" : "false")
      .Append(",\"mv\":").Append(moving ? "true" : "false");
    // 클라이언트 영역의 화면 사각형. 데몬이 바깥 창과의 차이(테두리와 제목 표시줄 몫)를 창마다 잰다.
    RECT c; POINT o; o.X = 0; o.Y = 0;
    if (GetClientRect(h, out c) && ClientToScreen(h, ref o)) {
      sb.Append(",\"c\":[").Append(o.X).Append(',').Append(o.Y).Append(',').Append(o.X + c.R).Append(',').Append(o.Y + c.B).Append(']');
    }
    sb.Append('}');
  }

  static RECT WorkArea() {
    POINT pt; pt.X = 0; pt.Y = 0;
    IntPtr mon = MonitorFromPoint(pt, 1);
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(mon, ref mi);
    return mi.rcWork;
  }

  // 모든 모니터의 작업 영역. 끝 값이 1 이면 주 모니터다.
  static void AppendMonitors(StringBuilder sb) {
    bool first = true;
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr hdc, IntPtr rc, IntPtr l) {
      MONITORINFO mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(m, ref mi)) return true;
      RECT w = mi.rcWork;
      if (!first) sb.Append(',');
      first = false;
      sb.Append('[').Append(w.L).Append(',').Append(w.T).Append(',').Append(w.R).Append(',').Append(w.B)
        .Append(',').Append((mi.dwFlags & 1) != 0 ? 1 : 0).Append(']');
      return true;
    }, IntPtr.Zero);
  }

  static long StartMs(Process p) {
    try { return (long)(p.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
    catch { return 0; }
  }

  static string CommandLine(int pid) {
    try {
      using (ManagementObjectSearcher s = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
      using (ManagementObjectCollection c = s.Get()) {
        foreach (ManagementBaseObject o in c) {
          object cl = o["CommandLine"];
          return cl == null ? null : cl.ToString();
        }
      }
    } catch { }
    return null;
  }

  static void Emit(string line) {
    lock (outLock) {
      try { output.WriteLine(line); } catch { quit = true; }
    }
  }

  static string Js(string s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder(s.Length + 2);
    b.Append('"');
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else b.Append(c);
    }
    b.Append('"');
    return b.ToString();
  }
}
`;
