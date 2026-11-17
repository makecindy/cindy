//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::SecureConnection` / `Incoming` / `Endpoint` 的公开接口和底层的 `noise::Handshake`。
//!   断言线上抓到的字节里没有明文和身份，篡改、重放的包被拒绝且不改变状态，私钥泄露后录下的通信仍解不开，
//!   握手的每个字节和 Noise 官方测试向量一致，加密以后各种网络下的数据仍然完整有序；
//!   不知道公钥的请求不做 DH、不回包，伪造来源的洪水做的 DH 不超过准入额度，同时真的发起方照样连得上；
//!   一端关闭时对端收到关闭包马上停，伪造的关闭包不起作用。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 4 步过关标准（抓包无明文，防篡改、防重放，有前向保密），
//!   `docs/product-rules/agent-net.md` 硬性规则 1（端到端加密，不允许明文降级）和“准入分两道门”（2026-11-06）：
//!   对公网开放监听之前，伪造的握手请求不能把 CPU 拖垮；对端走了要马上知道，不能等 15–30 秒判死。
//! - 现有覆盖缺口：`reliability.rs`、`streams.rs`、`sharing.rs` 只测明文的 `Connection`。
//! - 最小失败输入：随机矩阵打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放；其余用例的输入都是固定的。
//! - tier：Rust integration，虚拟时间，无真实网络。加密算法是测试用的 ring 和 x25519-dalek（`sim/src/crypto.rs`），
//!   一次性密钥按种子生成，不能用于真实通信；产品里由各平台传入系统实现。
//! - 实测耗时：2026-11-03，本机默认 200 个种子共 0.7 秒；`AGENT_NET_SEEDS=10000` 的记录见 `sim/results/2026-11-03-encryption/`。
//!   2026-11-06 加了两个准入用例和两个关闭用例，整个文件 1.7 秒，其中洪水用例 1.1 秒（2.5 秒虚拟时间里 5 万个请求）。
//!   2026-11-07 加了 7 个连接号用例，整个文件 2.44 秒；只跑连接号用例 0.03 秒（不含编译）。
//! - 测试本身的有效性由 `sim/mutants.py` 验证：注入已知 bug，这里必须变红。

use std::collections::{BTreeSet, VecDeque};
use std::net::SocketAddr;
use std::rc::Rc;

use agent_net_core::noise::Handshake;
use agent_net_core::{Admission, Config, Crypto, Endpoint, Incoming, PacketError, SecureConnection, TAG_LEN, destination_id, is_initiation};
use agent_net_sim::crypto::{AesGcm, ChaChaPoly, PROLOGUE, Probe, SecurePeer, Suite, TestCrypto};
use agent_net_sim::{Rng, Shifted, random_case, run};

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
        // 64 字节放不下握手（请求至少 135 字节）。
        case.config.max_packet_size = case.config.max_packet_size.max(160);
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
        case.config.max_packet_size = case.config.max_packet_size.max(160);
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
        // 攻击者知道响应方公钥，能把 mac1 算对，这样才走到 DH 那一步的检查。
        remac(&responder.public(), &mut forged);
        let probe = responder.probe();
        let before = probe.dh_operations.get();
        assert_eq!(Incoming::read(&responder, PROLOGUE, &forged).err(), Some(PacketError::Unauthenticated));
        assert!(probe.dh_operations.get() > before, "the low-order key must be caught at the DH, past the mac1 check");
    }
}

// ---------- 握手准入：在 DH 之前挡掉伪造请求 ----------

type Node = Endpoint<TestCrypto<AesGcm>>;

const LISTENER_SEED: u64 = 70;

/// 改过的请求重新算 mac1（`admission.rs` 的线上格式）：知道响应方公钥的人做得到。
fn remac(responder: &[u8; 32], packet: &mut [u8]) {
    let crypto = TestCrypto::<AesGcm>::from_seed(0);
    let key = crypto.hash(&[b"mac1----", responder]);
    let end = packet.len() - 32;
    let mac = crypto.hmac(&key, &[&packet[..end]]);
    packet[end..end + 16].copy_from_slice(&mac[..16]);
}

fn listener_public() -> [u8; 32] {
    TestCrypto::<AesGcm>::from_seed(LISTENER_SEED).public()
}

