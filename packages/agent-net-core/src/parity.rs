//! 校验包：每隔几个分片发一个校验包，丢的分片不超过校验包数量时，接收方当场算出来，不用等一个往返。
//!
//! 窗口被占满时，丢一个包整条传输都要等它重传，代价是一个往返。kcptun 那样的分组码有两个问题：
//! 每组要单独留余量，丢 5% 时开销就要 30%；丢的包要等这一组发完才能修，确认成批回来，
//! 发送方补发这一批又要几毫秒，窗口每轮都被拖慢一截。
//!
//! 这里用滑动窗口（思路同 RFC 8681）：校验包覆盖最近发出的一段分片，相邻校验包的覆盖范围重叠，
//! 余量是共用的。开销只比丢包率高一点，丢的包等下一个校验包就能修。
//!
//! 系数取 GF(256) 上的柯西矩阵：覆盖同一段分片的校验包，任取几个都能解出同样多的分片。

use alloc::vec::Vec;

/// 校验包序号的范围。分片序号按它取模，覆盖范围不超过它时系数不会重复。
pub(crate) const SYMBOLS: u8 = 128;
/// 一个校验包最多覆盖这么多个分片，编码量和它成正比。
pub(crate) const MAX_COVERED: u64 = 64;
/// 一次最多同时解这么多个未知分片。
pub(crate) const MAX_UNKNOWNS: usize = 32;
/// 校验占比 = 丢包率 × (1 + 这个比例) + 最小余量。速度卡在窗口上时校验包不占数据的位置，余量可以放宽：
/// 修得越快，窗口每轮被拖慢得越少。带宽是瓶颈时，每个校验包都要挤掉一个数据包，只留够用的。
const MARGIN_PERCENT: u64 = 100;
const MIN_MARGIN_PPM: u64 = 25_000;
const LEAN_MARGIN_PERCENT: u64 = 25;
const LEAN_MIN_MARGIN_PPM: u64 = 10_000;
/// 两个校验包之间最多隔这么多个分片，再长的话修复要等太久，窗口每轮都被拖慢一截。
/// 带宽是瓶颈时校验包要占数据的位置，可以隔得长一些。
const MAX_INTERVAL: u64 = 12;
const LEAN_MAX_INTERVAL: u64 = 32;

const fn build_tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut value: u16 = 1;
    let mut power = 0;
    while power < 255 {
        exp[power] = value as u8;
        exp[power + 255] = value as u8;
        log[value as usize] = power as u8;
        value <<= 1;
        if value & 0x100 != 0 {
            value ^= 0x11d;
        }
        power += 1;
    }
    (exp, log)
}

const TABLES: ([u8; 512], [u8; 256]) = build_tables();
static EXP: [u8; 512] = TABLES.0;
static LOG: [u8; 256] = TABLES.1;

fn multiply(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 { 0 } else { EXP[LOG[a as usize] as usize + LOG[b as usize] as usize] }
}

fn inverse(value: u8) -> u8 {
    EXP[255 - LOG[value as usize] as usize]
}

/// 第 `symbol` 个校验包里，分片 `sn` 的系数。高位不同，分母不会是 0。
pub(crate) fn coefficient(symbol: u8, sn: u64) -> u8 {
    inverse((symbol | SYMBOLS) ^ (sn as u8 & (SYMBOLS - 1)))
}

/// 把 `payload` 乘上 `factor` 后异或进 `target`。分片长度不一，短的按后面补零算。
pub(crate) fn add_scaled(target: &mut Vec<u8>, payload: &[u8], factor: u8) {
    if payload.len() > target.len() {
        target.resize(payload.len(), 0);
    }
    if factor == 0 {
        return;
    }
    if factor == 1 {
        for (byte, other) in target.iter_mut().zip(payload) {
            *byte ^= *other;
        }
        return;
    }
    // 一个分片上千字节，先建表比逐字节查对数快。
    let shift = LOG[factor as usize] as usize;
    let mut table = [0u8; 256];
    for value in 1..256 {
        table[value] = EXP[shift + LOG[value] as usize];
    }
    for (byte, other) in target.iter_mut().zip(payload) {
        *byte ^= table[*other as usize];
    }
}

