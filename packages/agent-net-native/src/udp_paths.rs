//! Side paths on the engine's UDP port, the same ones the Desktop driver runs next to the core
//! (packages/agent-net/src/stun.ts and relayUdp.ts):
//! - STUN: this port's address outside the NAT, announced to peers as a candidate for hole punching.
//! - Relay UDP: datagrams relayed through the Agent-Net relay go over UDP instead of its WebSocket
//!   (wire format: packages/agent-net-relay/src/udpRelay.ts; docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md).
//! The state machine follows relayUdp.ts step for step, with the same times. Both run inside `poll`;
//! host names resolve on a short-lived thread so a slow DNS answer never blocks a poll.
use std::{cell::Cell, collections::BTreeMap, io, net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket}, sync::{Arc, Mutex}, thread};
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

    /// Raw per-server STUN observations without deduplication, so JS NAT classification can distinguish
    /// multiple servers agreeing on the same address (`cone`) from a single STUN response (`single-server`).
    pub(crate) fn observations(&self) -> Vec<SocketAddr> {
        self.servers.iter().filter_map(|server| server.mapped).collect()
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
const UDP_RELAY_PROBE: u8 = 0xe5;
const UDP_RELAY_PROBE_ACK: u8 = 0xe6;
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
const PROBE_BYTES: usize = 1350;
const PROBE_MIN_BYTES: usize = 1 + SESSION_BYTES + COUNTER_BYTES + MAC_BYTES;
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
const PROBE_RETRY_US: u64 = 1_000_000;
const PROBE_TIMEOUT_US: u64 = 2_500_000;
const PROBE_FRESH_US: u64 = 3_000_000;
const DATA_SILENCE_US: u64 = 4_000_000;
const DATA_SILENCE_MIN_RESENDS: u32 = 3;
const DATA_SILENCE_MIN_SPAN_US: u64 = 1_000_000;
const STALL_WINDOW_US: u64 = 60_000_000;
const STALL_COUNT: usize = 2;
const RETRANSMIT_SAMPLE_US: u64 = 1_000_000;
const RETRANSMIT_WINDOW_US: u64 = 5_000_000;
const RETRANSMIT_MIN_SEGMENTS: u64 = 6;
const LEGACY_COOLDOWNS_US: [u64; 3] = [30_000_000, 300_000_000, 1_800_000_000];
const PROBE_COOLDOWNS_US: [u64; 4] = [15_000_000, 30_000_000, 60_000_000, 120_000_000];
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
pub(crate) struct Credentials { pub session: [u8; SESSION_BYTES], pub key: [u8; KEY_BYTES], pub probe: bool }
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

pub(crate) fn encode_probe(credentials: &Credentials, counter: u64, total_bytes: usize) -> Vec<u8> {
    let size = total_bytes.clamp(PROBE_MIN_BYTES, MAX_UDP_PAYLOAD);
    let pad_len = size - PROBE_MIN_BYTES;
    let mut packet = Vec::with_capacity(size);
    packet.push(UDP_RELAY_PROBE);
    packet.extend_from_slice(&credentials.session);
    packet.extend_from_slice(&counter.to_be_bytes());
    let padding = vec![0u8; pad_len];
    let tag = mac(&credentials.key, &[&packet, &padding]);
    packet.extend_from_slice(&tag);
    packet.extend_from_slice(&padding);
    packet
}

fn verify_probe_ack(packet: &[u8], credentials: &Credentials) -> Option<u64> {
    let header_end = 1 + COUNTER_BYTES;
    let mac_end = header_end + MAC_BYTES;
    if packet.first() != Some(&UDP_RELAY_PROBE_ACK) || packet.len() < mac_end || packet.len() > MAX_UDP_PAYLOAD { return None; }
    let padding = &packet[mac_end..];
    if !same(&mac(&credentials.key, &[&packet[..header_end], &credentials.session, padding]), &packet[header_end..mac_end]) { return None; }
    Some(u64::from_be_bytes(packet[1..header_end].try_into().ok()?))
}

pub(crate) enum Intercepted<'a> { NotRelay, Consumed, Deliver([u8; HASH_BYTES], &'a [u8]) }

#[derive(Clone, Copy)]
struct PeerRelayTrack {
    relay: bool,
    last_retrans: u64,
    last_sent: u64,
    last_acked: u64,
    relay_retrans: u64,
    relay_sent: u64,
    relay_acked: u64,
}

struct SendWindowSample {
    at: u64,
    retransmitted: u64,
    sent: u64,
    acked: u64,
    peers: BTreeMap<u32, (u64, u64, u64)>,
}

pub(crate) struct RelayUdp {
    pub(crate) server_name: String,
    host: String,
    port: u16,
    lookup: Option<Lookup>,
    server: Option<SocketAddr>,
    credentials: Option<Credentials>,
    counter: u64,
    up_counter: u64,
    probe_counter: u64,
    cookie: Option<[u8; COOKIE_BYTES]>,
    /// Sent and not yet acknowledged registrations: counter → (sent at, cookie it carried).
    pending: BTreeMap<u64, (u64, Option<[u8; COOKIE_BYTES]>)>,
    /// Sent and not yet acknowledged full-size probes: counter → sent at.
    pending_probes: BTreeMap<u64, u64>,
    acked_at: Option<u64>,
    rtt_us: Option<u64>,
    proven_address: bool,
    probe_verified: bool,
    probe_acked_at: Option<u64>,
    probe_started_at: Option<u64>,
    probe_last_sent_at: Option<u64>,
    unacked_since: Option<u64>,
    registered_at: Option<u64>,
    sent_at: Option<u64>,
    silent_since: Option<u64>,
    silent_resends: u32,
    silent_last_send: Option<u64>,
    stalls: Vec<u64>,
    peer_tracks: BTreeMap<u32, PeerRelayTrack>,
    total_relay_retrans: u64,
    total_relay_sent: u64,
    total_relay_acked: u64,
    send_samples: Vec<SendWindowSample>,
    last_sample_at: Option<u64>,
    last_healthy_peer_at: Option<u64>,
    unacked_streak_at: Option<u64>,
    suspended_until: Option<u64>,
    suspended_for_us: u64,
    suspension_reason: &'static str,
    suspensions: usize,
    resolved_at: Option<u64>,
    next_resolve_at: u64,
    resolve_retry_us: u64,
}

