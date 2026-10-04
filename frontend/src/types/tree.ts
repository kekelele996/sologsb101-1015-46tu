/**
 * 古树（Tree）
 * 一树一档：编号、树种、保护级别、树龄、位置与管护单位。
 *
 * 归属约定（两份档案各管各的，谁也改不到对方那份）：
 * - 班组档案（ownerScope = 'crew'）：树体检查记录、复壮措施、加固件
 * - 保护科档案（ownerScope = 'bureau'）：保护级别、长势复评结论
 * - 古树档案的身份/基础字段两侧均可建、只读引用；保护级别仅保护科可调整。
 */

/** 保护级别：一级 / 二级 / 三级 */
export type ProtectLevel = '一级' | '二级' | '三级'

export const PROTECT_LEVEL_OPTIONS: ProtectLevel[] = ['一级', '二级', '三级']

/**
 * 档案归属方：
 * - crew 养护班组
 * - bureau 古树保护科
 */
export type OwnerScope = 'crew' | 'bureau'

export const OWNER_SCOPE_OPTIONS: OwnerScope[] = ['crew', 'bureau']

/** 归属方中文名 */
export const OWNER_SCOPE_LABEL: Record<OwnerScope, string> = {
  crew: '养护班组',
  bureau: '古树保护科',
}

/** 各保护级别核定的当年复壮施工工日容量（工日 / 株·年） */
export const LEVEL_WORKDAY_QUOTA: Record<ProtectLevel, number> = {
  一级: 60,
  二级: 40,
  三级: 25,
}

/** 常见古树树种候选（可在表单中自由填写其他树种） */
export const TREE_SPECIES_CANDIDATES: string[] = ['国槐', '银杏', '侧柏', '香樟', '皂荚', '圆柏', '油松', '朴树']

export interface Tree {
  id: string
  /** 古树编号，如 京-01-0007 */
  code: string
  /** 树种 */
  species: string
  /** 保护级别（仅保护科可调整） */
  protectLevel: ProtectLevel
  /** 保护级别最近一次调整日期（YYYY-MM-DD），升级迁移回填为 '' */
  protectLevelChangedAt: string
  /** 上一版保护级别；'' 表示建立档案后从未调整 */
  previousProtectLevel: ProtectLevel | ''
  /** 树龄（年） */
  ageYears: number
  /** 位置 */
  location: string
  /** 管护单位 */
  owner: string
  /** 最近一次复壮措施完成日期（措施完成时回写） */
  lastMeasureDate: string
  createdAt: string
  updatedAt: string
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number
}

/** 新建 / 编辑古树档案的表单草稿 */
export interface TreeDraft {
  code: string
  species: string
  protectLevel: ProtectLevel
  ageYears: number
  location: string
  owner: string
}

/** 保护科调整保护级别的表单草稿（只能动级别，动不到基础信息与班组档案） */
export interface ProtectLevelDraft {
  protectLevel: ProtectLevel
  /** 调整生效日期，默认今天 */
  date: string
}
