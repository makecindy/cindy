use serde_json::{json, Value};
use windows::Gaming::Input::{GamepadButtons, GamepadReading};

pub fn family(vendor: u16, name: &str) -> &'static str {
    match vendor {
        0x045e => "xbox",
        0x054c => "playstation",
        0x057e => "nintendo",
        _ if name.to_ascii_lowercase().contains("xbox") => "xbox",
        _ => "generic",
    }
}

/// Per-device trigger history, independent of deduplication and forced probe frames.
#[derive(Default, Clone, Copy)]
pub struct TriggerState {
    lt: bool,
    rt: bool,
}

fn trigger_pressed(previous: bool, value: f64) -> bool {
    if previous {
        value > 0.4
    } else {
        value >= 0.55
    }
}

/// WGI and the existing macOS protocol both use positive Y for stick-up.
pub fn frame(family: &str, reading: &GamepadReading, triggers: &mut TriggerState) -> Value {
    triggers.lt = trigger_pressed(triggers.lt, reading.LeftTrigger);
    triggers.rt = trigger_pressed(triggers.rt, reading.RightTrigger);
    let pressed = |button: GamepadButtons| reading.Buttons.contains(button);
    json!({
        "kind": "frame", "family": family,
        "buttons": {
            "lt": triggers.lt, "rt": triggers.rt,
            "a": pressed(GamepadButtons::A), "b": pressed(GamepadButtons::B),
            "x": pressed(GamepadButtons::X), "y": pressed(GamepadButtons::Y),
            "lb": pressed(GamepadButtons::LeftShoulder), "rb": pressed(GamepadButtons::RightShoulder),
            "view": pressed(GamepadButtons::View), "menu": pressed(GamepadButtons::Menu),
            "ls": pressed(GamepadButtons::LeftThumbstick), "rs": pressed(GamepadButtons::RightThumbstick),
            "dpadUp": pressed(GamepadButtons::DPadUp), "dpadDown": pressed(GamepadButtons::DPadDown),
            "dpadLeft": pressed(GamepadButtons::DPadLeft), "dpadRight": pressed(GamepadButtons::DPadRight)
        },
        // Include digital history so main's trigger parser preserves the same hysteresis.
        "triggers": { "lt": reading.LeftTrigger, "rt": reading.RightTrigger },
        "axes": { "lx": reading.LeftThumbstickX, "ly": reading.LeftThumbstickY,
                  "rx": reading.RightThumbstickX, "ry": reading.RightThumbstickY }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Gaming::Input::GamepadButtons;

    #[test]
    fn trigger_holds_survive_pressure_dips_until_release_threshold() {
        let mut triggers = TriggerState::default();
        for (pressure, expected) in [
            (0.0, false),
            (0.6, true),
            (0.5, true),
            (0.6, true),
            (0.41, true),
            (0.4, false),
            (0.5, false),
            (0.55, true),
        ] {
            let value = frame(
                "xbox",
                &GamepadReading {
                    LeftTrigger: pressure,
                    RightTrigger: pressure,
                    ..Default::default()
                },
                &mut triggers,
            );
            assert_eq!(value["buttons"]["lt"], expected, "LT at {pressure}");
            assert_eq!(value["buttons"]["rt"], expected, "RT at {pressure}");
        }
    }

    #[test]
    fn recognizes_controller_families() {
        assert_eq!(family(0x045e, "Controller"), "xbox");
        assert_eq!(family(0x054c, "Wireless Controller"), "playstation");
        assert_eq!(family(0x057e, "Pro Controller"), "nintendo");
        assert_eq!(family(0, "Xbox compatible"), "xbox");
        assert_eq!(family(0, "USB gamepad"), "generic");
    }

    #[test]
    fn preserves_vendor_identity_even_when_the_name_mentions_xbox() {
        assert_eq!(family(0x054c, "Xbox compatible"), "playstation");
        assert_eq!(family(0, "XBOX Wireless Controller"), "xbox");
    }

    #[test]
    fn neutral_reading_releases_all_buttons_and_analog_controls() {
        let value = frame(
            "generic",
            &GamepadReading::default(),
            &mut TriggerState::default(),
        );
        assert!(value["buttons"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == false));
        assert!(value["axes"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == 0.0));
        assert_eq!(value["triggers"]["lt"], 0.0);
        assert_eq!(value["triggers"]["rt"], 0.0);
    }

    #[test]
    fn maps_every_supported_digital_button() {
        let buttons = [
            ("a", GamepadButtons::A),
            ("b", GamepadButtons::B),
            ("x", GamepadButtons::X),
            ("y", GamepadButtons::Y),
            ("lb", GamepadButtons::LeftShoulder),
            ("rb", GamepadButtons::RightShoulder),
            ("view", GamepadButtons::View),
            ("menu", GamepadButtons::Menu),
            ("ls", GamepadButtons::LeftThumbstick),
            ("rs", GamepadButtons::RightThumbstick),
            ("dpadUp", GamepadButtons::DPadUp),
            ("dpadDown", GamepadButtons::DPadDown),
            ("dpadLeft", GamepadButtons::DPadLeft),
            ("dpadRight", GamepadButtons::DPadRight),
        ];
        for (key, button) in buttons {
            let value = frame(
                "xbox",
                &GamepadReading {
                    Buttons: button,
                    ..Default::default()
                },
                &mut TriggerState::default(),
            );
            assert_eq!(value["buttons"][key], true, "{key}");
            assert_eq!(
                value["buttons"]
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
    fn maps_buttons_triggers_and_axes_to_the_existing_protocol() {
        let reading = GamepadReading {
            Buttons: GamepadButtons::A | GamepadButtons::DPadUp | GamepadButtons::RightThumbstick,
            LeftTrigger: 0.8,
            RightTrigger: 0.2,
            LeftThumbstickX: -0.5,
            LeftThumbstickY: 1.0,
            RightThumbstickX: 0.25,
            RightThumbstickY: -1.0,
            ..Default::default()
        };
        let value = frame("xbox", &reading, &mut TriggerState::default());
        assert_eq!(value["kind"], "frame");
        assert_eq!(value["family"], "xbox");
        assert_eq!(value["buttons"]["a"], true);
        assert_eq!(value["buttons"]["b"], false);
        assert_eq!(value["buttons"]["rs"], true);
        assert_eq!(value["buttons"]["dpadUp"], true);
        assert_eq!(value["triggers"]["lt"], 0.8);
        assert_eq!(value["axes"]["ly"], 1.0);
        assert_eq!(value["axes"]["ry"], -1.0);
    }
}