impl RelayUdp {
    pub(crate) fn new(server_name: &str) -> Option<Self> {
        let (host, port) = split_host_port(server_name)?;
        Some(Self { server_name: server_name.to_owned(), host, port, lookup: None, server: None, credentials: None, counter: 0, up_counter: 0,
            probe_counter: 0, cookie: None, pending: BTreeMap::new(), pending_probes: BTreeMap::new(), acked_at: None, rtt_us: None, proven_address: false,
            probe_verified: false, probe_acked_at: None, probe_started_at: None, probe_last_sent_at: None, unacked_since: None, registered_at: None,
            sent_at: None, silent_since: None, silent_resends: 0, silent_last_send: None, stalls: Vec::new(), peer_tracks: BTreeMap::new(),
            total_relay_retrans: 0, total_relay_sent: 0, total_relay_acked: 0, send_samples: Vec::new(), last_sample_at: None,
            last_healthy_peer_at: None, unacked_streak_at: None, suspended_until: None, suspended_for_us: 0, suspension_reason: "", suspensions: 0,
            resolved_at: None, next_resolve_at: 0, resolve_retry_us: RESOLVE_RETRY_FIRST_US })
    }

    fn probe_supported(&self) -> bool { self.credentials.as_ref().is_some_and(|c| c.probe) }

    /// Update the configured server address without discarding this session's monotonic counters: a temporary DNS fallback
    /// from a numeric IP back to the host name may still talk to the same relay session, which rejects reset counters.
    pub(crate) fn set_server(&mut self, server_name: &str) -> bool {
        if self.server_name == server_name { return true; }
        let Some((host, port)) = split_host_port(server_name) else { return false; };
        self.server_name = server_name.to_owned();
        self.host = host;
        self.port = port;
        self.lookup = None;
        self.resolved_at = None;
        self.next_resolve_at = 0;
        self.resolve_retry_us = RESOLVE_RETRY_FIRST_US;
        let numeric = self.host.parse::<IpAddr>().ok()
            .map(|ip| SocketAddr::new(ip, self.port))
            .filter(SocketAddr::is_ipv4);
        if numeric.is_none() || numeric != self.server {
            self.server = None;
            self.reset_registration();
        }
        true
    }

    /// The relay WebSocket reconnected (another session) or this side has none: the old registration is void.
    pub(crate) fn set_credentials(&mut self, credentials: Option<Credentials>) {
        if self.credentials == credentials { return; }
        self.credentials = credentials;
        self.counter = 0;
        self.up_counter = 0;
        self.probe_counter = 0;
        self.reset_registration();
    }

    /// Network changed (Wi-Fi ↔ cellular, VPN toggled): clear stale suspension and re-verify on the new route.
    pub(crate) fn network_changed(&mut self, now: u64, socket: &Udp) {
        self.suspended_until = None;
        self.suspended_for_us = 0;
        self.suspension_reason = "";
        self.suspensions = 0;
        self.silent_since = None;
        self.silent_resends = 0;
        self.silent_last_send = None;
        self.stalls.clear();
        self.last_healthy_peer_at = None;
        self.reset_send_window();
        self.proven_address = false;
        self.probe_verified = false;
        self.probe_acked_at = None;
        self.probe_started_at = None;
        self.probe_last_sent_at = None;
        self.pending_probes.clear();
        self.cookie = None;
        self.resolve_retry_us = RESOLVE_RETRY_FIRST_US;
        self.next_resolve_at = now;
        if self.server.is_some() && self.credentials.is_some() { self.register(now, socket); }
    }

    /// A relayed datagram came in, over relay UDP or the relay WebSocket: data comes back. Over UDP on a legacy relay, cooldowns reset.
    pub(crate) fn note_inbound(&mut self, via_udp: bool) {
        self.silent_since = None;
        self.silent_resends = 0;
        if via_udp && !self.probe_supported() { self.suspensions = 0; }
    }

    /// Whether `observe_relayed_sends` is due to take its next per-second sample while relay UDP is up.
    pub(crate) fn sample_due(&self, now: u64) -> bool {
        self.up(now) && self.last_sample_at.is_none_or(|at| now.saturating_sub(at) >= RETRANSMIT_SAMPLE_US)
    }

    /// Session request to a relayed peer timed out; two within 60 s trigger a hop-1 probe (or suspend on legacy relays).
    pub(crate) fn note_stall(&mut self, now: u64, socket: &Udp) {
        if !self.up(now) { return; }
        self.stalls.retain(|at| now.saturating_sub(*at) < STALL_WINDOW_US);
        self.stalls.push(now);
        if self.stalls.len() >= STALL_COUNT {
            self.stalls.clear();
            self.report_anomaly("request-timeouts", now, socket);
        }
    }

