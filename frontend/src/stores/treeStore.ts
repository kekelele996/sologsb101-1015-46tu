/**
 * 古树档案状态管理（Pinia）
 * 维护古树列表、当前选中古树、筛选条件与古树级派生统计；
 * 通过 Dexie liveQuery 订阅全量数据，写操作落库后自动回灌。
 *
 * 归属边界：本 store 只做读侧聚合；保护级别调整走 bureauStore，
 * 检查 / 措施 / 加固件写入走各自班组入口，互不越界。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { ProtectLevel, Tree, TreeDraft } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review, Trend, Vigor } from '../types/review'
import type { Inspection } from '../types/inspection'
import { VIGOR_NEED_FOLLOW_UP } from '../types/review'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  capacityOf,
  countAll,
  db,
  initDatabase,
  putTree,
  removeTree,
  updateTreeBase,
  type CapacityInfo,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import {
  LEAN_LEVEL_LABEL,
  annualGrowth,
  isSupportOverdue,
  leanLevel,
  type LeanLevel,
} from '../utils/dimension'

/** 古树筛选条件（关键字 + 保护级别 + 树种），由 <FilterBar> 同步到 URL query */
export interface TreeFilters {
  keyword: string
  protectLevel: ProtectLevel | 'all'
  species: string | 'all'
}

/** 单株古树的派生统计，供档案页、检查页、加固页与复评页复用 */
export interface TreeStat {
  treeId: string
  surveyCount: number
  latestSurvey: Survey | null
  /** 树高年生长量（米/年） */
  heightAnnual: number
  /** 胸径年生长量（厘米/年） */
  dbhAnnual: number
  /** 倾斜安全等级 */
  lean: LeanLevel
  leanLabel: string
  /** 最新空洞数 */
  hollowCount: number
  measureCount: number
  doneMeasureCount: number
  pendingMeasureCount: number
  queuedMeasureCount: number
  supportCount: number
  /** 超周期未检查的加固件数 */
  overdueCount: number
  reviewCount: number
  latestVigor: Vigor | null
  latestTrend: Trend | null
  /** 是否需要填写后续措施（最新长势为衰弱 / 濒危） */
  needFollowUp: boolean
  /** 级别调整后已失效、等班组重排的检查任务数 */
  voidedInspectionCount: number
  /** 检查周期仍停留在旧保护级别的加固件数（待按新级别重排） */
  staleSupportCount: number
}

const CURRENT_TREE_KEY = 'gbheritagetree:currentTreeId'

function readCurrentTreeId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_TREE_KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeCurrentTreeId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_TREE_KEY, id ?? '')
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

const EMPTY_STAT: Omit<TreeStat, 'treeId'> = {
  surveyCount: 0,
  latestSurvey: null,
  heightAnnual: 0,
  dbhAnnual: 0,
  lean: 'safe',
  leanLabel: LEAN_LEVEL_LABEL.safe,
  hollowCount: 0,
  measureCount: 0,
  doneMeasureCount: 0,
  pendingMeasureCount: 0,
  queuedMeasureCount: 0,
  supportCount: 0,
  overdueCount: 0,
  reviewCount: 0,
  latestVigor: null,
  latestTrend: null,
  needFollowUp: false,
  voidedInspectionCount: 0,
  staleSupportCount: 0,
}

let subscribed = false

