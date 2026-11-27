// Node-only entry point used by packaged Linux Host and Desktop. Credentials never enter a renderer.
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { z } from "zod";

const config = z
  .object({
    protocol: z.literal("tencent-init-key-v1").optional(),
    requestId: z.string().uuid(),
    receipt: z.string().regex(/^[\w-]{43}$/),
    membershipId: z.string().min(1).max(191),
    organizationId: z.string().min(1).max(191),
  })
  .strict();
export async function readCloudGuest() {
  if (process.platform !== "linux") return null;
  const name = "/etc/cindy-cloud/enrollment.json";
  let file;
  try {
    const dir = await lstat(path.dirname(name));
    if (!dir.isDirectory() || dir.uid !== 0 || dir.mode & 0o022)
      throw new Error("Invalid cloud enrollment directory");
    file = await open(
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.mode & 0o027 ||
      stat.size > 4096
    )
      throw new Error("Invalid cloud enrollment file");
    return config.parse(JSON.parse(await file.readFile("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}
const dirFor = (guest) =>
  path.join(homedir(), ".local", "state", "cindy-cloud", guest.requestId);
const marker = (guest, key) => path.join(dirFor(guest), key);
export async function cloudGuestSaved(guest) {
  try {
    return (
      (await readFile(marker(guest, "signed-in"), "utf8")) ===
      guest.membershipId
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
const verifierKey = (guest) => "cloud-guest-pkce-" + guest.requestId;

export async function markCloudGuestSaved(guest, store) {
  await mkdir(dirFor(guest), { recursive: true, mode: 0o700 });
  await writeFile(marker(guest, "signed-in"), guest.membershipId, {
    mode: 0o600,
  });
  store.remove(verifierKey(guest));
  await removeLegacyVerifier(guest);
}
// The clean Host has no settings yet. Publish once without replacing later user choices or a concurrently created profile.
export async function initializeCloudHostAccess(userDataDir) {
  const file = path.join(userDataDir, "device-link-settings.json");
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    userDataDir,
    ".cloud-access-" + randomBytes(16).toString("hex"),
  );
  await writeFile(temp, JSON.stringify({ remoteControlEnabled: true }), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temp, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(temp);
  }
}
function origin(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.href !== url.origin + "/")
    throw new Error("Invalid trusted service origin");
  return url.origin;
}
async function removeLegacyVerifier(guest) {
  await unlink(marker(guest, "pkce")).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function verifierFor(guest, store) {
  const key = verifierKey(guest);
  const legacyPath = marker(guest, "pkce");
  const legacy = await open(
    legacyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  let previous;
  if (legacy) {
    try {
      const stat = await legacy.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size !== 64)
        throw new Error("Invalid legacy guest verifier");
      previous = await legacy.readFile("utf8");
      if (!/^[\w-]{64}$/.test(previous))
        throw new Error("Invalid legacy guest verifier");
    } finally {
      await legacy.close();
    }
  }
  const saved = store.read(key);
  const verifier = saved ?? previous ?? randomBytes(48).toString("base64url");
  if (!/^[\w-]{64}$/.test(verifier))
    throw new Error("Unable to resume guest sign-in");
  if (!saved) store.write(key, verifier);
  if (legacy) await removeLegacyVerifier(guest);
  return verifier;
}
// The service turned this guest down for good (revoked receipt, paused delivery, changed owner): retrying cannot help.
class GuestSignInRefused extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
// The service could not answer yet (a network failure, 5xx, or 409 while the computer is still starting).
class GuestSignInUnavailable extends Error {
  constructor(status) {
    super("Guest sign-in temporarily unavailable");
    this.status = status;
  }
}
// The caller no longer wants this sign-in, for example because the owner signed in by hand.
class GuestSignInStopped extends Error {}
/**
 * Why a guest sign-in ended, for logs: a fixed reason, the HTTP status when a service answered and, for the
 * code exchange that follows (AuthApiError), its error code. Never includes the receipt, the verifier, the
 * authorization code or any token.
 */
export function cloudGuestFailureReason(error) {
  const status =
    typeof error?.status === "number" ? error.status
      : error?.name === "AuthApiError" && typeof error.statusCode === "number" ? error.statusCode
        : undefined;
  const code =
    error?.name === "AuthApiError" && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : undefined;
  const reason =
    error instanceof GuestSignInRefused ? "refused"
      : error instanceof GuestSignInUnavailable ? "unavailable"
        : error instanceof GuestSignInStopped ? "stopped"
          : error?.name === "AuthApiError" ? "exchange"
            : error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout"
              : "failed";
  return { reason, ...(status !== undefined && { status }), ...(code && { code }) };
}
const directFetch = (input, init) => globalThis.fetch(input, init);

async function authorize(guest, deviceId, authBase, verifier, serviceFetch) {
  const base = origin(authBase);
  const metadata = "http://169.254.169.254/latest/";
  const request = async (url, init = {}) => {
    // Metadata is local to the instance. Only Cindy service requests use the Host proxy.
    const transport = url.startsWith(metadata) ? directFetch : serviceFetch;
    const response = await transport(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (
        url.startsWith(base + "/") &&
        [400, 401, 403, 404, 410].includes(response.status)
      )
        throw new GuestSignInRefused(
          "Guest authorization is no longer available",
          response.status,
        );
      throw new GuestSignInUnavailable(response.status);
    }
    return response;
  };
  const codeChallenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  let document, signature;
  if (guest.protocol === "tencent-init-key-v1") {
    const file = await open(
      "/etc/cindy-cloud/instance-key.pem",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== 0 ||
        stat.mode & 0o027 ||
        stat.size > 1024
      )
        throw new Error("Invalid cloud instance key");
      const key = createPrivateKey(await file.readFile());
      if (key.asymmetricKeyType !== "ed25519")
        throw new Error("Invalid cloud instance key type");
      document = guest.protocol;
      signature = sign(
        null,
        Buffer.from(
          JSON.stringify([
            document,
            guest.requestId,
            deviceId,
            codeChallenge,
            guest.receipt,
          ]),
        ),
        key,
      ).toString("base64");
    } finally {
      await file.close();
    }
  } else {
    const token = await (
      await request(metadata + "api/token", {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      })
    ).text();
    const headers = { "X-aws-ec2-metadata-token": token };
    [document, signature] = await Promise.all(
      ["document", "signature"].map(async (key) =>
        (
          await request(metadata + "dynamic/instance-identity/" + key, {
            headers,
          })
        ).text(),
      ),
    );
  }
  const result = await (
    await request(
      base + "/api/auth/cloud-computers/" + guest.requestId + "/enroll",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receipt: guest.receipt,
          deviceId,
          codeChallenge,
          document,
          signature,
        }),
      },
    )
  ).json();
  if (
    result.membershipId !== guest.membershipId ||
    result.organizationId !== guest.organizationId ||
    typeof result.code !== "string" ||
    !result.code ||
    result.code.length > 256
  )
    throw new GuestSignInRefused("Guest sign-in identity changed");
  return { code: result.code, verifier };
}

const FIRST_BOOT_MS = 600000;
const FIRST_BOOT_RETRY_MS = 5000;
const LATER_RETRY_MS = 30000;
const LATER_RETRY_MAX_MS = 300000;
const RETRY_REPORT_MS = 3600000;
/**
 * Exchanges this guest's provisioned identity for a sign-in code. While the computer boots it retries every 5 s
 * for 10 minutes. With `persistent`, a guest still signed out keeps trying after that, backing off from 30 s to
 * 5 minutes, so an enrollment service that was down for longer does not leave it at the sign-in screen until
 * the next restart. A refusal ends at once either way, and `stopped()` ends a persistent retry. While it keeps
 * trying past the window, `onRetrying` receives the failure reason when it first starts, when the reason
 * changes, and otherwise at most once an hour.
 */
export async function cloudGuestAuthorization(guest, deviceId, authBase, store, serviceFetch = directFetch, options = {}) {
  const { persistent = false, stopped = () => false, onRetrying } = options;
  const verifier = await store.withLock(() => verifierFor(guest, store));
  const until = Date.now() + FIRST_BOOT_MS;
  let later = LATER_RETRY_MS;
  let reported;
  let reportedAt = 0;
  for (;;) {
    if (stopped()) throw new GuestSignInStopped("Guest sign-in is no longer needed");
    try {
      return await authorize(guest, deviceId, authBase, verifier, serviceFetch);
    } catch (error) {
      if (error instanceof GuestSignInRefused) throw error;
      let delay = FIRST_BOOT_RETRY_MS;
      if (Date.now() + FIRST_BOOT_RETRY_MS >= until) {
        if (!persistent) throw error;
        delay = later;
        later = Math.min(later * 2, LATER_RETRY_MAX_MS);
        const reason = cloudGuestFailureReason(error);
        const key = JSON.stringify(reason);
        if (key !== reported || Date.now() - reportedAt >= RETRY_REPORT_MS) {
          reported = key;
          reportedAt = Date.now();
          onRetrying?.(reason);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
let ready;
export function confirmCloudGuestWhenOnline(modelBase, token, serviceFetch = directFetch) {
  if (process.platform !== "linux" || ready) return;
  ready = (async () => {
    const guest = await readCloudGuest();
    if (!guest) return;
    const base = origin(modelBase());
    if (
      (await readFile(marker(guest, "linked"), "utf8").catch(() => "")) ===
      guest.membershipId
    )
      return;
    const deadline = Date.now() + 3600000;
    while (Date.now() < deadline) {
      const access = token();
      if (access) {
        const claims = JSON.parse(
          Buffer.from(access.split(".")[1], "base64url").toString(),
        );
        if (
          claims.sub !== guest.membershipId ||
          claims.ctx !== "org" ||
          claims.org !== guest.organizationId
        )
          return;
        const response = await serviceFetch(
          base +
            "/api/model-access/personal/cloud-computer/requests/" +
            guest.requestId +
            "/device",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + access,
            },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ receipt: guest.receipt }),
          },
        ).catch(() => undefined);
        if (response?.ok) {
          const receipt = await response.json();
          if (
            receipt.status === "linked" &&
            receipt.deviceId === claims.device
          ) {
            await mkdir(dirFor(guest), { recursive: true, mode: 0o700 });
            await writeFile(marker(guest, "linked"), guest.membershipId, {
              mode: 0o600,
            });
            return;
          }
        } else {
          await response?.body?.cancel();
          if (response?.status === 403 || response?.status === 410) return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5000).unref());
    }
  })()
    .catch(() => {})
    .finally(() => {
      ready = undefined;
    });
}
