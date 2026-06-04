<template>
  <section>
    <h2 class="section-title">帳號管理</h2>

    <div v-if="accounts.length === 0" class="empty-hint">尚無帳號，請在配置中設定 AdsPower 並同步帳號</div>
    <table v-else class="account-table">
      <thead><tr><th>順序</th><th>Serial</th><th>備註</th><th>狀態</th><th>今日次數</th><th>剩餘冷卻</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="(acc, idx) in accounts" :key="acc.serial">
          <td class="seq-num">{{ idx + 1 }}</td>
          <td><code>{{ acc.serial }}</code></td>
          <td>{{ acc.remark || '—' }}</td>
          <td><span class="tag" :class="statusClass(acc.status)">{{ statusLabel(acc.status) }}</span></td>
          <td>{{ acc.todayCount }} / {{ dailyLimit }}</td>
          <td>{{ cooldownRemain(acc) || '—' }}</td>
          <td>
            <button v-if="acc.status === 'error'" class="btn-del" @click="$emit('restore', acc.serial)">解除異常</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup>
const props = defineProps({ accounts: Array, dailyLimit: Number })
const emit = defineEmits(['restore'])

function statusLabel(s){ return { idle:'空閒', running:'執行中', cooling:'冷卻', error:'異常' }[s] || s }
function statusClass(s){ return { idle:'tag-idle', running:'tag-run', cooling:'tag-cool', error:'tag-ban' }[s] || '' }
function cooldownRemain(acc){ if (!acc.cooldownUntil) return ''; const ms = acc.cooldownUntil - Date.now(); if (ms<=0) return '即將解除'; return `${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s` }
</script>

<style scoped>
.seq-num {
  color: var(--subtext, #6c7086);
  font-size: 12px;
  text-align: center;
  width: 36px;
}
</style>
