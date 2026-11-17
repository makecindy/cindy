//! 基于带宽估计的拥塞控制和发送节奏，思路来自 BBR。
//!
//! 不把丢包当成拥塞信号：弱网的丢包多半是随机的，一丢就减速只会越传越慢。
//! 这里测量“实际送达速率”和“最小往返时间”，按估计出的带宽匀速发送，
//! 既不把瓶颈队列塞满，也不会被随机丢包吓住。

/// 增益用千分比表示。
const STARTUP_GAIN: u64 = 2885;
const DRAIN_GAIN: u64 = 347;
const CWND_GAIN: u64 = 2000;
/// 被窗口限住、离路径容量还远时，在途字节上限放宽到一个窗口的这么多倍。校验包、副本和等着校验结果的丢包
/// 都占在途字节却不占窗口，上限正好卡在一个窗口的话，丢包率越高窗口空得越多。
const WINDOW_LIMITED_CWND_CAP: u64 = 2000;
/// 超时或断网之后要连续这么多轮正常，才按上面放宽：刚恢复时窗口里全是丢掉的包，看起来也像被窗口限住。
const SPARE_WINDOW_CLEAN_ROUNDS: u32 = 2;
/// 路径速率至少是窗口速率的 21/20，才算还有余量放下加密的校验。
const ROOM_RATIO_NUMERATOR: u64 = 21;
const ROOM_RATIO_DENOMINATOR: u64 = 20;
const PROBE_CYCLE: [u64; 8] = [1250, 750, 1000, 1000, 1000, 1000, 1000, 1000];
/// 交互消息和大量数据同时在发时压低网络里的队列：在途量只留一点余量，巡航略低于带宽，加速探测也放轻。
/// 大量数据慢一点点，换来交互消息不用在瓶颈排队。
const LOW_QUEUE_CWND_GAIN: u64 = 1250;
/// 启动时冲得越猛，确认回来之前多发的越多，排队区一满交互消息就要等半秒。
const LOW_QUEUE_STARTUP_GAIN: u64 = 1350;
const LOW_QUEUE_CRUISE_GAIN: u64 = 970;
const LOW_QUEUE_PROBE_GAIN: u64 = 1050;
/// 探测撞到丢包，说明到顶了。之后巡航低于顶点一点，给别的流留个口子：顶着容量发的话，
/// TCP 一抬头就丢包，退到几乎没有流量，连被挤掉的信号都留不下来。
const HEADROOM_CRUISE_GAIN: u64 = 900;
/// 让路模式按 CUBIC（RFC 8312）算窗口：丢包时减到这个比例（千分比）。
const FAIR_BETA: u64 = 700;
/// 让路时窗口的计量单位至少这么大。TCP 的常数都是按满包定的，公平按字节算，包小的连接不该跟着慢。
const FAIR_UNIT_BYTES: u64 = 1400;
/// 让路时窗口最小几个包，和 TCP 一样。共用的下限比短往返窄路径的带宽延迟积还大，退到底也在超发。
const FAIR_MIN_PACKETS: u64 = 2;
const FAIR_SMALL_WINDOW_DIVISOR: u64 = 64;
/// 接管后这么多轮不减窗口。这几轮查出来的丢包都是启动阶段冲过头发的。
const FAIR_SETTLE_ROUNDS: u8 = 2;
/// CUBIC 的常数：窗口按 0.4 乘以（毫秒数的立方除以 10 的 9 次方）增长。
/// 换算成毫秒和分片：`K = 立方根(W × 0.3 / 0.4 × 10^9)`。
const FAIR_K_FACTOR: u64 = 750_000_000;
/// 压低队列时，路径的基础往返时间取最近这么多轮的最小值。
const RECENT_ROUNDS: usize = 8;
/// 压低队列时连续这么多轮判断在排队、往返时间却没有降下来，说明不是自己排的队，以现在的值为基准。
const QUEUE_CHECK_ROUNDS: u8 = 3;

const BW_WINDOW_ROUNDS: usize = 10;
/// 丢得比送达还多的轮次最多连续这么多轮不老化带宽样本。突发丢包和短断网撑不了这么久；
/// 一直这样是几条流一起超发，带宽估计不降下来，超发就一直持续。
const OUTAGE_HOLD_ROUNDS: u32 = 8;
const MIN_RTT_WINDOW_US: u64 = 10_000_000;
const PROBE_RTT_US: u64 = 200_000;
const FULL_BW_GROWTH: u64 = 1250;
const FULL_BW_ROUNDS: u8 = 3;
/// 还没有测量值时的默认发送速率，约 32 Mbit/s。第一批确认到达后就换成实测值。
const INITIAL_RATE: u64 = 4_000_000;
/// 第一批包的发送速率，约 128 Mbit/s。这批包的量由初始窗口管着，发得快只是让窗口早点转起来；
/// 带宽估计仍以 `INITIAL_RATE` 为上限，令牌桶放行的突发不会把估计抬高。
const FIRST_FLIGHT_RATE: u64 = 16_000_000;
/// 初始窗口发完、第一个确认还没回来时，窗口余下的部分按这个速率慢慢发，约 2 Mbit/s。
/// 这时什么也测不到：长往返路径上干等一个往返，窗口要空出半轮；慢慢发的话，窄带线路也来得及排空，挤不爆队列。
const FIRST_FLIGHT_TRICKLE_RATE: u64 = 250_000;
/// 初始窗口发完后等这么久才开始慢慢发。往返更短的路径上第一个确认已经回来了，用不着猜。
const FIRST_FLIGHT_TRICKLE_DELAY_US: u64 = 150_000;
/// 第一批确认测到的速率贴着自身发送上限，且测得的 BDP 远大于初始窗口时，才加速探测。
const TRAIN_PACING_HEADROOM: u64 = 4;
const TRAIN_BDP_RATIO: u64 = 8;
/// 允许提前这么久发送，避免为每个包都单独起一次计时器。
const PACING_QUANTUM_US: u64 = 1_000;
/// 发送节奏最多补回这么久的迟到，盖得住 Windows 默认 15.6 毫秒的定时器。
const PACING_CATCH_UP_US: u64 = 20_000;
const LOW_QUEUE_CATCH_UP_PACKETS: u64 = 2;
/// 连续超时这么多次（约 20 个往返没有任何确认），旧的带宽估计就不能再信了。
const PATH_CHANGE_TIMEOUTS: u32 = 12;
/// 连续超时这么多次（约 400 毫秒完全没有回应）就只发少量探测，等有确认回来再恢复。
/// 真断网时每次超时都重发整个窗口只是白费流量；但阈值不能太低：
/// 双向 90% 的突发丢包里，少量探测几乎拿不回确认，反而拖慢恢复。
pub(crate) const RECOVERY_TIMEOUTS: u32 = 4;
/// 短中断时拥塞窗口保留这么多倍的下限，确认方向断开时新数据仍能发出。
const SHORT_OUTAGE_CWND_FACTOR: u64 = 4;
/// 一轮里最小的 RTT 比历史最小值高出这么多，说明瓶颈有队列了。取一轮的最小值是为了滤掉抖动。
/// 启动阶段靠它尽早停下：等带宽不再增长才退出的话，再冲 3 个往返足够把队列挤爆。
const QUEUE_MARGIN_MIN_US: u64 = 4_000;
const QUEUE_MARGIN_MAX_US: u64 = 16_000;
/// 认别人的队列时余量的下限，见 [`Bbr::foreign_margin_us`]。
const FOREIGN_MARGIN_MIN_US: u64 = 500;
/// 一轮至少要有这么多 RTT 样本，才算数。
const ROUND_RTT_SAMPLES: u32 = 8;
/// 巡航时发现有队列，略微降速把它排空。带宽估计常有 1～2% 的高估，不纠正的话
/// 队列会一直涨到拥塞窗口的上限，大文件传输时所有交互都要多等一个往返。
const QUEUE_DRAIN_GAIN: u64 = 900;
/// 判断是否撞到容量的统计时段。要盖住限速器的一个周期，太短会把放行阶段当成上限。
const PERIOD_MIN_US: u64 = 1_000_000;
const PERIOD_MIN_RTTS: u64 = 8;
/// 一段拖得比正常长这么多倍，说明中间断网了：确认都回不来，这段的丢包率什么也说明不了。
const PERIOD_STALE_FACTOR: u64 = 3;
/// 确认中断超过这么多个往返（至少这么久），这一段的丢包按断网处理，不用来判断限速。
const OUTAGE_SILENCE_RTTS: u64 = 3;
const OUTAGE_SILENCE_MIN_US: u64 = 250_000;
/// 丢得比送达的还多时不用等满一段：这种丢法随机丢包到不了，多等一会儿就多浪费好几 MB。
const SEVERE_PERIOD_MIN_US: u64 = 200_000;
/// 一段里丢包超过这个比例、又至少有一半往返在丢，就直接确认上限。
const STRONG_EXCESS_LOSS_PPM: u64 = 150_000;
const SUSTAINED_MIN_ROUNDS: u32 = 4;
const SEVERE_PERIOD_MIN_RTTS: u64 = 4;
/// 总丢包率超过低速时丢包率的 1.25 倍再加这么多，再加两倍标准误，才算丢包随速率上涨。
/// 样本少时估计值波动大，门槛跟着放宽；样本多了门槛收紧，限速器也能更早认出来。
const EXCESS_LOSS_PPM: u64 = 30_000;
/// 这一段里至少要有这么多低速时发的包，才有资格下结论。
const PERIOD_MIN_CALM_PACKETS: u32 = 16;
/// 确认过的上限每隔这么久放开一档，看看路径是不是变好了：量到的值可能偏低，上限也可能调整过。
/// 每档只放开 1/8，撞上时丢的量很小。连续放开这么多次都没撞上就取消。
const CAP_CONFIRMED_HOLD_US: u64 = 2_000_000;
const CAP_MAX_RAISES: u32 = 4;
/// 宽松的上限设下以后，至少过这么多轮才看最近的丢包：丢失要晚一个往返才判出来。
const CAP_RELEASE_ROUNDS: u64 = 3;
/// 被窗口限住时的发送节奏增益。这时测到的只是窗口的速率，路径能力还在上面，
/// 节奏不能再压一层，否则窗口一打开也补不回来。
const WINDOW_LIMITED_GAIN: u64 = 2000;
/// 确认路径有余量以后的发送节奏增益。一窗口的包发得越紧凑，丢的包等到校验包的时间越短，窗口每轮卡得越少。
const WINDOW_ROOM_GAIN: u64 = 8000;
const WINDOW_LIMITED_CALM_GAIN: u64 = 900;
/// 补偿的上限：随机丢包再高，发送速率也只放大到送达速率的两倍。
const MAX_RANDOM_LOSS_PPM: u32 = 500_000;
/// 连续这么多轮都有数据等着发，就是持续满发。这时只补加速探测补不回来的那部分随机丢包，见 [`saturated_compensation`]。
/// 几条连接挤满一个浅队列时队列一直不空，最小往返里已经含着排队，看不出是别人挤掉的包；单看一条连接，
/// 这和线路本身随机丢包一模一样，补偿只会让大家一起多发、一起多丢。2026-11-05 扫了 144 种浅队列组合，
/// 原来满发时按 20% 封顶补偿，平均丢 9.15%、43 种超过 10%；改成这样以后 5.95%、23 种。代价是单条连接在低速、
/// 高丢包的线路上慢一些（3 Mbit/s、往返 150 毫秒、突发丢 10% 时慢 38%），用户 2026-11-05 选了整体的网络体验。
/// 零散的小消息不受影响，断网恢复时它们还要靠补偿尽快发完积压。
const SATURATED_ROUNDS: u32 = 8;
/// 持续满发时随机丢包在这以内不补偿：加速探测多发 25%，丢 16% 时送到的仍比原来多 5%，带宽估计涨得上去。
const SATURATED_FREE_LOSS_PPM: u64 = 160_000;
/// 持续满发时最多补这么多，和原来的封顶一样，判错时的损失上限、满发时扛得住的随机丢包（约 36%）都不变。
const SATURATED_MAX_COMPENSATION_PPM: u64 = 200_000;
/// 持续满发时按多少随机丢包补偿：超出 [`SATURATED_FREE_LOSS_PPM`] 的部分乘 1.25，补到探测时送到的比原来多 5%。
/// 丢 30% 时补 17.5%。完全不补的话，大窗口满发会越传越慢：丢 30% 时 64 MiB 从 8 秒变成 348 秒
/// （`random_loss_does_not_collapse_the_rate`）。
fn saturated_compensation(random_ppm: u64) -> u64 {
    (random_ppm.saturating_sub(SATURATED_FREE_LOSS_PPM) * 5 / 4).min(SATURATED_MAX_COMPENSATION_PPM)
}
/// 随机丢包率按“丢了几个 / 一共几个”计算，样本攒到这么多就各减半，旧样本逐渐淡出。
/// 不用逐个样本的指数平滑：同一批包里确认先到、判丢后到，平滑值总是被最后到的丢包拉高，
/// 丢 9% 时能估成 18%。
const CALM_SAMPLE_WINDOW: u32 = 512;
/// 样本少于这么多时按这么多算，刚开始一两个丢包不会把估计值推得很高。
const CALM_SAMPLE_FLOOR: u32 = 64;
/// 巡航时比降速时平均多丢这么多（再加两倍标准误），说明丢包跟着速率涨，巡航已经超过线路容量。
/// 真的随机丢包和速率无关，单条连接在随机丢 3%～10% 的路径上两者只差 0.4～0.8 个百分点；
/// 几条连接挤一个看不出排队的浅队列时差 3～6 个百分点。
const OVERFLOW_EXCESS_PPM: i64 = 15_000;
/// 两个阶段的包按探测周期累计，旧的计数逐个周期打折，大约这么久以前的结果淡出。
/// 按包数累计是因为一个周期的降速阶段只有一个往返，包很少，单看一个周期噪声太大。
/// 按时间而不是按周期数淡出：往返 40 毫秒时 32 个周期就是十秒，开头几条连接一起启动时挤掉的包要记十几秒。
const OVERFLOW_MEMORY_US: u64 = 3_000_000;
/// 一个探测周期大约这么多个最小往返。
const CYCLE_RTTS: u64 = PROBE_CYCLE.len() as u64;
/// 每个周期至少打 31/32 折，最多打对折。
const OVERFLOW_DECAY_MAX: u64 = 32;
const OVERFLOW_DECAY_MIN: u64 = 2;
/// 计数放大这么多倍存，打折时小数不会被舍掉。
const OVERFLOW_SCALE: u64 = 1024;
/// 周期之间的差别比按包独立算的波动大多少，按这个权重平滑（1/16）。突发丢包只落在某几个周期里，
/// 周期之间差得远，标准误跟着放大，不会被当成丢包跟着速率涨。
const OVERFLOW_DISPERSION_SMOOTHING: i64 = 16;
/// 至少比过这么多个周期才下结论。
const OVERFLOW_MIN_CYCLES: u32 = 8;
/// 一个周期里降速和巡航阶段的包至少有这么多个有了结果，这个周期才拿来比。
const OVERFLOW_MIN_CALM_PACKETS: u32 = 4;
const OVERFLOW_MIN_CRUISE_PACKETS: u32 = 16;
/// 丢包跟着速率涨时，补偿每轮收回四分之一；不涨了大约这么久才完全放开。
const COMPENSATION_CUT: u64 = 750;
const COMPENSATION_RESTORE_US: u64 = 3_000_000;
/// 看最近这么多轮的平均送达速率。要盖过排空阶段：排空时发得慢，送达速率本来就低。
const DELIVERY_ROUNDS: usize = 4;
/// 窗口不大时，刚进巡航的那个降速阶段不当低速样本：节奏还按启动时测到的带宽打折，配额或令牌桶刚放行完突发时，
/// 这个“降速”仍远超上限。要等巡航过了这么多轮，送达速率的平均值才能把降速阶段压下来。
/// 窗口大的连接要靠这个阶段尽早测出随机丢包率，不等。
const FIRST_CALM_ROUND: u32 = 2;
/// 最近几轮平均送达速率至少是窗口能送速率的这么多百分比，才算真的被窗口限住。
const WINDOW_DELIVERY_PERCENT: u64 = 85;
/// 加速探测发的包丢得比随机丢包率的两倍还多这么多：队列很浅，加速 25% 每次都把它挤爆，
/// 接下来改成只加 10%。窄带浅队列上这部分丢包占到传输量的 3% 左右，是重传的大头。
const PROBE_EXCESS_LOSS_PPM: u64 = 30_000;
const GENTLE_PROBE_GAIN: u64 = 1100;
/// 发现浅队列后，接下来这么多次探测都只加 10%，之后再按 25% 试一次，路径变了还能发现。
const GENTLE_PROBES: u32 = 8;
/// 一次探测至少要有这么多个包的结果，才拿来判断。
const PROBE_MIN_PACKETS: u64 = 8;
const PROBE_LOSS_RTTS: u64 = 2;
/// 启动刚结束时最近两轮丢包率都低于这个值，才跳过第一个降速阶段。
const SKIP_CALM_MAX_LOSS_PPM: u64 = 100_000;

