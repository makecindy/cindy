#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, variantsFor, LOCALES } from './options.mjs';
import { adhocPage, loadPages } from './registry.mjs';
import { root } from './build.mjs';
import { prSnippet } from './pr.mjs';

const HELP = `pnpm ui:check [selection] [matrix] [runtime]

selection (one of):
  --page <name>            registered page (pnpm ui:check --list)
  --entry <file.tsx>       ad-hoc entry calling mountPage(); generic checks + screenshots
  --changed[=<ref>]        pages that load files changed since the upstream merge-base
matrix (comma lists; every combination runs in one browser):
  --case <name,…|all>      default: default
  --theme light,dark|all   default: light
  --locale <list>|all      ${LOCALES.join(', ')} (default: zh-CN)
  --viewport 1280x800,…    default: the page/case viewport
  --platform darwin|win32|linux   value of electronAPI.platform (default: this machine)
runtime:
  --compare [<ref>]        also render the source at <ref> (default: upstream merge-base); overview pairs before/after
  --focus <css selector>   2x crop + measured box/padding/font of one element at every capture
  --engine chromium|electron  --browser <path>  --timeout <ms per variant>  --output <dir>
  --json                   print summary.json instead of the text report
pnpm ui:preview <page and single variant>   keep one window open; rebuilds on source edits`;

