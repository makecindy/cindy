import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Rectangle } from 'electron';

import { createLogger } from '../logger.js';
import { normalizeFocusedWindowFrame } from './overlayPlacement.js';

const log = createLogger('voice-input-windows-insertion');

const DEFAULT_START_TIMEOUT_MS = 4000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 1200;
const DEFAULT_PASTE_TIMEOUT_MS = 2500;
const DEFAULT_RESTORE_TIMEOUT_MS = 1500;
const MAX_CONTEXT_BEFORE_CHARS = 500;
const MAX_CONTEXT_SELECTED_CHARS = 1000;
const MAX_CONTEXT_AFTER_CHARS = 500;

export type WindowsPasteTarget = {
  processName: string;
  bundleId: string;
  pid?: number;
  /** Win32 HWND serialized as decimal string to avoid precision loss on 64-bit handles. */
  hwnd?: string;
};

export type WindowsPasteContext = {
  selectionBefore: string;
  selectedText: string;
  selectionAfter: string;
  focusedRole?: string;
  contextSource?: string;
};

export type WindowsCapturedOverlayTarget = {
  target: WindowsPasteTarget;
  context: WindowsPasteContext | null;
  /** Physical screen coordinates returned by Win32 GetWindowRect (converted to DIP by caller). */
  frame: Rectangle | null;
};

export type WindowsPasteVerificationResult = {
  ok: boolean;
  outcome: 'command_issued' | 'target_changed' | 'failed';
  reason?: string;
  commandIssued: boolean;
  currentHwnd?: string;
  currentPid?: number;
  currentProcessName?: string;
};

export type WindowsFocusRestoreResult = {
  ok: boolean;
  reason?: string;
  currentHwnd?: string;
  currentPid?: number;
};

type HelperRequestPayload =
  | { id: number; command: 'capture-target'; withFocusedFrame: boolean }
  | { id: number; command: 'paste-verified'; hwnd?: string; pid?: number; processName?: string }
  | { id: number; command: 'restore-focus'; hwnd?: string; pid?: number };

type HelperRawResponse = {
  id?: number;
  event?: string;
  ok?: boolean;
  reason?: string;
  outcome?: string;
  commandIssued?: boolean;
  target?: {
    processName?: string;
    pid?: number;
    hwnd?: string;
  };
  frame?: unknown;
  context?: {
    selectionBefore?: string;
    selectedText?: string;
    selectionAfter?: string;
    focusedRole?: string;
    contextSource?: string;
    isPassword?: boolean;
  } | null;
  currentHwnd?: string;
  currentPid?: number;
  currentProcessName?: string;
};

export interface WindowsHelperTransport {
  readonly isAlive: boolean;
  start(): Promise<void>;
  send(payload: HelperRequestPayload, timeoutMs: number): Promise<HelperRawResponse>;
  stop(): void;
}

/**
 * Resident PowerShell script that compiles a minimal Win32 + UIAutomationClient
 * helper once per process and serves JSON-line commands over stdin/stdout.
 *
 * Security & privacy invariants:
 * - Never reads AutomationElement text when IsPassword is true.
 * - Verifies foreground HWND/PID before issuing Win32 SendInput Ctrl+V so a
 *   focus shift never pastes dictated text into the wrong window.
 * - Never writes user dictated text to stdout/stderr logs.
 */
