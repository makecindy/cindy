//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::SecureConnection` 的 `on_packet_via` / `poll_transmit_via` /
//!   `on_local_address_change` 和 `destination_id`。断言客户端换网络以后连接不断、数据完整、多久恢复、新路径上的速度，
//!   验证通过前发往新地址的字节不超过从那里收到的三倍，从别的地址注入的包改变不了任何东西，验证失败时回到旧路径，
//!   空闲的连接不会一直发探测，每个包都被抢先复制时服务端照样跟到客户端真的新地址。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 5 步过关标准（Wi-Fi 切蜂窝不断线），`docs/product-rules/agent-net.md`
//!   硬性规则 1（端到端加密）。2026-11-05 写这些用例时查出四个问题，各有用例守着：客户端没察觉换了网络时，往返变长到超过
//!   重传超时，每个包都先被判丢、超时永远追不上，上传要 76 秒（应为 5 秒，见 `switching_networks_keeps_the_connection`）；
//!   对端发来的路径验证被当成“对端收得到”，客户端停止探测，服务端回到旧地址后两边都不再说话（`random_moves_deliver_intact_streams`
//!   的种子 22）；只收到过确认就以为对端空闲，NAT 换了端口后再也不探测（种子 131）；抢先送到的复制包每次都让服务端
//!   重置拥塞状态，八个包复制一个就让下载慢九倍（`spoofed_copies_cannot_amplify_or_hijack`）。之后新种子里又查出一个：
//!   不知道换了网络、只在下载的一端，安静探测的间隔翻到 4 秒，丢包三成的新网络上约 1% 的连接会断（种子 921733），
//!   断网 5 秒的要 3.15 秒才恢复（`switching_networks_keeps_the_connection` 断网 6.5 秒那组）；客户端真换了网络、
//!   路上的人又把每个包（或者恰好每批最新的那个）抢先复制时，新地址来的真包都成了重复包，服务端验证不到新地址，
//!   连接断在旧路径上（`copies_of_every_packet_do_not_strand_a_moved_client`、种子 920202）。
//! - 现有覆盖缺口：`secure.rs` 里两端的地址从不改变，`reliability.rs` 只测明文连接，而明文连接不能换路径。
//! - 最小失败输入：随机矩阵打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放；其余用例的输入都写在用例里。
//! - tier：Rust integration，虚拟时间，无真实网络。地址是模拟器编的号（`sim/src/migration.rs`），真实网卡、
//!   系统换网通知和 NAT 行为要在真机上测，见 `docs/agent-net-plan.md` 第 5 步。
//! - 实测耗时：2026-11-05，Windows 本机默认 100 个随机种子加 6 个固定种子，整个文件 5.4 秒（不含编译）；
//!   `AGENT_NET_SEEDS=10000` 时 381 秒，记录见 `sim/results/2026-11-05-migration/`。
//!   2026-11-07 加上 306 个场景各跑有号／无号两遍的矩阵，整个 integration 文件 16.56 秒；
//!   该矩阵用于协议／时序和性能对照，保留在 Rust 专用 integration tier，不进入 JS 默认 unit。
//! - 测试本身的有效性由 `sim/mutants.py` 验证：注入已知 bug，这里必须变红。

use std::collections::VecDeque;

use agent_net_core::{Config, Incoming, PacketError, SecureConnection, destination_id, is_initiation};
use agent_net_sim::LinkProfile;
use agent_net_sim::crypto::{AesGcm, PROLOGUE, TestCrypto};
use agent_net_sim::migration::{Attack, Move, Report, Scenario, random_scenario, run_moves, run_rotating_moves};

fn wifi() -> LinkProfile {
    LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() }
}

/// 比 Wi-Fi 慢五倍、往返长三倍多，还有一点丢包。
fn cellular() -> LinkProfile {
    LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() }
}

fn config() -> Config {
    Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() }
}

fn scenario(up: LinkProfile, down: LinkProfile, moves: Vec<Move>, upload_bytes: u64, download_bytes: u64, attack: Attack) -> Scenario {
    Scenario { seed: 1, config: config(), up, down, moves, upload_bytes, download_bytes, attack, time_limit_us: 600_000_000 }
}

