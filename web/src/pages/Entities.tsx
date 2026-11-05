import { Alert, Button, Card, Checkbox, Col, DatePicker, Form, Input, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import { EditOutlined, LockOutlined, PlusOutlined, UnlockOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { useCanWrite, useIsAdmin, useStore } from '@/data/store';
import { useBalances } from '@/data/hooks';
import type { Entity, TaxProfile } from '@ledger/shared/types';
import { money, today } from '@ledger/shared/format';
import { api } from '@/api';

const TAXPAYER = { GENERAL: '一般纳税人', SMALL: '小规模纳税人' };

export default function Entities() {
  const entities = useStore((s) => s.entities);
  const accounts = useStore((s) => s.accounts);
  const projects = useStore((s) => s.projects);
  const flows = useStore((s) => s.flows);
  const canWrite = useCanWrite();
  const bal = useBalances();
  const [editing, setEditing] = useState<Entity | 'new'>();
  const [profileOf, setProfileOf] = useState<Entity>();

  // 集团内往来净额：正数 = 行主体应收列主体
  const ic = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of flows) {
      if (!f.icNature || f.status !== 'CONFIRMED') continue;
      const a = accounts.find((x) => x.id === f.fromAccountId)!.entityId!;
      const b = accounts.find((x) => x.id === f.toAccountId)!.entityId!;
      m.set(`${a}|${b}`, (m.get(`${a}|${b}`) ?? 0) + f.amount);
      m.set(`${b}|${a}`, (m.get(`${b}|${a}`) ?? 0) - f.amount);
    }
    return m;
  }, [flows, accounts]);
  const icEntities = entities.filter((e) => entities.some((o) => ic.get(`${e.id}|${o.id}`)));

  return (
    <>
      <PageTitle
        title="公司主体"
        sub={`共 ${entities.length} 家；分公司独立报税；纳税人身份按生效日期保存历史，历史期间按当时身份计算`}
        extra={canWrite && <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>新增主体</Button>}
      />
      <Card>
        <Tabs
          items={[
            {
              key: 'list',
              label: '主体列表',
              children: (
                <Table
                  rowKey="id"
                  dataSource={entities}
                  pagination={false}
                  expandable={{
                    expandedRowRender: (e) => (
                      <Table
                        size="small"
                        pagination={false}
                        rowKey="validFrom"
                        dataSource={e.taxProfiles}
                        columns={[
                          { title: '纳税人身份', dataIndex: 'taxpayerType', render: (t: keyof typeof TAXPAYER) => TAXPAYER[t] },
                          { title: '生效', dataIndex: 'validFrom' },
                          { title: '截止（不含）', dataIndex: 'validTo', render: (v?: string) => v ?? '至今' },
                          { title: '申报', dataIndex: 'vatFiling', render: (v: string) => (v === 'MONTH' ? '按月' : '按季') },
                          { title: '城建税率', dataIndex: 'urbanRate', render: (v: number) => `${Math.round(v * 100)}%` },
                          { title: '六税两费减半', dataIndex: 'halving', render: (v: boolean) => (v ? '是' : '否') },
                        ]}
                      />
                    ),
                  }}
                  columns={[
                    { title: '编号', dataIndex: 'code', width: 80 },
                    {
                      title: '名称',
                      dataIndex: 'name',
                      render: (v: string, e: Entity) => (
                        <Space>
                          {v}
                          {e.kind === 'BRANCH' && <Tag>分公司</Tag>}
                          {e.kind === 'HEAD' && <Tag color="blue">总公司</Tag>}
                          {e.status === 'DISABLED' && <Tag color="red">已停用</Tag>}
                        </Space>
                      ),
                    },
                    { title: '上级', dataIndex: 'parentId', render: (id?: string) => entities.find((e) => e.id === id)?.shortName ?? '—' },
                    { title: '当前身份', dataIndex: 'taxpayerType', render: (t: string, e: Entity) => <Space size={4}>{t === 'GENERAL' ? <Tag color="geekblue">一般纳税人</Tag> : <Tag color="green">小规模纳税人</Tag>}{e.taxProfiles.length > 1 && <Tag>有变更历史</Tag>}</Space> },
                    { title: '申报', dataIndex: 'vatFiling', render: (v: string) => (v === 'MONTH' ? '按月' : '按季') },
                    { title: '所在地', dataIndex: 'region' },
                    { title: '对公账户', key: 'acc', render: (_: unknown, e: Entity) => accounts.filter((a) => a.entityId === e.id).length },
                    { title: '项目', key: 'proj', render: (_: unknown, e: Entity) => projects.filter((p) => p.entityId === e.id && p.kind === 'NORMAL').length },
                    { title: '对公余额', key: 'bal', align: 'right', render: (_: unknown, e: Entity) => money(accounts.filter((a) => a.entityId === e.id).reduce((s, a) => s + (bal.get(a.id) ?? 0), 0)) },
                    ...(canWrite
                      ? [{
                          title: '',
                          key: 'op',
                          width: 160,
                          render: (_: unknown, e: Entity) => (
                            <Space>
                              <a onClick={() => setEditing(e)}><EditOutlined /> 编辑</a>
                              <a onClick={() => setProfileOf(e)}>身份变更</a>
                            </Space>
                          ),
                        }]
                      : []),
                  ]}
                />
              ),
            },
            { key: 'periods', label: '结账', children: <Periods /> },
            {
              key: 'ic',
              label: '集团内往来',
              children: (
                <>
                  <Space style={{ marginBottom: 8, justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text type="secondary">两家主体之间的转账只记一条流水；合并视角（全部主体）下不计入收支。正数表示行主体应收列主体。</Typography.Text>
                    <Button size="small" onClick={() => api.download('/exports/ic').catch((e) => message.error(e.message))}>导出</Button>
                  </Space>
                  {icEntities.length ? (
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={false}
                      dataSource={icEntities}
                      columns={[
                        { title: '', dataIndex: 'shortName', width: 100, render: (v: string) => <b>{v}</b> },
                        ...icEntities.map((o) => ({
                          title: o.shortName,
                          key: o.id,
                          align: 'right' as const,
                          render: (_: unknown, e: Entity) => {
                            const v = ic.get(`${e.id}|${o.id}`);
                            return v ? <span style={{ color: v > 0 ? '#389e0d' : '#cf1322' }}>{money(v)}</span> : '—';
                          },
                        })),
                      ]}
                    />
                  ) : (
                    <Typography.Text type="secondary">暂无集团内往来</Typography.Text>
                  )}
                </>
              ),
            },
          ]}
        />
      </Card>
      <EntityFormModal entity={editing} onClose={() => setEditing(undefined)} />
      <TaxProfileModal entity={profileOf} onClose={() => setProfileOf(undefined)} />
    </>
  );
}

/** 按主体按月结账：结账后该月不能再新增或冲销流水；反结账仅管理员 */
function Periods() {
  const entities = useStore((s) => s.entities);
  const periods = useStore((s) => s.periods);
  const mutate = useStore((s) => s.mutate);
  const canWrite = useCanWrite();
  const isAdmin = useIsAdmin();
  const [month, setMonth] = useState<Dayjs>(dayjs(today()).subtract(1, 'month'));
  const [selected, setSelected] = useState<string[]>([]);
  const months = Array.from({ length: 6 }, (_, i) => dayjs(today()).subtract(i + 1, 'month').format('YYYY-MM')).reverse();
  const status = (e: string, m: string) => periods.find((p) => p.entityId === e && p.period === m);

  const close = async () => {
    try {
      await mutate(() => api.post('/periods/close', { entityIds: selected, period: month.format('YYYY-MM') }));
      message.success(`已结账 ${selected.length} 家主体的 ${month.format('YYYY-MM')}`);
      setSelected([]);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="结账后，该主体该月份不能再新增、导入或冲销流水（冲销记在当天，也受当月结账限制）。需要更正时由管理员反结账。" />
      {canWrite && (
        <Space style={{ marginBottom: 12 }}>
          <DatePicker picker="month" value={month} onChange={(v) => v && setMonth(v)} disabledDate={(d) => !d.isBefore(dayjs(today()).startOf('month'))} />
          <Button type="primary" icon={<LockOutlined />} disabled={!selected.length} onClick={close}>
            结账所选主体（{selected.length}）
          </Button>
        </Space>
      )}
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={entities}
        rowSelection={canWrite ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), getCheckboxProps: (e) => ({ disabled: status(e.id, month.format('YYYY-MM'))?.status === 'CLOSED' }) } : undefined}
        columns={[
          { title: '主体', dataIndex: 'shortName', width: 120 },
          ...months.map((m) => ({
            title: m,
            key: m,
            render: (_: unknown, e: Entity) => {
              const p = status(e.id, m);
              if (p?.status !== 'CLOSED') return <Typography.Text type="secondary">未结账</Typography.Text>;
              return (
                <Space size={4}>
                  <Tag color="green" icon={<LockOutlined />}>已结账</Tag>
                  {isAdmin && (
                    <Popconfirm title={`反结账 ${e.shortName} ${m}？`} onConfirm={() => mutate(() => api.post('/periods/reopen', { entityId: e.id, period: m })).then(() => message.success('已反结账')).catch((err) => message.error(err.message))}>
                      <UnlockOutlined style={{ color: '#999', cursor: 'pointer' }} />
                    </Popconfirm>
                  )}
                </Space>
              );
            },
          })),
        ]}
      />
    </>
  );
}

