//! kcp-go / kcptun 的前向纠错层，只用来给 KCP 对比加上它最常见的部署方式，不进入产品。
//!
//! 格式照 kcp-go：每个包前加 `[分片号 4][类型 2]`，数据片再加 `[长度 2]`（含这两个字节本身）。
//! 每凑够 `data` 个数据片，生成 `parity` 个 Reed-Solomon 校验片；同组收到任意 `data` 片就能还原其余数据片。
//! kcptun 默认 10 + 3。和 kcp-go 一样，凑不满一组时不发校验片，也没有超时补发。
//!
//! 编码矩阵用 [单位阵; Cauchy 阵]，任意 `data` 行都可逆，和 kcp-go 用的 klauspost/reedsolomon 恢复能力相同。

use std::collections::BTreeMap;

const TYPE_DATA: u16 = 0xf1;
const TYPE_PARITY: u16 = 0xf2;
pub const HEADER_LEN: usize = 6;
/// 数据片比校验片多两字节长度，KCP 的 MTU 要扣掉这么多。
pub const DATA_HEADER_LEN: usize = HEADER_LEN + 2;
/// 接收方保留最近这么多组，足够覆盖重排序，内存也有上限。
const KEPT_GROUPS: u32 = 64;

struct Field {
    exp: [u8; 512],
    log: [u8; 256],
}

impl Field {
    fn new() -> Self {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut value: u16 = 1;
        for power in 0..255 {
            exp[power] = value as u8;
            log[value as usize] = power as u8;
            value <<= 1;
            if value & 0x100 != 0 {
                value ^= 0x11d;
            }
        }
        for power in 255..512 {
            exp[power] = exp[power - 255];
        }
        Self { exp, log }
    }

    fn mul(&self, a: u8, b: u8) -> u8 {
        if a == 0 || b == 0 { 0 } else { self.exp[self.log[a as usize] as usize + self.log[b as usize] as usize] }
    }

    fn inv(&self, a: u8) -> u8 {
        self.exp[255 - self.log[a as usize] as usize]
    }
}

struct Codec {
    field: Field,
    data: usize,
    parity: usize,
}

impl Codec {
    /// 编码矩阵第 `row` 行：前 `data` 行是单位阵，之后是 Cauchy 阵 `1 / (x ^ y)`，x 和 y 取不同的值。
    fn coefficient(&self, row: usize, column: usize) -> u8 {
        if row < self.data {
            return (row == column) as u8;
        }
        self.field.inv((row as u8) ^ (column as u8))
    }

    fn encode(&self, shards: &[Vec<u8>], length: usize) -> Vec<Vec<u8>> {
        (0..self.parity)
            .map(|index| {
                let row = self.data + index;
                let mut out = vec![0u8; length];
                for (column, shard) in shards.iter().enumerate() {
                    let factor = self.coefficient(row, column);
                    for (byte, &value) in out.iter_mut().zip(shard) {
                        *byte ^= self.field.mul(factor, value);
                    }
                }
                out
            })
            .collect()
    }

    /// `present` 是已收到的分片（下标、内容），至少 `data` 个。返回缺失的数据片（下标、内容）。
    fn reconstruct(&self, present: &[(usize, &[u8])], length: usize) -> Vec<(usize, Vec<u8>)> {
        let chosen = &present[..self.data];
        let n = self.data;
        let mut matrix: Vec<Vec<u8>> = chosen.iter().map(|&(row, _)| (0..n).map(|column| self.coefficient(row, column)).collect()).collect();
        let mut inverse: Vec<Vec<u8>> = (0..n).map(|row| (0..n).map(|column| (row == column) as u8).collect()).collect();
        for column in 0..n {
            let pivot = (column..n).find(|&row| matrix[row][column] != 0).expect("Cauchy rows are independent");
            matrix.swap(column, pivot);
            inverse.swap(column, pivot);
            let scale = self.field.inv(matrix[column][column]);
            for value in 0..n {
                matrix[column][value] = self.field.mul(matrix[column][value], scale);
                inverse[column][value] = self.field.mul(inverse[column][value], scale);
            }
            for row in 0..n {
                let factor = matrix[row][column];
                if row == column || factor == 0 {
                    continue;
                }
                for value in 0..n {
                    matrix[row][value] ^= self.field.mul(factor, matrix[column][value]);
                    inverse[row][value] ^= self.field.mul(factor, inverse[column][value]);
                }
            }
        }
        let have: Vec<usize> = present.iter().map(|&(index, _)| index).collect();
        (0..n)
            .filter(|index| !have.contains(index))
            .map(|missing| {
                let mut out = vec![0u8; length];
                for (k, &(_, shard)) in chosen.iter().enumerate() {
                    let factor = inverse[missing][k];
                    for (byte, &value) in out.iter_mut().zip(shard) {
                        *byte ^= self.field.mul(factor, value);
                    }
                }
                (missing, out)
            })
            .collect()
    }
}

#[derive(Default)]
struct Group {
    shards: BTreeMap<usize, Vec<u8>>,
    done: bool,
}

pub struct Fec {
    codec: Codec,
    next_seq: u32,
    pending: Vec<Vec<u8>>,
    groups: BTreeMap<u32, Group>,
    newest_group: u32,
}

