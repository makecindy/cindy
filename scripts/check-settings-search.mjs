#!/usr/bin/env node
// Incremental settings discovery contract: new/changed controls need a registered
// definition. Once a file adopts useSettingDefinition, all its controls are checked.
// No editable baseline: legacy allowances come from the trusted Git base in CI.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const ts = requireDesktop("typescript");
const settingsDir = "apps/desktop/src/renderer/components/settings";
const extraFiles = [
  "apps/desktop/src/renderer/features/bots/BotsGlobalSettingsSection.tsx",
];
const controls = new Set([
  "Switch",
  "Checkbox",
  "Select",
  "SegmentedControl",
  "Input",
  "SettingsTextInput",
  "Textarea",
  "Slider",
  "Button",
  "button",
  "input",
  "select",
  "textarea",
  "BotModelChainEditor",
  "Select.Trigger",
  "FontFamilyPicker",
  "VoiceInputSelect",
  "PillSelect",
  "BehaviorRow",
  "OneshotModelPinPicker",
]);
// These application controls do not spread DOM props by contract. Check their
// implementation as well as every caller, including aliases and same-file controls.
const customControls = new Set([
  "SegmentedControl", "FontFamilyPicker", "BotModelChainEditor", "VoiceInputSelect", "PillSelect", "Select", "BehaviorRow", "OneshotModelPinPicker", "ModelSelector",
]);
const interactiveRoles = new Set([
  "button", "checkbox", "radio", "switch", "combobox", "listbox", "option",
  "textbox", "searchbox", "slider", "spinbutton", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "treeitem",
]);
function hasInteractiveRole(node) {
  if (!/^[a-z]/.test(node.tagName.getText())) return false;
  return node.attributes.properties.some(attribute => {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "role" || !attribute.initializer) return false;
    const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
    return value && ts.isStringLiteral(value) && value.text.split(/\s+/).some(role => interactiveRoles.has(role));
  });
}
const parse = (source) =>
  ts.createSourceFile(
    "settings.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const canonical = (node, source) => node.getText(source).replace(/\s+/g, " ");

function forwardedIdParameter(owner) {
  return owner.parameters.flatMap(({ name }) => ts.isObjectBindingPattern(name) ? name.elements : [])
    .find(binding => binding.propertyName && ts.isStringLiteral(binding.propertyName) &&
      binding.propertyName.text === "data-setting-id" && ts.isIdentifier(binding.name) &&
      !binding.initializer && !binding.dotDotDotToken)?.name.text;
}

function forwardsIdToDom(source, name, controlSources = new Map(), visited = new Set()) {
  if (visited.has(name)) return false;
  const nextVisited = new Set([...visited, name]);
  const file = parse(source);
  const nestedControls = new Map();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const item of named.elements) {
      const exported = item.propertyName?.text ?? item.name.text;
      if (customControls.has(exported)) nestedControls.set(item.name.text, {
        name: exported, source: controlSources.get(statement.moduleSpecifier.text + '#' + exported),
      });
    }
  }
  let forwarded = false;
  walk(file, owner => {
    if (!ts.isFunctionDeclaration(owner) || owner.name?.text !== name || !owner.body) return;
    const parameter = forwardedIdParameter(owner);
    if (!parameter) return;
    walk(owner.body, node => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const tag = node.tagName.getText(file);
      // Intrinsic elements and the existing DOM-prop-forwarding UI primitives.
      if (!/^[a-z]/.test(tag) && tag !== "Button" && tag !== "Switch" && tag !== "Select.Trigger") {
        const nested = nestedControls.get(tag);
        if (!nested?.source || !forwardsIdToDom(nested.source, nested.name, controlSources, nextVisited)) return;
      }
      if (node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) &&
        attribute.name.getText(file) === "data-setting-id" && attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression &&
        ts.isIdentifier(attribute.initializer.expression) && attribute.initializer.expression.text === parameter)) {
        forwarded = true;
      }
    });
  });
  return forwarded;
}

