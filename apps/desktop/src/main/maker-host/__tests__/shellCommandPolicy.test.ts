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

  // Documentation puts these prefixes in front of a recipe, so the recipe is
  // still spelled out and still reachable by reading the command word.
  it.each([
    'exec /usr/bin/xcrun simctl shutdown DEVICE',
    'command xcrun simctl boot DEVICE',
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
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; eval "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; sh -c "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; $CMD',
    'time xcrun simctl shutdown DEVICE',
    `function f () ( printf '%s' "$(date)"; /usr/bin/open -a Simulator ); f`,
    '/usr/bin/xcrun \\\n simctl shutdown DEVICE',
    '/usr/bin/nice /usr/bin/xcrun simctl erase DEVICE',
    '/usr/bin/arch /usr/bin/xcrun simctl boot DEVICE',
    '/usr/bin/caffeinate /usr/bin/xcrun simctl shutdown DEVICE',
    'xargs /usr/bin/xcrun simctl shutdown DEVICE',
    'timeout 30 xcrun simctl boot DEVICE',
    'timeout 1.5s gtimeout 2m xcrun simctl erase DEVICE',
    // A shell option that takes a value must not be read as the script operand.
    // Unlike a prefix, a shell's `-c` scan can only ever miss when it reads an
    // option wrongly, so the two value-taking options stay modelled here.
    "bash -o pipefail -c 'xcrun simctl shutdown DEVICE'",
    "bash -O extglob -c 'xcrun simctl shutdown DEVICE'",
    "bash +O extglob -c 'xcrun simctl boot DEVICE'",
    "zsh -o extendedglob -c 'xcrun simctl shutdown DEVICE'",
    // A stored recipe counts once something runs the variable that holds it.
    `CMD='xcrun simctl shutdown DEVICE'; eval "\${CMD}"`,
    `CMD='xcrun simctl boot DEVICE'; bash -lc "$CMD"`,
    `CMD='xcrun simctl boot DEVICE'; echo start; eval "$CMD"`,
    // An assignment builtin stores a recipe just like a bare `NAME=value`.
    `export CMD='xcrun simctl shutdown DEVICE'; eval "$CMD"`,
    `readonly CMD='xcrun simctl boot DEVICE'; eval "$CMD"`,
    `declare CMD='open -a Simulator'; eval "$CMD"`,
    `typeset CMD='xcrun simctl erase DEVICE'; eval "$CMD"`,
    `export -p CMD='xcrun simctl boot DEVICE'; eval "$CMD"`,
    // Heredoc reduction must not let a fake marker in a comment swallow a real
    // following command, and CRLF delimiters must end the data region correctly.
    `echo hi # <<'EOF'\nxcrun simctl shutdown DEVICE`,
    `cat <<'EOF'\r\ntext\r\nEOF\r\nxcrun simctl shutdown DEVICE`,
    `cat <<$'EOF' >/dev/null\ntext\nEOF\nxcrun simctl shutdown DEVICE`,
    `cat <<$"EOF" >/dev/null\ntext\nEOF\nxcrun simctl shutdown DEVICE`,
    // Arithmetic left-shift uses the same `<<` spelling as a heredoc opener;
    // it must not make the following command look like a body for delimiter 2.
    `echo $((1 << 2))\nxcrun simctl shutdown DEVICE`,
    `(( 1 << 2 ))\nxcrun simctl shutdown DEVICE`,
    `echo $[1 << 2]\nxcrun simctl shutdown DEVICE`,
  ])('denies a literal recipe behind a documentation-style prefix: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  // ── An option on the prefix ends the peel ──────────────────────────────────
  //
  // Each command below was denied while the policy carried a per-prefix table of
  // which options consume the following token. Maintaining that table meant
  // encoding two things about every CLI: its option arity, and whether the
  // operands are executed at all. Getting either wrong denies ordinary work, and
  // both kept being wrong — `bash -O`, then `command -v`, then `sudo -l`, one per
  // review round. Stopping at the first option can only miss, so the table is
  // gone and these forms are missed on purpose.
  //
  // Documentation spells a recipe as `sudo xcrun simctl boot …`, not
  // `sudo -u me xcrun simctl boot …`; the plain spelling of every prefix above is
  // still covered. All of these were also allowed before the embedded simulator
  // existed, so this restores that behaviour rather than loosening past it.
  it.each([
    'command -p xcrun simctl boot DEVICE',
    'time -p xcrun simctl boot DEVICE',
    'env -u FOO xcrun simctl shutdown DEVICE',
    'env --unset=FOO xcrun simctl shutdown DEVICE',
    'env -C /tmp xcrun simctl shutdown DEVICE',
    'sudo -u me xcrun simctl shutdown DEVICE',
    'sudo --user=me xcrun simctl boot DEVICE',
    'sudo -g staff xcrun simctl shutdown DEVICE',
    'nice -n 5 xcrun simctl shutdown DEVICE',
    'timeout -k 5 30 xcrun simctl shutdown DEVICE',
    'xargs -n 1 xcrun simctl shutdown DEVICE',
    'xargs -I{} xcrun simctl boot {}',
    'arch -arch arm64 xcrun simctl shutdown DEVICE',
    '/usr/bin/arch -arm64 /usr/bin/xcrun simctl boot DEVICE',
    'caffeinate -t 60 xcrun simctl shutdown DEVICE',
    '/usr/bin/caffeinate -i /usr/bin/xcrun simctl shutdown DEVICE',
    'exec -a label xcrun simctl shutdown DEVICE',
    'exec -a label /usr/bin/xcrun simctl boot DEVICE',
    'exec -cl -a label xcrun simctl erase DEVICE',
  ])('no longer denies a recipe behind an option-bearing prefix: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  // A stored recipe is only a recipe once something runs it. Classifying every
  // assignment denied commands that print or write the string and execute
  // nothing — and printing a command is exactly what a script does while
  // explaining itself.
  it.each([
    `CMD='xcrun simctl shutdown DEVICE'; printf '%s\\n' "$CMD"`,
    `CMD='xcrun simctl boot DEVICE'; echo "$CMD"`,
    `CMD='open -a Simulator'; echo "$CMD" > /tmp/note.txt`,
    `export CMD='xcrun simctl erase DEVICE'; echo "$CMD"`,
    `CMD='xcrun simctl boot DEVICE'; echo done`,
    `CMD='xcrun simctl boot DEVICE'`,
    `readonly DOC='run xcrun simctl boot DEVICE to start'; printf '%s' "$DOC"`,
    // A different name reaches the execution site, so this value never runs.
    `CMD='xcrun simctl boot DEVICE'; eval "$OTHER"`,
    // The execution point sees the latest value, not the complete assignment
    // history. The stored recipe was replaced before anything ran it.
    `CMD='xcrun simctl shutdown DEVICE'; CMD='echo safe'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; CMD='echo safe'; eval "$CMD" 2>&1`,
    `CMD='xcrun simctl shutdown DEVICE'; echo if; CMD='echo safe'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE' && true; CMD='echo safe'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'
CMD='echo safe'
eval "$CMD"`,
    // A lone background separator is complete before the newline, so the next
    // assignment is unconditional in the parent shell and replaces the value.
    `CMD='xcrun simctl shutdown DEVICE'; false &\nCMD='echo safe'; eval "$CMD"`,
    // A command-scoped assignment shadows the exported parent value only for
    // that child command.
    `CMD='xcrun simctl shutdown DEVICE'; CMD='echo safe' sh -c '$CMD'`,
  ])('allows a stored recipe that nothing executes: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  it.each([
    `CMD='xcrun simctl shutdown DEVICE'; eval "$CMD"; CMD='echo safe'`,
    `CMD='echo safe'; CMD='xcrun simctl shutdown DEVICE'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; OTHER='echo safe'; eval "$CMD"`,
    // An assignment attached to another command only changes that command's
    // environment; it must not replace the shell-scoped value used by eval.
    `CMD='xcrun simctl shutdown DEVICE'; CMD='echo safe' /usr/bin/true; eval "$CMD"`,
    `CMD='echo safe'; CMD='xcrun simctl shutdown DEVICE' sh -c '$CMD'`,
    // The later text is not a guaranteed replacement when control flow can skip
    // it or keep it inside a child scope, so the earlier value stays possible.
    `CMD='xcrun simctl shutdown DEVICE'; false && CMD='echo safe'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; false &&\nCMD='echo safe'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; true ||\nCMD='echo safe'; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; printf ignored |\nCMD='echo safe'; eval "$CMD"`,
    // A comment's separators and assignments are not shell syntax. Quoted
    // hashes remain ordinary data and must not disable comment scanning.
    `CMD='xcrun simctl shutdown DEVICE'; # note; CMD='echo safe'\neval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; echo "# not a comment"; eval "$CMD"`,
    // Assignments in a pipeline or background segment run in a child shell;
    // they cannot replace the parent value consumed by the later eval.
    `CMD='xcrun simctl shutdown DEVICE'; CMD='echo safe' & eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; CMD='echo safe' | /usr/bin/cat; eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; (CMD='echo safe'); eval "$CMD"`,
    `CMD='xcrun simctl shutdown DEVICE'; if false; then CMD='echo safe'; fi; eval "$CMD"`,
    // `local` fails outside a function, and function bodies are intentionally
    // outside this literal-recipe parser. It cannot prove a top-level override.
    `CMD='xcrun simctl shutdown DEVICE'; local CMD='echo safe'; eval "$CMD"`,
  ])('denies the current stored recipe at its execution point: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  // A recipe pasted into an interpreter one-liner is still literal text.
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
    `osascript -e 'set cmd to "/usr/bin/xcrun simctl shutdown DEVICE"' -e 'do shell script cmd'`,
    `osascript -l JavaScript -e 'ObjC.import("Foundation"); const task = $.NSTask.alloc.init; task.launchPath = "/usr/bin/xcrun"; task.arguments = ["simctl", "shutdown", "DEVICE"]; task.launch'`,
    `python3 -c 'import subprocess; subprocess.run(["/usr/bin/open","-a","Simulator"])'`,
    `node -e 'require("child_process").spawnSync("/usr/bin/open",["-na","Simulator"])'`,
    `ruby -e 'system("/usr/bin/open", "-a", "Simulator")'`,
    `/usr/bin/expect -c 'spawn /usr/bin/xcrun simctl shutdown DEVICE; expect eof'`,
    // The consumer can also follow the marker, so the heredoc's own pipeline —
    // not just the text before `<<` — decides whether the body is executable.
    `cat <<'SH' | sh
xcrun simctl boot DEVICE
SH`,
    `cat <<'SH' |
echo safe
SH
xcrun simctl shutdown DEVICE`,
    `cat <<'SH' | bash -s
xcrun simctl shutdown DEVICE
SH`,
    `cat <<'SH' | env FOO=1 bash
xcrun simctl erase DEVICE
SH`,
    `cat <<'SH' | bash | cat
open -a Simulator
SH`,
    `bash 2>/dev/null <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `bash>/dev/null <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `bash &>/dev/null <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `bash {log}>/dev/null <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `bash 0<<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `cat <<'SH' | bash 2>/dev/null
open -a Simulator
SH`,
    // Multiple stdin heredocs on one consumer: only the last body reaches bash.
    `bash <<'DATA' <<'CODE'
echo safe
DATA
xcrun simctl shutdown DEVICE
CODE`,
    `cat <<'DATA' | bash <<'CODE'
echo safe
DATA
xcrun simctl shutdown DEVICE
CODE`,
    `printf '<<SH'; cat <<SH | bash
xcrun simctl shutdown DEVICE
SH`,
    // A non-zero fd redirection leaves stdin connected to the pipeline, so the
    // downstream shell still executes the producer's body.
    `cat <<'DATA' | bash 2<err
xcrun simctl shutdown DEVICE
DATA`,
    `cat <<'DATA' | bash {fd}<err
xcrun simctl shutdown DEVICE
DATA`,
    `cat <<'SH' | bash -s $((1 << 2))
xcrun simctl shutdown DEVICE
SH`,
    `cat <<'SH' | bash -s $[1 << 2]
xcrun simctl shutdown DEVICE
SH`,
    `cat <<'SH' | bash -o pipefail
xcrun simctl shutdown DEVICE
SH`,
    `cat <<'SH' | bash -O extglob
xcrun simctl shutdown DEVICE
SH`,
    `cat <<'DATA' | bash -s $(printf foo < /tmp/x)
xcrun simctl shutdown DEVICE
DATA`,
    // An unquoted delimiter still expands, so the body's substitutions run.
    `cat <<MSG
$(xcrun simctl boot DEVICE)
MSG`,
    `cat <<MSG
\`xcrun simctl shutdown DEVICE\`
MSG`,
    // Quote removal happens during tokenization exactly as a shell performs it,
    // so an interrupted spelling is still a literal recipe.
    `bash <<'SH'
xcr"un" sim"ctl" shutdown DEVICE
SH`,
    // Only the executor is assembled here; `simctl shutdown DEVICE` is spelled out.
    `python3 -c "import os; os.system(''.join(['xc','run']) + ' simctl shutdown DEVICE')"`,
  ])('denies a literal recipe inside an interpreter payload: %s', (command) => {
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

  // A heredoc body, an inline interpreter program and an arithmetic expression
  // are not shell argv. Classifying their contents as command words denied
  // ordinary work with no Simulator executor anywhere in the command.
  it.each([
    // Ordinary HTTPS read through a Python heredoc (issue #2404).
    `python3 - <<'PY'
import urllib.request
data = urllib.request.urlopen("https://example.com").read()
print(len(data))
PY`,
    `python3 - <<'PY'
print(1)
PY`,
    `python3 - <<'PY'
def main():
    print("hi")
main()
PY`,
    `node <<'JS'
console.log(1)
JS`,
    `sqlite3 /tmp/app.db <<'SQL'
SELECT count(*) FROM items;
SQL`,
    `jq . <<'JSON'
{"a": 1}
JSON`,
    `cat > /tmp/notes.txt <<'EOF'
hello (world)
EOF`,
    `cat > README.md <<'EOF'
xcrun simctl shutdown DEVICE
open -a Simulator
EOF`,
    `cat > README.md <<EOF
xcrun simctl shutdown DEVICE
open -a Simulator
EOF`,
    // A trailing pipe does not make the next physical line a consumer: it is
    // still heredoc body data. The command after the delimiter is separate.
    `cat <<'SH' |
xcrun simctl shutdown DEVICE
SH
bash`,
    `cat <<'DATA' |
xcrun simctl shutdown DEVICE
DATA`,
    `cat <<$'EOF' >/dev/null
xcrun simctl shutdown DEVICE
EOF`,
    // A commit message written through a heredoc is stdin data, never argv. A
    // line starting with a Markdown backtick span used to read as an executable
    // position filled by an unresolvable expansion, which denied the commit and
    // interrupted the turn — with no Simulator executor anywhere in the command.
    `git commit -s -F - <<'MSG'
fix(scope): 收窄判据

验证：\`pnpm --filter desktop typecheck\` 通过，\`@cindy/ios-simulator-runtime\` 36 文件
\`pnpm test:unit\` 全绿
MSG`,
    `git commit -F - <<'MSG'
\`ls\`
MSG`,
    `git commit -F - <<'MSG'
xcrun simctl shutdown DEVICE
MSG`,
    `git commit -F - <<MSG
xcrun simctl shutdown DEVICE
MSG`,
    `git commit 2>/dev/null -F - <<'MSG'
xcrun simctl shutdown DEVICE
MSG`,
    `bash '2>/dev/null' <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `bash '&>/dev/null' <<'SH'
xcrun simctl shutdown DEVICE
SH`,
    `git commit &>/dev/null -F - <<'MSG'
xcrun simctl shutdown DEVICE
MSG`,
    // A quoted delimiter suppresses expansion in every spelling, and `<<-`
    // strips leading tabs from the body and the closing delimiter.
    `git commit -F - <<"MSG"
\`ls\`
MSG`,
    `git commit -F - <<\\MSG
\`ls\`
MSG`,
    `git commit -F - <<-'MSG'
\t\`ls\`
\tMSG`,
    // An unquoted delimiter expands, but running `ls` to build the body is not a
    // Simulator bypass; only the substitution's own command is classified.
    `git commit -F - <<MSG
\`ls\` 通过
MSG`,
    `cat <<'A' > /tmp/a && cat <<'B' > /tmp/b
\`ls\`
A
\`pwd\`
B`,
    // An unterminated body must not fall back to argv classification either.
    `git commit -F - <<'MSG'
\`ls\``,
    `git commit -F - <<'MSG'
说明：不要直接用 simctl，走 cindy_ios_simulator
MSG`,
    `node -e "
function check() {
  console.log(1);
}
check();
"`,
    `python3 -c "
def check():
    print(1)
check()
"`,
  ])('allows an ordinary interpreter heredoc or inline program: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  it.each([
    'n=3; (( n > 1 )) && echo yes',
    'i=0; (( i++ )); echo "$i"',
    '(( $# > 0 )) && echo has-args',
    '(( $? == 0 )) && echo ok',
    'echo $((1 << 2))',
    'echo $[1 << 2]',
    '(( 1 << 2 ))',
    'i=0; while (( i < 3 )); do echo "$i"; i=$((i+1)); done',
    'if (( count > 0 )); then echo ready; fi',
  ])('allows shell arithmetic with no Simulator evidence: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  it.each([
    'echo start\n*.ts\necho done',
    // A redirected group leaves `}` in command position, which is a shell
    // control token, not a glob-expanded executable name.
    '{ echo a; echo b; } > /tmp/out.log 2>&1',
    '{ pnpm build; pnpm test; } 2>&1 | tee /tmp/build.log',
    '( cd /tmp && ls ) > /tmp/out.txt',
    'expected=200; actual=$(curl -s -o /dev/null -w \'%{http_code}\' https://example.com); if [ "$expected" != "$actual" ]; then echo bad; fi',
    'rg -n "Rejected\\((.*)\\)" apps',
    "rg -n foo --glob '*.{ts,tsx}' apps",
    'grep -rEn "(foo|bar)" apps',
    "awk '{print $1}' /tmp/app.log",
    'ls /tmp/[abc]*.log',
    'cp file.{ts,ts.bak}',
    // Options after the script operand belong to the script, not to the shell.
    // Reading them as a shell program denied ordinary work and interrupted it.
    "bash ./print-args.sh -c 'xcrun simctl shutdown DEVICE'",
    'sh ./run.sh -c "xcrun simctl boot DEVICE"',
    "zsh tools/x.zsh -c 'open -a Simulator'",
    'bash ./build.sh --release',
    // Some prefixes only report on the command they name. `command -v` prints
    // where it lives and `sudo -l` asks whether it would be permitted; neither
    // runs it. Ending the peel at the option covers them without the policy
    // having to know which prefixes behave this way.
    'command -v simctl shutdown',
    'command -V simctl',
    'command -v xcrun simctl',
    'command -pv simctl boot',
    'sudo -l xcrun simctl boot DEVICE',
    'sudo --list xcrun simctl shutdown DEVICE',
    // The same rule keeps ordinary option-bearing work out of the guard.
    'sudo -u postgres psql -c "select 1"',
    'env -u NODE_OPTIONS pnpm test',
    'timeout -k 5 30 pnpm build',
    'nice -n 10 make -j8',
    'export PATH=/usr/bin:$PATH; echo ok',
  ])('allows an ordinary command whose shape is not an executable: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  // ── Reclassified by the stale-recipe threat model ──────────────────────────
  //
  // Every command below was denied before. Each one disguises the executor:
  // assembling it from variables or string fragments, completing it with a glob
  // or a substitution, forwarding it through eval, or storing it for an opaque
  // wrapper to run. A recipe copied from documentation never looks like this, so
  // none of them are in the threat model this policy defends.
  //
  // They are listed rather than deleted because the change is a deliberate
  // reduction in what the guard claims to stop, and a reviewer should be able to
  // see exactly what moved. Detecting these forms is not achievable from command
  // text anyway — `bash script.sh` carries the executor outside the command
  // entirely — and the machinery that attempted it is what denied ordinary work
  // such as a heredoc body, shell arithmetic and a redirected group.
  it.each([
    "env -S 'xcrun simctl shutdown DEVICE'",
    'printf "xcrun simctl shutdown DEVICE\\n" | sh',
    'f(){ xcrun simctl shutdown DEVICE;}; f',
    'f() ( xcrun simctl shutdown DEVICE ); f',
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
    '(( $COUNT > 0 ))',
    '(( COUNT[$idx]++ ))',
    'if (( $COUNT > 0 )); then echo ready; fi',
    `printf '%s' 'import os; os.system("xcrun simctl shutdown DEVICE")' | python3`,
    `python3 <<'PY'
import os
os.system("xcrun simctl shutdown DEVICE")
PY`,
    `printf '%s' 'exec /usr/bin/xcrun simctl shutdown DEVICE' | /usr/bin/tclsh`,
    `printf '%s' 'import os; os.system("xcrun simctl shutdown DEVICE")' |& python3`,
    `bash <<< 'xcrun simctl shutdown DEVICE'`,
    `zsh <<< 'open -a Simulator'`,
    `bash -c 'source /dev/stdin' <<< 'xcrun simctl shutdown DEVICE'`,
    `bash -c 'eval "$(cat)"' <<< 'xcrun simctl shutdown DEVICE'`,
    `printf 'xcrun simctl shutdown DEVICE' | bash -c 'eval "$(cat)"'`,
    `python3 -c 'import os; os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")'`,
    `node -e 'require("child_process").execSync("xcr" + "un" + " sim" + "ctl shutdown DEVICE")'`,
    `python3 - <<'PY'
import os
os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")
PY`,
    // The downstream heredoc replaces the pipe as bash's stdin, so DATA is
    // ordinary cat input even though it looks like a Simulator recipe.
    `cat <<'DATA' | bash <<'CODE'
xcrun simctl shutdown DEVICE
DATA
echo safe
CODE`,
    `bash <<'DATA' <<'CODE'
xcrun simctl shutdown DEVICE
DATA
echo safe
CODE`,
    `bash 3<<'DATA'
xcrun simctl shutdown DEVICE
DATA`,
    `bash {fd}<<'DATA'
xcrun simctl shutdown DEVICE
DATA`,
    `awk 'BEGIN { system("xcr" "un" " sim" "ctl shutdown DEVICE") }'`,
    'xcr$TAIL boot DEVICE',
    'sim$TAIL shutdown DEVICE',
    'xc$TAIL boot DEVICE',
    '${DIR}crun boot DEVICE',
    'simct$TAIL shutdown DEVICE',
    'sim* shutdown DEVICE',
    '$DIR/build/$NAME --version',
    '"$PWD/build/$NAME" --version',
    '$DIR/simctl/$SUB shutdown DEVICE',
    // A substitution can supply characters in the middle of the name, and the
    // tokenizer splits on the whitespace inside it, so the command word arrives
    // as an unterminated remnant. Contiguity is not a safe test here.
    'si$(printf m)ctl shutdown DEVICE',
    'sim$(printf c)tl shutdown DEVICE',
    'x$(printf c)run simctl shutdown DEVICE',
    'sim`printf c`tl shutdown DEVICE',
    // A character class or brace list holds mutually exclusive candidates, so
    // merging their contents into the core would invent a literal that matches
    // nothing and hide the name the shell can expand to.
    '/usr/bin/[sx]crun s[ai]mctl shutdown DEVICE',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/[sx]imctl shutdown DEVICE',
    '[sx]crun boot DEVICE',
    's[ai]mctl shutdown DEVICE',
    'x{cr,foo}un boot DEVICE',
    's{imc,foo}tl shutdown DEVICE',
    `python3 - <<'PY'
import os
os.system(''.join(('xc','run')) + ' ' + ''.join(('sim','ctl')) + ' shutdown DEVICE')
PY`,
  ])('no longer denies a disguised executor: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  // The deliberate boundary of the narrowing: the executable name is knowable
  // and is not a Simulator executor, so denying it would be a guess about the
  // expansion rather than a product rule. Documented in the PR description.
  it.each([
    '$DIR/build/tool --version',
    'tool$SUFFIX --version',
    'build$SUFFIX --version',
  ])('allows a resolvable non-Simulator executable name: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  // Adjacent string literals are data, not a join. Folding them used to fabricate
  // an executor name out of ordinary interpreter code.
  it.each([
    `python3 -c 'print("xcr", "un")'`,
    `node -e 'console.log(["sim", "ctl"])'`,
    `python3 -c 'print(["sim","ctl"])'`,
  ])('allows adjacent string literals that merely look like fragments: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });
});
