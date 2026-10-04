<script setup lang="ts">
/**
 * /supports 支撑加固与避雷件登记（养护班组那份档案）
 * 检查周期由古树保护科按保护级别核定；保护级别一调整，按旧级别排出的加固件检查即失效，
 * 列表中挑出待班组按新级别「重排检查」，已完成的检查历史照旧留住；
 * 超周期未检查的加固件自动高亮并生成检查提醒，支持一键登记本次检查。
 * 消费模型：Support、Inspection、Tree；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>、<VigorTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { db, markSupportChecked, putSupport, rescheduleSupportCheck, ROW_REVISION } from '@/utils/db'
import { policyOf } from '@/types/policy'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportDraft, type SupportType } from '@/types/support'
import { type Inspection } from '@/types/inspection'
import { isSupportOverdue, nextCheckDate, overdueDays } from '@/utils/dimension'
import { today, nowIso, uuid } from '@/utils/id'

const treeStore = useTreeStore()

const { rows, loading, remove } = useIdbTable<Support>(db.supports, { sortByUpdatedAt: false })

/** 当前级别核定的加固件检查周期（月） */
function cycleForTree(treeId: string): number {
  const tree = treeStore.trees.find((item) => item.id === treeId)
  return tree ? policyOf(tree.protectLevel).supportCheckCycleMon : 12
}

function isStale(row: Support): boolean {
  const tree = treeStore.trees.find((item) => item.id === row.treeId)
  return tree !== undefined && row.basisLevel !== tree.protectLevel
}

/** 该加固件关联的已失效检查任务（级别调整后挑出，等班组重排） */
function voidedTasksOf(supportId: string): Inspection[] {
  return treeStore.inspections.filter((task) => task.supportId === supportId && task.voided)
}

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  checkCycleMon: 12,
  lastCheckDate: '',
})

/** 表单中选中古树对应的当前核定周期（级别调整后登记新加固件即按新级别） */
const formCycle = computed<number>(() => cycleForTree(form.treeId))

/** 失效待重排的加固件（其检查周期仍停留在旧保护级别） */
const staleRows = computed<Support[]>(() => rows.value.filter(isStale))

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
  checkCycleMon: [{ required: true, message: '请填写检查周期', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const filtered = computed<Support[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && (isStale(row) || !isSupportOverdue(row.lastCheckDate, row.checkCycleMon))) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        row.lastCheckDate.includes(key)
      )
    })
    .sort((a, b) => a.installDate.localeCompare(b.installDate))
})

const overdueRows = computed<Support[]>(() =>
  rows.value.filter((row) => !isStale(row) && isSupportOverdue(row.lastCheckDate, row.checkCycleMon))
)

const coveredTrees = computed<number>(() => new Set(rows.value.map((row) => row.treeId)).size)

onMounted(() => {
  void treeStore.loadAll()
})

function rowClassName({ row }: { row: Support }): string {
  if (isStale(row)) return 'row-stale'
  return isSupportOverdue(row.lastCheckDate, row.checkCycleMon) ? 'row-overdue' : ''
}

function openCreate(): void {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingId.value = null
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: cycleForTree(treeId),
    lastCheckDate: today(),
  })
  dialogVisible.value = true
}

