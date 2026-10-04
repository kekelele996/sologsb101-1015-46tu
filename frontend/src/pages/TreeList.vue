<script setup lang="ts">
/**
 * /trees 古树一树一档
 * 新建档案、按保护级别与树种筛选、回显检查次数与最新长势等级、级联删除。
 * 两侧分家：
 * - 「编辑档案」改身份 / 基础字段（两侧均可），但表单不允许动保护级别；
 * - 「调整保护级别」是古树保护科专属动作，只写保护科那份，调整后旧级别任务失效由班组重排。
 * 消费模型：Tree、Review、Survey、Measure、Support；复用组件：<VigorTag>、<FilterBar>、<StatBadge>、<EmptyPanel>、<ScopeTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import FilterBar from '@/components/common/FilterBar.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useAccessStore } from '@/stores/accessStore'
import {
  PROTECT_LEVEL_OPTIONS,
  TREE_SPECIES_CANDIDATES,
  type ProtectLevel,
  type Tree,
  type TreeDraft,
} from '@/types/tree'
import { today } from '@/utils/id'

const router = useRouter()
const treeStore = useTreeStore()
const access = useAccessStore()

const dialogVisible = ref(false)
const levelDialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const levelTreeId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<TreeDraft>({
  code: '',
  species: '国槐',
  protectLevel: '二级',
  ageYears: 120,
  location: '',
  owner: '',
})

/** 保护科调级别用的小表单（只含级别与生效日期，动不到基础字段） */
const levelForm = reactive<{ protectLevel: ProtectLevel; date: string }>({
  protectLevel: '二级',
  date: today(),
})

const rules: FormRules<TreeDraft> = {
  code: [
    { required: true, message: '请填写古树编号', trigger: 'blur' },
    { max: 32, message: '编号不超过 32 个字符', trigger: 'blur' },
  ],
  species: [{ required: true, message: '请填写树种', trigger: 'blur' }],
  protectLevel: [{ required: true, message: '请选择保护级别', trigger: 'change' }],
  ageYears: [{ required: true, message: '请填写树龄', trigger: 'blur' }],
  location: [{ required: true, message: '请填写位置', trigger: 'blur' }],
  owner: [{ required: true, message: '请填写管护单位', trigger: 'blur' }],
}

const speciesOptions = computed<string[]>(() => {
  const set = new Set<string>([...TREE_SPECIES_CANDIDATES, ...treeStore.speciesOptions])
  return Array.from(set)
})

const rows = computed<Tree[]>(() => treeStore.visibleTrees)

const totals = computed(() => {
  const list = treeStore.trees
  const level1 = list.filter((tree) => tree.protectLevel === '一级').length
  const weak = list.filter((tree) => {
    const vigor = treeStore.statOf(tree.id).latestVigor
    return vigor === '衰弱' || vigor === '濒危'
  }).length
  const overdue = list.reduce((acc, tree) => acc + treeStore.statOf(tree.id).overdueCount, 0)
  const queued = list.reduce((acc, tree) => acc + treeStore.statOf(tree.id).queuedMeasureCount, 0)
  return { level1, weak, overdue, queued }
})

onMounted(() => {
  void treeStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    code: '',
    species: '国槐',
    protectLevel: '二级' as ProtectLevel,
    ageYears: 120,
    location: '',
    owner: '',
  })
  dialogVisible.value = true
}

function openEdit(row: Tree): void {
  editingId.value = row.id
  Object.assign(form, {
    code: row.code,
    species: row.species,
    protectLevel: row.protectLevel,
    ageYears: row.ageYears,
    location: row.location,
    owner: row.owner,
  })
  dialogVisible.value = true
}

