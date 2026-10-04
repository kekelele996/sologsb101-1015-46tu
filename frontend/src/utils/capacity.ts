/**
 * 两侧档案的业务核定规则（纯函数，不落库、不碰 Dexie）：
 * - 当年复壮施工工日按保护级别核定，超容量排队等下一批，不挤掉已确认措施
 * - 保护级别调整后，按旧级别安排、尚未完成 / 尚未检查的任务失效，挑出待班组重排
 * - 各保护级别默认的树体检查周期与加固件检查周期（班组按此重排）
 */
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Survey } from '../types/survey'
import type { ProtectLevel, Tree } from '../types/tree'
import { LEVEL_WORKDAY_QUOTA } from '../types/tree'

/** 取某年（YYYY）的年份字符串；日期非法时回退为给定年份 */
export function yearOf(date: string): string {
  const match = /^(\d{4})-/.exec(date)
  return match === null ? '' : match[1]
}

/* --------------------------- 工日容量与排队 --------------------------- */

/** 保护级别对应的当年复壮施工工日容量 */
export function workdayQuota(level: ProtectLevel): number {
  return LEVEL_WORKDAY_QUOTA[level]
}

/** 判断措施是否「已确认」：已完成视同确认；未完成以 queueState 为准 */
export function isMeasureConfirmed(measure: Measure): boolean {
  return measure.state === '已完成' || measure.queueState === '已确认'
}

/** 某株古树某年已占用的核定工日（只统计已确认措施，排队中的不占容量） */
export function usedWorkdays(measures: Measure[], treeId: string, year: string): number {
  return measures
    .filter((row) => row.treeId === treeId && yearOf(row.date) === year && isMeasureConfirmed(row))
    .reduce((sum, row) => sum + (Number.isFinite(row.workdays) ? row.workdays : 0), 0)
}

/** 某株古树某年的剩余可排工日容量 */
export function remainingWorkdays(
  trees: Tree[],
  measures: Measure[],
  treeId: string,
  year: string,
): number {
  const tree = trees.find((item) => item.id === treeId)
  if (tree === undefined) return 0
  return Math.max(0, workdayQuota(tree.protectLevel) - usedWorkdays(measures, treeId, year))
}

export interface WorkdayDecision {
  /** 写入措施的排队状态 */
  queueState: Measure['queueState']
  /** 剩余容量（尝试排入后） */
  remaining: number
  /** 是否因超容量被排进下一批 */
  queued: boolean
  message: string
}

/**
 * 核定一条待提交的措施（排除自身 id 后计算容量）。
 * 容量不足时排队等下一批，绝不动已确认的措施。
 */
export function decideMeasureQueue(params: {
  tree: Tree
  measures: Measure[]
  date: string
  workdays: number
  /** 编辑场景下需要排除的自身措施 id */
  selfId?: string
}): WorkdayDecision {
  const { tree, measures, date, workdays, selfId } = params
  const year = yearOf(date)
  const others = measures.filter((row) => row.id !== selfId)
  const used = usedWorkdays(others, tree.id, year)
  const quota = workdayQuota(tree.protectLevel)
  if (used + workdays <= quota) {
    return {
      queueState: '已确认',
      remaining: quota - used - workdays,
      queued: false,
      message: `已确认排入 ${year} 年批次，核定容量 ${quota} 工日，剩余 ${quota - used - workdays} 工日。`,
    }
  }
  return {
    queueState: '排队中',
    remaining: Math.max(0, quota - used),
    queued: true,
    message: `${year} 年 ${tree.protectLevel} 容量 ${quota} 工日，已确认 ${used} 工日，本措施 ${workdays} 工日排不下，已排队等下一批，不挤掉已确认措施。`,
  }
}

/* --------------------- 级别调整 → 任务失效 / 重排 --------------------- */

/**
 * 树体检查任务是否因保护级别调整而失效：
 * 必须是按级别派出、尚未完成的检查任务，且派出时的级别与现行级别不一致。
 * 已做完的检查（isDone）照旧留住。
 */
export function isSurveyTaskStale(survey: Survey, tree: Tree): boolean {
  if (survey.isDone) return false
  if (survey.taskState === '' || survey.taskLevel === '') return false
  return survey.taskLevel !== tree.protectLevel
}

/**
 * 加固件检查任务是否因保护级别调整而失效：
 * 按旧级别安排（taskLevel 与现行级别不一致），且最近一次检查发生在级别调整之前
 * （或从未检查）。级别调整之后已完成检查的照旧留住。
 */
export function isSupportTaskStale(support: Support, tree: Tree): boolean {
  if (support.taskState === '' || support.taskLevel === '') return false
  if (support.taskLevel === tree.protectLevel) return false
  return !support.checkedAfterLevelChange
}

/** 挑出一株古树所有失效待重排的树体检查任务 */
export function pickStaleSurveys(surveys: Survey[], tree: Tree): Survey[] {
  return surveys.filter((row) => row.treeId === tree.id && isSurveyTaskStale(row, tree))
}

/** 挑出一株古树所有失效待重排的加固件检查任务 */
export function pickStaleSupports(supports: Support[], tree: Tree): Support[] {
  return supports.filter((row) => row.treeId === tree.id && isSupportTaskStale(row, tree))
}

/** 各保护级别默认的树体检查周期（月），班组重排时带入 */
export const LEVEL_SURVEY_CYCLE_MON: Record<ProtectLevel, number> = {
  一级: 3,
  二级: 6,
  三级: 12,
}

/** 各保护级别默认的加固件检查周期（月），班组重排时带入 */
export const LEVEL_SUPPORT_CHECK_CYCLE_MON: Record<ProtectLevel, number> = {
  一级: 6,
  二级: 12,
  三级: 24,
}