/// 接受所有人的端点，长期密钥固定；`probe` 记它做过多少次 DH。
fn listener(probe: &Rc<Probe>) -> Node {
    listener_with_config(probe, Config::default())
}

fn listener_with_config(probe: &Rc<Probe>, config: Config) -> Node {
    let mut rng = Rng::new(71);
    let mut node = Node::new(move || rng.next_u64() as u32);
    let secret = TestCrypto::<AesGcm>::from_seed(LISTENER_SEED).secret_bytes();
    let probe = probe.clone();
    let mut created = 0;
    node.listen(
        PROLOGUE,
        config,
        &[],
        move || {
            created += 1;
            TestCrypto::from_secret(secret, created).with_probe(probe.clone())
        },
        |_, _| true,
    );
    node
}

fn dialer(seed: u64) -> Node {
    let mut rng = Rng::new(seed);
    Node::new(move || rng.next_u64() as u32)
}

/// 第 `index` 个伪造的来源地址。
fn spoofed(index: u64) -> SocketAddr {
    SocketAddr::from(([10, (index >> 16) as u8, (index >> 8) as u8, index as u8], 40_000 + (index % 20_000) as u16))
}

/// 一个发往 `responder` 的真请求，原样取出来。
fn initiation_to(responder: &[u8; 32], seed: u64) -> Vec<u8> {
    let config = Config::default();
    let mut initiator = SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(seed), config.clone(), PROLOGUE, responder, &[], 0).expect("connect");
    let mut buffer = vec![0; config.max_packet_size];
    let size = initiator.poll_transmit(0, &mut buffer).expect("initiation");
    buffer.truncate(size);
    buffer
}

fn drain(node: &mut Node, now: u64) -> Vec<(Vec<u8>, SocketAddr)> {
    let mut buffer = vec![0; 2048];
    let mut out = Vec::new();
    while let Some((size, to)) = node.poll_transmit(now, &mut buffer) {
        out.push((buffer[..size].to_vec(), to));
    }
    out
}

/// 不知道这一端公钥的人发来的请求（乱码，或者发给别的公钥的真请求）：一次 DH 都不做，一个字节都不回，扫描的人看不出这里有服务。
#[test]
fn initiations_without_our_key_cost_no_dh_and_get_no_reply() {
    let probe = Rc::new(Probe::default());
    let mut node = listener(&probe);
    let stranger = initiation_to(&TestCrypto::<AesGcm>::from_seed(72).public(), 73);
    let mut rng = Rng::new(74);
    for index in 0..5_000 {
        let mut garbage = vec![0x81; stranger.len()];
        for byte in &mut garbage[1..] {
            *byte = rng.next_u64() as u8;
        }
        node.on_datagram(index, spoofed(index), &garbage);
        node.on_datagram(index, spoofed(index), &stranger);
    }
    assert_eq!(probe.dh_operations.get(), 0);
    assert!(drain(&mut node, 5_000).is_empty(), "replied to a stranger");
    assert_eq!(node.stats().bad_mac1, 10_000);
    assert_eq!(node.ids().count(), 0);
}