/// 验证通过前发往每个地址的字节都不超过从那里收到的三倍，攻击者的地址也一样。
fn amplification_bounded(report: &Report) -> bool {
    report.attacker_sent <= 3 * report.attacker_received && report.unvalidated.values().all(|&(sent, received)| sent <= 3 * received)
}

/// 换网以后、恢复之后的平均速度，Mbit/s。
fn rate_after_move(scenario: &Scenario, report: &Report) -> f64 {
    let step = &scenario.moves[0];
    let delivered = report.delivered_at_moves[0];
    let left = (scenario.upload_bytes - delivered[0]) + (scenario.download_bytes - delivered[1]);
    let recovery = report.recoveries_us[0].unwrap_or(0);
    left as f64 * 8.0 / (report.finish_us - step.at_us - recovery) as f64
}

fn describe(report: &Report) -> String {
    format!(
        "finished={} at {}us violation={:?} recoveries={:?} unvalidated={:?} attacker={}/{} spurious={} server={:?}",
        report.finished,
        report.finish_us,
        report.violation,
        report.recoveries_us,
        report.unvalidated,
        report.attacker_sent,
        report.attacker_received,
        report.spurious_wakes,
        report.server.map(|(security, _)| security)
    )
}

/// Wi-Fi 切蜂窝：中间断网 0、1、3、6.5 秒，客户端知道或不知道自己换了网络，上传、下载、双向各一遍。
/// 都要传完、数据完整，服务端跟到新地址并验证通过，不回旧路径。知道换了网络的马上发包，恢复要在 0.4 秒以内（新路径约
/// 两个往返）；不知道的、又只在下载的客户端要等对端安静 1 秒才探测，之后每秒一次，断网多久都在 1.5 秒以内恢复。
/// 以前探测间隔翻倍（第 1、2、4、8 秒），断网 6.5 秒的要等到第 8 秒，1.65 秒（断网 5 秒的 3.15 秒）；
/// 最多翻到 2 倍时也是 1.65 秒。恢复以后新路径要跑到 10 Mbit/s 的
/// 七成半以上：不知道换了网络的客户端旧的往返和带宽估计还在，修好之前上传只有 5.3 Mbit/s，断过网的要 76 秒才传完。
#[test]
fn switching_networks_keeps_the_connection() {
    for outage_us in [0, 1_000_000, 3_000_000, 6_500_000] {
        for noticed in [true, false] {
            for (upload, download) in [(12_000_000, 1), (0, 12_000_000), (10_000_000, 10_000_000)] {
                let step = Move { at_us: 1_500_000 + outage_us, outage_us, up: cellular(), down: cellular(), noticed, same_route: false };
                let case = scenario(wifi(), wifi(), vec![step], upload, download, Attack::None);
                let report = run_moves(&case);
                let label = format!("outage {outage_us}us, noticed {noticed}, up {upload}, down {download}");
                assert!(report.finished, "{label}: {}", describe(&report));
                let (server, _) = report.server.expect("server");
                assert_eq!((server.migrations, server.path_failures), (1, 0), "{label}: {}", describe(&report));
                assert_eq!(report.server_path, 1, "{label}");
                assert_eq!(report.spurious_wakes, 0, "{label}");
                assert!(amplification_bounded(&report), "{label}: {}", describe(&report));
                let limit = if noticed || upload > 0 { 400_000 } else { 1_500_000 };
                let recovery = report.recoveries_us[0].expect("recovered");
                assert!(recovery <= limit, "{label}: recovered after {recovery}us");
                let rate = rate_after_move(&case, &report);
                assert!(rate >= 7.5, "{label}: {rate:.1} Mbit/s on the new path");
            }
        }
    }
}

/// 换到快得多或慢得多的网络：往返、带宽都按新路径从头量，从 100 Mbit/s 换到 5 Mbit/s 不会按旧速度一直冲爆队列，
/// 从 5 Mbit/s 换到 100 Mbit/s 也不被旧估计压着。两种都要跑到新线路的 85% 以上。
#[test]
fn the_new_path_is_measured_from_scratch() {
    let link = |rate| LinkProfile { bits_per_second: rate, delay_us: 20_000, queue_us: 40_000, ..LinkProfile::default() };
    for (from, to) in [(100_000_000u64, 5_000_000u64), (5_000_000, 100_000_000)] {
        for noticed in [true, false] {
            let step = Move { at_us: 2_000_000, outage_us: 0, up: link(to), down: link(to), noticed, same_route: false };
            let case = scenario(link(from), link(from), vec![step], 0, 40_000_000, Attack::None);
            let report = run_moves(&case);
            assert!(report.finished, "{from}->{to}: {}", describe(&report));
            let rate = rate_after_move(&case, &report) * 1e6;
            assert!(rate >= 0.85 * to as f64, "{from}->{to}, noticed {noticed}: {:.1} Mbit/s", rate / 1e6);
        }
    }
}

