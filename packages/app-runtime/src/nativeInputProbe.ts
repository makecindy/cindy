import {spawn} from 'node:child_process';
export function createNativeInputProbe(resolveDesktopInputBinary:()=>Promise<string>) {


/**
 * Runs the authenticated native helper once per request. Requests travel on
 * stdin so owner values never appear in argv, environment or logs; replies
 * never contain them.
 */
async function runHelper(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const binary = await resolveDesktopInputBinary();
  return new Promise((resolve, reject) => {
    // All three descriptors must be pipes: the helper authenticates its caller on each of them.
    const child = spawn(binary, ['--handoff'], { stdio: 'pipe' });
    child.stderr.resume();
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error('INPUT_HANDOFF_HELPER_TIMEOUT'));
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 8_000_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (settled) return;
      settled = true;
      const line = output.trim();
      if (line === 'permission') return resolve({ error: 'permission' });
      if (code === 77) return resolve({ error: 'unavailable' });
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: code === 0 ? 'invalid' : 'unavailable' });
      }
    });
    // Stdin stays open until the helper exits: it checks who launched it on each descriptor,
    // and a closed one fails that check. The request ends at its newline.
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}


/**
 * Whether typing into this app would land in a password field: the element at
 * a screen point, or the focused element. Used to point the agent at 代输入
 * instead of typing a secret. Unknown (no permission, helper failure) is false.
 */
async function isSecureInputTarget(target: { pid: number; point?: { x: number; y: number } }): Promise<boolean> {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(target.pid) || target.pid <= 0) return false;
  const point = target.point && Number.isFinite(target.point.x) && Number.isFinite(target.point.y)
    ? [target.point.x, target.point.y] : undefined;
  try {
    const result = (await runHelper({ op: 'secure', pid: target.pid, ...(point ? { point } : {}) }, 3000)) as { secure?: unknown };
    return result?.secure === true;
  } catch {
    return false;
  }
}
return {runHelper,isSecureInputTarget};
}
