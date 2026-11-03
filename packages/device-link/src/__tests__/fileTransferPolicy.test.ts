import { expect, it } from "vitest";
import {
  createFileTransferWatchdog,
  filePeerReuseMs,
  fileTransferPath,
  FILE_PEER_COMMAND_TIMEOUT_MS,
  FILE_PEER_RECEIVE_TIMEOUT_MS,
} from "../fileTransferPolicy";

it("uses the advertised lifetime minus a command budget, rejecting invalid capabilities", () => {
  expect(filePeerReuseMs(undefined, true)).toBeNull();
  expect(filePeerReuseMs(300_000, 'true')).toBe(285_000);
  expect(filePeerReuseMs(300_000)).toBe(285_000);
  expect(filePeerReuseMs(60_000)).toBe(45_000);
  for (const value of [undefined, NaN, Infinity, -1])
    expect(filePeerReuseMs(value)).toBe(30_000);
});
it("does not abandon a progressing transfer just because its KB/s is low", () => {
  let time = 0;
  const watch = createFileTransferWatchdog(() => time);
  for (time = 1000; time <= 25_000; time += 1000)
    expect(watch(time * 150)).toBeNull();
  expect(fileTransferPath('{"path":"relay","rttMs":300}')).toBe("relay");
  expect(fileTransferPath("invalid")).toBe("unknown");
});
it("keeps a progressing 806 MB download until completion regardless of route", () => {
  let time = 0;
  const size = 805_998_643;
  const watch = createFileTransferWatchdog(() => time);
  // Reported transfer: 2 MiB received in 15 seconds, with progress every second.
  // Replay the whole download using a fake clock, including the old 15s cutoff.
  let written = 0;
  while (written < size) {
    time += 1000;
    written = Math.min(size, Math.floor((2 * 1024 ** 2 * time) / 15_000));
    expect(watch(written)).toBeNull();
  }
  expect(time).toBeGreaterThan(FILE_PEER_RECEIVE_TIMEOUT_MS);
});
it("isolates stalled peers and still detects a missing EOF after all bytes arrived", () => {
  let time = 0;
  const stalled = createFileTransferWatchdog(() => time);
  const healthy = createFileTransferWatchdog(() => time);
  for (time = 1000; time < FILE_PEER_COMMAND_TIMEOUT_MS; time += 1000) {
    expect(stalled(0)).toBeNull();
    expect(healthy(Math.min(time * 100, 1_000_000))).toBeNull();
  }
  expect(stalled(0)).toBe("stalled");
  time = 10_000 + FILE_PEER_COMMAND_TIMEOUT_MS;
  expect(healthy(1_000_000)).toBe("stalled");
});
it("renews the stall deadline only when more bytes arrive", () => {
  let time = 0;
  const watch = createFileTransferWatchdog(() => time);
  time = FILE_PEER_COMMAND_TIMEOUT_MS - 1;
  expect(watch(1_000_000)).toBeNull();
  time += FILE_PEER_COMMAND_TIMEOUT_MS - 1;
  expect(watch(1_000_000)).toBeNull();
  time++;
  expect(watch(1_000_000)).toBe("stalled");
});
