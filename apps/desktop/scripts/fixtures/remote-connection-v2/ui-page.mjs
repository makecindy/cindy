import assert from 'node:assert/strict';
const V2_ON = { 'remoteConnection.v2': 'on' };

export default {
  name: 'remote-connection-v2',
  entry: './fixture.tsx',
  viewport: { width: 1180, height: 1100 },
  real: 'RemoteControlSection with the Agent-Net (Beta) switch on: RemoteConnectionV2Section, RemoteConnectionTopology, TopologyFlow, PlatformGlyph, DeviceNodePopover, below My devices (MyDevicesPanel: this computer pinned, the other devices in the collapsible list, the 云主机 row for an organization member with the entry), then RelayServicePanel',
  notCovered:
    'Live device-link IPC, real RTT and traffic sampling (send/receive times are fixture values), relay switching, SSH hosts, remote desktop launch; the legacy list page is covered by remoteControlDevicesDeepLink.test.tsx',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      // The 云主机 row reads the signed-in member; only the cloud-computer case sets one.
      partial: 'export function useAuth() { return { deviceId: "self", user: null, mode: "cloud" }; } export function useOptionalAuthUser() { return globalThis.__uiPageAuthUser ?? null; } export function useOptionalDataOwnerGeneration() { return 0; }',
    },
  },
  cases: {
    'rename-self': { about: 'Renaming this computer updates its topology label and openable card, while its reported hostname stays the same', storage: V2_ON },
    traffic: { about: 'Compare the two local transports over five minutes, one hour and one rolling day', storage: V2_ON },
    'app-nodes': { about: 'Friend, unknown App and offline Friend keep their App label and platform icon; no Cindy remote actions or control-off warning', storage: V2_ON },
    'app-nodes-list': { about: 'My devices labels other Apps without outbound computer actions; legacy Cindy stays unchanged' },
    default: {
      about: 'Eight other devices: direct (one exchanging messages), relay (receiving), not linked, needs attention and two folded offline',
      storage: V2_ON,
    },
    fleet: { about: 'Same shape as a real account: 3 direct, 7 via relay, 15 folded offline; two links carrying messages; the relay\'s UDP is blocked, so it reads Agent-Net · WS', storage: V2_ON },
    many: { about: 'Twenty other devices: dense rows, split direct group, folded offline', storage: V2_ON },
    'split-direct': {
      about: 'Nine direct devices split in two; the relay group sits below the second direct group, so its label goes under the relay point, clear of this computer’s name',
      storage: V2_ON,
    },
    'relay-below': {
      about: 'Seven direct devices split in two and two relayed under the left direct group, so the relay point sits well below this computer and the line to it is steep; this computer\'s leg (UDP · 9 ms) stays whole on that line',
      storage: V2_ON,
      viewport: { width: 1400, height: 1000 },
    },
    'relay-below-long-name': {
      about: 'A long computer name beside the steep relay line leaves the transport label by the relay point, away from the name',
      storage: V2_ON,
      viewport: { width: 1400, height: 1000 },
    },
    'self-device-link': {
      about: 'Agent-Net switch on, but this computer runs on Device Link this time: Device Link under its name, in its card and on every peer',
      storage: V2_ON,
    },
    'narrow-relay': {
      about: 'One relay peer at the topology width of a minimum-width Settings window; its protocol and RTT clear the relay point',
      storage: V2_ON,
      viewport: { width: 520, height: 900 },
    },
    'narrow-fleet': {
      about: 'Seven relay peers at the minimum Settings content width; their transport and RTT stay clear of the relay caption',
      storage: V2_ON,
      viewport: { width: 520, height: 900 },
    },
    empty: { about: 'Only this computer, master switch off', storage: V2_ON },
    'legacy-off': { about: 'Agent-Net off: no topology; 我的设备 and the relay route are unchanged' },
    'cloud-computer': {
      about: 'Organization member with a running cloud computer and room for another: the 云主机 row under this computer, with 管理云主机 and 添加云主机; My devices expanded above the topology',
      storage: V2_ON,
    },
    'remote-switch': {
      about: 'Prototype: switch another computer between Device Link and Agent-Net from its topology card (switching, reverted, outdated, phone, control off, already Agent-Net)',
      storage: V2_ON,
    },
    'remote-switch-batch': {
      about: 'Prototype: batch switch to Agent-Net (first computer first, then the rest; one goes back) and the switch-back list',
      storage: V2_ON,
    },
    'switched-here': {
      about: 'Prototype: this computer was switched to Agent-Net remotely; the switch hint says by whom and when',
      storage: V2_ON,
    },
    'remote-switch-controller-strict': {
      about: 'Controller requires Agent-Net: card and batch explain why it cannot switch a peer to Device Link',
      storage: V2_ON,
    },
    'removed-rejoin': {
      about: 'This computer was removed from the account on the official network: its card explains it and offers Rejoin, which runs once',
      storage: V2_ON,
    },
  },
  async check(page, ui) {
    await page.getByRole('switch', { name: await ui.t('settings.remoteControl.v2.switch.title') }).waitFor();
    if (ui.case === 'removed-rejoin') {
      // Removed from the account, this computer is off the device list; its own card still shows the removal.
      await page.getByText(await ui.t('settings.devices.rejoin.hint'), { exact: true }).waitFor({ timeout: 3000 });
      await ui.capture('removed');
      await page.getByRole('button', { name: await ui.t('settings.devices.rejoin.action'), exact: true }).click();
      await page.waitForFunction(() => window.__rejoinCalls === 1);
      return;
    }
    if (ui.case === 'rename-self') {
      const self = page.locator('[data-device-id="self"]');
      await self.getByText('Office desktop', { exact: true }).waitFor({ timeout: 3000 });
      await self.getByRole('button', { name: await ui.t('settings.devices.rename') }).click();
      await self.getByRole('textbox').fill('XD-PC');
      await self.getByRole('textbox').press('Enter');
      await self.getByText('XD-PC', { exact: true }).waitFor();
      const protocol = await ui.t('settings.remoteControl.v2.protocol.agentNet');
      const hub = page.getByRole('button', { name: `XD-PC · ${protocol}`, exact: true });
      await hub.waitFor({ timeout: 3000 });
      assert.equal(await page.getByText('XD-PC', { exact: true }).count(), 2);
      await ui.capture('renamed');
      await hub.click();
      await page.getByRole('dialog').getByText('XD-PC', { exact: true }).waitFor();
      return;
    }
    const traffic = page.getByRole('region', { name: await ui.t('settings.remoteControl.v2.traffic.title') });
    if (ui.case === 'traffic') {
      const row = traffic.getByRole('row', { name: /Agent-Net/ });
      await row.getByRole('cell', { name: '640.0 KB', exact: true }).waitFor();
      for (const [range, total] of [['lastHour', '10.0 MB'], ['lastDay', '128.0 MB']]) {
        await traffic.getByRole('radio', { name: await ui.t(`settings.remoteControl.v2.traffic.${range}`) }).click();
        await row.getByRole('cell', { name: total, exact: true }).waitFor();
      }
      await ui.capture('day');
      return;
    }
    if (ui.case === 'app-nodes' || ui.case === 'app-nodes-list') {
      const friend = `${await ui.t('settings.devices.apps.cindyFriend')} · Friend Mac`;
      if (ui.case === 'app-nodes-list') {
        await page.getByRole('button', { name: new RegExp(`^${await ui.t('settings.remoteControl.sections.myDevices')}`) }).click();
        const row = page.locator('[data-device-id="friend"]');
        await row.getByText(friend, { exact: true }).waitFor();
        await row.getByText(`${await ui.t('settings.devices.apps.cindyFriend')} 1.4.0`, { exact: false }).waitFor();
        assert.equal(await row.getByText(await ui.t('settings.remoteControl.myDevices.peerControlOff'), { exact: true }).count(), 0);
        assert.equal(await row.getByText(await ui.t('settings.remoteControl.myDevices.controlIt'), { exact: true }).count(), 0);
        await page.getByText('future-app · Lab Mac', { exact: true }).waitFor();
        await page.getByText('Legacy Cindy', { exact: true }).waitFor();
      } else {
        await page.getByRole('button', { name: new RegExp(`^${friend}`) }).click();
        const card = page.getByRole('dialog');
        await card.getByText(friend, { exact: true }).waitFor();
        await card.getByText(`${await ui.t('settings.devices.apps.cindyFriend')} 1.4.0`, { exact: false }).waitFor();
        assert.equal(await card.getByRole('button').count(), 0);
        await ui.capture('friend-card');
        await page.keyboard.press('Escape');
        await page.getByText('future-app · Lab Mac', { exact: true }).filter({ visible: true }).waitFor();
        await page.getByRole('button', { name: /^future-app · Lab Mac/ }).click();
        const unknownCard = page.getByRole('dialog');
        await unknownCard.getByText('future-app 1.4.0', { exact: false }).waitFor();
        assert.equal(await unknownCard.getByRole('button').count(), 0);
        await ui.capture('unknown-app-card');
        await page.keyboard.press('Escape');
        await page.getByText(`${await ui.t('settings.devices.apps.cindyFriend')} · Travel Mac`, { exact: true }).filter({ visible: true }).waitFor();
      }
      return;
    }
    if (ui.case === 'cloud-computer') {
      for (const action of ['manageCloud', 'addCloud']) {
        await page.getByRole('button', { name: await ui.t(`settings.remoteControl.cloudComputer.actions.${action}`) }).waitFor();
      }
      await page.getByRole('button', { name: new RegExp(`^${await ui.t('settings.remoteControl.sections.myDevices')}`) }).click();
      await page.locator('[data-device-id]').filter({ visible: true }).first().waitFor();
      return;
    }
    if (ui.case === 'switched-here') {
      await page.getByText('MacBook Pro', { exact: false }).first().waitFor();
      return;
    }
    if (ui.case.startsWith('remote-switch')) {
      const t = (key) => ui.t(`settings.remoteControl.v2.peerSwitch.${key}`);
      await page.getByRole('button', { name: /^Work PC/ }).waitFor();
      if (ui.case === 'remote-switch-controller-strict') {
        await page.getByRole('button', { name: /^Build Server/ }).click();
        await page.getByText(await t('disableBlocked.controller-encryption-required'), { exact: true }).waitFor();
        if (await page.getByRole('button', { name: await t('toDeviceLink'), exact: true }).count()) throw new Error('strict controller offers an unreachable switch-back');
        await ui.capture('card-controller-encryption-required');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: await t('batch.toDeviceLink'), exact: true }).click();
        await page.getByText(await t('batch.skipReason.controller-encryption-required'), { exact: true }).waitFor();
        if (!(await page.getByRole('dialog').getByRole('button').last().isDisabled())) throw new Error('strict controller can start a switch-back batch');
        await ui.capture('batch-controller-encryption-required');
        await page.keyboard.press('Escape');
        return;
      }
      if (ui.case === 'remote-switch') {
        const open = async (name, shot, { wait = 1000 } = {}) => {
          await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
          await page.getByRole('dialog').waitFor();
          if (wait) await page.waitForTimeout(wait);
          await ui.capture(shot);
          await page.keyboard.press('Escape');
        };
        // 打开卡片先问对方：问的时候写「正在确认」，问完才给按钮或原因。
        await open('Work PC', 'card-checking', { wait: 0 });
        await open('Work PC', 'card-switchable');
        await open('MacBook Air', 'card-outdated');
        await open('Spare PC', 'card-not-ready');
        await page.getByRole('button', { name: /^Build Server/ }).click();
        await page.getByText(await t('encryptionRequired'), { exact: true }).waitFor();
        if (await page.getByRole('button', { name: await t('toDeviceLink'), exact: true }).count()) throw new Error('encrypted-only target offers a remote downgrade');
        await ui.capture('card-encryption-required');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /^Archive Server/ }).click();
        await page.getByText(await t('disableBlocked.agent-net-only-relay'), { exact: true }).waitFor();
        if (await page.getByRole('button', { name: await t('toDeviceLink'), exact: true }).count()) throw new Error('V2-only relay offers a Device Link switch-back');
        await ui.capture('card-agent-net-only-relay');
        await page.keyboard.press('Escape');
        // 单台切换：点了先列三步；Home PC 的 Agent-Net 不通，期限过后显示已退回。
        await page.getByRole('button', { name: /^Home PC/ }).click();
        await page.getByRole('dialog').waitFor();
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: await t('toAgentNet'), exact: true }).click();
        await page.waitForTimeout(1200);
        await ui.capture('card-switching');
        await page.getByText(await t('reverted'), { exact: true }).waitFor();
        await ui.capture('card-reverted');
        await page.keyboard.press('Escape');
        return;
      }
      // 批量：先逐台确认，再先切一台、其余随后；之后可以全部切回。
      await page.getByRole('button', { name: await t('batch.toAgentNet'), exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('batch-checking');
      await page.waitForTimeout(1000);
      await ui.capture('batch-confirm');
      // 面板里最后一个按钮就是「切换 N 台」。
      await page.getByRole('dialog').getByRole('button').last().click();
      await page.waitForTimeout(1200);
      await ui.capture('batch-canary');
      await page.getByRole('dialog').locator('button:enabled').waitFor();
      await ui.capture('batch-done');
      await page.getByRole('button', { name: await t('batch.close'), exact: true }).click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: await t('batch.toDeviceLink'), exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.getByText(await t('batch.skipReason.encryption-required'), { exact: true }).waitFor();
      await page.getByText(await t('batch.skipReason.agent-net-only-relay'), { exact: true }).waitFor();
      await page.getByRole('dialog').locator('button:enabled').nth(1).waitFor();
      await ui.capture('rollback-confirm');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case === 'legacy-off') {
      await page.getByRole('button', { name: new RegExp(`^${await ui.t('settings.remoteControl.sections.myDevices')}`) }).waitFor();
      assert.equal(await traffic.count(), 0);
      return;
    }
    // 这台电脑名字下面写它实际用的连接方式;读屏名字同样带上(用户要求 2026-11-18)。
    const agentNet = await ui.t('settings.remoteControl.v2.protocol.agentNet');
    const deviceLink = await ui.t('settings.remoteControl.v2.protocol.deviceLink');
    const selfProtocol = ui.case === 'self-device-link' ? deviceLink : agentNet;
    const hasLongName = ui.case === 'relay-below-long-name';
    const selfName = hasLongName ? 'Conference Room Editing Workstation' : 'Studio Mac';
    const hub = page.getByRole('button', { name: `${selfName} · ${selfProtocol}`, exact: true });
    await hub.waitFor();
    const topology = page.locator('div.select-none').filter({ has: hub });
    // 2026-11-18 用户反馈:中转站的字写在圆点下面、朝中间排开,和这台电脑的名字、连接方式挤成一团。
    // 中转站的字要整个落在这台电脑的字与细环之外。
    // 同日用户要求：中转站写出协议，以及经中转的数据走 UDP 还是 WS(Agent-Net 两种都可能,Device Link 只有 WS),
    // 往返是那条路的。三行：名字 / 协议 /「UDP · 25 ms」;读屏名字是「名字 · 协议 · 走法 · 往返」。
    const relayName = await ui.t('settings.remoteControl.v2.relay.official');
    const relayBelow = ui.case === 'relay-below' || hasLongName;
    const relayRttValue = ui.case === 'many' ? 22 : relayBelow ? 9 : 25;
    const relayRtt = await ui.t('settings.remoteControl.v2.ms', { value: relayRttValue });
    const relayTransport = await ui.t(ui.case === 'self-device-link' || ui.case === 'fleet' || ui.case === 'narrow-fleet'
      ? 'settings.remoteControl.v2.relayTransport.websocket' : 'settings.remoteControl.v2.relayTransport.udp');
    const relayRoute = `${selfProtocol} · ${relayTransport}`;
    if (ui.case !== 'empty') {
      const relayDot = page.getByRole('img', { name: `${relayName} · ${relayRoute} · ${relayRtt}`, exact: true });
      await relayDot.waitFor();
      const hubBox = await hub.boundingBox();
      const hubX = hubBox.x + hubBox.width / 2;
      const below = async (text) => {
        for (const el of await page.getByText(text, { exact: true }).all()) {
          const box = await el.boundingBox();
          // 连接方式那行的文字前面有 12px 图标,文字本身比圆盘中心偏右几像素。
          if (box && box.y >= hubBox.y + hubBox.height && Math.abs(box.x + box.width / 2 - hubX) < 12) return box;
        }
        throw new Error(`no "${text}" under this computer in the topology`);
      };
      const dotBox = await relayDot.boundingBox();
      const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      const dotX = dotBox.x + dotBox.width / 2;
      // 2026-11-27 用户要求：这台电脑到中转那一段的走法写在这台电脑到中转站的线上，中转点上方只剩名字和协议;
      // 最窄的设置页那段线放不下，仍是中转点上方第三行。
      const relayPath = `${relayTransport} · ${relayRtt}`;
      const pathOnTrunk = ui.case !== 'narrow-relay' && ui.case !== 'narrow-fleet' && !hasLongName;
      const labels = [];
      for (const el of await page.getByText(relayName, { exact: true }).all()) {
        const label = el.locator('..');
        const box = await label.boundingBox();
        if (box && Math.abs(box.x + box.width / 2 - dotX) < 80 && Math.abs(box.y + box.height / 2 - dotBox.y) < 80) {
          if (hasLongName) assert.equal(await label.getByText(relayPath, { exact: true }).count(), 1, 'the trunk label must clear the long computer name');
          labels.push({ box, label, lines: [
            await el.boundingBox(),
            await label.getByText(selfProtocol, { exact: true }).boundingBox(),
            ...(pathOnTrunk ? [] : [await label.getByText(relayPath, { exact: true }).boundingBox()]),
          ] });
        }
      }
      assert.equal(labels.length, 1, 'relay station label');
      const [{ box: relayLabel, label: relayLabelEl, lines }] = labels;
      if (pathOnTrunk) assert.equal(await relayLabelEl.getByText(relayPath, { exact: true }).count(), 0, 'relay path still above the relay point');
      // 上下两行的标签是又窄又高的一块，胶囊的大圆角会把四角的字切掉(2026-11-27 真机截图:「9 ms」的 s 被切);
      // 字本身没溢出，scrollWidth 看不出来，只能看圆角。
      const roundClipped = await topology.locator('span.grid').evaluateAll((els) =>
        els.filter((el) => el.children.length > 1 && parseFloat(getComputedStyle(el).borderTopRightRadius) > 4).length);
      assert.equal(roundClipped, 0, 'a two-line link label keeps pill corners that cut off its text');
      // The full-size cases miss overlaps at the minimum Settings content width.
      // One relay peer exercises the point; the narrow fleet exercises the station caption beside a neighboring peer.
      if (ui.case === 'narrow-relay' || ui.case === 'narrow-fleet') {
        // 经中转的线写对方到中转那一段(对方说的):Relay PC 走 WS(本机 UDP),Cloud Runner 走 UDP(本机 WS),CI Linux 是旧连接不写。
        const expected = ui.case === 'narrow-relay'
          ? [[await ui.t('settings.remoteControl.v2.relayTransport.websocket'), 24]]
          : [[await ui.t('settings.remoteControl.v2.relayTransport.udp'), 194], [await ui.t('settings.remoteControl.v2.linkTransport.webrtc'), 38], ['', 316]];
        for (const [transport, value] of expected) {
          const peerRtt = await ui.t('settings.remoteControl.v2.ms', { value });
          const pill = page.getByText(new RegExp(`^${transport}[\\s·]*${peerRtt}$`));
          await pill.waitFor();
          const pillBox = await pill.boundingBox();
          assert.ok(pillBox && !overlaps(pillBox, dotBox), 'peer link label overlaps the relay point');
          for (const line of lines) {
            assert.ok(line && !overlaps(pillBox, line), 'peer link label overlaps the relay caption');
          }
          assert.ok(
            await pill.evaluate((el) => [el, ...el.children].every((part) => part.scrollWidth <= part.clientWidth)),
            `peer link label is truncated (${transport} ${peerRtt})`,
          );
        }
        return;
      }
      // 名字、连接方式、往返三行都在，从上到下排着、不互相压住。
      for (const [i, line] of lines.entries()) {
        assert.ok(line, `relay label line ${i} is missing`);
        if (i > 0) assert.ok(line.y >= lines[i - 1].y + lines[i - 1].height - 1, 'relay label lines overlap');
      }
      // 细环按圆算:字的每一行离圆心最近的点都要在环外。
      const ringY = hubBox.y + hubBox.height / 2;
      const inRing = (a) => Math.hypot(Math.min(Math.max(hubX, a.x), a.x + a.width) - hubX, Math.min(Math.max(ringY, a.y), a.y + a.height) - ringY) < 36;
      const blockers = [['name', await below(selfName)], ['protocol', await below(selfProtocol)], ['relay point', dotBox]];
      for (const line of lines) {
        assert.ok(!inRing(line), 'relay label overlaps the ring');
        for (const [what, box] of blockers) assert.ok(!overlaps(line, box), `relay label overlaps ${what}`);
      }
      if (pathOnTrunk) {
        // 写在细环与中转点之间那段线上：不压细环、中转点、这台电脑的字和中转站的字，也不截断。设备线上的标签叠放时它也叠放。
        // 设备线上可能有同样的「UDP · 9 ms」(relay-below 的 Work PC):取细环与中转点之间那一个。
        const [near, far] = dotX < hubX ? [dotBox.x + dotBox.width, hubX - 36] : [hubX + 36, dotBox.x];
        let trunk = null;
        let trunkBox = null;
        for (const el of await topology.getByText(new RegExp(`^${relayTransport}[\\s·]*${relayRtt}$`)).all()) {
          const box = await el.boundingBox();
          if (box && box.x + box.width / 2 > Math.min(near, far) && box.x + box.width / 2 < Math.max(near, far)) [trunk, trunkBox] = [el, box];
        }
        assert.ok(trunk && trunkBox, 'relay path is not on the line from this computer to the relay point');
        assert.ok(trunkBox.x >= near && trunkBox.x + trunkBox.width <= far, 'relay path is not between the relay point and the ring');
        assert.ok(!inRing(trunkBox), 'relay path overlaps the ring');
        for (const [what, box] of [...blockers, ['relay label', relayLabel]]) assert.ok(!overlaps(trunkBox, box), `relay path overlaps ${what}`);
        assert.ok(await trunk.evaluate((el) => [el, ...el.children].every((part) => part.scrollWidth <= part.clientWidth)), 'relay path on the line is truncated');
      }
      // 只有中转站整个落在这台电脑的字下面时(split-direct),字才写到圆点下面。
      if (ui.case === 'split-direct' || relayBelow) assert.ok(relayLabel.y >= dotBox.y + dotBox.height, 'relay label under the relay point');
      else assert.ok(relayLabel.y + relayLabel.height <= dotBox.y, 'relay label above the relay point');
    }
    const hubCardStatus = `${await ui.t('settings.devices.linkStatus.online')} · ${relayTransport} · ${await ui.t('settings.remoteControl.v2.ms', { value: 25 })}`;
    if (ui.case === 'self-device-link') {
      assert.equal(await topology.getByText(agentNet, { exact: true }).count(), 0);
      await hub.click();
      const hubCard = page.getByRole('dialog');
      await hubCard.getByText(deviceLink, { exact: true }).waitFor();
      await hubCard.getByText(hubCardStatus, { exact: true }).waitFor();
      await ui.capture('hub-card');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case === 'default' || ui.case === 'fleet') {
      // 默认截图是减弱动效(在用的线是略粗的绿色实线);这里放开动效,有消息的线变成流动的绿色虚线。
      // 隔半节虚线的时间再截一帧(flow-later),两帧的空隙应整体往消息方向挪了一点。
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForTimeout(600);
      await ui.capture('flow');
      await page.waitForTimeout(375);
      await ui.capture('flow-later');
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    if (ui.case === 'fleet') {
      await page.getByRole('button', { name: /^Build Server/ }).hover();
      await ui.capture('hover');
      await page.mouse.move(0, 0);
    }
    if (ui.case === 'default') {
      // Fractional RTT samples must render as whole milliseconds alongside each link's actual transport protocol.
      const udp = await ui.t('settings.remoteControl.v2.relayTransport.udp');
      const ws = await ui.t('settings.remoteControl.v2.relayTransport.websocket');
      const webrtc = await ui.t('settings.remoteControl.v2.linkTransport.webrtc');
      // Home server 经中转：这台电脑那段走 UDP(写在它到中转站的线上),它自己那段走 WS(写在通往它的线上)。
      const labels = await Promise.all([[webrtc, 3], [udp, 1], [ws, 97]].map(async ([transport, value]) => ({
        transport,
        latency: await ui.t('settings.remoteControl.v2.ms', { value }),
      })));
      for (const { transport, latency } of labels) {
        const pill = page.getByText(`${transport} · ${latency}`, { exact: true });
        assert.ok(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth), 'single-line peer label is fully visible');
      }
      await topology.getByText(new RegExp(`^${relayTransport}[\\s·]*${relayRtt}$`)).waitFor();
      // Browser layout regression: the wide and minimum-width fixtures alone miss the
      // intermediate width where WebRTC and UDP on opposite sides used different line counts.
      const assertStackedLabels = async () => {
        for (const { transport, latency } of labels) {
          const pill = page.getByText(new RegExp(`^${transport}[\\s·]*${latency}$`));
          const protocolBox = await pill.getByText(transport, { exact: true }).boundingBox({ timeout: 1000 });
          const latencyBox = await pill.getByText(latency, { exact: true }).boundingBox({ timeout: 1000 });
          assert.ok(protocolBox && latencyBox && latencyBox.y >= protocolBox.y + protocolBox.height, 'all peer labels stack');
          assert.ok(await pill.evaluate((el) => [...el.children].every((line) => line.scrollWidth <= line.clientWidth)), 'both peer label lines are fully visible');
        }
      };
      await page.setViewportSize({ ...ui.viewport, width: 860 });
      await assertStackedLabels();
      await ui.capture('stacked-links');
      await page.setViewportSize(ui.viewport);
      // The maximum UI font setting scales text-11 to 19px. It also needs a shared two-line layout.
      const previousFontSize = await page.evaluate(() => {
        const previous = document.body.style.getPropertyValue('--text-11');
        document.body.style.setProperty('--text-11', '19px');
        return previous;
      });
      await assertStackedLabels();
      await page.evaluate((previous) => document.body.style.setProperty('--text-11', previous), previousFontSize);
      // Mixed real routes: both protocols share the topology, independently of direct/relay grouping.
      await topology.getByText(deviceLink, { exact: true }).first().waitFor();
      await topology.getByText(agentNet, { exact: true }).first().waitFor();
      // 拓扑卡片只展示连接信息(本机的配置在上方「我的设备」的本机卡片,其它设备不再列出)。
      await page.getByRole('button', { name: /^Work PC/ }).click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('dialog').getByText(`· ${webrtc}`, { exact: true }).waitFor();
      await page.getByRole('dialog').getByText(`${await ui.t('settings.remoteControl.v2.ms', { value: 3 })} · ${await ui.t('settings.remoteControl.v2.popover.rttNote')}`, { exact: true }).waitFor();
      await ui.capture('popover');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Home server/ }).click();
      await page.getByRole('dialog').getByText(await ui.t('settings.remoteControl.v2.protocol.agentNet'), { exact: true }).waitFor();
      // 卡片的「连接方式」两段都写：本机 UDP · 对方 WS。
      const legs = `${await ui.t('settings.remoteControl.v2.popover.relayLegSelf', { transport: udp })} · ${await ui.t('settings.remoteControl.v2.popover.relayLegPeer', { transport: ws })}`;
      await page.getByRole('dialog').getByText(`· ${legs}`, { exact: true }).waitFor();
      await ui.capture('agent-net-card');
      await page.keyboard.press('Escape');
      // 这台电脑的卡只展示连接信息;本机设置直接使用同页上方的卡片。
      await hub.click();
      const hubCard = page.getByRole('dialog');
      await hubCard.getByText(agentNet, { exact: true }).waitFor();
      await hubCard.getByText(hubCardStatus, { exact: true }).waitFor();
      await ui.capture('hub-card');
      await page.keyboard.press('Escape');
      // 要处理的设备:点开卡片,「状态」用红字写原因(没有单独的「需要处理」卡片)。
      await page.getByRole('button', { name: /^MacBook Air/ }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('attention-card');
      await page.keyboard.press('Escape');
      // 最近活动:拓扑右上角的图标,点开是弹出层。
      await page.getByRole('button', { name: await ui.t('settings.remoteControl.v2.recent.title') }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('recent');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: await ui.t('settings.remoteControl.v2.offlineShow') }).last().click();
      const offlineDevice = page.getByRole('button', { name: /^Old laptop/ });
      await offlineDevice.click();
      const remove = page.getByRole('dialog').getByRole('button', { name: await ui.t('settings.devices.delete'), exact: true });
      assert.equal(await remove.count(), 1, 'offline device card offers deletion');
      await ui.capture('offline-device');
      await remove.focus();
      await page.keyboard.down('Enter');
      await page.getByText(await ui.t('settings.devices.deleteTitle', { name: 'Old laptop' }), { exact: true }).waitFor();
      const cancel = page.getByRole('alertdialog').getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel') });
      await cancel.and(page.locator(':focus')).waitFor();
      // A held Enter must not confirm deletion with the next repeated keydown.
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await offlineDevice.and(page.locator(':focus')).waitFor();
      await offlineDevice.press('Enter');
      await remove.click();
      await cancel.and(page.locator(':focus')).waitFor();
      await cancel.press('Escape');
      await offlineDevice.and(page.locator(':focus')).waitFor();
      await offlineDevice.click();
      await remove.click();
      await page.getByRole('button', { name: await ui.t('settings.devices.delete'), exact: true }).click();
      await offlineDevice.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: /^Spare PC/ }).waitFor();
      await hub.and(page.locator(':focus')).waitFor();
    }
  },
};
