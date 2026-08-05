// macOS 公证编排回归测试。所有命令与文件操作都通过依赖注入模拟，
// 不连接 Apple 服务、不读取真实凭证，也不创建打包产物。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertMacWebAuthnProvisioningProfile,
  embedMacWebAuthnProvisioningProfile,
  macWebAuthnKeychainAccessGroup,
  notarizeMacApp,
  parseCodesignTeamIdentifier,
  writeMacEntitlements,
} from "../../apps/desktop/scripts/ci/lib.mjs";

const APP_PATH = "/tmp/Cindy.app";
const ZIP_PATH = `${APP_PATH}.zip`;
const IDENTITY = Object.freeze({
  appleId: "ci@example.invalid",
  teamId: "TEAM123456",
  applePassword: "test-app-password",
});

test("macOS WebAuthn access group is derived from the exact signing and bundle identities", () => {
  assert.equal(
    macWebAuthnKeychainAccessGroup("TEAM123456", "com.xd.cindy"),
    "TEAM123456.com.xd.cindy.webauthn",
  );
  assert.throws(
    () => macWebAuthnKeychainAccessGroup("short", "com.xd.cindy"),
    /invalid Apple Team ID/,
  );
  assert.throws(
    () => macWebAuthnKeychainAccessGroup("TEAM123456", "com..xd.cindy"),
    /invalid macOS bundle id/,
  );
});

