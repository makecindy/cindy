use serde_json::{json, Value};

pub fn matches(vendor: u16, product: u16, page: u16, usage: u16) -> bool {
    (vendor, product, page, usage) == (0x303a, 0x8360, 0xff00, 1)
}
/// Public Codex-compatible framing: report 6, message type 2, up to 61 UTF-8 bytes.
pub fn encode(message: &Value) -> Vec<[u8; 64]> {
    let text = format!("{message}\n");
    text.as_bytes()
        .chunks(61)
        .map(|chunk| {
            let mut report = [0; 64];
            report[..3].copy_from_slice(&[6, 2, chunk.len() as u8]);
            report[3..3 + chunk.len()].copy_from_slice(chunk);
            report
        })
        .collect()
}
#[derive(Default)]
pub struct Decoder {
    bytes: Vec<u8>,
}
impl Decoder {
    pub fn feed(&mut self, report: &[u8]) -> Result<Vec<Value>, &'static str> {
        if report.len() != 64 || report[0] != 6 || report[1] != 2 || report[2] > 61 {
            self.bytes.clear();
            return Err("invalid Micro report");
        }
        self.bytes
            .extend_from_slice(&report[3..3 + report[2] as usize]);
        if self.bytes.len() > 16_384 {
            self.bytes.clear();
            return Err("Micro message too large");
        }
        let mut stream = serde_json::Deserializer::from_slice(&self.bytes).into_iter::<Value>();
        let mut messages = Vec::new();
        for value in stream.by_ref() {
            match value {
                Ok(value) if value.is_object() => messages.push(value),
                Err(error) if error.is_eof() => break,
                _ => {
                    self.bytes.clear();
                    return Err("invalid Micro JSON");
                }
            }
        }
        let consumed = stream.byte_offset();
        self.bytes.drain(..consumed);
        Ok(messages)
    }
}
pub fn input(message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str);
    let params = if matches!(method, Some("v.oai.hid" | "v.oai.rad")) {
        &message["params"]
    } else if message.get("method").is_none() && message.get("id").is_none() {
        message
    } else {
        return None;
    };
    let hid_key = params
        .get("key")
        .and_then(Value::as_str)
        .or_else(|| params.get("k").and_then(Value::as_str));
    if method == Some("v.oai.rad") || (method.is_none() && hid_key.is_none()) {
        let angle = params.get("a").or_else(|| params.get("angle"))?.as_f64()?;
        let distance = params
            .get("d")
            .or_else(|| params.get("distance"))?
            .as_f64()?;
        if !angle.is_finite()
            || !distance.is_finite()
            || !(0.0..=1.0).contains(&angle)
            || !(0.0..=1.0).contains(&distance)
        {
            return None;
        }
        return Some(json!({"kind":"joystick","event":{"angle":angle,"distance":distance}}));
    }
    let key = hid_key?;
    if key.is_empty() || key.len() > 32 {
        return None;
    }
    // Match parseWorkLouderCodexHidAct: omitted/null means press; only exact
    // numeric strings are accepted (no boolean or arbitrary string coercion).
    let act = match params.get("act") {
        None | Some(Value::Null) => 1,
        Some(Value::String(value)) => match value.as_str() {
            "0" => 0,
            "1" => 1,
            "2" => 2,
            _ => return None,
        },
        Some(Value::Number(value)) => match value.as_f64()? {
            0.0 => 0,
            1.0 => 1,
            2.0 => 2,
            _ => return None,
        },
        _ => return None,
    };
    let valid = [
        "AG00", "AG01", "AG02", "AG03", "AG04", "AG05", "AG06", "AG07", "AG08", "AG09", "AG10",
        "AG11", "AG12", "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12", "ENC",
        "ENC_CW", "ENC_CC",
    ]
    .contains(&key)
        || key.strip_prefix("ENC").is_some_and(|suffix| {
            suffix
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        });
    if !valid {
        return None;
    }
    Some(json!({"kind":"hid", "event":{"key":key,"act":act}}))
}

fn light(side: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for (long, short) in [
        ("color", "c"),
        ("brightness", "b"),
        ("effect", "e"),
        ("speed", "s"),
        ("magic", "m"),
        ("id", "id"),
    ] {
        if let Some(value) = side.get(long) {
            result.insert(short.into(), value.clone());
        }
    }
    for (long, short) in [("syncKeysLighting", "sk"), ("syncAmbientLighting", "sa")] {
        if let Some(value) = side.get(long).and_then(Value::as_bool) {
            result.insert(short.into(), json!(u8::from(value)));
        }
    }
    Value::Object(result)
}

