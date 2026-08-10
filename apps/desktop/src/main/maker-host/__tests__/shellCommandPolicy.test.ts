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
    'A=xcr; B=un; C=sim; D=ctl; "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=simctl; env "$A$B" "$C" shutdown DEVICE',
    'A=x; B=crun; C=sim; D=ctl; command "${A}${B}" "${C}${D}" shutdown DEVICE',
    '$(printf xcr)$(printf un) simctl shutdown DEVICE',
    'x{cr,foo}un simctl shutdown DEVICE',
    'RUNNER="$UNTRUSTED_EXECUTABLE"; exec "$RUNNER" --version',
    'env -S "$UNTRUSTED_EXECUTABLE"',
    'A=xcr; B=un; C=sim; D=ctl; CMD="$A$B $C$D shutdown DEVICE"; env -S "$CMD"',
    'time -l "$UNTRUSTED_EXECUTABLE"',
    'xargs "$UNTRUSTED_EXECUTABLE"',
    "find . -maxdepth 0 -exec \"$UNTRUSTED_EXECUTABLE\" '{}' '+'",
    `sandbox-exec -p '(version 1) (allow default)' "$UNTRUSTED_EXECUTABLE"`,
    'A=xcr; B=un; sh -c \'"$0" simctl shutdown DEVICE\' "$A$B"',
    'A=xcr; B=un; C=sim; D=ctl; >/tmp/cindy-shell.log "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; 2>/dev/null "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; < /dev/null "$A$B" "$C$D" shutdown DEVICE',
    "A=xcr; B=un; C=sim; D=ctl; COUNT='arr[$($A$B $C$D shutdown DEVICE)]'; (( COUNT ))",
    "A=xcr; B=un; C=sim; D=ctl; PAYLOAD='arr[$($A$B $C$D shutdown DEVICE)]'; COUNT=PAYLOAD; (( COUNT ))",
    "A=xcr; B=un; C=sim; D=ctl; printf -v COUNT 'arr[$($A$B $C$D shutdown DEVICE)]'; (( COUNT ))",
    "A=xcr B=un C=sim D=ctl COUNT='arr[$($A$B $C$D shutdown DEVICE)]' bash -c '(( COUNT ))'",
    'xargs -0 /Applications/Xcode.app/Contents/Developer/usr/bin/simct? shutdown DEVICE',
    'sudo -n /Applications/Xcode.app/Contents/Developer/usr/bin/simct[l] shutdown DEVICE',
    'gtimeout -v 5 /Applications/Xcode.app/Contents/Developer/usr/bin/simct? shutdown DEVICE',
    `zsh -o extendedglob -c '/Applications/Xcode.app/Contents/Developer/usr/bin/simct^foo shutdown DEVICE'`,
    `zsh -o extendedglob -c '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl~foo shutdown DEVICE'`,
    `zsh -o extendedglob -c '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl# shutdown DEVICE'`,
    'A=xcr; B=un; C=sim; D=ctl; launchctl asuser 501 "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; launchctl bsexec 123 "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; noglob "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; nocorrect "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; coproc "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; repeat 1 "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; sudo >/dev/null "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; xargs 2>/dev/null "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; launchctl submit -l test >/dev/null -- "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; sudo FOO=bar "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; xargs env FOO=bar "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; find . -maxdepth 0 -exec env FOO=bar "$A$B" "$C$D" shutdown DEVICE \';\'',
    'A=xcr; B=un; C=sim; D=ctl; sudo command "$A$B" "$C$D" shutdown DEVICE',
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

  it.each(['(( $COUNT > 0 ))', '(( COUNT[$idx]++ ))', 'if (( $COUNT > 0 )); then echo ready; fi'])(
    'denies dynamic shell arithmetic that can recursively execute stored payloads: %s',
    (command) => {
      expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
    },
  );

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
    `bash <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `cat <<EOF
$(xcrun simctl shutdown DEVICE)
EOF`,
    `python3 <<'PY'
