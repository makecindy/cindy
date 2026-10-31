import { describe, expect, it } from "vitest";

import { classifyShellCommand } from "./auto-review.js";
import {
  isShellDesktopInputCommand,
  SHELL_DESKTOP_INPUT_DENIAL_REASON,
} from "./desktop-input-shell.js";

/**
 * Rule basis: CU-014 (2026-10-31 audit) — shell-simulated desktop input bypasses
 * every cindy_computer guard and typed into the wrong window. Gap: no shared
 * classifier existed; `osascript` only counted as a pipe executor. Tier: unit.
 */
describe("isShellDesktopInputCommand", () => {
  it.each([
    // the exact shapes seen in the audited transcripts
    `osascript -e 'tell application "System Events" to keystroke "/pr "'`,
    `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
    `osascript -e 'tell application "System Events" to key code 36'`,
    `osascript -e 'tell application "System Events" to tell process "Cindy" to click button 1 of window 1'`,
    `printf '%s' 'hello' | pbcopy; osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`,
    `cliclick c:1460,645`,
    `swift /tmp/click.swift 100 200 # CGEventPost(.cghidEventTap, e)`,
    `python3 -c "import Quartz; e=Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (1,2), 0); Quartz.CGEventPost(0, e)"`,
    `xdotool type "hello"`,
    `powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"`,
    `cua-driver click --pid 11629 --x 600 --y 320`,
    `/Users/dash/.local/bin/cua-driver type-text --pid 1 --text hi`,
    // path-qualified binaries (review: absolute paths bypassed the guard)
    `/opt/homebrew/bin/cliclick c:100,100`,
    `/usr/bin/xdotool key Return`,
    // payloads that carry separators inside quotes, and a script written then run
    `osascript -e 'tell application "System Events"; keystroke "x"; end tell'`,
    `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); $.CGEventPost(0, e)'`,
    `cat > /tmp/click.swift <<'EOF'\nlet e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)\nEOF`,
    `rg foo src && osascript -e 'tell application "System Events" to keystroke "a"'`,
    // review round 5: libraries and Wayland / Windows entry points (one inventory)
    `python3 -c 'import pyautogui; pyautogui.write("x")'`,
    `python3 -c "from pynput.keyboard import Controller; Controller().type('x')"`,
    `node -e "require('robotjs').typeString('x')"`,
    `wtype x`,
    `/usr/bin/dotool`,
    `xvkbd -text x`,
    `nircmd.exe sendkeypress ctrl+v`,
    `AutoHotkey.exe click.ahk`,
    // review round 16: System Events addressed by bundle id
    `osascript -e 'tell application id "com.apple.systemevents" to tell process "Cindy" to set value of text field 1 of window 1 to "secret"'`,
    `osascript -l JavaScript -e 'Application("com.apple.SystemEvents").processes.byName("Cindy").windows[0].buttons[0].click()'`,
    // review round 14: a read-only head told to run another program, or an env assignment that does
    `printf x > 'c:100,100'; rg --pre cliclick z 'c:100,100'`,
    `rg --pre=cliclick z f`,
    `git -c core.pager='cliclick c:1,1' log`,
    `sort --compress-program=cliclick f`,
    `LESSOPEN='|cliclick c:1,1 %s' less f`,
    `GIT_PAGER='xdotool click 1' git log`,
    // review round 14: no distance limit between the wrapper and the verb
    `osascript -e 'tell application "System Events"${" ".repeat(500)}\n keystroke "x"'`,
    // review round 10: line continuations are deleted by the shell before it parses
    `xdotool \\\nclick 1`,
    `/Users/dash/.local/bin/cua-driver \\\n  click --pid 1 --x 5 --y 5`,
    // review round 10: GNU sed executes `e` with any address or range; only print-only scripts are read-only
    `sed -n '1e xdotool click 1' /etc/hosts`,
    `sed -n '2,4{e cliclick c:1,1\n}' f.txt`,
    `sed -n 's/x/y/e;p' f.txt && cliclick c:1,1`,
    `sed --expression='1e cliclick c:1,1' f.txt`,
    // review round 9: writes through the accessibility tree are input too
    `osascript -e 'tell application "System Events" to set value of text field 1 of window 1 of process "Cindy" to "secret"'`,
    `osascript -e 'tell application "System Events" to tell process "Cindy" to perform action "AXPress" of button 1 of window 1'`,
    `osascript -e 'tell application "System Events" to set selected of row 2 of table 1 of window 1 of process "Finder" to true'`,
    // review round 8: the executable sits inside a wrapper's command string
    `bash -c 'cliclick c:1,1'`,
    `sh -c "xdotool click 1"`,
    `eval 'wtype x'`,
    `zsh -lc 'cd /tmp && /opt/homebrew/bin/cliclick c:5,5'`,
    // sed that writes or executes is not read-only
    `sed -i '' 's/a/b/' f.txt; cliclick c:1,1`,
    `sed -n 'w /tmp/click.swift' in.txt && swift /tmp/click.swift # CGEventPost`,
    // review round 7: executable names resolve in any case on macOS / Windows
    `/opt/homebrew/bin/CLICLICK c:100,100`,
    `/Users/dash/.local/bin/CUA-DRIVER click --pid 1`,
    `XDOTOOL key Return`,
    // a newline is a separator: a read-only first line cannot hide the second command
    `rg foo src\nosascript -e 'tell application "System Events" to keystroke "a"'`,
    `osascript <<'EOF'\ntell application "System Events"\n  keystroke "a"\nend tell\nEOF`,
    `cliclick c:1,1 2>&1 | tee out.log`,
    // review: a read-only head still executes the substitutions in its arguments
    `rg "$(osascript -e 'tell application "System Events" to keystroke "x"')" .`,
    "grep -r `cliclick c:1,1` src",
    // and a text writer piped into an interpreter is not a read-only segment
    `printf 'tell application "System Events" to keystroke "x"' | osascript`,
  ])("matches synthesized input: %s", (command) => {
    expect(isShellDesktopInputCommand(command)).toBe(true);
  });

  it.each([
    // read-only desktop queries and unrelated uses of the same words
    `osascript -e 'tell application "System Events" to get {name, unix id} of first application process whose frontmost is true'`,
    `osascript -e 'tell application "Terminal" to get name of every tab of window 1'`,
    `screencapture -x /tmp/full.png`,
    `lsappinfo front`,
    `git commit -m "fix keystroke handling in composer"`,
    `rg "keystroke" apps/desktop/src`,
    `cat docs/cliclick-notes.md`,
    // read-only search / history over files that merely mention the APIs (review)
    `rg 'CGEventPost' apps/desktop/src`,
    `grep -rn "SendKeys" packages | head`,
    `git grep -n CGEventCreateMouseEvent`,
    `git commit -m "fix osascript keystroke guard for cliclick and CGEventPost"`,
    `git -C /repo log --oneline -S SendInput`,
    `rg cliclick /opt/homebrew/bin/cliclick.md`,
    `rg "$(pwd)/CGEventPost" src`,
    // review round 10: print-only sed over files that mention the APIs
    `sed -n '1,5p' apps/desktop/src/main/mcp-integrations/computer.ts`,
    `sed -n '/CGEventPost/,/^}/p' computer.ts`,
    `sed -n '$p' notes.md`,
    `osascript -e 'tell application id "com.apple.systemevents" to get the name of every process'`,
    // review round 9: reading accessibility values and process state stays allowed
    `osascript -e 'tell application "System Events" to get value of text field 1 of window 1 of process "Cindy"'`,
    `osascript -e 'tell application "System Events" to get the name of every process whose visible is true'`,
    // review round 8: read-only sed and other pure readers over files that mention the APIs
    `sed -n '/CGEventPost/p' apps/desktop/src/main/mcp-integrations/computer.ts`,
    `sed -nE '1,40p;/SendKeys/p' scripts/notes.md`,
    `jq '.scripts | keys' package.json | sort | uniq`,
    `ls docs | cut -d. -f1`,
    // review round 7: separators inside quotes belong to one argument
    `rg 'foo|CGEventPost' .`,
    `grep -E "SendKeys|SendInput; keybd_event" -r src`,
    `rg 'a;b' src && git log --oneline -S 'cliclick|xdotool'`,
    `rg CGEventPost src 2>&1 | head`,
    // installing or listing a library is not synthesis
    `pip install pyautogui`,
    `pnpm add robotjs`,
    `brew info cliclick`,
    `rg pyautogui requirements.txt`,
    `git log --grep=SendInput --since "$(date -v-7d +%F)"`,
    `cua-driver --version`,
    `cua-driver status`,
    `xcrun simctl io booted screenshot /tmp/sim.png`,
    `axe tap -x 100 -y 200 --udid ABC`,
    ``,
  ])("leaves non-input commands alone: %s", (command) => {
    expect(isShellDesktopInputCommand(command)).toBe(false);
  });

  // Not a classifier rule of its own: the commands are simply never allowlisted, so they reach
  // the reviewer, whose policy (continuation-policy.ts) says to block them on this computer.
  it("never auto-approves synthesized input", () => {
    expect(
      classifyShellCommand(
        `osascript -e 'tell application "System Events" to keystroke "a"'`,
        ["/repo"],
      ),
    ).toBe("prompt");
    expect(classifyShellCommand("cliclick c:10,10", ["/repo"])).toBe("prompt");
    expect(
      classifyShellCommand("screencapture -x /tmp/a.png", ["/repo"]),
    ).not.toBe("prompt-each-time");
  });

  it("names cindy_computer as the only entry in the denial reason", () => {
    expect(SHELL_DESKTOP_INPUT_DENIAL_REASON).toContain("cindy_computer");
    expect(SHELL_DESKTOP_INPUT_DENIAL_REASON).toContain(
      "SHELL_DESKTOP_INPUT_NOT_ALLOWED",
    );
  });
});
