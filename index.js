/**
 * dsh-playmate —— 陪玩骨架（0.1.0）
 *
 * 一个插件，三个模块，默认全关：
 *   看（see）  定时抓屏 → 变化分挑帧 → 拼一张图
 *   说（talk） 按住说话 → 本地识别 → 注入本会话
 *   听（hear） 会话回复 → 本地 TTS → 念出来
 *
 * 本文件只做三件事：①存开关 ②出一个设置页 ③留出三个模块的挂点。
 * 真正的抓屏/识别/TTS 都由本机的引擎进程做，这里只负责开关和路由。
 *
 * 重要：插件**不含任何声音模型与参考音频**。"听"默认返回 501 未配置，
 * 要用请自己准备参考音克隆（见 README）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createPttWindow } from './lib/ptt-window.mjs'
import { sessionLabel } from './lib/session-label.mjs'
import { createHear } from './lib/hear.mjs'
import { createWatch } from './lib/watch.mjs'
import { homedir } from 'node:os'

const API = '/api/playmate'
const MAX_BODY = 8 * 1024

/** 开关存哪儿：DSH 家目录下，重启后还在。
 *  注意：每次调用现算，不在模块加载时定死 —— 否则测试或换 HOME 会读到旧路径。 */
function stateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'playmate.json')
}

