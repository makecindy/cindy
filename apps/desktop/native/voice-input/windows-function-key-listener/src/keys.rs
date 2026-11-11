//! Physical keyboard-set helpers shared by the hook and startup snapshot.
//!
//! The hook only sees later events. Helper start / restart must seed the same
//! sets from the current physical key state, or an already-held ordinary key
//! looks like "no other keys" and a later F-keydown is treated as a bare press.

pub fn modifier_bit(vk: u32) -> u32 {
    match vk {
        0x10 => 1 << 0,  // VK_SHIFT
        0xA0 => 1 << 1,  // VK_LSHIFT
        0xA1 => 1 << 2,  // VK_RSHIFT
        0x11 => 1 << 3,  // VK_CONTROL
        0xA2 => 1 << 4,  // VK_LCONTROL
        0xA3 => 1 << 5,  // VK_RCONTROL
        0x12 => 1 << 6,  // VK_MENU
        0xA4 => 1 << 7,  // VK_LMENU
        0xA5 => 1 << 8,  // VK_RMENU
        0x5B => 1 << 9,  // VK_LWIN
        0x5C => 1 << 10, // VK_RWIN
        _ => 0,
    }
}

pub fn other_key_slot(vk: u32) -> Option<(usize, u64)> {
    if !is_trackable_other_key(vk) {
        return None;
    }
    Some((vk as usize / 64, 1 << (vk % 64)))
}

pub fn is_trackable_other_key(vk: u32) -> bool {
    vk < 256 && !is_mouse_button(vk) && modifier_bit(vk) == 0
}

pub fn apply_other_key(slots: &mut [u64; 4], vk: u32, down: bool) {
    let Some((index, bit)) = other_key_slot(vk) else {
        return;
    };
    if down {
        slots[index] |= bit;
    } else {
        slots[index] &= !bit;
    }
}

pub fn seed_other_key_slots(target_vk: u32, is_down: impl Fn(u32) -> bool) -> [u64; 4] {
    let mut slots = [0u64; 4];
    for vk in 0u32..256 {
        if vk == target_vk || !is_trackable_other_key(vk) {
            continue;
        }
        if is_down(vk) {
            apply_other_key(&mut slots, vk, true);
        }
    }
    slots
}

pub fn any_slot_down(slots: &[u64; 4]) -> bool {
    slots.iter().any(|slot| *slot != 0)
}

fn is_mouse_button(vk: u32) -> bool {
    matches!(vk, 0x01..=0x06)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_A: u32 = 0x41;
    const VK_F1: u32 = 0x70;
    const VK_F16: u32 = 0x7F;
    const VK_LSHIFT: u32 = 0xA0;
    const VK_LBUTTON: u32 = 0x01;

    #[test]
    fn seed_includes_already_held_ordinary_keys() {
        let slots = seed_other_key_slots(VK_F16, |vk| vk == VK_A);
        assert!(any_slot_down(&slots));
        let mut expected = [0u64; 4];
        apply_other_key(&mut expected, VK_A, true);
        assert_eq!(slots, expected);
    }

    #[test]
    fn seed_ignores_modifiers_mouse_and_the_target_key() {
        let slots =
            seed_other_key_slots(VK_F16, |vk| matches!(vk, VK_LSHIFT | VK_LBUTTON | VK_F16));
        assert!(!any_slot_down(&slots));
    }

    #[test]
    fn seed_tracks_other_function_keys() {
        let slots = seed_other_key_slots(VK_F16, |vk| vk == VK_F1);
        assert!(any_slot_down(&slots));
    }

    #[test]
    fn mouse_buttons_are_not_trackable_other_keys() {
        assert!(other_key_slot(VK_LBUTTON).is_none());
        assert!(other_key_slot(VK_A).is_some());
        assert!(other_key_slot(VK_LSHIFT).is_none());
    }
}
