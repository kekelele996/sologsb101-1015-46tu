/**
 * 加固件（Support）——养护班组档案
 * 支撑杆、拉纤、避雷设施，按保护科核定的检查周期（policy.ts）自动提示超期未检查。
 * 保护级别调整后，按旧级别核定的检查周期即作废，需要班组按新级别重排检查任务；
 * 已经完成的检查历史照旧留住（见 Inspection.voided 只作用于待办任务）。
 */
import type { OwnerSide } from './ownership'

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型 */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 检查周期（月）。登记时按当时保护级别核定，级别调整后由班组按新级别重设 */
  checkCycleMon: number
  /** 最近检查日期 YYYY-MM-DD */
  lastCheckDate: string
  /**
   * 检查周期所依据的保护级别。
   * 与古树当前保护级别不一致时，表示保护级别已调整、该加固件的检查待办已失效，待班组重排。
   */
  basisLevel: string
  /** 档案归属：固定为养护班组 */
  ownerSide: OwnerSide
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
