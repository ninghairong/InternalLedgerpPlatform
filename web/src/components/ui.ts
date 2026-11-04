import { createContext, useContext } from 'react';
import type { Flow, ID } from '@ledger/shared/types';

/** 全局弹层：任何页面都能打开"新建流水"和"流水详情" */
export interface Ui {
  newFlow: (copyFrom?: Flow) => void;
  openFlow: (id: ID) => void;
}

export const UiContext = createContext<Ui>({ newFlow: () => {}, openFlow: () => {} });
export const useUi = () => useContext(UiContext);
