// 前端数据：一次性从后端加载全量快照（5 人自用、数据量有限），页面在浏览器中计算展示；
// 所有写操作调用后端接口（后端校验 + 数据库约束兜底），成功后重新加载快照。
import { useMemo } from 'react';
import { create } from 'zustand';
import type { ImportRow, NewFlowInput } from '@ledger/shared/importer';
import type { Entity, ID, Role, Snapshot, TaxProfile } from '@ledger/shared/types';
import { api, token } from '@/api';

export interface Me {
  id: ID;
  username: string;
  displayName: string;
  role: Role;
}

export interface ImportResult {
  id: ID;
  batchNo: string;
  status?: string;
  rows: ImportRow[];
  summary: { total: number; ok: number; warning: number; error: number; duplicate: number; matched: number; skipped: number };
}

const SCOPE_KEY = 'ledger-entity-scope';

const empty: Snapshot = { version: 0, entities: [], accounts: [], projects: [], categories: [], flows: [], invoices: [], importBatches: [], taxRules: [], periods: [], writeoffs: [], payrolls: [] };

interface State extends Snapshot {
  me?: Me;
  loaded: boolean;
  entityScope: ID | 'ALL';
  setEntityScope: (id: ID | 'ALL') => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  restore: () => Promise<boolean>;
  load: () => Promise<void>;
  /** 写操作的统一包装：调用接口后刷新数据 */
  mutate: <T>(fn: () => Promise<T>) => Promise<T>;
  addFlows: (flows: NewFlowInput[]) => Promise<{ id: ID; flowNo: string; tempId?: string }[]>;
  reverseFlow: (id: ID, reason: string) => Promise<void>;
  saveEntity: (id: ID | undefined, e: Partial<Entity> & { profile?: TaxProfile }) => Promise<void>;
}

export const useStore = create<State>()((set, get) => ({
  ...empty,
  loaded: false,
  entityScope: (localStorage.getItem(SCOPE_KEY) as ID | null) ?? 'ALL',

  setEntityScope: (entityScope) => {
    localStorage.setItem(SCOPE_KEY, entityScope);
    set({ entityScope });
  },

  login: async (username, password) => {
    const r = await api.post<{ token: string; user: Me }>('/auth/login', { username, password });
    token.set(r.token);
    set({ me: r.user });
    await get().load();
  },

  logout: () => {
    token.clear();
    set({ ...empty, me: undefined, loaded: false });
  },

  restore: async () => {
    if (!token.get()) return false;
    try {
      const me = await api.get<Me>('/auth/me');
      set({ me });
      await get().load();
      return true;
    } catch {
      return false;
    }
  },

  load: async () => {
    const snap = await api.get<Snapshot>('/snapshot');
    const scope = get().entityScope;
    set({ ...snap, loaded: true, entityScope: scope !== 'ALL' && !snap.entities.some((e) => e.id === scope) ? 'ALL' : scope });
  },

  mutate: async (fn) => {
    const r = await fn();
    await get().load();
    return r;
  },

  addFlows: (flows) => get().mutate(async () => (await api.post<{ created: { id: ID; flowNo: string; tempId?: string }[] }>('/flows', { flows })).created),

  reverseFlow: (id, reason) => get().mutate(() => api.post(`/flows/${id}/reverse`, { reason })),

  saveEntity: (id, e) => get().mutate(() => (id ? api.put(`/entities/${id}`, e) : api.post('/entities', e))),
}));

/** 当前用户能否修改数据 */
export const useCanWrite = () => useStore((s) => s.me?.role === 'ADMIN' || s.me?.role === 'FINANCE');
export const useIsAdmin = () => useStore((s) => s.me?.role === 'ADMIN');

export const useMaps = () => {
  const accounts = useStore((s) => s.accounts);
  const projects = useStore((s) => s.projects);
  const entities = useStore((s) => s.entities);
  const categories = useStore((s) => s.categories);
  return useMemo(
    () => ({
      accMap: new Map(accounts.map((a) => [a.id, a])),
      projMap: new Map(projects.map((p) => [p.id, p])),
      entMap: new Map(entities.map((e) => [e.id, e])),
      catMap: new Map(categories.map((c) => [c.id, c])),
    }),
    [accounts, projects, entities, categories],
  );
};

/** 系统虚拟账户与主体"公司公共"项目的查找 */
export const virtualAccount = (kind: string) => useStore.getState().accounts.find((a) => a.virtualKind === kind);
export const commonProjectOf = (entityId?: ID) => useStore.getState().projects.find((p) => p.kind === 'COMMON' && p.entityId === entityId);
