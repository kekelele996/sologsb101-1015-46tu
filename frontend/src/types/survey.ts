/**
 * 树体检查（Survey）——养护班组档案
 * 每次检查记录树高、胸径、冠幅、倾斜度、空洞数与立地状况。
 * 保护级别一调整，按旧级别排出的检查计划即失效：
 * 已完成的检查记录照旧留住，仅待办检查任务（inspections）失效等班组重排。
 */
import type { OwnerSide } from './ownership'

/** 立地状况：铺装 / 裸土 / 积水 */
export type SiteNote = '铺装' | '裸土' | '积水'

export const SITE_NOTE_OPTIONS: SiteNote[] = ['铺装', '裸土', '积水']

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
  /** 档案归属：固定为养护班组 */
  ownerSide: OwnerSide
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
