import assert from 'node:assert/strict';

// Same ids as fixture.tsx (the person's devices; fictional names).
const CLOUD = 'cloud-host-0123456789abcdef';
const STUDIO = 'studio-mac-0011223344556677';
const AIR = 'macbook-air-8899aabbccddeeff';
const LAB = 'lab-pc-0123012301230123';
const MINI = 'mac-mini-4455667788990011';
const IMAC = 'office-imac-5566778899aabbcc';
const SSHD_INSTALL_COMMAND = 'sudo apt install -y openssh-server && sudo systemctl enable --now ssh';
// A narrow settings column (wide sidebar), and the narrowest one an 800px window leaves next to the default sidebar.
const NARROW = { width: 400, height: 1000 };
const NARROW_LIST = { width: 540, height: 1000 };

const scene = (name, about, extra = {}) => ({ about, data: { scene: name }, ...extra });
const TARGET = 'A Cindy cloud host (Linux) lets the owner\'s other devices in over SSH: on by default, the terminal alias, two devices and a pasted key; adding a key checks it, removing a device asks first (remote control goes too, its sessions end) and warns about a session whose key could not be identified, ending all sessions reports the count';
const CONTROLLER = 'This Mac keeps SSH hosts for the other devices: the terminal command and Connect on the cloud host\'s card, Add back for a host the person deleted, Needs update for an old Cindy, unavailable while the device has SSH off or Remote Login off (the card says which); the SSH list marks them 「来自我的设备」 (with 「主机指纹已核对」 where the host key is pinned), offers the terminal command to copy next to the alias and keeps their connection read-only';

