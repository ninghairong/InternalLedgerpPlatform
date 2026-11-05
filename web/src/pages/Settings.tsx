import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, List, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Tree, Typography, message } from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, PlusOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { useIsAdmin, useStore } from '@/data/store';
import type { AuditEntry, Role, TaxRule, User } from '@ledger/shared/types';
import { api } from '@/api';

const NATURE: Record<string, { label: string; color: string }> = {
  EXPENSE: { label: '支出', color: 'red' },
  INCOME: { label: '收入', color: 'green' },
  TRANSFER: { label: '内部划转', color: 'purple' },
  CURRENT: { label: '往来', color: 'blue' },
  TAX: { label: '税费', color: 'orange' },
};
const ROLE: Record<Role, string> = { ADMIN: '管理员', FINANCE: '财务', READONLY: '只读' };

export default function Settings() {
  const isAdmin = useIsAdmin();
  return (
    <>
      <PageTitle title="系统设置" sub="字典、税务规则、用户由管理员维护；审计日志与数据自检所有人可查看" />
      <Card>
        <Tabs
          items={[
            ...(isAdmin ? [{ key: 'users', label: '用户', children: <Users /> }] : []),
            { key: 'cat', label: '账目类型', children: <Categories /> },
            { key: 'tax', label: '税务规则', children: <TaxRules /> },
            { key: 'audit', label: '审计日志', children: <Audit /> },
            { key: 'check', label: '数据自检', children: <SelfCheck /> },
            ...(isAdmin ? [{ key: 'backup', label: '备份', children: <Backups /> }] : []),
          ]}
        />
      </Card>
    </>
  );
}

