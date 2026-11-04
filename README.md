# 内部账目管理平台

记录 30 家公司主体的每一笔资金流转：以项目为单位管理，公户、个人卡、现金逐笔强制溯源，资金链可从任意一笔来款追到最终去向。需求见 [docs/需求方案.md](docs/需求方案.md)，部署见 [docs/部署与运维.md](docs/部署与运维.md)。

## 目录

```
shared/   前后端共用：数据模型、溯源分配与资金链计算、Excel 模板 / 解析 / 导出、导入校验、税负测算
server/   后端：Fastify + postgres.js；业务服务、接口、集成测试
web/      前端：React + Ant Design + ECharts
db/       数据库迁移脚本（关键规则由触发器在数据库层保证）
scripts/  备份 / 恢复脚本
```

## 本地开发

需要 Node 22、Docker。

```bash
npm install
npm run db:up                    # 启动 PostgreSQL（端口 5433，含测试库 ledger_test）
npm run seed                     # 迁移 + 载入演示数据（清空后重新载入：npm run seed:reset）
npm run dev:server               # 后端 http://localhost:8090
npm run dev:web                  # 前端 http://localhost:5173（/api 转发到 8090）
```

演示账号：`admin / admin123`（管理员）、`caiwu / demo1234`（财务）、`boss / demo1234`（只读）。

```bash
npm test                         # 后端集成测试（连接 ledger_test，每个测试文件前清空重建）
npm run typecheck                # 三个包的类型检查
```

## 数据可靠性

- 金额在程序中以"分"为整数，数据库为 `numeric(18,2)`，全程不经过浮点。
- 流水保存即生效，账务字段不可修改、不可删除，只能冲销（记一笔反向分录，保留原记录）。
- 由数据库触发器保证、应用程序无法绕过：
  - 分摊合计 = 金额；强制溯源账户的出款来源合计 = 金额；
  - 资金来源不能超额使用、不能使用出款日之后才到的钱；
  - 被下游使用的入款不能先冲销；已结账月份不能记账；
  - 分录、审计日志只追加。
- 出款分配来源时对候选资金批次加行锁，并发出款不会超额。
- 每天凌晨自动自检（余额 = 分录合计、溯源账户余额 = 未用完入款合计、来源合计 = 出款金额、按流水重算余额）并备份。
