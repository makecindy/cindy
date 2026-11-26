import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {checkMigrationCompatibility} from '@personal/migrations';
const [root, profile] = process.argv.slice(2);
const Database = createRequire(path.join(root,'package.json'))('better-sqlite3');
const names = fs.readdirSync(profile).filter(n => /^cindy-.+\.db$/.test(n)).sort();
if (!names.length) throw Error('No account databases');
const result = [];
for (const name of names) {
  const file = path.join(profile,name), st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw Error('Unexpected database path');
  const db = new Database(file,{readonly:true,fileMustExist:true});
  try {
    const check = checkMigrationCompatibility(db,path.join(root,'apps/desktop/drizzle'),file);
    if (!check.compatible || db.pragma('quick_check',{simple:true}) !== 'ok') throw Error(`Database incompatible: ${name}`);
    result.push({name,version:check.databaseVersion,compatible:true});
  } finally {db.close();}
}
console.log(JSON.stringify({compatible:true,databases:result}));
