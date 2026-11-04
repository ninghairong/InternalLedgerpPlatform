import { Alert, Badge, Button, Card, Col, Popconfirm, Result, Row, Segmented, Space, Statistic, Steps, Switch, Table, Tag, Typography, Upload, message } from 'antd';
import { CloudUploadOutlined, DownloadOutlined, ExperimentOutlined, FileExcelOutlined } from '@ant-design/icons';
import ExcelJS from 'exceljs';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '@/components/PageTitle';
import { AccountSelect } from '@/components/Pickers';
import { useMaps, useStore, type ImportResult } from '@/data/store';
import type { ID } from '@ledger/shared/types';
import { buildTemplate, TEMPLATE_NAMES, type CellInput, type TemplateCode } from '@ledger/shared/excel';
import type { ImportRow, RowStatus } from '@ledger/shared/importer';
import { money, today } from '@ledger/shared/format';
import { api } from '@/api';

const STATUS: Record<RowStatus, { label: string; color: string }> = {
  OK: { label: '通过', color: 'success' },
  WARNING: { label: '需确认', color: 'warning' },
  ERROR: { label: '错误', color: 'error' },
  DUPLICATE: { label: '重复', color: 'default' },
  MATCHED: { label: '已配对', color: 'processing' },
  SKIPPED: { label: '跳过', color: 'default' },
};

const TEMPLATE_DESC: Record<TemplateCode, string> = {
  JOURNAL: '版式接近现有日记账：一个 Sheet 一个账户，收入 / 支出两列；补充了对方户名、项目、账目类型、实际用途、税种、链路号等列。',
  FLOW: '每行一笔"从 A 到 B"，适合个人卡、现金之间的流转，以及用链路号 / 来源引用迁移历史资金链。',
  PAYROLL: '按月导入已算好的工资表（个税为外部结算结果）；校验应发 − 扣款 = 实发，为每人生成实发流水。',
  ENTITY: '公司主体与纳税人身份。按编号匹配：已存在则更新，身份变化时新增身份记录。',
  ACCOUNT: '对公账户、个人卡、现金、外部单位；可带期初余额。按编号匹配更新。',
  PROJECT: '项目与预算。按编号匹配更新。',
};

const D = (s: string) => new Date(`${s}T00:00:00Z`);