/// 一个探测周期里降速和巡航阶段发的包：几个有了结果、其中丢了几个。
#[derive(Clone, Copy, Default)]
struct PhaseTally {
    cycle: u32,
    calm_packets: u32,
    calm_losses: u32,
    cruise_packets: u32,
    cruise_losses: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Startup,
    Drain,
    ProbeBw,
    ProbeRtt,
}

pub(crate) struct RateSample {
    pub(crate) delivery_rate: u64,
    pub(crate) rtt_us: u64,
    pub(crate) prior_delivered: u64,
    /// 不是满负荷发送：应用没数据，或者被窗口限住。
    pub(crate) app_limited: bool,
    /// 应用没数据可发。被窗口限住不算，整段丢包时窗口总是满的。
    pub(crate) app_idle: bool,
    /// 这批包从发第一个到发这一个用了多久。到达速率不可能超过发送速率。
    pub(crate) send_span_us: u64,
}

/// 最近几轮平均送达低于这个速率（字节每秒）时，不当作路径上有限速的证据。正常传输远高于它，
/// 低于它的只有断网、换路径时几乎什么都没送到的轮次。
const MIN_LIMITER_EVIDENCE_RATE: u64 = 1_000;

pub(crate) struct Bbr {
    mode: Mode,
    min_cwnd: u64,
    max_cwnd: u64,
    initial_cwnd: u64,
    initial_rate: u64,
    probe_sender_limited: bool,
    low_queue: bool,
    app_idle_estimate: bool,
    bw_samples: [u64; BW_WINDOW_ROUNDS],
    round: usize,
    next_round_delivered: u64,
    /// 这一轮开始时的送达量和这一轮的丢失量，用来认出突发丢包的轮次。
    round_start_delivered: u64,
    round_started_at: u64,
    /// 最近几轮各自的平均送达速率。
    round_rates: [u64; DELIVERY_ROUNDS],
    /// 进入巡航以后过了几轮。
    probe_bw_rounds: u32,
    /// 一共过了几轮，包括应用没数据的轮次。
    round_count: u64,
    /// 最近两轮的丢包率，单位百万分之一。
    round_loss_ppm: [u64; 2],
    /// 加速探测阶段发出的包：丢了几个、一共几个。
    probe_lost: u64,
    probe_total: u64,
    gentle_probes: u32,
    round_lost: u64,
    btl_bw: u64,
    min_rtt_us: u64,
    min_rtt_at: u64,
    full_bw: u64,
    full_bw_rounds: u8,
    filled_pipe: bool,
    cycle_index: usize,
    cycle_started: u64,
    probe_rtt_until: u64,
    next_send_at: u64,
    random_loss_ppm: u32,
    calm_samples: u32,
    calm_losses: u32,
    window_limited: bool,
    /// 这一轮和上一轮有没有包撞上窗口。
    window_hit: bool,
    window_hit_last_round: bool,
    recovering: bool,
    long_outage: bool,
    /// 上次超时或断网以来连续正常的轮数。
    clean_rounds: u32,
    /// 连续丢得比送达还多的轮数。
    outage_rounds: u32,
    round_min_rtt_us: u64,
    round_rtt_samples: u32,
    last_round_min_rtt_us: u64,
    recent_round_rtts: [u64; RECENT_ROUNDS],
    recent_round_index: usize,
    queue_check_rounds: u8,
    queue_check_rtt: u64,
    /// 正在降速，开始时的排队时间。
    calm_watch: bool,
    calm_entry_queue_us: u64,
    /// 上一次降速开始时队列就在排：队列是别的流排的。见 `queue_is_foreign`。
    foreign_queue: bool,
    /// 第几个探测周期，每次进入巡航或开始降速时加一。见 `compare_phases`。
    phase_cycle: u32,
    /// 最近两个周期里降速和巡航阶段发的包的结果。
    phase_tallies: [PhaseTally; 2],
    /// 按周期打折累计的降速和巡航阶段的包数、丢包数，放大 `OVERFLOW_SCALE` 倍。
    compare_calm_packets: u64,
    compare_calm_losses: u64,
    compare_cruise_packets: u64,
    compare_cruise_losses: u64,
    /// 每个周期“巡航丢包率减降速丢包率”偏离平均值的平方，和按包独立算的方差，各自平滑，单位是百万分之一的平方。
    observed_variance: i64,
    expected_variance: i64,
    compared_cycles: u32,
    /// 丢包跟着速率涨：巡航已经超过线路容量。
    overflowing: bool,
    /// 随机丢包的补偿用上几成，千分比。丢包跟着速率涨时逐轮收回，不涨了再慢慢放开。
    compensation: u64,
    /// 让路模式：一个分片的大小，0 表示全速。
    fair_packet: u64,
    fair_cwnd: u64,
    fair_w_max: u64,
    fair_epoch: u64,
    fair_settle_rounds: u8,
    /// 这一轮按后面的包到了才判丢的字节数。超时判的不算：我们的超时比 TCP 短得多，Wi-Fi 卡一下就响，
    /// 速度一低确认变稀，超时响得更多，把超时当拥塞会一路掉到 10 Mbit/s 出不来。
    fair_round_lost: u64,
    rate_limits_found: u64,
    /// 上次想发的时候节奏不让发。
    pacing_behind: bool,
    saturated_rounds: u32,
    /// 限速器的上限，0 表示没有发现限速。
    rate_cap: u64,
    rate_cap_until: u64,
    rate_cap_confirmed: bool,
    rate_cap_raises: u32,
    /// 宽松的上限是第几轮设下的。
    rate_cap_round: u64,
    period_started: u64,
    period_delivered: u64,
    period_lost: u64,
    period_idle: bool,
    /// 这一段里确认中断过好几个往返：断网时的丢包说明不了限速。
    period_outage: bool,
    /// 这一段里有多少个往返、其中多少个往返丢包明显超过随机丢包。
    period_rounds: u32,
    /// 这一段里出现过排队：丢包可能是冲过了普通瓶颈，不能直接当限速。
    period_unsettled: bool,
    /// 这一段有一部分还在启动阶段。
    period_startup: bool,
    period_lossy_rounds: u32,
    last_ack_at: u64,
    period_calm_packets: u32,
    /// 这一段里低速时发的包丢了几个。
    period_calm_lost: u32,
    last_period_rate: u64,
    /// 第一批包的第一个确认到达时的时间和送达量。
    train_start: Option<(u64, u64)>,
    /// 第一个确认回来之前发了多少字节。
    first_flight_sent: u64,
    /// 往返时间的平滑平均。
    rtt_avg_us: u64,
    /// 相邻两个 RTT 样本之差的平滑平均，衡量抖动。
    rtt_jitter_us: u64,
    last_rtt_us: u64,
}

