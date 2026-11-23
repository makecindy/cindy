//! Side paths on the engine's UDP port, the same ones the Desktop driver runs next to the core
//! (packages/agent-net/src/stun.ts and relayUdp.ts):
//! - STUN: this port's address outside the NAT, announced to peers as a candidate for hole punching.
//! - Relay UDP: datagrams relayed through the Agent-Net relay go over UDP instead of its WebSocket
//!   (wire format: packages/agent-net-relay/src/udpRelay.ts; docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md).
//! The state machine follows relayUdp.ts step for step, with the same times. Both run inside `poll`;
//! host names resolve on a short-lived thread so a slow DNS answer never blocks a poll.
use std::{cell::Cell, collections::{BTreeMap, VecDeque}, io, net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket}, sync::{Arc, Mutex}, thread};
use serde_json::{Value, json};
use ring::{digest, hmac};

/// The engine's UDP socket, counting the bytes it sends and receives as the Desktop driver does (node.mts `udpTraffic`: every
/// datagram on the port, the core's, relay UDP's and STUN's alike), for the computer's UDP traffic meter.
pub(crate) struct Udp { socket: UdpSocket, sent: Cell<u64>, received: Cell<u64> }
impl Udp {
    pub(crate) fn new(socket: UdpSocket) -> Self { Self { socket, sent: Cell::new(0), received: Cell::new(0) } }
    pub(crate) fn socket(&self) -> &UdpSocket { &self.socket }
    pub(crate) fn send_to(&self, bytes: &[u8], to: SocketAddr) -> io::Result<usize> {
        let sent = self.socket.send_to(bytes, to)?;
        self.sent.set(self.sent.get().saturating_add(sent as u64));
        Ok(sent)
    }
    pub(crate) fn recv_from(&self, buffer: &mut [u8]) -> io::Result<(usize, SocketAddr)> {
        let (length, from) = self.socket.recv_from(buffer)?;
        self.received.set(self.received.get().saturating_add(length as u64));
        Ok((length, from))
    }
    /// Bytes sent and received on the socket so far.
    pub(crate) fn traffic(&self) -> [u64; 2] { [self.sent.get(), self.received.get()] }
}

/// `host:port` (IPv6 literals in brackets). The engine's socket is IPv4, so only IPv4 answers count.
pub(crate) fn split_host_port(server: &str) -> Option<(String, u16)> {
    if server.len() > 260 { return None; }
    let index = server.rfind(':')?;
    let host = server[..index].trim_start_matches('[').trim_end_matches(']');
    let port = server[index + 1..].parse::<u16>().ok().filter(|port| *port > 0)?;
    if host.is_empty() { return None; }
    Some((host.to_owned(), port))
}

/// One name lookup. `take` is `None` while it runs, then once `Some(answer)`.
struct Lookup(Arc<Mutex<Option<Option<SocketAddr>>>>);
impl Lookup {
    fn start(host: &str, port: u16) -> Self {
        let slot = Arc::new(Mutex::new(None));
        if let Ok(ip) = host.parse::<IpAddr>() {
            *slot.lock().expect("fresh lock") = Some(Some(SocketAddr::new(ip, port)).filter(SocketAddr::is_ipv4));
            return Self(slot);
        }
        let (writer, host) = (slot.clone(), host.to_owned());
        let spawned = thread::Builder::new().name("agent-net-dns".into()).spawn(move || {
            let found = (host.as_str(), port).to_socket_addrs().ok().and_then(|mut all| all.find(SocketAddr::is_ipv4));
            if let Ok(mut slot) = writer.lock() { *slot = Some(found); }
        });
        if spawned.is_err() { *slot.lock().expect("fresh lock") = Some(None); }
        Self(slot)
    }
    fn take(&self) -> Option<Option<SocketAddr>> { self.0.lock().map(|mut slot| slot.take()).unwrap_or(Some(None)) }
}

// ─── STUN (RFC 5389 Binding, as stun.ts) ───────────────────────────────────

const MAGIC_COOKIE: u32 = 0x2112_a442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
/// Three tries, half a second each (stun.ts: 1.5 s split in three).
const STUN_ATTEMPTS: u8 = 3;
const STUN_ATTEMPT_US: u64 = 500_000;
pub(crate) const MAX_STUN_SERVERS: usize = 4;

struct StunServer {
    host: String,
    port: u16,
    lookup: Option<Lookup>,
    address: Option<SocketAddr>,
    transaction: Option<[u8; 12]>,
    attempts: u8,
    sent_at: u64,
    mapped: Option<SocketAddr>,
    finished: bool,
}

pub(crate) struct Stun { servers: Vec<StunServer> }

impl Stun {
    pub(crate) fn new(servers: &[(String, u16)]) -> Self {
        Self { servers: servers.iter().take(MAX_STUN_SERVERS).map(|(host, port)| StunServer { host: host.clone(), port: *port,
            lookup: None, address: None, transaction: None, attempts: 0, sent_at: 0, mapped: None, finished: false }).collect() }
    }

