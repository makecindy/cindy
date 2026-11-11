//! 往返时间估计与重传计时。平滑公式与 KCP、RFC 6298 相同。

/// 短中断时退避不超过这么多档，网络一恢复很快就能重连上。
const SHORT_BACKOFF_STEPS: u32 = 2;
/// 只有零散小消息在等时，短中断里只退避一档：重发它们很便宜，网络一恢复就要尽快补上。
const SPARSE_BACKOFF_STEPS: u32 = 1;
/// 连续超时这么多次、并且已经长时间没有任何回应，才算长断网，放慢探测省流量。
/// 只看次数的话，短中断里重试一快就会提前进入长断网，网络恢复后要多等好几百毫秒。
const LONG_OUTAGE_TIMEOUTS: u32 = 8;
const MAX_BACKOFF_STEPS: u32 = 4;

pub(crate) struct RttEstimator {
    srtt_us: u64,
    rttvar_us: u64,
    latest_us: u64,
    has_sample: bool,
    initial_rto_us: u64,
    min_rto_us: u64,
    max_rto_us: u64,
    ack_delay_us: u64,
}

impl RttEstimator {
    pub(crate) fn new(initial_rto_us: u64, min_rto_us: u64, max_rto_us: u64, ack_delay_us: u64) -> Self {
        Self { srtt_us: 0, rttvar_us: 0, latest_us: 0, has_sample: false, initial_rto_us, min_rto_us, max_rto_us, ack_delay_us }
    }

    pub(crate) fn observe(&mut self, sample_us: u64) {
        self.latest_us = sample_us;
        if !self.has_sample {
            self.srtt_us = sample_us;
            self.rttvar_us = sample_us / 2;
            self.has_sample = true;
            return;
        }
        // 比平滑值低一半以上就直接采信：排队和重传只会让 RTT 变大，不可能变小，
        // 低的样本才是真的。断网时发出的包要等恢复后才确认，第一个样本可能高出几倍，
        // 慢慢平滑的话超时一直偏长，重试次数不够就被判死了。
        if sample_us < self.srtt_us / 2 {
            self.srtt_us = sample_us;
            self.rttvar_us = sample_us / 2;
            return;
        }
        let delta = self.srtt_us.abs_diff(sample_us);
        self.rttvar_us = (3 * self.rttvar_us + delta) / 4;
        self.srtt_us = (7 * self.srtt_us + sample_us) / 8;
    }

    pub(crate) fn srtt_us(&self) -> u64 {
        self.srtt_us
    }

    fn base_rto_us(&self) -> u64 {
        let rto = if self.has_sample {
            self.srtt_us + (4 * self.rttvar_us).max(1_000) + self.ack_delay_us
        } else {
            self.initial_rto_us
        };
        rto.max(self.min_rto_us)
    }

    /// 连续超时 n 次之后的超时时间。沿用 KCP 快速模式的 1.5 倍退避，不翻倍，丢包时恢复更快。
    /// `long_outage` 由调用方按多久没收到对端的包判断；`sparse` 表示只有零散小消息在等。
    /// 这时连接已经只发少量探测，继续退避省不了多少流量，只会让网络恢复后多等。
    pub(crate) fn timeout_us(&self, consecutive_timeouts: u32, long_outage: bool, sparse: bool) -> u64 {
        let base = self.base_rto_us();
        // 上限只约束退避，不能低于当前 RTT 的估算，否则高延迟链路上每个包都会被误判丢失。
        let ceiling = self.max_rto_us.max(base);
        let mut rto = base;
        let long = consecutive_timeouts >= LONG_OUTAGE_TIMEOUTS && long_outage;
        let short_steps = if sparse { SPARSE_BACKOFF_STEPS } else { SHORT_BACKOFF_STEPS };
        let steps = if !long { consecutive_timeouts.min(short_steps) } else { MAX_BACKOFF_STEPS };
        for _ in 0..steps {
            rto += rto / 2;
            if rto >= ceiling {
                return ceiling;
            }
        }
        rto
    }

    /// 比某包晚发的包已被确认时，这个包等这么久还没确认就算丢失。余量取实测抖动，高延迟链路不用白等。
    pub(crate) fn loss_delay_us(&self) -> u64 {
        self.srtt_us.max(self.latest_us) + self.rttvar_us.max(1_000)
    }
}