impl Bbr {
    pub(crate) fn new(initial_cwnd: u64, min_cwnd: u64, max_cwnd: u64, initial_rate: Option<u64>, probe_sender_limited: bool) -> Self {
        Self {
            mode: Mode::Startup,
            min_cwnd,
            max_cwnd,
            initial_cwnd,
            initial_rate: initial_rate.unwrap_or(INITIAL_RATE),
            probe_sender_limited,
            low_queue: false,
            app_idle_estimate: false,
            bw_samples: [0; BW_WINDOW_ROUNDS],
            round: 0,
            next_round_delivered: 0,
            round_start_delivered: 0,
            round_started_at: 0,
            round_rates: [0; DELIVERY_ROUNDS],
            probe_bw_rounds: 0,
            round_count: 0,
            round_loss_ppm: [0; 2],
            probe_lost: 0,
            probe_total: 0,
            gentle_probes: 0,
            round_lost: 0,
            btl_bw: 0,
            min_rtt_us: 0,
            min_rtt_at: 0,
            full_bw: 0,
            full_bw_rounds: 0,
            filled_pipe: false,
            cycle_index: 0,
            cycle_started: 0,
            probe_rtt_until: 0,
            next_send_at: 0,
            random_loss_ppm: 0,
            calm_samples: 0,
            calm_losses: 0,
            window_limited: false,
            window_hit: false,
            window_hit_last_round: false,
            recovering: false,
            long_outage: false,
            clean_rounds: 0,
            outage_rounds: 0,
            round_min_rtt_us: u64::MAX,
            round_rtt_samples: 0,
            last_round_min_rtt_us: u64::MAX,
            recent_round_rtts: [u64::MAX; RECENT_ROUNDS],
            recent_round_index: 0,
            queue_check_rounds: 0,
            queue_check_rtt: 0,
            calm_watch: false,
            calm_entry_queue_us: 0,
            foreign_queue: false,
            phase_cycle: 0,
            phase_tallies: [PhaseTally::default(); 2],
            compare_calm_packets: 0,
            compare_calm_losses: 0,
            compare_cruise_packets: 0,
            compare_cruise_losses: 0,
            observed_variance: 0,
            expected_variance: 0,
            compared_cycles: 0,
            overflowing: false,
            compensation: 1000,
            fair_packet: 0,
            fair_cwnd: 0,
            fair_w_max: 0,
            fair_epoch: 0,
            fair_settle_rounds: 0,
            fair_round_lost: 0,
            rate_limits_found: 0,
            pacing_behind: false,
            saturated_rounds: 0,
            rate_cap: 0,
            rate_cap_until: 0,
            rate_cap_confirmed: false,
            rate_cap_raises: 0,
            rate_cap_round: 0,
            period_started: 0,
            period_delivered: 0,
            period_lost: 0,
            period_idle: false,
            period_outage: false,
            period_rounds: 0,
            period_unsettled: false,
            period_startup: false,
            period_lossy_rounds: 0,
            last_ack_at: 0,
            period_calm_packets: 0,
            period_calm_lost: 0,
            last_period_rate: 0,
            train_start: None,
            first_flight_sent: 0,
            rtt_avg_us: 0,
            rtt_jitter_us: 0,
            last_rtt_us: 0,
        }
    }

    /// 送达速率不含丢掉的部分，直接拿来当发送速率会越传越慢：
    /// 丢 30% 时每轮只剩 70%，再怎么探测也追不回来。这里换算回路径真正承载的速率。持续满发时不换算，见 [`SATURATED_ROUNDS`]。
    fn path_rate(&self) -> u64 {
        let random = self.random_loss_ppm.min(MAX_RANDOM_LOSS_PPM) as u64;
        let random = if self.saturated_rounds >= SATURATED_ROUNDS { saturated_compensation(random) } else { random };
        let compensated = random * self.compensation / 1000;
        let kept = 1_000_000 - compensated;
        let rate = self.btl_bw.saturating_mul(1_000_000) / kept;
        if self.rate_cap > 0 { rate.min(self.rate_cap) } else { rate }
    }

    pub(crate) fn rate_cap(&self) -> u64 {
        self.rate_cap
    }

    pub(crate) fn rate_limits_found(&self) -> u64 {
        self.rate_limits_found
    }

    /// 路径一个往返能装下半个窗口以上：这时丢一个包，窗口多半会在重传到达前被占满。
    /// 还在启动阶段。
    pub(crate) fn is_starting(&self) -> bool {
        self.mode == Mode::Startup
    }

    /// 要不要把网络里的队列压低。
    pub(crate) fn set_low_queue(&mut self, active: bool) {
        self.low_queue = active;
    }

    pub(crate) fn window_bound_path(&self) -> bool {
        self.btl_bw > 0 && self.bdp().saturating_mul(2) >= self.max_cwnd
    }

    /// 速度完全卡在窗口上，离路径容量还远，校验包不占数据的位置。
    /// 被窗口限住时测到的带宽就是窗口的速率，所以这里比的是接近窗口，不是超过窗口。
    pub(crate) fn window_is_the_limit(&self) -> bool {
        self.btl_bw > 0 && self.bdp().saturating_mul(10) >= self.max_cwnd.saturating_mul(9)
    }

    /// 已经过了启动阶段，测到的路径速率又明显高过窗口用掉的速率，并且没有排队：
    /// 这时多发的校验包不会挤掉数据。路径速率只比窗口高一点时，瓶颈其实是链路，校验会把数据挤掉。
    pub(crate) fn window_has_room(&self) -> bool {
        self.mode == Mode::ProbeBw
            && self.btl_bw > 0
            && self.bdp().saturating_mul(ROOM_RATIO_DENOMINATOR) >= self.max_cwnd.saturating_mul(ROOM_RATIO_NUMERATOR)
            && !self.queue_is_building()
    }

    /// 巡航周期里当前阶段的增益。发现浅队列以后，加速探测只加 10%。
    fn cycle_gain(&self) -> u64 {
        if self.cycle_index == 0 && self.low_queue {
            LOW_QUEUE_PROBE_GAIN
        } else if self.cycle_index == 0 && self.gentle_probes > 0 {
            GENTLE_PROBE_GAIN
        } else {
            PROBE_CYCLE[self.cycle_index]
        }
    }

    /// 正处在加速探测阶段。
    pub(crate) fn is_probing_up(&self) -> bool {
        self.mode == Mode::ProbeBw && self.cycle_index == 0
    }

    /// 加速探测阶段发出的一个包有了结果。
    pub(crate) fn on_probe_outcome(&mut self, lost: bool) {
        self.probe_total += 1;
        self.probe_lost += lost as u64;
    }

    /// 一共过了几轮。
    pub(crate) fn round_count(&self) -> u64 {
        self.round_count
    }

    /// 被窗口限住、没有限速、一轮里最小的 RTT 也没涨：多发的校验包没有把瓶颈顶出队列。
    pub(crate) fn window_limited_without_queue(&self) -> bool {
        self.mode == Mode::ProbeBw && self.window_limited && self.rate_cap == 0 && !self.queue_rising()
    }

    /// 按平均往返算，路径送达的速率已经装满窗口的九成：卡住速度的确实是窗口。
    /// 抖动大时窗口按平均往返周转，按最小往返算会低估；带宽才是瓶颈的路径到不了这个比例。
    pub(crate) fn window_binds(&self) -> bool {
        self.btl_bw.saturating_mul(self.rtt_avg_us) / 1_000_000 * 10 >= self.max_cwnd * 9
    }

    /// 一轮里最小的 RTT 比最小往返高出往返的十六分之一（至少 0.2 毫秒）：瓶颈开始排队了。
    /// 比 `queue_is_building` 敏感：为抖动多发的校验要在队列刚冒头时就收手。抖动用一轮的最小值滤掉。
    pub(crate) fn queue_rising(&self) -> bool {
        let floor = if self.round_rtt_samples >= ROUND_RTT_SAMPLES { self.round_min_rtt_us } else { self.last_round_min_rtt_us };
        let margin = (self.min_rtt_us / 16).max(200);
        floor != u64::MAX && floor >= self.min_rtt_us + margin
    }

    /// 已经确认撞上限速。这时再多发冗余只会丢得更多。
    pub(crate) fn is_rate_limited(&self) -> bool {
        self.rate_cap > 0 && self.rate_cap_confirmed
    }

    pub(crate) fn pacing_rate_estimate(&self) -> u64 {
        self.pacing_rate()
    }

    /// 判定丢包：`bytes` 是这次丢失的字节数。
    pub(crate) fn on_lost(&mut self, bytes: u64) {
        self.period_lost += bytes;
        self.round_lost += bytes;
    }

    /// 判丢的依据是后面的包到了，不是超时。
    pub(crate) fn on_overtaken(&mut self, bytes: u64) {
        self.fair_round_lost += bytes;
    }

    /// 之前算作丢失的包其实只是来晚了。
    pub(crate) fn undo_lost(&mut self, bytes: u64) {
        self.period_lost = self.period_lost.saturating_sub(bytes);
        self.round_lost = self.round_lost.saturating_sub(bytes);
        self.fair_round_lost = self.fair_round_lost.saturating_sub(bytes);
    }

