import { Space, Typography } from 'antd';
import type { ReactNode } from 'react';

export function PageTitle({ title, sub, extra }: { title: ReactNode; sub?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="page-title">
      <Space direction="vertical" size={0}>
        <Typography.Title level={4}>{title}</Typography.Title>
        {sub && <Typography.Text type="secondary">{sub}</Typography.Text>}
      </Space>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  );
}