    /// The network changed: ask again (and look the names up again).
    pub(crate) fn restart(&mut self) {
        for server in &mut self.servers {
            *server = StunServer { host: std::mem::take(&mut server.host), port: server.port, lookup: None, address: None,
                transaction: None, attempts: 0, sent_at: 0, mapped: None, finished: false };
        }
    }

    pub(crate) fn tick(&mut self, now: u64, socket: &Udp, mut random: impl FnMut() -> [u8; 12]) {
        for server in &mut self.servers {
            if server.finished { continue; }
            if server.address.is_none() {
                match server.lookup.as_ref().map(Lookup::take) {
                    None => { server.lookup = Some(Lookup::start(&server.host, server.port)); continue; },
                    Some(None) => continue,
                    Some(Some(found)) => { server.lookup = None; server.address = found; if found.is_none() { server.finished = true; continue; } },
                }
            }
            if server.transaction.is_some() && now.saturating_sub(server.sent_at) < STUN_ATTEMPT_US { continue; }
            if server.attempts >= STUN_ATTEMPTS { server.transaction = None; server.finished = true; continue; }
            let id = random();
            let mut request = [0u8; 20];
            request[..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
            request[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            request[8..].copy_from_slice(&id);
            server.transaction = Some(id);
            server.attempts += 1;
            server.sent_at = now;
            if socket.send_to(&request, server.address.expect("resolved above")).is_err() { server.transaction = None; server.finished = true; }
        }
    }

    /// An answer to one of this side's requests: taken here, never given to the core.
    pub(crate) fn intercept(&mut self, packet: &[u8]) -> bool {
        if packet.len() < 20 || packet[4..8] != MAGIC_COOKIE.to_be_bytes() { return false; }
        let Some(server) = self.servers.iter_mut().find(|server| server.transaction.as_ref().is_some_and(|id| id[..] == packet[8..20])) else { return false; };
        server.transaction = None;
        server.finished = true;
        if u16::from_be_bytes([packet[0], packet[1]]) == BINDING_SUCCESS { server.mapped = parse_mapped(packet); }
        true
    }

    pub(crate) fn mapped(&self) -> Vec<SocketAddr> {
        let mut found: Vec<SocketAddr> = Vec::new();
        for address in self.servers.iter().filter_map(|server| server.mapped) { if !found.contains(&address) { found.push(address); } }
        found
    }
}

fn parse_mapped(message: &[u8]) -> Option<SocketAddr> {
    let end = message.len().min(20 + u16::from_be_bytes([message[2], message[3]]) as usize);
    let (mut offset, mut plain) = (20, None);
    while offset + 4 <= end {
        let kind = u16::from_be_bytes([message[offset], message[offset + 1]]);
        let length = u16::from_be_bytes([message[offset + 2], message[offset + 3]]) as usize;
        let value = &message[offset + 4..(offset + 4 + length).min(end)];
        if (kind == XOR_MAPPED_ADDRESS || kind == MAPPED_ADDRESS) && value.len() >= 8 && value[1] == 0x01 {
            let xor = kind == XOR_MAPPED_ADDRESS;
            let port = u16::from_be_bytes([value[2], value[3]]) ^ if xor { (MAGIC_COOKIE >> 16) as u16 } else { 0 };
            let ip = u32::from_be_bytes([value[4], value[5], value[6], value[7]]) ^ if xor { MAGIC_COOKIE } else { 0 };
            let address = SocketAddr::new(IpAddr::from(ip.to_be_bytes()), port);
            if xor { return Some(address); }
            plain = Some(address);
        }
        // Attributes are aligned to four bytes.
        offset += 4 + length + (4 - length % 4) % 4;
    }
    plain
}

// ─── Relay UDP (udp-relay-v2, as relayUdp.ts) ──────────────────────────────

const UDP_RELAY_REGISTER: u8 = 0xe1;
const UDP_RELAY_REGISTER_ACK: u8 = 0xe2;
const UDP_RELAY_UP: u8 = 0xe3;
const UDP_RELAY_DOWN: u8 = 0xe4;
pub(crate) const SESSION_BYTES: usize = 8;
pub(crate) const KEY_BYTES: usize = 32;
const COOKIE_BYTES: usize = 16;
const HASH_BYTES: usize = 8;
const MAC_BYTES: usize = 16;
const COUNTER_BYTES: usize = 8;
/// What the relay adds around an upward datagram (`UDP_RELAY_UP_OVERHEAD`).
pub(crate) const UP_OVERHEAD: usize = 1 + SESSION_BYTES + COUNTER_BYTES + HASH_BYTES + MAC_BYTES;
/// The relay forwards on UDP up to 1350 bytes of payload; anything longer keeps the WebSocket.
const MAX_UDP_PAYLOAD: usize = 1350;
const MAX_DATAGRAM_BYTES: usize = 65_000;

const REGISTER_RETRY_US: u64 = 1_000_000;
const REGISTER_SLOW_RETRY_US: u64 = 5_000_000;
const SLOW_RETRY_AFTER_US: u64 = 10_000_000;
const KEEPALIVE_US: u64 = 15_000_000;
const ACTIVE_REFRESH_US: u64 = 2_000_000;
const ACTIVE_WINDOW_US: u64 = 5_000_000;
const UNACKED_DOWN_US: u64 = 4_000_000;
const ACK_FRESH_US: u64 = 40_000_000;
const RESOLVE_REFRESH_US: u64 = 300_000_000;
const RESOLVE_RETRY_FIRST_US: u64 = 2_000_000;
const RESOLVE_RETRY_MAX_US: u64 = 60_000_000;
const RESOLVE_WHEN_DOWN_US: u64 = 30_000_000;
const MAX_PENDING_REGISTRATIONS: usize = 16;
/// Relay UDP that answers registrations but carries no data (relayUdp.ts, 2026-11-22: a VPN's transparent proxy took the traffic
/// to the relay's UDP port, acknowledged every registration, and not one session datagram came back for hours). Data went out
/// over UDP, nothing relayed came back for DATA_SILENCE_US, and meanwhile the core kept resending (at least
/// DATA_SILENCE_MIN_RESENDS more sends, over DATA_SILENCE_MIN_SPAN_US).
const DATA_SILENCE_US: u64 = 4_000_000;
const DATA_SILENCE_MIN_RESENDS: u32 = 3;
const DATA_SILENCE_MIN_SPAN_US: u64 = 1_000_000;
/// Or session requests to relayed peers timed out STALL_COUNT times within STALL_WINDOW_US (`relayStalled`): data comes in, what
/// this side sends is lost.
const STALL_WINDOW_US: u64 = 60_000_000;
const STALL_COUNT: usize = 2;
/// Or what this side sent on relayed connections went unacknowledged: over the last RETRANSMIT_WINDOW_US the core retransmitted at
/// least RETRANSMIT_MIN_SEGMENTS segments, a RETRANSMIT_MIN_SHARE of the packets it sent or more.
const RETRANSMIT_WINDOW_US: u64 = 5_000_000;
const RETRANSMIT_MIN_SEGMENTS: u64 = 6;
const RETRANSMIT_MIN_SHARE: f64 = 0.25;
/// Then relay UDP is off for these, one after the other; data arriving over relay UDP starts over at the first.
const DATA_COOLDOWNS_US: [u64; 3] = [30_000_000, 300_000_000, 1_800_000_000];

/// The device id's tag inside relay UDP packets (`udpRelayPeerHash`).
pub(crate) fn peer_hash(device_id: &str) -> [u8; HASH_BYTES] {
    let mut context = digest::Context::new(&digest::SHA256);
    context.update(b"cindy-agent-net/udp-relay/1\0");
    context.update(device_id.as_bytes());
    context.finish().as_ref()[..HASH_BYTES].try_into().expect("sha256 is longer")
}

fn mac(key: &[u8], parts: &[&[u8]]) -> [u8; MAC_BYTES] {
    let mut context = hmac::Context::with_key(&hmac::Key::new(hmac::HMAC_SHA256, key));
    for part in parts { context.update(part); }
    context.sign().as_ref()[..MAC_BYTES].try_into().expect("sha256 is longer")
}
fn same(expected: &[u8], actual: &[u8]) -> bool {
    expected.len() == actual.len() && expected.iter().zip(actual).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// One relay WebSocket session's UDP credentials, from its hello.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Credentials { pub session: [u8; SESSION_BYTES], pub key: [u8; KEY_BYTES] }
impl Drop for Credentials { fn drop(&mut self) { zeroize::Zeroize::zeroize(&mut self.key); } }

pub(crate) fn encode_register(credentials: &Credentials, counter: u64, receiving: bool, cookie: Option<&[u8; COOKIE_BYTES]>) -> Vec<u8> {
    let mut packet = Vec::with_capacity(1 + SESSION_BYTES + COUNTER_BYTES + 1 + COOKIE_BYTES + MAC_BYTES);
    packet.push(UDP_RELAY_REGISTER);
    packet.extend_from_slice(&credentials.session);
    packet.extend_from_slice(&counter.to_be_bytes());
    packet.push(receiving as u8);
    packet.extend_from_slice(cookie.unwrap_or(&[0; COOKIE_BYTES]));
    let tag = mac(&credentials.key, &[&packet]);
    packet.extend_from_slice(&tag);
    packet
}

pub(crate) fn encode_up(credentials: &Credentials, counter: u64, destination: &[u8; HASH_BYTES], datagram: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(UP_OVERHEAD + datagram.len());
    packet.push(UDP_RELAY_UP);
    packet.extend_from_slice(&credentials.session);
    packet.extend_from_slice(&counter.to_be_bytes());
    packet.extend_from_slice(destination);
    let tag = mac(&credentials.key, &[&packet, datagram]);
    packet.extend_from_slice(&tag);
    packet.extend_from_slice(datagram);
    packet
}

fn verify_register_ack(packet: &[u8], credentials: &Credentials) -> Option<(u64, bool, [u8; COOKIE_BYTES])> {
    let counter_end = 1 + COUNTER_BYTES;
    let end = counter_end + 1 + COOKIE_BYTES;
    if packet.first() != Some(&UDP_RELAY_REGISTER_ACK) || packet.len() != end + MAC_BYTES { return None; }
    if !same(&mac(&credentials.key, &[&packet[..end], &credentials.session]), &packet[end..]) { return None; }
    Some((u64::from_be_bytes(packet[1..counter_end].try_into().ok()?), packet[counter_end] == 1, packet[counter_end + 1..end].try_into().ok()?))
}

fn verify_down<'a>(packet: &'a [u8], key: &[u8]) -> Option<([u8; HASH_BYTES], &'a [u8])> {
    let header_end = 1 + HASH_BYTES;
    let mac_end = header_end + MAC_BYTES;
    if packet.first() != Some(&UDP_RELAY_DOWN) || packet.len() <= mac_end || packet.len() - mac_end > MAX_DATAGRAM_BYTES { return None; }
    let datagram = &packet[mac_end..];
    if !same(&mac(key, &[&packet[..header_end], datagram]), &packet[header_end..mac_end]) { return None; }
    Some((packet[1..header_end].try_into().ok()?, datagram))
}

pub(crate) enum Intercepted<'a> { NotRelay, Consumed, Deliver([u8; HASH_BYTES], &'a [u8]) }

