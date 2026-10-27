/** Cindy integration for the pinned upstream snapshot and recorded host patches. */
import expandedCatalog, { canonicalCatalog as manifest } from './catalog.js';
import { getRegistry, type CliCommand, type Arg } from "../src/registry.js";
import { executePipeline } from "../src/pipeline/index.js";
import type { IPage } from "../src/types.js";
import { modules } from "./modules.js";
import { withRecipeHost, type RecipeSecrets, type RecipeFiles } from "./host.js";
export type { RecipeSecrets, RecipeFiles } from "./host.js";

export { CDPBasePage } from "../src/browser/base-page.js";
export { buildEvaluateExpression } from "../src/browser/utils.js";
export { waitForDomStableJs } from "../src/browser/dom-helpers.js";
export type {
  IPage,
  BrowserCookie,
  BrowserEvaluateFunction,
  ScreenshotOptions,
} from "../src/types.js";
export const catalog = manifest;
const entries = new Map(
  expandedCatalog.map((entry) => [`${entry.site}/${entry.name}`, entry]),
);

export async function loadAdapter(id: string): Promise<CliCommand> {
  const entry = entries.get(id);
  if (!entry) throw new Error(`Unknown bundled adapter: ${id}`);
  const load = modules[entry.modulePath];
  if (!load) throw new Error(`Missing bundled adapter module: ${id}`);
  const command = getRegistry().get(id);
  if (!command?.func && !command?.pipeline)
    throw new Error(`Adapter did not register: ${id}`);
  return command;
}

export function prepareInputs(
  args: Arg[],
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...inputs };
  for (const arg of args) {
    const value = result[arg.name] ?? arg.default;
    if (
      arg.required &&
      (value === undefined || value === null || value === "")
    ) {
      throw new Error(
        `Missing required input: ${arg.name}${arg.help ? ` (${arg.help})` : ""}`,
      );
    }
    if (value === undefined) continue;
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        `Input ${arg.name} must be finite and safe; pass large identifiers as strings`,
      );
    }
    if (arg.type === "int" || arg.type === "number") {
      const number = Number(value);
      if (
        !Number.isFinite(number) ||
        Math.abs(number) > Number.MAX_SAFE_INTEGER ||
        (arg.type === "int" && !Number.isInteger(number))
      ) {
        throw new Error(`Invalid ${arg.type} input: ${arg.name}`);
      }
      result[arg.name] = number;
    } else if (arg.type === "bool" || arg.type === "boolean") {
      if (value === true || value === "true" || value === "1" || value === 1)
        result[arg.name] = true;
      else if (
        value === false ||
        value === "false" ||
        value === "0" ||
        value === 0
      )
        result[arg.name] = false;
      else throw new Error(`Invalid boolean input: ${arg.name}`);
    } else result[arg.name] = value;
    if (
      arg.choices?.length &&
      !arg.choices.map(String).includes(String(result[arg.name]))
    ) {
      throw new Error(
        `Input ${arg.name} must be one of: ${arg.choices.join(", ")}`,
      );
    }
  }
  return result;
}

export async function executeAdapter(
  id: string,
  inputs: Record<string, unknown>,
  page: IPage,
  secrets?: RecipeSecrets,
  onExecutionStart?: () => void,
  files?: RecipeFiles,
): Promise<unknown> {
  return withRecipeHost(secrets, async () => {
    const command = await loadAdapter(id);
    const entry = entries.get(id)!;
    const excludedArg = entry.excludedArgs?.find(name => Object.prototype.hasOwnProperty.call(inputs, name));
    if (excludedArg) throw new Error(`Recipe mode is unavailable in Cindy: ${excludedArg}; use the selected recipe inputs`);
    // Discovery and execution use the same selected argument defaults.
    const args = prepareInputs(entry.args, inputs);
    if (!files?.output) {
      const skip = entry.args.find(arg => ['sd', 'skip-download', 'no-download'].includes(arg.name));
      if ((skip && args[skip.name] !== true) || (id === 'web/read' && args.stdout !== true)) {
        throw new Error('Local recipe file export is unavailable; keep the link-only or content-only mode');
      }
    }
    command.validateArgs?.(args);
    onExecutionStart?.();
    if (
      command.browser !== false &&
      typeof command.navigateBefore === "string"
    ) {
      await page.goto(command.navigateBefore);
    }
    // No generic replay of writes. Site-specific behavior remains upstream-owned.
    if (command.pipeline)
      return executePipeline(
        command.browser === false ? null : page,
        command.pipeline,
        { args, stepRetries: 0 },
      );
    if (command.browser === false) return command.func!(args);
    return command.func!(page, args);
  }, files);
}
