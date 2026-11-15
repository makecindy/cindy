const face = (el) => getComputedStyle(el, '::before').backgroundColor;
const faceOf = (page, sel) => page.locator(sel).evaluate(face);
const bgOf = (page, sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
const settle = (page) => page.waitForTimeout(260);

export default {
  name: 'button-states',
  entry: './button-states-fixture.tsx',
  viewport: { width: 760, height: 720 },
  real: 'Button, SendButton, PermissionPrompt, update button treatment, Cindy theme tokens',
  notCovered: 'Non-Cindy themes; business actions',
  cases: { default: { about: 'Real pointer hover and press match the state tokens', data: {} } },
  async check(page, ui) {
    const out = [];
    for (const id of ['cta', 'danger', 'permission', 'confirmation', 'update', 'secondary', 'primary']) {
      const btn = page.locator(`button[data-pointer="${id}"]`);
      await btn.hover(); await settle(page);
      const hover = await faceOf(page, `button[data-pointer="${id}"]`);
      const wantHover = await faceOf(page, `button[data-state-sample="${id}-hover"]`);
      await page.mouse.down(); await settle(page);
      const pressed = await faceOf(page, `button[data-pointer="${id}"]`);
      const wantPressed = await faceOf(page, `button[data-state-sample="${id}-pressed"]`);
      await page.mouse.up(); await page.mouse.move(2, 2); await settle(page);
      out.push({ id, hover, wantHover, pressed, wantPressed });
      if (hover !== wantHover || pressed !== wantPressed) throw new Error(`${id}: pointer differs ${JSON.stringify(out.at(-1))}`);
    }
    const send = page.locator('[data-pointer="send"] button');
    await send.hover(); await settle(page);
    const sh = await bgOf(page, '[data-pointer="send"] button'), wsh = await bgOf(page, '[data-send-sample="hover"] button');
    await page.mouse.down(); await settle(page);
    const sp = await bgOf(page, '[data-pointer="send"] button'), wsp = await bgOf(page, '[data-send-sample="pressed"] button');
    await page.mouse.up(); await page.mouse.move(2, 2);
    out.push({ id: 'send', hover: sh, wantHover: wsh, pressed: sp, wantPressed: wsp });
    if (sh !== wsh || sp !== wsp) throw new Error(`send: pointer differs ${JSON.stringify(out.at(-1))}`);

    // 真实授权入口的「允许一次」是最后一个按钮，状态色要和 permission 色值一致。
    const allow = page.locator('[data-permission-prompt] button').last();
    await allow.hover(); await settle(page);
    const ah = await allow.evaluate(face), wah = await faceOf(page, 'button[data-state-sample="permission-hover"]');
    await page.mouse.down(); await settle(page);
    const ap = await allow.evaluate(face), wap = await faceOf(page, 'button[data-state-sample="permission-pressed"]');
    await page.mouse.up(); await page.mouse.move(2, 2);
    out.push({ id: 'permission-prompt', hover: ah, wantHover: wah, pressed: ap, wantPressed: wap });
    if (ah !== wah || ap !== wap) throw new Error(`permission-prompt: pointer differs ${JSON.stringify(out.at(-1))}`);

    // 阈值附近：表达式在 Chromium 里算出的亮度必须和底色同向，不能混合出中间值。
    const threshold = await page.locator('[data-threshold]').evaluateAll((nodes) => nodes.map((node) => {
      const computed = (color) => {
        const probe = document.createElement('i');
        probe.style.color = color;
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      return { base: Number(node.dataset.threshold), hover: computed(node.dataset.hover), pressed: computed(node.dataset.pressed) };
    }));
    const lightness = (color) => {
      const match = /^oklch\(([\d.]+)/.exec(color);
      if (!match) throw new Error(`threshold: unexpected computed color ${color}`);
      return Number(match[1]);
    };
    for (const row of threshold) {
      const hover = lightness(row.hover), pressed = lightness(row.pressed);
      if (Math.sign(pressed - hover) !== Math.sign(hover - row.base)) throw new Error(`threshold: reversed ${JSON.stringify(row)}`);
    }
    out.push({ id: 'threshold', rows: threshold });
    console.log('[button-states]', ui.theme, JSON.stringify(out));
  },
};
