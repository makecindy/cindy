import { describe, expect, it } from 'vitest';
import { getDesktopShellCommandPolicy } from '../shell-command-policy.js';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('embedded iOS Simulator shell policy', () => {
  it.each([
    'open -a Simulator',
    'open -n -a "Simulator.app"',
    'open -na Simulator',
    'open -b com.apple.iphonesimulator',
    'open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
    '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
  ])('denies an external Simulator launch: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it('denies a multiline legacy simulator workflow before it can execute', () => {
    const command = [
      'SIM_UUID=1A9D41E0-E031-4AD0-A8B5-847480802E8E',
      'xcrun simctl boot "$SIM_UUID"',
      'open -a Simulator',
      'xcrun simctl install "$SIM_UUID" /tmp/FiloApp.app',
    ].join('\n');
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('cindy_ios_simulator'),
    });
  });

  it.each([
    'xcrun simctl boot DEVICE',
    'xcrun simctl bootstatus DEVICE -b',
    'xcrun simctl install DEVICE /tmp/App.app',
    'xcrun simctl launch DEVICE com.example.app',
    'xcrun simctl shutdown DEVICE',
    '/usr/bin/xcrun simctl io DEVICE screenshot /tmp/frame.png',
  ])('denies direct Simulator mutation: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'exec /usr/bin/xcrun simctl shutdown DEVICE',
    'command -p xcrun simctl boot DEVICE',
    'builtin exec xcrun simctl install DEVICE /tmp/App.app',
    'nohup -- xcrun simctl launch DEVICE com.example.app',
    'env FOO=1 /usr/bin/xcrun simctl shutdown DEVICE',
    'FOO=1 exec env BAR=2 xcrun simctl boot DEVICE',
    "bash -lc 'xcrun simctl shutdown DEVICE'",
    "/bin/csh -c 'xcrun simctl shutdown DEVICE'",
    "/bin/tcsh -c 'xcrun simctl shutdown DEVICE'",
    "/bin/ksh -c 'xcrun simctl shutdown DEVICE'",
    "fish -c 'xcrun simctl shutdown DEVICE'",
    "eval 'xcrun simctl erase DEVICE'",
    'echo "$(xcrun simctl shutdown DEVICE)"',
    'echo >(xcrun simctl shutdown DEVICE)',
    "env -S 'xcrun simctl shutdown DEVICE'",
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; eval "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; sh -c "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; $CMD',
    'printf "xcrun simctl shutdown DEVICE\\n" | sh',
    'time xcrun simctl shutdown DEVICE',
    'time -p xcrun simctl boot DEVICE',
    'f(){ xcrun simctl shutdown DEVICE;}; f',
    'f() ( xcrun simctl shutdown DEVICE ); f',
    `function f () ( printf '%s' "$(date)"; /usr/bin/open -a Simulator ); f`,
    '/usr/bin/xcrun \\\n simctl shutdown DEVICE',
    '/usr/bin/nice /usr/bin/xcrun simctl erase DEVICE',
    '/usr/bin/arch -arm64 /usr/bin/xcrun simctl boot DEVICE',
    '/usr/bin/caffeinate -i /usr/bin/xcrun simctl shutdown DEVICE',
    `/bin/sh -c '"$0" "$@"' /usr/bin/xcrun simctl shutdown DEVICE`,
    `/bin/sh -c '/usr/bin/open -a "$1"' ignored Simulator`,
    '$(/usr/bin/xcrun --find simctl) shutdown DEVICE',
    '/usr/bin/xc[r]un simctl shutdown DEVICE',
    'TOOL=simctl; /usr/bin/xcrun "$TOOL" shutdown DEVICE',
    'A=sim; B=ctl; xcrun "$A$B" shutdown DEVICE',
    'A=sim; B=ctl; xcrun --sdk iphonesimulator "${A}${B}" erase DEVICE',
    'xcrun s{imc,foo}tl shutdown DEVICE',
    'A="default simctl"; xcrun --toolchain ${=A} shutdown DEVICE',
    `bash -lc 'A="default simctl"; xcrun --toolchain $A shutdown DEVICE'`,
    'A=(default simctl); xcrun --toolchain "${(@)A}" shutdown DEVICE',
    'A="default simctl"; xcrun --toolchain "$=A" shutdown DEVICE',
    'A=(default simctl); xcrun --toolchain "$A[@]" shutdown DEVICE',
    `bash -O extglob -lc 'xcrun @(simctl) shutdown DEVICE'`,
    `zsh -o extendedglob -c 'xcrun ^foo shutdown DEVICE'`,
    'xcrun --sdk "$SDK" simctl list devices',
    'A=default; xcrun --toolchain "$A" swift --version',
    'xargs /usr/bin/xcrun simctl shutdown DEVICE',
    "find . -maxdepth 0 -exec /usr/bin/xcrun simctl shutdown DEVICE ';'",
    `printf 'simctl shutdown DEVICE' | xargs /usr/bin/xcrun`,
    'xcrun "$(printf simctl)" shutdown DEVICE',
    'xcrun $(printf simctl) shutdown DEVICE',
    'xcrun $(echo simctl) shutdown DEVICE',
    'TOOL=$(printf simctl); xcrun "$TOOL" shutdown DEVICE',
    'launchctl submit -l cindy-test -- /usr/bin/xcrun simctl shutdown DEVICE',
    `sandbox-exec -p '(version 1) (allow default)' /usr/bin/xcrun simctl shutdown DEVICE`,
    "shopt -s expand_aliases\nalias sim='xcrun simctl'\nsim shutdown DEVICE",
    "alias sim=xcrun\\ simctl; eval 'sim erase DEVICE'",
    "builtin alias sim='/usr/bin/xcrun simctl'; eval 'sim shutdown DEVICE'",
    "command -- alias sim='open -a Simulator'; eval sim",
    "alias safe='ls -la' sim='xcrun simctl'; eval 'sim boot DEVICE'",
    "alias sc='simctl'; eval 'sc shutdown DEVICE'",
  ])('denies Simulator mutation hidden behind shell execution: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    `python3 -c 'import subprocess; subprocess.run(["/usr/bin/xcrun", "simctl", "shutdown", "DEVICE"])'`,
    `node -e 'require("node:child_process").execFileSync("xcrun", ["simctl", "erase", "DEVICE"])'`,
    `ruby -e 'system("xcrun simctl boot DEVICE")'`,
    `perl -e 'system("simctl shutdown DEVICE")'`,
    `env FOO=1 python3.12 -c 'import os; os.system("xcrun simctl install DEVICE /tmp/App.app")'`,
    `/usr/bin/python3 -c 'import os; os.system("simctl shutdown DEVICE")'`,
    `awk 'BEGIN { system("xcrun simctl erase DEVICE") }'`,
    `osascript -e 'do shell script "/usr/bin/xcrun simctl shutdown DEVICE"'`,
    `osascript -e 'do shell script "open -a Simulator"'`,
    `printf '%s' 'import os; os.system("xcrun simctl shutdown DEVICE")' | python3`,
    `python3 <<'PY'
import os
os.system("xcrun simctl shutdown DEVICE")
PY`,
    `osascript -e 'set cmd to "/usr/bin/xcrun simctl shutdown DEVICE"' -e 'do shell script cmd'`,
    `osascript -l JavaScript -e 'ObjC.import("Foundation"); const task = $.NSTask.alloc.init; task.launchPath = "/usr/bin/xcrun"; task.arguments = ["simctl", "shutdown", "DEVICE"]; task.launch'`,
    `python3 -c 'import subprocess; subprocess.run(["/usr/bin/open","-a","Simulator"])'`,
    `node -e 'require("child_process").spawnSync("/usr/bin/open",["-na","Simulator"])'`,
    `ruby -e 'system("/usr/bin/open", "-a", "Simulator")'`,
    `/usr/bin/expect -c 'spawn /usr/bin/xcrun simctl shutdown DEVICE; expect eof'`,
    `printf '%s' 'exec /usr/bin/xcrun simctl shutdown DEVICE' | /usr/bin/tclsh`,
    `printf '%s' 'import os; os.system("xcrun simctl shutdown DEVICE")' |& python3`,
    `bash <<< 'xcrun simctl shutdown DEVICE'`,
    `zsh <<< 'open -a Simulator'`,
    `bash -c 'source /dev/stdin' <<< 'xcrun simctl shutdown DEVICE'`,
    `bash -c 'eval "$(cat)"' <<< 'xcrun simctl shutdown DEVICE'`,
    `printf 'xcrun simctl shutdown DEVICE' | bash -c 'eval "$(cat)"'`,
  ])('denies Simulator mutation hidden behind a programmable interpreter: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'xcrun simctl list devices',
    'xcrun simctl listapps DEVICE',
    'xcrun simctl list "$DEVICE"',
    'xcrun simctl getenv "$DEVICE" HOME',
    'xcrun --sdk iphonesimulator simctl list devices',
    'xcrun swift --version',
    'exec xcrun simctl list devices',
    'command -p xcrun simctl listapps DEVICE',
    "bash -lc 'xcrun simctl list devices'",
    'f(){ xcrun simctl list devices;}; f',
    'f() ( xcrun simctl list devices ); f',
    'echo "f() ( xcrun simctl shutdown DEVICE )"',
    'command -v xcrun',
    'xcodebuild -scheme FiloApp -sdk iphonesimulator build',
    'open -a Xcode',
    'echo "open -a Simulator"',
    'osascript -e \'tell application "Simulator" to quit\'',
    `python3 -c 'print("ordinary project build")'`,
    `python3 -c 'print("Simulator")'`,
    `node -e 'console.log("ordinary project build")'`,
    'swift test --filter IOSSimulatorTests',
    'swift build --product IOSSimulatorRuntime',
    'find . -maxdepth 1 -name simctl',
    'git grep simctl',
    'git log --grep=simctl',
    `sed -n '/simctl/p' README.md`,
    `jq '.simctl' config.json`,
    'diff simctl-before.txt simctl-after.txt',
    'cp simctl-notes.txt backup.txt',
    'git grep simctl && python3 scripts/check.py',
    'git grep simctl | python3 formatter.py',
    `git grep simctl | awk '{print $1}'`,
    `python3 -c 'print("ordinary")'; git grep simctl`,
    'git grep simctl || python3',
    'alias',
    'alias sim',
    "alias ll='ls -la'; ll",
    'echo "alias sim=\'xcrun simctl\'"',
  ])('allows a non-bypass command: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });
});