test("macOS WebAuthn keychain entitlement is main-only", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cindy-webauthn-entitlements-"),
  );
  const helperPath = path.join(tempDir, "helper.plist");
  const mainPath = path.join(tempDir, "main.plist");
  const keychainAccessGroup = macWebAuthnKeychainAccessGroup(
    "TEAM123456",
    "com.xd.cindy",
  );
  try {
    writeMacEntitlements(helperPath);
    writeMacEntitlements(mainPath, { appleEvents: true, keychainAccessGroup });

    const helper = fs.readFileSync(helperPath, "utf8");
    const main = fs.readFileSync(mainPath, "utf8");
    assert.doesNotMatch(helper, /keychain-access-groups/);
    assert.doesNotMatch(helper, /apple-events/);
    assert.match(main, /com\.apple\.security\.automation\.apple-events/);
    assert.match(main, /<key>keychain-access-groups<\/key>/);
    assert.ok(
      main.includes(`<string>${keychainAccessGroup}</string>`),
      "main entitlements should contain the exact WebAuthn keychain group",
    );
    assert.ok(
      !main.includes("<string>TEAM123456.com.xd.other.webauthn</string>"),
      "main entitlements should reject a different WebAuthn keychain group",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function validWebAuthnProvisioningProfile(overrides = {}) {
  return {
    TeamIdentifier: ["TEAM123456"],
    ExpirationDate: "2099-01-01T00:00:00.000Z",
    Entitlements: {
      "com.apple.developer.team-identifier": "TEAM123456",
      "com.apple.application-identifier": "TEAM123456.com.xd.cindy",
      "keychain-access-groups": ["TEAM123456.com.xd.cindy.webauthn"],
    },
    ...overrides,
  };
}

const WEB_AUTHN_PROFILE_EXPECTED = Object.freeze({
  teamId: "TEAM123456",
  bundleId: "com.xd.cindy",
  keychainAccessGroup: "TEAM123456.com.xd.cindy.webauthn",
});

test("macOS WebAuthn provisioning profile must authorize the signing, app and keychain identities", () => {
  assert.doesNotThrow(() =>
    assertMacWebAuthnProvisioningProfile(
      validWebAuthnProvisioningProfile(),
      WEB_AUTHN_PROFILE_EXPECTED,
    ),
  );
  assert.throws(
    () =>
      assertMacWebAuthnProvisioningProfile(
        validWebAuthnProvisioningProfile({ TeamIdentifier: ["OTHER12345"] }),
        WEB_AUTHN_PROFILE_EXPECTED,
      ),
    /does not authorize Apple Team ID/,
  );
  assert.throws(
    () =>
      assertMacWebAuthnProvisioningProfile(
        validWebAuthnProvisioningProfile({
          Entitlements: {
            ...validWebAuthnProvisioningProfile().Entitlements,
            "keychain-access-groups": ["TEAM123456.com.xd.other.webauthn"],
          },
        }),
        WEB_AUTHN_PROFILE_EXPECTED,
      ),
    /does not authorize keychain group/,
  );
});

test("macOS WebAuthn provisioning profile is validated before it is embedded", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cindy-webauthn-profile-"),
  );
  const appPath = path.join(tempDir, "Cindy.app");
  const profilePath = path.join(tempDir, "source.provisionprofile");
  fs.mkdirSync(path.join(appPath, "Contents"), { recursive: true });
  fs.writeFileSync(profilePath, "signed-profile-bytes");
  const spawnCalls = [];
  try {
    const embeddedPath = embedMacWebAuthnProvisioningProfile(
      appPath,
      profilePath,
      WEB_AUTHN_PROFILE_EXPECTED,
      {
        spawnCommand(command, args, options) {
          spawnCalls.push({ command, args, options });
          if (command === "/usr/bin/security") {
            return {
              status: 0,
              stdout: `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ExpirationDate</key><date>2099-01-01T00:00:00Z</date>
  <key>DER-Encoded-Profile</key><data>AAECAwQ=</data>
</dict></plist>`,
              stderr: "",
            };
          }
          assert.equal(command, "/usr/bin/plutil");
          assert.equal(args[0], "-extract");
          assert.equal(args[3], "-o");
          assert.equal(args[4], "-");
          assert.equal(args[5], "--");
          assert.match(
            args[6].replaceAll("\\", "/"),
            /\/cindy-webauthn-profile-[^/]+\/decoded\.plist$/,
          );
          if (args[1] === "TeamIdentifier") {
            assert.equal(args[2], "json");
            return { status: 0, stdout: JSON.stringify(["TEAM123456"]), stderr: "" };
          }
          if (args[1] === "ExpirationDate") {
            assert.equal(args[2], "raw");
            return { status: 0, stdout: "2099-01-01T00:00:00Z\n", stderr: "" };
          }
          assert.equal(args[1], "Entitlements");
          assert.equal(args[2], "json");
          return {
            status: 0,
            stdout: JSON.stringify(validWebAuthnProvisioningProfile().Entitlements),
            stderr: "",
          };
        },
      },
    );
    assert.equal(
      embeddedPath,
      path.join(appPath, "Contents", "embedded.provisionprofile"),
    );
    assert.equal(fs.readFileSync(embeddedPath, "utf8"), "signed-profile-bytes");
    assert.equal(spawnCalls.length, 4);
    assert.deepEqual(spawnCalls.slice(1).map(({ args }) => args.slice(0, 3)), [
      ["-extract", "TeamIdentifier", "json"],
      ["-extract", "ExpirationDate", "raw"],
      ["-extract", "Entitlements", "json"],
    ]);
    assert.ok(spawnCalls.every(({ args }) => !args.includes("-convert")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("codesign TeamIdentifier parser reads the signing authority actually applied", () => {
  assert.equal(
    parseCodesignTeamIdentifier(
      "Identifier=com.xd.cindy\nTeamIdentifier=TEAM123456\n",
    ),
    "TEAM123456",
  );
  assert.equal(
    parseCodesignTeamIdentifier("TeamIdentifier=not set"),
    "not set",
  );
});

function createHarness(results) {
  const queue = [...results];
  const execCommands = [];
  const spawnCalls = [];
  const deletedFiles = [];
  const output = [];
  const logger = {
    log(...args) {
      output.push(args.join(' '));
    },
    error(...args) {
      output.push(args.join(' '));
    },
  };
  const dependencies = {
    execCommand(command) {
      execCommands.push(command);
    },
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });
      assert.ok(queue.length > 0, `unexpected spawn: ${command} ${args.join(' ')}`);
      const result = queue.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    unlinkFile(filePath) {
      deletedFiles.push(filePath);
    },
    logger,
  };
  return {
    dependencies,
    execCommands,
    spawnCalls,
    deletedFiles,
    output,
    assertQueueDrained() {
      assert.equal(queue.length, 0, 'all mocked command results should be consumed');
    },
  };
}

test('notarizeMacApp: Accepted 后才删除 zip 并 staple', () => {
  const harness = createHarness([{
    status: 0,
    signal: null,
    stdout: JSON.stringify({ id: 'accepted-id', status: 'Accepted' }),
    stderr: '',
  }]);

  notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies);

  assert.deepEqual(harness.deletedFiles, [ZIP_PATH]);
  assert.deepEqual(harness.execCommands, [
    `/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
    `/usr/bin/xcrun stapler staple "${APP_PATH}"`,
  ]);
  assert.equal(harness.spawnCalls.length, 1);
  assert.deepEqual(harness.spawnCalls[0], {
    command: '/usr/bin/xcrun',
    args: [
      'notarytool',
      'submit',
      ZIP_PATH,
      '--apple-id',
      IDENTITY.appleId,
      '--password',
      IDENTITY.applePassword,
      '--team-id',
      IDENTITY.teamId,
      '--wait',
      '--output-format',
      'json',
    ],
    options: { encoding: 'utf8', timeout: 1800000 },
  });
  assert.match(harness.output.join('\n'), /Apple notarization status: Accepted/);
  assert.doesNotMatch(harness.output.join('\n'), new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

test('notarizeMacApp: Invalid 时拉取详细日志且不删除或 staple', () => {
  const harness = createHarness([
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ id: 'invalid-id', status: 'Invalid' }),
      stderr: '',
    },
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        statusCode: 4000,
        issues: [{ path: 'Cindy.app/Contents/MacOS/pi', message: IDENTITY.applePassword }],
      }),
      stderr: '',
    },
  ]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /Apple 公证未通过: status=Invalid, submission=invalid-id/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.deepEqual(harness.execCommands, [
    `/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
  ]);
  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.spawnCalls[1].args, [
    'notarytool',
    'log',
    'invalid-id',
    '--apple-id',
    IDENTITY.appleId,
    '--password',
    IDENTITY.applePassword,
    '--team-id',
    IDENTITY.teamId,
  ]);
  const output = harness.output.join('\n');
  assert.match(output, /Apple notarization log:/);
  assert.match(output, /Cindy\.app\/Contents\/MacOS\/pi/);
  assert.match(output, /\*\*\*\*/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

test('notarizeMacApp: submit 命令失败时保留 zip 且输出脱敏诊断', () => {
  const harness = createHarness([{
    status: 1,
    signal: null,
    stdout: '',
    stderr: `authentication rejected: ${IDENTITY.applePassword}`,
  }]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /notarytool submit 失败\(exit 1\);公证未通过/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.equal(harness.execCommands.length, 1);
  assert.equal(harness.spawnCalls.length, 1);
  const output = harness.output.join('\n');
  assert.match(output, /authentication rejected: \*\*\*\*/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

// notarytool 对 Invalid 提交的 exit code 随 Xcode 版本变化；非 0 退出这条路径同样
// 必须从 stdout 里救出 submission id 去拉 Apple 的详细原因，否则发布失败无从定位。
test('notarizeMacApp: submit 非 0 退出但 stdout 带 Invalid 时仍拉取详细日志', () => {
  const harness = createHarness([
    {
      status: 2,
      signal: null,
      stdout: JSON.stringify({ id: 'nonzero-invalid-id', status: 'Invalid' }),
      stderr: '',
    },
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        statusCode: 4000,
        issues: [{ path: 'Cindy.app/Contents/MacOS/cindy', message: 'not signed' }],
      }),
      stderr: '',
    },
  ]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /notarytool submit 失败\(exit 2\);公证未通过/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.deepEqual(harness.execCommands, [
    `/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
  ]);
  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.spawnCalls[1].args, [
    'notarytool',
    'log',
    'nonzero-invalid-id',
    '--apple-id',
    IDENTITY.appleId,
    '--password',
    IDENTITY.applePassword,
    '--team-id',
    IDENTITY.teamId,
  ]);
  const output = harness.output.join('\n');
  assert.match(output, /Apple notarization log:/);
  assert.match(output, /not signed/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});

test('notarizeMacApp: Invalid 的日志命令失败仍直接报告公证失败', () => {
  const harness = createHarness([
    {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ id: 'invalid-log-failure', status: 'Invalid' }),
      stderr: '',
    },
    {
      status: 69,
      signal: null,
      stdout: '',
      stderr: `log authentication failed: ${IDENTITY.applePassword}`,
    },
  ]);

  assert.throws(
    () => notarizeMacApp(APP_PATH, IDENTITY, harness.dependencies),
    /Apple 公证未通过: status=Invalid, submission=invalid-log-failure/,
  );

  assert.deepEqual(harness.deletedFiles, []);
  assert.equal(harness.execCommands.length, 1);
  const output = harness.output.join('\n');
  assert.match(output, /WARN: 无法获取 Apple notarization log/);
  assert.match(output, /log authentication failed: \*\*\*\*/);
  assert.doesNotMatch(output, new RegExp(IDENTITY.applePassword));
  harness.assertQueueDrained();
});