function openEdit(row: Support): void {
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    type: row.type,
    installDate: row.installDate,
    checkCycleMon: row.checkCycleMon,
    lastCheckDate: row.lastCheckDate,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      const stamp = nowIso()
      // 班组登记新加固件：归属 crew，检查周期按当前保护级别核定
      await putSupport({
        id: uuid('support'),
        ...form,
        checkCycleMon: formCycle.value,
        basisLevel: treeStore.trees.find((item) => item.id === form.treeId)?.protectLevel ?? '二级',
        ownerSide: 'crew',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })
      ElMessage.success(`加固件已登记，检查周期按当前保护级别核定为 ${formCycle.value} 个月`)
    } else {
      const existing = await db.supports.get(editingId.value)
      if (existing) {
        await putSupport({
          ...existing,
          ...form,
          basisLevel: existing.basisLevel,
        })
      }
      ElMessage.success('加固件已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

/** 班组按新级别重排加固件检查：旧待办已失效留痕，重排产生新的待办任务 */
async function handleReschedule(row: Support): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `「${treeLabel.value[row.treeId] ?? row.treeId} · ${row.type}」的检查周期仍按${row.basisLevel}核定，将按当前保护级别重排检查（已完成的检查历史保留）。`,
      '按新级别重排加固件检查？',
      { type: 'warning', confirmButtonText: '重排', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const task = await rescheduleSupportCheck(row.id)
    ElMessage.success(`已按新级别重排，下次检查日期：${task.dueDate}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重排失败')
  }
}

async function handleDelete(row: Support): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除「${row.type}」加固件记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('加固件记录已删除')
}

async function handleMarkChecked(row: Support): Promise<void> {
  await markSupportChecked(row.id, today())
  ElMessage.success(`已登记 ${treeLabel.value[row.treeId] ?? '该古树'} 的 ${row.type} 本次检查`)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="加固件总数" :value="rows.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge
        label="超期未检查"
        :value="overdueRows.length"
        suffix="件"
        :tone="overdueRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="超过检查周期（月）仍未登记检查的加固件（待重排的除外）"
      />
      <StatBadge
        label="级别调整待重排"
        :value="staleRows.length"
        suffix="件"
        :tone="staleRows.length > 0 ? 'warning' : 'success'"
        icon="RefreshRight"
        hint="保护级别调整后检查周期失效，等班组按新级别重排检查"
      />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="info" icon="DataLine" />
      <StatBadge label="筛选结果" :value="filtered.length" suffix="件" tone="default" icon="PieChart" size="small" />
    </div>

    <el-alert
      v-if="staleRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${staleRows.length} 件加固件的检查周期仍按旧保护级别核定，需要班组按新级别重排`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="row in staleRows" :key="row.id">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：原按
            {{ row.basisLevel }} / {{ row.checkCycleMon }} 个月，现古树为
            {{ treeStore.trees.find((tree) => tree.id === row.treeId)?.protectLevel }} /
            {{ cycleForTree(row.treeId) }} 个月
            <el-button link type="warning" size="small" @click="handleReschedule(row)">立即重排</el-button>
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="overdueRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${overdueRows.length} 件加固件超过检查周期未检查`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="row in overdueRows" :key="row.id">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：最近检查
            {{ row.lastCheckDate || '未记录' }}，检查周期 {{ row.checkCycleMon }} 个月，已超期
            {{ overdueDays(row.lastCheckDate, row.checkCycleMon) }} 天
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">支撑加固与避雷件登记</span>
          <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记加固件</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: treeFilter, type: typeFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            keyword = ''
            treeFilter = 'all'
            typeFilter = 'all'
            overdueOnly = false
          }
        "
      >
        <template #extra>
          <el-checkbox v-model="overdueOnly" border size="small">只看超期未检查</el-checkbox>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有加固件记录"
        description="登记支撑杆、拉纤与避雷件，设置检查周期后系统会自动高亮超期未检查的设施并生成提醒。"
        action-text="登记第一件加固件"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="loading || !treeStore.ready"
        :data="filtered"
        row-key="id"
        stripe
        :row-class-name="rowClassName"
      >
        <el-table-column label="古树" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
              <VigorTag
                :vigor="treeStore.statOf(row.treeId).latestVigor"
                :trend="treeStore.statOf(row.treeId).latestTrend"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="installDate" label="安装日期" width="120" />
        <el-table-column label="检查周期" width="150" align="right">
          <template #default="{ row }">
            <div>{{ row.checkCycleMon }} 个月</div>
            <div class="cell-sub">按 {{ row.basisLevel || '—' }} 核定</div>
          </template>
        </el-table-column>
        <el-table-column label="最近检查" width="130">
          <template #default="{ row }">
            <span v-if="row.lastCheckDate === ''" class="cell-warn">未记录</span>
            <span v-else>{{ row.lastCheckDate }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下次检查" width="130">
          <template #default="{ row }">{{ nextCheckDate(row.lastCheckDate, row.checkCycleMon) || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="190">
          <template #default="{ row }">
            <el-tag v-if="isStale(row)" type="warning" effect="dark">
              级别调整待重排
            </el-tag>
            <el-tag v-else-if="isSupportOverdue(row.lastCheckDate, row.checkCycleMon)" type="danger" effect="dark">
              超期 {{ overdueDays(row.lastCheckDate, row.checkCycleMon) }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
            <div v-if="voidedTasksOf(row.id).length > 0" class="cell-sub">
              {{ voidedTasksOf(row.id).length }} 个旧待办已失效
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="340" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="isStale(row)"
              link
              type="warning"
              size="small"
              @click="handleReschedule(row)"
            >
              按新级别重排
            </el-button>
            <el-button
              v-else
              link
              :type="isSupportOverdue(row.lastCheckDate, row.checkCycleMon) ? 'danger' : 'primary'"
              size="small"
              @click="handleMarkChecked(row)"
            >
              登记本次检查
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记加固件' : '编辑加固件'" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="类型" prop="type">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="安装日期" prop="installDate">
              <el-date-picker v-model="form.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="检查周期（月）">
              <el-input :model-value="`${formCycle} 个月（按当前保护级别核定）`" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="最近检查日期">
              <el-date-picker v-model="form.lastCheckDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          :title="`下次检查日期：${nextCheckDate(form.lastCheckDate, formCycle) || '请先填写最近检查日期'}`"
          description="检查周期由古树保护科按保护级别核定；级别调整后旧检查待办会失效，需班组在本页按新级别重排。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.overdue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}

:deep(.row-stale) {
  --el-table-tr-bg-color: #fdf8ec;
}
</style>
