#!/usr/bin/env node
/**
 * replyTweet.js
 * 用法: node replyTweet.js <serial> <adsBase> <tweetUrl> <deepseekKey> <systemPrompt> [appendUrl] [appendText]
 *
 * 流程：启动浏览器 → 导航推文页 → 从 DOM 抓取推文内容 → 调 DeepSeek → 回复 → 关闭浏览器
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// 解析 playwright-core 的優先順序
let chromium;
const candidates = [
  path.join(__dirname, 'node_modules', 'playwright-core'),
  path.join(__dirname, '..', 'node_modules', 'playwright-core'),
];

try {
  const globalDir = execSync('npm root -g', { timeout: 5000 }).toString().trim();
  candidates.push(path.join(globalDir, 'playwright-core'));
  candidates.push(path.join(globalDir, 'playwright', 'node_modules', 'playwright-core'));
} catch { /* npm 不可用，跳過 */ }

let loaded = false;
for (const p of candidates) {
  try {
    ({ chromium } = require(p));
    loaded = true;
    break;
  } catch { /* 繼續嘗試下一個 */ }
}
if (!loaded) {
  ({ chromium } = await import('playwright-core'));
}

// ==================== 全局仿生辅助函数 ====================

/** 随机延迟辅助函数（显式传递 page 对象，规避隐式作用域问题） */
const randDelay = (page, min, max) => page.waitForTimeout(Math.floor(Math.random() * (max - min + 1)) + min);

/** 生成真正的人类手腕运动轨迹（三次贝塞尔曲线） */
function generateBezierPoints(startX, startY, endX, endY, steps) {
  const points = [];
  const controlX1 = startX + (endX - startX) * Math.random();
  const controlY1 = startY + (endY - startY) * Math.random() + (Math.random() * 60 - 30);
  const controlX2 = startX + (endX - startX) * Math.random();
  const controlY2 = startY + (endY - startY) * Math.random() + (Math.random() * 60 - 30);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.pow(1 - t, 3) * startX + 3 * Math.pow(1 - t, 2) * t * controlX1 + 3 * (1 - t) * Math.pow(t, 2) * controlX2 + Math.pow(t, 3) * endX;
    const y = Math.pow(1 - t, 3) * startY + 3 * Math.pow(1 - t, 2) * t * controlY1 + 3 * (1 - t) * Math.pow(t, 2) * controlY2 + Math.pow(t, 3) * endY;
    points.push({ x, y });
  }
  return points;
}

/** 仿生鼠标移动并点击升级版（彻底消灭瞬间闪现） */
async function bionicClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return await locator.click(); // 兜底

  const padding = 5;
  const targetX = box.x + padding + Math.random() * (box.width - padding * 2);
  const targetY = box.y + padding + Math.random() * (box.height - padding * 2);

  // 读取 Playwright 底层记录的当前鼠标实际位置
  const startX = page.mouse._x !== undefined ? page.mouse._x : Math.floor(Math.random() * 100);
  const startY = page.mouse._y !== undefined ? page.mouse._y : Math.floor(Math.random() * 100);

  const steps = Math.floor(Math.random() * 10) + 15; // 15-25帧
  const curvePoints = generateBezierPoints(startX, startY, targetX, targetY, steps);

  for (const pt of curvePoints) {
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(Math.floor(Math.random() * 5) + 3); // 帧间随机微小延迟
  }

  await randDelay(page, 150, 350);
  await page.mouse.down();
  await randDelay(page, 60, 140);
  await page.mouse.up();
}

// ==================== 网络请求与业务服务 ====================