/// 知道公钥的人伪造来源地址，每秒 2 万个请求（录下的真请求重放），连续 2.5 秒：
/// 做 DH 的请求不超过准入额度，回给伪造地址的字节远少于收到的；同时一个正常的发起方先拿 cookie 再重发，1 毫秒内连上；
/// 另一个真地址上每毫秒新建一条连接，也只按这个地址的额度处理。
#[test]
fn a_flood_is_capped_and_a_real_client_still_connects() {
    const FLOOD_US: u64 = 2_500_000;
    const STEP_US: u64 = 50;
    const CLIENT_AT: u64 = 300_000;
    let admission = Admission::default();
    let probe = Rc::new(Probe::default());
    let mut server = listener(&probe);
    let public = listener_public();
    let recorded: Vec<Vec<u8>> = (0..64).map(|seed| initiation_to(&public, 1_000 + seed)).collect();
    let server_addr = SocketAddr::from(([198, 51, 100, 1], 443));
    let client_addr = SocketAddr::from(([192, 0, 2, 1], 5_000));
    let noisy_addr = SocketAddr::from(([192, 0, 2, 2], 6_000));
    let (mut client, mut noisy) = (dialer(75), dialer(76));
    let config = Config::default();

    let (mut flood_in, mut flood_out, mut noisy_started) = (0, 0, 0);
    let (mut client_id, mut client_connected_at) = (None, None);
    let mut now = 0;
    while now < FLOOD_US {
        let index = now / STEP_US;
        let packet = &recorded[(index % 64) as usize];
        server.on_datagram(now, spoofed(index), packet);
        flood_in += packet.len();
        if now == CLIENT_AT {
            client_id = Some(client.connect(now, TestCrypto::from_seed(77), config.clone(), PROLOGUE, &public, b"", server_addr).expect("connect"));
        }
        if now >= CLIENT_AT && now % 1_000 == 0 && noisy_started < 2_000 {
            noisy.connect(now, TestCrypto::from_seed(5_000 + noisy_started), config.clone(), PROLOGUE, &public, b"", server_addr).expect("connect");
            noisy_started += 1;
        }
        for (packet, to) in drain(&mut server, now) {
            match to {
                to if to == client_addr => client.on_datagram(now, server_addr, &packet),
                to if to == noisy_addr => noisy.on_datagram(now, server_addr, &packet),
                _ => flood_out += packet.len(),
            }
        }
        for (packet, _) in drain(&mut client, now) {
            server.on_datagram(now, client_addr, &packet);
        }
        for (packet, _) in drain(&mut noisy, now) {
            server.on_datagram(now, noisy_addr, &packet);
        }
        for node in [&mut server, &mut client, &mut noisy] {
            node.tick(now);
        }
        let established = client_id.and_then(|id| client.connection(id)).is_some_and(SecureConnection::is_established);
        if established && client_connected_at.is_none() {
            client_connected_at = Some(now);
        }
        now += STEP_US;
    }

    let seconds = FLOOD_US as f64 / 1e6;
    let stats = server.stats();
    let client_stats = client.connection(client_id.expect("client")).expect("client connection").security_stats();
    let noisy_established = noisy.ids().filter(|&id| noisy.connection(id).is_some_and(SecureConnection::is_established)).count() as f64;
    let report = format!(
        "{stats:?}; server DH {}; client cookies {}, connected {:?}us after connect; noisy {noisy_established} of {noisy_started} established; flood in {flood_in} out {flood_out}",
        probe.dh_operations.get(),
        client_stats.cookies_received,
        client_connected_at.map(|at| at - CLIENT_AT)
    );
    // 结果记录见 `sim/results/2026-11-06-hardening/`：`--nocapture` 时打印这一行。
    eprintln!("{report}");
    // 每个处理过的请求是 4 次 DH（解开 2 次，回复 2 次）。不忙时的额度由伪造的和那个真地址共用，忙时证明过地址的按地址限流，正常的发起方另算一个。
    let unproven_cap = admission.handshake_burst as f64 + admission.handshakes_per_second as f64 * seconds;
    let address_cap = admission.per_address_burst as f64 + admission.per_address_per_second as f64 * seconds;
    let dh_cap = 4.0 * (unproven_cap + address_cap + 1.0);
    assert!((probe.dh_operations.get() as f64) <= dh_cap, "{} DH > {dh_cap}: {report}", probe.dh_operations.get());
    assert!(noisy_established * 10.0 < noisy_started as f64, "one address got {noisy_established} of {noisy_started} handshakes through: {report}");
    assert!(noisy_established >= admission.per_address_burst as f64, "the proven address was starved: {report}");
    assert!(client_connected_at.is_some_and(|at| at - CLIENT_AT <= 1_000), "client connected at {client_connected_at:?}: {report}");
    assert!(client_stats.cookies_received >= 1, "the server was not busy when the client came: {report}");
    assert!(flood_out * 10 < flood_in, "{report}");
    assert!(stats.throttled_initiations > 0, "{report}");
}