/// 分片长度和内容一样参与编码，还原时才知道原来多长。
pub(crate) fn scale_length(length: u16, factor: u8) -> u16 {
    let [high, low] = length.to_be_bytes();
    u16::from_be_bytes([multiply(high, factor), multiply(low, factor)])
}

pub(crate) type Matrix = [[u8; MAX_UNKNOWNS]; MAX_UNKNOWNS];

/// 消元。`rows[r][c]` 是第 r 个校验包里第 c 个未知分片的系数，`combination` 进来时是单位阵。
/// 返回每个未知分片的解在第几行：`combination` 这一行的系数乘上各校验包，加起来就是这个分片。
/// 校验包不够、还解不出来的分片是 `None`：覆盖范围部分重叠时，能解的先解。
pub(crate) fn reduce(rows: &mut Matrix, combination: &mut Matrix, symbols: usize, unknowns: usize) -> [Option<u8>; MAX_UNKNOWNS] {
    let mut pivots = [None; MAX_UNKNOWNS];
    let mut rank = 0;
    for column in 0..unknowns {
        let Some(found) = (rank..symbols).find(|&row| rows[row][column] != 0) else { continue };
        rows.swap(rank, found);
        combination.swap(rank, found);
        let scale = inverse(rows[rank][column]);
        for value in rows[rank].iter_mut().chain(combination[rank].iter_mut()) {
            *value = multiply(*value, scale);
        }
        let (pivot_row, pivot_combination) = (rows[rank], combination[rank]);
        for row in 0..symbols {
            let factor = rows[row][column];
            if row == rank || factor == 0 {
                continue;
            }
            for (value, pivot) in rows[row].iter_mut().zip(&pivot_row).chain(combination[row].iter_mut().zip(&pivot_combination)) {
                *value ^= multiply(factor, *pivot);
            }
        }
        pivots[column] = Some(rank as u8);
        rank += 1;
    }
    // 这一行还带着别的未知分片时，这个分片解不出来。
    for column in 0..unknowns {
        if let Some(row) = pivots[column]
            && (0..unknowns).any(|other| other != column && rows[row as usize][other] != 0)
        {
            pivots[column] = None;
        }
    }
    pivots
}

/// 每隔多少个新分片发一个校验包。
pub(crate) fn repair_interval(loss_ppm: u32, spare_capacity: bool) -> u32 {
    repair_interval_with_margin(loss_ppm, spare_capacity, MARGIN_PERCENT)
}

/// 速度优先策略只在窗口受限、或还未测得路径时扩大校验；带宽受限时仍用精简余量。
pub(crate) fn fast_repair_interval(loss_ppm: u32, spare_capacity: bool) -> u32 {
    repair_interval_with_margin(loss_ppm, spare_capacity, 1000)
}

