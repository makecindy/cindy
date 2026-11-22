import assert from 'node:assert/strict';

/** Integration: repeated trusted cross-frame drags through real SDK issuance and Main redemption. */
export async function verifyComposerDrag(contents, frame, wait, imageUri, removeFromTray) {
  const mime = 'application/x-cindy-composer-attachment-v1';
  const resources = [{ uri: imageUri, name: 'fixture.png' }, { uri: 'library:fixture.txt', name: 'fixture.txt' }];
  await frame.executeJavaScript(`(async () => {
    const {bindComposerAttachmentDrag} = await import('@cindy/ext-apps/composer-attachment');
    const resources = ${JSON.stringify(resources)};
    window.dragTrace = { ready: new Set(), starts: 0, ends: 0, renders: 0 };
    const request = sdkApp.request.bind(sdkApp);
    sdkApp.request = async (...args) => {
      const result = await request(...args);
      if (args[0].method === 'cindy/composer-attachment/drag-ticket') dragTrace.ready.add(args[0].params.name);
      return result;
    };
    const handles = document.createElement('div');
    handles.style.cssText = 'position:fixed;left:0;top:0;display:flex;z-index:1';
    document.body.append(handles);
    let cleanup = [];
    const render = () => {
      cleanup.forEach(unbind => unbind());
      dragTrace.ready.clear();
      handles.replaceChildren();
      cleanup = resources.map(resource => {
        const button = document.createElement('button');
        button.style.cssText = 'width:90px;height:55px';
        button.textContent = resource.name;
        handles.append(button);
        return bindComposerAttachmentDrag(sdkApp, button, resource);
      });
      dragTrace.renders++;
    };
    render();
    sdkApp.onhostcontextchanged = () => { if (sdkApp.getHostContext().theme === 'dark') render(); };
    window.unpreparedDragCancelled = () => !handles.firstChild.dispatchEvent(
      new DragEvent('dragstart', {cancelable:true,dataTransfer:new DataTransfer()}));
    if (!unpreparedDragCancelled()) throw new Error('unprepared drag must be cancelled');
    handles.addEventListener('dragstart', e => {
      if (e.isTrusted) { dragTrace.starts++; dragTrace.ready.delete(e.target.textContent); }
    }, true);
    handles.addEventListener('dragend', e => { if (e.isTrusted) dragTrace.ends++; }, true);
    addEventListener('message', e => {
      if (e.data?.method === 'cindy/composer-attachment/tickets-invalidated') window.resumedDrag = true;
    });
  })()`);
  const { left, top, tx, ty } = await contents.executeJavaScript(`(() => {
    const target = document.createElement('div');
    target.style.cssText = 'position:fixed;right:0;bottom:0;width:150px;height:70px;background:white';
    document.body.append(target);
    window.drops = [];
    target.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    target.ondrop = e => {
      e.preventDefault();
      drops.push({trusted:e.isTrusted, types:[...e.dataTransfer.types]});
      window.dropResult = testHost.invoke({ op:'redeem-drag', ticket:e.dataTransfer.getData('${mime}') });
    };
    const {left, top} = document.querySelector('iframe').getBoundingClientRect();
    return {left, top, tx:innerWidth-40, ty:innerHeight-30};
  })()`);
  const cdp = contents.debugger;
  cdp.attach('1.3');
  try {
    const targets = await cdp.sendCommand('Target.getTargets');
    const source = targets.targetInfos.find(target => target.type === 'iframe' && target.url === frame.url);
    assert.ok(source, 'the source document must be a separate iframe target');
    const { sessionId } = await cdp.sendCommand('Target.attachToTarget', { targetId: source.targetId, flatten: true });
    const mouse = (type, x, y, props = {}) => cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...props });
    const ready = index => frame.executeJavaScript(`dragTrace.ready.has(${JSON.stringify(resources[index].name)})`);
    let count = 0;
    const drag = async index => {
      const x = 24 + index * 90;
      const y = 24;
      const sx = left + x;
      const sy = top + y;
      await mouse('mouseMoved', tx, ty);
      await mouse('mouseMoved', sx, sy);
      await mouse('mousePressed', sx, sy, { button: 'left', buttons: 1, clickCount: 1 });
      await wait(() => ready(index));
      for (let step = 1; step <= 16; step++) {
        const progress = step / 16;
        await mouse('mouseMoved', sx + (tx - sx) * progress, sy + (ty - sy) * progress, { button: 'left', buttons: 1 });
      }
      await mouse('mouseReleased', tx, ty, { button: 'left', buttons: 0 });
      count++;
      await wait(() => contents.executeJavaScript(`drops.length === ${count}`));
      assert.deepEqual(await contents.executeJavaScript('drops.at(-1)'), { trusted: true, types: [mime] });
      await contents.executeJavaScript('window.dropResult');
      assert.equal(await frame.executeJavaScript('dragTrace.starts'), count);
      // Electron 42/macOS dispatches the CDP drop to the top-level target but can
      // leave the source renderer in its drag session. Complete it in that iframe.
      if (await frame.executeJavaScript('dragTrace.ends') < count) {
        await cdp.sendCommand('Input.dispatchDragEvent', {
          type: 'dragCancel', x, y, data: { items: [], dragOperationsMask: 1 },
        }, sessionId);
      }
      await wait(() => frame.executeJavaScript(`dragTrace.ends === ${count}`));
      console.log('Trusted dragstart/drop/dragend', count, resources[index].name);
    };
    await mouse('mouseMoved', left + 24, top + 24);
    await wait(() => ready(0));
    await contents.executeJavaScript('testController.suspend().then(() => testController.resume())');
    await wait(() => frame.executeJavaScript('window.resumedDrag === true'));
    assert.equal(await frame.executeJavaScript('dragTrace.ready.clear(); unpreparedDragCancelled()'), true);
    await drag(0);
    await drag(1);
    removeFromTray(resources[0].name);
    await drag(0);
    removeFromTray(resources[1].name);
    const renders = await frame.executeJavaScript('dragTrace.renders');
    await contents.executeJavaScript("testController.context({theme:'dark'})");
    await wait(() => frame.executeJavaScript(`dragTrace.renders > ${renders}`));
    await drag(1);
  } finally {
    cdp.detach();
  }
}
