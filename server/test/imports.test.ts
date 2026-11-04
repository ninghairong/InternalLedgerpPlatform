import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildTemplate, type CellInput, type TemplateCode } from '@ledger/shared/excel';
import type { ImportRow } from '@ledger/shared/importer';
import { computeTraces } from '@ledger/shared/selectors';
import { basicFixture, call, flow, ok, setup, snap, teardown, type Ctx } from './helpers';

let ctx: Ctx;
let fx: Awaited<ReturnType<typeof basicFixture>>;
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const n = null;

async function workbook(code: TemplateCode, rows: CellInput[][], header: Record<string, CellInput> = {}) {
  const wb = buildTemplate(code, await snap(ctx), { header, rows });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(files: { name: string; data: Buffer }[], token = ctx.finance) {
  const form = new FormData();
  for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), f.name);
  const r = await ctx.app.inject({ method: 'POST', url: '/api/imports', payload: form as never, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
}

const byRef = (rows: ImportRow[], ref: string) => rows.find((r) => r.rowRef === ref || r.raw.code === ref || r.raw.person === ref)!;
const post = (url: string, body?: unknown, token = ctx.finance) => call(ctx.app, token, 'POST', url, body ?? {});

before(async () => {
  ctx = await setup();
  fx = await basicFixture(ctx);
  // 甲公司公户先有一笔回款，供工资发放使用
  await ok(post('/api/flows', { flows: [flow('2026-01-02', 500_000_00, fx.client, fx.corp1, fx.p1, 'c-inc-progress')] }));
});
after(() => teardown(ctx));

describe('Excel 导入', () => {
  let batchId: string;

  it('一个批次同时导入主体、账户、项目、日记账与个人账户流水，逐行给出校验结果', async () => {
    const entity = await workbook('ENTITY', [['E3', '丙公司', '丙', '独立公司', n, '小规模纳税人', D('2025-01-01'), n, '5%', n, '迭部', n]]);
    const account = await workbook('ACCOUNT', [
      ['A3', '丙-基本户', '对公账户', '丙公司', n, '农业银行', '1234', 10000, D('2026-01-01'), n, n],
      ['I2', '李四-建行卡', '内部个人', n, '李四', '建设银行', '5678', n, n, n, n],
    ]);
    const project = await workbook('PROJECT', [['P3', '丙项目', '丙公司', '赵', '县农业局', '迭部', '简易计税', 800000, 300000, 200000, n, n, D('2026-01-01'), '进行中']]);
    const journal = await workbook('JOURNAL', [
      ['J1', D('2026-02-01'), '新客户', '进度款', 50000, n, '丙项目', '项目收入/进度款', n, n, n, n, n, n, n, 'B001', n, n],
      ['J2', D('2026-02-02'), '李四-建行卡', '支付李四借款', n, 20000, '丙项目', '内部划转/公户→个人代管', '项目备用金', n, n, n, 'L1', n, n, n, 40000, n],
      ['J3', D('2026-02-03'), '国家金库（税务）', '缴税', n, 300, '丙·公司公共', '税费/增值税', n, n, n, n, n, n, n, n, n, n],
      ['J4', D('2026-02-04'), '银行手续费', '手续费', n, -9, '丙·公司公共', '财务费用/银行手续费', n, n, n, n, n, n, n, n, n, n],
      ['J5', '20206.2.5', '银行手续费', '手续费', n, 9, '丙·公司公共', '财务费用/银行手续费', n, n, n, n, n, n, n, n, n, n],
    ], { entity: '丙公司', account: '丙-基本户' });
    const flows = await workbook('FLOW', [
      ['N1', D('2026-02-10'), '李四-建行卡', '供应商乙', 15000, '银行转账', '丙项目', '项目材料费/主材', 'x', n, n, n, n, '李四', 'L1', n, n, n, n],
      ['N2', D('2026-02-11'), '李四-建行卡', '丙-基本户', 8000, '银行转账', '丙项目', '内部划转/回流公户', '退回', n, n, n, n, '李四', n, 'J2:8000', n, n, n],
      ['N3', D('2026-02-12'), '李四-建行卡', '丙-基本户', 5000, '银行转账', '丙项目', '内部划转/回流公户', '退回', n, n, n, n, '李四', n, 'J2:5000', n, n, n],
    ]);
    const r = await upload([
      { name: 'entity.xlsx', data: entity }, { name: 'account.xlsx', data: account }, { name: 'project.xlsx', data: project },
      { name: 'journal.xlsx', data: journal }, { name: 'flows.xlsx', data: flows },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    batchId = r.body.id;
    const rows: ImportRow[] = r.body.rows;
    assert.equal(byRef(rows, 'E3').status, 'OK');
    assert.equal(byRef(rows, 'A3').status, 'OK');
    assert.ok(byRef(rows, 'A3').flow, '期初余额生成期初流水');
    assert.equal(byRef(rows, 'J1').status, 'WARNING', '新客户自动新建外部账户');
    assert.match(byRef(rows, 'J2').messages.map((m) => m.text).join(), /资金来源/);
    assert.equal(byRef(rows, 'J2').status, 'OK', '余额核对：10000 + 50000 − 20000 = 40000');
    assert.equal(byRef(rows, 'J3').status, 'ERROR', '缴税须填税种');
    assert.equal(byRef(rows, 'J4').status, 'WARNING', '负数按绝对值');
    assert.equal(byRef(rows, 'J5').status, 'ERROR', '日期笔误');
    assert.match(byRef(rows, 'N1').messages.map((m) => m.text).join(), /链路 L1 内/);
    assert.equal(byRef(rows, 'N2').status, 'ERROR', 'J2 只剩 5000');
    assert.equal(byRef(rows, 'N3').status, 'OK');
  });

  it('跳过错误行后重新校验；提交时按最新数据再校验一次并写入', async () => {
    const cur = await ok(call(ctx.app, ctx.finance, 'GET', `/api/imports/${batchId}`));
    const skip = (cur.rows as ImportRow[]).filter((r) => r.status === 'ERROR').map((r) => r.key);
    const v = await ok(post(`/api/imports/${batchId}/validate`, { skip }));
    assert.equal(v.summary.error, 0);
    assert.equal(v.summary.skipped, 3);
    const c = await ok(post(`/api/imports/${batchId}/commit`));
    assert.equal(c.committed, 9, '主体 1 + 账户 2 + 项目 1 + 日记账 3 + 流水 2');
    const s = await snap(ctx);
    const ent = s.entities.find((e) => e.code === 'E3')!;
    assert.equal(ent.taxpayerType, 'SMALL');
    assert.ok(s.projects.find((p) => p.name === '丙·公司公共'), '新主体自动有公司公共项目');
    const corp3 = s.accounts.find((a) => a.code === 'A3')!;
    assert.equal(corp3.entityId, ent.id);
    assert.ok(s.accounts.find((a) => a.name === '新客户' && a.kind === 'EXTERNAL'));
    const p3 = s.projects.find((p) => p.code === 'P3')!;
    assert.deepEqual(p3.budget, { 'c-mat': 300000_00, 'c-wage': 200000_00 });
    const imported = s.flows.filter((f) => f.importBatchNo === c.batchNo);
    assert.equal(imported.length, 6, '期初 1 + 日记账 3 + 个人卡流水 2');
    const li = s.accounts.find((a) => a.code === 'I2')!;
    const t = computeTraces(s.flows, s.accounts, s.categories, '2026-02-20', s.writeoffs).filter((x) => x.edges.some((e) => e.to === li.id));
    assert.equal(Math.round(t.reduce((a, x) => a + x.held, 0)), 0, '李四卡上的 2 万：1.5 万材料费 + 0.5 万退回');
    assert.equal((await post(`/api/imports/${batchId}/commit`)).status, 400, '不能重复提交');
  });

  it('批次中的钱被批次外流水使用后不能撤销；冲销该流水后可以整批撤销', async () => {
    const s = await snap(ctx);
    const corp3 = s.accounts.find((a) => a.code === 'A3')!;
    const common3 = s.projects.find((p) => p.name === '丙·公司公共')!;
    const outside = await ok(post('/api/flows', { flows: [flow('2026-02-20', 1_000_00, corp3.id, fx.supplier, common3.id, 'c-admin-other')] }));
    let r = await post(`/api/imports/${batchId}/rollback`);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /用作资金来源/);
    await ok(post(`/api/flows/${outside.created[0].id}/reverse`, { reason: '测试' }));
    r = await post(`/api/imports/${batchId}/rollback`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await snap(ctx);
    assert.ok(after.flows.filter((f) => f.importBatchNo).every((f) => f.status === 'VOIDED'));
    assert.ok((await ok(call(ctx.app, ctx.admin, 'GET', '/api/admin/self-check'))).ok);
    assert.equal((await post(`/api/imports/${batchId}/rollback`)).status, 400);
  });

  it('工资表：校验应发 − 扣款 = 实发；为每人生成实发流水并记录工资批次', async () => {
    const data = await workbook('PAYROLL', [
      ['王五', '1111', '项目一', n, 10000, 1000, 500, 300, 0, 8200, 1600, 500, n, n],
      ['赵六', n, n, '项目一:0.6;项目二:0.4', 8000, 800, 400, 100, 0, 6700, 1300, 400, n, n],
      ['钱七', n, '项目一', n, 5000, 0, 0, 0, 0, 4000, 0, 0, n, '算错了'],
    ], { entity: '甲公司', month: '2026-01', payAccount: '甲-基本户', payDate: D('2026-02-10') });
    const r = await upload([{ name: 'payroll.xlsx', data }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows: ImportRow[] = r.body.rows;
    assert.equal(byRef(rows, '钱七').status, 'ERROR');
    assert.match(byRef(rows, '钱七').messages[0].text, /与实发 4,000\.00 不一致/);
    const zhao = byRef(rows, '赵六');
    assert.deepEqual(zhao.flow!.splits.map((s) => s.amount), [4020_00, 2680_00]);
    await ok(post(`/api/imports/${r.body.id}/validate`, { skip: [byRef(rows, '钱七').key] }));
    await ok(post(`/api/imports/${r.body.id}/commit`));
    const s = await snap(ctx);
    const pb = s.payrolls.find((p) => p.month === '2026-01')!;
    assert.equal(pb.items.length, 2);
    assert.equal(pb.items.reduce((a, i) => a + i.iit, 0), 400_00);
    const wang = s.accounts.find((a) => a.name === '王五')!;
    const netFlow = s.flows.find((f) => f.id === pb.items[0].netFlowId)!;
    assert.equal(netFlow.toAccountId, wang.id);
    assert.equal(netFlow.amount, 8200_00);
    assert.equal(netFlow.allocations.reduce((a, x) => a + x.amount, 0), 8200_00, '工资从公户发出，同样强制溯源');
  });

  it('主数据回填模板 → 修改后再导入：按编号更新', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/templates/ACCOUNT?fill=1', headers: { authorization: `Bearer ${ctx.finance}` } });
    assert.equal(r.statusCode, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as never);
    const ws = wb.getWorksheet('账户')!;
    let target = 0;
    ws.eachRow((row, i) => {
      if (row.getCell(1).value === 'X2') target = i;
    });
    assert.ok(target > 0);
    ws.getRow(target).getCell(11).value = '长期合作供应商';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const up = await upload([{ name: 'accounts-filled.xlsx', data: buf }]);
    const rows: ImportRow[] = up.body.rows;
    assert.ok(rows.every((x) => x.status === 'OK' || x.status === 'WARNING'), JSON.stringify(rows.filter((x) => x.status === 'ERROR').map((x) => x.messages)));
    await ok(post(`/api/imports/${up.body.id}/commit`));
    assert.equal((await snap(ctx)).accounts.find((a) => a.code === 'X2')!.remark, '长期合作供应商');
  });

  it('上传非模板文件给出明确提示', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').getCell('A1').value = '随便写的';
    const r = await upload([{ name: 'random.xlsx', data: Buffer.from(await wb.xlsx.writeBuffer()) }]);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /未识别到平台模板/);
  });
});

describe('导出', () => {
  for (const [kind, query] of [
    ['flows', ''], ['journal', 'accountId=CORP1'], ['traces', ''], ['balances', ''], ['projects', ''], ['settlement', 'projectId=P1'], ['ic', ''], ['tax', ''], ['payroll', ''],
  ] as const) {
    it(`导出 ${kind}`, async () => {
      const q = query.replace('CORP1', fx.corp1).replace('P1', fx.p1);
      const r = await ctx.app.inject({ method: 'GET', url: `/api/exports/${kind}?${q}`, headers: { authorization: `Bearer ${ctx.readonly}` } });
      assert.equal(r.statusCode, 200, r.body);
      assert.match(String(r.headers['content-disposition']), /filename\*=UTF-8''/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.rawPayload as never);
      assert.ok(wb.worksheets[0].rowCount >= 4);
      assert.match(String(wb.worksheets[0].getCell('A2').value), /导出人：ro/);
    });
  }
  it('每次导出都记审计日志', async () => {
    const logs = await ok(call(ctx.app, ctx.admin, 'GET', '/api/audit?action=export'));
    assert.ok(logs.length >= 9);
  });
});
