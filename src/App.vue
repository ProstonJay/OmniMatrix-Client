<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { check as checkUpdate } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import pkg from '../package.json'

import TopBar from './components/TopBar.vue'
import Dashboard from './components/Dashboard.vue'
import Accounts from './components/Accounts.vue'
import Logs from './components/Logs.vue'
import ConfigModal from './components/ConfigModal.vue'
import Tweets from './components/Tweets.vue'

// AdsPower 請求用 Rust native_get/native_post（invoke），完全繞過 WebView CORS 和 plugin-http scope 限制
// Server 請求用 window.fetch（localhost，無 CORS）
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const isAdsRequest = url.includes('127.0.0.1') || url.includes('adspower')
  if (isAdsRequest) {
    // 走 Rust reqwest，無任何 CORS/scope 問題
    const method = (options.method || 'GET').toUpperCase()
    let text
    if (method === 'POST') {
      text = await invoke('native_post', { url, body: options.body || '{}', headers: null })
    } else {
      text = await invoke('native_get', { url })
    }
    // 包裝成 fetch-like Response
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) }
  }
  // Server 請求走 window.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const { signal: _ignored, ...rest } = options
  return window.fetch(url, { ...rest, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// 模組頂層緩存，避免重複調用
const appWin = getCurrentWindow()
const appVersion = pkg?.version || '0.0.0'

// ─── 异步持久化存储（替代 localStorage，完全不阻塞 UI 线程）
async function storageRead(key) {
  try { return await invoke('store_read', { key }) } catch { return null }
}
function storageWrite(key, value) {
  // fire-and-forget，不阻塞调用方
  invoke('store_write', { key, value: JSON.stringify(value) }).catch(() => {})
}

// ─── 配置與狀態
const STORAGE_KEY = 'omnimatrix_config'
const DEFAULT_CONFIG = () => ({ clientId: `client_${Math.random().toString(36).slice(2, 9)}`, serverUrl: 'http://localhost:3000', adspowerUrl: 'http://127.0.0.1:50325', clientTag: 'node-01', groupName: '情报组', maxConcurrent: 5, cooldownMinutes: 30, dailyLimit: 5, maxRepliesPerTweet: 1 })
function saveConfig() { storageWrite(STORAGE_KEY, config) }
const config = reactive(DEFAULT_CONFIG())

const activeTab = ref('dashboard')
const showConfigPanel = ref(false)

// ─── 启动蒙版
const splashVisible = ref(true)
const splashMsg = ref('检测更新中...')
const splashIsUpdating = ref(false)
const logs = ref([])
function addLog(level, msg) { const time = new Date().toLocaleTimeString('zh-TW', { hour12: false }); logs.value.unshift({ time, level, msg }); if (logs.value.length > 200) logs.value.pop() }

const ACCOUNTS_KEY = 'omnimatrix_accounts'
const localAccounts = ref([])
function saveAccounts() { storageWrite(ACCOUNTS_KEY, localAccounts.value) }

function addAccount(payload) { const serial = payload.serial; if (!serial) return addLog('warn', '空 serial'); if (localAccounts.value.some(a => a.serial === serial)) { addLog('warn', `帳號 ${serial} 已存在`); return } localAccounts.value.push({ serial, remark: payload.remark || '', status: 'idle', lastRunAt: null, todayCount: 0, cooldownUntil: null }); saveAccounts(); addLog('info', `新增帳號 ${serial}`) }
function removeAccount(serial) { localAccounts.value = localAccounts.value.filter(a => a.serial !== serial); saveAccounts(); addLog('warn', `移除帳號 ${serial}`) }

// 在啟動時將所有帳號狀態重置為空閒（保留今日次數與冷卻時間），除非帳號為異常或仍在冷卻中
function normalizeAccountsOnStartup() {
  const now = Date.now(); let changed = false; for (const acc of localAccounts.value) {
    if (acc.status === 'error') continue; if (acc.cooldownUntil && acc.cooldownUntil > now) { acc.status = 'cooling' } else {
      if (acc.status !== 'idle') { acc.status = 'idle'; changed = true } // 保留 todayCount 與 lastRunAt 不變
      if (acc.cooldownUntil && acc.cooldownUntil <= now) acc.cooldownUntil = null
    }
  }
  if (changed) saveAccounts()
  // 清除上次遺留的 in_progress 推文，重置為 pending 重新等待審核
  tweets.value = tweets.value.map(t => t.status === 'in_progress' ? { ...t, status: 'pending' } : t)
  addLog('info', '啟動時已重置帳號執行狀態為空閒（保留今日次數）')
}

// 心跳/冷卻/任務等保持不變
const heartbeatStatus = ref('idle')
const heartbeatLatency = ref(null)
const isPaused = ref(false)
const serverOnline = ref(false)
let heartbeatTimer = null; let cooldownTimer = null
const COOLDOWN_MS = computed(() => (Number(config.cooldownMinutes) || 30) * 60 * 1000); const DAILY_LIMIT = computed(() => Number(config.dailyLimit) || 5)
const adsLoaded = ref(false)
const adsPollInterval = ref(60000) // 60s 默认轮询
let adsPollTimer = null

const tweets = ref([])

// 账号顺序轮转索引：严格按账号数组顺序依次执行，冷却完成不插队
const currentRoundIdx = ref(0)
// 自动执行开关：开启后推文入队自动派发，无需人工审核
const autoApprove = ref(false)
const AUTO_APPROVE_KEY = 'omnimatrix_auto_approve'

// 回覆附加配置（轉發連結 + 附加文字）
const REPLY_CFG_KEY = 'omnimatrix_reply_config'
const replyConfig = reactive({ appendUrl: '', appendText: '' })
// 当 replyConfig 更新时异步保存
function saveReplyConfig() { storageWrite(REPLY_CFG_KEY, replyConfig) }

// 去重添加推文到队列，避免重复 URL
function addTweetIfNotExists({ id, tweetUrl, text, replyText, status }) {
  if (!tweetUrl) return false
  if (tweets.value.some(t => t.tweetUrl === tweetUrl)) {
    addLog('warn', `推文已存在隊列: ${tweetUrl}`)
    return false
  }
  tweets.value.unshift({ id: id || `${Date.now()}`, tweetUrl, text: text || '', status: status || 'pending', replyText: replyText || '' })
  // 自动执行：入队后立即派发
  if (autoApprove.value) {
    const newTweet = tweets.value[0]
    nextTick(() => onApproveTweet(newTweet))
  }
  return true
}

// 并发控制
const MAX_CONCURRENT = computed(() => Number(config.maxConcurrent) || 5)
const activeCount = ref(0)
const waitQueue = []
function acquireSlot() { return new Promise(resolve => { if (activeCount.value < MAX_CONCURRENT.value) { activeCount.value++; resolve() } else { waitQueue.push(resolve) } }) }
function releaseSlot() { if (waitQueue.length > 0) { waitQueue.shift()() } else { activeCount.value-- } }

async function loadAccountsFromAds(groupName) {
  // 优先使用传入参数，否则使用配置中的 groupName
  const targetGroup = groupName || config.groupName || '情报组'
  if (!config.adspowerUrl) return
  try {
    const gUrl = `${config.adspowerUrl.replace(/\/$/, '')}/api/v1/group/list?group_name=${encodeURIComponent(targetGroup)}&page_size=1`
    addLog('info', `[AdsPower] 請求 URL: ${gUrl}`)
    let gRes, gJson
    try {
      gRes = await fetchWithTimeout(gUrl, {}, 8000)
      addLog('info', `[AdsPower] HTTP 狀態: ${gRes.status} ${gRes.statusText}`)
      const rawText = await gRes.text()
      addLog('info', `[AdsPower] 原始回應: ${rawText.slice(0, 300)}`)
      try { gJson = JSON.parse(rawText) } catch { addLog('error', `[AdsPower] JSON 解析失敗，原始內容: ${rawText.slice(0, 200)}`); return }
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      addLog('error', `[AdsPower] 請求失敗: ${msg}（adspowerUrl=${config.adspowerUrl}，確認 AdsPower 已啟動且端口正確）`)
      return
    }
    if (gJson.code !== 0) {
      addLog('error', `AdsPower 返回錯誤代碼: ${gJson.code}, 訊息: ${gJson.msg}`);
      return;
    }
    if (!gJson.data?.list?.length) {
      addLog('warn', `找不到分組: ${targetGroup}，請確認分組名稱是否完全一致！`);
      return;
    }
    if (!gJson || gJson.code !== 0 || !gJson.data?.list?.length) {
      addLog('warn', `未能從 AdsPower 讀取分組 ${targetGroup}`)
      return
    }
    const groupId = gJson.data.list[0].group_id
    const uUrl = `${config.adspowerUrl.replace(/\/$/, '')}/api/v1/user/list?group_id=${groupId}&page_size=500`
    const uRes = await fetchWithTimeout(uUrl, {}, 8000)
    const uJson = await uRes.json().catch(() => null)
    if (!uJson || uJson.code !== 0) { addLog('warn', '從 AdsPower 讀取帳號列表失敗'); return }
    const users = uJson.data?.list || []

    // 增量合并逻辑
    const existing = new Map(localAccounts.value.map(a => [a.serial, a]))
    const incoming = new Map(users.map(u => [String(u.serial_number || u.user_id), u]))

    // 添加或更新
    for (const [id, u] of incoming.entries()) {
      const serial = String(id)
      if (existing.has(serial)) {
        const acc = existing.get(serial)
        acc.remark = u.remark || acc.remark
      } else {
        localAccounts.value.push({ serial, remark: u.remark || '', status: 'idle', lastRunAt: null, todayCount: 0, cooldownUntil: null })
        addLog('info', `新增帳號: ${serial}`)
      }
    }
    // 删除不在 incoming 的旧账号
    for (const [serial, acc] of existing.entries()) {
      if (!incoming.has(serial)) {
        localAccounts.value = localAccounts.value.filter(a => a.serial !== serial)
        addLog('warn', `帳號已被 Ads 刪除: ${serial}`)
      }
    }

    saveAccounts()
    adsLoaded.value = true
    addLog('info', `從 AdsPower 同步 ${localAccounts.value.length} 個帳號`)
  } catch (e) { const emsg = e instanceof Error ? e.message : (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e) ?? String(e) ?? '未知錯誤')); addLog('error', `加載 AdsPower 帳號失敗: ${emsg}`) }
}

