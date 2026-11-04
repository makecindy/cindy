//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::SecureConnection` / `Incoming` 的公开接口和底层的 `noise::Handshake`。
//!   断言线上抓到的字节里没有明文和身份，篡改、重放的包被拒绝且不改变状态，私钥泄露后录下的通信仍解不开，
//!   握手的每个字节和 Noise 官方测试向量一致，加密以后各种网络下的数据仍然完整有序。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 4 步过关标准（抓包无明文，防篡改、防重放，有前向保密），
//!   `docs/product-rules/agent-net.md` 硬性规则 1（端到端加密，不允许明文降级）。
//! - 现有覆盖缺口：`reliability.rs`、`streams.rs`、`sharing.rs` 只测明文的 `Connection`。
//! - 最小失败输入：随机矩阵打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放；其余用例的输入都是固定的。
//! - tier：Rust integration，虚拟时间，无真实网络。加密算法是测试用的 ring 和 x25519-dalek（`sim/src/crypto.rs`），
//!   一次性密钥按种子生成，不能用于真实通信；产品里由各平台传入系统实现。
//! - 实测耗时：2026-11-03，本机默认 200 个种子共 0.7 秒；`AGENT_NET_SEEDS=10000` 的记录见 `sim/results/2026-11-03-encryption/`。
//! - 测试本身的有效性由 `sim/mutants.py` 验证：注入已知 bug，这里必须变红。

use std::collections::VecDeque;
use std::rc::Rc;

use agent_net_core::noise::Handshake;
use agent_net_core::{Config, Crypto, Incoming, PacketError, SecureConnection, TAG_LEN, is_initiation};
use agent_net_sim::crypto::{AesGcm, ChaChaPoly, PROLOGUE, Probe, SecurePeer, Suite, TestCrypto};
use agent_net_sim::{Shifted, random_case, run};

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex")).collect()
}

fn key(text: &str) -> [u8; 32] {
    hex(text).try_into().expect("32 bytes")
}

/// Noise 官方测试向量，摘自 cacophony（带握手哈希）和 snow 的向量文件。
/// 消息依次是：握手请求、握手回复，之后发起方和响应方轮流各发一条，每个方向的 nonce 从 0 开始。
struct Vector {
    source: &'static str,
    prologue: &'static str,
    init_static: &'static str,
    init_ephemeral: &'static str,
    resp_static: &'static str,
    resp_ephemeral: &'static str,
    handshake_hash: Option<&'static str>,
    messages: &'static [(&'static str, &'static str)],
}

const AESGCM_VECTORS: &[Vector] = &[
    Vector {
        source: "cacophony Noise_IK_25519_AESGCM_SHA256",
        prologue: "4a6f686e2047616c74",
        init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
        init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
        resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
        resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
        handshake_hash: Some("669c8640d9e42a3cda2f232f78597ceefb01daa6e3df81181ccce6fc6b5026bf"),
        messages: &[
            (
                "4c756477696720766f6e204d69736573",
                "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444e417bc55c7a8166c993356c1be41ef67818a292426f301556c7f26b21d25ddb097153891a9a956cff47b83e63ad8d701c1342c209cff1ca5ecd43402762ac249e3bd3a4c0a145fe07cb5dae28ea13a3",
            ),
            (
                "4d757272617920526f746862617264",
                "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843af2ccf9972e22afc67aeafcd25162f7f98c363b7762e3e4cb7d272e39f27a5",
            ),
            ("462e20412e20486179656b", "66acfc92e3197de166809e6d4d5d003dcc819a84bc3522ca53c9d9"),
            ("4361726c204d656e676572", "71f89aa6533a6de70b0826864dd75f60806ee40170c16290189eb3"),
            ("4a65616e2d426170746973746520536179", "4795a3423550c8bf00386bd496a3e2c76c10669d2a75ab8f79b5094c5412a25705"),
            ("457567656e2042f6686d20766f6e2042617765726b", "aa0bb39097555c918e40be82abc2b909eb79d9eb87adb07e268fc37323a6cf904fd01fb391"),
        ],
    },
    Vector {
        source: "snow Noise_IK_25519_AESGCM_SHA256",
        prologue: "5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e",
        init_static: "98faebfdc44a30b111d755708980f247e06f6fd40909fec3d675508952a3f615",
        init_ephemeral: "01fed814d96619ca317a6011dab28db5f32cb9a29d9bdad0eaca9eb48d7b57c4",
        resp_static: "bf6aaf9bc0cd92c4c5f93ef0797f02b3bec9498cfb4a3b338f34b4d682112154",
        resp_ephemeral: "9af33ff27f261005a3e57f7a32a6abd17f57834b74b22bb7b7633abe80cd1f95",
        handshake_hash: None,
        messages: &[
            (
                "8cb1797838a7e55bee256343e843befa874c504eb42eabcc843d26707fb3f051",
                "c3b79ee926435e045ffe4b100c9b7fd2548df6dbe26cdaf9ba7672e094abd46944b359dc54c040932dc7a5797b0efb1624fefa0161ef1fce7c196d06ae9ad1925c1d1127ae542bf18e8f5a4e3c0b7ba242e47b9dd5779de7ed251fac157c5957d33db53bb9e8d6f31ec0b0dc8f79855a139129acacdcea89ee8e29943c8fcde9",
            ),
            (
                "43365623b9d678439fe922abb9b75c2ded28fbaaa0ef2c0155b650bb3eca706d",
                "24ad0a9c3e786b299f8d2bd2edb4af785d5ffa432cb278a66234cf8e8f0a902c09a740060f734f0be6b91f563e4384a8da2e34bcc077ab29a017407dfae20a8386bb50d3df38dbfd2b57d39e6f7f667f",
            ),
            ("b9eed3d18bae1234e8180140025344e29b72d32db52ca89b142a1ac47295c91e", "1bb7ca95b86a472beac1fe0a203b3b1f0f0238669e89ac18819674ea34f158bd613721e58ea4339772aaff3f060086db"),
            ("8a0724a71789f642fc06a2af90be6dded6bf2b5ab1a32e210ef19945cd0b9b68", "c57711be5a672510e6025bc0089a60d8abe47f6ae56bc7f794b8ec3d632f7a4378450ba76584ca1f23b9ae92cb72a1e0"),
        ],
    },
];

