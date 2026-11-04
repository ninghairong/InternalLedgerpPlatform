// 命令行：migrate | seed [--reset]
import { sql } from './db';
import { migrate } from './migrate';
import { ensureBaseData } from './bootstrap';
import { loadDemo, resetDatabase } from './demo';

const [cmd, ...args] = process.argv.slice(2);

try {
  await migrate(sql);
  if (cmd === 'migrate') {
    await ensureBaseData(sql);
  } else if (cmd === 'seed') {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM flow`;
    if (n && !args.includes('--reset')) {
      console.error(`数据库中已有 ${n} 笔流水。如确定要清空并载入演示数据，请执行：npm run seed -- --reset`);
      process.exitCode = 1;
    } else {
      if (args.includes('--reset')) await resetDatabase(sql);
      await loadDemo(sql);
      console.log('演示账号：admin / admin123（管理员）、caiwu / demo1234（财务）、boss / demo1234（只读）');
    }
  } else {
    console.error('用法：cli migrate | seed [--reset]');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