/// NAT 只换了外部端口（来源 IP 不变、链路不变）：驱动告诉核心以后，验证通过时往返和带宽照旧，不从启动阶段重新冲；
/// 验证包带上标记，被验证的一端也不重量，验证期间收不到确认也不判超时；换过去的那一刻马上补一个确认。
/// 上传时客户端一直在发，服务端马上看到新端口：换两次端口和不换差不多。下载时客户端不知道自己换了端口，
/// 要等安静 1 秒后探测，这里只看换过去时估计保留住了。
#[test]
fn port_only_changes_keep_the_estimates() {
    let links = [wifi(), cellular(), LinkProfile { bits_per_second: 100_000_000, delay_us: 20_000, jitter_us: 2_000, queue_us: 40_000, ..LinkProfile::default() }];
    for (index, link) in links.iter().enumerate() {
        for (upload, download) in [(20_000_000u64, 1u64), (0, 20_000_000)] {
            let label = format!("link {index}, up {upload}, down {download}");
            let moves = [600_000u64, 1_200_000].map(|at_us| Move { at_us, outage_us: 0, up: link.clone(), down: link.clone(), noticed: false, same_route: true }).to_vec();
            let report = run_moves(&scenario(link.clone(), link.clone(), moves, upload, download, Attack::None));
            let still = run_moves(&scenario(link.clone(), link.clone(), Vec::new(), upload, download, Attack::None));
            assert!(report.finished && still.finished, "{label}: {}", describe(&report));
            let (server, server_stats) = report.server.expect("server");
            let (_, client_stats) = report.client.expect("client");
            let still_retx = still.client.map_or(0, |(_, s)| s.retransmitted_segments) + still.server.map_or(0, |(_, s)| s.retransmitted_segments);
            assert_eq!(server.path_failures, 0, "{label}");
            assert!(server.migrations >= 1 && server.port_migrations == server.migrations, "{label}: {}", describe(&report));
            if upload > 0 {
                // 2026-11-05：Wi-Fi、蜂窝、100M 三条链路上换两次端口，重传 40 / 236 / 280，不换时 37 / 251 / 271；
                // 用时 +1.6% / −3% / +5.9%。从头量时 Wi-Fi 上重传 160 左右；不暂缓超时时蜂窝上客户端超时判丢上百个。
                let retransmitted = client_stats.retransmitted_segments + server_stats.retransmitted_segments;
                assert_eq!(server.port_migrations, 2, "{label}");
                assert!(retransmitted <= still_retx + still_retx / 4 + 20, "{label}: {retransmitted} retransmitted, {still_retx} without moving");
                assert!(report.finish_us <= still.finish_us + still.finish_us / 10, "{label}: {}us, {}us without moving", report.finish_us, still.finish_us);
                assert!(client_stats.timeout_losses <= 30, "{label}: {} timeout losses", client_stats.timeout_losses);
            }
        }
    }
}

/// 从别的地址送来录下的旧包、改过一位的包、随机内容：全部被拒，连接不验证那个地址，也不往那里发一个字节，
/// 传输和没有攻击时一样快。
#[test]
fn forged_and_replayed_packets_from_elsewhere_change_nothing() {
    for (upload, download) in [(8_000_000, 1), (0, 8_000_000)] {
        let baseline = run_moves(&scenario(wifi(), wifi(), vec![], upload, download, Attack::None));
        for every in [1, 16] {
            let report = run_moves(&scenario(wifi(), wifi(), vec![], upload, download, Attack::Inject { every }));
            let label = format!("up {upload}, down {download}, every {every}");
            assert!(report.finished, "{label}: {}", describe(&report));
            let (security, _) = report.server.expect("server");
            assert_eq!((security.path_challenges, security.migrations, report.attacker_sent), (0, 0, 0), "{label}");
            assert!(security.unauthenticated_packets > 0 && security.replayed_packets > 0, "{label}: {security:?}");
            // 重放的旧包要是当初在路上丢了，这时送到就和一个晚到的重传一样，所以只要求快慢不变。
            let ratio = report.finish_us as f64 / baseline.finish_us as f64;
            assert!((0.99..=1.01).contains(&ratio), "{label}: {ratio:.3} of the time without attack");
        }
    }
}