const CHACHA_VECTORS: &[Vector] = &[
    Vector {
        source: "cacophony Noise_IK_25519_ChaChaPoly_SHA256",
        prologue: "4a6f686e2047616c74",
        init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
        init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
        resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
        resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
        handshake_hash: Some("0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7"),
        messages: &[
            (
                "4c756477696720766f6e204d69736573",
                "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7",
            ),
            (
                "4d757272617920526f746862617264",
                "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5",
            ),
            ("462e20412e20486179656b", "050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8"),
            ("4361726c204d656e676572", "344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667"),
            ("4a65616e2d426170746973746520536179", "62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4"),
            ("457567656e2042f6686d20766f6e2042617765726b", "029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024"),
        ],
    },
];

fn check_vector<S: Suite>(vector: &Vector) {
    let name = vector.source;
    let initiator = TestCrypto::<S>::from_secret(key(vector.init_static), 0);
    let responder = TestCrypto::<S>::from_secret(key(vector.resp_static), 0);
    initiator.script_ephemerals(&[key(vector.init_ephemeral)]);
    responder.script_ephemerals(&[key(vector.resp_ephemeral)]);
    let prologue = hex(vector.prologue);

    let mut sender = Handshake::initiator(&initiator, &prologue, &responder.public());
    let mut receiver = Handshake::responder(&responder, &prologue);
    let (payload, expected) = vector.messages[0];
    let mut message = Vec::new();
    sender.write_first(&initiator, &hex(payload), &mut message).expect("write first");
    assert_eq!(message, hex(expected), "{name}: 握手请求");
    let mut plain = Vec::new();
    receiver.read_first(&responder, &message, &mut plain).expect("read first");
    assert_eq!(plain, hex(payload), "{name}: 请求附带数据");
    assert_eq!(receiver.remote_static(), &initiator.public(), "{name}: 响应方看到的发起方身份");

    let (payload, expected) = vector.messages[1];
    let mut message = Vec::new();
    receiver.write_second(&responder, &hex(payload), &mut message).expect("write second");
    assert_eq!(message, hex(expected), "{name}: 握手回复");
    let mut plain = Vec::new();
    sender.read_second(&initiator, &message, &mut plain).expect("read second");
    assert_eq!(plain, hex(payload), "{name}: 回复附带数据");

    let initiator_keys = sender.finish(&initiator).expect("initiator keys");
    let responder_keys = receiver.finish(&responder).expect("responder keys");
    assert_eq!(initiator_keys.handshake_hash, responder_keys.handshake_hash, "{name}: 两端握手哈希");
    if let Some(hash) = vector.handshake_hash {
        assert_eq!(initiator_keys.handshake_hash.to_vec(), hex(hash), "{name}: 握手哈希");
    }
    // 之后的消息两端轮流发，各自方向的 nonce 从 0 数起。Noise 的传输消息没有附加数据。
    for (index, &(payload, expected)) in vector.messages[2..].iter().enumerate() {
        let nonce = (index / 2) as u64;
        let (crypto, send, peer, recv) = if index % 2 == 0 {
            (&initiator, &initiator_keys.send, &responder, &responder_keys.recv)
        } else {
            (&responder, &responder_keys.send, &initiator, &initiator_keys.recv)
        };
        let mut body = hex(payload);
        let tag = crypto.seal(send, nonce, &[], &mut body);
        let mut sealed = body.clone();
        sealed.extend_from_slice(&tag);
        assert_eq!(sealed, hex(expected), "{name}: 传输消息 {}", index + 2);
        assert!(peer.open(recv, nonce, &[], &mut body, &tag), "{name}: 对端解不开传输消息 {}", index + 2);
        assert_eq!(body, hex(payload), "{name}: 传输消息 {} 解出来不对", index + 2);
    }
}

/// 握手按 Noise 规范逐字节实现：和两个独立实现的官方向量完全一致，两种认证加密算法都覆盖。
#[test]
fn handshake_matches_the_noise_test_vectors() {
    for vector in AESGCM_VECTORS {
        check_vector::<AesGcm>(vector);
    }
    for vector in CHACHA_VECTORS {
        check_vector::<ChaChaPoly>(vector);
    }
}

const HARD_SEEDS: [u64; 10] = [643, 910, 2181, 2383, 3052, 179_502, 449_978, 526_708, 558_214, 2_003_576];

