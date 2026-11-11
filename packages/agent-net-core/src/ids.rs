//! 加密通道内交换的连接号。完整快照带代次并单独确认，重传和乱序都不会复活已作废的号。

use alloc::vec;
use alloc::vec::Vec;

use crate::connection::PacketError;

pub(crate) const MAX_IDS: usize = 8;
const UPDATE: u8 = 10;
const ACK: u8 = 11;
const UPDATE_HEADER: usize = 11;
const ACK_LEN: usize = 9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Id {
    sequence: u32,
    value: u32,
}

struct Route {
    path: u64,
    sequence: u32,
    /// 号不够时先沿用原号，新号到了以后再换。
    waiting: bool,
}

pub(crate) struct ConnectionIds {
    local: Vec<Id>,
    next_sequence: u32,
    remote: Vec<Id>,
    remote_generation: u64,
    remote_max_sequence: u32,
    routes: Vec<Route>,
    /// 还没在对端的新快照里消失的作废号。不收到新快照就不能忘，确认包可能先到。
    retired: Vec<u32>,
    generation: u64,
    sent_generation: u64,
    due_at: Option<u64>,
    ack: Option<u64>,
}

impl ConnectionIds {
    pub(crate) fn new(local: u32) -> Self {
        Self {
            local: vec![Id { sequence: 0, value: local }],
            next_sequence: 1,
            remote: Vec::new(),
            remote_generation: 0,
            remote_max_sequence: 0,
            routes: Vec::new(),
            retired: Vec::new(),
            generation: 0,
            sent_generation: 0,
            due_at: None,
            ack: None,
        }
    }

    pub(crate) fn set_remote(&mut self, value: u32) {
        self.remote = vec![Id { sequence: 0, value }];
        self.routes = vec![Route { path: 0, sequence: 0, waiting: false }];
    }

    pub(crate) fn handshake_path(&mut self, path: u64) {
        if let Some(route) = self.routes.first_mut() {
            route.path = path;
        }
    }