/// 路上的人把客户端的包复制一份，从自己的地址抢先送到：服务端去验证那个地址，发过去的只有验证包，不超过它送来的三倍，
/// 那里不回验证，数据就一直留在原路径上。时不时复制一个和每个包都复制，传输都照样完成、几乎不慢。
/// 修好之前服务端立刻跟过去：数据发进假地址，每次被带偏都重置拥塞状态，8 个复制一个下载慢 5.7 倍，每个都复制时连接断掉。
#[test]
fn spoofed_copies_cannot_amplify_or_hijack() {
    for (upload, download) in [(8_000_000, 1), (0, 8_000_000)] {
        let baseline = run_moves(&scenario(wifi(), wifi(), vec![], upload, download, Attack::None));
        for every in [64, 8, 1] {
            let report = run_moves(&scenario(wifi(), wifi(), vec![], upload, download, Attack::Race { every, lead_us: 5_000 }));
            let label = format!("up {upload}, down {download}, every {every}");
            assert!(report.finished, "{label}: {}", describe(&report));
            assert!(amplification_bounded(&report), "{label}: {}", describe(&report));
            let (security, _) = report.server.expect("server");
            assert!(security.path_challenges > 0, "{label}: the copies never won the race");
            assert_eq!((security.migrations, report.server_path), (0, 0), "{label}");
            let ratio = report.finish_us as f64 / baseline.finish_us as f64;
            assert!(ratio <= 1.05, "{label}: {ratio:.2} times slower");
        }
    }
}

/// 客户端真换了网络，路上的人又把每个包都抢先复制：新地址来的真包全成了复制包之后到的重复包。最新那个包的重复从新地址来时
/// 服务端也去验证那里，所以照样跟过去、传完，发往路上的人那里的字节不超过它送来的三倍。修好之前 6 种组合全断在旧路径上
/// （QUIC 也有这个问题，RFC 9000 §9.3.3）；每 8 个复制一个时，客户端每次恰好一批发 8 个包也会这样（种子 920202）。
#[test]
fn copies_of_every_packet_do_not_strand_a_moved_client() {
    for noticed in [true, false] {
        for (upload, download) in [(8_000_000, 1), (0, 8_000_000), (4_000_000, 4_000_000)] {
            let step = Move { at_us: 500_000, outage_us: 0, up: cellular(), down: cellular(), noticed, same_route: false };
            let report = run_moves(&scenario(wifi(), wifi(), vec![step], upload, download, Attack::Race { every: 1, lead_us: 5_000 }));
            let label = format!("noticed {noticed}, up {upload}, down {download}");
            assert!(report.finished, "{label}: {}", describe(&report));
            assert!(amplification_bounded(&report), "{label}: {}", describe(&report));
            let (security, _) = report.server.expect("server");
            assert_eq!((security.migrations, report.server_path), (1, 1), "{label}: {}", describe(&report));
        }
    }
}

const ONE_WAY_US: u64 = 10_000;

/// 两个加密端点直连，单程 10 毫秒，不丢包。服务端看到的客户端地址是 `client_path`，发往别的地址的包没人收。
struct Duo {
    now: u64,
    client: SecureConnection<TestCrypto>,
    server: SecureConnection<TestCrypto>,
    client_path: u64,
    /// 客户端发出的包要不要送到服务端。
    uplink: bool,
    /// （到达时间，发往服务端，路径，内容）
    in_flight: VecDeque<(u64, bool, u64, Vec<u8>)>,
    /// 线上的每个包：（发往服务端，路径，内容）
    wire: Vec<(bool, u64, Vec<u8>)>,
    received: [Vec<u8>; 2],
    spurious_wakes: u64,
}

