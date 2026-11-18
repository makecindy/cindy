use std::{cell::RefCell, collections::{BTreeMap, BTreeSet}, net::{SocketAddr, UdpSocket}, rc::Rc, time::Instant};
use agent_net_core::{Config, Crypto, Endpoint, Incoming, PathAddress, Priority, RecoveryPolicy, StreamEvent};
use serde_json::{Value, json};
use crate::{bytes, crypto::NativeCrypto, encoded, text, udp_paths::{self, Credentials, Intercepted, RelayUdp, Stun}};

const MAX_PEERS: usize = 512;
const MAX_CONNECTIONS: usize = 256;
const IO_SIZE: usize = 65_536;
const PROLOGUE: &[u8] = b"cindy/agent-net/device-link/2";
/// The same transport settings as the Desktop driver (packages/agent-net-core/wasm/src/lib.rs `init`,
/// packages/agent-net/src/transport.ts): receive up to 1400 bytes as older nodes still send them; send at most
/// 1350 bytes on the wire including what relay UDP adds, so tunnels (VPN, PPPoE) do not split packets
/// (docs/dev-rules/protocol-compatibility/agent-net-send-packet-size.md).
const MAX_PACKET_SIZE: usize = 1400;
const SEND_PACKET_SIZE: usize = 1350 - udp_paths::UP_OVERHEAD;
/// Window and send buffer are memory caps only; congestion control decides what is in flight from the measured
/// bandwidth and round trip. Interop with 128-segment peers is the core's (packages/agent-net-core/sim/results/2026-11-17-window-interop).
const SEND_WINDOW: u32 = 8192;
const SEND_BUFFER_BYTES: usize = 24 << 20;
/// Streams this side opened whose send-buffer size `poll` reports (data, control and the three session lanes).
const MAX_REPORTED_STREAMS: usize = 16;
/// What this build adds over the first native release; JS checks it before using any of them (an older
/// installed binary keeps working with newer JS, without these).
const FEATURES: [&str; 3] = ["stream-buffered", "stun", "relay-udp-v2"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Address { Udp(SocketAddr), Link(u32) }
impl PathAddress for Address {
    fn same_host(&self, other: &Self) -> bool {
        matches!((self, other), (Self::Udp(a), Self::Udp(b)) if a.ip() == b.ip())
    }
    fn cost(&self) -> u8 { if matches!(self, Self::Link(_)) { 1 } else { 0 } }
}
fn address(value: &Value) -> Result<Address, &'static str> {
    if let Some(id) = value["link"].as_u64() {
        return u32::try_from(id).ok().filter(|id| *id > 0).map(Address::Link).ok_or("INVALID_ADDRESS");
    }
    let host = text(value, "address")?;
    let port = value["port"].as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port > 0).ok_or("INVALID_ADDRESS")?;
    let ip = host.parse().map_err(|_| "INVALID_ADDRESS")?;
    Ok(Address::Udp(SocketAddr::new(ip, port)))
}
fn address_value(address: Address) -> Value {
    match address { Address::Udp(a) => json!({"address":a.ip().to_string(),"port":a.port()}), Address::Link(id) => json!({"link":id}) }
}
fn number(command: &Value, key: &str) -> Result<u32, &'static str> {
    command[key].as_u64().and_then(|value| u32::try_from(value).ok()).ok_or("INVALID_ARGUMENT")
}

/// Host adapter only: the trusted application supplies the root-verified roster.
/// No enrollment, account token, business permission or UI policy lives here.
pub struct NativeEngine {
    crypto: NativeCrypto,
    device_id: String,
    enhanced_transport: bool,
    endpoint: Endpoint<NativeCrypto, Address>,
    admitted: Rc<RefCell<BTreeMap<[u8; 32], u32>>>,
    /// Relay link ↔ the device's tag in relay UDP packets, from the admitted peers' relay device ids.
    relay_tags: BTreeMap<u32, [u8; 8]>,
    relay_links: BTreeMap<[u8; 8], u32>,
    relay_udp: Option<RelayUdp>,
    stun: Option<Stun>,
    local_streams: BTreeMap<u32, BTreeSet<u32>>,
    udp: Option<UdpSocket>,
    clock: Instant,
    now: u64,
    streams: BTreeMap<u32, BTreeSet<u32>>,
    finishing: BTreeMap<u32, BTreeSet<u32>>,
    poisoned: bool,
    media: crate::media::MediaCrypto,
    media_http: Option<crate::media_http::MediaHttp>,
}

