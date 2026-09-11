import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertFresh, buildProductionFiles } from "../generate.ts";
import {
  aliasTarget,
  flatten,
  readBindings,
  replaceRegion,
  validateProduction,
  type SourceToken,
} from "../production.ts";
import { findRepoRoot } from "../paths.ts";

const root = findRepoRoot();
const inputFiles = [
  "reference/color.json",
  "reference/foundations.json",
  "reference/themes.json",
  "semantic/color.json",
  "semantic/foundations.json",
  "component/color.json",
  "themes/builtin.json",
  "reference/shared.json",
  "semantic/shared.json",
];
function loadSource(): Record<string, SourceToken> {
  return Object.assign(
    {},
    ...inputFiles.map((file) =>
      flatten(
        JSON.parse(
          readFileSync(join(root, "packages/design-tokens/src", file), "utf8"),
        ),
      ),
    ),
  );
}
const bindings = readBindings(root);

describe("DS-8 production source", () => {
  it("generates twice without fixtures, detects every stale/missing/hand-edited output, and follows a real source edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cindy-ds8-production-"));
    try {
      const original = await buildProductionFiles(root);
      for (const path of [
        ...inputFiles.map((f) => `packages/design-tokens/src/${f}`),
        "packages/design-tokens/src/desktop-bindings.json",
        ...original.map((f) => f.path.slice(root.length + 1)),
      ]) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        cpSync(join(root, path), join(dir, path));
      }
      // There is deliberately no themes/__tests__/fixtures directory in this repo copy.
      const first = await buildProductionFiles(dir),
        second = await buildProductionFiles(dir);
      expect(second).toEqual(first);
      assertFresh(first);
      for (const output of first) {
        for (const bad of [
          undefined,
          output.body + "\n// hand edit",
          output.body.replace(/GENERATED/, "STALE"),
        ]) {
          expect(() =>
            assertFresh(first, (path) =>
              path === output.path ? bad : readFileSync(path, "utf8"),
            ),
          ).toThrow(/Stale generated output/);
        }
      }
      const sourcePath = join(
        dir,
        "packages/design-tokens/src/reference/color.json",
      );
      const source = JSON.parse(readFileSync(sourcePath, "utf8"));
      source.reference.defaults.surface.light.$value.components = [
        0.1, 0.2, 0.3,
      ];
      writeFileSync(sourcePath, JSON.stringify(source));
      const changed = await buildProductionFiles(dir);
      const colors = changed.find(
        (f) => f.path === join(dir, "apps/desktop/src/renderer/themes/colors.ts"),
      )!.body;
      expect(colors).toContain('"light": "#1a334d"');
      expect(colors).toContain('"light": "var(--surface)"');
      expect(() => assertFresh(changed)).toThrow(/Stale generated output/);
      const docPath = join(dir, "docs/design-rules/DESIGN.md");
      const doc = readFileSync(docPath, "utf8");
      writeFileSync(
        docPath,
        doc
          .replace(
            "BEGIN GENERATED DS-8: semantic-colors",
            "REVERSED GENERATED DS-8: semantic-colors",
          )
          .replace(
            "END GENERATED DS-8: semantic-colors",
            "BEGIN GENERATED DS-8: semantic-colors",
          )
          .replace(
            "REVERSED GENERATED DS-8: semantic-colors",
            "END GENERATED DS-8: semantic-colors",
          ),
      );
      await expect(buildProductionFiles(dir)).rejects.toThrow(
        /Reversed generated region/,
      );
      writeFileSync(docPath, doc);
      const bindingsPath = join(
        dir,
        "packages/design-tokens/src/desktop-bindings.json",
      );
      const incomplete = JSON.parse(readFileSync(bindingsPath, "utf8"));
      delete incomplete.themes["default-dark.ts"];
      writeFileSync(bindingsPath, JSON.stringify(incomplete));
      await expect(buildProductionFiles(dir)).rejects.toThrow(
        /cover every builtin file/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("every modeled registration consumes generated defaults; all other IDs have explicit retention reasons", () => {
    const file = join(root, "apps/desktop/src/renderer/themes/colors.ts");
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const ids: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "registerColor"
      ) {
        if (ts.isTemplateExpression(node.arguments[0])) {
          const prefix = node.arguments[0].head.text;
          expect(["effort-tier-", "price-tier-"]).toContain(prefix);
          const table =
            prefix === "effort-tier-"
              ? "EFFORT_TIER_COLORS"
              : "PRICE_TIER_COLORS";
          const loop = node.parent.parent.parent;
          expect(loop.getText(source)).toContain(`Object.entries(${table})`);
          expect(node.arguments[1].getText(source)).toBe(
            "{ light: hex, dark: hex }",
          );
          ids.push(
            ...(prefix === "effort-tier-"
              ? ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
              : ["t1", "t2", "t3"]
            ).map((key) => prefix + key),
          );
          return;
        }
        const id = (node.arguments[0] as ts.StringLiteral).text;
        ids.push(id);
        if (bindings.defaults[id])
          expect(node.arguments[1].getText(source)).toBe(
            `GENERATED_DEFAULTS[${JSON.stringify(id)}]`,
          );
        else expect(bindings.retained[id], id).toBeTruthy();
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(new Set(ids).size).toBe(542);
    expect(
      [
        ...Object.keys(bindings.defaults),
        ...Object.keys(bindings.retained),
      ].sort(),
    ).toEqual([...ids].sort());
    expect(
      Object.keys(bindings.defaults).some((id) => bindings.retained[id]),
    ).toBe(false);
  });

  it("rejects illegal types, missing modes, reversed aliases, missing references, color overflow, disconnected CSS aliases and CSS aliases on runtime pixel bindings", () => {
    const source = loadSource();
    expect(() => validateProduction(source, bindings)).not.toThrow();
    const mutate = (
      edit: (tokens: Record<string, SourceToken>) => void,
      message: RegExp,
    ) => {
      const bad = structuredClone(source);
      edit(bad);
      expect(() => validateProduction(bad, bindings)).toThrow(message);
    };
    mutate((t) => {
      t["reference.defaults.surface.light"].$type = "other";
    }, /Unsupported standard type/);
    mutate((t) => {
      delete t["semantic.defaults.surface.dark"];
    }, /Missing alias|Invalid mode binding/);
    mutate((t) => {
      t["reference.defaults.surface.light"].$value =
        "{semantic.defaults.surface.light}";
    }, /Alias direction/);
    mutate((t) => {
      t["component.defaults.panel-bg.light"].$value =
        "{component.defaults.panel-bg.dark}";
    }, /Alias direction/);
    mutate((t) => {
      t["component.defaults.panel-bg.light"].$value =
        "{reference.defaults.surface.light}";
    }, /Alias direction/);
    mutate((t) => {
      t["semantic.defaults.surface.light"].$value = "{reference.missing}";
    }, /Missing alias/);
    mutate((t) => {
      t["reference.defaults.surface.light"].$value = {
        colorSpace: "srgb",
        components: [1.5, 0, 0],
      };
    }, /Invalid color range/);
    mutate((t) => {
      t["component.defaults.panel-bg.light"].$extensions![
        "com.cindy.desktop"
      ].cssAlias = "text-primary";
    }, /Symbolic alias disconnected/);
    mutate((t) => {
      delete t["semantic.defaults.text-secondary.light"].$extensions;
    }, /Missing protection metadata/);
    mutate((t) => {
      t["reference.foundations.text-13"].$value = { value: 13, unit: "em" };
    }, /Invalid unit/);
    mutate((t) => {
      t["reference.foundations.text-13"].$value = { value: 1, unit: "rem" };
    }, /Runtime pixel binding/);
    // A legal-looking CSS alias on a runtime pixel binding would make
    // formatToken() emit `var(--…)`, whose parseFloat silently becomes NaN in
    // token-mappings.ts (numeric/text/lineHeight) and appearance-tokens.ts
    // (defaults). The generator must reject it instead.
    mutate((t) => {
      t["semantic.foundations.text-13"].$extensions = {
        "com.cindy.desktop": { cssAlias: "font-size-13", wrapper: "var" },
      };
    }, /Runtime pixel binding cannot use a CSS alias/);
    mutate((t) => {
      t["semantic.foundations.app-ui-font-size"].$extensions = {
        "com.cindy.desktop": { cssAlias: "app-ui-font-size", wrapper: "var" },
      };
    }, /Runtime pixel binding cannot use a CSS alias/);
    const badTheme = structuredClone(bindings);
    (badTheme.themes["default-dark.ts"] as { type: string }).type = "night";
    expect(() => validateProduction(source, badTheme)).toThrow(
      /Invalid theme mode/,
    );
    const badModes = structuredClone(bindings);
    delete (
      badModes.defaults.surface as Partial<typeof badModes.defaults.surface>
    ).dark;
    expect(() => validateProduction(source, badModes)).toThrow(
      /Missing mode binding/,
    );
  });

  it("retains mode-independent effort/price inputs as aliases of one numeric source", () => {
    const source = loadSource();
    for (const id of Object.keys(bindings.defaults).filter((id) =>
      /^(effort|price)-tier-/.test(id),
    )) {
      const modes = bindings.defaults[id];
      expect(aliasTarget(source[modes.light!].$value)).toBe(
        aliasTarget(source[modes.dark!].$value),
      );
    }
    expect(source["semantic.defaults.price-tier-t1.light"].$value).toBe(
      source["semantic.defaults.effort-tier-low.light"].$value,
    );
  });

  it("rejects missing or empty foundation families instead of silently dropping production outputs", () => {
    const source = loadSource();
    const missing = structuredClone(bindings);
    delete (missing as Partial<typeof missing>).foundations;
    expect(() => validateProduction(source, missing)).toThrow(
      /Missing foundation/,
    );
    for (const family of Object.keys(bindings.foundations)) {
      for (const value of [undefined, {}]) {
        const bad = structuredClone(bindings);
        Object.assign(bad.foundations, { [family]: value });
        expect(() => validateProduction(source, bad)).toThrow(
          /Missing foundation/,
        );
      }
    }
  });

  it.each(["code", "markdown"] as const)(
    "protects %s region boundaries and surrounding hand-written content",
    (style) => {
      const marker = (edge: string) =>
        style === "code"
          ? `// ${edge} GENERATED DS-8: defaults`
          : `<!-- ${edge} GENERATED DS-8: defaults -->`;
      const block = `${marker("BEGIN")}\nold\n${marker("END")}`;
      expect(
        replaceRegion(`before\n${block}\nafter`, "defaults", "new", style),
      ).toBe(`before\n${marker("BEGIN")}\nnew\n${marker("END")}\nafter`);
      expect(() => replaceRegion("", "defaults", "", style)).toThrow(/Missing/);
      expect(() => replaceRegion(block + block, "defaults", "", style)).toThrow(
        /duplicate/,
      );
      expect(() =>
        replaceRegion(
          `${marker("END")}\nold\n${marker("BEGIN")}`,
          "defaults",
          "",
          style,
        ),
      ).toThrow(/Reversed/);
    },
  );
});
