<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal">
      <h3>⚙ 系統配置</h3>
      <div class="modal-body">
        <!-- 左侧标签 -->
        <div class="tab-list">
          <div v-for="t in tabs" :key="t.key" class="tab-item" :class="{ active: activeTab === t.key }" @click="activeTab = t.key">
            <span class="tab-icon">{{ t.icon }}</span>{{ t.label }}
          </div>
        </div>
        <!-- 右侧内容 -->
        <div class="tab-content">
          <!-- 連接 -->
          <template v-if="activeTab === 'connection'">
            <label>中控服務器地址<input v-model="local.serverUrl" class="inp" placeholder="http://localhost:3000" /></label>
            <label>AdsPower 本地地址<input v-model="local.adspowerUrl" class="inp" placeholder="http://127.0.0.1:50325" /></label>
            <label>AdsPower 分組名稱<input v-model="local.groupName" class="inp" placeholder="情报组" /></label>
          </template>
          <!-- 節點 -->
          <template v-if="activeTab === 'node'">
            <label>節點標識 (Tag)<input v-model="local.clientTag" class="inp" placeholder="node-01" /></label>
            <label>客戶端 ID<input :value="local.clientId" class="inp" disabled style="opacity:.5;cursor:not-allowed;" /></label>
          </template>
          <!-- AI -->
          <template v-if="activeTab === 'ai'">
            <label>DeepSeek API Key<input v-model="local.deepSeekApiKey" class="inp" placeholder="sk-..." /></label>
          </template>
          <!-- 風控 -->
          <template v-if="activeTab === 'risk'">
            <label>最大並發瀏覽器數<input v-model.number="local.maxConcurrent" class="inp" type="number" min="1" max="20" placeholder="5" /></label>
            <label>每推文最大回復次數（不同帳號）<input v-model.number="local.maxRepliesPerTweet" class="inp" type="number" min="1" max="50" placeholder="3" /></label>
            <label>冷卻時間（分鐘）<input v-model.number="local.cooldownMinutes" class="inp" type="number" min="1" max="1440" placeholder="30" /></label>
            <label>每日發帖上限（次）<input v-model.number="local.dailyLimit" class="inp" type="number" min="1" max="100" placeholder="5" /></label>
          </template>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" @click="save">保存配置</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
const props = defineProps({ config: Object })
const emit = defineEmits(['save', 'close'])
const local = reactive({ ...props.config })
function save() { emit('save', local) }

const activeTab = ref('connection')
const tabs = [
  { key: 'connection', icon: '🌐', label: '連接' },
  { key: 'node',       icon: '🖥',  label: '節點' },
  { key: 'ai',         icon: '🤖', label: 'AI' },
  { key: 'risk',       icon: '🛡',  label: '風控' },
]
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 620px;
  max-width: 95vw;
  height: 480px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.modal h3 {
  font-size: 16px;
  color: var(--text);
  margin: 0;
}
.modal-body {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}
.tab-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 90px;
  flex-shrink: 0;
}
.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text2);
  transition: background .15s, color .15s;
}
.tab-item:hover {
  background: var(--bg3, rgba(255,255,255,.06));
  color: var(--text);
}
.tab-item.active {
  background: rgba(255,255,255,.12);
  color: var(--text, #fff);
}
.tab-icon {
  font-size: 15px;
}
.tab-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}
.tab-content label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text2);
}
.inp {
  width: 100%;
  box-sizing: border-box;
}
.inp-prompt {
  resize: vertical;
  min-height: 120px;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 12px;
  line-height: 1.6;
  background: var(--bg, #0d1117);
  color: var(--text, #e6edf3);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 8px 10px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>

