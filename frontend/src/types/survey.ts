/**
 * 树体检查（Survey）
 * 每次检查记录树高、胸径、冠幅、倾斜度、空洞数与立地状况。
 *
 * 归属：养护班组档案（ownerScope 固定 'crew'），保护科改不到这份。
 */
import type { OwnerScope, ProtectLevel } from './tree'

/** 立地状况：铺装 / 裸土 / 积水 */
export type SiteNote = '铺装' | '裸土' | '积水'

export const SITE_NOTE_OPTIONS: SiteNote[] = ['铺装', '裸土', '积水']

/**
 * 按新保护级别应做的树体检查任务状态：
 * - 待重排：保护级别一调整，原级别下未完成的检查任务立即失效，挑出来等班组重排
 * - 已安排：班组已按当前级别重新排入计划
 */
export type SurveyTaskState = '待重排' | '已安排'

export interface Survey {
  id: string
  /** 所属古树 */
  treeId: string
  /** 检查日期 YYYY-MM-DD */
  date: string
  /** 树高（米） */
  heightM: number
  /** 胸径（厘米） */
  dbhCm: number
  /** 冠幅（米） */
  crownM: number
  /** 倾斜度（度） */
  leanDeg: number
  /** 空洞数（个） */
  hollowCount: number
  /** 立地状况 */
  siteNote: SiteNote
  /** 档案归属方：树体检查记录归养护班组 */
  ownerScope: OwnerScope
  /**
   * 任务状态：该检查是否是「按保护级别应做」的待办。
   * 保护级别一调整，未完成的待办立即失效转为「待重排」，由班组重新安排；
   * 已经做完的检查（isDone = true）照旧留住，不参与失效。
   * '' 表示班组日常补录的普通检查记录（非级别派下的任务）。
   */
  taskState: SurveyTaskState | ''
  /** 排任务时所依据的保护级别；与古树现级别不一致时该任务即失效 */
  taskLevel: ProtectLevel | ''
  /** 已完成的检查永久留档 */
  isDone: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑树体检查的表单草稿 */
export interface SurveyDraft {
  treeId: string
  date: string
  heightM: number
  dbhCm: number
  crownM: number
  leanDeg: number
  hollowCount: number
  siteNote: SiteNote
}