    pub(crate) fn local_ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.local.iter().map(|id| id.value)
    }

    pub(crate) fn accepts(&self, value: u32) -> bool {
        self.local_ids().any(|id| id == value)
    }

    fn changed(&mut self) {
        self.generation += 1;
        self.due_at = Some(0);
    }

    pub(crate) fn add(&mut self, value: u32) -> bool {
        if value == 0 || self.accepts(value) || self.local.len() == MAX_IDS || self.next_sequence == u32::MAX {
            return false;
        }
        self.local.push(Id { sequence: self.next_sequence, value });
        self.next_sequence += 1;
        self.changed();
        true
    }

    /// 当前路径第一次用号，或换网以后给它换号。返回（线上号，是否换号，是否号不够）。
    pub(crate) fn address(&mut self, path: u64, rotate: bool) -> (u32, bool, bool) {
        let index = self.routes.iter().position(|route| route.path == path);
        if let Some(index) = index
            && !rotate && !self.routes[index].waiting
        {
            let sequence = self.routes[index].sequence;
            let id = self.remote.iter().find(|id| id.sequence == sequence).expect("live route has an id");
            return (id.value, false, false);
        }
        let fresh = self.remote.iter().find(|id| !self.retired.contains(&id.sequence) && !self.routes.iter().any(|route| route.sequence == id.sequence)).copied();
        if let Some(id) = fresh {
            let previous = index.map(|index| self.routes[index].sequence);
            if let Some(index) = index {
                self.routes[index].sequence = id.sequence;
                self.routes[index].waiting = false;
            } else {
                self.routes.push(Route { path, sequence: id.sequence, waiting: false });
            }
            if let Some(sequence) = previous {
                self.retire_if_unused(sequence);
            }
            return (id.value, true, false);
        }
        if let Some(index) = index {
            let route = &mut self.routes[index];
            let exhausted = !route.waiting;
            route.waiting = true;
            let value = self.remote.iter().find(|id| id.sequence == route.sequence).expect("live route has an id").value;
            return (value, false, exhausted);
        }
        let id = self.remote.iter().find(|id| !self.retired.contains(&id.sequence)).copied().expect("at least one live id");
        self.routes.push(Route { path, sequence: id.sequence, waiting: true });
        (id.value, false, true)
    }

    pub(crate) fn rotate(&mut self) -> (u64, u64) {
        let paths: Vec<_> = self.routes.iter().map(|route| route.path).collect();
        let (mut rotations, mut exhausted) = (0, 0);
        for path in paths {
            let (_, changed, missing) = self.address(path, true);
            rotations += u64::from(changed);
            exhausted += u64::from(missing);
        }
        (rotations, exhausted)
    }

    /// 没在用的号不能分给另一条路径：见过该号的旁观者会把两个地址对上。
    /// 从没用过的备用号保留；已用过且离开路径的号发通知作废。
    pub(crate) fn retain_paths(&mut self, mut keep: impl FnMut(u64) -> bool) {
        let mut index = 0;
        while index < self.routes.len() {
            if keep(self.routes[index].path) {
                index += 1;
            } else {
                let old = self.routes.remove(index);
                self.retire_if_unused(old.sequence);
            }
        }
    }

    fn retire_if_unused(&mut self, sequence: u32) {
        if !self.routes.iter().any(|route| route.sequence == sequence) && !self.retired.contains(&sequence) {
            self.retired.push(sequence);
            self.changed();
        }
    }

    pub(crate) fn is_frame(frame: &[u8]) -> bool {
        matches!(frame.first(), Some(&UPDATE | &ACK))
    }

    /// 只在认证、重放检查之后调用。先验证完整快照，再改本地状态。
    pub(crate) fn receive(&mut self, frame: &[u8], destination: u32) -> Result<u64, PacketError> {
        let generation = u64::from_be_bytes(frame.get(1..9).ok_or(PacketError::Malformed)?.try_into().map_err(|_| PacketError::Malformed)?);
        if generation == 0 {
            return Err(PacketError::Malformed);
        }
        if frame[0] == ACK {
            if frame.len() != ACK_LEN || generation > self.sent_generation {
                return Err(PacketError::Malformed);
            }
            if generation == self.generation {
                self.due_at = None;
            }
            return Ok(0);
        }
        let count = *frame.get(9).ok_or(PacketError::Malformed)? as usize;
        let retired_count = *frame.get(10).ok_or(PacketError::Malformed)? as usize;
        if !(1..=MAX_IDS).contains(&count) || retired_count > MAX_IDS || frame.len() != UPDATE_HEADER + count * 8 + retired_count * 4 {
            return Err(PacketError::Malformed);
        }
        let mut ids = Vec::with_capacity(count);
        for entry in frame[UPDATE_HEADER..UPDATE_HEADER + count * 8].as_chunks::<8>().0 {
            let sequence = u32::from_be_bytes(entry[..4].try_into().map_err(|_| PacketError::Malformed)?);
            let value = u32::from_be_bytes(entry[4..].try_into().map_err(|_| PacketError::Malformed)?);
            if (value == 0 && sequence != 0) || ids.iter().any(|id: &Id| id.sequence >= sequence || id.value == value) {
                return Err(PacketError::Malformed);
            }
            ids.push(Id { sequence, value });
        }
        let retired: Vec<_> = frame[UPDATE_HEADER + count * 8..].as_chunks::<4>().0.iter().map(|bytes| u32::from_be_bytes(*bytes)).collect();
        if generation <= self.remote_generation {
            self.ack = Some(self.remote_generation);
            return Ok(0);
        }
        for id in &ids {
            match self.remote.iter().find(|known| known.sequence == id.sequence) {
                Some(known) if known.value == id.value => {}
                None if id.sequence > self.remote_max_sequence => {}
                _ => return Err(PacketError::Malformed),
            }
        }
        if self.routes.iter().any(|route| !ids.iter().any(|id| id.sequence == route.sequence))
            || retired.iter().any(|sequence| *sequence >= self.next_sequence || self.local.iter().any(|id| id.sequence == *sequence && id.value == destination))
            || self.local.iter().all(|id| retired.contains(&id.sequence))
        {
            return Err(PacketError::Malformed);
        }
        self.remote_max_sequence = self.remote_max_sequence.max(ids.last().expect("nonempty ids").sequence);
        self.remote = ids;
        self.remote_generation = generation;
        self.ack = Some(generation);
        let retired_before = self.retired.len();
        self.retired.retain(|sequence| self.remote.iter().any(|id| id.sequence == *sequence));
        let before = self.local.len();
        self.local.retain(|id| !retired.contains(&id.sequence));
        let removed = (before - self.local.len()) as u64;
        if removed > 0 || retired_before != self.retired.len() {
            self.changed();
        }
        Ok(removed)
    }

    pub(crate) fn next_wake(&self) -> Option<u64> {
        if self.ack.is_some() { Some(0) } else { self.due_at }
    }

    /// 返回（明文帧长，是否重传）。最大 107 字节，最小握手 MTU 也放得下。
    pub(crate) fn write(&mut self, now_us: u64, retry_us: u64, out: &mut [u8]) -> Option<(usize, bool)> {
        if let Some(generation) = self.ack.take() {
            out[0] = ACK;
            out[1..ACK_LEN].copy_from_slice(&generation.to_be_bytes());
            return Some((ACK_LEN, false));
        }
        if !self.due_at.is_some_and(|at| at <= now_us) {
            return None;
        }
        out[0] = UPDATE;
        out[1..9].copy_from_slice(&self.generation.to_be_bytes());
        out[9] = self.local.len() as u8;
        out[10] = self.retired.len() as u8;
        let mut at = UPDATE_HEADER;
        for id in &self.local {
            out[at..at + 4].copy_from_slice(&id.sequence.to_be_bytes());
            out[at + 4..at + 8].copy_from_slice(&id.value.to_be_bytes());
            at += 8;
        }
        for sequence in &self.retired {
            out[at..at + 4].copy_from_slice(&sequence.to_be_bytes());
            at += 4;
        }
        let retransmission = self.sent_generation == self.generation;
        self.sent_generation = self.generation;
        self.due_at = Some(now_us + retry_us);
        Some((at, retransmission))
    }
}
