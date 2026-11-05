import { createContext, useContext } from 'react';
import { Grid } from 'antd';
import type { Flow, ID } from '@ledger/shared/types';

/** 全局弹层：任何页面都能打开"新建流水"和"流水详情" */
export interface Ui {
  newFlow: (copyFrom?: Flow) => void;
  openFlow: (id: ID) => void;
}

export const UiContext = createContext<Ui>({ newFlow: () => {}, openFlow: () => {} });
export const useUi = () => useContext(UiContext);

/** 屏幕宽度小于 768px（手机 / 竖屏小平板）时返回 true */
export function useIsMobile() {
  const screens = Grid.useBreakpoint();
  return screens.md === false;
}
