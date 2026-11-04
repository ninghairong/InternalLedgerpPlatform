import { Select, Tag, TreeSelect } from 'antd';
import type { SelectProps } from 'antd';
import { useMemo } from 'react';
import { useStore } from '@/data/store';
import { useBalances } from '@/data/hooks';
import { ACCOUNT_KIND } from '@ledger/shared/labels';
import type { AccountKind, ID } from '@ledger/shared/types';
import { money } from '@ledger/shared/format';

const KIND_ORDER: AccountKind[] = ['CORPORATE', 'INTERNAL_PERSONAL', 'CASH', 'EXTERNAL', 'VIRTUAL'];

export function AccountSelect(props: SelectProps<ID> & { kinds?: AccountKind[]; showBalance?: boolean }) {
  const { kinds, showBalance = true, ...rest } = props;
  const accounts = useStore((s) => s.accounts);
  const entities = useStore((s) => s.entities);
  const bal = useBalances();
  const options = useMemo(
    () =>
      KIND_ORDER.filter((k) => !kinds || kinds.includes(k)).map((k) => ({
        label: ACCOUNT_KIND[k].label,
        options: accounts
          .filter((a) => a.kind === k)
          .map((a) => ({
            value: a.id,
            searchText: `${a.name} ${a.code} ${a.holder ?? ''}`,
            label: (
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {a.name}
                  {a.entityId && <Tag style={{ marginLeft: 6 }}>{entities.find((e) => e.id === a.entityId)?.shortName}</Tag>}
                </span>
                {showBalance && (k === 'CORPORATE' || k === 'INTERNAL_PERSONAL' || k === 'CASH') && (
                  <span style={{ color: '#999', fontVariantNumeric: 'tabular-nums' }}>{money(bal.get(a.id) ?? 0)}</span>
                )}
              </span>
            ),
          })),
      })),
    [accounts, entities, bal, kinds, showBalance],
  );
  return (
    <Select
      showSearch
      placeholder="搜索账户名称 / 持有人"
      optionFilterProp="searchText"
      filterOption={(input, opt) => String((opt as { searchText?: string })?.searchText ?? '').toLowerCase().includes(input.toLowerCase())}
      options={options}
      {...rest}
    />
  );
}

export function ProjectSelect(props: SelectProps<ID> & { entityId?: ID }) {
  const { entityId, ...rest } = props;
  const projects = useStore((s) => s.projects);
  const entities = useStore((s) => s.entities);
  const options = useMemo(
    () =>
      entities
        .filter((e) => !entityId || e.id === entityId)
        .map((e) => ({
          label: e.shortName,
          options: projects
            .filter((p) => p.entityId === e.id && p.status !== 'CLOSED')
            .map((p) => ({ value: p.id, label: p.name, searchText: `${p.name} ${p.code} ${e.shortName}` })),
        }))
        .filter((g) => g.options.length),
    [projects, entities, entityId],
  );
  return (
    <Select
      showSearch
      placeholder="选择项目"
      filterOption={(input, opt) => String((opt as { searchText?: string })?.searchText ?? '').includes(input)}
      options={options}
      {...rest}
    />
  );
}

export function CategorySelect(props: { value?: ID; onChange?: (v: ID) => void; style?: React.CSSProperties; status?: 'error'; placeholder?: string }) {
  const categories = useStore((s) => s.categories);
  const tree = useMemo(
    () =>
      categories
        .filter((c) => !c.parentId)
        .map((p) => ({
          value: p.id,
          title: p.name,
          selectable: false,
          children: categories.filter((c) => c.parentId === p.id).map((c) => ({ value: c.id, title: `${p.name} / ${c.name}` })),
        })),
    [categories],
  );
  return (
    <TreeSelect
      showSearch
      treeNodeFilterProp="title"
      placeholder="账目类型"
      treeData={tree}
      treeDefaultExpandAll
      popupMatchSelectWidth={false}
      {...props}
    />
  );
}

export function EntityTag({ id }: { id?: ID }) {
  const e = useStore((s) => s.entities.find((x) => x.id === id));
  if (!e) return null;
  return <Tag color={e.taxpayerType === 'GENERAL' ? 'geekblue' : 'green'}>{e.shortName}</Tag>;
}