function startAdsPoll() { stopAdsPoll(); adsPollTimer = setInterval(() => loadAccountsFromAds().catch(() => { }), adsPollInterval.value) }
function stopAdsPoll() { if (adsPollTimer) clearInterval(adsPollTimer); adsPollTimer = null }

async function sendHeartbeat() { if (!config.serverUrl) return; const t0 = Date.now(); try { const res = await fetchWithTimeout(`${config.serverUrl}/api/clients/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: config.clientId, clientName: config.clientTag, type: 'soldier', accountCount: localAccounts.value.length, errorCount: localAccounts.value.filter(a => a.status === 'error').length, ts: Date.now() }) }, 4000); heartbeatLatency.value = Date.now() - t0; if (res.ok) { const data = await res.json().catch(() => ({})); heartbeatStatus.value = 'ok'; serverOnline.value = true; if (data.pause !== undefined) { isPaused.value = !!data.pause; if (isPaused.value) addLog('warn', '⏸ 中控下發暫停指令'); else addLog('info', '▶ 中控恢復執行指令') } } else throw new Error(`HTTP ${res.status}`) } catch (err) { heartbeatStatus.value = 'error'; serverOnline.value = false; heartbeatLatency.value = null; const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err) ?? String(err) ?? '未知錯誤')); addLog('error', `心跳失敗：${msg}`) } }

function isSameDay(ts) { if (!ts) return false; const d = new Date(ts), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate() }
async function runCooldownScan() { if (isPaused.value) return; const now = Date.now(); for (const acc of localAccounts.value) { if (acc.lastRunAt && !isSameDay(acc.lastRunAt)) { acc.todayCount = 0; addLog('info', `[${acc.serial}] 跨日重置計數`) } if (acc.status === 'cooling' && acc.cooldownUntil && now >= acc.cooldownUntil) { acc.status = 'idle'; acc.cooldownUntil = null; addLog('info', `[${acc.serial}] 冷卻完畢，進入空閒`) } if (acc.todayCount >= DAILY_LIMIT.value && acc.status === 'idle') { acc.status = 'cooling'; addLog('warn', `[${acc.serial}] 今日已達 ${DAILY_LIMIT.value} 次上限，等待次日`) } } saveAccounts(); const ready = localAccounts.value.filter(a => a.status === 'idle'); if (ready.length > 0) await dispatchTask(ready[0]); if (autoApprove.value) autoDispatchPending() }

async function dispatchTask(acc) { if (!serverOnline.value) return; try { const res = await fetchWithTimeout(`${config.serverUrl}/api/tasks/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: config.clientId, accountSerial: acc.serial }) }, 5000); if (!res.ok) return; const task = await res.json().catch(() => null); if (!task?.taskId) return; addLog('info', `[${acc.serial}] 🎯 搶到任務 ${task.taskId}，開始執行`); await executeTask(acc, task) } catch { } }

