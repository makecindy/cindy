//! Loopback-only player adapter. The host supplies authenticated plaintext in
//! bounded blocks; no network credential, remote URL or media key enters here.
use std::{collections::{BTreeMap, VecDeque}, io::{Read, Write}, net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc::{self, SyncSender}}, thread, time::Duration};
use serde_json::{Value, json};
use crate::{bytes, crypto::NativeCrypto, encoded, text};

const BLOCK: u64 = 1024 * 1024;
struct Ticket { length: usize, sender: SyncSender<Result<Vec<u8>, ()>> }
#[derive(Clone)]
struct Request { id: u64, start: u64, end: u64 }
struct Shared {
    stopped: AtomicBool, sequence: AtomicU64,
    clients: Mutex<BTreeMap<u64, TcpStream>>,
    requests: Mutex<VecDeque<Request>>, tickets: Mutex<BTreeMap<u64, Ticket>>,
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
        let shared = Arc::new(Shared { stopped: AtomicBool::new(false), sequence: AtomicU64::new(1),
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
        Ok((Self { shared, address }, json!({"url":url})))
    }
    pub fn command(&self, command: &Value) -> Result<Value, &'static str> {
        match text(command, "op")? {
            "httpMediaPoll" => {
                let requests: Vec<_> = self.shared.requests.lock().unwrap().drain(..).collect();
                let tickets = self.shared.tickets.lock().unwrap();
                Ok(json!(requests.into_iter().filter(|r| tickets.contains_key(&r.id)).map(|r|
                    json!({"id":r.id,"start":r.start,"end":r.end})).collect::<Vec<_>>()))
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
        state.tickets.lock().unwrap().insert(id, Ticket { length: (to - start + 1) as usize, sender });
        state.requests.lock().unwrap().push_back(Request { id, start, end: to });
        let result = receiver.recv_timeout(Duration::from_secs(30));
        state.tickets.lock().unwrap().remove(&id);
        let Ok(Ok(data)) = result else { break; };
        stream.write_all(&data)?; start = to + 1;
    }
    Ok(())
}
