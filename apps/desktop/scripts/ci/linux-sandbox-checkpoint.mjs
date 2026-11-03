// Explicit permission handoff only; never elevates or launches the application.
// Identity snapshots detect changes, but require an exclusively owned build
// output: separate lstat/read calls are not protection against concurrent writes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function directories(outRoot, appDir, uid) {
  if (path.dirname(appDir) !== outRoot) throw new Error('Unexpected packaged app directory');
  return [outRoot, appDir].map((dir) => {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(dir) !== dir ||
        s.uid !== uid || (s.mode & 0o022) !== 0) {
      throw new Error('Packaged directory identity or ownership is unsafe: ' + dir);
    }
    return { path: dir, dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode: s.mode };
  });
}

function helperState(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Sandbox helper must be a regular file');
  return { dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid,
    mode: s.mode & 0o7777, nlink: s.nlink, sha256: digest(file) };
}

export function assertPreparedLinuxSandbox(before, after) {
  if (JSON.stringify(before.dirs) !== JSON.stringify(after.dirs) ||
      before.helper.dev !== after.helper.dev || before.helper.sha256 !== after.helper.sha256) {
    throw new Error('Packaged sandbox identity or bytes changed during preparation');
  }
  const s = after.helper;
  if (s.uid !== 0 || s.gid !== 0 || s.mode !== 0o4755 || s.nlink !== 1) {
    throw new Error('Sandbox helper requires root:root, mode 4755, and exactly one hard link');
  }
  const wasReady = before.helper.uid === 0 && before.helper.gid === 0 &&
    before.helper.mode === 0o4755 && before.helper.nlink === 1;
  if (!wasReady && before.helper.ino === after.helper.ino) {
    throw new Error('Preparation must replace the helper with a private copy before changing ownership');
  }
}

export async function prepareLinuxSandboxCheckpoint(outRoot, appDir) {
  if (process.platform !== 'linux' || process.getuid() === 0) {
    throw new Error('Sandbox checkpoint requires an ordinary Linux build user');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Explicit sandbox preparation requires a foreground terminal');
  }
  const uid = process.getuid();
  const helper = path.join(appDir, 'chrome-sandbox');
  const capture = () => ({ dirs: directories(outRoot, appDir, uid), helper: helperState(helper) });
  const before = capture();
  const s = before.helper;
  if (s.uid === 0 && s.gid === 0 && s.mode === 0o4755 && s.nlink === 1) {
    assertPreparedLinuxSandbox(before, capture());
    return;
  }
  console.log(JSON.stringify({ checkpoint: 'linux-sandbox-preparation', helper,
    uid, dirs: before.dirs, original: s }));
  console.log('Prepare only this helper using the approved private-copy/root:root/4755 procedure.');
  console.log('Enter continue only after preparation; any other input or EOF aborts before smoke.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    for await (const line of rl) { answer = line; break; }
  } finally { rl.close(); }
  if (answer !== 'continue') throw new Error('Sandbox preparation aborted');
  assertPreparedLinuxSandbox(before, capture());
}
