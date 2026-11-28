import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("managed login preserves the publication order", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/main/authManager.ts"),
    "utf8",
  );
  const login = source.slice(source.indexOf("async function completeLogin("));

  it("acknowledges durable instance credentials before publishing the new owner", () => {
    const write = login.indexOf(
      "writePersistedAuthSessionOrThrow(outcome.refreshToken, committedRealm);",
    );
    const accept = login.indexOf("currentUser = nextUser;");
    const acknowledge = login.indexOf("acknowledgeInstanceLogin(outcome);");
    const clear = login.indexOf("canaryFlagStore.clear();", accept);
    const publish = login.indexOf(
      "commitCloudAppSession(currentUser.id, authRealmChanged);",
    );

    expect(write).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(write);
    expect(acknowledge).toBeGreaterThan(accept);
    expect(clear).toBeGreaterThan(acknowledge);
    expect(publish).toBeGreaterThan(clear);
  });
});
