/** Compatibility for existing build-personal.sh callers; all work goes through the public CLI. */
import fs from 'node:fs';
import path from 'node:path';
import { main, configFrom } from '../personal-build.mjs';
import { save } from './managed.mjs';
export async function legacyBuild(args) {
  const file = process.env.PERSONAL_CONFIG;
  if (!file) throw new Error('PERSONAL_CONFIG is required');
  const c = configFrom(file);
  const base = path.resolve(path.dirname(file), c.runtime?.stateDir || '.');
  const marker = path.join(base, 'last-build.json');
  let resume = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--continue') resume = true;
    else if (args[i] === '--author' && args[i + 1]) c.author = args[++i];
    else if (args[i] === '--exclude' && args[i + 1]) {
      const values = args[++i].split(',').map(Number);
      if (!values.every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid PR exclusion list');
      c.app.exclude = values;
    } else throw new Error(`Unknown legacy argument ${args[i]}`);
  }
  let info;
  if (resume) info = JSON.parse(fs.readFileSync(marker, 'utf8'));
  else {
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const scratch = process.env.SCRATCH ? path.resolve(process.env.SCRATCH) : path.join(base, 'builds', id);
    if (fs.existsSync(scratch)) throw new Error('SCRATCH exists; use --continue or a new directory');
    fs.mkdirSync(scratch, { recursive: true });
    info = { config: path.join(scratch, 'config.json'), report: path.join(scratch, 'composition/report.json'), output: process.env.OUT ? path.resolve(process.env.OUT, `personal-${id}`) : path.join(scratch, 'export') };
    save(info.config, c); save(marker, info);
  }
  if (resume) {
    const report = JSON.parse(fs.readFileSync(info.report, 'utf8'));
    if (report.state === 'failed') await main(['continue', '--report', info.report]);
  } else await main(['prepare', '--config', info.config, '--out', path.dirname(info.report)]);
  await main(['check', '--report', info.report]);
  await main(['export', '--report', info.report, '--out', info.output]);
  console.log(`Build checked and exported: ${info.output}`);
}
