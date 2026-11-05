"""公网换端口新旧对比的汇总：每次传输的用时、最长中断、重传（发送方）、超时判丢、服务端换路径次数。"""
import re, sys, pathlib, collections
P = pathlib.Path(sys.argv[1])
def runs(version):
    text = (P / f'client-{version}.txt').read_text(encoding='utf-8', errors='replace')
    out = []
    for block in text.split('## ')[1:]:
        head = block.splitlines()[0]
        name = ' '.join(head.split()[1:-1])
        done = re.search(r'^(done|dead|timeout): (.*)$', block, re.M)
        out.append({'name': name, 'status': done[1] if done else 'missing', 'line': done[2] if done else ''})
    server = (P / f'server-{version}.txt').read_text(encoding='utf-8', errors='replace').splitlines()
    finals = [line for line in server if re.match(r'^[0-9a-f]{8} done:', line)]
    moves = collections.Counter(line.split()[0] for line in server if ' peer moved ' in line)
    for run, final in zip(out, finals):
        run['server'] = final
        run['moves'] = moves.get(final.split()[0], 0)
    return out
def field(line, key):
    m = re.search(rf'{key}=(\S+)', line)
    return m[1] if m else '?'
rows = collections.defaultdict(dict)
for version in ['old', 'new']:
    for run in runs(version):
        upload = run['name'].startswith('上传')
        sender = run['line'] if upload else run.get('server', '')
        seconds = float(field(run.get('server', '') if upload else run['line'], 'seconds'))
        gaps = field(run.get('server', '') if upload else run['line'], 'longest_gaps')
        rows[run['name']][version] = (run['status'], seconds, int(field(sender, 'retransmitted')), int(field(sender, 'timeouts')), run.get('moves', 0), int(field(sender, 'packets_sent')), gaps.split(' ')[0].strip('[]'))
print('| 组合 | 旧版 用时 / 重传 / 超时判丢 / 服务端换过去 | 新版 用时 / 重传 / 超时判丢 / 服务端换过去 | 最长中断 旧 / 新 |')
print('| --- | --- | --- | --- |')
for name, value in rows.items():
    o, n = value.get('old'), value.get('new')
    if not o or not n: continue
    print(f"| {name} | {o[1]:.2f} 秒 / {o[2]} / {o[3]} / {o[4]} | {n[1]:.2f} 秒 / {n[2]} / {n[3]} / {n[4]} | {o[6] or '无'} / {n[6] or '无'} |" + ('' if o[0]=='done' and n[0]=='done' else f' 状态 {o[0]}/{n[0]}'))
