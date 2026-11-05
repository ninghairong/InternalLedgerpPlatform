import { Alert, Button, Card, Col, DatePicker, Empty, Input, InputNumber, Row, Select, Space, Tag, Typography, message } from 'antd';
import { ArrowDownOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '@/components/PageTitle';
import { AccountSelect, CategorySelect, ProjectSelect } from '@/components/Pickers';
import { TraceGraph } from '@/components/TraceGraph';
import { useMaps, useStore } from '@/data/store';
import type { NewFlowInput } from '@ledger/shared/importer';
import { computeTraces, isLive } from '@ledger/shared/selectors';
import { FLOW_METHOD } from '@ledger/shared/labels';
import type { Account, Allocation, Flow, FlowMethod, ID } from '@ledger/shared/types';
import { cnUpper, money, toCents, today } from '@ledger/shared/format';

interface Step {
  key: string;
  date: Dayjs;
  from?: ID;
  to?: ID;
  amount?: number; // 元
  method: FlowMethod;
  projectId?: ID;
  categoryId?: ID;
  summary?: string;
}

const guessMethod = (from?: Account, to?: Account): FlowMethod =>
  to?.kind === 'CASH' ? 'CASH_WITHDRAW' : from?.kind === 'CASH' ? 'CASH_HANDOVER' : from?.kind === 'CORPORATE' && to?.kind !== 'INTERNAL_PERSONAL' ? 'CORPORATE_TRANSFER' : 'BANK_TRANSFER';

const guessCategory = (from?: Account, to?: Account): ID | undefined => {
  if (!from || !to) return undefined;
  if (to.kind === 'CASH') return 'c-trf-withdraw';
  if (from.kind === 'CASH' && to.kind === 'EXTERNAL') return 'c-trf-handover';
  if (to.kind === 'INTERNAL_PERSONAL') return 'c-trf-advance';
  if (to.kind === 'CORPORATE' && from.kind !== 'CORPORATE') return 'c-trf-return';
  return undefined;
};

let keySeq = 0;
const newStep = (prev?: Step): Step => ({ key: `s${++keySeq}`, date: prev?.date ?? dayjs(today()), from: prev?.to, method: 'BANK_TRANSFER', projectId: prev?.projectId, amount: prev?.amount });

export default function ChainWizard() {
  const nav = useNavigate();
  const flows = useStore((s) => s.flows);
  const accounts = useStore((s) => s.accounts);
  const addFlows = useStore((s) => s.addFlows);
  const categories = useStore((s) => s.categories);
  const [busy, setBusy] = useState(false);
  const { accMap } = useMaps();
  const [steps, setSteps] = useState<Step[]>(() => [newStep()]);

  const update = (key: string, patch: Partial<Step>) =>
    setSteps((ss) =>
      ss.map((s) => {
        if (s.key !== key) return s;
        const n = { ...s, ...patch };
        if ('from' in patch || 'to' in patch) {
          const f = n.from ? accMap.get(n.from) : undefined;
          const t = n.to ? accMap.get(n.to) : undefined;
          n.method = guessMethod(f, t);
          n.categoryId = guessCategory(f, t) ?? n.categoryId;
        }
        return n;
      }),
    );

  // 模拟入账：每一步出款优先使用本次链路中上一步转入的钱，不够再取该账户已有资金（同项目优先、先进先出）
  const sim = useMemo(() => {
    const working: Flow[] = flows.filter(isLive).map((f) => ({ ...f }));
    const remaining = new Map<ID, number>();
    for (const f of working) if (accMap.get(f.toAccountId)?.trace !== 'NONE') remaining.set(f.id, f.amount);
    for (const f of working) for (const a of f.allocations) remaining.set(a.lotFlowId, (remaining.get(a.lotFlowId) ?? 0) - a.amount);
    const results = steps.map((s) => {
      const tempId = `wiz-${s.key}`;
      const amount = toCents(s.amount);
      const errors: string[] = [];
      if (!s.from || !s.to) errors.push('请选择转出与转入账户');
      if (s.from && s.from === s.to) errors.push('转出与转入不能相同');
      if (!amount) errors.push('请输入金额');
      if (!s.projectId || !s.categoryId) errors.push('请选择项目与账目类型');
      const from = s.from ? accMap.get(s.from) : undefined;
      const allocations: Allocation[] = [];
      let fromChain = 0;
      if (from?.trace === 'REQUIRED' && amount) {
        const date = s.date.format('YYYY-MM-DD');
        const lots = [...remaining.entries()]
          .map(([id, left]) => ({ id, left, f: working.find((w) => w.id === id)! }))
          .filter((l) => l.left > 0 && l.f.toAccountId === from.id && l.f.date <= date)
          .sort(
            (a, b) =>
              Number(b.id.startsWith('wiz-')) - Number(a.id.startsWith('wiz-')) ||
              Number(b.f.splits.some((x) => x.projectId === s.projectId)) - Number(a.f.splits.some((x) => x.projectId === s.projectId)) ||
              a.f.date.localeCompare(b.f.date),
          );
        let need = amount;
        for (const l of lots) {
          if (need <= 0) break;
          const take = Math.min(need, l.left);
          allocations.push({ lotFlowId: l.id, amount: take, auto: true });
          if (l.id.startsWith('wiz-')) fromChain += take;
          need -= take;
        }
        if (need > 0) errors.push(`「${from.name}」可用资金 ${money(amount - need)}，不足 ${money(amount)}`);
      }
      if (!errors.length) {
        for (const a of allocations) remaining.set(a.lotFlowId, remaining.get(a.lotFlowId)! - a.amount);
        const f: Flow = {
          id: tempId, flowNo: `第${steps.indexOf(s) + 1}步`, date: s.date.format('YYYY-MM-DD'), amount, fromAccountId: s.from!, toAccountId: s.to!, method: s.method,
          bookSummary: s.summary, splits: [{ projectId: s.projectId!, categoryId: s.categoryId!, amount }], allocations, status: 'CONFIRMED', createdAt: '',
        };
        working.push(f);
        if (accMap.get(s.to!)?.trace !== 'NONE') remaining.set(tempId, amount);
      }
      return { step: s, tempId, amount, errors, allocations, fromChain, from };
    });
    const tempIds = new Set(results.map((r) => r.tempId));
    const traces = computeTraces(working, accounts, categories, today()).filter((t) => t.edges.some((e) => tempIds.has(e.flowId)));
    // 本次链路结束后，各内部账户中仍滞留的本链资金
    const leftovers = results
      .filter((r) => !r.errors.length && accMap.get(r.step.to!)?.trace === 'REQUIRED')
      .map((r) => ({ account: accMap.get(r.step.to!)!, left: remaining.get(r.tempId) ?? 0 }))
      .filter((x) => x.left > 0);
    return { results, traces, leftovers };
  }, [steps, flows, accounts, accMap, categories]);

  const valid = sim.results.every((r) => !r.errors.length);

  const save = async () => {
    if (!valid) return message.error('请先处理各步骤中的问题');
    const input: NewFlowInput[] = sim.results.map((r) => ({
      tempId: r.tempId, date: r.step.date.format('YYYY-MM-DD'), amount: r.amount, fromAccountId: r.step.from!, toAccountId: r.step.to!, method: r.step.method,
      bookSummary: r.step.summary, splits: [{ projectId: r.step.projectId!, categoryId: r.step.categoryId!, amount: r.amount }], allocations: r.allocations,
    }));
    setBusy(true);
    let created: { id: string }[];
    try {
      created = await addFlows(input);
    } catch (e) {
      setBusy(false);
      return message.error((e as Error).message);
    }
    setBusy(false);
    message.success(`已保存 ${created.length} 笔流水`);
    const st = useStore.getState();
    const root = computeTraces(st.flows, st.accounts, st.categories, today(), st.writeoffs).find((t) => t.edges.some((e) => e.flowId === created[created.length - 1].id));
    nav(root ? `/traces/${root.id}` : '/flows');
  };

  return (
    <>
      <PageTitle
        title="连续流转录入"
        sub="一次录完一笔钱的完整去向，例如：公户 → 个人卡 → 取现 → 现金交付 → 对方转回公户。每一步自动接上一步的资金。"
        extra={
          <Button type="primary" disabled={!valid} loading={busy} onClick={save}>
            保存全部
          </Button>
        }
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          {sim.results.map((r, i) => (
            <div key={r.step.key}>
              <Card
                size="small"
                title={
                  <Space>
                    <Tag color="blue">第 {i + 1} 步</Tag>
                    {r.from && r.step.to && (
                      <Typography.Text type="secondary">
                        {r.from.name} → {accMap.get(r.step.to)?.name}
                      </Typography.Text>
                    )}
                  </Space>
                }
                extra={steps.length > 1 && <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => setSteps((ss) => ss.filter((s) => s.key !== r.step.key))} />}
              >
                <Row gutter={[8, 8]}>
                  <Col xs={24} md={6}>
                    <DatePicker style={{ width: '100%' }} value={r.step.date} onChange={(d) => d && update(r.step.key, { date: d })} allowClear={false} />
                  </Col>
                  <Col xs={24} md={9}>
                    <AccountSelect style={{ width: '100%' }} placeholder="从" value={r.step.from} onChange={(v) => update(r.step.key, { from: v })} />
                  </Col>
                  <Col xs={24} md={9}>
                    <AccountSelect style={{ width: '100%' }} placeholder="到" value={r.step.to} onChange={(v) => update(r.step.key, { to: v })} />
                  </Col>
                </Row>
                <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
                  <Col xs={12} md={6}>
                    <InputNumber style={{ width: '100%' }} placeholder="金额（元）" min={0.01} precision={2} value={r.step.amount} onChange={(v) => update(r.step.key, { amount: v ?? undefined })} />
                  </Col>
                  <Col xs={12} md={5}>
                    <Select style={{ width: '100%' }} value={r.step.method} onChange={(v) => update(r.step.key, { method: v })} options={Object.entries(FLOW_METHOD).map(([value, label]) => ({ value, label }))} />
                  </Col>
                  <Col xs={24} md={13}>
                    <ProjectSelect style={{ width: '100%' }} value={r.step.projectId} onChange={(v) => update(r.step.key, { projectId: v })} />
                  </Col>
                </Row>
                <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
                  <Col xs={24} md={11}>
                    <CategorySelect style={{ width: '100%' }} value={r.step.categoryId} onChange={(v) => update(r.step.key, { categoryId: v })} />
                  </Col>
                  <Col xs={24} md={13}>
                    <Input placeholder="摘要 / 实际用途" value={r.step.summary} onChange={(e) => update(r.step.key, { summary: e.target.value })} />
                  </Col>
                </Row>
                <div style={{ marginTop: 8 }}>
                  {r.amount > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{cnUpper(r.amount)}　</Typography.Text>}
                  {r.errors.length > 0 ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {r.errors.join('；')}
                    </Typography.Text>
                  ) : r.allocations.length ? (
                    <Typography.Text style={{ fontSize: 12, color: '#722ed1' }}>
                      资金来源：{r.fromChain ? `本链上一步 ${money(r.fromChain)}` : ''}
                      {r.fromChain && r.fromChain < r.amount ? ' + ' : ''}
                      {r.fromChain < r.amount ? `该账户已有资金 ${money(r.amount - r.fromChain)}（同项目优先、先进先出）` : ''}
                    </Typography.Text>
                  ) : null}
                </div>
              </Card>
              <div style={{ textAlign: 'center', color: '#bfbfbf', padding: 4 }}>
                <ArrowDownOutlined />
              </div>
            </div>
          ))}
          <Button block type="dashed" icon={<PlusOutlined />} onClick={() => setSteps((ss) => [...ss, newStep(ss[ss.length - 1])])}>
            添加下一步（从上一步的转入账户继续）
          </Button>
        </Col>
        <Col xs={24} lg={11}>
          <Card size="small" title="链路预览" style={{ position: 'sticky', top: 16 }}>
            {sim.traces.length ? (
              sim.traces.map((t) => <TraceGraph key={t.id} trace={t} height={320} />)
            ) : (
              <Empty description="填写第一步后显示资金流向" />
            )}
            {sim.leftovers.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="未闭环"
                description={sim.leftovers.map((x) => `${x.account.name} 滞留 ¥${money(x.left)}`).join('；')}
              />
            ) : (
              valid && sim.traces.length > 0 && <Alert type="success" showIcon message="本次录入的资金已全部有去向" />
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}