/// 关闭通知：一端关掉，发出两个关闭包就停；第一个在路上丢了，第二个照样让对端马上停，并且知道是对端关的，不用等 15–30 秒判死。
/// 改过的关闭包认证不过，对端照常工作；握手还没完成时关闭不发任何包。
#[test]
fn closing_tells_the_peer_at_once() {
    let mut pair = Pair::new(60, Config::default(), &[]);
    pair.transfer(b"before close", b"reply");
    let settled = pair.run_until(pair.now + 1_000_000, &mut pass, &|pair| pair.in_flight.is_empty() && pair.now > 0);
    assert!(settled);
    pair.initiator.close();
    let mut buffer = vec![0; pair.config.max_packet_size];
    let mut sent = Vec::new();
    while let Some(size) = pair.initiator.poll_transmit(pair.now, &mut buffer) {
        sent.push(buffer[..size].to_vec());
    }
    assert_eq!(sent.len(), 2, "two close packets");
    assert!(pair.initiator.is_dead() && pair.initiator.next_wake().is_none());
    assert!(!pair.initiator.closed_by_peer());

    let mut forged = sent[0].clone();
    *forged.last_mut().expect("tag") ^= 1;
    assert_eq!(pair.deliver(true, &forged), Err(PacketError::Unauthenticated));
    assert!(!pair.responder().is_dead(), "a forged close stopped the connection");

    assert_eq!(pair.deliver(true, &sent[1]), Ok(()));
    let responder = pair.responder();
    assert!(responder.is_dead() && responder.closed_by_peer());
    assert_eq!(responder.next_wake(), None);
    assert_eq!(pair.deliver(true, &sent[0]), Err(PacketError::Dead));

    let mut early = Pair::new(61, Config::default(), &[]);
    early.initiator.close();
    assert_eq!(early.initiator.poll_transmit(0, &mut buffer), None, "nothing to tell before the handshake");
    assert!(early.initiator.is_dead());
}

/// `Endpoint::close` 是驱动关连接的入口：关闭包排进 `poll_transmit`，发往对端现在的地址，对端的连接随即停下。
#[test]
fn endpoint_close_tells_the_peer() {
    let probe = Rc::new(Probe::default());
    let (mut server, mut client) = (listener(&probe), dialer(62));
    let server_addr = SocketAddr::from(([198, 51, 100, 1], 443));
    let client_addr = SocketAddr::from(([192, 0, 2, 1], 5_000));
    let id = client.connect(0, TestCrypto::from_seed(63), Config::default(), PROLOGUE, &listener_public(), b"", server_addr).expect("connect");
    let established = |client: &Node, server: &Node| {
        client.connection(id).is_some_and(SecureConnection::is_established) && server.ids().any(|id| server.connection(id).is_some_and(SecureConnection::is_established))
    };
    let mut now = 0;
    while !established(&client, &server) && now < 1_000_000 {
        for (packet, _) in drain(&mut client, now) {
            server.on_datagram(now, client_addr, &packet);
        }
        for (packet, _) in drain(&mut server, now) {
            client.on_datagram(now, server_addr, &packet);
        }
        now += 1_000;
    }
    assert!(established(&client, &server));
    let server_id = server.ids().next().expect("server connection");
    assert!(server.close(server_id).is_some());
    let packets = drain(&mut server, now);
    assert_eq!(packets.len(), 2, "two close packets");
    assert!(packets.iter().all(|(_, to)| *to == client_addr));
    client.on_datagram(now, server_addr, &packets[0].0);
    let connection = client.connection(id).expect("client connection");
    assert!(connection.is_dead() && connection.closed_by_peer());
}

// 测试价值（连接号轮换，2026-11-07）
// - 入口与可观察结果：Endpoint 的公开收发／换网／关闭入口；抓取线上目的号，检查换地址时换号、
//   作废的号不再路由、有效号不能被篡改、缺号不阻塞数据，多连接共享一个端口仍各收各的。
// - 规则依据：用户确认的备用 7 号、每路径独立用号、可靠作废和补号方案；agent-net-plan §0 的公网防护。
// - 缺口：原有 migration 用例直接用 SecureConnection、没有备用号，原有 Endpoint 用例不换号。
// - 最小输入：下面的固定包丢失／乱序／8 次连续通知／64 条连接，135 字节 MTU 也必须能完成交号。
// - tier：Rust integration，虚拟时间，使用真实加密和生产分发入口，无真实 socket 或等待。

struct RoutingPair {
    nodes: [Node; 2],
    handles: [u32; 2],
    addresses: [SocketAddr; 2],
    now: u64,
    wire: Vec<(usize, SocketAddr, SocketAddr, Vec<u8>)>,
}