    /// 每隔一段时间比较总丢包率和低速时的丢包率。丢包随速率上涨，就是撞到了容量。
    ///
    /// 限速器没有队列，RTT 不变，令牌攒够时还能放行远超上限的突发，带宽估计和 RTT 都发现不了。
    /// 但它一定会丢包，而且只在超速时丢。这时一段时间内的实际送达速率就是真实上限，
    /// 不管它是令牌桶、固定配额还是很浅的队列。
    fn sample_period(&mut self, now_us: u64, delivered: u64) {
        // 还没有 RTT 时的超时是按猜的超时时间判的，长往返路径上第一批包全会被误判成丢包，不能拿来判断上限。
        if self.min_rtt_us == 0 {
            return;
        }
        let elapsed = now_us.saturating_sub(self.period_started);
        let period_delivered = delivered.saturating_sub(self.period_delivered);
        let severe = self.period_lost > period_delivered && elapsed >= SEVERE_PERIOD_MIN_US.max(SEVERE_PERIOD_MIN_RTTS * self.min_rtt_us);
        let period = PERIOD_MIN_US.max(PERIOD_MIN_RTTS * self.min_rtt_us);
        if !severe && elapsed < period {
            return;
        }
        if elapsed > PERIOD_STALE_FACTOR * period {
            self.period_started = now_us;
            self.period_delivered = delivered;
            self.period_lost = 0;
            self.period_idle = false;
            self.period_outage = false;
            self.period_rounds = 0;
            self.period_lossy_rounds = 0;
            self.period_unsettled = false;
            self.period_startup = false;
            self.period_calm_packets = 0;
            self.period_calm_lost = 0;
            self.last_period_rate = 0;
            return;
        }
        let lost = core::mem::take(&mut self.period_lost);
        let idle = core::mem::take(&mut self.period_idle) | core::mem::take(&mut self.period_outage);
        let calm_packets = core::mem::take(&mut self.period_calm_packets);
        let calm_lost = core::mem::take(&mut self.period_calm_lost);
        self.period_started = now_us;
        self.period_delivered = delivered;
        let total = period_delivered + lost;
        if total == 0 {
            return;
        }
        let loss_ppm = lost.saturating_mul(1_000_000) / total;
        // 还没测过随机丢包率时，普通的丢包率说明不了什么：随机丢 8% 也会超过门槛。
        // 只有丢得比送达的还多才能下结论，这种丢法随机丢包到不了。
        let unmeasured = self.rate_cap == 0 && !severe && self.calm_samples < PERIOD_MIN_CALM_PACKETS;
        // RTT 涨了说明是普通瓶颈的队列满了，带宽估计本来就管得住。
        let unsettled = core::mem::take(&mut self.period_unsettled);
        let startup = core::mem::take(&mut self.period_startup);
        if unmeasured || idle || self.queue_is_building() || loss_ppm < self.excess_loss_threshold() {
            self.period_rounds = 0;
            self.period_lossy_rounds = 0;
            self.last_period_rate = 0;
            // 宽松的上限是猜的，这一段没撞上就说明猜错了，马上放开，不用等到期。
            if !self.rate_cap_confirmed {
                self.rate_cap = 0;
            }
            return;
        }
        let rate = period_delivered.saturating_mul(1_000_000) / elapsed;
        if rate == 0 {
            return;
        }
        // 只量到一次可能是偶然的突发，只设宽松的上限，判错了最多让速度减半、持续两秒。
        // 连续两段速率一致才收紧到实测值。
        // 丢得远超随机丢包、并且大半个往返都在丢：这是一直卡着的上限，不是一阵突发，不用再等一段确认。
        let lossy_rounds = core::mem::take(&mut self.period_lossy_rounds);
        let rounds = core::mem::take(&mut self.period_rounds);
        let sustained = rounds >= SUSTAINED_MIN_ROUNDS && lossy_rounds.saturating_mul(2) >= rounds;
        // 低速发的包也丢得差不多多，说明丢包不随速率变化：是一阵突发或断网，不是上限。
        let rate_dependent = (calm_lost as u64).saturating_mul(1_000_000) <= loss_ppm.saturating_mul(calm_packets as u64) / 2;
        // 启动阶段还在往上爬，整段平均的送达速率偏低，不能直接当上限；丢得比送达还多时才例外：那是冲过了上限。
        let strong = sustained && !unsettled && rate_dependent && (severe || !startup) && loss_ppm >= self.excess_loss_threshold().saturating_mul(2).max(STRONG_EXCESS_LOSS_PPM);
        let confirmed = calm_packets >= PERIOD_MIN_CALM_PACKETS && (strong || self.last_period_rate.abs_diff(rate) <= self.last_period_rate / 8);
        self.last_period_rate = rate;
        self.rate_cap_raises = 0;
        self.rate_cap_confirmed = confirmed;
        if !confirmed {
            self.rate_cap = (rate + rate / 2).max(self.btl_bw / 2);
            self.rate_cap_round = self.round_count;
            // 只守到下一段结束：还在丢就会重新设上，判错了也只影响这一段。
            self.rate_cap_until = now_us + elapsed + elapsed / 4;
            return;
        }
        self.rate_cap = rate;
        self.rate_limits_found += 1;
        self.rate_cap_until = now_us + CAP_CONFIRMED_HOLD_US;
        // 量准了才退出启动：退出时带宽估计过低的话，高延迟链路要爬很久才回得来。
        if self.mode == Mode::Startup {
            self.filled_pipe = true;
            self.mode = Mode::Drain;
        }
        // 窗口里的速率样本是放行阶段测的，留着的话带宽估计还会高出上限好几倍。
        self.bw_samples = [0; BW_WINDOW_ROUNDS];
        self.bw_samples[self.round % BW_WINDOW_ROUNDS] = rate;
        self.btl_bw = rate;
    }

    /// 宽松的上限设下以后丢包率回到了正常水平，说明刚才是突发丢包而不是限速：限速器只要超速就一定丢包。
    /// 不用等这一段结束，否则每次突发丢包都要按半速多跑一秒。不能要求一个包都不丢：随机丢包的路径上永远等不到。
    fn release_unconfirmed_cap(&mut self, now_us: u64, delivered: u64) {
        if self.rate_cap == 0 || self.rate_cap_confirmed {
            return;
        }
        // 最近两轮都不丢了，送达速率还顶到了这个上限：路径上的上限比它高，刚才只是一阵突发，不用等这一段结束。
        let reached = self.round_rates[..2].iter().all(|&rate| rate.saturating_mul(10) >= self.rate_cap.saturating_mul(9));
        if reached && self.round_count >= self.rate_cap_round + CAP_RELEASE_ROUNDS && self.round_loss_ppm.iter().all(|&loss| loss < self.excess_loss_threshold()) {
            self.rate_cap = 0;
            return;
        }
        let quiet = now_us.saturating_sub(self.period_started) >= SEVERE_PERIOD_MIN_US.max(SEVERE_PERIOD_MIN_RTTS * self.min_rtt_us);
        if !quiet {
            return;
        }
        let total = delivered.saturating_sub(self.period_delivered) + self.period_lost;
        if self.period_lost.saturating_mul(1_000_000) < self.excess_loss_threshold().saturating_mul(total) {
            self.rate_cap = 0;
        }
    }

    fn relax_rate_cap(&mut self, now_us: u64) {
        if self.rate_cap == 0 || now_us < self.rate_cap_until {
            return;
        }
        self.rate_cap_raises += 1;
        if !self.rate_cap_confirmed || self.rate_cap_raises > CAP_MAX_RAISES {
            self.rate_cap = 0;
            return;
        }
        self.rate_cap += self.rate_cap / 8;
        self.rate_cap_until = now_us + CAP_CONFIRMED_HOLD_US;
    }

    fn bdp(&self) -> u64 {
        self.path_rate().saturating_mul(self.base_rtt()) / 1_000_000
    }

    /// 判断在排队时会主动降速，自己排的队这样几轮就排空了。往返时间不降，就是路径本身变慢了，继续降速只会越降越低。
    fn check_queue_is_ours(&mut self) {
        let floor = self.last_round_min_rtt_us;
        if !self.low_queue || floor == u64::MAX || !self.queue_is_building() {
            self.queue_check_rounds = 0;
            return;
        }
        if self.queue_check_rounds == 0 {
            self.queue_check_rtt = floor;
        }
        self.queue_check_rounds += 1;
        if self.queue_check_rounds >= QUEUE_CHECK_ROUNDS {
            self.queue_check_rounds = 0;
            if floor.saturating_mul(32) >= self.queue_check_rtt.saturating_mul(31) {
                self.recent_round_rtts = [floor; RECENT_ROUNDS];
            }
        }
    }

    /// 没有排队时的往返时间。真实路径的往返时间会整体漂移，窗口里偶尔碰到一次的最低值代表不了现在的路径。
    /// 压低队列时拿它当基准的话，平常的往返时间就成了排队，只能一路降速，在途量也装不满路径，带宽估计越降越低。
    fn base_rtt(&self) -> u64 {
        if !self.low_queue {
            return self.min_rtt_us;
        }
        let recent = self.recent_round_rtts.iter().copied().min().unwrap_or(u64::MAX);
        if recent == u64::MAX { self.min_rtt_us } else { recent.max(self.min_rtt_us) }
    }

    /// 正在主动降速，现在发出去的包不可能挤爆瓶颈。这种包丢了只能是随机丢包，
    /// 瓶颈溢出造成的丢包不会混进来，所以队列再小、遇到限速器也不会把拥塞当成随机丢包越补越快。
    /// 被窗口限住不算：窗口对应的速率完全可能高过限速。
    pub(crate) fn is_below_capacity(&self) -> bool {
        self.mode == Mode::ProbeBw && PROBE_CYCLE[self.cycle_index] < 1000
    }

    /// 速度卡在窗口上、路径还有余量，并且最近真的按接近窗口的速率送到了：这时不管处在哪个阶段，
    /// 发出去的包都低于路径容量，丢了只能是随机丢包，用不着专门降速去测。
    /// 送达速率明显低于窗口能送的速率时不算：那说明路径上另有更低的上限（比如令牌桶），带宽估计是被突发抬高的。
    /// 只看进入巡航以后的轮次：启动时令牌桶放行的突发能让送达速率短时间远超上限。
    fn window_bound_with_room(&self) -> bool {
        let recent = self.round_rates.iter().sum::<u64>() / DELIVERY_ROUNDS as u64;
        let window_rate = self.max_cwnd.saturating_mul(1_000_000) / self.min_rtt_us.max(1);
        self.mode == Mode::ProbeBw
            && self.window_limited
            && self.rate_cap == 0
            && self.window_has_room()
            && self.probe_bw_rounds as usize > DELIVERY_ROUNDS
            && recent.saturating_mul(100) >= window_rate.saturating_mul(WINDOW_DELIVERY_PERCENT)
    }