/** 文件日志：宿主 logger 在桌面版里不一定写盘，出问题只能靠这个 */
function fileLog(msg) {
  try {
    const dir = stateFile().replace(/[\\/][^\\/]+$/, '')
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} ${msg}
`
    writeFileSync(join(dir, 'playmate-plugin.log'), line, { flag: 'a' })
  } catch {
    /* 记不上就算了，不能影响主流程 */
  }
}

/** toggle「说」之后要通知耳朵：由 registerEar 把自己的同步函数挂上来 */
let syncEar = null

/** 看屏幕的模式/参数变化后要重排自动循环：由 registerWatch 挂上来 */
let syncWatch = null

const DEFAULT_STATE = {
  see: false,
  talk: false,
  hear: false,
  /** 看：多久抓一次（秒） */
  seeEvery: 3,
  /** 说：识别引擎地址（本地） */
  asrUrl: '',
  /** 听：TTS 引擎地址（本地，默认空 = 未接入） */
  ttsUrl: '',
  /** 看：ffmpeg 路径（留空走 PATH） */
  ffmpegPath: '',
  /** 看：临时工作目录（留空走系统临时目录） */
  workDir: '',
  /** 看：变化分阈值，低于它就算"没变" */
  seeDiff: 2,
  /** 看：默认抓多少秒 */
  seeSeconds: 8,
  /** 看：默认每秒几帧 */
  seeFps: 2,
  /** 看：默认最多几帧 */
  seeMaxFrames: 9,
  /** 说：按住说话（ptt）还是一直听（always） */
  talkMode: 'ptt',
  /** 说：跑 ear.py 的 python（留空 = PATH 里的 python） */
  pythonPath: '',
  /** 说：麦克风能量阈值（越大越不灵敏） */
  vadThreshold: 0.012,
  /** 说：静音多少毫秒算一句话说完 */
  silenceMs: 700,
  /** 说：语音送到哪儿 —— fixed=固定会话 / auto=跟随最近活动 */
  targetMode: 'auto',
  /** 说：固定会话的 id（targetMode=fixed 时生效） */
  targetSessionId: '',
  /** 说：录音时要不要显示右下角小条（0=不显示，只用提示音） */
  showPill: false,
  /** 说：识别模型（默认 SenseVoiceSmall；想更准可以换更大的，见 README） */
  asrModel: 'iic/SenseVoiceSmall',
  /** 说：模型缓存目录（留空=系统默认；有些机器默认目录写不进去，要指到可写盘） */
  msCacheDir: '',
  /** 听：念多少字（默认 80，约 40 个汉字） */
  speakChars: 80,
  /** 听：过程话念多少字（默认 40；一轮中间的短句用这个上限，最终回复仍用 speakChars） */
  speakMidChars: 40,
  /** 看：手动（模型需要时才看）还是自动（画面变了就叫它看） */
  seeMode: 'manual',
  /** 看：自动模式两帧之间至少隔多少个 10 毫秒（这里存秒） */
  seeMinGapSec: 15,
  /** 看：自动模式的变化分阈值（越大越不敏感） */
  seeAutoDiff: 8,
  /** 看：自动模式"多主动" —— quiet / normal / dense */
  seePace: 'quiet',
}

function readState() {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
    return { ...DEFAULT_STATE, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(next) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function sendJson(response, code, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function loopbackOnly(request) {
  const remote = String(request.socket?.remoteAddress ?? '')
  const ok = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return ok && !request.headers.origin ? true : ok
}

async function readBody(request) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 可配置项：名字 → { kind, min, max, label, hint }。越界直接拒，不静默截断。 */
const CONFIG_FIELDS = {
  seeSeconds: { kind: 'number', min: 1, max: 20, label: '抓多少秒', hint: '1–20，默认 8' },
  seeFps: { kind: 'number', min: 1, max: 4, label: '每秒几帧', hint: '1–4，默认 2；越高越费 CPU' },
  seeMaxFrames: { kind: 'number', min: 1, max: 9, label: '最多几帧', hint: '1–9，默认 9（3×3）' },
  seeDiff: { kind: 'number', min: 0.2, max: 20, label: '变化阈值', hint: '低于它就算"没变"，默认 2；越小越敏感' },
  ffmpegPath: { kind: 'string', max: 400, label: 'ffmpeg 路径', hint: '留空走 PATH；填绝对路径也行' },
  workDir: { kind: 'string', max: 400, label: '工作目录', hint: '留空用系统临时目录' },
  talkMode: { kind: 'enum', values: ['ptt', 'always'], label: '识别方式', hint: 'ptt=按住说（松开才发）；always=一直听，说完自动发' },
  pythonPath: { kind: 'string', max: 400, label: 'python 路径', hint: '跑识别引擎用；留空走 PATH' },
  vadThreshold: { kind: 'number', min: 0.002, max: 0.2, label: '麦克风灵敏度阈值', hint: '默认 0.012；环境吵就调大' },
  silenceMs: { kind: 'number', min: 200, max: 3000, label: '静音多久算说完(ms)', hint: '默认 700' },
  targetMode: { kind: 'enum', values: ['auto', 'fixed'], label: '语音送到', hint: 'fixed=只进固定会话（防串台）；auto=跟随最近活动的会话' },
  targetSessionId: { kind: 'string', max: 120, label: '固定会话 id', hint: 'targetMode=fixed 时用；在下面的下拉里选' },
  showPill: { kind: 'enum', values: ['true', 'false'], label: '录音时显示小条', hint: 'false=不显示，只用提示音（热键模式下推荐）' },
  msCacheDir: { kind: 'string', max: 400, label: '模型缓存目录', hint: '留空用系统默认；如果引擎报 model not registered，把它指到可写目录（例如 D:/mc/mscache）' },
  asrModel: { kind: 'string', max: 200, label: '识别模型', hint: '默认 iic/SenseVoiceSmall（快、够用）；长句同音字容易错，可换成更大的模型，见 README「识别精度」' },
  speakChars: { kind: 'number', min: 10, max: 600, label: '念多少字', hint: '默认 80（约 40 个汉字）；只念回答的开头这一段' },
  speakMidChars: { kind: 'number', min: 10, max: 600, label: '过程话念多少字', hint: '默认 40；一轮中间那些短句用这个上限，最终回复仍用上面那条' },
  seeMode: { kind: 'enum', values: ['manual', 'auto'], label: '看屏幕的方式', hint: 'manual=模型判断需要时才看；auto=画面变化后自动送一帧进来（打游戏用这个）' },
  seeMinGapSec: { kind: 'number', min: 3, max: 120, label: '自动模式最短间隔(秒)', hint: '默认 15；再剧烈也不会比这更频繁' },
  seeAutoDiff: { kind: 'number', min: 1, max: 60, label: '自动模式变化阈值', hint: '默认 8；越小越敏感（也越费）' },
  seePace: { kind: 'enum', values: ['quiet', 'normal', 'dense'], label: '自动模式多主动', hint: 'quiet=安静（3 分钟最多一次）/ normal=正常（1 分钟）/ dense=热闹（15 秒，演示用）' },
  ttsUrl: { kind: 'string', max: 400, label: 'TTS 地址', hint: '留空 = 「念出来」未接线' },
}

function validateConfig(patch) {
  const out = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    const f = CONFIG_FIELDS[key]
    if (!f) return { error: `unknown-field:${key}` }
    if (f.kind === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) return { error: `not-a-number:${key}` }
      if (n < f.min || n > f.max) return { error: `out-of-range:${key}`, min: f.min, max: f.max }
      out[key] = n
    } else if (f.kind === 'enum') {
      const str = String(value ?? '').trim()
      if (!f.values.includes(str)) return { error: `not-allowed:${key}`, allowed: f.values }
      out[key] = str
    } else {
      const str = String(value ?? '').trim()
      if (str.length > f.max) return { error: `too-long:${key}`, max: f.max }
      out[key] = str
    }
  }
  return { patch: out }
}

/** 三个模块的挂点：现在都是"未接线"，接线后各自返回真值。 */
const MODULES = {
  see: {
    label: '看屏幕',
    hint: '需要本机有 ffmpeg（设置页里可以填绝对路径）',
    ready: () => true,
  },
  talk: {
    label: '听我说话',
    hint: '需要 python + 麦克风（识别引擎已内置，首次启动要加载模型约 10 秒）',
    ready: () => true,
  },
  hear: {
    label: '念出来',
    hint: '引擎已内置，但**不附带任何声音模型**：要在“TTS 地址”里填一个本地 TTS 服务（自己克隆声音）',
    ready: (state) => typeof state.ttsUrl === 'string' && state.ttsUrl.trim() !== '',
  },
}

function settingsPage(state) {
  const row = (key, mod) => {
    const on = state[key] === true
    const ready = mod.ready(state)
    const cls = on ? 'on' : 'off'
    const note = ready ? '' : `<div class="hint">${mod.hint}</div>`
    return `<div class="row">
      <div class="meta"><div class="label">${mod.label}</div>${note}</div>
      <button class="sw ${cls}" data-key="${key}">${on ? '开' : '关'}</button>
    </div>`
  }
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>陪玩 · 设置</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b1017;color:#dfe7f2;font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif}
  main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#7f8ea3;font-size:13px;margin-bottom:24px}
  .card{background:#121a24;border:1px solid #1e2a38;border-radius:14px;padding:6px 16px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid #1a2530}
  .row:last-child{border-bottom:none}
  .label{font-size:16px}
  .hint{color:#7f8ea3;font-size:12px;margin-top:2px}
  .sw{min-width:64px;padding:7px 14px;border-radius:999px;border:1px solid #2a3a4d;background:#16202c;color:#c9d6e6;cursor:pointer;font-size:13px}
  .sw.on{background:#1f6feb;border-color:#2f7ff5;color:#fff}
  .note{margin-top:18px;color:#7f8ea3;font-size:12px;line-height:1.8}
  code{background:#16202c;padding:1px 6px;border-radius:6px;color:#9fc0e8}
</style></head><body><main>
  <h1>陪玩</h1>
  <div class="sub">三个开关默认全关。关着的模块不会抓屏、不会录音、不会出声。</div>
  <div class="card">${row('see', MODULES.see)}${row('talk', MODULES.talk)}${row('hear', MODULES.hear)}</div>
  <div class="note">
    <div>状态文件：<code>${stateFile()}</code></div>
    <div>本插件<strong>不附带任何声音模型与参考音频</strong>。"念出来"要么留空，要么接你自己的 TTS。</div>
  </div>
</main>
<script>
  document.querySelectorAll('.sw').forEach((el) => {
    el.addEventListener('click', async () => {
      const key = el.dataset.key
      const on = !el.classList.contains('on')
      const r = await fetch('${API}/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, on }),
      })
      const j = await r.json().catch(() => ({}))
      if (j.ok) {
        el.classList.toggle('on', on)
        el.textContent = on ? '开' : '关'
      }
    })
  })
</script></body></html>`
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    const routes = [
      {
        kind: 'exact',
        path: `${API}/`,
        handler(request, response) {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          const html = Buffer.from(settingsPage(readState()), 'utf8')
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(html.length),
            'cache-control': 'no-store',
          })
          response.end(html)
        },
      },
      {
        kind: 'exact',
        path: `${API}/status`,
        handler(request, response) {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          const state = readState()
          sendJson(response, 200, {
            ok: true,
            file: stateFile(),
            state,
            modules: Object.fromEntries(
              Object.entries(MODULES).map(([key, mod]) => [
                key,
                { label: mod.label, on: state[key] === true, ready: mod.ready(state), hint: mod.hint },
              ]),
            ),
          })
        },
      },
      {
        kind: 'exact',
        path: `${API}/config`,
        handler: async (request, response) => {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          if (request.method !== 'POST') {
            const state = readState()
            return sendJson(response, 200, {
              ok: true,
              config: Object.fromEntries(Object.keys(CONFIG_FIELDS).map((k) => [k, state[k]])),
              fields: Object.fromEntries(
                Object.entries(CONFIG_FIELDS).map(([k, f]) => [
                  k,
                  { kind: f.kind, min: f.min, max: f.max, label: f.label, hint: f.hint },
                ]),
              ),
            })
          }
          let body = {}
          try {
            body = JSON.parse(await readBody(request))
          } catch {
            return sendJson(response, 400, { ok: false, error: 'bad-body' })
          }
          const check = validateConfig(body)
          if (check.error) return sendJson(response, 400, { ok: false, ...check })
          const state = readState()
          Object.assign(state, check.patch)
          if (!writeState(state)) return sendJson(response, 500, { ok: false, error: 'state-write-failed' })
          // 模式/阈值这类参数是引擎**启动时**读的，改了必须重启引擎才生效
          const needsEngineRestart = ['talkMode', 'vadThreshold', 'silenceMs', 'pythonPath'].some((k) => k in check.patch)
          const needsWatchRestart = ['seeMode', 'seeEvery', 'seeAutoDiff', 'seeMinGapSec', 'seePace'].some((k) => k in check.patch)
          if (needsWatchRestart && typeof syncWatch === 'function') {
            await syncWatch().catch(() => {})
          }
          let earRestarted = null
          if (needsEngineRestart && state.talk === true && typeof syncEar === 'function') {
            earRestarted = await syncEar(true).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
          }
          return sendJson(response, 200, { ok: true, changed: Object.keys(check.patch), ear: earRestarted })
        },
      },
      {
        kind: 'exact',
        path: `${API}/toggle`,
        handler: async (request, response) => {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          let body = {}
          try {
            body = JSON.parse(await readBody(request))
          } catch {
            return sendJson(response, 400, { ok: false, error: 'bad-body' })
          }
          const key = String(body?.key ?? '')
          if (!(key in MODULES)) return sendJson(response, 400, { ok: false, error: 'unknown-key' })
          const on = body?.on === true
          if (on && !MODULES[key].ready(readState())) {
            return sendJson(response, 409, { ok: false, error: 'not-wired', hint: MODULES[key].hint })
          }
          const state = readState()
          state[key] = on
          if (!writeState(state)) return sendJson(response, 500, { ok: false, error: 'state-write-failed' })
          if (key === 'talk' && typeof syncEar === 'function') {
            const earResult = await syncEar(on).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
            return sendJson(response, 200, { ok: true, key, on, ear: earResult })
          }
          return sendJson(response, 200, { ok: true, key, on })
        },
      },
    ]
    for (const route of routes) {
      host.effect(() => host.webServer.register(route), `playmate:route:${route.path}`)
    }
  })

  const safely = (name, fn) => {
    try {
      fn(ctx)
      fileLog(`mount ${name} ok`)
    } catch (e) {
      fileLog(`mount ${name} FAILED: ${e?.message ?? e}`)
    }
  }
  safely('see', registerSee)
  safely('ear', registerEar)
  safely('hear', registerHear)
}