function report(summary) {
  const after = summary.variants.filter((variant) => variant.role === 'after');
  const passed = after.filter((variant) => variant.status === 'passed').length;
  const lines = [
    summary.mode === 'preview'
      ? `UI_PREVIEW ${summary.status} · ${summary.reloads ?? 0} reloads · ${(summary.timings.totalMs / 1000).toFixed(1)}s`
      : `UI_CHECK ${summary.status} ${passed}/${after.length} variants · ${(summary.timings.totalMs / 1000).toFixed(1)}s (build ${summary.timings.buildMs ?? 0}ms, launch ${summary.timings.launchMs ?? 0}ms)`,
  ];
  const overviews = summary.overviews ?? (summary.overview ? [summary.overview] : []);
  if (overviews.length)
    lines.push(
      `overview: ${overviews[0]}` +
        (overviews.length > 1
          ? ` (+${overviews.length - 1}: ${overviews
              .slice(1)
              .map((file) => path.basename(file))
              .join(', ')})`
          : ''),
    );
  lines.push(`summary:  ${path.join(summary.evidence, 'summary.json')}`);
  if (summary.pr)
    lines.push(
      `pr:       ${summary.pr} — 发 PR 前运行 pnpm ui:check:publish，把截图发到你的 fork 并生成带图的「UI 变化」`,
    );
  for (const page of summary.pages) {
    const replaced = Object.entries(page.replaced);
    lines.push(
      `page ${page.name}: real — ${page.real}`,
      `  not covered — ${page.notCovered}`,
      replaced.length
        ? `  replaced — ${replaced.map(([key, info]) => `${key} (${info.kind})`).join(', ')}`
        : '  replaced — none',
    );
    if (page.compare)
      lines.push(
        `  compare ${page.compare.ref}: ` +
          (page.compare.replacedFromRef.length
            ? `${page.compare.replacedFromRef.length} files from ref`
            : 'no loaded product file differs from ref; before = now, not rendered') +
          (page.compare.newSinceRef.length
            ? `; new since ref (used as-is): ${page.compare.newSinceRef.join(', ')}`
            : '') +
          (page.compare.currentOnBothSides?.length
            ? `; current on both sides: ${page.compare.currentOnBothSides.join(', ')}`
            : ''),
      );
  }
  for (const variant of after) {
    const mark = variant.status === 'passed' ? 'ok  ' : 'FAIL';
    lines.push(
      `${mark} ${variant.id}${variant.warnings.length ? ` · ${variant.warnings.length} warnings` : ''}`,
    );
    for (const error of variant.errors.slice(0, 3))
      lines.push(`     error: ${error.split('\n')[0]}`);
    if (variant.status !== 'passed' && variant.hostMissing.length)
      lines.push(
        `     host APIs read but not provided: ${variant.hostMissing.slice(0, 8).join(', ')}`,
      );
    for (const warning of variant.warnings.slice(0, 4)) lines.push(`     warn: ${warning}`);
    for (const item of variant.focus ?? [])
      lines.push(
        `     focus ${item.capture}: ${item.box.width}×${item.box.height} · padding ${item.padding} · gap ${item.gap} · ${item.font}` +
          (item.clippedChildren ? ` · ${item.clippedChildren} clipped` : ''),
      );
    // The pre-change side never fails the run; show what differed there so it can be compared.
    const before = summary.variants.find(
      (other) => other.role === 'before' && other.id === variant.id,
    );
    if (before) {
      for (const note of [...before.errors, ...before.warnings].slice(0, 3))
        lines.push(`     before ${summary.compare?.ref}: ${note.split('\n')[0]}`);
      for (const item of before.focus ?? [])
        lines.push(
          `     before focus ${item.capture}: ${item.box.width}×${item.box.height} · padding ${item.padding} · gap ${item.gap} · ${item.font}`,
        );
    }
  }
  for (const error of summary.errors) lines.push(`error: ${error.split('\n')[0]}`);
  const coverage = summary.coverage;
  if (coverage) {
    lines.push(`changed since ${coverage.base.slice(0, 10)}: ${coverage.changedCount} files`);
    for (const [file, pages] of Object.entries(coverage.covered))
      lines.push(`  loaded  ${file} → ${pages.join(', ')}`);
    for (const [file, pages] of Object.entries(coverage.replacedOnly))
      lines.push(`  STUBBED ${file} → replaced in ${pages.join(', ')}; not verified there`);
    for (const file of coverage.uncovered) lines.push(`  UNCOVERED ${file}`);
    if (coverage.uncovered.length)
      lines.push(
        '  Uncovered files are NOT verified: add a case/page, use --entry, or verify in the full app.',
      );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) return console.log(HELP);
  if (options.compare === true)
    options.compare = (await import('./coverage.mjs')).baseRef(true).slice(0, 12);
  const pages = await loadPages();
  if (options.list) {
    for (const page of Object.values(pages)) {
      console.log(`${page.name}  (${path.relative(root, page.file)})`);
      console.log(`  real: ${page.real}\n  not covered: ${page.notCovered}`);
      for (const [name, item] of Object.entries(page.cases))
        console.log(`  --case ${name}: ${item.about}`);
    }
    return;
  }
  const plan = { pages: [] };
  if (options.changed) {
    const { changedFiles, coverageFor } = await import('./coverage.mjs');
    const { base, files } = changedFiles(options.changed);
    const coverage = await coverageFor(pages, files);
    plan.coverage = { base, changedCount: files.length, ...coverage };
    plan.label = 'changed';
    // Changed pages run every case unless a case list was given explicitly.
    if (!process.argv.includes('--case') && !process.argv.some((arg) => arg.startsWith('--case=')))
      options.cases = 'all';
    for (const name of coverage.selected) plan.pages.push({ definition: pages[name] });
    if (!plan.pages.length) {
      const text = report({
        status: 'nothing-to-run',
        variants: [],
        pages: [],
        errors: [],
        timings: { totalMs: 0 },
        evidence: '-',
        coverage: plan.coverage,
      });
      console.log(options.json ? JSON.stringify(plan.coverage, null, 2) : text);
      process.exitCode = 0;
      return;
    }
  } else if (options.entry) {
    plan.pages.push({ definition: adhocPage(options.entry) });
  } else {
    if (!options.page) throw new Error('Choose --page, --entry or --changed (see --list)');
    if (!pages[options.page]) throw new Error(`Unknown page: ${options.page}; use --list`);
    plan.pages.push({ definition: pages[options.page] });
  }
  if (options.changed && options.cases !== 'all') {
    // A case list with --changed applies to the pages that declare those cases.
    const wanted = options.cases.split(',').map((name) => name.trim());
    const matching = plan.pages.filter((item) =>
      wanted.some((name) => item.definition.cases[name]),
    );
    if (!matching.length) throw new Error(`No changed page declares --case ${options.cases}`);
    plan.pages = matching.map((item) => ({
      ...item,
      cases: wanted.filter((name) => item.definition.cases[name]).join(','),
    }));
  }
  for (const item of plan.pages)
    item.variants = variantsFor(
      item.definition,
      item.cases ? { ...options, cases: item.cases } : options,
    );
  const { runPlan } = await import('./run.mjs');
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('用户中断单页验证'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const summary = await runPlan(plan, options, stop.signal);
    if (summary.mode === 'check' && summary.variants.length) {
      summary.pr = path.join(summary.evidence, 'pr.md');
      await writeFile(summary.pr, prSnippet(summary, process.argv.slice(2)));
    }
    console.log(options.json ? JSON.stringify(summary, null, 2) : report(summary));
    if (!['passed', 'preview-closed'].includes(summary.status)) process.exitCode = 1;
    // A scenario still running after its timeout keeps this process alive; end once output is out.
    if (summary.strandedScenarios?.length) process.stdout.write('', () => process.exit());
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main().catch((error) => {
  console.error(`单页验证未能运行：${error.message}\n运行 pnpm ui:check --help 查看参数。`);
  process.exitCode = 2;
});
