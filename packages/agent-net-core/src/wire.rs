//! 线上格式。接入产品之前不做兼容承诺。
//!
//! 包：`[版本 3 位][逐包确认 1 位][包号低 20 位]`，共 3 字节，后跟若干帧。
//! DATA：`[1][分片序号 4][长度 2][内容]`，长度的最高位表示内容前面带流头（见 `stream.rs`）。
//! ACK： `[2][最大包号低 24 位 3][确认延迟 2][una 低 24 位 3][窗口 2][首段长度 2][段数 1]` 后跟 `[间隔 2][长度 2]`
//! PING：`[3]`
//! CREDIT：`[5][流号 4][允许发到的流内序号低 32 位 4]`
//! PARITY：`[4][首分片序号低 16 位 2][覆盖分片数 1][校验包序号 1][长度校验 2][校验内容]`，内容一直到包尾，所以只能是最后一帧。
//! PATH_CHALLENGE / PATH_RESPONSE：`[6、8 或 7][值 8]`，只用在加密连接的路径验证里，单独成包，后面全是填充的零，见 `secure.rs`。
//! 8 是验证一个只换了端口的地址（来源 IP 和数据路径相同），被验证的一端不用从头量往返和带宽。
//! CLOSE：`[9]`，只用在加密连接里，单独成包：发包的一端已经关掉这条连接，对端收到就停，不用等判死，见 `secure.rs`。
//! ID_UPDATE：`[10][代次 8][本地号个数 1][作废请求个数 1][序号 4、号 4]…[要作废的对端序号 4]…`。
//! ID_ACK：`[11][代次 8]`。两种均为大端、单独加密成包；完整快照按代次重发／确认，编解码见 `ids.rs`。
//!
//! 每次发送都用新包号，重传也不例外：这样 RTT 没有歧义，第 4 步也能用包号做加密 nonce。

use crate::parity::{MAX_COVERED, SYMBOLS};
use crate::stream::{HEADED_LENGTH_BIT, STREAM_HEADER_LEN};

const VERSION_BITS: u8 = 0xA0;
const VERSION_MASK: u8 = 0xE0;
/// 首字节的这一位：发送方请对端逐包确认。
const EAGER_ACK_FLAG: u8 = 0x10;
pub(crate) const PACKET_HEADER_LEN: usize = 3;
pub(crate) const DATA_HEADER_LEN: usize = 7;
pub(crate) const PARITY_HEADER_LEN: usize = 7;
const ACK_FIXED_LEN: usize = 14;
/// 线上序号的位数。接收方取离期望值最近的那个，所以差距不能超过一半：
/// 包号的差距受发送窗口限制，确认和校验覆盖的序号都落在窗口内。
pub(crate) const PACKET_NUMBER_BITS: u32 = 20;
pub(crate) const ACK_NUMBER_BITS: u32 = 24;
pub(crate) const PARITY_FIRST_BITS: u32 = 16;
pub(crate) const SEQUENCE_BITS: u32 = 32;
const ACK_RANGE_LEN: usize = 4;
/// 解析时接受的区间数上限。
pub(crate) const MAX_ACK_RANGES: usize = 32;
/// 发送时最多带的区间数。重传用新包号，旧空洞永远填不上，全带的话确认帧常年 149 字节；
/// 每个新区间会出现在后续好几个确认里，只带最新的就够了。
const MAX_SENT_ACK_RANGES: usize = 8;
/// 区间最后一次变化以后，再跟着这么多个确认发出去就不再带：对端早就知道了。
/// 不限的话，随机丢包的路径上每个确认都带满 8 个旧区间，慢速链路上光确认就占流量的 4%。
/// 也不能太少：确认在回程上同样会丢、会乱序，留得太短，发送方会把已经收到的包当成丢了重传（跨境乱序路径上 8 个就嫌少）。
/// 按确认个数而不是包号距离算：高速链路上一阵突发丢包就隔开几百个包号，按距离会把还没送到的区间提前扔掉。
pub(crate) const RANGE_REPORT_ACKS: u32 = 32;

