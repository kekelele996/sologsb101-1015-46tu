/**
 * 档案归属（Ownership）
 * 一树两份档案，分别由两个限界上下文管理，谁也改不到对方那份：
 * - crew  养护班组：树体检查记录、复壮措施、加固件、检查任务
 * - bureau 古树保护科：保护级别、长势复评结论
 * 古树主档（编号 / 树种 / 树龄 / 位置 / 管护单位）为双方共享档案锚点，
 * 其中 protectLevel 字段归保护科，lastMeasureDate 字段由班组回写。
 */

/** 归属方：养护班组 / 古树保护科 */
export type OwnerSide = 'crew' | 'bureau'

export const OWNER_SIDE_OPTIONS: OwnerSide[] = ['crew', 'bureau']

export const OWNER_SIDE_LABEL: Record<OwnerSide, string> = {
  crew: '养护班组',
  bureau: '古树保护科',
}

/** 各实体的法定归属方（实体表名 → 归属） */
export const ENTITY_OWNER: Record<string, OwnerSide> = {
  surveys: 'crew',
  measures: 'crew',
  supports: 'crew',
  inspections: 'crew',
  reviews: 'bureau',
}

/** 违反归属边界时抛出：某一侧试图改写另一侧的档案 */
export class OwnershipError extends Error {
  /** 期望归属 */
  readonly expected: OwnerSide
  /** 实际归属 */
  readonly actual: OwnerSide | undefined

  constructor(table: string, expected: OwnerSide, actual?: OwnerSide) {
    super(
      actual === undefined
        ? `该记录归${OWNER_SIDE_LABEL[expected]}管理，当前操作无权修改（${table}）。`
        : `${OWNER_SIDE_LABEL[expected]}不能修改${OWNER_SIDE_LABEL[actual]}的档案（${table}）。`,
    )
    this.name = 'OwnershipError'
    this.expected = expected
    this.actual = actual
  }
}

/**
 * 校验一条已有记录的归属。
 * 归属字段缺失（未回填）视为非法：升级时应已按现有档案统一回填并启用。
 */
export function assertOwnedBy(table: string, row: { ownerSide?: unknown }, expected: OwnerSide): void {
  if (row.ownerSide !== expected) {
    throw new OwnershipError(table, expected, typeof row.ownerSide === 'string' ? (row.ownerSide as OwnerSide) : undefined)
  }
}
