import { Alert, Button, Checkbox, Descriptions, Drawer, Empty, Form, Input, InputNumber, List, Modal, Select, Space, Table, Tag, Timeline, Typography, Upload, message } from 'antd';
import { CopyOutlined, EditOutlined, PaperClipOutlined, RollbackOutlined, UploadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Money } from './Money';
import { CategorySelect, EntityTag } from './Pickers';
import { TraceGraph } from './TraceGraph';
import { useCanWrite, useMaps, useStore } from '@/data/store';
import { useLots, useTraces } from '@/data/hooks';
import { FLOW_METHOD, FLOW_STATUS, IC_NATURE, TAX_KIND, TRACE_STATUS } from '@ledger/shared/labels';
import type { Attachment, AuditEntry, Flow, ID } from '@ledger/shared/types';
import { money, toCents } from '@ledger/shared/format';
import { api } from '@/api';

export function FlowDetailDrawer({ flowId, onClose, onCopy, onOpenFlow }: { flowId?: ID; onClose: () => void; onCopy?: (f: Flow) => void; onOpenFlow?: (id: ID) => void }) {
  const flows = useStore((s) => s.flows);
  const writeoffs = useStore((s) => s.writeoffs);
  const mutate = useStore((s) => s.mutate);
  const reverseFlow = useStore((s) => s.reverseFlow);
  const canWrite = useCanWrite();
  const { accMap, projMap, catMap } = useMaps();
  const lotMap = useLots();
  const traces = useTraces();
  const f = flows.find((x) => x.id === flowId);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [writingOff, setWritingOff] = useState(false);

  const reloadSide = () => {
    if (!flowId) return;
    api.get<Attachment[]>(`/flows/${flowId}/attachments`).then(setAttachments).catch(() => setAttachments([]));
    api.get<AuditEntry[]>(`/audit?targetType=FLOW&targetId=${flowId}&limit=50`).then(setHistory).catch(() => setHistory([]));
  };
  useEffect(reloadSide, [flowId, f?.attachmentCount, f?.status, f?.remark, writeoffs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const downstream = useMemo(() => (f ? flows.filter((x) => x.status === 'CONFIRMED' && x.allocations.some((a) => a.lotFlowId === f.id)) : []), [flows, f]);
  const myTraces = useMemo(() => (f ? traces.filter((t) => t.edges.some((e) => e.flowId === f.id)) : []), [traces, f]);

  if (!f) return <Drawer open={false} onClose={onClose} />;
  const from = accMap.get(f.fromAccountId)!;
  const to = accMap.get(f.toAccountId)!;
  const lot = lotMap.get(f.id);
  const myWriteoffs = writeoffs.filter((w) => w.lotFlowId === f.id);
  const canWriteoff = canWrite && f.status === 'CONFIRMED' && to.kind === 'EXTERNAL' && !!lot && lot.remaining > 0 && !f.splits.some((s) => catMap.get(s.categoryId)?.affectsPnl);
  const flowLink = (id: ID) => <a onClick={() => onOpenFlow?.(id)}>{flows.find((y) => y.id === id)?.flowNo}</a>;

  const doReverse = () => {
    let reason = '';
    Modal.confirm({
      title: `冲销 ${f.flowNo}`,
      content: (
        <>
          <p>已入账的流水不能修改或删除。冲销后保留原记录与冲销痕迹，并在今天记一笔反向分录；如需更正请重新录入。</p>
          <Input.TextArea placeholder="冲销原因（必填）" onChange={(e) => (reason = e.target.value)} />
        </>
      ),
      okButtonProps: { danger: true },
      okText: '确认冲销',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('请填写冲销原因');
          return Promise.reject();
        }
        try {
          await reverseFlow(f.id, reason);
          message.success('已冲销');
        } catch (e) {
          message.error((e as Error).message);
          return Promise.reject();
        }
      },
    });
  };

  return (
    <Drawer
      open={!!flowId}
      onClose={onClose}
      width={900}
      title={
        <Space>
          <span>流水 {f.flowNo}</span>
          <Tag color={FLOW_STATUS[f.status].color}>{FLOW_STATUS[f.status].label}</Tag>
          {f.icNature && <Tag color="magenta">集团内往来·{IC_NATURE[f.icNature]}</Tag>}
          {f.purposeMismatch && <Tag color="volcano">用途不一致</Tag>}
        </Space>
      }
      extra={
        canWrite && (
          <Space>
            {onCopy && <Button icon={<CopyOutlined />} onClick={() => onCopy(f)}>复制</Button>}
            {f.status === 'CONFIRMED' && <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>修改说明</Button>}
            {f.status === 'CONFIRMED' && <Button danger icon={<RollbackOutlined />} onClick={doReverse}>冲销</Button>}
          </Space>
        )
      }
    >
      {f.status !== 'CONFIRMED' && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${FLOW_STATUS[f.status].label}：${f.reversalReason ?? ''}`} />}
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="日期">{f.date}</Descriptions.Item>
        <Descriptions.Item label="金额"><Typography.Text strong style={{ fontSize: 16 }}>¥{money(f.amount)}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="转出">{from.name} <EntityTag id={from.entityId} /></Descriptions.Item>
        <Descriptions.Item label="转入">{to.name} <EntityTag id={to.entityId} /></Descriptions.Item>
        <Descriptions.Item label="方式">{FLOW_METHOD[f.method]}</Descriptions.Item>
        <Descriptions.Item label="经办人">{f.handler ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="账面摘要">{f.bookSummary ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="实际用途">{f.actualPurpose ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="发票">{f.invoiceNos?.join('、') ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="来源">{f.importBatchNo ? `导入批次 ${f.importBatchNo}` : `${f.createdBy ?? ''} 手工录入`}</Descriptions.Item>
        <Descriptions.Item label="备注" span={2}>{f.remark ?? '—'}</Descriptions.Item>
      </Descriptions>

      <Typography.Title level={5} style={{ marginTop: 20 }}>项目分摊</Typography.Title>
      <Table
        size="small"
        pagination={false}
        rowKey={(_, i) => String(i)}
        dataSource={f.splits}
        columns={[
          { title: '项目', dataIndex: 'projectId', render: (id: ID) => <Link to={`/projects/${id}`}>{projMap.get(id)?.name}</Link> },
          { title: '归属主体', dataIndex: 'projectId', key: 'e', render: (id: ID) => <EntityTag id={projMap.get(id)?.entityId} /> },
          {
            title: '账目类型',
            dataIndex: 'categoryId',
            render: (id: ID) => {
              const c = catMap.get(id);
              const p = c?.parentId ? catMap.get(c.parentId) : undefined;
              return <>{p ? `${p.name} / ` : ''}{c?.name} {!c?.affectsPnl && <Tag>不计损益</Tag>}</>;
            },
          },
          { title: '税种/所属期', key: 'tax', render: (_: unknown, s) => (s.tax ? `${TAX_KIND[s.tax]} ${s.taxPeriod}` : '—') },
          { title: '金额', dataIndex: 'amount', align: 'right', render: (v: number) => <Money cents={v} /> },
        ]}
      />

      <Typography.Title level={5} style={{ marginTop: 20 }}>资金来源</Typography.Title>
      {f.allocations.length ? (
        <Table
          size="small"
          pagination={false}
          rowKey="lotFlowId"
          dataSource={f.allocations}
          columns={[
            { title: '来源入款', dataIndex: 'lotFlowId', render: flowLink },
            { title: '日期', dataIndex: 'lotFlowId', key: 'd', render: (id: ID) => flows.find((x) => x.id === id)?.date },
            { title: '来自', dataIndex: 'lotFlowId', key: 'a', render: (id: ID) => accMap.get(flows.find((x) => x.id === id)!.fromAccountId)?.name },
            { title: '使用金额', dataIndex: 'amount', align: 'right', render: (v: number) => <Money cents={v} /> },
            { title: '分配方式', dataIndex: 'auto', render: (v: boolean) => (v ? <Tag>自动分配</Tag> : <Tag color="purple">手动指定</Tag>) },
          ]}
        />
      ) : (
        <Typography.Text type="secondary">{f.status !== 'CONFIRMED' ? '已释放' : from.trace === 'REQUIRED' ? '—' : `「${from.name}」是平台外的账户，本笔是资金链的起点`}</Typography.Text>
      )}

      {lot && f.status === 'CONFIRMED' && (
        <>
          <Typography.Title level={5} style={{ marginTop: 20 }}>
            资金去向{' '}
            <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal' }}>
              这笔钱进入「{to.name}」后已用 {money(lot.original - lot.remaining)}，剩余 {money(lot.remaining)}
            </Typography.Text>
            {canWriteoff && (
              <Button size="small" style={{ marginLeft: 12 }} onClick={() => setWritingOff(true)}>
                说明差额并核销
              </Button>
            )}
          </Typography.Title>
          {downstream.length ? (
            <Table
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={downstream}
              columns={[
                { title: '流水', dataIndex: 'id', render: flowLink },
                { title: '日期', dataIndex: 'date' },
                { title: '去向', dataIndex: 'toAccountId', render: (id: ID) => accMap.get(id)?.name },
                { title: '类型', key: 'c', render: (_: unknown, x: Flow) => catMap.get(x.splits[0].categoryId)?.name },
                { title: '使用本笔', key: 'amt', align: 'right', render: (_: unknown, x: Flow) => <Money cents={x.allocations.find((a) => a.lotFlowId === f.id)!.amount} /> },
              ]}
            />
          ) : (
            <Typography.Text type="secondary">尚未被后续流水使用</Typography.Text>
          )}
          {myWriteoffs.length > 0 && (
            <List
              size="small"
              style={{ marginTop: 8 }}
              header={<Typography.Text strong>差额核销</Typography.Text>}
              dataSource={myWriteoffs}
              renderItem={(w) => <List.Item>¥{money(w.amount)} · {catMap.get(w.categoryId)?.name} · {w.reason} · {w.createdBy}</List.Item>}
            />
          )}
        </>
      )}

      <Typography.Title level={5} style={{ marginTop: 20 }}>
        凭证附件
        {canWrite && (
          <Upload
            multiple
            accept="image/*,.pdf"
            showUploadList={false}
            customRequest={async ({ file, onSuccess, onError }) => {
              try {
                await mutate(() => api.upload(`/flows/${f.id}/attachments`, [file as File]));
                message.success('已上传');
                onSuccess?.({});
              } catch (e) {
                message.error((e as Error).message);
                onError?.(e as Error);
              }
            }}
          >
            <Button size="small" icon={<UploadOutlined />} style={{ marginLeft: 12 }}>上传</Button>
          </Upload>
        )}
      </Typography.Title>
      {attachments.length ? (
        <List
          size="small"
          dataSource={attachments}
          renderItem={(a) => (
            <List.Item actions={[<a key="d" onClick={() => api.download(`/attachments/${a.id}`, a.fileName).catch((e) => message.error(e.message))}>下载</a>]}>
              <Space><PaperClipOutlined />{a.fileName}<Typography.Text type="secondary">{(a.size / 1024).toFixed(0)} KB · {a.uploadedBy} · {new Date(a.uploadedAt).toLocaleString('zh-CN')}</Typography.Text></Space>
            </List.Item>
          )}
        />
      ) : (
        <Typography.Text type="secondary">暂无凭证</Typography.Text>
      )}

      <Typography.Title level={5} style={{ marginTop: 20 }}>所在资金链</Typography.Title>
      {myTraces.length > 3 && <Typography.Paragraph type="secondary">本笔资金来自 {myTraces.length} 条资金链，以下显示金额最大的 3 条</Typography.Paragraph>}
      {myTraces.length ? (
        [...myTraces]
          .sort((a, b) => (b.edges.find((e) => e.flowId === f.id)?.value ?? 0) - (a.edges.find((e) => e.flowId === f.id)?.value ?? 0))
          .slice(0, 3)
          .map((t) => (
            <div key={t.id} style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <Space style={{ marginBottom: 4 }}>
                <Link to={`/traces/${t.id}`}>资金链 T-{flows.find((x) => x.id === t.rootFlowId)?.flowNo.slice(1)}</Link>
                <Tag color={TRACE_STATUS[t.status].color}>{TRACE_STATUS[t.status].label}</Tag>
                <Typography.Text type="secondary">起始 {money(t.rootAmount)}，本笔中属于该链 {money(Math.round(t.edges.find((e) => e.flowId === f.id)?.value ?? 0))}</Typography.Text>
              </Space>
              {t.reasons.length > 0 && <Alert type="warning" showIcon message={t.reasons.join('；')} style={{ marginBottom: 4 }} />}
              <TraceGraph trace={t} height={240} highlightFlowId={f.id} />
            </div>
          ))
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={f.status === 'CONFIRMED' ? '本笔流向外部账户，不进入溯源体系' : '已冲销 / 撤销的流水不参与资金链'} />
      )}

      <Typography.Title level={5} style={{ marginTop: 20 }}>操作记录</Typography.Title>
      <Timeline items={history.map((h) => ({ children: <><Typography.Text type="secondary">{new Date(h.at).toLocaleString('zh-CN')} · {h.user}</Typography.Text><div>{h.summary}</div></> }))} />

      <EditInfoModal open={editing} flow={f} onClose={() => setEditing(false)} />
      <WriteoffModal open={writingOff} flow={f} remaining={lot?.remaining ?? 0} onClose={() => setWritingOff(false)} />
    </Drawer>
  );
}

function EditInfoModal({ open, flow, onClose }: { open: boolean; flow: Flow; onClose: () => void }) {
  const [form] = Form.useForm();
  const mutate = useStore((s) => s.mutate);
  return (
    <Modal
      title={`修改说明信息 ${flow.flowNo}`}
      open={open}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        try {
          await mutate(() => api.patch(`/flows/${flow.id}`, { ...v, invoiceNos: v.invoiceNos ?? [] }));
          message.success('已保存');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Typography.Paragraph type="secondary">只能修改不影响账务的说明字段；日期、金额、账户、项目等需冲销后重录。</Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ actualPurpose: flow.actualPurpose, purposeMismatch: flow.purposeMismatch, handler: flow.handler, invoiceNos: flow.invoiceNos, remark: flow.remark }}>
        <Form.Item name="actualPurpose" label="实际用途"><Input /></Form.Item>
        <Form.Item name="purposeMismatch" valuePropName="checked"><Checkbox>账面用途与实际不一致</Checkbox></Form.Item>
        <Form.Item name="handler" label="经办人"><Input /></Form.Item>
        <Form.Item name="invoiceNos" label="关联发票号"><Select mode="tags" tokenSeparators={[',', ';', ' ']} /></Form.Item>
        <Form.Item name="remark" label="备注"><Input.TextArea /></Form.Item>
      </Form>
    </Modal>
  );
}

function WriteoffModal({ open, flow, remaining, onClose }: { open: boolean; flow: Flow; remaining: number; onClose: () => void }) {
  const [form] = Form.useForm();
  const mutate = useStore((s) => s.mutate);
  return (
    <Modal
      title="说明差额并核销"
      open={open}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        try {
          await mutate(() => api.post(`/lots/${flow.id}/writeoff`, { amount: toCents(v.amount), categoryId: v.categoryId, reason: v.reason }));
          message.success('已核销');
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Typography.Paragraph type="secondary">
        这笔钱交给外部后，还有 ¥{money(remaining)} 没有转回。说明原因后核销，资金链不再标为异常。不发生资金移动。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ amount: remaining / 100 }}>
        <Form.Item name="amount" label="核销金额（元）" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} min={0.01} max={remaining / 100} precision={2} />
        </Form.Item>
        <Form.Item name="categoryId" label="差额性质（账目类型）" rules={[{ required: true, message: '请选择' }]}>
          <CategorySelect style={{ width: '100%' }} placeholder="如：财务费用 / 银行手续费" />
        </Form.Item>
        <Form.Item name="reason" label="原因说明" rules={[{ required: true, message: '请说明原因' }]}>
          <Input.TextArea placeholder="如：对方收取的手续费、返点等" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