async function executeTask(acc, task) { acc.status = 'running'; saveAccounts(); try { const openRes = await fetchWithTimeout(`${config.adspowerUrl}/api/v1/browser/start?serial_number=${acc.serial}`, {}, 10000); const openData = await openRes.json(); if (openData.code !== 0) throw new Error(`AdsPower 啟動失敗: ${openData.msg}`); addLog('info', `[${acc.serial}] 🌐 AdsPower 已啟動`); await sleep(3000); await fetchWithTimeout(`${config.serverUrl}/api/accounts/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: config.clientId, accountSerial: acc.serial, taskId: task.taskId, status: 'done', ts: Date.now() }) }, 5000); addLog('info', `[${acc.serial}] ✅ 任務 ${task.taskId} 上報完成`); acc.lastRunAt = Date.now(); acc.todayCount = (acc.todayCount || 0) + 1; acc.status = 'cooling'; acc.cooldownUntil = Date.now() + COOLDOWN_MS.value; addLog('info', `[${acc.serial}] ⏳ 進入 ${config.cooldownMinutes || 30} 分鐘冷卻 (今日第 ${acc.todayCount} 次)`) } catch (err) { acc.status = 'idle'; addLog('error', `[${acc.serial}] 任務執行失敗: ${err.message}`) } saveAccounts() }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchTweetTask() {
  try {
    const res = await fetchWithTimeout(`${config.serverUrl}/api/tasks/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: config.clientId }) }, 5000)
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) {
      if (body?.code === 'PAUSED') { isPaused.value = true; addLog('warn', `⏸ 服務端暫停: ${body.msg || ''}`) }
      else if (body?.code === 'EMPTY') { addLog('info', '📭 推文池暫無任務') }
      else { addLog('warn', `拉取推文失敗 HTTP ${res.status}: ${body?.msg || body?.error || JSON.stringify(body)}`) }
      return
    }
    const tweet = body.tweet
    const tweetUrl = tweet?.url
    const text = tweet?.text || tweet?.replyText || ''
    const taskId = tweet?.taskId || tweet?.task_id || `task_${Date.now()}`
    if (tweetUrl) {
      const added = addTweetIfNotExists({ id: taskId, tweetUrl, text, replyText: text })
      if (added) addLog('info', `收到推文任務: ${tweetUrl}（來自 ${tweet?.submittedBy || '未知'}）`)
    } else {
      addLog('warn', 'fetch 未返回推文連結')
    }
  } catch (e) { const emsg = e instanceof Error ? e.message : (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e) ?? String(e) ?? '未知錯誤')); addLog('error', `拉取推文任務失敗: ${emsg}`) }
}

