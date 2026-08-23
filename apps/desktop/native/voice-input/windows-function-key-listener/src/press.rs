//! One owner for a single physical target-key press.
//!
//! Hold-lock and swallow are different jobs:
//! - any non-idle press stays locked until the real key-up, so auto-repeat
//!   cannot `start` after other keys are released;
//! - swallow only happens after Cindy claimed the key-down (`Active` /
//!   `Canceled`). A rejected press, including its auto-repeats, stays with
//!   the foreground app.

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetPress {
    Idle = 0,
    Rejected = 1,
    Active = 2,
    Canceled = 3,
}

impl TargetPress {
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Rejected,
            2 => Self::Active,
            3 => Self::Canceled,
            _ => Self::Idle,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeydownEffect {
    pub next: TargetPress,
    pub swallow: bool,
    pub emit_pressed: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForeignKeydownEffect {
    pub next: TargetPress,
    pub emit_canceled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyupEffect {
    pub next: TargetPress,
    pub swallow: bool,
    pub emit_pressed: Option<bool>,
}

pub fn on_target_keydown(current: TargetPress, exact_chord: bool) -> KeydownEffect {
    match current {
        TargetPress::Idle if exact_chord => KeydownEffect {
            next: TargetPress::Active,
            swallow: true,
            emit_pressed: Some(true),
        },
        TargetPress::Idle => KeydownEffect {
            next: TargetPress::Rejected,
            swallow: false,
            emit_pressed: None,
        },
        TargetPress::Rejected => KeydownEffect {
            next: TargetPress::Rejected,
            swallow: false,
            emit_pressed: None,
        },
        TargetPress::Active => KeydownEffect {
            next: TargetPress::Active,
            swallow: true,
            emit_pressed: None,
        },
        TargetPress::Canceled => KeydownEffect {
            next: TargetPress::Canceled,
            swallow: true,
            emit_pressed: None,
        },
    }
}

pub fn on_foreign_keydown(current: TargetPress) -> ForeignKeydownEffect {
    match current {
        TargetPress::Active => ForeignKeydownEffect {
            next: TargetPress::Canceled,
            emit_canceled: true,
        },
        other => ForeignKeydownEffect {
            next: other,
            emit_canceled: false,
        },
    }
}

pub fn initial_target_press(target_already_down: bool) -> TargetPress {
    if target_already_down {
        TargetPress::Rejected
    } else {
        TargetPress::Idle
    }
}

pub fn on_target_keyup(current: TargetPress) -> KeyupEffect {
    match current {
        TargetPress::Idle => KeyupEffect {
            next: TargetPress::Idle,
            swallow: false,
            emit_pressed: None,
        },
        TargetPress::Rejected => KeyupEffect {
            next: TargetPress::Idle,
            swallow: false,
            emit_pressed: Some(false),
        },
        TargetPress::Active | TargetPress::Canceled => KeyupEffect {
            next: TargetPress::Idle,
            swallow: true,
            emit_pressed: Some(false),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_with_target_already_down_is_rejected_not_idle() {
        assert_eq!(initial_target_press(false), TargetPress::Idle);
        assert_eq!(initial_target_press(true), TargetPress::Rejected);
        let repeat = on_target_keydown(initial_target_press(true), true);
        assert_eq!(repeat.next, TargetPress::Rejected);
        assert!(!repeat.swallow);
        assert_eq!(repeat.emit_pressed, None);
    }

    #[test]
    fn from_u8_round_trips_known_states() {
        assert_eq!(TargetPress::from_u8(0), TargetPress::Idle);
        assert_eq!(TargetPress::from_u8(1), TargetPress::Rejected);
        assert_eq!(TargetPress::from_u8(2), TargetPress::Active);
        assert_eq!(TargetPress::from_u8(3), TargetPress::Canceled);
        assert_eq!(TargetPress::from_u8(99), TargetPress::Idle);
    }

    #[test]
    fn idle_exact_chord_claims_and_swallows() {
        let effect = on_target_keydown(TargetPress::Idle, true);
        assert_eq!(
            effect,
            KeydownEffect {
                next: TargetPress::Active,
                swallow: true,
                emit_pressed: Some(true),
            }
        );
    }

    #[test]
    fn idle_mismatch_rejects_without_swallowing() {
        let effect = on_target_keydown(TargetPress::Idle, false);
        assert_eq!(
            effect,
            KeydownEffect {
                next: TargetPress::Rejected,
                swallow: false,
                emit_pressed: None,
            }
        );
    }

    #[test]
    fn rejected_repeats_never_start_and_are_not_swallowed() {
        for exact_chord in [false, true] {
            let effect = on_target_keydown(TargetPress::Rejected, exact_chord);
            assert_eq!(
                effect,
                KeydownEffect {
                    next: TargetPress::Rejected,
                    swallow: false,
                    emit_pressed: None,
                },
                "exact_chord={exact_chord}"
            );
        }
    }

    #[test]
    fn claimed_repeats_stay_swallowed_without_restarting() {
        assert!(on_target_keydown(TargetPress::Active, true).swallow);
        assert_eq!(
            on_target_keydown(TargetPress::Canceled, true).emit_pressed,
            None
        );
        assert_eq!(
            on_target_keydown(TargetPress::Active, true).next,
            TargetPress::Active
        );
        assert_eq!(
            on_target_keydown(TargetPress::Canceled, false).next,
            TargetPress::Canceled
        );
    }

    #[test]
    fn foreign_keydown_cancels_only_an_active_press() {
        assert_eq!(
            on_foreign_keydown(TargetPress::Active),
            ForeignKeydownEffect {
                next: TargetPress::Canceled,
                emit_canceled: true,
            }
        );
        assert_eq!(
            on_foreign_keydown(TargetPress::Rejected),
            ForeignKeydownEffect {
                next: TargetPress::Rejected,
                emit_canceled: false,
            }
        );
        assert!(!on_foreign_keydown(TargetPress::Canceled).emit_canceled);
    }

    #[test]
    fn rejected_press_then_other_key_release_then_repeat_stays_passthrough() {
        let mut state = TargetPress::Idle;
        let first = on_target_keydown(state, false);
        state = first.next;
        assert!(!first.swallow);
        assert_eq!(first.emit_pressed, None);

        let after_other_release = on_target_keydown(state, true);
        assert_eq!(after_other_release.next, TargetPress::Rejected);
        assert!(!after_other_release.swallow);
        assert_eq!(after_other_release.emit_pressed, None);

        let release = on_target_keyup(after_other_release.next);
        assert!(!release.swallow);
        assert_eq!(release.emit_pressed, Some(false));
        assert_eq!(release.next, TargetPress::Idle);
    }

    #[test]
    fn claimed_then_canceled_repeats_stay_swallowed() {
        let mut state = on_target_keydown(TargetPress::Idle, true).next;
        state = on_foreign_keydown(state).next;
        assert_eq!(state, TargetPress::Canceled);
        let repeat = on_target_keydown(state, true);
        assert!(repeat.swallow);
        assert_eq!(repeat.emit_pressed, None);
        let release = on_target_keyup(repeat.next);
        assert!(release.swallow);
        assert_eq!(release.emit_pressed, Some(false));
    }

    #[test]
    fn keyup_notifies_typescript_and_swallows_only_claimed_presses() {
        assert_eq!(
            on_target_keyup(TargetPress::Rejected),
            KeyupEffect {
                next: TargetPress::Idle,
                swallow: false,
                emit_pressed: Some(false),
            }
        );
        assert!(on_target_keyup(TargetPress::Active).swallow);
        assert_eq!(
            on_target_keyup(TargetPress::Canceled),
            KeyupEffect {
                next: TargetPress::Idle,
                swallow: true,
                emit_pressed: Some(false),
            }
        );
        assert_eq!(on_target_keyup(TargetPress::Idle).emit_pressed, None);
    }
}
