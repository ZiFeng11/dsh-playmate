/**
 * hear.mjs —— 「念出来」：把回答的前 N 个字交给本地 TTS 念。
 *
 * 设计上的三个决定：
 *   1. **不打包任何 TTS 模型**。插件只当一个"客户端"：把文字 POST 到配置的 ttsUrl。
 *      理由：模型动辄几个 GB；更要紧的是——音色靠参考音，而参考音通常是某个人自己的声音，
 *      不能也不该随插件发出去。谁来念、用谁的声音，使用者自己决定。
 *   2. **只念前面一段**（默认 80 个字符）。整段念完又慢又吵；80 字大约 40 个汉字，
 *      一句话刚够，也够听懂。
 *   3. **失败就当没发生**：TTS 没起、端口不通、合成超时，都不能影响会话本身。
 */

/** 把 markdown / 代码块 / 表情符号去掉，只留能念的字 */
export function stripForSpeech(text) {
  let s = String(text ?? '')
  // 代码块整体丢掉（念代码没有意义）
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`[^`]*`/g, ' ')
  // 〔说〕那种标记保留正文
  const mark = /^[ \t]*[〔【\[]\s*说\s*[〕】\]]\s*(.+)$/m.exec(s)
  if (mark !== null && mark[1].trim() !== '') s = mark[1]
  // 表格线、引用号、标题号、列表符
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*#{1,6}\s*/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  // 粗体/斜体/删除线的记号去掉（念的时候会念成"星号"）
  s = s.replace(/\*\*|__|~~|\*/g, '')
  // 链接只留文字
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // emoji 与方括号里的表情标记
  s = s.replace(/\[表情[^\]]*\]/g, ' ')
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
  // 收尾：多余空白压成一个空格
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/** 按句子边界截到 N 个字符，尽量不要切断半句话 */
export function clipForSpeech(text, maxChars) {
  const clean = stripForSpeech(text)
  const max = Math.max(10, Math.min(600, Number(maxChars) || 80))
  if (clean.length <= max) return clean
  const head = clean.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('，'), head.lastIndexOf(' '))
  return (cut > max * 0.5 ? head.slice(0, cut + 1) : head).trim()
}

/**
 * 出声器：拿一个读配置的函数，返回 { speak }。
 */
export function createHear({ getState, log = () => {}, fetchImpl = null }) {
  let lastSpokenAt = 0
  let lastText = ''

  /**
   * 念一段话。
   * @param text 原文
   * @param maxChars 覆盖「念多少字」。过程话由调用点传短值（默认 40），
   *                 最终回复不传，用配置里的 speakChars。
   */
  async function speak(text, maxChars) {
    const state = getState() ?? {}
    if (state.hear !== true) return { ok: false, reason: 'disabled' }
    const url = String(state.ttsUrl ?? '').trim()
    if (url === '') return { ok: false, reason: 'no-tts-url' }
    const limit = Number(maxChars) > 0 ? Number(maxChars) : state.speakChars
    const line = clipForSpeech(text, limit)
    if (line === '') return { ok: false, reason: 'empty' }
    // 同一句刚念过就别重复念（模型有时会把同一段发两次）
    const now = Date.now()
    if (line === lastText && now - lastSpokenAt < 8000) return { ok: false, reason: 'duplicate' }
    lastText = line
    lastSpokenAt = now
    const doFetch = fetchImpl ?? fetch
    try {
      await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text: line }),
        signal: AbortSignal.timeout(20000),
      })
      log(`[dsh-playmate/hear] 念了 ${line.length} 字：${line.slice(0, 20)}…`)
      return { ok: true, line }
    } catch (e) {
      log(`[dsh-playmate/hear] 念失败：${e?.message ?? e}`)
      return { ok: false, reason: 'failed', error: String(e?.message ?? e) }
    }
  }

  return { speak }
}
