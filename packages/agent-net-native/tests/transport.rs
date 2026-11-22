//! Native host integration: real UDP, Noise IK, independent keys and revocation.
//! The core's simulator already exercises packet loss; these tests exercise
//! host crypto and per-handle IO, which the simulator does not load.
use std::{thread::sleep, time::{Duration, Instant}};
use cindy_agent_net_native::{NativeEngine, create};
use serde_json::{Value, json};

fn engine(seed: u8, id: &str) -> NativeEngine {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    create(&json!({"seed":URL_SAFE_NO_PAD.encode([seed;32]),"context":"native-host-unit",
        "deviceId":id})).unwrap()
}
fn command(engine: &mut NativeEngine, value: Value) -> Value { engine.command(&value).unwrap() }
fn until(a: &mut NativeEngine, b: &mut NativeEngine, mut condition: impl FnMut(&Value, &Value) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let pa = command(a, json!({"op":"poll"}));
        let pb = command(b, json!({"op":"poll"}));
        if condition(&pa, &pb) { return; }
        assert!(Instant::now() < deadline, "native transport deadline");
        sleep(Duration::from_millis(1));
    }
}

#[test]
fn independent_native_handles_exchange_udp_streams_and_revoke_without_restart() {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut a = engine(7, "native-a");
    let mut b = engine(9, "native-b");
    let ia = command(&mut a, json!({"op":"identity"}));
    let ib = command(&mut b, json!({"op":"identity"}));
    assert_ne!(ia["transportKey"], ib["transportKey"]);
    command(&mut a, json!({"op":"admit","peers":[{"key":ib["transportKey"],"link":1}]}));
    command(&mut b, json!({"op":"admit","peers":[{"key":ia["transportKey"],"link":1}]}));
    let id = command(&mut a, json!({"op":"connect","key":ib["transportKey"],
        "address":{"address":"127.0.0.1","port":ib["udpPort"]}}));
    until(&mut a, &mut b, |pa,pb| pa["connections"].as_array().unwrap().iter().any(|c| c["established"] == true)
        && pb["connections"].as_array().unwrap().iter().any(|c| c["established"] == true));
    let stream = command(&mut a, json!({"op":"openStream","id":id}));
    let payload: Vec<u8> = (0..60_000).map(|n| (n % 251) as u8).collect();
    assert_eq!(command(&mut a, json!({"op":"write","id":id,"stream":stream,"data":URL_SAFE_NO_PAD.encode(&payload)})), payload.len());
    let mut received = Vec::new();
    until(&mut a, &mut b, |_,pb| {
        for connection in pb["connections"].as_array().unwrap() {
            for chunk in connection["data"].as_array().unwrap() {
                received.extend(URL_SAFE_NO_PAD.decode(chunk["data"].as_str().unwrap()).unwrap());
            }
        }
        received.len() == payload.len()
    });
    assert_eq!(received, payload);
    command(&mut b, json!({"op":"admit","peers":[]}));
    let result = command(&mut b, json!({"op":"poll"}));
    assert!(result["connections"].as_array().unwrap().is_empty());
    assert_eq!(b.command(&json!({"op":"datagram","from":{"link":1},"data":"AA"})), Err("PEER_NOT_ADMITTED"));
}

#[test]
fn malformed_admission_is_atomic_and_signing_keys_are_separate_from_transport_keys() {
    let mut a = engine(7, "native-a");
    let identity = command(&mut a, json!({"op":"identity"}));
    assert_ne!(identity["signingKey"], identity["transportKey"]);
    command(&mut a, json!({"op":"admit","peers":[{"key":identity["transportKey"],"link":2}]}));
    assert_eq!(a.command(&json!({"op":"admit","peers":[{"key":identity["transportKey"],"link":2},
        {"key":identity["transportKey"],"link":3}]})), Err("DUPLICATE_PEER"));
    let message = "unit fixture; not a real credential";
    let signature = command(&mut a, json!({"op":"sign","text":message}));
    assert_eq!(command(&mut a, json!({"op":"verify","key":identity["signingKey"],"text":message,"signature":signature})), true);
    assert_eq!(command(&mut a, json!({"op":"verify","key":identity["signingKey"],"text":"changed","signature":signature})), false);
    assert_eq!(a.command(&json!({"op":"connect","key":identity["transportKey"],"address":{"link":3}})), Err("PEER_ADDRESS_MISMATCH"));
}

