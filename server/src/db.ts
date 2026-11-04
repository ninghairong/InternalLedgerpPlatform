import postgres from 'postgres';
import { config } from './config';

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

export function connect(url = config.databaseUrl): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    // date 保持 YYYY-MM-DD 文本，避免时区换算；numeric / int8 默认返回字符串，由业务层转成"分"
    types: {
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  }) as unknown as Sql;
}

export const sql = connect();