/** Pure checker; registry keys are module-specifier#named-export, supplied by the CLI. */
export function inspectSettingsControls(
  source,
  previous = "",
  registeredExports = new Set(),
  indexedTextKeys = new Set(),
  controlSources = new Map(),
) {
  const file = parse(source);
  const errors = [];
  const aliases = new Set(controls);
  const imports = new Map();
  const customNames = new Map([...customControls].map(name => [name, name]));
  const definitionImports = new Set();
  const hooks = new Set();
  const bindings = new Set();
  const definitionBindings = new Set();
  walk(file, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      return;
    const from = node.moduleSpecifier.text;
    const named = node.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return;
    for (const item of named.elements) {
      const name = item.propertyName?.text ?? item.name.text;
      imports.set(item.name.text, `${from}#${name}`);
      if (registeredExports.has(`${from}#${name}`))
        definitionImports.add(item.name.text);
      if (controls.has(name)) aliases.add(item.name.text);
      if (customControls.has(name)) customNames.set(item.name.text, name);
      if (
        name === "useSettingDefinition" &&
        /(?:^|\/)useSettingDefinition$/.test(from)
      )
        hooks.add(item.name.text);
    }
  });
  const isDefinition = (node) => {
    if (!node) return false;
    if (ts.isIdentifier(node)) return definitionBindings.has(node.text);
    if (ts.isConditionalExpression(node))
      return isDefinition(node.whenTrue) && isDefinition(node.whenFalse);
    return (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      definitionImports.has(node.expression.text)
    );
  };
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isDefinition(node.initializer)
    )
      definitionBindings.add(node.name.text);
  });
  walk(file, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !hooks.has(node.initializer.expression.getText(file))
    )
      return;
    const argument = node.initializer.arguments[0];
    if (isDefinition(argument)) bindings.add(node.name.text);
  });
  const getControls = (ast) => {
    const found = [];
    walk(ast, (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        (aliases.has(node.tagName.getText(ast)) || hasInteractiveRole(node))
      )
        found.push(node);
    });
    return found;
  };
  const oldFile = parse(previous);
  const displayKeys = (ast) => {
    const keys = new Map();
    walk(ast, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !/^(?:t|\w+\.t)$/.test(node.expression.getText(ast))
      )
        return;
      const key = node.arguments[0];
      if (
        key &&
        ts.isStringLiteral(key) &&
        /^settings\./.test(key.text) &&
        /(?:title|label|description|hint)$/i.test(key.text)
      )
        keys.set(key.text, key);
    });
    return keys;
  };
  const previousKeys = displayKeys(oldFile);
  for (const [key, node] of displayKeys(file)) {
    if (!previousKeys.has(key) && !indexedTextKeys.has(key))
      errors.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        message: `${key} is new setting text missing from the search definitions`,
      });
  }
  const legacy = new Map();
  for (const node of getControls(oldFile)) {
    const signature = canonical(node, oldFile);
    legacy.set(signature, (legacy.get(signature) ?? 0) + 1);
  }
  const strict =
    hooks.size > 0 ||
    definitionImports.size > 0 ||
    /\buseSettingDefinition\b|\.settings-search['"]/.test(previous);
  // Reusable controls may forward the caller's ID. Only accept a destructured
  // data-setting-id in controls whose call sites this checker already validates.
  const forwardsSettingId = (node, value) => {
    if (!value || !ts.isIdentifier(value)) return false;
    for (let owner = node.parent; owner; owner = owner.parent) {
      if (!ts.isFunctionDeclaration(owner)) continue;
      if (!owner.name || !controls.has(owner.name.text)) return false;
      return forwardedIdParameter(owner) === value.text;
    }
    return false;
  };
  for (const node of getControls(file)) {
    const signature = canonical(node, file);
    const allowance = legacy.get(signature) ?? 0;
    if (!strict && allowance > 0) {
      legacy.set(signature, allowance - 1);
      continue;
    }
    const covered = node.attributes.properties.some((attribute) => {
      if (
        ts.isJsxSpreadAttribute(attribute) &&
        ts.isPropertyAccessExpression(attribute.expression)
      ) {
        return (
          attribute.expression.name.text === "controlProps" &&
          ts.isIdentifier(attribute.expression.expression) &&
          bindings.has(attribute.expression.expression.text)
        );
      }
      // Ordinary actions (cancel, retry, navigation) may be excluded with a specific reason.
      if (
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(file) === "data-setting-id" &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer)
      ) {
        const value = attribute.initializer.expression;
        if (forwardsSettingId(node, value)) return true;
        return (
          value &&
          ts.isPropertyAccessExpression(value) &&
          value.name.text === "id" &&
          isDefinition(value.expression)
        );
      }
      return (
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(file) === "data-settings-search-action" &&
        attribute.initializer &&
        ts.isStringLiteral(attribute.initializer) &&
        attribute.initializer.text.trim().length >= 8
      );
    });
    if (!covered)
      errors.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        message: `${node.tagName.getText(file)} needs {...setting.controlProps} from a registered useSettingDefinition, or data-settings-search-action with an operation-specific reason`,
      });
    else {
      const tag = node.tagName.getText(file);
      const customName = customNames.get(tag);
      if (customName && !forwardsIdToDom(controlSources.get(imports.get(tag)) ?? source, customName, controlSources))
        errors.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          message: `${tag} must forward the caller data-setting-id to rendered DOM`,
        });
    }
  }
  return errors;
}

/** A named definition collection must actually feed the discovered default catalog. */
export function registeredDefinitionExports(source) {
  const file = parse(source);
  const defined = new Set();
  const registered = new Set();
  walk(file, (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          declaration.initializer.expression.getText(file) === "defineSettings"
        )
          defined.add(declaration.name.text);
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      walk(node.expression, (child) => {
        if (
          ts.isPropertyAssignment(child) &&
          child.name.getText(file) === "entries"
        ) {
          walk(child.initializer, (value) => {
            if (
              ts.isCallExpression(value) &&
              value.expression.getText(file) === "Object.values" &&
              value.arguments.length === 1 &&
              ts.isIdentifier(value.arguments[0])
            )
              registered.add(value.arguments[0].text);
          });
        }
      });
    }
  });
  return new Set([...defined].filter((name) => registered.has(name)));
}

