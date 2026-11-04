import { Alert, Button, Card, Col, Descriptions, Empty, Row, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useParams } from 'react-router-dom';
import { Money } from '@/components/Money';
import { PageTitle } from '@/components/PageTitle';
import { TraceGraph } from '@/components/TraceGraph';
import { useUi } from '@/components/ui';
import { useMaps, useStore } from '@/data/store';
import { useTraces } from '@/data/hooks';
import { FLOW_METHOD, FLOW_STATUS, TRACE_STATUS } from '@ledger/shared/labels';
import type { TraceEdge } from '@ledger/shared/selectors';
import { daysSince, money } from '@ledger/shared/format';

export default function TraceDetail() {
  const { id } = useParams();
  const ui = useUi();
  const t = useTraces().find((x) => x.id === id);
  const flows = useStore((s) => s.flows);
  const { accMap, catMap, entMap } = useMaps();
  if (!t) return <Empty description="资金链不存在（可能根流水已作废或冲销）" />;
  const byId = new Map(flows.map((f) => [f.id, f]));
  const root = byId.get(t.rootFlowId)!;

  return (
    <>
      <PageTitle
        title={
          <Space>
            <span>{`资金链 T-${root.flowNo.slice(1)}`}</span>
            <Tag color={TRACE_STATUS[t.status].color}>{TRACE_STATUS[t.status].label}</Tag>
          </Space>
        }
        sub={`${accMap.get(root.fromAccountId)?.name} → ${accMap.get(root.toAccountId)?.name}，${root.date} 起`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => ui.newFlow()}>
            录入后续流转
          </Button>
        }
      />
      {t.reasons.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t.reasons.join('；')}
          description={
            <>
              {t.held >= 0.5 && <div>仍有 ¥{money(t.held)} 在个人/现金账户中（最早 {t.oldestHeldDate}，已 {daysSince(t.oldestHeldDate!)} 天）。请录入这笔钱的去向，或让持有人退回公户。</div>}
              {t.external >= 0.5 && <div>有 ¥{money(t.external)} 交给外部后未转回，需说明原因（手续费、返点、损失等）并核销。</div>}
            </>
          }
        />
      )}
      <Row gutter={16}>
        <Col span={17}>
          <Card size="small" title="资金流向">
            <TraceGraph trace={t} height={420} />
          </Card>
        </Col>
        <Col span={7}>
          <Card size="small" title="资金去向汇总">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="首次进入主体">{entMap.get(t.originEntityId ?? '')?.name ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="起始金额"><Money cents={t.rootAmount} strong /></Descriptions.Item>
              <Descriptions.Item label="已落地为费用/税费"><Money cents={t.landed} /></Descriptions.Item>
              <Descriptions.Item label="往来流出（借款/还款等）"><Money cents={t.outflow} /></Descriptions.Item>
              <Descriptions.Item label="留存在对公账户"><Money cents={t.retained} /></Descriptions.Item>
              <Descriptions.Item label="滞留个人/现金"><Typography.Text style={{ color: '#722ed1' }}>{money(t.held)}</Typography.Text></Descriptions.Item>
              <Descriptions.Item label="外部待说明"><Typography.Text type="warning">{money(t.external)}</Typography.Text></Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              合并资金按比例归属：如果一笔出款同时用了本链和其他链的钱，只把属于本链的部分计入。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
      <Card size="small" title="流转明细" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="flowId"
          pagination={false}
          className="clickable-rows"
          onRow={(e) => ({ onClick: () => ui.openFlow(e.flowId) })}
          dataSource={[...t.edges].sort((a, b) => a.depth - b.depth || byId.get(a.flowId)!.date.localeCompare(byId.get(b.flowId)!.date))}
          columns={[
            { title: '层级', dataIndex: 'depth', width: 60, render: (d: number) => <Tag>{d + 1}</Tag> },
            { title: '流水号', dataIndex: 'flowId', render: (fid: string) => byId.get(fid)?.flowNo },
            { title: '日期', key: 'd', render: (_: unknown, e: TraceEdge) => byId.get(e.flowId)?.date },
            { title: '转出', dataIndex: 'from', render: (a: string) => accMap.get(a)?.name },
            { title: '转入', dataIndex: 'to', render: (a: string) => accMap.get(a)?.name },
            { title: '方式', key: 'm', render: (_: unknown, e: TraceEdge) => FLOW_METHOD[byId.get(e.flowId)!.method] },
            { title: '类型', key: 'c', render: (_: unknown, e: TraceEdge) => catMap.get(byId.get(e.flowId)!.splits[0].categoryId)?.name },
            { title: '流水金额', key: 'a', align: 'right', render: (_: unknown, e: TraceEdge) => money(byId.get(e.flowId)!.amount) },
            { title: '归属本链', dataIndex: 'value', align: 'right', render: (v: number) => <Typography.Text strong>{money(v)}</Typography.Text> },
            { title: '状态', key: 's', render: (_: unknown, e: TraceEdge) => { const s = byId.get(e.flowId)!.status; return <Tag color={FLOW_STATUS[s].color}>{FLOW_STATUS[s].label}</Tag>; } },
          ]}
        />
      </Card>
    </>
  );
}
