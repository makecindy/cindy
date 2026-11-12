// Guard tier: native transport, memory safety and packaged helper contracts
// span Swift/C, Forge and the JS host; JS host fakes cannot execute these APIs.
// Keep real host lifecycle behavior in host.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Xbox gamepad helper packaging contract', () => {
  it('starts Windows input and ships a native helper for the requested architecture', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const forge = readFileSync(new URL('../../../../forge.config.ts', import.meta.url), 'utf8');
    expect(index).toContain("process.platform === 'darwin' || process.platform === 'win32'");
    expect(forge).toContain('buildWindowsGamepadHelper(platform, arch)');
    expect(forge).toContain('aarch64-pc-windows-msvc');
    expect(forge).toContain('x86_64-pc-windows-msvc');
    expect(forge).toContain("buildWindowsInputHelper('gamepad', platform, arch)");
    expect(forge).toContain("buildWindowsInputHelper('micro', platform, arch)");
    expect(forge).toContain('cindy-windows-${kind}-helper.exe');
  });
  it('matches HID transport to the current controller instead of any Microsoft USB device', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/macos-xbox-gamepad-helper.swift', import.meta.url),
      'utf8',
    );
    expect(source).toContain('func controllerTransport(for controller: GCController)');
    expect(source).toContain('IOHIDManagerSetDeviceMatchingMultiple');
    expect(source).toContain('0x054C');
    expect(source).toContain('0x057E');
    expect(source).not.toContain('func microsoftControllerTransport()');
    expect(source).not.toContain('if sawUsb { return "usb" }');
  });

  it('attaches any extended gamepad instead of filtering to Xbox', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/macos-xbox-gamepad-helper.swift', import.meta.url),
      'utf8',
    );
    expect(source).toContain('func isSupportedGamepad');
    expect(source).toContain('func resolveGamepadFamily');
    expect(source).toContain('for controller in all where isSupportedGamepad(controller)');
    expect(source).toContain('return "generic"');
    expect(source).not.toContain('func isXboxController');
    expect(source).not.toContain('all.first(where: isXboxController)');
    expect(source).toContain('switch2_usb_ensure');
    expect(source).toContain('switch2-usb on');
    expect(source).toContain('switch2-usb off');
    expect(source).toContain('switch2_usb_shutdown');
    expect(source).toContain('func setSwitch2UsbWanted');
    const startFn = source.match(/func start\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(startFn).not.toContain('switch2_usb_ensure');
    expect(startFn).not.toContain('scheduledTimer');
    expect(source).toContain('switch2PollTimer');
    expect(source).toMatch(
      /if family == "nintendo" \{[\s\S]*?if switch2UsbWanted \{[\s\S]*?continue/,
    );
    expect(source).not.toMatch(
      /if family == "nintendo" \{\s*observed\[family\] = nil\s*continue\s*\}/,
    );
  });

  it('compiles switch2_usb.c with clang before linking the object into swiftc', () => {
    const forge = readFileSync(new URL('../../../../forge.config.ts', import.meta.url), 'utf8');
    const host = readFileSync(new URL('../host.ts', import.meta.url), 'utf8');
    expect(forge).toContain("MACOS_XBOX_GAMEPAD_HELPER_DEPLOYMENT_TARGET = 'macos11.0'");
    expect(forge).toContain('compileCObjectForTarget');
    expect(forge).toContain("'clang'");
    expect(forge).toContain('switch2_usb.c');
    expect(forge).toContain('switch2_usb.h');
    expect(host).toContain("'clang'");
    expect(host).toContain("'-c'");
    expect(host).toContain('switch2_usb.o');
    expect(host).not.toMatch(/swiftc',[\s\S]*switch2UsbC/);
    expect(host).toContain('setSwitch2UsbWanted');
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toContain('setSwitch2UsbWanted');
    expect(index).toContain('computeSwitch2UsbWanted');
    expect(index).toContain('taskSlotsSuspended');
    expect(index).toContain('layoutPreviewLease.setActive(false, owner)');
    expect(index).not.toMatch(/previewFamily = family;\s*layoutPreviewLease\.setActive\(active/);
    expect(index).not.toMatch(
      /setSwitch2UsbWanted\(\s*controller\.getAccessories\(\)\.nintendo\.settings\.deviceEnabled \|\| previewFamily === 'nintendo'/,
    );
  });

  it('copies the matching HID set into a buffer sized for every device', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/switch2_usb.c', import.meta.url),
      'utf8',
    );
    expect(source).toContain('CFSetApplyFunction');
    expect(source).not.toContain('CFSetGetValues(devices, (const void **)&device)');
  });
});
