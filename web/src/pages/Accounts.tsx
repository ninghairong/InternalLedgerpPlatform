import { Alert, Button, Card, DatePicker, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { DownloadOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMemo, useState } from 'react';
import { FlowTable } from '@/components/FlowTable';
import { Money } from '@/components/Money';
import { PageTitle } from '@/components/PageTitle';
import { EntityTag } from '@/components/Pickers';
import { useUi } from '@/components/ui';
import { useCanWrite, useStore } from '@/data/store';
import { ProjectSelect } from '@/components/Pickers';
import { api } from '@/api';
import { useBalances, useLots } from '@/data/hooks';
import { ACCOUNT_KIND, TRACE_MODE } from '@ledger/shared/labels';
import type { Account, AccountKind, ID } from '@ledger/shared/types';
import { daysSince, money, toCents, today } from '@ledger/shared/format';
import { STALE_DAYS } from '@ledger/shared/selectors';

const TABS: (AccountKind | 'ALL')[] = ['CORPORATE', 'INTERNAL_PERSONAL', 'CASH', 'EXTERNAL', 'VIRTUAL'];

export default function Accounts() {
  const accounts = useStore((s) => s.accounts);
  const scope = useStore((s) => s.entityScope);
  const bal = useBalances();
  const lotMap = useLots();
  const [tab, setTab] = useState<AccountKind | 'ALL'>('CORPORATE');
  const [detail, setDetail] = useState<ID>();
  const [creating, setCreating] = useState(false);
  const canWrite = useCanWrite();

  const lotStats = useMemo(() => {
    const m = new Map<ID, { open: number; oldest?: string }>();
    for (const l of lotMap.values()) {
      if (l.remaining <= 0) continue;
      const s = m.get(l.accountId) ?? { open: 0 };
      s.open++;
      if (!s.oldest || l.date < s.oldest) s.oldest = l.date;
      m.set(l.accountId, s);
    }
    return m;
  }, [lotMap]);

  const rows = accounts.filter((a) => a.kind === tab && (tab !== 'CORPORATE' || scope === 'ALL' || a.entityId === scope));
  const traced = tab === 'INTERNAL_PERSONAL' || tab === 'CASH' || tab === 'CORPORATE';
  const held = tab === 'INTERNAL_PERSONAL' || tab === 'CASH';

  return (
    <>
      <PageTitle
        title="账户"
        sub="任何能持有资金的地方都是账户：对公账户、员工代管的个人卡与现金、外部往来单位、税务等虚拟账户"
        extra={
          canWrite && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新增账户
          </Button>
        }
      />
      <Card>
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as AccountKind)}
          items={TABS.map((k) => ({ key: k, label: `${ACCOUNT_KIND[k as AccountKind].label}（${accounts.filter((a) => a.kind === k).length}）` }))}
        />
        {traced && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              held
                ? `个人卡与现金账户的余额 = 公司资金在个人手中的沉淀，超过 ${STALE_DAYS} 天未用完会预警。名单由管理员维护。`
                : '对公账户、个人卡、现金账户的每一笔出款都必须注明资金来源（强制溯源）。'
            }
          />
        )}
        <Table
          rowKey="id"
          className="clickable-rows"
          dataSource={rows}
          pagination={false}
          onRow={(a) => ({ onClick: () => setDetail(a.id) })}
          columns={[
            { title: '编号', dataIndex: 'code', width: 110 },
            { title: '账户名称', dataIndex: 'name' },
            ...(tab === 'CORPORATE' ? [{ title: '主体', dataIndex: 'entityId', render: (id: string) => <EntityTag id={id} /> }] : []),
            { title: '持有人', dataIndex: 'holder', render: (v?: string) => v ?? '—' },
            { title: '开户行 / 尾号', key: 'bank', render: (_: unknown, a: Account) => (a.bank ? `${a.bank} ****${a.last4 ?? ''}` : '—') },
            { title: '溯源', dataIndex: 'trace', render: (t: Account['trace']) => <Tag color={t === 'REQUIRED' ? 'purple' : undefined}>{TRACE_MODE[t]}</Tag> },
            ...(tab !== 'VIRTUAL' && tab !== 'EXTERNAL'
              ? [{ title: '余额', key: 'bal', align: 'right' as const, render: (_: unknown, a: Account) => <Money cents={bal.get(a.id) ?? 0} strong /> }]
              : [{ title: '累计净额', key: 'bal', align: 'right' as const, render: (_: unknown, a: Account) => money(bal.get(a.id) ?? 0) }]),
            ...(traced
              ? [
                  {
                    title: held ? '滞留资金' : '未用完的入款',
                    key: 'lots',
                    render: (_: unknown, a: Account) => {
                      const s = lotStats.get(a.id);
                      if (!s) return <Tag color="success">无</Tag>;
                      const age = daysSince(s.oldest!);
                      if (!held) return `${s.open} 笔`;
                      return (
                        <Space>
                          <span>{s.open} 笔未用完</span>
                          <Tag color={age > STALE_DAYS ? 'red' : 'orange'}>最早 {age} 天</Tag>
                        </Space>
                      );
                    },
                  },
                ]
              : []),
          ]}
        />
      </Card>
      <AccountDrawer id={detail} onClose={() => setDetail(undefined)} />
      <AccountFormModal open={creating} kind={tab === 'ALL' ? 'CORPORATE' : tab} onClose={() => setCreating(false)} />
    </>
  );
}

