/** One-time DB import seed; uses the reviewed translations already shipped to users. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelDescriptionKey } from "../src/legacyModelDescriptions.js";
import {
  MODEL_PRESENTATION_LOCALES,
  type ModelPresentation,
} from "../src/modelPresentation.js";
import { parseModelRegistry } from "../src/modelAccessValidator.js";
const [registryPath, localesPath, output] = process.argv.slice(2);
if (!registryPath || !localesPath || !output)
  throw new Error(
    "Usage: tsx exportModelPresentationSeed.ts <registry.json> <desktop-locales-directory> <new-output.json>",
  );
const parsed = parseModelRegistry(
  JSON.parse(await readFile(registryPath, "utf8")),
);
if (!parsed.ok) throw new Error(parsed.error);
const registry = parsed.value;
const locales = Object.fromEntries(
  await Promise.all(
    MODEL_PRESENTATION_LOCALES.map(async (locale) => [
      locale,
      JSON.parse(
        await readFile(join(localesPath, locale, "common.json"), "utf8"),
      ).modelDescriptions,
    ]),
  ),
);
const copy = (model: {
  id: string;
  mode?: string;
  group?: string;
}): ModelPresentation => {
  const key = modelDescriptionKey(model);
  return key
    ? Object.fromEntries(
        MODEL_PRESENTATION_LOCALES.flatMap((locale) =>
          typeof locales[locale]?.[key] === "string" && locales[locale][key]
            ? [[locale, { description: locales[locale][key] }]]
            : [],
        ),
      )
    : {};
};
const baseModels = Object.fromEntries(
  (registry.baseModels ?? []).flatMap((base) => {
    const presentation = copy({ id: base.id, ...base.defaults });
    return Object.keys(presentation).length ? [[base.id, presentation]] : [];
  }),
);
const models = Object.fromEntries(
  registry.models.flatMap((model) => {
    const presentation = copy(model);
    return Object.keys(presentation).length &&
      JSON.stringify(presentation) !==
        JSON.stringify(model.modelRef ? baseModels[model.modelRef] : undefined)
      ? [[model.id, presentation]]
      : [];
  }),
);
await writeFile(
  output,
  JSON.stringify({ version: 1, baseModels, models }, null, 2) + "\n",
  { flag: "wx" },
);
process.stdout.write(
  `Exported ${Object.keys(baseModels).length} shared and ${Object.keys(models).length} access-specific editorial copies.\n`,
);
