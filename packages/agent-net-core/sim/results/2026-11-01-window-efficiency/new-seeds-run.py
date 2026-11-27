import re,sys,subprocess
from concurrent.futures import ThreadPoolExecutor
R='<home>/Documents/Cindy/cindy/.cindy-worktrees/agent-net/packages/agent-net-core/sim/results'
src=open(R+'/2026-11-01-first-rtt/dominance.py').read().split('\nkcp = parse')[0]
ns={}; exec(src,ns)
kcp=ns['parse'](R+'/2026-10-31-optimization/network-v2/kcp-reference-merged.txt')
n,first=sys.argv[1],sys.argv[2]
jobs=[]
for (w,sc),peers in kcp.items():
    f=min(peers.items(),key=lambda kv:kv[1][0])
    jobs.append((sc.strip(),str(w),f[0]))
def go(j):
    r=subprocess.run(['./bins/hold-F1',j[0],j[1],j[2],n,first],capture_output=True,text=True)
    return r.stdout.strip() or ('ERR '+str(j)+r.stderr[-200:])
with ThreadPoolExecutor(9) as ex:
    rows=list(ex.map(go,jobs))
fails=[]
for r in sorted(rows):
    print(r)
    p=r.split('\t')
    if len(p)==7:
        t,o,k,ko=map(float,(p[3],p[4],p[5],p[6]))
        if t>k or o>ko: fails.append(f"{p[0]} {p[1]} [{p[2]}] 用时 {t:.0f}/{k:.0f} ({(t/k-1)*100:+.2f}%) 字节 {o:.1f}/{ko:.1f}")
print('未超过',len(fails),'/',len(rows))
print('\n'.join(fails))
