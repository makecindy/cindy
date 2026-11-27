//! Loopback-only player adapter. The host supplies authenticated plaintext in
//! bounded blocks; no network credential, remote URL or media key enters here.
use std::{collections::{BTreeMap, VecDeque}, io::{Read, Write}, net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc::{self, SyncSender}}, thread, time::{Duration, Instant}};
use serde_json::{Value, json};
use crate::{bytes, crypto::NativeCrypto, encoded, text};

const BLOCK: u64 = 1024 * 1024;
const INACTIVITY: Duration = Duration::from_secs(60);
struct Ticket {
    length: usize, sender: SyncSender<Result<Vec<u8>, ()>>,
    queued: bool, loaded: u64, last_progress: Instant,
}
impl Ticket {
    fn update(&mut self, state: &str, loaded: u64, now: Instant) -> Result<(), &'static str> {
        // A 1 MiB HTTP range can straddle two authenticated 1 MiB blocks,
        // each with a 16-byte tag. Wire progress is not plaintext length.
        if loaded > 2 * BLOCK + 32 || loaded < self.loaded || !["queued", "active"].contains(&state) {
            return Err("INVALID_MEDIA_PROGRESS");
        }
        // Only a read that has not received bytes may be put on the file queue.
        if state == "queued" {
            if self.loaded != 0 || loaded != 0 { return Err("INVALID_MEDIA_PROGRESS"); }
            self.queued = true;
        } else {
            if self.queued || loaded > self.loaded { self.last_progress = now; }
            self.queued = false; self.loaded = loaded;
        }
        Ok(())
    }
    fn expired(&self, now: Instant, last_poll: Instant) -> bool {
        now.duration_since(if self.queued { last_poll } else { self.last_progress }) >= INACTIVITY
    }
}
#[derive(Clone)]
struct Request { id: u64, start: u64, end: u64 }
struct Shared {
    stopped: AtomicBool, sequence: AtomicU64, last_poll: Mutex<Instant>,
    clients: Mutex<BTreeMap<u64, TcpStream>>,
    requests: Mutex<VecDeque<Request>>, tickets: Mutex<BTreeMap<u64, Ticket>>,
}
impl Shared {
    fn expired(&self, id: u64, now: Instant) -> bool {
        let last_poll = *self.last_poll.lock().unwrap();
        // Reply owns the sender after removing its ticket, while decoding and
        // handing data to the channel. Absence is not a timeout: recv will
        // deliver that reply or report Disconnected if its validation fails.
        self.tickets.lock().unwrap().get(&id).is_some_and(|t| t.expired(now, last_poll))
    }
}
pub struct MediaHttp { shared: Arc<Shared>, address: SocketAddr }
impl Drop for MediaHttp {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::Release);
        self.shared.tickets.lock().unwrap().clear();
        for stream in self.shared.clients.lock().unwrap().values() { let _ = stream.shutdown(Shutdown::Both); }
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(50));
    }
}
impl MediaHttp {
    pub fn start(command: &Value) -> Result<(Self, Value), &'static str> {
        let size = command["size"].as_u64().filter(|n| *n <= 2 * 1024 * 1024 * 1024).ok_or("INVALID_MEDIA_SIZE")?;
        let content_type = text(command, "contentType")?;
        if content_type.len() > 128 || !content_type.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._+-".contains(&b)) || !content_type.contains('/') {
            return Err("INVALID_MEDIA_CONTENT_TYPE");
        }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "MEDIA_HTTP_BIND_FAILED")?;
        let address = listener.local_addr().map_err(|_| "MEDIA_HTTP_BIND_FAILED")?;
        let port = address.port();
        let token = encoded(&NativeCrypto::random::<32>());
        let path = format!("/{token}");
        let url = format!("http://127.0.0.1:{port}{path}");
        let shared = Arc::new(Shared { stopped: AtomicBool::new(false), sequence: AtomicU64::new(1), last_poll: Mutex::new(Instant::now()),
            clients: Mutex::new(BTreeMap::new()), requests: Mutex::new(VecDeque::new()), tickets: Mutex::new(BTreeMap::new()) });
        let worker = shared.clone(); let content_type = content_type.to_owned();
        thread::spawn(move || {
            while !worker.stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, source)) => {
                        if worker.stopped.load(Ordering::Acquire) { break; }
                        let mut clients = worker.clients.lock().unwrap();
                        if !source.ip().is_loopback() || clients.len() >= 4 {
                            let _ = stream.write_all(b"HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); continue;
                        }
                        let client_id = worker.sequence.fetch_add(1, Ordering::Relaxed);
                        let Ok(copy) = stream.try_clone() else { continue; };
                        clients.insert(client_id, copy); drop(clients);
                        let state = worker.clone(); let path = path.clone(); let kind = content_type.clone();
                        thread::spawn(move || {
                            let _ = serve(&mut stream, &state, size, &kind, &path);
                            let _ = stream.shutdown(Shutdown::Both);
                            state.clients.lock().unwrap().remove(&client_id);
                        });
                    }
                    Err(_) => break,
                }
            }
        });
        Ok((Self { shared, address }, json!({"url":url,"progress":true})))
    }
    pub fn command(&self, command: &Value) -> Result<Value, &'static str> {
        match text(command, "op")? {
            "httpMediaPoll" => {
                let now = Instant::now();
                *self.shared.last_poll.lock().unwrap() = now;
                let requests: Vec<_> = self.shared.requests.lock().unwrap().drain(..).collect();
                let mut tickets = self.shared.tickets.lock().unwrap();
                // Legacy JS has no activity callbacks: dequeue starts its idle budget.
                for r in &requests { if let Some(ticket) = tickets.get_mut(&r.id) {
                    ticket.queued = false; ticket.last_progress = now;
                } }
                if let Some(updates) = command.get("updates") {
                    let updates = updates.as_array().filter(|u| u.len() <= 4).ok_or("INVALID_MEDIA_PROGRESS")?;
                    for update in updates {
                        let id = update["id"].as_u64().ok_or("INVALID_MEDIA_REQUEST")?;
                        let loaded = update["loaded"].as_u64().ok_or("INVALID_MEDIA_PROGRESS")?;
                        if let Some(ticket) = tickets.get_mut(&id) {
                            ticket.update(text(update, "state")?, loaded, now)?;
                        }
                    }
                }
                let requests: Vec<_> = requests.into_iter().filter(|r| tickets.contains_key(&r.id)).map(|r|
                    json!({"id":r.id,"start":r.start,"end":r.end})).collect();
                if command["progress"].as_bool() == Some(true) {
                    let jobs = command["jobs"].as_array().filter(|v| v.len() <= 4).ok_or("INVALID_MEDIA_REQUEST")?;
                    let active: Vec<_> = jobs.iter().filter_map(|id| id.as_u64()).filter(|id| tickets.contains_key(id)).collect();
                    Ok(json!({"requests":requests,"active":active}))
                } else { Ok(json!(requests)) }
            }
            "httpMediaReply" => {
                let id = command["id"].as_u64().ok_or("INVALID_MEDIA_REQUEST")?;
                let Some(ticket) = self.shared.tickets.lock().unwrap().remove(&id) else { return Ok(json!(false)); };
                let data = if command.get("data").is_some() { bytes(&command["data"])? } else {
                    let _ = ticket.sender.send(Err(())); return Ok(json!(true));
                };
                if data.len() != ticket.length { return Err("INVALID_MEDIA_CHUNK"); }
                Ok(json!(ticket.sender.send(Ok(data)).is_ok()))
            }
            _ => Err("UNKNOWN_NATIVE_OPERATION"),
        }
    }
}
fn interval(input: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 { return if input.is_none() { Some((0, 0)) } else { None }; }
    let Some(input) = input else { return Some((0, size - 1)); };
    let (start, end) = input.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let count: u64 = end.parse().ok()?; return (count > 0).then_some((size.saturating_sub(count), size - 1));
    }
    let start: u64 = start.parse().ok()?;
    let end: u64 = if end.is_empty() { size - 1 } else { end.parse().ok()? };
    (start < size && end >= start).then_some((start, end.min(size - 1)))
}
fn serve(stream: &mut TcpStream, state: &Shared, size: u64, kind: &str, path: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut bytes = Vec::new();
    while !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
        let mut buffer = [0; 1024]; let n = stream.read(&mut buffer)?;
        if n == 0 || bytes.len() + n > 8192 { return Ok(()); } bytes.extend_from_slice(&buffer[..n]);
    }
    let Ok(header) = std::str::from_utf8(&bytes) else { return Ok(()); };
    let mut lines = header.split("\r\n"); let parts: Vec<_> = lines.next().unwrap_or("").split(' ').collect();
    if parts.len() != 3 || parts[1] != path || !["GET", "HEAD"].contains(&parts[0]) {
        return stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    let mut range = None;
    for line in lines.take_while(|s| !s.is_empty()) {
        if let Some((key, value)) = line.split_once(':') { if key.eq_ignore_ascii_case("range") {
            if range.is_some() { return Ok(()); } range = Some(value.trim());
        } }
    }
    let Some((mut start, end)) = interval(range, size) else {
        return stream.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
    };
    let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let content_range = if range.is_some() { format!("Content-Range: bytes {start}-{end}/{size}\r\n") } else { String::new() };
    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {length}\r\nContent-Type: {kind}\r\nAccept-Ranges: bytes\r\n{content_range}Cache-Control: no-store\r\nConnection: close\r\n\r\n").as_bytes())?;
    if parts[0] == "HEAD" || size == 0 { return Ok(()); }
    while start <= end && !state.stopped.load(Ordering::Acquire) {
        let to = end.min(start + BLOCK - 1); let id = state.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::sync_channel(1);
        state.tickets.lock().unwrap().insert(id, Ticket { length: (to - start + 1) as usize, sender, queued: true, loaded: 0, last_progress: Instant::now() });
        state.requests.lock().unwrap().push_back(Request { id, start, end: to });
        let result = loop {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(result) => break Some(result),
                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if state.stopped.load(Ordering::Acquire) { break None; }
            let now = Instant::now();
            if state.expired(id, now) { break None; }
            // A cancelled player must not hold a queued read alive just because JS polls.
            stream.set_nonblocking(true)?;
            let disconnected = match stream.peek(&mut [0; 1]) {
                Ok(0) => true,
                Err(error) => error.kind() != std::io::ErrorKind::WouldBlock,
                _ => false,
            };
            stream.set_nonblocking(false)?;
            if disconnected { break None; }
        };
        state.tickets.lock().unwrap().remove(&id);
        state.requests.lock().unwrap().retain(|r| r.id != id);
        let Some(Ok(data)) = result else { break; };
        stream.write_all(&data)?; start = to + 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // #10142: the real ticket policy is independent of elapsed transfer/queue
    // duration. No sleeps: exercise the same Instant-based expiry predicate.
    #[test]
    fn progress_and_queue_have_separate_idle_budgets() {
        let now = Instant::now(); let (sender, _) = mpsc::sync_channel(1);
        let mut ticket = Ticket { length: 16, sender, queued: true, loaded: 0, last_progress: now };
        assert!(!ticket.expired(now + Duration::from_secs(120), now + Duration::from_secs(119)));
        assert!(ticket.expired(now + INACTIVITY, now));
        ticket.update("active", 0, now + Duration::from_secs(120)).unwrap();
        for loaded in 1..=16 {
            let time = now + Duration::from_secs(120 + loaded * 59);
            assert!(!ticket.expired(time, time));
            ticket.update("active", loaded, time).unwrap();
        }
        let last = ticket.last_progress;
        ticket.update("active", 16, last + Duration::from_secs(59)).unwrap();
        assert!(ticket.expired(last + INACTIVITY, last + INACTIVITY));
        assert!(ticket.update("queued", 16, last).is_err());
        assert!(ticket.update("active", 15, last).is_err());
        assert!(ticket.update("active", 2 * BLOCK + 33, last).is_err());
    }
    #[test]
    fn reply_handoff_is_not_mistaken_for_ticket_expiry() {
        let now = Instant::now(); let (sender, receiver) = mpsc::sync_channel(1);
        let state = Shared { stopped: AtomicBool::new(false), sequence: AtomicU64::new(1),
            last_poll: Mutex::new(now), clients: Mutex::new(BTreeMap::new()), requests: Mutex::new(VecDeque::new()),
            tickets: Mutex::new(BTreeMap::from([(1, Ticket { length: 1, sender, queued: false, loaded: 0, last_progress: now })])) };
        assert!(state.expired(1, now + INACTIVITY));
        // Same order as httpMediaReply: claim ticket, decode, then send. A
        // concurrent recv_timeout boundary must keep waiting during the gap.
        let reply = state.tickets.lock().unwrap().remove(&1).unwrap();
        assert!(!state.expired(1, now + INACTIVITY));
        reply.sender.send(Ok(vec![74])).unwrap();
        assert_eq!(receiver.try_recv().unwrap().unwrap(), vec![74]);
    }

}
