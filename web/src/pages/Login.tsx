import { Button, Card, Form, Input, Typography, message } from 'antd';
import { AccountBookOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '@/data/store';

export default function Login() {
  const login = useStore((s) => s.login);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8', padding: 16, boxSizing: 'border-box' }}>
      <Card style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <AccountBookOutlined style={{ fontSize: 36, color: '#1677ff' }} />
          <Typography.Title level={4} style={{ marginTop: 8 }}>
            内部账目管理平台
          </Typography.Title>
        </div>
        <Form
          size="large"
          onFinish={async (v) => {
            setBusy(true);
            try {
              await login(v.username, v.password);
              nav('/', { replace: true });
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
