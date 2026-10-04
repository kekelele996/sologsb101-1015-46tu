/**
 * 复壮措施状态管理（Pinia）——养护班组那份档案
 * 维护措施草稿、实施状态流转与批量操作；
 * 当年施工工日按古树保护级别核定，超容量的「计划」措施自动排队等下一批，
 * 已确认（实施中 / 已完成）的措施不被挤掉；完成即回写古树最近复壮日期。
 */
import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Measure, MeasureDraft, MeasureState, MeasureType } from '../types/measure'
import {
  batchSetMeasureState,
  capacityOf,
  db,
  initDatabase,
  promoteQueuedMeasures,
  putMeasure,
  removeMeasure,
} from '../utils/db'
import { defaultWorkdays } from '../types/policy'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

/** 复壮措施筛选条件 */
export interface MeasureFilters {
  keyword: string
  treeId: string | 'all'
  type: MeasureType | 'all'
  state: MeasureState | 'all'
}

function yearOf(date: string): number {
  return /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : new Date().getFullYear()
}

export const useMeasureStore = defineStore('measure', () => {
  const filters = reactive<MeasureFilters>({ keyword: '', treeId: 'all', type: 'all', state: 'all' })
  /** 每行的行内编辑草稿，key = measure id */
  const drafts = ref<Record<string, Partial<MeasureDraft>>>({})
  const selectedIds = ref<string[]>([])
  /** 批量操作选中的目标状态 */
  const stateDraft = ref<MeasureState>('已完成')
  const lastMessage = ref('')
  const revision = ref(0)

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  function setFilters(patch: Partial<MeasureFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.treeId = 'all'
    filters.type = 'all'
    filters.state = 'all'
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
    const draft = drafts.value[measureId]
    if (draft === undefined) return
    const existing = await db.measures.get(measureId)
    if (!existing) return
    await putMeasure({ ...existing, ...draft } as Measure)
    clearDraft(measureId)
    revision.value += 1
    lastMessage.value = '措施草稿已保存'
  }

  async function createMeasure(draft: MeasureDraft): Promise<Measure> {
    const stamp = nowIso()
    const workdays = draft.workdays && draft.workdays > 0 ? draft.workdays : defaultWorkdays(draft.type)
    const row: Measure = {
      id: uuid('measure'),
      treeId: draft.treeId,
      type: draft.type,
      date: draft.date,
      material: draft.material.trim(),
      operator: draft.operator.trim(),
      state: draft.state,
      workdays,
      planYear: yearOf(draft.date),
      queueOrder: 0,
      queueReason: '',
      ownerSide: 'crew',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    // putMeasure 内部按核定容量决定是否转为「排队待批」
    await putMeasure(row)
    revision.value += 1
    const saved = (await db.measures.get(row.id)) ?? row
    if (saved.state === '排队待批') {
      lastMessage.value = `当年核定工日容量不足，该措施（${saved.workdays} 工日）已排队等下一批，已确认措施不受影响`
    } else if (saved.state === '已完成') {
      lastMessage.value = '措施已登记为「已完成」，古树最近复壮日期已回写'
    } else {
      lastMessage.value = `复壮措施已排入 ${saved.planYear} 年度批次（核定 ${saved.workdays} 工日）`
    }
    return saved
  }

  async function updateMeasure(measureId: string, draft: MeasureDraft): Promise<void> {
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
      workdays: draft.workdays && draft.workdays > 0 ? draft.workdays : existing.workdays,
      planYear: yearOf(draft.date),
    })
    revision.value += 1
  }

  async function deleteMeasure(measureId: string): Promise<void> {
    await removeMeasure(measureId)
    clearDraft(measureId)
    selectedIds.value = selectedIds.value.filter((id) => id !== measureId)
    revision.value += 1
  }

  /** 推进到下一状态：排队待批 → 计划（受容量约束）→ 实施中 → 已完成 */
  async function advance(measureId: string): Promise<MeasureState | null> {
    const existing = await db.measures.get(measureId)
    if (!existing) return null
    if (existing.state === '排队待批') {
      const capacity = await capacityOf(existing.treeId, existing.planYear)
      if (existing.workdays > capacity.remaining) {
        lastMessage.value = `当年剩余核定工日仅 ${capacity.remaining}，不足 ${existing.workdays} 工日，该措施继续排队等下一批`
        return '排队待批'
      }
      await putMeasure({ ...existing, state: '计划', queueOrder: 0, queueReason: '' })
      revision.value += 1
      lastMessage.value = '排队措施已排入当年批次'
      return '计划'
    }
    const flow: MeasureState[] = ['计划', '实施中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) return null
    const next = flow[index + 1]
    await putMeasure({ ...existing, state: next })
    revision.value += 1
    lastMessage.value = next === '已完成' ? '措施已完成，古树最近复壮日期已回写' : `措施状态已推进为「${next}」`
    return next
  }

  /** 批量修改实施状态 */
  async function batchSetState(state: MeasureState): Promise<number> {
    const count = await batchSetMeasureState(selectedIds.value, state)
    selectedIds.value = []
    revision.value += 1
    lastMessage.value = `已把 ${count} 条措施状态改为「${state}」`
    // 回写古树日期后，同步刷新古树统计
    await useTreeStore().refreshCounts()
    return count
  }

  /** 让排队措施按顺序尝试排入容量空出的当年批次；不挤掉任何已确认措施 */
  async function promoteQueue(treeId?: string, year?: number): Promise<number> {
    const count = await promoteQueuedMeasures(treeId, year)
    revision.value += 1
    lastMessage.value =
      count > 0 ? `已按排队顺序把 ${count} 条措施排入当年批次` : '当前容量仍不足以排入更多排队措施'
    return count
  }

  /** 读取某株古树某年度核定容量 */
  async function capacity(treeId: string, year?: number) {
    return capacityOf(treeId, year ?? new Date().getFullYear())
  }

  return {
    filters,
    drafts,
    selectedIds,
    stateDraft,
    lastMessage,
    revision,
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
    promoteQueue,
    capacity,
  }
})