fn seed_count() -> u64 {
    std::env::var("AGENT_NET_SEEDS").ok().and_then(|value| value.parse().ok()).unwrap_or(200)
}

fn seed_start() -> u64 {
    std::env::var("AGENT_NET_SEED_START").ok().and_then(|value| value.parse().ok()).unwrap_or(0)
}

/// 加了握手和加密以后，明文矩阵里的每一种网络照样传完、数据完整有序、端点不空转。
/// 两成种子的包号从 2^32 前几十个开始，正好跨过换密钥的边界，乱序的种子还会用到上一个密钥。
/// 测试用的加密实现会在 nonce 重复时直接 panic。
#[test]
fn encrypted_seeds_deliver_intact_streams() {
    let seeds: Vec<u64> = match std::env::var("AGENT_NET_REPLAY") {
        Ok(value) => vec![value.parse().expect("replay seed")],
        Err(_) => {
            let start = seed_start();
            HARD_SEEDS.into_iter().chain(start..start + seed_count()).collect()
        }
    };
    let mut failures = Vec::new();
    for seed in seeds {
        let mut case = random_case(seed);
        // 64 字节放不下握手。
        case.config.max_packet_size = case.config.max_packet_size.max(128);
        let outcome = if seed % 3 == 0 {
            let (a, b) = SecurePeer::<ChaChaPoly>::pair(case.config.clone(), seed);
            run(a, b, case.a_link.clone(), case.b_link.clone(), &case.workload, seed)
        } else {
            let (a, b) = SecurePeer::<AesGcm>::pair(case.config.clone(), seed);
            run(a, b, case.a_link.clone(), case.b_link.clone(), &case.workload, seed)
        };
        if !outcome.finished || outcome.violation.is_some() || outcome.spurious_wakes > 0 {
            failures.push(format!(
                "seed {seed}: finished={} violation={:?} spurious_wakes={} at {}us\n  config={:?}\n  a={:?}\n  b={:?}\n  workload={:?}\n  states={:?}",
                outcome.finished, outcome.violation, outcome.spurious_wakes, outcome.finish_us, case.config, case.a_link, case.b_link, case.workload, outcome.final_states
            ));
            if failures.len() == 5 {
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} failing seeds:\n{}", failures.len(), failures.join("\n"));
}

/// 握手和换密钥也只能依赖时间差：整体平移时钟以后，加密连接的每一步都要和从 0 开始一样。
#[test]
fn shifting_the_clock_changes_nothing() {
    for seed in HARD_SEEDS.into_iter().chain(0..seed_count().min(300)) {
        let mut case = random_case(seed);
        case.config.max_packet_size = case.config.max_packet_size.max(128);
        let pair = |at: u64| {
            let (a, b) = SecurePeer::<AesGcm>::pair_at(case.config.clone(), seed, true, at);
            (Shifted { peer: a, offset_us: at }, Shifted { peer: b, offset_us: at })
        };
        let (a, b) = pair(0);
        let base = run(a, b, case.a_link.clone(), case.b_link.clone(), &case.workload, seed);
        let (a, b) = pair(123_456_789_012_345);
        let shifted = run(a, b, case.a_link.clone(), case.b_link.clone(), &case.workload, seed);
        assert_eq!(base.trace, shifted.trace, "seed {seed}: finish {} vs {}us", base.finish_us, shifted.finish_us);
    }
}

const ONE_WAY_US: u64 = 10_000;

/// 决定每个到达的包：参数是（发往响应方，内容），返回 `None` 丢掉，否则投递返回的内容。
type Intercept<'a> = dyn FnMut(bool, &[u8]) -> Option<Vec<u8>> + 'a;

/// 两个加密端点直连：单程 10 毫秒，不丢包，记下线上每个包。用例可以在投递前拦下、改掉或扣住包。
struct Pair {
    now: u64,
    config: Config,
    initiator: SecureConnection<TestCrypto>,
    responder: Option<SecureConnection<TestCrypto>>,
    listener: Option<TestCrypto>,
    /// （到达时间，发往响应方，内容）
    in_flight: VecDeque<(u64, bool, Vec<u8>)>,
    /// （来自发起方，内容）
    wire: Vec<(bool, Vec<u8>)>,
    outbox: [Vec<u8>; 2],
    received: [Vec<u8>; 2],
    errors: Vec<PacketError>,
    /// 两端加密实现的计数：发起方、响应方。
    probes: [Rc<Probe>; 2],
    /// 大于 0 时，每个方向每这么多个数据包扣住一个，等下一个包到了再送，造成固定的乱序。
    reorder_every: usize,
    held: [Option<Vec<u8>>; 2],
    arrivals: [usize; 2],
}

impl Pair {
    fn new(seed: u64, config: Config, payload: &[u8]) -> Self {
        let initiator_crypto = TestCrypto::<AesGcm>::from_seed(seed * 2 + 1);
        let listener = TestCrypto::<AesGcm>::from_seed(seed * 2 + 2);
        let probes = [initiator_crypto.probe(), listener.probe()];
        let initiator = SecureConnection::connect(initiator_crypto, config.clone(), PROLOGUE, &listener.public(), payload, 0).expect("connect");
        Self {
            now: 0,
            config,
            initiator,
            responder: None,
            listener: Some(listener),
            in_flight: VecDeque::new(),
            wire: Vec::new(),
            outbox: [Vec::new(), Vec::new()],
            received: [Vec::new(), Vec::new()],
            errors: Vec::new(),
            probes,
            reorder_every: 0,
            held: [None, None],
            arrivals: [0, 0],
        }
    }

    fn deliver(&mut self, to_responder: bool, packet: &[u8]) -> Result<(), PacketError> {
        if !to_responder {
            return self.initiator.on_packet(self.now, packet);
        }
        if let Some(responder) = &mut self.responder {
            return responder.on_packet(self.now, packet);
        }
        let listener = self.listener.take().expect("listener");
        match Incoming::read(&listener, PROLOGUE, packet) {
            Ok(incoming) => {
                self.responder = Some(incoming.accept(listener, self.config.clone(), b"responder hello", self.now).expect("accept"));
                Ok(())
            }
            Err(error) => {
                self.listener = Some(listener);
                Err(error)
            }
        }
    }

    /// 往前走一步。`intercept` 决定每个到达的包：返回 `None` 丢掉，否则投递返回的内容。
    fn step(&mut self, intercept: &mut Intercept) {
        let mut buffer = vec![0; self.config.max_packet_size];
        for side in 0..2 {
            let connection = if side == 0 { Some(&mut self.initiator) } else { self.responder.as_mut() };
            let Some(connection) = connection else { continue };
            let pending = std::mem::take(&mut self.outbox[side]);
            let written = connection.send(self.now, &pending);
            self.outbox[side] = pending[written..].to_vec();
            while let Some(size) = connection.poll_transmit(self.now, &mut buffer) {
                self.wire.push((side == 0, buffer[..size].to_vec()));
                self.in_flight.push_back((self.now + ONE_WAY_US, side == 0, buffer[..size].to_vec()));
            }
            let mut chunk = [0u8; 4096];
            loop {
                let size = connection.recv(self.now, &mut chunk);
                if size == 0 {
                    break;
                }
                self.received[side].extend_from_slice(&chunk[..size]);
            }
        }
        let mut next = self.in_flight.front().map(|item| item.0);
        for wake in [self.initiator.next_wake(), self.responder.as_ref().and_then(SecureConnection::next_wake)].into_iter().flatten() {
            next = Some(next.map_or(wake, |value| value.min(wake)));
        }
        self.now = next.unwrap_or(self.now + 1_000_000).max(self.now + 1);
        while self.in_flight.front().is_some_and(|item| item.0 <= self.now) {
            let (_, to_responder, packet) = self.in_flight.pop_front().expect("in flight");
            let Some(packet) = intercept(to_responder, &packet) else { continue };
            let lane = to_responder as usize;
            self.arrivals[lane] += 1;
            if self.reorder_every > 0 && packet[0] & 0xE0 == 0xA0 && self.held[lane].is_none() && self.arrivals[lane].is_multiple_of(self.reorder_every) {
                self.held[lane] = Some(packet);
                continue;
            }
            let late = self.held[lane].take();
            for packet in std::iter::once(packet).chain(late) {
                if let Err(error) = self.deliver(to_responder, &packet) {
                    self.errors.push(error);
                }
            }
        }
        if self.initiator.next_wake().is_some_and(|at| at <= self.now) {
            self.initiator.tick(self.now);
        }
        if let Some(responder) = &mut self.responder
            && responder.next_wake().is_some_and(|at| at <= self.now)
        {
            responder.tick(self.now);
        }
    }

    fn run_until(&mut self, limit_us: u64, intercept: &mut Intercept, done: &dyn Fn(&Self) -> bool) -> bool {
        while self.now <= limit_us {
            if done(self) {
                return true;
            }
            self.step(intercept);
        }
        done(self)
    }

    fn transfer(&mut self, to_responder: &[u8], to_initiator: &[u8]) {
        self.outbox[0].extend_from_slice(to_responder);
        self.outbox[1].extend_from_slice(to_initiator);
        let (want_responder, want_initiator) = (self.received[1].len() + to_responder.len(), self.received[0].len() + to_initiator.len());
        let finished = self.run_until(self.now + 60_000_000, &mut |_, packet| Some(packet.to_vec()), &|pair| {
            pair.received[1].len() >= want_responder && pair.received[0].len() >= want_initiator
        });
        assert!(finished, "transfer stuck: errors={:?}", self.errors);
    }

    fn responder(&mut self) -> &mut SecureConnection<TestCrypto> {
        self.responder.as_mut().expect("responder")
    }
}

fn pass(_: bool, packet: &[u8]) -> Option<Vec<u8>> {
    Some(packet.to_vec())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn marked(size: usize, mark: &[u8]) -> Vec<u8> {
    mark.iter().copied().cycle().take(size).collect()
}

/// 抓包看不到明文：双向的数据、握手附带的数据都不出现在线上，两端的长期公钥也不出现，
/// 被动监听分不出是谁在和谁连接。
#[test]
fn nothing_readable_on_the_wire() {
    let mark = b"<agent-net plaintext marker>";
    let mut pair = Pair::new(1, Config::default(), b"initiator hello: secret handshake payload");
    let (up, down) = (marked(300_000, mark), marked(120_000, mark));
    pair.transfer(&up, &down);
    assert_eq!(pair.received[1], up);
    assert_eq!(pair.received[0], down);
    assert!(pair.initiator.is_established() && pair.responder().is_established());
    assert_eq!(pair.responder().remote_payload(), Some(&b"initiator hello: secret handshake payload"[..]));
    assert_eq!(pair.initiator.remote_payload(), Some(&b"responder hello"[..]));

    let identities = [pair.initiator.remote_static().to_vec(), pair.responder().remote_static().to_vec()];
    let secrets: [&[u8]; 4] = [&mark[..16], &mark[12..], b"secret handshake", b"responder hello"];
    for (from_initiator, packet) in &pair.wire {
        for secret in secrets {
            assert!(!contains(packet, secret), "plaintext {:?} on the wire (from initiator: {from_initiator})", String::from_utf8_lossy(secret));
        }
        for identity in &identities {
            assert!(!contains(packet, identity), "a static public key is visible on the wire");
        }
    }
    assert!(pair.wire.len() > 200, "only {} packets captured", pair.wire.len());
}

/// 防篡改：数据包第一次送达之前，先把改动任意一位、截短、加长的版本喂给对端，全部被认证拒绝，
/// 而且不留下任何影响：可靠层没收到，防重放窗口没前移，随后送达的原包照常被接受，数据完整传完。
#[test]
fn tampered_packets_are_rejected_without_side_effects() {
    let mut pair = Pair::new(2, Config::default(), &[]);
    let data = marked(60_000, b"tamper target ");
    pair.outbox[0].extend_from_slice(&data);
    pair.outbox[1].extend_from_slice(&data);
    let (mut seen, mut checked, mut forgeries) = (0usize, 0usize, 0usize);
    while (pair.received[1].len() < data.len() || pair.received[0].len() < data.len()) && pair.now < 10_000_000 {
        let mut held = Vec::new();
        pair.step(&mut |to_responder, packet| {
            if is_initiation(packet) || pair_is_response(to_responder, packet) {
                return Some(packet.to_vec());
            }
            seen += 1;
            if seen % 4 == 0 {
                held.push((to_responder, packet.to_vec()));
                return None;
            }
            Some(packet.to_vec())
        });
        for (to_responder, packet) in held {
            let target = if to_responder { pair.responder() } else { &mut pair.initiator };
            let before = (target.stats().packets_received, target.stats().wire_bytes_received);
            let mut variants = Vec::new();
            for bit in 0..packet.len() * 8 {
                let mut forged = packet.clone();
                forged[bit / 8] ^= 1 << (bit % 8);
                variants.push(forged);
            }
            variants.push(packet[..packet.len() - 1].to_vec());
            variants.push(packet[..packet.len() - TAG_LEN].to_vec());
            variants.push([&packet[..], &[0]].concat());
            for forged in &variants {
                let now = pair.now;
                let target = if to_responder { pair.responder() } else { &mut pair.initiator };
                let result = target.on_packet(now, forged);
                assert!(result.is_err(), "a forged {}-byte packet was accepted", forged.len());
                forgeries += 1;
            }
            let target = if to_responder { pair.responder() } else { &mut pair.initiator };
            assert_eq!(before, (target.stats().packets_received, target.stats().wire_bytes_received), "a forged packet reached the reliable layer");
            assert_eq!(pair.deliver(to_responder, &packet), Ok(()), "the genuine packet was rejected after forgeries");
            checked += 1;
        }
    }
    assert_eq!(pair.received[1], data);
    assert_eq!(pair.received[0], data);
    assert!(checked > 20, "only {checked} packets checked");
    assert!(forgeries > 10_000);
    // 改到包号的版本会先被当成重放挡掉，其余的由认证挡掉。
    assert!(pair.responder().security_stats().unauthenticated_packets > 0);
}

fn pair_is_response(to_responder: bool, packet: &[u8]) -> bool {
    !to_responder && packet[0] == 0x82
}

/// 握手消息被篡改也一样：改过的请求解不开；改过的回复被发起方丢弃，它重发请求，响应方重发回复，握手照常完成。
#[test]
fn tampered_handshakes_are_rejected_and_recover() {
    let mut pair = Pair::new(3, Config::default(), &[]);
    let (mut initiation_tampered, mut response_tampered) = (false, false);
    let mut intercept = |to_responder: bool, packet: &[u8]| {
        let mut packet = packet.to_vec();
        // 第一个请求改加密的长期公钥，第一个回复改密文。
        if to_responder && is_initiation(&packet) && !initiation_tampered {
            packet[40] ^= 0x20;
            initiation_tampered = true;
        } else if !to_responder && !response_tampered {
            packet[50] ^= 0x20;
            response_tampered = true;
        }
        Some(packet)
    };
    let established = pair.run_until(5_000_000, &mut intercept, &|pair| pair.initiator.is_established() && pair.responder.as_ref().is_some_and(SecureConnection::is_established));
    assert!(established, "errors={:?}", pair.errors);
    assert_eq!(pair.errors.first(), Some(&PacketError::Unauthenticated), "the tampered initiation");
    assert_eq!(pair.initiator.security_stats().unauthenticated_packets, 1, "the tampered response");
    assert!(pair.initiator.security_stats().handshake_retransmissions >= 2);
    pair.transfer(b"after recovery", b"both ways");
    assert_eq!(pair.received[1], b"after recovery");
}

/// 防重放：传完以后把录下的每个包原样再发一遍，全部被拒，不多交付一个字节；之后的新数据照常收发。
#[test]
fn replayed_packets_are_rejected() {
    let mut pair = Pair::new(4, Config::default(), &[]);
    let data = marked(100_000, b"once ");
    pair.transfer(&data, &data);
    // 等路上的确认都送到，录下的包才全是对端已经收过的。
    let settled = pair.run_until(pair.now + 1_000_000, &mut pass, &|pair| pair.in_flight.is_empty() && pair.now > 0);
    assert!(settled);
    let recorded = pair.wire.clone();
    for (index, (from_initiator, packet)) in recorded.iter().enumerate() {
        let to_responder = *from_initiator;
        let result = pair.deliver(to_responder, packet);
        assert_eq!(result, Err(PacketError::Replayed), "replayed packet {index} of {} ({} bytes, first byte {:#04x}, to responder {to_responder})", recorded.len(), packet.len(), packet[0]);
    }
    for _ in 0..50 {
        pair.step(&mut pass);
    }
    assert_eq!(pair.received[1], data, "replays delivered data twice");
    assert_eq!(pair.received[0], data);
    let replays = pair.initiator.security_stats().replayed_packets + pair.responder().security_stats().replayed_packets;
    assert_eq!(replays, recorded.len() as u64);

    pair.transfer(b"fresh data", b"fresh reply");
    assert_eq!(&pair.received[1][data.len()..], b"fresh data");
    assert_eq!(&pair.received[0][data.len()..], b"fresh reply");
}

/// 录下的握手请求重放给响应方（伪造来源地址时，回复会打到受害者那里）：每份请求最多换来一个同样大的回复，
/// 应用写了多少数据都不发，连接永远确认不了，到期放弃。
#[test]
fn replayed_initiations_do_not_amplify() {
    let mut pair = Pair::new(5, Config::default(), &[]);
    pair.transfer(b"genuine", b"");
    let initiation = pair.wire.iter().find(|(_, packet)| is_initiation(packet)).map(|(_, packet)| packet.clone()).expect("initiation");

    // 响应方重启后（或另一台持有同一密钥的机器）收到录下的请求，请求本身认证得过去。
    let listener = TestCrypto::<AesGcm>::from_seed(5 * 2 + 2);
    let incoming = Incoming::read(&listener, PROLOGUE, &initiation).expect("a recorded initiation still authenticates");
    let config = Config::default();
    let mut victim = incoming.accept(listener, config.clone(), &[], 0).expect("accept");
    victim.send(0, &marked(500_000, b"eager data "));
    let mut buffer = vec![0; config.max_packet_size];
    let (mut received, mut sent, mut now) = (initiation.len(), 0, 0);
    while let Some(size) = victim.poll_transmit(now, &mut buffer) {
        sent += size;
    }
    for _ in 0..20 {
        now += 100_000;
        assert_eq!(victim.on_packet(now, &initiation), Ok(()));
        received += initiation.len();
        victim.tick(now);
        while let Some(size) = victim.poll_transmit(now, &mut buffer) {
            sent += size;
        }
    }
    assert!(sent <= received, "sent {sent} bytes for {received} received");
    assert!(sent > 0, "the response must still be resent for a lost-response retransmission");
    assert!(!victim.is_established());
    let mut deadline = 0;
    while let Some(at) = victim.next_wake() {
        assert!(at <= config.dead_after_us + 1, "wakes at {at}us without progress");
        now = now.max(at);
        victim.tick(now);
        while let Some(size) = victim.poll_transmit(now, &mut buffer) {
            sent += size;
        }
        deadline += 1;
        assert!(deadline < 100, "busy waking while unconfirmed");
    }
    assert!(victim.is_dead(), "an unconfirmed connection must give up");
    assert!(sent <= received);
}

/// 回复不比请求大，即使响应方允许更大的包；伪造的数据包也不能让响应方以为对方在线、开始发数据。
#[test]
fn responses_never_outgrow_requests() {
    let listener = TestCrypto::<AesGcm>::from_seed(52);
    let small = Config { max_packet_size: 300, ..Config::default() };
    let mut initiator = SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(51), small, PROLOGUE, &listener.public(), &[], 0).expect("connect");
    let mut buffer = vec![0; 1400];
    let size = initiator.poll_transmit(0, &mut buffer).expect("initiation");
    assert_eq!(size, 300, "the initiation is padded to the full packet size");
    let incoming = Incoming::read(&listener, PROLOGUE, &buffer[..size]).expect("read");
    let mut responder = incoming.accept(listener, Config::default(), &[], 0).expect("accept");
    responder.send(0, &marked(100_000, b"waiting "));
    let response = responder.poll_transmit(0, &mut buffer).expect("response");
    assert!(response <= size, "a {response}-byte response to a {size}-byte request");
    assert_eq!(responder.poll_transmit(0, &mut buffer), None);

    let mut forged = vec![0xA0, 0, 0];
    forged.extend_from_slice(&[0x55; 60]);
    assert_eq!(responder.on_packet(1_000, &forged), Err(PacketError::Unauthenticated));
    assert!(!responder.is_established());
    assert_eq!(responder.poll_transmit(1_000, &mut buffer), None, "a forged packet unlocked sending");
}

/// 前向保密：握手一结束两端的一次性私钥就被销毁；事后拿到两端的长期私钥和完整抓包，也解不开录下的数据。
/// 第一条消息只受长期密钥保护，偷到响应方私钥的人能看出发起方是谁，这是 IK 模式的已知性质。
#[test]
fn stolen_static_keys_do_not_decrypt_recorded_traffic() {
    let mut pair = Pair::new(6, Config::default(), &[]);
    let probes = pair.probes.clone();
    pair.transfer(&marked(50_000, b"recorded "), &marked(20_000, b"recorded reply "));
    for probe in &probes {
        assert_eq!(probe.ephemerals_created.get(), 1);
        assert_eq!(probe.live_ephemerals.get(), 0, "an ephemeral secret outlived the handshake");
    }

    let initiation = pair.wire.iter().find(|(_, packet)| is_initiation(packet)).map(|(_, packet)| packet.clone()).expect("initiation");
    let response = pair.wire.iter().find(|(from_initiator, _)| !from_initiator).map(|(_, packet)| packet.clone()).expect("response");
    let recorded: Vec<(bool, Vec<u8>)> = pair.wire.iter().filter(|(_, packet)| packet[0] & 0xE0 == 0xA0).cloned().collect();
    assert!(recorded.len() > 50);

    // 偷到响应方私钥：能解开请求，但新算出的会话密钥和当时的不同。
    let stolen_responder = TestCrypto::<AesGcm>::from_secret(TestCrypto::<AesGcm>::from_seed(6 * 2 + 2).secret_bytes(), 99);
    let incoming = Incoming::read(&stolen_responder, PROLOGUE, &initiation).expect("IK's first message is readable with the responder's key");
    let mut attacker = incoming.accept(stolen_responder, Config::default(), &[], 0).expect("accept");
    for (from_initiator, packet) in recorded.iter().filter(|(from_initiator, _)| *from_initiator) {
        assert_eq!(attacker.on_packet(0, packet), Err(PacketError::Unauthenticated), "decrypted a recorded packet (from initiator {from_initiator})");
    }
    // 偷到发起方私钥：重新发起时一次性密钥不同，录下的回复解不开。
    let stolen_initiator = TestCrypto::<AesGcm>::from_secret(TestCrypto::<AesGcm>::from_seed(6 * 2 + 1).secret_bytes(), 99);
    let remote = TestCrypto::<AesGcm>::from_seed(6 * 2 + 2).public();
    let mut attacker = SecureConnection::connect(stolen_initiator, Config::default(), PROLOGUE, &remote, &[], 0).expect("connect");
    assert_eq!(attacker.on_packet(0, &response), Err(PacketError::Unauthenticated));
    for (_, packet) in recorded.iter().filter(|(from_initiator, _)| !from_initiator) {
        assert!(attacker.on_packet(0, packet).is_err());
    }
}

/// 换密钥：包号跨过 2^20 的边界时两个方向各换一次，数据不断、不重复。边界前后的包有乱序，
/// 旧密钥的包晚到也要解得开。传的包比防重放窗口多，窗口前移时让出的位置要清空，否则晚到的新包会被当成重放。
#[test]
fn keys_rotate_across_the_packet_number_boundary() {
    // 每个方向第 1 个到达的是握手消息，之后包号连续：起点取 2^20 - 41，旧密钥的最后一个包正好是第 42 个，被扣到新密钥的第一个包之后。
    let config = Config { initial_packet_number: (1 << 20) - 41, ..Config::default() };
    let mut pair = Pair::new(7, config, &[]);
    pair.reorder_every = 7;
    let (up, down) = (marked(6_000_000, b"rotate "), marked(400_000, b"rotate back "));
    pair.transfer(&up, &down);
    assert_eq!(pair.received[1], up);
    assert_eq!(pair.received[0], down);
    // 每端发送方向换一次、接收方向换一次。
    assert_eq!(pair.initiator.security_stats().rekeys, 2);
    assert_eq!(pair.responder().security_stats().rekeys, 2);
    assert!(pair.errors.is_empty(), "genuine packets rejected: {:?}", pair.errors);
    assert!(pair.initiator.stats().packets_sent > 4096, "only {} packets", pair.initiator.stats().packets_sent);
}

/// 响应方先说话：发起方没有数据要发，也要马上发探测包让响应方确认，响应方的数据只多等一个往返。
#[test]
fn responder_can_talk_first() {
    let mut pair = Pair::new(8, Config::default(), &[]);
    pair.outbox[1].extend_from_slice(b"server greeting");
    let start = pair.now;
    let done = pair.run_until(5_000_000, &mut pass, &|pair| pair.received[0] == b"server greeting");
    assert!(done, "responder data never arrived: {:?}", pair.errors);
    // 请求、回复、探测、数据：两个往返。
    assert!(pair.now - start <= 4 * ONE_WAY_US + 2_000, "took {}us", pair.now - start);
    assert!(pair.responder().is_established());
}

/// 对端不在：握手按退避重发，到期放弃，不会无限重试。
#[test]
fn handshake_gives_up_when_nobody_answers() {
    let mut pair = Pair::new(9, Config::default(), &[]);
    let limit = pair.config.dead_after_us + 1_000_000;
    let dead = pair.run_until(limit, &mut |_, _| None, &|pair| pair.initiator.is_dead());
    assert!(dead, "still trying after {}us", pair.now);
    let sent = pair.initiator.security_stats().handshake_packets_sent;
    assert!((5..=25).contains(&sent), "{sent} handshake packets in 30 s");
}

/// 公钥不对、前言不同：都在第一条消息就失败，不会建立连接。
#[test]
fn wrong_key_or_prologue_is_rejected() {
    let config = Config::default();
    let initiator = TestCrypto::<AesGcm>::from_seed(21);
    let responder = TestCrypto::<AesGcm>::from_seed(22);
    let stranger = TestCrypto::<AesGcm>::from_seed(23);
    let mut buffer = vec![0; config.max_packet_size];

    let mut to_stranger = SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(21), config.clone(), PROLOGUE, &stranger.public(), &[], 0).expect("connect");
    let size = to_stranger.poll_transmit(0, &mut buffer).expect("initiation");
    assert_eq!(Incoming::read(&responder, PROLOGUE, &buffer[..size]).err(), Some(PacketError::Unauthenticated));

    let mut other_protocol = SecureConnection::connect(initiator, config, b"another-app/1", &responder.public(), &[], 0).expect("connect");
    let size = other_protocol.poll_transmit(0, &mut buffer).expect("initiation");
    assert_eq!(Incoming::read(&responder, PROLOGUE, &buffer[..size]).err(), Some(PacketError::Unauthenticated));
}

/// 两端同时向对方发起：公钥小的一方改当响应方，只完成一次握手，两边各自先写的数据都送到；
/// 被忽略的那个请求迟到时也不会被当成新连接。
#[test]
fn simultaneous_open_settles_on_one_handshake() {
    let config = Config::default();
    let (left_crypto, right_crypto) = (TestCrypto::<AesGcm>::from_seed(31), TestCrypto::<AesGcm>::from_seed(32));
    let (left_public, right_public) = (left_crypto.public(), right_crypto.public());
    let mut left = SecureConnection::connect(left_crypto, config.clone(), PROLOGUE, &right_public, &[], 0).expect("connect");
    let mut right = SecureConnection::connect(right_crypto, config.clone(), PROLOGUE, &left_public, &[], 0).expect("connect");
    left.send(0, b"from left");
    right.send(0, b"from right");

    let mut buffer = vec![0; config.max_packet_size];
    let mut in_flight: VecDeque<(u64, bool, Vec<u8>)> = VecDeque::new();
    let mut stale = Vec::new();
    let (mut got_left, mut got_right) = (Vec::new(), Vec::new());
    let mut now = 0;
    while now < 2_000_000 && (got_left != b"from right" || got_right != b"from left") {
        for (to_right, connection) in [(true, &mut left), (false, &mut right)] {
            while let Some(size) = connection.poll_transmit(now, &mut buffer) {
                if is_initiation(&buffer[..size]) {
                    stale.push((to_right, buffer[..size].to_vec()));
                }
                in_flight.push_back((now + ONE_WAY_US, to_right, buffer[..size].to_vec()));
            }
        }
        let mut chunk = [0u8; 64];
        let size = left.recv(now, &mut chunk);
        got_left.extend_from_slice(&chunk[..size]);
        let size = right.recv(now, &mut chunk);
        got_right.extend_from_slice(&chunk[..size]);
        now = in_flight.front().map_or(now + 1_000, |item| item.0).min(left.next_wake().unwrap_or(u64::MAX)).min(right.next_wake().unwrap_or(u64::MAX)).max(now + 1);
        while in_flight.front().is_some_and(|item| item.0 <= now) {
            let (_, to_right, packet) = in_flight.pop_front().expect("in flight");
            let target = if to_right { &mut right } else { &mut left };
            assert!(matches!(target.on_packet(now, &packet), Ok(()) | Err(PacketError::Replayed)), "rejected during simultaneous open");
        }
        for connection in [&mut left, &mut right] {
            if connection.next_wake().is_some_and(|at| at <= now) {
                connection.tick(now);
            }
        }
    }
    assert_eq!(got_left, b"from right");
    assert_eq!(got_right, b"from left");
    assert!(left.is_established() && right.is_established());
    assert_eq!(left.security_stats().role_switches + right.security_stats().role_switches, 1);
    assert_eq!(left.handshake_hash(), right.handshake_hash());
    for (to_right, packet) in stale {
        let target = if to_right { &mut right } else { &mut left };
        assert_eq!(target.on_packet(now, &packet), Err(PacketError::Replayed), "a stale simultaneous-open initiation looked like a new connection");
    }
}


/// 无效公钥（全零之类的低阶点）算出的共享密钥是固定值，等于没有加密：发起时、收到请求时都必须拒绝。
#[test]
fn low_order_public_keys_are_rejected() {
    let config = Config::default();
    let low_order = [[0u8; 32], {
        let mut one = [0u8; 32];
        one[0] = 1;
        one
    }];
    for key in low_order {
        let result = SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(41), config.clone(), PROLOGUE, &key, &[], 0);
        assert_eq!(result.err(), Some(agent_net_core::HandshakeError::InvalidKey));
    }
    let responder = TestCrypto::<AesGcm>::from_seed(42);
    let mut initiator = SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(41), config.clone(), PROLOGUE, &responder.public(), &[], 0).expect("connect");
    let mut buffer = vec![0; config.max_packet_size];
    let size = initiator.poll_transmit(0, &mut buffer).expect("initiation");
    for key in low_order {
        let mut forged = buffer[..size].to_vec();
        forged[1..33].copy_from_slice(&key);
        assert_eq!(Incoming::read(&responder, PROLOGUE, &forged).err(), Some(PacketError::Unauthenticated));
    }
}
