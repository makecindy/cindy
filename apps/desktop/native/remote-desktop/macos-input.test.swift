// Compiled with the real helper and DESKTOP_INPUT_TEST. Never posts OS events
// or requests permissions: these assertions inspect constructed CGEvents only.
for down in [true, false] {
  keys = []
  let desktop = makeKeyEvent(103, down)!
  precondition(desktop.flags.contains(.maskSecondaryFn), "F11 must match the system shortcut")
  precondition(!desktop.flags.contains(.maskControl))

  keys = [59]
  let windows = makeKeyEvent(126, down)!
  precondition(windows.flags.contains([.maskControl, .maskSecondaryFn, .maskNumericPad]),
               "Control-Up must retain both the remote modifier and intrinsic arrow flags")

  keys = [55, 56]
  let letter = makeKeyEvent(0, down)!
  precondition(letter.flags.contains([.maskCommand, .maskShift]))
  precondition(!letter.flags.contains(.maskSecondaryFn), "Letters must not become function keys")

  keys = []
  precondition(!makeKeyEvent(0, down)!.flags.contains(.maskCommand), "Released modifiers must clear")
  // Simulate flags left in the sending source by earlier F11 / arrow events.
  letter.flags.formUnion([.maskSecondaryFn, .maskNumericPad, .maskControl])
  configureKeyFlags(letter, 0, down)
  precondition(letter.flags.intersection([.maskSecondaryFn, .maskNumericPad, .maskControl, .maskCommand, .maskShift]).isEmpty,
               "Previous shortcut flags must not leak into ordinary typing")
  let control = makeKeyEvent(59, down)!
  precondition(!control.flags.contains(.maskSecondaryFn), "Control must not inherit F11's Fn state")
}
print("native keyboard flags passed")
