import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const avatarData = 'data:image/png;base64,' + readFileSync(new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url)).toString('base64');
export default {
  name:'project-icon-list',entry:'./fixture.tsx',viewport:{width:360,height:420},
  real:'ProjectNode, SessionGroupNode, SessionEntryList, SessionItem and ProjectSettingsDialog',
  notCovered:'Full application shell, persisted project settings and device link transport. Example project names and tasks.',
  stubs:{'src/renderer/contexts/AuthContext':{partial:'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});'}},
  cases:{
    flat:{data:{avatarData,flat:'list'},about:'Project icons beside source labels on task cards'},
    compact:{data:{avatarData,flat:'text'},about:'Project icons beside source labels on compact task rows'},
    default:{data:{avatarData},about:'Sidebar folders preserve expand/collapse semantics regardless of saved project icon'},
    'idle-projects':{data:{avatarData,inactive:true},about:'Idle tasks fold independently under each project header (#11233)'},
    'idle-flat':{data:{avatarData,inactive:true,flat:'text'},about:'Idle tasks fold in a flat sidebar and can be shown again (#11233)'},
    'filtered-projects':{data:{avatarData,inactive:true,filtered:true},about:'Filtered project results show all matches and omit the inactivity toggle (#11233)'},
    'idle-groups':{data:{avatarData,inactive:true,groups:true},about:'Automation and dialogue headers offer independent idle toggles on hover (#11252)'},
  },
  async ready(page){await page.locator('[data-project-source] img, [data-project-working-dir="local:/Projects/Cindy"] .lucide-folder-open, [aria-label="Automation fixture"]').first().waitFor();},
  async check(page,ui){
    if (ui.case === 'idle-groups') {
      const automation = page.getByRole('region', { name: 'Automation fixture' });
      const dialogue = page.getByRole('region', { name: 'Dialogue fixture' });
      const expand = await ui.t('ccAgent.sidebar.expandAllSessions');
      const fold = await ui.t('ccAgent.sidebar.collapseInactiveSessions');
      const showOne = await ui.t('ccAgent.sidebar.showMoreSessions', { count: 1 });
      const weekly = automation.getByRole('button', { name: /每周用量报告/ });
      const idleDialogue = dialogue.locator('[data-session-id="demo-0-1"]');
      assert.equal(await automation.getByRole('button', { name: showOne, exact: true }).count(), 0);
      await dialogue.getByRole('button', { name: showOne, exact: true }).waitFor();

      await automation.getByText(await ui.t('ccAgent.layout.automations'), { exact: true }).hover();
      await automation.getByRole('button', { name: expand, exact: true }).click();
      await weekly.waitFor();
      assert.equal(await idleDialogue.count(), 0);
      assert.equal(await automation.getByRole('button', { name: fold, exact: true }).count(), 1);
      await ui.capture('automation-expanded');
      await automation.getByRole('button', { name: fold, exact: true }).click();
      assert.equal(await weekly.count(), 0);

      await dialogue.getByText(await ui.t('ccAgent.sidebar.dialogues'), { exact: true }).hover();
      await dialogue.getByRole('button', { name: expand, exact: true }).click();
      await idleDialogue.waitFor();
      assert.equal(await dialogue.getByRole('button', { name: fold, exact: true }).count(), 1);
      await ui.capture('dialogues-expanded');
      return;
    }
    if (ui.case === 'filtered-projects') {
      await page.locator('[data-session-id="demo-1-0"]').waitFor();
      const expand=await ui.t('ccAgent.sidebar.expandAllSessions');
      const fold=await ui.t('ccAgent.sidebar.collapseInactiveSessions');
      if (await page.getByRole('button', { name: expand, exact: true }).count() ||
          await page.getByRole('button', { name: fold, exact: true }).count()) {
        throw new Error('Filtered projects must not offer inactivity folding');
      }
      return;
    }
    if(ui.case === 'idle-projects') {
      const project=page.locator('[data-project-working-dir="local:/Projects/Cindy"]');
      const other=page.locator('[data-project-working-dir="local:/Projects/移动客户端"]');
      const hidden=page.locator('[data-session-id="demo-0-1"]');
      if(await hidden.count()) throw new Error('Idle task must start folded');
      // Regression for #11252: an open project with one idle task keeps only
      // its header action. This real-component UI check also covers a mixed list.
      const showOne=await ui.t('ccAgent.sidebar.showMoreSessions',{count:1});
      if(await other.getByRole('button',{name:showOne,exact:true}).count()) throw new Error('An all-idle project must not show a list footer');
      // UI regression for #11252: one visible and one idle task exercise the
      // hidden count and the real header geometry that locator.click() obscures.
      const header = project.locator('[data-project-header]');
      const expand = header.getByRole('button', { name: await ui.t('ccAgent.sidebar.expandAllSessions'), exact: true });
      const more = header.getByRole('button', { name: await ui.t('ccAgent.common.moreActions'), exact: true });
      const isRevealed = (button) => button.evaluate((element) => {
        for (let node = element; node && !node.matches('[data-project-header]'); node = node.parentElement) {
          if (getComputedStyle(node).opacity === '0') return false;
        }
        return getComputedStyle(element).pointerEvents !== 'none';
      });
      await page.mouse.move(0, 0);
      const resting = await expand.boundingBox();
      assert.ok(resting, 'The idle toggle must have a fixed slot before hover');
      assert.equal(await isRevealed(expand), false, 'The idle toggle should start hidden with the other actions');
      await project.getByRole('button', { name: showOne, exact: true }).waitFor();
      await ui.capture('inactive-folded');
      const x = resting.x + resting.width / 2;
      const y = resting.y + resting.height / 2;
      await header.focus();
      await page.keyboard.press('Tab');
      assert.equal(await isRevealed(expand), true, 'Keyboard focus must reveal the header actions');
      assert.deepEqual(await expand.boundingBox(), resting, 'Keyboard focus on project actions must not move the idle toggle');
      await page.mouse.click(0, 0);
      await page.mouse.move(x, y);
      assert.equal(await isRevealed(expand), true, 'Hovering must reveal the idle toggle');
      assert.equal(await isRevealed(more), true, 'Hovering must reveal the other actions together');
      assert.deepEqual(await expand.boundingBox(), resting, 'Hovering the project header must not move the idle toggle');
      await ui.capture('toggle-hover');
      await page.mouse.click(x, y);
      await hidden.waitFor();
      if(await other.locator('[data-session-id="demo-1-0"]').count()) throw new Error('Project controls must stay independent');
      await ui.capture('project-expanded');
      const fold = await ui.t('ccAgent.sidebar.collapseInactiveSessions');
      assert.equal(await project.getByRole('button', { name: fold, exact: true }).count(), 1);
      await header.getByRole('button', { name: fold, exact: true }).click();
      if(await hidden.count()) throw new Error('Idle task must fold again');
      return;
    }
    if(ui.case === 'idle-flat') {
      if(await page.locator('[data-session-id="demo-0-1"]').count()) throw new Error('Idle flat task must start folded');
      await ui.capture('inactive-folded');
      await page.getByRole('button',{name:await ui.t('ccAgent.sidebar.showMoreSessions',{count:5}),exact:true}).click();
      await page.locator('[data-session-id="demo-0-1"]').waitFor();
      await ui.capture('flat-expanded');
      await page.getByRole('button',{name:await ui.t('ccAgent.sidebar.collapseInactiveSessions'),exact:true}).click();
      if(await page.locator('[data-session-id="demo-0-1"]').count()) throw new Error('Idle flat task must fold again');
      return;
    }
    if(ui.case !== 'default') {
      await page.locator('[data-project-source] img').first().waitFor();
      await page.locator('[data-project-source] [data-project-monogram]').first().waitFor();
      await ui.capture('project-source-icons');
      return;
    }

    const row=page.locator('[data-project-working-dir="local:/Projects/Cindy"]');
    await row.locator('[aria-expanded]').first().click();
    await ui.capture('collapsed');
    await row.locator('.lucide-folder').waitFor();
    if(await row.locator('img, [data-project-monogram]').count()) throw new Error('Sidebar must keep folder semantics');
    await row.locator('[aria-expanded]').first().click();
    await page.locator('[data-session-id="demo-0-0"]').waitFor();
    await row.locator('.lucide-folder-open').waitFor();
    const folderTitle = await row.getByText('Cindy', { exact: true }).boundingBox();
    const sessionTitle = await row.locator('[data-session-id="demo-0-0"] .sidebar-title-marquee__ellipsis').boundingBox();
    if (!folderTitle || !sessionTitle || Math.abs(folderTitle.x - sessionTitle.x) > 1) {
      throw new Error('Expanding a project must keep compact session titles in the sidebar title column');
    }
    await page.locator('[data-project-working-dir="local:/Projects/工具库"] .lucide-folder').waitFor();
    // The merged menu must retain the quick double-click rename path.
    await row.locator('[data-project-header]').click({button:'right'});
    await page.getByRole('menuitem', {name:await ui.t('projectSettings.title'),exact:true}).waitFor();
    if(await page.getByRole('menuitem', {name:await ui.t('ccAgent.sidebar.sessionMenu.rename'),exact:true}).count()) throw new Error('Project rename is part of settings');
    await ui.capture('project-menu');
    await page.keyboard.press('Escape');
    await row.locator('[data-project-header]').dblclick();
    await row.locator('input').waitFor();
    await ui.capture('double-click-rename');
    await row.locator('input').press('Escape');
    await page.mouse.move(350,410);
  }
};