import os
os.system("$(xcrun simctl shutdown DEVICE)")
PY`,
    `sh -c 'eval "$(cat)"' <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `python3 - <<'PY'
import os
os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")
PY`,
    `python3 - <<'PY'
import os
os.system(f"xcr{'un'} sim{'ctl'} shutdown DEVICE")
PY`,
    `python3 - <<'PY'
import subprocess
subprocess.run(["xcr" + "un", "sim" + "ctl", "shutdown", "DEVICE"])
PY`,
    `python3 -c 'import os; os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")'`,
    `bash <<'SH'
xcr"un" sim"ctl" shutdown DEVICE
SH`,
    `python3 - <<'PY.SH'
import os
os.system("xcrun simctl shutdown DEVICE")
PY.SH`,
    `echo '<<END'
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE
END`,
    `echo "<<END"
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE
END`,
    `# <<END
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE`,
    `python3 - <<'PY'
print(x) <<END
PY
$(printf xcr) $(printf un) shutdown DEVICE`,
    `python3 - <<'PY'
import os
os.system(chr(120)+chr(99)+chr(114)+chr(117)+chr(110)+chr(32)+chr(115)+chr(105)+chr(109)+chr(99)+chr(116)+chr(108))
PY`,
    `python3 - <<'PY'
import os
os.system("".join(chr(c) for c in [120,99,114,117,110,32,115,105,109,99,116,108]))
PY`,
    `node - <<'JS'
require("child_process").execSync(String.fromCharCode(120,99,114,117,110,32,115,105,109,99,116,108))
JS`,
    `python3 - <<'PY'
import os
os.system("\\x78\\x63\\x72\\x75\\x6e \\x73\\x69\\x6d\\x63\\x74\\x6c shutdown DEVICE")
PY`,
    `python3 - <<'END!'
import os
os.system("xcrun simctl shutdown DEVICE")
END!`,
    `python3 - <<'END$'
import os
os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")
END$`,
    `echo x; # <<END
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE`,
    `echo x | # <<END
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE`,
    `( echo x ) # <<END
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE`,
    `python3 -c 'x = "
a <<END
b
"'
$(printf xcr) $(printf un) shutdown DEVICE`,
    `python3 -c "x = '
a <<END
b
'"
$(printf xcr) $(printf un) shutdown DEVICE`,
    `python3 - <<'PY'
import base64, os
os.system(base64.b64decode("eGNydW4gc2ltY3RsIHNodXRkb3duIERFVklDRQ=="))
PY`,
    `node - <<'JS'
require("child_process").execSync(atob("eGNydW4gc2ltY3RsIHNodXRkb3duIERFVklDRQ=="))
JS`,
    `node - <<'JS'
require("child_process").execSync(Buffer.from("eGNydW4gc2ltY3RsIHNodXRkb3duIERFVklDRQ==", "base64"))
JS`,
    `python3 - <<'PY'
import os
os.system(bytes.fromhex("786372756e2073696d63746c2073687574646f776e20444556494345"))
PY`,
    `node - <<'JS'
require("child_process").execSync(\`xcr\${'un'} sim\${'ctl'} shutdown DEVICE\`)
JS`,
    `cat <<<EOF
$(printf xcr) $(printf un) shutdown DEVICE`,
    `cat <<< EOF
$(printf xcr) $(printf un) shutdown DEVICE`,
    `awk -f - <<'AWK'
system("xcrun simctl shutdown DEVICE")
AWK`,
    `awk -f - <<'AWK'
system("xcr" "un" " sim" "ctl shutdown DEVICE")
AWK`,
    `python3 - <<PY:
import os
os.system("xcrun simctl shutdown DEVICE")
PY:`,
    `python3 - <<PY:
print("hi")
PY:
$(printf xcr) $(printf un) shutdown DEVICE`,
    `awk -f- <<'AWK'
system("xcrun simctl shutdown DEVICE")
AWK`,
    `awk -f- <<'AWK'
system("xcr" "un" " sim" "ctl shutdown DEVICE")
AWK`,
    `awk <<'AWK'
system("xcrun simctl shutdown DEVICE")
AWK`,
    `awk -v x=1 <<'AWK'
system("xcr" "un" " sim" "ctl shutdown DEVICE")
AWK`,
    `python3 - <<'PY'
import os
os.system("ECIVED nwodtuhs ltcmis nurxc"[::-1])
PY`,
    `python3 - <<'PY'
import os
os.system("".join(reversed("ECIVED nwodtuhs ltcmis nurxc")))
PY`,
    `python3 - <<'PY'
import os
os.system(chr(60*2)+chr(99)+chr(114)+chr(117)+chr(110)+chr(32)+chr(115)+chr(105)+chr(109)+chr(99)+chr(116)+chr(108))
PY`,
    `python3 - <<'PY'
import os
os.system("".join(chr(c) for c in [60*2, 99, 114, 117, 110, 32, 115, 105, 109, 99, 116, 108]))
PY`,
    `python3 - <<'PY'
import os
os.system("".join(chr(c) for c in (60*2, 99, 114, 117, 110)))
PY`,
    `python3 - <<'PY'
import os
os.system(" ".join("ECIVED nwodtuhs ltcmis nurxc".split()[::-1]))
PY`,
    `node - <<'JS'
require("child_process").execSync("ECIVED nwodtuhs ltcmis nurxc".split("").reverse().join(""))
JS`,
    `awk -f /dev/stdin <<'AWK'
system("xcrun simctl shutdown DEVICE")
AWK`,
    `awk -f /dev/fd/0 <<'AWK'
system("xcr" "un" " sim" "ctl shutdown DEVICE")
AWK`,
    `cat <<'SCRIPT' > /tmp/x.sh
xcrun simctl shutdown DEVICE
SCRIPT
sh /tmp/x.sh`,
    `tee /tmp/x.sh <<'SCRIPT'
xcrun simctl shutdown DEVICE
SCRIPT
sh /tmp/x.sh`,
    `cat <<'SCRIPT' > /tmp/x.sh
"xcr" "un" " sim" "ctl shutdown DEVICE"
SCRIPT
bash /tmp/x.sh`,
    `cat <<'EOF'
xcrun simctl shutdown DEVICE
EOF`,
    `cat <<'EOF' | sh
$(printf xcr) $(printf un) shutdown DEVICE
EOF`,
    `cat <<'EOF' | sh
$(printf xcr) $(printf un) $(printf sim) $(printf ctl) shutdown DEVICE
EOF`,
    `cat <<'EOF' | sh
$(printf '%s' xcr) $(printf '%s' un) $(printf '%s' sim) $(printf '%s' ctl) shutdown DEVICE
EOF`,
    `cat <<'EOF' | sh
$(printf '%s %s' xcr un) $(printf '%s %s' sim ctl) shutdown DEVICE
EOF`,
    `cat <<'EOF' | sh
$(printf 'xcr%s' un) $(printf ' sim%s' ctl) shutdown DEVICE
EOF`,
    `cat <<'EOF' > /tmp/x.sh
$(printf xcr) $(printf un) shutdown DEVICE
EOF
sh /tmp/x.sh`,
    `bash <<< '"xcr" + "un" + " sim" + "ctl shutdown DEVICE"'`,
    `bash <<< '"xcr" "un" " sim" "ctl shutdown DEVICE"'`,
    `echo '"xcr" "un" " sim" "ctl shutdown DEVICE"' | sh`,
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
    `python3 - <<'PY'
import json
__import__("json")
print(json.dumps({"ok": True}))
PY`,
    `python3 - <<'PY'
from xml.etree import ElementTree as ET
ET.fromstring("<a/>")
PY`,
    `node - <<'JS'
const data = JSON.parse('{"a":1}');
console.log(data);
JS`,
    `node - <<'JS'
(async () => {})().catch((err) => { console.error(err); });
JS`,
    `swift - <<'SW'
let x = { (a: Int) -> Int in a * 2 }(21)
print(x)
SW`,
    `perl - <<'PL'
my $x = join(",", (1..5));
print $x;
PL`,
    `cat <<'EOF'
{"data": [1, 2, 3]}
EOF`,
    `cat <<EOF
{"data": [1, 2, 3]}
EOF`,
    `python3 -c 'import sys; print(sys.stdin.read())' <<'PY'
{"data": [1, 2, 3]}
PY`,
    `echo "$(python3 - <<'PY'
print("ok")
PY
)"`,
    `python3 - <<'PY.SH'
import json
print(json.dumps({"ok": True}))
PY.SH`,
    `python3 - <<'A' <<'B'
print("a")
A
print("b")
B`,
    `python3 - <<-'PY'
	print("hi")
	PY`,
    `python3 - <<PY
	PY
print("hi")
PY`,
    `python3 - <<'PY'
print("a")
PY
node - <<'JS'
console.log("b")
JS`,
    `python3 - <<'PY'
print("hello", "world")
parts = ["a", "b"]
PY`,
    `echo '<<END'`,
    `python3 - <<'PY'  # note
print("hi")
PY`,
    `python3 - <<'PY'
print(x) <<END
PY`,
    `python3 - <<'END!'
import json
print(json.dumps({"ok": True}))
END!`,
    `python3 - <<'PY'
print([1, 2, 3])
colors = [(120, 99, 114), (65, 66, 67)]
print(colors)
PY`,
    `python3 - <<'PY'
print(chr(65))
PY`,
    `python3 - <<'PY'
print(chr(65+0))
PY`,
    `python3 - <<'PY'
print(chr(n))
PY`,
    `python3 - <<'PY'
print([1*2, 3+4])
PY`,
    `python3 - <<'PY'
def g(n): return n
print(chr(g(65)))
PY`,
    `python3 - <<'PY'
print("\\x78foo")
PY`,
    `python3 -c 'x = "
a <<END
b
"'
`,
    `python3 - <<'PY'
import base64
print(base64.b64decode("aGVsbG8gd29ybGQ="))
PY`,
    `node - <<'JS'
const name = "world";
console.log(\`hello \${name}\`);
JS`,
    `cat <<<hello`,
    `cat <<< 'simctl'`,
    `awk -f - <<'AWK'
print("hi")
AWK`,
    `awk '{print}' <<'AWK'
data line
AWK`,
    `awk -f script.awk <<'AWK'
data line
AWK`,
    `python3 - <<PY:
print("hi")
PY:`,
    `python3 - <<PY+
print("hi")
PY+`,
    `awk -f- <<'AWK'
print("hi")
AWK`,
    `awk -v x=1 <<'AWK'
print(x)
AWK`,
    `python3 - <<'PY'
print("hello"[::-1])
PY`,
    `python3 - <<'PY'
arr = [1, 2, 3]
print(arr[::-1])
PY`,
    `awk -f /dev/stdin <<'AWK'
print("hi")
AWK`,
    `cat <<'EOF'
{"data": [1, 2, 3]}
EOF`,
    `grep foo <<'EOF'
line one
line two
EOF`,
    `cat <<'EOF'
hello world
EOF`,
    `cat <<'EOF' | sh
echo hello
EOF`,
    `bash <<< 'echo hello'`,
    `echo 'echo hello' | sh`,
    `cat <<'EOF' | sh
printf '%s' "$var"
EOF`,
    `cat <<'EOF' | sh
$(printf '%s' hello)
EOF`,
    `cat <<'EOF' | sh
$(printf '%d' 42)
EOF`,
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
    'echo "$UNTRUSTED_EXECUTABLE"',
    '# ordinary shell comment',
    '#!/bin/sh\necho ordinary',
    'command -v "$UNTRUSTED_EXECUTABLE"',
    '[ -n "$UNTRUSTED_EXECUTABLE" ]',
    '[[ -n "$UNTRUSTED_EXECUTABLE" ]]',
    '(( 1 + 2 > 0 ))',
    'if (( 3 > 0 )); then echo ready; fi',
    'sudo ls "$ORDINARY_PATH"',
    'sudo -u "$ORDINARY_USER" /bin/echo ok',
    'sudo FOO=bar /bin/echo "$ORDINARY_VALUE"',
    'sudo >/dev/null /bin/echo "$ORDINARY_VALUE"',
    'xargs echo "$ORDINARY_VALUE"',
    'xargs -n "$ORDINARY_COUNT" /bin/echo ok',
    `sandbox-exec -p '(version 1) (allow default)' /bin/echo "$ORDINARY_VALUE"`,
    'sandbox-exec -p "$ORDINARY_PROFILE" /bin/echo ok',
    'launchctl submit -l "$ORDINARY_LABEL" -- /bin/echo ok',
    'launchctl asuser "$ORDINARY_UID" /bin/echo ok',
    'launchctl bsexec "$ORDINARY_PID" /bin/echo "$ORDINARY_VALUE"',
    'watch -d /bin/echo "$ORDINARY_VALUE"',
    'time -l /bin/echo "$ORDINARY_VALUE"',
    'script -q /tmp/typescript /bin/echo "$ORDINARY_VALUE"',
  ])('allows a non-bypass command: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });
});
