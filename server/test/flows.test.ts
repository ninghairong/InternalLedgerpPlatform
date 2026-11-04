import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTraces } from '@ledger/shared/selectors';
import { basicFixture, call, flow, ok, setup, snap, teardown, type Ctx } from './helpers';

let ctx: Ctx;
let fx: Awaited<ReturnType<typeof basicFixture>>;
const post = (url: string, body: unknown, token = ctx.finance) => call(ctx.app, token, 'POST', url, body);
const create = (...flows: unknown[]) => post('/api/flows', { flows });
const balanceOf = async (id: string) => {
  const [r] = await ctx.sql`SELECT balance FROM account_balance WHERE account_id = ${id}`;
  return r ? Math.round(Number(r.balance) * 100) : 0;
};

before(async () => {
  ctx = await setup();
  fx = await basicFixture(ctx);
});
after(() => teardown(ctx));

describe('资金流水与强制溯源', () => {
  it('外部来款进入公户，公户出款按"同项目优先、先进先出"自动分配来源', async () => {
    await ok(create(flow('2026-01-05', 100_000_00, fx.client, fx.corp1, fx.p2, 'c-inc-progress')));
    await ok(create(flow('2026-01-10', 80_000_00, fx.client, fx.corp1, fx.p1, 'c-inc-progress')));
    const r = await ok(create(flow('2026-01-15', 30_000_00, fx.corp1, fx.supplier, fx.p1, 'c-mat-main')));
    const s = await snap(ctx);
    const out = s.flows.find((f) => f.id === r.created[0].id)!;
    const src = s.flows.find((f) => f.id === out.allocations[0].lotFlowId)!;
    assert.equal(out.allocations.length, 1);
    assert.equal(src.splits[0].projectId, fx.p1, '应优先使用项目一的回款，即使项目二的回款更早');
    assert.equal(await balanceOf(fx.corp1), 150_000_00);
  });

  it('可用资金不足时拒绝保存，并给出可用金额', async () => {
    const r = await create(flow('2026-01-16', 999_999_00, fx.corp1, fx.supplier, fx.p1, 'c-mat-main'));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /可用资金 150,000\.00，不足 999,999\.00/);
  });

  it('不能使用出款日期之后才到账的钱', async () => {
    const r = await create(flow('2026-01-01', 10_00, fx.corp1, fx.supplier, fx.p1, 'c-mat-main'));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /可用资金 0\.00/);
  });

  it('手动指定的来源必须是转入该账户的款项，合计必须等于金额', async () => {
    const s = await snap(ctx);
    const corp1Lot = s.flows.find((f) => f.toAccountId === fx.corp1)!.id;
    const wrong = await create(flow('2026-01-20', 10_00, fx.zhang, fx.supplier, fx.p1, 'c-mat-main', { allocations: [{ lotFlowId: corp1Lot, amount: 10_00 }] }));
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.message, /不是转入「张三-工行卡」的款项/);
    const partial = await create(flow('2026-01-20', 20_00, fx.corp1, fx.supplier, fx.p1, 'c-mat-main', { allocations: [{ lotFlowId: corp1Lot, amount: 10_00 }] }));
    assert.equal(partial.status, 400);
    assert.match(partial.body.message, /资金来源合计 10\.00 与金额 20\.00 不一致/);
  });

  it('集团内往来必须填写性质；缴税必须填写税种和所属期', async () => {
    let r = await create(flow('2026-01-20', 1_000_00, fx.corp1, fx.corp2, fx.common1, 'c-cur-ic'));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /集团内往来，须选择往来性质/);
    await ok(create(flow('2026-01-20', 1_000_00, fx.corp1, fx.corp2, fx.common1, 'c-cur-ic', { icNature: 'LOAN' })));
    r = await create(flow('2026-01-21', 100_00, fx.corp1, fx.tax, fx.common1, 'c-tax-vat'));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /须填写税种和所属期/);
    await ok(create(flow('2026-01-21', 100_00, fx.corp1, fx.tax, fx.common1, 'c-tax-vat', { splits: [{ projectId: fx.common1, categoryId: 'c-tax-vat', amount: 100_00, tax: 'VAT', taxPeriod: '2025-12' }] })));
  });

  it('连续流转：同一请求中后一步引用前一步（tempId）作为资金来源，整条链在一个事务中', async () => {
    const r = await ok(create(
      { ...flow('2026-02-01', 50_000_00, fx.corp1, fx.zhang, fx.p1, 'c-trf-advance'), tempId: 's1' },
      { ...flow('2026-02-02', 20_000_00, fx.zhang, fx.cash, fx.p1, 'c-trf-withdraw', { method: 'CASH_WITHDRAW', allocations: [{ lotFlowId: 's1', amount: 20_000_00 }] }), tempId: 's2' },
      { ...flow('2026-02-03', 20_000_00, fx.cash, fx.client, fx.p1, 'c-trf-handover', { method: 'CASH_HANDOVER' }), tempId: 's3' },
    ));
    assert.equal(r.created.length, 3);
    const s = await snap(ctx);
    const t = computeTraces(s.flows, s.accounts, s.categories, '2026-02-10', s.writeoffs).find((x) => x.edges.some((e) => e.flowId === r.created[2].id))!;
    assert.ok(t.viaPerson);
    assert.equal(Math.round(t.held), 30_000_00, '张三卡上还剩 3 万');
  });

  it('链中任一步失败则整批不保存', async () => {
    const before = (await snap(ctx)).flows.length;
    const r = await create(
      { ...flow('2026-02-05', 1_000_00, fx.corp1, fx.zhang, fx.p1, 'c-trf-advance'), tempId: 'a' },
      flow('2026-02-05', 999_999_00, fx.zhang, fx.supplier, fx.p1, 'c-mat-main'),
    );
    assert.equal(r.status, 400);
    assert.match(r.body.message, /第 2 笔/);
    assert.equal((await snap(ctx)).flows.length, before);
  });

  it('冲销：被下游使用的入款不能先冲销；冲销下游后再冲销上游，余额与来源恢复', async () => {
    const up = await ok(create(flow('2026-03-01', 5_000_00, fx.client, fx.zhang, fx.p2, 'c-cur-loan')));
    const down = await ok(create(flow('2026-03-02', 3_000_00, fx.zhang, fx.supplier, fx.p2, 'c-mat-main')));
    const zhangBefore = await balanceOf(fx.zhang);
    let r = await post(`/api/flows/${up.created[0].id}/reverse`, { reason: '录错' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /已被 F\d{6}-\d+ 用作资金来源/);
    await ok(post(`/api/flows/${down.created[0].id}/reverse`, { reason: '录错' }));
    assert.equal(await balanceOf(fx.zhang), zhangBefore + 3_000_00);
    await ok(post(`/api/flows/${up.created[0].id}/reverse`, { reason: '录错' }));
    assert.equal(await balanceOf(fx.zhang), zhangBefore + 3_000_00 - 5_000_00);
    r = await post(`/api/flows/${up.created[0].id}/reverse`, { reason: '再来一次' });
    assert.equal(r.status, 400);
    const check = await ok(call(ctx.app, ctx.admin, 'GET', '/api/admin/self-check'));
    assert.ok(check.ok, JSON.stringify(check.items));
  });

  it('已入账流水的账务字段由数据库禁止修改，说明类字段可以修改', async () => {
    const s = await snap(ctx);
    const f = s.flows.find((x) => x.status === 'CONFIRMED')!;
    await assert.rejects(ctx.sql`UPDATE flow SET amount = 1 WHERE id = ${f.id}`, /FLOW_IMMUTABLE/);
    await assert.rejects(ctx.sql`DELETE FROM flow WHERE id = ${f.id}`, /append-only/);
    await ok(call(ctx.app, ctx.finance, 'PATCH', `/api/flows/${f.id}`, { remark: '补充说明', purposeMismatch: true }));
    assert.equal((await snap(ctx)).flows.find((x) => x.id === f.id)!.remark, '补充说明');
  });

  it('并发出款不会超额使用同一笔资金（行锁）', async () => {
    await ok(create(flow('2026-04-01', 1_000_00, fx.client, fx.corp2, fx.common2, 'c-inc-progress')));
    const bal = await balanceOf(fx.corp2);
    const amount = Math.ceil(bal * 0.6);
    const tries = await Promise.all(Array.from({ length: 5 }, () => create(flow('2026-04-02', amount, fx.corp2, fx.supplier, fx.common2, 'c-mat-main'))));
    assert.equal(tries.filter((t) => t.status === 200).length, 1, JSON.stringify(tries.map((t) => [t.status, t.body?.message])));
    assert.equal(await balanceOf(fx.corp2), bal - amount);
  });

  it('结账后该月不能再记账；管理员反结账后恢复', async () => {
    await ok(post('/api/periods/close', { entityIds: [fx.e1], period: '2026-01' }));
    const r = await create(flow('2026-01-25', 1_00, fx.client, fx.corp1, fx.p1, 'c-inc-progress'));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /甲 2026-01 已结账/);
    assert.equal((await post('/api/periods/reopen', { entityId: fx.e1, period: '2026-01' })).status, 403, '财务不能反结账');
    await ok(post('/api/periods/reopen', { entityId: fx.e1, period: '2026-01' }, ctx.admin));
    await ok(create(flow('2026-01-25', 1_00, fx.client, fx.corp1, fx.p1, 'c-inc-progress')));
  });

  it('外部差额核销：只能核销外部账户上的剩余；核销后资金链不再报异常', async () => {
    const r = await ok(create(
      { ...flow('2026-05-01', 6_000_00, fx.corp1, fx.cash, fx.p1, 'c-trf-withdraw', { method: 'CASH_WITHDRAW' }), tempId: 'w' },
      { ...flow('2026-05-02', 6_000_00, fx.cash, fx.supplier, fx.p1, 'c-trf-handover', { method: 'CASH_HANDOVER', allocations: [{ lotFlowId: 'w', amount: 6_000_00 }] }), tempId: 'h' },
      flow('2026-05-03', 5_800_00, fx.supplier, fx.corp1, fx.p1, 'c-trf-return', { allocations: [{ lotFlowId: 'h', amount: 5_800_00 }] }),
    ));
    const handover = r.created[1].id;
    let bad = await post(`/api/lots/${handover}/writeoff`, { amount: 300_00, categoryId: 'c-fin-fee', reason: '返点' });
    assert.equal(bad.status, 400, '超过剩余');
    bad = await post(`/api/lots/${r.created[0].id}/writeoff`, { amount: 1_00, categoryId: 'c-fin-fee', reason: 'x' });
    assert.equal(bad.status, 400, '现金账户不能核销');
    assert.match(bad.body.message, /不能直接核销/);
    await ok(post(`/api/lots/${handover}/writeoff`, { amount: 200_00, categoryId: 'c-fin-fee', reason: '对方收取的手续费' }));
    const s = await snap(ctx);
    // 这笔现金来自两笔入款（合并资金），核销金额按比例分摊到两条链上
    const ts = computeTraces(s.flows, s.accounts, s.categories, '2026-05-10', s.writeoffs).filter((x) => x.edges.some((e) => e.flowId === handover));
    assert.equal(Math.round(ts.reduce((a, t) => a + t.external, 0)), 0);
    assert.equal(Math.round(ts.reduce((a, t) => a + t.writtenOff, 0)), 200_00);
  });

  it('权限：只读账号不能写；财务不能管理用户', async () => {
    const r = await call(ctx.app, ctx.readonly, 'POST', '/api/flows', { flows: [flow('2026-06-01', 1_00, fx.client, fx.corp1, fx.p1, 'c-inc-progress')] });
    assert.equal(r.status, 403);
    assert.equal((await call(ctx.app, ctx.finance, 'GET', '/api/users')).status, 403);
    assert.equal((await call(ctx.app, ctx.readonly, 'GET', '/api/snapshot')).status, 200);
  });

  it('结项检查：项目资金滞留在个人卡时不能结项（管理员可强制）', async () => {
    const r = await post(`/api/projects/${fx.p1}/close`, {});
    assert.equal(r.status, 400);
    assert.match(r.body.message, /滞留在个人\/现金账户/);
    await ok(post(`/api/projects/${fx.p1}/close`, { force: true }, ctx.admin));
    const again = await create(flow('2026-06-02', 1_00, fx.client, fx.corp1, fx.p1, 'c-inc-progress'));
    assert.match(again.body.message, /已结项/);
  });

  it('纳税人身份变更：生效日期须晚于现有记录；历史期间仍按原身份', async () => {
    let r = await post(`/api/entities/${fx.e2}/tax-profiles`, { taxpayerType: 'GENERAL', vatFiling: 'MONTH', validFrom: '2023-06-01', urbanRate: 0.05, halving: false });
    assert.equal(r.status, 400);
    r = await post(`/api/entities/${fx.e2}/tax-profiles`, { taxpayerType: 'GENERAL', vatFiling: 'MONTH', validFrom: '2026-07-01', urbanRate: 0.05, halving: false });
    assert.equal(r.status, 200);
    const e = (await snap(ctx)).entities.find((x) => x.id === fx.e2)!;
    assert.equal(e.taxpayerType, 'GENERAL');
    assert.deepEqual(e.taxProfiles.map((p) => [p.taxpayerType, p.validFrom, p.validTo]), [['SMALL', '2024-01-01', '2026-07-01'], ['GENERAL', '2026-07-01', undefined]]);
  });
});
