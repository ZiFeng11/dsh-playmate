/**
 * ear.mjs —— 「耳朵」的宿主半边：拉起引擎、收文字、注进会话。
 *
 * 分工：
 *   ear.py（子进程）负责听麦 + 识别；它认得字之后 POST 到 /api/playmate/heard
 *   这里负责把文字注入当前会话，和「用户自己在输入框里说话」走同一条路
 *   （agent.followup(用户消息)），所以历史、上下文、记忆都接得上。
 *
 * 为什么不走全局热键：这台机器的沙箱里读不到键盘（GetAsyncKeyState 恒 0、
 * SetWindowsHookEx 直接失败），所以 ptt 模式的"按住"由界面按钮写控制文件驱动。
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const EAR_TAG = '[dsh-playmate/ear]'

export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function ctlFile() {
  return join(homeDir(), 'playmate-ptt.ctl')
}

function agentId(agent) {
  try {
    return String(agent?.session?.id ?? '')
  } catch {
    return ''
  }
}

function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 记住"最近真的在动的会话"——它就是用户此刻看着的那个窗口。
 *
 * 为什么需要：不指定会话时，光看 agents.list() 挑到的是"最后一个"或"唯一一个"，
 * 一旦同时存在别的会话（世界那边的家、微信桥的 social-*），语音就可能灌错窗口。
 */
let lastActiveSessionId = ''
/** 用户指定"语音只进这个会话"时，它优先于一切（防串台） */
let fixedSessionId = ''

export function setFixedSession(id) {
  fixedSessionId = typeof id === 'string' ? id.trim() : ''
}

export function getFixedSession() {
  return fixedSessionId
}

export function rememberActiveSession(id) {
  if (typeof id === 'string' && id !== '') lastActiveSessionId = id
}

export function activeSessionId() {
  return lastActiveSessionId
}

/** 挑一个会话：指定 > 最近活动的 > 唯一在跑的 > 最新的。 */
export function pickAgent(host, wanted) {
  let list = []
  try {
    list = host?.agents?.list?.() ?? []
  } catch {
    list = []
  }
  const usable = list.filter((a) => !agentId(a).startsWith('social-'))
  const explicit = wanted || fixedSessionId || lastActiveSessionId
  if (explicit) {
    const hit = usable.find((a) => agentId(a) === explicit)
    if (hit) return hit
  }
  const running = usable.filter((a) => String(a?.status ?? '') === 'running')
  if (running.length === 1) return running[0]
  if (usable.length >= 1) return usable[usable.length - 1]
  return null
}

