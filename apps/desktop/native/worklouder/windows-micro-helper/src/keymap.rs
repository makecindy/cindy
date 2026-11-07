//! Keymap occupancy, mirroring the utility host in `protocol.ts`: Cindy replaces the
//! active layer with one `KV_OAI_*` grid so every task key has its own AG thread,
//! snapshots the board before the first rewrite and restores it on release.
use serde_json::{json, Value};

pub const FILE: &str = "keymap.json";
/// Firmware live-reloads after `fs.write`; lighting waits for it like the utility host.
pub const RELOAD_MS: u64 = 2_500;
const BACKUP_ID_MAX: usize = 64;

/// `fs.read` answers with the file text, `{data}` or an already parsed document.
pub fn text(result: &Value) -> Option<String> {
    let text = match result {
        Value::String(text) => text.clone(),
        Value::Object(record) => match record.get("data") {
            Some(Value::String(text)) => text.clone(),
            _ if record.get("profiles").is_some_and(Value::is_array) => result.to_string(),
            _ => return None,
        },
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

pub fn parse(text: &str) -> Option<Value> {
    let document: Value = serde_json::from_str(text).ok()?;
    let first = document.get("profiles")?.as_array()?.first()?;
    (!first.get("layers")?.as_array()?.is_empty()).then_some(document)
}

/// `device.status` profile is 0-based and layer 1-based; both clamp to the document.
pub fn active_layer(document: &Value, status: &Value) -> (usize, usize) {
    let profiles = document["profiles"].as_array().map_or(0, Vec::len);
    let profile = status["profile_index"]
        .as_u64()
        .map_or(0, |index| index as usize)
        .min(profiles.saturating_sub(1));
    let layers = document["profiles"][profile]["layers"]
        .as_array()
        .map_or(0, Vec::len);
    let layer = status["layer_index"]
        .as_u64()
        .filter(|index| *index >= 1)
        .map_or(0, |index| index as usize - 1)
        .min(layers.saturating_sub(1));
    (profile, layer)
}

/// A full `KV_OAI_*` grid that includes AG00 is Cindy's own occupancy, not a user layout.
pub fn is_cindy_layer(layer: &Value) -> bool {
    let codes: Vec<&str> = layer["layout"]["keymap"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    codes.len() >= 8
        && codes.iter().all(|code| code.starts_with("KV_OAI_"))
        && codes.iter().any(|code| code.contains("AG00"))
}

pub fn is_cindy_keymap(text: &str, profile: usize, layer: usize) -> bool {
    parse(text)
        .is_some_and(|document| is_cindy_layer(&document["profiles"][profile]["layers"][layer]))
}

#[derive(Debug, PartialEq)]
pub enum Bind {
    /// The active layer already carries this grid.
    AlreadyBound,
    /// No such layer; leave the board alone.
    Unchanged,
    /// Write this document.
    Write(String),
}

pub fn bind(document: &Value, profile: usize, layer: usize, keymap: &Value) -> Bind {
    let Some(original) = document["profiles"][profile]["layers"].get(layer) else {
        return Bind::Unchanged;
    };
    let encoders = json!([["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]]);
    if original["layout"]["keymap"] == *keymap && original["layout"]["encoders"] == encoders {
        return Bind::AlreadyBound;
    }
    let mut next = document.clone();
    let target = &mut next["profiles"][profile]["layers"][layer];
    if !target["id"].is_number() {
        target["id"] = json!(layer);
    }
    if !target["layout"].is_object() {
        target["layout"] = json!({});
    }
    let layout = &mut target["layout"];
    layout["encoders"] = encoders;
    layout["buttons"] = json!([]);
    layout["keymap"] = keymap.clone();
    layout["joystick"] = json!({"type": "VENDOR", "sectors": []});
    Bind::Write(next.to_string())
}

/// Same names as the utility host's Codex Micro backups, so both hosts restore one snapshot.
pub fn backup_files(serial: Option<&str>) -> (String, String) {
    let serial = serial.map(str::trim).unwrap_or_default();
    let raw = if serial.is_empty() {
        "codex-micro".to_owned()
    } else {
        format!("codex-micro-{serial}")
    };
    // Same as `replace(/[^A-Za-z0-9._-]+/g, '-')`: each run of other chars becomes one dash.
    let mut id = String::new();
    let mut replacing = false;
    for char in raw.chars() {
        if char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-') {
            id.push(char);
            replacing = false;
        } else if !replacing {
            id.push('-');
            replacing = true;
        }
    }
    let id: String = id.trim_matches('-').chars().take(BACKUP_ID_MAX).collect();
    (
        format!("keymap-backup-{id}.json"),
        format!("keymap-session-{id}.json"),
    )
}

/// Whether to snapshot the live document before rewriting it. A snapshot still on disk
/// belongs to an occupancy that was never released, so it is kept when the layer already
/// looks like Cindy's grid. Codex Micro's factory layer looks the same, so without a
/// leftover snapshot the live document is the layout to hand back.
pub fn should_save_session(live_layer_is_cindy: bool, session_exists: bool) -> bool {
    !live_layer_is_cindy || !session_exists
}

/// A layer of `KV_OAI_*` codes, as the main process sends it.
pub fn requested(value: &Value) -> Option<Value> {
    let rows = value.as_array().filter(|rows| !rows.is_empty())?;
    let valid = rows.iter().all(|row| {
        row.as_array().is_some_and(|codes| {
            codes.iter().all(|code| {
                code.as_str()
                    .is_some_and(|code| code.starts_with("KV_OAI_") && code.len() <= 32)
            })
        })
    });
    valid.then(|| value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(keymap: Value) -> Value {
        json!({"version":1,"profiles":[{"id":0,"layers":[
            {"id":0,"name":"Layer 1","layout":{"keymap":keymap,
                "encoders":[["KV_OAI_ENC_CC","KV_OAI_ENC_CW","KV_OAI_ENC_CLK"]],
                "joystick":{"type":"VENDOR","sectors":[]},"buttons":[]},
             "lights":{"backlight":{"effect":"solid"}}},
            {"id":1,"name":"Layer 2","layout":{"keymap":[["KC_A","KC_B"]]}}
        ]}]})
    }
    fn factory() -> Value {
        json!([
            ["KV_OAI_AG00", "KV_OAI_AG01"],
            ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
            [
                "KV_OAI_ACT06",
                "KV_OAI_ACT07",
                "KV_OAI_ACT08",
                "KV_OAI_ACT09"
            ],
            ["KV_OAI_ACT10", "KV_OAI_ACT11", "KV_OAI_ACT12"]
        ])
    }
    fn all_tasks() -> Value {
        json!([
            ["KV_OAI_AG00", "KV_OAI_AG01"],
            ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
            ["KV_OAI_AG06", "KV_OAI_AG07", "KV_OAI_AG08", "KV_OAI_AG09"],
            ["KV_OAI_AG10", "KV_OAI_AG11", "KV_OAI_AG12"]
        ])
    }

    #[test]
    fn rewrites_only_the_active_layer_and_keeps_its_other_fields() {
        let live = document(factory());
        let Bind::Write(text) = bind(&live, 0, 0, &all_tasks()) else {
            panic!("expected a rewrite");
        };
        let next: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            next["profiles"][0]["layers"][0]["layout"]["keymap"],
            all_tasks()
        );
        assert_eq!(
            next["profiles"][0]["layers"][0]["lights"],
            live["profiles"][0]["layers"][0]["lights"]
        );
        assert_eq!(
            next["profiles"][0]["layers"][1],
            live["profiles"][0]["layers"][1]
        );
        assert_eq!(bind(&next, 0, 0, &all_tasks()), Bind::AlreadyBound);
        assert_eq!(bind(&live, 0, 5, &all_tasks()), Bind::Unchanged);
    }

    #[test]
    fn rewrites_a_user_layer_into_the_full_agent_layout() {
        let live = document(factory());
        let Bind::Write(text) = bind(&live, 0, 1, &factory()) else {
            panic!("expected a rewrite");
        };
        let layer = &serde_json::from_str::<Value>(&text).unwrap()["profiles"][0]["layers"][1];
        assert_eq!(
            layer["layout"]["joystick"],
            json!({"type":"VENDOR","sectors":[]})
        );
        assert_eq!(layer["layout"]["buttons"], json!([]));
        assert!(is_cindy_layer(layer));
    }

    #[test]
    fn treats_only_full_agent_grids_as_cindy_occupancy() {
        assert!(is_cindy_keymap(&document(factory()).to_string(), 0, 0));
        assert!(!is_cindy_keymap(&document(factory()).to_string(), 0, 1));
        let mixed = document(json!([
            ["KV_OAI_AG00", "KC_A"],
            ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
            ["KV_OAI_ACT06", "KV_OAI_ACT07"]
        ]));
        assert!(!is_cindy_keymap(&mixed.to_string(), 0, 0));
    }

    #[test]
    fn resolves_the_active_layer_from_device_status() {
        let live = document(factory());
        assert_eq!(
            active_layer(&live, &json!({"profile_index":0,"layer_index":2})),
            (0, 1)
        );
        assert_eq!(
            active_layer(&live, &json!({"profile_index":4,"layer_index":9})),
            (0, 1)
        );
        assert_eq!(active_layer(&live, &json!({})), (0, 0));
        assert_eq!(active_layer(&live, &json!({"layer_index":0})), (0, 0));
    }

    #[test]
    fn reads_keymap_text_from_every_fs_read_shape() {
        let raw = document(factory()).to_string();
        assert_eq!(text(&json!(raw)), Some(raw.clone()));
        assert_eq!(text(&json!({"data": raw})), Some(raw.clone()));
        assert!(text(&document(factory())).is_some());
        assert_eq!(text(&json!({"data": "  "})), None);
        assert_eq!(text(&json!(null)), None);
        assert!(parse("{\"profiles\":[]}").is_none());
        assert!(parse(&raw).is_some());
    }

    #[test]
    fn names_backups_like_the_utility_host_codex_micro_snapshots() {
        assert_eq!(
            backup_files(Some(" AB:12/34 ")),
            (
                "keymap-backup-codex-micro-AB-12-34.json".into(),
                "keymap-session-codex-micro-AB-12-34.json".into()
            )
        );
        assert_eq!(
            backup_files(Some("a-/b")).0,
            "keymap-backup-codex-micro-a--b.json"
        );
        assert_eq!(backup_files(None).0, "keymap-backup-codex-micro.json");
        assert_eq!(backup_files(Some("")).1, "keymap-session-codex-micro.json");
    }

    #[test]
    fn keeps_a_leftover_snapshot_but_saves_the_factory_layout_when_none_exists() {
        assert!(should_save_session(false, true));
        assert!(should_save_session(false, false));
        assert!(should_save_session(true, false));
        assert!(!should_save_session(true, true));
    }

    #[test]
    fn accepts_only_agent_keycode_grids_from_main() {
        assert_eq!(requested(&all_tasks()), Some(all_tasks()));
        assert!(requested(&json!([])).is_none());
        assert!(requested(&json!([["KC_A"]])).is_none());
        assert!(requested(&json!([["KV_OAI_AG00", 1]])).is_none());
        assert!(requested(&json!("KV_OAI_AG00")).is_none());
    }
}
