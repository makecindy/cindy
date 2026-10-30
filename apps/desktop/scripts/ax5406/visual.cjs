// Real Electron layout and screenshots; synthetic props, no user profile/backend.
const fs = require('node:fs');
const path = require('node:path');
module.exports = async (win, output) => {
  const steps = [], failures = [];
  const js = code => win.webContents.executeJavaScript(code);
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 450)); };
  // Do not mutate the target while its smooth focus navigation still owns the
  // scroll position. Match the bounded landing check in scroll-tests.cjs.
  const focusMessage = async id => {
    await js(`window.ax5406Visual.focus(${JSON.stringify(id)})`);
    const samples = [];
    let previous, stable = 0;
    const started = Date.now();
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      const state = await js(`(() => {
        const root=document.querySelector('[data-scroll-container]');
        const target=document.querySelector('[data-message-client-id="${id}"]');
        const r=root.getBoundingClientRect(), b=target?.getBoundingClientRect();
        return {top:root.scrollTop, visible:!!b && b.bottom>r.top && b.top<r.bottom};
      })()`);
      samples.push({ms:Date.now()-started,...state});
      stable = state.visible && previous === state.top ? stable + 1 : 0;
      previous = state.top;
      if (stable >= 4 && Date.now()-started >= 1200) break;
    } while (Date.now()-started < 3000);
    if (!samples.at(-1)?.visible || stable < 4) failures.push(`focus ${id}: did not settle within 3s`);
    steps.push({name:'focus-settlement',id,samples});
  };
  const stableAnchor = (name, before, after) => {
    const anchor = before.visible[0];
    const current = after.rows.find(row => row.key === anchor?.key);
    if (!current || Math.abs(current.top - anchor.top) > 2) failures.push(`${name}: reading anchor moved`);
  };
  const snapshot = async name => {
    await settle();
    const state = await js(`(() => {
      const root = document.querySelector('[data-scroll-container]'), bounds = root.getBoundingClientRect();
      const rows = [...document.querySelector('.msg-stream-items').children].map(e => {
        const r = e.getBoundingClientRect(); return { key:e.dataset.renderItemKey, id:e.dataset.messageClientId,
          top:r.top-bounds.top, bottom:r.bottom-bounds.top, height:r.height,
          placeholder:e.hasAttribute('data-message-placeholder'), visibility:getComputedStyle(e).contentVisibility };
      });
      const visible = rows.filter(e => e.bottom > 1 && e.top < root.clientHeight-1 && e.height > 0);
      return { rows, visible, scrollTop:root.scrollTop, distance:root.scrollHeight-root.scrollTop-root.clientHeight,
        mounted:rows.filter(e=>!e.placeholder).length, errors:window.ax5406Stats.errors,
        overlaps:rows.slice(1).filter((e,i)=>e.top < rows[i].bottom-1).length };
    })()`);
    if (state.visible.some(e => e.placeholder)) failures.push(`${name}: visible placeholder`);
    if (state.overlaps) failures.push(`${name}: overlapping rows`);
    if (state.errors.length) failures.push(`${name}: renderer errors`);
    if (!state.visible.length) failures.push(`${name}: empty viewport`);
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    steps.push({ name, ...state });
    fs.writeFileSync(path.join(output, 'visual-steps.json'), JSON.stringify({ steps, failures }, null, 2));
    return state;
  };
  await settle();
  const first = await snapshot('01-light-bottom');
  if (first.mounted >= 40) failures.push('initial: too many mounted bodies');
  if (first.distance > 2) failures.push('initial: not pinned to bottom');
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: 400, y: 300, deltaY: 600, deltaX: 0 });
  await settle();
  await js(`(() => {const r=document.querySelector('[data-scroll-container]');r.scrollTop=r.scrollHeight*.45;})()`);
  const middle = await snapshot('02-light-middle');
  if (middle.distance < 1000) failures.push('middle: unexpectedly returned to bottom');
  const sweep = await js(`(async () => {
    const root=document.querySelector('[data-scroll-container]'); const results=[];
    for(const fraction of [.2,.8,.35,.7,.4]) {
      root.scrollTop=(root.scrollHeight-root.clientHeight)*fraction;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const bounds=root.getBoundingClientRect();
      const placeholders=[...document.querySelectorAll('[data-message-placeholder]')].filter(e=>{
        const r=e.getBoundingClientRect();return r.bottom>bounds.top+1&&r.top<bounds.bottom-1;
      });results.push({fraction,blankRows:placeholders.length});
    } return results;
  })()`);
  if(sweep.some(step=>step.blankRows)) failures.push('rapid-scroll: placeholders still visible after two frames');
  steps.push({name:'rapid-scroll',sweep});
  await js(`(() => {const r=document.querySelector('[data-scroll-container]');r.scrollTop=${middle.scrollTop};})()`);
  const beforeGrowth = await snapshot('03a-before-growth');
  await js(`window.ax5406Visual.grow(${JSON.stringify(beforeGrowth.visible[0]?.id)})`);
  const growth = await snapshot('03b-async-growth');
  stableAnchor('async-growth', beforeGrowth, growth);
  const user = beforeGrowth.visible.find(e => Number(e.id?.split('-').at(-1)) % 2 === 0);
  if (user) {
    await focusMessage(user.id);
    const beforeImage = await snapshot('04a-before-image');
    await js(`window.ax5406Visual.image(${JSON.stringify(user.id)})`);
    const image = await snapshot('04-async-image');
    stableAnchor('async-image', beforeImage, image);
    if (!await js(`!!document.querySelector('[data-message-client-id="${user.id}"] img')?.naturalWidth`)) failures.push('image: not decoded');
  } else failures.push('image: no visible user row');
  await js(`(() => {const r=document.querySelector('[data-scroll-container]');r.scrollTop=0;})()`);
  await snapshot('05-top');
  await focusMessage('synthetic-155');
  const focus = await snapshot('06-search-jump');
  if (!focus.visible.some(row => row.id === 'synthetic-155')) failures.push('focus: target not visible');
  win.setSize(620, 760); await snapshot('07-narrow');
  await js('window.ax5406Visual.theme(true)'); await snapshot('08-dark-narrow');
  win.setSize(1000, 760); await snapshot('09-dark-wide');
  await js('window.ax5406Visual.remount()'); const remount = await snapshot('10-remount');
  await js('window.ax5406Visual.append()'); const appended = await snapshot('11-new-message-reading');
  stableAnchor('append-while-reading', remount, appended);
  await focusMessage('synthetic-198');
  await settle();
  await js(`window.ax5406Visual.grow('synthetic-198')`);
  await settle();
  const expanded = await js(`(() => {
    const button=document.querySelector('[data-message-client-id="synthetic-198"] button[aria-expanded="false"]');
    if(!button)return false;
    button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));button.click();return true;
  })()`);
  if (!expanded) failures.push('expand: missing collapsed message control');
  await snapshot('12-expanded-message');
  await js(`(() => {const r=document.querySelector('[data-scroll-container]');r.scrollTop=0;})()`);
  await settle();
  if (!await js(`!!document.querySelector('[data-message-client-id="synthetic-198"] button[aria-expanded="true"]')`)) failures.push('expand: state lost offscreen');
  await focusMessage('synthetic-199');
  await settle();
  await focusMessage('synthetic-198');
  await snapshot('13-expanded-return');
  await js(`window.ax5406Visual.focus(undefined)`);
  const jumped = await js(`(() => {
    const button=[...document.querySelectorAll('button')].find(e=>/new messages|Jump to bottom/.test(e.textContent));
    if(!button)return false;button.click();return true;
  })()`);
  if(!jumped) failures.push('follow: missing jump-to-bottom control');
  await new Promise(resolve => setTimeout(resolve, 3000));
  const bottom = await snapshot('14-dark-bottom');
  if(bottom.distance>2) failures.push('follow: did not reach bottom');
  await js('window.ax5406Visual.append()');
  const followed = await snapshot('15-follow-new-message');
  if(followed.distance>2) failures.push('follow: new message not followed');
  // Native selection must see all logically loaded bodies, even offscreen.
  await js(`document.querySelector('[data-scroll-container]').dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}))`);
  const selected = await snapshot('16-keyboard-selection');
  if (selected.rows.some(row => row.placeholder)) failures.push('selection: missing loaded bodies');
  if(selected.distance>2) failures.push('selection: bottom anchor lost');
  fs.writeFileSync(path.join(output, 'visual-steps.json'), JSON.stringify({ steps, failures }, null, 2));
  return { steps, failures };
};
