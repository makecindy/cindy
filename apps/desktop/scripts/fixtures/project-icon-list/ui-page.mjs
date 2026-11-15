import { readFileSync } from 'node:fs';
const avatarData = 'data:image/png;base64,' + readFileSync(new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url)).toString('base64');
export default {
  name:'project-icon-list',entry:'./fixture.tsx',viewport:{width:360,height:420},
  real:'ProjectNode, SessionEntryList, SessionItem and ProjectSettingsDialog',
  notCovered:'Full application shell, persisted project settings and device link transport. Example project names and tasks.',
  stubs:{'src/renderer/contexts/AuthContext':{partial:'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});'}},
  cases:{flat:{data:{avatarData,flat:'list'},about:'Project icons beside source labels on task cards'},compact:{data:{avatarData,flat:'text'},about:'Project icons beside source labels on compact task rows'},default:{data:{avatarData},about:'Sidebar folders preserve expand/collapse semantics regardless of saved project icon'}},
  async ready(page){await page.locator('[data-project-source] img, [data-project-working-dir="local:/Projects/Cindy"] .lucide-folder-open').first().waitFor();},
  async check(page,ui){
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
    await page.locator('[data-project-working-dir="local:/Projects/工具库"] .lucide-folder').waitFor();
    // The merged menu must retain the quick double-click rename path.
    await row.locator('[data-project-header]').click({button:'right'});
    await page.getByRole('menuitem', {name:'项目设置',exact:true}).waitFor();
    if(await page.getByRole('menuitem', {name:'重命名',exact:true}).count()) throw new Error('Project rename is part of settings');
    await ui.capture('project-menu');
    await page.keyboard.press('Escape');
    await row.locator('[data-project-header]').dblclick();
    await row.locator('input').waitFor();
    await ui.capture('double-click-rename');
    await row.locator('input').press('Escape');
    await page.mouse.move(350,410);
  }
};