function AccountDrawer({ id, onClose }: { id?: ID; onClose: () => void }) {
  const account = useStore((s) => s.accounts.find((a) => a.id === id));
  const flows = useStore((s) => s.flows);
  const lotMap = useLots();
  const bal = useBalances();
  const ui = useUi();
  const canWrite = useCanWrite();
  const mutate = useStore((s) => s.mutate);
  const [editing, setEditing] = useState(false);
  const mine = useMemo(() => flows.filter((f) => f.fromAccountId === id || f.toAccountId === id), [flows, id]);
  const open = useMemo(() => [...lotMap.values()].filter((l) => l.accountId === id && l.remaining > 0).sort((a, b) => a.date.localeCompare(b.date)), [lotMap, id]);
  if (!account) return null;
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={1080}
      title={
        <Space>
          {account.name}
          <Tag color={ACCOUNT_KIND[account.kind].color}>{ACCOUNT_KIND[account.kind].label}</Tag>
          <Typography.Text type="secondary">余额 ¥{money(bal.get(account.id) ?? 0)}</Typography.Text>
        </Space>
      }
      extra={
        <Space>
          {canWrite && account.kind !== 'VIRTUAL' && (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              编辑
            </Button>
          )}
          {canWrite && account.kind !== 'VIRTUAL' && (
            <Popconfirm
              title={account.status === 'ACTIVE' ? '停用后不能再选择该账户记账' : '重新启用该账户？'}
              description={account.status === 'ACTIVE' && account.kind !== 'EXTERNAL' ? '余额须为 0 才能停用' : undefined}
              onConfirm={() => mutate(() => api.put(`/accounts/${account.id}`, { status: account.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })).then(() => message.success('已更新')).catch((e) => message.error(e.message))}
            >
              <Button danger={account.status === 'ACTIVE'}>{account.status === 'ACTIVE' ? '停用' : '启用'}</Button>
            </Popconfirm>
          )}
          <Button icon={<DownloadOutlined />} onClick={() => api.download(`/exports/journal?accountId=${account.id}`).catch((e) => message.error(e.message))}>
            导出日记账
          </Button>
        </Space>
      }
    >
      {account.trace === 'REQUIRED' && (
        <Card size="small" title="未用完的入款（资金来源池）" style={{ marginBottom: 16 }}>
          <Table
            size="small"
            rowKey="flowId"
            pagination={false}
            dataSource={open}
            locale={{ emptyText: '该账户的钱都有去向了' }}
            className="clickable-rows"
            onRow={(l) => ({ onClick: () => ui.openFlow(l.flowId) })}
            columns={[
              { title: '入款流水', dataIndex: 'flowId', render: (fid: string) => flows.find((f) => f.id === fid)?.flowNo },
              { title: '日期', dataIndex: 'date' },
              { title: '账龄', dataIndex: 'date', key: 'age', render: (d: string) => <Tag color={account.kind !== 'CORPORATE' && daysSince(d) > STALE_DAYS ? 'red' : undefined}>{daysSince(d)} 天</Tag> },
              { title: '来自', dataIndex: 'flowId', key: 'from', render: (fid: string) => useStore.getState().accounts.find((a) => a.id === flows.find((f) => f.id === fid)?.fromAccountId)?.name },
              { title: '原金额', dataIndex: 'original', align: 'right', render: (v: number) => money(v) },
              { title: '剩余', dataIndex: 'remaining', align: 'right', render: (v: number) => <Typography.Text strong>{money(v)}</Typography.Text> },
            ]}
          />
        </Card>
      )}
      <FlowTable flows={mine} perspectiveAccountId={account.id} showRunningBalance exportTitle={`${account.name}_流水`} pageSize={20} />
      <AccountFormModal open={editing} kind={account.kind} account={account} onClose={() => setEditing(false)} />
    </Drawer>
  );
}