fn repair_interval_with_margin(loss_ppm: u32, spare_capacity: bool, spare_margin_percent: u64) -> u32 {
    const PPM: u64 = 1_000_000;
    let loss = (loss_ppm as u64).min(PPM);
    let (percent, floor, longest) =
        if spare_capacity { (spare_margin_percent, MIN_MARGIN_PPM, MAX_INTERVAL) } else { (LEAN_MARGIN_PERCENT, LEAN_MIN_MARGIN_PPM, LEAN_MAX_INTERVAL) };
    let share = (loss + loss * percent / 100 + floor).min(PPM / 2);
    ((PPM - share) / share).clamp(1, longest) as u32
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;

    fn segments() -> Vec<Vec<u8>> {
        (0..8u32).map(|i| (0..(40 + i as usize * 29)).map(|j| (j as u32 * (i + 3)) as u8).collect()).collect()
    }

    fn encode(segments: &[Vec<u8>], symbol: u8, first: usize, count: usize) -> (Vec<u8>, u16) {
        let (mut data, mut length) = (Vec::new(), 0);
        for (position, segment) in segments.iter().enumerate().skip(first).take(count) {
            let factor = coefficient(symbol, position as u64);
            length ^= scale_length(segment.len() as u16, factor);
            add_scaled(&mut data, segment, factor);
        }
        (data, length)
    }

    fn solve(segments: &[Vec<u8>], lost: &[usize], symbols: &[(u8, usize, usize)]) -> Vec<Option<(Vec<u8>, u16)>> {
        let mut rows: Matrix = [[0; MAX_UNKNOWNS]; MAX_UNKNOWNS];
        let mut combination: Matrix = [[0; MAX_UNKNOWNS]; MAX_UNKNOWNS];
        let mut known = Vec::new();
        for (row, &(symbol, first, count)) in symbols.iter().enumerate() {
            combination[row][row] = 1;
            let (mut value, mut length) = encode(segments, symbol, first, count);
            for (position, segment) in segments.iter().enumerate().skip(first).take(count) {
                let factor = coefficient(symbol, position as u64);
                match lost.iter().position(|&missing| missing == position) {
                    Some(column) => rows[row][column] = factor,
                    None => {
                        add_scaled(&mut value, segment, factor);
                        length ^= scale_length(segment.len() as u16, factor);
                    }
                }
            }
            known.push((value, length));
        }
        let pivots = reduce(&mut rows, &mut combination, symbols.len(), lost.len());
        pivots[..lost.len()]
            .iter()
            .map(|pivot| {
                let row = (*pivot)? as usize;
                let (mut value, mut length) = (Vec::new(), 0);
                for (index, (data, known_length)) in known.iter().enumerate() {
                    add_scaled(&mut value, data, combination[row][index]);
                    length ^= scale_length(*known_length, combination[row][index]);
                }
                Some((value, length))
            })
            .collect()
    }

    /// 覆盖同一段分片时，丢任意几个，校验包任取同样多个，都能解回来。
    #[test]
    fn any_lost_segments_can_be_rebuilt_from_any_parity_subset() {
        let segments = segments();
        for lost_mask in 1u32..256 {
            let lost: Vec<usize> = (0..8).filter(|bit| lost_mask >> bit & 1 == 1).collect();
            for parity_mask in 1u32..256 {
                if parity_mask.count_ones() as usize != lost.len() {
                    continue;
                }
                let symbols: Vec<(u8, usize, usize)> = (0..8).filter(|bit| parity_mask >> bit & 1 == 1).map(|bit| (bit as u8 * 17, 0, 8)).collect();
                for (column, solved) in solve(&segments, &lost, &symbols).into_iter().enumerate() {
                    let (value, length) = solved.expect("enough parity");
                    let want = &segments[lost[column]];
                    assert_eq!(length as usize, want.len(), "lost {lost:?} parity {parity_mask:b}");
                    assert_eq!(&value[..want.len()], &want[..], "lost {lost:?} parity {parity_mask:b}");
                }
            }
        }
    }

    /// 覆盖范围部分重叠时，能解的先解：不能因为后面还缺着，就把前面能修的也卡住。
    #[test]
    fn overlapping_parity_solves_what_it_can() {
        let segments = segments();
        let solved = solve(&segments, &[1, 6, 7], &[(3, 0, 4)]);
        assert_eq!(solved[1], None);
        assert_eq!(solved[2], None);
        let (value, length) = solved[0].clone().expect("only one unknown in range");
        assert_eq!(length as usize, segments[1].len());
        assert_eq!(&value[..segments[1].len()], &segments[1][..]);

        let solved = solve(&segments, &[1, 6, 7], &[(3, 0, 4), (4, 4, 4)]);
        assert!(solved[0].is_some() && solved[1].is_none() && solved[2].is_none());
        let solved = solve(&segments, &[1, 6, 7], &[(3, 0, 4), (4, 4, 4), (5, 2, 6)]);
        assert!(solved.iter().all(Option::is_some));
    }

    #[test]
    fn repair_share_stays_just_above_the_loss_rate() {
        for loss in [5_000u32, 10_000, 50_000, 150_000] {
            let share = |spare| 1_000_000 / (repair_interval(loss, spare) as u64 + 1);
            assert!(share(false) > loss as u64 && share(false) <= share(true), "{loss}");
            assert!(share(false) < loss as u64 * 2 + 30_000, "{loss}");
        }
        assert_eq!(repair_interval(0, true), MAX_INTERVAL as u32);
        assert_eq!(repair_interval(0, false), LEAN_MAX_INTERVAL as u32);
    }
}
