/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3：两份档案分家 —— 班组（crew）管树体检查 / 复壮措施 / 加固件，
 *   保护科（bureau）管保护级别 / 长势复评结论；写入时强制归属，谁也改不到对方那份。
 * - 两侧各自独立事务：任一侧提交失败只回滚自己那张表，对方已落库的数据不受影响。
 * - 保护级别调整只写 trees 表，绝不连带改班组表；班组任务是否失效由 utils/capacity.ts 派生，
 *   班组重排后才落回班组自己的表。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import { nowIso, today, uuid } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>

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

    // ---------- v3：两份档案分家，回填归属与级别任务字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        // queueState：快速挑出排队等下一批的措施
        measures: 'id, treeId, type, state, date, operator, queueState',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 古树：补齐保护级别调整痕迹（历史档案视为从未调整）
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.protectLevelChangedAt !== 'string') row.protectLevelChangedAt = ''
          if (typeof row.previousProtectLevel !== 'string') row.previousProtectLevel = ''
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })
        // 树体检查：全部归养护班组；存量记录都是已完成的检查，照旧留住
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          row.ownerScope = 'crew'
          if (typeof row.taskState !== 'string') row.taskState = ''
          if (typeof row.taskLevel !== 'string') row.taskLevel = ''
          if (typeof row.isDone !== 'boolean') row.isDone = true
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })
        // 复壮措施：全部归养护班组，按类型回填工日，存量措施保留已确认名额
        await tx.table('measures').toCollection().modify((row: Record<string, unknown>) => {
          row.ownerScope = 'crew'
          if (typeof row.workdays !== 'number' || !Number.isFinite(row.workdays)) {
            row.workdays = defaultWorkdaysByType(row.type)
          }
          if (row.queueState !== '已确认' && row.queueState !== '排队中') row.queueState = '已确认'
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })
        // 加固件：全部归养护班组；存量为日常登记（taskState 为空），不参与级别失效
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          row.ownerScope = 'crew'
          if (typeof row.taskState !== 'string') row.taskState = ''
          if (typeof row.taskLevel !== 'string') row.taskLevel = ''
          if (typeof row.checkedAfterLevelChange !== 'boolean') row.checkedAfterLevelChange = false
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })
        // 长势复评：全部归古树保护科
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          row.ownerScope = 'bureau'
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })
      })
  }
}

/** 历史措施缺工日时按类型给默认值（与 MEASURE_TYPE_DEFAULT_WORKDAYS 保持一致） */
function defaultWorkdaysByType(type: unknown): number {
  switch (type) {
    case '换土':
      return 12
    case '施肥':
      return 4
    case '透气':
      return 6
    case '树洞修补':
      return 8
    case '病虫害防治':
      return 3
    default:
      return 6
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

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 保护科调整保护级别 —— 只写保护科自己那份（trees 表），
 * 不碰班组的 surveys / measures / supports：班组事务失败与否都与本次无关，
 * 反之保护科提交失败也只回滚 trees 这一处。
 * 级别调整后按新级别该做而未做的检查是否失效，由班组侧派生挑出。
 */
export async function adjustProtectLevel(
  treeId: string,
  nextLevel: Tree['protectLevel'],
  date = today()
): Promise<Tree> {
  return db.transaction('rw', db.trees, async () => {
    const tree = await db.trees.get(treeId)
    if (!tree) throw new Error('古树档案不存在，保护级别未调整')
    if (tree.protectLevel === nextLevel) {
      throw new Error(`保护级别本来就是「${nextLevel}」，无需调整`)
    }
    const updated: Tree = {
      ...tree,
      previousProtectLevel: tree.protectLevel,
      protectLevel: nextLevel,
      protectLevelChangedAt: date,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    }
    await db.trees.put(updated)
    return updated
  })
}

/** 删除古树并级联清理其检查、措施、加固与复评记录（整档删除的系统级操作） */
export async function removeTree(id: string): Promise<void> {
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await db.surveys.where('treeId').equals(id).delete()
    await db.measures.where('treeId').equals(id).delete()
    await db.supports.where('treeId').equals(id).delete()
    await db.reviews.where('treeId').equals(id).delete()
    await db.trees.delete(id)
  })
}

/* ------------------------------ 树体检查（养护班组） ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 写入树体检查。独立事务，只动班组自己的 surveys 表：
 * 提交失败只回滚这一条，保护科的 trees / reviews 不受影响。
 */
