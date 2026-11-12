/** Native integration regression: execute the production session methods with a fake
 * AVAudioSession. Protects PR #10141's restoration across playback takeover and
 * reacquisition; JS recorder tests cannot exercise native ownership. Minimal failure:
 * activate -> change category to playback -> deactivate leaves the flag enabled.
 * Run manually on macOS: node scripts/test-mobile-recording-haptics-native.mjs.
 * No network, microphone, or real AVAudioSession is used.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const source = readFileSync(new URL('../apps/mobile/modules/xdt-mobile-realtime-audio/ios/XdtMobileRealtimeAudioModule.swift', import.meta.url), 'utf8');
function method(name) {
  const start = source.indexOf(`  private func ${name}(`);
  if (start < 0) throw new Error(`Missing production method: ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 1, end = brace + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start, end).replace('private func', 'func');
}
const driver = String.raw`
import Foundation
final class AVAudioSession {
  enum Category { case playAndRecord, playback }
  enum Mode { case measurement, moviePlayback }
  struct Options: OptionSet {
    let rawValue: Int
    static let mixWithOthers = Options(rawValue: 1)
    static let duckOthers = Options(rawValue: 2)
    static let defaultToSpeaker = Options(rawValue: 4)
    static let notifyOthersOnDeactivation = Options(rawValue: 8)
  }
  static var current = AVAudioSession()
  static func sharedInstance() -> AVAudioSession { current }
  var category: Category = .playback
  var mode: Mode = .moviePlayback
  var categoryOptions: Options = []
  var allowHapticsAndSystemSoundsDuringRecording = false
  var deactivations = 0
  var failActivation = false
  func setCategory(_ category: Category, mode: Mode, options: Options) throws {
    self.category = category; self.mode = mode; categoryOptions = options
  }
  func setPreferredIOBufferDuration(_ duration: Double) throws {}
  func setAllowHapticsAndSystemSoundsDuringRecording(_ enabled: Bool) throws {
    allowHapticsAndSystemSoundsDuringRecording = enabled
  }
  func setActive(_ active: Bool, options: Options = []) throws {
    if active && failActivation { throw NSError(domain: "test", code: 1) }
    if !active { deactivations += 1 }
  }
}
final class Recorder {
  var ownsAudioSession = false
  var previousRecordingHaptics: Bool?
  var sessionActivatedAt = 0.0
__METHODS__
}
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() { fatalError(message) }
}
for initiallyEnabled in [false, true] {
  for takeover in [false, true] {
    let session = AVAudioSession(); AVAudioSession.current = session
    session.allowHapticsAndSystemSoundsDuringRecording = initiallyEnabled
    let recorder = Recorder()
    try recorder.activateAudioSessionLocked(session)
    try recorder.activateAudioSessionLocked(session) // warm reuse preserves snapshot
    if takeover { try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers]) }
    recorder.deactivateOwnedSessionLocked()
    check(session.allowHapticsAndSystemSoundsDuringRecording == initiallyEnabled, "original flag lost on release/takeover")
    check(session.deactivations == (takeover ? 0 : 1), "foreign playback was deactivated")
    recorder.deactivateOwnedSessionLocked()
    check(session.deactivations == (takeover ? 0 : 1), "duplicate release")
  }
}
let session = AVAudioSession(); AVAudioSession.current = session
let recorder = Recorder()
try recorder.activateAudioSessionLocked(session)
try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
try recorder.activateAudioSessionLocked(session) // before keep-alive cleanup fires
recorder.deactivateOwnedSessionLocked()
check(!session.allowHapticsAndSystemSoundsDuringRecording, "reacquisition overwrote original flag")
session.failActivation = true
let failed = Recorder()
do { try failed.activateAudioSessionLocked(session); fatalError("activation should fail") } catch {}
check(!session.allowHapticsAndSystemSoundsDuringRecording, "failed activation leaked flag")
print("PASS: recording haptics restoration, playback takeover, warm reuse, reacquisition, failed activation")
`;
const directory = mkdtempSync(join(tmpdir(), 'cindy-recording-haptics-'));
try {
  const main = join(directory, 'main.swift');
  writeFileSync(main, driver.replace('__METHODS__', [method('deactivateOwnedSessionLocked'), method('activateAudioSessionLocked')].join('\n')));
  execFileSync('xcrun', ['swiftc', main, '-o', join(directory, 'test')], { stdio: 'inherit' });
  execFileSync(join(directory, 'test'), [], { stdio: 'inherit' });
} finally { rmSync(directory, { recursive: true, force: true }); }
