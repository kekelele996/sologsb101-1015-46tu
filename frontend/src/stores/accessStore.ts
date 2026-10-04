/**
 * 访问身份状态（Pinia）
 * 纯前端没有登录体系，用顶栏的「当前身份」在养护班组 / 古树保护科之间切换。
 * 页面与写操作都按身份判定：谁也改不到对方那份档案。
 * 身份只保存在 localStorage（界面偏好），不随业务数据导入导出。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { OWNER_SCOPE_LABEL, type OwnerScope } from '../types/tree'

const ACCESS_ROLE_KEY = 'gbheritagetree:accessRole'

function readRole(): OwnerScope {
  try {
    const raw = window.localStorage.getItem(ACCESS_ROLE_KEY)
    return raw === 'bureau' ? 'bureau' : 'crew'
  } catch {
    return 'crew'
  }
}

export const useAccessStore = defineStore('access', () => {
  const role = ref<OwnerScope>(readRole())

  const isCrew = computed<boolean>(() => role.value === 'crew')
  const isBureau = computed<boolean>(() => role.value === 'bureau')
  const roleLabel = computed<string>(() => OWNER_SCOPE_LABEL[role.value])

  function setRole(next: OwnerScope): void {
    role.value = next
    try {
      window.localStorage.setItem(ACCESS_ROLE_KEY, next)
    } catch {
      /* 隐私模式下写入失败时静默降级 */
    }
  }

  /**
   * 写操作归属闸门：存储层函数也会强制归属，这里给 UI/store 一个统一入口。
   * scope = 'crew' 仅班组可写；'bureau' 仅保护科可写。
   */
  function canWrite(scope: OwnerScope): boolean {
    return role.value === scope
  }

  /** 无权写入时返回一句可直接弹给用户的提示 */
  function deniedMessage(scope: OwnerScope): string {
    return `这是${OWNER_SCOPE_LABEL[scope]}档案，当前身份（${OWNER_SCOPE_LABEL[role.value]}）改不到对方那份。`
  }

  return { role, isCrew, isBureau, roleLabel, setRole, canWrite, deniedMessage }
})