const WINDOWS_HELPER_POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  "$csharp = @'",
  'using System;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Runtime.InteropServices;',
  'using System.Threading;',
  'using System.Windows.Automation;',
  'using System.Windows.Automation.Text;',
  '',
  'public static class XdtWinVoiceHelper {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  private struct INPUT { public uint type; public InputUnion u; }',
  '',
  '  [StructLayout(LayoutKind.Explicit)]',
  '  private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }',
  '',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '',
  '  private const uint INPUT_KEYBOARD = 1;',
  '  private const uint KEYEVENTF_KEYUP = 0x0002;',
  '  private const ushort VK_CONTROL = 0x11;',
  '  private const ushort VK_V = 0x56;',
  '  private const uint GA_ROOT = 2;',
  '  private const int SW_RESTORE = 9;',
  '',
  '  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
  '  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
  '  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);',
  '  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);',
  '  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  '',
  '  private static string TryGetProcessName(int pid) {',
  '    if (pid <= 0) return "";',
  '    try { using (var p = Process.GetProcessById(pid)) { return p.ProcessName ?? ""; } }',
  '    catch { return ""; }',
  '  }',
  '',
  '  private static IntPtr ParseHwnd(string raw) {',
  '    if (string.IsNullOrWhiteSpace(raw)) return IntPtr.Zero;',
  '    long v;',
  '    if (!long.TryParse(raw.Trim(), out v) || v == 0) return IntPtr.Zero;',
  '    return new IntPtr(v);',
  '  }',
  '',
  '  private static bool MatchesTarget(IntPtr currentHwnd, int currentPid, IntPtr targetHwnd, int targetPid) {',
  '    if (currentHwnd == IntPtr.Zero) return false;',
  '    if (targetHwnd != IntPtr.Zero) {',
  '      if (currentHwnd == targetHwnd) return true;',
  '      var curRoot = GetAncestor(currentHwnd, GA_ROOT);',
  '      var tgtRoot = GetAncestor(targetHwnd, GA_ROOT);',
  '      if (curRoot != IntPtr.Zero && curRoot == tgtRoot) return true;',
  '      return false;',
  '    }',
  '    if (targetPid > 0 && currentPid == targetPid) return true;',
  '    return false;',
  '  }',
  '',
  '  private static string ClampHead(string text, int maxChars) {',
  '    if (string.IsNullOrEmpty(text)) return "";',
  '    return text.Length <= maxChars ? text : text.Substring(0, maxChars);',
  '  }',
  '',
  '  private static string ClampTail(string text, int maxChars) {',
  '    if (string.IsNullOrEmpty(text)) return "";',
  '    return text.Length <= maxChars ? text : text.Substring(text.Length - maxChars);',
  '  }',
  '',
  '  public static Dictionary<string, object> CaptureTarget(bool withFocusedFrame) {',
  '    var result = new Dictionary<string, object>();',
  '    IntPtr hwnd = GetForegroundWindow();',
  '    if (hwnd == IntPtr.Zero) {',
  '      result["ok"] = false;',
  '      result["reason"] = "no_foreground_window";',
  '      return result;',
  '    }',
  '    uint rawPid = 0;',
  '    GetWindowThreadProcessId(hwnd, out rawPid);',
  '    int pid = unchecked((int)rawPid);',
  '    string processName = TryGetProcessName(pid);',
  '    var target = new Dictionary<string, object>();',
  '    target["processName"] = processName;',
  '    target["pid"] = pid;',
  '    target["hwnd"] = hwnd.ToInt64().ToString();',
  '    result["target"] = target;',
  '',
  '    if (withFocusedFrame) {',
  '      RECT rect;',
  '      if (GetWindowRect(hwnd, out rect)) {',
  '        int width = rect.Right - rect.Left;',
  '        int height = rect.Bottom - rect.Top;',
  '        if (width > 0 && height > 0) {',
  '          var frame = new Dictionary<string, object>();',
  '          frame["x"] = rect.Left;',
  '          frame["y"] = rect.Top;',
  '          frame["width"] = width;',
  '          frame["height"] = height;',
  '          result["frame"] = frame;',
  '        }',
  '      }',
  '    }',
  '',
  '    try {',
  '      var focused = AutomationElement.FocusedElement;',
  '      if (focused != null) {',
  '        bool isPassword = false;',
  '        try { isPassword = focused.Current.IsPassword; } catch { isPassword = false; }',
  '        string controlType = "";',
  '        try { controlType = focused.Current.ControlType != null ? focused.Current.ControlType.ProgrammaticName : ""; } catch {}',
  '        if (isPassword) {',
  '          var ctx = new Dictionary<string, object>();',
  '          ctx["isPassword"] = true;',
  '          ctx["focusedRole"] = controlType;',
  '          result["context"] = ctx;',
  '        } else {',
  '          object patternObj = null;',
  '          if (focused.TryGetCurrentPattern(TextPattern.Pattern, out patternObj) && patternObj is TextPattern) {',
  '            var tp = (TextPattern)patternObj;',
  '            var selections = tp.GetSelection();',
  '            if (selections != null && selections.Length > 0) {',
  '              var sel = selections[0];',
  '              string selectedText = ClampHead(sel.GetText(1000) ?? "", 1000);',
  '              var beforeRange = sel.Clone();',
  '              beforeRange.MoveEndpointByRange(TextPatternRangeEndpoint.End, sel, TextPatternRangeEndpoint.Start);',
  '              beforeRange.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -500);',
  '              string selectionBefore = ClampTail(beforeRange.GetText(500) ?? "", 500);',
  '              var afterRange = sel.Clone();',
  '              afterRange.MoveEndpointByRange(TextPatternRangeEndpoint.Start, sel, TextPatternRangeEndpoint.End);',
  '              afterRange.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, 500);',
  '              string selectionAfter = ClampHead(afterRange.GetText(500) ?? "", 500);',
  '              var ctx = new Dictionary<string, object>();',
  '              ctx["selectionBefore"] = selectionBefore;',
  '              ctx["selectedText"] = selectedText;',
  '              ctx["selectionAfter"] = selectionAfter;',
  '              ctx["focusedRole"] = controlType;',
  '              ctx["contextSource"] = "uia-text-pattern";',
  '              result["context"] = ctx;',
  '            }',
  '          } else if (focused.TryGetCurrentPattern(ValuePattern.Pattern, out patternObj) && patternObj is ValuePattern) {',
  '            var vp = (ValuePattern)patternObj;',
  '            bool isEditControl = controlType == "ControlType.Edit" || controlType == "ControlType.Document";',
  '            if (isEditControl && !vp.Current.IsReadOnly) {',
  '              string value = ClampTail(vp.Current.Value ?? "", 500);',
  '              var ctx = new Dictionary<string, object>();',
  '              ctx["selectionBefore"] = value;',
  '              ctx["selectedText"] = "";',
  '              ctx["selectionAfter"] = "";',
  '              ctx["focusedRole"] = controlType;',
  '              ctx["contextSource"] = "uia-value-pattern";',
  '              result["context"] = ctx;',
  '            }',
  '          }',
  '        }',
  '      }',
  '    } catch {}',
  '',
  '    result["ok"] = !string.IsNullOrEmpty(processName) || pid > 0;',
  '    return result;',
  '  }',
  '',
  '  private static bool EnsureForegroundTarget(IntPtr targetHwnd, int targetPid, out IntPtr currentHwnd, out int currentPid, out string reason) {',
  '    currentHwnd = GetForegroundWindow();',
  '    uint rawPid = 0;',
  '    if (currentHwnd != IntPtr.Zero) GetWindowThreadProcessId(currentHwnd, out rawPid);',
  '    currentPid = unchecked((int)rawPid);',
  '    if (targetHwnd != IntPtr.Zero && !IsWindow(targetHwnd)) {',
  '      reason = "target_window_closed";',
  '      return false;',
  '    }',
  '    if (MatchesTarget(currentHwnd, currentPid, targetHwnd, targetPid)) {',
  '      reason = "already_focused";',
  '      return true;',
  '    }',
  '    if (targetHwnd != IntPtr.Zero) {',
  '      if (IsIconic(targetHwnd)) ShowWindow(targetHwnd, SW_RESTORE);',
  '      SetForegroundWindow(targetHwnd);',
  '      for (int i = 0; i < 8; i++) {',
  '        Thread.Sleep(15);',
  '        currentHwnd = GetForegroundWindow();',
  '        rawPid = 0;',
  '        if (currentHwnd != IntPtr.Zero) GetWindowThreadProcessId(currentHwnd, out rawPid);',
  '        currentPid = unchecked((int)rawPid);',
  '        if (MatchesTarget(currentHwnd, currentPid, targetHwnd, targetPid)) {',
  '          reason = "focus_restored";',
  '          return true;',
  '        }',
  '      }',
  '    }',
  '    reason = "focus_not_on_target";',
  '    return false;',
  '  }',
  '',
  '  public static Dictionary<string, object> RestoreFocus(string hwndRaw, int targetPid) {',
  '    IntPtr targetHwnd = ParseHwnd(hwndRaw);',
  '    IntPtr currentHwnd;',
  '    int currentPid;',
  '    string reason;',
  '    bool ok = EnsureForegroundTarget(targetHwnd, targetPid, out currentHwnd, out currentPid, out reason);',
  '    var result = new Dictionary<string, object>();',
  '    result["ok"] = ok;',
  '    result["reason"] = reason;',
  '    result["currentHwnd"] = currentHwnd.ToInt64().ToString();',
  '    result["currentPid"] = currentPid;',
  '    return result;',
  '  }',
  '',
  '  public static Dictionary<string, object> PasteVerified(string hwndRaw, int targetPid) {',
  '    IntPtr targetHwnd = ParseHwnd(hwndRaw);',
  '    var result = new Dictionary<string, object>();',
  '    IntPtr currentHwnd;',
  '    int currentPid;',
  '    string reason;',
  '    if (targetHwnd != IntPtr.Zero || targetPid > 0) {',
  '      if (!EnsureForegroundTarget(targetHwnd, targetPid, out currentHwnd, out currentPid, out reason)) {',
  '        result["ok"] = false;',
  '        result["outcome"] = "target_changed";',
  '        result["reason"] = reason;',
  '        result["commandIssued"] = false;',
  '        result["currentHwnd"] = currentHwnd.ToInt64().ToString();',
  '        result["currentPid"] = currentPid;',
  '        result["currentProcessName"] = TryGetProcessName(currentPid);',
  '        return result;',
  '      }',
  '    } else {',
  '      currentHwnd = GetForegroundWindow();',
  '      uint rawPid = 0;',
  '      if (currentHwnd != IntPtr.Zero) GetWindowThreadProcessId(currentHwnd, out rawPid);',
  '      currentPid = unchecked((int)rawPid);',
  '    }',
  '',
  '    var inputs = new INPUT[4];',
  '    inputs[0].type = INPUT_KEYBOARD;',
  '    inputs[0].u.ki.wVk = VK_CONTROL;',
  '    inputs[1].type = INPUT_KEYBOARD;',
  '    inputs[1].u.ki.wVk = VK_V;',
  '    inputs[2].type = INPUT_KEYBOARD;',
  '    inputs[2].u.ki.wVk = VK_V;',
  '    inputs[2].u.ki.dwFlags = KEYEVENTF_KEYUP;',
  '    inputs[3].type = INPUT_KEYBOARD;',
  '    inputs[3].u.ki.wVk = VK_CONTROL;',
  '    inputs[3].u.ki.dwFlags = KEYEVENTF_KEYUP;',
  '    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));',
  '    bool issued = sent == (uint)inputs.Length;',
  '    result["ok"] = issued;',
  '    result["outcome"] = issued ? "command_issued" : "failed";',
  '    result["reason"] = issued ? "send_input_ok" : "send_input_incomplete";',
  '    result["commandIssued"] = issued;',
  '    result["currentHwnd"] = currentHwnd.ToInt64().ToString();',
  '    result["currentPid"] = currentPid;',
  '    result["currentProcessName"] = TryGetProcessName(currentPid);',
  '    return result;',
  '  }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $csharp -ReferencedAssemblies @("UIAutomationClient", "UIAutomationTypes")',
  '[Console]::Out.WriteLine((ConvertTo-Json -Compress @{ event = "ready" }))',
  '[Console]::Out.Flush()',
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  '  if ([string]::IsNullOrWhiteSpace($line)) { continue }',
  '  $id = 0',
  '  try {',
  '    $req = ConvertFrom-Json -InputObject $line',
  '    if ($null -ne $req.id) { $id = [int]$req.id }',
  '    $cmd = [string]$req.command',
  '    if ($cmd -eq "capture-target") {',
  '      $resp = [XdtWinVoiceHelper]::CaptureTarget([bool]$req.withFocusedFrame)',
  '    } elseif ($cmd -eq "paste-verified") {',
  '      $hwnd = if ($null -ne $req.hwnd) { [string]$req.hwnd } else { "" }',
  '      $pidVal = if ($null -ne $req.pid) { [int]$req.pid } else { 0 }',
  '      $resp = [XdtWinVoiceHelper]::PasteVerified($hwnd, $pidVal)',
  '    } elseif ($cmd -eq "restore-focus") {',
  '      $hwnd = if ($null -ne $req.hwnd) { [string]$req.hwnd } else { "" }',
  '      $pidVal = if ($null -ne $req.pid) { [int]$req.pid } else { 0 }',
  '      $resp = [XdtWinVoiceHelper]::RestoreFocus($hwnd, $pidVal)',
  '    } else {',
  '      $resp = @{ ok = $false; reason = "unknown_command" }',
  '    }',
  '    $resp["id"] = $id',
  '    [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 6 $resp))',
  '    [Console]::Out.Flush()',
  '  } catch {',
  '    $errResp = @{ id = $id; ok = $false; outcome = "failed"; reason = $_.Exception.Message }',
  '    [Console]::Out.WriteLine((ConvertTo-Json -Compress $errResp))',
  '    [Console]::Out.Flush()',
  '  }',
  '}',
].join('\n');