export function injectText(host, text, wanted) {
  const agent = pickAgent(host, wanted)
  if (!agent) return { ok: false, error: 'no-agent' }
  try {
    agent.followup(userMessage(text))
    return { ok: true, target: agentId(agent) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 引擎管理器：插件活着的时候最多一个 ear.py。
 */
export function createEar(opts) {
  const { rootDir, log = () => {} } = opts
  let child = null
  /** 上次拉起时用的模式：切 ptt/always 时要靠它判断"要不要重起" */
  let spawnedMode = ''
  let startedAt = 0
  let lastExit = ''

  const script = join(rootDir, 'lib', 'asr', 'ear.py')
  const pidFile = join(homeDir(), 'playmate-ear.pid')
  /** 心跳文件：引擎每 5 秒写一次，用于判断"活着且没卡死" */
  /** 模式文件：写 ptt / always，引擎自己切，不用重启 */
  const modeFile = () => (typeof rootDir === 'string' && rootDir !== ''
    ? join(rootDir, 'dsh-playmate', 'ear.mode')
    : join(homeDir(), 'playmate-ear.mode'))

  const writeMode = (m) => {
    try {
      const f = modeFile()
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, m, 'utf8')
    } catch {
      /* 写不进去就退回重启 */
    }
  }

  const heartbeatFile = () => (typeof rootDir === 'string' && rootDir !== ''
    ? join(rootDir, 'dsh-playmate', 'ear.heartbeat')
    : join(homeDir(), 'playmate-ear.heartbeat'))

  /** 起之前先确保没有旧引擎在跑：多个引擎抢同一个麦克风时，谁都收不到音频。 */
  function killStale() {
    try {
      const old = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(old) && old > 0) {
        process.kill(old, 0)
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(old), '/F'], { windowsHide: true })
        } else {
          process.kill(old, 'SIGKILL')
        }
        log(`${EAR_TAG} 清掉旧引擎 pid=${old}`)
      }
    } catch {
      /* 没有旧 pid 文件，或者进程已经没了 */
    }
  }

  /**
   * 找 python：配置优先，其次常见的安装位置，最后才交给 PATH。
   *
   * 为什么要列候选：宿主的 PATH 里通常没有 python，直接 spawn `python` 会得到
   * **退出码 9009（命令不存在）**——引擎一启动就死，界面上看起来"没反应"。
   * 这台机器上踩过一次，所以默认就把常见路径试一遍。
   */
  function pythonCandidates(state) {
    const configured = String(state?.pythonPath ?? '').trim()
    if (configured !== '') return [configured]
    const win = process.platform === 'win32'
    // 只用**绝对路径**的候选；实在找不到才退回 PATH 里的 python/py。
    // 为什么：PATH 里的 `python` 可能是别的东西（这台机器上它是 uv 的 python，
    // 没有 sounddevice/numpy，spawn 出来会"活着但什么都不干"，很难查）。
    const absolutes = [
      process.env.PLAY_PYTHON,                                    // 环境变量最优先
      win ? join(rootDir, '.venv', 'Scripts', 'python.exe') : '', // 插件目录里的虚拟环境
      win ? join(homeDir(), '..', 'AppData/Local/Programs/Python/Python312/python.exe') : '/usr/bin/python3',
      win ? join(homeDir(), '..', 'AppData/Local/Programs/Python/Python311/python.exe') : '/usr/local/bin/python3',
    ].filter((x) => typeof x === 'string' && x !== '')
    const usable = absolutes.filter((x) => existsSync(x))
    if (usable.length > 0) return usable
    return [win ? 'python' : 'python3']
  }

  function pythonOf(state) {
    const list = pythonCandidates(state)
    for (const candidate of list) {
      if (candidate === 'py' || candidate === 'python' || candidate === 'python3') return candidate
      if (existsSync(candidate)) return candidate
    }
    return list[list.length - 1]
  }

  function pidAlive() {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (!Number.isFinite(pid) || pid <= 0) return false
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 心跳：最近 20 秒内写过就算活着（引擎每 5 秒写一次） */
  function heartbeatFresh() {
    try {
      const st = statSync(heartbeatFile())
      return Date.now() - st.mtimeMs < 20000
    } catch {
      return false
    }
  }

  /** 活着 = 自己拉的那个还活着，**或者** pid 文件里那个还活着。
   *  只看 child 会漏掉"端口被另一个引擎占着、插件自己那个已经退了"的情况，
   *  于是看门狗每 20 秒再拉一个，越拉越多。 */
  function alive() {
    // 有心跳文件就以它为准：文件在但太久没更新 = 卡死/已退出（pid 可能被复用，
    // 这时看 pid 反而会误判成"活着"，于是永远不再重启）。
    try {
      statSync(heartbeatFile())
      return heartbeatFresh()
    } catch {
      /* 没有心跳文件：退回 pid / child 判断 */
    }
    if (child !== null && child.exitCode === null && child.killed === false) return true
    return pidAlive()
  }

  function stop(reason = '手动') {
    // 先删心跳：否则 alive() 还会因为"心跳文件还很新"说活着，
    // 于是换模式时 start() 直接回 already、模式根本没换（2026-11-04 的 bug）。
    try {
      unlinkSync(heartbeatFile())
    } catch {
      /* 没有就算了 */
    }
    if (!alive()) {
      child = null
      return false
    }
    const pid = child?.pid
    try {
      if (process.platform === 'win32' && Number.isFinite(pid)) {
        // 用 taskkill /T /F：child.kill() 在 Windows 上偶尔打不死 python，
        // 打不死就会出现"旧引擎占着麦克风和端口、新引擎起不来"的死局。
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
      log(`${EAR_TAG} 已停（${reason}, pid=${pid}）`)
    } catch {
      /* 已经死了 */
    }
    child = null
    return true
  }

  function start(state, host) {
    if (!existsSync(script)) return { ok: false, error: 'ear.py 不在' }
    const want = state?.talkMode === 'always' ? 'always' : 'ptt'
    // 活着、而且模式一致，才算"已经起了"。
    // 只判断 alive 的话，切模式时会把旧模式的引擎当成"已经起了"，
    // 于是配置改了、进程却没换（2026-11-04 的 bug）。
    if (alive() && spawnedMode === want) return { ok: true, already: true }
    // 活着但模式不对：写个模式文件让它自己切，比重启快得多（毫秒 vs 25 秒）
    if (alive() && spawnedMode !== '') {
      writeMode(want)
      writeMode(want)
    spawnedMode = want
      return { ok: true, switched: true, mode: want }
    }
    killStale()
    const mode = state?.talkMode === 'ptt' ? 'ptt' : 'always'
    const ctl = ctlFile()
    mkdirSync(dirname(ctl), { recursive: true })
    writeFileSync(ctl, '', 'utf8')
    const args = [
      script,
      '--mode', mode,
      '--host', String(state?.earHost || host || 'http://127.0.0.1:3080'),
      '--ctl', ctl,
      '--threshold', String(Number(state?.vadThreshold) || 0.012),
      '--silence-ms', String(Number(state?.silenceMs) || 700),
      '--model', String(state?.asrModel || 'iic/SenseVoiceSmall'),
    ]
    try {
      child = spawn(pythonOf(state), args, {
        cwd: rootDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // 模型缓存目录：不写死，从设置里来（很多机器默认目录写不进去，
          // 指不到可写盘就会报 "model ... is not registered"）
          ...(String(state?.msCacheDir ?? '').trim() !== ''
            ? { PLAY_MODELSCOPE_CACHE: String(state.msCacheDir).trim() }
            : {}),
          // 纠错词表路径：留空 = 不启用（识别行为与原来完全一致）
          ...(String(state?.vocabPath ?? '').trim() !== ''
            ? { PLAY_VOCAB: String(state.vocabPath).trim() }
            : {}),
          // 心跳文件路径：引擎每 5 秒写一次，宿主用它判活
          // 推理设备：cuda（默认）/ cpu。cpu 不占显存，适合和游戏抢显卡的机器
          ...(String(state?.asrDevice ?? '').trim() !== ''
            ? { PLAY_ASR_DEVICE: String(state.asrDevice).trim() }
            : {}),
          // 心跳文件路径：引擎每 5 秒写一次，宿主用它判活
          PLAY_EAR_HEARTBEAT: heartbeatFile(),
          PLAY_EAR_MODE_FILE: modeFile(),
        },
      })
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
    writeMode(want)
    spawnedMode = want
    startedAt = Date.now()
    try {
      writeFileSync(pidFile, String(child?.pid ?? ''), 'utf8')
    } catch {
      /* 记不上不影响运行 */
    }
    child.stdout?.on('data', (b) => log(`${EAR_TAG} ${String(b).trim().slice(0, 200)}`))
    child.stderr?.on('data', (b) => {
      const s = String(b).trim()
      if (s !== '') log(`${EAR_TAG} stderr: ${s.slice(-200)}`)
    })
    child.on('exit', (code, signal) => {
      try {
        unlinkSync(pidFile)
      } catch {
        /* 已经没了 */
      }
      lastExit = `code=${code} signal=${signal}`
      log(`${EAR_TAG} 退出 ${lastExit}`)
      child = null
    })
    log(`${EAR_TAG} 已启动（mode=${mode}, pid=${child?.pid ?? '?'}）`)
    return { ok: true, mode, pid: child?.pid ?? null }
  }

  function status() {
    return { alive: alive(), pid: child?.pid ?? null, startedAt, lastExit }
  }

  return { start, stop, alive, status, script }
}
