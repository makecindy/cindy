import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { transformCloudIdentitySource, targets } from "./overlay.mjs";
const source = process.env.CLOUD_UPDATE_TEST_SOURCE;
const require = source
  ? createRequire(path.join(source, "package.json"))
  : null;
const read = (file) => fs.readFileSync(path.join(source, file), "utf8");
const compile = (code, loader = "ts") =>
  require("esbuild").transformSync(code, {
    loader,
    format: "cjs",
    jsx: "automatic",
  }).code;

test("unknown sources are untouched; drift and duplicate injection fail closed", () => {
  assert.equal(transformCloudIdentitySource("same", "other.ts"), null);
  for (const target of targets)
    assert.throws(() => transformCloudIdentitySource("", target));
});
test(
  "real cloud UI sources compile and cannot receive the overlay twice",
  { skip: !source },
  () => {
    for (const target of targets) {
      const before = read(target),
        after = transformCloudIdentitySource(before, target);
      compile(after, target.endsWith(".tsx") ? "tsx" : "ts");
      assert.equal(read(target), before);
      assert.throws(() => transformCloudIdentitySource(after, target), /twice/);
    }
  },
);
test(
  "actual settings profile hides logout and add-account only in managed cloud windows",
  { skip: !source },
  () => {
    const code = compile(
      transformCloudIdentitySource(read(targets[1]), targets[1]),
      "tsx",
    );
    for (const managed of [false, true]) {
      const jsx = (type, props) => ({ type, props }),
        noop = () => {},
        user = {
          id: "fixture-id",
          name: "Fixture",
          membershipKind: "personal",
        };
      const modules = {
        react: {
          useEffect: noop,
          useId: () => ":id:",
          useState: (x) => [x, noop],
        },
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "react-i18next": { useTranslation: () => ({ t: (k) => k }) },
        "react-router-dom": {
          useNavigate: () => noop,
          useLocation: () => ({ pathname: "/settings", search: "" }),
        },
        "@/contexts/AuthContext": {
          useAuth: () => ({ user, mode: "cloud", exitLocalMode: noop }),
        },
        "@/components/ui/confirm-dialog-provider": {
          useOptionalConfirmDialog: () => null,
        },
        "@/hooks/useLogout": { useLogout: () => ({ handleLogout: noop }) },
        "@/lib/utils": { cn: (...x) => x.join(" ") },
      };
      const context = {
        module: { exports: {} },
        window: { electronAPI: { cloudIdentityManaged: managed } },
        require: (id) => modules[id] ?? new Proxy({}, { get: (_, key) => key }),
      };
      vm.runInNewContext(code, context);
      const tree = JSON.stringify(context.module.exports.UserProfileCard());
      assert.equal(tree.includes("settings.logout.button"), !managed);
      assert.equal(tree.includes("sidebar.user.menuAddAccount"), !managed);
      assert.ok(tree.includes("Fixture"));
      assert.ok(tree.includes("settings.userProfile.edit.open"));
    }
  },
);
test(
  "main identity guard rejects mutations while allowing only the managed token pair",
  { skip: !source },
  () => {
    const sourceCode = read("apps/desktop/src/main/instance-runtime/host.ts");
    const start = sourceCode.indexOf(
        "export function assertInstanceAuthMutationAllowed(",
      ),
      end = sourceCode.indexOf("\n}\n", start) + 3;
    assert.ok(start >= 0 && end > start);
    const code = compile(sourceCode.slice(start, end));
    for (const managed of [false, true]) {
      const owned = { accessToken: "fixture" },
        context = {
          module: { exports: {} },
          getInstanceConfig: () => (managed ? {} : null),
          session: { owns: (pair) => pair === owned },
          AuthApiError: class extends Error {
            constructor(code) {
              super(code);
            }
          },
        };
      vm.runInNewContext(code, context);
      const guard = context.module.exports.assertInstanceAuthMutationAllowed;
      if (managed) {
        assert.throws(() => guard(), /INSTANCE_AUTH_MANAGED_BY_CIS/);
        assert.throws(
          () => guard({ accessToken: "foreign" }),
          /INSTANCE_AUTH_MANAGED_BY_CIS/,
        );
      } else guard();
      guard(owned);
    }
    const auth = read("apps/desktop/src/main/authManager.ts");
    for (const name of [
      "logout",
      "beginAddAccountLogin",
      "dispatchLoginAction",
      "switchSavedAccount",
      "enterLocalMode",
    ]) {
      const i = auth.indexOf(`export async function ${name}(`);
      assert.ok(i >= 0);
      const j = auth.indexOf("assertInstanceAuthMutationAllowed();", i);
      assert.ok(j > i && j - i < 400, `${name} must guard before mutation`);
    }
  },
);
