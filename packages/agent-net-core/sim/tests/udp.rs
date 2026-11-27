//! 测试价值
//! - 生产入口与可观察结果：`agent_net_udp::Endpoint` 的 `connect` / `listen` / `poll` / `rebind`，在本机回环的真实 UDP 套接字和
//!   真实时钟上断言：几条连接共用一个端口各收各的数据，客户端换了端口（知道和不知道两种）以后服务端按连接号找到它、
//!   验证新地址、把数据换过去，数据完整。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 5 步（真实 UDP 和网络切换）。驱动层第一次接上真实套接字，模拟器里的路径号
//!   在这里要变成真实地址，按连接号分发、Windows 上 ICMP 引起的收包错误、换端口后旧套接字的处理都只有这里测得到。
//! - 现有覆盖缺口：`migration.rs` 只在模拟器里换地址，`sim/src/bin/migrate.rs` 是要手动跑的公网测试。
//! - 最小失败输入：固定的两个场景，数据量写在用例里。
//! - tier：Rust integration，本机回环上的真实 UDP 和真实时钟，不访问外网。计时只设宽松的上限，不比快慢。
//! - 实测耗时：2026-11-05，Windows 本机 0.1–1.1 秒（不含编译）：不告诉连接的那次换端口，要看那一刻有没有确认要发，没有就等安静 1 秒后的探测。

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use agent_net_core::Config;
use agent_net_sim::crypto::{AesGcm, TestCrypto};
use agent_net_udp::Endpoint;

type Crypto = TestCrypto<AesGcm>;

const PROLOGUE: &[u8] = b"agent-net-udp-test/1";

fn byte(stream: u64, index: u64) -> u8 {
    ((index ^ stream).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8
}

fn loopback() -> SocketAddr {
    "127.0.0.1:0".parse().expect("address")
}

fn server() -> Endpoint<Crypto> {
    let mut server = Endpoint::<Crypto>::bind(loopback(), 1400).expect("bind");
    let identity = Crypto::from_seed(90).secret_bytes();
    let mut connections = 0;
    server.listen(
        PROLOGUE,
        Config::default(),
        b"",
        move || {
            connections += 1;
            Crypto::from_secret(identity, connections)
        },
        |_, _| true,
    );
    server
}

/// 双方各自的一端：要发的流、已经发出和收到的字节。
struct Side {
    stream: u64,
    to_send: u64,
    sent: u64,
    received: u64,
}

impl Side {
    fn pump(&mut self, endpoint: &mut Endpoint<Crypto>, id: u32, peer_stream: u64) {
        let now = endpoint.now_us();
        let Some(connection) = endpoint.connection_mut(id) else { return };
        let mut chunk = [0u8; 8192];
        while self.sent < self.to_send {
            let size = chunk.len().min((self.to_send - self.sent) as usize);
            for (offset, value) in chunk[..size].iter_mut().enumerate() {
                *value = byte(self.stream, self.sent + offset as u64);
            }
            let accepted = connection.send(now, &chunk[..size]);
            self.sent += accepted as u64;
            if accepted < size {
                break;
            }
        }
        loop {
            let size = connection.recv(now, &mut chunk);
            if size == 0 {
                break;
            }
            for (offset, &value) in chunk[..size].iter().enumerate() {
                assert_eq!(value, byte(peer_stream, self.received + offset as u64), "byte {} of stream {peer_stream}", self.received + offset as u64);
            }
            self.received += size as u64;
        }
    }
}

/// 三个客户端连同一个服务端口，各自双向传 1 MB：每条连接只收到发给自己的数据，连接号各不相同，没有认不出的包。
#[test]
fn connections_share_one_port() {
    let mut server = server();
    let address = server.local_addr().expect("server address");
    let public = Crypto::from_seed(90).public();
    let mut clients: Vec<(Endpoint<Crypto>, u32, Side)> = (0..3)
        .map(|index| {
            let mut endpoint = Endpoint::<Crypto>::bind(loopback(), 1400).expect("bind");
            let id = endpoint.connect(Crypto::from_seed(91 + index), Config::default(), PROLOGUE, &public, &[index as u8], address).expect("connect");
            (endpoint, id, Side { stream: 100 + index, to_send: 1 << 20, sent: 0, received: 0 })
        })
        .collect();
    let mut accepted: Vec<(u32, Side, u64)> = Vec::new();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        for (endpoint, id, side) in &mut clients {
            endpoint.poll(Duration::from_millis(1)).expect("client poll");
            side.pump(endpoint, *id, side.stream + 100);
        }
        server.poll(Duration::from_millis(1)).expect("server poll");
        while let Some(id) = server.accept() {
            let index = server.connection(id).and_then(|connection| connection.remote_payload()).expect("payload")[0] as u64;
            accepted.push((id, Side { stream: 200 + index, to_send: 1 << 20, sent: 0, received: 0 }, 100 + index));
        }
        for (id, side, peer_stream) in &mut accepted {
            side.pump(&mut server, *id, *peer_stream);
        }
        let done = accepted.len() == 3 && accepted.iter().all(|(_, side, _)| side.received == 1 << 20) && clients.iter().all(|(_, _, side)| side.received == 1 << 20);
        if done {
            break;
        }
    }
    assert_eq!(accepted.len(), 3);
    for (_, side, _) in &accepted {
        assert_eq!(side.received, 1 << 20);
    }
    for (_, _, side) in &clients {
        assert_eq!(side.received, 1 << 20);
    }
    let mut ids: Vec<u32> = accepted.iter().map(|(id, _, _)| *id).collect();
    ids.dedup();
    assert_eq!(ids.len(), 3);
    assert_eq!(server.stats().unknown_destination, 0);
}

