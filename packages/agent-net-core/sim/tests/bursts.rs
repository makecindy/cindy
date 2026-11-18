//! 一阵一阵的大数据：两端一直有零星小消息（每 500 毫秒各 200 字节），大数据隔一阵来一次。
//! 应用层（任务列表、历史、附件）的数据就是这样来的，几乎每一阵都从空闲或只发过小消息的状态开始。
//! 完整的线路对比见 `sim/results/2026-11-14-bursts/`。
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use agent_net_core::{Config, Connection};
use agent_net_sim::{Link, LinkProfile};

const BULK: u64 = 1 << 20;
const TAP: u64 = 200;
const TAP_EVERY_US: u64 = 500_000;

struct Net {
    peers: [Connection; 2],
    links: [Link; 2],
    heap: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>>,
    order: u64,
    now: u64,
    pending: [u64; 2],
    written: [u64; 2],
    read: [u64; 2],
    next_tap: u64,
    /// 两端各自缓冲占用的峰值（字节）。
    peak: [usize; 2],
    /// 每一端写过的零星小消息字节数（`chunked` 数请求时扣掉）。
    tap_bytes: [u64; 2],
    /// 驱动的计时器多久才醒一次（微秒），1 是准时。粗的时候按 `wasm/node.mts` 的规则醒，见 `step`。
    timer_us: u64,
    /// 有一端要每轮看时间（驱动一直占着 CPU）的总时长。
    fine_us: u64,
}

impl Net {
    fn new(profile: &LinkProfile, seed: u64) -> Self {
        Self::with_config(profile, seed, Config::default())
    }

    fn with_config(profile: &LinkProfile, seed: u64, config: Config) -> Self {
        Self {
            peers: [Connection::new(config.clone(), 0), Connection::new(config, 0)],
            links: [Link::new(profile.clone(), seed), Link::new(profile.clone(), seed ^ 0x5A5A)],
            heap: BinaryHeap::new(),
            order: 0,
            now: 0,
            pending: [0; 2],
            written: [0; 2],
            read: [0; 2],
            next_tap: 0,
            peak: [0; 2],
            tap_bytes: [0; 2],
            timer_us: 1,
            fine_us: 0,
        }
    }