impl Duo {
    fn new() -> Self {
        let client_config = Config { connection_id: 0x0C11_E000, ..Config::default() };
        let server_config = Config { connection_id: 0x05E7_F000, ..Config::default() };
        let listener = TestCrypto::<AesGcm>::from_seed(72);
        let mut client = SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(71), client_config, PROLOGUE, &listener.public(), &[], 0).expect("connect");
        let mut buffer = vec![0; 1400];
        let (size, _) = client.poll_transmit_via(0, &mut buffer).expect("initiation");
        let incoming = Incoming::read(&listener, PROLOGUE, &buffer[..size]).expect("read");
        let server = incoming.accept(listener, server_config, &[], ONE_WAY_US).expect("accept");
        let mut duo = Self {
            now: ONE_WAY_US,
            client,
            server,
            client_path: 0,
            uplink: true,
            in_flight: VecDeque::new(),
            wire: vec![(true, 0, buffer[..size].to_vec())],
            received: [Vec::new(), Vec::new()],
            spurious_wakes: 0,
        };
        assert!(duo.run_until(1_000_000, &|duo| duo.client.is_established() && duo.server.is_established()));
        duo
    }

    fn step(&mut self) {
        let mut buffer = vec![0; 1400];
        while let Some((size, path)) = self.client.poll_transmit_via(self.now, &mut buffer) {
            assert_eq!(path, 0, "the client only talks to the server's address");
            self.wire.push((true, self.client_path, buffer[..size].to_vec()));
            if self.uplink {
                self.in_flight.push_back((self.now + ONE_WAY_US, true, self.client_path, buffer[..size].to_vec()));
            }
        }
        while let Some((size, path)) = self.server.poll_transmit_via(self.now, &mut buffer) {
            self.wire.push((false, path, buffer[..size].to_vec()));
            self.in_flight.push_back((self.now + ONE_WAY_US, false, path, buffer[..size].to_vec()));
        }
        let mut chunk = [0u8; 4096];
        for (side, connection) in [&mut self.server, &mut self.client].into_iter().enumerate() {
            loop {
                let size = connection.recv(self.now, &mut chunk);
                if size == 0 {
                    break;
                }
                self.received[side].extend_from_slice(&chunk[..size]);
            }
        }
        let wakes = [self.client.next_wake(), self.server.next_wake()];
        self.spurious_wakes += wakes.iter().flatten().filter(|&&at| at <= self.now).count() as u64;
        let next = wakes.into_iter().flatten().chain(self.in_flight.front().map(|item| item.0)).min();
        self.now = next.unwrap_or(self.now + 1_000_000).max(self.now + 1);
        while self.in_flight.front().is_some_and(|item| item.0 <= self.now) {
            let (_, to_server, path, packet) = self.in_flight.pop_front().expect("in flight");
            if to_server {
                let _ = self.server.on_packet_via(self.now, path, &packet);
            } else if path == self.client_path {
                let _ = self.client.on_packet_via(self.now, 0, &packet);
            }
        }
        for connection in [&mut self.client, &mut self.server] {
            if connection.next_wake().is_some_and(|at| at <= self.now) {
                connection.tick(self.now);
            }
        }
    }

    fn run_until(&mut self, limit_us: u64, done: &dyn Fn(&Self) -> bool) -> bool {
        while self.now <= limit_us {
            if done(self) {
                return true;
            }
            self.step();
        }
        done(self)
    }

    fn upload(&mut self, data: &[u8]) {
        let want = self.received[0].len() + data.len();
        assert_eq!(self.client.send(self.now, data), data.len());
        assert!(self.run_until(self.now + 10_000_000, &|duo| duo.received[0].len() >= want), "upload stuck");
    }
}

