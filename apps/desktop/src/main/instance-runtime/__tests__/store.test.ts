import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInstanceStore,
  readBootstrapFile,
  type SecretCodec,
} from "../store.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "cindy-instance-store-test-"),
  );
  roots.push(root);
  const codec: SecretCodec = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
  };
  const file = path.join(root, "instance-credentials", "session.bin");
  return { root, codec, file, store: createInstanceStore(root, codec) };
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("safeStorage boundary and private file lifecycle", () => {
  it("persists through the codec, uses 0700/0600 and leaves no probe or temporary files", () => {
    const test = fixture();
    test.store.preflight();
    expect(test.store.read()).toBeNull();
    test.store.write({ refreshToken: "test-only-secret" });
    expect(createInstanceStore(test.root, test.codec).read()).toEqual({
      refreshToken: "test-only-secret",
    });
    expect(fs.statSync(test.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(test.file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(test.file))).toEqual(["session.bin"]);
    expect(fs.readFileSync(test.file, "utf8")).not.toContain(
      "test-only-secret",
    );
  });
  it.each(["basic_text", "unknown", "kwallet"])(
    "rejects backend %s even if encryption reports available",
    (backend) => {
      const test = fixture();
      test.codec.getSelectedStorageBackend = () => backend;
      expect(() => test.store.preflight()).toThrow(
        "INSTANCE_KEYRING_UNAVAILABLE",
      );
      expect(() => test.store.write("test")).toThrow(
        "INSTANCE_KEYRING_UNAVAILABLE",
      );
      expect(() => test.store.read()).toThrow("INSTANCE_KEYRING_UNAVAILABLE");
    },
  );
  it("rejects unavailable or wrong keyring instead of treating data as absent", () => {
    const test = fixture();
    test.store.write("test-only-value");
    test.codec.isEncryptionAvailable = () => false;
    expect(() => test.store.read()).toThrow("INSTANCE_KEYRING_UNAVAILABLE");
    test.codec.isEncryptionAvailable = () => true;
    test.codec.decryptString = () => {
      throw new Error("wrong-key");
    };
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
    expect(fs.existsSync(test.file)).toBe(true);
  });
  it("rejects corrupt, public, oversized and symlinked records without replacing them", () => {
    const test = fixture();
    test.store.write("test-only-value");
    fs.chmodSync(test.file, 0o644);
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
    fs.chmodSync(test.file, 0o600);
    fs.writeFileSync(test.file, Buffer.alloc(65_537));
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
    fs.writeFileSync(test.file, "corrupt");
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
    fs.unlinkSync(test.file);
    fs.symlinkSync(path.join(test.root, "missing"), test.file);
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
  });
  it("does not accept an insecure existing credential directory", () => {
    const test = fixture();
    fs.mkdirSync(path.dirname(test.file), { mode: 0o755 });
    fs.chmodSync(path.dirname(test.file), 0o755);
    expect(() => test.store.preflight()).toThrow("INSTANCE_STORE_PERMISSIONS");
  });
  it("rejects linked files and linked credential directories", () => {
    const test = fixture();
    test.store.write("test-only-value");
    const linked = path.join(test.root, "linked.bin");
    fs.linkSync(test.file, linked);
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
    fs.unlinkSync(linked);
    const directory = path.dirname(test.file);
    const renamed = path.join(test.root, "renamed");
    fs.renameSync(directory, renamed);
    fs.symlinkSync(renamed, directory);
    expect(() => test.store.read()).toThrow("INSTANCE_STORE_UNREADABLE");
  });
  it("reads only bounded bootstrap material and distinguishes ENOENT from invalid contents", () => {
    const test = fixture();
    const file = path.join(test.root, "bootstrap");
    expect(readBootstrapFile(file)).toBeNull();
    fs.writeFileSync(file, `${"x".repeat(43)}\n`, { mode: 0o600 });
    expect(readBootstrapFile(file)).toBe("x".repeat(43));
    fs.writeFileSync(file, "invalid");
    expect(() => readBootstrapFile(file)).toThrow("INSTANCE_BOOTSTRAP_INVALID");
    fs.writeFileSync(file, "x".repeat(1000));
    expect(() => readBootstrapFile(file)).toThrow(
      "INSTANCE_BOOTSTRAP_UNREADABLE",
    );
  });
  it("accepts UUID resource bootstrap only in the explicitly selected protocol", () => {
    const test = fixture();
    const file = path.join(test.root, "bootstrap");
    const token = "00000000-0000-4000-8000-000000000001";
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    expect(readBootstrapFile(file, "resource-v1")).toBe(token);
    expect(() => readBootstrapFile(file)).toThrow("INSTANCE_BOOTSTRAP_INVALID");
    fs.writeFileSync(file, "x".repeat(43));
    expect(() => readBootstrapFile(file, "resource-v1")).toThrow(
      "INSTANCE_BOOTSTRAP_INVALID",
    );
    expect(readBootstrapFile(file, "instance-v1")).toBe("x".repeat(43));
  });
});
