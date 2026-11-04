import { Alert, Button, Checkbox, Col, DatePicker, Divider, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Table, Tag, Typography, Upload, message } from 'antd';
import type { UploadFile } from 'antd';
import { DeleteOutlined, PaperClipOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { AccountSelect, CategorySelect, ProjectSelect } from './Pickers';
import { useMaps, useStore } from '@/data/store';
import { autoAllocate as allocate, openLotsOf } from '@ledger/shared/selectors';
import { FLOW_METHOD, IC_NATURE, TAX_KIND } from '@ledger/shared/labels';
import type { Allocation, Flow, FlowMethod, IcNature, ID, TaxKind } from '@ledger/shared/types';
import { cnUpper, money, toCents, today } from '@ledger/shared/format';
import { api } from '@/api';

interface SplitRow {
  projectId?: ID;
  categoryId?: ID;
  amount?: number; // 元
  tax?: TaxKind;
  taxPeriod?: string;
}

interface FormValues {
  date: Dayjs;
  fromAccountId?: ID;
  toAccountId?: ID;
  amount?: number; // 元
  method: FlowMethod;
  bookSummary?: string;
  actualPurpose?: string;
  purposeMismatch?: boolean;
  icNature?: IcNature;
  handler?: string;
  invoiceNos?: string[];
  remark?: string;
  splits: SplitRow[];
}

export function FlowFormModal({ open, onClose, copyFrom }: { open: boolean; onClose: () => void; copyFrom?: Flow }) {
  const [form] = Form.useForm<FormValues>();
  const flows = useStore((s) => s.flows);
  const accounts = useStore((s) => s.accounts);
  const addFlows = useStore((s) => s.addFlows);
  const { accMap, projMap, catMap } = useMaps();

  const fromId = Form.useWatch('fromAccountId', form);
  const toId = Form.useWatch('toAccountId', form);
  const amountYuan = Form.useWatch('amount', form);
  const date = Form.useWatch('date', form);
  const splits = Form.useWatch('splits', form) ?? [];
  const amount = toCents(amountYuan);
  const dateStr = date ? date.format('YYYY-MM-DD') : today();

  const from = fromId ? accMap.get(fromId) : undefined;
  const to = toId ? accMap.get(toId) : undefined;
  const [optionalTrace, setOptionalTrace] = useState(false);
  const traceNeeded = from?.trace === 'REQUIRED' || (from?.trace === 'OPTIONAL' && optionalTrace);
  const isIc = !!(from?.entityId && to?.entityId && from.entityId !== to.entityId);

  const [alloc, setAlloc] = useState<Record<ID, number>>({});
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const firstProject = splits[0]?.projectId;
  const allocOpts = useMemo(() => ({ asOf: dateStr, preferProjectId: firstProject }), [dateStr, firstProject]);
  const openLots = useMemo(() => (fromId && traceNeeded ? openLotsOf(flows, accounts, fromId, allocOpts) : []), [flows, accounts, fromId, traceNeeded, allocOpts]);

  const autoAllocate = () => {
    if (!fromId || !amount) return setAlloc({});
    const r = allocate(flows, accounts, fromId, amount, allocOpts);
    setAlloc(Object.fromEntries(r.allocations.map((a) => [a.lotFlowId, a.amount])));
  };
  useEffect(autoAllocate, [fromId, amount, allocOpts, traceNeeded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setOptionalTrace(false);
    setFiles([]);
    if (copyFrom) {
      form.setFieldsValue({
        date: dayjs(today()), fromAccountId: copyFrom.fromAccountId, toAccountId: copyFrom.toAccountId, amount: copyFrom.amount / 100,
        method: copyFrom.method, bookSummary: copyFrom.bookSummary, actualPurpose: copyFrom.actualPurpose, icNature: copyFrom.icNature,
        handler: copyFrom.handler, splits: copyFrom.splits.map((s) => ({ ...s, amount: s.amount / 100 })),
      });
    }
  }, [open, copyFrom, form]);

  // 根据账户类型推荐流转方式
  useEffect(() => {
    if (!from || !to) return;
    let m: FlowMethod | undefined;
    if (to.kind === 'CASH' && from.kind !== 'CASH') m = 'CASH_WITHDRAW';
    else if (from.kind === 'CASH') m = 'CASH_HANDOVER';
    else if (from.kind === 'CORPORATE' && (to.kind === 'CORPORATE' || to.kind === 'EXTERNAL')) m = 'CORPORATE_TRANSFER';
    if (m && !form.isFieldTouched('method')) form.setFieldValue('method', m);
  }, [from, to, form]);

  const allocTotal = Object.values(alloc).reduce((a, b) => a + b, 0);
  const available = openLots.reduce((a, l) => a + l.remaining, 0);
  const splitTotal = splits.length <= 1 ? amount : splits.reduce((a, s) => a + toCents(s?.amount), 0);
  const singleSplit = splits.length <= 1;

  const submit = async (andNew: boolean) => {
    // 校验未通过时表单已标红提示，这里直接返回
    const v = await form.validateFields().catch(() => undefined);
    if (!v) return;
    if (!amount) return;
    if (v.fromAccountId === v.toAccountId) return message.error('转出与转入账户不能相同');
    if (traceNeeded && allocTotal !== amount) return message.error(`资金来源合计 ${money(allocTotal)} 与金额 ${money(amount)} 不一致`);
    if (!singleSplit && splitTotal !== amount) return message.error(`分摊合计 ${money(splitTotal)} 与金额 ${money(amount)} 不一致`);
    const fifo = allocate(flows, accounts, v.fromAccountId!, amount, allocOpts);
    const fifoMap = new Map(fifo.allocations.map((a) => [a.lotFlowId, a.amount]));
    const allocations: Allocation[] = traceNeeded
      ? Object.entries(alloc).filter(([, a]) => a > 0).map(([lotFlowId, a]) => ({ lotFlowId, amount: a, auto: fifoMap.get(lotFlowId) === a }))
      : [];
    setBusy(true);
    let created: { id: ID; flowNo: string };
    try {
      [created] = await addFlows([
      {
        date: v.date.format('YYYY-MM-DD'), amount, fromAccountId: v.fromAccountId!, toAccountId: v.toAccountId!, method: v.method,
        bookSummary: v.bookSummary, actualPurpose: v.actualPurpose, purposeMismatch: v.purposeMismatch, icNature: isIc ? v.icNature : undefined,
        handler: v.handler, invoiceNos: v.invoiceNos, remark: v.remark, allocations,
        splits: v.splits.map((s) => ({ projectId: s.projectId!, categoryId: s.categoryId!, amount: singleSplit ? amount : toCents(s.amount), tax: s.tax, taxPeriod: s.taxPeriod })),
      },
      ]);
    } catch (e) {
      setBusy(false);
      return message.error((e as Error).message);
    }
    // 凭证附件在流水保存成功后上传
    if (files.length) {
      try {
        await api.upload(`/flows/${created.id}/attachments`, files.map((f) => f.originFileObj as File));
        await useStore.getState().load();
      } catch (e) {
        message.warning(`流水已保存，但凭证上传失败：${(e as Error).message}，可在流水详情中重新上传`);
      }
    }
    setBusy(false);
    message.success(`已保存 ${created.flowNo}`);
    if (andNew) {
      form.setFieldsValue({ amount: undefined, bookSummary: undefined, actualPurpose: undefined, invoiceNos: undefined, remark: undefined });
      setFiles([]);
    } else onClose();
  };

  return (
    <Modal
      title="新建资金流水"
      open={open}
      onCancel={onClose}
      width={980}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={() => submit(true)} loading={busy}>保存并继续录入</Button>
          <Button type="primary" onClick={() => submit(false)} loading={busy}>保存</Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={{ date: dayjs(today()), method: 'BANK_TRANSFER', splits: [{}] }} requiredMark="optional">
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="date" label="日期" rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={9}>
            <Form.Item name="fromAccountId" label="转出账户" rules={[{ required: true, message: '请选择转出账户' }]}>
              <AccountSelect />
            </Form.Item>
          </Col>
          <Col span={9}>
            <Form.Item name="toAccountId" label="转入账户" rules={[{ required: true, message: '请选择转入账户' }]}>
              <AccountSelect />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="amount" label="金额（元）" rules={[{ required: true, message: '请输入金额' }]} extra={amount ? <Typography.Text type="secondary">{cnUpper(amount)}</Typography.Text> : null}>
              <InputNumber style={{ width: '100%' }} min={0.01} precision={2} controls={false} formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} parser={(v) => Number((v ?? '').replace(/,/g, '')) as unknown as 0.01} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="method" label="流转方式" rules={[{ required: true }]}>
              <Select options={Object.entries(FLOW_METHOD).map(([value, label]) => ({ value, label }))} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="handler" label="经办人">
              <Input placeholder="姓名" />
            </Form.Item>
          </Col>
          <Col span={5}>
            {isIc && (
              <Form.Item name="icNature" label="集团内往来性质" rules={[{ required: true, message: '两家主体之间的流水需选择性质' }]}>
                <Select options={Object.entries(IC_NATURE).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            )}
          </Col>
          <Col span={12}>
            <Form.Item name="bookSummary" label="账面摘要" tooltip="银行回单上的用途">
              <Input placeholder="如：支付王燕雪工资" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="实际用途" tooltip="与账面摘要不同时填写，账目类型按实际用途选择">
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="actualPurpose" noStyle>
                  <Input placeholder="如：颐和小区房租 + 物业费" />
                </Form.Item>
              </Space.Compact>
              <Form.Item name="purposeMismatch" valuePropName="checked" noStyle>
                <Checkbox style={{ marginTop: 6 }}>账面用途与实际不一致（报表中标记，供内部审计复核）</Checkbox>
              </Form.Item>
            </Form.Item>
          </Col>
        </Row>

        {isIc && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`集团内往来：${from?.name} → ${to?.name}。只记这一条，双方往来余额自动更新，合并视角下不计入收支。`} />
        )}

        <Divider orientation="left" plain style={{ margin: '4px 0 12px' }}>
          项目与账目类型
        </Divider>
        <Form.List name="splits">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field, idx) => {
                const cat = catMap.get(splits[idx]?.categoryId ?? '');
                const proj = projMap.get(splits[idx]?.projectId ?? '');
                return (
                  <Row gutter={8} key={field.key} align="top">
                    <Col span={singleSplit ? 12 : 9}>
                      <Form.Item name={[field.name, 'projectId']} rules={[{ required: true, message: '请选择项目' }]} extra={proj ? `归属主体：${useStore.getState().entities.find((e) => e.id === proj.entityId)?.shortName}` : undefined}>
                        <ProjectSelect />
                      </Form.Item>
                    </Col>
                    <Col span={singleSplit ? 12 : 8}>
                      <Form.Item name={[field.name, 'categoryId']} rules={[{ required: true, message: '请选择账目类型' }]}>
                        <CategorySelect style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    {!singleSplit && (
                      <Col span={5}>
                        <Form.Item name={[field.name, 'amount']} rules={[{ required: true, message: '金额' }]}>
                          <InputNumber style={{ width: '100%' }} min={0.01} precision={2} placeholder="金额" />
                        </Form.Item>
                      </Col>
                    )}
                    {!singleSplit && (
                      <Col span={2}>
                        <Button icon={<DeleteOutlined />} type="text" danger onClick={() => remove(field.name)} />
                      </Col>
                    )}
                    {cat?.requiresTax && (
                      <>
                        <Col span={6}>
                          <Form.Item name={[field.name, 'tax']} rules={[{ required: true, message: '缴税流水须注明税种' }]}>
                            <Select placeholder="税种" options={Object.entries(TAX_KIND).map(([value, label]) => ({ value, label }))} />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item name={[field.name, 'taxPeriod']} rules={[{ required: true, message: '所属期' }]}>
                            <Input placeholder="所属期，如 2026-10 或 2026-Q3" />
                          </Form.Item>
                        </Col>
                      </>
                    )}
                  </Row>
                );
              })}
              <Space>
                <Button size="small" icon={<PlusOutlined />} onClick={() => add({})}>
                  拆分到多个项目 / 类型
                </Button>
                {!singleSplit && (
                  <Typography.Text type={splitTotal === amount ? 'success' : 'danger'}>
                    分摊合计 {money(splitTotal)} / {money(amount)}
                  </Typography.Text>
                )}
              </Space>
            </>
          )}
        </Form.List>

        {from && (from.trace === 'REQUIRED' || from.trace === 'OPTIONAL') && (
          <>
            <Divider orientation="left" plain style={{ margin: '16px 0 12px' }}>
              资金来源（溯源）
            </Divider>
            {from.trace === 'REQUIRED' ? (
              <Alert
                type={!amount ? 'info' : allocTotal === amount ? 'success' : 'error'}
                showIcon
                style={{ marginBottom: 8 }}
                message={
                  !amount
                    ? `「${from.name}」的每笔出款都必须注明资金来自哪几笔入款`
                    : available < amount
                      ? `可用资金不足：该账户截至 ${dateStr} 未分配的入款合计 ${money(available)}，本次需要 ${money(amount)}。请先录入这笔钱的来源。`
                      : `已分配 ${money(allocTotal)} / ${money(amount)}（默认同项目优先、再先进先出，可手动调整）`
                }
              />
            ) : (
              <Space style={{ marginBottom: 8 }}>
                <Switch size="small" checked={optionalTrace} onChange={setOptionalTrace} />
                <Typography.Text type="secondary">关联资金来源（可选）：用于把外部账户转回的钱接到原资金链上，例如李老板收到现金后转回公户</Typography.Text>
              </Space>
            )}
            {traceNeeded && (
              <Table
                size="small"
                rowKey="flowId"
                pagination={false}
                scroll={{ y: 220 }}
                dataSource={openLots}
                locale={{ emptyText: '该账户没有可用的入款' }}
                title={() => (
                  <Space>
                    <Typography.Text strong>可用入款</Typography.Text>
                    <Button size="small" icon={<ThunderboltOutlined />} onClick={autoAllocate}>
                      重新自动分配
                    </Button>
                  </Space>
                )}
                columns={[
                  { title: '入款流水', dataIndex: 'flowId', width: 140, render: (id: ID) => flows.find((f) => f.id === id)?.flowNo },
                  { title: '入款日期', dataIndex: 'date', width: 100 },
                  { title: '来自', dataIndex: 'flowId', key: 'src', ellipsis: true, render: (id: ID) => accMap.get(flows.find((f) => f.id === id)!.fromAccountId)?.name },
                  { title: '入款项目', dataIndex: 'projectIds', ellipsis: true, render: (ids: ID[]) => ids.map((id) => projMap.get(id)?.name).join('、') },
                  { title: '原金额', dataIndex: 'original', align: 'right', width: 120, render: (v: number) => money(v) },
                  { title: '剩余可用', dataIndex: 'remaining', align: 'right', width: 120, render: (v: number) => money(v) },
                  {
                    title: '本次使用',
                    key: 'use',
                    width: 140,
                    render: (_: unknown, l) => (
                      <InputNumber
                        size="small"
                        style={{ width: '100%' }}
                        min={0}
                        max={l.remaining / 100}
                        precision={2}
                        value={(alloc[l.flowId] ?? 0) / 100}
                        onChange={(v) => setAlloc({ ...alloc, [l.flowId]: toCents(v) })}
                      />
                    ),
                  },
                  { title: '', key: 'tag', width: 56, render: (_: unknown, l) => (alloc[l.flowId] ? <Tag color="purple">已选</Tag> : null) },
                ]}
              />
            )}
          </>
        )}

        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={12}>
            <Form.Item name="invoiceNos" label="关联发票号">
              <Select mode="tags" placeholder="输入发票号后回车" tokenSeparators={[',', ';', ' ']} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="remark" label="备注">
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Upload
          multiple
          accept="image/*,.pdf"
          fileList={files}
          beforeUpload={() => false}
          onChange={({ fileList }) => setFiles(fileList)}
        >
          <Button icon={<PaperClipOutlined />}>添加凭证（转账截图、收据、发票，图片或 PDF）</Button>
        </Upload>
      </Form>
    </Modal>
  );
}
