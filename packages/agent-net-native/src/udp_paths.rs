//! Side paths on the engine's UDP port, the same ones the Desktop driver runs next to the core
//! (packages/agent-net/src/stun.ts and relayUdp.ts):
//! - STUN: this port's address outside the NAT, announced to peers as a candidate for hole punching.
//! - Relay UDP: datagrams relayed through the Agent-Net relay go over UDP instead of its WebSocket
//!   (wire format: packages/agent-net-relay/src/udpRelay.ts; docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md).
//! The state machine follows relayUdp.ts step for step, with the same times. Both run inside `poll`;
//! host names resolve on a short-lived thread so a slow DNS answer never blocks a poll.
use std::{collections::BTreeMap, net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket}, sync::{Arc, Mutex}, thread};
use ring::{digest, hmac};

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

    pub(crate) fn tick(&mut self, now: u64, socket: &UdpSocket, mut random: impl FnMut() -> [u8; 12]) {
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
}

impl RelayUdp {
    pub(crate) fn new(server_name: &str) -> Option<Self> {
        let (host, port) = split_host_port(server_name)?;
        Some(Self { server_name: server_name.to_owned(), host, port, lookup: None, server: None, credentials: None, counter: 0, up_counter: 0,
            cookie: None, pending: BTreeMap::new(), acked_at: None, unacked_since: None, registered_at: None, sent_at: None,
            resolved_at: None, next_resolve_at: 0, resolve_retry_us: RESOLVE_RETRY_FIRST_US })
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
        self.cookie = None;
        self.pending.clear();
        self.acked_at = None;
        self.unacked_since = None;
        self.registered_at = None;
    }

    /// Both directions work: acknowledged recently and no registration stuck unacknowledged.
    pub(crate) fn up(&self, now: u64) -> bool {
        self.server.is_some() && self.credentials.is_some()
            && self.acked_at.is_some_and(|at| now.saturating_sub(at) < ACK_FRESH_US)
            && self.unacked_since.is_none_or(|at| now.saturating_sub(at) < UNACKED_DOWN_US)
    }

    /// Sent over UDP: true. False: the caller sends it on the relay WebSocket.
    pub(crate) fn send(&mut self, now: u64, socket: &UdpSocket, destination: &[u8; HASH_BYTES], datagram: &[u8]) -> bool {
        if !self.up(now) || datagram.len() + UP_OVERHEAD > MAX_UDP_PAYLOAD { return false; }
        let (Some(server), Some(credentials)) = (self.server, self.credentials.as_ref()) else { return false; };
        self.up_counter += 1;
        if socket.send_to(&encode_up(credentials, self.up_counter, destination, datagram), server).is_err() { return false; }
        self.sent_at = Some(now);
        true
    }

    pub(crate) fn intercept<'a>(&mut self, now: u64, socket: &UdpSocket, packet: &'a [u8]) -> Intercepted<'a> {
        if packet.is_empty() || !(UDP_RELAY_REGISTER..=UDP_RELAY_DOWN).contains(&packet[0]) { return Intercepted::NotRelay; }
        let Some(credentials) = self.credentials.as_ref() else { return Intercepted::Consumed; };
        if packet[0] == UDP_RELAY_REGISTER_ACK {
            if let Some((counter, proven, cookie)) = verify_register_ack(packet, credentials) { self.acknowledge(now, socket, counter, proven, cookie); }
            return Intercepted::Consumed;
        }
        if packet[0] == UDP_RELAY_DOWN && let Some((source, datagram)) = verify_down(packet, &credentials.key) {
            return Intercepted::Deliver(source, datagram);
        }
        Intercepted::Consumed
    }

    /// Only a registration still waiting and sent less than UNACKED_DOWN_US ago counts, each once: a replayed
    /// or delayed acknowledgement cannot make the path look up.
    fn acknowledge(&mut self, now: u64, socket: &UdpSocket, counter: u64, proven: bool, cookie: [u8; COOKIE_BYTES]) {
        let Some(&(sent_at, sent_cookie)) = self.pending.get(&counter) else { return; };
        if now.saturating_sub(sent_at) >= UNACKED_DOWN_US { return; }
        let was_up = self.up(now);
        self.pending.retain(|pending, _| *pending > counter);
        self.acked_at = Some(now);
        self.unacked_since = self.pending.values().map(|(at, _)| *at).min();
        self.cookie = Some(cookie);
        // Just up: tell the relay at once that this side receives. Not proven with a new cookie: register again with it.
        if !was_up || (!proven && sent_cookie != Some(cookie)) { self.register(now, socket); }
    }

    pub(crate) fn tick(&mut self, now: u64, socket: &UdpSocket) {
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
        let interval = if self.unacked_since.is_some() || !self.up(now) {
            if self.unacked_since.is_some_and(|at| now.saturating_sub(at) >= SLOW_RETRY_AFTER_US) { REGISTER_SLOW_RETRY_US } else { REGISTER_RETRY_US }
        } else if self.sent_at.is_some_and(|at| now.saturating_sub(at) < ACTIVE_WINDOW_US) { ACTIVE_REFRESH_US } else { KEEPALIVE_US };
        if self.registered_at.is_none_or(|at| now.saturating_sub(at) >= interval) { self.register(now, socket); }
    }

    fn register(&mut self, now: u64, socket: &UdpSocket) {
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
