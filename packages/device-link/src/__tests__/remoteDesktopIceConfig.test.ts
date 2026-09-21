import { afterEach, expect, it, vi } from "vitest";
import {
  parseDesktopIceConfig,
  resolveDesktopIceServers,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
} from "../remoteDesktopIceConfig.js";

const servers = [
  {
    urls: [
      "stun:primary.example.test:3478",
      "turn:primary.example.test:3478?transport=udp",
    ],
    username: "temporary",
    credential: "test-only",
  },
  {
    urls: ["turns:backup.example.test:5349?transport=tcp"],
    username: "temporary2",
    credential: "test-only2",
  },
];
const config = () => ({
  iceServers: servers,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
afterEach(() => vi.useRealTimers());

it("accepts slow configuration for every caller and keeps independent requests bounded", async () => {
  vi.useFakeTimers();
  const diagnostic = vi.fn();
  const delayed = resolveDesktopIceServers(
    () => new Promise((resolve) => setTimeout(() => resolve(config()), 5_000)),
    diagnostic,
  );
  const independent = resolveDesktopIceServers(async () => config());
  await vi.advanceTimersByTimeAsync(3_000);
  expect(await independent).toEqual(servers);
  expect(diagnostic).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await delayed).toEqual(servers);
  const stalled = resolveDesktopIceServers(
    () => new Promise(() => {}),
    diagnostic,
  );
  await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS - 1);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await stalled).every((server) => !server.credential)).toBe(true);
  expect(diagnostic.mock.lastCall?.[0].outcome).toBe("timeout");
  expect(vi.getTimerCount()).toBe(0);
});

it("reports only safe result categories and counts without altering returned configuration", async () => {
  const diagnostic = vi.fn();
  expect(
    await resolveDesktopIceServers(async () => config(), diagnostic),
  ).toEqual(servers);
  expect(diagnostic).toHaveBeenLastCalledWith({
    outcome: "configured",
    elapsedMs: expect.any(Number),
    serverCount: 2,
    turnUrlCount: 2,
  });
  for (const [fetch, outcome] of [
    [async () => ({ iceServers: [], expiresAt: null }), "empty"],
    [async () => ({ secret: "private" }), "invalid"],
    [
      async () => {
        throw Object.assign(new Error("private upstream body"), {
          status: 503,
        });
      },
      "request-failed",
    ],
  ] as const) {
    await resolveDesktopIceServers(fetch, diagnostic);
    expect(diagnostic.mock.lastCall?.[0]).toMatchObject({
      outcome,
      turnUrlCount: 0,
    });
  }
  expect(diagnostic.mock.lastCall?.[0].status).toBe(503);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
    /primary|backup|temporary|private|test-only/,
  );
  expect(
    await resolveDesktopIceServers(
      async () => config(),
      () => {
        throw new Error("sink");
      },
    ),
  ).toEqual(servers);
});

it("reports the deadline once and does not emit a late success", async () => {
  vi.useFakeTimers();
  const diagnostic = vi.fn();
  let finish!: (value: unknown) => void;
  const result = resolveDesktopIceServers(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    diagnostic,
  );
  await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS);
  await result;
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(diagnostic.mock.lastCall?.[0]).toMatchObject({
    outcome: "timeout",
    turnUrlCount: 0,
  });
  finish(config());
  await Promise.resolve();
  expect(diagnostic).toHaveBeenCalledTimes(1);
});

it("passes all independent nodes to ICE, strips unrelated response secrets, and reloads on retry", async () => {
  const fetchConfig = vi.fn(async () => ({
    ...config(),
    secret: "must-not-cross-bridge",
  }));
  expect(await resolveDesktopIceServers(fetchConfig)).toEqual(servers);
  expect(await resolveDesktopIceServers(fetchConfig)).toEqual(servers);
  expect(fetchConfig).toHaveBeenCalledTimes(2);
});

it.each([
  "https://example.test/",
  "turn:user:password@example.test:3478",
  "stun:a.test:3478?transport=udp",
  "turn:a.test:99999",
  "turns:a.test:5349?transport=udp",
  "turn:[::::]:3478?transport=udp",
  "turn:a..test:3478?transport=udp",
])("rejects invalid URL %s without echoing it", (url) => {
  expect(() =>
    parseDesktopIceConfig({
      ...config(),
      iceServers: [{ ...servers[0], urls: [url] }],
    }),
  ).toThrow("INVALID_DESKTOP_ICE_CONFIG");
});

it("rejects expired, oversized and missing credentials", () => {
  expect(() =>
    parseDesktopIceConfig({
      ...config(),
      expiresAt: new Date(Date.now() + 119_000).toISOString(),
    }),
  ).toThrow();
  expect(() =>
    parseDesktopIceConfig({ ...config(), expiresAt: new Date().toISOString() }),
  ).toThrow();
  expect(() =>
    parseDesktopIceConfig({
      ...config(),
      iceServers: Array(5).fill(servers[0]),
    }),
  ).toThrow();
  expect(() =>
    parseDesktopIceConfig({
      ...config(),
      iceServers: [{ urls: servers[0].urls }],
    }),
  ).toThrow();
});

it("preserves legacy behavior on an old/disabled/broken server", async () => {
  for (const fetchConfig of [
    async () => {
      throw new Error("404");
    },
    async () => ({ iceServers: [], expiresAt: null }),
    async () => ({ malformed: true }),
  ]) {
    const result = await resolveDesktopIceServers(fetchConfig);
    expect(result).toHaveLength(2);
    expect(
      result.every((s) => s.urls.every((url) => url.startsWith("stun:"))),
    ).toBe(true);
  }
});

it("bounds a stalled API independently of another peer and ignores late credentials", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const slow = resolveDesktopIceServers(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(await resolveDesktopIceServers(async () => config())).toEqual(servers);
  await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS);
  const fallback = await slow;
  finish(config());
  await Promise.resolve();
  expect(fallback[0].username).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