    fn step(&mut self) {
        let now = self.now;
        if now >= self.next_tap {
            self.pending = self.pending.map(|pending| pending + TAP);
            self.tap_bytes = self.tap_bytes.map(|bytes| bytes + TAP);
            self.next_tap += TAP_EVERY_US;
        }
        let chunk = [7u8; 4096];
        for side in 0..2 {
            while self.pending[side] > 0 {
                let n = self.peers[side].send(now, &chunk[..4096.min(self.pending[side] as usize)]) as u64;
                if n == 0 {
                    break;
                }
                self.pending[side] -= n;
                self.written[side] += n;
            }
        }
        while self.heap.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Reverse((_, _, to, packet)) = self.heap.pop().unwrap();
            let _ = self.peers[to].on_packet(now, &packet);
        }
        let read_before = self.read;
        let mut sink = [0u8; 65536];
        for side in 0..2 {
            loop {
                let n = self.peers[side].recv(now, &mut sink);
                if n == 0 {
                    break;
                }
                self.read[side] += n as u64;
            }
        }
        for side in 0..2 {
            self.peak[side] = self.peak[side].max(self.peers[side].buffered_bytes());
        }
        let mut out = [0u8; 2048];
        for side in 0..2 {
            if self.peers[side].next_wake().is_some_and(|wake| wake <= now) {
                self.peers[side].tick(now);
            }
            while let Some(n) = self.peers[side].poll_transmit(now, &mut out) {
                let (arrivals, count) = self.links[side].transmit(now, n);
                for &at in &arrivals[..count] {
                    self.order += 1;
                    self.heap.push(Reverse((at, self.order, 1 - side, out[..n].to_vec())));
                }
            }
        }
        let mut next = self.next_tap;
        if let Some(Reverse(item)) = self.heap.peek() {
            next = next.min(item.0);
        }
        // 读到数据的这一刻应用就能回（Node 里应用写数据，驱动当轮就处理），不用等下一次醒来。
        if self.read != read_before {
            next = next.min(now + 1);
        }
        // 计时器粗时，核心说等不起（`needs_fine_timer`）的一端一个周期内的等待每轮看时间，其余等到下一个周期才醒，醒来补发。
        let mut fine = false;
        for peer in &self.peers {
            if let Some(wake) = peer.next_wake() {
                let precise = self.timer_us == 1 || peer.needs_fine_timer(self.timer_us);
                fine |= self.timer_us > 1 && precise && wake < now + self.timer_us;
                let quantum = if precise { 1 } else { self.timer_us };
                next = next.min(wake.max(now + 1).div_ceil(quantum) * quantum);
            }
        }
        self.now = next.max(now + 1);
        if fine {
            self.fine_us += self.now - now;
        }
    }

    /// `side` 写 1 MiB，返回对端读完用了多少微秒。
    fn burst(&mut self, side: usize) -> u64 {
        self.burst_of(side, BULK)
    }

    fn burst_of(&mut self, side: usize, bytes: u64) -> u64 {
        let start = self.now;
        let target = self.written[side] + self.pending[side] + bytes;
        self.pending[side] += bytes;
        while self.read[1 - side] < target && self.now < start + 120_000_000 {
            self.step();
        }
        self.now - start
    }

    /// 分块请求-回复，和端到端压测 bulk-transfer.ts 一样：A 同时发 `concurrency` 个 64 字节的请求，B 每收到一个回 512 KiB，
    /// A 收完一块再发下一个请求，共 `chunks` 块；返回用时。零星小消息照常发：读到的字节扣掉对端写过的小消息再数，
    /// 还在路上的小消息只会让这一端晚一点数到，不会数多。
    fn chunked(&mut self, chunks: u64, concurrency: u64) -> u64 {
        const REQUEST: u64 = 64;
        const CHUNK: u64 = 512 * 1024;
        let start = self.now;
        let (base_a, base_b) = (self.read[0], self.read[1]);
        let taps_at_start = self.tap_bytes;
        let mut requested = concurrency.min(chunks);
        self.pending[0] += REQUEST * requested;
        let mut responded = 0;
        while self.now < start + 120_000_000 {
            self.step();
            let requests = (self.read[1] - base_b).saturating_sub(self.tap_bytes[0] - taps_at_start[0]) / REQUEST;
            while responded < requests.min(chunks) {
                self.pending[1] += CHUNK;
                responded += 1;
            }
            let done = (self.read[0] - base_a).saturating_sub(self.tap_bytes[1] - taps_at_start[1]) / CHUNK;
            if done >= chunks {
                break;
            }
            while requested < chunks && requested < done + concurrency {
                self.pending[0] += REQUEST;
                requested += 1;
            }
        }
        self.now - start
    }

    fn idle(&mut self, us: u64) {
        let until = self.now + us;
        while self.now < until {
            self.step();
        }
    }
}

/// 2026-11-14：空闲 2 秒后的一阵要 4.04 秒（线路上 1.05 秒就能传完）。限速判断取最近几轮的平均送达速率，
/// 空闲时零星小消息那几轮（每秒几百字节）也算在里面，新一阵一开始就被当成撞上了限速，节奏压到每秒 10 KB；
/// 头几个包按这个节奏把下一次发送排到 0.57 秒以后，期间每个往返只能发 4 个不等节奏的包，十轮后带宽估计也被挤掉。
/// 现在只看发送方一直有数据可发的轮次，三阵都在 1.1 秒左右。没有随机因素，一个种子就够。
#[test]
fn bursts_after_idle_keep_the_line_rate() {
    let line = LinkProfile { bits_per_second: 8_000_000, delay_us: 20_000, queue_us: 262_000, ..LinkProfile::default() };
    let mut net = Net::new(&line, 1);
    net.idle(1_000_000);
    for idle_us in [0, 2_000_000, 5_000_000] {
        net.idle(idle_us);
        let took = net.burst(0);
        assert!(took <= 1_250_000, "after {idle_us}us idle: {took}us for 1 MiB at 1 MB/s");
    }
}

