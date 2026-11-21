import assert from 'node:assert/strict';

// The bar's affordances are identified by position inside a state, not by their
// translated text: the check has to hold in every locale, so it reads the rendered
// labels out of the DOM and asserts they are translations rather than raw keys.

export default {
  name: 'xcode-build-toolbar',
  entry: './fixture.tsx',
  viewport: { width: 480, height: 320 },
  real: 'XcodeBuildToolbar over prop fixtures for the six discovery and build states',
  notCovered:
    'xcodebuild execution, IPC transport and useXcodeBuild state transitions; covered by main-process and hook unit tests',
  cases: {
    default: { about: 'The six toolbar states stacked in the sidebar rail' },
    narrow: {
      about: 'The bar still fits a 320 px rail without overflowing',
      viewport: { width: 320, height: 320 },
    },
    output: {
      about: 'The expanded run output panel while a Flutter app is running',
      viewport: { width: 480, height: 320 },
    },
  },
  async check(page, ui) {
    if (ui.case === 'output') {
      const panel = page.locator('[data-case="output"] pre');
      await panel.waitFor();
      const text = await panel.innerText();
      assert.ok(text.includes('Compile Swift sources'), 'Run output shows the build log');
      assert.ok(
        (await page.locator('[data-case="output"] button').count()) > 0,
        'The panel keeps its collapse affordance',
      );
      const mono = await panel.evaluate((element) => getComputedStyle(element).fontFamily);
      assert.match(mono, /mono|Menlo|SF Mono/i, 'Build output uses the mono stack');
      await ui.capture('verified');
      return;
    }

    await page.locator('[data-case="ready"]').waitFor();

    const states = await page.evaluate(() => {
      return [...document.querySelectorAll('section[data-case]')].map((section) => ({
        name: section.getAttribute('data-case'),
        target: section.querySelector('button[aria-haspopup]')?.textContent?.trim() ?? null,
        targetDisabled: section.querySelector('button[aria-haspopup]')?.disabled ?? null,
        buttons: [...section.querySelectorAll('button')].map((button) => ({
          label: button.getAttribute('aria-label'),
          disabled: button.disabled,
          pressed: button.getAttribute('aria-pressed'),
        })),
        errorName: section.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null,
        overflow: section.scrollWidth - section.clientWidth,
      }));
    });

    const byName = Object.fromEntries(states.map((state) => [state.name, state]));
    assert.equal(states.length, 6, 'Every toolbar state renders');

    // 1. 没有一条无障碍名是原始翻译键。
    for (const state of states) {
      for (const button of state.buttons) {
        assert.ok(button.label, `${state.name}: every control needs an accessible name`);
        assert.ok(
          !button.label.startsWith('ccAgent.'),
          `${state.name}: ${button.label} is a raw translation key`,
        );
        assert.ok(
          ui.isTranslationKey ? !ui.isTranslationKey(button.label) : true,
          `${state.name}: ${button.label} is a raw translation key`,
        );
      }
      assert.ok(state.target, `${state.name}: the trigger shows a target label`);
    }

    // 2. ready —— 选了 scheme + 模拟器：可编译、不可停止。
    const ready = byName.ready;
    assert.equal(ready.targetDisabled, false, 'Target picker is interactive');
    assert.ok(ready.target.includes('iPhone 17'), 'The trigger names the chosen destination');
    assert.equal(ready.buttons[1].disabled, false, 'Build is available once a target is chosen');
    assert.equal(ready.buttons[2].disabled, true, 'Stop is unavailable before a build starts');

    // 3. loading —— 发现未完成：显示「正在查找」，编译保持禁用。
    assert.equal(byName.loading.targetDisabled, true, 'Target picker waits for discovery');
    assert.equal(byName.loading.buttons[1].disabled, true, 'Build cannot start while discovering');
    assert.notEqual(
      byName.loading.target,
      byName.ready.target,
      'Discovery announces itself instead of showing a stale destination',
    );

    // 4. error —— 失败原因就是无障碍名，不是泛化警告。
    assert.equal(
      byName.error.errorName,
      'xcodebuild is unavailable',
      'A discovery error is announced verbatim',
    );

    // 5. flutter-running —— 已启动的 Flutter 应用给出热重载/热重启 + 输出开关。
    const flutter = byName.flutter;
    assert.equal(flutter.buttons.length, 6, 'Flutter run adds hot reload, hot restart and output');
    assert.equal(flutter.buttons[3].disabled, false, 'Hot reload is usable once launched');
    assert.equal(flutter.buttons[4].disabled, false, 'Hot restart is usable once launched');
    assert.equal(flutter.buttons[5].pressed, 'false', 'Run output starts collapsed');

    // 6. native-running —— 原生产物没有热通道，但 play 变成「重新编译并启动」。
    const native = byName.native;
    assert.equal(native.buttons.length, 4, 'A native run offers no hot actions');
    assert.equal(native.buttons[1].disabled, false, 'A launched native app can be rebuilt');

    // 7. failed —— 结束态由状态图标体现，输出开关仍在。
    assert.equal(byName.failed.buttons.length, 4, 'A finished build keeps the output toggle');

    // 8. 窄栏不溢出。
    for (const state of states) {
      assert.ok(state.overflow <= 1, `${state.name} toolbar overflows by ${state.overflow}px`);
    }


    await ui.capture('verified');
  },
};
