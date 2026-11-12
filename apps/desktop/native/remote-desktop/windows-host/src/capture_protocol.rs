//! Local broker framing only. Remote viewers keep the existing cursorOverlay wire format.
pub const OVERLAY_RESPONSE_LIMIT: usize = 1_750_000;

pub fn response_limit(init: &serde_json::Value) -> usize {
    if init["mode"] == "capture" && init["cursorOverlay"] == true {
        OVERLAY_RESPONSE_LIMIT
    } else {
        240001
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_explicit_capture_overlay_gets_the_larger_frame_budget() {
        for init in [
            json!({}),
            json!({"mode":"capture"}),
            json!({"mode":"capture", "cursorOverlay":false}),
            json!({"mode":"capture", "cursorOverlay":"true"}),
            json!({"mode":"input", "cursorOverlay":true}),
        ] {
            assert_eq!(response_limit(&init), 240001);
        }
        assert_eq!(
            response_limit(&json!({"mode":"capture", "cursorOverlay":true})),
            OVERLAY_RESPONSE_LIMIT
        );
    }
}