impl RoutingPair {
    fn new(max_packet_size: usize, settle: bool) -> Self {
        let config = Config { max_packet_size, ..Config::default() };
        let server = listener_with_config(&Rc::new(Probe::default()), config.clone());
        let mut client = dialer(1_007);
        let addresses = [SocketAddr::from(([192, 0, 2, 1], 5_000)), SocketAddr::from(([198, 51, 100, 1], 443))];
        let handle = client.connect(0, TestCrypto::from_seed(1_008), config, PROLOGUE, &listener_public(), &[], addresses[1]).expect("connect");
        let mut pair = Self { nodes: [client, server], handles: [handle, 0], addresses, now: 0, wire: Vec::new() };
        if settle {
            pair.pump(500_000, &mut |_, _| true);
            pair.handles[1] = pair.nodes[1].ids().next().expect("accepted");
            pair.assert_live();
        }
        pair
    }

    fn connection(&self, side: usize) -> &SecureConnection<TestCrypto> {
        self.nodes[side].connection(self.handles[side]).expect("stable handle")
    }

    fn pump(&mut self, duration: u64, pass: &mut impl FnMut(usize, &[u8]) -> bool) {
        let until = self.now + duration;
        while self.now < until {
            self.now += 1_000;
            for side in 0..2 {
                self.nodes[side].tick(self.now);
                for (packet, to) in drain(&mut self.nodes[side], self.now) {
                    let from = self.addresses[side];
                    self.wire.push((side, from, to, packet.clone()));
                    if to == self.addresses[1 - side] && pass(side, &packet) {
                        self.nodes[1 - side].on_datagram(self.now, from, &packet);
                    }
                }
            }
        }
    }

    fn assert_live(&self) {
        for side in 0..2 {
            assert!(self.connection(side).is_established(), "side {side}");
            assert_eq!(self.connection(side).local_connection_ids().count(), 8, "side {side}");
        }
    }

    fn exchange(&mut self, data: &[u8]) {
        for side in 0..2 {
            assert_eq!(self.nodes[side].connection_mut(self.handles[side]).expect("connection").send(self.now, data), data.len());
        }
        self.pump(200_000, &mut |_, _| true);
        for side in 0..2 {
            let mut received = vec![0; data.len() + 1];
            let size = self.nodes[side].connection_mut(self.handles[side]).expect("connection").recv(self.now, &mut received);
            assert_eq!(&received[..size], data, "side {side}");
        }
    }
}

fn wire_ids(wire: &[(usize, SocketAddr, SocketAddr, Vec<u8>)], side: usize) -> BTreeSet<u32> {
    wire.iter().filter(|(sender, _, _, packet)| *sender == side && packet[0] & 0xE0 == 0xA0).filter_map(|(_, _, _, packet)| destination_id(packet)).collect()
}

