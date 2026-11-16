/** Read-only retention inventory. No deletion: worktrees, live processes and receipts need a
 * separate revalidation at deletion time. Never infer ownership from a directory name alone. */
import fs from 'node:fs';
import path from 'node:path';
import {readJournal} from './recovery.mjs';

export function retentionPlan(c) {
  const state = c.runtime.stateDir, roots = [state, path.join(state, 'automatic', 'versions')];
  const protectedDirs = new Map([[c.app.checkout,'source'],[c.runtime.clientDir,'configured client'],[c.runtime.stagingDir,'configured staging']]);
  const issues = [], entries = [];
  const protect = (release, reason) => { if(release?.directory)protectedDirs.set(path.resolve(release.directory),reason); };
  try {
    const journal = readJournal(path.join(state,'automatic/journal.json'));
    if(journal.phase !== 'stable')issues.push(`journal is ${journal.phase}`);
    for(const key of ['good','selected','previous','failed'])protect(journal[key],`journal ${key}`);
  } catch { issues.push('journal unavailable; no cleanup candidates'); }
  for(const name of ['candidate','known-good']) {
    const file=path.join(state,'automatic',`${name}.json`);
    if(!fs.existsSync(file))continue;
    try { protect(JSON.parse(fs.readFileSync(file,'utf8')),name); }
    catch { issues.push(`${name} receipt unreadable`); }
  }
  for(const root of roots) {
    if(!fs.existsSync(root))continue;
    for(const item of fs.readdirSync(root,{withFileTypes:true})) {
      if(!item.isDirectory() || item.isSymbolicLink())continue;
      const directory=path.join(root,item.name), file=path.join(directory,'report.json');
      if(!fs.existsSync(file))continue; // Unrecognized directories are never cleanup candidates.
      try {
        const report=JSON.parse(fs.readFileSync(file,'utf8')), checkout=path.join(directory,'app');
        if(report.version!==1 || report.directory!==checkout || report.name!==c.name || report.region!==c.region || !Number.isFinite(Date.parse(report.createdAt))) {
          entries.push({directory,keep:true,reason:'unrecognized receipt'}); continue;
        }
        entries.push({directory,checkout,createdAt:report.createdAt,state:report.state,keep:true,
          reason:protectedDirs.get(checkout) || 'pending retention evaluation'});
      } catch { entries.push({directory,keep:true,reason:'unreadable receipt'}); }
    }
  }
  const recognized=entries.filter(e=>e.checkout).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const recent=new Set(recognized.slice(0,2).map(e=>e.directory));
  const checked=recognized.find(e=>e.state==='checked');
  for(const entry of recognized) {
    if(protectedDirs.has(entry.checkout))continue;
    if(issues.length)entry.reason='blocked by incomplete lifecycle evidence';
    else if(recent.has(entry.directory))entry.reason='one of the two latest preparations';
    else if(entry===checked)entry.reason='latest checked preparation';
    else { entry.keep=false; entry.reason='review for cleanup; recheck live processes, dirty worktree and references before deletion'; }
  }
  return {version:1,dryRun:true,deletionSupported:false,issues,entries,
    retainedOutsideInventory:['runtime caches and install backups','tool versions','unrecognized directories and worktrees']};
}
