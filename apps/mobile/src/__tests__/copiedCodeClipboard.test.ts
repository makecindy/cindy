import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  os: "ios",
  text: "",
  count: 0,
  // Simulates another app writing between our write and the next version read.
  interleave: false,
  version: vi.fn(async () => String(h.count)),
  sync: vi.fn(async (json: string, version: string) => {
    if (String(h.count) !== version) throw new Error("CLIPBOARD_CHANGED");
    h.text = JSON.parse(json).text;
    h.count++;
    return String(h.count);
  }),
  getString: vi.fn(async () => h.text),
  setString: vi.fn(async (value: string) => {
    h.text = value;
    h.count++;
    if (h.interleave) {
      h.interleave = false;
      h.text = "other";
      h.count++;
    }
    return true;
  }),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return h.os;
    },
  },
}));
vi.mock("expo-clipboard", () => ({
  getStringAsync: h.getString,
  setStringAsync: h.setString,
}));
vi.mock("../../modules/cindy-remote-presentation/src", () => ({
  remotePresentation: {
    clipboardVersion: h.version,
    syncClipboard: h.sync,
  },
}));

import { createCopiedCodeClipboard } from "@/plugins/copiedCodeClipboard";

let clipboard: ReturnType<typeof createCopiedCodeClipboard>;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { os: "ios", text: "before", count: 5, interleave: false });
  clipboard = createCopiedCodeClipboard();
});

it("clears its own iOS write by change count without reading the clipboard", async () => {
  const copied = await clipboard.copy("CODE-1");
  expect(copied).toEqual({ code: "CODE-1", version: "6" });
  await clipboard.clear();
  expect(h.text).toBe("");
  expect(h.getString).not.toHaveBeenCalled();
});

it("keeps a later iOS copy, including one that lands before the version read", async () => {
  await clipboard.copy("CODE-1");
  await h.setString("mine");
  await clipboard.clear();
  expect(h.text).toBe("mine");

  h.interleave = true;
  const raced = await clipboard.copy("CODE-2");
  expect(raced.version).toBeUndefined();
  await clipboard.clear();
  expect(h.text).toBe("other");
  expect(h.getString).not.toHaveBeenCalled();
});

it("keeps the latest iOS copy clearable when the user taps copy twice quickly", async () => {
  const [first, second] = await Promise.all([
    clipboard.copy("CODE-1"),
    clipboard.copy("CODE-1"),
  ]);
  expect(first.version).toBe("6");
  expect(second.version).toBe("7");
  await clipboard.clear();
  expect(h.text).toBe("");
});

it("settles copies in call order and lets a failed copy keep the earlier token", async () => {
  const settled: string[] = [];
  h.setString.mockImplementationOnce(async (value: string) => {
    h.text = value;
    h.count++;
    return true;
  });
  h.setString.mockRejectedValueOnce(new Error("write failed"));
  let token: { code: string; version?: string } | undefined;
  await Promise.allSettled([
    clipboard.copy("CODE-1").then((copied) => {
      settled.push("first");
      token = copied;
    }),
    clipboard.copy("CODE-1").then(
      (copied) => {
        token = copied;
      },
      () => settled.push("second-failed"),
    ),
  ]);
  expect(settled).toEqual(["first", "second-failed"]);
  expect(token?.version).toBe("6");
  await clipboard.clear();
  expect(h.text).toBe("");
});

it("compares contents on Android, so returning from the browser still clears the code", async () => {
  h.os = "android";
  await clipboard.copy("CODE-1");
  await clipboard.clear();
  expect(h.text).toBe("");

  await clipboard.copy("CODE-2");
  await h.setString("mine");
  await clipboard.clear();
  expect(h.text).toBe("mine");
});

it.each(["before-read", "write", "after-read"])(
  "releases pending copies when the form ends during %s, including repeated cleanup",
  async (phase) => {
    await clipboard.copy("CODE-1");
    let resume!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => (started = resolve));
    const wait = new Promise<void>((resolve) => (resume = resolve));
    const version = async () => {
      const value = String(h.count);
      started();
      await wait;
      return value;
    };
    if (phase === "before-read") h.version.mockImplementationOnce(version);
    else if (phase === "after-read") {
      h.version.mockImplementationOnce(async () => String(h.count));
      h.version.mockImplementationOnce(version);
    } else {
      h.setString.mockImplementationOnce(async (value) => {
        started();
        await wait;
        h.text = value;
        h.count++;
        return true;
      });
    }
    const copying = clipboard.copy("CODE-2");
    await paused;
    const clearing = clipboard.clear();
    const clearingAgain = clipboard.clear();
    resume();
    const copied = await copying;
    await Promise.all([clearing, clearingAgain]);
    expect(copied.version).toBe("7");
    expect(h.text).toBe("");
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.getString).not.toHaveBeenCalled();
  },
);

it.each(["ios", "android"])(
  "waits for %s cleanup before another form writes a new code",
  async (os) => {
    h.os = os;
    await clipboard.copy("CODE-1");
    let resume!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => (started = resolve));
    const wait = new Promise<void>((resolve) => (resume = resolve));
    if (os === "ios") {
      h.sync.mockImplementationOnce(async (json, version) => {
        started();
        await wait;
        if (String(h.count) !== version) throw new Error("CLIPBOARD_CHANGED");
        h.text = JSON.parse(json).text;
        return String(++h.count);
      });
    } else {
      h.getString.mockImplementationOnce(async () => {
        const value = h.text;
        started();
        await wait;
        return value;
      });
    }
    const clearing = clipboard.clear();
    await paused;
    const newerForm = createCopiedCodeClipboard();
    const copying = newerForm.copy("CODE-2");
    resume();
    await clearing;
    const copied = await copying;
    expect(h.text).toBe("CODE-2");
    if (os === "ios") expect(copied.version).toBe(String(h.count));
    await newerForm.clear();
    expect(h.text).toBe("");
  },
);

it.each(["ios", "android"])(
  "clears the first pending %s copy when released immediately",
  async (os) => {
    h.os = os;
    await Promise.all([
      clipboard.copy("CODE-1"),
      clipboard.clear(),
      clipboard.clear(),
    ]);
    expect(h.text).toBe("");
  },
);

it("does not let an older iOS form clear the newer form's copy of the same code", async () => {
  const newerForm = createCopiedCodeClipboard();
  await clipboard.copy("CODE-1");
  await newerForm.copy("CODE-1");
  await clipboard.clear();
  expect(h.text).toBe("CODE-1");
  await newerForm.clear();
  expect(h.text).toBe("");
});

it("continues after cleanup fails and still releases a queued copy", async () => {
  await clipboard.copy("CODE-1");
  h.sync.mockRejectedValueOnce(new Error("native unavailable"));
  await Promise.all([
    clipboard.clear(),
    clipboard.copy("CODE-2"),
    clipboard.clear(),
  ]);
  expect(h.text).toBe("");
});
