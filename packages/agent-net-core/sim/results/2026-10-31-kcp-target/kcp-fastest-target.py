#!/usr/bin/env python3
"""Check a matrix file against target T: per scenario vs the fastest KCP config: time<=+1%, bytes<=+1%, latency<=envelope+1%."""
import sys
src=open(sys.argv[1]).read().split('\nkcp = parse')[0]
ns={}; exec(src, ns)
kcp=ns['parse'](sys.argv[2]); me_all=ns['parse'](sys.argv[3])
fails=[]
for key in sorted(me_all):
    me=me_all[key]['agent-net']; ks=kcp.get(key)
    if not ks: continue
    fastest=min(ks.items(), key=lambda kv: kv[1][0])
    r=[]
    if me[0] > fastest[1][0]*1.01: r.append(f"用时 {me[0]:.0f}>{fastest[1][0]:.0f}")
    if me[1] > fastest[1][1]*1.01: r.append(f"字节 {me[1]:.1f}>{fastest[1][1]:.1f}")
    for i,n in [(2,'p50'),(3,'p95'),(4,'p99')]:
        b=min(v[i] for v in ks.values())
        if me[i] > b*1.01: r.append(f"{n} {me[i]:.1f}>{b:.1f}")
    if r: fails.append(f"  {key[0]} {key[1]} [{fastest[0]}]: "+'; '.join(r))
print(f"未达标 {len(fails)}/{len(me_all)}"); print('\n'.join(fails))