    /// 这时发的包可以当低速样本，用来估计随机丢包率。
    pub(crate) fn sends_below_capacity(&self) -> bool {
        (self.is_below_capacity() && (self.probe_bw_rounds >= FIRST_CALM_ROUND || !self.small_window())) || self.window_bound_with_room()
    }

    /// 被窗口限住、随机丢包率的样本已经攒够、也没有撞上过容量的降速阶段。
    fn settled_window_limited(&self) -> bool {
        self.mode == Mode::ProbeBw
            && self.window_limited
            && self.is_below_capacity()
            && self.rate_cap == 0
            && self.last_period_rate == 0
            && self.calm_samples >= CALM_SAMPLE_WINDOW / 2
    }

    /// 宽松的上限还没确认时，降速阶段按的是放大过的上限，仍可能高过真实限速，
    /// 这时的丢包混着限速造成的丢包，不能用来估计随机丢包率。令牌桶上能把估计值推到 76%。
    /// 要在发送时判断：结果要晚一个往返才知道，那时上限可能刚好确认，按那时算会把限速丢包全收进来。
    ///
    /// 瓶颈在排队时也不算：队列可能是别的流排的，我们降速也挡不住丢包。这种丢包当成随机丢包的话，
    /// 大家都按丢包率多发，发得越多丢得越多，几条流一起就是拥塞崩溃。
    /// 压低队列时除外：那时的基准往返时间取最近几轮，抖动一点就算排队，样本攒不够，真正的随机丢包率测不出来。
    /// 队列浅到往返时间看不出来、但丢包跟着速率涨时同样不算，见 [`Self::compare_phases`]。
    /// 降速时还有比排队判断浅的队列在排，也是别人的，不算，见 [`Self::queue_is_foreign`]。
    pub(crate) fn trusts_calm_samples(&self) -> bool {
        self.fair_packet == 0
            && (self.rate_cap == 0 || self.rate_cap_confirmed)
            && (self.low_queue || !self.queue_is_building())
            && !self.overflowing
            && !self.queue_is_foreign()
    }

    /// 正在巡航，按带宽估计全速发。
    pub(crate) fn is_cruising(&self) -> bool {
        self.mode == Mode::ProbeBw && PROBE_CYCLE[self.cycle_index] == 1000 && !self.sends_below_capacity()
    }

    /// 当前是第几个探测周期。发包时记下来，结果回来时按周期配对比较。
    pub(crate) fn phase_cycle(&self) -> u32 {
        self.phase_cycle
    }

    /// 第 `cycle` 个周期的降速（`calm`）或巡航阶段发出的一个包有了结果。
    pub(crate) fn on_phase_outcome(&mut self, cycle: u32, calm: bool, lost: bool) {
        let Some(tally) = self.phase_tally(cycle) else { return };
        if calm {
            tally.calm_packets += 1;
            tally.calm_losses += lost as u32;
        } else {
            tally.cruise_packets += 1;
            tally.cruise_losses += lost as u32;
        }
    }

    /// 之前算作丢失的包其实只是来晚了。那个周期已经比完了就不管：差一个包改变不了结论。
    pub(crate) fn undo_phase_loss(&mut self, cycle: u32, calm: bool) {
        if let Some(tally) = self.phase_tallies.iter_mut().find(|tally| tally.cycle == cycle) {
            if calm {
                tally.calm_losses = tally.calm_losses.saturating_sub(1);
            } else {
                tally.cruise_losses = tally.cruise_losses.saturating_sub(1);
            }
        }
    }

    /// 这个周期的计数。比手上两个周期都新时，旧的那个周期的结果都回来了，拿去比，空出来给它；
    /// 比两个都旧就是隔了一整个周期才判出来的结果，不要了。
    fn phase_tally(&mut self, cycle: u32) -> Option<&mut PhaseTally> {
        if let Some(index) = self.phase_tallies.iter().position(|tally| tally.cycle == cycle) {
            return Some(&mut self.phase_tallies[index]);
        }
        let oldest = if self.phase_tallies[0].cycle <= self.phase_tallies[1].cycle { 0 } else { 1 };
        if cycle < self.phase_tallies[oldest].cycle {
            return None;
        }
        let finished = core::mem::replace(&mut self.phase_tallies[oldest], PhaseTally { cycle, ..PhaseTally::default() });
        self.compare_phases(finished);
        Some(&mut self.phase_tallies[oldest])
    }

    /// 比一个周期里巡航和降速的丢包率，更新“丢包是不是跟着速率涨”的判断。
    ///
    /// 队列浅到排满了往返时间也涨不过判断余量时，靠往返时间认不出排队，被挤掉的包就会被当成随机丢包。
    /// 几条连接一起这样，各自按估高的丢包率多发，多发的部分又被挤掉，估多少就丢多少，能一直维持下去。
    /// 随机丢包和速率无关，降速时也一样丢；挤掉的包跟着速率走，巡航比降速多发三分之一，就多丢一截。
    /// 一个周期的降速和巡航碰上的是同一段路况，按周期累计，只拿同时有两个阶段结果的周期比。
    fn compare_phases(&mut self, tally: PhaseTally) {
        if tally.calm_packets < OVERFLOW_MIN_CALM_PACKETS || tally.cruise_packets < OVERFLOW_MIN_CRUISE_PACKETS {
            return;
        }
        let divisor = (OVERFLOW_MEMORY_US / (CYCLE_RTTS * self.min_rtt_us).max(1)).clamp(OVERFLOW_DECAY_MIN, OVERFLOW_DECAY_MAX);
        let decay = |value: u64| value - value / divisor;
        self.compare_calm_packets = decay(self.compare_calm_packets) + tally.calm_packets as u64 * OVERFLOW_SCALE;
        self.compare_calm_losses = decay(self.compare_calm_losses) + tally.calm_losses as u64 * OVERFLOW_SCALE;
        self.compare_cruise_packets = decay(self.compare_cruise_packets) + tally.cruise_packets as u64 * OVERFLOW_SCALE;
        self.compare_cruise_losses = decay(self.compare_cruise_losses) + tally.cruise_losses as u64 * OVERFLOW_SCALE;
        let rate = |losses: u64, packets: u64| (losses * 1_000_000 / packets.max(1)) as i64;
        let excess = rate(self.compare_cruise_losses, self.compare_cruise_packets) - rate(self.compare_calm_losses, self.compare_calm_packets);
        let pooled = rate(self.compare_calm_losses + self.compare_cruise_losses, self.compare_calm_packets + self.compare_cruise_packets);
        let spread = pooled * (1_000_000 - pooled.min(1_000_000));
        // 这个周期自己的差别偏离平均值多少，和每个包各自独立丢的话该偏多少。
        let cycle_excess = rate(tally.cruise_losses as u64, tally.cruise_packets as u64) - rate(tally.calm_losses as u64, tally.calm_packets as u64);
        let cycle_expected = spread / tally.calm_packets as i64 + spread / tally.cruise_packets as i64;
        let deviation = cycle_excess - excess;
        if self.compared_cycles == 0 {
            self.observed_variance = cycle_expected;
            self.expected_variance = cycle_expected;
        } else {
            self.observed_variance += (deviation * deviation - self.observed_variance) / OVERFLOW_DISPERSION_SMOOTHING;
            self.expected_variance += (cycle_expected - self.expected_variance) / OVERFLOW_DISPERSION_SMOOTHING;
        }
        self.compared_cycles = self.compared_cycles.saturating_add(1);
        // 累计计数按包独立算的方差，乘上实际比独立时大几倍（至少 1 倍）。
        let independent = spread * OVERFLOW_SCALE as i64 / self.compare_calm_packets.max(1) as i64 + spread * OVERFLOW_SCALE as i64 / self.compare_cruise_packets.max(1) as i64;
        let dispersion = (self.observed_variance.saturating_mul(1000) / self.expected_variance.max(1)).max(1000);
        let standard_error = isqrt((independent / 1000).saturating_mul(dispersion).max(0) as u64) as i64;
        self.overflowing = self.compared_cycles >= OVERFLOW_MIN_CYCLES && excess > OVERFLOW_EXCESS_PPM + 2 * standard_error;
    }

    /// `trusted` 是发送时 [`Self::trusts_calm_samples`] 的结果。
    /// `foreign` 是发送时 [`Self::queue_is_foreign`] 的结果。
    pub(crate) fn on_calm_outcome(&mut self, lost: bool, trusted: bool, foreign: bool) {
        self.period_calm_packets = self.period_calm_packets.saturating_add(1);
        self.period_calm_lost = self.period_calm_lost.saturating_add(lost as u32);
        // 别的流排的队列里丢的包分不清是随机丢的还是被挤掉的，不算；送到了的包说明随机丢包没那么多，照样算。
        // 否则几条流一起启动时估高的随机丢包率，在队列一直满着时修正不了，大家按它多发，队列就一直满着。
        // 自己排的队不这样算：那时只算送达会把随机丢包率压低，有随机丢包的深队列线路上补得不够。
        if !trusted && !(foreign && !lost) {
            return;
        }
        self.calm_samples += 1;
        self.calm_losses += lost as u32;
        if self.calm_samples >= CALM_SAMPLE_WINDOW {
            self.calm_samples /= 2;
            self.calm_losses /= 2;
        }
        self.update_random_loss();
    }

    /// 之前算作丢失的包其实只是来晚了。只对当初算进去的包调用。
    pub(crate) fn undo_calm_loss(&mut self) {
        self.calm_losses = self.calm_losses.saturating_sub(1);
        self.update_random_loss();
    }

    /// 丢包跟着速率涨时随机丢包率正在去掉被挤掉的包，可能低过真实值，拿它当门槛会把随机丢包当成撞上限速。
    /// 这时门槛至少按降速阶段实际的丢包率算：限速器上降速时几乎不丢，门槛不变；共享瓶颈上降速时照样有随机丢包。
    fn excess_loss_threshold(&self) -> u64 {
        let calm = self.compare_calm_losses * 1_000_000 / self.compare_calm_packets.max(1);
        let p = if self.overflowing { (self.random_loss_ppm as u64).max(calm) } else { self.random_loss_ppm as u64 };
        let samples = self.calm_samples.max(1) as u64;
        let standard_error = isqrt(p * (1_000_000 - p.min(1_000_000)) / samples);
        p + p / 4 + EXCESS_LOSS_PPM + 2 * standard_error
    }

    fn update_random_loss(&mut self) {
        let samples = self.calm_samples.max(CALM_SAMPLE_FLOOR) as u64;
        self.random_loss_ppm = (self.calm_losses as u64 * 1_000_000 / samples) as u32;
    }

    /// 打开让路模式。`packet_bytes` 是一个分片的大小。
    pub(crate) fn set_fair_share(&mut self, packet_bytes: u64) {
        self.fair_packet = packet_bytes.max(FAIR_UNIT_BYTES);
    }

    /// 换了路径：量到的带宽、往返、排队和限速都不再适用，从启动阶段重新量。连接定下的设置和计数保留。
    pub(crate) fn restart(&mut self) {
        let mut fresh = Self::new(self.initial_cwnd, self.min_cwnd, self.max_cwnd, Some(self.initial_rate), self.probe_sender_limited);
        fresh.fair_packet = self.fair_packet;
        fresh.low_queue = self.low_queue;
        fresh.rate_limits_found = self.rate_limits_found;
        *self = fresh;
    }

