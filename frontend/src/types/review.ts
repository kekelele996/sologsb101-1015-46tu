/**
 * 长势复评（Review）
 * 长势为「衰弱」或「濒危」时必须填写后续措施。
 *
 * 归属：古树保护科档案（ownerScope 固定 'bureau'），养护班组改不到这份。
 *      保护科在自己这份里同时持有保护级别（Tree.protectLevel）与长势复评结论。
 */
import type { OwnerScope } from './tree'

/** 长势等级 */
export type Vigor = '旺盛' | '一般' | '衰弱' | '濒危'

/** 长势趋势 */
export type Trend = '好转' | '持平' | '下降'

export const VIGOR_OPTIONS: Vigor[] = ['旺盛', '一般', '衰弱', '濒危']
export const TREND_OPTIONS: Trend[] = ['好转', '持平', '下降']

/** 需要强制填写后续措施的长势等级 */
export const VIGOR_NEED_FOLLOW_UP: Vigor[] = ['衰弱', '濒危']

export interface Review {
  id: string
  /** 所属古树 */
  treeId: string
  /** 复评日期 YYYY-MM-DD */
  date: string
  /** 长势 */
  vigor: Vigor
  /** 趋势 */
  trend: Trend
  /** 复评结论（保护科定，班组顶不回去） */
  conclusion: string
  /** 后续措施（长势为衰弱 / 濒危时必填） */
  followUp: string
  /** 档案归属方：长势复评归保护科 */
  ownerScope: OwnerScope
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑长势复评的表单草稿 */
export interface ReviewDraft {
  treeId: string
  date: string
  vigor: Vigor
  trend: Trend
  conclusion: string
  followUp: string
}