export function indexedSettingsTextKeys(source) {
  const keys = new Set();
  const registered = registeredDefinitionExports(source);
  const collect = (rootNode) =>
    walk(rootNode, (node) => {
      if (
        !ts.isPropertyAssignment(node) ||
        !/^(titleKey|sectionKey|descriptionKey|labelKey|keywordKeys)$/.test(
          node.name.getText(),
        )
      )
        return;
      walk(node.initializer, (value) => {
        if (ts.isStringLiteral(value)) keys.add(value.text);
      });
    });
  walk(parse(source), (node) => {
    if (ts.isExportAssignment(node) && !node.isExportEquals)
      collect(node.expression);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      registered.has(node.name.text) &&
      node.initializer
    )
      collect(node.initializer);
  });
  return keys;
}

export function checkSettingsSearch(baseRef = "HEAD") {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const indexedTextKeys = new Set();
  const metadataFiles = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    settingsDir,
  ])
    .trim()
    .split("\n")
    .filter(
      (file) =>
        file.endsWith(".settings-search.ts") &&
        existsSync(path.join(root, file)),
    );
  for (const file of metadataFiles) {
    for (const key of indexedSettingsTextKeys(
      readFileSync(path.join(root, file), "utf8"),
    ))
      indexedTextKeys.add(key);
  }
  const files = [
    ...new Set(
      git([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        settingsDir,
        ...extraFiles,
      ])
        .trim()
        .split("\n"),
    ),
  ].filter(
    (file) =>
      file.endsWith(".tsx") &&
      !file.includes("/__tests__/") &&
      existsSync(path.join(root, file)),
  );
  const baseFiles = new Set(
    git([
      "ls-tree",
      "-r",
      "--name-only",
      baseRef,
      "--",
      settingsDir,
      ...extraFiles,
    ])
      .trim()
      .split("\n"),
  );
  const changedFiles = new Set(
    git(["diff", "--name-only", baseRef, "--", settingsDir, ...extraFiles])
      .trim()
      .split("\n"),
  );
  const errors = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    if (
      baseFiles.has(file) &&
      !changedFiles.has(file) &&
      !source.includes("useSettingDefinition") &&
      !source.includes(".settings-search")
    )
      continue;
    let previous = "";
    // A missing path at a verified base is a new file; other Git failures remain errors.
    if (baseFiles.has(file)) previous = git(["show", `${baseRef}:${file}`]);
    const registered = new Set();
    const controlSources = new Map();
    const loadControlSource = (from, name, importer) => {
      const key = from + '#' + name;
      if (controlSources.has(key)) return;
      const stem = from.startsWith('@/')
        ? path.join(root, 'apps/desktop/src/renderer', from.slice(2))
        : path.resolve(root, path.dirname(importer), from);
      const resolved = stem + '.tsx';
      if (!existsSync(resolved)) return;
      const content = readFileSync(resolved, 'utf8');
      controlSources.set(key, content);
      for (const statement of parse(content).statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const named = statement.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const item of named.elements) {
          const exported = item.propertyName?.text ?? item.name.text;
          if (customControls.has(exported)) loadControlSource(statement.moduleSpecifier.text, exported, resolved);
        }
      }
    };
    walk(parse(source), (node) => {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        return;
      const from = node.moduleSpecifier.text;
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const item of named.elements) {
          const name = item.propertyName?.text ?? item.name.text;
          if (!customControls.has(name)) continue;
          loadControlSource(from, name, file);
        }
      }
      if (!from.endsWith(".settings-search")) return;
      const resolved = from.startsWith("@/")
        ? path.join(root, "apps/desktop/src/renderer", from.slice(2) + ".ts")
        : path.resolve(root, path.dirname(file), from + ".ts");
      // Only glob-discovered metadata counts; importing an arbitrary file cannot pass.
      const relative = path.relative(path.join(root, settingsDir), resolved);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !existsSync(resolved)
      )
        return;
      for (const name of registeredDefinitionExports(
        readFileSync(resolved, "utf8"),
      ))
        registered.add(`${from}#${name}`);
    });
    for (const error of inspectSettingsControls(
      source,
      previous,
      registered,
      indexedTextKeys,
      controlSources,
    ))
      errors.push(`${file}:${error.line}: ${error.message}`);
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const baseIndex = process.argv.indexOf("--base-ref");
    const errors = checkSettingsSearch(
      baseIndex < 0 ? "HEAD" : process.argv[baseIndex + 1],
    );
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else console.log("Settings search coverage: passed");
  } catch (error) {
    console.error(`Settings search coverage could not run: ${error.message}`);
    process.exitCode = 1;
  }
}
