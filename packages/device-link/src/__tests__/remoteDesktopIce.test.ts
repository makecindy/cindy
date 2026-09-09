import { expect, it } from "vitest";
import { parseRemoteDesktopRequest } from "../remoteDesktop";
import { parseDesktopIceReply } from "../remoteDesktopIce";
const candidate = {
  candidate: "candidate:1 1 UDP 100 192.0.2.1 5000 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
const request = {
  op: "ice",
  lease: "lease",
  attemptId: "attempt",
  after: 0,
  candidates: [candidate],
};
it("projects candidate fields and retains both old and incremental offer shapes", () => {
  expect(
    parseRemoteDesktopRequest({
      ...request,
      candidates: [{ ...candidate, secret: "ignored" }],
    }),
  ).toEqual(request);
  expect(
    parseRemoteDesktopRequest({ op: "offer", lease: "lease", sdp: "sdp" }),
  ).toEqual({ op: "offer", lease: "lease", sdp: "sdp" });
  for (const settings of [undefined, { fps: 30, bitrate: 0, audio: false }])
    expect(
      parseRemoteDesktopRequest({
        op: "offer",
        lease: "lease",
        sdp: "sdp",
        attemptId: "new",
        settings,
      }),
    ).toMatchObject({ attemptId: "new" });
});
it.each([
  { attemptId: "" },
  { attemptId: "a".repeat(129) },
  { lease: "" },
  { after: -1 },
  { after: 129 },
  { after: 0.5 },
  { candidates: Array(17).fill(candidate) },
  { candidates: [{ ...candidate, candidate: "a".repeat(2049) }] },
  { candidates: [{ ...candidate, sdpMid: null, sdpMLineIndex: null }] },
  { candidates: [{ ...candidate, sdpMLineIndex: 32 }] },
  { candidates: [{ ...candidate, usernameFragment: 7 }] },
])("rejects unbounded or malformed signaling %j", (bad) => {
  expect(() => parseRemoteDesktopRequest({ ...request, ...bad })).toThrow();
});
it("validates host replies independently from requests", () => {
  expect(
    parseDesktopIceReply({
      attemptId: "attempt",
      next: 1,
      complete: false,
      candidates: [candidate],
    }),
  ).toMatchObject({ next: 1 });
  expect(() =>
    parseDesktopIceReply({
      attemptId: "attempt",
      next: 129,
      complete: false,
      candidates: [],
    }),
  ).toThrow();
  expect(() =>
    parseDesktopIceReply({
      attemptId: "attempt",
      next: 0,
      complete: 1,
      candidates: [],
    }),
  ).toThrow();
});
