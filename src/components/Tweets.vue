<template>
  <div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h3 class="section-title" style="margin-bottom:0">推文管理 <span style="font-size:13px;color:var(--text2);margin-left:8px">({{ tweets.length }})</span></h3>
      <div style="display:flex;align-items:center;gap:10px">
        <!-- 自动执行开关 -->
        <div class="auto-bar">
          <span class="auto-label">自動執行</span>
          <button
            class="toggle-btn"
            :class="localAutoApprove ? 'toggle-on' : 'toggle-off'"
            @click="toggleAuto()"
          >{{ localAutoApprove ? '✅ 開啟' : '⬜ 關閉' }}</button>
        </div>
        <button class="cfg-trigger" @click="showCfg = true">⚡</button>
      </div>
    </div>

    <!-- 回覆配置弹窗 -->
    <div v-if="showCfg" class="overlay" @click.self="showCfg = false">
      <div class="cfg-modal">
        <div class="cfg-header">
          <span>回覆配置</span>
          <button class="cfg-close" @click="showCfg = false">✕</button>
        </div>
        <div class="cfg-body">
          <label class="cfg-label">轉發推文連結（附加到回覆末尾）</label>
          <input v-model="draftAppendUrl" class="cfg-inp" placeholder="https://x.com/..." />
          <label class="cfg-label" style="margin-top:14px">附加文字（轉發連結之後再追加）</label>
          <textarea v-model="draftAppendText" class="cfg-inp cfg-ta" rows="4" placeholder="輸入要附加的內容..."></textarea>
        </div>
        <div class="cfg-footer">
          <button class="btn" @click="showCfg = false">取消</button>
          <button class="btn btn-primary" @click="saveCfg">保存</button>
        </div>
      </div>
    </div>

    <div v-if="!tweets.length" class="empty-hint">目前沒有待處理的推文</div>
    <table v-else class="account-table">
      <thead>
        <tr>
          <th>來源</th>
          <th>推文連結</th>
          <th>內容摘要</th>
          <th>狀態</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(t, idx) in tweets" :key="t.id || t.tweetUrl || idx">
          <td>{{ t.source || 'server' }}</td>
          <td><a :href="t.tweetUrl" target="_blank" rel="noopener">{{ t.tweetUrl }}</a></td>
          <td>{{ (t.text||t.replyText||'').slice(0,60) }}</td>
          <td>
            <span v-if="t.status === 'in_progress'" class="tag processing">處理中</span>
            <span v-else-if="t.status === 'done'" class="tag success">已完成</span>
            <span v-else-if="t.status === 'error'" class="tag error">失敗</span>
            <span v-else class="tag pending">待處理</span>
          </td>
          <td>
            <!-- 只有在运行中或已完成时禁止再次審核；error 与 pending 均可再次審核 -->
            <div v-if="t.status === 'in_progress'">
              <button class="btn" disabled>处理中</button>
            </div>
            <div v-else-if="t.status === 'done'">
              <button class="btn" disabled>已完成</button>
            </div>
            <div v-else>
              <button class="btn primary" :disabled="disabled" @click="$emit('approve', t)">
                {{ t.status === 'error' ? '重試 / 審核通過' : '審核通過' }}
              </button>
              <button class="btn btn-discard" style="margin-left:6px" @click="$emit('discard', t)">放棄</button>
              <span v-if="t.status === 'error'" style="margin-left:8px;color:var(--red);font-size:12px">上次失敗</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({ tweets: Array, disabled: Boolean, autoApprove: Boolean })
const emit = defineEmits(['approve', 'discard', 'update:replyConfig', 'toggleAutoApprove'])

// 本地状态，避免纯 prop 更新延迟导致按钮没反应
const localAutoApprove = ref(props.autoApprove)
watch(() => props.autoApprove, v => { localAutoApprove.value = v })

function toggleAuto() {
  localAutoApprove.value = !localAutoApprove.value
  emit('toggleAutoApprove', localAutoApprove.value)
}

const REPLY_CFG_KEY = 'omnimatrix_reply_config'
function loadReplyCfg() {
  try { const r = localStorage.getItem(REPLY_CFG_KEY); if (r) return JSON.parse(r) } catch {}
  return { appendUrl: '', appendText: '' }
}

const showCfg = ref(false)
const cfg = ref(loadReplyCfg())
const draftAppendUrl = ref(cfg.value.appendUrl)
const draftAppendText = ref(cfg.value.appendText)

function saveCfg() {
  cfg.value = { appendUrl: draftAppendUrl.value.trim(), appendText: draftAppendText.value.trim() }
  localStorage.setItem(REPLY_CFG_KEY, JSON.stringify(cfg.value))
  emit('update:replyConfig', cfg.value)
  showCfg.value = false
}
</script>

<style scoped>
.auto-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.auto-label {
  font-size: 12px;
  color: var(--subtext, #8b949e);
  white-space: nowrap;
}
.toggle-btn {
  padding: 4px 12px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: background 0.2s;
  white-space: nowrap;
}
.toggle-on {
  background: #40a02b;
  color: #fff;
}
.toggle-off {
  background: #313244;
  color: #888;
}
.cfg-trigger {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: border-color .15s, color .15s;
}
.cfg-trigger:hover {
  border-color: #58a6ff;
  color: #58a6ff;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.cfg-modal {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 10px;
  width: 480px;
  max-width: 95vw;
  display: flex;
  flex-direction: column;
}
.cfg-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #30363d;
  font-weight: 600;
  font-size: 15px;
}
.cfg-close {
  background: transparent;
  border: none;
  color: #8b949e;
  font-size: 16px;
  cursor: pointer;
}
.cfg-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
}
.cfg-label {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 6px;
  display: block;
}
.cfg-inp {
  background: #0d1117;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  outline: none;
  width: 100%;
}
.cfg-inp:focus { border-color: #58a6ff; }
.cfg-ta { resize: vertical; font-family: inherit; }
.btn-discard {
  border-color: rgba(248,81,73,.4);
  color: var(--red, #f85149);
}
.btn-discard:hover {
  background: rgba(248,81,73,.15);
  border-color: #f85149;
}
.cfg-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid #30363d;
}
</style>
