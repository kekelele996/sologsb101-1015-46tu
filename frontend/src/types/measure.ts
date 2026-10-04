/**
 * 复壮措施（Measure）
 * 换土、施肥、透气、树洞修补、病虫害防治等，按实施状态跟踪。
 *
 * 归属：养护班组档案（ownerScope 固定 'crew'），保护科改不到这份。
 * 容量：当年（按措施日期所在年份）复壮施工工日按古树保护级别核定，
 *      班组排措施超出容量就排队等下一批（queueState='排队中'），不挤掉已确认的措施。
 */
import type { OwnerScope } from './tree'

/** 措施类型 */
export type MeasureType = '换土' | '施肥' | '透气' | '树洞修补' | '病虫害防治'

/** 实施状态：计划 / 实施中 / 已完成 */
export type MeasureState = '计划' | '实施中' | '已完成'

/**
 * 排队状态：
 * - 已确认：已占当年工日容量，任何后续调整都不会把它挤掉
 * - 排队中：超出级别核定工日容量，等下一批容量释放后按序确认
 */
export type MeasureQueueState = '已确认' | '排队中'

export const MEASURE_TYPE_OPTIONS: MeasureType[] = ['换土', '施肥', '透气', '树洞修补', '病虫害防治']
export const MEASURE_STATE_OPTIONS: MeasureState[] = ['计划', '实施中', '已完成']
export const MEASURE_QUEUE_OPTIONS: MeasureQueueState[] = ['已确认', '排队中']

/** 各类措施的默认施工工日（新建表单与历史数据回填时使用，可人工修改） */
export const MEASURE_TYPE_DEFAULT_WORKDAYS: Record<MeasureType, number> = {
  换土: 12,
  施肥: 4,
  透气: 6,
  树洞修补: 8,
  病虫害防治: 3,
}

export interface Measure {
  id: string
  /** 所属古树 */
  treeId: string
  /** 措施类型 */
  type: MeasureType
  /** 实施日期 YYYY-MM-DD（容量按其所在「当年」核定） */
  date: string
  /** 材料 */
  material: string
  /** 负责人 */
  operator: string
  /** 实施状态 */
  state: MeasureState
  /** 占用的复壮施工工日 */
  workdays: number
  /** 排队状态：已确认 / 排队中；已完成措施视同已确认 */
  queueState: MeasureQueueState
  /** 档案归属方：复壮措施归养护班组 */
  ownerScope: OwnerScope
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
  workdays: number
}
