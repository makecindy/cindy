import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aliases = JSON.parse(
  await readFile(
    path.join(root, "scripts/browser-recipe-aliases.json"),
    "utf8",
  ),
);
const upstream = JSON.parse(
  await readFile(
    path.join(root, "packages/opencli-vendor/cli-manifest.json"),
    "utf8",
  ),
);
const snapshot = JSON.parse(
  await readFile(
    path.join(root, "packages/opencli-vendor/UPSTREAM.json"),
    "utf8",
  ),
);
const commands = new Map(
  upstream.map((entry) => [`${entry.site}/${entry.name}`, entry]),
);
const directory = path.join(root, "packages/lizi-mcps/src/browser/recipes");
const reviewed = [];
for (const site of (await readdir(path.join(directory, '../recipe-examples'))).sort()) {
  const recipe = JSON.parse(await readFile(path.join(directory, '../recipe-examples', site, 'recipe.json'), 'utf8'));
  reviewed.push({ recipe: recipe.id, status: 'example-only', reason: 'Scraping sandbox; excluded from the product catalog' });
}
for (const site of (await readdir(directory)).sort()) {
  const recipePath = path.join(directory, site, "recipe.json");
  const guidePath = path.join(directory, site, "siteguide.json");
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  const guide = JSON.parse(await readFile(guidePath, "utf8"));
  const alias = aliases[recipe.id];
  if (alias) {
    const [id, rename = {}] = typeof alias === "string" ? [alias] : alias;
    const command = commands.get(id);
    if (!command) throw new Error(`Missing upstream command: ${id}`);
    const reverse = Object.fromEntries(
      Object.entries(rename).map(([from, to]) => [to, from]),
    );
    const inputs = Object.fromEntries(
      command.args.map((arg) => [
        reverse[arg.name] ?? arg.name,
        {
          required: arg.required,
          type: arg.type,
          default: arg.default,
          description: arg.help,
          ...(arg.choices ? { choices: arg.choices } : {}),
        },
      ]),
    );
    const updated = {
      id: recipe.id,
      match: recipe.match,
      description: command.description,
      access: command.access,
      adapter: id,
      ...(Object.keys(rename).length ? { adapterInputMap: rename } : {}),
      inputs,
      steps: [],
    };
    await writeFile(recipePath, JSON.stringify(updated, null, 2) + "\n");
    guide.auth = `鉴权以具体命令为准：${command.strategy ?? (command.browser === false ? "public/local" : "browser")}。需要登录的命令复用当前浏览器会话。`;
    guide.entry = command.domain ? { home: `https://${command.domain}` } : {};
    delete guide.pages;
    guide.notes = `兼容入口 ${recipe.id} 现执行内置 ${id}，原参数名保留；结果采用新版适配器的结构化输出。可用 opencli:<站点>/<命令> 调用完整目录，siteguide 查询参数默认值、类型及 read/write 分类。网站可能变更或要求登录、验证；有 Cookie 不保证绕过风控。`;
    reviewed.push({ recipe: recipe.id, adapter: id, status: "updated" });
  } else {
    recipe.access = "read";
    await writeFile(recipePath, JSON.stringify(recipe, null, 2) + "\n");
    // These flows have no equivalent upstream contract (e.g. public podcast
    // HTML vs upstream's credential-requiring mobile API). Keep them runnable.
    guide.notes = `${(guide.notes ?? "").split("\n完整目录更新时保留此 Cindy 独立配方：")[0]}\n完整目录更新时保留此 Cindy 独立配方：上游没有相同的接口或免登录/参数合同。本站可用能力以 siteguide 当前目录为准。`;
    reviewed.push({
      recipe: recipe.id,
      status: "native-preserved",
      reason: "No equivalent upstream input/auth contract",
    });
  }
  guide.upstream = {
    repository: snapshot.repository,
    revision: snapshot.revision,
  };
  await writeFile(guidePath, JSON.stringify(guide, null, 2) + "\n");
}
await writeFile(
  path.join(root, "packages/opencli-vendor/cindy/legacy-coverage.json"),
  JSON.stringify(reviewed, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    legacy: reviewed.length,
    updated: reviewed.filter((row) => row.adapter).length,
    native: reviewed.filter((row) => row.status === 'native-preserved').length,
    examples: reviewed.filter((row) => row.status === 'example-only').length,
  }),
);
