/**
 * 保护级别核定政策（古树保护科核定，班组按此排工）
 * - 树体检查周期（月）：按新级别该做的树体检查频次
 * - 加固件检查周期（月）：按新级别该做的加固件检查频次
 * - 当年复壮施工工日容量：班组在一年里可排的复壮措施工日上限
 * 规则集中在此处，便于保护科调整核定额而不触碰班组代码。
 */
import type { ProtectLevel } from './tree'
import type { MeasureType } from './measure'

export interface LevelPolicy {
  /** 树体检查周期（月） */
  surveyCycleMon: number
  /** 加固件检查周期（月） */
  supportCheckCycleMon: number
  /** 当年复壮施工核定工日（工日 / 株 / 年） */
  annualWorkdayQuota: number
}

/** 各级别核定标准（保护科定） */
export const LEVEL_POLICY: Record<ProtectLevel, LevelPolicy> = {
  一级: { surveyCycleMon: 3, supportCheckCycleMon: 6, annualWorkdayQuota: 40 },
  二级: { surveyCycleMon: 6, supportCheckCycleMon: 12, annualWorkdayQuota: 24 },
  三级: { surveyCycleMon: 12, supportCheckCycleMon: 24, annualWorkdayQuota: 12 },
}

export function policyOf(level: ProtectLevel): LevelPolicy {
  return LEVEL_POLICY[level]
}

/**
 * 各类复壮措施的核定工日（工日 / 次）。
 * 班组排措施时默认带入，可在台账中按实际施工核定调整。
 */
export const MEASURE_WORKDAYS: Record<MeasureType, number> = {
  换土: 8,
  施肥: 2,
  透气: 4,
  树洞修补: 6,
  病虫害防治: 3,
}

export function defaultWorkdays(type: MeasureType): number {
  return MEASURE_WORKDAYS[type] ?? 1
}