function clampHead(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function clampTail(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

/**
 * Normalize UIA text context returned from Windows helper.
 *
 * Security invariant: password fields (`isPassword: true`) ALWAYS normalize to
 * null so credentials never enter the dictation refiner or prompt context.
 */
export function normalizeWindowsPasteContext(
  raw: HelperRawResponse['context'],
): WindowsPasteContext | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.isPassword === true) return null;
  const selectionBefore = clampTail(raw.selectionBefore, MAX_CONTEXT_BEFORE_CHARS);
  const selectedText = clampHead(raw.selectedText, MAX_CONTEXT_SELECTED_CHARS);
  const selectionAfter = clampHead(raw.selectionAfter, MAX_CONTEXT_AFTER_CHARS);
  if (!selectionBefore && !selectedText && !selectionAfter) return null;
  return {
    selectionBefore,
    selectedText,
    selectionAfter,
    focusedRole: typeof raw.focusedRole === 'string' && raw.focusedRole ? raw.focusedRole : undefined,
    contextSource: typeof raw.contextSource === 'string' && raw.contextSource ? raw.contextSource : 'uia',
  };
}

/**
 * Convert a Win32 physical-pixel window rectangle into Electron DIP coordinates
 * so `screen.getDisplayMatching` selects the right monitor under per-monitor DPI scaling.
 */