pub fn lighting(frame: &Value) -> [Value; 2] {
    let threads: Vec<Value> = frame["threads"]
        .as_array()
        .map(|items| items.iter().take(6).map(light).collect())
        .unwrap_or_default();
    [
        json!({"method":"v.oai.rgbcfg","params":{"ambient":light(&frame["ambient"]),"keys":light(&frame["keys"])}}),
        json!({"method":"v.oai.thstatus","params":threads}),
    ]
}

pub fn off_frame() -> Value {
    let side = json!({"color":0,"brightness":0,"effect":0,"speed":0,"magic":0});
    let threads: Vec<Value> = (0..6).map(|id| json!({"id":id,"color":0,"brightness":0,"effect":0,"speed":0,"syncKeysLighting":false,"syncAmbientLighting":false})).collect();
    json!({"keys":side,"ambient":side,"threads":threads})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_legacy_act_defaults_and_exact_numeric_strings() {
        for (act, expected) in [
            (Value::Null, 1),
            (json!("0"), 0),
            (json!("1"), 1),
            (json!("2"), 2),
            (json!(1.0), 1),
        ] {
            assert_eq!(
                input(&json!({"k":"AG06","act":act})),
                Some(json!({"kind":"hid","event":{"key":"AG06","act":expected}}))
            );
            assert_eq!(
                input(&json!({"method":"v.oai.hid","params":{"k":"AG06","act":act}})),
                Some(json!({"kind":"hid","event":{"key":"AG06","act":expected}}))
            );
        }
        assert_eq!(
            input(&json!({"k":"AG00"})),
            Some(json!({"kind":"hid","event":{"key":"AG00","act":1}}))
        );
        for act in [
            json!(false),
            json!(3),
            json!(-1),
            json!(0.5),
            json!("1.0"),
            json!("true"),
        ] {
            assert!(input(&json!({"k":"AG00","act":act})).is_none());
        }
    }
    #[test]
    fn preserves_the_host_key_alias_and_encoder_acceptance_contract() {
        assert_eq!(
            input(&json!({"key":"AG12","act":"1"})),
            Some(json!({"kind":"hid","event":{"key":"AG12","act":1}}))
        );
        assert_eq!(
            input(&json!({"k":"ENC_TOUCH","act":0})),
            Some(json!({"kind":"hid","event":{"key":"ENC_TOUCH","act":0}}))
        );
        assert!(input(&json!({"k":"ENC-bad","act":1})).is_none());
    }
    #[test]
    fn preserves_all_legacy_agent_keys_in_bare_and_wrapped_notifications() {
        for slot in 0..=12 {
            let key = format!("AG{slot:02}");
            for act in [0, 1] {
                let expected = Some(json!({"kind":"hid","event":{"key":key,"act":act}}));
                assert_eq!(input(&json!({"k":key,"act":act})), expected);
                assert_eq!(
                    input(&json!({"method":"v.oai.hid","params":{"k":key,"act":act}})),
                    expected
                );
            }
        }
        for key in ["AG13", "AG99", "AG6", "AG-1"] {
            assert!(input(&json!({"k":key,"act":1})).is_none());
        }
    }
    #[test]
    fn forwards_joystick_directions_and_center_in_both_notify_formats() {
        for (angle, distance) in [(0.0, 1.0), (0.25, 1.0), (0.5, 0.7), (0.75, 0.5), (1.0, 0.0)] {
            let expected =
                Some(json!({"kind":"joystick","event":{"angle":angle,"distance":distance}}));
            assert_eq!(
                input(&json!({"method":"v.oai.rad","params":{"a":angle,"d":distance}})),
                expected
            );
            assert_eq!(input(&json!({"a":angle,"d":distance})), expected);
        }
    }
    #[test]
    fn rejects_invalid_joysticks_and_does_not_treat_rpc_replies_as_input() {
        for value in [
            json!({"a":-0.1,"d":0.5}),
            json!({"a":1.1,"d":0.5}),
            json!({"a":0.1,"d":-0.1}),
            json!({"a":0.1,"d":1.1}),
            json!({"a":"0.1","d":0.5}),
            json!({"a":0.5}),
            json!({"id":1,"result":{"a":0.1,"d":0.2}}),
        ] {
            assert!(input(&value).is_none());
        }
    }
    #[test]
    fn selects_only_micro_primary_collection_without_usb_interface_assumptions() {
        assert!(matches(0x303a, 0x8360, 0xff00, 1));
        assert!(!matches(0x303a, 0x8360, 0xff70, 1));
        assert!(!matches(0x303a, 0x8360, 1, 6));
        assert!(!matches(0x303a, 0x9999, 0xff00, 1));
    }
    #[test]
    fn round_trips_fragmented_unicode_json_in_64_byte_reports() {
        let value = json!({"method":"device.status", "id":1, "params":"测试".repeat(40)});
        let reports = encode(&value);
        assert!(reports.len() > 1);
        let mut decoder = Decoder::default();
        let mut values = Vec::new();
        for report in reports {
            assert_eq!(&report[..2], &[6, 2]);
            assert!(report[2] <= 61);
            values.extend(decoder.feed(&report).unwrap());
        }
        assert_eq!(values, vec![value]);
    }
    #[test]
    fn rejects_companion_and_oversized_reports_and_recovers() {
        let mut decoder = Decoder::default();
        assert!(decoder.feed(&[7; 64]).is_err());
        let mut bad = [0; 64];
        bad[0] = 6;
        bad[1] = 2;
        bad[2] = 62;
        assert!(decoder.feed(&bad).is_err());
        let valid = json!({"id":1,"result":{}});
        assert_eq!(decoder.feed(&encode(&valid)[0]).unwrap(), vec![valid]);
    }
    #[test]
    fn bounds_unfinished_json_and_accepts_the_next_message_after_overflow() {
        let mut decoder = Decoder::default();
        let mut report = [b' '; 64];
        report[..3].copy_from_slice(&[6, 2, 61]);
        report[3] = b'{';
        assert!(decoder.feed(&report).unwrap().is_empty());
        report[3] = b' ';
        let mut overflow = false;
        for _ in 0..300 {
            if decoder.feed(&report).is_err() {
                overflow = true;
                break;
            }
        }
        assert!(overflow);
        let valid = json!({"id":2,"result":{}});
        assert_eq!(decoder.feed(&encode(&valid)[0]).unwrap(), vec![valid]);
    }
    #[test]
    fn translates_notifications_but_not_rpc_results_or_unknown_keys() {
        assert_eq!(
            input(&json!({"method":"v.oai.hid","params":{"k":"AG00","act":1}})),
            Some(json!({"kind":"hid","event":{"key":"AG00","act":1}}))
        );
        assert_eq!(
            input(&json!({"k":"ENC_CW","act":2})),
            Some(json!({"kind":"hid","event":{"key":"ENC_CW","act":2}}))
        );
        assert!(input(&json!({"method":"v.oai.hid","params":{"k":"AG99","act":1}})).is_none());
        assert!(input(&json!({"id":1,"result":{"k":"AG00","act":1}})).is_none());
    }
    #[test]
    fn translates_lighting_field_names_and_boolean_sync_flags() {
        let [rgb, threads] = lighting(&json!({"ambient":{"color":123,"brightness":0.3},
            "keys":{"effect":1}, "threads":[{"id":0,"color":456,"syncKeysLighting":true,"syncAmbientLighting":false}]}));
        assert_eq!(rgb["method"], "v.oai.rgbcfg");
        assert_eq!(rgb["params"]["ambient"]["c"], 123);
        assert_eq!(threads["method"], "v.oai.thstatus");
        assert_eq!(threads["params"][0]["sk"], 1);
        assert_eq!(threads["params"][0]["sa"], 0);
    }
    #[test]
    fn disables_both_zones_and_all_six_slots_on_release() {
        let [rgb, threads] = lighting(&off_frame());
        assert_eq!(rgb["params"]["ambient"]["b"], 0);
        assert_eq!(rgb["params"]["keys"]["e"], 0);
        assert_eq!(threads["params"].as_array().unwrap().len(), 6);
        assert!(threads["params"]
            .as_array()
            .unwrap()
            .iter()
            .all(|slot| slot["b"] == 0 && slot["e"] == 0));
    }
}
