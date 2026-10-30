import { restoreDiagnosticEvents } from "./diagnosticEvents";

/** Desktop SLS web-tracking wire contract, with mobile's narrower event projection. */
export interface DiagnosticUploadTarget {
  region: string;
  project: string;
  logstore: string;
  endpointHost: string;
}
export function parseDiagnosticUploadTarget(
  raw: string,
  region: string,
): DiagnosticUploadTarget | null {
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.region !== region ||
      !["cn", "global", "dev"].includes(region)
    )
      return null;
    if (
      typeof value.project !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(value.project)
    )
      return null;
    if (
      typeof value.logstore !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(value.logstore)
    )
      return null;
    if (
      typeof value.endpointHost !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\.log\.aliyuncs\.com$/.test(value.endpointHost)
    )
      return null;
    return {
      region,
      project: value.project,
      logstore: value.logstore,
      endpointHost: value.endpointHost,
    };
  } catch {
    return null;
  }
}

export type DiagnosticUploadResult =
  | { kind: "uploaded"; uploadCode: string; count: number }
  | { kind: "unavailable" | "consentRequired" | "empty" | "failed" };

/** Dependencies keep tests offline and keep native/auth modules out of the wire contract. */
export interface DiagnosticUploadDeps {
  rawTarget: string;
  region: string;
  consent(): Promise<boolean>;
  snapshot(): Promise<unknown>;
  randomBytes(size: number): Uint8Array;
  fetch(input: string, init: RequestInit): Promise<Response>;
  appVersion: string;
  platform: string;
  osVersion: string;
}

export async function uploadDiagnosticSnapshot(
  deps: DiagnosticUploadDeps,
): Promise<DiagnosticUploadResult> {
  const target = parseDiagnosticUploadTarget(deps.rawTarget, deps.region);
  if (!target) return { kind: "unavailable" };
  try {
    if (!(await deps.consent())) return { kind: "consentRequired" };
    const events = restoreDiagnosticEvents(await deps.snapshot());
    if (!events.length) return { kind: "empty" };
    // Same readable alphabet and XXXX-XXXX format as desktop; rejection sampling avoids bias.
    const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    let code = "";
    for (let attempt = 0; code.length < 8 && attempt < 32; attempt++) {
      for (const byte of deps.randomBytes(16)) {
        if (byte < limit) code += alphabet[byte % alphabet.length];
        if (code.length === 8) break;
      }
    }
    if (code.length !== 8) return { kind: "failed" };
    const uploadCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    const body = JSON.stringify({
      __topic__: "cindy-client-log",
      __source__: "mobile",
      __tags__: {
        uploadCode,
        region: target.region,
        reason: "manual",
        appVersion: deps.appVersion.slice(0, 80),
        platform: deps.platform === "ios" ? "ios" : "android",
        osVersion: deps.osVersion.slice(0, 80),
      },
      __logs__: events.map((event) => ({
        ts: new Date(event.at).toISOString(),
        level: "info",
        src: "mobile",
        scope: "mobile-diagnostics",
        msg: JSON.stringify({ event: event.event, ...event.fields }),
        uploadCode,
      })),
    });
    const size = new TextEncoder().encode(body).byteLength;
    // 500 bounded events fit in one desktop-sized batch. Refuse, never silently truncate a payload.
    if (size > 1024 * 1024) return { kind: "failed" };
    if (!(await deps.consent())) return { kind: "consentRequired" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await deps.fetch(
        `https://${target.project}.${target.endpointHost}/logstores/${target.logstore}/track`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-log-apiversion": "0.6.0",
            "x-log-bodyrawsize": String(size),
          },
          body,
          signal: controller.signal,
          credentials: "omit",
          redirect: "error",
        },
      );
      return response.status >= 200 && response.status < 300
        ? { kind: "uploaded", uploadCode, count: events.length }
        : { kind: "failed" };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { kind: "failed" };
  }
}
