import { describe, expect, it, vi } from "vitest";
import {
  readSecretJSON,
  writeSecretJSON,
  withRecipeHost,
} from "@jackwener/opencli/cindy/host";

describe("recipe credential host boundary", () => {
  it("keeps concurrent invocation credentials separate and writes through the host", async () => {
    const first = {
      read: vi.fn(() => '{"access_token":"fake-first"}'),
      write: vi.fn(() => true),
    };
    const second = {
      read: vi.fn(() => '{"access_token":"fake-second"}'),
      write: vi.fn(() => true),
    };
    const values = await Promise.all(
      [first, second].map((store) =>
        withRecipeHost(store, async () => {
          await Promise.resolve();
          const credentials = readSecretJSON("spotify", "/unused-legacy-path");
          writeSecretJSON("spotify", credentials);
          return credentials;
        }),
      ),
    );
    expect(values).toEqual([
      { access_token: "fake-first" },
      { access_token: "fake-second" },
    ]);
    expect(first.write).toHaveBeenCalledWith(
      "spotify",
      '{"access_token":"fake-first"}',
    );
    expect(second.write).toHaveBeenCalledWith(
      "spotify",
      '{"access_token":"fake-second"}',
    );
    expect(() => writeSecretJSON("spotify", {})).toThrow("encrypted store");
  });

  it("does not replace an unreadable encrypted credential or fall back to plaintext writes", async () => {
    const write = vi.fn(() => false);
    await expect(
      withRecipeHost(
        {
          read: () => {
            throw new Error("locked store");
          },
          write,
        },
        async () => {
          readSecretJSON("xiaoyuzhou", "/unused-legacy-path");
        },
      ),
    ).rejects.toThrow("locked store");
    expect(write).not.toHaveBeenCalled();
    await expect(
      withRecipeHost({ read: () => null, write }, async () => {
        writeSecretJSON("xiaoyuzhou", { access_token: "fake-token" });
      }),
    ).rejects.toThrow("encrypted store");
  });
});
