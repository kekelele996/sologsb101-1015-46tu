<script setup lang="ts">
/**
 * <ScopeTag> 档案归属徽标
 * crew 养护班组 / bureau 古树保护科，被全部档案页面消费，直观看清这份记录归谁管。
 */
import { computed } from 'vue'
import { OWNER_SCOPE_LABEL, type OwnerScope } from '@/types/tree'

const props = withDefaults(
  defineProps<{
    scope: OwnerScope
    size?: 'default' | 'small'
  }>(),
  { size: 'default' }
)

const label = computed(() => OWNER_SCOPE_LABEL[props.scope])
</script>

<template>
  <el-tag
    :type="scope === 'bureau' ? 'warning' : 'success'"
    :effect="scope === 'bureau' ? 'dark' : 'light'"
    :size="size"
    class="scope-tag"
  >
    {{ label }}
  </el-tag>
</template>

<style scoped>
.scope-tag {
  font-weight: 600;
}
</style>