// The engine's own turn (`pump`) and the socket waiter, as the phone's wait thread uses them (CindyAgentNetModule `wait`):
// 2026-11-21 every request from a phone took 30–60 ms longer than over Device Link and an idle app kept its JS thread
// 9–22% busy, because the core only received, acknowledged and ran its timers when JS polled it on a timer.
// Observable: two engines complete the handshake and move a stream with `pump` alone; `pump` reports work exactly when
// `poll` has something new for the application and `poll` hands each byte over once, also when `pump` ran many times
// before it; the waiter times out on a quiet socket and returns as soon as the peer's datagram arrives.
// The poll-driven test above never calls `pump`, and nothing waited on the socket before.
#[test]
fn pump_runs_the_transport_without_the_application_and_the_waiter_wakes_on_a_datagram() {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut a = engine(11, "native-a");
    let mut b = engine(13, "native-b");
    let ia = command(&mut a, json!({"op":"identity"}));
    let ib = command(&mut b, json!({"op":"identity"}));
    command(&mut a, json!({"op":"admit","peers":[{"key":ib["transportKey"],"link":1}]}));
    command(&mut b, json!({"op":"admit","peers":[{"key":ia["transportKey"],"link":1}]}));
    let waiter = b.waiter();
    assert!(!waiter.wait(20), "a quiet socket times out");
    let id = command(&mut a, json!({"op":"connect","key":ib["transportKey"],"address":{"address":"127.0.0.1","port":ib["udpPort"]}}));
    // The handshake request goes out on a's turn; b's waiter sees it without b having been polled.
    a.pump().unwrap();
    assert!(waiter.wait(2_000), "the peer's datagram wakes the waiter");
    let pump_until = |a: &mut NativeEngine, b: &mut NativeEngine, done: &mut dyn FnMut(&mut NativeEngine, &mut NativeEngine) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(4);
        while !done(a, b) {
            assert!(Instant::now() < deadline, "native pump deadline");
            a.pump().unwrap(); b.pump().unwrap();
            sleep(Duration::from_millis(1));
        }
    };
    // Both sides report work once the connection exists; the application reads that state once.
    let established = |poll: &Value| poll["connections"].as_array().unwrap().iter().any(|c| c["established"] == true);
    let (mut seen_a, mut seen_b) = (false, false);
    pump_until(&mut a, &mut b, &mut |a, b| {
        if a.pump().unwrap().0 { seen_a |= established(&command(a, json!({"op":"poll"}))); }
        if b.pump().unwrap().0 { seen_b |= established(&command(b, json!({"op":"poll"}))); }
        seen_a && seen_b
    });
    // Settle: with the state read and nothing arriving, there is no work.
    pump_until(&mut a, &mut b, &mut |a, b| !a.pump().unwrap().0 && !b.pump().unwrap().0);
    let (work, wake_ms) = b.pump().unwrap();
    assert!(!work && wake_ms <= 250);

    let stream = command(&mut a, json!({"op":"openStream","id":id}));
    let payload: Vec<u8> = (0..200_000).map(|n| (n % 251) as u8).collect();
    let mut written = 0;
    let mut received = Vec::new();
    let mut polls = 0;
    pump_until(&mut a, &mut b, &mut |a, b| {
        if written < payload.len() {
            let end = (written + 60_000).min(payload.len());
            written += command(a, json!({"op":"write","id":id,"stream":stream,"data":URL_SAFE_NO_PAD.encode(&payload[written..end])})).as_u64().unwrap() as usize;
        }
        // The application is slow: b's engine takes many turns between two polls and must neither lose nor repeat data.
        for _ in 0..5 { a.pump().unwrap(); b.pump().unwrap(); }
        if b.pump().unwrap().0 {
            polls += 1;
            for connection in command(b, json!({"op":"poll"}))["connections"].as_array().unwrap() {
                for chunk in connection["data"].as_array().unwrap() { received.extend(URL_SAFE_NO_PAD.decode(chunk["data"].as_str().unwrap()).unwrap()); }
            }
        }
        received.len() >= payload.len()
    });
    assert_eq!(received, payload);
    assert!(polls >= 1);
}