#[test]
fn connection_ids_rotate_and_retired_routes_disappear() {
    for mtu in [135, 1_200] {
        for same_host in [false, true] {
            for noticed in [false, true] {
                let mut pair = RoutingPair::new(mtu, true);
                pair.exchange(b"before moving");
                let old = [wire_ids(&pair.wire, 0), wire_ids(&pair.wire, 1)];
                let delayed = pair.wire.iter().rev().find(|(side, _, _, packet)| *side == 0 && packet[0] & 0xE0 == 0xA0).expect("old transport packet").3.clone();
                pair.wire.clear();
                pair.addresses[0] = if same_host { SocketAddr::from(([192, 0, 2, 1], 6_000)) } else { SocketAddr::from(([203, 0, 113, 1], 6_000)) };
                if noticed {
                    pair.nodes[0].on_local_address_change(pair.now);
                } else {
                    pair.nodes[0].connection_mut(pair.handles[0]).expect("connection").ping();
                }
                pair.pump(500_000, &mut |_, _| true);
                let to_new = pair.wire.iter().filter(|(side, _, to, _)| *side == 1 && *to == pair.addresses[0]).cloned().collect::<Vec<_>>();
                assert!(wire_ids(&to_new, 1).is_disjoint(&old[1]), "first validation packet reused an id: mtu {mtu}, noticed {noticed}");
                if noticed {
                    assert!(wire_ids(&pair.wire, 0).is_disjoint(&old[0]), "local change reused an id");
                }
                pair.wire.clear();
                pair.exchange(b"intact after moving");
                pair.assert_live();
                for (side, ids) in old.iter().enumerate() {
                    assert!(wire_ids(&pair.wire, side).is_disjoint(ids), "side {side} kept the old id after validation");
                    assert!(pair.connection(side).security_stats().connection_ids_retired > 0);
                }
                let unknown = pair.nodes[1].stats().unknown_destination;
                pair.nodes[1].on_datagram(pair.now, pair.addresses[0], &delayed);
                assert_eq!(pair.nodes[1].stats().unknown_destination, unknown + 1, "retired id was still routed");

                pair.nodes[0].connection_mut(pair.handles[0]).expect("connection").ping();
                let (original, _) = drain(&mut pair.nodes[0], pair.now).pop().expect("ping");
                let another = pair.connection(1).local_connection_ids().find(|id| Some(*id) != destination_id(&original)).expect("spare");
                let mut tampered = original.clone();
                tampered[3..7].copy_from_slice(&another.to_be_bytes());
                let unauthenticated = pair.connection(1).security_stats().unauthenticated_packets;
                let path = pair.nodes[1].peer_addr(pair.handles[1]);
                pair.nodes[1].on_datagram(pair.now, pair.addresses[0], &tampered);
                assert_eq!(pair.connection(1).security_stats().unauthenticated_packets, unauthenticated + 1);
                assert_eq!(pair.nodes[1].peer_addr(pair.handles[1]), path);
                pair.nodes[1].on_datagram(pair.now, pair.addresses[0], &original);
                pair.exchange(b"still intact after tampering");

                let live_ids = pair.connection(1).local_connection_ids().collect::<Vec<_>>();
                assert!(pair.nodes[1].close(pair.handles[1]).is_some());
                let unknown = pair.nodes[1].stats().unknown_destination;
                for id in &live_ids {
                    tampered[3..7].copy_from_slice(&id.to_be_bytes());
                    pair.nodes[1].on_datagram(pair.now, pair.addresses[0], &tampered);
                }
                assert_eq!(pair.nodes[1].stats().unknown_destination, unknown + live_ids.len() as u64, "close left aliases behind");
                pair.pump(5_000, &mut |_, _| true);
                assert!(pair.connection(0).closed_by_peer(), "close must use the current destination id");
            }
        }
    }
}

