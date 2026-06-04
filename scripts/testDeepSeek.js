import OpenAI from "openai";

/**
 * AI 自动判断推文是否符合要求 + 生成回复
 * 匹配主题：股票/投资/养老金/NISA/新NISA/投资相关free → 返回日文回复
 * 不匹配/无关内容 → 返回固定标识 NO_MATCH
 * 模型：deepseek-v4-flash（官方标准名称，长期可用）
 */
export async function generateDeepSeekReply(apiKey, tweetText, systemPrompt) {
  if (!apiKey) throw new Error("DeepSeek API Key 未配置");

  const COMPACT_PROMPT = `
あなたはX（Twitter）の株クラ投資家向け返信AIです。

【判断基準：厳守】
入力されたツイートが以下のいずれかの話題に明確に関連する場合のみ合格とする：
・株式、股票
・株式投資、股票投資
・年金、养老金、老後資金
・NISA、新NISA
・free、フリー、無料（投資・株式関連の文脈に限る）

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

  const finalSystemPrompt = systemPrompt
    ? `${COMPACT_PROMPT}\n追加ルール:\n${systemPrompt}`
    : COMPACT_PROMPT;

  const openai = new OpenAI({
    baseURL: "https://api.deepseek.com/v1",
    apiKey: apiKey,
    dangerouslyAllowBrowser: true,
  });

  try {
    const completion = await openai.chat.completions.create({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: tweetText },
      ],
      temperature: 0.4,
      stream: false,
    });

    let result = completion.choices[0].message.content
      .replace(/```[a-zA-Z]*\n?/g, "")
      .replace(/```/g, "")
      .replace(/[「」\(\)\[\]'""]/g, "")
      .trim();

    if (result.toUpperCase().includes("NO_MATCH") || result === "") {
      return "NO_MATCH";
    }

    return result;
  } catch (error) {
    throw new Error(`AI呼叫失败: ${error.message}`);
  }
}

// ==============================================
// 极简测试方法：只测一条！改这里就行
// ==============================================
async function test() {
  // 1. 填入你的 API Key
  const TEST_API_KEY = "sk-a695019171da48618a86b0fba8ec6287";

  // 2. 只改这一句文本！想测什么写什么
  const testText = "ご夫妻の許可を取りましたので、動画をあげさせていただきますいつまでもお元気で仲の良いご夫婦をこれからも応援しています！また来年も会いに行きます☺";

  console.log("📝 测试内容:", testText);

  try {
    const result = await generateDeepSeekReply(TEST_API_KEY, testText);
    console.log("✅ AI 返回结果:", result);
  } catch (e) {
    console.log("❌ 错误:", e.message);
  }
}

// 运行测试
// test();