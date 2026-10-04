<script setup lang="ts">
/**
 * /supports 支撑加固与避雷件登记 —— 养护班组档案
 * 超周期未检查的加固件自动高亮并生成检查提醒，支持一键登记本次检查。
 * 保护级别调整后：按旧级别安排、调整后尚未检查的加固件检查失效（红色「待重排」），
 * 班组按新级别重置检查周期重排；调整后已检查过的照旧留住。
 * 消费模型：Support、Tree；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>、<ScopeTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { useAccessStore } from '@/stores/accessStore'
import { db, markSupportChecked, requeueSupportTask } from '@/utils/db'
import { isSupportTaskStale, LEVEL_SUPPORT_CHECK_CYCLE_MON } from '@/utils/capacity'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportDraft, type SupportType } from '@/types/support'
import { isSupportOverdue, nextCheckDate, overdueDays } from '@/utils/dimension'
import { today } from '@/utils/id'

const treeStore = useTreeStore()
const access = useAccessStore()

const { rows, loading, create, update, remove } = useIdbTable<Support>(db.supports, { sortByUpdatedAt: false })

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

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
  checkCycleMon: [{ required: true, message: '请填写检查周期', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

function treeOf(id: string) {
  return treeStore.trees.find((tree) => tree.id === id) ?? null
}

const filtered = computed<Support[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && !isSupportOverdue(row.lastCheckDate, row.checkCycleMon)) return false
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
  rows.value.filter((row) => isSupportOverdue(row.lastCheckDate, row.checkCycleMon))
)

/** 保护级别调整后失效、等班组重排的加固件检查 */
const staleRows = computed<Support[]>(() =>
  rows.value.filter((row) => {
    const tree = treeOf(row.treeId)
    return tree !== null && isSupportTaskStale(row, tree)
  })
)

const coveredTrees = computed<number>(() => new Set(rows.value.map((row) => row.treeId)).size)

onMounted(() => {
  void treeStore.loadAll()
})

function isStale(row: Support): boolean {
  const tree = treeOf(row.treeId)
  return tree !== null && isSupportTaskStale(row, tree)
}

function rowClassName({ row }: { row: Support }): string {
  return isStale(row) ? 'row-stale' : isSupportOverdue(row.lastCheckDate, row.checkCycleMon) ? 'row-overdue' : ''
}

function openCreate(): void {
  if (!access.canWrite('crew')) {
    ElMessage.info(access.deniedMessage('crew'))
    return
  }
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingId.value = null
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: 12,
    lastCheckDate: today(),
  })
  dialogVisible.value = true
}