/// 每个包都带着收包方的连接号，调用方按它找连接：请求没有，回复带发起方的号，数据包带对方的号。
/// 连接号被改过的包，即使送到了这条连接，也被拒收、不留下任何影响。
#[test]
fn every_packet_names_its_receiver() {
    let mut duo = Duo::new();
    duo.upload(b"hello");
    duo.server.send(duo.now, b"world");
    assert!(duo.run_until(duo.now + 1_000_000, &|duo| duo.received[1] == b"world"));
    let initiation = duo.wire.iter().find(|(_, _, packet)| is_initiation(packet)).expect("initiation");
    assert_eq!(destination_id(&initiation.2), None);
    let response = duo.wire.iter().find(|(to_server, _, packet)| !to_server && packet[0] == 0x82).expect("response");
    assert_eq!(destination_id(&response.2), Some(0x0C11_E000));
    let data: Vec<_> = duo.wire.iter().filter(|(_, _, packet)| packet[0] & 0xE0 == 0xA0).collect();
    assert!(data.iter().any(|(to_server, _, _)| *to_server) && data.iter().any(|(to_server, _, _)| !to_server));
    for (to_server, _, packet) in data {
        assert_eq!(destination_id(packet), Some(if *to_server { 0x05E7_F000 } else { 0x0C11_E000 }));
    }

    duo.client.send(duo.now, b"!");
    let mut buffer = vec![0; 1400];
    let (size, _) = duo.client.poll_transmit_via(duo.now, &mut buffer).expect("data");
    let mut renamed = buffer[..size].to_vec();
    renamed[3..7].copy_from_slice(&0x0BAD_0000u32.to_be_bytes());
    let before = duo.server.stats().packets_received;
    assert_eq!(duo.server.on_packet_via(duo.now, 0, &renamed), Err(PacketError::Unauthenticated));
    assert_eq!(duo.server.stats().packets_received, before);
    assert_eq!(duo.server.on_packet_via(duo.now, 0, &buffer[..size]), Ok(()));
}

/// 抢先送到的复制包让服务端去验证地址 7，那里没人。原路径的下一个包又成了最新的，服务端就放弃验证；
/// 客户端一直不说话时，服务端约 3 秒后放弃，之间不空转。两种情况下数据都一直在原地址上，发往地址 7 的
/// 只有验证包，不超过复制包的三倍；原包随后到达被当成重放，之后的数据照常收发。
#[test]
fn validation_of_a_spoofed_address_is_abandoned() {
    for client_keeps_talking in [true, false] {
        let mut duo = Duo::new();
        duo.upload(&[7; 50_000]);
        duo.server.send(duo.now, &[8; 50_000]);
        duo.client.send(duo.now, b"copied");
        duo.uplink = false;
        assert!(duo.run_until(duo.now + 1_000_000, &|duo| duo.wire.last().is_some_and(|(to_server, _, packet)| *to_server && packet[0] & 0xE0 == 0xA0)));
        let original = duo.wire.last().expect("client packet").2.clone();
        assert_eq!(duo.server.on_packet_via(duo.now, 7, &original), Ok(()));
        assert_eq!((duo.server.path(), duo.server.validating().collect::<Vec<_>>()), (0, vec![7]));

        duo.uplink = client_keeps_talking;
        let copied_at = duo.now;
        let abandoned = duo.run_until(copied_at + 4_000_000, &|duo| duo.server.validating().next().is_none());
        let label = format!("client keeps talking: {client_keeps_talking}");
        assert!(abandoned, "{label}: still validating after {}us", duo.now - copied_at);
        let limit = if client_keeps_talking { 100_000 } else { 3_100_000 };
        assert!(duo.now - copied_at <= limit, "{label}: abandoned after {}us", duo.now - copied_at);
        assert_eq!(duo.server.path(), 0, "{label}");
        let to_seven: usize = duo.wire.iter().filter(|(to_server, path, _)| !to_server && *path == 7).map(|(_, _, packet)| packet.len()).sum();
        assert!(to_seven > 0 && to_seven <= 3 * original.len(), "{label}: {to_seven} bytes sent to path 7 for a {}-byte packet", original.len());
        assert_eq!(duo.spurious_wakes, 0, "{label}");
        let security = duo.server.security_stats();
        assert_eq!((security.path_challenges, security.migrations, security.path_failures), (1, 0, !client_keeps_talking as u64), "{label}");

        duo.uplink = true;
        assert_eq!(duo.server.on_packet_via(duo.now, 0, &original), Err(PacketError::Replayed), "{label}");
        duo.upload(&[9; 100_000]);
        assert!(duo.run_until(duo.now + 5_000_000, &|duo| duo.received[1].len() == 50_000), "{label}");
        assert!(duo.received[0].ends_with(&[9; 100_000]), "{label}");
        assert_eq!(duo.server.security_stats().path_challenges, 1, "{label}");
    }
}

