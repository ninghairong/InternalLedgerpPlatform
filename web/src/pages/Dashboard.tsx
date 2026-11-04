import { Alert, Button, Card, Col, List, Progress, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Money } from '@/components/Money';
import { EntityTag } from '@/components/Pickers';
import { useUi } from '@/components/ui';
import { useMaps, useStore } from '@/data/store';
import { useBalances, useLots, useProjectStats, useScopedFlows, useScopedProjects, useTraces } from '@/data/hooks';
import { isHeldByPerson, isLive, STALE_DAYS } from '@ledger/shared/selectors';
import { daysSince, money, moneyShort, today } from '@ledger/shared/format';

export default function Dashboard() {
  const nav = useNavigate();
  const ui = useUi();
  const accounts = useStore((s) => s.accounts);
  const scope = useStore((s) => s.entityScope);
  const flows = useScopedFlows();
  const projects = useScopedProjects();
  const bal = useBalances();
  const lotMap = useLots();
  const traces = useTraces();
  const stats = useProjectStats();
  const { accMap, catMap } = useMaps();

  const corporate = accounts.filter((a) => a.kind === 'CORPORATE' && (scope === 'ALL' || a.entityId === scope));
  const corporateTotal = corporate.reduce((s, a) => s + (bal.get(a.id) ?? 0), 0);
  const internal = accounts.filter((a) => isHeldByPerson(a.kind));
  const internalTotal = internal.reduce((s, a) => s + (bal.get(a.id) ?? 0), 0);
  const recent = useMemo(() => flows.filter(isLive).sort((a, b) => b.date.localeCompare(a.date) || b.flowNo.localeCompare(a.flowNo)).slice(0, 6), [flows]);
  const abnormal = traces.filter((t) => t.status === 'ABNORMAL');

  const stale = useMemo(
    () =>
      [...lotMap.values()]
        .filter((l) => isHeldByPerson(accMap.get(l.accountId)?.kind) && l.remaining > 0 && daysSince(l.date) > STALE_DAYS)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [lotMap, accMap],
  );

  // 近 12 个月收支（只算影响损益的分摊行）
  const monthly = useMemo(() => {
    const months: string[] = [];
    const d = new Date(today());
    for (let i = 11; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
    }
    const inc = Object.fromEntries(months.map((m) => [m, 0]));
    const exp = Object.fromEntries(months.map((m) => [m, 0]));
    for (const f of flows) {
      if (!isLive(f)) continue;
      const m = f.date.slice(0, 7);
      if (!(m in inc)) continue;
      for (const s of f.splits) {
        const c = catMap.get(s.categoryId);
        if (!c?.affectsPnl) continue;
        if (c.nature === 'INCOME') inc[m] += s.amount;
        else exp[m] += s.amount;
      }
    }
    return { months, inc: months.map((m) => inc[m] / 100), exp: months.map((m) => exp[m] / 100) };
  }, [flows, catMap]);

  const monthKey = today().slice(0, 7);
  const thisMonth = useMemo(() => {
    let inc = 0;
    let exp = 0;
    for (const f of flows) {
      if (!isLive(f) || f.date.slice(0, 7) !== monthKey) continue;
      for (const s of f.splits) {
        const c = catMap.get(s.categoryId);
        if (!c?.affectsPnl) continue;
        if (c.nature === 'INCOME') inc += s.amount;
        else exp += s.amount;
      }
    }
    return { inc, exp };
  }, [flows, catMap, monthKey]);

  const projectRows = projects
    .filter((p) => p.kind === 'NORMAL')
    .map((p) => {
      const st = stats.get(p.id);
      const budget = Object.values(p.budget).reduce((a, b) => a + b, 0);
      return { ...p, income: st?.income ?? 0, expense: st?.expense ?? 0, budgetTotal: budget };
    })
    .sort((a, b) => b.expense - a.expense);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {abnormal.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`${abnormal.length} 条资金链异常：${abnormal.map((t) => t.reasons.join('、')).filter((v, i, a) => a.indexOf(v) === i).join('；')}`}
          action={
            <Button size="small" danger onClick={() => nav('/traces?status=ABNORMAL')}>
              查看
            </Button>
          }
        />
      )}
      <Row gutter={16}>
        <Col span={5}>
          <Card>
            <Statistic title={`对公账户余额（${corporate.length} 个账户）`} value={money(corporateTotal)} prefix="¥" />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title={<Tooltip title="内部个人账户与现金账户余额合计，即员工手中的公司资金">个人代管资金</Tooltip>} value={money(internalTotal)} prefix="¥" valueStyle={{ color: internalTotal > 0 ? '#722ed1' : undefined }} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title={`本月收入（${monthKey}）`} value={money(thisMonth.inc)} prefix="¥" valueStyle={{ color: '#389e0d' }} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title={`本月支出（${monthKey}）`} value={money(thisMonth.exp)} prefix="¥" valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card hoverable onClick={() => nav('/traces?status=ABNORMAL')}>
            <Statistic title="异常资金链" value={abnormal.length} suffix="条" valueStyle={{ color: abnormal.length ? '#cf1322' : undefined }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={15}>
          <Card title="近 12 个月收支（管理口径，不含内部划转）" size="small">
            <ReactECharts
              style={{ height: 280 }}
              option={{
                tooltip: { trigger: 'axis', valueFormatter: (v: number) => `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}` },
                legend: { data: ['收入', '支出'], top: 0 },
                grid: { left: 60, right: 16, top: 32, bottom: 24 },
                xAxis: { type: 'category', data: monthly.months },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => (v >= 10000 ? `${v / 10000}万` : v) } },
                series: [
                  { name: '收入', type: 'bar', data: monthly.inc, itemStyle: { color: '#52c41a' }, barMaxWidth: 18 },
                  { name: '支出', type: 'bar', data: monthly.exp, itemStyle: { color: '#ff7875' }, barMaxWidth: 18 },
                ],
              }}
            />
          </Card>
        </Col>
        <Col span={9}>
          <Card
            title={
              <Space>
                <WarningOutlined style={{ color: '#fa541c' }} />
                资金滞留预警（超过 {STALE_DAYS} 天）
              </Space>
            }
            size="small"
            styles={{ body: { height: 280, overflow: 'auto' } }}
          >
            <List
              dataSource={stale}
              locale={{ emptyText: '没有滞留资金' }}
              renderItem={(l) => {
                const src = useStore.getState().flows.find((f) => f.id === l.flowId)!;
                return (
                  <List.Item actions={[<a key="v" onClick={() => ui.openFlow(l.flowId)}>查看</a>]}>
                    <List.Item.Meta
                      title={
                        <Space>
                          {accMap.get(l.accountId)?.name}
                          <Tag color="red">{daysSince(l.date)} 天</Tag>
                        </Space>
                      }
                      description={`${l.date} 来自 ${accMap.get(src.fromAccountId)?.name}，剩余 ¥${money(l.remaining)} / ${money(l.original)}`}
                    />
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={15}>
          <Card title="项目概况" size="small" extra={<Link to="/projects">全部项目</Link>}>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={projectRows.slice(0, 6)}
              columns={[
                { title: '项目', dataIndex: 'name', ellipsis: true, render: (v: string, p) => <Link to={`/projects/${p.id}`}>{v}</Link> },
                { title: '主体', dataIndex: 'entityId', width: 90, render: (id: string) => <EntityTag id={id} /> },
                { title: '收入', dataIndex: 'income', align: 'right', width: 110, render: (v: number) => moneyShort(v) },
                { title: '支出', dataIndex: 'expense', align: 'right', width: 110, render: (v: number) => moneyShort(v) },
                {
                  title: '预算执行',
                  key: 'b',
                  width: 140,
                  render: (_: unknown, p) => {
                    const pct = p.budgetTotal ? Math.round((p.expense / p.budgetTotal) * 100) : 0;
                    return <Progress percent={pct} size="small" status={pct > 100 ? 'exception' : 'normal'} />;
                  },
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={9}>
          <Card title="最近流水" size="small" extra={<Link to="/flows">全部</Link>}>
            <List
              size="small"
              dataSource={recent}
              locale={{ emptyText: '暂无流水' }}
              renderItem={(f) => (
                <List.Item onClick={() => ui.openFlow(f.id)} style={{ cursor: 'pointer' }}>
                  <Space direction="vertical" size={0} style={{ width: '100%' }}>
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Typography.Text>
                        {accMap.get(f.fromAccountId)?.name} → {accMap.get(f.toAccountId)?.name}
                      </Typography.Text>
                      <Money cents={f.amount} strong />
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {f.date} · {catMap.get(f.splits[0].categoryId)?.name} · {f.flowNo}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
