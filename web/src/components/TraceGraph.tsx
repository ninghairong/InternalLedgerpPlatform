import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useMaps } from '@/data/store';
import type { Trace } from '@ledger/shared/selectors';
import { money } from '@ledger/shared/format';

const KIND_COLOR: Record<string, string> = {
  CORPORATE: '#1677ff',
  INTERNAL_PERSONAL: '#722ed1',
  CASH: '#d48806',
  EXTERNAL: '#8c8c8c',
  VIRTUAL: '#13c2c2',
  OPEN: '#ff4d4f',
  KEPT: '#91caff',
  EXT: '#faad14',
};

/**
 * 资金链桑基图。节点 = 账户@层级（同一账户在不同层级重复出现时分开画，避免环），
 * 公户未用完的钱画成"留存"节点，个人卡/现金未用完的画成"滞留"节点，外部账户未说明的差额画成"待说明"节点。
 */
export function TraceGraph({ trace, height = 360, highlightFlowId }: { trace: Trace; height?: number; highlightFlowId?: string }) {
  const { accMap } = useMaps();
  const option = useMemo(() => {
    const nodes = new Map<string, { name: string; label: string; color: string; depth: number }>();
    const links = new Map<string, { source: string; target: string; value: number; flowIds: string[] }>();
    const inflow = new Map<string, number>();
    const outflow = new Map<string, number>();
    const node = (accId: string, depth: number) => {
      const key = `${accId}@${depth}`;
      const a = accMap.get(accId);
      if (!nodes.has(key)) nodes.set(key, { name: key, label: a?.name ?? accId, color: KIND_COLOR[a?.kind ?? 'EXTERNAL'], depth });
      return key;
    };
    for (const e of trace.edges) {
      const s = node(e.from, e.depth);
      const t = node(e.to, e.depth + 1);
      const k = `${s}->${t}`;
      const l = links.get(k) ?? { source: s, target: t, value: 0, flowIds: [] };
      l.value += e.value;
      l.flowIds.push(e.flowId);
      links.set(k, l);
      outflow.set(s, (outflow.get(s) ?? 0) + e.value);
      inflow.set(t, (inflow.get(t) ?? 0) + e.value);
    }
    for (const [key, n] of [...nodes]) {
      const accId = key.split('@')[0];
      const a = accMap.get(accId);
      const rest = (inflow.get(key) ?? 0) - (outflow.get(key) ?? 0);
      if (rest < 0.5 || !a) continue;
      if (a.kind === 'CORPORATE') {
        const t = `${key}#kept`;
        nodes.set(t, { name: t, label: `留存 ${money(rest)}`, color: KIND_COLOR.KEPT, depth: n.depth + 1 });
        links.set(`${key}->${t}`, { source: key, target: t, value: rest, flowIds: [] });
      } else if (a.trace === 'REQUIRED') {
        const t = `${key}#open`;
        nodes.set(t, { name: t, label: `滞留 ${money(rest)}`, color: KIND_COLOR.OPEN, depth: n.depth + 1 });
        links.set(`${key}->${t}`, { source: key, target: t, value: rest, flowIds: [] });
      } else if (a.kind === 'EXTERNAL' && trace.external >= 0.5 && outflow.has(key)) {
        const t = `${key}#ext`;
        nodes.set(t, { name: t, label: `待说明 ${money(rest)}`, color: KIND_COLOR.EXT, depth: n.depth + 1 });
        links.set(`${key}->${t}`, { source: key, target: t, value: rest, flowIds: [] });
      }
    }
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: { dataType: string; data: { label?: string; source?: string; target?: string; value: number } }) => {
          if (p.dataType === 'edge') {
            const s = nodes.get(p.data.source!)?.label;
            const t = nodes.get(p.data.target!)?.label;
            return `${s} → ${t}<br/><b>¥${money(p.data.value)}</b>`;
          }
          return p.data.label;
        },
      },
      series: [
        {
          type: 'sankey',
          left: 8,
          right: 140,
          top: 16,
          bottom: 16,
          nodeAlign: 'left',
          nodeGap: 14,
          nodeWidth: 16,
          draggable: false,
          emphasis: { focus: 'adjacency' },
          label: { formatter: (p: { data: { label: string } }) => p.data.label, fontSize: 12, width: 120, overflow: 'truncate', ellipsis: '…' },
          lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.35 },
          data: [...nodes.values()].map((n) => ({ ...n, depth: n.depth, itemStyle: { color: n.color } })),
          links: [...links.values()].map((l) => ({
            ...l,
            lineStyle: highlightFlowId && l.flowIds.includes(highlightFlowId) ? { opacity: 0.8, color: '#fa541c' } : undefined,
          })),
        },
      ],
    };
  }, [trace, accMap, highlightFlowId]);

  return <ReactECharts option={option} style={{ height }} notMerge />;
}
