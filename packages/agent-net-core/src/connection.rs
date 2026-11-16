//! 单条可靠字节流。蒸馏自 KCP：
//!
//! - 保留：`una` 累计确认加逐包确认、快速重传、1.5 倍退避、窗口探测、未读数据计入接收窗口、最老分片优先重传。
//! - 改动：重传使用新包号；确认按包号区间表达，比 KCP 每分片 24 字节的确认更省。
//! - 新增：带宽估计和发送节奏（见 `congestion.rs`）、按时间判丢、从误判中学习乱序程度、
//!   丢包时捎带小消息、窗口被卡住时重传发两份、按丢包率调整的校验包（见 `parity.rs`）、多路流（见 `stream.rs`）。
//! - 不在这里：加密、连接号和换地址都在 `secure.rs`，明文连接没有认证，不能跟着来源地址换路径。

use alloc::collections::{BTreeMap, BTreeSet, VecDeque};
use alloc::vec::Vec;

use crate::congestion::{Bbr, RECOVERY_TIMEOUTS, RateSample};
use crate::parity::{self, MAX_UNKNOWNS};
use crate::rtt::RttEstimator;
use crate::stream::{DEFAULT_STREAM, HEADED_LENGTH_BIT, Priority, RecvStream, STREAM_HEADER_LEN, Scheduler, SendStream, StreamEvent, StreamHeader};
use crate::wire::{self, Frame};

const MAX_SEGMENTS_PER_PACKET: usize = 16;
/// 接收端记住的包号区间上限，防止对端用稀疏包号撑大内存。
const MAX_TRACKED_RANGES: usize = 64;
/// 在途分片少于这个数时不受发送节奏限制：交互消息不该为匀速排队。
const UNPACED_SEGMENTS: u32 = 4;
/// 拥塞窗口的下限，单位是分片。
const MIN_CWND_SEGMENTS: u64 = 16;
const INITIAL_CWND_SEGMENTS: u64 = 64;
/// 丢包率估计的平滑系数。太短的话丢 1% 时估计值大起大落，四分之一的时间捎带是关着的。
const LOSS_SMOOTHING: u32 = 256;
/// 最近丢包率超过这个值才捎带，单位百万分之一。干净网络上不多花一个字节。
const BUNDLE_LOSS_PPM: u32 = 2_000;
/// 丢过一个包后，这么多个往返之内都捎带，最长这么久。丢包率估计在两次丢包之间会掉到门槛以下，
/// 这时再丢一个，小消息要等一个往返，后面的消息全被堵住。往返越短，这个代价越小，用不着一直带着副本。
const BUNDLE_HOLD_RTTS: u64 = 150;
const BUNDLE_HOLD_US: u64 = 30_000_000;
/// 这么久完全没有收到对端的包才算长断网：放慢重试、只发少量探测。更短的中断要尽快重连。
const LONG_OUTAGE_US: u64 = 2_000_000;
/// 连接开头还没测过丢包率，这么多个包之内也捎带。第一个丢包要一个往返才发现，
/// 长 RTT 路径上这一个包能堵住十几条消息。满载的包没有空位，只有小消息花这点流量。
/// 自动策略只带够发现第一个丢包所需的量，干净路径上这也是白花的流量；速度优先策略带得多一些。
const AUTO_BUNDLE_WARMUP_PACKETS: u32 = 40;
const BUNDLE_WARMUP_PACKETS: u32 = 128;
/// 丢包率达到这些值时捎带这么多份，让连续丢光的概率压到千分之一左右。
/// 小消息丢了要等一个往返，后面的消息全被堵住，长 RTT 路径上要乘十几倍。
const BUNDLE_COPIES: [(u32, usize); 3] = [(200_000, 4), (100_000, 3), (35_000, 2)];
const MAX_BUNDLED_SEGMENTS: usize = 4;
/// 随机丢包率超过这个值，窗口被卡住时给重传分片多发一份。
/// 只看随机丢包：瓶颈溢出时再多发一份只会丢得更多。
const DUPLICATE_LOSS_PPM: u32 = 20_000;
/// 有校验包时大部分丢包不用重传，丢得更多才值得再发副本。
const DUPLICATE_WITH_PARITY_LOSS_PPM: u32 = 50_000;
/// 等待发送的副本上限，防止丢包很重时副本比数据还多。
const MAX_DUPLICATES_QUEUED: usize = 16;
const BUNDLE_SCAN_SEGMENTS: usize = 8;
const BUNDLE_OLDEST_TIMEOUTS: u32 = 2;
/// 乱序时最多再等这么久发确认，把突发的乱序合并成一个确认包。
const REORDER_ACK_DELAY_US: u64 = 1_000;
/// 丢包率在这个范围内才发校验包。太低不值得；太高时校验比数据还多，不如重传。
const PARITY_MIN_LOSS_PPM: u32 = 1_000;
const PARITY_MAX_LOSS_PPM: u32 = 400_000;
/// 开头见过丢包后，校验至少按这个丢包率给：样本还少，估计值可能偏低。
const EARLY_PARITY_LOSS_PPM: u32 = 20_000;
/// 确认丢过包后，这么久之内校验至少按最低比例保持开启。丢包率估计在两次丢包之间会降到门槛以下，
/// 这时关掉的话，下一个丢包只能等重传，窗口整整卡一个往返。
const PARITY_FLOOR_HOLD_US: u64 = 5_000_000;
/// 窗口不超过校验覆盖范围的这么多倍时，自动策略才按速度优先的余量发校验。
const HEAVY_PARITY_COVERAGE_FACTOR: u64 = 4;
/// 丢的包里，紧挨着上一个丢包的比例达到这个值就算成片地丢。随机丢包时这个比例等于丢包率。
const PARITY_LOST_RUN_PPM: u32 = 500_000;
const LOST_RUN_SMOOTHING: u32 = 16;
const LOST_RUN_DECAY_PACKETS: u32 = 1024;
/// 比后面的包晚这么多个才算晚到。
const LATE_PACKET_DISTANCE: u64 = 16;
/// 窗口满了但还没到发校验包的时候，等这么多分之一个往返再发。
/// 确认一个个回来时窗口总是刚满，一满就发的话，校验包的间隔被切得很短，占比翻倍。
const PARITY_FLUSH_RTT_DIVISOR: u64 = 4;
/// 接收端暂存的校验包：缺得多时要等够数量，或者等重传到了再算。
const MAX_PENDING_PARITY: usize = MAX_UNKNOWNS;
/// 接收端保留多少个读过的分片：算校验时，覆盖范围里前面的分片可能已经被应用读走了。
const MAX_HISTORY_SEGMENTS: usize = parity::MAX_COVERED as usize + 16;
/// 记住最近这么多组校验包的发送时间，判丢时用。
const PARITY_RECORDS: usize = 64;
/// 这么久没见到校验包，就不再保留读过的分片。
const PARITY_HISTORY_US: u64 = 2_000_000;
/// 确认帧要额外带上的晚到包数量。
const MAX_LATE_PACKETS: usize = 4;
/// 乱序容忍度每隔这么多个往返回落一次，路径恢复后不用一直等。
const REORDER_DECAY_RTTS: u64 = 16;
/// 空闲分片缓冲的数量上限，避免收发路径上反复申请内存。
const MAX_SPARE_BUFFERS: usize = 256;
/// 为抖动多发校验时每轮最多加这么多。
const JITTER_PARITY_STEP_PPM: u32 = 50_000;
/// 逐轮多发的校验比例最多到丢包率的这么多倍、不超过这个上限。丢的包等校验包的时间约占往返的“丢包率 × 校验间隔 ÷ 2”，
/// 校验间隔减半，窗口每轮卡的时间也减半。
const LOSS_PARITY_FACTOR: u32 = 40;
const LOSS_PARITY_MAX_PPM: u32 = 250_000;
/// 往返短于这个值时不为抖动多发校验：局域网一类的路径上，晚到的包只让窗口多等零点几毫秒，校验包反倒占掉不多的余量。
const JITTER_PARITY_MIN_RTT_US: u64 = 10_000;
/// 顶起过队列以后，上限每轮放开这么多。
const JITTER_CEILING_RELAX_PPM: u32 = 2_000;
/// 收到的包平均间隔短于这个值（每秒两万个包以上）时，每个包都马上确认。
const FAST_ARRIVAL_GAP_US: u64 = 50;
/// 晚到的包超过这个比例、平均比后发的包晚到这么久以上时逐包确认。
const JITTERY_LATE_PPM: u32 = 100_000;
const JITTERY_LATE_US: u64 = 4000;
/// 记住最近这么多个包的到达时间。
const RECENT_ARRIVALS: usize = 64;
/// 丢包率比随机丢包率的两倍还高出这么多，又量到了上限，就当成限速器在丢包。
const LIMITER_EXCESS_LOSS_PPM: u64 = 30_000;
/// 待发和没确认的数据加起来不超过这么多个分片，算零散消息。
const SPARSE_BACKLOG_SEGMENTS: u64 = 64;
/// 所有流加起来没读走的分片上限，是接收窗口的这么多倍。一条流最多占一个窗口，读得慢的流拖不住别的流。
const MAX_UNREAD_WINDOWS: usize = 4;
/// 所有流加起来的发送缓冲上限，是 `send_buffer_bytes` 的这么多倍。一条流写满缓冲时别的流还能写。
const MAX_SEND_BUFFERS: usize = 2;
/// 读走窗口的这么多分之一就更新额度。
const GRANT_FRACTION: u64 = 8;
/// 新的流量额度跟着这么多个确认发出去，确认丢了也不用等超时。
const GRANT_REPEATS: u8 = 3;
/// 最近这么久发过数据的流，算还在发。
const STREAM_ACTIVE_US: u64 = 1_000_000;
/// 交互流和大量数据同时在发时，发送窗口留出这么多分之一给交互流。
const INTERACTIVE_WINDOW_RESERVE: u64 = 16;
/// 每个往返最多这么多个分片的交互流数据不用等节奏和拥塞窗口。
const INTERACTIVE_ROUND_SEGMENTS: usize = 8;
/// 一个确认包最多带这么多条流的额度。
const MAX_GRANTS_PER_PACKET: usize = 2;

/// 传输策略；只影响发送节奏和冗余，不改变线格式。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RecoveryPolicy {
    /// 自动保护交互小消息，持续中断时回到保守探测。
    #[default]
    Auto,
    /// 只重传缺失数据，省去主动副本、捎带和校验；恢复延迟可能增加。
    Lean,
    /// 更快启动并增加窗口受限路径的校验，可能明显增加流量。
    Fast,
}

/// 和同一条线路上别的流量怎么分；只影响发送速度，不改变线格式，两端可以选得不一样。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BandwidthShare {
    /// 全速：尽量用满线路。和 TCP 同跑时占大头。
    #[default]
    Full,
    /// 让路：按 CUBIC 的规则发，见到丢包就减速，和 TCP 接近平分。有随机丢包的路径上会和 TCP 一样明显变慢。
    Fair,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub recovery_policy: RecoveryPolicy,
    pub bandwidth_share: BandwidthShare,
    /// 单个 UDP 载荷的上限，含包头。
    pub max_packet_size: usize,
    /// 同时在途的分片上限。
    pub send_window: u32,
    /// 接收窗口，单位是分片。每条流各有这么大的窗口。
    pub recv_window: u32,
    /// 每个方向同时存在的流数上限，含默认流。
    pub max_streams: u32,
    /// 每条流的发送缓冲字节上限。写满后 `send` 只接受部分数据。
    pub send_buffer_bytes: usize,
    pub initial_rto_us: u64,
    pub min_rto_us: u64,
    pub max_rto_us: u64,
    /// 比某包晚发的包已有这么多被确认时，判定该包丢失。
    pub reorder_threshold: u64,
    pub ack_delay_us: u64,
    /// 累计收到这么多包后立即确认。
    pub ack_every: u32,
    /// 有未确认数据却这么久没收到任何有效包时，放弃连接。
    pub dead_after_us: u64,
    pub probe_initial_us: u64,
    pub probe_max_us: u64,
    /// 起始序号。测试用来覆盖 32 位回绕，正常使用保持 0。
    pub initial_sequence: u64,
    pub initial_packet_number: u64,
    /// 加密连接：对端发给这一端的每个数据包都带着这个号，调用方按它找到连接，地址变了也找得到。
    /// 由这一端自己选，同一个端口上的连接各不相同。明文连接不用。
    pub connection_id: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            recovery_policy: RecoveryPolicy::Auto,
            bandwidth_share: BandwidthShare::Full,
            max_packet_size: 1400,
            send_window: 128,
            recv_window: 128,
            max_streams: 64,
            send_buffer_bytes: 1 << 20,
            initial_rto_us: 200_000,
            min_rto_us: 30_000,
            // 判死前要留够重试次数：30 秒内至少 15 次，双向重度丢包时才不会把活着的对端判死。
            max_rto_us: 2_000_000,
            reorder_threshold: 3,
            ack_delay_us: 2_000,
            ack_every: 2,
            dead_after_us: 30_000_000,
            probe_initial_us: 250_000,
            probe_max_us: 5_000_000,
            initial_sequence: 0,
            initial_packet_number: 0,
            connection_id: 0,
        }
    }
}

