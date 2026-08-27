const { DatabaseSync } = require('node:sqlite');
const dbPath = process.argv[2] || '.codegraph/codegraph.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
console.log('nodes', db.prepare('select count(*) c from nodes').get().c);
console.log('edges', db.prepare('select count(*) c from edges').get().c);
for (const r of db.prepare('select kind, count(*) c from edges group by kind order by c desc').all()) console.log('  edge', r.kind, r.c);
for (const r of db.prepare('select kind, count(*) c from nodes group by kind order by c desc').all()) console.log('  node', r.kind, r.c);
