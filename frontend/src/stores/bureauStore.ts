/**
 * 古树保护科状态管理（Pinia）——保护科那份档案
 * 管：保护级别调整、级别调整同期的长势复评结论。
 * 不管：树体检查、复壮措施、加固件（那些在养护班组那份里）。
 *
 * 事务边界：
 * - submitBureauAdjustment 只写保护科自己的表（trees.protectLevel + reviews）；
 * - 级别调整提交成功后，再调用班组侧的 syncChecksAfterLevelChange 挑出失效检查；
 * - 班组侧同步失败只记 warning，不回滚保护科已提交的级别与复评。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ProtectLevel } from '../types/tree'
import type { ReviewDraft } from '../types/review'
import {
  submitBureauAdjustment,
  syncChecksAfterLevelChange,
  type BureauAdjustmentResult,
} from '../utils/db'
import { policyOf } from '../types/policy'

/** 级别调整提交结果（含班组侧失效同步状态，两侧互不回滚） */
export interface AdjustmentOutcome {
  result: BureauAdjustmentResult
  /** 班组侧失效检查同步是否成功（失败时保护科级别仍已生效） */
  crewSyncOk: boolean
  crewMessage: string
  voidedSurveyTasks: number
  voidedSupportTasks: number
}

export const useBureauStore = defineStore('bureau', () => {
  const lastMessage = ref('')
  const lastWarning = ref('')
  const submitting = ref(false)

  /** 各级别核定参数只读视图，供保护科调整级别时展示影响 */
  const policyTable = computed(() => policyOf)

  /**
   * 保护科提交级别调整（可同时提交本次复评结论）。
   * 任一侧失败只回滚自己那份：保护科事务失败整体抛出；保护科成功、班组同步失败时给出告警。
   */
  async function adjustLevel(
    treeId: string,
    nextLevel: ProtectLevel,
    changedDate: string,
    review: ReviewDraft | null,
  ): Promise<AdjustmentOutcome> {
    submitting.value = true
    lastWarning.value = ''
    try {
      // 第一步：只提交保护科那份
      const result = await submitBureauAdjustment(treeId, nextLevel, changedDate, review)

      // 第二步：级别生效后，把班组按旧级别排出的待办检查挑出来作废（独立事务）
      let crewSyncOk = true
      let crewMessage = ''
      let voidedSurveyTasks = 0
      let voidedSupportTasks = 0
      if (result.changed) {
        try {
          const invalidation = await syncChecksAfterLevelChange(treeId)
          voidedSurveyTasks = invalidation.surveyTasks
          voidedSupportTasks = invalidation.supportTasks
          crewMessage = `已挑出 ${voidedSurveyTasks} 项树体检查、${voidedSupportTasks} 项加固件检查待班组按新级别重排；做完的检查历史照旧保留。`
          lastMessage.value = `保护级别已调整为「${nextLevel}」。${crewMessage}`
        } catch (err) {
          // 班组那份提交失败：只影响班组侧，保护科级别与复评不回滚，可稍后重试挑拣
          crewSyncOk = false
          crewMessage = err instanceof Error ? err.message : '班组侧检查失效同步失败'
          lastWarning.value = `保护级别已生效，但班组侧失效检查挑取失败：${crewMessage}（可在加固件 / 检查页重试重排）`
        }
      } else {
        lastMessage.value = '保护级别未变化，已登记本次复评结论。'
      }

      return { result, crewSyncOk, crewMessage, voidedSurveyTasks, voidedSupportTasks }
    } finally {
      submitting.value = false
    }
  }

  return {
    lastMessage,
    lastWarning,
    submitting,
    policyTable,
    adjustLevel,
  }
})