impl Config {
    /// 先取得所选策略的默认值，再通过字段覆写定制；不改调用方显式给出的字段。
    pub fn for_policy(recovery_policy: RecoveryPolicy) -> Self {
        Self {
            recovery_policy,
            ack_every: if recovery_policy == RecoveryPolicy::Fast { 1 } else { 2 },
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PacketError {
    Malformed,
    InvalidAck,
    Dead,
    /// 加密连接：认证失败，可能被篡改、不是这条连接的包，或者密钥还没协商好。
    Unauthenticated,
    /// 加密连接：这个包已经收过，或者旧到超出了防重放窗口。
    Replayed,
    /// 加密连接：对端发来新的握手，这条连接处理不了，交给 `Incoming::read`。
    Handshake,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub packets_sent: u64,
    pub packets_received: u64,
    pub wire_bytes_sent: u64,
    pub wire_bytes_received: u64,
    pub retransmitted_segments: u64,
    pub bundled_segments: u64,
    pub parity_packets: u64,
    /// 靠校验包算出来的分片数，这些分片省掉了一次往返。
    pub recovered_segments: u64,
    pub timeout_losses: u64,
    pub fast_losses: u64,
    /// 判定丢失后确认又到了的包，说明是乱序不是丢包。
    pub spurious_losses: u64,
    pub duplicate_packets: u64,
    pub rejected_packets: u64,
    pub srtt_us: u64,
    pub min_rtt_us: u64,
    /// 估计的路径带宽，字节每秒。
    pub bandwidth: u64,
    /// 估计的随机丢包率，百万分之一。
    pub random_loss_ppm: u32,
    /// 发现的限速上限，字节每秒。0 表示没有发现。
    pub rate_cap: u64,
    /// 量到过几次限速。上限会周期性放开试探，`rate_cap` 在某一时刻是 0 不代表没发现过。
    pub rate_limits_found: u64,
    /// 当前发送节奏，字节每秒。
    pub pacing_rate: u64,
}

struct Segment {
    /// 分片内容，带流头时流头在最前面。
    data: Vec<u8>,
    stream: u32,
    headed: bool,
    /// 属于交互流，丢了先补。
    urgent: bool,
    acked: bool,
    in_flight: bool,
    sent_before: bool,
}

/// 收到的分片。校验包可能还要用到，所以交付给流以后内容还留着。
struct Received {
    body: Vec<u8>,
    headed: bool,
    /// 属于哪条流的第几个分片。没带流头时要等前一个分片到了才知道。
    place: Option<(u32, u64)>,
    delivered: bool,
}

fn coded_length(length: usize, headed: bool) -> u16 {
    length as u16 | if headed { HEADED_LENGTH_BIT } else { 0 }
}

#[derive(Clone, Copy)]
struct SentPacket {
    number: u64,
    sent_at: u64,
    bytes: u32,
    segment_count: u8,
    segments: [u64; MAX_SEGMENTS_PER_PACKET],
    /// 发出后第一个校验包的编号，0 表示没有校验保护。
    parity_group: u64,
    /// 捎带的分片副本：收到确认算数，丢了不用管，原件还在别的包里。
    bundled_count: u8,
    bundled: [u64; MAX_BUNDLED_SEGMENTS],
    /// 发送时速率低于路径容量，这个包的结果可以用来估计随机丢包率。
    below_capacity: bool,
    /// 发送时随机丢包的估计不会被限速丢包污染，结果可以算进去。
    calm_trusted: bool,
    /// 发送时队列是别的流排的。
    calm_foreign: bool,
    /// 发送时正处在加速探测阶段。
    probing: bool,
    /// 发送时正在巡航。和同一个探测周期里降速阶段的包比丢包率，看丢包是不是跟着速率涨。
    cruising: bool,
    /// 发送时是第几个探测周期。
    cycle: u32,
    app_idle: bool,
    // 发送时的送达进度，确认到达时用来计算实际送达速率。
    delivered: u64,
    delivered_at: u64,
    first_sent_at: u64,
    app_limited: bool,
}

impl SentPacket {
    /// 满负荷发送时，这个包是降速阶段（`true`）还是巡航阶段（`false`）发的。应用没数据时发的不算：那时速率是应用定的。
    fn compared_phase(&self) -> Option<bool> {
        if self.app_idle {
            None
        } else if self.below_capacity {
            Some(true)
        } else if self.cruising {
            Some(false)
        } else {
            None
        }
    }
}

struct PendingParity {
    first: u64,
    count: u8,
    symbol: u8,
    length: u16,
    data: Vec<u8>,
}

impl PendingParity {
    fn end(&self) -> u64 {
        self.first + self.count as u64
    }
}

/// 判定丢失但还没过期的包。确认后到说明判错了，要据此放宽判丢窗口。
#[derive(Clone, Copy)]
struct LostPacket {
    packet: SentPacket,
    declared_at: u64,
    /// 判丢时最大已确认包号比它大多少。
    distance: u64,
}

pub struct Connection {
    config: Config,
    /// 外层（加密）给每个包追加的字节数。只影响分片大小和流量计量，明文连接是 0。
    overhead: usize,
    max_segment: usize,
    rtt: RttEstimator,
    congestion: Bbr,
    stats: Stats,
    dead: bool,
    last_heard: u64,
    spare_buffers: Vec<Vec<u8>>,

    // 发送侧。segments[0] 的序号恒为 snd_una。
    segments: VecDeque<Segment>,
    snd_una: u64,
    snd_sent: u64,
    send_buffered: usize,
    send_streams: BTreeMap<u32, SendStream>,
    scheduler: Scheduler,
    next_stream_id: u32,
    /// 交互流和其他流都在发：其他流要给它让路，也要少占网络里的队列。
    mixed_traffic: bool,
    last_interactive_at: Option<u64>,
    last_other_at: Option<u64>,
    /// 这个往返里发了多少交互流的数据。
    urgent_round_at: u64,
    urgent_round_bytes: usize,
    /// 上一个切出来的分片属于哪条流，下一个流内序号。接下来的分片接得上就不用带流头。
    tail_stream: (u32, u64),
    /// 待重传的分片，交互流的先发，其余序号最小的先发：它堵着对端所有已到的后续数据。
    /// 按丢失先后排队会让它排在几百片后面，瓶颈很小时几十秒都轮不到。
    retransmit: BTreeSet<(bool, u64)>,
    /// 待发送的重传副本。窗口被卡住时重传再丢一次就要多等一个往返，发两份几乎不会再丢。
    duplicates: VecDeque<u64>,
    /// 上一个校验包之后发的新分片数。
    parity_pending: u32,
    parity_target: u32,
    parity_symbol: u8,
    /// 窗口满时，下一个校验包最晚什么时候发。
    parity_flush_at: u64,
    parity_group_number: u64,
    /// 每组的校验包什么时候发出，还没发是 `None`。不能拿 0 当“没发”：时钟从 0 开始时，开头就发的校验包会被当成不存在。
    parity_sent_at: [Option<u64>; PARITY_RECORDS],
    /// 待确认的包，包号和发送时间都单调递增。
    sent: VecDeque<SentPacket>,
    lost: VecDeque<LostPacket>,
    packet_threshold: u64,
    /// 通过误判学到的额外等待时间。
    reorder_delay_us: u64,
    reorder_decay_at: u64,
    next_packet: u64,
    largest_acked: Option<u64>,
    /// 已确认的包里最晚发出的那个的发送时间。
    largest_acked_sent_at: u64,
    in_flight: u32,
    bytes_in_flight: u64,
    delivered: u64,
    delivered_at: u64,
    first_sent_at: u64,
    consecutive_timeouts: u32,
    last_timeout_at: u64,
    /// 这之前不判超时，见 [`Self::hold_timeouts`]。
    timeouts_held_until: u64,
    loss_ppm: u32,
    loss_samples: u32,
    /// 晚到得足以堵住窗口的包占多少，单位百万分之一。
    late_ppm: u32,
    /// 被抖动拖晚、比后发的包更晚确认的包所占比例。窗口卡住时它们和丢包一样堵窗口头部。
    jitter_late_ppm: u32,
    /// 为抖动多发的校验比例，见 `adjust_jitter_parity`。
    jitter_parity_ppm: u32,
    jitter_parity_round: u64,
    /// 上次把队列顶起来时的比例的四分之三，之后加到这里为止，慢慢再放开。
    jitter_parity_ceiling: u32,
    bundle_until: u64,
    /// 最近一次确认丢包后，保持最低校验比例到这个时刻。
    parity_floor_until: u64,
    /// 丢的包里紧挨着上一个丢包的比例，单位百万分之一。
    lost_run_ppm: u32,
    last_lost_packet: u64,
    peer_una: u64,
    peer_window: u32,
    probe_at: Option<u64>,
    probe_interval_us: u64,
    probe_due: bool,

    // 接收侧。
    rcv_next: u64,
    /// 序号还没连上的分片，`rcv_next` 之后的都在这里。
    reorder: BTreeMap<u64, Received>,
    reorder_bytes: usize,
    recv_streams: BTreeMap<u32, RecvStream>,
    /// 所有流交付了、应用还没读走的分片和字节。
    unread_segments: usize,
    ready_bytes: usize,
    /// `rcv_next` 之前的那个分片属于哪条流，下一个流内序号。
    rcv_tail: (u32, u64),
    events: VecDeque<StreamEvent>,
    /// 序号已经连上、校验包可能还要用的分片，紧接在 `rcv_next` 前面。
    history: VecDeque<Received>,
    history_bytes: usize,
    pending_parity: VecDeque<PendingParity>,
    /// 这个包带来了暂存的校验包等着的分片。
    parity_dirty: bool,
    parity_seen_at: Option<u64>,
    /// 收到的包号区间 `(低, 高, 最后变化时已发出的确认数)`。
    received: VecDeque<(u64, u64, u32)>,
    /// 已发出的确认个数，判断旧区间还要不要接着带。
    acks_sent: u32,
    largest_received: Option<u64>,
    largest_received_at: u64,
    late_packets: [u64; MAX_LATE_PACKETS],
    late_packet_count: usize,
    ack_pending: bool,
    ack_deadline: u64,
    unacked_packets: u32,
    /// 收到的包之间的平均间隔。
    arrival_gap_us: u64,
    last_arrival_at: u64,
    /// 最后一次收到带数据（分片或校验）的包的时间。
    last_data_at: u64,
    /// 最近收到的包的包号和到达时间，用来算晚到的包比后发的包晚了多久。
    recent_arrivals: [(u64, u64); RECENT_ARRIVALS],
    recent_cursor: usize,
    /// 晚到的包（序号比已收到的最大序号小）比后发的包晚到多久，平滑平均。
    late_arrival_us: u64,
    /// 收到的包里晚到的比例，单位百万分之一。
    late_arrival_ppm: u32,
}

impl Connection {
    pub fn new(config: Config, now_us: u64) -> Self {
        Self::with_overhead(config, now_us, 0)
    }

    /// `overhead` 是外层追加在每个包后面的字节数。`max_packet_size` 仍是整个 UDP 载荷的上限。
    pub(crate) fn with_overhead(config: Config, now_us: u64, overhead: usize) -> Self {
        assert!(config.max_packet_size > overhead + wire::PACKET_HEADER_LEN + wire::PARITY_HEADER_LEN, "max_packet_size too small");
        assert!(config.max_packet_size <= u16::MAX as usize, "max_packet_size too large");
        assert!(config.send_window > 0 && config.recv_window > 0, "windows must be positive");
        assert!(config.recv_window < 1 << (wire::PARITY_FIRST_BITS - 1), "recv_window exceeds the wire format");
        assert!(config.reorder_threshold > 0, "reorder_threshold must be positive");
        // 按校验帧的头算，这样满长度分片的校验内容也能放进一个包。
        let max_segment = config.max_packet_size - overhead - wire::PACKET_HEADER_LEN - wire::PARITY_HEADER_LEN;
        let rtt = RttEstimator::new(config.initial_rto_us, config.min_rto_us, config.max_rto_us, config.ack_delay_us);
        let packet_size = config.max_packet_size as u64;
        let max_cwnd = config.send_window as u64 * packet_size;
        let fast = config.recovery_policy == RecoveryPolicy::Fast;
        let initial_segments = if fast { 128 } else { INITIAL_CWND_SEGMENTS };
        let mut congestion = Bbr::new(
            (initial_segments * packet_size).min(max_cwnd),
            (MIN_CWND_SEGMENTS * packet_size).min(max_cwnd),
            max_cwnd,
            if fast { Some(16_000_000) } else { None },
            config.recovery_policy != RecoveryPolicy::Lean,
        );
        if config.bandwidth_share == BandwidthShare::Fair {
            congestion.set_fair_share(config.max_packet_size as u64);
        }
        let (sequence, packet) = (config.initial_sequence, config.initial_packet_number);
        let mut connection = Self {
            overhead,
            max_segment,
            rtt,
            congestion,
            stats: Stats::default(),
            dead: false,
            last_heard: now_us,
            spare_buffers: Vec::new(),
            segments: VecDeque::new(),
            snd_una: sequence,
            snd_sent: sequence,
            send_buffered: 0,
            send_streams: BTreeMap::from([(DEFAULT_STREAM, SendStream::new(Priority::Normal, 0))]),
            scheduler: Scheduler::default(),
            next_stream_id: DEFAULT_STREAM + 1,
            mixed_traffic: false,
            last_interactive_at: None,
            last_other_at: None,
            urgent_round_at: 0,
            urgent_round_bytes: 0,
            tail_stream: (DEFAULT_STREAM, 0),
            retransmit: BTreeSet::new(),
            duplicates: VecDeque::new(),
            parity_pending: 0,
            parity_target: 0,
            parity_symbol: 0,
            parity_flush_at: 0,
            parity_group_number: 1,
            parity_sent_at: [None; PARITY_RECORDS],
            sent: VecDeque::new(),
            lost: VecDeque::new(),
            packet_threshold: config.reorder_threshold,
            reorder_delay_us: 0,
            reorder_decay_at: now_us,
            next_packet: packet,
            largest_acked: None,
            largest_acked_sent_at: 0,
            in_flight: 0,
            bytes_in_flight: 0,
            delivered: 0,
            delivered_at: now_us,
            first_sent_at: now_us,
            consecutive_timeouts: 0,
            last_timeout_at: 0,
            timeouts_held_until: 0,
            loss_ppm: 0,
            loss_samples: 0,
            late_ppm: 0,
            jitter_late_ppm: 0,
            jitter_parity_ppm: 0,
            jitter_parity_round: 0,
            jitter_parity_ceiling: 1_000_000,
            bundle_until: 0,
            parity_floor_until: 0,
            lost_run_ppm: 0,
            last_lost_packet: 0,
            peer_una: sequence,
            peer_window: config.recv_window,
            probe_at: None,
            probe_interval_us: config.probe_initial_us,
            probe_due: false,
            rcv_next: sequence,
            reorder: BTreeMap::new(),
            reorder_bytes: 0,
            recv_streams: BTreeMap::from([(DEFAULT_STREAM, RecvStream::new(0))]),
            unread_segments: 0,
            ready_bytes: 0,
            rcv_tail: (DEFAULT_STREAM, 0),
            events: VecDeque::new(),
            history: VecDeque::new(),
            history_bytes: 0,
            pending_parity: VecDeque::new(),
            parity_dirty: false,
            parity_seen_at: None,
            received: VecDeque::new(),
            largest_received: None,
            acks_sent: 0,
            largest_received_at: now_us,
            late_packets: [0; MAX_LATE_PACKETS],
            late_packet_count: 0,
            ack_pending: false,
            ack_deadline: 0,
            unacked_packets: 0,
            arrival_gap_us: u64::MAX,
            last_arrival_at: 0,
            last_data_at: 0,
            recent_arrivals: [(0, 0); RECENT_ARRIVALS],
            recent_cursor: 0,
            late_arrival_us: 0,
            late_arrival_ppm: 0,
            config,
        };
        connection.anchor_clock(now_us);
        connection
    }

    pub fn is_dead(&self) -> bool {
        self.dead
    }

    pub fn stats(&self) -> Stats {
        Stats {
            srtt_us: self.rtt.srtt_us(),
            min_rtt_us: self.congestion.min_rtt_us(),
            bandwidth: self.congestion.bandwidth_estimate(),
            random_loss_ppm: self.congestion.random_loss_ppm(),
            rate_cap: self.congestion.rate_cap(),
            rate_limits_found: self.congestion.rate_limits_found(),
            pacing_rate: self.congestion.pacing_rate_estimate(),
            ..self.stats
        }
    }

    /// 所有缓冲占用的字节数，用来确认内存有上限。
    pub fn buffered_bytes(&self) -> usize {
        self.send_buffered + self.reorder_bytes + self.ready_bytes + self.history_bytes
    }

    /// 校验内部账目是否一致，模拟器每一步都会调用。账目一旦出错，症状往往很久以后才出现。
    pub fn check_invariants(&self) {
        let flying = self.segments.iter().filter(|segment| segment.in_flight).count() as u32;
        assert_eq!(self.in_flight, flying, "in_flight counter");
        let buffered: usize = self.segments.iter().map(|segment| segment.data.len()).sum();
        let pending: usize = self.send_streams.values().map(|stream| stream.pending.len()).sum();
        assert_eq!(self.send_buffered, buffered + pending, "send buffer accounting");
        for (&id, stream) in &self.send_streams {
            let unacked: usize = self.segments.iter().filter(|segment| segment.stream == id).map(|segment| segment.data.len()).sum();
            assert_eq!(stream.unacked, unacked, "stream {id} send accounting");
        }
        assert_eq!(self.segments.len() as u64, self.snd_sent - self.snd_una, "segment queue length");
        assert!(self.snd_una <= self.snd_sent, "send sequence order");
        assert_eq!(self.reorder_bytes, self.reorder.values().map(|entry| entry.body.len()).sum::<usize>(), "reorder accounting");
        let ready: usize = self.recv_streams.values().flat_map(|stream| stream.ready.iter()).map(Vec::len).sum();
        let offsets: usize = self.recv_streams.values().map(|stream| stream.ready_offset).sum();
        assert_eq!(self.ready_bytes, ready - offsets, "ready accounting");
        assert_eq!(self.unread_segments, self.recv_streams.values().map(|stream| stream.ready.len()).sum::<usize>(), "unread accounting");
        assert_eq!(self.history_bytes, self.history.iter().map(|entry| entry.body.len()).sum::<usize>(), "history accounting");
        assert!(self.send_streams.len() <= self.config.max_streams as usize, "send stream bound");
        assert!(self.recv_streams.len() <= self.config.max_streams as usize, "receive stream bound");
        assert!(self.recv_streams.values().all(|stream| stream.waiting.len() <= self.config.recv_window as usize), "out of order stream bound");
        assert!(self.history.len() <= MAX_HISTORY_SEGMENTS, "history bound");
        assert!(self.pending_parity.len() <= MAX_PENDING_PARITY, "pending parity bound");
        assert!(self.reorder.keys().all(|&sn| sn > self.rcv_next), "reorder holds delivered data");
        let bytes: u64 = self.sent.iter().map(|packet| packet.bytes as u64).sum();
        assert_eq!(self.bytes_in_flight, bytes, "bytes in flight");
        assert!(
            self.sent.iter().zip(self.sent.iter().skip(1)).all(|(a, b)| a.number < b.number && a.sent_at <= b.sent_at),
            "sent order"
        );
        assert!(self.lost.iter().zip(self.lost.iter().skip(1)).all(|(a, b)| a.packet.number < b.packet.number), "lost packet order");
    }

    /// 还有数据未被对端确认。
    pub fn has_unacked_data(&self) -> bool {
        !self.segments.is_empty() || self.send_streams.values().any(SendStream::has_data)
    }

    fn take_buffer(&mut self) -> Vec<u8> {
        self.spare_buffers.pop().unwrap_or_else(|| Vec::with_capacity(self.max_segment))
    }

    fn recycle_buffer(&mut self, mut buffer: Vec<u8>) {
        if self.spare_buffers.len() < MAX_SPARE_BUFFERS {
            buffer.clear();
            self.spare_buffers.push(buffer);
        }
    }

    /// 写入默认流，返回接受的字节数；缓冲满时可能小于 `data.len()`。
    pub fn send(&mut self, now_us: u64, data: &[u8]) -> usize {
        self.send_stream(now_us, DEFAULT_STREAM, data)
    }

    /// 开一条发往对端的流，返回流号。流数到了上限时返回 `None`。
    pub fn open_stream(&mut self, priority: Priority) -> Option<u32> {
        if self.send_streams.len() >= self.config.max_streams as usize || self.max_segment <= STREAM_HEADER_LEN {
            return None;
        }
        let id = self.next_stream_id;
        self.next_stream_id = id.checked_add(1)?;
        self.send_streams.insert(id, SendStream::new(priority, self.config.recv_window as u64));
        Some(id)
    }

    /// 调整流的优先级，下一个分片起生效。流不存在时返回 false。
    pub fn set_priority(&mut self, stream: u32, priority: Priority) -> bool {
        self.send_streams.get_mut(&stream).map(|state| state.priority = priority).is_some()
    }

    /// 写入一条流，返回接受的字节数。流不存在或已经结束时返回 0。
    pub fn send_stream(&mut self, now_us: u64, stream: u32, data: &[u8]) -> usize {
        if self.dead || data.is_empty() {
            return 0;
        }
        if !self.has_unacked_data() {
            self.last_heard = now_us;
        }
        let per_stream = self.config.send_buffer_bytes;
        let total_room = per_stream.saturating_mul(MAX_SEND_BUFFERS).saturating_sub(self.send_buffered);
        let Some(state) = self.send_streams.get_mut(&stream).filter(|state| !state.finishing) else { return 0 };
        let room = per_stream.saturating_sub(state.pending.len() + state.unacked).min(total_room);
        let accepted = data.len().min(room);
        state.pending.extend(&data[..accepted]);
        self.send_buffered += accepted;
        accepted
    }

    /// 这条流不再写了。之前写入的数据发完后，对端会收到 [`StreamEvent::Finished`]。默认流不能结束。
    pub fn finish_stream(&mut self, stream: u32) -> bool {
        if stream == DEFAULT_STREAM {
            return false;
        }
        self.send_streams.get_mut(&stream).map(|state| state.finishing = true).is_some()
    }

    /// 取下一个流事件。
    pub fn poll_event(&mut self) -> Option<StreamEvent> {
        self.events.pop_front()
    }

    fn push_event(&mut self, event: StreamEvent) {
        // 应用不取事件时也不能无限涨。
        if self.events.len() < self.config.max_streams as usize * 4 {
            self.events.push_back(event);
        }
    }

    /// 按序读出默认流已到达的数据。
    pub fn recv(&mut self, now_us: u64, out: &mut [u8]) -> usize {
        self.recv_stream(now_us, DEFAULT_STREAM, out)
    }

    /// 按序读出一条流已到达的数据。
    pub fn recv_stream(&mut self, now_us: u64, stream: u32, out: &mut [u8]) -> usize {
        let window_before = self.advertised_window();
        let Self { recv_streams, spare_buffers, ready_bytes, unread_segments, .. } = self;
        let Some(state) = recv_streams.get_mut(&stream) else { return 0 };
        let mut written = 0;
        while written < out.len() {
            let Some(front) = state.ready.front() else { break };
            let available = &front[state.ready_offset..];
            let take = available.len().min(out.len() - written);
            out[written..written + take].copy_from_slice(&available[..take]);
            written += take;
            state.ready_offset += take;
            *ready_bytes -= take;
            if state.ready_offset == front.len() {
                state.ready_offset = 0;
                state.consumed += 1;
                *unread_segments -= 1;
                if let Some(mut buffer) = state.ready.pop_front()
                    && spare_buffers.len() < MAX_SPARE_BUFFERS
                {
                    buffer.clear();
                    spare_buffers.push(buffer);
                }
            }
        }
        if stream == DEFAULT_STREAM {
            // 窗口重新打开时主动告诉对端，不用等对端下一次探测。
            let half = self.config.recv_window / 2;
            let window_after = self.advertised_window();
            if (window_before == 0 && window_after > 0) || (window_before < half && window_after >= half) {
                self.request_ack(now_us);
            }
        } else {
            self.grant_credit(now_us, stream);
            self.close_if_drained(stream);
        }
        written
    }

    /// 应用读走了数据，就告诉对端可以接着发。等得太久的话，额度跟不上路径速度，流会被自己的窗口卡住。
    fn grant_credit(&mut self, now_us: u64, stream: u32) {
        let window = self.config.recv_window as u64;
        let Some(state) = self.recv_streams.get_mut(&stream) else { return };
        if state.fin_seq.is_none() && state.consumed + window >= state.granted_end + (window / GRANT_FRACTION).max(1) {
            state.granted_end = state.consumed + window;
            state.grant_repeats = GRANT_REPEATS;
            self.request_ack(now_us);
        }
    }

    fn close_if_drained(&mut self, stream: u32) {
        if stream != DEFAULT_STREAM && self.recv_streams.get(&stream).is_some_and(RecvStream::is_drained) {
            self.recv_streams.remove(&stream);
            self.push_event(StreamEvent::Finished(stream));
        }
    }

    /// 序号连上的分片，最近见过校验包就先留着，算校验时可能要用到。
    fn retire_received(&mut self, entry: Received) {
        if self.parity_seen_at.is_none_or(|at| at + PARITY_HISTORY_US < self.last_heard) {
            while let Some(old) = self.history.pop_front() {
                self.history_bytes -= old.body.len();
                self.recycle_buffer(old.body);
            }
            self.recycle_buffer(entry.body);
            return;
        }
        self.history_bytes += entry.body.len();
        self.history.push_back(entry);
        if self.history.len() > MAX_HISTORY_SEGMENTS
            && let Some(old) = self.history.pop_front()
        {
            self.history_bytes -= old.body.len();
            self.recycle_buffer(old.body);
        }
    }

    /// 已收到的分片内容，没收到或已经丢弃时为空。
    fn received_segment(&self, sn: u64) -> Option<(&[u8], bool)> {
        let entry = if sn >= self.rcv_next {
            self.reorder.get(&sn)
        } else {
            let index = (sn + self.history.len() as u64).checked_sub(self.rcv_next)?;
            self.history.get(index as usize)
        };
        entry.map(|entry| (entry.body.as_slice(), entry.headed))
    }

    /// 把暂存的校验包理一遍，能算的分片都算出来。算不了的留着：等后面的校验包或重传到了再试。
    fn try_recover(&mut self) {
        // 分片数有上限，算出一批后还可能轮到别的空洞。
        while self.recover_once() {}
    }

    fn recover_once(&mut self) -> bool {
        let mut holes = [0u64; MAX_UNKNOWNS];
        let mut hole_count = 0;
        let mut index = 0;
        while index < self.pending_parity.len() {
            let (first, end) = (self.pending_parity[index].first, self.pending_parity[index].end());
            // 已经交付、又不在保留范围内的分片拿不回来，这个校验包用不上了。
            let mut useful = first >= self.rcv_next || self.received_segment(first).is_some();
            let mut missing = false;
            for sn in first.max(self.rcv_next)..end {
                if !useful {
                    break;
                }
                if self.reorder.contains_key(&sn) {
                    continue;
                }
                missing = true;
                if hole_count < MAX_UNKNOWNS && !holes[..hole_count].contains(&sn) {
                    holes[hole_count] = sn;
                    hole_count += 1;
                }
            }
            useful &= missing;
            if useful {
                index += 1;
            } else if let Some(parity) = self.pending_parity.remove(index) {
                self.recycle_buffer(parity.data);
            }
        }
        hole_count > 0 && self.rebuild_segments(&holes[..hole_count])
    }

    /// 返回有没有算出新的分片。
    fn rebuild_segments(&mut self, holes: &[u64]) -> bool {
        let symbols = self.pending_parity.len();
        let mut rows = [[0u8; MAX_UNKNOWNS]; MAX_UNKNOWNS];
        let mut combination = [[0u8; MAX_UNKNOWNS]; MAX_UNKNOWNS];
        for (row, parity) in self.pending_parity.iter().enumerate() {
            combination[row][row] = 1;
            for (column, &sn) in holes.iter().enumerate() {
                if (parity.first..parity.end()).contains(&sn) {
                    rows[row][column] = parity::coefficient(parity.symbol, sn);
                }
            }
        }
        let pivots = parity::reduce(&mut rows, &mut combination, symbols, holes.len());
        if pivots.iter().all(Option::is_none) {
            return false;
        }
        let recovered_before = self.stats.recovered_segments;
        // 用到的校验包先减掉已知的分片，只剩未知的部分。
        let mut known: [Option<(Vec<u8>, u16)>; MAX_UNKNOWNS] = [const { None }; MAX_UNKNOWNS];
        for &pivot in &pivots {
            let Some(pivot) = pivot else { continue };
            for row in 0..symbols {
                if combination[pivot as usize][row] != 0 && known[row].is_none() {
                    known[row] = self.known_part(row, holes);
                }
            }
        }
        for (column, &pivot) in pivots.iter().enumerate() {
            let Some(pivot) = pivot else { continue };
            let mut restored = self.take_buffer();
            let mut length = 0u16;
            let mut complete = true;
            for row in 0..symbols {
                let factor = combination[pivot as usize][row];
                if factor == 0 {
                    continue;
                }
                match &known[row] {
                    Some((data, known_length)) => {
                        parity::add_scaled(&mut restored, data, factor);
                        length ^= parity::scale_length(*known_length, factor);
                    }
                    None => complete = false,
                }
            }
            let headed = length & HEADED_LENGTH_BIT != 0;
            let length = (length & !HEADED_LENGTH_BIT) as usize;
            let sn = holes[column];
            // 校验内容来自已认证的对端，长度不对只可能是实现有错；丢掉即可，重传会补上。
            let sized = length > 0 && length <= restored.len() && length <= self.max_segment && (!headed || length >= STREAM_HEADER_LEN);
            if complete && sized && self.accept_segment(sn, &restored[..length], headed) {
                self.stats.recovered_segments += 1;
            }
            self.recycle_buffer(restored);
        }
        for known in known.into_iter().flatten() {
            self.recycle_buffer(known.0);
        }
        self.stats.recovered_segments > recovered_before
    }

    /// 从校验包里减掉已经收到的分片。
    fn known_part(&mut self, row: usize, holes: &[u64]) -> Option<(Vec<u8>, u16)> {
        let mut data = self.take_buffer();
        let parity = &self.pending_parity[row];
        data.extend_from_slice(&parity.data);
        let mut length = parity.length;
        for sn in parity.first..parity.end() {
            if holes.contains(&sn) {
                continue;
            }
            let Some((segment, headed)) = self.received_segment(sn) else {
                self.recycle_buffer(data);
                return None;
            };
            let factor = parity::coefficient(parity.symbol, sn);
            length ^= parity::scale_length(coded_length(segment.len(), headed), factor);
            parity::add_scaled(&mut data, segment, factor);
        }
        Some((data, length))
    }

    fn on_parity(&mut self, now_us: u64, first: u64, count: u8, symbol: u8, length: u16, payload: &[u8]) {
        self.parity_seen_at = Some(now_us);
        if first + count as u64 <= self.rcv_next || self.pending_parity.iter().any(|parity| parity.first == first && parity.symbol == symbol) {
            return;
        }
        if self.pending_parity.len() == MAX_PENDING_PARITY
            && let Some(old) = self.pending_parity.pop_front()
        {
            self.recycle_buffer(old.data);
        }
        let mut data = self.take_buffer();
        data.extend_from_slice(payload);
        self.pending_parity.push_back(PendingParity { first, count, symbol, length, data });
        self.parity_dirty = true;
    }

    /// 确认帧里的窗口只管默认流，别的流各有额度，一条流不读不会卡住别的流。
    fn advertised_window(&self) -> u32 {
        let unread = self.recv_streams.get(&DEFAULT_STREAM).map_or(0, |stream| stream.ready.len());
        self.config.recv_window.saturating_sub(unread as u32)
    }

    fn request_ack(&mut self, now_us: u64) {
        self.ack_pending = true;
        self.ack_deadline = now_us;
    }

    fn schedule_ack(&mut self, deadline: u64) {
        self.ack_deadline = if self.ack_pending { self.ack_deadline.min(deadline) } else { deadline };
        self.ack_pending = true;
    }

    /// 处理一个收到的包。错误只表示这个包被丢弃，不影响连接。
    pub fn on_packet(&mut self, now_us: u64, packet: &[u8]) -> Result<(), PacketError> {
        self.on_packet_numbered(now_us, None, packet)
    }

    /// 外层已经认证过的包，`number` 是外层还原出的完整包号。`packet` 是解密后的包头加帧。
    pub(crate) fn on_packet_numbered(&mut self, now_us: u64, number: Option<u64>, packet: &[u8]) -> Result<(), PacketError> {
        if self.dead {
            return Err(PacketError::Dead);
        }
        let result = self.process_packet(now_us, number, packet);
        if result.is_err() {
            self.stats.rejected_packets += 1;
        }
        result
    }

    /// 尽快发一个探测包，对端会确认它。加密层握手完成后用它让响应方确认这一端在线，顺便测一次往返。
    pub(crate) fn ping(&mut self) {
        if !self.dead {
            self.probe_due = true;
        }
    }

    pub(crate) fn ping_pending(&self) -> bool {
        self.probe_due
    }

    /// 下一个包要用的包号。外层用它还原收到的包号，两端的起点相同。
    pub(crate) fn expected_packet_number(&self) -> u64 {
        self.largest_received.map_or(self.config.initial_packet_number, |value| value + 1)
    }

    /// 刚由 `poll_transmit` 写出的那个包的完整包号。
    pub(crate) fn last_packet_number(&self) -> u64 {
        self.next_packet - 1
    }

    /// 外层自己写的包（路径验证）要用的包号。这个包不进待确认队列，对端也不交给可靠层，只计入流量。
    pub(crate) fn take_packet_number(&mut self, wire_bytes: usize) -> u64 {
        let number = self.next_packet;
        self.next_packet += 1;
        self.stats.packets_sent += 1;
        self.stats.wire_bytes_sent += wire_bytes as u64;
        number
    }

    /// 外层自己处理掉的包（路径验证），只计入流量。不算收到对端的消息：对端在验证这一端的新地址，
    /// 不说明它的数据和确认能送到这里，这一端照样要按安静处理、接着探测。
    pub(crate) fn on_probe_received(&mut self, wire_bytes: usize) {
        self.stats.packets_received += 1;
        self.stats.wire_bytes_received += wire_bytes as u64;
    }

    /// 最后一次收到对端任何有效包的时间。
    pub(crate) fn last_heard(&self) -> u64 {
        self.last_heard
    }

    /// 最后一次收到对端数据（分片或校验）的时间。
    pub(crate) fn last_data_at(&self) -> u64 {
        self.last_data_at
    }

    pub(crate) fn bytes_in_flight(&self) -> u64 {
        self.bytes_in_flight
    }

    pub(crate) fn srtt_us(&self) -> u64 {
        self.rtt.srtt_us()
    }

    /// 连续超时了几次，有包被确认就清零。加密层据此判断当前路径是不是断了。
    pub(crate) fn timeouts_in_a_row(&self) -> u32 {
        self.consecutive_timeouts
    }

    /// 换了路径：在途的包多半跟着旧路径丢了，全部放回待重传；往返、带宽、丢包和乱序都按新路径从头量。
    /// 序号、包号和流都不受影响，对端照常确认。
    pub(crate) fn on_path_change(&mut self, now_us: u64) {
        self.requeue_in_flight();
        // 旧路径上判丢的包再被确认，说明不了新路径的乱序。
        self.lost.clear();
        self.rtt = RttEstimator::new(self.config.initial_rto_us, self.config.min_rto_us, self.config.max_rto_us, self.config.ack_delay_us);
        self.congestion.restart();
        self.packet_threshold = self.config.reorder_threshold;
        self.reorder_delay_us = 0;
        self.reorder_decay_at = now_us;
        self.consecutive_timeouts = 0;
        self.loss_ppm = 0;
        self.loss_samples = 0;
        self.late_ppm = 0;
        self.jitter_late_ppm = 0;
        self.jitter_parity_ppm = 0;
        self.jitter_parity_round = 0;
        self.jitter_parity_ceiling = 1_000_000;
        self.bundle_until = 0;
        self.parity_floor_until = 0;
        self.lost_run_ppm = 0;
        self.arrival_gap_us = u64::MAX;
        self.late_arrival_us = 0;
        self.late_arrival_ppm = 0;
        self.delivered_at = now_us;
        self.first_sent_at = now_us;
    }

    /// 只换了端口、走的还是同一条路（NAT 换了外部端口）：发往旧端口的包多半丢了，放回待重传，不算丢包；
    /// 往返、带宽和丢包率都还适用，照旧。连续超时清零：新端口已经验证通过了。
    pub(crate) fn on_port_change(&mut self) {
        self.requeue_in_flight();
        self.consecutive_timeouts = 0;
    }

    /// 马上发一个确认。加密层验证通过、换到对端的新地址时用：验证期间的确认都发往了旧地址，对端没收到，
    /// 它在途的包等不到确认、窗口又满着，要等超时把它们全判丢才动。2026-11-05 模拟里换一次端口卡了 50 毫秒、白重传 189 个包。
    pub(crate) fn ack_now(&mut self, now_us: u64) {
        self.request_ack(now_us);
    }

    /// 在途的包全部放回待重传，不算丢包。
    fn requeue_in_flight(&mut self) {
        while let Some(packet) = self.sent.pop_front() {
            self.bytes_in_flight -= packet.bytes as u64;
            for &sn in &packet.segments[..packet.segment_count as usize] {
                let Some(segment) = self.segment_mut(sn) else { continue };
                if segment.acked {
                    continue;
                }
                segment.in_flight = false;
                let urgent = segment.urgent;
                self.in_flight -= 1;
                self.retransmit.insert((!urgent, sn));
            }
        }
    }

    /// 握手完成时调用：连接在握手期间就建好了，创建时记下的时间已经过时。只能在收发任何包之前调用。
    pub(crate) fn reset_clock(&mut self, now_us: u64) {
        debug_assert!(self.stats.packets_sent == 0 && self.stats.packets_received == 0);
        self.anchor_clock(now_us);
    }

    /// 以建连时刻为起点的时间。留成 0 的话，时钟不从 0 开始的真实设备上，开头的判断会和模拟器里不一样：
    /// 第一个包的到达间隔按距开机多久算，乱序确认回来时更早的包不判丢。别的时间点第一次用到之前都会被覆盖，不在这里。
    fn anchor_clock(&mut self, now_us: u64) {
        self.last_heard = now_us;
        self.reorder_decay_at = now_us;
        self.delivered_at = now_us;
        self.first_sent_at = now_us;
        self.largest_received_at = now_us;
        self.last_arrival_at = now_us;
        self.largest_acked_sent_at = now_us;
    }

    fn process_packet(&mut self, now_us: u64, known_number: Option<u64>, packet: &[u8]) -> Result<(), PacketError> {
        let (truncated, eager_ack) = wire::parse_header(packet).ok_or(PacketError::Malformed)?;

        // 先完整校验一遍再改状态，半个坏包不能留下任何影响。
        let mut pos = wire::PACKET_HEADER_LEN;
        if pos == packet.len() {
            return Err(PacketError::Malformed);
        }
        while pos < packet.len() {
            match wire::parse_frame(packet, &mut pos).ok_or(PacketError::Malformed)? {
                Frame::Ack(ack) => self.validate_ack(&ack)?,
                Frame::Data { payload, .. } | Frame::Parity { payload, .. } if payload.len() > self.max_segment => {
                    return Err(PacketError::Malformed);
                }
                _ => {}
            }
        }

        let number = known_number.unwrap_or_else(|| wire::expand(truncated, self.expected_packet_number(), wire::PACKET_NUMBER_BITS));
        self.stats.packets_received += 1;
        self.stats.wire_bytes_received += (packet.len() + self.overhead) as u64;
        self.last_heard = now_us;

        if self.is_duplicate(number) {
            // 对端可能没收到上一次确认，马上再确认一次。
            self.stats.duplicate_packets += 1;
            self.request_ack(now_us);
            return Ok(());
        }

        let mut ack_eliciting = false;
        let mut carries_data = false;
        let mut urgent = false;
        let mut accepted = true;
        let rcv_next_before = self.rcv_next;
        let mut pos = wire::PACKET_HEADER_LEN;
        while pos < packet.len() {
            match wire::parse_frame(packet, &mut pos).ok_or(PacketError::Malformed)? {
                Frame::Data { sn, payload, headed } => {
                    ack_eliciting = true;
                    carries_data = true;
                    accepted &= self.accept_segment(wire::expand(sn, self.rcv_next, wire::SEQUENCE_BITS), payload, headed);
                }
                Frame::Ack(ack) => self.apply_ack(now_us, &ack),
                Frame::Ping => {
                    ack_eliciting = true;
                    urgent = true;
                    // 对端可能是等额度等到了探测：额度帧丢光时靠这里补。
                    for state in self.recv_streams.values_mut() {
                        state.grant_repeats = state.grant_repeats.max(1);
                    }
                }
                Frame::Credit { stream, end } => {
                    if let Some(state) = self.send_streams.get_mut(&stream) {
                        state.credit_end = state.credit_end.max(wire::expand(end, state.credit_end, wire::SEQUENCE_BITS));
                    }
                }
                Frame::Parity { first, count, index, length, payload } => {
                    ack_eliciting = true;
                    carries_data = true;
                    self.on_parity(now_us, wire::expand(first, self.rcv_next, wire::PARITY_FIRST_BITS), count, index, length, payload);
                }
            }
        }
        if core::mem::take(&mut self.parity_dirty) {
            self.try_recover();
        }
        if carries_data {
            self.last_data_at = now_us;
        }
        // 有分片超出窗口时不能确认这个包：确认等于承诺收下了里面所有数据，否则就是丢数据。
        if !accepted {
            self.request_ack(now_us);
            return Ok(());
        }

        // 空洞补上了：发送方的窗口多半正卡在这里，确认晚一毫秒它就白等一毫秒。
        urgent |= self.rcv_next > rcv_next_before + 1;
        let in_order = self.largest_received.is_none_or(|value| number == value + 1);
        let arrived_late = self.largest_received.is_some_and(|value| number < value);
        if arrived_late {
            // 比它后发、已经到了的包里最早到的那个，到现在过了多久。
            let first_after = self.recent_arrivals.iter().filter(|&&(n, at)| n > number && at > 0).map(|&(_, at)| at).min();
            let lateness = first_after.map_or(0, |at| now_us.saturating_sub(at));
            self.late_arrival_us = (self.late_arrival_us * 7 + lateness) / 8;
        }
        self.recent_arrivals[self.recent_cursor] = (number, now_us);
        self.recent_cursor = (self.recent_cursor + 1) % RECENT_ARRIVALS;
        let sample = if arrived_late { 1_000_000 } else { 0 };
        self.late_arrival_ppm = self.late_arrival_ppm - self.late_arrival_ppm / LOSS_SMOOTHING + sample / LOSS_SMOOTHING;
        if arrived_late && self.late_packet_count < MAX_LATE_PACKETS {
            self.late_packets[self.late_packet_count] = number;
            self.late_packet_count += 1;
        }
        self.record_received(number);
        if self.largest_received.is_none_or(|value| number > value) {
            self.largest_received = Some(number);
            self.largest_received_at = now_us;
        }
        if ack_eliciting {
            let gap = now_us.saturating_sub(self.last_arrival_at);
            self.arrival_gap_us = if self.last_arrival_at == 0 || self.arrival_gap_us == u64::MAX { gap } else { (self.arrival_gap_us * 7 + gap) / 8 };
            self.last_arrival_at = now_us;
            self.unacked_packets += 1;
            // 包挨得极近（每秒两万个以上）时往返通常只有几毫秒，每个包都马上确认：窗口卡住时，
            // 一串包的最后一个单独等确认延迟的话，整个窗口要多等这么久才能往前走，占往返的比例不小。
            // 抖动把包的先后打乱好几毫秒时也逐包确认：窗口头上那个晚到的包一到，发送方就要马上知道。
            // 只看比后发的包晚了多久，不看晚了几个包：丢包多时到达间隔被拉长，按包数换算会把丢包当成抖动。
            let jittery = self.late_arrival_ppm >= JITTERY_LATE_PPM && self.late_arrival_us >= JITTERY_LATE_US;
            let every = if self.arrival_gap_us < FAST_ARRIVAL_GAP_US || jittery || eager_ack { 1 } else { self.config.ack_every };
            if urgent || self.unacked_packets >= every {
                self.request_ack(now_us);
            } else if !in_order {
                self.schedule_ack(now_us + REORDER_ACK_DELAY_US);
            } else {
                self.schedule_ack(now_us + self.config.ack_delay_us);
            }
        }
        Ok(())
    }

    fn validate_ack(&self, ack: &wire::AckFrame<'_>) -> Result<(), PacketError> {
        let expected = self.next_packet.saturating_sub(1);
        let largest = wire::expand(ack.largest, expected, wire::ACK_NUMBER_BITS);
        // 确认没发过的包，要么是伪造，要么是状态错乱，都不能接受。
        if largest >= self.next_packet {
            return Err(PacketError::InvalidAck);
        }
        if wire::expand(ack.una, self.snd_una, wire::ACK_NUMBER_BITS) > self.snd_sent {
            return Err(PacketError::InvalidAck);
        }
        if ack.first_run as u64 > largest + 1 {
            return Err(PacketError::InvalidAck);
        }
        let mut low = largest + 1 - ack.first_run as u64;
        for (gap, run) in ack.ranges() {
            let span = gap as u64 + run as u64;
            if gap == 0 || run == 0 || span > low {
                return Err(PacketError::InvalidAck);
            }
            low -= span;
        }
        Ok(())
    }

    fn apply_ack(&mut self, now_us: u64, ack: &wire::AckFrame<'_>) {
        let largest = wire::expand(ack.largest, self.next_packet.saturating_sub(1), wire::ACK_NUMBER_BITS);
        // 这个确认里最新的包早被超时判丢了：往返突然变长（换了网络、路由变了），超时比往返还短，在途的包都先被判丢、再被确认。
        // 每次发送都用新包号，它的往返照样准；不采样的话超时永远追不上，每个确认还会把退避清零，连接卡在误判里出不来。
        // 只取这个确认里最新的包：确认延迟说的就是它，旧确认丢了、被后面的确认带上的包不会是最新的那个。
        let late_sample = (self.rtt.srtt_us() > 0)
            .then(|| self.lost.binary_search_by_key(&largest, |lost| lost.packet.number).ok())
            .flatten()
            .map(|index| self.lost[index].packet.sent_at)
            .filter(|_| self.largest_acked.is_none_or(|value| largest > value));
        let mut newest = None;
        let mut high = largest;
        let mut low = high + 1 - ack.first_run as u64;
        self.ack_packets(now_us, low, high, &mut newest);
        self.ack_lost_packets(now_us, low, high);
        for (gap, run) in ack.ranges() {
            high = low - gap as u64 - 1;
            low = high + 1 - run as u64;
            self.ack_packets(now_us, low, high, &mut newest);
            self.ack_lost_packets(now_us, low, high);
        }

        if let Some(packet) = newest {
            self.largest_acked_sent_at = self.largest_acked_sent_at.max(packet.sent_at);
            self.consecutive_timeouts = 0;
            let elapsed = now_us.saturating_sub(packet.sent_at);
            let rtt_us = elapsed.saturating_sub(ack.delay_us.min(elapsed / 2));
            if self.largest_acked.is_none_or(|value| packet.number > value) {
                self.rtt.observe(rtt_us);
            }
            let send_elapsed = packet.sent_at.saturating_sub(packet.first_sent_at);
            let ack_elapsed = now_us.saturating_sub(packet.delivered_at);
            let interval = send_elapsed.max(ack_elapsed).max(1);
            let delivered = self.delivered.saturating_sub(packet.delivered);
            self.first_sent_at = packet.sent_at;
            let sample = RateSample {
                delivery_rate: delivered.saturating_mul(1_000_000) / interval,
                rtt_us,
                prior_delivered: packet.delivered,
                app_limited: packet.app_limited,
                app_idle: packet.app_idle,
                send_span_us: send_elapsed,
            };
            self.congestion.on_ack(now_us, &sample, self.delivered, self.bytes_in_flight);
            self.adjust_jitter_parity();
        } else if let Some(sent_at) = late_sample {
            let elapsed = now_us.saturating_sub(sent_at);
            self.rtt.observe(elapsed.saturating_sub(ack.delay_us.min(elapsed / 2)));
        }
        if self.largest_acked.is_none_or(|value| largest > value) {
            self.largest_acked = Some(largest);
        }

        let una = wire::expand(ack.una, self.snd_una, wire::ACK_NUMBER_BITS);
        self.advance_una(una);
        self.peer_una = self.peer_una.max(una);
        self.peer_window = ack.window;
        self.retire_repaired_idle_packets(now_us);
        self.detect_losses(now_us);

        if !self.window_blocked() {
            self.probe_at = None;
            self.probe_due = false;
            self.probe_interval_us = self.config.probe_initial_us;
        }
    }

    /// 稀疏消息已经由副本或校验确认送达，原包过了判丢延迟后不再占着在途预算。
    /// 持续满载的包仍按普通判丢处理，避免改变带宽、排队与限速采样。
    fn retire_repaired_idle_packets(&mut self, now_us: u64) {
        if self.rtt.srtt_us() == 0 {
            return;
        }
        let mut index = 0;
        while index < self.sent.len() {
            let packet = self.sent[index];
            if now_us.saturating_sub(packet.sent_at) < self.rtt.loss_delay_us() {
                break;
            }
            let repaired = packet.app_idle && packet.segment_count > 0 && packet.segments[..packet.segment_count as usize].iter().all(|&sn| {
                sn < self.snd_una || self.segments.get((sn - self.snd_una) as usize).is_some_and(|segment| segment.acked)
            });
            if repaired {
                self.sent.remove(index);
                self.declare_lost(now_us, &packet);
            } else {
                index += 1;
            }
        }
    }

    /// 处理包号区间 `[low, high]` 内被确认的包。
    fn ack_packets(&mut self, now_us: u64, low: u64, high: u64, newest: &mut Option<SentPacket>) {
        let start = self.sent.partition_point(|packet| packet.number < low);
        let end = self.sent.partition_point(|packet| packet.number <= high);
        for index in start..end {
            let packet = self.sent[index];
            self.bytes_in_flight -= packet.bytes as u64;
            self.delivered += packet.bytes as u64;
            self.delivered_at = now_us;
            self.observe_outcome(&packet, false);
            let late = self.is_slow(now_us, &packet) && self.largest_acked.is_some_and(|largest| packet.number + LATE_PACKET_DISTANCE <= largest);
            self.observe_lateness(late);
            // 后发的包已经确认了、自己比最小往返晚到了十六分之一往返以上：抖动把它拖在了后面。
            let reordered = self.largest_acked.is_some_and(|largest| packet.number < largest);
            let delayed = now_us.saturating_sub(packet.sent_at) > self.congestion.min_rtt_us() + self.rtt.srtt_us() / 16;
            let sample = if reordered && delayed { 1_000_000 } else { 0 };
            self.jitter_late_ppm = self.jitter_late_ppm - self.jitter_late_ppm / LOSS_SMOOTHING + sample / LOSS_SMOOTHING;
            if newest.is_none_or(|value: SentPacket| packet.number > value.number) {
                *newest = Some(packet);
            }
            self.mark_packet_acked(&packet);
        }
        self.sent.drain(start..end);
    }

    /// 已判丢失的包又被确认：它只是来晚了。算回送达量，并放宽判丢窗口。
    fn ack_lost_packets(&mut self, now_us: u64, low: u64, high: u64) {
        let start = self.lost.partition_point(|lost| lost.packet.number < low);
        let end = self.lost.partition_point(|lost| lost.packet.number <= high);
        for index in start..end {
            let lost = self.lost[index];
            self.stats.spurious_losses += 1;
            // 初始超时比 RTT 短的链路上，每个包都先被判丢，不从这里采样就永远拿不到 RTT。
            // 只用来开头：确认丢了的话，这个包可能早就到了，算出来的 RTT 能高出几十倍，
            // 有了正常样本就不能再用，否则超时被拉到好几秒，连接最后被判死。
            if self.rtt.srtt_us() == 0 {
                self.rtt.observe(now_us.saturating_sub(lost.packet.sent_at));
            }
            self.congestion.undo_lost(lost.packet.bytes as u64);
            self.delivered += lost.packet.bytes as u64;
            self.delivered_at = now_us;
            self.consecutive_timeouts = 0;
            // 要和算进去时的权重一样：开头样本少时权重大，只减一点的话，一次误判就让校验开好一阵。
            self.loss_ppm = self.loss_ppm.saturating_sub(1_000_000 / self.loss_samples.max(1));
            self.observe_lateness(self.is_slow(now_us, &lost.packet));
            if lost.packet.below_capacity && lost.packet.calm_trusted {
                self.congestion.undo_calm_loss();
            }
            if let Some(calm) = lost.packet.compared_phase() {
                self.congestion.undo_phase_loss(lost.packet.cycle, calm);
            }
            let late = now_us.saturating_sub(lost.declared_at);
            self.reorder_delay_us = self.reorder_delay_us.max(late + late / 4).min(self.rtt.srtt_us());
            let limit = (self.config.send_window as u64 / 2).max(self.config.reorder_threshold);
            self.packet_threshold = self.packet_threshold.max(lost.distance + 1).min(limit);
            self.reorder_decay_at = now_us + REORDER_DECAY_RTTS * self.rtt.srtt_us();
            self.mark_packet_acked(&lost.packet);
        }
        self.lost.drain(start..end);
    }

    fn mark_packet_acked(&mut self, packet: &SentPacket) {
        for &sn in &packet.segments[..packet.segment_count as usize] {
            self.mark_segment_acked(sn);
        }
        for &sn in &packet.bundled[..packet.bundled_count as usize] {
            self.mark_segment_acked(sn);
        }
    }

    fn observe_outcome(&mut self, packet: &SentPacket, lost: bool) {
        let sample = if lost { 1_000_000 } else { 0 };
        // 样本不够时按个数平均：校验要尽早打开，从 0 慢慢平滑的话要等好几个往返。
        self.loss_samples = (self.loss_samples + 1).min(LOSS_SMOOTHING);
        self.loss_ppm = (self.loss_ppm as u64 * (self.loss_samples - 1) as u64 / self.loss_samples as u64) as u32 + sample / self.loss_samples;
        // 丢包少时这个比例很久才更新一次。启动时溢出的那一片不能一直算数，否则校验要关好几秒。
        self.lost_run_ppm -= self.lost_run_ppm / LOST_RUN_DECAY_PACKETS;
        if packet.below_capacity {
            self.congestion.on_calm_outcome(lost, packet.calm_trusted, packet.calm_foreign);
        }
        if let Some(calm) = packet.compared_phase() {
            self.congestion.on_phase_outcome(packet.cycle, calm, lost);
        }
        if packet.probing {
            self.congestion.on_probe_outcome(lost);
        }
    }

    /// 序号落后不一定堵窗口：抖动让包的先后错开几毫秒是常事。比平时慢一半才算。
    fn is_slow(&self, now_us: u64, packet: &SentPacket) -> bool {
        let srtt = self.rtt.srtt_us();
        now_us.saturating_sub(packet.sent_at) >= srtt + srtt / 2
    }

    fn observe_lateness(&mut self, late: bool) {
        let sample = if late { 1_000_000 } else { 0 };
        self.late_ppm = self.late_ppm - self.late_ppm / LOSS_SMOOTHING + sample / LOSS_SMOOTHING;
    }

    fn relax_reorder_tolerance(&mut self, now_us: u64) {
        if now_us < self.reorder_decay_at {
            return;
        }
        self.reorder_decay_at = now_us + REORDER_DECAY_RTTS * self.rtt.srtt_us();
        self.reorder_delay_us -= self.reorder_delay_us / 4;
        let threshold = self.packet_threshold - self.packet_threshold / 4;
        self.packet_threshold = threshold.max(self.config.reorder_threshold);
    }

    fn loss_delay_us(&self) -> u64 {
        self.rtt.loss_delay_us() + self.reorder_delay_us.max(self.jitter_reorder_us())
    }

    /// 按实测抖动估计的乱序幅度。
    fn jitter_reorder_us(&self) -> u64 {
        self.congestion.rtt_jitter_us() * 3
    }

    fn segment_mut(&mut self, sn: u64) -> Option<&mut Segment> {
        let index = sn.checked_sub(self.snd_una)?;
        self.segments.get_mut(index as usize)
    }

    fn mark_segment_acked(&mut self, sn: u64) {
        let Some(segment) = self.segment_mut(sn) else { return };
        if segment.acked {
            return;
        }
        segment.acked = true;
        let was_in_flight = core::mem::replace(&mut segment.in_flight, false);
        if was_in_flight {
            self.in_flight -= 1;
        }
    }

    fn advance_una(&mut self, una: u64) {
        while self.snd_una < una {
            self.mark_segment_acked(self.snd_una);
            self.pop_front_segment();
        }
        while self.segments.front().is_some_and(|segment| segment.acked) {
            self.pop_front_segment();
        }
    }

    fn pop_front_segment(&mut self) {
        if let Some(segment) = self.segments.pop_front() {
            self.send_buffered -= segment.data.len();
            self.snd_una += 1;
            if let Some(state) = self.send_streams.get_mut(&segment.stream) {
                state.unacked -= segment.data.len();
                if state.is_done() {
                    self.send_streams.remove(&segment.stream);
                }
            }
            self.recycle_buffer(segment.data);
        }
    }

    /// 按包数或按时间判丢。按时间这一条让稀疏流量也能快速恢复：
    /// 它后面可能再也没有三个包，只靠计数就只能等超时。
    fn detect_losses(&mut self, now_us: u64) {
        let Some(largest) = self.largest_acked else { return };
        self.relax_reorder_tolerance(now_us);
        let expiry = 2 * self.rtt.srtt_us();
        while self.lost.front().is_some_and(|lost| lost.declared_at + expiry < now_us) {
            self.lost.pop_front();
            // 判丢两个往返后仍没有确认，说明确实丢了，不是乱序。
            self.parity_floor_until = now_us + PARITY_FLOOR_HOLD_US;
        }
        let delay = self.loss_delay_us();
        // 抖动会把前后发出的包的到达顺序打乱：比它晚发出不到一个抖动幅度的包先到了，不能说明它丢了。
        let window = self.jitter_reorder_us();
        while let Some(&packet) = self.sent.front() {
            if self.parity_hold_until(&packet).is_some_and(|at| at > now_us) {
                break;
            }
            let lost = packet.number < largest
                && ((packet.number + self.packet_threshold <= largest && packet.sent_at + window <= self.largest_acked_sent_at) || packet.sent_at + delay <= now_us);
            if !lost {
                break;
            }
            self.sent.pop_front();
            self.stats.fast_losses += 1;
            self.congestion.on_overtaken(packet.bytes as u64);
            self.declare_lost(now_us, &packet);
        }
    }

    fn declare_lost(&mut self, now_us: u64, packet: &SentPacket) {
        let srtt = self.rtt.srtt_us();
        self.bundle_until = now_us + if srtt == 0 { BUNDLE_HOLD_US } else { (srtt * BUNDLE_HOLD_RTTS).min(BUNDLE_HOLD_US) };
        let run = if packet.number == self.last_lost_packet + 1 { 1_000_000 } else { 0 };
        self.lost_run_ppm = self.lost_run_ppm - self.lost_run_ppm / LOST_RUN_SMOOTHING + run / LOST_RUN_SMOOTHING;
        self.last_lost_packet = packet.number;
        self.bytes_in_flight -= packet.bytes as u64;
        self.observe_outcome(packet, true);
        self.congestion.on_lost(packet.bytes as u64);
        let distance = self.largest_acked.unwrap_or(0).saturating_sub(packet.number);
        // 修复过的旧包可能晚于新包退休；确认区间的二分查找要求这里始终按包号排序。
        let index = self.lost.partition_point(|lost| lost.packet.number < packet.number);
        self.lost.insert(index, LostPacket { packet: *packet, declared_at: now_us, distance });
        if self.lost.len() > self.config.send_window as usize {
            self.lost.pop_front();
        }
        for &sn in &packet.segments[..packet.segment_count as usize] {
            // 分片只有在旧包被判丢失后才会重发，所以同一分片不会同时在两个待确认的包里。
            let Some(segment) = self.segment_mut(sn) else { continue };
            if segment.acked {
                continue;
            }
            segment.in_flight = false;
            let urgent = segment.urgent;
            self.in_flight -= 1;
            self.retransmit.insert((!urgent, sn));
        }
    }

    fn is_duplicate(&self, number: u64) -> bool {
        self.received.iter().rev().any(|&(low, high, _)| low <= number && number <= high)
    }

    fn record_received(&mut self, number: u64) {
        let index = self.received.partition_point(|&(_, high, _)| high < number);
        let joins_previous = index > 0 && self.received[index - 1].1 + 1 == number;
        let joins_next = self.received.get(index).is_some_and(|&(low, _, _)| low == number + 1);
        let acks = self.acks_sent;
        match (joins_previous, joins_next) {
            (true, true) => {
                let high = self.received[index].1;
                self.received[index - 1].1 = high;
                self.received.remove(index);
                self.received[index - 1].2 = acks;
            }
            (true, false) => {
                self.received[index - 1].1 = number;
                self.received[index - 1].2 = acks;
            }
            (false, true) => {
                self.received[index].0 = number;
                self.received[index].2 = acks;
            }
            (false, false) => self.received.insert(index, (number, number, acks)),
        }
        if self.received.len() > MAX_TRACKED_RANGES {
            self.received.pop_front();
        }
    }

    /// 收下一个分片。返回 false 表示超出窗口、没有收下。
    fn accept_segment(&mut self, sn: u64, payload: &[u8], headed: bool) -> bool {
        if sn < self.rcv_next || self.reorder.contains_key(&sn) {
            return true;
        }
        let window = self.config.recv_window as usize;
        if sn - self.rcv_next >= window as u64 || self.unread_segments >= window * MAX_UNREAD_WINDOWS {
            return false;
        }
        // 没带流头的分片接着前一个分片的流，要等前一个到了才知道归谁；它们受分片窗口限制，占不了多少。
        if headed && !self.admits_header(payload) {
            return false;
        }
        self.parity_dirty |= self.pending_parity.iter().any(|parity| sn < parity.end());
        self.reorder_bytes += payload.len();
        let mut body = self.take_buffer();
        body.extend_from_slice(payload);
        self.reorder.insert(sn, Received { body, headed, place: None, delivered: false });
        self.resolve_places(sn);
        while self.reorder.get(&self.rcv_next).is_some_and(|entry| entry.place.is_some()) {
            let Some(entry) = self.reorder.remove(&self.rcv_next) else { break };
            self.reorder_bytes -= entry.body.len();
            self.rcv_next += 1;
            if let Some((stream, seq)) = entry.place {
                self.rcv_tail = (stream, seq + 1);
                // 流内序号接不上的分片过不了这一步，只有伪造的包才会这样。
                if !entry.delivered
                    && let Some(state) = self.recv_streams.get_mut(&stream)
                {
                    state.waiting.remove(&seq);
                }
            }
            self.retire_received(entry);
        }
        true
    }

    /// 这个流头的分片现在能不能收下。流数到了上限就不再开新流。
    /// 不用查额度：内存已经被分片窗口和未读上限限住，流内序号接不上的分片也留不下来。
    fn admits_header(&self, body: &[u8]) -> bool {
        let Some(header) = StreamHeader::parse(body) else { return false };
        self.recv_streams.contains_key(&header.stream) || self.recv_streams.len() < self.config.max_streams as usize
    }

    /// 从 `sn` 起，能确定归属的分片都交给各自的流。
    fn resolve_places(&mut self, mut sn: u64) {
        loop {
            let previous = if sn == self.rcv_next {
                Some(self.rcv_tail)
            } else {
                sn.checked_sub(1).and_then(|before| self.reorder.get(&before)).and_then(|entry| entry.place).map(|(stream, seq)| (stream, seq + 1))
            };
            let Some(entry) = self.reorder.get(&sn).filter(|entry| entry.place.is_none()) else { return };
            let (stream, seq, fin) = if entry.headed {
                let Some(header) = StreamHeader::parse(&entry.body) else { return };
                if !self.recv_streams.contains_key(&header.stream) {
                    self.recv_streams.insert(header.stream, RecvStream::new(self.config.recv_window as u64));
                    self.push_event(StreamEvent::Opened(header.stream));
                }
                let next = self.recv_streams.get(&header.stream).map_or(0, |state| state.next_seq);
                (header.stream, wire::expand(header.seq, next, wire::SEQUENCE_BITS), header.fin)
            } else {
                let Some((stream, seq)) = previous else { return };
                (stream, seq, false)
            };
            if let Some(entry) = self.reorder.get_mut(&sn) {
                entry.place = Some((stream, seq));
            }
            if let Some(state) = self.recv_streams.get_mut(&stream) {
                if fin && stream != DEFAULT_STREAM {
                    state.fin_seq = Some(seq);
                }
                if seq >= state.next_seq {
                    state.waiting.insert(seq, sn);
                }
            }
            self.deliver(stream);
            sn += 1;
        }
    }

    /// 把一条流里接得上的分片交给应用。分片内容还留在连接这边，校验包可能要用。
    fn deliver(&mut self, stream: u32) {
        let Self { recv_streams, reorder, spare_buffers, ready_bytes, unread_segments, max_segment, .. } = self;
        let Some(state) = recv_streams.get_mut(&stream) else { return };
        while let Some(sn) = state.waiting.remove(&state.next_seq) {
            let Some(entry) = reorder.get_mut(&sn) else { break };
            entry.delivered = true;
            state.next_seq += 1;
            let payload = &entry.body[if entry.headed { STREAM_HEADER_LEN } else { 0 }..];
            if payload.is_empty() {
                state.consumed += 1;
                continue;
            }
            let mut buffer = spare_buffers.pop().unwrap_or_else(|| Vec::with_capacity(*max_segment));
            buffer.extend_from_slice(payload);
            *ready_bytes += buffer.len();
            *unread_segments += 1;
            state.ready.push_back(buffer);
        }
        self.close_if_drained(stream);
    }

    /// 这条流还有没有对端给的额度。默认流看确认帧里的窗口，别的流看各自的额度。
    fn peer_allows(&self, id: u32, stream: &SendStream) -> bool {
        if id == DEFAULT_STREAM { self.snd_sent < self.peer_una + self.peer_window as u64 } else { stream.next_seq < stream.credit_end }
    }

    fn window_blocked(&self) -> bool {
        self.send_streams.iter().any(|(&id, stream)| stream.has_data() && !self.peer_allows(id, stream))
    }

    /// 下一个新分片该给哪条流，现在没有能发的就是 `None`。
    fn next_stream(&self) -> Option<u32> {
        let room = (self.snd_una + self.config.send_window as u64).saturating_sub(self.snd_sent);
        // 给交互流留一点窗口：窗口被丢包卡住时，新消息不用等大量数据。
        let reserve = if self.mixed_traffic { (self.config.send_window as u64 / INTERACTIVE_WINDOW_RESERVE).max(1) } else { 0 };
        self.scheduler.pick(&self.send_streams, |id, stream| {
            let allowed = if stream.priority == Priority::Interactive { room > 0 } else { room > reserve };
            allowed && stream.has_data() && self.peer_allows(id, stream)
        })
    }

    fn update_mixed_traffic(&mut self, now_us: u64) {
        let active = |at: Option<u64>| at.is_some_and(|at| now_us.saturating_sub(at) < STREAM_ACTIVE_US);
        self.mixed_traffic = active(self.last_interactive_at) && active(self.last_other_at);
        self.congestion.set_low_queue(self.mixed_traffic);
    }

    /// 从这条流切一个分片。放不进 `room` 字节时不切。
    fn cut_segment(&mut self, now_us: u64, id: u32, room: usize) -> Option<u64> {
        let max_segment = self.max_segment;
        let tail_stream = self.tail_stream;
        let state = self.send_streams.get(&id)?;
        let continuing = tail_stream == (id, state.next_seq);
        let capacity = if continuing && !state.finishing { max_segment } else { max_segment - STREAM_HEADER_LEN };
        let count = state.pending.len().min(capacity);
        let fin = state.finishing && count == state.pending.len();
        let headed = !continuing || fin;
        let size = count + if headed { STREAM_HEADER_LEN } else { 0 };
        if size > room {
            return None;
        }
        let mut data = self.take_buffer();
        let state = self.send_streams.get_mut(&id)?;
        if headed {
            StreamHeader { stream: id, seq: state.next_seq as u32, fin }.write(&mut data);
        }
        state.take_pending(count, &mut data);
        state.unacked += size;
        state.next_seq += 1;
        state.fin_sent |= fin;
        let (next_seq, priority) = (state.next_seq, state.priority);
        self.send_buffered += size - count;
        self.tail_stream = (id, next_seq);
        let lower_waiting = self.send_streams.values().any(|stream| stream.has_data() && stream.priority.is_lower_than(priority));
        self.scheduler.record(id, priority, lower_waiting);
        let urgent = priority == Priority::Interactive;
        *(if urgent { &mut self.last_interactive_at } else { &mut self.last_other_at }) = Some(now_us);
        self.update_mixed_traffic(now_us);
        self.segments.push_back(Segment { data, stream: id, headed, urgent, acked: false, in_flight: false, sent_before: false });
        Some(self.snd_sent)
    }

    /// 退避按“每次超时”计，不按“每个包”计：包之间可能只隔 0.1 毫秒，
    /// 按包算的话一次断网就能把退避和连续超时次数刷到顶。
    fn timeout_deadline(&self) -> Option<u64> {
        let front = self.sent.front()?;
        let aged = (front.sent_at + self.timeout_age_us()).max(self.parity_hold_until(front).unwrap_or(0)).max(self.timeouts_held_until);
        if self.consecutive_timeouts == 0 {
            return Some(aged);
        }
        let pending: usize = self.send_streams.values().map(|stream| stream.pending.len()).sum();
        let sparse = self.snd_sent - self.snd_una + pending.div_ceil(self.max_segment) as u64 <= SPARSE_BACKLOG_SEGMENTS;
        let backoff = self.rtt.timeout_us(self.consecutive_timeouts, self.long_outage(self.last_timeout_at), sparse);
        Some(aged.max(self.last_timeout_at + backoff + self.reorder_delay_us))
    }

    /// 到 `until_us` 之前收不到确认也不判超时。对端在验证这一端只换了端口的新地址时用：
    /// 验证通过之前它的确认都发往旧端口，这一端在途的包其实都送到了。
    pub(crate) fn hold_timeouts(&mut self, until_us: u64) {
        self.timeouts_held_until = self.timeouts_held_until.max(until_us);
    }

    /// 很久没有收到对端的包，或者还没测到 RTT，都按长断网处理：后者只是不知道往返多长，
    /// 第一批确认还在路上，这时多重传只会添乱。
    fn long_outage(&self, now_us: u64) -> bool {
        self.rtt.srtt_us() == 0 || now_us.saturating_sub(self.last_heard) >= LONG_OUTAGE_US
    }

    /// 超时也要算上学到的乱序余量，否则乱序的包全被超时判丢，放宽判丢窗口也没用。
    fn timeout_age_us(&self) -> u64 {
        self.rtt.timeout_us(0, false, false) + self.reorder_delay_us
    }

    fn loss_deadline(&self) -> Option<u64> {
        let front = self.sent.front()?;
        let aged = front.sent_at + self.loss_delay_us();
        (front.number < self.largest_acked?).then(|| aged.max(self.parity_hold_until(front).unwrap_or(0)))
    }

    /// 受校验保护的包，等校验的结果回来再判丢：校验包到了对端能直接算出来，这时重传就白发了。
    /// 校验救不回来时，多等的也只是几个包的发送时间。
    fn parity_hold_until(&self, packet: &SentPacket) -> Option<u64> {
        let age = self.parity_group_number.checked_sub(packet.parity_group)?;
        if packet.parity_group == 0 || age as usize >= PARITY_RECORDS {
            return None;
        }
        let sent_at = self.parity_sent_at[packet.parity_group as usize % PARITY_RECORDS]?;
        Some(sent_at + self.rtt.loss_delay_us() + self.config.ack_delay_us)
    }

    fn finish_parity_group(&mut self, sent_at: u64) {
        self.parity_sent_at[self.parity_group_number as usize % PARITY_RECORDS] = Some(sent_at);
        self.parity_group_number += 1;
        self.parity_sent_at[self.parity_group_number as usize % PARITY_RECORDS] = None;
    }

    /// 处理到期的计时器。调用方在 `next_wake` 到点时调用。
    pub fn tick(&mut self, now_us: u64) {
        if self.dead {
            return;
        }
        if self.has_unacked_data() && now_us.saturating_sub(self.last_heard) >= self.config.dead_after_us {
            self.dead = true;
            return;
        }
        self.detect_losses(now_us);
        if self.timeout_deadline().is_some_and(|at| at <= now_us) {
            // 一次判完所有超龄的包。只判最老的几个的话，其余的要等退避，整个窗口好几秒才能恢复。
            let age = self.timeout_age_us();
            // 尚未测得 RTT 时，初始超时只是猜测，可能比真实往返还短。第一回先探测一个数据包，保留其余包用于测量。
            // 还有数据等着发（批量传输）时，之后也只探测：600 毫秒的卫星链路上第一批确认还没回来，第二回就整批判丢的话，
            // 整个初始窗口白重发一遍，误判的丢包还把第一轮带宽估计压到很低。只剩零散小消息时第二回起按整批超时处理：
            // 重发它们很便宜，能少等。快要按断网恢复时也整批判丢：那时拥塞窗口收到很小，其余包还算在途的话，
            // 连探测包都发不出去，连接会一直卡到判死。
            let bulk_probe = self.send_streams.values().any(SendStream::has_data) && self.consecutive_timeouts + 1 < RECOVERY_TIMEOUTS;
            let initial_probe = self.rtt.srtt_us() == 0 && (self.consecutive_timeouts == 0 || bulk_probe);
            let mut lost_data = false;
            while let Some(&packet) = self.sent.front() {
                if packet.sent_at + age > now_us || self.parity_hold_until(&packet).is_some_and(|at| at > now_us) {
                    break;
                }
                self.sent.pop_front();
                self.stats.timeout_losses += 1;
                lost_data |= packet.segment_count > 0;
                self.declare_lost(now_us, &packet);
                if initial_probe && packet.segment_count > 0 {
                    break;
                }
            }
            if lost_data {
                self.consecutive_timeouts += 1;
                self.last_timeout_at = now_us;
                self.congestion.on_timeout(now_us, self.consecutive_timeouts, self.long_outage(now_us));
            }
        }
        if self.window_blocked() && self.in_flight == 0 {
            match self.probe_at {
                None => self.probe_at = Some(now_us + self.probe_interval_us),
                Some(at) if at <= now_us => {
                    self.probe_due = true;
                    self.probe_interval_us =
                        (self.probe_interval_us + self.probe_interval_us / 2).min(self.config.probe_max_us);
                    self.probe_at = Some(now_us + self.probe_interval_us);
                }
                Some(_) => {}
            }
        }
    }

    /// 下一次需要调用 `tick` 的时间。没有待办时返回 `None`。
    pub fn next_wake(&self) -> Option<u64> {
        if self.dead {
            return None;
        }
        let mut wake = self.ack_pending.then_some(self.ack_deadline);
        let mut consider = |at: u64| wake = Some(wake.map_or(at, |value: u64| value.min(at)));
        if let Some(at) = self.timeout_deadline() {
            consider(at);
        }
        if let Some(at) = self.loss_deadline() {
            consider(at);
        }
        // 探测计时器只在“被窗口卡住且没有在途数据”时才有意义。其它时候它可能已过期，
        // 算进来会让调用方反复醒来，CPU 空转。
        if self.window_blocked() && self.in_flight == 0 {
            consider(self.probe_at.unwrap_or(self.last_heard));
        }
        if self.within_flight_limits() {
            if self.has_data_to_send() {
                consider(self.congestion.next_send_wake());
            }
            if let Some(at) = self.parity_due_at() {
                consider(at.max(self.congestion.next_send_wake()));
            }
        }
        if self.has_unacked_data() {
            consider(self.last_heard + self.config.dead_after_us);
        }
        wake
    }

    fn has_data_to_send(&self) -> bool {
        !self.retransmit.is_empty() || !self.duplicates.is_empty() || self.next_stream().is_some()
    }

    /// 下一个校验包什么时候该发：攒够了分片，或者窗口满了后面暂时不会再有新数据。
    fn parity_due_at(&self) -> Option<u64> {
        // 只剩一个分片时对端要么收到了，要么下一个重传就到，校验包帮不上。
        let (first, end) = self.parity_range();
        if self.parity_pending == 0 || end - first < 2 {
            return None;
        }
        if self.parity_pending >= self.parity_target {
            return Some(0);
        }
        // 所有数据都发完了：后面不会再有新分片，校验包不用等。
        self.next_stream().is_none().then_some(self.parity_flush_at)
    }

    fn parity_due(&self, now_us: u64) -> bool {
        self.parity_due_at().is_some_and(|at| at <= now_us)
    }

    /// 现在要不要发校验包，要的话每隔多少个新分片发一个。只有速度卡在窗口上时才值得：
    /// 带宽才是瓶颈时，校验包要占数据的位置，比重传贵。瓶颈溢出和限速时再多发只会丢得更多。
    fn parity_interval(&self) -> Option<u32> {
        if self.config.recovery_policy == RecoveryPolicy::Lean {
            return None;
        }
        // 晚到的包和丢掉的包一样堵窗口，校验包都能修。
        let fast = self.config.recovery_policy == RecoveryPolicy::Fast;
        // 开头见过丢包、窗口又装不满路径时，校验按速度优先的余量给：这时还不知道路径有没有余量，但等测出来，
        // 第二轮里丢的包要等一个往返的重传，窗口白白卡住。没见过丢包时不发，干净路径不多花字节。
        let coverable = self.config.send_window as u64 <= parity::MAX_COVERED * HEAVY_PARITY_COVERAGE_FACTOR;
        let early = !fast
            && coverable
            && self.congestion.is_starting()
            && self.loss_ppm > 0
            && self.congestion.window_bound_path()
            && !self.limiter_suspected();
        let warmup = (fast && self.loss_samples < BUNDLE_WARMUP_PACKETS) || early;
        let floor = if self.last_heard < self.parity_floor_until { PARITY_MIN_LOSS_PPM } else { 0 };
        let holes = if early { (self.loss_ppm + self.late_ppm).max(EARLY_PARITY_LOSS_PPM) } else if warmup { 50_000 } else { (self.loss_ppm + self.late_ppm).max(floor) };
        let useful = (PARITY_MIN_LOSS_PPM..=PARITY_MAX_LOSS_PPM).contains(&holes);
        // 量到了上限（还没确认也算）、丢得又远多于随机丢包：丢的是限速器挡下的包，校验包只会占掉限速的额度。
        let limiter_losses = self.congestion.rate_cap() > 0
            && self.loss_ppm as u64 > (self.congestion.random_loss_ppm() as u64).saturating_mul(2).saturating_add(LIMITER_EXCESS_LOSS_PPM);
        if (!warmup && !self.congestion.window_bound_path()) || !useful || self.congestion.is_rate_limited() || limiter_losses {
            return None;
        }
        // 成片地丢是撞上了容量，这时多发只会丢得更多，校验也修不过来。随机丢包是零散的。
        if self.lost_run_ppm >= PARITY_LOST_RUN_PPM {
            return None;
        }
        let spare = warmup || self.congestion.window_is_the_limit();
        // 窗口受限、路径还有余量时，自动策略按速度优先的余量发校验：这时校验不挤占数据，只多花流量。
        // 一个校验包只覆盖最近 64 个分片，窗口比覆盖范围大很多时，大部分空洞修不到，多发也帮不上。
        let heavy = fast || early || (spare && coverable && self.congestion.window_has_room());
        let interval = if heavy { parity::fast_repair_interval(holes, spare) } else { parity::repair_interval(holes, spare) };
        // 为抖动多发的校验按比例直接给，不再乘余量：比例由 `jitter_parity_ppm` 逐轮试出来。
        let share = self.jitter_parity_ppm.min(500_000) as u64;
        let jitter_interval = if share > 0 { ((1_000_000 - share) / share).max(1) as u32 } else { u32::MAX };
        Some(interval.min(jitter_interval))
    }

    /// 每轮调整一次为抖动多发的校验。
    ///
    /// 抖动大时窗口要等最慢的那个包确认才能往前走，KCP 的 FEC 配置靠校验把晚到的包提前算出来。
    /// 但被窗口限住时测不出路径还剩多少余量：余量够的路径（家宽、5G）多发校验能快 3%–5%，
    /// 余量不够的路径（4G、校园网、千兆）校验会挤掉数据。所以逐轮试：窗口确实卡住、没排队时每轮加一点，
    /// 最多加到抖动晚到的比例；一轮里最小的 RTT 涨了（队列冒头）就减半，并把上限压到这次的四分之三，之后慢慢放开。
    fn adjust_jitter_parity(&mut self) {
        let round = self.congestion.round_count();
        if round == self.jitter_parity_round {
            return;
        }
        self.jitter_parity_round = round;
        if self.congestion.queue_rising() || self.congestion.rate_cap() > 0 {
            if self.jitter_parity_ppm > 0 {
                self.jitter_parity_ceiling = self.jitter_parity_ppm * 3 / 4;
            }
            self.jitter_parity_ppm /= 2;
        } else if self.congestion.window_limited_without_queue()
            && self.congestion.window_binds()
            && self.congestion.min_rtt_us() >= JITTER_PARITY_MIN_RTT_US
        {
            self.jitter_parity_ceiling = (self.jitter_parity_ceiling + JITTER_CEILING_RELAX_PPM).min(1_000_000);
            // 上限除了晚到的比例，还跟丢包率走：路径有余量时，修复等得越短，窗口每轮卡得越少。
            let wanted = self.jitter_late_ppm.max((self.loss_ppm + self.late_ppm).saturating_mul(LOSS_PARITY_FACTOR).min(LOSS_PARITY_MAX_PPM));
            self.jitter_parity_ppm = (self.jitter_parity_ppm + JITTER_PARITY_STEP_PPM).min(wanted).min(self.jitter_parity_ceiling);
        }
    }

    /// 校验包覆盖的范围：最近发出的、对端可能还缺的分片。
    fn parity_range(&self) -> (u64, u64) {
        (self.snd_una.max(self.snd_sent.saturating_sub(parity::MAX_COVERED)), self.snd_sent)
    }

    fn parity_frame_len(&self) -> usize {
        let (first, end) = self.parity_range();
        let largest = self.segments.iter().skip((first - self.snd_una) as usize).take((end - first) as usize).map(|segment| segment.data.len()).max();
        wire::PARITY_HEADER_LEN + largest.unwrap_or(0)
    }

    fn write_parity(&mut self, out: &mut [u8], used: usize, now_us: u64) -> usize {
        let (first, end) = self.parity_range();
        let symbol = self.parity_symbol;
        self.parity_symbol = (symbol + 1) % parity::SYMBOLS;
        let mut data = self.take_buffer();
        let mut length = 0u16;
        for sn in first..end {
            let segment = &self.segments[(sn - self.snd_una) as usize];
            let factor = parity::coefficient(symbol, sn);
            length ^= parity::scale_length(coded_length(segment.data.len(), segment.headed), factor);
            parity::add_scaled(&mut data, &segment.data, factor);
        }
        let used = wire::write_parity(out, used, first, (end - first) as u8, symbol, length, &data);
        self.recycle_buffer(data);
        self.parity_pending = 0;
        self.finish_parity_group(now_us);
        self.stats.parity_packets += 1;
        used
    }

    /// 成片地丢、或者量到了上限：丢的多半是瓶颈或限速器挡下的包，不是随机丢包，也不是乱序。
    fn limiter_suspected(&self) -> bool {
        self.lost_run_ppm >= PARITY_LOST_RUN_PPM || self.congestion.rate_cap() > 0
    }

    /// 路径一个往返能装下半个窗口以上、又见过丢包：这时窗口往前走的每一刻都值钱，请对端逐包确认。
    /// 干净路径照旧每两个包确认一次，窄带线路也不受影响，那里确认本身就占不少流量。
    fn wants_eager_acks(&self) -> bool {
        let floor = if self.last_heard < self.parity_floor_until { PARITY_MIN_LOSS_PPM } else { 0 };
        self.config.recovery_policy != RecoveryPolicy::Lean
            && self.congestion.window_bound_path()
            && !self.limiter_suspected()
            && (self.loss_ppm + self.late_ppm).max(floor) >= PARITY_MIN_LOSS_PPM
    }

    fn should_duplicate(&self) -> bool {
        if self.config.recovery_policy == RecoveryPolicy::Lean {
            return false;
        }
        let threshold = if self.parity_interval().is_some() { DUPLICATE_WITH_PARITY_LOSS_PPM } else { DUPLICATE_LOSS_PPM };
        // 窗口卡住时，启动阶段还量不到随机丢包率，先按总丢包率算：这时重传再丢一次，整个窗口又要多等一个往返。
        // 成片地丢、或者量到了上限，丢的多半是限速器挡下的包，再发一份只会丢得更多。
        let unmeasured = self.congestion.is_starting() && self.congestion.window_bound_path() && !self.limiter_suspected();
        let loss = if unmeasured { self.loss_ppm } else { self.congestion.random_loss_ppm() };
        loss >= threshold
            && !self.congestion.is_rate_limited()
            && self.duplicates.len() < MAX_DUPLICATES_QUEUED
            && self.next_stream().is_none()
    }

    fn within_flight_limits(&self) -> bool {
        // 校验包不占发送窗口，但算在途字节。要留出它的位置，否则校验越多能发的数据越少。
        let cwnd = self.congestion.cwnd();
        let parity_room = self.parity_interval().map_or(0, |interval| cwnd / interval as u64);
        self.in_flight < self.config.send_window && self.bytes_in_flight < cwnd + parity_room
    }

    fn may_send(&mut self, now_us: u64) -> bool {
        if !self.within_flight_limits() {
            self.congestion.stop_pacing_catch_up();
        } else if self.in_flight < UNPACED_SEGMENTS || self.congestion.can_send(now_us) {
            return true;
        }
        // 交互消息不用排在大量数据后面等节奏和拥塞窗口。丢包时在途量会远超窗口，这时更要让它走。
        // 用量按往返算：大量数据就算标成交互流，超出这点额度后也要照常排节奏，不能把瓶颈顶爆。
        if now_us.saturating_sub(self.urgent_round_at) >= self.rtt.srtt_us().max(1) {
            self.urgent_round_at = now_us;
            self.urgent_round_bytes = 0;
        }
        self.urgent_round_bytes < INTERACTIVE_ROUND_SEGMENTS * self.config.max_packet_size
            && self.in_flight < self.config.send_window
            && self.next_is_urgent()
    }

    fn next_duplicate(&mut self) -> Option<u64> {
        while let Some(&sn) = self.duplicates.front() {
            if sn >= self.snd_una && self.segment_mut(sn).is_some_and(|segment| !segment.acked) {
                return Some(sn);
            }
            self.duplicates.pop_front();
        }
        None
    }

    fn next_retransmit(&mut self) -> Option<(bool, u64)> {
        while let Some(&(routine, sn)) = self.retransmit.first() {
            if sn >= self.snd_una && self.segment_mut(sn).is_some_and(|segment| !segment.acked && !segment.in_flight) {
                return Some((routine, sn));
            }
            self.retransmit.pop_first();
        }
        None
    }

    /// 下一个新分片是不是交互流的。
    fn next_interactive_stream(&self) -> Option<u32> {
        self.next_stream().filter(|id| self.send_streams.get(id).is_some_and(|stream| stream.priority == Priority::Interactive))
    }

    /// 接下来要发的是交互流的数据。
    fn next_is_urgent(&mut self) -> bool {
        matches!(self.next_retransmit(), Some((false, _))) || self.next_interactive_stream().is_some()
    }

    /// 下一个要发的分片，放不进 `room` 字节时是 `None`。
    fn next_segment_to_send(&mut self, now_us: u64, room: usize) -> Option<u64> {
        let retransmit = self.next_retransmit();
        // 先发交互流的重传和新消息，再发其他重传：成片丢包后的重传队列很长，新消息不能排在它后面。
        if !matches!(retransmit, Some((false, _)))
            && let Some(id) = self.next_interactive_stream()
        {
            return self.cut_segment(now_us, id, room);
        }
        if let Some((_, sn)) = retransmit {
            let size = self.segment_mut(sn)?.data.len();
            return (size <= room).then_some(sn);
        }
        let id = self.next_stream()?;
        self.cut_segment(now_us, id, room)
    }

    /// 取下一个要发的包，写入 `out` 并返回长度；暂时没有要发的返回 `None`。
    /// `out` 至少要有 `max_packet_size` 字节。
    pub fn poll_transmit(&mut self, now_us: u64, out: &mut [u8]) -> Option<usize> {
        if self.dead {
            return None;
        }
        // 发校验包会让受保护的包结束等待，判丢和超时的时间可能已经过了。在这里处理掉，丢的数据马上就能重传。
        if self.loss_deadline().is_some_and(|at| at <= now_us) || self.timeout_deadline().is_some_and(|at| at <= now_us) {
            self.tick(now_us);
            if self.dead {
                return None;
            }
        }
        self.update_mixed_traffic(now_us);
        if !self.has_data_to_send() {
            self.congestion.stop_pacing_catch_up();
        }
        let out = &mut out[..self.config.max_packet_size - self.overhead];
        let mut bundled = [0u64; MAX_BUNDLED_SEGMENTS];
        let mut bundled_count = 0;
        let can_send_data =
            self.may_send(now_us) && (self.parity_due(now_us) || self.next_duplicate().is_some() || self.next_retransmit().is_some() || self.next_stream().is_some());
        let ack_due = self.ack_pending && self.ack_deadline <= now_us;
        if !ack_due && !can_send_data && !self.probe_due {
            return None;
        }

        let number = self.next_packet;
        let header = wire::write_header(out, number, self.wants_eager_acks());
        let mut used = header;
        // 有数据要发时顺带确认，省一个纯确认包。
        if self.ack_pending {
            let delay = now_us.saturating_sub(self.largest_received_at);
            let window = self.advertised_window();
            let late_packets = &self.late_packets[..self.late_packet_count];
            let acks = self.acks_sent;
            let ranges = self.received.iter().map(|&(low, high, changed)| (low, high, acks.wrapping_sub(changed) < wire::RANGE_REPORT_ACKS));
            used = wire::write_ack(out, used, ranges, late_packets, delay, self.rcv_next, window);
            self.acks_sent = self.acks_sent.wrapping_add(1);
            self.late_packet_count = 0;
            self.ack_pending = false;
            self.unacked_packets = 0;
            used = self.write_grants(out, used);
        }

        // 校验内容一直到包尾，这个包不再放别的。排在数据前面，否则满载时永远轮不到它。
        let mut parity_sent = false;
        if self.parity_due(now_us) && self.may_send(now_us) && used + self.parity_frame_len() <= out.len() {
            used = self.write_parity(out, used, now_us);
            parity_sent = true;
        }

        while !parity_sent && bundled_count < MAX_BUNDLED_SEGMENTS && self.may_send(now_us) {
            let Some(sn) = self.next_duplicate() else { break };
            // 同一分片的主动副本必须分开发包，同一个 UDP 包里的重复数据没有独立的送达机会。
            if bundled[..bundled_count].contains(&sn) {
                break;
            }
            let Some(segment) = self.segment_mut(sn) else { break };
            if used + wire::DATA_HEADER_LEN + segment.data.len() > out.len() {
                break;
            }
            used = wire::write_data(out, used, sn, &segment.data, segment.headed);
            self.duplicates.pop_front();
            bundled[bundled_count] = sn;
            bundled_count += 1;
            self.stats.bundled_segments += 1;
        }

        let mut segments = [0u64; MAX_SEGMENTS_PER_PACKET];
        let mut count = 0usize;
        let mut small_copied = false;
        let mut protected_by = 0;
        // 校验包到期但这个包放不下时先停一下：双向传输时每个包都带确认，继续发新数据的话校验包永远轮不到。
        while !parity_sent && !self.parity_due(now_us) && count < MAX_SEGMENTS_PER_PACKET && self.may_send(now_us) {
            let Some(sn) = self.next_segment_to_send(now_us, (out.len() - used).saturating_sub(wire::DATA_HEADER_LEN)) else { break };
            let Some(segment) = self.segment_mut(sn) else { break };
            used = wire::write_data(out, used, sn, &segment.data, segment.headed);
            let retransmission = core::mem::replace(&mut segment.sent_before, true);
            let urgent = segment.urgent;
            let size = segment.data.len();
            segment.in_flight = true;
            if urgent {
                self.urgent_round_bytes += size;
            }
            self.in_flight += 1;
            if !self.retransmit.remove(&(!urgent, sn)) {
                self.snd_sent += 1;
            }
            if !retransmission {
                match self.parity_interval() {
                    Some(interval) => {
                        if self.parity_pending == 0 {
                            self.parity_flush_at = now_us + self.rtt.srtt_us() / PARITY_FLUSH_RTT_DIVISOR;
                        }
                        self.parity_target = interval;
                        self.parity_pending += 1;
                        protected_by = self.parity_group_number;
                    }
                    None if self.parity_pending > 0 => {
                        self.parity_pending = 0;
                        self.finish_parity_group(0);
                    }
                    None => {}
                }
            }
            if !retransmission && self.queue_small_message_copies(now_us, sn) {
                small_copied = true;
            }
            if retransmission {
                self.stats.retransmitted_segments += 1;
                if !urgent {
                    self.scheduler.record_retransmission();
                }
                if self.should_duplicate() {
                    self.duplicates.push_back(sn);
                }
            }
            segments[count] = sn;
            count += 1;
        }
        let warmup_packets = if self.config.recovery_policy == RecoveryPolicy::Fast { BUNDLE_WARMUP_PACKETS } else { AUTO_BUNDLE_WARMUP_PACKETS };
        let warmup = self.loss_samples < warmup_packets;
        let bundling = self.loss_ppm >= BUNDLE_LOSS_PPM || now_us < self.bundle_until || warmup;
        // 副本和原件同一时刻发出，成片丢包时会一起丢；这时再在后面的包里捎带一份，把时间错开。
        let burst_losses = self.lost_run_ppm >= PARITY_LOST_RUN_PPM;
        if self.config.recovery_policy != RecoveryPolicy::Lean && count > 0 && bundling && (!small_copied || burst_losses) {
            (used, bundled_count) = self.bundle_unacked(out, used, &segments[..count], &mut bundled, bundled_count);
        }

        let mut ack_eliciting = count > 0 || bundled_count > 0 || parity_sent;
        // 确认可能把包填满。探测留到下一个包，不能越界。
        if self.probe_due && used < out.len() && !parity_sent {
            self.probe_due = false;
            used = wire::write_ping(out, used);
            ack_eliciting = true;
        }
        if used == header {
            return None;
        }

        self.next_packet += 1;
        self.stats.packets_sent += 1;
        let wire_bytes = used + self.overhead;
        self.stats.wire_bytes_sent += wire_bytes as u64;
        if ack_eliciting {
            if self.bytes_in_flight == 0 {
                self.first_sent_at = now_us;
                self.delivered_at = now_us;
            }
            // 对端窗口卡住时测到的速率同样不代表路径能力，要和“应用没东西发”一样对待。
            let app_limited = !self.has_data_to_send();
            let app_idle = self.retransmit.is_empty() && !self.send_streams.values().any(SendStream::has_data);
            let below_capacity = app_idle || self.congestion.sends_below_capacity();
            self.sent.push_back(SentPacket {
                number,
                sent_at: now_us,
                bytes: wire_bytes as u32,
                segment_count: count as u8,
                segments,
                parity_group: protected_by,
                bundled_count: bundled_count as u8,
                bundled,
                below_capacity,
                calm_trusted: self.congestion.trusts_calm_samples(),
                calm_foreign: self.congestion.queue_is_foreign(),
                probing: self.congestion.is_probing_up(),
                cruising: self.congestion.is_cruising(),
                cycle: self.congestion.phase_cycle(),
                app_idle,
                delivered: self.delivered,
                delivered_at: self.delivered_at,
                first_sent_at: self.first_sent_at,
                app_limited,
            });
            self.bytes_in_flight += wire_bytes as u64;
            self.congestion.on_sent(now_us, wire_bytes as u64);
        }
        Some(used)
    }

    /// 把还没告诉对端的流量额度写进这个包，放不下的留给后面的确认。
    fn write_grants(&mut self, out: &mut [u8], mut used: usize) -> usize {
        let mut written = 0;
        for (&id, state) in self.recv_streams.iter_mut() {
            if written == MAX_GRANTS_PER_PACKET || used + wire::CREDIT_FRAME_LEN > out.len() {
                break;
            }
            if state.grant_repeats > 0 && id != DEFAULT_STREAM {
                state.grant_repeats -= 1;
                used = wire::write_credit(out, used, id, state.granted_end);
                written += 1;
            }
        }
        used
    }

    /// 稳定丢包时，把小消息的冗余分散到独立包中，不必等下一条消息才修复。
    /// 副本预算沿用原来的捎带份数；已经复制的原件平时不再捎带旧数据，避免叠加两套冗余，成片丢包时例外。
    fn queue_small_message_copies(&mut self, now_us: u64, sn: u64) -> bool {
        if self.config.recovery_policy == RecoveryPolicy::Lean
            || self.segments[(sn - self.snd_una) as usize].data.len() > self.config.max_packet_size / 4
            || (self.loss_ppm < BUNDLE_LOSS_PPM && now_us >= self.bundle_until)
            || self.congestion.is_rate_limited()
            || self.rtt.srtt_us() == 0
            // 短时间收不到回应时照样复制：可能只是确认方向断了，数据照样能到，这时零散丢包没有确认就补不回来，
            // 只能靠副本。成片丢包也照样复制：隔几秒断一次的链路上，断网后的保护期会把副本一直关掉。
            // 长时间断网才停：那时只发少量探测省流量。
            || now_us.saturating_sub(self.last_heard) >= LONG_OUTAGE_US
        {
            return false;
        }
        let mut copies = BUNDLE_COPIES.iter().find(|&&(loss, _)| self.loss_ppm >= loss).map_or(1, |&(_, copies)| copies);
        if self.config.recovery_policy == RecoveryPolicy::Fast {
            copies = copies.max(3);
        }
        if self.duplicates.len() + copies > MAX_DUPLICATES_QUEUED {
            return false;
        }
        self.duplicates.extend(core::iter::repeat_n(sn, copies));
        true
    }

    /// 丢包严重时，把还没确认的小消息捎带在这个包的空余位置里。
    /// 前一个包丢了也不用等重传，下一个包就把数据带到了。满载传输的包没有空位，不受影响。
    /// 份数随丢包率增加：丢 1% 时一份就够，全带上只是白占流量。
    fn bundle_unacked(
        &mut self,
        out: &mut [u8],
        mut used: usize,
        primary: &[u64],
        bundled: &mut [u64; MAX_BUNDLED_SEGMENTS],
        mut added: usize,
    ) -> (usize, usize) {
        let copies = BUNDLE_COPIES.iter().find(|&&(loss, _)| self.loss_ppm >= loss).map_or(1, |&(_, copies)| copies);
        let limit = (added + copies).min(MAX_BUNDLED_SEGMENTS);
        // 平时从最新的开始：刚发的最可能还没到，最老的多半已经到了只是确认还在路上。
        // 连续超时说明断网了，这时反过来：最老的堵着后面所有消息，网一通第一个包就要把它带到。
        // 只超时一次不算：可能只是这个包和它的副本都丢了，或者初始超时比 RTT 短。
        let sent = (self.snd_sent - self.snd_una) as usize;
        let scan = sent.min(BUNDLE_SCAN_SEGMENTS);
        let stalled = self.consecutive_timeouts >= BUNDLE_OLDEST_TIMEOUTS;
        for offset in 0..scan {
            let index = if stalled { offset } else { sent - 1 - offset };
            let sn = self.snd_una + index as u64;
            let segment = &self.segments[index];
            if added == limit {
                break;
            }
            if segment.acked || (!stalled && !segment.in_flight) || primary.contains(&sn) {
                continue;
            }
            if used + wire::DATA_HEADER_LEN + segment.data.len() > out.len() {
                continue;
            }
            used = wire::write_data(out, used, sn, &segment.data, segment.headed);
            bundled[added] = sn;
            added += 1;
            self.stats.bundled_segments += 1;
        }
        (used, added)
    }
}