export const useTreeStore = defineStore('tree', () => {
  const trees = ref<Tree[]>([])
  const surveys = ref<Survey[]>([])
  const measures = ref<Measure[]>([])
  const supports = ref<Support[]>([])
  const reviews = ref<Review[]>([])
  const inspections = ref<Inspection[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const currentTreeId = ref<string | null>(readCurrentTreeId())
  const counts = ref<Record<string, number>>({})
  const filters = reactive<TreeFilters>({ keyword: '', protectLevel: 'all', species: 'all' })

  const speciesOptions = computed<string[]>(() => {
    const set = new Set(trees.value.map((tree) => tree.species))
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  })

  const stats = computed<Record<string, TreeStat>>(() => {
    const result: Record<string, TreeStat> = {}
    trees.value.forEach((tree) => {
      const treeSurveys = surveys.value
        .filter((row) => row.treeId === tree.id)
        .sort((a, b) => a.date.localeCompare(b.date))
      const latest = treeSurveys.length > 0 ? treeSurveys[treeSurveys.length - 1] : null
      const previous = treeSurveys.length > 1 ? treeSurveys[treeSurveys.length - 2] : null
      const treeMeasures = measures.value.filter((row) => row.treeId === tree.id)
      const treeSupports = supports.value.filter((row) => row.treeId === tree.id)
      const treeReviews = reviews.value
        .filter((row) => row.treeId === tree.id)
        .sort((a, b) => a.date.localeCompare(b.date))
      const latestReview = treeReviews.length > 0 ? treeReviews[treeReviews.length - 1] : null
      const treeInspections = inspections.value.filter((row) => row.treeId === tree.id)
      const lean = latest === null ? 'safe' : leanLevel(latest.leanDeg)
      result[tree.id] = {
        treeId: tree.id,
        surveyCount: treeSurveys.length,
        latestSurvey: latest,
        heightAnnual:
          latest !== null && previous !== null
            ? annualGrowth(previous.heightM, latest.heightM, previous.date, latest.date)
            : 0,
        dbhAnnual:
          latest !== null && previous !== null
            ? annualGrowth(previous.dbhCm, latest.dbhCm, previous.date, latest.date)
            : 0,
        lean,
        leanLabel: LEAN_LEVEL_LABEL[lean],
        hollowCount: latest === null ? 0 : latest.hollowCount,
        measureCount: treeMeasures.length,
        doneMeasureCount: treeMeasures.filter((row) => row.state === '已完成').length,
        pendingMeasureCount: treeMeasures.filter((row) => row.state === '计划' || row.state === '实施中').length,
        queuedMeasureCount: treeMeasures.filter((row) => row.state === '排队待批').length,
        supportCount: treeSupports.length,
        overdueCount: treeSupports
          // 待重排（级别失效）的加固件不参与普通超期高亮，统一进入待重排队列
          .filter((row) => row.basisLevel === tree.protectLevel && isSupportOverdue(row.lastCheckDate, row.checkCycleMon))
          .length,
        reviewCount: treeReviews.length,
        latestVigor: latestReview === null ? null : latestReview.vigor,
        latestTrend: latestReview === null ? null : latestReview.trend,
        needFollowUp: latestReview !== null && VIGOR_NEED_FOLLOW_UP.includes(latestReview.vigor),
        voidedInspectionCount: treeInspections.filter((row) => row.voided).length,
        staleSupportCount: treeSupports.filter((row) => row.basisLevel !== tree.protectLevel).length,
      }
    })
    return result
  })

  const visibleTrees = computed<Tree[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return trees.value.filter((tree) => {
      if (filters.protectLevel !== 'all' && tree.protectLevel !== filters.protectLevel) return false
      if (filters.species !== 'all' && tree.species !== filters.species) return false
      if (keyword === '') return true
      return (
        tree.code.toLowerCase().includes(keyword) ||
        tree.species.toLowerCase().includes(keyword) ||
        tree.location.toLowerCase().includes(keyword) ||
        tree.owner.toLowerCase().includes(keyword)
      )
    })
  })

  const currentTree = computed<Tree | null>(
    () => trees.value.find((tree) => tree.id === currentTreeId.value) ?? null
  )

  /** 超周期未检查（且检查周期仍对应当前保护级别）的加固件 */
  const overdueSupports = computed<Support[]>(() =>
    supports.value.filter((row) => {
      const tree = trees.value.find((item) => item.id === row.treeId)
      if (tree && row.basisLevel !== tree.protectLevel) return false
      return isSupportOverdue(row.lastCheckDate, row.checkCycleMon)
    }),
  )

  /** 级别调整后等班组重排的检查任务（已失效待办，已完成的历史不在其中） */
  const voidedInspections = computed<Inspection[]>(() =>
    inspections.value
      .filter((row) => row.voided)
      .sort((a, b) => a.treeId.localeCompare(b.treeId) || a.kind.localeCompare(b.kind))
  )

  /** 检查周期依据级别已过期的加固件（班组需按新级别重排） */
  const staleSupports = computed<Support[]>(() =>
    supports.value.filter((row) => {
      const tree = trees.value.find((item) => item.id === row.treeId)
      return tree !== undefined && row.basisLevel !== tree.protectLevel
    }),
  )

  /** 待班组重排的措施项：失效检查任务 + 旧级别加固件，按古树去重提示 */
  const crewRecheckCount = computed<number>(() => {
    const supportIds = new Set(staleSupports.value.map((row) => row.id))
    const surveyVoids = new Set(
      voidedInspections.value.filter((row) => row.kind === 'survey').map((row) => row.treeId),
    )
    return supportIds.size + surveyVoids.size
  })

  /** 全部排队等下一批的复壮措施 */
  const queuedMeasures = computed<Measure[]>(() =>
    measures.value
      .filter((row) => row.state === '排队待批')
      .sort((a, b) => a.queueOrder - b.queueOrder || a.date.localeCompare(b.date))
  )

  function statOf(treeId: string): TreeStat {
    return stats.value[treeId] ?? { treeId, ...EMPTY_STAT }
  }

  function inspectionsOf(treeId: string): Inspection[] {
    return inspections.value
      .filter((row) => row.treeId === treeId)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  }

  async function loadCapacity(treeId: string, year = new Date().getFullYear()): Promise<CapacityInfo> {
    return capacityOf(treeId, year)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [treeRows, surveyRows, measureRows, supportRows, reviewRows, inspectionRows] = await Promise.all([
            db.trees.toArray(),
            db.surveys.toArray(),
            db.measures.toArray(),
            db.supports.toArray(),
            db.reviews.toArray(),
            db.inspections.toArray(),
          ])
          return { treeRows, surveyRows, measureRows, supportRows, reviewRows, inspectionRows }
        }).subscribe({
          next: ({ treeRows, surveyRows, measureRows, supportRows, reviewRows, inspectionRows }) => {
            const sorted = [...treeRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            trees.value = sorted
            surveys.value = surveyRows
            measures.value = measureRows
            supports.value = supportRows
            reviews.value = reviewRows
            inspections.value = inspectionRows
            loading.value = false
            ready.value = true
            error.value = ''
            const stillExists =
              currentTreeId.value !== null && sorted.some((tree) => tree.id === currentTreeId.value)
            if (!stillExists) {
              selectTree(sorted.length > 0 ? sorted[0].id : null)
            }
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取古树数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function selectTree(treeId: string | null): void {
    currentTreeId.value = treeId
    writeCurrentTreeId(treeId)
  }

  function setFilters(patch: Partial<TreeFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.protectLevel = 'all'
    filters.species = 'all'
  }

  async function createTree(draft: TreeDraft): Promise<Tree> {
    const stamp = nowIso()
    const row: Tree = {
      id: uuid('tree'),
      code: draft.code.trim() || '未编号',
      species: draft.species.trim() || '未鉴定',
      protectLevel: draft.protectLevel,
      levelChangedDate: '',
      ageYears: draft.ageYears,
      location: draft.location.trim(),
      owner: draft.owner.trim(),
      lastMeasureDate: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putTree(row)
    selectTree(row.id)
    return row
  }

  /**
   * 编辑古树共享基础信息（编号 / 树种 / 树龄 / 位置 / 管护单位）。
   * 不含保护级别——保护级别只能由保护科经级别调整流程修改。
   */
  async function updateTree(treeId: string, draft: TreeDraft): Promise<void> {
    await updateTreeBase(treeId, {
      code: draft.code.trim(),
      species: draft.species.trim(),
      ageYears: draft.ageYears,
      location: draft.location.trim(),
      owner: draft.owner.trim(),
    })
  }

  async function deleteTree(treeId: string): Promise<void> {
    await removeTree(treeId)
    if (currentTreeId.value === treeId) selectTree(null)
    await refreshCounts()
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    trees,
    surveys,
    measures,
    supports,
    reviews,
    inspections,
    loading,
    ready,
    error,
    counts,
    filters,
    currentTreeId,
    currentTree,
    speciesOptions,
    stats,
    visibleTrees,
    overdueSupports,
    voidedInspections,
    staleSupports,
    crewRecheckCount,
    queuedMeasures,
    statOf,
    inspectionsOf,
    loadCapacity,
    loadAll,
    selectTree,
    setFilters,
    resetFilters,
    createTree,
    updateTree,
    deleteTree,
    refreshCounts,
  }
})
