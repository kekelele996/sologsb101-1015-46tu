/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree，结构版本 v3
 * - v1 → v2：补齐索引与回写字段
 * - v2 → v3：一树两份档案拆分归属（ownerSide）、新增 inspections 检查任务表、
 *   措施工日与容量字段、加固件 basisLevel、古树 levelChangedDate；
 *   历史数据没有归属，升级时按现有档案统一回填后再启用。
 *
 * 限界上下文（两份档案各自独立事务，任一侧提交失败只回滚自己那份）：
 * - 养护班组（crew）：surveys / measures / supports / inspections
 * - 古树保护科（bureau）：trees.protectLevel / reviews
 * 古树主档为共享锚点：保护科在 bureau 事务内调整 protectLevel，
 * 班组在 crew 事务内回写 lastMeasureDate，互不交叉。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree, ProtectLevel } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review, ReviewDraft } from '../types/review'
import type { Inspection, InspectionDraft, InspectionKind } from '../types/inspection'
import { ENTITY_OWNER, OwnerSide, assertOwnedBy } from '../types/ownership'
import { defaultWorkdays, policyOf } from '../types/policy'
import { nowIso, today, uuid } from './id'
import { addMonths } from './dimension'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** 占用当年工日容量的措施状态（排队待批不占容量） */
const CAPACITY_ACTIVE_STATES: MeasureState[] = ['计划', '实施中', '已完成']
/** 已确认、不可被新措施挤掉的措施状态 */
const CONFIRMED_STATES: MeasureState[] = ['实施中', '已完成']

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  inspections!: Table<Inspection, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：两份档案拆归属 + 检查任务表 + 工日容量 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, levelChangedDate, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote, ownerSide',
        measures: 'id, treeId, type, state, date, operator, ownerSide, [treeId+planYear]',
        supports: 'id, treeId, type, installDate, lastCheckDate, ownerSide, basisLevel',
        reviews: 'id, treeId, date, vigor, trend, ownerSide',
        // 班组按保护级别排出的检查任务（树体检查 / 加固件检查）
        inspections: 'id, treeId, kind, status, dueDate, supportId, voided, ownerSide, [treeId+kind]',
      })
      .upgrade(async (tx) => {
        // 迁移 1：历史数据未记归属——按现有档案统一回填归属与修订号后再启用
        for (const [tableName, side] of Object.entries(ENTITY_OWNER)) {
          if (tableName === 'inspections') continue
          await tx.table(tableName).toCollection().modify((row: Record<string, unknown>) => {
            row.ownerSide = side
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }

        // 迁移 2：古树补齐「级别调整日期」
        const treeRows = await tx.table('trees').toArray() as Tree[]
        const levelOfTree = new Map<string, ProtectLevel>(treeRows.map((row) => [row.id, row.protectLevel]))
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.levelChangedDate !== 'string') row.levelChangedDate = ''
        })

        // 迁移 3：措施补齐工日 / 核定年度 / 排队字段
        await tx.table('measures').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.workdays !== 'number') row.workdays = defaultWorkdays(row.type as Measure['type'])
          const year = typeof row.date === 'string' && /^\d{4}/.test(row.date) ? Number(row.date.slice(0, 4)) : new Date().getFullYear()
          if (typeof row.planYear !== 'number') row.planYear = year
          if (typeof row.queueOrder !== 'number') row.queueOrder = 0
          if (typeof row.queueReason !== 'string') row.queueReason = ''
        })

        // 迁移 4：加固件补齐「检查周期所依据的保护级别」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.basisLevel !== 'string') {
            row.basisLevel = levelOfTree.get(row.treeId as string) ?? '二级'
          }
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })

        // 迁移 5：按现有加固件与最近一次树体检查，回填待办检查任务（做完的历史不回填）
        const stamp = nowIso()
        const inspectionRows: Inspection[] = []
        const supportRows = await tx.table('supports').toArray() as Support[]
        for (const support of supportRows) {
          const base = support.lastCheckDate || support.installDate || today()
          inspectionRows.push({
            id: uuid('insp-upg-support'),
            treeId: support.treeId,
            kind: 'support',
            supportId: support.id,
            dueDate: addMonths(base, support.checkCycleMon),
            basisLevel: support.basisLevel,
            cycleMon: support.checkCycleMon,
            status: '待检查',
            voided: false,
            voidReason: '',
            checkedAt: '',
            recordId: '',
            ownerSide: 'crew',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          })
        }
        const surveyRows = await tx.table('surveys').toArray() as Survey[]
        const latestSurveyByTree = new Map<string, Survey>()
        for (const survey of surveyRows.sort((a, b) => a.date.localeCompare(b.date))) {
          latestSurveyByTree.set(survey.treeId, survey)
        }
        latestSurveyByTree.forEach((survey, treeId) => {
          const level = levelOfTree.get(treeId)
          if (!level) return
          const cycle = policyOf(level).surveyCycleMon
          inspectionRows.push({
            id: uuid('insp-upg-survey'),
            treeId,
            kind: 'survey',
            supportId: '',
            dueDate: addMonths(survey.date, cycle),
            basisLevel: level,
            cycleMon: cycle,
            status: '待检查',
            voided: false,
            voidReason: '',
            checkedAt: '',
            recordId: '',
            ownerSide: 'crew',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          })
        })
        if (inspectionRows.length > 0) {
          await tx.table('inspections').bulkPut(inspectionRows)
        }
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树（共享锚点） -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

