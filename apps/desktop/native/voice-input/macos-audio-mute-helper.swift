import CoreAudio
import Foundation

// One-shot helper: no microphone access, event loop, or resident process.
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data(message.utf8))
  exit(1)
}

func check(_ status: OSStatus) {
  if status != noErr { fail("CoreAudio status \(status)") }
}

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func deviceUID(_ device: AudioDeviceID) -> String {
  var property = address(kAudioDevicePropertyDeviceUID)
  var uid: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  check(AudioObjectGetPropertyData(device, &property, 0, nil, &size, &uid))
  guard let uid else { fail("Missing device UID") }
  return uid.takeUnretainedValue() as String
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, ["read", "mute", "set"].contains(command) else {
  fail("Expected read, mute or set")
}
var device = AudioDeviceID(kAudioObjectUnknown)
if command == "set" {
  guard args.count == 4, let id = UInt32(args[1]), ["true", "false"].contains(args[3]) else {
    fail("Expected set device uid true|false")
  }
  device = id
  // Never apply an old snapshot to a different device after disconnect/reuse.
  guard deviceUID(device) == args[2] else { fail("Output device changed") }
} else {
  guard args.count == 1 else { fail("Unexpected arguments") }
  var property = address(kAudioHardwarePropertyDefaultOutputDevice)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &device))
}
var property = address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
var writable: DarwinBoolean = false
check(AudioObjectIsPropertySettable(device, &property, &writable))
guard writable.boolValue else { fail("Output mute is not writable") }
var muted: UInt32 = 0
var size = UInt32(MemoryLayout<UInt32>.size)
check(AudioObjectGetPropertyData(device, &property, 0, nil, &size, &muted))

// Publish the original state BEFORE any write. The parent retains this even
// when the write fails or the helper is killed, so restoration remains possible.
let snapshot: [String: Any] = ["outputMuted": muted != 0, "deviceId": device, "deviceUID": deviceUID(device)]
let json = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
FileHandle.standardOutput.write(json + Data([10]))
if command != "read" {
  var desired: UInt32 = command == "mute" || args[3] == "true" ? 1 : 0
  if desired != muted {
    check(AudioObjectSetPropertyData(device, &property, 0, nil, UInt32(MemoryLayout<UInt32>.size), &desired))
  }
}
