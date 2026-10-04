/**
 * 复壮措施状态管理（Pinia）—— 养护班组档案
 * 维护措施草稿、实施状态流转与批量操作。
 * 容量规则：当年复壮施工工日按保护级别核定，排不下就排队等下一批，不挤掉已确认措施。
 * 归属：仅养护班组可写（accessStore.canWrite('crew')）；写库只动 measures 表，
 * 提交失败只回滚班组这份，保护科的保护级别 / 复评结论不受影响。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  MEASURE_TYPE_DEFAULT_WORKDAYS,
  type Measure,
  type MeasureDraft,
  type MeasureQueueState,
  type MeasureState,
  type MeasureType,
} from '../types/measure'
import {
  batchSetMeasureState,
  confirmQueuedMeasures,
  db,
  initDatabase,
  putMeasure,
  removeMeasure,
} from '../utils/db'
import { decideMeasureQueue, remainingWorkdays, workdayQuota, yearOf } from '../utils/capacity'
import { nowIso, uuid } from '../utils/id'
import { useAccessStore } from './accessStore'
import { useTreeStore } from './treeStore'

/** 复壮措施筛选条件 */
export interface MeasureFilters {
  keyword: string
  treeId: string | 'all'
  type: MeasureType | 'all'
  state: MeasureState | 'all'
  queue: MeasureQueueState | 'all'
}

