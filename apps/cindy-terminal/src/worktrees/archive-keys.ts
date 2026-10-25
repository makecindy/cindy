import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** A per-owner wrapping key lives only in the terminal's encrypted vault. The
 * archive journal contains an authenticated envelope, never a recovery secret. */
export function createTerminalArchiveKeys(
  secrets: {
    getSync(key: string): string | null;
    setSync(key: string, value: string): void;
  },
  guard: () => void,
) {
  function master(create: boolean): Buffer {
    guard();
    let value = secrets.getSync("worktree:recovery-key");
    if (!value && create) {
      const key = randomBytes(32);
      try {
        value = key.toString("base64");
        secrets.setSync("worktree:recovery-key", value);
      } finally {
        key.fill(0);
      }
    }
    if (!value) throw new Error("WORKTREE_RECOVERY_KEY_UNAVAILABLE");
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) {
      key.fill(0);
      throw new Error("WORKTREE_RECOVERY_KEY_INVALID");
    }
    return key;
  }
  return {
    async wrapArchiveKey(key: Buffer): Promise<string> {
      if (key.length !== 32) throw new Error("WORKTREE_ARCHIVE_KEY_INVALID");
      const wrappingKey = master(true);
      try {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
        cipher.setAAD(Buffer.from("cindy-terminal-worktree-v1"));
        const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
        guard();
        return [
          "terminal",
          "v1",
          iv.toString("base64"),
          cipher.getAuthTag().toString("base64"),
          encrypted.toString("base64"),
        ].join(":");
      } finally {
        wrappingKey.fill(0);
      }
    },
    async unwrapArchiveKey(envelope: string): Promise<Buffer> {
      const [kind, version, nonce, tag, data, extra] = envelope.split(":");
      if (
        kind !== "terminal" ||
        version !== "v1" ||
        !nonce ||
        !tag ||
        !data ||
        extra !== undefined
      )
        throw new Error("WORKTREE_ARCHIVE_KEY_UNSUPPORTED");
      const iv = Buffer.from(nonce, "base64"),
        authTag = Buffer.from(tag, "base64"),
        encrypted = Buffer.from(data, "base64");
      if (iv.length !== 12 || authTag.length !== 16 || encrypted.length !== 32)
        throw new Error("WORKTREE_ARCHIVE_KEY_INVALID");
      const wrappingKey = master(false);
      try {
        const cipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
        cipher.setAAD(Buffer.from("cindy-terminal-worktree-v1"));
        cipher.setAuthTag(authTag);
        guard();
        return Buffer.concat([cipher.update(encrypted), cipher.final()]);
      } finally {
        wrappingKey.fill(0);
      }
    },
  };
}