pub(crate) struct RelayUdp {
    pub(crate) server_name: String,
    host: String,
    port: u16,
    lookup: Option<Lookup>,
    server: Option<SocketAddr>,
    credentials: Option<Credentials>,
    counter: u64,
    up_counter: u64,
    cookie: Option<[u8; COOKIE_BYTES]>,
    /// Sent and not yet acknowledged registrations: counter → (sent at, cookie it carried).
    pending: BTreeMap<u64, (u64, Option<[u8; COOKIE_BYTES]>)>,
    acked_at: Option<u64>,
    unacked_since: Option<u64>,
    registered_at: Option<u64>,
    sent_at: Option<u64>,
    resolved_at: Option<u64>,
    next_resolve_at: u64,
    resolve_retry_us: u64,
    /// The last registration this side counted, from sending to its acknowledgement; cleared with the registration.
    rtt_us: Option<u64>,
    /// Since the last relayed datagram came in: the first send of data over UDP, how many followed, the last one.
    silent_since: Option<u64>,
    silent_resends: u32,
    silent_last_send: u64,
    /// Relay UDP carried no data: off until then.
    suspended_until: Option<u64>,
    suspended_for_us: u64,
    suspension_reason: &'static str,
    suspensions: usize,
    /// When session requests to relayed peers timed out while on UDP (within STALL_WINDOW_US).
    stalls: Vec<u64>,
    /// Retransmitted segments and packets sent on relayed connections, sampled every tick while up.
    send_samples: VecDeque<(u64, u64, u64)>,
}

