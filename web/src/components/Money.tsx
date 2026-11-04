import { Typography } from 'antd';
import { money } from '@ledger/shared/format';

/** 金额展示：支出红、收入绿（direction 指定），等宽数字右对齐 */
export function Money({ cents, direction, strong }: { cents: number; direction?: 'in' | 'out'; strong?: boolean }) {
  const color = direction === 'in' ? '#389e0d' : direction === 'out' ? '#cf1322' : undefined;
  return (
    <Typography.Text strong={strong} style={{ color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      {direction === 'in' ? '+' : direction === 'out' ? '-' : ''}
      {money(Math.abs(cents))}
    </Typography.Text>
  );
}
