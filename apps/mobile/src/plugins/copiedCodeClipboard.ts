import { Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";

interface CopiedCode {
  code: string;
  /** iOS change count right after our write; absent when ownership is unproven. */
  version?: string;
}

const iosVersion = () =>
  remotePresentation?.clipboardVersion?.().catch(() => undefined) ??
  Promise.resolve(undefined);

// All forms share one queue: neither copies nor cleanup may interrupt
// another operation's version reads or ownership check.
let pending: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

/** One form owns its token; releasing it also waits for already requested copies. */
export function createCopiedCodeClipboard() {
  let copied: CopiedCode | undefined;
  return {
    copy: (code: string) =>
      enqueue(async () => (copied = await writeCode(code))),
    clear: () =>
      enqueue(async () => {
        const token = copied;
        copied = undefined;
        if (token) await clearCopiedCode(token);
      }),
  };
}

async function writeCode(code: string): Promise<CopiedCode> {
  if (Platform.OS !== "ios") {
    await Clipboard.setStringAsync(code);
    return { code };
  }
  const before = await iosVersion();
  await Clipboard.setStringAsync(code);
  const after = await iosVersion();
  // A single increment proves no other write landed between ours and the read.
  const owned =
    before !== undefined &&
    after !== undefined &&
    Number(after) === Number(before) + 1;
  return owned ? { code, version: after } : { code };
}

/** Clear the clipboard only while it still holds the copied code. */
async function clearCopiedCode(copied: CopiedCode): Promise<void> {
  if (Platform.OS === "ios") {
    // Reading the contents would trigger the iOS paste prompt. The native
    // write compares the change count and clears in one main-queue step.
    if (copied.version !== undefined)
      await remotePresentation
        ?.syncClipboard?.(JSON.stringify({ text: "" }), copied.version)
        .catch(() => {});
    return;
  }
  // Android has no paste prompt; compare the contents.
  if ((await Clipboard.getStringAsync().catch(() => "")) === copied.code)
    await Clipboard.setStringAsync("").catch(() => {});
}
