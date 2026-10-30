# Mobile teammate entry and settings alignment

- Settings screenshots: iOS 27, 402 × 874 pt simulator, actual `CompanionProfileNativeView.ios.tsx` and native `ComposerSheet`/Form, Chinese, system Light and Dark.
- All eight icon-bearing rows share the same title and separator start. SF Symbol artwork remains centered in a 26 pt column with the existing 12 pt gap; row touch height remains 44 pt.
- The screenshots use static, non-sensitive profile props because the simulator's remote hosts were offline. Restart/delete sections are absent from that fixture. No remote action/save acceptance is claimed. The temporary fixture and route replacement were removed before commit.
- Metro served this branch (`fix-mobile-teammate-list-entry`) on 8081 and hot-reloaded the fixture and changed native component. The standard `mobile:sim:whoami` check does not discover the Baguette device set and reported native-missing; its injected source fingerprint also preceded the temporary fixture. These screenshots are component visual evidence, not full-app identity or end-to-end acceptance.
- Navigation validation uses the real HomeScreen, HomeModePanes, shared preferences, and navigation hook: single/multiple teammates, late roster arrival, refresh/remount, explicit row selection, and untouched cold startup. The chat drawer separately verifies close-before-return for the already-active teammate mode.
- Android shares the navigation implementation. Its settings rows already use equally-sized Lucide icons; no Android settings-layout changes. Android device checks and iOS online-host navigation were not performed.

## Teammate typography

The shared TeammateList now uses the existing task-row typography from HomeListVisuals: title 18/28 semibold, preview 15/26 regular, time/status 13/22 regular. These styles apply to the home roster, collection page and embedded name picker on iOS/Android. The Light/Dark list screenshots render the production list with static profiles in an isolated route fixture; long names/previews truncate to one line while timestamps remain readable. They are component evidence, not screenshots of the complete home chrome. No temporary preview code is shipped.