#[test]
fn connection_id_loss_reordering_and_exhaustion_do_not_stop_data() {
    let mut pair = RoutingPair::new(135, false);
    let mut delayed = Vec::new();
    // 初次满池快照长 98，确认长 32（加密后的 wire contract）。全部扣下，握手与可靠层仍照常走。
    pair.pump(800_000, &mut |side, packet| {
        if packet.len() == 98 || packet.len() == 32 {
            delayed.push((side, packet.to_vec()));
            false
        } else {
            true
        }
    });
    pair.handles[1] = pair.nodes[1].ids().next().expect("accepted");
    pair.assert_live();
    assert!(pair.connection(0).security_stats().connection_id_retransmissions >= 2, "lost offers were not retried");
    pair.nodes[0].on_local_address_change(pair.now);
    assert!(pair.connection(0).security_stats().connection_id_exhaustions > 0, "missing spares were not counted");
    let data = b"data proceeds while the offer is missing";
    for side in 0..2 {
        pair.nodes[side].connection_mut(pair.handles[side]).expect("connection").send(pair.now, data);
    }
    pair.pump(200_000, &mut |_, packet| packet.len() != 98 && packet.len() != 32);
    for side in 0..2 {
        let mut buffer = [0; 100];
        let size = pair.nodes[side].connection_mut(pair.handles[side]).expect("connection").recv(pair.now, &mut buffer);
        assert_eq!(&buffer[..size], data);
    }
    let retransmissions = pair.connection(0).security_stats().connection_id_retransmissions;
    // 交号放行、确认全丢：收到交号还不等于发出方知道对端收到了，仍须重发。
    pair.pump(600_000, &mut |side, packet| {
        if packet.len() == 32 {
            delayed.push((side, packet.to_vec()));
            false
        } else {
            true
        }
    });
    assert!(pair.connection(0).security_stats().connection_id_retransmissions > retransmissions, "lost acknowledgement stopped retries");
    pair.pump(300_000, &mut |_, _| true);
    pair.assert_live();

    let before = wire_ids(&pair.wire, 0);
    pair.wire.clear();
    // 不给补号包送达的机会，连续 8 次换网络，把 7 个备用号用完。
    for index in 0..8 {
        pair.addresses[0] = SocketAddr::from(([203, 0, 113, index + 1], 6_000));
        pair.nodes[0].on_local_address_change(pair.now);
    }
    pair.exchange(b"data proceeds after exhausting the pool");
    pair.pump(500_000, &mut |_, _| true);
    pair.assert_live();
    assert!(pair.connection(0).security_stats().connection_id_exhaustions >= 2);
    assert!(pair.connection(1).security_stats().connection_ids_retired >= 7, "retired ids were not replaced");
    let ids_before = pair.connection(1).local_connection_ids().collect::<Vec<_>>();
    // 最早的交号包和确认现在才到；不得把已经作废的号复活，也不能停止新代次的重发。
    for (side, packet) in delayed.into_iter().rev() {
        pair.nodes[1 - side].on_datagram(pair.now, pair.addresses[side], &packet);
    }
    assert_eq!(pair.connection(1).local_connection_ids().collect::<Vec<_>>(), ids_before);
    pair.wire.clear();
    pair.addresses[0] = SocketAddr::from(([203, 0, 113, 20], 7_000));
    pair.nodes[0].on_local_address_change(pair.now);
    pair.exchange(b"fresh pool works after delayed old controls");
    assert!(wire_ids(&pair.wire, 0).is_disjoint(&before), "stale snapshot restored an old destination");
    pair.assert_live();
}

#[test]
fn connection_id_aliases_remain_unique_among_many_connections() {
    let mut pair = RoutingPair::new(1_200, true);
    let mut serial = 0u32;
    // 刻意重复随机结果，还会返回 0 和当前句柄／别名，分配器必须跳过。
    pair.nodes[0] = Node::new(move || { serial += 1; serial / 2 });
    let mut handles = Vec::new();
    for index in 0..64 {
        handles.push(pair.nodes[0].connect(pair.now, TestCrypto::from_seed(2_000 + index), Config::default(), PROLOGUE, &listener_public(), &[], pair.addresses[1]).expect("connect"));
    }
    pair.pump(500_000, &mut |_, _| true);
    let mut all = BTreeSet::new();
    for &handle in &handles {
        let connection = pair.nodes[0].connection_mut(handle).expect("handle");
        assert!(connection.is_established());
        assert_eq!(connection.local_connection_ids().count(), 8);
        for id in connection.local_connection_ids() {
            assert!(all.insert(id), "two connections share id {id}");
        }
        connection.send(pair.now, &handle.to_be_bytes());
    }
    assert_eq!(all.len(), handles.len() * 8);
    pair.pump(100_000, &mut |_, _| true);
    let mut received = BTreeSet::new();
    for handle in pair.nodes[1].ids().collect::<Vec<_>>() {
        let mut bytes = [0; 8];
        let size = pair.nodes[1].connection_mut(handle).expect("server connection").recv(pair.now, &mut bytes);
        if size != 0 {
            assert_eq!(size, 4);
            received.insert(u32::from_be_bytes(bytes[..4].try_into().expect("four bytes")));
        }
    }
    assert_eq!(received, handles.into_iter().collect());
}