/** 新建古树档案（共享锚点），保护级别由建档时一并登记，视同保护科初始核定 */
export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 编辑古树共享基础信息（不含保护级别）。
 * 保护级别只能走保护科的「级别调整」事务，本函数即使传入新级别也会被忽略。
 */
export async function updateTreeBase(id: string, patch: Partial<Tree>): Promise<void> {
  const existing = await db.trees.get(id)
  if (!existing) return
  await db.trees.update(id, {
    code: patch.code ?? existing.code,
    species: patch.species ?? existing.species,
    ageYears: patch.ageYears ?? existing.ageYears,
    location: patch.location ?? existing.location,
    owner: patch.owner ?? existing.owner,
    updatedAt: nowIso(),
  })
}

/** 删除古树档案锚点并级联清理双方记录（系统级清理，跨两张档案） */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.inspections],
    async () => {
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      await db.supports.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()
      await db.inspections.where('treeId').equals(id).delete()
      await db.trees.delete(id)
    },
  )
}

/* ----------------------- 古树保护科（bureau）：级别调整 + 复评 ----------------------- */

export interface BureauAdjustmentResult {
  /** 级别是否真的发生变化（未变化时不触发检查失效） */
  changed: boolean
  oldLevel: ProtectLevel
  newLevel: ProtectLevel
  /** 同事务内登记的复评记录 id（未带复评为 null） */
  reviewId: string | null
}

/**
 * 保护科提交：调整保护级别（可同时登记本次长势复评结论）。
 * 只写保护科自己那份（trees.protectLevel + reviews），与班组档案完全分库事务，
 * 班组侧随后失败不会回滚级别调整；本函数失败也不会动班组任何记录。
 */
