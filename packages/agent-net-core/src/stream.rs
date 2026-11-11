//! 一条连接里的多条流。
//!
//! 确认、重传、校验、拥塞控制都留在连接这一层，分片序号全连接共用。流只管两件事：
//! 发送方决定下一个分片给谁，接收方按流各自交付。一个流丢包不耽误别的流。
//!
//! 流是单向的，两个方向各编各的号，要一问一答就各开一条。
//!
//! 分片序号连续、又属于同一条流时不带流头，所以只有一条流时没有额外开销。
//! 流头放在分片内容的最前面，校验包能一起算回来；分片长度字段的最高位表示有没有流头。

use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;

/// 不开流时用的默认流，一直存在。
pub const DEFAULT_STREAM: u32 = 0;
/// `[流号 4][流内序号 4][标记 1]`。
pub(crate) const STREAM_HEADER_LEN: usize = 9;
/// 分片长度字段的最高位：这个分片带流头。
pub(crate) const HEADED_LENGTH_BIT: u16 = 0x8000;
const FLAG_FIN: u8 = 1;
const PRIORITIES: usize = 3;
/// 同一优先级里每条流连发这么多个分片再换下一条：换流要带流头，轮得太勤开销不小。
const ROUND_QUANTUM: u32 = 8;
/// 高优先级连续占用这么多个分片后，让低优先级发一个，免得被彻底饿死。
const STARVATION_LIMIT: u32 = 15;

/// 流的优先级，只影响本端发送顺序。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Priority {
    /// 聊天、远程控制这类小消息，有数据就先发。
    Interactive,
    #[default]
    Normal,
    /// 大文件这类后台传输，用剩下的带宽。
    Background,
}

impl Priority {
    fn rank(self) -> usize {
        match self {
            Priority::Interactive => 0,
            Priority::Normal => 1,
            Priority::Background => 2,
        }
    }

    pub(crate) fn is_lower_than(self, other: Priority) -> bool {
        self.rank() > other.rank()
    }
}

/// 收到的流发生了变化。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamEvent {
    /// 对端开了一条新流。
    Opened(u32),
    /// 对端写完了，数据也全读走了。
    Finished(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StreamHeader {
    pub(crate) stream: u32,
    pub(crate) seq: u32,
    pub(crate) fin: bool,
}

impl StreamHeader {
    pub(crate) fn write(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.stream.to_be_bytes());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.push(if self.fin { FLAG_FIN } else { 0 });
    }

    pub(crate) fn parse(body: &[u8]) -> Option<Self> {
        let bytes = body.get(..STREAM_HEADER_LEN)?;
        Some(Self {
            stream: u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            seq: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
            fin: bytes[8] & FLAG_FIN != 0,
        })
    }
}

pub(crate) struct SendStream {
    pub(crate) priority: Priority,
    pub(crate) pending: VecDeque<u8>,
    /// 已经切成分片、还没确认的字节。
    pub(crate) unacked: usize,
    pub(crate) next_seq: u64,
    /// 对端允许发到的流内序号（不含）。默认流不用它，看确认帧里的窗口。
    pub(crate) credit_end: u64,
    pub(crate) finishing: bool,
    pub(crate) fin_sent: bool,
}

impl SendStream {
    pub(crate) fn new(priority: Priority, credit_end: u64) -> Self {
        Self { priority, pending: VecDeque::new(), unacked: 0, next_seq: 0, credit_end, finishing: false, fin_sent: false }
    }

    /// 还有东西要切成分片。
    pub(crate) fn has_data(&self) -> bool {
        !self.pending.is_empty() || (self.finishing && !self.fin_sent)
    }

    pub(crate) fn is_done(&self) -> bool {
        self.fin_sent && self.pending.is_empty() && self.unacked == 0
    }