function Users() {
  const me = useStore((s) => s.me);
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<User | 'new'>();
  const [form] = Form.useForm();
  const load = () => api.get<User[]>('/users').then(setUsers).catch((e) => message.error(e.message));
  useEffect(() => {
    load();
  }, []);
  const cur = editing && editing !== 'new' ? editing : undefined;
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>新增用户</Button>
        <Typography.Text type="secondary">平台为 5 人以内自用：管理员可做全部操作；财务可录入、导入、结账；只读只能查看和导出。</Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={users}
        columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '姓名', dataIndex: 'displayName' },
          { title: '角色', dataIndex: 'role', render: (r: Role) => <Tag color={r === 'ADMIN' ? 'red' : r === 'FINANCE' ? 'blue' : 'default'}>{ROLE[r]}</Tag> },
          { title: '状态', dataIndex: 'status', render: (s: string) => (s === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag>停用</Tag>) },
          { title: '最近登录', dataIndex: 'lastLoginAt', render: (v?: string) => (v ? new Date(v).toLocaleString('zh-CN') : '—') },
          { title: '', key: 'op', render: (_: unknown, u: User) => <a onClick={() => setEditing(u)}>编辑 / 重置密码</a> },
        ]}
      />
      <Modal
        title={cur ? `编辑用户 ${cur.username}` : '新增用户'}
        open={!!editing}
        onCancel={() => setEditing(undefined)}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields();
          try {
            if (cur) await api.put(`/users/${cur.id}`, { displayName: v.displayName, role: v.role, status: v.status, password: v.password || undefined });
            else await api.post('/users', v);
            message.success('已保存');
            setEditing(undefined);
            load();
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={cur ?? { role: 'FINANCE' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input disabled={!!cur} /></Form.Item>
          <Form.Item name="displayName" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="role" label="角色"><Select disabled={cur?.id === me?.id} options={(Object.keys(ROLE) as Role[]).map((r) => ({ value: r, label: ROLE[r] }))} /></Form.Item>
          {cur && <Form.Item name="status" label="状态"><Select disabled={cur.id === me?.id} options={[{ value: 'ACTIVE', label: '正常' }, { value: 'DISABLED', label: '停用' }]} /></Form.Item>}
          <Form.Item name="password" label={cur ? '新密码（留空不修改）' : '初始密码'} rules={[{ required: !cur }, { min: 8, message: '至少 8 位' }]}><Input.Password /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function Categories() {
  const categories = useStore((s) => s.categories);
  const mutate = useStore((s) => s.mutate);
  const isAdmin = useIsAdmin();
  const [parent, setParent] = useState<string>();
  const [form] = Form.useForm();
  const tree = categories
    .filter((c) => !c.parentId)
    .map((p) => ({
      key: p.id,
      title: (
        <Space>
          <b>{p.name}</b>
          <Tag color={NATURE[p.nature].color}>{NATURE[p.nature].label}</Tag>
          {!p.affectsPnl && <Tag>不计损益</Tag>}
          {isAdmin && <a onClick={() => setParent(p.id)}><PlusOutlined /> 子类型</a>}
        </Space>
      ),
      children: categories.filter((c) => c.parentId === p.id).map((c) => ({ key: c.id, title: <>{c.name} {c.requiresTax && <Tag color="orange">须填税种</Tag>}<Typography.Text type="secondary" style={{ fontSize: 12 }}> {c.id}</Typography.Text></> })),
    }));
  return (
    <Row gutter={[24, 16]}>
      <Col xs={24} lg={12}>
        <Tree treeData={tree} defaultExpandAll selectable={false} />
      </Col>
      <Col xs={24} lg={12}>
        <Typography.Paragraph><b>不计损益</b>的类型（内部划转、往来款）只用于资金链与往来余额，不计入项目成本或收入，避免同一笔钱在流转过程中被重复统计。</Typography.Paragraph>
        <Typography.Paragraph><b>须填税种</b>的类型（缴税、社保）必须注明税种与所属期，不能只记"国库"。</Typography.Paragraph>
        <Typography.Paragraph type="secondary">新增的子类型继承一级类型的性质；已使用的类型不能删除或改性质，以保证历史报表口径一致。</Typography.Paragraph>
      </Col>
      <Modal
        title={`新增子类型 · ${categories.find((c) => c.id === parent)?.name ?? ''}`}
        open={!!parent}
        onCancel={() => setParent(undefined)}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await mutate(() => api.post('/categories', { id: v.id, parentId: parent, name: v.name }));
            message.success('已新增');
            setParent(undefined);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={{ id: `${parent}-` }}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="如：钢材" /></Form.Item>
          <Form.Item name="id" label="编码" rules={[{ required: true }, { pattern: /^c-[a-z0-9-]+$/, message: '小写字母、数字、短横线，以 c- 开头' }]}><Input placeholder="如：c-mat-steel" /></Form.Item>
        </Form>
      </Modal>
    </Row>
  );
}

const TAX_NAME: Record<string, string> = { VAT: '增值税', VAT_PREPAY: '增值税预缴', EDU_SURCHARGE: '教育费附加', LOCAL_EDU_SURCHARGE: '地方教育附加', URBAN_MAINT: '城市维护建设税' };

function TaxRules() {
  const rules = useStore((s) => s.taxRules);
  const mutate = useStore((s) => s.mutate);
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="政策调整时新增一条规则并设置生效日期，旧规则继续用于历史期间。城建税率与是否减半在各主体的纳税信息中设置。" />
      {isAdmin && <Button icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={() => setOpen(true)}>新增规则</Button>}
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={rules}
        scroll={{ x: 960 }}
        columns={[
          { title: '税种', dataIndex: 'tax', render: (t: string) => TAX_NAME[t] ?? t },
          { title: '名称', dataIndex: 'name' },
          { title: '适用身份', dataIndex: 'taxpayer', render: (t?: string) => (t === 'GENERAL' ? '一般纳税人' : t === 'SMALL' ? '小规模' : '全部') },
          { title: '税率 / 征收率', dataIndex: 'rate', render: (r: number) => `${Math.round(r * 1000) / 10}%` },
          { title: '免征额', dataIndex: 'thresholdAmount', render: (v: number | undefined, r: TaxRule) => (v ? `${r.thresholdPeriod === 'QUARTER' ? '季度' : '月度'} ${(v / 1000000).toFixed(0)} 万` : '—') },
          { title: '生效', dataIndex: 'validFrom' },
          { title: '失效', dataIndex: 'validTo', render: (v?: string) => v ?? '—' },
          { title: '政策依据', dataIndex: 'policyRef', ellipsis: true },
        ]}
      />
      <Modal
        title="新增税务规则"
        open={open}
        onCancel={() => setOpen(false)}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await mutate(() => api.post('/tax-rules', { ...v, rate: v.rate / 100, thresholdAmount: v.threshold ? Math.round(v.threshold * 10000 * 100) : undefined, threshold: undefined, validFrom: v.validFrom.format('YYYY-MM-DD'), validTo: v.validTo?.format('YYYY-MM-DD') }));
            message.success('已新增');
            setOpen(false);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col xs={24} md={12}><Form.Item name="tax" label="税种" rules={[{ required: true }]}><Select options={Object.entries(TAX_NAME).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="taxpayer" label="适用身份"><Select allowClear placeholder="全部" options={[{ value: 'GENERAL', label: '一般纳税人' }, { value: 'SMALL', label: '小规模' }]} /></Form.Item></Col>
            <Col xs={24} md={24}><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="如：增值税-小规模（3% 减按 1%）" /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="rate" label="税率（%）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} max={99} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="threshold" label="免征额（万元）"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="thresholdPeriod" label="免征额周期"><Select allowClear options={[{ value: 'QUARTER', label: '季度' }, { value: 'MONTH', label: '月度' }]} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="validFrom" label="生效日期" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="validTo" label="失效日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} md={24}><Form.Item name="policyRef" label="政策依据"><Input /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

function Audit() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [action, setAction] = useState<string>();
  useEffect(() => {
    api.get<AuditEntry[]>(`/audit${api.qs({ action, limit: '300' })}`).then(setRows).catch((e) => message.error(e.message));
  }, [action]);
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="操作类型"
          style={{ width: 200 }}
          value={action}
          onChange={setAction}
          options={[['flow', '流水'], ['import', '导入'], ['export', '导出'], ['entity', '主体'], ['account', '账户'], ['project', '项目'], ['invoice', '发票'], ['period', '结账'], ['user', '用户'], ['auth', '登录'], ['system', '系统任务'], ['backup', '备份']].map(([value, label]) => ({ value, label }))}
        />
        <Typography.Text type="secondary">审计日志只追加、不可修改，最近 300 条</Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={{ pageSize: 30 }}
        columns={[
          { title: '时间', dataIndex: 'at', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
          { title: '操作人', dataIndex: 'user', width: 120 },
          { title: '操作', dataIndex: 'action', width: 160, render: (v: string) => <Tag>{v}</Tag> },
          { title: '内容', dataIndex: 'summary' },
        ]}
      />
    </>
  );
}

function SelfCheck() {
  const [r, setR] = useState<{ at: string; ok: boolean; items: { name: string; ok: boolean; detail: string[] }[] }>();
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    api.get<typeof r>('/admin/self-check').then(setR).catch((e) => message.error(e.message)).finally(() => setBusy(false));
  };
  useEffect(run, []);
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button loading={busy} onClick={run}>立即自检</Button>
        <Typography.Text type="secondary">系统每天凌晨自动运行一次，结果记入审计日志</Typography.Text>
      </Space>
      {r && (
        <>
          <Alert type={r.ok ? 'success' : 'error'} showIcon style={{ marginBottom: 12 }} message={r.ok ? `全部通过（${new Date(r.at).toLocaleString('zh-CN')}）` : '发现不一致，请联系管理员'} />
          <List
            dataSource={r.items}
            renderItem={(i) => (
              <List.Item>
                <List.Item.Meta avatar={i.ok ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <CloseCircleTwoTone twoToneColor="#ff4d4f" />} title={i.name} description={i.ok ? '一致' : i.detail.join('；')} />
              </List.Item>
            )}
          />
        </>
      )}
    </>
  );
}

function Backups() {
  const [list, setList] = useState<{ name: string; size: number; at: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<typeof list>('/admin/backups').then(setList).catch((e) => message.error(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="每天凌晨自动备份数据库（pg_dump）与附件，保留 30 天。建议定期把备份文件复制到另一台机器或网盘。恢复方法见 docs/部署与运维.md。"
      />
      <Popconfirm title="立即生成一份备份？" onConfirm={() => { setBusy(true); api.post<{ name: string }>('/admin/backups').then((r) => { message.success(`已生成 ${r.name}`); load(); }).catch((e) => message.error(e.message)).finally(() => setBusy(false)); }}>
        <Button type="primary" loading={busy} style={{ marginBottom: 12 }}>立即备份</Button>
      </Popconfirm>
      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={list}
        locale={{ emptyText: '暂无备份' }}
        columns={[
          { title: '文件', dataIndex: 'name' },
          { title: '大小', dataIndex: 'size', render: (v: number) => `${(v / 1024).toFixed(0)} KB` },
          { title: '时间', dataIndex: 'at', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
          { title: '', key: 'd', render: (_: unknown, b) => <a onClick={() => api.download(`/admin/backups/${b.name}`, b.name).catch((e) => message.error(e.message))}>下载</a> },
        ]}
      />
    </>
  );
}
