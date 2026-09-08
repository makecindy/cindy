import { describe, expect, it } from "vitest";
import { projectDiagnostic, restoreDiagnosticEvents } from "./diagnosticEvents";

describe("local diagnostic privacy boundary", () => {
  it("drops unknown messages and error contents", () => {
    expect(projectDiagnostic(["secret chat content"])).toBeNull();
    expect(
      projectDiagnostic(
        ["relay connection error", new Error("Bearer secret")],
        10,
      ),
    ).toEqual({ at: 10, event: "relay connection error", fields: {} });
  });
  it("keeps recovery enums and numbers without identities or nested payloads", () => {
    expect(
      projectDiagnostic(
        [
          "recovery phase",
          {
            elapsedMs: 123,
            phase: "history",
            outcome: "applied",
            count: 2,
            peer: "private-device",
            connection: Infinity,
            body: "secret",
            url: "https://private",
          },
        ],
        20,
      ),
    ).toEqual({
      at: 20,
      event: "recovery phase",
      fields: {
        elapsedMs: 123,
        phase: "history",
        outcome: "applied",
        count: 2,
      },
    });
  });
  it("never stores interpolated close reasons or request identifiers", () => {
    const events = [
      projectDiagnostic(
        ["device-link disconnected (code=1001, reason=secret, onlineForMs=2)"],
        1,
      ),
      projectDiagnostic(
        ["device-link request timeout private-id elapsed=12ms"],
        2,
      ),
    ];
    expect(JSON.stringify(events)).not.toMatch(/secret|private-id/);
    expect(
      projectDiagnostic(["device-link online (protocol=v1, elapsedMs=200)"], 3)
        ?.fields,
    ).toEqual({ elapsedMs: 200 });
  });
  it("revalidates saved fields and bounds history", () => {
    const events = restoreDiagnosticEvents(
      Array.from({ length: 1000 }, (_, at) => ({
        at,
        event: "app started",
        fields: { secret: "token" },
        other: "password",
      })),
    );
    expect(events).toHaveLength(500);
    expect(events[0]).toEqual({ at: 500, event: "app started", fields: {} });
    expect(
      restoreDiagnosticEvents([null, { at: NaN, event: "app started" }]),
    ).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/token|password/);
  });
});