function EntityFormModal({ entity, onClose }: { entity?: Entity | 'new'; onClose: () => void }) {
  const [form] = Form.useForm();
  const entities = useStore((s) => s.entities);
  const saveEntity = useStore((s) => s.saveEntity);
  const kind = Form.useWatch('kind', form);
  const isNew = entity === 'new';
  const cur = entity && entity !== 'new' ? entity : undefined;
  return (
    <Modal
      title={isNew ? '新增公司主体' : `编辑 ${cur?.name}`}
      open={!!entity}
      onCancel={onClose}
      width={680}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        try {
          if (isNew) {
            const profile: TaxProfile = { taxpayerType: v.taxpayerType, vatFiling: v.taxpayerType === 'SMALL' ? 'QUARTER' : 'MONTH', validFrom: v.validFrom.format('YYYY-MM-DD'), urbanRate: v.urbanRate, halving: v.halving };
            await saveEntity(undefined, { code: v.code, name: v.name, shortName: v.shortName, kind: v.kind, parentId: v.parentId, region: v.region, uscc: v.uscc, profile });
            message.success('主体已创建，并自动生成"公司公共"项目');
          } else {
            await saveEntity(cur!.id, { name: v.name, shortName: v.shortName, kind: v.kind, parentId: v.parentId ?? '', region: v.region, uscc: v.uscc ?? '', status: v.status });
            message.success('已保存');
          }
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Form form={form} layout="vertical" preserve={false} initialValues={cur ?? { kind: 'INDEPENDENT', taxpayerType: 'GENERAL', urbanRate: 0.05, halving: false, validFrom: dayjs(today()).startOf('year') }}>
        <Row gutter={12}>
          <Col xs={24} md={6}>
            <Form.Item name="code" label="编号" rules={[{ required: true }]}>
              <Input placeholder="E30" disabled={!isNew} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="name" label="全称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="shortName" label="简称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="kind" label="类型">
              <Select options={[{ value: 'INDEPENDENT', label: '独立公司' }, { value: 'HEAD', label: '总公司' }, { value: 'BRANCH', label: '分公司' }]} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            {kind === 'BRANCH' && (
              <Form.Item name="parentId" label="上级公司" rules={[{ required: true }]}>
                <Select options={entities.filter((e) => e.kind !== 'BRANCH' && e.id !== cur?.id).map((e) => ({ value: e.id, label: e.shortName }))} />
              </Form.Item>
            )}
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="region" label="所在地" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="uscc" label="统一社会信用代码">
              <Input />
            </Form.Item>
          </Col>
          {!isNew && (
            <Col xs={24} md={12}>
              <Form.Item name="status" label="状态">
                <Select options={[{ value: 'ACTIVE', label: '正常' }, { value: 'DISABLED', label: '停用' }]} />
              </Form.Item>
            </Col>
          )}
          {isNew && <ProfileFields />}
        </Row>
      </Form>
    </Modal>
  );
}

function ProfileFields() {
  return (
    <>
      <Col xs={24} md={8}>
        <Form.Item name="taxpayerType" label="纳税人身份" rules={[{ required: true }]}>
          <Select options={[{ value: 'GENERAL', label: '一般纳税人' }, { value: 'SMALL', label: '小规模纳税人' }]} />
        </Form.Item>
      </Col>
      <Col xs={24} md={8}>
        <Form.Item name="validFrom" label="生效日期" rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
      </Col>
      <Col xs={24} md={4}>
        <Form.Item name="urbanRate" label="城建税率">
          <Select options={[{ value: 0.07, label: '7%' }, { value: 0.05, label: '5%' }, { value: 0.01, label: '1%' }]} />
        </Form.Item>
      </Col>
      <Col xs={24} md={4}>
        <Form.Item name="halving" label="六税两费减半" valuePropName="checked">
          <Checkbox />
        </Form.Item>
      </Col>
    </>
  );
}

function TaxProfileModal({ entity, onClose }: { entity?: Entity; onClose: () => void }) {
  const [form] = Form.useForm();
  const mutate = useStore((s) => s.mutate);
  const last = entity?.taxProfiles[entity.taxProfiles.length - 1];
  return (
    <Modal
      title={`纳税人身份变更 · ${entity?.shortName ?? ''}`}
      open={!!entity}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        try {
          await mutate(() => api.post(`/entities/${entity!.id}/tax-profiles`, { taxpayerType: v.taxpayerType, vatFiling: v.taxpayerType === 'SMALL' ? 'QUARTER' : 'MONTH', validFrom: v.validFrom.format('YYYY-MM-DD'), urbanRate: v.urbanRate, halving: v.halving }));
          message.success('纳税信息已更新');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Typography.Paragraph type="secondary">
        现有记录：自 {last?.validFrom} 起为{last ? TAXPAYER[last.taxpayerType] : ''}。新记录生效后，之前的期间仍按原身份计算税费。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ taxpayerType: last?.taxpayerType === 'SMALL' ? 'GENERAL' : 'SMALL', urbanRate: last?.urbanRate ?? 0.05, halving: last?.taxpayerType !== 'SMALL', validFrom: dayjs(today()).add(1, 'month').startOf('month') }}>
        <Row gutter={12}>
          <ProfileFields />
        </Row>
      </Form>
    </Modal>
  );
}
