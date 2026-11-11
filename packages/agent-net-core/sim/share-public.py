#!/usr/bin/env python3
"""真实公网上和真实 TCP 同跑。TCP 是 SSH 传的数据，用的是操作系统自带的拥塞控制。

用法：sim/share-public.py 用户@服务器 客户端公网地址 服务器上的muxperf 本机的muxperf [轮数] [秒数] [fair]
末尾写 fair 时 agent-net 用让路模式，默认全速。
客户端公网地址写 stun 时用 STUN 自动查映射，要求 NAT 对不同目的地映射同一个端口；运营商网络通常不满足，打不了洞。
每轮按 只有TCP、只有agent-net、同跑、两条TCP 的顺序跑，上传下载各一遍，打印平均速度。
"""
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time

HOST, PEER, REMOTE_BIN, LOCAL_BIN = sys.argv[1:5]
ROUNDS = int(sys.argv[5]) if len(sys.argv) > 5 else 3
SECONDS = int(sys.argv[6]) if len(sys.argv) > 6 else 15
FAIR = ["--fair"] if len(sys.argv) > 7 and sys.argv[7] == "fair" else []
WARMUP = 3
SERVER_IP = HOST.split("@")[1]
CHUNK = bytes(65536)


def tcp_flow(upload, result, index):
    """跑 SECONDS 秒，头 WARMUP 秒不算。"""
    if upload:
        process = subprocess.Popen(["ssh", "-o", "Compression=no", HOST, "bash -c 'cat > /dev/null'"], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    else:
        process = subprocess.Popen(["ssh", "-o", "Compression=no", HOST, "bash -c 'head -c 4000000000 /dev/zero'"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    started = time.time()
    counted = 0
    try:
        while time.time() - started < SECONDS:
            if upload:
                process.stdin.write(CHUNK)
                process.stdin.flush()
                size = len(CHUNK)
            else:
                size = len(process.stdout.read(65536))
            if time.time() - started >= WARMUP:
                counted += size
    except (BrokenPipeError, OSError):
        pass
    process.kill()
    process.wait()
    result[index] = counted * 8 / (SECONDS - WARMUP) / 1e6


def mapped_address():
    """查本地 47813 端口在 NAT 上的映射。路由器重启或换网络后端口会变，服务器要往这个地址打洞。"""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("0.0.0.0", 47813))
    probe.settimeout(2)
    for attempt in range(6):
        try:
            probe.sendto(struct.pack("!HHI", 1, 0, 0x2112A442) + os.urandom(12), ("stun.cloudflare.com", 3478))
            reply = probe.recvfrom(2048)[0]
            break
        except OSError:
            if attempt == 5:
                raise
    probe.close()
    offset = 20
    while offset + 4 <= len(reply):
        kind, size = struct.unpack("!HH", reply[offset:offset + 4])
        value = reply[offset + 4:offset + 4 + size]
        if kind == 0x20:
            port = struct.unpack("!H", value[2:4])[0] ^ 0x2112
            return ".".join(str(byte ^ mask) for byte, mask in zip(value[4:8], b"\x21\x12\xa4\x42")) + f":{port}"
        offset += 4 + size + (4 - size % 4) % 4
    raise RuntimeError("STUN 回复里没有地址")


def agent_flow(upload, result, index):
    peer = mapped_address() if PEER == "stun" else PEER
    command = f"bash -c 'pkill muxperf; (nohup {REMOTE_BIN} server --bind 0.0.0.0:47812 --peer {peer} --limit {SECONDS + 20} {" ".join(FAIR)} > /dev/null 2>&1 < /dev/null &); echo'"
    subprocess.run(["ssh", HOST, command], stdout=subprocess.DEVNULL)
    time.sleep(0.5)
    output = subprocess.run(
        [LOCAL_BIN, "client", "--bind", "0.0.0.0:47813", "--server", f"{SERVER_IP}:47812", "--rounds", "1", "--seconds", str(SECONDS), "--modes", "3", "--directions", "0" if upload else "1"] + FAIR,
        capture_output=True, text=True,
    ).stdout
    match = re.search(r"文件\s+([\d.]+) Mbit/s", output)
    result[index] = float(match.group(1)) if match else 0.0


def together(flows, upload):
    result = [0.0] * len(flows)
    threads = [threading.Thread(target=flow, args=(upload, result, index)) for index, flow in enumerate(flows)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    time.sleep(1)
    return result


for upload in (False, True):
    label = "上传" if upload else "下载"
    rows = {"只有 TCP": [], "只有 agent-net": [], "同跑 agent-net / TCP": [], "两条 TCP": []}
    for _ in range(ROUNDS):
        rows["只有 TCP"].append(together([tcp_flow], upload))
        rows["只有 agent-net"].append(together([agent_flow], upload))
        rows["同跑 agent-net / TCP"].append(together([agent_flow, tcp_flow], upload))
        rows["两条 TCP"].append(together([tcp_flow, tcp_flow], upload))
    for name, samples in rows.items():
        means = [sum(column) / len(column) for column in zip(*samples)]
        detail = " ; ".join("/".join(f"{value:.1f}" for value in sample) for sample in samples)
        print(f"{label} {name:<20} 平均 {' / '.join(f'{value:.1f}' for value in means):<14} Mbit/s  每轮 {detail}", flush=True)