/// 传完以后两端都没事做：安静 1 秒后探测，对端回了以后只每 15 秒（判死时限的一半）一来一回，
/// 一分钟里线上不超过 12 个包，连接也不会因此判死。修好之前对端回过一次就再也不探测，对端的数据被挡掉、
/// 这一端又悄悄换了地址时两边失联（`random_moves_deliver_intact_streams` 的种子 901894）。
#[test]
fn idle_connections_only_keep_alive() {
    let mut duo = Duo::new();
    duo.upload(&[1; 200_000]);
    duo.server.send(duo.now, &[2; 200_000]);
    assert!(duo.run_until(duo.now + 10_000_000, &|duo| duo.received[1].len() == 200_000));
    assert!(duo.run_until(duo.now + 1_000_000, &|duo| duo.in_flight.is_empty()));
    let (packets, start) = (duo.wire.len(), duo.now);
    assert!(!duo.run_until(start + 60_000_000, &|_| false));
    let idle = &duo.wire[packets..];
    let shape: Vec<_> = idle.iter().map(|(to_server, _, packet)| (*to_server, packet.len())).collect();
    assert!((4..=12).contains(&idle.len()), "{} packets while idle: {shape:?}", idle.len());
    assert!(duo.client.is_established() && duo.server.is_established());
    assert_eq!(duo.spurious_wakes, 0);
}

/// 抓到过真实 bug 的种子，每次都跑：5314、9232 换网后几轮几乎没送到数据，降速阶段的节奏被压成 0，除以 0 崩溃；
/// 900360 真换了网络时抢先复制的包把要验证的地址顶掉，真的新地址一直验证不完；901894 对端回过一次探测就再也不探测，
/// 之后悄悄换了地址就失联；921733 换网后只在下载、新网络上行丢三成还成段丢包，唯一送到的探测又被抢先复制，
/// 探测间隔翻到 4 秒以后 30 秒里剩下的六次全丢，服务端判死；920202 换网后客户端每次一批发 8 个包，每 8 个复制一个的人
/// 正好每批都抢先送到最新的那个，新地址来的包没有一个是最新的，服务端一直验证不到新地址。
const HARD_SEEDS: [u64; 6] = [5314, 9232, 900_360, 901_894, 920_202, 921_733];

fn seed_count() -> u64 {
    std::env::var("AGENT_NET_SEEDS").ok().and_then(|value| value.parse().ok()).unwrap_or(100)
}

fn seed_start() -> u64 {
    std::env::var("AGENT_NET_SEED_START").ok().and_then(|value| value.parse().ok()).unwrap_or(0)
}

