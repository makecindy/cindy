import fs from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git status -s', { cwd: process.cwd() })
  .toString()
  .split('\n')
  .filter((l) => l.startsWith('UU'))
  .map((l) => l.slice(3).trim());
if (files.length === 0) {
  // 工作树已无 UU(此前部分解决):直接扫残留标记
  const out = execSync('grep -rl "<<<<<<<" apps/desktop/src/renderer/i18n/locales apps/mobile/src/i18n/locales || true')
    .toString()
    .split('\n')
    .filter(Boolean);
  files.push(...out);
}
console.log('files:', files.length);
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(/<<<<<<< HEAD[\s\S]*?=======\r?\n([\s\S]*?)>>>>>>> upstream\/main\r?\n/g, '$1');
  fs.writeFileSync(f, s);
  JSON.parse(fs.readFileSync(f, 'utf8'));
  if (/^<<<<<<<|^>>>>>>>|^=======\s*$/m.test(s)) throw new Error('markers left: ' + f);
  console.log('ok:', f);
}
