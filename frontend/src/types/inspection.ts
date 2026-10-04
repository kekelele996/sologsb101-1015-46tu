/**
 * 检查任务（Inspection）——养护班组档案
 * 班组按古树保护科核定的检查周期排出的「待办检查」：
 * - kind = survey   → 按树体检查周期排出的树体检查
 * - kind = support  → 按加固件检查周期排出的加固件检查
 * 保护级别一调整，按旧级别排出的待办检查立即失效（voided = true），
 * 挑出来等班组按新级别重排；已经完成的检查（checkedAt 有值 / 对应历史记录）照旧留住。
 */
import type { OwnerSide } from './ownership'

/** 检查任务种类：树体检查 / 加固件检查 */
export type InspectionKind = 'survey' | 'support'

export const INSPECTION_KIND_LABEL: Record<InspectionKind, string> = {
  survey: '树体检查',
  support: '加固件检查',
}

/** 检查任务状态：待检查 / 已完成 / 已失效 */
export type InspectionStatus = '待检查' | '已完成' | '已失效'

export const INSPECTION_STATUS_LABEL: Record<InspectionStatus, string> = {
  待检查: '待检查',
  已完成: '已完成',
  已失效: '已失效（待重排）',
}

export interface Inspection {
  id: string
  /** 所属古树 */
  treeId: string
  /** 任务种类 */
  kind: InspectionKind
  /** kind=support 时关联的加固件 id；kind=survey 时为空 */
  supportId: string
  /** 计划检查日期 YYYY-MM-DD */
  dueDate: string
  /** 排任务时依据的保护级别（级别调整后据此识别失效任务） */
  basisLevel: string
  /** 排任务时依据的检查周期（月） */
  cycleMon: number
  /** 任务状态 */
  status: InspectionStatus
  /** 是否已失效：保护级别调整后置 true，已完成任务不失效（做完的照旧留住） */
  voided: boolean
  /** 失效原因 */
  voidReason: string
  /** 完成日期 YYYY-MM-DD；完成后由班组回填 */
  checkedAt: string
  /** 完成时关联的记录 id（树体检查 / 加固件检查登记） */
  recordId: string
  /** 档案归属：固定为养护班组 */
  ownerSide: OwnerSide
  createdAt: string
  updatedAt: string
  revision: number
}

/** 班组重排检查任务时的入参 */
export interface InspectionDraft {
  treeId: string
  kind: InspectionKind
  supportId?: string
  dueDate: string
  cycleMon: number
}
