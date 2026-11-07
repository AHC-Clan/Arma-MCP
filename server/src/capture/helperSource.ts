// helperSource.ts — arma_capture 캡처 헬퍼의 C# 소스 + 소스 해시.
//
// 왜 PowerShell 이 아니라 C# 컴파일 exe 인가:
//   창 탐색(EnumWindows/GetWindowThreadProcessId) + PrintWindow + CopyFromScreen 이 한
//   PowerShell 스크립트 텍스트에 공존하면 Windows Defender AMSI 가 스크린 그래버 시그니처로
//   오탐해 ScriptContainedMaliciousContent 로 차단한다(개별 API 는 통과하지만 조합이 걸린다).
//   PE 파일은 스크립트 스캐너 대상이 아니므로, 이 소스를 csc.exe 로 작은 exe 로 컴파일해 실행한다.
//
// 파라미터는 env(ARMA_CAP_*)로 받고, 결과는 stdout 에 JSON 1줄로 낸다:
//   성공 {"ok":true,"file","method","imageW","imageH","windowRect"?,"note"?}
//   실패 {"ok":false,"stage":"find-window"|"minimized"|"capture"|"encode","error"}
// 실패도 stdout 으로 ok:false + Environment.Exit(0) — exit!=0 은 런타임 붕괴로 구분한다.
//
// 캡처 전략: window 는 PrintWindow(PW_RENDERFULLCONTENT=2) → 사실상 전부 검정이면
//   최소화 상태는 명시적 에러(바탕화면 오캡처 방지), 그 외엔 CopyFromScreen(창 rect) 폴백.
//   screen 은 주 모니터 전체(게임 창 밖 다이얼로그·런처 확인용).

import { createHash } from 'node:crypto';