impl RelayUdp {
    pub(crate) fn new(server_name: &str) -> Option<Self> {
        let (host, port) = split_host_port(server_name)?;
        Some(Self { server_name: server_name.to_owned(), host, port, lookup: None, server: None, credentials: None, counter: 0, up_counter: 0,
            cookie: None, pending: BTreeMap::new(), acked_at: None, unacked_since: None, registered_at: None, sent_at: None,
            resolved_at: None, next_resolve_at: 0, resolve_retry_us: RESOLVE_RETRY_FIRST_US, rtt_us: None, silent_since: None,
            silent_resends: 0, silent_last_send: 0, suspended_until: None, suspended_for_us: 0, suspension_reason: "data-silence",
            suspensions: 0, stalls: Vec::new(), send_samples: VecDeque::new() })
    }

    /// The relay WebSocket reconnected (another session) or this side has none: the old registration is void.
    pub(crate) fn set_credentials(&mut self, credentials: Option<Credentials>) {
        if self.credentials == credentials { return; }
        self.credentials = credentials;
        self.counter = 0;
        self.up_counter = 0;
        self.reset_registration();
    }

    fn reset_registration(&mut self) {
        self.silent_since = None;
        self.silent_resends = 0;
        self.rtt_us = None;
        self.cookie = None;
        self.pending.clear();
        self.acked_at = None;
        self.unacked_since = None;
        self.registered_at = None;
    }

    /// Both directions work: acknowledged recently, no registration stuck unacknowledged, not off for carrying no data.
    pub(crate) fn up(&self, now: u64) -> bool {
        self.server.is_some() && self.credentials.is_some()
            && self.acked_at.is_some_and(|at| now.saturating_sub(at) < ACK_FRESH_US)
            && self.unacked_since.is_none_or(|at| now.saturating_sub(at) < UNACKED_DOWN_US)
            && !self.suspended(now)
    }
    fn suspended(&self, now: u64) -> bool { self.suspended_until.is_some_and(|until| now < until) }

