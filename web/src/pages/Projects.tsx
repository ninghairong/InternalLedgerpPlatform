import { Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Progress, Row, Segmented, Select, Space, Table, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';
import { PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '@/components/PageTitle';
import { EntityTag } from '@/components/Pickers';
import { useCanWrite, useStore } from '@/data/store';
import { useProjectStats, useScopedProjects } from '@/data/hooks';
import { PROJECT_STATUS } from '@ledger/shared/labels';
import type { Project, ProjectStatus } from '@ledger/shared/types';
import { moneyShort, toCents } from '@ledger/shared/format';

export default function Projects() {
  const projects = useScopedProjects();
  const stats = useProjectStats();
  const [status, setStatus] = useState<ProjectStatus | 'ALL'>('ACTIVE');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const canWrite = useCanWrite();

  const rows = projects
    .filter((p) => (status === 'ALL' || p.status === status) && (!q || p.name.includes(q) || p.code.includes(q)))
    .map((p) => {
      const st = stats.get(p.id);
      const budget = Object.values(p.budget).reduce((a, b) => a + b, 0);
      return { ...p, income: st?.income ?? 0, expense: st?.expense ?? 0, budgetTotal: budget };
    })
    .sort((a, b) => (a.kind === b.kind ? b.expense - a.expense : a.kind === 'NORMAL' ? -1 : 1));

  return (
    <>
      <PageTitle
        title="项目"
        sub="以项目为单位管理收支；内部划转与往来款不计入项目损益"
        extra={
          canWrite && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建项目
          </Button>
        }
      />
      <Card>
        <Space style={{ marginBottom: 12 }}>
          <Segmented
            value={status}
            onChange={(v) => setStatus(v as ProjectStatus | 'ALL')}
            options={[
              { label: '进行中', value: 'ACTIVE' },
              { label: '筹备', value: 'PREPARING' },
              { label: '已结项', value: 'CLOSED' },
              { label: '全部', value: 'ALL' },
            ]}
          />
          <Input.Search placeholder="项目名称 / 编号" allowClear onSearch={setQ} style={{ width: 260 }} />
        </Space>
        <Table
          rowKey="id"
          size="middle"
          dataSource={rows}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: '编号', dataIndex: 'code', width: 130 },
            {
              title: '项目名称',
              dataIndex: 'name',
              render: (v: string, p) => (
                <Space>
                  <Link to={`/projects/${p.id}`}>{v}</Link>
                  {p.kind === 'COMMON' && <Tag>公司公共</Tag>}
                </Space>
              ),
            },
            { title: '主体', dataIndex: 'entityId', width: 100, render: (id: string) => <EntityTag id={id} /> },
            { title: '负责人', dataIndex: 'manager', width: 80 },
            { title: '合同额', dataIndex: 'contractAmount', align: 'right', width: 110, render: (v: number) => (v ? moneyShort(v) : '—') },
            { title: '已收', dataIndex: 'income', align: 'right', width: 110, render: (v: number) => <span style={{ color: '#389e0d' }}>{moneyShort(v)}</span> },
            { title: '已支', dataIndex: 'expense', align: 'right', width: 110, render: (v: number) => <span style={{ color: '#cf1322' }}>{moneyShort(v)}</span> },
            { title: '收支差', key: 'm', align: 'right', width: 110, render: (_: unknown, p) => moneyShort(p.income - p.expense) },
            {
              title: '预算执行',
              key: 'b',
              width: 150,
              render: (_: unknown, p) => (p.budgetTotal ? <Progress size="small" percent={Math.round((p.expense / p.budgetTotal) * 100)} status={p.expense > p.budgetTotal ? 'exception' : 'normal'} /> : <Typography.Text type="secondary">未设预算</Typography.Text>),
            },
            { title: '状态', dataIndex: 'status', width: 80, render: (s: ProjectStatus) => <Tag color={PROJECT_STATUS[s].color}>{PROJECT_STATUS[s].label}</Tag> },
          ]}
        />
      </Card>
      <ProjectFormModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** 新建 / 编辑项目（编辑时承接主体与编号不可改） */
export function ProjectFormModal({ open, onClose, project }: { open: boolean; onClose: () => void; project?: Project }) {
  const [form] = Form.useForm();
  const entities = useStore((s) => s.entities);
  const mutate = useStore((s) => s.mutate);
  const scope = useStore((s) => s.entityScope);
  const [busy, setBusy] = useState(false);
  const y = (c?: number) => (c ? c / 100 : undefined);
  const initial = project
    ? { ...project, contract: y(project.contractAmount), bMat: y(project.budget['c-mat']), bWage: y(project.budget['c-wage']), bReimb: y(project.budget['c-reimb']), bSub: y(project.budget['c-sub']), startDate: project.startDate ? dayjs(project.startDate) : undefined }
    : { entityId: scope === 'ALL' ? undefined : scope, vatMethod: 'GENERAL', status: 'ACTIVE' };
  return (
    <Modal
      title={project ? `编辑项目 ${project.code}` : '新建项目'}
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      confirmLoading={busy}
      onOk={async () => {
        const v = await form.validateFields();
        const body = {
          code: v.code, name: v.name, entityId: v.entityId, manager: v.manager, customer: v.customer, region: v.region, vatMethod: v.vatMethod,
          contractAmount: toCents(v.contract), status: v.status, startDate: v.startDate ? v.startDate.format('YYYY-MM-DD') : undefined,
          budget: Object.fromEntries(Object.entries({ 'c-mat': v.bMat, 'c-wage': v.bWage, 'c-reimb': v.bReimb, 'c-sub': v.bSub }).filter(([, x]) => x).map(([k, x]) => [k, toCents(x as number)])),
        };
        setBusy(true);
        try {
          await mutate(() => (project ? api.put(`/projects/${project.id}`, body) : api.post('/projects', body)));
          message.success(project ? '已保存' : '项目已创建');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form form={form} layout="vertical" initialValues={initial} preserve={false}>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="code" label="项目编号" rules={[{ required: true }]}>
              <Input placeholder="P-QY-004" disabled={!!project} />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="entityId" label="承接主体" rules={[{ required: true }]} extra="决定项目收入、成本与税费归属">
              <Select disabled={!!project} options={entities.map((e) => ({ value: e.id, label: `${e.name}（${e.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模'}）` }))} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="manager" label="负责人" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="vatMethod" label="计税方式">
              <Select options={[{ value: 'GENERAL', label: '一般计税' }, { value: 'SIMPLE', label: '简易计税' }]} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="customer" label="客户">
              <Input />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="region" label="项目所在地" tooltip="与主体所在地不同时提示跨地区预缴">
              <Input />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="contract" label="合同额（元）">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          {[
            ['bMat', '材料预算'],
            ['bWage', '人工预算'],
            ['bReimb', '报销预算'],
            ['bSub', '分包预算'],
          ].map(([k, l]) => (
            <Col span={6} key={k}>
              <Form.Item name={k} label={`${l}（元）`}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
            </Col>
          ))}
          <Col span={6}>
            <Form.Item name="startDate" label="开始日期">
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="status" label="状态" extra={project?.status === 'CLOSED' ? '已结项项目由管理员在详情页重新开启' : undefined}>
              <Select disabled={project?.status === 'CLOSED'} options={[{ value: 'PREPARING', label: '筹备' }, { value: 'ACTIVE', label: '进行中' }, ...(project?.status === 'CLOSED' ? [{ value: 'CLOSED', label: '已结项' }] : [])]} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
