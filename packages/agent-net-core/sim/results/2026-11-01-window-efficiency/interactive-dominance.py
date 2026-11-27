import re,sys
R='..'
src=open('dominance.py').read().split('\nkcp = parse')[0]
ns={}; exec(src,ns)
kcp=ns['parse']('../2026-10-31-optimization/network-v2/kcp-reference-merged.txt'); me=ns['parse'](sys.argv[1])
dom=0;rows=[]
for key in sorted(me):
    m=me[key]['agent-net']; ks=kcp[key]
    # idx: 0 time 1 overhead 2 p50 3 p95 4 p99 5 bytes
    d=[n for n,k in ks.items() if k[3]<=m[3] and k[4]<=m[4] and k[5]<=m[5] and k[2]<=m[2]]
    if d: dom+=1
    bp=min(ks.items(),key=lambda kv:(kv[1][4],kv[1][3]))
    rows.append((key,m,d,bp))
for key,m,d,bp in rows:
    if key[0]==128: print(f"{key[1][:24]:<26} 我 p95 {m[3]:7.1f} p99 {m[4]:7.1f} {m[5]:5.0f}K | 尾延迟最好 [{bp[0]}] p95 {bp[1][3]:7.1f} p99 {bp[1][4]:7.1f} {bp[1][5]:5.0f}K | 同时不差的 KCP {d}")
print('存在 KCP 配置在交互四项上都不差于我们的组合数',dom,'/',len(rows))