/// 随机网络、随机换网（一到两次，可能断网，客户端不一定知道），四分之一有时不时抢先送复制包的人，
/// 四分之一有人从别的地址注入包：都要传完、数据完整、端点不空转，验证前发往任何地址的字节都不超过收到的三倍。
#[test]
fn random_moves_deliver_intact_streams() {
    let seeds: Vec<u64> = match std::env::var("AGENT_NET_REPLAY") {
        Ok(value) => vec![value.parse().expect("replay seed")],
        Err(_) => HARD_SEEDS.into_iter().chain(seed_start()..seed_start() + seed_count()).collect(),
    };
    let mut failures = Vec::new();
    for seed in seeds {
        let case = random_scenario(seed);
        let report = run_moves(&case);
        if !report.finished || report.spurious_wakes > 0 || !amplification_bounded(&report) {
            failures.push(format!("seed {seed}: {}\n  scenario={case:?}", describe(&report)));
            if failures.len() == 5 {
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} failing seeds:\n{}", failures.len(), failures.join("\n"));
}

// 测试价值：公开 SecureConnection 收发入口上的换网矩阵；守住 2026-11-07 用户确认的每路径换号、
// 防放大与可靠传输规则。原矩阵不提供备用号，无法发现复用旧号、晚到的作废包和控制包乱序。
// 最小输入：下列固定的 306 个场景，含三次换网、只换端口、丢包与抢先复制。Rust integration，虚拟时间。
#[test]
fn rotating_ids_survive_the_migration_matrix() {
    let mut total = [0u64; 2];
    let mut recovery = [0u64; 2];
    let mut retired = 0;
    let mut known_reuse = 0;
    let mut cases = 0;
    let mut records = vec!["seed,noticed,loss,mode,before_finish_us,after_finish_us,before_recovery_us,after_recovery_us,before_wire_bytes,after_wire_bytes,retired_packets,client_exhaustions,server_exhaustions".to_string()];
    for seed in 0..17 {
        for noticed in [false, true] {
            for loss in [0.0, 0.01, 0.10] {
                for mode in 0..3 {
                    let mut new = cellular();
                    new.loss = loss;
                    let mut moves = vec![Move { at_us: 500_000, outage_us: 0, up: new.clone(), down: new.clone(), noticed, same_route: false }];
                    if mode == 1 {
                        moves.push(Move { at_us: 1_000_000, outage_us: 0, up: new.clone(), down: new.clone(), noticed, same_route: true });
                        moves.push(Move { at_us: 1_500_000, outage_us: 0, up: wifi(), down: wifi(), noticed, same_route: false });
                    }
                    let mut case = scenario(wifi(), wifi(), moves, if mode == 0 { 0 } else { 2_000_000 }, 3_000_000, Attack::None);
                    case.seed = seed;
                    if mode == 2 {
                        case.attack = Attack::Race { every: 8, lead_us: 5_000 };
                    }
                    let before = run_moves(&case);
                    let report = run_rotating_moves(&case);
                    let label = format!("seed {seed}, noticed {noticed}, loss {loss}, mode {mode}: {}", describe(&report));
                    assert!(before.finished && report.finished, "{label}");
                    assert!(amplification_bounded(&report), "{label}");
                    assert_eq!(report.spurious_wakes, 0, "{label}");
                    let exhausted = report.client.expect("client").0.connection_id_exhaustions;
                    for direction in 0..2 {
                        // 不知情一端被发现前仍用原号；没有任何回退时，主动通知和发往新地址的包必须互不重叠。
                        if direction == 0 && (!noticed || exhausted > 0) {
                            continue;
                        }
                        let mut seen = std::collections::BTreeSet::new();
                        for ids in report.connection_ids[direction].values() {
                            let reused = ids.intersection(&seen).count();
                            known_reuse += reused;
                            assert_eq!(reused, 0, "direction {direction} reused ids: {label}");
                            seen.extend(ids);
                        }
                    }
                    total[0] += before.finish_us;
                    total[1] += report.finish_us;
                    recovery[0] += before.recoveries_us.iter().flatten().sum::<u64>();
                    recovery[1] += report.recoveries_us.iter().flatten().sum::<u64>();
                    retired += report.retired_packets;
                    let wire = |r: &Report| r.client.expect("client").1.wire_bytes_sent + r.server.expect("server").1.wire_bytes_sent;
                    records.push(format!("{seed},{noticed},{loss},{mode},{},{},{},{},{},{},{},{},{}", before.finish_us, report.finish_us,
                        before.recoveries_us.iter().flatten().sum::<u64>(), report.recoveries_us.iter().flatten().sum::<u64>(), wire(&before), wire(&report), report.retired_packets,
                        exhausted, report.server.expect("server").0.connection_id_exhaustions));
                    cases += 1;
                }
            }
        }
    }
    eprintln!("id rotation matrix: {cases} cases; total_us={total:?}; recovery_us={recovery:?}; retired_packets={retired}; known_reuse={known_reuse}");
    if let Ok(path) = std::env::var("AGENT_NET_ROTATION_REPORT") {
        std::fs::write(path, records.join("\n") + "\n").expect("write requested rotation report");
    }
    // 同一随机网络多了控制包会改变个别丢包抽样，用整组比较，保留严格的完传／防放大／隐私断言。
    assert!(total[1] <= total[0] * 105 / 100, "rotation slowed the matrix: {total:?}");
    assert!(recovery[1] <= recovery[0] * 110 / 100, "rotation delayed recovery: {recovery:?}");
}

#[test]
fn rotating_ids_survive_random_moves() {
    let seeds: Vec<u64> = match std::env::var("AGENT_NET_REPLAY") {
        Ok(value) => vec![value.parse().expect("replay seed")],
        Err(_) => HARD_SEEDS.into_iter().chain(seed_start()..seed_start() + seed_count()).collect(),
    };
    for seed in seeds {
        let case = random_scenario(seed);
        let report = run_rotating_moves(&case);
        assert!(report.finished && report.spurious_wakes == 0 && amplification_bounded(&report), "seed {seed}: {}\n{case:?}", describe(&report));
    }
}
