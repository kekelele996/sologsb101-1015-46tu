/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：古树 → 树体检查 / 复壮措施 / 加固件 / 长势复评 / 检查任务
 * 所有 id 固定，保证 /trees/:id/surveys 深链一定命中真实数据。
 * 归属按限界上下文盖章：树体检查 / 措施 / 加固件 / 检查任务 = 养护班组，长势复评 = 古树保护科。
 */
import { db, ROW_REVISION } from './db'
import { policyOf } from '../types/policy'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { Inspection } from '../types/inspection'
import { addMonths } from './dimension'
import { uuid } from './id'

const SEED_TIME = '2026-01-08T01:30:00.000Z'

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  treeA: 'tree-guozijian-0007',
  treeB: 'tree-xiangshan-0113',
  treeC: 'tree-ritan-0246',
} as const

type Row<T> = Omit<T, 'createdAt' | 'updatedAt' | 'revision'>

function wrap<T>(row: Row<T>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T
}

/** 播种任务行（检查任务由班组按保护级别核定的周期排出） */
function task(
  partial: Omit<Inspection, 'createdAt' | 'updatedAt' | 'revision' | 'ownerSide' | 'id' | 'voided' | 'voidReason' | 'checkedAt' | 'recordId' | 'status'> &
    Partial<Pick<Inspection, 'id' | 'status' | 'voided' | 'voidReason' | 'checkedAt' | 'recordId'>>,
): Inspection {
  return {
    id: partial.id ?? uuid('insp'),
    treeId: partial.treeId,
    kind: partial.kind,
    supportId: partial.supportId,
    dueDate: partial.dueDate,
    basisLevel: partial.basisLevel,
    cycleMon: partial.cycleMon,
    status: partial.status ?? '待检查',
    voided: partial.voided ?? false,
    voidReason: partial.voidReason ?? '',
    checkedAt: partial.checkedAt ?? '',
    recordId: partial.recordId ?? '',
    ownerSide: 'crew',
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  }
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用；
 * 这里再做一次防御：若已存在古树档案则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.trees.count()
  if (exists > 0) return

  // ---------------- 古树档案（3 棵，覆盖三级保护级别） ----------------
  // levelChangedDate：侧柏 2026-01-05 由二级升为一级，用于演示「级别调整后旧检查失效、待班组重排」
  const trees: Tree[] = [
    wrap<Tree>({
      id: SEED_IDS.treeA,
      code: '京-01-0007',
      species: '国槐',
      protectLevel: '一级',
      levelChangedDate: '',
      ageYears: 320,
      location: '东城区国子监街 18 号院门前',
      owner: '东城区园林绿化局',
      lastMeasureDate: '2025-09-12',
    }),
    wrap<Tree>({
      id: SEED_IDS.treeB,
      code: '京-02-0113',
      species: '银杏',
      protectLevel: '一级',
      levelChangedDate: '',
      ageYears: 260,
      location: '海淀区香山南路甲 3 号院',
      owner: '海淀区园林绿化服务中心',
      lastMeasureDate: '2026-03-28',
    }),
    wrap<Tree>({
      id: SEED_IDS.treeC,
      code: '京-05-0246',
      species: '侧柏',
      protectLevel: '一级',
      levelChangedDate: '2026-01-05',
      ageYears: 150,
      location: '朝阳区日坛公园北门内',
      owner: '朝阳区公园管理中心',
      lastMeasureDate: '2026-04-11',
    }),
  ]

  // ---------------- 树体检查（每棵 2–3 次，数值随日期递增；归属：养护班组） ----------------
  const surveys: Survey[] = [
    wrap<Survey>({ id: 'survey-a1', treeId: SEED_IDS.treeA, date: '2023-05-18', heightM: 14.4, dbhCm: 97.5, crownM: 13.8, leanDeg: 3.6, hollowCount: 2, siteNote: '铺装', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-a2', treeId: SEED_IDS.treeA, date: '2024-06-02', heightM: 14.6, dbhCm: 99, crownM: 14.1, leanDeg: 4.1, hollowCount: 2, siteNote: '铺装', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-a3', treeId: SEED_IDS.treeA, date: '2026-05-08', heightM: 14.8, dbhCm: 100.2, crownM: 14.4, leanDeg: 4.4, hollowCount: 3, siteNote: '铺装', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-b1', treeId: SEED_IDS.treeB, date: '2024-07-18', heightM: 18.2, dbhCm: 118.4, crownM: 16.2, leanDeg: 1.8, hollowCount: 0, siteNote: '裸土', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-b2', treeId: SEED_IDS.treeB, date: '2025-08-02', heightM: 18.5, dbhCm: 120.1, crownM: 16.6, leanDeg: 2.1, hollowCount: 0, siteNote: '裸土', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-b3', treeId: SEED_IDS.treeB, date: '2026-07-15', heightM: 18.7, dbhCm: 121.3, crownM: 16.9, leanDeg: 2.3, hollowCount: 1, siteNote: '裸土', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-c1', treeId: SEED_IDS.treeC, date: '2024-08-15', heightM: 9.6, dbhCm: 62.5, crownM: 7.4, leanDeg: 11.2, hollowCount: 4, siteNote: '积水', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-c2', treeId: SEED_IDS.treeC, date: '2025-08-20', heightM: 9.7, dbhCm: 63.1, crownM: 7.1, leanDeg: 12.4, hollowCount: 4, siteNote: '积水', ownerSide: 'crew' }),
    wrap<Survey>({ id: 'survey-c3', treeId: SEED_IDS.treeC, date: '2026-07-20', heightM: 9.7, dbhCm: 63.4, crownM: 6.9, leanDeg: 12.8, hollowCount: 5, siteNote: '铺装', ownerSide: 'crew' }),
  ]

  // ---------------- 复壮措施（工日按类型核定；含一条排队待批样本） ----------------
  // 侧柏 2026 年度一级核定 40 工日：已排换土/透气/树洞修补/施肥 = 40 工日，最后一条病虫害防治 3 工日超出 → 排队待批
  const measures: Measure[] = [
    wrap<Measure>({ id: 'measure-a1', treeId: SEED_IDS.treeA, type: '换土', date: '2024-04-10', material: '基质土 6 m³ + 草炭土 2 m³', operator: '王建军', state: '已完成', workdays: 8, planYear: 2024, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-a2', treeId: SEED_IDS.treeA, type: '树洞修补', date: '2025-09-12', material: '防腐树脂 + 木栓填充', operator: '李慧', state: '已完成', workdays: 6, planYear: 2025, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-a3', treeId: SEED_IDS.treeA, type: '透气', date: '2026-03-20', material: '透气砖 12 块 + 通气管 4 根', operator: '张勇', state: '实施中', workdays: 4, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-b1', treeId: SEED_IDS.treeB, type: '换土', date: '2024-04-15', material: '腐叶土 5 m³ + 河沙 1 m³', operator: '赵鹏', state: '已完成', workdays: 8, planYear: 2024, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-b2', treeId: SEED_IDS.treeB, type: '施肥', date: '2026-03-28', material: '有机肥 80 kg + 复合肥 15 kg', operator: '赵鹏', state: '已完成', workdays: 2, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-b3', treeId: SEED_IDS.treeB, type: '透气', date: '2026-06-10', material: '通气管 6 根', operator: '孙晓', state: '计划', workdays: 4, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-c1', treeId: SEED_IDS.treeC, type: '树洞修补', date: '2026-04-11', material: '不锈钢网 + 防腐树脂', operator: '周敏', state: '已完成', workdays: 6, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-c2', treeId: SEED_IDS.treeC, type: '换土', date: '2026-05-12', material: '腐叶土 4 m³ + 河沙 2 m³', operator: '周敏', state: '实施中', workdays: 8, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-c3', treeId: SEED_IDS.treeC, type: '透气', date: '2026-08-02', material: '透气铺装 18 m² + 通气管 8 根', operator: '李慧', state: '计划', workdays: 4, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({ id: 'measure-c4', treeId: SEED_IDS.treeC, type: '施肥', date: '2026-09-15', material: '缓释有机肥 60 kg', operator: '周敏', state: '计划', workdays: 2, planYear: 2026, queueOrder: 0, queueReason: '', ownerSide: 'crew' }),
    wrap<Measure>({
      id: 'measure-c5',
      treeId: SEED_IDS.treeC,
      type: '病虫害防治',
      date: '2026-10-20',
      material: '生物制剂 2 次施药',
      operator: '周敏',
      state: '排队待批',
      workdays: 3,
      planYear: 2026,
      queueOrder: 1,
      queueReason: '2026 年度核定工日 40，已排 40，本措施 3 工日超出容量，排队等下一批',
      ownerSide: 'crew',
    }),
  ]

  // ---------------- 加固件（basisLevel：侧柏两件仍按旧二级，待班组按新一级重排） ----------------
  const supports: Support[] = [
    wrap<Support>({ id: 'support-a1', treeId: SEED_IDS.treeA, type: '支撑杆', installDate: '2019-04-08', checkCycleMon: policyOf('一级').supportCheckCycleMon, lastCheckDate: '2024-03-15', basisLevel: '一级', ownerSide: 'crew' }),
    wrap<Support>({ id: 'support-a2', treeId: SEED_IDS.treeA, type: '避雷', installDate: '2020-07-01', checkCycleMon: policyOf('一级').supportCheckCycleMon, lastCheckDate: '2025-06-01', basisLevel: '一级', ownerSide: 'crew' }),
    wrap<Support>({ id: 'support-b1', treeId: SEED_IDS.treeB, type: '拉纤', installDate: '2021-09-20', checkCycleMon: policyOf('一级').supportCheckCycleMon, lastCheckDate: '2024-08-10', basisLevel: '一级', ownerSide: 'crew' }),
    // 以下两件侧柏加固件仍是二级 12 个月周期：级别已升一级（6 个月），检查待办已失效
    wrap<Support>({ id: 'support-c1', treeId: SEED_IDS.treeC, type: '避雷', installDate: '2018-06-01', checkCycleMon: policyOf('二级').supportCheckCycleMon, lastCheckDate: '2025-05-20', basisLevel: '二级', ownerSide: 'crew' }),
    wrap<Support>({ id: 'support-c2', treeId: SEED_IDS.treeC, type: '支撑杆', installDate: '2022-05-10', checkCycleMon: policyOf('二级').supportCheckCycleMon, lastCheckDate: '2026-05-08', basisLevel: '二级', ownerSide: 'crew' }),
  ]

  // ---------------- 长势复评（归属：古树保护科；衰弱 / 濒危样本均带后续措施） ----------------
  const reviews: Review[] = [
    wrap<Review>({ id: 'review-a1', treeId: SEED_IDS.treeA, date: '2024-06-20', vigor: '一般', trend: '下降', conclusion: '树冠外围枝条略有回枯，整体长势中等偏下。', followUp: '', ownerSide: 'bureau' }),
    wrap<Review>({ id: 'review-a2', treeId: SEED_IDS.treeA, date: '2026-06-18', vigor: '一般', trend: '好转', conclusion: '树洞修补后新梢抽发正常，冠幅稳定。', followUp: '', ownerSide: 'bureau' }),
    wrap<Review>({ id: 'review-b1', treeId: SEED_IDS.treeB, date: '2024-07-25', vigor: '旺盛', trend: '持平', conclusion: '叶片浓绿，年生长量处于正常区间。', followUp: '', ownerSide: 'bureau' }),
    wrap<Review>({ id: 'review-b2', treeId: SEED_IDS.treeB, date: '2026-07-22', vigor: '一般', trend: '下降', conclusion: '新增空洞 1 处，树势较上次略有回落。', followUp: '2026 年秋季安排树洞修补与树盘透气改造，并加强根区水分管理。', ownerSide: 'bureau' }),
    wrap<Review>({ id: 'review-c1', treeId: SEED_IDS.treeC, date: '2024-08-28', vigor: '衰弱', trend: '下降', conclusion: '树冠稀疏，倾斜度超过 10 度，立地长期积水。', followUp: '设置拉纤加固并开挖排水盲沟，同时安排树洞修补。', ownerSide: 'bureau' }),
    wrap<Review>({ id: 'review-c2', treeId: SEED_IDS.treeC, date: '2025-09-05', vigor: '濒危', trend: '下降', conclusion: '主枝皮层开裂，根系呼吸受阻，长势濒危。', followUp: '列入重点抢救名单，实施换土、透气与病虫害综合防治，必要时设置支撑杆。', ownerSide: 'bureau' }),
    wrap<Review>({ id: 'review-c3', treeId: SEED_IDS.treeC, date: '2026-07-20', vigor: '衰弱', trend: '好转', conclusion: '排水改造后积水缓解，新梢萌发量回升；经评审保护级别由二级升为一级。', followUp: '继续按季度监测倾斜度与空洞变化，按一级标准重排树体与加固件检查，年度复壮计划中保留透气措施。', ownerSide: 'bureau' }),
  ]

  // ---------------- 检查任务（养护班组按保护级别核定周期排出） ----------------
  // - 国槐/银杏：一级，按 6 个月周期的加固件检查与按 3 个月周期的树体检查
  // - 侧柏：旧二级排出的待办检查已因 2026-01-05 升一级而失效（做完的检查历史不失效）
  const inspections: Inspection[] = [
    // 国槐支撑杆：2024-03-15 已超期未检查（一级 6 个月周期）
    task({ id: 'insp-a1-support', treeId: SEED_IDS.treeA, kind: 'support', supportId: 'support-a1', dueDate: addMonths('2024-03-15', policyOf('一级').supportCheckCycleMon), basisLevel: '一级', cycleMon: policyOf('一级').supportCheckCycleMon }),
    // 国槐避雷：2025-06-01 后 6 个月到期
    task({ id: 'insp-a2-support', treeId: SEED_IDS.treeA, kind: 'support', supportId: 'support-a2', dueDate: addMonths('2025-06-01', policyOf('一级').supportCheckCycleMon), basisLevel: '一级', cycleMon: policyOf('一级').supportCheckCycleMon }),
    task({ id: 'insp-a-survey', treeId: SEED_IDS.treeA, kind: 'survey', supportId: '', dueDate: addMonths('2026-05-08', policyOf('一级').surveyCycleMon), basisLevel: '一级', cycleMon: policyOf('一级').surveyCycleMon }),
    task({ id: 'insp-b1-support', treeId: SEED_IDS.treeB, kind: 'support', supportId: 'support-b1', dueDate: addMonths('2024-08-10', policyOf('一级').supportCheckCycleMon), basisLevel: '一级', cycleMon: policyOf('一级').supportCheckCycleMon }),
    task({ id: 'insp-b-survey', treeId: SEED_IDS.treeB, kind: 'survey', supportId: '', dueDate: addMonths('2026-07-15', policyOf('一级').surveyCycleMon), basisLevel: '一级', cycleMon: policyOf('一级').surveyCycleMon }),
    // 侧柏：按旧二级排出的待办检查，已被 2026-01-05 的级别调整作废，等班组按一级重排
    task({
      id: 'insp-c1-support-void',
      treeId: SEED_IDS.treeC,
      kind: 'support',
      supportId: 'support-c1',
      dueDate: addMonths('2025-05-20', policyOf('二级').supportCheckCycleMon),
      basisLevel: '二级',
      cycleMon: policyOf('二级').supportCheckCycleMon,
      status: '已失效',
      voided: true,
      voidReason: '保护级别已由二级调整为一级，按旧级别排出的检查作废，待按新级别重排',
    }),
    task({
      id: 'insp-c2-support-void',
      treeId: SEED_IDS.treeC,
      kind: 'support',
      supportId: 'support-c2',
      dueDate: addMonths('2026-05-08', policyOf('二级').supportCheckCycleMon),
      basisLevel: '二级',
      cycleMon: policyOf('二级').supportCheckCycleMon,
      status: '已失效',
      voided: true,
      voidReason: '保护级别已由二级调整为一级，按旧级别排出的检查作废，待按新级别重排',
    }),
    task({
      id: 'insp-c-survey-void',
      treeId: SEED_IDS.treeC,
      kind: 'survey',
      supportId: '',
      dueDate: addMonths('2025-08-20', policyOf('二级').surveyCycleMon),
      basisLevel: '二级',
      cycleMon: policyOf('二级').surveyCycleMon,
      status: '已失效',
      voided: true,
      voidReason: '保护级别已由二级调整为一级，按旧级别排出的检查作废，待按新级别重排',
    }),
    // 侧柏支撑杆 2026-05-08 的检查在级别调整后已完成——做完的照旧留住（已完成不失效）
    task({
      id: 'insp-c-support-done',
      treeId: SEED_IDS.treeC,
      kind: 'support',
      supportId: 'support-c2',
      dueDate: '2026-05-08',
      basisLevel: '一级',
      cycleMon: policyOf('一级').supportCheckCycleMon,
      status: '已完成',
      checkedAt: '2026-05-08',
      recordId: 'support-c2',
    }),
  ]

  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.inspections],
    async () => {
      await db.trees.bulkPut(trees)
      await db.surveys.bulkPut(surveys)
      await db.measures.bulkPut(measures)
      await db.supports.bulkPut(supports)
      await db.reviews.bulkPut(reviews)
      await db.inspections.bulkPut(inspections)
    },
  )
}