async function callDeepSeek(apiKey, tweetText, systemPrompt) {
  const COMPACT_PROMPT = `
あなたはX（Twitter）の株クラ投資家向け返信AIです。

【判断基準：厳守】
入力されたツイートが以下のいずれかの話題に明確に関連する場合のみ合格とする：
・株式、股票
・株式投資、股票投資
・年金、养老金、老後資金
・NISA、新NISA
Free、フリー、無料（投資・株式関連の文脈に限る）

上記に一つも該当しない、関連性が薄い、スパム・一般宣伝の場合は、
何も説明せず、ただ一語だけ：NO_MATCH と出力してください。

【合格時の返信ルール】
・日本の個人投資家らしい自然な感想（丁寧語～少しフランクな表現）
・文字数：30～80文字（厳守）
・絵文字1～2個使用可、過剰な使用は禁止
・日本語のみ出力、前置き、挨拶、補足説明は一切記載しない

【絶対禁止事項】
・条件に合わない場合に日本語コメントを出力すること
・NO_MATCH に余計な文字、記号、改行を追加すること
`;

  const finalPrompt = systemPrompt
    ? `${COMPACT_PROMPT}\n追加ルール:\n${systemPrompt}`
    : COMPACT_PROMPT;

  const body = JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: finalPrompt },
      { role: 'user', content: tweetText },
    ],
    temperature: 0.4,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error) return reject(new Error(`DeepSeek 错误: ${json.error.message}`));
          let text = json.choices?.[0]?.message?.content;
          if (!text) return reject(new Error('DeepSeek 未返回内容'));
          text = text
            .replace(/```[a-zA-Z]*\n?/g, '')
            .replace(/```/g, '')
            .replace(/[「」\(\)\[\]'""]/g, '')
            .trim();
          if (text.toUpperCase().includes('NO_MATCH') || text === '') {
            resolve('NO_MATCH');
          } else {
            resolve(text);
          }
        } catch { reject(new Error(`DeepSeek 响应解析失败: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function startBrowser(serial, adsBase) {
  const url = `${adsBase}/api/v1/browser/start?serial_number=${encodeURIComponent(serial)}`;
  console.error(`[replyTweet] 启动 AdsPower 浏览器: ${url}`);
  const json = await httpGet(url);
  console.error(`[replyTweet] AdsPower 响应: ${JSON.stringify(json)}`);
  if (!json || json.code !== 0) throw new Error(`AdsPower 启动失败: ${json?.msg || JSON.stringify(json)}`);
  const wsUrl = json.data?.ws?.puppeteer;
  if (!wsUrl) throw new Error(`AdsPower 未返回 wsUrl: ${JSON.stringify(json.data)}`);
  return wsUrl;
}

function stopBrowser(serial, adsBase) {
  return new Promise((resolve) => {
    const stopUrl = `${adsBase}/api/v1/browser/stop?serial_number=${encodeURIComponent(serial)}`;
    const lib = stopUrl.startsWith('https') ? https : http;
    lib.get(stopUrl, (res) => {
      res.resume();
      res.on('end', () => {
        console.error(`[replyTweet] AdsPower 浏览器已停止: ${serial}`);
        resolve();
      });
    }).on('error', (e) => {
      console.error(`[replyTweet] 停止浏览器失败: ${e.message}`);
      resolve();
    });
  });
}

// ==================== 主核心流程 ====================

async function main() {
  const [, , serial, adsBase, tweetUrl, deepseekKey, systemPrompt, appendUrl, appendText] = process.argv;

  if (!serial || !adsBase || !tweetUrl || !deepseekKey) {
    console.log(JSON.stringify({ success: false, error: '参数不足: 需要 serial adsBase tweetUrl deepseekKey' }));
    process.exit(1);
  }

  let browser;
  try {
    // 1. 启动 AdsPower 浏览器并建立 CDP 连接
    const wsUrl = await startBrowser(serial, adsBase);
    console.error(`[replyTweet] CDP wsUrl: ${wsUrl}`);
    browser = await chromium.connectOverCDP(wsUrl);

    let contexts = browser.contexts();
    if (contexts.length === 0) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        contexts = browser.contexts();
        if (contexts.length > 0) break;
      }
    }
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    let allPages = context.pages();
    if (allPages.length === 0) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        allPages = context.pages();
        if (allPages.length > 0) break;
      }
    }
    console.error(`[replyTweet] 当前总标签数(含插件): ${allPages.length}`);

    let page = null;

    // 安全清场：过滤插件页，锁定唯一工作页
    for (let i = 0; i < allPages.length; i++) {
      const p = allPages[i];
      try {
        const currentUrl = p.url();
        if (currentUrl.startsWith('chrome-extension://')) {
          continue;
        }
        if (!page) {
          page = p;
        } else {
          console.error(`[replyTweet] 关闭多余标签: ${currentUrl}`);
          await p.close().catch(() => { });
        }
      } catch (e) { /* 忽略瞬时异常 */ }
    }

    if (!page) {
      page = await context.newPage();
      console.error(`[replyTweet] 未找到常规页面，新建唯一工作标签`);
    } else {
      console.error(`[replyTweet] 成功锁定唯一工作标签，准备清理内存`);
    }

    // 洗地清理内存，避免 SPA 缓存干扰
    await page.goto('about:blank', { timeout: 5000 }).catch(() => { });

    // 2. 跳转到目标推文
    await page.bringToFront();
    console.error(`[replyTweet] 导航到: ${tweetUrl}`);
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    console.error(`[replyTweet] 推文加载完成 URL: ${page.url()}`);

    // 3. 抓取主推文内容（利用原生 Locator 规避全局监控特征）
    console.error('[replyTweet] 等待推文内容元素出现...');
    const targetTweetLocator = page.locator('article [data-testid="tweetText"]').first();

    try {
      await targetTweetLocator.waitFor({ timeout: 30000, state: 'visible' });
    } catch {
      console.error(`[replyTweet] 等待 tweetText 超时，当前 URL: ${page.url()}，尝试继续抓取...`);
    }

    const tweetText = await targetTweetLocator.evaluate(el => {
      if (!el) return '';
      return Array.from(el.querySelectorAll('span, img[alt]'))
        .map(node => node.tagName === 'IMG' ? node.getAttribute('alt') : node.textContent)
        .join('').trim();
    }).catch(() => '');

    console.error(`[replyTweet] 抓取推文内容: ${tweetText.slice(0, 100)}`);

    if (!tweetText) {
      throw new Error('无法从页面抓取推文内容，元素未渲染或页面加载失败');
    }

    // 4. 点赞验活：监听 FavoriteTweet 响应
    console.error('[replyTweet] 注册 FavoriteTweet 响应监听...');
    let likeResult = null;
    let likeErrorMsg = '';

    const likeResponseHandler = async (response) => {
      if (!response.url().includes('/i/api/graphql') || !response.url().includes('FavoriteTweet')) return;
      try {
        const body = await response.json().catch(() => null);
        if (!body) return;
        if (body?.data?.favorite_tweet === 'Done') {
          likeResult = 'ok';
          console.error('[replyTweet] 点赞成功 ✅');
          return;
        }
        const err0 = body?.errors?.[0];
        if (err0) {
          if (err0.code === 141) {
            likeResult = 'suspended';
            likeErrorMsg = err0.message || '账号已被封禁或停用';
          } else {
            likeResult = 'error';
            likeErrorMsg = `点赞失败 code=${err0.code}: ${err0.message || ''}`;
          }
          console.error(`[replyTweet] 点赞响应异常: ${JSON.stringify(err0)}`);
        }
      } catch { }
    };
    page.on('response', likeResponseHandler);

    const likeSelectors = [
      '[data-testid="like"]',
      '[data-testid="unlike"]',
      'button[data-testid="like"]',
    ];
    let likeClicked = false;
    for (const sel of likeSelectors) {
      try {
        const btn = page.locator(sel).first();
        // 使用 waitFor 代替 isVisible，给它 5 秒时间让它从“未渲染”变成“可见”
        await btn.waitFor({ timeout: 5000, state: 'visible' });

        await bionicClick(page, btn);
        likeClicked = true;
        console.error(`[replyTweet] 物理级模拟点击点赞按钮: ${sel}`);
        break;
      } catch {
        // 如果 5 秒内这个 selector 没出来，说明可能已经点过赞了（变成了 unlike）或者真的没找到，换下一个 selector
      }
    }

    if (!likeClicked) {
      console.error(`[replyTweet] 点击点赞没有找到按钮`);

      const currentUrl = page.url();
      const isLoginPage = currentUrl.includes('/login') ||
        currentUrl.includes('/i/flow/login') ||
        /^https?:\/\/(www\.)?(x\.com|twitter\.com)\/?$/.test(currentUrl);

      const loginSelector = 'input[autocomplete="username"], input[name="session[username_or_email]"], [data-testid="loginButton"]';
      const hasLoginForm = await page.locator(loginSelector).first().isVisible({ timeout: 1500 }).catch(() => false);

      if (isLoginPage || hasLoginForm) {
        throw new Error(`账号未登录，页面已跳转至登录界面: ${currentUrl}`);
      }

      console.error('[replyTweet] 未找到点赞按钮，跳过点赞验活继续执行');
    }

    if (likeClicked) {
      let waited = 0;
      while (likeResult === null && waited < 8000) {
        await page.waitForTimeout(300);
        waited += 300;
      }
      page.off('response', likeResponseHandler);

      if (likeResult === 'suspended') {
        throw new Error(`账号风控/封禁，点赞失败: ${likeErrorMsg}`);
      }
      if (likeResult === 'error') {
        throw new Error(`点赞接口异常: ${likeErrorMsg}`);
      }
      if (likeResult === null) {
        console.error('[replyTweet] 点赞响应超时，谨慎继续...');
      }
    }

    // 5. 调 AI 过滤和生成内容
    console.error('[replyTweet] 请求 DeepSeek 审核并生成回复...');
    let replyText = await callDeepSeek(deepseekKey, tweetText, systemPrompt || '');
    console.error(`[replyTweet] AI 返回: ${replyText.slice(0, 80)}`);

    if (replyText === 'NO_MATCH') {
      console.error('[replyTweet] 内容不匹配目标主题，跳过回复');
      console.log(JSON.stringify({ success: false, discard: true, reason: '推文内容不符合目标主题' }));
      return;
    }

    if (appendUrl) replyText += `\n${appendUrl}`;
    if (appendText) replyText += `\n${appendText}`;

    // 拦截发帖响应以提取新推文 ID
    let newTweetId = null;
    page.on('response', async (response) => {
      if (response.url().includes('/i/api/graphql') && response.url().includes('CreateTweet')) {
        try {
          const body = await response.json().catch(() => null);
          const id = body?.data?.create_tweet?.tweet_results?.result?.rest_id
            || body?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str;
          if (id) newTweetId = id;
        } catch { }
      }
    });

    // 6. 定位输入框
    await page.waitForTimeout(1000);
    const editorSelectors = [
      '[data-testid="tweetTextarea_0_label"] div[contenteditable="true"]',
      '[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
      '[data-testid="tweetTextarea_0_label"]',
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_1_label"] div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="Reply"]',
      'div[contenteditable="true"][aria-label*="reply"]',
      'div[contenteditable="true"][role="textbox"]',
    ];

    let editor = null;
    for (const sel of editorSelectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 35000, state: 'attached' });
        if (el) {
          editor = page.locator(sel).first();
          console.error(`[replyTweet] 找到编辑器: ${sel}`);
          await editor.scrollIntoViewIfNeeded().catch(() => { });
          break;
        }
      } catch { }
    }

    if (!editor) {
      throw new Error(`找不到回复输入框，当前页面: ${page.url()}`);
    }

    // ======= 执行核心防封输入业务 =======

    // ======= 执行核心防封输入业务 =======

    // 激活输入框
    await randDelay(page, 800, 2000);
    await bionicClick(page, editor);
    await randDelay(page, 400, 900);

    // 【修复核心】将字符串转为真正由独立字符（含完整Emoji）组成的数组
    const charArray = Array.from(replyText);

    // 仿生打字流（3% 错字纠错 + 5% 停顿思考）
    for (let i = 0; i < charArray.length; i++) {
      const char = charArray[i];

      // 只有当字符不是 Emoji/特殊符号时，才允许触发错字纠错机制（规避charCodeAt在Emoji上的异常）
      const isNormalChar = char.length === 1 && char.charCodeAt(0) < 0xD800;

      if (isNormalChar && Math.random() < 0.03 && i < charArray.length - 1) {
        const wrongChar = String.fromCharCode(char.charCodeAt(0) + 1);
        await page.keyboard.type(wrongChar);
        await randDelay(page, 150, 300);
        await page.keyboard.press('Backspace');
        await randDelay(page, 100, 250);
      }

      // 无论是正常字还是完整的 Emoji，现在都能安全输入了
      await page.keyboard.type(char, { delay: 0 });
      await randDelay(page, 60, 180);

      if (Math.random() < 0.05) {
        await randDelay(page, 400, 1200);
      }
    }
    await randDelay(page, 800, 1500);

    // 验证内容是否落盘成功
    const isTextExist = await editor.evaluate(el => el.textContent.length > 0).catch(() => false);
    if (!isTextExist) {
      throw new Error('[replyTweet] 输入框内容为空，输入可能被系统拦截，放弃该任务以保护账号');
    }

    console.error(`[replyTweet] 已确认安全输入回复: ${replyText.slice(0, 30)}...`);

    // 7. 发送按钮寻获与物理级点击
    const submitSelectors = [
      '[data-testid="tweetButtonInline"]',
      '[data-testid="tweetButton"]',
      'div[role="button"][data-testid*="tweet"]',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        const isDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
        if (isDisabled === 'true') {
          console.error(`[replyTweet] 按钮 ${sel} 处于禁用状态，跳过`);
          continue;
        }

        await randDelay(page, 1000, 2500); // 模拟最后肉眼复读检查
        await bionicClick(page, btn);
        submitted = true;
        console.error(`[replyTweet] 物理级模拟点击发送按钮: ${sel}`);
        break;
      }
    }

    if (!submitted) throw new Error('找不到发送按钮');

    // 异步等待接口回执
    await randDelay(page, 2000, 4000);

    console.log(JSON.stringify({ success: true, tweetId: newTweetId || null }));

  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  } finally {
    // 释放资源：先断开 AdsPower 控制，再断开 CDP 连接
    await stopBrowser(serial, adsBase);
    if (browser) {
      try { await browser.close(); } catch { }
    }
    process.exit(0);
  }
}

main();