function openEdit(row: Support): void {
  if (!access.canWrite('crew')) {
    ElMessage.info(access.deniedMessage('crew'))
    return
  }
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
    const tree = treeOf(form.treeId)
    if (editingId.value === null) {
      // 班组按当前级别安排加固件检查任务
      await create(
        {
          ...form,
          ownerScope: 'crew',
          taskState: '已安排',
          taskLevel: tree?.protectLevel ?? '',
          checkedAfterLevelChange: form.lastCheckDate !== '' && tree !== null
            ? form.lastCheckDate >= tree.protectLevelChangedAt
            : false,
        },
        'support',
      )
      ElMessage.success('加固件已登记')
    } else {
      await update(editingId.value, { ...form })
      ElMessage.success('加固件已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Support): Promise<void> {
  if (!access.canWrite('crew')) {
    ElMessage.info(access.deniedMessage('crew'))
    return
  }
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
  if (!access.canWrite('crew')) {
    ElMessage.info(access.deniedMessage('crew'))
    return
  }
  await markSupportChecked(row.id, today())
  ElMessage.success(`已登记 ${treeLabel.value[row.treeId] ?? '该古树'} 的 ${row.type} 本次检查`)
}

/** 班组按新级别重排失效的加固件检查：重置为新级别默认周期，待实地检查解除超期 */
async function handleRequeue(row: Support): Promise<void> {
  if (!access.canWrite('crew')) return
  const tree = treeOf(row.treeId)
  if (tree === null) return
  const cycle = LEVEL_SUPPORT_CHECK_CYCLE_MON[tree.protectLevel]
  await requeueSupportTask(row.id, tree.protectLevel, cycle)
  ElMessage.success(`已按「${tree.protectLevel}」重排 ${row.type} 检查，周期重置为 ${cycle} 个月，待登记本次检查`)
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
        hint="超过检查周期（月）仍未登记检查的加固件"
      />
      <StatBadge
        label="级别调整待重排"
        :value="staleRows.length"
        suffix="件"
        :tone="staleRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="按旧级别安排、保护级别调整后尚未检查；已挑出等班组按新级别重排"
      />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="info" icon="DataLine" />
      <StatBadge label="筛选结果" :value="filtered.length" suffix="件" tone="default" icon="PieChart" size="small" />
    </div>

    <el-alert
      v-if="!access.isCrew"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="加固件登记与检查归养护班组，保护科身份只读，改不到班组这份。"
    />

    <el-alert
      v-if="staleRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      title="保护级别调整后，以下加固件检查按旧级别安排、调整后尚未检查，已失效待班组重排"
    >
      <template #default>
        <div class="stale-list">
          <div v-for="row in staleRows" :key="row.id">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：旧级别
            {{ row.taskLevel }} 安排，现行 {{ treeOf(row.treeId)?.protectLevel }}；最近检查
            {{ row.lastCheckDate || '未记录' }}，
            <el-button link type="danger" size="small" @click="handleRequeue(row)">按新级别重排</el-button>
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-else-if="overdueRows.length > 0"
      type="warning"
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
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="installDate" label="安装日期" width="110" />
        <el-table-column label="检查周期" width="100" align="right">
          <template #default="{ row }">{{ row.checkCycleMon }} 个月</template>
        </el-table-column>
        <el-table-column label="最近检查" width="120">
          <template #default="{ row }">
            <span v-if="row.lastCheckDate === ''" class="cell-warn">未记录</span>
            <span v-else>{{ row.lastCheckDate }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下次检查" width="120">
          <template #default="{ row }">{{ nextCheckDate(row.lastCheckDate, row.checkCycleMon) || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="190">
          <template #default="{ row }">
            <el-tag v-if="isStale(row)" type="danger" effect="dark">级别调整 · 待重排</el-tag>
            <el-tag v-else-if="isSupportOverdue(row.lastCheckDate, row.checkCycleMon)" type="warning" effect="dark">
              超期 {{ overdueDays(row.lastCheckDate, row.checkCycleMon) }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
            <div v-if="row.taskLevel !== ''" class="cell-sub mt-2">按 {{ row.taskLevel }} 级别安排</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              :type="isSupportOverdue(row.lastCheckDate, row.checkCycleMon) || isStale(row) ? 'danger' : 'primary'"
              size="small"
              @click="handleMarkChecked(row)"
            >
              登记本次检查
            </el-button>
            <el-button v-if="isStale(row)" link type="danger" size="small" @click="handleRequeue(row)">
              按新级别重排
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
            <el-form-item label="检查周期（月）" prop="checkCycleMon">
              <el-input-number v-model="form.checkCycleMon" :min="1" :max="120" :step="1" style="width: 100%" />
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
          :title="`下次检查日期：${nextCheckDate(form.lastCheckDate, form.checkCycleMon) || '请先填写最近检查日期'}`"
          description="超过下次检查日期仍未登记检查会高亮；保护级别调整后，调整前的旧检查安排会失效，需按新级别重排。"
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

.overdue-list,
.stale-list {
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

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}

.mt-2 {
  margin-top: 4px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}

:deep(.row-stale) {
  --el-table-tr-bg-color: #fbeaea;
}
</style>
