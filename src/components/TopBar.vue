<template>
  <header class="topbar">
    <div class="drag-region" data-tauri-drag-region></div>
    <div class="topbar-left">
      <img class="brand-logo" src="/logo.png" alt="logo" />
      <span class="brand">OmniMatrix</span>
      <span class="client-id">v {{ appVersion }}</span>
    </div>
    <nav class="tabs">
      <button :class="{ active: activeTab === 'dashboard' }" @click="$emit('change-tab','dashboard')">儀表盤</button>
      <button :class="{ active: activeTab === 'tweets' }" @click="$emit('change-tab','tweets')">推文管理</button>
      <button :class="{ active: activeTab === 'accounts' }"  @click="$emit('change-tab','accounts')">帳號管理</button>
      <button :class="{ active: activeTab === 'logs' }"      @click="$emit('change-tab','logs')">運行日誌</button>
    </nav>
    <div class="topbar-right">
      <span>{{ heartbeatDot }}</span>
      <span class="server-label">{{ serverOnline ? '中控在線' : '中控離線' }}</span>
      <!-- <span v-if="heartbeatLatency" class="latency">{{ heartbeatLatency }}ms</span> -->
      <button class="btn-icon no-drag" @click="$emit('open-config')" title="設定">⚙</button>
      <div class="win-controls">
        <button class="wc-btn wc-min no-drag" @click="$emit('minimize')" title="最小化"></button>
        <button class="wc-btn wc-close no-drag" @click="$emit('close')" title="關閉"></button>
      </div>
    </div>
  </header>
</template>

<script setup>
const props = defineProps({
  config: Object,
  appVersion: String,
  heartbeatDot: String,
  heartbeatLatency: [Number, String],
  serverOnline: Boolean,
  activeTab: String,
})
</script>

<style scoped>
/* 组件不重复定义样式，使用 App.vue 的全局样式 */
</style>