// 当有空闲账户且有待处理推文时触发拉取任务
async function ensureFetchTasks() {
  if (!serverOnline.value) { addLog('warn', '[fetch] 服務器離線，跳過拉取'); return }
  if (isPaused.value) { addLog('warn', '[fetch] 已暫停，跳過拉取'); return }
  const idleAccounts = localAccounts.value.filter(a => a.status === 'idle' && (a.todayCount || 0) < DAILY_LIMIT.value)
  if (idleAccounts.length === 0) {
    const total = localAccounts.value.length
    const statusSummary = ['idle','running','cooling','error'].map(s => `${s}:${localAccounts.value.filter(a=>a.status===s).length}`).join(' ')
    addLog('info', `[fetch] 無可用帳號，跳過拉取（共 ${total} 個，${statusSummary}）`)
    return
  }
  const pendingTweets = tweets.value.filter(t => t.status === 'pending' || t.status === 'in_progress')
  if (pendingTweets.length >= idleAccounts.length) {
    addLog('info', `[fetch] 推文隊列(${pendingTweets.length})已覆蓋空閒帳號(${idleAccounts.length})，暫不拉取`)
    return
  }
  addLog('info', `[fetch] 空閒帳號 ${idleAccounts.length} 個，隊列推文 ${pendingTweets.length} 條，拉取補充`)
  await fetchTweetTask()
}