export default {
  name: 'ssh-access',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 1000 },
  real: 'RemoteControlSection and MyDevicesPanel: SshAccessSetting in this computer\'s card next to RemoteDesktopSetting (DefaultOverrideControls, the add-key dialog, ConfirmDialog, toasts), SshDeviceHostRow with useSshDeviceHosts on the other devices\' cards, and RemoteSection\'s SSH list and edit form for hosts of the person\'s own devices',
  notCovered:
    'Main-process behaviour (authorized_keys writes, the sshd / Remote Login probe, enrollment over device-link, ~/.ssh/cindy.conf and cindy_known_hosts writes, host-key pinning) and real SSH connections, covered by src/main/ssh-access/__tests__ and packages/maker-remote-ssh tests; clipboard contents are not read back',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export function useAuth() { return { deviceId: "self", user: null, mode: "cloud" }; } export function useOptionalAuthUser() { return null; } export function useOptionalDataOwnerGeneration() { return 0; }',
    },
  },
  cases: {
    default: scene('target', TARGET),
    'target-narrow': scene('target', `${TARGET} (narrow window)`, { viewport: NARROW }),
    'target-blocked-linux': scene(
      'target-blocked-linux',
      'SSH server not running on the cloud host: the install command to copy (Cindy never runs it), no alias yet, and a key of a device that left the account marked not in effect',
    ),
    'target-blocked-mac': scene(
      'target-blocked-mac',
      'Turned on by the person on a Mac with Remote Login off: where to turn it on (Cindy never toggles it), the customized badge, removing a device says its open sessions stay open (macOS cannot end one device\'s sessions), and Restore default back to off',
    ),
    'target-blocked-mac-narrow': scene('target-blocked-mac', 'The Mac guidance in a narrow window', { viewport: NARROW }),
    controller: scene('controller', CONTROLLER),
    'controller-narrow': scene('controller', `${CONTROLLER} (narrowest settings column of an 800px window)`, { viewport: NARROW_LIST }),
  },
  async check(page, ui) {
    const sceneName = ui.data.scene;
    const selfId = sceneName === 'controller' || sceneName === 'target-blocked-mac' ? STUDIO : CLOUD;
    const self = page.locator(`li[data-device-id="${selfId}"]`);
    const section = page.locator('#settings-search-target-remote-ssh-access');
    const k = (key, values) => ui.t(`settings.remoteControl.sshAccess.${key}`, values);
    const toggle = section.getByRole('switch', { name: await k('title') });
    await toggle.waitFor();
    // In this computer's card, right under remote desktop.
    assert.equal(await self.locator('#settings-search-target-remote-ssh-access').count(), 1);
    await self.getByRole('switch', { name: await ui.t('remoteDesktop.allow') }).waitFor();

    // The description and this computer's default read as one string, spaced the way the language writes sentences.
    const described = async (defaultKey) => k('descriptionWithDefault', { description: await k('description'), defaultNote: await k(defaultKey) });

    if (sceneName === 'controller') {
      // This Mac's own SSH access stays at its default (off): no list, no actions.
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await section.getByText(await described('defaultOff'), { exact: true }).waitFor();
      assert.equal(await section.getByRole('button', { name: await k('addKey') }).count(), 0);

      const card = (deviceId) => page.locator(`li[data-device-id="${deviceId}"]`);
      const ready = card(CLOUD);
      await ready.getByText('ssh cindy-vm-4-7-ubuntu', { exact: true }).waitFor();
      await ready.getByRole('button', { name: await k('device.copy') }).waitFor();
      await ready.getByRole('button', { name: await k('device.connect'), exact: true }).waitFor();
      const deleted = card(AIR);
      await deleted.getByText(await k('device.userDeleted')).waitFor();
      // Not in the SSH list, so no command to copy yet.
      assert.equal(await deleted.getByText('ssh cindy-macbook-air').count(), 0);
      await card(LAB).getByText(await k('device.needsUpdate')).waitFor();
      assert.equal(await card(LAB).locator('code').count(), 0);
      const off = card(MINI);
      await off.getByText(await k('device.unavailable.off')).waitFor();
      assert.equal(await off.getByRole('button', { name: await k('device.connect'), exact: true }).count(), 0);
      // Blocked there: the card names the device's own reason, not a generic one.
      await card(IMAC).getByText(await k('device.unavailable.blocked.REMOTE_LOGIN_OFF'), { exact: true }).waitFor();
      // The controller's own Mac card has no SSH row about itself.
      assert.equal(await self.getByText(await k('device.rowName'), { exact: true }).count(), 0);
      await ready.scrollIntoViewIfNeeded();
      await ui.capture('cards');

      // 「添加到 SSH 远程主机」 brings the deleted host back.
      await deleted.getByRole('button', { name: await k('device.restore'), exact: true }).click();
      await deleted.getByText('ssh cindy-macbook-air', { exact: true }).waitFor();
      assert.equal(await deleted.getByText(await k('device.userDeleted')).count(), 0);
      await deleted.scrollIntoViewIfNeeded();
      await ui.capture('restored', { locator: deleted });

      // Connect opens Cindy's own SSH connection to that host.
      await ready.getByRole('button', { name: await k('device.connect'), exact: true }).click();
      await page.getByText(await k('device.connected', { name: 'VM-4-7-ubuntu' })).waitFor();

      // The SSH list: the device hosts say where they come from, and that their host fingerprint was checked only where
      // the key is pinned (not on the Mac mini, whose pin is gone); the unusable ones say so.
      const ssh = page.locator('#settings-search-target-remote-ssh');
      await ssh.locator(':scope > button').click();
      const pinned = await ui.t('settings.remote.fromMyDeviceKeyPinned');
      await ssh.getByText(pinned, { exact: true }).first().waitFor();
      assert.equal(await ssh.getByText(pinned, { exact: true }).count(), 2);
      assert.equal(await ssh.getByText(await ui.t('settings.remote.fromMyDevice'), { exact: true }).count(), 1);
      assert.equal(await ssh.getByText(await ui.t('settings.remote.deviceUnavailable'), { exact: true }).count(), 2);
      // Each device host offers its terminal command next to the alias, as on its card; dev-server does not.
      assert.equal(await ssh.getByRole('button', { name: await k('device.copy') }).count(), 3);
      // A host's title keeps its name whole and its alias beside it, also in the narrowest column: the actions take a
      // line of their own there instead of squeezing the title letter by letter.
      const nameBox = await ssh.getByText('VM-4-7-ubuntu', { exact: true }).boundingBox();
      const aliasBox = await ssh.getByText('cindy-vm-4-7-ubuntu', { exact: true }).boundingBox();
      assert.ok(nameBox.height < 24, `the host name wrapped (${nameBox.height}px tall)`);
      assert.ok(Math.abs(nameBox.y + nameBox.height / 2 - (aliasBox.y + aliasBox.height / 2)) < 4, 'the alias left the name\'s line');
      await ssh.scrollIntoViewIfNeeded();
      await ui.capture('ssh-list');
      // Editing one keeps its connection read-only (main refuses such edits too).
      await ssh.getByRole('button', { name: await ui.t('settings.remote.button.edit') }).first().click();
      await ssh.getByText(await ui.t('settings.remote.edit.deviceHostReadOnly')).waitFor();
      const hostname = ssh.getByLabel(await ui.t('settings.remote.add.hostname'));
      assert.equal(await hostname.inputValue(), '203.0.113.24');
      assert.equal(await hostname.isDisabled(), true);
      await ssh.getByText(await ui.t('settings.remote.edit.deviceHostReadOnly')).scrollIntoViewIfNeeded();
      await ui.capture('ssh-edit');
      return;
    }

    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    if (sceneName === 'target-blocked-mac') {
      await section.getByText(await k('blocked.REMOTE_LOGIN_OFF')).waitFor();
      assert.equal(await section.getByText(SSHD_INSTALL_COMMAND).count(), 0);
      // The guidance opens the Sharing pane directly instead of leaving the person to find it.
      await section.getByRole('button', { name: await k('openSharingSettings'), exact: true }).waitFor();
      // No alias to offer while the other devices cannot connect.
      assert.equal(await section.locator('code').count(), 0);
      await section.getByText(await described('defaultOff'), { exact: true }).waitFor();
      await section.getByText(await ui.t('settings.defaults.customizedBadge'), { exact: true }).waitFor();
      await self.scrollIntoViewIfNeeded();
      await ui.capture('blocked', { locator: self });
      // macOS cannot end one device's sessions, so the confirmation says they stay open; cancelling keeps the device.
      await section.locator('li').filter({ hasText: 'MacBook Air' }).getByRole('button', { name: await k('remove'), exact: true }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.getByText(await k('removeDeviceConfirm.bodyKeepsSessions', { name: 'MacBook Air' })).waitFor();
      await ui.capture('remove-device-confirm-mac');
      await confirm.getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true }).click();
      await confirm.waitFor({ state: 'detached' });
      await section.getByText('MacBook Air', { exact: true }).waitFor();
      // Restore default: off on a Mac; the list and guidance go away.
      await section.getByRole('button', { name: await ui.t('settings.defaults.restore') }).click();
      await page.waitForFunction(
        () => document.querySelector('#settings-search-target-remote-ssh-access [role="switch"]')?.getAttribute('aria-checked') === 'false',
      );
      assert.equal(await section.getByText(await k('blocked.REMOTE_LOGIN_OFF')).count(), 0);
      assert.equal(await section.getByRole('button', { name: await k('addKey') }).count(), 0);
      await ui.capture('restored-default', { locator: self });
      return;
    }

    if (sceneName === 'target-blocked-linux') {
      await section.getByText(await k('blocked.SSHD_UNREACHABLE')).waitFor();
      assert.equal((await section.locator('code').first().innerText()).trim(), SSHD_INSTALL_COMMAND);
      await section.getByRole('button', { name: await k('copyCommand') }).waitFor();
      await section.getByText(await k('otherDistributions')).waitFor();
      // A device that left the account: unknown name, its key no longer in effect.
      const unknown = section.locator('li').filter({ hasText: await k('unknownDevice') });
      await unknown.getByText(await k('inactive'), { exact: false }).waitFor();
      await self.scrollIntoViewIfNeeded();
      await ui.capture('blocked', { locator: self });
      return;
    }

    // target: on by default here, the alias other devices usually use, the devices (one named from the device list)
    // and the key.
    await section.getByText(await described('defaultOn'), { exact: true }).waitFor();
    await section.getByText('ssh cindy-vm-4-7-ubuntu', { exact: true }).waitFor();
    // The command copies from here too, like on the other devices' cards.
    await section.getByRole('button', { name: await k('device.copy'), exact: true }).waitFor();
    await section.getByText(await k('listHeading', { count: 3 })).waitFor();
    for (const name of ['Studio Mac', 'MacBook Air', 'Office server']) {
      await section.getByText(name, { exact: true }).waitFor();
    }
    await self.scrollIntoViewIfNeeded();
    await ui.capture('setting', { locator: self });

    // Add a key: a key that is not ssh-ed25519 is refused in the dialog, which stays open.
    await section.getByRole('button', { name: await k('addKey'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: await k('addKeyDialog.heading') });
    const keyField = dialog.getByLabel(await k('addKeyDialog.keyField'));
    await keyField.fill('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ ci@build');
    await dialog.getByRole('button', { name: await k('addKeyDialog.submit'), exact: true }).click();
    await dialog.getByText(await k('addKeyErrors.INVALID_PARAMS')).waitFor();
    assert.equal(await keyField.getAttribute('aria-invalid'), 'true');
    await ui.capture('add-key-invalid');
    await keyField.fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ci@build');
    await dialog.getByLabel(await k('addKeyDialog.noteField')).fill('Build runner');
    await dialog.getByRole('button', { name: await k('addKeyDialog.submit'), exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await section.getByText('Build runner', { exact: true }).waitFor();
    await section.getByText(await k('listHeading', { count: 4 })).waitFor();

    // Removing a device revokes its remote access too, so it asks first. One of its sessions ends; another session's
    // key could not be identified, so it is left running and the result is a warning naming the way to end it.
    const studio = section.locator('li').filter({ hasText: 'Studio Mac' });
    await studio.getByRole('button', { name: await k('remove'), exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByText(await k('removeDeviceConfirm.body', { name: 'Studio Mac' })).waitFor();
    await ui.capture('remove-device-confirm');
    await confirm.getByRole('button', { name: await ui.t('settings.remoteControl.revokeConfirm.confirm'), exact: true }).click();
    await confirm.waitFor({ state: 'detached' });
    await page.getByText(await k('deviceRemovedSessionsLeft', { name: 'Studio Mac', count: 1, unmapped: 1 }), { exact: true }).waitFor();
    assert.equal(await section.getByText('Studio Mac', { exact: true }).count(), 0);

    // Ending every session asks first, then says how many ended.
    await section.getByRole('button', { name: await k('endSessions'), exact: true }).click();
    const end = page.getByRole('alertdialog');
    await end.getByText(await k('endSessionsConfirm.body')).waitFor();
    await ui.capture('end-sessions-confirm');
    await end.getByRole('button', { name: await k('endSessionsConfirm.action'), exact: true }).click();
    await end.waitFor({ state: 'detached' });
    await page.getByText(await k('sessionsEnded', { count: 2 }), { exact: true }).waitFor();
    await ui.capture('sessions-ended');
  },
};