export function normalizeWindowsFocusedFrame(
  rawFrame: unknown,
  physicalToDip?: (rect: Rectangle) => Rectangle,
): Rectangle | null {
  const physical = normalizeFocusedWindowFrame(rawFrame);
  if (!physical) return null;
  if (!physicalToDip) return physical;
  try {
    return normalizeFocusedWindowFrame(physicalToDip(physical)) ?? physical;
  } catch {
    return physical;
  }
}

class PowerShellWindowsHelperTransport implements WindowsHelperTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<number, {
    resolve: (response: HelperRawResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stdoutBuffer = '';

  get isAlive(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  start(): Promise<void> {
    if (this.isAlive && !this.startPromise) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            WINDOWS_HELPER_POWERSHELL_SCRIPT,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
      } catch (error) {
        this.startPromise = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.child = child;
      this.stdoutBuffer = '';

      const settleStart = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        fn();
      };

      const readyTimer = setTimeout(() => {
        settleStart(() => {
          this.teardownChild('Windows text insertion helper startup timed out.', child);
          reject(new Error('Windows text insertion helper startup timed out.'));
        });
      }, DEFAULT_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return;
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: HelperRawResponse;
          try {
            parsed = JSON.parse(trimmed) as HelperRawResponse;
          } catch {
            continue;
          }
          if (parsed.event === 'ready') {
            settleStart(() => {
              this.startPromise = null;
              resolve();
            });
            continue;
          }
          if (typeof parsed.id === 'number') {
            const entry = this.pending.get(parsed.id);
            if (entry) {
              this.pending.delete(parsed.id);
              clearTimeout(entry.timer);
              entry.resolve(parsed);
            }
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (this.child !== child) return;
        const trimmed = chunk.trim();
        if (trimmed) {
          log.debug('windows text insertion helper stderr', { message: trimmed.slice(0, 300) });
        }
      });

      child.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!settled) {
          settleStart(() => {
            this.teardownChild(err.message, child);
            reject(err);
          });
        } else {
          this.teardownChild(err.message, child);
        }
      });

      child.on('exit', (code, signal) => {
        const reason = `Windows text insertion helper exited (code=${String(code)}, signal=${String(signal)}).`;
        if (!settled) {
          settleStart(() => {
            this.teardownChild(reason, child);
            reject(new Error(reason));
          });
        } else {
          this.teardownChild(reason, child);
        }
      });
    });
    return this.startPromise;
  }

  async send(payload: HelperRequestPayload, timeoutMs: number): Promise<HelperRawResponse> {
    await this.start();
    const child = this.child;
    if (!child || !this.isAlive) {
      throw new Error('Windows text insertion helper is not running.');
    }
    return new Promise<HelperRawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.id);
        this.teardownChild(`Windows text insertion helper timed out after ${timeoutMs}ms.`, child);
        reject(new Error(`Windows text insertion helper timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(payload.id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
      } catch (error) {
        this.pending.delete(payload.id);
        clearTimeout(timer);
        const err = error instanceof Error ? error : new Error(String(error));
        this.teardownChild(err.message, child);
        reject(err);
      }
    });
  }

  stop(): void {
    this.teardownChild('Windows text insertion helper stopped.');
  }

  private teardownChild(reason: string, expectedChild?: ChildProcessWithoutNullStreams): void {
    if (expectedChild && this.child !== expectedChild) return;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.stdoutBuffer = '';
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      try {
        if (!child.killed && child.exitCode === null) child.kill();
      } catch {
        // ignore
      }
    }
  }
}

export class WindowsTextInsertionClient {
  private nextRequestId = 1;

  constructor(private readonly transport: WindowsHelperTransport = new PowerShellWindowsHelperTransport()) {}

  prewarm(): void {
    void this.transport.start().catch((error) => {
      log.debug('windows text insertion helper prewarm failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async captureTarget(options?: {
    withFocusedFrame?: boolean;
    timeoutMs?: number;
    physicalToDip?: (rect: Rectangle) => Rectangle;
  }): Promise<WindowsCapturedOverlayTarget | null> {
    const response = await this.sendWithRetry(
      {
        id: this.nextRequestId++,
        command: 'capture-target',
        withFocusedFrame: Boolean(options?.withFocusedFrame),
      },
      options?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
    );
    if (!response.ok || !response.target) return null;
    const processName = typeof response.target.processName === 'string' ? response.target.processName.trim() : '';
    const pid = typeof response.target.pid === 'number' && Number.isFinite(response.target.pid) && response.target.pid > 0
      ? Math.trunc(response.target.pid)
      : undefined;
    const hwnd = typeof response.target.hwnd === 'string' && response.target.hwnd.trim() && response.target.hwnd.trim() !== '0'
      ? response.target.hwnd.trim()
      : undefined;
    if (!processName && !pid && !hwnd) return null;
    return {
      target: {
        processName: processName || (pid ? `pid:${pid}` : 'unknown'),
        bundleId: processName,
        pid,
        hwnd,
      },
      context: normalizeWindowsPasteContext(response.context),
      frame: normalizeWindowsFocusedFrame(response.frame, options?.physicalToDip),
    };
  }

  async pasteVerified(
    target: WindowsPasteTarget | null | undefined,
    options?: { timeoutMs?: number },
  ): Promise<WindowsPasteVerificationResult> {
    const response = await this.sendWithRetry(
      {
        id: this.nextRequestId++,
        command: 'paste-verified',
        hwnd: target?.hwnd,
        pid: target?.pid,
        processName: target?.processName,
      },
      options?.timeoutMs ?? DEFAULT_PASTE_TIMEOUT_MS,
    );
    const outcome =
      response.outcome === 'command_issued' || response.outcome === 'target_changed'
        ? response.outcome
        : response.ok
          ? 'command_issued'
          : 'failed';
    return {
      ok: Boolean(response.ok) && outcome === 'command_issued',
      outcome,
      reason: typeof response.reason === 'string' ? response.reason : undefined,
      commandIssued: response.commandIssued === true,
      currentHwnd: typeof response.currentHwnd === 'string' ? response.currentHwnd : undefined,
      currentPid: typeof response.currentPid === 'number' ? response.currentPid : undefined,
      currentProcessName: typeof response.currentProcessName === 'string' ? response.currentProcessName : undefined,
    };
  }

  async restoreFocus(
    target: WindowsPasteTarget | null | undefined,
    options?: { timeoutMs?: number },
  ): Promise<WindowsFocusRestoreResult> {
    if (!target?.hwnd && !target?.pid) {
      return { ok: false, reason: 'missing_target' };
    }
    const response = await this.sendWithRetry(
      {
        id: this.nextRequestId++,
        command: 'restore-focus',
        hwnd: target.hwnd,
        pid: target.pid,
      },
      options?.timeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS,
    );
    return {
      ok: Boolean(response.ok),
      reason: typeof response.reason === 'string' ? response.reason : undefined,
      currentHwnd: typeof response.currentHwnd === 'string' ? response.currentHwnd : undefined,
      currentPid: typeof response.currentPid === 'number' ? response.currentPid : undefined,
    };
  }

  shutdown(): void {
    this.transport.stop();
  }

  private async sendWithRetry(
    payload: HelperRequestPayload,
    timeoutMs: number,
  ): Promise<HelperRawResponse> {
    try {
      return await this.transport.send(payload, timeoutMs);
    } catch (firstError) {
      // A lost acknowledgement does not prove SendInput was skipped.
      if (payload.command === 'paste-verified') throw firstError;
      if (this.transport.isAlive) throw firstError;
      // Resident helper exited unexpectedly; spawn a clean instance once.
      const retryPayload = { ...payload, id: this.nextRequestId++ };
      return await this.transport.send(retryPayload, timeoutMs);
    }
  }
}

export type WindowsClipboardPort = {
  writeText(text: string): void;
  readText(): string;
  clear(): void;
};

export type WindowsPasteGuardResult =
  | { ok: true; currentProcessName?: string }
  | { ok: false; code: 'unavailable' | 'failed'; message: string; detail: string };

/**
 * Execute a guarded Windows paste critical section:
 * 1. Write temporary dictated text to clipboard and confirm read-back matches.
 * 2. Verify foreground focus matches the captured target (restoring if still alive)
 *    before issuing Win32 SendInput Ctrl+V.
 * 3. On any failure or focus mismatch, synchronously restore the prior clipboard
 *    snapshot (or clear the temporary text if no snapshot was captured).
 */
export async function executeWindowsGuardedPaste<TSnapshot>(params: {
  text: string;
  target: WindowsPasteTarget | null;
  client: Pick<WindowsTextInsertionClient, 'pasteVerified'>;
  clipboard: WindowsClipboardPort;
  captureSnapshot: () => TSnapshot | null;
  restoreSnapshotSync: (snapshot: TSnapshot, expectedTemporaryText: string) => void;
  scheduleSnapshotRestore: (snapshot: TSnapshot | null, expectedTemporaryText: string) => void;
}): Promise<WindowsPasteGuardResult> {
  const { text, target, client, clipboard, captureSnapshot, restoreSnapshotSync, scheduleSnapshotRestore } = params;
  const snapshot = captureSnapshot();
  const rollbackClipboard = (): void => {
    if (snapshot) {
      restoreSnapshotSync(snapshot, text);
      return;
    }
    try {
      if (clipboard.readText() === text) {
        clipboard.clear();
      }
    } catch {
      // ignore tombstone errors
    }
  };

  try {
    clipboard.writeText(text);
    if (clipboard.readText() !== text) {
      rollbackClipboard();
      return {
        ok: false,
        code: 'unavailable',
        message: 'Could not prepare clipboard for automatic input.',
        detail: 'clipboard_readback_mismatch',
      };
    }
  } catch (error) {
    rollbackClipboard();
    return {
      ok: false,
      code: 'failed',
      message: 'Could not write dictated text to clipboard.',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let result: WindowsPasteVerificationResult;
  try {
    result = await client.pasteVerified(target);
  } catch (error) {
    rollbackClipboard();
    return {
      ok: false,
      code: 'failed',
      message: 'Could not paste into the current app.',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!result.ok) {
    rollbackClipboard();
    if (result.outcome === 'target_changed') {
      return {
        ok: false,
        code: 'unavailable',
        message: 'The target window changed before automatic input completed.',
        detail: result.reason || 'target_changed',
      };
    }
    return {
      ok: false,
      code: 'failed',
      message: 'Could not paste into the current app.',
      detail: result.reason || 'windows_paste_failed',
    };
  }

  scheduleSnapshotRestore(snapshot, text);
  return { ok: true, currentProcessName: result.currentProcessName };
}

export const windowsTextInsertionClient = new WindowsTextInsertionClient();