    /// 让路模式每轮算一次窗口。第一次丢包才接管：没见过丢包就没和别人抢，线路卡一下启动就结束了，这时量到的容量还差得远。
    fn update_fair_window(&mut self, now_us: u64, bytes_in_flight: u64, app_limited: bool) {
        if self.fair_packet == 0 {
            return;
        }
        let floor = self.fair_packet * FAIR_MIN_PACKETS;
        if self.fair_cwnd == 0 {
            if self.fair_round_lost == 0 {
                return;
            }
            // 按测到的线路容量接手。按在途量接手再逐轮减的话，启动冲过头丢的包连着查出来好几轮，窗口减到容量的三分之一，
            // 要爬十几秒才回来。曲线的目标还是出事时的在途量：启动中途碰上丢包时容量还没量准，拿它当目标就爬不回去了。
            // 容量最多落后一轮，也就是两倍；限速器放过的突发会让在途量远不止这个数，不能算数。
            self.fair_cwnd = self.bdp().max(floor);
            self.fair_w_max = bytes_in_flight.clamp(self.fair_cwnd, self.fair_cwnd.saturating_mul(2));
            self.fair_epoch = now_us;
            self.fair_settle_rounds = FAIR_SETTLE_ROUNDS;
            return;
        }
        if self.fair_settle_rounds > 0 {
            self.fair_settle_rounds -= 1;
            return;
        }
        // 有丢包的轮次都减，比 TCP 一次拥塞只减一次狠：只减一次的话单独跑快一些，但和 TCP 分不平。
        if self.fair_round_lost > 0 {
            self.fair_w_max = self.fair_cwnd;
            self.fair_cwnd = (self.fair_cwnd.saturating_mul(FAIR_BETA) / 1000).max(floor);
            self.fair_epoch = now_us;
        } else if !app_limited {
            let w_max = self.fair_w_max / self.fair_packet;
            let k_ms = icbrt(w_max.saturating_mul(FAIR_K_FACTOR)) as i128;
            let elapsed_ms = (now_us.saturating_sub(self.fair_epoch) / 1000) as i128;
            let offset = elapsed_ms - k_ms;
            let target = (w_max as i128 + offset * offset * offset * 4 / 10_000_000_000).max(0) as u64;
            // 三次方曲线在小窗口上太慢，保底按 RFC 8312 的 3(1-β)/(1+β) 一个往返涨 0.53 个包。窗口不到几十个包时再慢些：
            // TCP 这时一丢包就超时，成串发的包在限速器上又比我们匀速发的丢得多，涨快了就把它挤没了。
            let steady = self.fair_cwnd + (self.fair_packet * 53 / 100).min(self.fair_cwnd / FAIR_SMALL_WINDOW_DIVISOR);
            self.fair_cwnd = target.saturating_mul(self.fair_packet).clamp(steady, steady.max(self.fair_cwnd.saturating_mul(3) / 2)).min(self.max_cwnd);
        }
    }

    pub(crate) fn cwnd(&self) -> u64 {
        if self.recovering {
            // 长时间断网只发少量探测省流量；短中断可能只是确认方向断了，数据照样能到，不能把新消息全卡住。
            return if self.long_outage {
                self.min_cwnd / 2
            } else {
                self.min_cwnd.saturating_mul(SHORT_OUTAGE_CWND_FACTOR).min(self.max_cwnd)
            };
        }
        if self.btl_bw == 0 {
            return if self.probe_sender_limited { self.max_cwnd } else { self.initial_cwnd };
        }
        if self.fair_cwnd > 0 {
            return self.fair_cwnd.min(self.max_cwnd);
        }
        if self.mode == Mode::ProbeRtt {
            return (self.bdp() / 2).max(self.min_cwnd / 4);
        }
        let gain = if self.mode == Mode::Startup {
            self.startup_gain()
        } else if self.low_queue {
            LOW_QUEUE_CWND_GAIN
        } else {
            CWND_GAIN
        };
        // 窗口接近路径容量时不放宽：这时多出来的包会直接挤进瓶颈队列。
        let spare_window = self.window_limited
            && self.mode == Mode::ProbeBw
            && self.window_is_the_limit()
            && self.clean_rounds >= SPARE_WINDOW_CLEAN_ROUNDS;
        let cap = if spare_window { self.max_cwnd.saturating_mul(WINDOW_LIMITED_CWND_CAP) / 1000 } else { self.max_cwnd };
        (self.bdp().saturating_mul(gain) / 1000).clamp(self.min_cwnd, cap)
    }

    fn pacing_rate(&self) -> u64 {
        if self.btl_bw == 0 {
            return if self.first_flight_sent < self.initial_cwnd || !self.probe_sender_limited { self.initial_rate.max(FIRST_FLIGHT_RATE) } else { FIRST_FLIGHT_TRICKLE_RATE };
        }
        let gain = match self.mode {
            Mode::Startup => return self.startup_rate(),
            Mode::Drain => DRAIN_GAIN,
            Mode::ProbeBw if PROBE_CYCLE[self.cycle_index] == 1000 && self.queue_is_building() => QUEUE_DRAIN_GAIN,
            Mode::ProbeBw if PROBE_CYCLE[self.cycle_index] == 1000 && self.low_queue => LOW_QUEUE_CRUISE_GAIN,
            Mode::ProbeBw if PROBE_CYCLE[self.cycle_index] == 1000 && self.gentle_probes > 0 => HEADROOM_CRUISE_GAIN,
            // 被窗口限住时瓶颈没有队列，这一轮只是要测随机丢包率，低于送达速率就够了，不用多降。
            // 窗口对应的速率可能高过限速，所以要等样本攒够、确认过没有撞上容量。
            // 窗口限住、路径有余量时任何阶段都低于容量，降速阶段照常按窗口发，不用白白慢下来。
            Mode::ProbeBw if self.is_below_capacity() && self.window_bound_with_room() => 1000,
            Mode::ProbeBw if self.settled_window_limited() => {
                WINDOW_LIMITED_CALM_GAIN
            }
            Mode::ProbeBw => self.cycle_gain(),
            Mode::ProbeRtt => 1000,
        };
        // 降速阶段不能被抬上去：这段时间的丢包要用来判断是不是随机丢包。
        // 排空阶段也不能：抬上去在途量就降不到一个 BDP，连接一直出不了排空，随机丢包率永远测不到。
        let boost = self.window_limited && self.mode != Mode::Drain && (!self.is_below_capacity() || self.window_bound_with_room());
        let room_gain = if self.window_bound_with_room() { WINDOW_ROOM_GAIN } else { WINDOW_LIMITED_GAIN };
        let gain = if boost { gain.max(room_gain) } else { gain };
        let rate = (self.path_rate().saturating_mul(gain) / 1000).max(1);
        // 已经确认限速时，任何增益都不能把节奏抬过上限：多出来的包只会被限速器丢掉。
        // 只量到一次的宽松上限可能是突发丢包造成的，不在这里强压。
        // 想知道上限有没有放宽，由 relax_rate_cap 定期放开一档去试。
        let rate = if self.is_rate_limited() { rate.min(self.rate_cap) } else { rate };
        // 降速阶段要真的低于路径送得出去的速率，这段的丢包才能当随机丢包。令牌桶放行突发时测到的带宽能高出上限好几倍，
        // 按它打折的“降速”仍远超上限，限速丢包混进随机丢包率；估计值一高，补偿后发得更快，越滚越高，再也认不出上限。
        // 最近几轮的平均送达速率既远低于带宽估计、又远低于窗口能送的速率，说明卡住送达的是路径上的上限，
        // 这时降速阶段按实际送达速率打折，才真的低于上限。取平均：攒够令牌时能放行短突发，单看最快的一轮会偏高。
        // 稀疏消息测到的只是应用发送速度，按它打折的话断网积压要等很久，这时只压到带宽估计的一半。
        // 窗口受限的长往返路径上，启动测到的速率常比窗口能送的高好几倍，那不是限速，不压；
        // 随机丢包率已经测稳的窗口受限阶段也不压，那时降速只比窗口速率低一点，再压就白白慢了。
        let recent = self.round_rates.iter().sum::<u64>() / DELIVERY_ROUNDS as u64;
        let window_rate = self.max_cwnd.saturating_mul(1_000_000) / self.min_rtt_us.max(1);
        // 断网、换路径时有几轮几乎什么都没送到，平均只有每秒几个字节，那不是限速的证据：按它打折，节奏会被压成 0。
        let limited_elsewhere = recent >= MIN_LIMITER_EVIDENCE_RATE && recent < self.btl_bw / 2 && recent < window_rate / 2;
        let delivering = match (limited_elsewhere, self.app_idle_estimate) {
            (false, _) => u64::MAX,
            (true, true) => self.btl_bw / 2,
            (true, false) => recent * 3 / 4,
        };
        let rate = if self.is_below_capacity() && recent > 0 && !self.settled_window_limited() { rate.min(delivering) } else { rate };
        // 稀疏消息测到的是应用发送速度，不能把它当作恢复积压时的路径上限。
        // 仍受拥塞窗口限制；主动降速、排空、排队或已知限速时都不抬高，避免污染低速丢包样本。
        if self.probe_sender_limited && self.app_idle_estimate && self.rate_cap == 0
            && self.mode != Mode::Drain && self.mode != Mode::ProbeRtt && !self.is_below_capacity() && !self.queue_is_building()
        {
            rate.max(self.initial_rate.min(self.initial_cwnd.saturating_mul(1_000_000) / self.min_rtt_us.max(1)))
        } else {
            rate
        }
    }

    pub(crate) fn bandwidth_estimate(&self) -> u64 {
        self.btl_bw
    }

    pub(crate) fn random_loss_ppm(&self) -> u32 {
        self.random_loss_ppm
    }

    /// 相邻两个 RTT 样本之差的平滑平均。均匀抖动下约是抖动幅度的三分之一。
    pub(crate) fn rtt_jitter_us(&self) -> u64 {
        self.rtt_jitter_us
    }

    pub(crate) fn min_rtt_us(&self) -> u64 {
        self.min_rtt_us
    }

    /// 启动时至少按“每个往返发完初始窗口”的速度走。低延迟链路上第一批确认很快回来，
    /// 这时送达速率还没测准，只看它的话，2 毫秒的链路要爬十几个往返。
    fn startup_rate(&self) -> u64 {
        let gain = self.startup_gain();
        let measured = self.path_rate().saturating_mul(gain) / 1000;
        let floor = self.initial_cwnd.saturating_mul(1_000_000).saturating_mul(gain) / 1000 / self.min_rtt_us.max(1);
        let rate = measured.max(floor);
        // 包列的确认间隔被自身发送节奏限制时，只能量到路径速率的下界。
        // 仅在已经测得足够大的 BDP、没有排队时增加探测余量；仍受窗口与限速上限约束。
        let sender_limited = self.probe_sender_limited && self.btl_bw >= self.initial_rate * 9 / 10
            && self.bdp() >= self.initial_cwnd.saturating_mul(TRAIN_BDP_RATIO) && !self.queue_is_building();
        let rate = if sender_limited { rate.max(self.initial_rate.saturating_mul(TRAIN_PACING_HEADROOM)) } else { rate };
        if self.rate_cap > 0 { rate.min(self.rate_cap) } else { rate }
    }

