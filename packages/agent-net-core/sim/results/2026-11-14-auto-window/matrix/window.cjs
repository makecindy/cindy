const fs = require('fs');
function parse(file) {
  const r = {}; let w = '', lab = '';
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (l.startsWith('=== 窗口')) w = l.match(/\d+/)[0];
    else if (l.startsWith('  agent-net')) { const m = l.match(/用时\s*([\d.]+|inf)ms 开销\s*([\d.-]+|inf)%.*p99\s*([\d.]+)/); (r[lab] ||= {})[w] = m ? m.slice(1).map(Number) : null; }
    else if (l.trim() && !/^(agent-net|test|running|warning|\s)/.test(l)) lab = l.trim();
  }
  return r;
}
const a = parse(process.argv[2]), b = parse(process.argv[3]); const [wa, wb] = [process.argv[4], process.argv[5]];
let s = 0, n = 0, slower = [];
for (const k of Object.keys(a)) {
  const x = a[k]?.[wa], y = b[k]?.[wb]; if (!x || !y) continue;
  const q = y[0] / x[0]; s += Math.log(q); n++;
  const line = `${k.padEnd(36)} 用时 ${x[0]}→${y[0]} (${((q - 1) * 100).toFixed(0)}%) 开销 ${x[1]}→${y[1]}% p99 ${x[2]}→${y[2]}`;
  if (q > 1.01 || y[1] > x[1] * 1.2 + 2 || y[2] > x[2] * 1.05 + 1) slower.push(line); else if (q < 0.9) console.log('++ ' + line);
}
console.log(`几何平均 ${((Math.exp(s / n) - 1) * 100).toFixed(1)}%，共 ${n} 行`); console.log('变差的：'); slower.forEach((l) => console.log('<< ' + l));