/// 不打乱先后的抖动（Wi-Fi 聚合、经 TCP 中转）：一个包被耽搁，后面的包都要等它。先由 B 传 1 MiB（A 只回确认和小消息），
/// 再由 A 传 1 MiB。2026-11-14 前 A 这一阵平均要 6.6 秒（线路的 16%）：
/// - A 只发过小消息，某个小消息的往返碰上抖动就被当成排队，起速阶段带着每秒几 KB 的估计结束了；
/// - 连续发包时每个包都碰上最近最大的那次耽搁，往返整体抬高约 30 毫秒，起速一两轮就因为“排队”结束，估计停在三成以下。
/// 现在零星包不结束起速；抖动大到排队余量盖不住时，满负荷发送还要带宽有一轮没涨上去才算排队。
/// 同日一阵开头改成快发量速以后平均 1.13 秒；不看抖动、只看往返就结束起速的话是 1.51 秒。
#[test]
fn jitter_does_not_end_startup_before_the_line_is_full() {
    let line = LinkProfile { bits_per_second: 8_000_000, delay_us: 20_000, jitter_us: 30_000, jitter_fifo: true, queue_us: 262_000, ..LinkProfile::default() };
    let mut total = 0;
    for seed in 1..=4 {
        let mut net = Net::new(&line, seed);
        net.idle(1_000_000);
        net.burst(1);
        net.idle(2_000_000);
        total += net.burst(0);
    }
    assert!(total / 4 <= 1_300_000, "first burst after only small messages took {}us on average", total / 4);
}

/// 2026-11-14：产品把在途上限从 1024 个分片放到 8192 个、每条流发送缓冲上限放到 24 MiB 以后，缓冲不能一直按上限占内存：
/// 每条流能缓冲的量跟着拥塞窗口走（两倍窗口，至少 1 MiB），拥塞窗口按实测的带宽和往返算。
/// - 慢线路上一次写 8 MiB，按固定上限算会整个收进来，占 8 MB；现在最多约 1 MB，其余留在应用那边。
/// - 千兆、往返 20 毫秒的线路上一个窗口约 2.5 MB，缓冲要跟着放大才不断流：窗口 1024 时 20 MiB 只跑到线路的 54%，
///   现在 95%；缓冲一直停在 1 MiB 的话只有约四成。
#[test]
fn send_buffer_follows_the_path() {
    let config = Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, ..Config::default() };
    let slow = LinkProfile { bits_per_second: 2_000_000, delay_us: 50_000, queue_us: 524_000, ..LinkProfile::default() };
    let mut net = Net::with_config(&slow, 1, config.clone());
    net.idle(1_000_000);
    net.burst_of(0, 8 << 20);
    assert!(net.peak[0] <= 1_500_000, "slow path buffered {} bytes", net.peak[0]);

    let gigabit = LinkProfile { bits_per_second: 1_000_000_000, delay_us: 10_000, jitter_us: 500, queue_us: 20_000, ..LinkProfile::default() };
    let mut net = Net::with_config(&gigabit, 1, config);
    net.idle(1_000_000);
    net.burst_of(0, 20 << 20);
    net.idle(2_000_000);
    let took = net.burst_of(0, 20 << 20);
    // 20 MiB 在 1 Gbit/s 上要 0.168 秒，八成五是 0.197 秒。
    assert!(took <= 197_000, "20 MiB at 1 Gbit/s took {took}us");
}

/// 2026-11-14：往返 200 毫秒、每秒 6.25 MB 的线路（和端到端压测的「跨地区」一档一样），两端之前只有零星小消息。
/// 原来带宽估计停在小消息的速度（每秒约 2 KB），窗口按它算比新连接的初始窗口还小，一阵 1 MiB 每个往返涨不到三倍，
/// 要 1.1 秒（线路上 0.27 秒）。现在一阵开头那一串按新连接第一批包的方式快发，用确认间隔一个往返内量出线路速度：0.46 秒。
/// 量出瓶颈以后，之后几阵按它的 1.25 倍发：仍按启动阶段的倍数冲的话，一阵 1 MiB 一下冲过 100 毫秒的队列，
/// 丢掉的要多等一个往返，0.5 秒；现在 0.27 秒。没有随机因素，一个种子就够。
#[test]
fn a_burst_on_a_long_path_learns_the_line_from_its_first_packets() {
    let config = Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, ..Config::default() };
    let far = LinkProfile { bits_per_second: 50_000_000, delay_us: 100_000, queue_us: 100_000, ..LinkProfile::default() };
    let mut net = Net::with_config(&far, 1, config);
    net.idle(1_000_000);
    let first = net.burst(0);
    assert!(first <= 600_000, "first burst took {first}us");
    for idle_us in [2_000_000, 5_000_000] {
        net.idle(idle_us);
        let took = net.burst(0);
        assert!(took <= 350_000, "after {idle_us}us idle: {took}us");
    }
}

