/**
 * 古树（Tree）——一树一档的共享档案锚点
 * 编号、树种、树龄、位置、管护单位为双方共享信息；
 * protectLevel 保护级别归古树保护科维护；
 * lastMeasureDate 最近复壮日期由养护班组在措施完成时回写。
 */

/** 保护级别：一级 / 二级 / 三级 */
export type ProtectLevel = '一级' | '二级' | '三级'

export const PROTECT_LEVEL_OPTIONS: ProtectLevel[] = ['一级', '二级', '三级']

/** 常见古树树种候选（可在表单中自由填写其他树种） */
export const TREE_SPECIES_CANDIDATES: string[] = ['国槐', '银杏', '侧柏', '香樟', '皂荚', '圆柏', '油松', '朴树']

export interface Tree {
  id: string
  /** 古树编号，如 京-01-0007 */
  code: string
  /** 树种 */
  species: string
  /** 保护级别（归古树保护科维护） */
  protectLevel: ProtectLevel
  /** 保护级别最后调整日期（保护科填写，用于让按旧级别排出的检查失效） */
  levelChangedDate: string
  /** 树龄（年） */
  ageYears: number
  /** 位置 */
  location: string
  /** 管护单位 */
  owner: string
  /** 最近一次复壮措施完成日期（养护班组措施完成时回写） */
  lastMeasureDate: string
  createdAt: string
  updatedAt: string
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number
}

/** 新建古树档案的表单草稿（共享基础信息） */
export interface TreeDraft {
  code: string
  species: string
  protectLevel: ProtectLevel
  ageYears: number
  location: string
  owner: string
}
