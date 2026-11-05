import { Button, Card, Checkbox, Col, Row, Segmented, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { useState } from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { Link, useSearchParams } from 'react-router-dom';
import { PageTitle } from '@/components/PageTitle';
import { useMaps, useStore } from '@/data/store';
import { useTraces } from '@/data/hooks';
import { STALE_DAYS, type Trace, type TraceStatus } from '@ledger/shared/selectors';
import { TRACE_STATUS } from '@ledger/shared/labels';
import { daysSince, money } from '@ledger/shared/format';
import { api } from '@/api';

export default function Traces() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as TraceStatus | null) ?? 'ALL';
  const traces = useTraces();
  const flows = useStore((s) => s.flows);
  const scope = useStore((s) => s.entityScope);
  const { accMap } = useMaps();
  const byId = new Map(flows.map((f) => [f.id, f]));
  const [viaPerson, setViaPerson] = useState(false);
  const rows = traces.filter((t) => (status === 'ALL' || t.status === status) && (!viaPerson || t.viaPerson)).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  const sum = (k: keyof Pick<Trace, 'held' | 'retained' | 'external'>) => traces.reduce((s, t) => s + t[k], 0);

  return (
    <>
      <PageTitle
        title="资金链"
        sub={`每一笔从外部进入的钱（项目回款、借款、期初等）都是一条资金链，逐笔追踪到最终落地为费用或税费。个人/现金账户中滞留超过 ${STALE_DAYS} 天、或外部差额未说明的标为异常。`}
        extra={
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              await api.download(`/exports/traces${api.qs({ entityId: scope === 'ALL' ? undefined : scope })}`).catch((e) => message.error(e.message));
            }}
          >
            导出资金链
          </Button>
        }
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={6}><Card size="small"><Statistic title="资金链总数" value={traces.length} /></Card></Col>
        <Col xs={12} lg={6}><Card size="small"><Statistic title="留存在对公账户（未使用）" value={money(sum('retained'))} prefix="¥" /></Card></Col>
        <Col xs={12} lg={6}><Card size="small"><Statistic title="滞留在个人/现金账户" value={money(sum('held'))} prefix="¥" valueStyle={{ color: '#722ed1' }} /></Card></Col>
        <Col xs={12} lg={6}><Card size="small"><Statistic title="外部账户待说明差额" value={money(sum('external'))} prefix="¥" valueStyle={{ color: '#d48806' }} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 12 }}>
        <Segmented
          value={status}
          onChange={(v) => setParams(v === 'ALL' ? {} : { status: String(v) })}
          options={[{ label: '全部', value: 'ALL' }, ...Object.entries(TRACE_STATUS).map(([value, { label }]) => ({ label, value }))]}
        />
        <Checkbox checked={viaPerson} onChange={(e) => setViaPerson(e.target.checked)}>
          只看经过个人卡 / 现金的
        </Checkbox>
        </Space>
        <Table
          rowKey="id"
          size="middle"
          dataSource={rows}
          columns={[
            { title: '链路号', key: 'no', width: 150, render: (_: unknown, t) => <Link to={`/traces/${t.id}`}>T-{byId.get(t.rootFlowId)?.flowNo.slice(1)}</Link> },
            {
              title: '起点',
              key: 'root',
              render: (_: unknown, t) => {
                const r = byId.get(t.rootFlowId)!;
                return (
                  <Space direction="vertical" size={0}>
                    <span>{accMap.get(r.fromAccountId)?.name} → {accMap.get(r.toAccountId)?.name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.date} · {t.edges.length} 步流转{t.viaPerson ? ' · 经过个人/现金' : ''}</Typography.Text>
                  </Space>
                );
              },
            },
            { title: '起始金额', dataIndex: 'rootAmount', align: 'right', render: (v: number) => money(v) },
            { title: '已落地', dataIndex: 'landed', align: 'right', render: (v: number) => money(v) },
            { title: '往来流出', dataIndex: 'outflow', align: 'right', render: (v: number) => (v >= 0.5 ? money(v) : '—') },
            { title: '留存公户', dataIndex: 'retained', align: 'right', render: (v: number) => (v >= 0.5 ? money(v) : '—') },
            { title: '滞留个人/现金', dataIndex: 'held', align: 'right', render: (v: number) => (v >= 0.5 ? <Typography.Text style={{ color: '#722ed1' }} strong>{money(v)}</Typography.Text> : '—') },
            { title: '外部待说明', dataIndex: 'external', align: 'right', render: (v: number) => (v >= 0.5 ? <Typography.Text type="warning">{money(v)}</Typography.Text> : '—') },
            { title: '滞留天数', key: 'age', align: 'right', render: (_: unknown, t) => (t.oldestHeldDate && t.held >= 0.5 ? `${daysSince(t.oldestHeldDate)} 天` : '—') },
            { title: '状态', dataIndex: 'status', render: (s: TraceStatus, t) => <Space direction="vertical" size={0}><Tag color={TRACE_STATUS[s].color}>{TRACE_STATUS[s].label}</Tag>{t.reasons.map((r) => <Typography.Text key={r} type="secondary" style={{ fontSize: 12 }}>{r}</Typography.Text>)}</Space> },
          ]}
        />
      </Card>
    </>
  );
}
