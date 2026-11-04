import { Button, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { DownloadOutlined, LinkOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import { Money } from './Money';
import { EntityTag } from './Pickers';
import { useUi } from './ui';
import { useMaps } from '@/data/store';
import { FLOW_METHOD, FLOW_STATUS } from '@ledger/shared/labels';
import type { Flow, ID } from '@ledger/shared/types';
import { api } from '@/api';

/**
 * 通用流水表。perspectiveAccountId / perspectiveEntityId 指定"站在谁的角度"显示收支方向。
 */
export function FlowTable({
  flows,
  perspectiveAccountId,
  perspectiveEntityId,
  exportTitle,
  pageSize = 15,
  showRunningBalance,
}: {
  flows: Flow[];
  perspectiveAccountId?: ID;
  perspectiveEntityId?: ID;
  exportTitle?: string;
  pageSize?: number;
  showRunningBalance?: boolean;
}) {
  const ui = useUi();
  const [exporting, setExporting] = useState(false);
  const { accMap, projMap, catMap } = useMaps();

  const dir = (f: Flow): 'in' | 'out' | undefined => {
    if (perspectiveAccountId) return f.toAccountId === perspectiveAccountId ? 'in' : 'out';
    if (perspectiveEntityId) {
      const fromE = accMap.get(f.fromAccountId)?.entityId;
      const toE = accMap.get(f.toAccountId)?.entityId;
      if (toE === perspectiveEntityId && fromE !== perspectiveEntityId) return 'in';
      if (fromE === perspectiveEntityId && toE !== perspectiveEntityId) return 'out';
    }
    return undefined;
  };

  // 账户视角下的滚动余额（按日期正序累计）
  const running = new Map<ID, number>();
  if (showRunningBalance && perspectiveAccountId) {
    let b = 0;
    [...flows]
      .filter((f) => f.status === 'CONFIRMED')
      .sort((a, b2) => a.date.localeCompare(b2.date) || a.flowNo.localeCompare(b2.flowNo))
      .forEach((f) => {
        b += f.toAccountId === perspectiveAccountId ? f.amount : -f.amount;
        running.set(f.id, b);
      });
  }

  const columns: ColumnsType<Flow> = [
    { title: '日期', dataIndex: 'date', width: 104, sorter: (a, b) => a.date.localeCompare(b.date), defaultSortOrder: 'descend' },
    {
      title: '转出 → 转入',
      key: 'acc',
      render: (_, f) => (
        <Space size={4} wrap>
          <span>{accMap.get(f.fromAccountId)?.name}</span>
          <span style={{ color: '#bbb' }}>→</span>
          <span>{accMap.get(f.toAccountId)?.name}</span>
          {f.icNature && <Tag color="magenta">集团内</Tag>}
          {!!f.attachmentCount && (
            <Tooltip title={`${f.attachmentCount} 个凭证附件`}>
              <PaperClipOutlined style={{ color: '#8c8c8c' }} />
            </Tooltip>
          )}
          {f.allocations.length > 0 && (
            <Tooltip title={`资金来源：${f.allocations.length} 笔入款`}>
              <LinkOutlined style={{ color: '#722ed1' }} />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '项目 / 类型',
      key: 'proj',
      width: 260,
      render: (_, f) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis style={{ maxWidth: 250 }}>
            <EntityTag id={projMap.get(f.splits[0].projectId)?.entityId} />
            {projMap.get(f.splits[0].projectId)?.name}
            {f.splits.length > 1 && <Tag style={{ marginLeft: 4 }}>+{f.splits.length - 1}</Tag>}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {catMap.get(catMap.get(f.splits[0].categoryId)?.parentId ?? '')?.name} / {catMap.get(f.splits[0].categoryId)?.name}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '摘要',
      key: 'sum',
      ellipsis: true,
      render: (_, f) => (
        <Space size={4}>
          {f.purposeMismatch && (
            <Tooltip title={`实际用途：${f.actualPurpose ?? ''}`}>
              <Tag color="volcano">用途不符</Tag>
            </Tooltip>
          )}
          <span>{f.actualPurpose ?? f.bookSummary ?? f.remark ?? ''}</span>
        </Space>
      ),
    },
    { title: '方式', dataIndex: 'method', width: 84, render: (m: Flow['method']) => FLOW_METHOD[m] },
    {
      title: '金额',
      dataIndex: 'amount',
      align: 'right',
      width: 140,
      sorter: (a, b) => a.amount - b.amount,
      render: (v: number, f) => <Money cents={v} direction={dir(f)} />,
    },
    ...(showRunningBalance
      ? [{ title: '余额', key: 'bal', align: 'right' as const, width: 130, render: (_: unknown, f: Flow) => (running.has(f.id) ? <Money cents={running.get(f.id)!} /> : '—') }]
      : []),
    { title: '状态', dataIndex: 'status', width: 84, render: (s: Flow['status']) => <Tag color={FLOW_STATUS[s].color}>{FLOW_STATUS[s].label}</Tag> },
  ];

  return (
    <>
      <Space style={{ marginBottom: 8 }}>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={exporting}
          disabled={!flows.length}
          onClick={async () => {
            setExporting(true);
            try {
              await api.download('/exports/flows', '资金流水.xlsx', { ids: flows.map((f) => f.id), title: exportTitle ?? '资金流水' });
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setExporting(false);
            }
          }}
        >
          导出当前列表（{flows.length} 条）
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          点击行查看详情、资金来源与去向
        </Typography.Text>
      </Space>
      <Table
        className="clickable-rows"
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={flows}
        pagination={{ pageSize, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
        rowClassName={(f) => (f.status === 'VOIDED' || f.status === 'REVERSED' ? 'row-dead' : '')}
        onRow={(f) => ({ onClick: () => ui.openFlow(f.id) })}
      />
    </>
  );
}