/// 老交号快照第一次到达时包号仍在重放窗口内，且目的号仍有效：必须按快照代次判断，不能倒退回小池子。
#[test]
fn connection_id_snapshots_do_not_roll_back_when_reordered() {
    let mut pair = Pair::new(1_009, Config::default(), &[]);
    pair.transfer(b"ready", b"ready");
    let mut buffer = vec![0; pair.config.max_packet_size];
    assert!(pair.initiator.add_connection_id(10_001));
    let first = pair.initiator.poll_transmit(pair.now, &mut buffer).expect("first snapshot");
    let first = buffer[..first].to_vec();
    assert!(pair.initiator.add_connection_id(10_002));
    let second = pair.initiator.poll_transmit(pair.now, &mut buffer).expect("newer snapshot");
    let second = buffer[..second].to_vec();
    assert_eq!(pair.deliver(true, &second), Ok(()));
    assert_eq!(pair.deliver(true, &first), Ok(()), "fresh old-generation packet is handled, not a replay");
    let responder = pair.responder.as_mut().expect("responder");
    for expected in [10_001, 10_002] {
        responder.on_local_address_change(pair.now);
        let size = responder.poll_transmit(pair.now, &mut buffer).expect("rotated packet");
        assert_eq!(destination_id(&buffer[..size]), Some(expected), "old snapshot discarded the newer spare");
    }
    assert_eq!(responder.security_stats().connection_id_exhaustions, 0);
}

/// 缺号时临时给验证路径借用了数据路径的号，验证失败只能移除该路径，不能作废仍在用的那个号。
#[test]
fn connection_id_shared_fallback_keeps_the_active_id() {
    let mut pair = Pair::new(1_010, Config::default(), &[]);
    pair.transfer(b"ready", b"ready");
    let mut buffer = vec![0; pair.config.max_packet_size];
    let now = pair.now;
    let responder = pair.responder.as_mut().expect("responder");
    assert!(responder.probe_path(now, 7));
    let (_, path) = responder.poll_transmit_via(now, &mut buffer).expect("validation");
    assert_eq!(path, 7);
    pair.now += 15 * pair.config.initial_rto_us + 1;
    responder.tick(pair.now);
    assert_eq!(responder.validating().count(), 0);
    responder.send(pair.now, b"active route survives");
    while let Some((size, path)) = pair.responder.as_mut().expect("responder").poll_transmit_via(pair.now, &mut buffer) {
        assert_eq!(path, 0);
        assert_eq!(pair.deliver(false, &buffer[..size]), Ok(()), "a live id was erroneously retired");
    }
    let mut received = [0; 100];
    let size = pair.initiator.recv(pair.now, &mut received);
    assert_eq!(&received[..size], b"active route survives");
}

/// 一端刚跟随对端换过路径，自己随即悄悄换网：拥塞估计的「刚换过」窗口不能抑制第二次换号。
#[test]
fn connection_ids_change_when_both_peers_move_in_quick_succession() {
    let mut pair = RoutingPair::new(1_200, true);
    pair.addresses[1] = SocketAddr::from(([198, 51, 100, 2], 444));
    pair.nodes[1].on_local_address_change(pair.now);
    pair.pump(200_000, &mut |_, _| true);
    assert_eq!(pair.connection(0).security_stats().migrations, 1);
    pair.wire.clear();
    pair.exchange(b"after the first move");
    let old = wire_ids(&pair.wire, 0);
    pair.addresses[0] = SocketAddr::from(([203, 0, 113, 2], 6_000));
    pair.nodes[0].connection_mut(pair.handles[0]).expect("connection").ping();
    pair.pump(200_000, &mut |_, _| true);
    pair.wire.clear();
    pair.exchange(b"after both peers moved");
    assert!(wire_ids(&pair.wire, 0).is_disjoint(&old), "recent path switch suppressed the unannounced local change");
    pair.assert_live();
}

/// 系统通知过一次，验证回复却一直收不到；此后又发生未通知的换网，第一次收到的验证也必须再换号。
#[test]
fn connection_ids_change_again_when_the_first_validation_was_lost() {
    let mut pair = RoutingPair::new(1_200, true);
    pair.addresses[0] = SocketAddr::from(([203, 0, 113, 3], 6_000));
    pair.nodes[0].on_local_address_change(pair.now);
    pair.wire.clear();
    pair.pump(20_000, &mut |side, _| side == 0);
    let old = wire_ids(&pair.wire, 0);
    pair.addresses[0] = SocketAddr::from(([203, 0, 113, 4], 6_001));
    pair.nodes[0].connection_mut(pair.handles[0]).expect("connection").ping();
    pair.pump(200_000, &mut |_, _| true);
    pair.wire.clear();
    pair.exchange(b"second local move survived");
    assert!(wire_ids(&pair.wire, 0).is_disjoint(&old), "the stale system notification suppressed a later unannounced move");
    pair.assert_live();
}
