/**
 * 加固件（Support）
 * 支撑杆、拉纤、避雷设施，按检查周期自动提示超期未检查。
 *
 * 归属：养护班组档案（ownerScope 固定 'crew'），保护科改不到这份。
 * 失效规则：保护级别一调整，按旧级别安排、尚未检查的加固件检查任务立即失效，
 *          挑出来等班组按新级别重排；已检查过的记录照旧留住。
 */
import type { OwnerScope, ProtectLevel } from './tree'

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

/**
 * 加固件检查任务状态：
 * - 待重排：级别调整导致旧的检查安排失效（派生判定），等班组按新级别重排
 * - 已安排：已按古树当前级别重新安排检查周期
 */
export type SupportTaskState = '待重排' | '已安排'

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型 */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 检查周期（月） */
  checkCycleMon: number
  /** 最近检查日期 YYYY-MM-DD；'' 表示安装后从未检查（任务一旦失效必被挑出） */
  lastCheckDate: string
  /** 档案归属方：加固件登记归养护班组 */
  ownerScope: OwnerScope
  /** 任务状态：按级别安排的加固件检查是否待班组重排；'' 为班组日常登记 */
  taskState: SupportTaskState | ''
  /** 安排检查时所依据的保护级别；与古树现级别不一致即失效 */
  taskLevel: ProtectLevel | ''
  /**
   * 最近一次检查是否发生在最近一次级别调整之后。
   * true  = 已按新级别完成检查，照旧留住；
   * false = 级别调整前的旧检查安排，taskLevel 又对不上时判定为失效待重排。
   */
  checkedAfterLevelChange: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑加固件的表单草稿 */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  checkCycleMon: number
  lastCheckDate: string
}
