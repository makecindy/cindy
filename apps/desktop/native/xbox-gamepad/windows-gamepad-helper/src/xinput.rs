use crate::mapping;
use serde_json::{json, Value};
use windows::Gaming::Input::{GamepadButtons, GamepadReading};
use windows::Win32::UI::Input::XboxController::*;

/// One stable XInput slot owns the Xbox accessory; neutral input is not disconnect.
#[derive(Default)]
pub struct XboxInput {
    slot: Option<u32>,
    last_frame: Option<Value>,
    triggers: mapping::TriggerState,
}

/// XInput 1.4 ships with supported Windows versions. No custom DLL loader or driver changes.
pub fn read(slot: u32) -> Option<XINPUT_GAMEPAD> {
    let mut state = XINPUT_STATE::default();
    // SAFETY: state is initialized writable storage; slot is a bounded XInput user index.
    (unsafe { XInputGetState(slot, &mut state) } == 0).then_some(state.Gamepad)
}

fn reading(pad: &XINPUT_GAMEPAD) -> GamepadReading {
    let mut buttons = GamepadButtons::None;
    for (native, mapped) in [
        (XINPUT_GAMEPAD_A, GamepadButtons::A),
        (XINPUT_GAMEPAD_B, GamepadButtons::B),
        (XINPUT_GAMEPAD_X, GamepadButtons::X),
        (XINPUT_GAMEPAD_Y, GamepadButtons::Y),
        (XINPUT_GAMEPAD_LEFT_SHOULDER, GamepadButtons::LeftShoulder),
        (XINPUT_GAMEPAD_RIGHT_SHOULDER, GamepadButtons::RightShoulder),
        (XINPUT_GAMEPAD_BACK, GamepadButtons::View),
        (XINPUT_GAMEPAD_START, GamepadButtons::Menu),
        (XINPUT_GAMEPAD_LEFT_THUMB, GamepadButtons::LeftThumbstick),
        (XINPUT_GAMEPAD_RIGHT_THUMB, GamepadButtons::RightThumbstick),
        (XINPUT_GAMEPAD_DPAD_UP, GamepadButtons::DPadUp),
        (XINPUT_GAMEPAD_DPAD_DOWN, GamepadButtons::DPadDown),
        (XINPUT_GAMEPAD_DPAD_LEFT, GamepadButtons::DPadLeft),
        (XINPUT_GAMEPAD_DPAD_RIGHT, GamepadButtons::DPadRight),
    ] {
        if pad.wButtons.contains(native) {
            buttons |= mapped;
        }
    }
    // Signed sticks have asymmetric endpoints. Keep the existing positive-up convention
    // and leave action dead zones to the existing controller, just like WGI frames.
    let axis = |v: i16| f64::from(v) / if v < 0 { 32768.0 } else { 32767.0 };
    GamepadReading {
        Buttons: buttons,
        LeftTrigger: f64::from(pad.bLeftTrigger) / 255.0,
        RightTrigger: f64::from(pad.bRightTrigger) / 255.0,
        LeftThumbstickX: axis(pad.sThumbLX),
        LeftThumbstickY: axis(pad.sThumbLY),
        RightThumbstickX: axis(pad.sThumbRX),
        RightThumbstickY: axis(pad.sThumbRY),
        ..Default::default()
    }
}

fn presence(slot: Option<u32>) -> Value {
    match slot {
        Some(slot) => json!({"kind":"presence", "family":"xbox", "present":true,
            "name":format!("Xbox Controller (XInput {})", slot + 1),
            "category":"XInput", "transport":"unknown"}),
        None => json!({"kind":"presence", "family":"xbox", "present":false}),
    }
}

impl XboxInput {
    pub fn connected(&self) -> bool {
        self.slot.is_some()
    }