const FRAME_DATA: u8 = 1;
const FRAME_ACK: u8 = 2;
const FRAME_PING: u8 = 3;
const FRAME_PARITY: u8 = 4;
const FRAME_CREDIT: u8 = 5;
const FRAME_PATH_CHALLENGE: u8 = 6;
const FRAME_PATH_RESPONSE: u8 = 7;
const FRAME_PATH_CHALLENGE_SAME_ROUTE: u8 = 8;
const FRAME_CLOSE: u8 = 9;
pub(crate) const CREDIT_FRAME_LEN: usize = 9;
pub(crate) const PATH_FRAME_LEN: usize = 9;
pub(crate) const CLOSE_FRAME_LEN: usize = 1;

/// 确认延迟的单位。两字节能表示约 4.2 秒，再长就饱和。
const ACK_DELAY_UNIT_US: u64 = 64;

pub(crate) struct AckFrame<'a> {
    pub(crate) largest: u32,
    pub(crate) delay_us: u64,
    pub(crate) una: u32,
    pub(crate) window: u32,
    pub(crate) first_run: u32,
    /// 尚未解码的 `[间隔 2][长度 2]` 列表，长度已校验。
    ranges: &'a [u8],
}

impl AckFrame<'_> {
    pub(crate) fn ranges(&self) -> impl Iterator<Item = (u32, u32)> + '_ {
        self.ranges
            .chunks_exact(ACK_RANGE_LEN)
            .map(|item| (u16::from_be_bytes([item[0], item[1]]) as u32, u16::from_be_bytes([item[2], item[3]]) as u32))
    }
}

pub(crate) enum Frame<'a> {
    Data { sn: u32, payload: &'a [u8], headed: bool },
    Ack(AckFrame<'a>),
    Ping,
    Parity { first: u32, count: u8, index: u8, length: u16, payload: &'a [u8] },
    Credit { stream: u32, end: u32 },
}

fn take<'a>(packet: &'a [u8], pos: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = pos.checked_add(len)?;
    let slice = packet.get(*pos..end)?;
    *pos = end;
    Some(slice)
}

fn take_u16(packet: &[u8], pos: &mut usize) -> Option<u16> {
    take(packet, pos, 2).map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn take_u24(packet: &[u8], pos: &mut usize) -> Option<u32> {
    take(packet, pos, 3).map(|bytes| u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]))
}

fn take_u32(packet: &[u8], pos: &mut usize) -> Option<u32> {
    take(packet, pos, 4).map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

pub(crate) fn parse_header(packet: &[u8]) -> Option<(u32, bool)> {
    if packet.len() < PACKET_HEADER_LEN || packet[0] & VERSION_MASK != VERSION_BITS {
        return None;
    }
    Some((u32::from_be_bytes([0, packet[0] & 0x0F, packet[1], packet[2]]), packet[0] & EAGER_ACK_FLAG != 0))
}

pub(crate) fn parse_frame<'a>(packet: &'a [u8], pos: &mut usize) -> Option<Frame<'a>> {
    match *take(packet, pos, 1)?.first()? {
        FRAME_DATA => {
            let sn = take_u32(packet, pos)?;
            let coded = take_u16(packet, pos)?;
            let headed = coded & HEADED_LENGTH_BIT != 0;
            let len = (coded & !HEADED_LENGTH_BIT) as usize;
            if len == 0 || (headed && len < STREAM_HEADER_LEN) {
                return None;
            }
            Some(Frame::Data { sn, payload: take(packet, pos, len)?, headed })
        }
        FRAME_ACK => {
            let largest = take_u24(packet, pos)?;
            let delay_us = take_u16(packet, pos)? as u64 * ACK_DELAY_UNIT_US;
            let una = take_u24(packet, pos)?;
            let window = take_u16(packet, pos)? as u32;
            let first_run = take_u16(packet, pos)? as u32;
            let count = *take(packet, pos, 1)?.first()? as usize;
            if first_run == 0 || count > MAX_ACK_RANGES {
                return None;
            }
            let ranges = take(packet, pos, count * ACK_RANGE_LEN)?;
            Some(Frame::Ack(AckFrame { largest, delay_us, una, window, first_run, ranges }))
        }
        FRAME_PING => Some(Frame::Ping),
        FRAME_PARITY => {
            let first = take_u16(packet, pos)? as u32;
            let count = *take(packet, pos, 1)?.first()?;
            let index = *take(packet, pos, 1)?.first()?;
            let length = take_u16(packet, pos)?;
            if count < 2 || count as u64 > MAX_COVERED || index >= SYMBOLS || *pos == packet.len() {
                return None;
            }
            let payload = take(packet, pos, packet.len() - *pos)?;
            Some(Frame::Parity { first, count, index, length, payload })
        }
        FRAME_CREDIT => Some(Frame::Credit { stream: take_u32(packet, pos)?, end: take_u32(packet, pos)? }),
        _ => None,
    }
}