    /// Watches per-connection relay-path retransmissions so a broken uplink triggers a hop-1 probe (or suspends on legacy relays) even while downlink keeps arriving.
    pub(crate) fn observe_relayed_sends(&mut self, now: u64, socket: &Udp, connections: &[(u32, bool, u64, u64, u64)]) {
        if !self.up(now) {
            self.reset_send_window();
            return;
        }
        if self.last_sample_at.is_some_and(|at| now.saturating_sub(at) < RETRANSMIT_SAMPLE_US) { return; }
        self.last_sample_at = Some(now);
        let mut active_ids = BTreeMap::new();
        let mut peers = BTreeMap::new();
        for &(id, relay, retrans, sent, acked) in connections {
            active_ids.insert(id, ());
            let entry = self.peer_tracks.entry(id).or_insert(PeerRelayTrack {
                relay, last_retrans: retrans, last_sent: sent, last_acked: acked,
                relay_retrans: 0, relay_sent: 0, relay_acked: 0,
            });
            if entry.relay && relay {
                let d_retrans = retrans.saturating_sub(entry.last_retrans);
                let d_sent = sent.saturating_sub(entry.last_sent);
                let d_acked = acked.saturating_sub(entry.last_acked);
                self.total_relay_retrans = self.total_relay_retrans.saturating_add(d_retrans);
                self.total_relay_sent = self.total_relay_sent.saturating_add(d_sent);
                self.total_relay_acked = self.total_relay_acked.saturating_add(d_acked);
                entry.relay_retrans = entry.relay_retrans.saturating_add(d_retrans);
                entry.relay_sent = entry.relay_sent.saturating_add(d_sent);
                entry.relay_acked = entry.relay_acked.saturating_add(d_acked);
            }
            entry.relay = relay;
            entry.last_retrans = retrans;
            entry.last_sent = sent;
            entry.last_acked = acked;
            if relay { peers.insert(id, (entry.relay_retrans, entry.relay_sent, entry.relay_acked)); }
        }
        self.peer_tracks.retain(|id, _| active_ids.contains_key(id));
        if self.send_samples.last().is_some_and(|last| now.saturating_sub(last.at) >= RETRANSMIT_WINDOW_US) {
            self.reset_send_window();
        }
        self.send_samples.push(SendWindowSample {
            at: now, retransmitted: self.total_relay_retrans, sent: self.total_relay_sent, acked: self.total_relay_acked, peers,
        });
        while self.send_samples.len() > 1 && now.saturating_sub(self.send_samples[1].at) >= RETRANSMIT_WINDOW_US {
            self.send_samples.remove(0);
        }
        let first = &self.send_samples[0];
        if now.saturating_sub(first.at) < RETRANSMIT_WINDOW_US { return; }
        let retrans = self.total_relay_retrans.saturating_sub(first.retransmitted);
        let sent = self.total_relay_sent.saturating_sub(first.sent);
        let acked = self.total_relay_acked.saturating_sub(first.acked);
        let last = self.send_samples.last().expect("pushed above");
        let healthy_peer = last.peers.iter().any(|(id, &(r, s, a))| {
            first.peers.get(id).is_some_and(|&(pr, ps, pa)| {
                let da = a.saturating_sub(pa);
                if da == 0 { return false; }
                let dr = r.saturating_sub(pr);
                let ds = s.saturating_sub(ps);
                !(dr >= RETRANSMIT_MIN_SEGMENTS && dr.saturating_mul(4) >= ds.max(1))
            })
        });
        if healthy_peer { self.last_healthy_peer_at = Some(now); }
        let another_peer_healthy = last.peers.len() >= 2 && healthy_peer;
        let high_retransmit = retrans >= RETRANSMIT_MIN_SEGMENTS && retrans.saturating_mul(4) >= sent.max(1);
        if high_retransmit && !another_peer_healthy {
            if acked == 0 {
                self.reset_send_window();
                self.report_anomaly("unacked-sends", now, socket);
            } else if self.unacked_streak_at.is_none() {
                self.unacked_streak_at = Some(now);
            } else if self.unacked_streak_at.is_some_and(|at| now.saturating_sub(at) >= RETRANSMIT_WINDOW_US) {
                self.reset_send_window();
                self.report_anomaly("unacked-sends", now, socket);
            }
        } else {
            self.unacked_streak_at = None;
        }
    }

    fn report_anomaly(&mut self, reason: &'static str, now: u64, socket: &Udp) {
        if !self.probe_supported() {
            if reason == "request-timeouts" && self.last_healthy_peer_at.is_some_and(|at| now.saturating_sub(at) <= RETRANSMIT_WINDOW_US) {
                self.stalls.clear();
                return;
            }
            self.suspend(reason, now, socket);
            return;
        }
        self.silent_since = None;
        self.silent_resends = 0;
        self.stalls.clear();
        self.unacked_streak_at = None;
        if self.probe_acked_at.is_none_or(|at| now.saturating_sub(at) >= PROBE_FRESH_US) && self.probe_started_at.is_none() {
            self.start_probe(now, socket);
        }
    }

    fn reset_send_window(&mut self) {
        self.send_samples.clear();
        self.last_sample_at = None;
        self.unacked_streak_at = None;
    }

    fn reset_registration(&mut self) {
        self.cookie = None;
        self.proven_address = false;
        self.probe_verified = false;
        self.probe_acked_at = None;
        self.probe_started_at = None;
        self.probe_last_sent_at = None;
        self.pending_probes.clear();
        self.pending.clear();
        self.acked_at = None;
        self.rtt_us = None;
        self.unacked_since = None;
        self.registered_at = None;
        self.silent_since = None;
        self.silent_resends = 0;
        self.silent_last_send = None;
        self.stalls.clear();
        self.last_healthy_peer_at = None;
        self.reset_send_window();
    }

    fn suspended(&self, now: u64) -> bool { self.suspended_until.is_some_and(|until| now < until) }

    /// Both directions work: registration fresh, not suspended, and full-size probe verified when supported.
    pub(crate) fn up(&self, now: u64) -> bool {
        self.server.is_some() && self.credentials.is_some()
            && self.acked_at.is_some_and(|at| now.saturating_sub(at) < ACK_FRESH_US)
            && self.unacked_since.is_none_or(|at| now.saturating_sub(at) < UNACKED_DOWN_US)
            && !self.suspended(now)
            && (!self.probe_supported() || self.probe_verified)
    }

