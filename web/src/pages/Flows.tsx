import { Button, Card, Checkbox, DatePicker, Input, Select, Space } from 'antd';
import { NodeIndexOutlined, PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FlowTable } from '@/components/FlowTable';
import { PageTitle } from '@/components/PageTitle';
import { AccountSelect, ProjectSelect } from '@/components/Pickers';
import { useUi } from '@/components/ui';
import { useCanWrite, useMaps, useStore } from '@/data/store';
import { useScopedFlows } from '@/data/hooks';
import { FLOW_STATUS } from '@ledger/shared/labels';
import type { FlowStatus, ID } from '@ledger/shared/types';

export default function Flows() {
  const ui = useUi();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const scoped = useScopedFlows();
  const scope = useStore((s) => s.entityScope);
  const categories = useStore((s) => s.categories);
  const canWrite = useCanWrite();
  const { accMap, catMap } = useMaps();

  const status = (params.get('status') as FlowStatus | null) ?? undefined;
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [account, setAccount] = useState<ID>();
  const [project, setProject] = useState<ID>();
  const [topCat, setTopCat] = useState<ID>();
  const [q, setQ] = useState('');
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  const [onlyIc, setOnlyIc] = useState(false);
  const [showDead, setShowDead] = useState(false);

  const flows = useMemo(
    () =>
      scoped.filter((f) => {
        if (status && f.status !== status) return false;
        if (!status && !showDead && (f.status === 'VOIDED' || f.status === 'REVERSED')) return false;
        if (range?.[0] && f.date < range[0].format('YYYY-MM-DD')) return false;
        if (range?.[1] && f.date > range[1].format('YYYY-MM-DD')) return false;
        if (account && f.fromAccountId !== account && f.toAccountId !== account) return false;
        if (project && !f.splits.some((s) => s.projectId === project)) return false;
        if (topCat && !f.splits.some((s) => (catMap.get(s.categoryId)?.parentId ?? s.categoryId) === topCat)) return false;
        if (onlyMismatch && !f.purposeMismatch) return false;
        if (onlyIc && !f.icNature) return false;
        if (q) {
          const hay = [f.flowNo, f.bookSummary, f.actualPurpose, f.remark, f.handler, accMap.get(f.fromAccountId)?.name, accMap.get(f.toAccountId)?.name, String(f.amount / 100)].join(' ');
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [scoped, status, showDead, range, account, project, topCat, onlyMismatch, onlyIc, q, accMap, catMap],
  );

  return (
    <>
      <PageTitle
        title="资金流水"
        sub="每一笔资金移动；已确认的流水只能冲销，不能修改或删除"
        extra={
          canWrite && <>
            <Button icon={<NodeIndexOutlined />} onClick={() => nav('/flows/chain')}>
              连续流转录入
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => ui.newFlow()}>
              新建流水
            </Button>
          </>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 110 }}
            value={status}
            onChange={(v) => setParams(v ? { status: v } : {})}
            options={Object.entries(FLOW_STATUS).map(([value, { label }]) => ({ value, label }))}
          />
          <DatePicker.RangePicker value={range} onChange={(v) => setRange(v)} />
          <AccountSelect allowClear style={{ width: 230 }} placeholder="账户" value={account} onChange={setAccount} showBalance={false} />
          <ProjectSelect allowClear style={{ width: 260 }} placeholder="项目" value={project} onChange={setProject} entityId={scope === 'ALL' ? undefined : scope} />
          <Select allowClear placeholder="账目类型" style={{ width: 130 }} value={topCat} onChange={setTopCat} options={categories.filter((c) => !c.parentId).map((c) => ({ value: c.id, label: c.name }))} />
          <Input.Search placeholder="摘要 / 流水号 / 金额 / 经办人" allowClear onSearch={setQ} style={{ width: 240 }} />
          <Checkbox checked={onlyMismatch} onChange={(e) => setOnlyMismatch(e.target.checked)}>
            用途不一致
          </Checkbox>
          <Checkbox checked={onlyIc} onChange={(e) => setOnlyIc(e.target.checked)}>
            集团内往来
          </Checkbox>
          <Checkbox checked={showDead} onChange={(e) => setShowDead(e.target.checked)}>
            显示已作废/冲销
          </Checkbox>
        </Space>
        <FlowTable flows={flows} perspectiveEntityId={scope === 'ALL' ? undefined : scope} perspectiveAccountId={account} exportTitle="资金流水" />
      </Card>
    </>
  );
}