    pub fn poll(
        &mut self,
        force: bool,
        scan: bool,
        mut read: impl FnMut(u32) -> Option<XINPUT_GAMEPAD>,
    ) -> Vec<Value> {
        let old = self.slot;
        let mut messages = Vec::new();
        let mut sample = old.and_then(|slot| read(slot).map(|pad| (slot, pad)));
        let lost = old.is_some() && sample.is_none();
        if lost {
            messages.push(presence(None));
            self.slot = None;
            self.last_frame = None;
            self.triggers = mapping::TriggerState::default();
        }
        if sample.is_none() && (scan || force || lost) {
            sample = (0..4)
                .filter(|slot| Some(*slot) != old)
                .find_map(|slot| read(slot).map(|pad| (slot, pad)));
        }
        if let Some((slot, pad)) = sample {
            if self.slot != Some(slot) {
                self.slot = Some(slot);
                self.last_frame = None;
                self.triggers = mapping::TriggerState::default();
                messages.push(presence(self.slot));
            } else if force {
                messages.push(presence(self.slot));
            }
            let frame = mapping::frame("xbox", &reading(&pad), &mut self.triggers);
            if force || self.last_frame.as_ref() != Some(&frame) {
                messages.push(frame.clone());
                self.last_frame = Some(frame);
            }
        } else if force && !lost {
            messages.push(presence(None));
        }
        messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_xinput_button_maps_to_exactly_one_protocol_button() {
        for (button, key) in [
            (XINPUT_GAMEPAD_A, "a"),
            (XINPUT_GAMEPAD_B, "b"),
            (XINPUT_GAMEPAD_X, "x"),
            (XINPUT_GAMEPAD_Y, "y"),
            (XINPUT_GAMEPAD_LEFT_SHOULDER, "lb"),
            (XINPUT_GAMEPAD_RIGHT_SHOULDER, "rb"),
            (XINPUT_GAMEPAD_BACK, "view"),
            (XINPUT_GAMEPAD_START, "menu"),
            (XINPUT_GAMEPAD_LEFT_THUMB, "ls"),
            (XINPUT_GAMEPAD_RIGHT_THUMB, "rs"),
            (XINPUT_GAMEPAD_DPAD_UP, "dpadUp"),
            (XINPUT_GAMEPAD_DPAD_DOWN, "dpadDown"),
            (XINPUT_GAMEPAD_DPAD_LEFT, "dpadLeft"),
            (XINPUT_GAMEPAD_DPAD_RIGHT, "dpadRight"),
        ] {
            let frame = mapping::frame(
                "xbox",
                &reading(&XINPUT_GAMEPAD {
                    wButtons: button,
                    ..Default::default()
                }),
                &mut mapping::TriggerState::default(),
            );
            assert_eq!(frame["buttons"][key], true, "{key}");
            assert_eq!(
                frame["buttons"]
                    .as_object()
                    .unwrap()
                    .values()
                    .filter(|v| **v == true)
                    .count(),
                1
            );
        }
    }

    #[test]
    fn xinput_frames_match_the_shared_host_controller_lifecycle_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../src/main/xbox-gamepad/__tests__/fixtures/windowsLifecycle.json"
        ))
        .unwrap();
        for (key, pad) in [
            ("neutral", XINPUT_GAMEPAD::default()),
            (
                "held",
                XINPUT_GAMEPAD {
                    bLeftTrigger: 255,
                    sThumbRY: i16::MAX,
                    ..Default::default()
                },
            ),
        ] {
            let mut expected = fixture["frames"][key].clone();
            for group in ["axes", "triggers"] {
                for value in expected[group].as_object_mut().unwrap().values_mut() {
                    *value = json!(value.as_f64().unwrap());
                }
            }
            let mut xbox = XboxInput::default();
            let messages = xbox.poll(true, true, |_| Some(pad));
            assert_eq!(messages.last().unwrap(), &expected);
        }
    }

    #[test]
    fn wired_input_and_neutral_release_use_xinput_without_wgi() {
        let mut xbox = XboxInput::default();
        let held = XINPUT_GAMEPAD {
            wButtons: XINPUT_GAMEPAD_A | XINPUT_GAMEPAD_DPAD_UP,
            bLeftTrigger: 255,
            bRightTrigger: 128,
            sThumbLX: i16::MIN,
            sThumbLY: i16::MAX,
            sThumbRX: i16::MAX,
            sThumbRY: i16::MIN,
        };
        let messages = xbox.poll(true, true, |slot| (slot == 0).then_some(held));
        assert_eq!(messages[0]["present"], true);
        let frame = messages.last().unwrap();
        assert_eq!(frame["buttons"]["a"], true);
        assert_eq!(frame["buttons"]["dpadUp"], true);
        assert_eq!(frame["buttons"]["lt"], true);
        assert_eq!(
            frame["axes"],
            serde_json::json!({"lx":-1.0,"ly":1.0,"rx":1.0,"ry":-1.0})
        );
        assert_eq!(frame["triggers"]["rt"], 128.0 / 255.0);
        let released = xbox.poll(false, false, |_| Some(XINPUT_GAMEPAD::default()));
        assert!(released[0]["buttons"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == false));
        assert!(xbox
            .poll(false, false, |_| Some(XINPUT_GAMEPAD::default()))
            .is_empty());
    }

    #[test]
    fn selection_is_stable_and_removal_releases_before_replacement() {
        let mut xbox = XboxInput::default();
        xbox.poll(true, true, |slot| {
            (slot == 2).then_some(XINPUT_GAMEPAD::default())
        });
        let mut queried = Vec::new();
        let messages = xbox.poll(false, true, |slot| {
            queried.push(slot);
            Some(XINPUT_GAMEPAD::default())
        });
        assert_eq!(queried, vec![2]);
        assert!(messages.is_empty());
        let messages = xbox.poll(false, false, |slot| {
            (slot == 1).then_some(XINPUT_GAMEPAD::default())
        });
        assert_eq!(messages[0]["present"], false);
        assert_eq!(messages[1]["present"], true);
        assert_eq!(messages[2]["kind"], "frame");
        assert_eq!(
            xbox.poll(false, false, |_| None),
            vec![serde_json::json!({"kind":"presence","family":"xbox","present":false})]
        );
        let mut queried = Vec::new();
        assert!(xbox
            .poll(false, false, |slot| {
                queried.push(slot);
                None
            })
            .is_empty());
        assert!(
            queried.is_empty(),
            "empty slots must not be polled every frame"
        );
    }

    #[test]
    fn probes_preserve_trigger_hysteresis_and_force_a_fresh_frame() {
        let mut xbox = XboxInput::default();
        for (pressure, pressed) in [(153, true), (128, true), (102, false)] {
            let messages = xbox.poll(true, true, |_| {
                Some(XINPUT_GAMEPAD {
                    bLeftTrigger: pressure,
                    ..Default::default()
                })
            });
            assert_eq!(messages.last().unwrap()["buttons"]["lt"], pressed);
        }
    }
}
