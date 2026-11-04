import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { EntityTag, ProjectSelect } from '@/components/Pickers';
import { useUi } from '@/components/ui';
import { useCanWrite, useMaps, useStore } from '@/data/store';
import { isLive } from '@ledger/shared/selectors';
import { TAX_KIND } from '@ledger/shared/labels';
import { taxAssessments } from '@ledger/shared/tax';
import type { Invoice } from '@ledger/shared/types';
import { money, toCents, today } from '@ledger/shared/format';
import { api } from '@/api';

export default function Tax() {
  const snap = useStore();
  const { entities, invoices, flows, entityScope: scope } = snap;
  const canWrite = useCanWrite();
  const ui = useUi();
  const { projMap, accMap } = useMaps();
  const [editing, setEditing] = useState<Invoice | 'new'>();

  const rows = useMemo(() => taxAssessments(snap, scope === 'ALL' ? undefined : new Set([scope])), [snap, scope]);
  const scopedInvoices = invoices.filter((i) => scope === 'ALL' || i.entityId === scope);
  const taxFlows = flows.filter((f) => isLive(f) && f.splits.some((s) => s.tax) && (scope === 'ALL' || accMap.get(f.fromAccountId)?.entityId === scope));

  // 发票与流水核对：按发票号关联
  const flowByInvoice = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of flows) if (isLive(f)) for (const n of f.invoiceNos ?? []) m.set(n, [...(m.get(n) ?? []), f.id]);
    return m;
  }, [flows]);
  const invoiceNos = new Set(invoices.map((i) => i.invoiceNo));
  const unmatchedInvoices = scopedInvoices.filter((i) => !flowByInvoice.has(i.invoiceNo));
  const unknownNos = [...flowByInvoice.entries()].filter(([n]) => !invoiceNos.has(n));

  return (
    <>
      <PageTitle
        title="发票与税费"
        sub="按主体计算；按所属期适用的纳税人身份选择规则（一般纳税人按月、小规模按季）；税率来自系统设置中的税务规则"
        extra={
          <>
            <Button icon={<DownloadOutlined />} onClick={() => api.download(`/exports/tax${api.qs({ entityId: scope === 'ALL' ? undefined : scope })}`).catch((e) => message.error(e.message))}>导出税负测算</Button>
            {canWrite && <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>登记发票</Button>}
          </>
        }
      />
      <Card>
        <Tabs
          items={[
            {
              key: 'calc',
              label: '税负测算',
              children: (
                <>
                  <Alert type="info" showIcon style={{ marginBottom: 12 }} message="管理口径测算，不作为申报依据。附加税 = 增值税 ×（城建税率 + 教育附加 + 地方教育附加），享受“六税两费”减半的主体减半；小规模季度销售额未超过免征额（仅开普票）时免征。" />
                  <Table
                    size="small"
                    rowKey="key"
                    dataSource={rows}
                    pagination={{ pageSize: 20 }}
                    columns={[
                      { title: '主体', key: 'e', render: (_: unknown, r) => <EntityTag id={r.entityId} /> },
                      { title: '当期身份', dataIndex: 'taxpayerType', render: (t: string) => (t === 'GENERAL' ? '一般纳税人' : '小规模') },
                      { title: '所属期', dataIndex: 'period' },
                      { title: '不含税销售额', dataIndex: 'sales', align: 'right', render: (v: number) => money(v) },
                      { title: '销项税额', dataIndex: 'outTax', align: 'right', render: (v: number) => money(v) },
                      { title: '可抵扣进项', dataIndex: 'inTax', align: 'right', render: (v: number, r) => (r.taxpayerType === 'GENERAL' ? money(v) : <Typography.Text type="secondary">不可抵扣</Typography.Text>) },
                      { title: '应纳增值税', dataIndex: 'vat', align: 'right', render: (v: number) => <b>{money(v)}</b> },
                      { title: '附加税', dataIndex: 'surcharge', align: 'right', render: (v: number) => money(v) },
                      { title: '已缴增值税', dataIndex: 'paidVat', align: 'right', render: (v: number, r) => <span style={{ color: v === r.vat ? '#389e0d' : v ? '#d48806' : undefined }}>{money(v)}</span> },
                      { title: '说明', dataIndex: 'note', render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> },
                    ]}
                  />
                </>
              ),
            },
            {
              key: 'inv',
              label: `发票台账（${scopedInvoices.length}）`,
              children: (
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={scopedInvoices}
                  pagination={{ pageSize: 20 }}
                  columns={[
                    { title: '方向', dataIndex: 'direction', render: (d: string) => (d === 'OUTPUT' ? <Tag color="green">销项</Tag> : <Tag color="blue">进项</Tag>) },
                    { title: '票种', dataIndex: 'type', render: (t: string) => (t === 'VAT_SPECIAL' ? '专票' : '普票') },
                    { title: '发票号', dataIndex: 'invoiceNo' },
                    { title: '开票日期', dataIndex: 'issueDate' },
                    { title: '我方主体', dataIndex: 'entityId', render: (id: string) => <EntityTag id={id} /> },
                    { title: '项目', dataIndex: 'projectId', render: (id?: string) => projMap.get(id ?? '')?.name ?? '—', ellipsis: true },
                    { title: '对方', dataIndex: 'counterparty', ellipsis: true },
                    { title: '货物/服务', dataIndex: 'goods' },
                    { title: '不含税', dataIndex: 'amountExclTax', align: 'right', render: (v: number) => money(v) },
                    { title: '税率', dataIndex: 'taxRate', render: (v: number) => `${Math.round(v * 1000) / 10}%` },
                    { title: '税额', dataIndex: 'taxAmount', align: 'right', render: (v: number) => money(v) },
                    {
                      title: '抵扣',
                      key: 'd',
                      render: (_: unknown, i: Invoice) => {
                        if (i.direction === 'OUTPUT') return '—';
                        const e = entities.find((x) => x.id === i.entityId)!;
                        return e.taxpayerType === 'GENERAL' && i.type === 'VAT_SPECIAL' ? <Tag color="green">可抵扣</Tag> : <Tag>计入成本</Tag>;
                      },
                    },
                    { title: '关联流水', key: 'f', render: (_: unknown, i: Invoice) => (flowByInvoice.get(i.invoiceNo) ?? []).map((id) => <a key={id} onClick={() => ui.openFlow(id)}>{flows.find((f) => f.id === id)?.flowNo} </a>) },
                    ...(canWrite
                      ? [{
                          title: '',
                          key: 'op',
                          width: 100,
                          render: (_: unknown, i: Invoice) => (
                            <Space>
                              <a onClick={() => setEditing(i)}>编辑</a>
                              <Popconfirm title="删除这张发票？" onConfirm={() => snap.mutate(() => api.del(`/invoices/${i.id}`)).then(() => message.success('已删除')).catch((e) => message.error(e.message))}>
                                <a style={{ color: '#cf1322' }}>删除</a>
                              </Popconfirm>
                            </Space>
                          ),
                        }]
                      : []),
                  ]}
                />
              ),
            },
            {
              key: 'match',
              label: `发票与流水核对（${unmatchedInvoices.length + unknownNos.length}）`,
              children: (
                <Row gutter={16}>
                  <Col span={12}>
                    <Typography.Title level={5}>有发票、没有关联流水</Typography.Title>
                    <Table size="small" rowKey="id" pagination={false} dataSource={unmatchedInvoices} locale={{ emptyText: '全部已关联' }}
                      columns={[
                        { title: '发票号', dataIndex: 'invoiceNo' },
                        { title: '方向', dataIndex: 'direction', render: (d: string) => (d === 'OUTPUT' ? '销项' : '进项') },
                        { title: '对方', dataIndex: 'counterparty', ellipsis: true },
                        { title: '价税合计', key: 't', align: 'right', render: (_: unknown, i: Invoice) => money(i.amountExclTax + i.taxAmount) },
                      ]} />
                  </Col>
                  <Col span={12}>
                    <Typography.Title level={5}>流水填写的发票号，台账中没有</Typography.Title>
                    <Table size="small" rowKey="0" pagination={false} dataSource={unknownNos} locale={{ emptyText: '没有' }}
                      columns={[
                        { title: '发票号', key: 'n', render: (_: unknown, r) => r[0] },
                        { title: '流水', key: 'f', render: (_: unknown, r) => r[1].map((id: string) => <a key={id} onClick={() => ui.openFlow(id)}>{flows.find((f) => f.id === id)?.flowNo} </a>) },
                      ]} />
                  </Col>
                </Row>
              ),
            },
            {
              key: 'paid',
              label: '缴税记录',
              children: (
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={taxFlows}
                  className="clickable-rows"
                  onRow={(f) => ({ onClick: () => ui.openFlow(f.id) })}
                  columns={[
                    { title: '日期', dataIndex: 'date' },
                    { title: '主体', key: 'e', render: (_: unknown, f) => <EntityTag id={accMap.get(f.fromAccountId)?.entityId} /> },
                    { title: '收款方', key: 'to', render: (_: unknown, f) => accMap.get(f.toAccountId)?.name },
                    { title: '账面摘要', dataIndex: 'bookSummary' },
                    { title: '税种 / 所属期', key: 't', render: (_: unknown, f) => <Space>{f.splits.filter((s) => s.tax).map((s, i) => <Tag key={i}>{TAX_KIND[s.tax!]} {s.taxPeriod}</Tag>)}</Space> },
                    { title: '金额', dataIndex: 'amount', align: 'right', render: (v: number) => money(v) },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>
      <InvoiceModal invoice={editing} onClose={() => setEditing(undefined)} />
    </>
  );
}

function InvoiceModal({ invoice, onClose }: { invoice?: Invoice | 'new'; onClose: () => void }) {
  const [form] = Form.useForm();
  const entities = useStore((s) => s.entities);
  const scope = useStore((s) => s.entityScope);
  const mutate = useStore((s) => s.mutate);
  const cur = invoice && invoice !== 'new' ? invoice : undefined;
  const excl = Form.useWatch('amountExclTax', form);
  const rate = Form.useWatch('taxRate', form);
  const entityId = Form.useWatch('entityId', form);
  return (
    <Modal
      title={cur ? `编辑发票 ${cur.invoiceNo}` : '登记发票'}
      open={!!invoice}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        const body = { ...v, issueDate: v.issueDate.format('YYYY-MM-DD'), amountExclTax: toCents(v.amountExclTax), taxAmount: toCents(v.taxAmount), taxRate: v.taxRate / 100 };
        try {
          await mutate(() => (cur ? api.put(`/invoices/${cur.id}`, body) : api.post('/invoices', body)));
          message.success('已保存');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={cur ? { ...cur, issueDate: dayjs(cur.issueDate), amountExclTax: cur.amountExclTax / 100, taxAmount: cur.taxAmount / 100, taxRate: Math.round(cur.taxRate * 1000) / 10 } : { direction: 'INPUT', type: 'VAT_SPECIAL', issueDate: dayjs(today()), taxRate: 13, entityId: scope === 'ALL' ? undefined : scope }}
        onValuesChange={(ch) => {
          if ('amountExclTax' in ch || 'taxRate' in ch) {
            const e = form.getFieldValue('amountExclTax');
            const r = form.getFieldValue('taxRate');
            if (e != null && r != null) form.setFieldValue('taxAmount', Math.round(e * r) / 100);
          }
        }}
      >
        <Row gutter={12}>
          <Col span={6}><Form.Item name="direction" label="方向" rules={[{ required: true }]}><Select options={[{ value: 'OUTPUT', label: '销项（我方开出）' }, { value: 'INPUT', label: '进项（收到）' }]} /></Form.Item></Col>
          <Col span={6}><Form.Item name="type" label="票种" rules={[{ required: true }]}><Select options={[{ value: 'VAT_SPECIAL', label: '增值税专票' }, { value: 'VAT_NORMAL', label: '增值税普票' }]} /></Form.Item></Col>
          <Col span={6}><Form.Item name="invoiceNo" label="发票号" rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={6}><Form.Item name="issueDate" label="开票日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={12}><Form.Item name="entityId" label="我方主体" rules={[{ required: true }]}><Select options={entities.map((e) => ({ value: e.id, label: `${e.shortName} · ${e.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模'}` }))} /></Form.Item></Col>
          <Col span={12}><Form.Item name="projectId" label="项目"><ProjectSelect allowClear entityId={entityId} /></Form.Item></Col>
          <Col span={12}><Form.Item name="counterparty" label="对方单位" rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={12}><Form.Item name="goods" label="货物或服务名称" rules={[{ required: true }]}><Input placeholder="如：建筑服务*围栏工程" /></Form.Item></Col>
          <Col span={8}><Form.Item name="amountExclTax" label="不含税金额（元）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col span={8}><Form.Item name="taxRate" label="税率 / 征收率（%）" rules={[{ required: true }]}><Select options={[13, 9, 6, 5, 3, 1, 0].map((x) => ({ value: x, label: `${x}%` }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="taxAmount" label="税额（元）" rules={[{ required: true }]} extra={excl != null && rate != null ? `价税合计 ${money(toCents(excl) + toCents(form.getFieldValue('taxAmount') ?? 0))}` : undefined}><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col span={24}><Form.Item name="remark" label="备注"><Input /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  );
}