function AccountFormModal({ open, kind, account, onClose }: { open: boolean; kind: AccountKind; account?: Account; onClose: () => void }) {
  const [form] = Form.useForm();
  const entities = useStore((s) => s.entities);
  const mutate = useStore((s) => s.mutate);
  const [busy, setBusy] = useState(false);
  const k = (Form.useWatch('kind', form) as AccountKind | undefined) ?? account?.kind;
  const entityId = Form.useWatch('entityId', form) as string | undefined;
  return (
    <Modal
      title={account ? `编辑账户 ${account.code}` : '新增账户'}
      open={open}
      onCancel={onClose}
      destroyOnHidden
      confirmLoading={busy}
      onOk={async () => {
        const v = await form.validateFields();
        setBusy(true);
        try {
          if (account) {
            await mutate(() => api.put(`/accounts/${account.id}`, { name: v.name, holder: v.holder, bank: v.bank, last4: v.last4, remark: v.remark }));
          } else {
            await mutate(() =>
              api.post('/accounts', {
                code: v.code, name: v.name, kind: v.kind, entityId: v.kind === 'CORPORATE' ? v.entityId : undefined, holder: v.holder, bank: v.bank, last4: v.last4, remark: v.remark,
                // 期初余额 = 一笔"期初 → 账户"的流水，作为后续出款的资金来源
                opening: v.opening ? { amount: toCents(v.opening), date: (v.openingDate ?? dayjs()).format('YYYY-MM-DD'), projectId: v.openingProject } : undefined,
              }),
            );
          }
          message.success(account ? '已保存' : '账户已创建');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form form={form} layout="vertical" initialValues={account ?? { kind: kind === 'VIRTUAL' ? 'EXTERNAL' : kind, openingDate: dayjs(today()) }} preserve={false}>
        <Form.Item name="kind" label="账户类型" rules={[{ required: true }]}>
          <Select disabled={!!account} options={(['CORPORATE', 'INTERNAL_PERSONAL', 'CASH', 'EXTERNAL'] as AccountKind[]).map((x) => ({ value: x, label: ACCOUNT_KIND[x].label }))} />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="code" label="编号" rules={[{ required: true }]} style={{ width: '35%' }}>
            <Input disabled={!!account} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]} style={{ width: '65%' }}>
            <Input placeholder={k === 'INTERNAL_PERSONAL' ? '如：王xx-建行卡' : k === 'CASH' ? '如：王xx-现金' : ''} />
          </Form.Item>
        </Space.Compact>
        {k === 'CORPORATE' && (
          <Form.Item name="entityId" label="所属主体" rules={[{ required: true }]}>
            <Select disabled={!!account} options={entities.map((e) => ({ value: e.id, label: e.name }))} />
          </Form.Item>
        )}
        {k !== 'CORPORATE' && (
          <Form.Item name="holder" label="持有人" rules={[{ required: k === 'INTERNAL_PERSONAL' || k === 'CASH' }]}>
            <Input />
          </Form.Item>
        )}
        {k !== 'CASH' && (
          <Space.Compact block>
            <Form.Item name="bank" label="开户行" style={{ width: '60%' }}>
              <Input />
            </Form.Item>
            <Form.Item name="last4" label="账号尾号" style={{ width: '40%' }} rules={[{ pattern: /^\d{4}$/, message: '4 位数字' }]} extra="只记录尾号，不保存完整账号">
              <Input maxLength={4} />
            </Form.Item>
          </Space.Compact>
        )}
        <Form.Item name="remark" label="备注">
          <Input />
        </Form.Item>
        {!account && (k === 'CORPORATE' || k === 'INTERNAL_PERSONAL' || k === 'CASH') && (
          <Space.Compact block>
            <Form.Item name="opening" label="期初余额（元）" style={{ width: '35%' }} extra="生成一笔期初流水，作为之后出款的资金来源">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
            <Form.Item name="openingDate" label="期初日期" style={{ width: '25%' }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="openingProject" label="期初项目" style={{ width: '40%' }} rules={[{ required: k !== 'CORPORATE' && !!form.getFieldValue('opening'), message: '个人卡/现金的期初须指定项目' }]} extra={k === 'CORPORATE' ? '不填则记入所属主体的公司公共项目' : undefined}>
              <ProjectSelect allowClear entityId={k === 'CORPORATE' ? entityId : undefined} />
            </Form.Item>
          </Space.Compact>
        )}
      </Form>
    </Modal>
  );
}
