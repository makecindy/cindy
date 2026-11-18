import { readFileSync } from 'node:fs';
const avatarData = 'data:image/png;base64,' + readFileSync(new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url)).toString('base64');
export default {
  name:'project-icon-list',entry:'./fixture.tsx',viewport:{width:360,height:420},
  real:'ProjectNode, SessionEntryList, SessionItem and ProjectSettingsDialog',
  notCovered:'Full application shell, persisted project settings and device link transport. Example project names and tasks.',
  stubs:{'src/renderer/contexts/AuthContext':{partial:'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});'}},
  cases:{
    flat:{data:{avatarData,flat:'list'},about:'Project icons beside source labels on task cards'},
    compact:{data:{avatarData,flat:'text'},about:'Project icons beside source labels on compact task rows'},
    default:{data:{avatarData},about:'Sidebar folders preserve expand/collapse semantics regardless of saved project icon'},
    'idle-projects':{data:{avatarData,inactive:true},about:'Idle tasks fold independently under each project header (#11233)'},
    'idle-flat':{data:{avatarData,inactive:true,flat:'text'},about:'Idle tasks fold in a flat sidebar and can be shown again (#11233)'},
    'filtered-projects':{data:{avatarData,inactive:true,filtered:true},about:'Filtered project results show all matches and omit the inactivity toggle (#11233)'},
  },
  async ready(page){await page.locator('[data-project-source] img, [data-project-working-dir="local:/Projects/Cindy"] .lucide-folder-open').first().waitFor();},
  async check(page,ui){
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
      const showOne=await ui.t('ccAgent.sidebar.showAllSessions',{count:1});
      if(await other.getByRole('button',{name:showOne,exact:true}).count()) throw new Error('An all-idle project must not show a list footer');
      await project.getByRole('button',{name:await ui.t('ccAgent.sidebar.showAllSessions',{count:2}),exact:true}).waitFor();
      await ui.capture('inactive-folded');
      await project.getByRole('button',{name:await ui.t('ccAgent.sidebar.expandAllSessions'),exact:true}).click();
      await hidden.waitFor();
      if(await other.locator('[data-session-id="demo-1-0"]').count()) throw new Error('Project controls must stay independent');
      await ui.capture('project-expanded');
      await project.getByRole('button',{name:await ui.t('ccAgent.sidebar.collapseInactiveSessions'),exact:true}).first().click();
      if(await hidden.count()) throw new Error('Idle task must fold again');
      return;
    }
    if(ui.case === 'idle-flat') {
      if(await page.locator('[data-session-id="demo-0-1"]').count()) throw new Error('Idle flat task must start folded');
      await ui.capture('inactive-folded');
      await page.getByRole('button',{name:await ui.t('ccAgent.sidebar.showAllSessions',{count:6}),exact:true}).click();
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
