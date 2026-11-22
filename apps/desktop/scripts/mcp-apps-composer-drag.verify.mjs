import assert from 'node:assert/strict';

/** Integration: real SDK/iframe issuance and top-level redemption of the actual drag payload. */
export async function verifyComposerDrag(contents, frame, wait) {
  const mime = 'application/x-cindy-composer-attachment-v1';
  await frame.executeJavaScript(`(async () => {
    const {bindComposerAttachmentDrag} = await import('@cindy/ext-apps/composer-attachment');
    const source = document.createElement('div');
    source.id = 'drag-resource';
    source.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:60px;background:white;z-index:1';
    source.textContent = 'fixture.txt';
    document.body.append(source);
    // Observe completion of real AppBridge preparation so the mouse does not race the ticket.
    const request = sdkApp.request.bind(sdkApp);
    sdkApp.request = async (...args) => {
      const result = await request(...args);
      if (args[0].method === 'cindy/composer-attachment/drag-ticket') window.dragPrepared = true;
      return result;
    };
    bindComposerAttachmentDrag(sdkApp, source, { uri: 'library:fixture.txt', name: 'fixture.txt' });
    const early = new DragEvent('dragstart', { cancelable: true, dataTransfer: new DataTransfer() });
    if (source.dispatchEvent(early)) throw new Error('unprepared drag must be cancelled');
    source.addEventListener('dragstart', e => window.sourceDragTrusted = e.isTrusted);
    addEventListener('message', event => {
      if (event.data?.method === 'cindy/composer-attachment/tickets-invalidated') window.resumedDrag = true;
    });
  })()`);
  const points = await contents.executeJavaScript(`(() => {
    const target = document.createElement('div');
    target.style.cssText = 'position:fixed;right:0;bottom:0;width:150px;height:70px;background:white';
    document.body.append(target);
    target.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    target.ondrop = e => {
      e.preventDefault();
      window.dragDropTrusted = e.isTrusted;
      window.dropResult = testHost.invoke({ op: 'redeem-drag', ticket: e.dataTransfer.getData('${mime}') });
    };
    const r = document.querySelector('iframe').getBoundingClientRect();
    return {sx:r.left+24,sy:r.top+24,tx:innerWidth-40,ty:innerHeight-30};
  })()`);
  const cdp = contents.debugger;
  cdp.attach('1.3');
  try {
    await cdp.sendCommand('Input.setInterceptDrags', { enabled: true });
    let intercepted;
    cdp.on('message', (_event, method, params) => {
      if (method === 'Input.dragIntercepted') intercepted = params.data;
    });
    const mouse = (type, x, y, props = {}) => cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...props });
    const { sx, sy, tx, ty } = points;
    await mouse('mouseMoved', sx, sy);
    await wait(() => frame.executeJavaScript('window.dragPrepared === true'));
    await contents.executeJavaScript('testController.suspend().then(() => testController.resume())');
    await wait(() => frame.executeJavaScript('window.resumedDrag === true'));
    await frame.executeJavaScript(`(() => {
      const source = document.getElementById('drag-resource');
      if (source.dispatchEvent(new DragEvent('dragstart', {cancelable:true,dataTransfer:new DataTransfer()})))
        throw new Error('resumed document kept a revoked ticket');
      window.dragPrepared = false;
    })()`);
    await mouse('mousePressed', sx, sy, { button:'left', buttons:1, clickCount:1 });
    await wait(() => frame.executeJavaScript('window.dragPrepared === true'));
    await mouse('mouseMoved', sx+16, sy+2, { button:'left', buttons:1 });
    await mouse('mouseMoved', sx+32, sy+4, { button:'left', buttons:1 });
    await wait(() => !!intercepted);
    assert.equal(await frame.executeJavaScript('window.sourceDragTrusted'), true);
    assert.deepEqual(intercepted.items.map(item => item.mimeType), [mime]);
    for (const type of ['dragEnter','dragOver','drop']) {
      await cdp.sendCommand('Input.dispatchDragEvent', { type, x:tx, y:ty, data:intercepted });
    }
    assert.equal(await contents.executeJavaScript('window.dragDropTrusted'), true);
    await contents.executeJavaScript('window.dropResult');
  } finally {
    cdp.detach();
  }
}
