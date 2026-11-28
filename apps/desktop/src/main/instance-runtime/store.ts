import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InstanceAuthProtocol } from "./config.js";

export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export function assertSecretService(codec: SecretCodec): void {
  if (
    !codec.isEncryptionAvailable() ||
    codec.getSelectedStorageBackend() !== "gnome_libsecret"
  ) {
    throw new Error("INSTANCE_KEYRING_UNAVAILABLE");
  }
}

export function atomicPrivateWrite(
  file: string,
  value: Buffer,
  replace = true,
): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new Error("INSTANCE_STORE_PERMISSIONS");
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}-${randomUUID()}`,
  );
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, value);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (replace) {
      fs.renameSync(temporary, file);
    } else {
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    }
    const parent = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function createInstanceStore(userDataDir: string, codec: SecretCodec) {
  const directory = path.join(userDataDir, "instance-credentials");
  const file = path.join(directory, "session.bin");
  const readEncrypted = (target: string): unknown => {
    assertSecretService(codec);
    try {
      const directoryStat = fs.lstatSync(directory);
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        directoryStat.uid !== process.getuid?.() ||
        (directoryStat.mode & 0o077) !== 0
      )
        throw new Error("INSTANCE_STORE_UNREADABLE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("INSTANCE_STORE_UNREADABLE");
    }
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        target,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("INSTANCE_STORE_UNREADABLE");
    }
    try {
      const stat = fs.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 65_536 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("INSTANCE_STORE_PERMISSIONS");
      return JSON.parse(codec.decryptString(fs.readFileSync(descriptor)));
    } catch {
      throw new Error("INSTANCE_STORE_UNREADABLE");
    } finally {
      fs.closeSync(descriptor);
    }
  };
  return {
    read: () => readEncrypted(file),
    write(value: unknown): void {
      assertSecretService(codec);
      atomicPrivateWrite(file, codec.encryptString(JSON.stringify(value)));
    },
    writeNew(value: unknown): void {
      assertSecretService(codec);
      atomicPrivateWrite(
        file,
        codec.encryptString(JSON.stringify(value)),
        false,
      );
    },
    preflight(): void {
      assertSecretService(codec);
      const probe = path.join(directory, `.probe-${randomUUID()}`);
      const value = randomUUID();
      try {
        atomicPrivateWrite(probe, codec.encryptString(JSON.stringify(value)));
        if (readEncrypted(probe) !== value)
          throw new Error("INSTANCE_STORE_ROUNDTRIP_FAILED");
      } finally {
        fs.rmSync(probe, { force: true });
      }
    },
  };
}

export function isResourceRefreshToken(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
}

export function readBootstrapFile(
  file: string,
  protocol: InstanceAuthProtocol = "instance-v1",
): string | null {
  if (protocol !== "instance-v1" && protocol !== "resource-v1")
    throw new Error("INSTANCE_AUTH_PROTOCOL_INVALID");
  let value: string;
  try {
    const descriptor = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 128)
        throw new Error("INSTANCE_BOOTSTRAP_INVALID");
      value = fs.readFileSync(descriptor, "utf8").trim();
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("INSTANCE_BOOTSTRAP_UNREADABLE");
  }
  if (
    protocol === "resource-v1"
      ? !isResourceRefreshToken(value)
      : !/^[a-zA-Z0-9_-]{43}$/.test(value)
  )
    throw new Error("INSTANCE_BOOTSTRAP_INVALID");
  return value;
}