//核心業務邏輯：生成回复 ➡️ 開瀏覽器 ➡️ Playwright 腳本發帖
async function doReplyWithAccount(tweet, acc) {
  await acquireSlot()
  acc.status = 'running'
  saveAccounts()

  try {
    // 1. 调用 Rust invoke → Node.js replyTweet.js
    //    脚本内部：启动浏览器 → 抓推文内容 → 调 DeepSeek → 回复 → 关闭浏览器
    if (!config.deepSeekApiKey) throw new Error('未配置 DeepSeek API Key')
    const adsBase = config.adspowerUrl.replace(/\/$/, '')
    let scriptPath
    try {
      const { resourceDir } = await import('@tauri-apps/api/path')
      const dir = await resourceDir()
      scriptPath = dir.replace(/[/\\]$/, '') + '\\scripts\\replyTweet.js'
    } catch {
      const base = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
      scriptPath = base.replace(/[/\\]src[/\\]?$/, '') + '\\scripts\\replyTweet.js'
    }

    addLog('info', `[${acc.serial}] 呼叫 Playwright 腳本: ${scriptPath}`)
    let resultStr
    try {
      resultStr = await invoke('run_reply_script', {
        scriptPath,
        serial: acc.serial,
        adsBase,
        tweetUrl: tweet.tweetUrl,
        deepseekKey: config.deepSeekApiKey,
        systemPrompt: '',
        appendUrl: replyConfig.appendUrl || '',
        appendText: replyConfig.appendText || '',
      })
    } catch (invokeErr) {
      addLog('error', `[${acc.serial}] invoke 原始錯誤: ${JSON.stringify(invokeErr)} | ${String(invokeErr)}`)
      throw new Error(typeof invokeErr === 'string' ? invokeErr : JSON.stringify(invokeErr))
    }

    let result
    try { result = JSON.parse(resultStr) } catch { throw new Error(`腳本返回格式錯誤: ${resultStr}`) }

    // AI 审核不通过（内容不符合目标主题）→ 丢弃推文，账号正常回 idle
    if (!result.success && result.discard) {
      tweets.value = tweets.value.filter(t => t !== tweet)
      acc.status = 'idle'
      addLog('warn', `[${acc.serial}] 推文內容不符合目標主題，已自動丟棄: ${result.reason || ''}`)
      saveAccounts()
      releaseSlot()
      return
    }

    if (!result.success) throw new Error(result.error || '腳本執行失敗')

    // 4. 結算
    // 如果腳本回傳 success 且有 tweetId => 成功
    if (result.tweetId) {
      tweet.replyCount = (tweet.replyCount || 0) + 1
      // 记录已回复过的账号，防止同账号重复回复同一推文
      if (!tweet.repliedBy) tweet.repliedBy = []
      if (!tweet.repliedBy.includes(acc.serial)) tweet.repliedBy.push(acc.serial)
      const maxReplies = Number(config.maxRepliesPerTweet) || 3
      addLog('info', `[${acc.serial}] ✅ 發帖成功! tweetId: ${result.tweetId}（${tweet.replyCount}/${maxReplies} 次）`)

      if (tweet.replyCount >= maxReplies) {
        // 已达回复上限，标为完成并从队列移除
        tweet.status = 'done'
        tweets.value = tweets.value.filter(t => t !== tweet)
        addLog('info', `推文已完成 ${maxReplies} 次回複，從佇列移除`)
      } else {
        // 未达上限，重置为 pending 等待下一个账号继续回复
        tweet.status = 'pending'
        addLog('info', `推文還需 ${maxReplies - tweet.replyCount} 次回複，保留在佇列`)
      }

      // 成功才進入冷卻與計數
      acc.lastRunAt = Date.now()
      acc.todayCount = (acc.todayCount || 0) + 1
      acc.status = 'cooling'
      acc.cooldownUntil = Date.now() + COOLDOWN_MS.value
    } else {
      // 未取得 tweetId 視為失敗，推文重置 pending 等下次重試，帳號標為異常需人工檢查
      tweet.status = 'pending'
      acc.status = 'error'
      acc.cooldownUntil = null
      addLog('warn', `[${acc.serial}] 發帖未返回 tweetId，推文重置待審核，帳號標為異常`)
    }

    // 5. 上報中控（可選，失敗不影響主流程）
    if (config.serverUrl) {
      fetchWithTimeout(`${config.serverUrl}/api/accounts/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: config.clientId, accountSerial: acc.serial, tweetUrl: tweet.tweetUrl, tweetId: result.tweetId, status: 'done', ts: Date.now() })
      }, 5000).catch(() => { })
    }

  } catch (err) {
    // 失败推文重置为 pending，等待下次有空闲账号时重试
    tweet.status = 'pending'
    addLog('error', `[${acc.serial}] 原始錯誤: ${JSON.stringify(err)} | type: ${typeof err} | str: ${String(err)}`)
    const msg = err instanceof Error ? err.message
      : (typeof err === 'string' ? err
        : (err?.message ?? JSON.stringify(err) ?? String(err) ?? '未知錯誤'))

    // 区分可重试的临时错误 vs 需要人工检查的账号异常
    const isTransient = /proxy|check proxy|network|timeout|ECONNREFUSED|ETIMEDOUT|fetch|启动失败/i.test(msg)
    if (isTransient) {
      // 临时网络/代理问题 → 账号回 idle，下次自动重试，不需要人工干预
      acc.status = 'idle'
      addLog('warn', `[${acc.serial}] 臨時錯誤（代理/網絡），帳號回空閒等待重試: ${msg}`)
    } else {
      // 真正的账号异常（登录失效等）→ 标为 error，需人工检查
      acc.status = 'error'
      addLog('error', `[${acc.serial}] 發帖失敗: ${msg}，帳號已標為異常需人工檢查`)
    }
  }

  saveAccounts()
  releaseSlot()
}

async function onApproveTweet(tweet) {
  if (tweet.status === 'in_progress' || tweet.status === 'done') return
  const repliedSerials = tweet.repliedBy || []

  // 严格顺序执行：从 currentRoundIdx 开始找下一个尚未回复过此推文且状态为 idle 的账号
  // 冷却中的账号不插队，必须等整轮跑完再回到头部
  const accounts = localAccounts.value
  const total = accounts.length
  let candidate = null
  let candidateIdx = -1

  for (let i = 0; i < total; i++) {
    const idx = (currentRoundIdx.value + i) % total
    const acc = accounts[idx]
    if (
      acc.status === 'idle' &&
      (acc.todayCount || 0) < DAILY_LIMIT.value &&
      !repliedSerials.includes(acc.serial)
    ) {
      candidate = acc
      candidateIdx = idx
      break
    }
  }

  if (!candidate) {
    addLog('warn', '沒有可用帳號進行發帖（所有帳號冷卻中或已達上限）')
    return
  }

  // 推进轮转索引到下一个位置，下次从此账号之后开始找
  currentRoundIdx.value = (candidateIdx + 1) % total

  tweet.status = 'in_progress'
  addLog('info', `審核通過，指派帳號 ${candidate.serial}（順序第 ${candidateIdx + 1} 個）去發帖`)
  doReplyWithAccount(tweet, candidate).catch(e => addLog('error', `派發發帖任務異常: ${e.message}`))
}

function onToggleAutoApprove(v) {
  autoApprove.value = v
  storageWrite(AUTO_APPROVE_KEY, v)
  addLog('info', `自動執行模式已${v ? '開啟' : '關閉'}`)
  // 开启时立即扫描待处理推文触发执行
  if (v) autoDispatchPending()
}

// 自动派发所有待处理推文（自动执行模式专用）
// 严格限制：每次最多派发 min(空闲账号数, 剩余并发槽位数) 条，防止同一账号被重复分配
function autoDispatchPending() {
  const idleAccounts = localAccounts.value.filter(
    a => a.status === 'idle' && (a.todayCount || 0) < DAILY_LIMIT.value
  )
  // 可用槽位 = 并发上限 - 当前运行数，与空闲账号数取较小值
  const availableSlots = Math.max(0, Math.min(
    idleAccounts.length,
    MAX_CONCURRENT.value - activeCount.value
  ))
  if (availableSlots === 0) return

  const pending = tweets.value.filter(t => t.status === 'pending')
  // 只取前 availableSlots 条，其余等下次定时扫描再派发
  const toDispatch = pending.slice(0, availableSlots)
  for (const t of toDispatch) {
    onApproveTweet(t)
  }
}
function onRestoreAccount(serial) {
  const acc = localAccounts.value.find(a => a.serial === serial)
  if (!acc) { addLog('warn', `解除異常失敗: 找不到帳號 ${serial}`); return }
  acc.status = 'idle'
  acc.cooldownUntil = null
  addLog('info', `帳號 ${serial} 已解除異常，設為空閒`)
  saveAccounts()
}

onMounted(async () => {
  // ── 第一步：检查更新（含蒙版），完成后再执行初始化
  await checkAppUpdateOnStartup()

  // ── 第二步：从 Tauri store 异步加载持久化数据
  const [rawCfg, rawAccounts, rawReply] = await Promise.all([
    storageRead(STORAGE_KEY),
    storageRead(ACCOUNTS_KEY),
    storageRead(REPLY_CFG_KEY),
  ])

  // 加载 config（Tauri store 优先，fallback localStorage，再 fallback 默认值）
  const savedCfg = rawCfg
    ? (() => { try { return JSON.parse(rawCfg) } catch { return null } })()
    : (() => { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null } catch { return null } })()
  if (savedCfg) {
    Object.assign(config, savedCfg)
    if (!rawCfg) storageWrite(STORAGE_KEY, config) // 迁移旧数据到 Tauri store
  } else {
    storageWrite(STORAGE_KEY, config) // 首次启动写入默认值
  }

  // 加载 accounts
  const savedAccounts = rawAccounts
    ? (() => { try { return JSON.parse(rawAccounts) } catch { return null } })()
    : (() => { try { const r = localStorage.getItem(ACCOUNTS_KEY); return r ? JSON.parse(r) : null } catch { return null } })()
  if (savedAccounts) {
    localAccounts.value = savedAccounts
    if (!rawAccounts) storageWrite(ACCOUNTS_KEY, localAccounts.value) // 迁移
  }

  // 加载 replyConfig
  const savedReply = rawReply
    ? (() => { try { return JSON.parse(rawReply) } catch { return null } })()
    : (() => { try { const r = localStorage.getItem(REPLY_CFG_KEY); return r ? JSON.parse(r) : null } catch { return null } })()
  if (savedReply) {
    Object.assign(replyConfig, savedReply)
    if (!rawReply) storageWrite(REPLY_CFG_KEY, replyConfig) // 迁移
  }

  addLog('info', `🚀 OmniMatrix Client 啟動 [${config.clientId}]`)
  // 加载 autoApprove
  try { const raw = await storageRead(AUTO_APPROVE_KEY); if (raw !== null) autoApprove.value = JSON.parse(raw) } catch {}
  normalizeAccountsOnStartup()
  await loadAccountsFromAds().catch(() => { })
  startAdsPoll()
  sendHeartbeat(); heartbeatTimer = setInterval(sendHeartbeat, 5000); cooldownTimer = setInterval(runCooldownScan, 10000)
  setInterval(() => ensureFetchTasks().catch(() => { }), 5000)
  // 所有初始化完成，隐藏启动蒙版
  splashVisible.value = false
})
onUnmounted(() => { clearInterval(heartbeatTimer); clearInterval(cooldownTimer); stopAdsPoll() })

function onSaveConfig(newCfg) {
  Object.assign(config, newCfg); saveConfig(); showConfigPanel.value = false; addLog('info', '💾 配置已保存，重新連接中...'); sendHeartbeat();
  // 立即根据新配置刷新并重启轮询
  loadAccountsFromAds().catch(() => { })
  stopAdsPoll(); startAdsPoll()
}

// ─── 自动更新
const updateAvailable = ref(false)
const updateVersion = ref('')
const updateDownloading = ref(false)

// 启动时更新检查（含蒙版流程），检查/更新完成后才进入初始化
async function checkAppUpdateOnStartup() {
  try {
    splashMsg.value = '检测更新中...'
    splashIsUpdating.value = false
    const update = await checkUpdate()
    if (update) {
      updateAvailable.value = true
      updateVersion.value = update.version
      splashIsUpdating.value = true
      splashMsg.value = `发现新版本 v${update.version}，更新中...`
      await update.downloadAndInstall()
      splashMsg.value = '更新完成，即将重启...'
      await new Promise(r => setTimeout(r, 1500))
      await relaunch()
      // relaunch 后不会继续执行
    }
    // 无更新，直接返回继续初始化
  } catch (e) {
    splashMsg.value = `检测更新失败，跳过...`
    await new Promise(r => setTimeout(r, 1000))
  }
}

// 顶栏手动触发更新（已进入主界面后使用）
async function doUpdate() {
  if (updateDownloading.value) return
  updateDownloading.value = true
  addLog('info', `⬇️ 開始下載更新 v${updateVersion.value}...`)
  try {
    const update = await checkUpdate()
    if (!update) { addLog('warn', '更新資訊已失效，請重試'); updateDownloading.value = false; return }
    await update.downloadAndInstall()
    addLog('info', '✅ 更新下載完成，即將重啟...')
    await new Promise(r => setTimeout(r, 1500))
    await relaunch()
  } catch (e) {
    addLog('error', `更新失敗: ${e?.message || e}`)
    updateDownloading.value = false
  }
}

async function onMinimize() { try { await appWin.minimize() } catch (e) { addLog('error', `最小化失敗: ${e.message}`) } }
async function onClose() { try { await appWin.close() } catch (e) { addLog('error', `關閉失敗: ${e.message}`) } }

const stats = computed(() => ({
  total: localAccounts.value.length, idle: localAccounts.value.filter(a => a.status === 'idle').length, running: localAccounts.value.filter(a => a.status === 'running').length,
  cooling: tweets.value.length,
  error: localAccounts.value.filter(a => a.status === 'error').length,
  activeCount: activeCount.value,
  maxConcurrent: MAX_CONCURRENT.value,
  cooldownMinutes: Number(config.cooldownMinutes) || 30,
  dailyLimit: Number(config.dailyLimit) || 5
}))
const heartbeatDot = computed(() => ({ ok: '🟢', error: '🔴', idle: '⚪', paused: '🟡' }[heartbeatStatus.value] || '⚪'))

</script>

<template>
  <div class="app">
    <!-- 启动蒙版：检测更新 / 更新中 -->
    <Transition name="splash-fade">
      <div v-if="splashVisible" class="splash-overlay">
        <div class="splash-box">
          <div class="splash-logo">⚡</div>
          <p class="splash-title">OmniMatrix</p>
          <div class="splash-spinner"></div>
          <p class="splash-msg">{{ splashMsg }}</p>
          <p v-if="splashIsUpdating" class="splash-updating">正在下载安装，请勿关闭...</p>
          <p class="splash-version">v{{ appVersion }}</p>
        </div>
      </div>
    </Transition>
    <TopBar :config="config" :appVersion="appVersion" :heartbeatDot="heartbeatDot" :heartbeatLatency="heartbeatLatency"
      :serverOnline="serverOnline" :activeTab="activeTab" :updateAvailable="updateAvailable" :updateVersion="updateVersion" :updateDownloading="updateDownloading"
      @change-tab="activeTab = $event" @open-config="showConfigPanel = true" @minimize="onMinimize" @close="onClose" @do-update="doUpdate" />
    <main class="content">
      <Dashboard v-if="activeTab === 'dashboard'" :config="config" :stats="stats" :heartbeatDot="heartbeatDot"
        :heartbeatStatus="heartbeatStatus" :heartbeatLatency="heartbeatLatency" />
      <Tweets v-if="activeTab === 'tweets'" :tweets="tweets" :disabled="!localAccounts.some(a => a.status === 'idle' && (a.todayCount || 0) < DAILY_LIMIT)" :autoApprove="autoApprove"
        @approve="onApproveTweet" @discard="t => { tweets = tweets.filter(x => x !== t); addLog('warn', `已放棄推文: ${t.tweetUrl}`) }" @update:replyConfig="cfg => { Object.assign(replyConfig, cfg); saveReplyConfig() }"
        @toggleAutoApprove="onToggleAutoApprove" />
      <Accounts v-if="activeTab === 'accounts'" :accounts="localAccounts" :dailyLimit="DAILY_LIMIT" :allowAdd="!adsLoaded"
        @add="addAccount" @remove="removeAccount" @restore="onRestoreAccount" />
      <Logs v-if="activeTab === 'logs'" :logs="logs" @clear="logs = []" />
    </main>
    <ConfigModal v-if="showConfigPanel" :config="config" @save="onSaveConfig" @close="showConfigPanel = false" />
  </div>
</template>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg: #0d1117;
  --bg2: #161b22;
  --bg3: #21262d;
  --border: #30363d;
  --text: #e6edf3;
  --text2: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
  --blue: #58a6ff;
  --radius: 8px;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 52px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  position: relative;
}

/* 拖拽透明覆蓋層，完整鋪滿 topbar */
.drag-region {
  position: absolute;
  inset: 0;
  z-index: 0;
  -webkit-app-region: drag;
}

/* topbar 子元素全部疊在拖拽層上方 */
.topbar-left,
.tabs,
.topbar-right {
  position: relative;
  z-index: 1;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 按鈕和可互動元素：明確禁用拖拽 */
.no-drag,
.tabs button,
.btn-icon {
  -webkit-app-region: no-drag;
}

.brand-logo {
  width: 28px;
  height: 28px;
  object-fit: cover;
  border-radius: 6px;
  margin-right: 0px;
}

.brand {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 1px;
  display: inline-flex;
  align-items: center;
}

.client-id {
  font-size: 11px;
  color: var(--text2);
  font-family: monospace;
  background: var(--bg3);
  padding: 2px 8px;
  border-radius: 20px;
}

.tabs {
  display: flex;
  gap: 4px;
}

.tabs button {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text2);
  cursor: pointer;
  font-size: 13px;
  transition: all .15s;
}

.tabs button:hover {
  background: var(--bg3);
  color: var(--text);
}

.tabs button.active {
  background: var(--bg3);
  color: var(--accent);
  font-weight: 600;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text2);
}

.server-label {
  font-size: 12px;
}

.latency {
  font-size: 11px;
  color: var(--green);
  font-family: monospace;
}

.btn-icon {
  background: var(--bg3);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
  border-radius: 6px;
  width: 32px;
  height: 32px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  border-color: var(--accent);
}

/* macOS 風格圓形窗口控制按鈕 */
.win-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 4px;
}

.wc-btn {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  position: relative;
  transition: filter .15s;
  flex-shrink: 0;
}

.wc-btn:hover {
  filter: brightness(1.25);
}

.wc-min {
  background: #f59e0b;
}

.wc-close {
  background: #ef4444;
}

/* hover 時顯示符號 */
.wc-min::after {
  content: '−';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: rgba(0, 0, 0, .6);
  line-height: 1;
  padding-bottom: 1px;
  display: none;
}

.wc-close::after {
  content: '×';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: rgba(0, 0, 0, .6);
  line-height: 1;
  display: none;
}

.win-controls:hover .wc-btn::after {
  display: flex;
}

.pause-banner {
  background: rgba(210, 153, 34, .15);
  border-bottom: 1px solid var(--yellow);
  color: var(--yellow);
  text-align: center;
  padding: 8px;
  font-weight: 600;
  font-size: 13px;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text2);
  margin-bottom: 16px;
  text-transform: uppercase;
  letter-spacing: .5px;
}

.mt {
  margin-top: 28px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.stat-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 16px;
  text-align: center;
}

.stat-card.green {
  border-color: rgba(63, 185, 80, .4);
}

.stat-card.blue {
  border-color: rgba(88, 166, 255, .4);
}

.stat-card.yellow {
  border-color: rgba(210, 153, 34, .4);
}

.stat-card.red {
  border-color: rgba(248, 81, 73, .4);
}

.stat-card.purple {
  border-color: rgba(168, 85, 247, .4);
}

.stat-card.purple .stat-num {
  color: #a855f7;
}

.stat-num {
  font-size: 32px;
  font-weight: 700;
  color: var(--text);
}

.stat-card.green .stat-num {
  color: var(--green);
}

.stat-card.blue .stat-num {
  color: var(--blue);
}

.stat-card.yellow .stat-num {
  color: var(--yellow);
}

.stat-card.red .stat-num {
  color: var(--red);
}

.stat-label {
  font-size: 12px;
  color: var(--text2);
  margin-top: 4px;
}

.info-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.info-row:last-child {
  border-bottom: none;
}

.info-row>span:first-child {
  color: var(--text2);
  font-size: 13px;
}

code {
  font-family: monospace;
  font-size: 12px;
  background: var(--bg3);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--accent);
}

.add-form {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.inp {
  background: var(--bg2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  flex: 1;
  min-width: 180px;
  outline: none;
}

.inp:focus {
  border-color: var(--accent);
}

.inp-sm {
  flex: 0 0 160px;
}

.btn {
  padding: 8px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  transition: all .15s;
}

.btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
}

.btn-primary:hover {
  background: #79b8ff;
  border-color: #79b8ff;
}

.btn-add {
  background: var(--green);
  border-color: var(--green);
  color: #0d1117;
  font-weight: 600;
  padding: 8px 20px;
}

.btn-add:hover {
  background: #56d364;
}

.btn-sm {
  padding: 4px 12px;
  font-size: 12px;
}

.account-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.account-table th {
  background: var(--bg3);
  color: var(--text2);
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.account-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.account-table tr:last-child td {
  border-bottom: none;
}

.account-table tbody tr:hover {
  background: var(--bg3);
}

.tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
}

.tag-idle {
  background: rgba(139, 148, 158, .15);
  color: var(--text2);
}

.tag-run {
  background: rgba(88, 166, 255, .15);
  color: var(--blue);
}

.tag-cool {
  background: rgba(210, 153, 34, .15);
  color: var(--yellow);
}

.tag-ban {
  background: rgba(248, 81, 73, .15);
  color: var(--red);
}

.btn-del {
  background: transparent;
  border: 1px solid rgba(248, 81, 73, .4);
  color: var(--red);
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.btn-del:hover {
  background: rgba(248, 81, 73, .15);
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.log-list {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
  font-family: monospace;
  font-size: 12px;
}

.log-row {
  display: grid;
  grid-template-columns: 80px 50px 1fr;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
}

.log-row:hover {
  background: var(--bg3);
}

.log-time {
  color: var(--text2);
}

.log-level {
  font-weight: 700;
  text-align: center;
}

.log-info .log-level {
  color: var(--blue);
}

.log-warn .log-level {
  color: var(--yellow);
}

.log-error .log-level {
  color: var(--red);
}

.log-msg {
  color: var(--text);
  word-break: break-all;
}

.empty-hint {
  text-align: center;
  color: var(--text2);
  padding: 40px;
  font-size: 14px;
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: var(--bg);
}

::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

/* ─── 启动蒙版 */
.splash-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.splash-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.splash-logo {
  font-size: 48px;
  line-height: 1;
  filter: drop-shadow(0 0 16px #58a6ff88);
}

.splash-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 2px;
}

.splash-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.splash-msg {
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
}

.splash-updating {
  color: var(--yellow);
  font-size: 12px;
}

.splash-version {
  color: var(--text2);
  font-size: 11px;
  font-family: monospace;
}

.splash-fade-leave-active {
  transition: opacity 0.4s ease;
}
.splash-fade-leave-to {
  opacity: 0;
}
</style>
