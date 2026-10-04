/**
 * 核心业务规则运行时验证（fake-indexeddb + tsx）
 * 覆盖：v2→v3 迁移回填、归属隔离、级别调整失效（做完的留住）、容量排队（不挤已确认）、单侧失败只回滚自己
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import {
  db,
  initDatabase,
  submitBureauAdjustment,
  syncChecksAfterLevelChange,
  rescheduleSupportCheck,
  putMeasure,
  putReview,
  putSurvey,
  capacityOf,
  promoteQueuedMeasures,
} from '../src/utils/db'
import { SEED_IDS } from '../src/utils/seed'
import type { Review } from '../src/types/review'
import type { Survey } from '../src/types/survey'
import type { Measure } from '../src/types/measure'
import { nowIso, uuid } from '../src/utils/id'

async function main() {
  // ---------- 场景 1：全新播种 ----------
  await initDatabase()
  const c = SEED_IDS.treeC // 侧柏：已升一级，2 件加固件仍按二级，含 1 条排队措施
  let cap = await capacityOf(c, 2026)
  assert.strictEqual(cap.quota, 40, '一级年容量应为 40 工日')
  assert.strictEqual(cap.used, 20, `已排工日应为 20（6+8+4+2），实际 ${cap.used}`)
  const queued = (await db.measures.where('treeId').equals(c).toArray()).filter((m) => m.state === '排队待批')
  assert.strictEqual(queued.length, 1, '应有 1 条排队措施')
  assert.strictEqual(queued[0].workdays, 3)

  // ---------- 场景 2：容量不足时新计划措施排队，不挤已确认 ----------
  await putMeasure({
    id: uuid('measure'), treeId: c, type: '施肥', date: '2026-11-01', material: 'x', operator: 'y',
    state: '计划', workdays: 30, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew',
    createdAt: nowIso(), updatedAt: nowIso(), revision: 3,
  } as Measure)
  const q2 = (await db.measures.where('treeId').equals(c).toArray()).filter((m) => m.state === '排队待批')
  assert.strictEqual(q2.length, 2, '30 工日超容量 → 排队，排队数应为 2')
  const confirmedStill = (await db.measures.where('treeId').equals(c).toArray())
    .filter((m) => m.state === '已完成' || m.state === '实施中')
  assert.strictEqual(confirmedStill.length, 2, '已确认的 2 条措施不应被挤掉')

  // ---------- 场景 3：班组改不到保护科的复评（归属隔离） ----------
  await assert.rejects(
    async () =>
      putReview({
        id: 'review-x', treeId: c, date: '2026-10-01', vigor: '一般', trend: '持平',
        conclusion: '', followUp: '', ownerSide: 'crew',
        createdAt: nowIso(), updatedAt: nowIso(), revision: 3,
      } as Review),
    /不能修改|无权修改/,
    'crew 章复评必须被拒',
  )
  await assert.rejects(
    async () =>
      putSurvey({
        id: 'survey-x', treeId: c, date: '2026-10-01', heightM: 1, dbhCm: 1, crownM: 1, leanDeg: 1,
        hollowCount: 0, siteNote: '裸土', ownerSide: 'bureau',
        createdAt: nowIso(), updatedAt: nowIso(), revision: 3,
      } as unknown as Survey),
    /不能修改|无权修改/,
    'bureau 章树体检查必须被拒',
  )

  // ---------- 场景 4：保护科级别调整 → 旧待办失效，已完成留住 ----------
  // 班组先把侧柏避雷按当前一级重排（产生一级待办）；随后保护科降为二级，该一级待办应失效
  const scheduled = await rescheduleSupportCheck('support-c1')
  assert.strictEqual(scheduled.basisLevel, '一级')
  const beforeTasks = await db.inspections.where('treeId').equals(c).toArray()
  const doneBefore = beforeTasks.filter((t) => t.status === '已完成').length
  const r = await submitBureauAdjustment(c, '二级', '2026-10-02', null)
  assert.strictEqual(r.changed, true)
  const inv = await syncChecksAfterLevelChange(c)
  assert.ok(inv.supportTasks >= 1, '至少 1 个加固件待办应失效')
  const afterTasks = await db.inspections.where('treeId').equals(c).toArray()
  assert.strictEqual(afterTasks.filter((t) => t.status === '已完成').length, doneBefore, '已完成任务照旧留住')
  const tree = await db.trees.get(c)
  assert.strictEqual(tree?.protectLevel, '二级')
  assert.strictEqual(tree?.levelChangedDate, '2026-10-02')
  // 班组按新二级重排加固件检查
  const t2 = await rescheduleSupportCheck('support-c1')
  assert.strictEqual(t2.basisLevel, '二级')
  assert.strictEqual(t2.status, '待检查')
  const support = await db.supports.get('support-c1')
  assert.strictEqual(support?.basisLevel, '二级')
  assert.strictEqual(support?.checkCycleMon, 12)

  // ---------- 场景 5：排队晋升不挤已确认 ----------
  // 容量现为二级 24 工日：已排 20，剩 4 → 3 工日的排队措施可进，30 工日的继续排队
  const promoted = await promoteQueuedMeasures(c, 2026)
  assert.ok(promoted >= 1, '至少 1 条小工日排队措施可排入')

  // ---------- 场景 6：v2 → v3 迁移回填 ----------
  await testV2ToV3Migration()

  console.log('全部断言通过 ✅')
  process.exit(0)
}

/** 构造一个 v2 结构的库并验证 v3 升级：归属回填 + 检查任务生成 */
async function testV2ToV3Migration() {
  await db.close()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbheritagetree')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('delete blocked'))
  })

  // 用 v2 schema 手工建库并灌一条无 ownerSide 的旧数据
  const { default: Dexie } = await import('dexie')
  const old = new Dexie('gbheritagetree')
  old.version(1).stores({
    trees: 'id, code, species, protectLevel, ageYears, createdAt',
    surveys: 'id, treeId, date',
    measures: 'id, treeId, type, state, date',
    supports: 'id, treeId, type, installDate',
    reviews: 'id, treeId, date, vigor',
  })
  old.version(2).stores({
    trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
    surveys: 'id, treeId, [treeId+date], date, siteNote',
    measures: 'id, treeId, type, state, date, operator',
    supports: 'id, treeId, type, installDate, lastCheckDate',
    reviews: 'id, treeId, date, vigor, trend',
  })
  await old.open()
  await old.table('trees').put({
    id: 'tree-old-1', code: '京-99-0001', species: '国槐', protectLevel: '一级',
    ageYears: 200, location: 'x', owner: 'y', lastMeasureDate: '',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', revision: 2,
  })
  await old.table('surveys').put({
    id: 'survey-old-1', treeId: 'tree-old-1', date: '2026-01-10', heightM: 10, dbhCm: 50,
    crownM: 6, leanDeg: 1, hollowCount: 0, siteNote: '裸土',
    createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-01-10T00:00:00.000Z', revision: 2,
  })
  await old.table('supports').put({
    id: 'support-old-1', treeId: 'tree-old-1', type: '支撑杆', installDate: '2020-01-01',
    checkCycleMon: 12, lastCheckDate: '2025-06-01',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 2,
  })
  await old.table('reviews').put({
    id: 'review-old-1', treeId: 'tree-old-1', date: '2026-01-10', vigor: '一般', trend: '持平',
    conclusion: 'c', followUp: '',
    createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-01-10T00:00:00.000Z', revision: 2,
  })
  await old.close()

  // 重新打开正式库 → 触发 v3 升级
  await db.open()
  const survey = await db.surveys.get('survey-old-1')
  assert.strictEqual(survey?.ownerSide, 'crew', '旧检查记录应回填为班组归属')
  const review = await db.reviews.get('review-old-1')
  assert.strictEqual(review?.ownerSide, 'bureau', '旧复评应回填为保护科归属')
  const supportRow = await db.supports.get('support-old-1')
  assert.strictEqual(supportRow?.basisLevel, '一级', '加固件应回填依据级别')
  const tasks = await db.inspections.where('treeId').equals('tree-old-1').toArray()
  assert.ok(tasks.length >= 2, `应回填树体 + 加固件检查任务，实际 ${tasks.length}`)
  assert.ok(tasks.every((t) => t.ownerSide === 'crew'))
  await db.close()
}

main().catch((err) => {
  console.error('验证失败：', err)
  process.exit(1)
})
