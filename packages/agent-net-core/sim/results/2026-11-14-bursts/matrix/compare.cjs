const fs = require('fs');
const [a, b] = process.argv.slice(2).map((f) => fs.readFileSync(f, 'utf8').split('\n'));
function parse(lines) {
  const rows = []; let label = '', win = '';
  for (const l of lines) {
    if (l.startsWith('=== 窗口')) win = l.match(/\d+/)[0];
    else if (l.startsWith('  agent-net')) {
      const n = (re) => { const m = l.match(re); return m ? Number(m[1]) : NaN; };
      rows.push({ key: win + ' ' + label, finish: n(/用时\s*([\d.]+|inf)ms/), over: n(/开销\s*([\d.-]+)%/), p95: n(/p95\s*([\d.]+)/), p99: n(/p99\s*([\d.]+)/), bad: /未完成|未送达/.test(l) ? l.slice(l.indexOf('交互字节')) : '' });
    } else if (l.trim() && !l.startsWith('agent-net') && !l.startsWith('test') && !l.startsWith('running')) label = l.trim();
  }
  return rows;
}
const A = parse(a), B = parse(b);
let logSum = 0, n = 0, better = 0, worse = 0;
for (let i = 0; i < A.length; i++) {
  const x = A[i], y = B[i];
  const r = y.finish / x.finish;
  if (Number.isFinite(r)) { logSum += Math.log(r); n++; }
  if (r < 0.99) better++; else if (r > 1.01) worse++;
  const flag = r > 1.03 || y.over > x.over * 1.1 + 1 || y.p99 > x.p99 * 1.1 + 1 || y.bad ? ' <<' : (r < 0.97 ? ' ++' : '');
  if (flag || process.env.ALL) console.log(`${y.key.padEnd(40)} 用时 ${x.finish}→${y.finish} (${((r - 1) * 100).toFixed(1)}%) 开销 ${x.over}→${y.over} p99 ${x.p99}→${y.p99}${y.bad ? ' ' + y.bad : ''}${flag}`);
}
console.log(`用时几何平均 ${((Math.exp(logSum / n) - 1) * 100).toFixed(2)}%  快>1%: ${better}  慢>1%: ${worse}  共 ${A.length}`);