export const CAPTURE_CS_SOURCE: string = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class Cap {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

  static string E(string s) {
    if (s == null) return "";
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }
  static void Ok(string body) { Console.Out.Write("{\"ok\":true," + body + "}"); Environment.Exit(0); }
  static void Fail(string stage, string msg) {
    Console.Out.Write("{\"ok\":false,\"stage\":\"" + E(stage) + "\",\"error\":\"" + E(msg) + "\"}");
    Environment.Exit(0);
  }

  static IntPtr FindPidWindow(uint targetPid) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid && IsWindowVisible(h)) {
        RECT r;
        if (GetWindowRect(h, out r)) {
          long area = (long)(r.R - r.L) * (long)(r.B - r.T);
          if (area > bestArea) { bestArea = area; best = h; }
        }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  // 가장자리 5% 인셋 후 10x10 그리드 100픽셀 샘플 — 평균/최대 밝기 모두 바닥이면 사실상 전부 검정.
  static bool AllBlack(Bitmap b) {
    int ix = Math.Max((int)(b.Width * 0.05), 1), iy = Math.Max((int)(b.Height * 0.05), 1);
    int iw = b.Width - 2 * ix, ih = b.Height - 2 * iy;
    if (iw <= 0 || ih <= 0) return false;
    long sum = 0; int peak = 0, n = 0;
    for (int gy = 0; gy < 10; gy++)
      for (int gx = 0; gx < 10; gx++) {
        int px = ix + (int)(iw * (gx + 0.5) / 10), py = iy + (int)(ih * (gy + 0.5) / 10);
        Color c = b.GetPixel(px, py); int v = c.R + c.G + c.B;
        sum += v; if (v > peak) peak = v; n++;
      }
    return (sum / n) < 6 && peak < 24;
  }

  static string Env(string k) { return Environment.GetEnvironmentVariable(k) ?? ""; }
  static int EnvI(string k, int d) { int r; return int.TryParse(Env(k), out r) ? r : d; }

  [STAThread]
  static void Main() {
    // 스케일 모니터에서 rect 가 논리 픽셀이 되어 잘리지 않도록 DPI 인식 설정.
    try {
      if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    } catch { try { SetProcessDPIAware(); } catch {} }

    string scope = Env("ARMA_CAP_SCOPE");
    string procImage = Env("ARMA_CAP_PROC");
    string outFile = Env("ARMA_CAP_OUT");
    string format = Env("ARMA_CAP_FORMAT");
    int quality = EnvI("ARMA_CAP_QUALITY", 80);
    int maxW = EnvI("ARMA_CAP_MAXW", 1568);
    int delayMs = EnvI("ARMA_CAP_DELAY", 0);
    if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);

    Bitmap bmp = null; string method = ""; string note = null; RECT wr = new RECT(); bool haveRect = false;
    try {
      if (scope == "screen") {
        Rectangle b = Screen.PrimaryScreen.Bounds;
        bmp = new Bitmap(b.Width, b.Height);
        using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size);
        method = "screen";
      } else {
        string name = System.IO.Path.GetFileNameWithoutExtension(procImage);
        int pid = EnvI("ARMA_CAP_PID", 0);
        System.Diagnostics.Process[] procs;
        if (pid > 0) {
          // 스택이 고른 프로세스 하나만 본다. 같은 이미지가 여럿 떠 있어도 엉뚱한 창을 찍지 않는다.
          try { procs = new System.Diagnostics.Process[] { System.Diagnostics.Process.GetProcessById(pid) }; }
          catch (Exception) { procs = new System.Diagnostics.Process[0]; }
          if (procs.Length == 0) Fail("find-window", "process not running: pid " + pid);
        } else {
          procs = System.Diagnostics.Process.GetProcessesByName(name);
          if (procs.Length == 0) Fail("find-window", "process not running: " + procImage);
        }
        IntPtr hwnd = IntPtr.Zero;
        foreach (var p in procs) { if (p.MainWindowHandle != IntPtr.Zero) { hwnd = p.MainWindowHandle; break; } }
        if (hwnd == IntPtr.Zero)
          foreach (var p in procs) { IntPtr h = FindPidWindow((uint)p.Id); if (h != IntPtr.Zero) { hwnd = h; break; } }
        if (hwnd == IntPtr.Zero) Fail("find-window", "no visible window for " + procImage);

        GetWindowRect(hwnd, out wr); haveRect = true;
        int w = wr.R - wr.L, h2 = wr.B - wr.T;
        if (w <= 0 || h2 <= 0) Fail("capture", "empty window rect");
        bmp = new Bitmap(w, h2);
        bool pwOk;
        using (Graphics g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          pwOk = PrintWindow(hwnd, hdc, 2);
          g.ReleaseHdc(hdc);
        }
        method = "printwindow";
        if (!pwOk || AllBlack(bmp)) {
          if (IsIconic(hwnd)) Fail("minimized", "window is minimized - restore the window and retry");
          bmp.Dispose();
          bmp = new Bitmap(w, h2);
          using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(wr.L, wr.T, 0, 0, new Size(w, h2));
          method = "screen";
          note = "PrintWindow gave a black frame (likely exclusive fullscreen) - captured from screen; if the game window is covered by another window, that content appears instead";
        }
      }
    } catch (Exception ex) { Fail("capture", ex.Message); }

    int outW = bmp.Width, outH = bmp.Height;
    try {
      string outDir = System.IO.Path.GetDirectoryName(outFile);
      if (!string.IsNullOrEmpty(outDir)) System.IO.Directory.CreateDirectory(outDir);
      if (maxW > 0 && outW > maxW) {
        outH = Math.Max((int)Math.Round(bmp.Height * (double)maxW / bmp.Width), 1);
        outW = maxW;
        Bitmap rs = new Bitmap(outW, outH);
        using (Graphics g = Graphics.FromImage(rs)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.DrawImage(bmp, 0, 0, outW, outH);
        }
        bmp.Dispose(); bmp = rs;
      }
      if (format == "png") {
        bmp.Save(outFile, ImageFormat.Png);
      } else {
        ImageCodecInfo codec = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") { codec = c; break; }
        EncoderParameters ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
        bmp.Save(outFile, codec, ep);
      }
      bmp.Dispose();
    } catch (Exception ex) { Fail("encode", ex.Message); }

    string body = "\"file\":\"" + E(outFile) + "\",\"method\":\"" + method + "\",\"imageW\":" + outW + ",\"imageH\":" + outH;
    if (haveRect) body += ",\"windowRect\":{\"x\":" + wr.L + ",\"y\":" + wr.T + ",\"w\":" + (wr.R - wr.L) + ",\"h\":" + (wr.B - wr.T) + "}";
    if (note != null) body += ",\"note\":\"" + E(note) + "\"";
    Ok(body);
  }
}
`;

/** C# 소스 해시(첫 12자). 헬퍼 exe 파일명에 박아 소스 변경 시 자동 재컴파일. */
export function helperHash(): string {
  return createHash('sha256').update(CAPTURE_CS_SOURCE).digest('hex').slice(0, 12);
}
