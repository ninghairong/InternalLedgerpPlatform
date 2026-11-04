import { Button, Card, Space, Table, Tag, Typography, message } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '@/components/PageTitle';
import { EntityTag } from '@/components/Pickers';
import { useUi } from '@/components/ui';
import { useCanWrite, useMaps, useStore } from '@/data/store';
import type { PayrollBatch, PayrollItem } from '@ledger/shared/types';
import { money } from '@ledger/shared/format';
import { api } from '@/api';

const sum = (items: PayrollItem[], k: keyof PayrollItem) => items.reduce((s, i) => s + (i[k] as number), 0);

export default function Payroll() {
  const nav = useNavigate();
  const ui = useUi();
  const payrolls = useStore((s) => s.payrolls);
  const scope = useStore((s) => s.entityScope);
  const canWrite = useCanWrite();
  const { accMap } = useMaps();
  const list = payrolls.filter((p) => scope === 'ALL' || p.entityId === scope);

  return (
    <>
      <PageTitle
        title="工资"
        sub="个税、社保为外部已结算结果，通过工资表导入；系统校验应发 − 扣款 = 实发，为每人生成实发流水（从发放公户逐笔溯源）"
        extra={
          <>
            <Button icon={<DownloadOutlined />} onClick={() => api.download(`/exports/payroll${api.qs({ entityId: scope === 'ALL' ? undefined : scope })}`).catch((e) => message.error(e.message))}>导出工资汇总</Button>
            {canWrite && <Button type="primary" icon={<UploadOutlined />} onClick={() => nav('/import')}>导入工资表</Button>}
          </>
        }
      />
      <Card>
        <Table
          rowKey="id"
          dataSource={list}
          locale={{ emptyText: '暂无工资批次。在"Excel 导入"中下载工资表模板，填好后上传。' }}
          expandable={{
            expandedRowRender: (p: PayrollBatch) => (
              <Table
                size="small"
                rowKey="person"
                pagination={false}
                dataSource={p.items}
                columns={[
                  { title: '人员', dataIndex: 'person' },
                  { title: '应发', dataIndex: 'gross', align: 'right', render: (v: number) => money(v) },
                  { title: '社保个人', dataIndex: 'siPersonal', align: 'right', render: (v: number) => money(v) },
                  { title: '公积金个人', dataIndex: 'hfPersonal', align: 'right', render: (v: number) => money(v) },
                  { title: '个税', dataIndex: 'iit', align: 'right', render: (v: number) => money(v) },
                  { title: '其他扣款', dataIndex: 'otherDeduct', align: 'right', render: (v: number) => money(v) },
                  { title: '实发', dataIndex: 'net', align: 'right', render: (v: number) => <b>{money(v)}</b> },
                  { title: '社保单位', dataIndex: 'siCompany', align: 'right', render: (v: number) => money(v) },
                  { title: '公积金单位', dataIndex: 'hfCompany', align: 'right', render: (v: number) => money(v) },
                  { title: '收款账户', dataIndex: 'payeeAccountId', render: (id: string) => accMap.get(id)?.name },
                  { title: '实发流水', dataIndex: 'netFlowId', render: (id?: string) => (id ? <a onClick={() => ui.openFlow(id)}>查看</a> : '—') },
                ]}
              />
            ),
          }}
          columns={[
            { title: '主体', dataIndex: 'entityId', render: (id: string) => <EntityTag id={id} /> },
            { title: '月份', dataIndex: 'month', render: (m: string, p: PayrollBatch) => <Space>{m}{p.seq > 1 && <Tag>第 {p.seq} 批（补发）</Tag>}{p.voided && <Tag color="red">导入已撤销</Tag>}</Space> },
            { title: '发放账户', dataIndex: 'payAccountId', render: (id: string) => accMap.get(id)?.name },
            { title: '发放日期', dataIndex: 'payDate' },
            { title: '人数', key: 'n', render: (_: unknown, p: PayrollBatch) => p.items.length },
            { title: '应发合计', key: 'g', align: 'right', render: (_: unknown, p: PayrollBatch) => money(sum(p.items, 'gross')) },
            { title: '代扣个税', key: 'i', align: 'right', render: (_: unknown, p: PayrollBatch) => money(sum(p.items, 'iit')) },
            { title: '社保（个人+单位）', key: 's', align: 'right', render: (_: unknown, p: PayrollBatch) => money(sum(p.items, 'siPersonal') + sum(p.items, 'siCompany')) },
            { title: '实发合计', key: 'net', align: 'right', render: (_: unknown, p: PayrollBatch) => <b>{money(sum(p.items, 'net'))}</b> },
            { title: '导入批次', dataIndex: 'importBatchNo', render: (v?: string) => <Typography.Text type="secondary">{v}</Typography.Text> },
          ]}
        />
      </Card>
    </>
  );
}
