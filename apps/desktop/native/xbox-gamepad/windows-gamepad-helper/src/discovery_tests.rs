use super::*;
#[test]
fn lifecycle_messages_match_the_host_controller_contract_fixture() {
    #[derive(Clone)]
    struct FixtureDevice {
        handle: String,
        id: String,
        name: String,
        triggers: mapping::TriggerState,
    }
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../../../src/main/xbox-gamepad/__tests__/fixtures/windowsLifecycle.json"
    ))
    .unwrap();
    // JavaScript JSON has one number type; native axes/triggers are f64.
    // Normalize only these declared numeric fields, not arbitrary payloads.
    for frame in fixture["frames"].as_object_mut().unwrap().values_mut() {
        for group in ["axes", "triggers"] {
            for number in frame[group].as_object_mut().unwrap().values_mut() {
                *number = json!(number.as_f64().unwrap());
            }
        }
    }
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let mut current: BTreeMap<&'static str, FixtureDevice> = BTreeMap::new();
        for step in scenario["steps"].as_array().unwrap() {
            for _ in 0..step["repeat"].as_u64().unwrap_or(1) {
                let messages = match step["kind"].as_str().unwrap() {
                    "snapshot" => {
                        let preferred = current
                            .iter()
                            .map(|(&family, device)| (family, device.id.clone()))
                            .collect();
                        let candidates = step["devices"].as_array().unwrap().iter().map(|record| {
                            let handle = record["handle"].as_str().unwrap();
                            let existing = current
                                .iter()
                                .find(|(_, device)| device.handle == handle)
                                .map(|(&family, device)| (family, device));
                            reuse_live_device(existing, || {
                                if record["metadataOk"] == false {
                                    return Err("metadata unavailable");
                                }
                                Ok((
                                    "xbox",
                                    FixtureDevice {
                                        handle: handle.into(),
                                        id: record["id"].as_str().unwrap().into(),
                                        name: record["name"].as_str().unwrap().into(),
                                        triggers: mapping::TriggerState::default(),
                                    },
                                ))
                            })
                        });
                        let next =
                            select_devices(candidates, &preferred, |device| device.id.as_str());
                        let messages = snapshot_messages(
                            "xbox",
                            current
                                .get("xbox")
                                .map(|d| (d.id.as_str(), d.name.as_str())),
                            next.get("xbox").map(|d| (d.id.as_str(), d.name.as_str())),
                            step["force"].as_bool().unwrap_or(false),
                        );
                        current = next;
                        messages
                    }
                    "frame" => {
                        let reading = &fixture["readings"][step["frame"].as_str().unwrap()];
                        let reading = windows::Gaming::Input::GamepadReading {
                            LeftTrigger: reading["lt"].as_f64().unwrap(),
                            RightThumbstickY: reading["ry"].as_f64().unwrap(),
                            ..Default::default()
                        };
                        vec![mapping::frame(
                            "xbox",
                            &reading,
                            &mut current.get_mut("xbox").unwrap().triggers,
                        )]
                    }
                    "read-error" => {
                        current.remove("xbox");
                        vec![presence_message("xbox", None)]
                    }
                    other => panic!("unknown fixture step {other}"),
                };
                let expected: Vec<Value> = step["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| match m.as_str() {
                        Some(key) => fixture["frames"][key].clone(),
                        None => m.clone(),
                    })
                    .collect();
                assert_eq!(
                    messages, expected,
                    "scenario: {}, step: {}",
                    scenario["name"], step["kind"]
                );
                assert_eq!(
                    current.get("xbox").map(|d| d.name.as_str()),
                    step["expect"]["name"].as_str()
                );
            }
        }
    }
}
#[test]
fn a_selected_live_handle_does_not_depend_on_fallible_metadata_refresh() {
    let old = "selected".to_string();
    let candidate = reuse_live_device(Some(("xbox", &old)), || Err("transient metadata error"));
    let selected = select_devices(
        [Ok(("xbox", "other".to_string())), candidate],
        &BTreeMap::from([("xbox", old.clone())]),
        |id| id.as_str(),
    );
    assert_eq!(selected.get("xbox"), Some(&old));
}
#[test]
fn disappeared_handles_are_not_retained_by_cached_metadata() {
    let preferred = BTreeMap::from([("xbox", "removed".to_string())]);
    let candidate: std::result::Result<_, &str> =
        reuse_live_device(None, || Ok(("xbox", "replacement".to_string())));
    let selected = select_devices([candidate], &preferred, |id| id.as_str());
    assert_eq!(
        selected.get("xbox").map(String::as_str),
        Some("replacement")
    );
    let absent: Vec<std::result::Result<(&'static str, String), &str>> = Vec::new();
    assert!(select_devices(absent, &preferred, |id| id.as_str()).is_empty());
}
#[test]
fn a_failed_device_probe_does_not_drop_healthy_devices() {
    let candidates = [
        Err("conversion failed"),
        Ok(("xbox", "first".to_string())),
        Err("property read failed"),
        Ok(("xbox", "selected".to_string())),
        Ok(("generic", "other".to_string())),
    ];
    let preferred = BTreeMap::from([("xbox", "selected".to_string())]);
    let selected = select_devices(candidates, &preferred, |id| id.as_str());
    assert_eq!(
        selected,
        BTreeMap::from([
            ("xbox", "selected".to_string()),
            ("generic", "other".to_string())
        ])
    );
}
#[test]
fn all_failed_probes_leave_an_empty_snapshot_without_terminating_the_host() {
    let candidates: [std::result::Result<(&'static str, String), &str>; 2] =
        [Err("removed"), Err("unreadable")];
    let selected = select_devices(candidates, &BTreeMap::new(), |id| id.as_str());
    assert!(selected.is_empty());
}