    /// 把前 `count` 个字节挪到 `out` 后面。
    pub(crate) fn take_pending(&mut self, count: usize, out: &mut Vec<u8>) {
        let (front, back) = self.pending.as_slices();
        let first = count.min(front.len());
        out.extend_from_slice(&front[..first]);
        out.extend_from_slice(&back[..count - first]);
        self.pending.drain(..count);
    }
}

/// 决定下一个分片给哪条流。
#[derive(Default)]
pub(crate) struct Scheduler {
    /// 每个优先级上一次发的流，和它这一轮还能连发几个。
    last: [Option<u32>; PRIORITIES],
    quantum_left: [u32; PRIORITIES],
    /// 比最低的那个有数据的优先级高的流，已经连续发了几个分片。
    high_run: u32,
}

impl Scheduler {
    /// `ready` 判断这条流现在能不能发。
    pub(crate) fn pick(&self, streams: &BTreeMap<u32, SendStream>, mut ready: impl FnMut(u32, &SendStream) -> bool) -> Option<u32> {
        let mut candidates: [Option<u32>; PRIORITIES] = [None; PRIORITIES];
        let mut next_after_last: [Option<u32>; PRIORITIES] = [None; PRIORITIES];
        for (&id, stream) in streams {
            if !ready(id, stream) {
                continue;
            }
            let rank = stream.priority.rank();
            candidates[rank].get_or_insert(id);
            if self.last[rank] == Some(id) && self.quantum_left[rank] > 0 {
                next_after_last[rank] = Some(id);
            } else if self.last[rank].is_some_and(|last| id > last) {
                next_after_last[rank].get_or_insert(id);
            }
        }
        let choice = |rank: usize| next_after_last[rank].or(candidates[rank]);
        let highest = (0..PRIORITIES).find(|&rank| candidates[rank].is_some())?;
        if self.high_run >= STARVATION_LIMIT
            && let Some(lower) = (highest + 1..PRIORITIES).find(|&rank| candidates[rank].is_some())
        {
            return choice(lower);
        }
        choice(highest)
    }

    /// 发了一个低优先级的重传。它和新分片一样算低优先级在前进：只认新分片的话，
    /// 重传队列排空之前计数清不了零，高优先级要一直让路。
    pub(crate) fn record_retransmission(&mut self) {
        self.high_run = 0;
    }

    pub(crate) fn record(&mut self, id: u32, priority: Priority, higher_than_lowest: bool) {
        let rank = priority.rank();
        self.quantum_left[rank] = if self.last[rank] == Some(id) { self.quantum_left[rank].saturating_sub(1) } else { ROUND_QUANTUM - 1 };
        self.last[rank] = Some(id);
        self.high_run = if higher_than_lowest { self.high_run + 1 } else { 0 };
    }
}

pub(crate) struct RecvStream {
    pub(crate) next_seq: u64,
    /// 到了但前面还缺分片：流内序号 → 连接分片序号。内容还留在连接的乱序缓冲里。
    pub(crate) waiting: BTreeMap<u64, u64>,
    pub(crate) ready: VecDeque<Vec<u8>>,
    pub(crate) ready_offset: usize,
    /// 带结束标记的分片的流内序号。
    pub(crate) fin_seq: Option<u64>,
    /// 应用读完的分片数。
    pub(crate) consumed: u64,
    /// 告诉过对端可以发到哪里。
    pub(crate) granted_end: u64,
    /// 这个额度还要跟着几个确认发出去。
    pub(crate) grant_repeats: u8,
}

impl RecvStream {
    pub(crate) fn new(granted_end: u64) -> Self {
        Self {
            next_seq: 0,
            waiting: BTreeMap::new(),
            ready: VecDeque::new(),
            ready_offset: 0,
            fin_seq: None,
            consumed: 0,
            granted_end,
            grant_repeats: 0,
        }
    }

    /// 对端写完了，应用也读完了。
    pub(crate) fn is_drained(&self) -> bool {
        self.fin_seq.is_some_and(|fin| self.next_seq > fin) && self.ready.is_empty()
    }
}
