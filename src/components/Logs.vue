<template>
  <section>
    <div class="log-header">
      <h2 class="section-title">運行日誌</h2>
      <button class="btn btn-sm" @click="$emit('clear')">清空</button>
    </div>
    <div class="log-list">
      <div v-for="(log, i) in logs" :key="i" class="log-row" :class="`log-${log.level}`">
        <span class="log-time">{{ log.time }}</span>
        <span class="log-level">{{ log.level.toUpperCase() }}</span>
        <span class="log-msg">{{ log.msg }}</span>
      </div>
      <div v-if="logs.length === 0" class="empty-hint">日誌為空</div>
    </div>
  </section>
</template>

<script setup>
const props = defineProps({ logs: Array })
const emit = defineEmits(['clear'])
</script>
