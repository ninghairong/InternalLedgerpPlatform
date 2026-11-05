import { Alert, Button, Card, Col, DatePicker, List, Row, Select, Space, Table, Typography, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { AccountSelect } from '@/components/Pickers';
import { useIsMobile } from '@/components/ui';
import { useStore } from '@/data/store';
import { useScopedProjects } from '@/data/hooks';
import type { AuditEntry, ID } from '@ledger/shared/types';
import { api } from '@/api';

export default function ExportPage() {
  const scope = useStore((s) => s.entityScope);
  const projects = useScopedProjects();
  const [acc, setAcc] = useState<ID>();
  const [proj, setProj] = useState<ID>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [recent, setRecent] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState<string>();
  const mobile = useIsMobile();
  const entityId = scope === 'ALL' ? undefined : scope;
  const from = range?.[0]?.format('YYYY-MM-DD');
  const to = range?.[1]?.format('YYYY-MM-DD');

  const loadRecent = () => api.get<AuditEntry[]>('/audit?action=export&limit=20').then(setRecent).catch(() => {});
  useEffect(() => {
    loadRecent();
  }, []);

  const run = async (key: string, url: string) => {
    setBusy(key);
    try {
      const name = await api.download(url);
      message.success(`已生成 ${name}`);
      loadRecent();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const btn = (key: string, url: string, disabled = false) => (
    <Button icon={<DownloadOutlined />} loading={busy === key} disabled={disabled} onClick={() => run(key, url)}>
      导出
    </Button>
  );

  const items = [
    { key: 'flows', title: '资金流水明细', desc: '当前主体范围、所选日期内的全部流水；一笔多分摊时展开为多行，附资金来源（流水号:金额）', action: btn('flows', `/exports/flows${api.qs({ entityId, from, to })}`) },
    {
      key: 'journal',
      title: '账户日记账',
      desc: '沿用现有日记账版式（序号 / 日期 / 对方 / 摘要 / 收入 / 支出 / 余额），期初、余额与合计由系统计算',
      action: (
        <Space.Compact>
          <AccountSelect style={{ width: mobile ? 180 : 220 }} placeholder="选择账户" value={acc} onChange={setAcc} kinds={['CORPORATE', 'INTERNAL_PERSONAL', 'CASH']} showBalance={false} />
          {btn('journal', `/exports/journal${api.qs({ accountId: acc, from, to })}`, !acc)}
        </Space.Compact>
      ),
    },
    { key: 'balances', title: '账户余额表', desc: '对公账户、个人卡、现金的当前余额', action: btn('balances', `/exports/balances${api.qs({ entityId })}`) },
    { key: 'projects', title: '项目收支汇总', desc: '每个项目的合同额、收入、按一级类型的支出、预算', action: btn('projects', `/exports/projects${api.qs({ entityId })}`) },
    {
      key: 'settlement',
      title: '项目结算单 / 项目流水',
      desc: '选择项目，导出结算单或其全部流水',
      action: (
        <Space.Compact>
          <Select style={{ width: mobile ? 150 : 240 }} placeholder="选择项目" value={proj} onChange={setProj} options={projects.map((p) => ({ value: p.id, label: p.name }))} showSearch optionFilterProp="label" />
          <Button loading={busy === 'settlement'} disabled={!proj} onClick={() => run('settlement', `/exports/settlement?projectId=${proj}`)}>结算单</Button>
          <Button loading={busy === 'pflows'} disabled={!proj} onClick={() => run('pflows', `/exports/flows?projectId=${proj}`)}>流水</Button>
        </Space.Compact>
      ),
    },
    { key: 'traces', title: '资金链明细', desc: '两个 Sheet：链路汇总（落地 / 往来流出 / 留存 / 滞留 / 待说明）与逐步流转明细', action: btn('traces', `/exports/traces${api.qs({ entityId })}`) },
    { key: 'tax', title: '税负测算', desc: '各主体各期的销项、进项、应纳增值税、附加税与已缴', action: btn('tax', `/exports/tax${api.qs({ entityId })}`) },
    { key: 'payroll', title: '工资汇总', desc: '各工资批次的人员明细', action: btn('payroll', `/exports/payroll${api.qs({ entityId })}`) },
    { key: 'ic', title: '集团内往来余额', desc: '任意两家主体之间的累计净额', action: btn('ic', `/exports/ic${api.qs({ entityId })}`) },
  ];

  return (
    <>
      <PageTitle title="导出中心" sub="所有文件由后端生成，带数据范围、导出人、导出时间水印，并记录审计日志" extra={<Space wrap><Typography.Text type="secondary">日期范围</Typography.Text><DatePicker.RangePicker value={range} onChange={setRange} /></Space>} />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card>
            <List dataSource={items} renderItem={(i) => <List.Item actions={[i.action]}><List.Item.Meta title={i.title} description={i.desc} /></List.Item>} />
            <Alert type="info" showIcon style={{ marginTop: 12 }} message="数据范围取顶部的主体切换器；日期范围对流水明细和日记账生效。各列表页的“导出当前列表”按页面筛选结果导出。" />
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title="最近导出" size="small">
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={recent}
              scroll={{ x: 460 }}
              locale={{ emptyText: '暂无' }}
              columns={[
                { title: '内容', dataIndex: 'summary', ellipsis: true },
                { title: '导出人', dataIndex: 'user', width: 80 },
                { title: '时间', dataIndex: 'at', width: 150, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