    /// How relayed datagrams travel now, for the Desktop's remote-access panel and logs (`NativeTransport.relayRoute`): over UDP
    /// with its registration/probe round trip, or over the WebSocket, and why while relay UDP is suspended.
    pub(crate) fn route(&self, now: u64) -> Value {
        let up = self.up(now);
        let mut route = json!({"via": if up { "udp" } else { "websocket" }, "rttMs": if up { self.rtt_us.map(|us| (us + 500) / 1000) } else { None }});
        if self.suspended(now) {
            route["udpSuspension"] = json!({"reason": self.suspension_reason, "cooldownMs": self.suspended_for_us / 1000});
        }
        route
    }

    /// Sent over UDP: true. False: the caller sends it on the relay WebSocket.
    pub(crate) fn send(&mut self, now: u64, socket: &Udp, destination: &[u8; HASH_BYTES], datagram: &[u8]) -> bool {
        if !self.up(now) || datagram.len() + UP_OVERHEAD > MAX_UDP_PAYLOAD { return false; }
        let (Some(server), Some(credentials)) = (self.server, self.credentials.as_ref()) else { return false; };
        self.up_counter += 1;
        if socket.send_to(&encode_up(credentials, self.up_counter, destination, datagram), server).is_err() { return false; }
        self.sent_at = Some(now);
        if self.silent_since.is_none() { self.silent_since = Some(now); self.silent_resends = 0; } else { self.silent_resends += 1; }
        self.silent_last_send = Some(now);
        true
    }