impl Fec {
    pub fn new(data: usize, parity: usize) -> Self {
        assert!(data + parity <= 128, "shard indices must stay below the Cauchy x values");
        Self { codec: Codec { field: Field::new(), data, parity }, next_seq: 0, pending: Vec::new(), groups: BTreeMap::new(), newest_group: 0 }
    }

    fn group_size(&self) -> u32 {
        (self.codec.data + self.codec.parity) as u32
    }

    /// 给一个 KCP 包加头，凑满一组时附带校验片。
    pub fn encode(&mut self, packet: &[u8], out: &mut Vec<Vec<u8>>) {
        let mut shard = Vec::with_capacity(packet.len() + 2);
        shard.extend_from_slice(&((packet.len() + 2) as u16).to_le_bytes());
        shard.extend_from_slice(packet);
        out.push(self.frame(TYPE_DATA, &shard));
        self.pending.push(shard);
        if self.pending.len() == self.codec.data {
            let length = self.pending.iter().map(Vec::len).max().unwrap_or(0);
            for parity in self.codec.encode(&self.pending, length) {
                out.push(self.frame(TYPE_PARITY, &parity));
            }
            self.pending.clear();
        }
    }

    fn frame(&mut self, kind: u16, body: &[u8]) -> Vec<u8> {
        let mut packet = Vec::with_capacity(HEADER_LEN + body.len());
        packet.extend_from_slice(&self.next_seq.to_le_bytes());
        packet.extend_from_slice(&kind.to_le_bytes());
        packet.extend_from_slice(body);
        self.next_seq = self.next_seq.wrapping_add(1);
        packet
    }

    /// 处理一个收到的包，把能交给 KCP 的内容（原包或还原出的包）放进 `out`。
    pub fn decode(&mut self, packet: &[u8], out: &mut Vec<Vec<u8>>) {
        if packet.len() < HEADER_LEN {
            return;
        }
        let seq = u32::from_le_bytes([packet[0], packet[1], packet[2], packet[3]]);
        let kind = u16::from_le_bytes([packet[4], packet[5]]);
        let body = &packet[HEADER_LEN..];
        let group_id = seq / self.group_size();
        let index = (seq % self.group_size()) as usize;
        if group_id + KEPT_GROUPS <= self.newest_group {
            // 太旧的组已经丢弃，数据片照样交给 KCP。
            if kind == TYPE_DATA {
                Self::unwrap_data(body, out);
            }
            return;
        }
        self.newest_group = self.newest_group.max(group_id);
        while let Some((&oldest, _)) = self.groups.first_key_value() {
            if oldest + KEPT_GROUPS > self.newest_group {
                break;
            }
            self.groups.pop_first();
        }
        let data = self.codec.data;
        let group = self.groups.entry(group_id).or_default();
        if group.shards.contains_key(&index) {
            return;
        }
        if kind == TYPE_DATA {
            Self::unwrap_data(body, out);
        } else if kind != TYPE_PARITY {
            return;
        }
        group.shards.insert(index, body.to_vec());
        if group.done || group.shards.len() < data || (0..data).all(|i| group.shards.contains_key(&i)) {
            return;
        }
        group.done = true;
        let length = group.shards.values().map(Vec::len).max().unwrap_or(0);
        let padded: Vec<(usize, Vec<u8>)> = group
            .shards
            .iter()
            .map(|(&i, shard)| {
                let mut shard = shard.clone();
                shard.resize(length, 0);
                (i, shard)
            })
            .collect();
        let present: Vec<(usize, &[u8])> = padded.iter().map(|(i, shard)| (*i, shard.as_slice())).collect();
        for (index, shard) in self.codec.reconstruct(&present, length) {
            Self::unwrap_data(&shard, out);
            // 记下来，原片晚到时不再重复交给 KCP。
            group.shards.insert(index, shard);
        }
    }

    fn unwrap_data(shard: &[u8], out: &mut Vec<Vec<u8>>) {
        if shard.len() < 2 {
            return;
        }
        let size = u16::from_le_bytes([shard[0], shard[1]]) as usize;
        if size >= 2 && size <= shard.len() {
            out.push(shard[2..size].to_vec());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一组 13 片里任意丢 3 片，都能还原出全部 10 个数据片。
    #[test]
    fn any_three_losses_recover() {
        let packets: Vec<Vec<u8>> = (0..10u8).map(|i| (0..(50 + i as usize * 37)).map(|j| (j as u8).wrapping_mul(i + 3)).collect()).collect();
        let mut encoder = Fec::new(10, 3);
        let mut wire = Vec::new();
        for packet in &packets {
            encoder.encode(packet, &mut wire);
        }
        assert_eq!(wire.len(), 13);
        for a in 0..13 {
            for b in a + 1..13 {
                for c in b + 1..13 {
                    let mut decoder = Fec::new(10, 3);
                    let mut got = Vec::new();
                    for (index, packet) in wire.iter().enumerate() {
                        if index != a && index != b && index != c {
                            decoder.decode(packet, &mut got);
                        }
                    }
                    got.sort();
                    let mut want = packets.clone();
                    want.sort();
                    assert_eq!(got, want, "lost {a} {b} {c}");
                }
            }
        }
    }
}