impl NativeEngine {
    pub(crate) fn new(crypto: NativeCrypto, device_id: String, udp_enabled: bool, enhanced_transport: bool) -> Result<Self, &'static str> {
        let mut endpoint = Endpoint::new(|| u32::from_le_bytes(NativeCrypto::random()));
        let admitted = Rc::new(RefCell::new(BTreeMap::<[u8; 32], u32>::new()));
        let roster = admitted.clone();
        let listener_crypto = crypto.clone();
        endpoint.listen(PROLOGUE, Self::config(enhanced_transport), &[], move || listener_crypto.clone(),
            move |incoming: &Incoming<NativeCrypto>, from| {
                let roster = roster.borrow();
                let Some(link) = roster.get(incoming.remote_static()) else { return false; };
                !matches!(from, Address::Link(actual) if actual != *link)
            });
        let udp = if udp_enabled {
            let socket = UdpSocket::bind("0.0.0.0:0").map_err(|_| "UDP_BIND_FAILED")?;
            socket.set_nonblocking(true).map_err(|_| "UDP_SETUP_FAILED")?;
            Some(socket)
        } else { None };
        Ok(Self { crypto, device_id, enhanced_transport, endpoint, admitted, relay_tags: BTreeMap::new(), relay_links: BTreeMap::new(), relay_udp: None,
            stun: None, local_streams: BTreeMap::new(), udp, clock: Instant::now(), now: 0,
            streams: BTreeMap::new(), finishing: BTreeMap::new(), poisoned: false, media: Default::default(), media_http: None })
    }
    fn config(enhanced_transport: bool) -> Config {
        if !enhanced_transport { return Config { max_packet_size: MAX_PACKET_SIZE, ..Config::default() }; }
        Config { max_packet_size: MAX_PACKET_SIZE, send_packet_size: SEND_PACKET_SIZE, send_window: SEND_WINDOW, recv_window: SEND_WINDOW,
            send_buffer_bytes: SEND_BUFFER_BYTES, ..Config::for_policy(RecoveryPolicy::Auto) }
    }
    fn update_clock(&mut self) {
        self.now = self.now.max(self.clock.elapsed().as_micros().min(u64::MAX as u128) as u64);
    }
    pub fn command(&mut self, command: &Value) -> Result<Value, &'static str> {
        if self.poisoned { return Err("NATIVE_ENGINE_FAILURE"); }
        self.update_clock();
        if text(command, "op")? == "httpMediaStart" {
            if self.media_http.is_some() { return Err("MEDIA_HTTP_EXISTS"); }
            let (server, response) = crate::media_http::MediaHttp::start(command)?;
            self.media_http = Some(server); return Ok(response);
        }
        if text(command, "op")? == "httpMediaStop" { self.media_http = None; return Ok(Value::Null); }
        if text(command, "op")?.starts_with("httpMedia") {
            return self.media_http.as_ref().ok_or("MEDIA_HTTP_CLOSED")?.command(command);
        }
        if text(command, "op")?.starts_with("media") { return self.media.command(&self.crypto, command); }
        match text(command, "op")? {
            "identity" => Ok(json!({"deviceId":self.device_id,"signingKey":encoded(self.crypto.signing_public()),
                "transportKey":encoded(&self.crypto.static_public()),"udpPort":self.udp.as_ref().and_then(|s| s.local_addr().ok()).map(|a|a.port()),
                "features":if self.enhanced_transport { FEATURES.as_slice() } else { &[] }})),
            "sign" => {
                let value = text(command, "text")?;
                if value.len() > 65_536 { return Err("SIGNING_INPUT_TOO_LARGE"); }
                Ok(json!(encoded(&self.crypto.sign(value.as_bytes()))))
            },
            "verify" => Ok(json!(NativeCrypto::verify(&bytes(&command["key"])?,
                text(command, "text")?.as_bytes(), &bytes(&command["signature"])?))),
            "random" => Ok(json!(encoded(&NativeCrypto::random::<32>()))),
            "notificationKey" => Ok(json!({"secret":encoded(&self.crypto.notification_secret()),
                "encryptionKey":encoded(&self.crypto.notification_public())})),
            "notificationOpen" => crate::notification::open(command),
            "notificationSeal" => crate::notification::seal(&self.crypto, command),
            "admit" => self.replace_admission(command),
            "connect" => {
                if self.endpoint.ids().count() >= MAX_CONNECTIONS { return Err("CONNECTION_LIMIT"); }
                let remote: [u8; 32] = bytes(&command["key"])?.try_into().map_err(|_| "INVALID_PUBLIC_KEY")?;
                let to = address(&command["address"])?;
                let admitted = self.admitted.borrow();
                let link = admitted.get(&remote).ok_or("PEER_NOT_ADMITTED")?;
                if matches!(to, Address::Link(actual) if actual != *link) { return Err("PEER_ADDRESS_MISMATCH"); }
                drop(admitted);
                let id = self.endpoint.connect(self.now, self.crypto.clone(), Self::config(self.enhanced_transport), PROLOGUE,
                    &remote, &[], to).map_err(|_| "CONNECT_FAILED")?;
                Ok(json!(id))
            },
            "datagram" => {
                let from = address(&command["from"])?;
                // UDP is read directly from the bound socket. JS may inject only
                // authenticated relay channels, never spoof a UDP source address.
                let Address::Link(link) = from else { return Err("INVALID_RELAY_ADDRESS"); };
                if !self.admitted.borrow().values().any(|id| *id == link) { return Err("PEER_NOT_ADMITTED"); }
                let data = bytes(&command["data"])?;
                if data.len() > IO_SIZE { return Err("DATAGRAM_TOO_LARGE"); }
                self.endpoint.on_datagram(self.now, from, &data);
                Ok(Value::Null)
            },
            "openStream" => {
                let priority = match command["priority"].as_str().unwrap_or("normal") {
                    "interactive" => Priority::Interactive, "normal" => Priority::Normal,
                    "background" => Priority::Background, _ => return Err("INVALID_PRIORITY"),
                };
                let id = number(command, "id")?;
                let connection = self.endpoint.connection_mut(id).ok_or("CONNECTION_CLOSED")?;
                let stream = connection.open_stream(priority).ok_or("STREAM_LIMIT")?;
                if self.enhanced_transport {
                    let reported = self.local_streams.entry(id).or_default();
                    if reported.len() < MAX_REPORTED_STREAMS { reported.insert(stream); }
                }
                Ok(json!(stream))
            },
            "write" => {
                let data = bytes(&command["data"])?;
                if data.len() > IO_SIZE { return Err("WRITE_TOO_LARGE"); }
                let connection = self.endpoint.connection_mut(number(command, "id")?).ok_or("CONNECTION_CLOSED")?;
                Ok(json!(connection.send_stream(self.now, number(command, "stream")?, &data)))
            },
            "finish" => {
                let connection = self.endpoint.connection_mut(number(command, "id")?).ok_or("CONNECTION_CLOSED")?;
                Ok(json!(connection.finish_stream(number(command, "stream")?)))
            },
            "close" => {
                let id = number(command, "id")?;
                self.streams.remove(&id);
                self.finishing.remove(&id);
                self.local_streams.remove(&id);
                Ok(json!(self.endpoint.close(id).is_some()))
            },
            "probe" => Ok(json!(self.endpoint.probe(self.now, number(command, "id")?, address(&command["address"])?))),
            "migrate" => {
                // A new network: connections send from the new address at once; ask STUN again for the new outside address.
                self.endpoint.on_local_address_change(self.now);
                if let Some(stun) = &mut self.stun { stun.restart(); }
                Ok(Value::Null)
            },
            "stun" => {
                if self.udp.is_none() { return Err("UDP_DISABLED"); }
                let servers = command["servers"].as_array().filter(|all| all.len() <= udp_paths::MAX_STUN_SERVERS).ok_or("INVALID_STUN_SERVERS")?;
                let parsed = servers.iter().map(|server| server.as_str().and_then(udp_paths::split_host_port).ok_or("INVALID_STUN_SERVERS"))
                    .collect::<Result<Vec<_>, _>>()?;
                self.stun = (!parsed.is_empty()).then(|| Stun::new(&parsed));
                Ok(Value::Null)
            },
            "relayUdp" => self.configure_relay_udp(command),
            "poll" => self.poll(),
            _ => Err("UNKNOWN_NATIVE_OPERATION"),
        }
    }
    /// The relay's UDP address and this relay session's credentials (`{server, session, key}`), or `{server: null}`.
    /// Credentials change whenever the relay WebSocket reconnects; until a registration is acknowledged everything stays on it.
    fn configure_relay_udp(&mut self, command: &Value) -> Result<Value, &'static str> {
        let Some(server) = command["server"].as_str() else { self.relay_udp = None; return Ok(Value::Null); };
        if self.udp.is_none() { return Err("UDP_DISABLED"); }
        let credentials = if command["session"].is_null() { None } else {
            let session = bytes(&command["session"])?.try_into().map_err(|_| "INVALID_RELAY_UDP_CREDENTIALS")?;
            let key = zeroize::Zeroizing::new(bytes(&command["key"])?);
            let key = key.as_slice().try_into().map_err(|_| "INVALID_RELAY_UDP_CREDENTIALS")?;
            Some(Credentials { session, key })
        };
        if self.relay_udp.as_ref().is_none_or(|current| current.server_name != server) {
            self.relay_udp = Some(RelayUdp::new(server).ok_or("INVALID_RELAY_UDP_SERVER")?);
        }
        self.relay_udp.as_mut().expect("set above").set_credentials(credentials);
        Ok(Value::Null)
    }
    fn replace_admission(&mut self, command: &Value) -> Result<Value, &'static str> {
        let entries = command["peers"].as_array().filter(|p| p.len() <= MAX_PEERS).ok_or("INVALID_PEER_LIST")?;
        let mut next = BTreeMap::new();
        let mut links = BTreeSet::new();
        let (mut tags, mut tagged) = (BTreeMap::new(), BTreeMap::new());
        for peer in entries {
            let key: [u8; 32] = bytes(&peer["key"])?.try_into().map_err(|_| "INVALID_PUBLIC_KEY")?;
            let link = number(peer, "link")?;
            if link == 0 || next.insert(key, link).is_some() || !links.insert(link) { return Err("DUPLICATE_PEER"); }
            // Older JS sends no relay device id: that peer stays on the relay WebSocket.
            if let Some(relay_id) = peer["relayId"].as_str() {
                if relay_id.is_empty() || relay_id.len() > 256 { return Err("INVALID_RELAY_ID"); }
                let tag = udp_paths::peer_hash(relay_id);
                tags.insert(link, tag);
                tagged.insert(tag, link);
            }
        }
        let removed: Vec<u32> = self.endpoint.ids().filter(|id| self.endpoint.connection(*id)
            .is_some_and(|c| !next.contains_key(c.remote_static())
                || next.get(c.remote_static()) != self.admitted.borrow().get(c.remote_static()))).collect();
        *self.admitted.borrow_mut() = next;
        self.relay_tags = tags;
        self.relay_links = tagged;
        for id in removed { self.endpoint.close(id); self.streams.remove(&id); self.finishing.remove(&id); self.local_streams.remove(&id); }
        Ok(Value::Null)
    }
    pub(crate) fn poison(&mut self) { self.poisoned = true; }
    fn poll(&mut self) -> Result<Value, &'static str> {
        let mut io = [0u8; IO_SIZE];
        let now = self.now;
        if let Some(socket) = &self.udp {
            for _ in 0..256 {
                match socket.recv_from(&mut io) {
                    Ok((len, from)) => {
                        let packet = &io[..len];
                        // Relay UDP and STUN answers share this port; like the Desktop driver's `intercept`, they never reach the core.
                        if let Some(relay) = &mut self.relay_udp {
                            match relay.intercept(now, socket, packet) {
                                Intercepted::NotRelay => {},
                                Intercepted::Consumed => continue,
                                Intercepted::Deliver(source, datagram) => {
                                    // Only a peer admitted right now: anyone else's relayed datagram is dropped here.
                                    if let Some(link) = self.relay_links.get(&source) { self.endpoint.on_datagram(now, Address::Link(*link), datagram); }
                                    continue;
                                },
                            }
                        }
                        if self.stun.as_mut().is_some_and(|stun| stun.intercept(packet)) { continue; }
                        self.endpoint.on_datagram(now, Address::Udp(from), packet);
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => break,
                }
            }
            if let Some(relay) = &mut self.relay_udp { relay.tick(now, socket); }
            if let Some(stun) = &mut self.stun { stun.tick(now, socket, NativeCrypto::random::<12>); }
        }
        self.endpoint.tick(now);
        let mut packets = Vec::new();
        for _ in 0..128 {
            let Some((len, to)) = self.endpoint.poll_transmit(now, &mut io) else { break; };
            match to {
                Address::Udp(to) => { if let Some(socket) = &self.udp { let _ = socket.send_to(&io[..len], to); } },
                Address::Link(link) => {
                    let over_udp = match (&mut self.relay_udp, &self.udp, self.relay_tags.get(&link)) {
                        (Some(relay), Some(socket), Some(tag)) => relay.send(now, socket, tag, &io[..len]),
                        _ => false,
                    };
                    if !over_udp { packets.push(json!({"link":link,"data":encoded(&io[..len])})); }
                },
            }
        }
        let mut accepted = Vec::new();
        while accepted.len() < 32 {
            let Some(id) = self.endpoint.accept() else { break; };
            if self.endpoint.ids().count() > MAX_CONNECTIONS { self.endpoint.close(id); }
            else { accepted.push(id); }
        }
        let ids: Vec<u32> = self.endpoint.ids().take(MAX_CONNECTIONS).collect();
        let mut connections = Vec::new();
        let mut remaining = 256 * 1024;
        let mut event_budget = 256;
        let mut overflowed = Vec::new();
        for id in ids {
            let path = self.endpoint.peer_addr(id).map(address_value);
            let Some(connection) = self.endpoint.connection_mut(id) else { continue; };
            let streams = self.streams.entry(id).or_default();
            let finishing = self.finishing.entry(id).or_default();
            let mut events = Vec::new();
            while event_budget > 0 {
                let Some(event) = connection.poll_event() else { break; };
                event_budget -= 1;
                match event {
                    StreamEvent::Opened(stream) => { streams.insert(stream); events.push(json!({"kind":"open","stream":stream})); },
                    StreamEvent::Finished(stream) => { finishing.insert(stream); },
                }
            }
            if streams.len() > 128 { overflowed.push(id); continue; }
            let mut data = Vec::new();
            let mut completed = Vec::new();
            for stream in streams.iter().copied() {
                while remaining > 0 {
                    let limit = remaining.min(io.len());
                    let len = connection.recv_stream(self.now, stream, &mut io[..limit]);
                    if len == 0 {
                        if finishing.contains(&stream) { completed.push(stream); }
                        break;
                    }
                    data.push(json!({"stream":stream,"data":encoded(&io[..len])}));
                    remaining -= len;
                }
            }
            for stream in completed {
                streams.remove(&stream); finishing.remove(&stream);
                events.push(json!({"kind":"finish","stream":stream}));
            }
            let stats = connection.stats();
            let security = connection.security_stats();
            // Bytes still in the core's send buffer per stream this side opened (not sent yet, or sent and unacknowledged): the
            // session's backlog reading counts them, as the Desktop's does (transport.ts `coreBufferedBytes`).
            let buffered: Vec<Value> = self.local_streams.get(&id).into_iter().flatten()
                .map(|stream| json!([stream, connection.stream_buffered(*stream)])).collect();
            connections.push(json!({"id":id,"established":connection.is_established(),"dead":connection.is_dead(),
                "closedByPeer":connection.closed_by_peer(),"remoteKey":encoded(connection.remote_static()),
                "unacked":connection.connection().has_unacked_data(),
                "path":path,"events":events,"data":data,"rttUs":stats.srtt_us,"buffered":buffered,
                "rotations":security.connection_id_rotations,"received":stats.wire_bytes_received,"sent":stats.wire_bytes_sent}));
        }
        for id in overflowed { self.endpoint.close(id); }
        let live: BTreeSet<u32> = self.endpoint.ids().collect();
        self.streams.retain(|id,_| live.contains(id));
        self.finishing.retain(|id,_| live.contains(id));
        self.local_streams.retain(|id,_| live.contains(id));
        let mapped: Vec<Value> = self.stun.as_ref().map(Stun::mapped).unwrap_or_default().into_iter()
            .map(|address| json!({"address":address.ip().to_string(),"port":address.port()})).collect();
        Ok(json!({"packets":packets,"accepted":accepted,"connections":connections,"mapped":mapped,
            "relayUdp":self.relay_udp.as_ref().is_some_and(|relay| relay.up(now))}))
    }
}