export async function putSurvey(row: Survey): Promise<void> {
  await db.transaction('rw', db.surveys, async () => {
    // 强制归属：树体检查只能进班组档案，调用方改不了 ownerScope
    await db.surveys.put({ ...row, ownerScope: 'crew', updatedAt: nowIso(), revision: ROW_REVISION })
  })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/**
 * 班组按当前保护级别派出一次「应做」的树体检查任务（尚未完成）。
 * 级别再调整时，这类未完成任务会被派生判定失效、挑出待重排。
 */
export async function createScheduledSurveyTask(input: {
  treeId: string
  taskLevel: Survey['taskLevel']
  date: string
}): Promise<Survey> {
  const stamp = nowIso()
  const row: Survey = {
    id: uuid('survey-task'),
    treeId: input.treeId,
    date: input.date,
    heightM: 0,
    dbhCm: 0,
    crownM: 0,
    leanDeg: 0,
    hollowCount: 0,
    siteNote: '裸土',
    ownerScope: 'crew',
    taskState: '已安排',
    taskLevel: input.taskLevel,
    isDone: false,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }
  await db.surveys.put(row)
  return row
}

/** 班组重排：把失效的检查任务改挂到新保护级别（批量，各自只写 surveys 表） */
export async function requeueSurveyTasks(ids: string[], newLevel: Survey['taskLevel']): Promise<number> {
  if (ids.length === 0) return 0
  return db.transaction('rw', db.surveys, async () => {
    const rows = await db.surveys.bulkGet(ids)
    const list = rows.filter((row): row is Survey => row !== undefined)
    for (const row of list) {
      await db.surveys.update(row.id, {
        taskState: '已安排',
        taskLevel: newLevel,
        updatedAt: nowIso(),
      })
    }
    return list.length
  })
}

/* ------------------------------ 复壮措施（养护班组） ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。独立事务，只动班组自己的 measures 表：
 * 不再跨表回写 trees.lastMeasureDate（最近复壮日期改为读取侧按已完成措施派生），
 * 因此班组提交失败绝不会影响古树档案 / 保护科那份。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.measures, async () => {
    await db.measures.put({ ...row, ownerScope: 'crew', updatedAt: nowIso(), revision: ROW_REVISION })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；逐条走班组独立事务，任一条失败只回滚那一条 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    // 已完成的措施不可能再退回排队
    const queueState: Measure['queueState'] = state === '已完成' ? '已确认' : row.queueState
    await putMeasure({ ...row, state, queueState })
  }
  return list.length
}

/** 把排队中的措施按序确认进下一批（容量已由调用方核定），只动 measures 表 */
export async function confirmQueuedMeasures(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  return db.transaction('rw', db.measures, async () => {
    const rows = await db.measures.bulkGet(ids)
    const list = rows.filter((row): row is Measure => row !== undefined && row.queueState === '排队中')
    for (const row of list) {
      await db.measures.update(row.id, { queueState: '已确认', updatedAt: nowIso() })
    }
    return list.length
  })
}

/* ------------------------------ 加固件（养护班组） ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

/** 写入加固件。独立事务，只动班组自己的 supports 表，并强制归属。 */
export async function putSupport(row: Support): Promise<void> {
  await db.transaction('rw', db.supports, async () => {
    await db.supports.put({ ...row, ownerScope: 'crew', updatedAt: nowIso(), revision: ROW_REVISION })
  })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/**
 * 登记本次检查：把最近检查日期置为给定日期（默认今天）。
 * 这代表班组已按现行级别实地检查，checkedAfterLevelChange 置真，
 * 之后即使 taskLevel 仍是旧级别也不再判失效（做完的照旧留住）。
 */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, {
    lastCheckDate: date,
    checkedAfterLevelChange: true,
    updatedAt: nowIso(),
  })
}

/**
 * 班组重排失效的加固件检查：改挂新保护级别、重置检查周期。
 * 只表示重新安排，尚未实地检查（checkedAfterLevelChange 保持 false），
 * 超期高亮仍在，直到班组「登记本次检查」。
 */
export async function requeueSupportTask(
  id: string,
  newLevel: Support['taskLevel'],
  checkCycleMon: number
): Promise<void> {
  await db.supports.update(id, {
    taskState: '已安排',
    taskLevel: newLevel,
    checkCycleMon,
    updatedAt: nowIso(),
  })
}