    /// How relayed datagrams go now, for the computer's connection page and log (relayUdp.ts `rttMs` and `suspension`): over UDP
    /// with its registration round trip, or over the WebSocket, and why while relay UDP is off for carrying no data.
    pub(crate) fn route(&self, now: u64) -> Value {
        let up = self.up(now);
        let mut route = json!({"via": if up { "udp" } else { "websocket" }, "rttMs": if up { self.rtt_us.map(|us| (us + 500) / 1000) } else { None }});
        if self.suspended(now) {
            route["udpSuspension"] = json!({"reason": self.suspension_reason, "cooldownMs": self.suspended_for_us / 1000});
        }
        route
    }

    /// A relayed datagram came in, over relay UDP or the relay WebSocket: data comes back. Over UDP, the cooldowns start over.
    pub(crate) fn note_inbound(&mut self, via_udp: bool) {
        self.silent_since = None;
        self.silent_resends = 0;
        if via_udp { self.suspensions = 0; }
    }

    /// A session request to a relayed peer timed out (`relayStalled`). The second within STALL_WINDOW_US while on UDP turns relay
    /// UDP off: this catches "receives, cannot send", where the peer keeps resending and data keeps coming in.
    pub(crate) fn note_stall(&mut self, now: u64, socket: &Udp) {
        if !self.up(now) { return; }
        self.stalls.retain(|at| now.saturating_sub(*at) < STALL_WINDOW_US);
        self.stalls.push(now);
        if self.stalls.len() >= STALL_COUNT { self.suspend("request-timeouts", now, socket); }
    }

    /// Sent over UDP: true. False: the caller sends it on the relay WebSocket.
    pub(crate) fn send(&mut self, now: u64, socket: &Udp, destination: &[u8; HASH_BYTES], datagram: &[u8]) -> bool {
        if !self.up(now) || datagram.len() + UP_OVERHEAD > MAX_UDP_PAYLOAD { return false; }
        let (Some(server), Some(credentials)) = (self.server, self.credentials.as_ref()) else { return false; };
        self.up_counter += 1;
        if socket.send_to(&encode_up(credentials, self.up_counter, destination, datagram), server).is_err() { return false; }
        self.sent_at = Some(now);
        if self.silent_since.is_none() { self.silent_since = Some(now); self.silent_resends = 0; } else { self.silent_resends += 1; }
        self.silent_last_send = now;
        true
    }