/** 示例文件（基于演示数据的名称）：包含近似户名、负数金额、缴税未填税种、重复、日期笔误、溯源不足等情况 */
async function sampleFiles(): Promise<File[]> {
  const snap = useStore.getState();
  const n = null;
  const PJ1 = '迭部县多儿乡布后村耕地围栏建设项目';
  const PJ2 = '迭部县卡坝乡娘玉村农田围栏建设项目';
  const COMMON = '凌岳迭部·公司公共';
  const toFile = async (wb: ExcelJS.Workbook, name: string) => new File([await wb.xlsx.writeBuffer()], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const journal = buildTemplate('JOURNAL', snap, {
    header: { entity: '甘肃凌岳建设有限公司迭部分公司', account: '凌岳迭部-农行基本户' },
    rows: [
      ['J1', D('2026-10-20'), '迭部县农业农村和科学技术局零余额账户', '进度款', 150000, n, PJ1, '项目收入/进度款', n, n, n, n, n, n, n, `B${Date.now()}`, n, n],
      ['J2', D('2026-10-21'), '宁晓华', '支付宁晓花借款', n, 80000, PJ1, '内部划转/公户→个人代管', '项目备用金，由宁晓花代管', n, n, n, 'L001', n, n, n, n, n],
      ['J3', D('2026-10-22'), '国家金库（税务）', '中华人民共和国国家金库迭部县支库', n, 1500, COMMON, '税费/增值税', n, n, n, n, n, n, n, n, n, n],
      ['J4', D('2026-10-23'), '银行手续费', '转账手续费', n, -9, COMMON, '财务费用/银行手续费', n, n, n, n, n, n, n, n, n, n],
      ['J5', D('2026-10-25'), '甘肃祥瑞苗木专业合作社', '苗木款', n, 23000, PJ1, '项目材料费/苗木', n, n, n, n, n, n, n, n, n, n],
      ['J6', D('2025-12-11'), '河北揽升交通安防设施有限公司', '支付河北揽升交通安防设施有限公司围栏款', n, 185138, PJ2, '项目材料费/围栏丝网', n, n, n, n, n, n, n, n, n, '历史数据，已在系统中'],
      ['J7', D('2026-10-28'), '擎宇-农行基本户', '收到擎宇调拨', 50000, n, COMMON, '往来款/集团内往来', n, n, n, n, n, n, n, n, n, n],
      ['J8', '20206.10.29', '银行手续费', '短信费', n, 20, COMMON, '财务费用/银行手续费', n, n, n, n, n, n, n, n, n, '日期笔误'],
    ] as CellInput[][],
  });
  const flow = buildTemplate('FLOW', snap, {
    rows: [
      ['N1', D('2026-10-24'), '宁晓花-农行卡', '陕西创建园林绿化公司', 30000, '银行转账', PJ1, '项目材料费/苗木', '苗木款', n, n, n, n, '宁晓花', 'L001', n, n, n, n],
      ['N2', D('2026-10-26'), '宁晓花-农行卡', '工人工资代发（多人）', 45000, '银行转账', PJ1, '人员工资/劳务费', '围栏工人工资', n, n, n, n, '宁晓花', 'L001', n, n, n, n],
      ['N3', D('2026-10-27'), '宁晓花-农行卡', '凌岳迭部-农行基本户', 20000, '银行转账', PJ1, '内部划转/回流公户', '退回余款', n, n, n, n, '宁晓花', n, 'J2:20000', n, n, '引用金额超过剩余'],
      ['N4', D('2026-10-27'), '杨燕花-建行卡', '工人工资代发（多人）', 8000, '微信', PJ2, '人员工资/劳务费', '工人工资', n, n, n, n, '杨燕花', n, n, n, n, '该账户已无可用资金'],
      ['N5', D('2026-10-30'), '宁晓花-农行卡', '凌岳迭部-农行基本户', 5000, '银行转账', PJ1, '内部划转/回流公户', '退回余款', n, n, n, n, '宁晓花', n, 'J2:5000', n, n, n],
    ] as CellInput[][],
  });
  return [await toFile(journal, '示例_凌岳迭部日记账.xlsx'), await toFile(flow, '示例_个人账户流水.xlsx')];
}

export default function ImportPage() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [batch, setBatch] = useState<ImportResult>();
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<RowStatus | 'ALL'>('ALL');
  const [journalAcc, setJournalAcc] = useState<ID>();
  const [payAcc, setPayAcc] = useState<ID>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ batchNo: string; committed: number; flows: number }>();
  const batches = useStore((s) => s.importBatches);
  const mutate = useStore((s) => s.mutate);
  const { accMap, projMap, catMap } = useMaps();

  const rows = batch?.rows ?? [];
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const committable = rows.filter((r) => r.status === 'OK' || r.status === 'WARNING');

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = (files: File[]) =>
    run(async () => {
      const r = await api.upload<ImportResult>('/imports', files);
      setBatch(r);
      setSkip(new Set());
      setFilter('ALL');
      setStep(1);
    });

  const toggleSkip = (key: string, on: boolean) =>
    run(async () => {
      const n = new Set(skip);
      if (on) n.delete(key);
      else n.add(key);
      const r = await api.post<ImportResult>(`/imports/${batch!.id}/validate`, { skip: [...n] });
      setSkip(n);
      setBatch({ ...batch!, ...r });
    });

  const commit = () =>
    run(async () => {
      const r = await mutate(() => api.post<{ batchNo: string; committed: number; flows: number }>(`/imports/${batch!.id}/commit`));
      setResult(r);
      setStep(2);
    });

  const download = (code: TemplateCode, query = '') => api.download(`/templates/${code}${query}`).catch((e) => message.error(e.message));

  const errorReport = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('校验结果');
    ws.columns = [{ header: '文件', width: 28 }, { header: 'Sheet', width: 12 }, { header: '行号', width: 6 }, { header: '行ID', width: 8 }, { header: '状态', width: 8 }, { header: '问题', width: 90 }];
    rows.filter((r) => r.status !== 'OK').forEach((r) => {
      const row = ws.addRow([r.file, r.sheet, r.rowNo, r.rowRef ?? '', STATUS[r.status].label, r.messages.map((m) => m.text).join('\n')]);
      row.getCell(6).alignment = { wrapText: true };
      if (r.status === 'ERROR') row.getCell(5).font = { color: { argb: 'FFCF1322' }, bold: true };
    });
    ws.getRow(1).font = { bold: true };
    const url = URL.createObjectURL(new Blob([await wb.xlsx.writeBuffer()]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `导入校验结果_${batch?.batchNo}_${today()}.xlsx`;
    a.click();
  };

  const nameOf = (id: string) => accMap.get(id)?.name ?? rows.find((r) => r.newAccount?.id === id)?.newAccount?.name ?? rows.find((r) => r.master?.id === id)?.master?.data.name ?? id;
  const projOf = (id: string) => projMap.get(id)?.name ?? rows.find((r) => r.master?.id === id)?.master?.data.name ?? (id.startsWith('new-') ? '（本批新建主体的公司公共项目）' : id);
  const shown = rows.filter((r) => filter === 'ALL' || r.status === filter);

  return (
    <>
      <PageTitle title="Excel 导入" sub="上传 → 校验预览 → 确认导入。提交时后端按最新数据重新校验，整批在一个事务中写入；导入后立即生效，可整批撤销。" />
      <Card style={{ marginBottom: 16 }}>
        <Steps current={step} items={[{ title: '选择模板并上传' }, { title: '校验预览' }, { title: '完成' }]} style={{ maxWidth: 720, marginBottom: 24 }} />

        {step === 0 && (
          <Row gutter={16}>
            <Col span={11}>
              <Typography.Title level={5}>1. 下载模板（下拉选项来自系统当前数据）</Typography.Title>
              <Space direction="vertical" style={{ width: '100%' }}>
                {(Object.keys(TEMPLATE_NAMES) as TemplateCode[]).map((code) => (
                  <Card key={code} size="small" title={<Space><FileExcelOutlined style={{ color: '#389e0d' }} />{TEMPLATE_NAMES[code]}模板</Space>}>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>{TEMPLATE_DESC[code]}</Typography.Paragraph>
                    {code === 'JOURNAL' ? (
                      <Space.Compact style={{ width: '100%' }}>
                        <AccountSelect style={{ width: '70%' }} placeholder="选择账户（预填到表头）" allowClear value={journalAcc} onChange={setJournalAcc} kinds={['CORPORATE', 'INTERNAL_PERSONAL', 'CASH']} showBalance={false} />
                        <Button icon={<DownloadOutlined />} onClick={() => download(code, api.qs({ accountId: journalAcc }))}>下载</Button>
                      </Space.Compact>
                    ) : code === 'PAYROLL' ? (
                      <Space.Compact style={{ width: '100%' }}>
                        <AccountSelect style={{ width: '70%' }} placeholder="发放账户（预填到表头）" allowClear value={payAcc} onChange={setPayAcc} kinds={['CORPORATE']} showBalance={false} />
                        <Button icon={<DownloadOutlined />} onClick={() => download(code, api.qs({ accountId: payAcc }))}>下载</Button>
                      </Space.Compact>
                    ) : (
                      <Space>
                        <Button icon={<DownloadOutlined />} onClick={() => download(code)}>下载空白模板</Button>
                        {['ENTITY', 'ACCOUNT', 'PROJECT'].includes(code) && <Button onClick={() => download(code, '?fill=1')}>导出现有数据（改完可再导入）</Button>}
                      </Space>
                    )}
                  </Card>
                ))}
              </Space>
            </Col>
            <Col span={13}>
              <Typography.Title level={5}>2. 上传填好的文件</Typography.Title>
              <Upload.Dragger
                multiple
                accept=".xlsx"
                showUploadList={false}
                disabled={busy}
                beforeUpload={(f, list) => {
                  if (f === list[list.length - 1]) uploadFiles(list as unknown as File[]);
                  return false;
                }}
                style={{ padding: 24 }}
              >
                <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
                <p className="ant-upload-text">{busy ? '正在校验…' : '点击或拖拽 .xlsx 文件到此处'}</p>
                <p className="ant-upload-hint">可一次上传多个文件（如主体、账户、各账户日记账），系统先处理主数据，再按日期统一排序入账；跨文件的资金来源可以互相引用</p>
              </Upload.Dragger>
              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                icon={<ExperimentOutlined />}
                message="迁移建议顺序"
                description="主体 → 账户（含期初余额）→ 项目 → 各对公账户日记账 → 个人卡 / 现金流水。可以放在同一批里一起上传。两家主体的日记账里都出现的同一笔往来会自动配对，不会重复入账。"
              />
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                message="演示用示例文件"
                description={
                  <Space direction="vertical">
                    <span>基于演示数据的名称生成（需先执行 npm run seed）。示例里故意放了近似户名、负数金额、缴税未填税种、重复记录、日期笔误、个人账户资金来源不足等问题。</span>
                    <Button loading={busy} onClick={async () => uploadFiles(await sampleFiles())}>用示例文件演示</Button>
                  </Space>
                }
              />
            </Col>
          </Row>
        )}

        {step === 1 && batch && (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={4}><Statistic title={`批次 ${batch.batchNo}`} value={rows.length} suffix="行" /></Col>
              <Col span={4}><Statistic title="通过" value={count('OK')} valueStyle={{ color: '#389e0d' }} /></Col>
              <Col span={4}><Statistic title="需确认" value={count('WARNING')} valueStyle={{ color: '#d48806' }} /></Col>
              <Col span={4}><Statistic title="错误" value={count('ERROR')} valueStyle={{ color: '#cf1322' }} /></Col>
              <Col span={4}><Statistic title="重复 / 已配对" value={`${count('DUPLICATE')} / ${count('MATCHED')}`} /></Col>
              <Col span={4}><Statistic title="将导入" value={committable.length} suffix="行" /></Col>
            </Row>
            {count('ERROR') > 0 && (
              <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`${count('ERROR')} 行有错误，不会导入。可以修改 Excel 后重新上传，或先导入其余有效行（依赖错误行资金的行会一并报错）。关闭某行的"导入"开关后系统会重新校验。`} />
            )}
            <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
              <Segmented
                value={filter}
                onChange={(v) => setFilter(v as RowStatus | 'ALL')}
                options={[{ label: `全部 ${rows.length}`, value: 'ALL' }, ...(Object.keys(STATUS) as RowStatus[]).filter((s) => count(s)).map((s) => ({ label: `${STATUS[s].label} ${count(s)}`, value: s }))]}
              />
              <Space>
                <Button icon={<DownloadOutlined />} onClick={errorReport}>下载校验结果</Button>
                <Button onClick={() => (setBatch(undefined), setStep(0))}>重新上传</Button>
                <Popconfirm title={`导入 ${committable.length} 行？`} description="提交后立即生效；如有问题可在下方导入记录中整批撤销" onConfirm={commit} disabled={!committable.length}>
                  <Button type="primary" loading={busy} disabled={!committable.length}>
                    {count('ERROR') ? `导入有效行（${committable.length}）` : `确认导入（${committable.length}）`}
                  </Button>
                </Popconfirm>
              </Space>
            </Space>
            <Table
              size="small"
              rowKey="key"
              loading={busy}
              dataSource={shown}
              pagination={{ pageSize: 50 }}
              scroll={{ x: 1300 }}
              columns={[
                { title: '来源', key: 'src', width: 170, render: (_: unknown, r: ImportRow) => <Space direction="vertical" size={0}><Typography.Text ellipsis style={{ maxWidth: 160, fontSize: 12 }}>{r.file}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.sheet} 第 {r.rowNo} 行</Typography.Text></Space> },
                { title: '行ID', dataIndex: 'rowRef', width: 60 },
                { title: '链路', dataIndex: 'chainNo', width: 60, render: (v?: string) => (v ? <Tag color="purple">{v}</Tag> : null) },
                {
                  title: '内容',
                  key: 'what',
                  width: 420,
                  render: (_: unknown, r: ImportRow) => {
                    if (r.master) {
                      const kind = { ENTITY: '主体', ACCOUNT: '账户', PROJECT: '项目' }[r.master.type];
                      return <Space direction="vertical" size={0}><span><Tag color={r.master.op === 'CREATE' ? 'blue' : 'default'}>{r.master.op === 'CREATE' ? '新增' : '更新'}{kind}</Tag>{r.master.data.name}</span>{r.flow && <Typography.Text type="secondary" style={{ fontSize: 12 }}>期初余额 {money(r.flow.amount)}（{r.flow.date}）</Typography.Text>}</Space>;
                    }
                    if (!r.flow) return <Typography.Text type="secondary">{String(r.raw.counterparty ?? r.raw.person ?? `${r.raw.from ?? ''} → ${r.raw.to ?? ''}`)}</Typography.Text>;
                    return (
                      <Space direction="vertical" size={0}>
                        <span>{r.flow.date}　{nameOf(r.flow.fromAccountId)} → {nameOf(r.flow.toAccountId)}　<b>{money(r.flow.amount)}</b></span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {r.payroll ? `工资 ${r.payroll.month}：应发 ${money(r.payroll.gross)}，个税 ${money(r.payroll.iit)}，实发 ${money(r.payroll.net)} · ` : ''}
                          {r.flow.splits.map((s) => `${projOf(s.projectId)} / ${catMap.get(s.categoryId)?.name}${r.flow!.splits.length > 1 ? ` ${money(s.amount)}` : ''}`).join('；')}
                        </Typography.Text>
                      </Space>
                    );
                  },
                },
                { title: '状态', dataIndex: 'status', width: 80, render: (s: RowStatus) => <Tag color={STATUS[s].color}>{STATUS[s].label}</Tag> },
                {
                  title: '校验结果',
                  key: 'm',
                  render: (_: unknown, r: ImportRow) => (
                    <Space direction="vertical" size={0}>
                      {r.messages.map((m, i) => (
                        <Typography.Text key={i} type={m.level === 'error' ? 'danger' : m.level === 'warning' ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                          {m.level === 'error' ? '✕ ' : m.level === 'warning' ? '! ' : '· '}
                          {m.text}
                        </Typography.Text>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: '导入',
                  key: 'skip',
                  width: 64,
                  fixed: 'right',
                  render: (_: unknown, r: ImportRow) =>
                    r.status === 'DUPLICATE' || r.status === 'MATCHED' ? null : (
                      <Switch size="small" checked={!skip.has(r.key)} disabled={busy || (r.status === 'ERROR' && !skip.has(r.key))} onChange={(on) => toggleSkip(r.key, on)} />
                    ),
                },
              ]}
            />
          </>
        )}

        {step === 2 && result && (
          <Result
            status="success"
            title={`已导入 ${result.committed} 行，其中 ${result.flows} 笔流水`}
            subTitle={`批次号 ${result.batchNo}。如发现问题，可在下方导入记录中撤销整批后重新导入。`}
            extra={[
              <Button key="flows" type="primary" onClick={() => nav('/flows')}>查看流水</Button>,
              <Button key="traces" onClick={() => nav('/traces')}>查看资金链</Button>,
              <Button key="again" onClick={() => (setBatch(undefined), setStep(0))}>继续导入</Button>,
            ]}
          />
        )}
      </Card>

      <Card title="导入记录" size="small">
        <Table
          size="small"
          rowKey="id"
          dataSource={batches}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: '暂无导入记录' }}
          columns={[
            { title: '批次号', dataIndex: 'batchNo' },
            { title: '模板', dataIndex: 'template' },
            { title: '文件', dataIndex: 'fileName', ellipsis: true },
            { title: '时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '操作人', dataIndex: 'createdBy' },
            { title: '行数 / 导入', key: 'c', render: (_: unknown, b) => `${b.total} / ${b.committed}` },
            { title: '状态', dataIndex: 'status', render: (s: string) => (s === 'COMMITTED' ? <Badge status="success" text="已导入" /> : <Badge status="default" text="已撤销" />) },
            {
              title: '',
              key: 'op',
              render: (_: unknown, b) =>
                b.status === 'COMMITTED' && (
                  <Popconfirm
                    title="撤销整批？"
                    description="批次内流水全部撤销（保留记录）；本批新建的主体、账户、项目保留。被批次外的流水用作资金来源时不能撤销。"
                    onConfirm={() => run(async () => { await mutate(() => api.post(`/imports/${b.id}/rollback`)); message.success('已撤销'); })}
                  >
                    <a>撤销</a>
                  </Popconfirm>
                ),
            },
          ]}
        />
      </Card>
    </>
  );
}
