// `pr.md`: the run described for the PR template's「UI 变化」section. The last line is a
// placeholder that `pnpm ui:check:publish` replaces with the published screenshots.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PLATFORM = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

// Arguments are pasted back into a shell, so quote anything a shell would expand.
const shellArg = (arg) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

const measured = (item) =>
  `${item.box.width}×${item.box.height}，padding ${item.padding}，gap ${item.gap}，${item.font}`;

function list(values) {
  return [...new Set(values)].join(' / ');
}

export function prSnippet(summary, argv) {
  const variants = summary.variants.filter((variant) => variant.role === 'after');
  const passed = variants.filter((variant) => variant.status === 'passed').length;
  const warnings = variants.reduce((count, variant) => count + variant.warnings.length, 0);
  const runtime = summary.versions?.electron
    ? `Electron ${summary.versions.electron}（Chromium ${summary.versions.chrome}，与 Cindy 同一渲染内核）`
    : `Chromium ${summary.versions?.chrome ?? '?'}`;
  const lines = [
    '<!-- 由 pnpm ui:check 生成；pnpm ui:check:publish 把截图发到作者 fork 并换上图片链接 -->',
    `- 截图来源：单页验证 \`pnpm ui:check ${argv.map(shellArg).join(' ')}\`，${PLATFORM[process.platform] ?? process.platform} · ${runtime}；` +
      '真实组件与主题，场景数据，不是登录账号下的完整 Cindy',
    `- 版本：\`${summary.commit?.slice(0, 12) ?? '未知'}\`${summary.worktreeDirty ? '（含未提交改动）' : ''}`,
    `- 结果：${passed}/${variants.length} 个场景通过${warnings ? `，${warnings} 条警告` : ''}`,
  ];
  const simulated = [...new Set(variants.map((variant) => variant.platform))].filter(
    (platform) => platform !== process.platform,
  );
  if (simulated.length)
    lines.push(
      `- 模拟平台：页面按 ${simulated.map((platform) => PLATFORM[platform] ?? platform).join(' / ')} 渲染`,
    );
  for (const page of summary.pages) {
    const own = variants.filter((variant) => variant.page === page.name);
    const cases = [...new Map(own.map((variant) => [variant.case, variant.about])).entries()];
    lines.push(
      `- 页面 \`${page.name}\`：${list(own.map((variant) => variant.theme))} · ${list(own.map((variant) => variant.locale))} · ${list(own.map((variant) => `${variant.viewport.width}×${variant.viewport.height}`))}`,
      ...cases.map(([name, about]) => `  - \`${name}\`：${about ?? name}`),
      `  - 未覆盖：${page.notCovered}`,
    );
    const replaced = Object.keys(page.replaced);
    if (replaced.length)
      lines.push(`  - 场景替换的模块（未验证）：${replaced.map((key) => `\`${key}\``).join('、')}`);
    if (page.compare)
      lines.push(
        page.compare.replacedFromRef.length
          ? `  - 改前／改后对照：\`${page.compare.ref}\`，同一步骤左右并排`
          : `  - 改前／改后对照：\`${page.compare.ref}\` 之后没有改动本页面加载的产品文件`,
      );
    if (page.compare?.currentOnBothSides?.length)
      lines.push(
        `  - 对照两侧都用当前版本：${page.compare.currentOnBothSides.map((file) => `\`${file}\``).join('、')}`,
      );
  }
  // `--focus` measurements: the last capture where the element was visible, before → now.
  for (const variant of variants) {
    const now = variant.focus?.at(-1);
    if (!now) continue;
    const before = summary.variants
      .find((other) => other.role === 'before' && other.id === variant.id)
      ?.focus?.find((item) => item.capture === now.capture);
    lines.push(
      `- 实测 \`${variant.case}\` ${variant.theme} ${variant.locale}（${now.capture}）：` +
        (before ? `${measured(before)} → ${measured(now)}` : measured(now)),
    );
  }
  const failed = variants.filter((variant) => variant.status !== 'passed');
  for (const variant of failed)
    lines.push(`- 未通过：\`${variant.id}\` — ${variant.errors[0]?.split('\n')[0] ?? ''}`);
  if (summary.coverage?.uncovered.length)
    lines.push(
      `- 本分支改动中没有被单页验证覆盖的界面文件：${summary.coverage.uncovered.map((file) => `\`${file}\``).join('、')}`,
    );
  const images = summary.overviews ?? (summary.overview ? [summary.overview] : []);
  lines.push(
    '',
    `<!-- 截图：${images.map((file) => path.basename(file)).join('、') || '（本次没有生成总览图）'} -->`,
    '',
  );
  return lines.join('\n');
}

const THEMES = ['light', 'dark'];

const captureName = (file) => path.basename(file, '.png').replace(/\.focus$/, '');
// `--focus` crops when the run made them, so the changed element is legible in the PR.
const shotsOf = (variant) =>
  variant?.focus?.length ? variant.focus.map((item) => item.file) : (variant?.screenshots ?? []);
// One capture of a before/after pair. The crop is used only when both sides have it: the
// element may exist on one side only, and a crop next to a full page is not comparable.
const pairedShots = (before, after, name) => {
  const crop = (variant) => variant.focus?.find((item) => item.capture === name)?.file;
  const full = (variant) => variant.screenshots.find((file) => captureName(file) === name);
  const [b, a] =
    crop(before) && crop(after) ? [crop(before), crop(after)] : [full(before), full(after)];
  return { before: b ?? null, after: a };
};

/**
 * Captures for the PR description, as rows of side-by-side columns. With `--compare`: every
 * capture whose before and after differ, 改前 | 改后, in run order. Otherwise: each scenario's
 * last capture, Light | Dark. `cases` limits the scenarios.
 */
export async function prShots(summary, dir, { cases } = {}) {
  const variants = summary.variants.filter(
    (variant) => variant.role === 'after' && (!cases?.length || cases.includes(variant.case)),
  );
  const size = (variant) => `${variant.viewport.width}×${variant.viewport.height}`;
  const rows = [];
  if (summary.compare) {
    const bytes = (file) => readFile(path.join(dir, file));
    for (const variant of variants) {
      const before = summary.variants.find(
        (other) => other.role === 'before' && other.id === variant.id,
      );
      // No pre-change render: nothing this page loads changed since the ref.
      if (!before) continue;
      for (const name of variant.screenshots.map(captureName)) {
        const { before: pair, after: file } = pairedShots(before, variant, name);
        if (!file) continue;
        if (pair && (await bytes(pair)).equals(await bytes(file))) continue;
        rows.push({
          title: `${variant.case} · ${name}`,
          subtitle: `${variant.theme} · ${variant.locale} · ${size(variant)}`,
          columns: [
            { label: `改前（${summary.compare.ref}）`, file: pair ?? null },
            { label: '改后', file },
          ],
        });
      }
    }
  } else {
    const groups = new Map();
    for (const variant of variants) {
      const file = shotsOf(variant).at(-1);
      if (!file) continue;
      const key = [variant.page, variant.case, variant.locale, size(variant)].join('|');
      if (!groups.has(key))
        groups.set(key, {
          title: `${variant.case} · ${captureName(file)}`,
          subtitle: `${variant.locale} · ${size(variant)}`,
          columns: [],
        });
      groups.get(key).columns.push({
        label: variant.theme === 'dark' ? 'Dark' : 'Light',
        theme: variant.theme,
        file,
      });
    }
    for (const row of groups.values()) {
      row.columns.sort((a, b) => THEMES.indexOf(a.theme) - THEMES.indexOf(b.theme));
      rows.push(row);
    }
  }
  return rows;
}
