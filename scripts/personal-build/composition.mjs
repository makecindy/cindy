/** Resumable worktree composition. Conflict resolutions use Git rerere in the user's source repository. */
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../personal-build.mjs';
import { save } from './managed.mjs';
const check = (ok, message) => { if (!ok) throw new Error(message); };
export function resumableCompose(repo, selection, worktree, stateFile, exec = run) {
  const identity = repo.identity ? ['-c', `user.name=${repo.identity.name}`, '-c', `user.email=${repo.identity.email}`] : [];
  const git = (cwd, ...args) => exec('git', ['-C', cwd, ...identity, '-c', 'rerere.enabled=true', '-c', 'rerere.autoupdate=true', ...args], cwd);
  let state;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check(state.repository === repo.repository && state.worktree === worktree, 'Composition state belongs to a different repository');
    if (state.pending) {
      let merging = false;
      try { git(worktree, 'rev-parse', '--verify', 'MERGE_HEAD'); merging = true; } catch { /* Merge committed. */ }
      check(!merging && git(worktree, 'status', '--porcelain', '--untracked-files=no') === '', `Resolve and commit the merge in ${worktree}, then continue`);
      git(worktree, 'merge-base', '--is-ancestor', state.pending.sha, 'HEAD');
      git(worktree, 'merge-base', '--is-ancestor', state.before, 'HEAD');
      state.completed.push(state.pending); state.pending = null; save(stateFile, state);
    }
  } else {
    const name = git(repo.checkout, 'config', 'user.name'), email = git(repo.checkout, 'config', 'user.email');
    check(name && email, 'Set Git identity before composing');
    const steps = selection.selected.map(p => ({ ...p, label: `PR #${p.number}` }));
    for (const ref of repo.localRefs || []) steps.push({ ref, label: `local ${ref}`, sha: git(repo.checkout, 'rev-parse', '--verify', `${ref}^{commit}`) });
    for (const commit of [selection.baseSha, ...selection.selected.map(p => p.sha)]) git(repo.checkout, 'fetch', '--no-tags', '--no-write-fetch-head', `https://github.com/${repo.repository}.git`, commit);
    git(repo.checkout, 'worktree', 'add', '--detach', worktree, selection.baseSha);
    state = { repository: repo.repository, base: selection.base, baseSha: selection.baseSha, worktree, steps, completed: [], name, email, excluded: selection.excluded };
    save(stateFile, state);
  }
  for (const step of state.steps.slice(state.completed.length)) {
    state.before = git(worktree, 'rev-parse', 'HEAD'); state.pending = step; save(stateFile, state);
    try {
      git(worktree, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-commit', step.sha);
    } catch (error) {
      const conflicts = git(worktree, 'diff', '--name-only', '--diff-filter=U');
      if (conflicts === 'docs/design-rules/design-inventory.md' && fs.existsSync(path.join(worktree, 'scripts/design-inventory.mjs'))) {
        git(worktree, 'checkout', '--ours', '--', conflicts);
        exec(process.execPath, ['scripts/design-inventory.mjs'], worktree);
        git(worktree, 'add', '--', conflicts);
      } else if (conflicts) throw new Error(`${step.label} conflicts. Resolve and commit in ${worktree}; run continue with the same report.`);
      // A command failure without a merge in progress must never be called resolved.
      try { git(worktree, 'rev-parse', '--verify', 'MERGE_HEAD'); } catch { throw error; }
    }
    let merging = false;
    try { git(worktree, 'rev-parse', '--verify', 'MERGE_HEAD'); merging = true; } catch { /* Already an ancestor. */ }
    if (merging) git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-m', `Personal build: ${step.label}\n\nSigned-off-by: ${state.name} <${state.email}>`);
    state.completed.push(step); state.pending = null; save(stateFile, state);
  }
  // This file is generated from the combined source; multiple independent PRs may each update it.
  if (fs.existsSync(path.join(worktree, 'scripts/design-inventory.mjs'))) {
    try { exec(process.execPath, ['scripts/design-inventory.mjs', '--check'], worktree); }
    catch {
      exec(process.execPath, ['scripts/design-inventory.mjs'], worktree);
      const inventory = 'docs/design-rules/design-inventory.md';
      check(git(worktree, 'diff', '--name-only') === inventory, 'Inventory regeneration changed unexpected files; inspect the composition');
      git(worktree, 'add', '--', inventory);
      git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-m', `Personal build: regenerate design inventory\n\nSigned-off-by: ${state.name} <${state.email}>`);
    }
  }
  state.target = git(worktree, 'rev-parse', 'HEAD'); save(stateFile, state);
  return { repository: repo.repository, checkout: repo.checkout, base: state.base, baseSha: state.baseSha, target: state.target,
    prs: state.completed.filter(p => p.number), localRefs: state.completed.filter(p => p.ref), excluded: state.excluded };
}
