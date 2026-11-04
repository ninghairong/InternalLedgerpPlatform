import { useMemo } from 'react';
import { useMaps, useStore } from './store';
import { balances, computeTraces, flowTouchesEntity, lots, projectStats } from '@ledger/shared/selectors';
import { today } from '@ledger/shared/format';

/** 按顶部"主体"切换器过滤后的流水 */
export function useScopedFlows() {
  const flows = useStore((s) => s.flows);
  const scope = useStore((s) => s.entityScope);
  const { accMap, projMap } = useMaps();
  return useMemo(
    () => (scope === 'ALL' ? flows : flows.filter((f) => flowTouchesEntity(f, scope, accMap, projMap))),
    [flows, scope, accMap, projMap],
  );
}

export function useScopedProjects() {
  const projects = useStore((s) => s.projects);
  const scope = useStore((s) => s.entityScope);
  return useMemo(() => (scope === 'ALL' ? projects : projects.filter((p) => p.entityId === scope)), [projects, scope]);
}

export function useBalances() {
  const flows = useStore((s) => s.flows);
  return useMemo(() => balances(flows), [flows]);
}

export function useLots() {
  const flows = useStore((s) => s.flows);
  const accounts = useStore((s) => s.accounts);
  const writeoffs = useStore((s) => s.writeoffs);
  return useMemo(() => lots(flows, accounts, undefined, writeoffs), [flows, accounts, writeoffs]);
}

export function useTraces() {
  const flows = useStore((s) => s.flows);
  const accounts = useStore((s) => s.accounts);
  const categories = useStore((s) => s.categories);
  const writeoffs = useStore((s) => s.writeoffs);
  const scope = useStore((s) => s.entityScope);
  const { accMap, projMap } = useMaps();
  return useMemo(() => {
    const all = computeTraces(flows, accounts, categories, today(), writeoffs);
    if (scope === 'ALL') return all;
    const byId = new Map(flows.map((f) => [f.id, f]));
    return all.filter((t) => t.edges.some((e) => flowTouchesEntity(byId.get(e.flowId)!, scope, accMap, projMap)));
  }, [flows, accounts, categories, writeoffs, scope, accMap, projMap]);
}

export function useProjectStats() {
  const flows = useStore((s) => s.flows);
  const categories = useStore((s) => s.categories);
  return useMemo(() => projectStats(flows, categories), [flows, categories]);
}