pub(crate) fn write_header(out: &mut [u8], packet_number: u64, eager_ack: bool) -> usize {
    let [_, high, middle, low] = (packet_number as u32).to_be_bytes();
    out[0] = VERSION_BITS | if eager_ack { EAGER_ACK_FLAG } else { 0 } | (high & 0x0F);
    out[1] = middle;
    out[2] = low;
    PACKET_HEADER_LEN
}

pub(crate) fn write_data(out: &mut [u8], used: usize, sn: u64, payload: &[u8], headed: bool) -> usize {
    let end = used + DATA_HEADER_LEN;
    out[used] = FRAME_DATA;
    out[used + 1..used + 5].copy_from_slice(&(sn as u32).to_be_bytes());
    let coded = payload.len() as u16 | if headed { HEADED_LENGTH_BIT } else { 0 };
    out[used + 5..end].copy_from_slice(&coded.to_be_bytes());
    out[end..end + payload.len()].copy_from_slice(payload);
    end + payload.len()
}

pub(crate) fn write_parity(out: &mut [u8], used: usize, first: u64, count: u8, index: u8, length: u16, payload: &[u8]) -> usize {
    let end = used + PARITY_HEADER_LEN;
    out[used] = FRAME_PARITY;
    out[used + 1..used + 3].copy_from_slice(&(first as u16).to_be_bytes());
    out[used + 3] = count;
    out[used + 4] = index;
    out[used + 5..end].copy_from_slice(&length.to_be_bytes());
    out[end..end + payload.len()].copy_from_slice(payload);
    end + payload.len()
}

pub(crate) fn write_credit(out: &mut [u8], used: usize, stream: u32, end: u64) -> usize {
    out[used] = FRAME_CREDIT;
    out[used + 1..used + 5].copy_from_slice(&stream.to_be_bytes());
    out[used + 5..used + CREDIT_FRAME_LEN].copy_from_slice(&(end as u32).to_be_bytes());
    used + CREDIT_FRAME_LEN
}

pub(crate) fn write_ping(out: &mut [u8], used: usize) -> usize {
    out[used] = FRAME_PING;
    used + 1
}

/// 路径验证帧占满 `out`：帧后面填零，填充让验证包本身也测一测这条路径能过多长的包。
pub(crate) fn write_path_frame(out: &mut [u8], frame: PathFrame, value: u64) {
    out[0] = match frame {
        PathFrame::Challenge { same_route: false } => FRAME_PATH_CHALLENGE,
        PathFrame::Challenge { same_route: true } => FRAME_PATH_CHALLENGE_SAME_ROUTE,
        PathFrame::Response => FRAME_PATH_RESPONSE,
    };
    out[1..PATH_FRAME_LEN].copy_from_slice(&value.to_be_bytes());
    out[PATH_FRAME_LEN..].fill(0);
}

pub(crate) fn write_close_frame(out: &mut [u8]) {
    out[0] = FRAME_CLOSE;
}

/// 包头之后是不是关闭帧。
pub(crate) fn is_close_frame(frames: &[u8]) -> bool {
    frames == [FRAME_CLOSE]
}