/* ------------------------------ 长势复评（古树保护科） ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 写入长势复评。独立事务，只动保护科自己的 reviews 表：
 * 班组提交失败不影响复评结论，复评提交失败也不碰班组数据。
 */
export async function putReview(row: Review): Promise<void> {
  await db.transaction('rw', db.reviews, async () => {
    // 强制归属：复评结论只能进保护科档案，调用方改不了 ownerScope
    await db.reviews.put({ ...row, ownerScope: 'bureau', updatedAt: nowIso(), revision: ROW_REVISION })
  })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 旧存档归一化 ---------------------------- */

/** 把旧版本（无归属 / 无工日 / 无任务字段）的行补齐为当前结构 */
function normalizeTree(row: Tree): Tree {
  return {
    ...row,
    protectLevelChangedAt: typeof row.protectLevelChangedAt === 'string' ? row.protectLevelChangedAt : '',
    previousProtectLevel:
      row.previousProtectLevel === '一级' || row.previousProtectLevel === '二级' || row.previousProtectLevel === '三级'
        ? row.previousProtectLevel
        : '',
    lastMeasureDate: typeof row.lastMeasureDate === 'string' ? row.lastMeasureDate : '',
    revision: ROW_REVISION,
  }
}

function normalizeSurvey(row: Survey): Survey {
  return {
    ...row,
    ownerScope: 'crew',
    taskState: row.taskState === '待重排' || row.taskState === '已安排' ? row.taskState : '',
    taskLevel: row.taskLevel === '一级' || row.taskLevel === '二级' || row.taskLevel === '三级' ? row.taskLevel : '',
    isDone: typeof row.isDone === 'boolean' ? row.isDone : true,
    revision: ROW_REVISION,
  }
}

function normalizeMeasure(row: Measure): Measure {
  return {
    ...row,
    ownerScope: 'crew',
    workdays: typeof row.workdays === 'number' && Number.isFinite(row.workdays) ? row.workdays : defaultWorkdaysByType(row.type),
    queueState: row.queueState === '排队中' ? '排队中' : '已确认',
    revision: ROW_REVISION,
  }
}

function normalizeSupport(row: Support): Support {
  return {
    ...row,
    ownerScope: 'crew',
    taskState: row.taskState === '待重排' || row.taskState === '已安排' ? row.taskState : '',
    taskLevel: row.taskLevel === '一级' || row.taskLevel === '二级' || row.taskLevel === '三级' ? row.taskLevel : '',
    checkedAfterLevelChange: typeof row.checkedAfterLevelChange === 'boolean' ? row.checkedAfterLevelChange : false,
    lastCheckDate: typeof row.lastCheckDate === 'string' ? row.lastCheckDate : '',
    revision: ROW_REVISION,
  }
}

function normalizeReview(row: Review): Review {
  return { ...row, ownerScope: 'bureau', revision: ROW_REVISION }
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
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
  ])
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), trees, surveys, measures, supports, reviews }
}

/**
 * 用快照覆盖整库（导入存档）。
 * 两侧各自独立事务：先班组合（surveys / measures / supports），
 * 再保护科（trees / reviews），一侧失败只回滚自己那份。
 * 旧版本存档先按现有档案结构回填归属与新字段再启用。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const surveys = snapshot.surveys.map(normalizeSurvey)
  const measures = snapshot.measures.map(normalizeMeasure)
  const supports = snapshot.supports.map(normalizeSupport)
  // 班组那份：失败只回滚班组三表
  await db.transaction('rw', db.surveys, db.measures, db.supports, async () => {
    await Promise.all([db.surveys.clear(), db.measures.clear(), db.supports.clear()])
    await db.surveys.bulkPut(surveys)
    await db.measures.bulkPut(measures)
    await db.supports.bulkPut(supports)
  })
  // 保护科那份：失败只回滚 trees / reviews，班组数据已留住
  const trees = snapshot.trees.map(normalizeTree)
  const reviews = snapshot.reviews.map(normalizeReview)
  await db.transaction('rw', db.trees, db.reviews, async () => {
    await Promise.all([db.trees.clear(), db.reviews.clear()])
    await db.trees.bulkPut(trees)
    await db.reviews.bulkPut(reviews)
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
  ])
  return { trees, surveys, measures, supports, reviews }
}