    fn startup_gain(&self) -> u64 {
        if self.low_queue { LOW_QUEUE_STARTUP_GAIN } else { STARTUP_GAIN }
    }

    pub(crate) fn can_send(&mut self, now_us: u64) -> bool {
        let ready = self.next_send_at <= now_us + PACING_QUANTUM_US;
        self.pacing_behind |= !ready;
        ready
    }

    /// 这段时间不是在等节奏：没数据可发或者拥塞窗口满了。不算迟到，补回来就成了突发。
    pub(crate) fn stop_pacing_catch_up(&mut self) {
        self.pacing_behind = false;
    }

    pub(crate) fn next_send_wake(&self) -> u64 {
        self.next_send_at.saturating_sub(PACING_QUANTUM_US)
    }

    pub(crate) fn on_sent(&mut self, now_us: u64, bytes: u64) {
        // 统计段从第一次发送算起。连接建好后先空闲一阵（应用还没写）的话，空闲时间算进第一段，
        // 送达速率偏低，开头的丢包会被当成撞到了一个很低的限速。
        if self.btl_bw == 0 && self.first_flight_sent == 0 {
            self.period_started = now_us;
        }
        let trickle_starts = self.btl_bw == 0 && self.first_flight_sent < self.initial_cwnd && self.first_flight_sent + bytes >= self.initial_cwnd;
        if self.btl_bw == 0 {
            self.first_flight_sent += bytes;
        }
        if trickle_starts {
            self.next_send_at = now_us + FIRST_FLIGHT_TRICKLE_DELAY_US;
            return;
        }
        let interval = bytes.saturating_mul(1_000_000) / self.pacing_rate();
        // 定时器总会晚一点。迟到的时间作废的话，每次醒来只能发一个包，速度锁死在“一个包除以定时器精度”，
        // 带宽估计跟着掉下去：4 毫秒的定时器上 40 Mbit/s 的路径只跑 2.8。在等节奏时迟到的时间要补回来。
        // 压低队列时巡航本来就低于带宽，等确认耽误的节奏也补一点，不然实际发得更低，交互消息赶上线路空闲的机会反而少。
        let earliest = if self.pacing_behind {
            now_us.saturating_sub(PACING_CATCH_UP_US)
        } else if self.low_queue {
            now_us.saturating_sub(interval * LOW_QUEUE_CATCH_UP_PACKETS)
        } else {
            now_us
        };
        self.next_send_at = self.next_send_at.max(earliest) + interval;
    }

    pub(crate) fn on_ack(&mut self, now_us: u64, sample: &RateSample, delivered: u64, bytes_in_flight: u64) {
        self.recovering = false;
        // 第一个确认到了，慢慢发的节奏作废，不用等那个包的间隔。
        if self.btl_bw == 0 {
            self.next_send_at = self.next_send_at.min(now_us);
        }
        if sample.delivery_rate >= self.btl_bw {
            self.app_idle_estimate = sample.app_idle;
        }
        self.period_idle |= sample.app_idle;
        self.period_unsettled |= self.queue_is_building();
        self.period_startup |= self.mode == Mode::Startup;
        // 限速器每个往返总会放行一部分，确认不会整段中断；中断好几个往返只能是断网。
        let silence = now_us.saturating_sub(self.last_ack_at);
        if self.last_ack_at > 0
            && self.min_rtt_us > 0
            && silence > (OUTAGE_SILENCE_RTTS * self.min_rtt_us).max(OUTAGE_SILENCE_MIN_US)
        {
            self.period_outage = true;
        }
        self.last_ack_at = now_us;
        let delivery_rate = sample.delivery_rate.max(self.train_rate(now_us, sample, delivered));
        self.sample_period(now_us, delivered);
        self.release_unconfirmed_cap(now_us, delivered);
        self.relax_rate_cap(now_us);
        let round_start = sample.prior_delivered >= self.next_round_delivered;
        // 一个包都没撞上窗口时，在途量可能只差一点。逐个确认判断的话，加速时断时续，在途量上不去，
        // 测到的带宽也跟着上不去。按两轮算：只有窗口末尾的包才会撞上窗口，每轮至少有一个。
        self.window_hit |= sample.app_limited && !sample.app_idle;
        // 只有在途量确实接近窗口才算被窗口限住。瓶颈远小于窗口时，窗口用满只是在等重传，
        // 这时加速只会把小队列挤爆。
        self.window_limited = (self.window_hit || self.window_hit_last_round) && self.bdp().saturating_mul(2) >= self.max_cwnd;
        if round_start {
            self.window_hit_last_round = core::mem::take(&mut self.window_hit);
            // 丢得比送达的还多的一轮是突发丢包或断网，这时测到的速率不代表路径能力。
            // 让它老化掉旧样本的话，半秒的突发就能把带宽估计压到十分之一，之后要爬好几秒。
            let round_delivered = delivered.saturating_sub(self.round_start_delivered);
            let outage = self.round_lost > round_delivered;
            let round_total = round_delivered + self.round_lost;
            if round_total > 0 {
                self.period_rounds = self.period_rounds.saturating_add(1);
                if self.round_lost.saturating_mul(1_000_000) >= self.excess_loss_threshold().saturating_mul(round_total) {
                    self.period_lossy_rounds = self.period_lossy_rounds.saturating_add(1);
                }
            }
            self.clean_rounds = if outage { 0 } else { self.clean_rounds.saturating_add(1) };
            self.outage_rounds = if outage { self.outage_rounds.saturating_add(1) } else { 0 };
            let round_elapsed = now_us.saturating_sub(self.round_started_at);
            if self.round_started_at > 0 && round_elapsed > 0 {
                self.round_loss_ppm = [if round_total > 0 { self.round_lost.saturating_mul(1_000_000) / round_total } else { 0 }, self.round_loss_ppm[0]];
                self.probe_bw_rounds = if self.mode == Mode::ProbeBw { self.probe_bw_rounds.saturating_add(1) } else { 0 };
                self.round_rates.rotate_right(1);
                self.round_count += 1;
                self.round_rates[0] = round_delivered.saturating_mul(1_000_000) / round_elapsed;
                self.update_fair_window(now_us, bytes_in_flight, sample.app_limited);
            }
            self.round_started_at = now_us;
            self.next_round_delivered = delivered;
            self.round_start_delivered = delivered;
            self.round_lost = 0;
            self.fair_round_lost = 0;
            // 空闲或被对端窗口卡住时也不老化：否则停一会儿，旧的带宽估计就被挤掉了。
            self.saturated_rounds = if sample.app_limited { 0 } else { self.saturated_rounds.saturating_add(1) };
            // 补偿把多发的部分算成会被随机丢掉的。丢包跟着速率涨时多发的其实是被挤掉的，补偿越多挤掉越多，要尽快收回。
            // 放开要慢：几条连接同时放开又会挤回去。认出排队期间估高的随机丢包率已经清掉一部分，慢慢放开时补偿也小得多。
            if self.overflowing {
                self.compensation = self.compensation * COMPENSATION_CUT / 1000;
            } else {
                let step = (1000 * self.min_rtt_us / COMPENSATION_RESTORE_US).max(1);
                self.compensation = (self.compensation + step).min(1000);
            }
            if !sample.app_limited && (!outage || self.outage_rounds > OUTAGE_HOLD_ROUNDS) {
                self.round += 1;
                self.bw_samples[self.round % BW_WINDOW_ROUNDS] = 0;
            }
        }
        // 这种时候测到的速率偏低，不能用来下调带宽估计。
        if !sample.app_limited || delivery_rate > self.btl_bw {
            let slot = &mut self.bw_samples[self.round % BW_WINDOW_ROUNDS];
            *slot = (*slot).max(delivery_rate);
        }
        let windowed_max = self.bw_samples.iter().copied().max().unwrap_or(0);
        if windowed_max > 0 {
            self.btl_bw = windowed_max;
        }

        let min_rtt_expired = now_us.saturating_sub(self.min_rtt_at) > MIN_RTT_WINDOW_US;
        if sample.rtt_us > 0 && (self.min_rtt_us == 0 || sample.rtt_us <= self.min_rtt_us || min_rtt_expired) {
            self.min_rtt_us = sample.rtt_us;
            self.min_rtt_at = now_us;
        }

        if round_start {
            self.last_round_min_rtt_us = self.round_min_rtt_us;
            self.recent_round_rtts[self.recent_round_index] = self.round_min_rtt_us;
            self.recent_round_index = (self.recent_round_index + 1) % RECENT_ROUNDS;
            self.check_queue_is_ours();
            if !self.queue_above(self.foreign_margin_us()) {
                self.foreign_queue = false;
            }
            self.round_min_rtt_us = u64::MAX;
            self.round_rtt_samples = 0;
        }
        if sample.rtt_us > 0 {
            if self.last_rtt_us > 0 {
                self.rtt_jitter_us = (self.rtt_jitter_us * 7 + sample.rtt_us.abs_diff(self.last_rtt_us)) / 8;
            }
            self.rtt_avg_us = if self.rtt_avg_us == 0 { sample.rtt_us } else { (self.rtt_avg_us * 7 + sample.rtt_us) / 8 };
            self.last_rtt_us = sample.rtt_us;
            self.round_min_rtt_us = self.round_min_rtt_us.min(sample.rtt_us);
            self.round_rtt_samples += 1;
        }
        if self.mode == Mode::Startup && self.queue_is_building() {
            self.filled_pipe = true;
            // 被窗口限住时在途量最多一个窗口，排起来的队列有上限，不会越堆越长。
            // 这时整体降到三分之一去排空，只会让窗口空转一个往返。
            if self.window_limited {
                self.enter_probe_bw(now_us);
            } else {
                self.mode = Mode::Drain;
            }
        }
        // 被窗口限住时带宽不再增长也算到头了：继续留在启动阶段就没有降速阶段，测不出随机丢包率。
        if self.mode == Mode::Startup && round_start && !sample.app_idle {
            if self.btl_bw >= self.full_bw.saturating_mul(FULL_BW_GROWTH) / 1000 {
                self.full_bw = self.btl_bw;
                self.full_bw_rounds = 0;
            } else {
                self.full_bw_rounds += 1;
                if self.full_bw_rounds >= FULL_BW_ROUNDS {
                    self.filled_pipe = true;
                    // 被窗口限住、没有排队时瓶颈上什么也没堆，不用排空，直接巡航。
                    if self.window_limited && !self.queue_is_building() {
                        self.enter_probe_bw(now_us);
                    } else {
                        self.mode = Mode::Drain;
                    }
                }
            }
        }
        // 窗口最低也有 min_cwnd，在途量降到这以下也不会更空。带宽估计偏低时（稀疏消息只测到应用速度），
        // 只等降到估计的 BDP 会一直卡在排空阶段，按排空速度慢慢补发断网积压。
        if self.mode == Mode::Drain && bytes_in_flight <= self.bdp().max(self.min_cwnd) {
            self.enter_probe_bw(now_us);
        }
        if self.mode == Mode::ProbeBw && self.cycle_phase_done(now_us, sample, bytes_in_flight) {
            self.finish_calm_watch();
            self.cycle_index = (self.cycle_index + 1) % PROBE_CYCLE.len();
            if PROBE_CYCLE[self.cycle_index] < 1000 {
                self.start_calm_watch();
            }
            // 新一轮探测开始前，看上一次探测发的包丢了多少：中间隔了好几个往返，结果都回来了。
            if self.cycle_index == 0 {
                self.gentle_probes = self.gentle_probes.saturating_sub(1);
            }
            if self.cycle_index == 0 && self.probe_total >= PROBE_MIN_PACKETS {
                let loss = self.probe_lost * 1_000_000 / self.probe_total;
                if loss > (self.random_loss_ppm as u64).saturating_mul(2).saturating_add(PROBE_EXCESS_LOSS_PPM) {
                    self.gentle_probes = GENTLE_PROBES;
                }
                self.probe_lost = 0;
                self.probe_total = 0;
            }
            self.cycle_started = now_us;
        }
        // 流量稀疏时队列本来就是空的，刚才的样本已经是干净的 RTT，不用再专门探测。
        if min_rtt_expired && self.mode == Mode::ProbeBw && !sample.app_limited {
            self.mode = Mode::ProbeRtt;
            self.probe_rtt_until = now_us + PROBE_RTT_US;
        }
        if self.mode == Mode::ProbeRtt && now_us >= self.probe_rtt_until {
            self.min_rtt_at = now_us;
            if self.filled_pipe {
                self.enter_probe_bw(now_us);
            } else {
                self.mode = Mode::Startup;
            }
        }
    }

