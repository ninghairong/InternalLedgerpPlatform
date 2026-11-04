import { App as AntApp, Avatar, Badge, Button, Dropdown, Form, Input, Layout, Menu, Modal, Result, Select, Space, Spin, Tag, Typography, message } from 'antd';
import {
  AccountBookOutlined,
  ApartmentOutlined,
  BankOutlined,
  CalculatorOutlined,
  DashboardOutlined,
  DownloadOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  ProjectOutlined,
  SettingOutlined,
  SwapOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { FlowDetailDrawer } from './components/FlowDetailDrawer';
import { FlowFormModal } from './components/FlowFormModal';
import { UiContext } from './components/ui';
import { useCanWrite, useStore } from './data/store';
import { useTraces } from './data/hooks';
import { api, setUnauthorizedHandler } from './api';
import type { Flow, ID } from '@ledger/shared/types';
import Login from './pages/Login';
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const Flows = lazy(() => import('./pages/Flows'));
const ChainWizard = lazy(() => import('./pages/ChainWizard'));
const Traces = lazy(() => import('./pages/Traces'));
const TraceDetail = lazy(() => import('./pages/TraceDetail'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Entities = lazy(() => import('./pages/Entities'));
const Tax = lazy(() => import('./pages/Tax'));
const Payroll = lazy(() => import('./pages/Payroll'));
const ImportPage = lazy(() => import('./pages/ImportPage'));
const ExportPage = lazy(() => import('./pages/ExportPage'));
const Settings = lazy(() => import('./pages/Settings'));

const MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '工作台' },
  { key: '/projects', icon: <ProjectOutlined />, label: '项目' },
  { key: '/flows', icon: <SwapOutlined />, label: '资金流水' },
  { key: '/traces', icon: <NodeIndexOutlined />, label: '资金链' },
  { key: '/accounts', icon: <BankOutlined />, label: '账户' },
  { key: '/entities', icon: <ApartmentOutlined />, label: '公司主体' },
  { key: '/tax', icon: <CalculatorOutlined />, label: '发票与税费' },
  { key: '/payroll', icon: <TeamOutlined />, label: '工资' },
  { key: '/import', icon: <UploadOutlined />, label: 'Excel 导入' },
  { key: '/export', icon: <DownloadOutlined />, label: '导出中心' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
];

const ROLE_TEXT = { ADMIN: '管理员', FINANCE: '财务', READONLY: '只读' } as const;

export default function App() {
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.loaded);
  const restore = useStore((s) => s.restore);
  const logout = useStore((s) => s.logout);
  const nav = useNavigate();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
      nav('/login');
    });
    restore().finally(() => setBooting(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (booting) return <Spin fullscreen tip="加载中…" />;
  return (
    <AntApp>
      <Routes>
        <Route path="/login" element={me && loaded ? <Navigate to="/" replace /> : <Login />} />
        <Route path="*" element={me && loaded ? <Shell /> : <Navigate to="/login" replace />} />
      </Routes>
    </AntApp>
  );
}

function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  const me = useStore((s) => s.me)!;
  const entities = useStore((s) => s.entities);
  const scope = useStore((s) => s.entityScope);
  const setScope = useStore((s) => s.setEntityScope);
  const logout = useStore((s) => s.logout);
  const load = useStore((s) => s.load);
  const canWrite = useCanWrite();
  const abnormal = useTraces().filter((t) => t.status === 'ABNORMAL').length;
  const [pwdOpen, setPwdOpen] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [copyFrom, setCopyFrom] = useState<Flow>();
  const [detailId, setDetailId] = useState<ID>();
  const ui = useMemo(
    () => ({
      newFlow: (f?: Flow) => {
        setCopyFrom(f);
        setFormOpen(true);
      },
      openFlow: (id: ID) => setDetailId(id),
    }),
    [],
  );

  const selected = MENU.filter((m) => m.key !== '/' && loc.pathname.startsWith(m.key)).map((m) => m.key);

  return (
    <UiContext.Provider value={ui}>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Sider width={200} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px', fontWeight: 600, fontSize: 15 }}>
            <AccountBookOutlined style={{ color: '#1677ff', fontSize: 20 }} />
            内部账目平台
          </div>
          <Menu mode="inline" selectedKeys={selected.length ? selected : ['/']} items={MENU} onClick={(e) => nav(e.key)} style={{ borderInlineEnd: 'none' }} />
        </Layout.Sider>
        <Layout>
          <Layout.Header style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '0 20px', display: 'flex', alignItems: 'center', gap: 16, height: 56 }}>
            <Space>
              <Typography.Text type="secondary">主体</Typography.Text>
              <Select
                value={scope}
                onChange={setScope}
                style={{ width: 280 }}
                showSearch
                optionFilterProp="label"
                options={[{ value: 'ALL', label: `全部主体（${entities.length} 家）` }, ...entities.map((e) => ({ value: e.id, label: `${e.shortName} · ${e.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模'}` }))]}
              />
            </Space>
            <div style={{ flex: 1 }} />
            {canWrite && (
              <Dropdown
                menu={{
                  items: [
                    { key: 'flow', label: '新建流水', onClick: () => ui.newFlow() },
                    { key: 'chain', label: '连续流转录入', onClick: () => nav('/flows/chain') },
                    { key: 'import', label: '从 Excel 导入', onClick: () => nav('/import') },
                  ],
                }}
              >
                <Button type="primary" icon={<PlusOutlined />}>
                  新建
                </Button>
              </Dropdown>
            )}
            <Badge count={abnormal} size="small">
              <Button onClick={() => nav('/traces?status=ABNORMAL')}>资金链异常</Button>
            </Badge>
            <Dropdown
              menu={{
                items: [
                  { key: 'who', label: <Space>{me.displayName}<Tag>{ROLE_TEXT[me.role]}</Tag></Space>, disabled: true },
                  { key: 'reload', label: '刷新数据', onClick: () => load().then(() => message.success('已刷新')) },
                  { key: 'pwd', label: '修改密码', onClick: () => setPwdOpen(true) },
                  { type: 'divider' },
                  { key: 'logout', label: '退出登录', danger: true, onClick: () => (logout(), nav('/login')) },
                ],
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar icon={<UserOutlined />} />
                <span>{me.displayName}</span>
              </Space>
            </Dropdown>
          </Layout.Header>
          <Layout.Content style={{ padding: 20, background: '#f5f6f8' }}>
            {/* 页面按需加载：Excel、图表等较大的依赖只在用到的页面下载 */}
            <Suspense fallback={<Spin style={{ display: 'block', marginTop: 80 }} />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:id" element={<ProjectDetail />} />
              <Route path="/flows" element={<Flows />} />
              <Route path="/flows/chain" element={canWrite ? <ChainWizard /> : <NoPermission />} />
              <Route path="/traces" element={<Traces />} />
              <Route path="/traces/:id" element={<TraceDetail />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/entities" element={<Entities />} />
              <Route path="/tax" element={<Tax />} />
              <Route path="/payroll" element={<Payroll />} />
              <Route path="/import" element={canWrite ? <ImportPage /> : <NoPermission />} />
              <Route path="/export" element={<ExportPage />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Result status="404" title="页面不存在" />} />
            </Routes>
            </Suspense>
          </Layout.Content>
        </Layout>
      </Layout>
      <FlowFormModal open={formOpen} copyFrom={copyFrom} onClose={() => setFormOpen(false)} />
      <FlowDetailDrawer
        flowId={detailId}
        onClose={() => setDetailId(undefined)}
        onOpenFlow={setDetailId}
        onCopy={(f) => {
          setDetailId(undefined);
          ui.newFlow(f);
        }}
      />
      <PasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </UiContext.Provider>
  );
}

function NoPermission() {
  return <Result status="403" title="只读账号不能修改数据" />;
}

function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="修改密码"
      open={open}
      onCancel={onClose}
      destroyOnHidden
      confirmLoading={busy}
      onOk={async () => {
        const v = await form.validateFields();
        setBusy(true);
        try {
          await api.post('/auth/password', { oldPassword: v.oldPassword, newPassword: v.newPassword });
          message.success('密码已修改');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="oldPassword" label="原密码" rules={[{ required: true }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 8, message: '至少 8 位' }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item name="confirm" label="确认新密码" dependencies={['newPassword']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))) })]}>
          <Input.Password />
        </Form.Item>
      </Form>
    </Modal>
  );
}