    pub(crate) fn intercept<'a>(&mut self, now: u64, socket: &Udp, packet: &'a [u8]) -> Intercepted<'a> {
        if packet.is_empty() || !(UDP_RELAY_REGISTER..=UDP_RELAY_DOWN).contains(&packet[0]) { return Intercepted::NotRelay; }
        let Some(credentials) = self.credentials.as_ref() else { return Intercepted::Consumed; };
        if packet[0] == UDP_RELAY_REGISTER_ACK {
            if let Some((counter, proven, cookie)) = verify_register_ack(packet, credentials) { self.acknowledge(now, socket, counter, proven, cookie); }
            return Intercepted::Consumed;
        }
        if packet[0] == UDP_RELAY_DOWN && let Some((source, datagram)) = verify_down(packet, &credentials.key) {
            // Counted as data coming back once the engine delivers it (only from a peer admitted now; engine.rs `network`).
            return Intercepted::Deliver(source, datagram);
        }
        Intercepted::Consumed
    }

    /// Only a registration still waiting and sent less than UNACKED_DOWN_US ago counts, each once: a replayed
    /// or delayed acknowledgement cannot make the path look up.
    fn acknowledge(&mut self, now: u64, socket: &Udp, counter: u64, proven: bool, cookie: [u8; COOKIE_BYTES]) {
        let Some(&(sent_at, sent_cookie)) = self.pending.get(&counter) else { return; };
        if now.saturating_sub(sent_at) >= UNACKED_DOWN_US { return; }
        let was_up = self.up(now);
        self.pending.retain(|pending, _| *pending > counter);
        self.acked_at = Some(now);
        self.rtt_us = Some(now.saturating_sub(sent_at));
        self.unacked_since = self.pending.values().map(|(at, _)| *at).min();
        self.cookie = Some(cookie);
        // Just up: tell the relay at once that this side receives. Not proven with a new cookie: register again with it. While
        // off for carrying no data `up` stays false, and registering on every acknowledgement would spin at the round trip.
        if !self.suspended(now) && (!was_up || (!proven && sent_cookie != Some(cookie))) { self.register(now, socket); }
    }

    /// `relayed_sends`: when `sample_due`, the retransmitted segments and packets sent so far on connections relayed the whole
    /// time between two samples (engine.rs `relayed_send_counters`).
    /// Time for the next sample of `relayed_sends` (once per REGISTER_RETRY_US while up, as relayUdp.ts samples on its tick).
    pub(crate) fn sample_due(&self, now: u64) -> bool {
        self.up(now) && self.send_samples.back().is_none_or(|last| now.saturating_sub(last.0) >= REGISTER_RETRY_US)
    }
    pub(crate) fn tick(&mut self, now: u64, socket: &Udp, relayed_sends: Option<(u64, u64)>) {
        if let Some(answer) = self.lookup.as_ref().and_then(Lookup::take) {
            self.lookup = None;
            match answer {
                Some(address) => {
                    self.resolved_at = Some(now);
                    self.next_resolve_at = now + RESOLVE_REFRESH_US;
                    self.resolve_retry_us = RESOLVE_RETRY_FIRST_US;
                    // The relay moved: registrations, acknowledgements and cookies were for the old address.
                    if self.server != Some(address) { self.server = Some(address); self.reset_registration(); }
                },
                None => {
                    // Offline start, DNS down: stay on the WebSocket and retry with backoff.
                    self.next_resolve_at = now + self.resolve_retry_us;
                    self.resolve_retry_us = (self.resolve_retry_us * 2).min(RESOLVE_RETRY_MAX_US);
                },
            }
        }
        // Down for long: the relay may have changed its address, look it up early (never past the DNS failure backoff).
        let down_too_long = self.server.is_some() && self.credentials.is_some() && !self.up(now)
            && self.resolved_at.is_none_or(|at| now.saturating_sub(at) >= RESOLVE_WHEN_DOWN_US)
            && self.unacked_since.is_none_or(|at| now.saturating_sub(at) >= RESOLVE_WHEN_DOWN_US);
        if self.lookup.is_none() && (now >= self.next_resolve_at || (down_too_long && self.resolve_retry_us == RESOLVE_RETRY_FIRST_US)) {
            self.lookup = Some(Lookup::start(&self.host, self.port));
        }
        if self.server.is_none() || self.credentials.is_none() { return; }
        let suspended = self.suspended(now);
        if !suspended && self.up(now) && self.silent_since.is_some_and(|since| now.saturating_sub(since) >= DATA_SILENCE_US
            && self.silent_resends >= DATA_SILENCE_MIN_RESENDS && self.silent_last_send.saturating_sub(since) >= DATA_SILENCE_MIN_SPAN_US) {
            self.suspend("data-silence", now, socket);
            return;
        }
        if !suspended && self.up(now) && relayed_sends.is_some_and(|counts| self.unacked_sends(now, counts)) {
            self.suspend("unacked-sends", now, socket);
            return;
        }
        if suspended {
            // Off: keep registering now and then (not receiving), so the relay keeps this address; the first tick after the
            // cooldown registers as receiving at once.
            if self.registered_at.is_none_or(|at| now.saturating_sub(at) >= KEEPALIVE_US) { self.register(now, socket); }
            return;
        }
        if let Some(until) = self.suspended_until && self.registered_at.is_none_or(|at| at < until) {
            self.register(now, socket);
            return;
        }
        let interval = if self.unacked_since.is_some() || !self.up(now) {
            if self.unacked_since.is_some_and(|at| now.saturating_sub(at) >= SLOW_RETRY_AFTER_US) { REGISTER_SLOW_RETRY_US } else { REGISTER_RETRY_US }
        } else if self.sent_at.is_some_and(|at| now.saturating_sub(at) < ACTIVE_WINDOW_US) { ACTIVE_REFRESH_US } else { KEEPALIVE_US };
        if self.registered_at.is_none_or(|at| now.saturating_sub(at) >= interval) { self.register(now, socket); }
    }

    /// What this side sent on relayed connections lately went unacknowledged: the core keeps retransmitting. This looks at this
    /// side's own sends, so it also finds a broken upward path when this side is only controlled, requests keep coming in (which
    /// clears the silence) and it sends no requests of its own (nothing to time out).
    fn unacked_sends(&mut self, now: u64, (retransmitted, sent): (u64, u64)) -> bool {
        // A connection closed and the totals went down: start over from here.
        if self.send_samples.back().is_some_and(|last| retransmitted < last.1 || sent < last.2) { self.send_samples.clear(); }
        self.send_samples.push_back((now, retransmitted, sent));
        while self.send_samples.len() > 1 && now.saturating_sub(self.send_samples[1].0) >= RETRANSMIT_WINDOW_US { self.send_samples.pop_front(); }
        let first = self.send_samples[0];
        if now.saturating_sub(first.0) < RETRANSMIT_WINDOW_US { return false; }
        let (retransmitted, sent) = (retransmitted - first.1, sent - first.2);
        retransmitted >= RETRANSMIT_MIN_SEGMENTS && retransmitted as f64 >= RETRANSMIT_MIN_SHARE * sent.max(1) as f64
    }

    /// Relay UDP carries no data: off for the next cooldown, and the relay hears at once that this side does not receive, so
    /// datagrams for it go over the WebSocket too.
    fn suspend(&mut self, reason: &'static str, now: u64, socket: &Udp) {
        self.suspended_for_us = DATA_COOLDOWNS_US[self.suspensions.min(DATA_COOLDOWNS_US.len() - 1)];
        self.suspension_reason = reason;
        self.suspensions += 1;
        self.suspended_until = Some(now + self.suspended_for_us);
        self.silent_since = None;
        self.silent_resends = 0;
        self.stalls.clear();
        self.send_samples.clear();
        self.register(now, socket);
    }

    fn register(&mut self, now: u64, socket: &Udp) {
        let receiving = self.up(now);
        let (Some(server), Some(credentials)) = (self.server, self.credentials.as_ref()) else { return; };
        self.registered_at = Some(now);
        self.unacked_since.get_or_insert(now);
        self.counter += 1;
        let packet = encode_register(credentials, self.counter, receiving, self.cookie.as_ref());
        self.pending.insert(self.counter, (now, self.cookie));
        if self.pending.len() > MAX_PENDING_REGISTRATIONS && let Some(oldest) = self.pending.keys().next().copied() { self.pending.remove(&oldest); }
        let _ = socket.send_to(&packet, server);
    }
}