/** 取一个服务：优先 ctx.get()，老宿主退回属性访问（没声明 inject 时属性访问会 throw）。 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key)
      if (v) return v
    }
  } catch {
    /* 没声明 inject 时 get 陷阱会 throw */
  }
  try {
    return ctx?.[key] ?? null
  } catch {
    return null
  }
}

/** 加载 defineTool：插件自己的 node_modules 里找不到时，退回 DSH 安装目录。 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod?.defineTool) return mod.defineTool
  } catch {
    /* 继续找 */
  }
  const guess = [
    process.env.DSH_TOOLS_PATH,
    process.env.DSH_RESOURCES ? `${process.env.DSH_RESOURCES}/node_modules/@deepseek-ai/dsh-tools/lib/index.js` : '',
  ].filter(Boolean)
  for (const p of guess) {
    try {
      const { pathToFileURL } = await import('node:url')
      const mod = await import(pathToFileURL(p).href)
      if (mod?.defineTool) return mod.defineTool
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/**
 * 注册「看」这个工具。
 *
 * 工具**一直在**（不像开关那样注册/注销）：开关关着时它回一句话说明为什么看不见，
 * 这比"工具突然消失"更好——模型至少知道该去设置页把它打开。
 */
function registerSee(ctx) {
  const injectList = ['tools', 'attachments']
  const wire = async (host) => {
    const tools = host?.tools ?? serviceOf(ctx, 'tools')
    const attachments = host?.attachments ?? serviceOf(ctx, 'attachments')
    if (!tools?.register) return
    const defineTool = await loadDefineTool()
    const { seeToolSpec, runSee, TOOL_NAME } = await import('./lib/see-tool.mjs')
    const { existsSync } = await import('node:fs')

    const toolObj = {
      ...seeToolSpec(),
      async execute(rawArgs = {}) {
        const state = readState()
        if (state.see !== true) {
          return {
            text: '「看屏幕」现在是关着的。请在 设置 → 陪玩 → 看屏幕 里打开，否则无法读取画面。',
            meta: { ok: false, reason: 'disabled' },
          }
        }
        const ffmpeg = String(state.ffmpegPath || '').trim()
        if (ffmpeg !== '' && !existsSync(ffmpeg)) {
          return { text: `ffmpeg 路径不对：${ffmpeg}（设置页里改一下，或者留空让它走 PATH）`, meta: { ok: false, reason: 'ffmpeg-missing' } }
        }
        try {
          return await runSee(ctx, attachments, {
            ffmpeg: ffmpeg === '' ? undefined : ffmpeg,
            workDir: String(state.workDir || '').trim() || undefined,
            seconds: rawArgs.seconds,
            maxFrames: rawArgs.max_frames,
            defaultSeconds: state.seeSeconds,
            defaultFps: state.seeFps,
            defaultMaxFrames: state.seeMaxFrames,
            diffThreshold: state.seeDiff,
          })
        } catch (e) {
          return { text: `看屏幕失败了：${e?.message ?? e}`, meta: { ok: false, reason: 'engine-error' } }
        }
      },
    }

    const spec = defineTool ? defineTool(toolObj) : toolObj
    const mark = (ok, detail) => {
      try {
        const cur = readState()
        cur.tool = { name: TOOL_NAME, ok, detail: String(detail || ''), at: new Date().toISOString() }
        writeState(cur)
      } catch {
        /* 记不上不影响工具本身 */
      }
    }
    try {
      const dispose = tools.register(spec)
      if (typeof dispose === 'function') ctx.effect?.(() => dispose, `playmate:tool:${TOOL_NAME}`)
      mark(true, defineTool ? 'defineTool' : 'raw')
    } catch (e) {
      mark(false, e?.message ?? e)
      ctx?.logger?.warn?.(`[dsh-playmate] 注册 ${TOOL_NAME} 失败：${e?.message ?? e}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(injectList, (host) => {
        void wire(host)
      })
    } else {
      void wire(null)
    }
  } catch (e) {
    ctx?.logger?.warn?.(`[dsh-playmate] 注入失败：${e?.message ?? e}`)
  }
}

/**
 * 挂「耳朵」：引擎进程 + 三条路由 + 看门狗。
 *
 *   POST /api/playmate/heard   { text }          ← ear.py 认出字之后调它
 *   POST /api/playmate/ptt     { state:"start|stop" }  ← 界面上的「按住说话」按钮
 *   GET  /api/playmate/ear                        ← 引擎活没活、什么模式
 */
function registerEar(ctx) {
  let ear = null
  let pttWin = null
  let watchdog = null
  const api = async () => await import('./lib/ear.mjs')

  const rootDir = (() => {
    try {
      const url = new URL('.', import.meta.url)
      return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
    } catch {
      return process.cwd()
    }
  })()

  ctx.inject(['webServer', 'agents', 'attachments'], (host) => {
    const log = (m) => {
      try {
        ctx?.logger?.info?.(m)
      } catch {
        /* 记不上不影响运行 */
      }
    }

    const origin = () => host.webServer?.getOrigin?.() ?? 'http://127.0.0.1:3080'

    const ensure = async () => {
      const mod = await api()
      // 固定会话：配置改了立刻生效（不用重启），并优先于"最近活动"
      try {
        const st0 = readState()
        mod.setFixedSession?.(st0.targetMode === 'fixed' ? String(st0.targetSessionId ?? '') : '')
      } catch {
        /* 老版本模块没有这个方法，忽略 */
      }
      ear = ear ?? mod.createEar({ rootDir, log })
      pttWin = pttWin ?? createPttWindow({ rootDir, log })
      const state = readState()
      if (state.talk !== true) {
        ear.stop('开关关着')
        pttWin.stop('开关关着')
        return { ok: true, running: false }
      }
      const r = ear.start(state, origin())
      // 只有「按住说话」模式才需要那个小浮窗；一直听模式用不上
      const wantsWindow = state.talkMode !== 'always'
      const win = wantsWindow
        ? pttWin.start(origin(), String(state.showPill) === 'true')
        : (pttWin.stop('一直听模式'), { ok: true, running: false })
      return { ok: r.ok !== false, ...r, window: win, ...ear.status() }
    }

    const stop = async () => {
      if (pttWin !== null) pttWin.stop('开关关掉')
      if (!ear) return { ok: true, running: false }
      ear.stop('开关关掉')
      return { ok: true, running: false }
    }

    const routes = [
      {
        kind: 'exact',
        path: `${API}/heard`,
        handler: async (request, response) => {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          let body = {}
          try {
            body = JSON.parse(await readBody(request))
          } catch {
            return sendJson(response, 400, { ok: false, error: 'bad-body' })
          }
          const text = String(body?.text ?? '').trim()
          if (text === '') return sendJson(response, 400, { ok: false, error: 'empty-text' })
          const mod = await api()
          const r = mod.injectText(host, text)
          return sendJson(response, r.ok ? 200 : 503, { ...r, text })
        },
      },
      {
        kind: 'exact',
        path: `${API}/ptt`,
        handler: async (request, response) => {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          if (request.method !== 'POST') return sendJson(response, 200, { ok: true, state: readState().talkMode })
          let body = {}
          try {
            body = JSON.parse(await readBody(request))
          } catch {
            return sendJson(response, 400, { ok: false, error: 'bad-body' })
          }
          const action = String(body?.state ?? '')
          if (!['start', 'stop'].includes(action)) return sendJson(response, 400, { ok: false, error: 'bad-state' })
          const mod = await api()
          const ctl = mod.ctlFile()
          try {
            const { writeFileSync, mkdirSync } = await import('node:fs')
            const { dirname } = await import('node:path')
            mkdirSync(dirname(ctl), { recursive: true })
            writeFileSync(ctl, action, 'utf8')
          } catch (e) {
            return sendJson(response, 500, { ok: false, error: String(e?.message ?? e) })
          }
          return sendJson(response, 200, { ok: true, state: action })
        },
      },
      {
        kind: 'exact',
        path: `${API}/diag`,
        handler: async (request, response) => {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          const state = readState()
          const checks = []
          const push = (id, label, ok, detail) => checks.push({ id, label, ok: ok === true, detail: String(detail ?? '') })

          // ffmpeg
          const ff = String(state.ffmpegPath ?? '').trim()
          const { spawnSync } = await import('node:child_process')
          let ffOk = false
          let ffDetail = ''
          try {
            const r = spawnSync(ff || 'ffmpeg', ['-version'], { windowsHide: true, timeout: 8000, encoding: 'utf8' })
            ffOk = r.status === 0
            ffDetail = ffOk ? String(r.stdout || '').split('\n')[0].slice(0, 80) : `退出码 ${r.status}`
          } catch (e) {
            ffDetail = String(e?.message ?? e)
          }
          push('ffmpeg', 'ffmpeg（看屏幕要用）', ffOk, ffDetail || '没找到 ffmpeg')

          // python（听我说话要用）
          const py = String(state.pythonPath ?? '').trim()
          let pyOk = false
          let pyDetail = ''
          try {
            const r = spawnSync(py || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', 'import sys;print(sys.version.split()[0])'], {
              windowsHide: true, timeout: 10000, encoding: 'utf8',
            })
            pyOk = r.status === 0
            pyDetail = pyOk ? `Python ${String(r.stdout || '').trim()}` : `退出码 ${r.status}`
          } catch (e) {
            pyDetail = String(e?.message ?? e)
          }
          push('python', 'python（听我说话要用）', pyOk, pyDetail || '没找到 python')

          // TTS
          const tts = String(state.ttsUrl ?? '').trim()
          if (tts === '') {
            push('tts', 'TTS 地址（念出来要用）', false, '未填写 —— 「念出来」会保持关闭')
          } else {
            let ttsOk = false
            let ttsDetail = ''
            try {
              const url = tts.replace(/\/say\/?$/, '/health')
              const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
              ttsOk = r.ok
              ttsDetail = ttsOk ? `HTTP ${r.status}` : `HTTP ${r.status}`
            } catch (e) {
              ttsDetail = String(e?.message ?? e)
            }
            push('tts', 'TTS 服务', ttsOk, ttsDetail || tts)
          }

          // 麦克风：不真开麦（会亮灯），只报"引擎是否在跑"
          let earAlive = false
          try {
            earAlive = typeof syncEar === 'function' && readState().talk === true
          } catch {
            earAlive = false
          }
          push('mic', '语音引擎', earAlive, earAlive ? '已启动（录音时才占用麦克风）' : '未启动（「听我说话」关着）')

          return sendJson(response, 200, { ok: true, checks })
        },
      },
      {
        kind: 'exact',
        path: `${API}/agents`,
        handler(request, response) {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          let list = []
          try {
            list = host.agents?.list?.() ?? []
          } catch {
            list = []
          }
          const agents = list.map((a) => {
            let id = ''
            let title = ''
            try {
              id = String(a?.session?.id ?? '')
              title = String(a?.session?.title ?? a?.session?.header?.title ?? '')
            } catch {
              /* 拿不到就算空 */
            }
            let label = title
            let detail = ''
            if (label === '' && id !== '') {
              try {
                const info = sessionLabel(id)
                label = info.label
                detail = info.detail
              } catch {
                label = '会话 ' + id.slice(8, 16)
              }
            }
            return { id, title: label, detail, status: String(a?.status ?? '') }
          }).filter((a) => a.id !== '' && !a.id.startsWith('social-'))
          return sendJson(response, 200, { ok: true, agents })
        },
      },
      {
        kind: 'exact',
        path: `${API}/ear`,
        handler(request, response) {
          if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
          const state = readState()
          return sendJson(response, 200, {
            ok: true,
            on: state.talk === true,
            mode: state.talkMode === 'ptt' ? 'ptt' : 'always',
            engine: ear === null ? null : ear.status(),
            window: pttWin === null ? null : { alive: pttWin.alive() },
          })
        },
      },
    ]
    for (const route of routes) {
      host.effect(() => host.webServer.register(route), `playmate:route:${route.path}`)
    }

    // 自动看屏幕挂在这里：ear 的注入块已经被证明能跑起来（路由都在），
    // 而单独给 watch 开一个 inject 在真宿主里始终不触发（/watch 一直 404）。
    try {
      fileLog('ear: mounting watch')
      startWatch(ctx, host, host.attachments)
      fileLog('ear: watch mounted')
    } catch (e) {
      fileLog('ear: watch mount FAILED: ' + (e?.message ?? e))
    }

    // 记住"此刻在动的会话"：语音就灌到那个窗口里，而不是随便挑一个
    void (async () => {
      const mod0 = await import('./lib/ear.mjs')
      host.on?.('agent/assistant-stream', (payload) => {
        try {
          mod0.rememberActiveSession(String(payload?.agent?.session?.id ?? ''))
        } catch {
          /* 拿不到就算了 */
        }
      })
      host.on?.('agent/turn-stopping', (payload) => {
        try {
          mod0.rememberActiveSession(String(payload?.agent?.session?.id ?? ''))
        } catch {
          /* 同上 */
        }
      })
    })().catch(() => {})

    syncEar = async (on) => {
      if (!on) return await stop()
      // **不要**先 stop()：stop 会把引擎杀掉，切模式就得重新加载模型（25–45 秒）。
      // 交给 start() 判断：活着且模式不同 → 写模式文件热切换（<1 秒）；
      // 没活着 → 才真的拉起。这条是 2026-11-04 "切一直听要等 44 秒" 的根因。
      return await ensure()
    }

    // 开机对齐：说开着就起，关着就确保没在跑
    void ensure()
    // 看门狗：引擎自己死了就再拉起来（20 秒一次，安静重试）
    // 看门狗：带**退避**。以前每 20 秒硬拉一次，引擎起不来就变成"每 20 秒一个
    // 新进程"，互相抢显存和端口，最后谁都活不了（2026-11-04 凌晨就是这么崩的）。
    // 现在失败一次就等更久：30s → 60s → 120s → 300s 封顶；成功即清零。
    let failCount = 0
    let nextTryAt = 0
    watchdog = setInterval(() => {
      void (async () => {
        const state = readState()
        if (state.talk !== true) return
        const want = state.talkMode === 'always' ? 'always' : 'ptt'
        const runningMode = ear === null ? '' : (typeof ear.mode === 'function' ? ear.mode() : '')
        if (ear !== null && ear.alive() && runningMode === want) {
          failCount = 0
          return
        }
        // 活着但模式不对（比如切了 always，跑的还是 ptt）→ 也要重起
        if (ear !== null && ear.alive() && runningMode !== '' && runningMode !== want) {
          log(`[dsh-playmate/ear] 模式不一致（跑的是 ${runningMode}，要的是 ${want}），重起`)
        }
        const now = Date.now()
        if (now < nextTryAt) return
        log(`[dsh-playmate/ear] 引擎不在了，重新拉起（第 ${failCount + 1} 次）`)
        const r = await ensure().catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        const ok = r?.ok !== false && ear !== null && ear.alive()
        if (ok) {
          failCount = 0
          nextTryAt = 0
        } else {
          failCount += 1
          const wait = Math.min(300000, 30000 * 2 ** (failCount - 1))
          nextTryAt = Date.now() + wait
          log(`[dsh-playmate/ear] 拉起失败，${Math.round(wait / 1000)} 秒后再试`)
        }
      })().catch(() => {})
    }, 20000)
    if (typeof watchdog?.unref === 'function') watchdog.unref()
    ctx.effect?.(() => () => {
      if (watchdog !== null) clearInterval(watchdog)
      if (pttWin !== null) pttWin.stop('插件卸载')
      void stop()
    }, 'playmate:ear')
  })
}

/**
 * 挂「念出来」：听会话输出，只把开头那段交给本地 TTS。
 *
 * 只念前面一段是刻意的：整段念完又慢又吵，而且真正"陪在旁边"的时候，
 * 一句就够。念多少字可以在设置里改（默认 80，约 40 个汉字）。
 */
function registerHear(ctx) {
  ctx.inject(['agents'], (host) => {
    const log = (m) => {
      try {
        ctx?.logger?.info?.(m)
      } catch {
        /* 记不上不影响 */
      }
    }
    const hear = createHear({ getState: readState, log })
    /** 每个会话这一轮攒下来的回答文字 */
    const drafts = new Map()

    /** 只念目标会话的话；limit 为空 = 用「念多少字」 */
    const speakIfTarget = (sid, text, limit) => {
      if (String(text ?? '').trim() === '') return
      const state = readState()
      // 固定会话时，只念那个会话的回答，别把别的窗口的话念出来
      if (state.targetMode === 'fixed' && String(state.targetSessionId ?? '') !== '' && sid !== state.targetSessionId) return
      void hear.speak(text, limit)
    }

    try {
      host.on?.('agent/assistant-stream', (payload) => {
        const sid = String(payload?.agent?.session?.id ?? '')
        if (sid === '') return
        const frame = payload?.frame
        if (frame?.type === 'start') {
          // 一轮里模型常分好几段说（先给一句、调工具、再补结论）。原来这里直接
          // set(sid, '')，等于每开一段就把上一段抹掉，最终只剩最后一段被念出来。
          // 现在改成：开新段之前，先把上一段按「过程话」的上限念出去。
          const prev = drafts.get(sid) ?? ''
          if (prev.trim() !== '') {
            const mid = Number(readState().speakMidChars)
            speakIfTarget(sid, prev, Number.isFinite(mid) && mid > 0 ? mid : 40)
          }
          drafts.set(sid, '')
          return
        }
        if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
          drafts.set(sid, (drafts.get(sid) ?? '') + frame.chunk.text)
        }
      })

      host.on?.('agent/turn-stopping', (payload) => {
        const sid = String(payload?.agent?.session?.id ?? '')
        const text = drafts.get(sid) ?? ''
        drafts.delete(sid)
        speakIfTarget(sid, text)
      })
      log('[dsh-playmate/hear] 已挂上会话输出钩子')
    } catch (e) {
      log(`[dsh-playmate/hear] 挂钩子失败：${e?.message ?? e}`)
    }
  })
}

/**
 * 挂「自动看屏幕」：画面变化够大就把那一帧送进会话。
 *
 * 交付方式是一条用户消息（带图 + 一句说明）—— 和"用户把截图贴进来"是同一种东西，
 * 模型不需要自己调工具，也就不会出现"它以为还得再看一眼"的循环。
 */
function startWatch(ctx, host, attachments) {
  {
    const log = (m) => {
      try {
        ctx?.logger?.info?.(m)
      } catch {
        /* 记不上不影响 */
      }
    }
    log('[dsh-playmate/watch] 模块已挂载')
    const watch = createWatch({
      getState: readState,
      log,
      attachments: attachments ?? host.attachments,
      host,
    })

    try {
      // 先注册路由，再启动循环：路由不在，出问题时连看都看不到
    } catch {}
    const sync = async () => {
      const state = readState()
      if (state.see === true && state.seeMode === 'auto') {
        watch.start()
      } else {
        watch.stop('开关关着或手动模式')
      }
      return watch.status()
    }
    syncWatch = sync
    void sync()

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: `${API}/watch`,
      handler(request, response) {
        if (!loopbackOnly(request)) return sendJson(response, 403, { ok: false, error: 'loopback-only' })
        return sendJson(response, 200, { ok: true, ...watch.status(), mode: readState().seeMode })
      },
    }), 'playmate:route:/watch')

    ctx.effect?.(() => () => watch.stop('插件卸载'), 'playmate:watch')
  }
}