export async function submitBureauAdjustment(
  treeId: string,
  nextLevel: ProtectLevel,
  changedDate: string,
  review: ReviewDraft | null,
): Promise<BureauAdjustmentResult> {
  return db.transaction('rw', db.trees, db.reviews, async () => {
    const tree = await db.trees.get(treeId)
    if (!tree) throw new Error('古树档案不存在，无法调整保护级别')
    const oldLevel = tree.protectLevel
    const changed = oldLevel !== nextLevel
    if (changed) {
      await db.trees.update(treeId, {
        protectLevel: nextLevel,
        levelChangedDate: changedDate,
        updatedAt: nowIso(),
      })
    }
    let reviewId: string | null = null
    if (review !== null) {
      const stamp = nowIso()
      const row: Review = {
        id: uuid('review'),
        treeId,
        date: review.date,
        vigor: review.vigor,
        trend: review.trend,
        conclusion: review.conclusion.trim(),
        followUp: review.followUp.trim(),
        ownerSide: 'bureau',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      await db.reviews.put(row)
      reviewId = row.id
    }
    return { changed, oldLevel, newLevel: nextLevel, reviewId }
  })
}

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 保护科写复评：强制盖 bureau 章，班组事务改不到这一份 */
export async function putReview(row: Review): Promise<void> {
  if (row.ownerSide !== undefined) assertOwnedBy('reviews', row, 'bureau')
  await db.reviews.put({ ...row, ownerSide: 'bureau', updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  const existing = await db.reviews.get(id)
  if (existing) assertOwnedBy('reviews', existing, 'bureau')
  await db.reviews.delete(id)
}

/* ------------------------------ 养护班组（crew） ------------------------------ */

/* ---------- 树体检查 ---------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 班组写树体检查：强制盖 crew 章；提交失败只回滚班组自己的表 */
export async function putSurvey(row: Survey): Promise<void> {
  if (row.ownerSide !== undefined) assertOwnedBy('surveys', row, 'crew')
  await db.transaction('rw', db.surveys, db.inspections, async () => {
    const stamp = nowIso()
    await db.surveys.put({ ...row, ownerSide: 'crew', updatedAt: stamp, revision: ROW_REVISION })
    // 顺手把到期（或超期）的待办树体检查任务收口为已完成——做完的照旧留住
    const pending = await db.inspections
      .where('[treeId+kind]').equals([row.treeId, 'survey' as InspectionKind])
      .filter((task) => task.status === '待检查' && !task.voided && task.dueDate <= row.date)
      .toArray()
    const task = pending.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
    if (task) {
      await db.inspections.update(task.id, {
        status: '已完成',
        checkedAt: row.date,
        recordId: row.id,
        updatedAt: stamp,
      })
    }
  })
}

export async function removeSurvey(id: string): Promise<void> {
  const existing = await db.surveys.get(id)
  if (existing) assertOwnedBy('surveys', existing, 'crew')
  await db.surveys.delete(id)
}

/* ---------- 加固件 ---------- */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

/** 班组登记 / 编辑加固件：检查周期默认按当前保护级别核定并记录依据级别 */
export async function putSupport(row: Support): Promise<void> {
  if (row.ownerSide !== undefined) assertOwnedBy('supports', row, 'crew')
  let basisLevel: ProtectLevel = row.basisLevel as ProtectLevel
  let cycleMon = row.checkCycleMon
  if (!row.basisLevel) {
    const tree = await db.trees.get(row.treeId)
    basisLevel = tree?.protectLevel ?? '二级'
    cycleMon = policyOf(basisLevel).supportCheckCycleMon
  }
  await db.supports.put({
    ...row,
    ownerSide: 'crew',
    basisLevel,
    checkCycleMon: cycleMon,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
}

export async function removeSupport(id: string): Promise<void> {
  const existing = await db.supports.get(id)
  if (existing) assertOwnedBy('supports', existing, 'crew')
  await db.transaction('rw', db.supports, db.inspections, async () => {
    await db.inspections.where('supportId').equals(id).delete()
    await db.supports.delete(id)
  })
}

/** 登记本次检查：最近检查日期置为给定日期，并把对应待办加固件检查收口（crew 事务） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.transaction('rw', db.supports, db.inspections, async () => {
    const existing = await db.supports.get(id)
    if (!existing) return
    assertOwnedBy('supports', existing, 'crew')
    const stamp = nowIso()
    await db.supports.update(id, { lastCheckDate: date, updatedAt: stamp })
    const pending = await db.inspections
      .where('supportId').equals(id)
      .filter((task) => task.status === '待检查' && !task.voided)
      .toArray()
    const task = pending.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
    if (task) {
      await db.inspections.update(task.id, {
        status: '已完成',
        checkedAt: date,
        recordId: id,
        updatedAt: stamp,
      })
    }
  })
}

/* ---------- 检查任务（级别调整失效 / 班组重排） ---------- */

export async function listInspections(): Promise<Inspection[]> {
  return db.inspections.toArray()
}

export interface InvalidationResult {
  surveyTasks: number
  supportTasks: number
}

/**
 * 保护级别调整后，在班组档案侧把按旧级别排出的待办检查挑出来作废：
 * - 待检查任务依据级别与新级别不一致 → 置「已失效」，等班组按新级别重排；
 * - 已完成任务不动（做完的照旧留住）。
 * 幂等：保护科事务已提交但本函数失败时，可随时对同一古树重跑。
 */
export async function syncChecksAfterLevelChange(treeId: string): Promise<InvalidationResult> {
  return db.transaction('rw', db.trees, db.supports, db.inspections, async () => {
    const tree = await db.trees.get(treeId)
    if (!tree) throw new Error('古树档案不存在')
    const stamp = nowIso()
    let surveyTasks = 0
    let supportTasks = 0
    const tasks = await db.inspections.where('treeId').equals(treeId).toArray()
    for (const task of tasks) {
      if (task.status !== '待检查' || task.voided) continue
      let stale = task.basisLevel !== tree.protectLevel
      if (task.kind === 'support' && task.supportId) {
        const support = await db.supports.get(task.supportId)
        if (support) stale = support.basisLevel !== tree.protectLevel
      }
      if (!stale) continue
      const reason = `保护级别已由${task.basisLevel}调整为${tree.protectLevel}，按旧级别排出的检查作废，待按新级别重排`
      await db.inspections.update(task.id, {
        voided: true,
        status: '已失效',
        voidReason: reason,
        updatedAt: stamp,
      })
      if (task.kind === 'survey') surveyTasks += 1
      else supportTasks += 1
    }
    return { surveyTasks, supportTasks }
  })
}

/** 班组按新级别重排加固件检查：更新核定周期与依据级别，并生成新的待办任务 */
export async function rescheduleSupportCheck(supportId: string): Promise<Inspection> {
  return db.transaction('rw', db.trees, db.supports, db.inspections, async () => {
    const support = await db.supports.get(supportId)
    if (!support) throw new Error('加固件不存在')
    assertOwnedBy('supports', support, 'crew')
    const tree = await db.trees.get(support.treeId)
    if (!tree) throw new Error('古树档案不存在')
    const stamp = nowIso()
    const cycleMon = policyOf(tree.protectLevel).supportCheckCycleMon
    const dueDate = addMonths(support.lastCheckDate || today(), cycleMon)
    await db.supports.update(supportId, {
      checkCycleMon: cycleMon,
      basisLevel: tree.protectLevel,
      updatedAt: stamp,
    })
    return putPendingInspection({
      treeId: support.treeId,
      kind: 'support',
      supportId,
      dueDate,
      cycleMon,
      basisLevel: tree.protectLevel,
      stamp,
    })
  })
}

/** 班组按新级别重排树体检查：从最近一次检查日期（无则今天）起按新周期排下一程 */
export async function rescheduleSurveyCheck(treeId: string): Promise<Inspection> {
  return db.transaction('rw', db.trees, db.surveys, db.inspections, async () => {
    const tree = await db.trees.get(treeId)
    if (!tree) throw new Error('古树档案不存在')
    const stamp = nowIso()
    const cycleMon = policyOf(tree.protectLevel).surveyCycleMon
    const surveys = await db.surveys.where('treeId').equals(treeId).toArray()
    const latest = surveys.sort((a, b) => b.date.localeCompare(a.date))[0]
    const baseDate = latest?.date ?? today()
    const dueDate = addMonths(baseDate, cycleMon)
    return putPendingInspection({
      treeId,
      kind: 'survey',
      supportId: '',
      dueDate,
      cycleMon,
      basisLevel: tree.protectLevel,
      stamp,
    })
  })
}

interface PendingInspectionInput extends InspectionDraft {
  basisLevel: ProtectLevel
  stamp: string
}

async function putPendingInspection(input: PendingInspectionInput): Promise<Inspection> {
  // 已有同种类、同依据级别、同到期日的待办任务时不重复排
  const duplicated = await db.inspections
    .where('[treeId+kind]').equals([input.treeId, input.kind])
    .filter(
      (task) =>
        task.status === '待检查' &&
        !task.voided &&
        task.basisLevel === input.basisLevel &&
        task.dueDate === input.dueDate &&
        (input.kind === 'survey' || task.supportId === input.supportId),
    )
    .first()
  if (duplicated) return duplicated
  const row: Inspection = {
    id: uuid('insp'),
    treeId: input.treeId,
    kind: input.kind,
    supportId: input.supportId ?? '',
    dueDate: input.dueDate,
    basisLevel: input.basisLevel,
    cycleMon: input.cycleMon,
    status: '待检查',
    voided: false,
    voidReason: '',
    checkedAt: '',
    recordId: '',
    ownerSide: 'crew',
    createdAt: input.stamp,
    updatedAt: input.stamp,
    revision: ROW_REVISION,
  }
  await db.inspections.put(row)
  return row
}

/* ---------- 复壮措施（工日容量 + 排队） ---------- */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export interface CapacityInfo {
  year: number
  /** 当年按保护级别核定的工日容量 */
  quota: number
  /** 已排入当年批次的工日（计划 / 实施中 / 已完成） */
  used: number
  /** 其中已确认（实施中 / 已完成）的工日 */
  confirmed: number
  /** 剩余可排工日 */
  remaining: number
  /** 排队等下一批的工日 */
  queued: number
  /** 排队条数 */
  queuedCount: number
}

/** 某株古树某年度的复壮工日容量（按当前保护级别核定） */
export async function capacityOf(treeId: string, year: number): Promise<CapacityInfo> {
  const [tree, rows] = await Promise.all([
    db.trees.get(treeId),
    db.measures.where('treeId').equals(treeId).toArray(),
  ])
  const yearly = rows.filter((row) => row.planYear === year)
  const used = yearly
    .filter((row) => CAPACITY_ACTIVE_STATES.includes(row.state))
    .reduce((sum, row) => sum + row.workdays, 0)
  const confirmed = yearly
    .filter((row) => CONFIRMED_STATES.includes(row.state))
    .reduce((sum, row) => sum + row.workdays, 0)
  const queuedRows = yearly.filter((row) => row.state === '排队待批')
  const quota = tree ? policyOf(tree.protectLevel).annualWorkdayQuota : 0
  return {
    year,
    quota,
    used,
    confirmed,
    remaining: Math.max(0, quota - used),
    queued: queuedRows.reduce((sum, row) => sum + row.workdays, 0),
    queuedCount: queuedRows.length,
  }
}

function yearOf(date: string): number {
  return /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : new Date().getFullYear()
}

/**
 * 班组写复壮措施（crew 事务）：
 * - 盖 crew 章；状态「已完成」时回写古树最近复壮日期；
 * - 仅当「计划」新措施超出当年按级别核定的工日容量时自动改为「排队待批」，
 *   已确认（实施中 / 已完成）的措施一律保留，不被挤掉。
 */
export async function putMeasure(row: Measure): Promise<void> {
  if (row.ownerSide !== undefined) assertOwnedBy('measures', row, 'crew')
  await db.transaction('rw', db.trees, db.measures, async () => {
    const stamp = nowIso()
    const workdays = row.workdays > 0 ? row.workdays : defaultWorkdays(row.type)
    const planYear = row.planYear || yearOf(row.date)
    let state = row.state
    let queueOrder = row.queueOrder ?? 0
    let queueReason = row.queueReason ?? ''

    if (state === '计划') {
      const tree = await db.trees.get(row.treeId)
      const quota = tree ? policyOf(tree.protectLevel).annualWorkdayQuota : 0
      const others = await db.measures
        .where('treeId').equals(row.treeId)
        .filter((item) => item.id !== row.id && item.planYear === planYear && CAPACITY_ACTIVE_STATES.includes(item.state))
        .toArray()
      const used = others.reduce((sum, item) => sum + item.workdays, 0)
      if (quota > 0 && used + workdays > quota) {
        state = '排队待批'
        const queued = await db.measures
          .where('treeId').equals(row.treeId)
          .filter((item) => item.planYear === planYear && item.state === '排队待批')
          .toArray()
        queueOrder = queued.reduce((max, item) => Math.max(max, item.queueOrder), 0) + 1
        queueReason = `${planYear} 年度核定工日 ${quota}，已排 ${used}，本措施 ${workdays} 工日超出容量，排队等下一批`
      }
    }

    await db.measures.put({
      ...row,
      ownerSide: 'crew',
      workdays,
      planYear,
      state,
      queueOrder,
      queueReason,
      updatedAt: stamp,
      revision: ROW_REVISION,
    })

    if (state === '已完成') {
      const tree = await db.trees.get(row.treeId)
      if (tree && tree.lastMeasureDate < row.date) {
        await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: stamp })
      }
    }
  })
}

export async function removeMeasure(id: string): Promise<void> {
  const existing = await db.measures.get(id)
  if (existing) assertOwnedBy('measures', existing, 'crew')
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/**
 * 让排队措施按 queueOrder 依次尝试排入当年批次（容量空出多少进多少）。
 * 不挤掉任何已确认 / 已排入的措施。返回成功排入条数。
 */
export async function promoteQueuedMeasures(treeId?: string, year?: number): Promise<number> {
  const targetYear = year ?? new Date().getFullYear()
  const queued = (await db.measures
    .where('state').equals('排队待批')
    .filter((row) => (treeId ? row.treeId === treeId : true) && row.planYear === targetYear)
    .toArray())
    .sort((a, b) => a.queueOrder - b.queueOrder || a.date.localeCompare(b.date))
  let promoted = 0
  for (const row of queued) {
    const capacity = await capacityOf(row.treeId, targetYear)
    if (row.workdays > capacity.remaining) continue
    await putMeasure({ ...row, state: '计划', queueOrder: 0, queueReason: '' })
    promoted += 1
  }
  return promoted
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  inspections: Inspection[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, inspections] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.inspections.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    inspections,
  }
}

/** 用快照覆盖整库（导入存档）；无归属的旧存档按现有档案回填归属后再启用 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.inspections],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.inspections.clear(),
      ])
      await db.trees.bulkPut(
        snapshot.trees.map((row) => ({
          ...row,
          levelChangedDate: row.levelChangedDate ?? '',
          revision: ROW_REVISION,
        })),
      )
      await db.surveys.bulkPut(snapshot.surveys.map(stampOwner('surveys')))
      await db.measures.bulkPut(
        snapshot.measures.map((row) => ({
          ...row,
          ownerSide: 'crew' as OwnerSide,
          workdays: row.workdays ?? defaultWorkdays(row.type),
          planYear: row.planYear ?? yearOf(row.date),
          queueOrder: row.queueOrder ?? 0,
          queueReason: row.queueReason ?? '',
          revision: ROW_REVISION,
        })),
      )
      await db.supports.bulkPut(
        snapshot.supports.map((row) => ({
          ...row,
          ownerSide: 'crew' as OwnerSide,
          basisLevel: row.basisLevel ?? '',
          revision: ROW_REVISION,
        })),
      )
      await db.reviews.bulkPut(snapshot.reviews.map(stampOwner('reviews')))
      const inspections = snapshot.inspections ?? []
      if (inspections.length > 0) {
        await db.inspections.bulkPut(inspections.map(stampOwner('inspections')))
      }
    },
  )
}

function stampOwner<T extends { ownerSide?: OwnerSide }>(table: keyof typeof ENTITY_OWNER) {
  return (row: T): T => ({ ...row, ownerSide: ENTITY_OWNER[table], revision: ROW_REVISION })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.inspections],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.inspections.clear(),
      ])
    },
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, inspections] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.inspections.count(),
  ])
  return { trees, surveys, measures, supports, reviews, inspections }
}