/// 包头之后是不是路径验证帧。
pub(crate) fn is_path_frame(frames: &[u8]) -> bool {
    matches!(frames.first(), Some(&FRAME_PATH_CHALLENGE | &FRAME_PATH_RESPONSE | &FRAME_PATH_CHALLENGE_SAME_ROUTE))
}

/// 路径验证帧的种类。`same_route` 是验证方看出来新地址只换了端口。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathFrame {
    Challenge { same_route: bool },
    Response,
}

/// 解出路径验证帧：种类、值。填充不全是零时格式不对。
pub(crate) fn parse_path_frame(frames: &[u8]) -> Option<(PathFrame, u64)> {
    let value = u64::from_be_bytes(frames.get(1..PATH_FRAME_LEN)?.try_into().ok()?);
    if frames[PATH_FRAME_LEN..].iter().any(|&byte| byte != 0) {
        return None;
    }
    let frame = match frames[0] {
        FRAME_PATH_RESPONSE => PathFrame::Response,
        FRAME_PATH_CHALLENGE_SAME_ROUTE => PathFrame::Challenge { same_route: true },
        _ => PathFrame::Challenge { same_route: false },
    };
    Some((frame, value))
}

/// 已收到的包号区间，升序、闭区间。写入时优先保留最新的区间。
pub(crate) fn write_ack(
    out: &mut [u8],
    used: usize,
    received: impl DoubleEndedIterator<Item = (u64, u64, bool)>,
    late_packets: &[u64],
    delay_us: u64,
    una: u64,
    window: u32,
) -> usize {
    let mut newest_first = received.rev();
    let Some((first_low, first_high, _)) = newest_first.next() else {
        return used;
    };
    if used + ACK_FIXED_LEN > out.len() {
        return used;
    }
    let first_run = (first_high - first_low + 1).min(u16::MAX as u64);
    let header = used;
    out[header] = FRAME_ACK;
    out[header + 1..header + 4].copy_from_slice(&(first_high as u32).to_be_bytes()[1..]);
    out[header + 4..header + 6].copy_from_slice(&((delay_us / ACK_DELAY_UNIT_US).min(u16::MAX as u64) as u16).to_be_bytes());
    out[header + 6..header + 9].copy_from_slice(&(una as u32).to_be_bytes()[1..]);
    out[header + 9..header + 11].copy_from_slice(&(window.min(u16::MAX as u32) as u16).to_be_bytes());
    out[header + 11..header + 13].copy_from_slice(&(first_run as u16).to_be_bytes());

    let mut cursor = header + ACK_FIXED_LEN;
    let mut count = 0usize;
    let mut previous_low = first_high + 1 - first_run;
    for (low, high, fresh) in newest_first {
        if cursor + ACK_RANGE_LEN > out.len() {
            break;
        }
        // 晚到的包落在最新几个区间之外时也要带上，否则发送方永远等不到它的确认，只能白白重传。
        let stale = count >= MAX_SENT_ACK_RANGES || !fresh;
        if stale && !late_packets.iter().any(|&number| low <= number && number <= high) {
            continue;
        }
        let gap = previous_low - high - 1;
        let run = high - low + 1;
        if gap == 0 || gap > u16::MAX as u64 || run > u16::MAX as u64 {
            break;
        }
        out[cursor..cursor + 2].copy_from_slice(&(gap as u16).to_be_bytes());
        out[cursor + 2..cursor + 4].copy_from_slice(&(run as u16).to_be_bytes());
        cursor += ACK_RANGE_LEN;
        count += 1;
        previous_low = low;
    }
    out[header + 13] = count as u8;
    cursor
}

/// 把线上的低 `bits` 位还原成完整序号，取离期望值最近的那个。
pub(crate) fn expand(truncated: u32, expected: u64, bits: u32) -> u64 {
    let window = 1u64 << bits;
    let half = window / 2;
    let candidate = (expected & !(window - 1)) | truncated as u64;
    if candidate + half <= expected {
        candidate + window
    } else if candidate > expected + half && candidate >= window {
        candidate - window
    } else {
        candidate
    }
}
