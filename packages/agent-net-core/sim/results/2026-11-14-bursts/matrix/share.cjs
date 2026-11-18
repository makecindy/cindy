const fs = require('fs');
const [a, b] = process.argv.slice(2).map((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('公平 ') && l.includes('利用率')));
const num = (l, re) => Number((l.match(re) || [])[1]);
let fa = 0, fb = 0, ua = 0, ub = 0, qa = 0, qb = 0, la = 0, lb = 0;
for (let i = 0; i < a.length; i++) {
  const x = a[i], y = b[i];
  const [f1, f2] = [num(x, /公平 ([\d.]+)/), num(y, /公平 ([\d.]+)/)];
  const [u1, u2] = [num(x, /利用率\s*(\d+)%/), num(y, /利用率\s*(\d+)%/)];
  const [q1, q2] = [num(x, /排队\s*([\d.]+)ms/), num(y, /排队\s*([\d.]+)ms/)];
  const [l1, l2] = [num(x, /丢包 ([\d.]+)%/), num(y, /丢包 ([\d.]+)%/)];
  fa += f1; fb += f2; ua += u1; ub += u2; qa += q1; qb += q2; la += l1; lb += l2;
  if (f2 < f1 - 0.05 || u2 < u1 - 2 || q2 > q1 * 1.3 + 2 || l2 > l1 * 1.3 + 0.3) console.log('<< ' + x.slice(0, 40).trim() + ` 公平 ${f1}→${f2} 利用率 ${u1}→${u2} 排队 ${q1}→${q2} 丢包 ${l1}→${l2}`);
}
const n = a.length;
console.log(`${n} 行 平均：公平 ${(fa / n).toFixed(3)}→${(fb / n).toFixed(3)} 利用率 ${(ua / n).toFixed(1)}→${(ub / n).toFixed(1)} 排队 ${(qa / n).toFixed(1)}→${(qb / n).toFixed(1)}ms 丢包 ${(la / n).toFixed(2)}→${(lb / n).toFixed(2)}%`);