/// Relay UDP that answers registrations but carries no data, ported from the Desktop's relayUdp.ts (relayUdp.test.ts) for the
/// Desktop's move to this engine (2026-11-23 review: the engine had none of it, and relayed peers behind such a VPN would stall).
/// Observable: whether datagrams go over relay UDP (`send`), what the relay is told (`receiving` in registrations), and the
/// route reported. Minimal failing inputs: acknowledged registrations with four sends over three seconds and nothing back; two
/// request timeouts within a minute while data keeps arriving; relayed sends resent at half the packets sent over five seconds.
/// Unit tier: real loopback sockets for the relay, time passed in explicitly.
#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture { path: RelayUdp, udp: Udp, relay: UdpSocket, credentials: Credentials, now: u64, acking: bool,
        registrations: Vec<bool>, relayed_sends: (u64, u64) }
    impl Fixture {
        fn up() -> Self {
            let relay = UdpSocket::bind("127.0.0.1:0").unwrap();
            relay.set_nonblocking(true).unwrap();
            let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            socket.set_nonblocking(true).unwrap();
            let credentials = Credentials { session: [7; SESSION_BYTES], key: [9; KEY_BYTES] };
            let mut path = RelayUdp::new(&format!("127.0.0.1:{}", relay.local_addr().unwrap().port())).unwrap();
            path.set_credentials(Some(credentials.clone()));
            let mut fixture = Self { path, udp: Udp::new(socket), relay, credentials, now: 1_000_000, acking: true,
                registrations: Vec::new(), relayed_sends: (0, 0) };
            fixture.step(2_000);
            assert!(fixture.path.up(fixture.now), "acknowledged registrations bring relay UDP up");
            fixture
        }
        /// Time passes in quarter seconds; the relay acknowledges every registration at once (while `acking`).
        fn step(&mut self, ms: u64) {
            for _ in 0..ms / 250 {
                self.now += 250_000;
                let sends = self.path.sample_due(self.now).then_some(self.relayed_sends);
                self.path.tick(self.now, &self.udp, sends);
                self.serve();
            }
        }
        fn serve(&mut self) {
            let mut buffer = [0u8; 2048];
            while let Ok((length, _)) = self.relay.recv_from(&mut buffer) {
                let packet = &buffer[..length];
                if packet[0] != UDP_RELAY_REGISTER { continue; }
                let counter = &packet[1 + SESSION_BYTES..1 + SESSION_BYTES + COUNTER_BYTES];
                self.registrations.push(packet[1 + SESSION_BYTES + COUNTER_BYTES] == 1);
                if !self.acking { continue; }
                let mut ack = vec![UDP_RELAY_REGISTER_ACK];
                ack.extend_from_slice(counter);
                ack.push(1);
                ack.extend_from_slice(&[3; COOKIE_BYTES]);
                let tag = mac(&self.credentials.key, &[&ack, &self.credentials.session]);
                ack.extend_from_slice(&tag);
                assert!(matches!(self.path.intercept(self.now, &self.udp, &ack), Intercepted::Consumed));
            }
        }
        fn send(&mut self) -> bool { self.path.send(self.now, &self.udp, &[1; HASH_BYTES], &[0; 1_000]) }
        /// Data goes out every second and nothing comes back: three resends over three seconds.
        fn send_unanswered(&mut self) { for _ in 0..4 { assert!(self.send()); self.step(1_000); } }
        fn suspension(&self) -> Value { self.path.route(self.now)["udpSuspension"].clone() }
    }

    #[test]
    fn leaves_relay_udp_when_registrations_are_acknowledged_but_no_data_comes_back_and_retries_after_growing_cooldowns() {
        let mut fixture = Fixture::up();
        assert_eq!(fixture.path.route(fixture.now)["via"], "udp");
        assert!(fixture.path.route(fixture.now)["rttMs"].is_u64(), "the registration round trip is reported");
        fixture.send_unanswered();
        fixture.step(1_000);
        assert!(!fixture.send(), "relayed datagrams go over the WebSocket");
        assert_eq!(fixture.suspension(), json!({"reason":"data-silence","cooldownMs":30_000}));
        assert_eq!(fixture.path.route(fixture.now)["via"], "websocket");
        assert_eq!(fixture.registrations.last(), Some(&false), "the relay hears that this side does not receive");
        // While off, acknowledgements must not bounce registrations back and forth at the round trip.
        let before = fixture.registrations.len();
        fixture.step(10_000);
        assert!(fixture.registrations.len() - before <= 1);
        fixture.step(20_000);
        assert!(fixture.send(), "back on relay UDP after the cooldown");
        assert_eq!(fixture.registrations.last(), Some(&true));
        // Still no data: the next cooldown is longer.
        fixture.send_unanswered();
        fixture.step(1_000);
        assert_eq!(fixture.suspension()["cooldownMs"], 300_000);
        // Data arriving over relay UDP starts over at the first cooldown.
        fixture.step(300_000);
        assert!(fixture.send());
        fixture.path.note_inbound(true);
        fixture.send_unanswered();
        fixture.step(1_000);
        assert_eq!(fixture.suspension()["cooldownMs"], 30_000);
    }

    #[test]
    fn stays_on_relay_udp_for_an_unanswered_single_packet_and_while_replies_arrive_over_either_path() {
        let mut fixture = Fixture::up();
        assert!(fixture.send());
        fixture.step(10_000);
        assert!(fixture.send() && fixture.suspension().is_null(), "one packet nobody answers (an acknowledgement) proves nothing");
        for round in 0..8 {
            fixture.step(1_000);
            assert!(fixture.send());
            fixture.path.note_inbound(round % 2 == 0);
        }
        fixture.step(1_000);
        assert!(fixture.send() && fixture.suspension().is_null());
    }

    #[test]
    fn leaves_relay_udp_after_two_request_timeouts_within_a_minute_even_while_data_arrives() {
        let mut fixture = Fixture::up();
        let mut arriving = |fixture: &mut Fixture| for _ in 0..4 { fixture.step(1_000); assert!(fixture.send()); fixture.path.note_inbound(true); };
        arriving(&mut fixture);
        fixture.path.note_stall(fixture.now, &fixture.udp);
        arriving(&mut fixture);
        assert!(fixture.send());
        // Two timeouts more than a minute apart do not count together.
        fixture.step(60_000);
        fixture.path.note_stall(fixture.now, &fixture.udp);
        assert!(fixture.suspension().is_null());
        fixture.path.note_stall(fixture.now, &fixture.udp);
        assert!(!fixture.send());
        assert_eq!(fixture.suspension(), json!({"reason":"request-timeouts","cooldownMs":30_000}));
        fixture.serve();
        assert_eq!(fixture.registrations.last(), Some(&false));
        // A timeout while relay UDP is not in use is not about it.
        fixture.path.note_stall(fixture.now, &fixture.udp);
        assert_eq!(fixture.suspension()["cooldownMs"], 30_000);
    }

    #[test]
    fn leaves_relay_udp_when_its_relayed_sends_go_unacknowledged_even_on_a_host_that_only_receives() {
        let mut fixture = Fixture::up();
        let receiving = |fixture: &mut Fixture, retransmitted: u64, sent: u64| for _ in 0..6 {
            fixture.step(1_000);
            fixture.path.note_inbound(true);
            assert!(fixture.send() || fixture.suspension().is_object());
            fixture.relayed_sends.0 += retransmitted;
            fixture.relayed_sends.1 += sent;
        };
        // Lossy but working: enough resent segments, but a tenth of what was sent.
        receiving(&mut fixture, 2, 20);
        assert!(fixture.suspension().is_null());
        // A connection closed and the totals went down: start counting again, never a negative difference.
        fixture.relayed_sends = (0, 0);
        fixture.step(1_000);
        assert!(fixture.suspension().is_null());
        // What this host sends back is never acknowledged: the core resends half of what it sends.
        receiving(&mut fixture, 2, 4);
        assert!(!fixture.send());
        assert_eq!(fixture.suspension(), json!({"reason":"unacked-sends","cooldownMs":30_000}));
        assert_eq!(fixture.registrations.last(), Some(&false));
    }

    #[test]
    fn reports_no_round_trip_once_acknowledgements_stop() {
        let mut fixture = Fixture::up();
        fixture.acking = false;
        // Sending keeps registrations every 2 s (replies keep coming over the WebSocket); one unacknowledged for 4 s takes relay
        // UDP down, and no round trip is reported for it any more.
        for _ in 0..7 { fixture.send(); fixture.path.note_inbound(false); fixture.step(1_000); }
        assert_eq!(fixture.path.route(fixture.now), json!({"via":"websocket","rttMs":null}));
    }
}