/// 下载途中客户端换了两次端口：第一次告诉连接，第二次不告诉（和 NAT 换端口一样）。服务端两次都按连接号认出它、
/// 验证新地址后把数据换过去，最后发往的就是客户端现在的端口，数据完整。不告诉的那次要等客户端安静 1 秒后探测，
/// 整个过程 15 秒内完成。回环上 IP 不变，驱动要认出这两次都只换了端口，服务端换过去时不重量往返和带宽。
#[test]
fn a_rebound_client_is_followed() {
    let mut server = server();
    let address = server.local_addr().expect("server address");
    let mut client = Endpoint::<Crypto>::bind(loopback(), 1400).expect("bind");
    let id = client.connect(Crypto::from_seed(95), Config::default(), PROLOGUE, &Crypto::from_seed(90).public(), &[], address).expect("connect");
    let bytes = 16u64 << 20;
    let mut down = Side { stream: 7, to_send: 0, sent: 0, received: 0 };
    let mut serving: Option<(u32, Side)> = None;
    let mut rebinds = [(bytes / 3, true), (2 * bytes / 3, false)].into_iter().peekable();
    let started = Instant::now();
    while down.received < bytes && started.elapsed() < Duration::from_secs(15) {
        client.poll(Duration::from_millis(1)).expect("client poll");
        down.pump(&mut client, id, 8);
        server.poll(Duration::from_millis(1)).expect("server poll");
        if let Some(accepted) = server.accept() {
            serving = Some((accepted, Side { stream: 8, to_send: bytes, sent: 0, received: 0 }));
        }
        if let Some((accepted, side)) = &mut serving {
            side.pump(&mut server, *accepted, 7);
        }
        if let Some(&(at, notify)) = rebinds.peek()
            && down.received >= at
        {
            rebinds.next();
            client.rebind(loopback(), notify).expect("rebind");
        }
    }
    assert_eq!(down.received, bytes, "stuck after {:?}", started.elapsed());
    let (accepted, _) = serving.expect("accepted");
    let security = server.connection(accepted).expect("server connection").security_stats();
    assert_eq!((security.migrations, security.path_failures, security.port_migrations), (2, 0, 2), "{security:?}");
    assert_eq!(server.peer_addr(accepted), Some(client.local_addr().expect("client address")));
    assert_eq!(client.stats().rebinds, 2);
}