// Production background opener: an unrelated expired sender must not invalidate
// a fresh sender. The transport tests do not exercise persisted notification trust.
#[test]
fn poll_after_pump_reports_the_connections_there_are_now_and_keeps_what_pump_collected() {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut a = engine(21, "native-a");
    let mut b = engine(23, "native-b");
    let mut c = engine(25, "native-c");
    let ia = command(&mut a, json!({"op":"identity"}));
    let ib = command(&mut b, json!({"op":"identity"}));
    let ic = command(&mut c, json!({"op":"identity"}));
    command(&mut a, json!({"op":"admit","peers":[{"key":ib["transportKey"],"link":1}]}));
    command(&mut b, json!({"op":"admit","peers":[{"key":ia["transportKey"],"link":1},{"key":ic["transportKey"],"link":2}]}));
    let id = command(&mut a, json!({"op":"connect","key":ib["transportKey"],"address":{"address":"127.0.0.1","port":ib["udpPort"]}}));
    until(&mut a, &mut b, |pa, pb| pa["connections"][0]["established"] == true && pb["connections"][0]["established"] == true);
    let stream = command(&mut a, json!({"op":"openStream","id":id}));
    assert_eq!(command(&mut a, json!({"op":"write","id":id,"stream":stream,"data":URL_SAFE_NO_PAD.encode(b"collected by pump")})), 17);
    // b's own turn collects the stream data before the application reads anything.
    let deadline = Instant::now() + Duration::from_secs(4);
    while !b.pump().unwrap().0 {
        assert!(Instant::now() < deadline, "native pump deadline");
        a.pump().unwrap();
        sleep(Duration::from_millis(1));
    }
    // The application dials another peer over its relay WebSocket link after that, and only then polls.
    let dialled = command(&mut b, json!({"op":"connect","key":ic["transportKey"],"address":{"link":2}}));
    let poll = command(&mut b, json!({"op":"poll"}));
    let connections = poll["connections"].as_array().unwrap();
    assert!(connections.iter().any(|connection| connection["id"] == dialled), "the connection dialled since is listed: {connections:?}");
    let data: Vec<u8> = connections.iter().flat_map(|connection| connection["data"].as_array().unwrap().iter())
        .flat_map(|chunk| URL_SAFE_NO_PAD.decode(chunk["data"].as_str().unwrap()).unwrap()).collect();
    assert_eq!(data, b"collected by pump");
    assert!(poll["packets"].as_array().unwrap().iter().any(|packet| packet["link"] == 2), "the dial's datagram goes to the relay link");
    // Handed over once.
    let again = command(&mut b, json!({"op":"poll"}));
    assert!(again["connections"].as_array().unwrap().iter().all(|connection| connection["data"].as_array().unwrap().is_empty()));
    // A datagram for the relay WebSocket that a write left behind is work at the engine's next turn, with nothing arriving:
    // the application is not left waiting for a packet before it sends this one.
    let relayed = command(&mut b, json!({"op":"connect","key":ic["transportKey"],"address":{"link":2}}));
    assert!(relayed.is_u64() && b.pump().unwrap().0);
}

#[test]
fn notification_trust_expires_only_the_selected_sender() {

    let mut sender = engine(31, "fresh-host");
    let mut old_sender = engine(32, "old-host");
    let mut phone = engine(33, "phone");
    let sender_key = command(&mut sender, json!({"op":"identity"}))["signingKey"].clone();
    let old_key = command(&mut old_sender, json!({"op":"identity"}))["signingKey"].clone();
    let notification_key = command(&mut phone, json!({"op":"notificationKey"}));
    let now = 1_800_000_000_000u64;
    let seal = |engine: &mut NativeEngine, id: &str| {
        let signed = json!(["cindy-agent-net/notification/2", 2, "unit-network", id, "phone", "unit-notification", now, now + 60_000,
            {"category":"session-done", "title":"Unit result", "deepLink":"/sessions/unit"}]);
        command(engine, json!({"op":"notificationSeal", "recipientKey":notification_key["encryptionKey"], "text":signed.to_string()}))
    };
    let config = json!({"version":3, "secret":notification_key["secret"], "networkId":"unit-network", "deviceId":"phone",
        "expiresAt":now + 120_000, "peers":{"fresh-host":sender_key, "old-host":old_key},
        "peerExpiresAt":{"fresh-host":now + 120_000, "old-host":now - 1}});
    let envelope = seal(&mut sender, "fresh-host");
    assert!(phone.command(&json!({"op":"notificationOpen", "config":config, "envelope":envelope, "now":now})).is_ok());
    let expired_envelope = seal(&mut old_sender, "old-host");
    assert_eq!(phone.command(&json!({"op":"notificationOpen", "config":config, "envelope":expired_envelope, "now":now})),
        Err("NOTIFICATION_SENDER_EXPIRED"));
    let mut missing = config.clone();
    missing["peerExpiresAt"].as_object_mut().unwrap().remove("fresh-host");
    assert_eq!(phone.command(&json!({"op":"notificationOpen", "config":missing, "envelope":envelope, "now":now})),
        Err("NOTIFICATION_SENDER_EXPIRED"));
    assert_eq!(phone.command(&json!({"op":"notificationOpen", "config":config, "envelope":envelope, "now":now + 120_000})),
        Err("NOTIFICATION_TRUST_EXPIRED"));
    // Previous local format used the shortest certificate as its global bound.
    let mut legacy = config.clone(); legacy["version"] = json!(2); legacy.as_object_mut().unwrap().remove("peerExpiresAt");
    assert!(phone.command(&json!({"op":"notificationOpen", "config":legacy, "envelope":envelope, "now":now})).is_ok());
}
