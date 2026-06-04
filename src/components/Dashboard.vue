<template>
  <section>
    <h2 class="section-title">系統概況</h2>
    <div class="stat-grid">
      <div class="stat-card">        <div class="stat-num">{{ stats.total }}</div>  <div class="stat-label">總帳號數</div></div>
      <div class="stat-card green">  <div class="stat-num">{{ stats.idle }}</div>   <div class="stat-label">空閒可用</div></div>
      <div class="stat-card blue">   <div class="stat-num">{{ stats.running }}</div><div class="stat-label">執行中</div></div>
      <div class="stat-card yellow"> <div class="stat-num">{{ stats.cooling }}</div><div class="stat-label">待處理推文</div></div>
      <div class="stat-card red">    <div class="stat-num">{{ stats.error ?? 0 }}</div> <div class="stat-label">異常帳號</div></div>
    </div>
    <h2 class="section-title mt">連接狀態</h2>
    <div class="info-card">
      <div class="info-row"><span>中控地址</span><code>{{ config.serverUrl }}</code></div>
      <div class="info-row"><span>AdsPower</span><code>{{ config.adspowerUrl }}</code></div>
      <div class="info-row"><span>節點標識</span><code>{{ config.clientTag }}</code></div>
      <div class="info-row"><span>心跳狀態</span><span>{{ heartbeatDot }} {{ heartbeatStatus }}<span v-if="heartbeatLatency"> · {{ heartbeatLatency }}ms</span></span></div>
      <div class="info-row"><span>並發實例</span><code>{{ stats.maxConcurrent ?? 5 }} 個</code></div>
      <div class="info-row"><span>風控規則</span><code>冷卻 {{ stats.cooldownMinutes ?? 30 }} 分鐘 · 每日上限 {{ stats.dailyLimit ?? 5 }} 次</code></div>
  
    </div>
  </section>
</template>

<script setup>
const props = defineProps({ config: Object, stats: Object, heartbeatDot: String, heartbeatStatus: String, heartbeatLatency: [Number, String] })
</script>