/// 2026-11-14：不打乱先后的抖动线路（每秒 1 MB、往返 80 毫秒、抖动 30 毫秒，Wi-Fi 聚合与经 TCP 转发就是这样），
/// 先只有零星小消息，再按块请求-回复（同时 4 块，共 4 MiB）。16 个随机种子现在都是 4.4～4.6 秒（线路的九成以上）。之前两种误判：
/// - 连续发的包都碰上最近最大的那次耽搁，往返整体抬高、相邻差值却很小，按相邻差值估的抖动盖不住排队判断，
///   回数据的一端起步在每秒约 0.3 MB 就结束，之后每轮只涨一点（种子 1：9.3 秒）。现在也看零星消息的往返比最低值高出多少。
/// - 大数据刚开始那一轮样本不够，拿上一轮零星消息碰上的一次耽搁判排队，起步在每秒约 9 KB 就结束（种子 5：7.0 秒）。
///   现在只用有满负荷发送的那一轮判排队。
#[test]
fn ordered_jitter_does_not_end_startup_on_chunked_transfers() {
    let line = LinkProfile { bits_per_second: 8_000_000, delay_us: 40_000, jitter_us: 30_000, jitter_fifo: true, queue_us: 262_000, ..LinkProfile::default() };
    for seed in 1..=16 {
        let mut net = Net::new(&line, seed);
        net.idle(1_000_000);
        let took = net.chunked(8, 4);
        assert!(took <= 5_500_000, "seed {seed}: 4 MiB in 512 KiB chunks with ordered jitter took {took}us");
    }
}

/// 2026-11-16：Windows 上 Node 的计时器约 15.6 毫秒才醒一次。驱动只在核心说这条连接等不起（`needs_fine_timer`）时
/// 每轮事件循环看时间，其余交给计时器、醒来补发攒下的包（`wasm/node.mts`）。之前驱动先量出收发速率再切，一阵开头
/// 已经按计时器走完了：真实线路（往返约 16 毫秒、每秒约 20 MB）上 20 MiB 慢一到两成；一直看时间的话，每秒 1 MB 的线路上
/// 每 MB 要 1.8 秒 CPU（同一进程两端合计）。这里按同样的规则醒，分块请求-回复和压测一样（每块 512 KiB、同时 4 块）：
/// 每秒 20 MB 的线路上和计时器准时一样快（一直交给计时器慢 3%），每秒 1 MB 的线路上一直看时间的时候不到传输时间的 2%
/// （一直看时间是 97%，零星小消息在途时也看是 4%）。没有随机因素，一个种子就够。
#[test]
fn coarse_timers_slow_neither_fast_chunks_nor_keep_slow_lines_busy() {
    let config = Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, ..Config::default() };
    let vpn = LinkProfile { bits_per_second: 160_000_000, delay_us: 8_000, queue_us: 50_000, ..LinkProfile::default() };
    let chunks = |timer_us| {
        let mut net = Net::with_config(&vpn, 1, config.clone());
        net.timer_us = timer_us;
        net.idle(1_000_000);
        net.chunked(16, 4)
    };
    let (precise, coarse) = (chunks(1), chunks(16_000));
    assert!(coarse * 100 <= precise * 101, "8 MiB in 512 KiB chunks at 20 MB/s: {coarse}us with a 16 ms timer, {precise}us with a precise one");

    let line = LinkProfile { bits_per_second: 8_000_000, delay_us: 20_000, queue_us: 262_000, ..LinkProfile::default() };
    let mut net = Net::new(&line, 1);
    net.timer_us = 16_000;
    net.idle(1_000_000);
    let before = net.fine_us;
    let took = net.chunked(4, 4);
    assert!(took <= 2_400_000, "2 MiB in 512 KiB chunks at 1 MB/s with a 16 ms timer took {took}us");
    assert!((net.fine_us - before) * 50 <= took, "kept the timer precise for {}us of {took}us at 1 MB/s", net.fine_us - before);
}
