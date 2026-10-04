/**
 * 复壮措施（Measure）——养护班组档案
 * 换土、施肥、透气、树洞修补、病虫害防治等，按实施状态跟踪。
 * 当年复壮施工工日按保护级别核定（policy.ts）：
 * - 已确认（实施中 / 已完成）的措施占用核定工日容量，不被新措施挤掉；
 * - 班组排出的措施超出当年容量时进入排队（queued），等下一批容量空出再排入。
 */
import type { OwnerSide } from './ownership'

/** 措施类型 */
export type MeasureType = '换土' | '施肥' | '透气' | '树洞修补' | '病虫害防治'

/** 实施状态：计划 / 实施中 / 已完成 / 排队待批 */
export type MeasureState = '计划' | '实施中' | '已完成' | '排队待批'

/** 已确认、占用当年工日容量且不可被挤掉的状态 */
export const MEASURE_CONFIRMED_STATES: MeasureState[] = ['实施中', '已完成']

export const MEASURE_TYPE_OPTIONS: MeasureType[] = ['换土', '施肥', '透气', '树洞修补', '病虫害防治']
export const MEASURE_STATE_OPTIONS: MeasureState[] = ['计划', '实施中', '已完成', '排队待批']

export interface Measure {
  id: string
  /** 所属古树 */
  treeId: string
  /** 措施类型 */
  type: MeasureType
  /** 实施日期 YYYY-MM-DD */
  date: string
  /** 材料 */
  material: string
  /** 负责人 */
  operator: string
  /** 实施状态 */
  state: MeasureState
  /** 核定施工工日（工日 / 次），按措施类型默认带入 */
  workdays: number
  /** 核定年度（YYYY，按排措施当时的年度计入容量） */
  planYear: number
  /** 排队序号：处于「排队待批」时的先后次序（越小越靠前），非排队为 0 */
  queueOrder: number
  /** 容量不足进入排队时的说明 */
  queueReason: string
  /** 档案归属：固定为养护班组 */
  ownerSide: OwnerSide
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑复壮措施的表单草稿 */
export interface MeasureDraft {
  treeId: string
  type: MeasureType
  date: string
  material: string
  operator: string
  state: MeasureState
  workdays?: number
}
