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

for press: Int64 in [36, 100000] {
  var gate = PrivacyInputGate()
  precondition(gate.consume(physical: false, press: press, down: true, trigger: true) == (false, false))
  precondition(gate.consume(physical: true, press: press, down: true, trigger: true) == (true, true))
  precondition(gate.consume(physical: false, press: press, down: false, trigger: false) == (false, false))
  gate.phase = 2
  precondition(gate.consume(physical: false, press: press, down: true, trigger: true) == (true, false))
  precondition(gate.consume(physical: true, press: press, down: true, trigger: true) == (true, false))
  precondition(gate.consume(physical: true, press: press, down: false, trigger: false) == (true, false))
  precondition(gate.consume(physical: true, press: press, down: true, trigger: true) == (false, false))
  gate.phase = 0
  precondition(gate.consume(physical: false, press: press, down: true, trigger: true) == (false, false))
}

var wheelGate = PrivacyInputGate()
for phase in [0, 1, 2, 0] {
  wheelGate.phase = phase
  precondition(wheelGate.consume(physical: false, press: nil, down: false, trigger: false, scroll: true) == (phase == 2, false))
  precondition(wheelGate.consume(physical: true, press: nil, down: false, trigger: false, scroll: true) == (true, phase == 0))
  precondition(wheelGate.swallowed.isEmpty)
}

// 代输入 live view: decisions only, nothing is posted. A window id and pid that
// cannot exist stand in for a window that is gone or an app that is not focused.
do {
  let absent = HandoffConfine(window: 0xFFFF_FFF0, pid: 99_999_999)
  keys = []; buttons = []; location = CGPoint(x: 40, y: 50)
  precondition(confined(["kind": "move", "x": 0.5, "y": 0.5], absent) == nil, "No window, no pointer")
  precondition(confined(["kind": "button", "button": 0, "down": true, "x": 0.5, "y": 0.5], absent) == nil)
  let up = confined(["kind": "button", "button": 0, "down": false, "x": 0.9, "y": 0.9], absent)
  precondition(up?["x"] as? Double == 40 && up?["y"] as? Double == 50, "A release always lands where the pointer is")
  precondition(confined(["kind": "scroll", "dx": 0.0, "dy": 3.0], absent) == nil)
  precondition(confined(["kind": "text", "text": "a"], absent) == nil, "Typing only while the app is focused")
  precondition(confined(["kind": "key", "code": "KeyA", "down": true], absent) == nil)
  precondition(confined(["kind": "key", "code": "F3", "down": true], absent) == nil, "No function keys")
  precondition(confined(["kind": "key", "code": "KeyA", "down": false], absent) == nil, "Nothing to release")
  keys = [0]
  precondition(confined(["kind": "key", "code": "KeyA", "down": false], absent) != nil, "A held key is always released")
  keys = [55]
  precondition(confined(["kind": "key", "code": "Tab", "down": true], absent) == nil, "No app switcher")
  keys = [55, 59]
  precondition(confined(["kind": "key", "code": "KeyQ", "down": true], absent) == nil, "No lock-screen shortcut")
  precondition(confined(["kind": "wheel"], absent) == nil)
  keys = []
}
print("native window confinement passed")

// 代输入 scan-to-sign-in: a code drawn into a larger picture is found, with its content and place.
do {
  let filter = CIFilter(name: "CIQRCodeGenerator")!
  filter.setValue("https://login.example.com/qr?token=abc".data(using: .utf8), forKey: "inputMessage")
  let code = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
  let canvas = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 1200, height: 800))
  let placed = code.transformed(by: CGAffineTransform(translationX: 700, y: 300)).composited(over: canvas)
  let rep = NSBitmapImageRep(ciImage: placed)
  let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])!
  let codes = handoffDetectQr(jpeg)
  precondition(codes.count == 1 && codes[0]["text"] as? String == "https://login.example.com/qr?token=abc", "The code says what it was made with")
  let box = codes[0]["box"] as! [Double]
  precondition(box[0] > 0.55 && box[0] < 0.65 && box[1] > 0.2 && box[1] < 0.36, "Top-left origin, as fractions")
  precondition(handoffDetectQr(Data([1, 2, 3])).isEmpty, "Not a picture, no codes")
}
print("native qr detection passed")