    /// 第一批包的确认到达间隔反映路径能走多快。普通的速率样本要除以一个往返，
    /// 第一批包只有几十个，算出来很低，高延迟链路要多爬两三轮，这里一步到位。
    /// 发送速率是上限，确认挤在一起到达也不会高估。
    fn train_rate(&mut self, now_us: u64, sample: &RateSample, delivered: u64) -> u64 {
        if sample.prior_delivered != 0 || self.mode != Mode::Startup {
            return 0;
        }
        let Some((at, base)) = self.train_start else {
            self.train_start = Some((now_us, delivered));
            return 0;
        };
        let bytes = delivered.saturating_sub(base);
        if bytes < self.min_cwnd {
            return 0;
        }
        (bytes.saturating_mul(1_000_000) / now_us.saturating_sub(at).max(sample.send_span_us).max(1)).min(self.initial_rate)
    }

    fn queue_is_building(&self) -> bool {
        self.queue_above(self.queue_margin_us())
    }

    /// 一轮里最小的往返比基准高出 `margin_us`。
    fn queue_above(&self, margin_us: u64) -> bool {
        let floor = if self.round_rtt_samples >= ROUND_RTT_SAMPLES { self.round_min_rtt_us } else { self.last_round_min_rtt_us };
        floor != u64::MAX && floor >= self.base_rtt().saturating_add(margin_us)
    }

    /// 余量要盖过抖动：抖动小的链路上按往返的十六分之一算，10 毫秒的浅队列排到一半就能发现；
    /// 抖动大的链路上按抖动的三倍算，不把抖动当成排队。
    fn queue_margin_us(&self) -> u64 {
        (self.min_rtt_us / 16).max(self.rtt_jitter_us * 3).clamp(QUEUE_MARGIN_MIN_US, QUEUE_MARGIN_MAX_US)
    }

    /// 队列在排，而且上一次降速开始时就在排：是别的流排的。巡航时发现排队会主动降速，自己排的队到降速阶段开始前已经排空了。
    /// 2026-11-03 试过再看降速期间队列有没有回落，对比矩阵和共享矩阵里结果几乎一样，没留。
    /// 丢包跟着速率涨时也按这样算：降速时丢的包分不清是随机丢的还是被挤掉的，送到的照样算，估高的随机丢包率才降得下来。
    /// 余量用 [`Self::foreign_margin_us`]，比排队判断的小。
    pub(crate) fn queue_is_foreign(&self) -> bool {
        (self.foreign_queue && self.queue_above(self.foreign_margin_us())) || self.overflowing
    }

    /// 认别人的队列用的余量，只影响随机丢包率的样本。排队判断至少要 4 毫秒，几条连接挤满 3 毫秒的队列时
    /// 永远到不了；这里按一轮的最小往返比，抖动已经滤掉一层，再留抖动的三倍、往返的 1/32，至少 0.5 毫秒。
    /// 2026-11-05：下限 0.25、0.5、1 毫秒在浅队列扫描里结果一样；去掉它，浅队列扫描平均丢包 5.95% → 7.07%。
    fn foreign_margin_us(&self) -> u64 {
        (self.min_rtt_us / 32).max(self.rtt_jitter_us * 3).clamp(FOREIGN_MARGIN_MIN_US, QUEUE_MARGIN_MAX_US)
    }

    fn start_calm_watch(&mut self) {
        self.phase_cycle += 1;
        let floor = self.last_round_min_rtt_us;
        self.calm_entry_queue_us = if floor == u64::MAX { 0 } else { floor.saturating_sub(self.base_rtt()) };
        self.calm_watch = true;
    }

    /// 降速阶段结束时才更新，这一段降速发的包仍按上一段的结论算。
    fn finish_calm_watch(&mut self) {
        if core::mem::take(&mut self.calm_watch) {
            self.foreign_queue = self.calm_entry_queue_us >= self.foreign_margin_us();
        }
    }

    fn cycle_phase_done(&self, now_us: u64, sample: &RateSample, bytes_in_flight: u64) -> bool {
        let gain = self.cycle_gain();
        let full_length = now_us.saturating_sub(self.cycle_started) >= self.min_rtt_us;
        if gain > 1000 {
            // 没真正把在途数据加上去就结束的话，这次探测什么也没测到。
            // 见到丢包再跑一个往返也结束：限速器把多发的包都丢了，在途量永远加不上去，等下去就一直多发、一直丢。
            // 多跑的这个往返不能省，发现限速要靠这段时间的丢包。
            let lost_enough = !self.low_queue && self.probe_lost > 0 && now_us.saturating_sub(self.cycle_started) >= self.min_rtt_us * PROBE_LOSS_RTTS;
            return full_length && (sample.app_limited || lost_enough || bytes_in_flight >= self.bdp().saturating_mul(gain) / 1000);
        }
        if gain < 1000 {
            // 没有丢包时队列排空就可以恢复；有丢包时要跑满，这段时间是在测随机丢包率。
            // 不能只看随机丢包率是不是 0：还没测过时它也是 0，提前结束的话一个低速包都测不到，永远是 0。
            let no_loss = self.random_loss_ppm == 0 && self.period_lost == 0;
            return full_length || (no_loss && bytes_in_flight <= self.bdp());
        }
        full_length
    }

    /// 窗口不超过两个初始窗口。
    fn small_window(&self) -> bool {
        self.max_cwnd <= self.initial_cwnd.saturating_mul(2)
    }

    fn enter_probe_bw(&mut self, now_us: u64) {
        self.mode = Mode::ProbeBw;
        // 通常从降速阶段开始，尽早测出随机丢包率。
        // 窗口本身不超过两个初始窗口时，被窗口限住是常态，启动一结束就降速，窗口要空转一个往返，占整段传输的比例不小。
        // 这时如果最近两轮丢得不多（没冲过限速或配额），跳过第一个降速阶段，随机丢包率留给后面的降速阶段测。
        // 窗口大的连接照旧：窗口和路径容量可能只差一点，不降速直接巡航会挤爆队列。
        let calm_rounds = self.round_loss_ppm.iter().all(|&loss| loss < SKIP_CALM_MAX_LOSS_PPM);
        self.cycle_index = if self.small_window() && self.window_limited && calm_rounds { 2 } else { 1 };
        if PROBE_CYCLE[self.cycle_index] < 1000 {
            self.start_calm_watch();
        } else {
            self.phase_cycle += 1;
        }
        self.cycle_started = now_us;
    }

    pub(crate) fn on_timeout(&mut self, now_us: u64, consecutive: u32, long_outage: bool) {
        self.long_outage = long_outage;
        // 降速阶段要靠确认才能结束，超时说明确认断了，这一段什么也测不到。稀疏消息留在降速阶段的话，
        // 整个断网期间和恢复后的头一个往返都不能提速补发，积压的消息全被拖住。
        // 满负荷传输不动：限速路径上超时很常见，降速阶段是它测随机丢包率、找上限的依据。
        if self.mode == Mode::ProbeBw && PROBE_CYCLE[self.cycle_index] < 1000 && self.app_idle_estimate {
            self.calm_watch = false;
            self.cycle_index = (self.cycle_index + 1) % PROBE_CYCLE.len();
            self.cycle_started = now_us;
        }
        self.clean_rounds = 0;
        self.recovering = consecutive >= RECOVERY_TIMEOUTS;
        if consecutive >= PATH_CHANGE_TIMEOUTS {
            self.bw_samples = [0; BW_WINDOW_ROUNDS];
            self.btl_bw = 0;
            self.min_rtt_us = 0;
            // 旧的一轮 RTT 要一起清掉：留着的话，恢复后新的最小 RTT 更低，看起来像队列在堆积，
            // 启动马上就退出，带宽要从很低的估计慢慢爬回来。
            self.round_min_rtt_us = u64::MAX;
            self.last_round_min_rtt_us = u64::MAX;
            self.recent_round_rtts = [u64::MAX; RECENT_ROUNDS];
            self.round_rtt_samples = 0;
            self.full_bw = 0;
            self.full_bw_rounds = 0;
            self.filled_pipe = false;
            self.mode = Mode::Startup;
            // 换了路径，旧瓶颈上“丢包跟着速率涨”的结论不再适用。
            self.compare_calm_packets = 0;
            self.compare_calm_losses = 0;
            self.compare_cruise_packets = 0;
            self.compare_cruise_losses = 0;
            self.compared_cycles = 0;
            self.overflowing = false;
            self.compensation = 1000;
        }
    }
}

/// 整数立方根，向下取整。
fn icbrt(value: u64) -> u64 {
    let (mut low, mut high) = (0u64, 1u64 << 21);
    while low + 1 < high {
        let middle = (low + high) / 2;
        if middle.saturating_mul(middle).saturating_mul(middle) <= value {
            low = middle;
        } else {
            high = middle;
        }
    }
    low
}

fn isqrt(value: u64) -> u64 {
    if value < 2 {
        return value;
    }
    let mut x = value;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + value / x) / 2;
    }
    x
}
