import { Alert, Button, Card, Col, Descriptions, Empty, List, Modal, Row, Space, Statistic, Table, Tabs, Tag, Typography, message } from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, DownloadOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FlowTable } from '@/components/FlowTable';
import { EntityTag } from '@/components/Pickers';
import { PageTitle } from '@/components/PageTitle';
import { TraceGraph } from '@/components/TraceGraph';
import { useUi } from '@/components/ui';
import { useCanWrite, useIsAdmin, useMaps, useStore } from '@/data/store';
import { ProjectFormModal } from './Projects';
import { api } from '@/api';
import { taxAssessments } from '@ledger/shared/tax';
import { useProjectStats, useTraces } from '@/data/hooks';
import { PROJECT_STATUS, TRACE_STATUS } from '@ledger/shared/labels';
import { money, moneyShort } from '@ledger/shared/format';

export default function ProjectDetail() {
  const { id } = useParams();
  const ui = useUi();
  const project = useStore((s) => s.projects.find((p) => p.id === id));
  const allFlows = useStore((s) => s.flows);
  const allInvoices = useStore((s) => s.invoices);
  const snapshot = useStore();
  const categories = snapshot.categories;
  const mutate = snapshot.mutate;
  const canWrite = useCanWrite();
  const isAdmin = useIsAdmin();
  const [editing, setEditing] = useState(false);
  const entity = useStore((s) => s.entities.find((e) => e.id === project?.entityId));
  const stats = useProjectStats().get(id ?? '');
  const traces = useTraces();
  const { accMap, catMap } = useMaps();

  const flows = useMemo(() => allFlows.filter((f) => f.splits.some((s) => s.projectId === id)), [allFlows, id]);
  const invoices = useMemo(() => allInvoices.filter((i) => i.projectId === id), [allInvoices, id]);
  const myTraces = useMemo(() => {
    const ids = new Set(flows.map((f) => f.id));
    return traces.filter((t) => t.edges.some((e) => ids.has(e.flowId)));
  }, [traces, flows]);

  if (!project || !entity) return <Empty description="项目不存在" />;

  const tops = categories.filter((c) => !c.parentId && c.nature === 'EXPENSE');
  const budgetRows = tops
    .map((c) => ({ id: c.id, name: c.name, budget: project.budget[c.id] ?? 0, actual: stats?.byTop[c.id] ?? 0 }))
    .filter((r) => r.budget || r.actual);
  const budgetTotal = Object.values(project.budget).reduce((a, b) => a + b, 0);
  const income = stats?.income ?? 0;
  const expense = stats?.expense ?? 0;
  const held = myTraces.reduce((s, t) => s + t.held, 0);

  // 税费估算（管理口径）：按项目发票、按主体当期纳税人身份计算
  const output = invoices.filter((i) => i.direction === 'OUTPUT');
  const input = invoices.filter((i) => i.direction === 'INPUT');
  const outTax = output.reduce((s, i) => s + i.taxAmount, 0);
  const projTax = taxAssessments({ ...snapshot, invoices }, new Set([entity.id]));
  const vat = projTax.reduce((s, r) => s + r.vat, 0);
  const surcharge = projTax.reduce((s, r) => s + r.surcharge, 0);
  const inTax = projTax.reduce((s, r) => s + r.inTax, 0);
  const general = entity.taxpayerType === 'GENERAL';

  // 结项检查由后端执行（与结项时的校验一致）
  const settle = async () => {
    let checks: { ok: boolean; text: string }[];
    try {
      checks = await api.get(`/projects/${project.id}/close-checks`);
    } catch (e) {
      return message.error((e as Error).message);
    }
    const passed = checks.every((c) => c.ok);
    Modal.confirm({
      title: '结项检查',
      width: 520,
      okText: passed ? '确认结项' : isAdmin ? '仍然结项（管理员）' : '知道了',
      okButtonProps: { disabled: !passed && !isAdmin, danger: !passed },
      content: (
        <List
          dataSource={checks}
          renderItem={(c) => (
            <List.Item>
              <Space>
                {c.ok ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <CloseCircleTwoTone twoToneColor="#ff4d4f" />}
                {c.text}
              </Space>
            </List.Item>
          )}
        />
      ),
      onOk: async () => {
        try {
          await mutate(() => api.post(`/projects/${project.id}/close`, { force: !passed }));
          message.success('项目已结项，之后不能再记账');
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <>
      <PageTitle
        title={
          <Space>
            {project.name}
            <Tag color={PROJECT_STATUS[project.status].color}>{PROJECT_STATUS[project.status].label}</Tag>
          </Space>
        }
        sub={
          <Space split="·">
            <span>{project.code}</span>
            <span>
              <EntityTag id={project.entityId} />
              {entity.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模纳税人'} · {project.vatMethod === 'GENERAL' ? '一般计税' : '简易计税'}
            </span>
            <span>负责人 {project.manager}</span>
            {project.customer && <span>客户 {project.customer}</span>}
          </Space>
        }
        extra={
          <>
            {canWrite && project.status !== 'CLOSED' && (
              <Button icon={<PlusOutlined />} onClick={() => ui.newFlow()}>
                记一笔
              </Button>
            )}
            {canWrite && project.kind === 'NORMAL' && (
              <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                编辑
              </Button>
            )}
            <Button icon={<DownloadOutlined />} onClick={() => api.download(`/exports/settlement?projectId=${project.id}`).catch((e) => message.error(e.message))}>
              导出结算单
            </Button>
            {canWrite && project.status !== 'CLOSED' && project.kind === 'NORMAL' && (
              <Button type="primary" onClick={settle}>
                结项
              </Button>
            )}
            {isAdmin && project.status === 'CLOSED' && (
              <Button onClick={() => mutate(() => api.post(`/projects/${project.id}/reopen`)).then(() => message.success('已重新开启')).catch((e) => message.error(e.message))}>
                重新开启
              </Button>
            )}
            <ProjectFormModal open={editing} project={project} onClose={() => setEditing(false)} />
          </>
        }
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {[
          ['合同额', project.contractAmount, undefined],
          ['已收款', income, '#389e0d'],
          ['已支出', expense, '#cf1322'],
          ['收支差', income - expense, undefined],
          ['预算余额', budgetTotal - expense, budgetTotal - expense < 0 ? '#cf1322' : undefined],
          ['滞留个人资金', held, held > 0 ? '#722ed1' : undefined],
        ].map(([t, v, c]) => (
          <Col xs={12} sm={8} xl={4} key={t as string}>
            <Card size="small">
              <Statistic title={t as string} value={moneyShort(v as number)} valueStyle={{ color: c as string | undefined, fontSize: 20 }} />
            </Card>
          </Col>
        ))}
      </Row>
      <Card>
        <Tabs
          items={[
            {
              key: 'overview',
              label: '概览',
              children: (
                <Row gutter={[24, 16]}>
                  <Col xs={24} lg={14}>
                    <Typography.Title level={5}>预算 vs 实际</Typography.Title>
                    {budgetRows.length ? (
                      <ReactECharts
                        style={{ height: 260 }}
                        option={{
                          tooltip: { trigger: 'axis', valueFormatter: (v: number) => `¥${v.toLocaleString('zh-CN')}` },
                          legend: { data: ['预算', '实际'] },
                          grid: { left: 80, right: 20, top: 30, bottom: 20 },
                          yAxis: { type: 'category', data: budgetRows.map((r) => r.name) },
                          xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${v / 10000}万` } },
                          series: [
                            { name: '预算', type: 'bar', data: budgetRows.map((r) => r.budget / 100), itemStyle: { color: '#d9d9d9' }, barGap: '-100%', barWidth: 16 },
                            { name: '实际', type: 'bar', data: budgetRows.map((r) => ({ value: r.actual / 100, itemStyle: { color: r.actual > r.budget && r.budget ? '#ff4d4f' : '#1677ff' } })), barWidth: 10 },
                          ],
                        }}
                      />
                    ) : (
                      <Empty description="暂无支出" />
                    )}
                  </Col>
                  <Col xs={24} lg={10}>
                    <Typography.Title level={5}>支出构成</Typography.Title>
                    <ReactECharts
                      style={{ height: 260 }}
                      option={{
                        tooltip: { trigger: 'item', valueFormatter: (v: number) => `¥${v.toLocaleString('zh-CN')}` },
                        series: [{ type: 'pie', radius: ['45%', '70%'], data: Object.entries(stats?.byTop ?? {}).map(([k, v]) => ({ name: catMap.get(k)?.name, value: v / 100 })), label: { formatter: '{b}\n{d}%' } }],
                      }}
                    />
                  </Col>
                </Row>
              ),
            },
            { key: 'flows', label: `流水（${flows.length}）`, children: <FlowTable flows={flows} perspectiveEntityId={project.entityId} exportTitle={`${project.name}_流水`} /> },
            {
              key: 'traces',
              label: `资金链（${myTraces.length}）`,
              children: myTraces.length ? (
                myTraces.map((t) => {
                  const root = allFlows.find((f) => f.id === t.rootFlowId)!;
                  return (
                    <Card key={t.id} size="small" style={{ marginBottom: 12 }} title={<Space><Link to={`/traces/${t.id}`}>T-{root.flowNo.slice(1)}</Link><span>{`${accMap.get(root.fromAccountId)?.name} → ${accMap.get(root.toAccountId)?.name}  ¥${money(t.rootAmount)}`}</span><Tag color={TRACE_STATUS[t.status].color}>{TRACE_STATUS[t.status].label}</Tag></Space>}>
                      {t.reasons.length > 0 && <Alert type="warning" showIcon message={t.reasons.join('；')} style={{ marginBottom: 8 }} />}
                      <TraceGraph trace={t} height={220} />
                    </Card>
                  );
                })
              ) : (
                <Empty description="本项目没有经过个人/现金账户的资金" />
              ),
            },
            {
              key: 'tax',
              label: '发票与税费',
              children: (
                <>
                  <Descriptions bordered size="small" column={{ xs: 1, sm: 2, xl: 4 }} style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="纳税人身份">{general ? '一般纳税人' : '小规模纳税人'}</Descriptions.Item>
                    <Descriptions.Item label="销项税额">¥{money(outTax)}</Descriptions.Item>
                    <Descriptions.Item label={general ? '可抵扣进项（专票）' : '进项（不可抵扣，计入成本）'}>¥{money(general ? inTax : input.reduce((s, i) => s + i.taxAmount, 0))}</Descriptions.Item>
                    <Descriptions.Item label="应纳增值税（估）">¥{money(vat)}</Descriptions.Item>
                    <Descriptions.Item label="附加税（估）" span="filled">
                      ¥{money(surcharge)}　<Typography.Text type="secondary">{general ? '城建 7% + 教育附加 3% + 地方教育附加 2%' : '同左，叠加"六税两费"减半'}；正式计算按主体申报期汇总，见"发票与税费"</Typography.Text>
                    </Descriptions.Item>
                  </Descriptions>
                  <Table
                    size="small"
                    rowKey="id"
                    dataSource={invoices}
                    pagination={false}
                    columns={[
                      { title: '方向', dataIndex: 'direction', render: (d: string) => (d === 'OUTPUT' ? <Tag color="green">销项</Tag> : <Tag color="blue">进项</Tag>) },
                      { title: '票种', dataIndex: 'type', render: (t: string) => (t === 'VAT_SPECIAL' ? '专票' : '普票') },
                      { title: '发票号', dataIndex: 'invoiceNo' },
                      { title: '开票日期', dataIndex: 'issueDate' },
                      { title: '对方', dataIndex: 'counterparty' },
                      { title: '不含税金额', dataIndex: 'amountExclTax', align: 'right', render: (v: number) => money(v) },
                      { title: '税率', dataIndex: 'taxRate', render: (v: number) => `${v * 100}%` },
                      { title: '税额', dataIndex: 'taxAmount', align: 'right', render: (v: number) => money(v) },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