    pub(crate) fn intercept<'a>(&mut self, now: u64, socket: &Udp, packet: &'a [u8]) -> Intercepted<'a> {
        if packet.is_empty() || !(UDP_RELAY_REGISTER..=UDP_RELAY_PROBE_ACK).contains(&packet[0]) { return Intercepted::NotRelay; }
        let Some(credentials) = self.credentials.as_ref() else { return Intercepted::Consumed; };
        if packet[0] == UDP_RELAY_REGISTER_ACK {
            if let Some((counter, proven, cookie)) = verify_register_ack(packet, credentials) { self.acknowledge(now, socket, counter, proven, cookie); }
            return Intercepted::Consumed;
        }
        if packet[0] == UDP_RELAY_PROBE_ACK {
            if let Some(counter) = verify_probe_ack(packet, credentials) { self.acknowledge_probe(now, socket, counter); }
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
        self.proven_address = proven;
        let suspended = self.suspended(now);
        if self.probe_supported() && proven && !self.probe_verified && !suspended && self.probe_started_at.is_none() {
            self.start_probe(now, socket);
            return;
        }
        if !proven && sent_cookie != Some(cookie) { self.register(now, socket); }
        else if !suspended && !was_up && self.up(now) { self.register(now, socket); }
    }

    fn acknowledge_probe(&mut self, now: u64, socket: &Udp, counter: u64) {
        let Some(&sent_at) = self.pending_probes.get(&counter) else { return; };
        if now.saturating_sub(sent_at) >= PROBE_TIMEOUT_US { return; }
        let was_up = self.up(now);
        self.pending_probes.clear();
        self.probe_started_at = None;
        self.probe_acked_at = Some(now);
        self.rtt_us = Some(now.saturating_sub(sent_at));
        self.probe_verified = true;
        self.suspended_until = None;
        self.suspended_for_us = 0;
        self.suspension_reason = "";
        self.suspensions = 0;
        self.silent_since = None;
        self.silent_resends = 0;
        self.stalls.clear();
        self.reset_send_window();
        if !was_up && self.up(now) { self.register(now, socket); }
    }

    fn start_probe(&mut self, now: u64, socket: &Udp) {
        if self.server.is_none() || !self.probe_supported() { return; }
        self.probe_started_at = Some(now);
        self.send_probe(now, socket);
    }

    fn send_probe(&mut self, now: u64, socket: &Udp) {
        let (Some(server), Some(credentials)) = (self.server, self.credentials.as_ref()) else { return; };
        self.probe_last_sent_at = Some(now);
        self.probe_counter += 1;
        let packet = encode_probe(credentials, self.probe_counter, PROBE_BYTES);
        self.pending_probes.insert(self.probe_counter, now);
        if self.pending_probes.len() > MAX_PENDING_REGISTRATIONS && let Some(oldest) = self.pending_probes.keys().next().copied() {
            self.pending_probes.remove(&oldest);
        }
        let _ = socket.send_to(&packet, server);
    }

    fn suspend(&mut self, reason: &'static str, now: u64, socket: &Udp) {
        let cooldown = if self.probe_supported() {
            PROBE_COOLDOWNS_US[self.suspensions.min(PROBE_COOLDOWNS_US.len() - 1)]
        } else {
            LEGACY_COOLDOWNS_US[self.suspensions.min(LEGACY_COOLDOWNS_US.len() - 1)]
        };
        self.suspensions = self.suspensions.saturating_add(1);
        self.suspended_until = Some(now.saturating_add(cooldown));
        self.suspended_for_us = cooldown;
        self.suspension_reason = reason;
        self.probe_verified = false;
        self.probe_started_at = None;
        self.pending_probes.clear();
        self.silent_since = None;
        self.silent_resends = 0;
        self.stalls.clear();
        self.reset_send_window();
        self.register(now, socket);
    }

    pub(crate) fn tick(&mut self, now: u64, socket: &Udp) {
        if let Some(answer) = self.lookup.as_ref().and_then(Lookup::take) {
            self.lookup = None;
            match answer {
                Some(address) => {
                    self.resolved_at = Some(now);
                    self.next_resolve_at = now + RESOLVE_REFRESH_US;
                    self.resolve_retry_us = RESOLVE_RETRY_FIRST_US;
                    // The relay moved: registrations, acknowledgements, probes and cookies were for the old address.
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
        if let Some(started_at) = self.probe_started_at {
            if now.saturating_sub(started_at) >= PROBE_TIMEOUT_US {
                self.suspend("probe-failed", now, socket);
                return;
            }
            if self.probe_last_sent_at.is_none_or(|at| now.saturating_sub(at) >= PROBE_RETRY_US) {
                self.send_probe(now, socket);
            }
        }
        if self.up(now)
            && let Some(since) = self.silent_since
            && let Some(last_send) = self.silent_last_send
            && now.saturating_sub(since) >= DATA_SILENCE_US
            && self.silent_resends >= DATA_SILENCE_MIN_RESENDS
            && last_send.saturating_sub(since) >= DATA_SILENCE_MIN_SPAN_US
        {
            self.report_anomaly("data-silence", now, socket);
        }
        if self.suspended(now) {
            if self.registered_at.is_none_or(|at| now.saturating_sub(at) >= KEEPALIVE_US) { self.register(now, socket); }
            return;
        }
        if self.suspended_until.is_some() {
            self.suspended_until = None;
            self.suspended_for_us = 0;
            self.suspension_reason = "";
            if !self.probe_supported() && self.up(now) {
                self.register(now, socket);
                return;
            }
        }
        if self.probe_supported() && !self.probe_verified {
            let interval = if self.unacked_since.is_some() || !self.proven_address {
                if self.unacked_since.is_some_and(|at| now.saturating_sub(at) >= SLOW_RETRY_AFTER_US) { REGISTER_SLOW_RETRY_US } else { REGISTER_RETRY_US }
            } else { KEEPALIVE_US };
            if self.registered_at.is_none_or(|at| now.saturating_sub(at) >= interval) { self.register(now, socket); }
            if self.proven_address && self.acked_at.is_some_and(|at| now.saturating_sub(at) < KEEPALIVE_US) && self.probe_started_at.is_none() {
                self.start_probe(now, socket);
            }
            return;
        }
        let interval = if self.unacked_since.is_some() || !self.up(now) {
            if self.unacked_since.is_some_and(|at| now.saturating_sub(at) >= SLOW_RETRY_AFTER_US) { REGISTER_SLOW_RETRY_US } else { REGISTER_RETRY_US }
        } else if self.sent_at.is_some_and(|at| now.saturating_sub(at) < ACTIVE_WINDOW_US) { ACTIVE_REFRESH_US } else { KEEPALIVE_US };
        if self.registered_at.is_none_or(|at| now.saturating_sub(at) >= interval) { self.register(now, socket); }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_register_ack_test(credentials: &Credentials, counter: u64, proven: bool, cookie: [u8; COOKIE_BYTES]) -> Vec<u8> {
        let mut packet = Vec::with_capacity(1 + COUNTER_BYTES + 1 + COOKIE_BYTES + MAC_BYTES);
        packet.push(UDP_RELAY_REGISTER_ACK);
        packet.extend_from_slice(&counter.to_be_bytes());
        packet.push(proven as u8);
        packet.extend_from_slice(&cookie);
        let tag = mac(&credentials.key, &[&packet, &credentials.session]);
        packet.extend_from_slice(&tag);
        packet
    }

    fn encode_probe_ack_test(credentials: &Credentials, counter: u64, probe_size: usize) -> Vec<u8> {
        let min_ack = 1 + COUNTER_BYTES + MAC_BYTES;
        let ack_size = probe_size.saturating_sub(SESSION_BYTES).max(min_ack);
        let padding = vec![0u8; ack_size - min_ack];
        let mut packet = Vec::with_capacity(ack_size);
        packet.push(UDP_RELAY_PROBE_ACK);
        packet.extend_from_slice(&counter.to_be_bytes());
        let tag = mac(&credentials.key, &[&packet, &credentials.session, &padding]);
        packet.extend_from_slice(&tag);
        packet.extend_from_slice(&padding);
        packet
    }

    // Regression (2026-11-25): Mobile/Desktop native RelayUdp must gate admission on a full-size 1350B probe when the relay
    // supports udp-relay-probe-v1, stay on UDP when data-silence / uplink retransmits / stalls are cleared by a passing
    // hop-1 probe, fall back to WebSocket when full-size probes drop (even while downlink keeps arriving), and recover
    // immediately on network_changed.
    #[test]
    fn full_size_probe_gates_admission_handles_blackhole_and_recovers_on_network_change() {
        let relay_sock = UdpSocket::bind("127.0.0.1:0").expect("bind relay");
        // Short read timeout (instead of nonblocking) so macOS BSD loopback netisr finishes delivering queued datagrams.
        relay_sock.set_read_timeout(Some(std::time::Duration::from_millis(20))).expect("timeout");
        let relay_addr = relay_sock.local_addr().expect("addr");
        let client_raw = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client_raw.set_nonblocking(true).expect("nonblocking");
        let client_sock = Udp::new(client_raw);

        let creds = Credentials { session: [1; SESSION_BYTES], key: [2; KEY_BYTES], probe: true };
        let cookie = [7; COOKIE_BYTES];
        let mut relay = RelayUdp::new(&relay_addr.to_string()).expect("relay");
        relay.set_credentials(Some(creds.clone()));

        let mut now: u64 = 1_000_000;
        let pump = |relay: &mut RelayUdp, now: u64, answer_probes: bool| -> Vec<(u8, usize)> {
            let mut seen = Vec::new();
            let mut buf = [0u8; 2048];
            while let Ok((len, _)) = relay_sock.recv_from(&mut buf) {
                let pkt = &buf[..len];
                seen.push((pkt[0], len));
                if pkt[0] == UDP_RELAY_REGISTER && len == 1 + SESSION_BYTES + COUNTER_BYTES + 1 + COOKIE_BYTES + MAC_BYTES {
                    let counter = u64::from_be_bytes(pkt[1 + SESSION_BYTES..1 + SESSION_BYTES + COUNTER_BYTES].try_into().unwrap());
                    let sent_cookie: [u8; COOKIE_BYTES] = pkt[1 + SESSION_BYTES + COUNTER_BYTES + 1..1 + SESSION_BYTES + COUNTER_BYTES + 1 + COOKIE_BYTES].try_into().unwrap();
                    let ack = encode_register_ack_test(&creds, counter, sent_cookie == cookie, cookie);
                    let _ = relay.intercept(now, &client_sock, &ack);
                } else if pkt[0] == UDP_RELAY_PROBE && answer_probes {
                    let counter = u64::from_be_bytes(pkt[1 + SESSION_BYTES..1 + SESSION_BYTES + COUNTER_BYTES].try_into().unwrap());
                    let ack = encode_probe_ack_test(&creds, counter, len);
                    let _ = relay.intercept(now, &client_sock, &ack);
                }
            }
            seen
        };

        // 1. Resolve + register: 50B register succeeds, 1350B probe is dropped -> never enters UDP, suspends after 2.5s.
        relay.tick(now, &client_sock);
        relay.tick(now, &client_sock);
        let seen = pump(&mut relay, now, false);
        assert!(seen.iter().any(|&(kind, len)| kind == UDP_RELAY_PROBE && len == PROBE_BYTES));
        assert!(!relay.up(now));
        now += PROBE_TIMEOUT_US + 100_000;
        relay.tick(now, &client_sock);
        let _ = pump(&mut relay, now, false);
        assert!(!relay.up(now));
        assert_eq!(relay.route(now)["udpSuspension"], json!({"reason":"probe-failed","cooldownMs":15_000}));

        // 2. Network change clears suspension; now 1350B probe succeeds -> enters UDP immediately.
        now += 500_000;
        relay.network_changed(now, &client_sock);
        let _ = pump(&mut relay, now, true);
        assert!(relay.up(now));
        assert_eq!(relay.route(now)["via"], "udp");
        assert!(relay.route(now)["rttMs"].is_u64());
        assert!(relay.send(now, &client_sock, &[9; HASH_BYTES], &[0u8; 64]));

        // 3. Data silence while hop-1 probe still succeeds -> stays on UDP.
        now += PROBE_FRESH_US + 1_000_000;
        for _ in 0..4 {
            assert!(relay.send(now, &client_sock, &[9; HASH_BYTES], &[0u8; 64]));
            now += 1_500_000;
            relay.tick(now, &client_sock);
            let _ = pump(&mut relay, now, true);
        }
        assert!(relay.up(now));

        // 4. Downlink keeps arriving (clearing silent_since) while uplink breaks (retransmits with 0 ACK) ->
        //    observe_relayed_sends triggers 1350B probe; probe failure suspends back to WebSocket.
        now += PROBE_FRESH_US + 1_000_000;
        let (mut retrans, mut sent) = (0u64, 0u64);
        for _ in 0..7 {
            relay.note_inbound(true);
            retrans += 2;
            sent += 4;
            relay.observe_relayed_sends(now, &client_sock, &[(1, true, retrans, sent, 0)]);
            now += 1_000_000;
            relay.tick(now, &client_sock);
            let _ = pump(&mut relay, now, false);
        }
        now += PROBE_TIMEOUT_US + 100_000;
        relay.tick(now, &client_sock);
        let _ = pump(&mut relay, now, false);
        assert!(!relay.up(now));

        // 5. Recover on network_changed, then verify note_stall triggers probe even while downlink keeps arriving.
        now += 500_000;
        relay.network_changed(now, &client_sock);
        let _ = pump(&mut relay, now, true);
        assert!(relay.up(now));
        now += PROBE_FRESH_US + 1_000_000;
        relay.note_inbound(true);
        relay.note_stall(now, &client_sock);
        relay.note_stall(now, &client_sock);
        let seen = pump(&mut relay, now, false);
        assert!(seen.iter().any(|&(kind, len)| kind == UDP_RELAY_PROBE && len == PROBE_BYTES));
        now += PROBE_TIMEOUT_US + 100_000;
        relay.tick(now, &client_sock);
        assert!(!relay.up(now));
    }

    struct LegacyFixture {
        relay: UdpSocket,
        udp: Udp,
        credentials: Credentials,
        path: RelayUdp,
        now: u64,
        registrations: Vec<bool>,
    }
    impl LegacyFixture {
        fn up() -> Self {
            let relay = UdpSocket::bind("127.0.0.1:0").expect("bind relay");
            relay.set_read_timeout(Some(std::time::Duration::from_millis(20))).expect("timeout");
            let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
            client.set_nonblocking(true).expect("nonblocking");
            let credentials = Credentials { session: [3; SESSION_BYTES], key: [4; KEY_BYTES], probe: false };
            let mut path = RelayUdp::new(&relay.local_addr().expect("addr").to_string()).expect("relay");
            path.set_credentials(Some(credentials.clone()));
            let mut fixture = Self { relay, udp: Udp::new(client), credentials, path, now: 1_000_000, registrations: Vec::new() };
            fixture.path.tick(fixture.now, &fixture.udp);
            fixture.step(100);
            assert!(fixture.path.up(fixture.now));
            fixture
        }
        fn step(&mut self, ms: u64) {
            for _ in 0..ms.div_ceil(1_000).max(1) {
                let jump = ms.min(1_000);
                self.now += jump * 1_000;
                self.path.tick(self.now, &self.udp);
                self.answer_registrations();
            }
        }
        fn answer_registrations(&mut self) {
            let mut buf = [0u8; 2048];
            let cookie = [9; COOKIE_BYTES];
            while let Ok((len, _)) = self.relay.recv_from(&mut buf) {
                let pkt = &buf[..len];
                if pkt[0] == UDP_RELAY_REGISTER && len == 1 + SESSION_BYTES + COUNTER_BYTES + 1 + COOKIE_BYTES + MAC_BYTES {
                    let counter = u64::from_be_bytes(pkt[1 + SESSION_BYTES..1 + SESSION_BYTES + COUNTER_BYTES].try_into().unwrap());
                    let receiving = pkt[1 + SESSION_BYTES + COUNTER_BYTES] == 1;
                    self.registrations.push(receiving);
                    let ack = encode_register_ack_test(&self.credentials, counter, true, cookie);
                    assert!(matches!(self.path.intercept(self.now, &self.udp, &ack), Intercepted::Consumed));
                }
            }
        }
        fn send(&mut self) -> bool { self.path.send(self.now, &self.udp, &[1; HASH_BYTES], &[0; 1_000]) }
        fn send_unanswered(&mut self) { for _ in 0..4 { assert!(self.send()); self.step(1_000); } }
        fn suspension(&self) -> Value { self.path.route(self.now)["udpSuspension"].clone() }
    }

    #[test]
    fn leaves_relay_udp_when_registrations_are_acknowledged_but_no_data_comes_back_and_retries_after_growing_cooldowns() {
        let mut fixture = LegacyFixture::up();
        assert_eq!(fixture.path.route(fixture.now)["via"], "udp");
        assert!(fixture.path.route(fixture.now)["rttMs"].is_u64());
        fixture.send_unanswered();
        fixture.step(1_000);
        assert!(!fixture.send());
        assert_eq!(fixture.suspension(), json!({"reason":"data-silence","cooldownMs":30_000}));
        assert_eq!(fixture.path.route(fixture.now)["via"], "websocket");
        assert_eq!(fixture.registrations.last(), Some(&false));
        let before = fixture.registrations.len();
        fixture.step(10_000);
        assert!(fixture.registrations.len() - before <= 1);
        fixture.step(20_000);
        assert!(fixture.send());
        assert_eq!(fixture.registrations.last(), Some(&true));
        fixture.send_unanswered();
        fixture.step(1_000);
        assert_eq!(fixture.suspension()["cooldownMs"], 300_000);
        fixture.step(300_000);
        assert!(fixture.send());
        fixture.path.note_inbound(true);
        fixture.send_unanswered();
        fixture.step(1_000);
        assert_eq!(fixture.suspension()["cooldownMs"], 30_000);
    }

    #[test]
    fn stays_on_relay_udp_for_an_unanswered_single_packet_and_while_replies_arrive_over_either_path() {
        let mut fixture = LegacyFixture::up();
        assert!(fixture.send());
        fixture.step(10_000);
        assert!(fixture.path.up(fixture.now));
        for _ in 0..5 {
            assert!(fixture.send());
            fixture.step(1_000);
            fixture.path.note_inbound(false);
        }
        assert!(fixture.path.up(fixture.now));
    }

    #[test]
    fn leaves_relay_udp_after_two_request_timeouts_within_a_minute_even_while_data_arrives() {
        let mut fixture = LegacyFixture::up();
        fixture.path.note_stall(fixture.now, &fixture.udp);
        fixture.path.note_inbound(true);
        fixture.step(30_000);
        assert!(fixture.path.up(fixture.now));
        fixture.path.note_stall(fixture.now, &fixture.udp);
        assert!(!fixture.path.up(fixture.now));
        assert_eq!(fixture.suspension(), json!({"reason":"request-timeouts","cooldownMs":30_000}));
    }

    #[test]
    fn leaves_relay_udp_when_its_relayed_sends_go_unacknowledged_even_on_a_host_that_only_receives() {
        let mut fixture = LegacyFixture::up();
        let (mut retrans, mut sent) = (0u64, 0u64);
        for _ in 0..6 {
            fixture.path.note_inbound(true);
            retrans += 2;
            sent += 4;
            fixture.path.observe_relayed_sends(fixture.now, &fixture.udp, &[(1, true, retrans, sent, 0)]);
            fixture.step(1_000);
        }
        assert!(!fixture.path.up(fixture.now));
        assert_eq!(fixture.suspension(), json!({"reason":"unacked-sends","cooldownMs":30_000}));
    }

    #[test]
    fn reports_no_round_trip_once_acknowledgements_stop() {
        let mut fixture = LegacyFixture::up();
        assert!(fixture.path.route(fixture.now)["rttMs"].is_u64());
        fixture.now += KEEPALIVE_US;
        fixture.path.tick(fixture.now, &fixture.udp);
        fixture.now += UNACKED_DOWN_US;
        assert_eq!(fixture.path.route(fixture.now), json!({"via":"websocket","rttMs":null}));
    }

    // Regression (2026-11-26): Updating only the relay server string (e.g. a temporary DNS refresh timeout falling back
    // from a numeric IP to the hostname) must keep monotonic register/uplink/probe counters for the same relay session so
    // the relay never drops subsequent packets as replays.
    #[test]
    fn set_server_preserves_session_counters_while_resetting_registration() {
        let relay_sock = UdpSocket::bind("127.0.0.1:0").expect("bind relay");
        relay_sock.set_read_timeout(Some(std::time::Duration::from_millis(20))).expect("timeout");
        let relay_addr = relay_sock.local_addr().expect("addr");
        let client_raw = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client_raw.set_nonblocking(true).expect("nonblocking");
        let client_sock = Udp::new(client_raw);

        let creds = Credentials { session: [5; SESSION_BYTES], key: [6; KEY_BYTES], probe: true };
        let cookie = [8; COOKIE_BYTES];
        let mut relay = RelayUdp::new(&relay_addr.to_string()).expect("relay");
        relay.set_credentials(Some(creds.clone()));

        let mut now: u64 = 1_000_000;
        let mut last = (0u64, 0u64, 0u64);
        let drain = |relay: &mut RelayUdp, now: u64, last: &mut (u64, u64, u64)| {
            let mut buf = [0u8; 2048];
            while let Ok((len, _)) = relay_sock.recv_from(&mut buf) {
                let pkt = &buf[..len];
                let counter = u64::from_be_bytes(pkt[1 + SESSION_BYTES..1 + SESSION_BYTES + COUNTER_BYTES].try_into().unwrap());
                match pkt[0] {
                    UDP_RELAY_REGISTER => {
                        assert!(counter > last.0, "register counter must stay strictly monotonic: {counter} <= {}", last.0);
                        last.0 = counter;
                        let sent_cookie: [u8; COOKIE_BYTES] = pkt[1 + SESSION_BYTES + COUNTER_BYTES + 1..1 + SESSION_BYTES + COUNTER_BYTES + 1 + COOKIE_BYTES].try_into().unwrap();
                        let ack = encode_register_ack_test(&creds, counter, sent_cookie == cookie, cookie);
                        let _ = relay.intercept(now, &client_sock, &ack);
                    },
                    UDP_RELAY_PROBE => {
                        assert!(counter > last.1, "probe counter must stay strictly monotonic: {counter} <= {}", last.1);
                        last.1 = counter;
                        let ack = encode_probe_ack_test(&creds, counter, len);
                        let _ = relay.intercept(now, &client_sock, &ack);
                    },
                    UDP_RELAY_UP => {
                        assert!(counter > last.2, "uplink counter must stay strictly monotonic: {counter} <= {}", last.2);
                        last.2 = counter;
                    },
                    _ => {},
                }
            }
        };

        relay.tick(now, &client_sock);
        relay.tick(now, &client_sock);
        drain(&mut relay, now, &mut last);
        assert!(relay.up(now));
        assert!(relay.send(now, &client_sock, &[9; HASH_BYTES], &[0u8; 64]));
        drain(&mut relay, now, &mut last);
        assert!(last.0 >= 2 && last.1 >= 1 && last.2 == 1);

        // Simulate DNS refresh fallback to hostname (different string) then back to IP, with identical credentials.
        assert!(relay.set_server(&format!("localhost:{}", relay_addr.port())));
        relay.set_credentials(Some(creds.clone()));
        assert!(!relay.up(now), "registration state resets on server string change");
        assert!(relay.set_server(&relay_addr.to_string()));
        relay.set_credentials(Some(creds.clone()));
        now += 100_000;
        relay.tick(now, &client_sock);
        relay.tick(now, &client_sock);
        drain(&mut relay, now, &mut last);
        assert!(relay.up(now));
        assert!(relay.send(now, &client_sock, &[9; HASH_BYTES], &[0u8; 64]));
        drain(&mut relay, now, &mut last);
        assert!(last.0 >= 4 && last.1 >= 2 && last.2 == 2);
    }

    // Regression (2026-11-27): `Stun::mapped()` deduplicates identical external addresses for candidate announcements,
    // while `Stun::observations()` must retain every server's response so NAT diagnostics distinguish `cone` from `single-server`.
    #[test]
    fn stun_observations_preserve_duplicate_server_answers_for_cone_nat() {
        let s1 = UdpSocket::bind("127.0.0.1:0").expect("bind stun1");
        let s2 = UdpSocket::bind("127.0.0.1:0").expect("bind stun2");
        let a1 = s1.local_addr().expect("addr1");
        let a2 = s2.local_addr().expect("addr2");
        let client_raw = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client_raw.set_nonblocking(true).expect("nonblocking");
        let client_sock = Udp::new(client_raw);

        let mut stun = Stun::new(&[(a1.ip().to_string(), a1.port()), (a2.ip().to_string(), a2.port())]);
        let mut seq = 1u8;
        let mut next_tx = || { let id = [seq; 12]; seq += 1; id };
        for _ in 0..20 {
            stun.tick(1_000_000, &client_sock, &mut next_tx);
            if stun.servers.iter().all(|s| s.transaction.is_some()) { break; }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(stun.servers.iter().all(|s| s.transaction.is_some()), "both STUN requests should be sent");

        // Build RFC 5389 XOR-MAPPED-ADDRESS success responses returning the exact same external IP:port from both servers.
        let make_response = |tx: [u8; 12], ip: [u8; 4], port: u16| -> Vec<u8> {
            let mut msg = vec![0u8; 32];
            msg[0..2].copy_from_slice(&BINDING_SUCCESS.to_be_bytes());
            msg[2..4].copy_from_slice(&12u16.to_be_bytes());
            msg[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            msg[8..20].copy_from_slice(&tx);
            msg[20..22].copy_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
            msg[22..24].copy_from_slice(&8u16.to_be_bytes());
            msg[25] = 0x01; // IPv4
            let xport = port ^ ((MAGIC_COOKIE >> 16) as u16);
            let xip = u32::from_be_bytes(ip) ^ MAGIC_COOKIE;
            msg[26..28].copy_from_slice(&xport.to_be_bytes());
            msg[28..32].copy_from_slice(&xip.to_be_bytes());
            msg
        };
        let tx1 = stun.servers[0].transaction.unwrap();
        let tx2 = stun.servers[1].transaction.unwrap();
        assert!(stun.intercept(&make_response(tx1, [161, 29, 200, 234], 54520)));
        assert!(stun.intercept(&make_response(tx2, [161, 29, 200, 234], 54520)));

        let expected: SocketAddr = "161.29.200.234:54520".parse().unwrap();
        assert_eq!(stun.mapped(), vec![expected]);
        assert_eq!(stun.observations(), vec![expected, expected]);
    }
}