function openLevelDialog(row: Tree): void {
  levelTreeId.value = row.id
  levelForm.protectLevel = row.protectLevel
  levelForm.date = today()
  levelDialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await treeStore.createTree({ ...form })
      ElMessage.success(`已建立古树档案「${row.code}」，可继续登记树体检查`)
    } else {
      await treeStore.updateTree(editingId.value, { ...form })
      ElMessage.success('古树档案已更新（保护级别由保护科单独调整，未在本次改动）')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleLevelSubmit(): Promise<void> {
  if (levelTreeId.value === null) return
  submitting.value = true
  try {
    const updated = await treeStore.adjustLevel(levelTreeId.value, levelForm.protectLevel, levelForm.date)
    ElMessage.success(
      `保护级别已由${updated.previousProtectLevel || '未定级'}调整为「${updated.protectLevel}」；按旧级别安排、尚未完成的检查与加固件检查已挑出，等班组按新级别重排，已完成的照旧留住。`
    )
    levelDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '调整失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Tree): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将删除「${row.code} ${row.species}」及其全部树体检查、复壮措施、加固件与复评记录，且不可恢复。`,
      '确认删除古树档案？',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  await treeStore.deleteTree(row.id)
  ElMessage.success('古树档案已删除')
}

function goSurveys(row: Tree): void {
  treeStore.selectTree(row.id)
  void router.push(`/trees/${row.id}/surveys`)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'protectLevel') treeStore.setFilters({ protectLevel: value as ProtectLevel | 'all' })
  if (key === 'species') treeStore.setFilters({ species: value })
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="在档古树" :value="treeStore.trees.length" suffix="株" tone="primary" icon="Histogram" />
      <StatBadge label="一级古树" :value="totals.level1" suffix="株" tone="success" icon="DataLine" />
      <StatBadge label="衰弱/濒危" :value="totals.weak" suffix="株" tone="danger" icon="Warning" hint="最新长势为衰弱或濒危的古树" />
      <StatBadge label="加固件超期" :value="totals.overdue" suffix="件" tone="warning" icon="Warning" hint="超过检查周期未检查的加固件" />
      <StatBadge label="排队措施" :value="totals.queued" suffix="项" tone="warning" icon="Warning" hint="超出当年级别核定工日、排队等下一批的措施" />
      <StatBadge label="筛选结果" :value="rows.length" suffix="株" tone="info" icon="PieChart" size="small" />
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">古树名木一树一档</span>
          <el-button type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>新建古树档案</span>
          </el-button>
        </div>
      </template>

      <el-alert
        class="mb-14"
        :type="access.isBureau ? 'warning' : 'success'"
        show-icon
        :closable="false"
        :title="`当前身份：${access.roleLabel}`"
        :description="access.isBureau
          ? '保护科管保护级别与长势复评结论：可在此调整级别、在「长势复评」页出结论；树体检查、复壮措施、加固件由养护班组登记，保护科改不到。'
          : '养护班组管树体检查、复壮措施与加固件：可登记检查 / 排措施 / 检查加固件；保护级别与复评结论由保护科定，班组顶不回去。'"
      />

      <FilterBar
        :keyword="treeStore.filters.keyword"
        :fields="[
          { key: 'protectLevel', label: '保护级别', options: PROTECT_LEVEL_OPTIONS as unknown as string[] },
          { key: 'species', label: '树种', options: speciesOptions },
        ]"
        :values="{ protectLevel: treeStore.filters.protectLevel, species: treeStore.filters.species }"
        :result-text="`命中 ${rows.length} / ${treeStore.trees.length} 株`"
        @update:keyword="(value: string) => treeStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="treeStore.resetFilters()"
      />

      <EmptyPanel
        v-if="treeStore.ready && treeStore.trees.length === 0"
        title="还没有古树档案"
        description="先为一株古树建立档案（编号、树种、保护级别、树龄、位置、管护单位），再登记树体检查与复壮措施。"
        action-text="新建第一个古树档案"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="!treeStore.ready"
        :data="rows"
        row-key="id"
        stripe
        @row-click="goSurveys"
      >
        <el-table-column label="编号 / 树种" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click.stop="goSurveys(row)">{{ row.code }}</el-link>
              <span class="cell-sub">{{ row.species }} · 约 {{ row.ageYears }} 年</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="保护级别（保护科）" width="150">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-tag :type="row.protectLevel === '一级' ? 'danger' : row.protectLevel === '二级' ? 'warning' : 'info'">
                {{ row.protectLevel }}
              </el-tag>
              <span v-if="row.protectLevelChangedAt !== ''" class="cell-sub">
                {{ row.protectLevelChangedAt }} 由{{ row.previousProtectLevel }}调整
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="位置 / 管护单位" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.location }}</span>
              <span class="cell-sub">{{ row.owner }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="检查次数" width="100" align="right">
          <template #default="{ row }">{{ treeStore.statOf(row.id).surveyCount }} 次</template>
        </el-table-column>
        <el-table-column label="最新长势" width="170">
          <template #default="{ row }">
            <VigorTag
              :vigor="treeStore.statOf(row.id).latestVigor"
              :trend="treeStore.statOf(row.id).latestTrend"
            />
          </template>
        </el-table-column>
        <el-table-column label="待重排 / 排队" width="140" align="center">
          <template #default="{ row }">
            <el-tooltip
              v-if="treeStore.statOf(row.id).staleSurveyCount + treeStore.statOf(row.id).staleSupportCount > 0"
              content="保护级别调整后，按旧级别安排、尚未完成的检查与加固件检查已失效，等班组重排"
              placement="top"
            >
              <el-tag type="danger" size="small" effect="dark">
                待重排 {{ treeStore.statOf(row.id).staleSurveyCount + treeStore.statOf(row.id).staleSupportCount }}
              </el-tag>
            </el-tooltip>
            <el-tooltip
              v-if="treeStore.statOf(row.id).queuedMeasureCount > 0"
              content="超出当年级别核定工日，排队等下一批"
              placement="top"
            >
              <el-tag type="warning" size="small" effect="plain" class="mt-2">
                排队 {{ treeStore.statOf(row.id).queuedMeasureCount }}
              </el-tag>
            </el-tooltip>
            <span v-if="treeStore.statOf(row.id).staleSurveyCount + treeStore.statOf(row.id).staleSupportCount === 0 && treeStore.statOf(row.id).queuedMeasureCount === 0" class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="最近复壮" width="120">
          <template #default="{ row }">
            <span v-if="treeStore.latestMeasureDateOf(row.id) === ''" class="cell-sub">未登记</span>
            <span v-else>{{ treeStore.latestMeasureDateOf(row.id) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click.stop="goSurveys(row)">树体检查</el-button>
            <el-button link type="primary" size="small" @click.stop="openEdit(row)">编辑档案</el-button>
            <el-button
              link
              :type="access.isBureau ? 'warning' : 'info'"
              size="small"
              @click.stop="access.isBureau ? openLevelDialog(row) : ElMessage.info(access.deniedMessage('bureau'))"
            >
              调级别
            </el-button>
            <el-button link type="danger" size="small" @click.stop="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 古树档案身份 / 基础字段表单（保护级别只读展示，编辑改不到） -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId === null ? '新建古树档案' : '编辑古树档案'"
      width="620px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="古树编号" prop="code">
              <el-input v-model="form.code" placeholder="如：京-01-0007" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="树种" prop="species">
              <el-select v-model="form.species" filterable allow-create style="width: 100%">
                <el-option v-for="item in speciesOptions" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="保护级别" prop="protectLevel">
              <el-select v-model="form.protectLevel" :disabled="editingId !== null" style="width: 100%">
                <el-option v-for="item in PROTECT_LEVEL_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="树龄（年）" prop="ageYears">
              <el-input-number v-model="form.ageYears" :min="1" :max="5000" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="位置" prop="location">
          <el-input v-model="form.location" placeholder="如：东城区国子监街 18 号院门前" />
        </el-form-item>
        <el-form-item label="管护单位" prop="owner">
          <el-input v-model="form.owner" placeholder="如：东城区园林绿化局" />
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          :title="editingId === null
            ? '建档时给定初始保护级别；之后级别调整由古树保护科在列表「调级别」中单独完成。'
            : '保护级别是保护科档案，本表单不允许修改；如需调整请由保护科点「调级别」。'"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 保护科专属：调整保护级别（独立小档案，只含级别 + 生效日期） -->
    <el-dialog v-model="levelDialogVisible" title="古树保护科 · 调整保护级别" width="480px">
      <el-form label-width="110px">
        <el-form-item label="新生效级别">
          <el-select v-model="levelForm.protectLevel" style="width: 100%">
            <el-option v-for="item in PROTECT_LEVEL_OPTIONS" :key="item" :value="item" :label="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="生效日期">
          <el-date-picker v-model="levelForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </el-form>
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="调整只改保护科这份"
        description="保护级别一经调整，按旧级别派出且尚未完成的树体检查、尚未检查的加固件检查立即失效，挑出等养护班组按新级别重排；已完成的检查与已确认的复壮措施照旧留住。"
      />
      <template #footer>
        <el-button @click="levelDialogVisible = false">取消</el-button>
        <el-button type="warning" :loading="submitting" @click="handleLevelSubmit">确认调整</el-button>
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

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
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
</style>