export const useMeasureStore = defineStore('measure', () => {
  const access = useAccessStore()
  const filters = reactive<MeasureFilters>({ keyword: '', treeId: 'all', type: 'all', state: 'all', queue: 'all' })
  /** 每行的行内编辑草稿，key = measure id */
  const drafts = ref<Record<string, Partial<MeasureDraft>>>({})
  const selectedIds = ref<string[]>([])
  /** 批量操作选中的目标状态 */
  const stateDraft = ref<MeasureState>('已完成')
  const lastMessage = ref('')
  const revision = ref(0)

  /** 某株某年的核定容量与余量，供表单提示 */
  const capacityOf = (treeId: string, date: string): { quota: number; remaining: number; year: string } => {
    const treeStore = useTreeStore()
    const tree = treeStore.trees.find((item) => item.id === treeId)
    const year = yearOf(date)
    if (tree === undefined || year === '') return { quota: 0, remaining: 0, year: year ?? '' }
    return {
      quota: workdayQuota(tree.protectLevel),
      remaining: remainingWorkdays(treeStore.trees, treeStore.measures, treeId, year),
      year,
    }
  }

  /** 当前筛选范围内排队中的措施（按日期先排先确认） */
  const queuedRows = computed<Measure[]>(() => {
    const treeStore = useTreeStore()
    return treeStore.measures
      .filter((row) => row.queueState === '排队中')
      .sort((a, b) => a.date.localeCompare(b.date))
  })

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  function assertWritable(): void {
    if (!access.canWrite('crew')) throw new Error(access.deniedMessage('crew'))
  }

  function setFilters(patch: Partial<MeasureFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.treeId = 'all'
    filters.type = 'all'
    filters.state = 'all'
    filters.queue = 'all'
    selectedIds.value = []
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  function setStateDraft(state: MeasureState): void {
    stateDraft.value = state
  }

  function setDraft(measureId: string, patch: Partial<MeasureDraft>): void {
    drafts.value = { ...drafts.value, [measureId]: { ...drafts.value[measureId], ...patch } }
  }

  function clearDraft(measureId: string): void {
    const next = { ...drafts.value }
    delete next[measureId]
    drafts.value = next
  }

  function hasDraft(measureId: string): boolean {
    return drafts.value[measureId] !== undefined
  }

  async function saveDraft(measureId: string): Promise<void> {
    assertWritable()
    const draft = drafts.value[measureId]
    if (draft === undefined) return
    const existing = await db.measures.get(measureId)
    if (!existing) return
    // 行内草稿不改日期 / 工日，沿用既有排队结论
    await putMeasure({ ...existing, ...draft } as Measure)
    clearDraft(measureId)
    revision.value += 1
    lastMessage.value = '措施草稿已保存'
  }

  /** 按容量核定措施排队状态（新建 / 编辑统一入口） */
  function resolveQueue(draft: MeasureDraft, selfId?: string): MeasureQueueState {
    const treeStore = useTreeStore()
    const tree = treeStore.trees.find((item) => item.id === draft.treeId)
    if (tree === undefined) throw new Error('请先选择古树')
    // 已完成的措施直接确认；计划 / 实施中按容量核定
    if (draft.state === '已完成') return '已确认'
    const decision = decideMeasureQueue({
      tree,
      measures: treeStore.measures,
      date: draft.date,
      workdays: draft.workdays,
      selfId,
    })
    lastMessage.value = decision.message
    return decision.queueState
  }

  async function createMeasure(draft: MeasureDraft): Promise<Measure> {
    assertWritable()
    const queueState = resolveQueue(draft)
    const stamp = nowIso()
    const row: Measure = {
      id: uuid('measure'),
      treeId: draft.treeId,
      type: draft.type,
      date: draft.date,
      material: draft.material.trim(),
      operator: draft.operator.trim(),
      state: draft.state,
      workdays: draft.workdays,
      queueState,
      ownerScope: 'crew',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    }
    await putMeasure(row)
    revision.value += 1
    lastMessage.value =
      queueState === '排队中'
        ? lastMessage.value
        : draft.state === '已完成'
          ? '措施已登记为「已完成」，占用当年核定工日'
          : lastMessage.value
    return row
  }

  async function updateMeasure(measureId: string, draft: MeasureDraft): Promise<void> {
    assertWritable()
    const queueState = resolveQueue(draft, measureId)
    const existing = await db.measures.get(measureId)
    if (!existing) return
    await putMeasure({
      ...existing,
      treeId: draft.treeId,
      type: draft.type,
      date: draft.date,
      material: draft.material.trim(),
      operator: draft.operator.trim(),
      state: draft.state,
      workdays: draft.workdays,
      queueState,
    })
    revision.value += 1
  }

  async function deleteMeasure(measureId: string): Promise<void> {
    assertWritable()
    await removeMeasure(measureId)
    clearDraft(measureId)
    selectedIds.value = selectedIds.value.filter((id) => id !== measureId)
    revision.value += 1
  }

  /** 推进到下一状态：计划 → 实施中 → 已完成；完成时占用容量，排不下则继续排队 */
  async function advance(measureId: string): Promise<MeasureState | null> {
    assertWritable()
    const existing = await db.measures.get(measureId)
    if (!existing) return null
    const flow: MeasureState[] = ['计划', '实施中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) return null
    const next = flow[index + 1]
    const queueState =
      next === '已完成'
        ? '已确认'
        : resolveQueue(
            {
              treeId: existing.treeId,
              type: existing.type,
              date: existing.date,
              material: existing.material,
              operator: existing.operator,
              state: next,
              workdays: existing.workdays,
            },
            measureId,
          )
    await putMeasure({ ...existing, state: next, queueState })
    revision.value += 1
    lastMessage.value = next === '已完成' ? '措施已完成，占用当年核定工日' : lastMessage.value
    return next
  }

  /** 批量修改实施状态 */
  async function batchSetState(state: MeasureState): Promise<number> {
    assertWritable()
    const count = await batchSetMeasureState(selectedIds.value, state)
    selectedIds.value = []
    revision.value += 1
    lastMessage.value = `已把 ${count} 条措施状态改为「${state}」`
    await useTreeStore().refreshCounts()
    return count
  }

  /** 班组把排队中的措施确认进下一批（仅确认容量允许的，其余继续排队） */
  async function confirmNextBatch(ids?: string[]): Promise<number> {
    assertWritable()
    const target = ids ?? queuedRows.value.map((row) => row.id)
    const treeStore = useTreeStore()
    // 按 (树, 年) 分组，逐株逐年在余量内确认，已确认措施不受影响
    const candidates = target
      .map((id) => treeStore.measures.find((row) => row.id === id))
      .filter((row): row is Measure => row !== undefined && row.queueState === '排队中')
      .sort((a, b) => a.date.localeCompare(b.date))
    const confirmedIds: string[] = []
    const used: Record<string, number> = {}
    for (const row of candidates) {
      const tree = treeStore.trees.find((item) => item.id === row.treeId)
      if (tree === undefined) continue
      const year = yearOf(row.date)
      const key = `${row.treeId}@${year}`
      const already = used[key] ?? 0
      const quota = workdayQuota(tree.protectLevel)
      const confirmedBefore = treeStore.measures
        .filter((item) => item.treeId === row.treeId && yearOf(item.date) === year && item.id !== row.id)
        .filter((item) => item.queueState === '已确认' || item.state === '已完成')
        .reduce((sum, item) => sum + item.workdays, 0)
      if (confirmedBefore + already + row.workdays <= quota) {
        confirmedIds.push(row.id)
        used[key] = already + row.workdays
      }
    }
    const count = await confirmQueuedMeasures(confirmedIds)
    revision.value += 1
    lastMessage.value =
      count > 0 ? `已确认 ${count} 条排队措施进入下一批，其余继续排队` : '当前容量仍不足，排队措施继续等下一批'
    return count
  }

  function defaultWorkdays(type: MeasureType): number {
    return MEASURE_TYPE_DEFAULT_WORKDAYS[type]
  }

  return {
    filters,
    drafts,
    selectedIds,
    stateDraft,
    lastMessage,
    revision,
    queuedRows,
    capacityOf,
    defaultWorkdays,
    init,
    setFilters,
    resetFilters,
    setSelectedIds,
    setStateDraft,
    setDraft,
    clearDraft,
    hasDraft,
    saveDraft,
    createMeasure,
    updateMeasure,
    deleteMeasure,
    advance,
    batchSetState,
    confirmNextBatch,
  }
})
