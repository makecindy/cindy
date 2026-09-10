import { REMOTE_DESKTOP_ICE_SERVERS } from "./remoteDesktopIce.js";

export const REMOTE_DESKTOP_ICE_CONFIG_PATH = "/api/device-link/ice-servers";
export const REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS = 3000;
export interface DesktopIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const ICE_URL =
  /^(stun|turn|turns):(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\]):([0-9]{1,5})(\?transport=(udp|tcp))?$/;

/** Strip unknown fields; only short-lived WebRTC credentials may cross the native bridge. */
export function parseDesktopIceConfig(
  value: unknown,
  now = Date.now(),
): DesktopIceServer[] {
  const fail = (): never => {
    throw new Error("INVALID_DESKTOP_ICE_CONFIG");
  };
  if (!value || typeof value !== "object") return fail();
  const v = value as { iceServers?: unknown; expiresAt?: unknown };
  if (!Array.isArray(v.iceServers) || v.iceServers.length > 4) return fail();
  if (v.iceServers.length === 0 && v.expiresAt === null) return [];
  const expires =
    typeof v.expiresAt === "string" ? Date.parse(v.expiresAt) : NaN;
  // Leave room for cold capture setup, SDP exchange and connection checks.
  if (
    !Number.isFinite(expires) ||
    expires <= now + 120_000 ||
    expires > now + 86_400_000
  )
    return fail();
  return v.iceServers.map((server: unknown) => {
    if (!server || typeof server !== "object") return fail();
    const s = server as DesktopIceServer;
    if (!Array.isArray(s.urls) || !s.urls.length || s.urls.length > 4)
      return fail();
    const urls = s.urls.map((url) => {
      if (typeof url !== "string" || url.length > 512) return fail();
      const match = ICE_URL.exec(url);
      if (
        !match ||
        Number(match[2]) < 1 ||
        Number(match[2]) > 65535 ||
        (match[1] === "stun" && match[3]) ||
        (match[1] === "turns" && match[4] !== "tcp")
      )
        return fail();
      try {
        const host = new URL(
          "http://" + url.slice(url.indexOf(":") + 1).split("?")[0],
        ).hostname;
        if (
          !host.startsWith("[") &&
          host
            .split(".")
            .some(
              (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
            )
        )
          return fail();
      } catch {
        return fail();
      }
      return url;
    });
    if (
      !urls.some((url) => /^turns?:/.test(url)) ||
      typeof s.username !== "string" ||
      !s.username.length ||
      s.username.length > 256 ||
      typeof s.credential !== "string" ||
      !s.credential.length ||
      s.credential.length > 256
    )
      return fail();
    return { urls, username: s.username, credential: s.credential };
  });
}

/** Per attempt, no credential cache. A slow/missing API must not hold up legacy connectivity. */
export async function resolveDesktopIceServers(
  fetchConfig: () => Promise<unknown>,
): Promise<DesktopIceServer[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fetchConfig),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("ICE_CONFIG_TIMEOUT")),
          REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
        );
      }),
    ]);
    const servers = parseDesktopIceConfig(value);
    if (servers.length) return servers;
  } catch {
    // No upstream body/error/credential logging. Existing JPEG fallback is independent.
  } finally {
    clearTimeout(timer);
  }
  return REMOTE_DESKTOP_ICE_SERVERS.map((server) => ({ urls: [server.urls] }));
}
