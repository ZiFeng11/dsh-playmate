"""ear.py —— 陪玩的「耳朵」：常驻听麦，说完一句就把文字交给宿主。

两种模式：
  always  一直听：能量 VAD 判断"有人在说"，说完（静音 0.7 秒）就识别、发送
  ptt     按住说：宿主写一个控制文件（start/stop），stop 时识别刚录的那段

为什么不用全局热键：宿主沙箱里的进程读不到键盘（GetAsyncKeyState 恒为 0、
SetWindowsHookEx 直接失败、keyboard 库也收不到）——热键这条路在这里走不通。
所以 ptt 模式的"按住"由界面上的按钮驱动，控制文件是它的信号通道。

用法（由插件拉起，也可手动调试）：
  python ear.py --mode always --host http://127.0.0.1:3080
  python ear.py --mode ptt --ctl D:/path/ptt.ctl --host http://127.0.0.1:3080
"""
import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.request
import wave

os.environ.setdefault("PYTHONUTF8", "1")
# 模型缓存目录：不写死，由宿主用环境变量传进来。
# 为什么必须可配：默认缓存目录在用户主目录下，有些机器（包括这台）写不进去，
# 那时 funasr 会解析不到模型，报 "model 'iic/SenseVoiceSmall' is not registered"。
_ms_cache = os.environ.get("PLAY_MODELSCOPE_CACHE", "").strip()
if _ms_cache:
    os.environ["MODELSCOPE_CACHE"] = _ms_cache
# 模型缓存/临时目录都用系统默认。要换位置请在外部设 MODELSCOPE_CACHE / TMPDIR，
# 不要写死机器相关的路径 —— 这个文件是要发出去的。


import numpy as np  # noqa: E402
import sounddevice as sd  # noqa: E402

SR = 16000
BLOCK = 0.1
TAG_RE = re.compile(r"<\|[^|]+\|>")

import tempfile

# ---- 纠错词表 ----------------------------------------------------------
# 语音识别对专有名词、英文缩写、同音字一向不稳。这是留给使用者的入口：
# 一个纯文本词表，每次识别前重读一遍（改完不用重启引擎）。
# 格式见仓库根目录的 vocab.example.txt。路径由 PLAY_VOCAB 指定；不指定则不启用。
VOCAB_PATH = os.environ.get("PLAY_VOCAB", "").strip()


def load_vocab(path=VOCAB_PATH):
    """读词表。

    返回 (显式替换, 正则规则, 热词表)：
      显式替换 [(错, 对)]
      正则     [(模式, 替换)]
      热词表   [正确词]  —— 取自每条规则的右值，供拼音模糊匹配兜底

    为什么右值也要拿来当热词：模糊匹配（阈值 0.85）能抓住只差声母韵母的近音写法，
    不用一个个把错写法列出来。但它够不着差得远的，那种还是得靠左边的显式映射。
    """
    explicit, regexes, targets = [], [], []
    if not path:
        return explicit, regexes, targets
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=>" not in line:
                    continue
                left, right = line.split("=>", 1)
                left, right = left.strip(), right.strip()
                if left == "":
                    # 左边留空 = 只加热词，不配错词：交给拼音模糊匹配去抓近音写法，
                    # 不用提前想它会错成什么样。
                    if right and right not in targets:
                        targets.append(right)
                    continue
                if left.startswith("re:"):
                    regexes.append((left[3:].strip(), right))
                else:
                    explicit.append((left, right))
                    if right and right not in targets:
                        targets.append(right)
    except Exception:
        pass
    return explicit, regexes, targets


def build_matcher(targets, threshold=0.85):
    """拼音模糊匹配器；词表为空、或环境里跑不了时返回 None（只用显式替换）。"""
    if not targets:
        return None
    try:
        from funasr.utils.postprocess_hotwords import build_postprocess_hotword_matcher

        return build_postprocess_hotword_matcher(
            postprocess_hotwords=targets,
            postprocess_hotword_threshold=threshold,
        )
    except Exception as e:
        log(f"热词匹配器建不起来（{type(e).__name__}: {e}），只用显式替换")
        return None


_MATCHER_CACHE = {"key": None, "matcher": None}


def get_matcher(targets, threshold=0.85):
    """带缓存的匹配器：词表内容不变就复用。

    注意成本构成：建表本身是毫秒级，但**第一次** import
    funasr.utils.postprocess_hotwords 很贵（它会把 funasr 一大片拽进来）。
    所以启动时先 warmup_matcher() 把这笔开销吃掉，别让它落在第一句话上。
    """
    key = (tuple(sorted(targets)), threshold)
    if _MATCHER_CACHE["key"] == key:
        return _MATCHER_CACHE["matcher"]
    m = build_matcher(targets, threshold)
    _MATCHER_CACHE["key"] = key
    _MATCHER_CACHE["matcher"] = m
    return m


def warmup_matcher():
    targets = load_vocab()[2]
    if not targets:
        return
    t0 = time.time()
    get_matcher(targets)
    log(f"热词匹配器预热完成（{time.time() - t0:.1f}s，热词 {len(targets)} 个）")


def apply_vocab(text, rules, matcher=None):
    """显式替换 → 正则 → 拼音模糊兜底。顺序不能反：正则看的是原始上下文。"""
    if not text:
        return text
    explicit, regexes, _targets = rules
    for left, right in explicit:
        text = text.replace(left, right)
    for pat, rep in regexes:
        try:
            text = re.sub(pat, rep, text)
        except Exception:
            continue
    if matcher is not None:
        try:
            text, _matches = matcher.apply_text(text)
        except Exception:
            pass
    return text


_LOG_DIR = pathlib.Path(tempfile.gettempdir()) / "dsh-playmate"
LOG_PATH = pathlib.Path(os.environ.get("PLAY_EAR_LOG", str(_LOG_DIR / "ear.log")))


# 心跳：每 5 秒写一次时间戳。宿主靠它判断"引擎还活着吗"，
# 而不是靠 child 句柄或 pid 文件 —— 那两个在 Windows 上都会骗人
# （进程还在但已经卡死、pid 被复用、child 在重启后变 null）。
HB_PATH = pathlib.Path(os.environ.get("PLAY_EAR_HEARTBEAT", str(_LOG_DIR / "ear.heartbeat")))
# 模式文件：ptt / always。改了它，引擎**不用重启**就能换模式
# （重启一次要重新加载模型，25 秒；换文件是毫秒级）
MODE_FILE = pathlib.Path(os.environ.get("PLAY_EAR_MODE_FILE", str(_LOG_DIR / "ear.mode")))


def desired_mode(fallback):
    try:
        if MODE_FILE.exists():
            v = MODE_FILE.read_text(encoding="utf-8").strip().lower()
            if v in ("always", "ptt"):
                return v
    except Exception:
        pass
    return fallback


def beat():
    try:
        HB_PATH.parent.mkdir(parents=True, exist_ok=True)
        HB_PATH.write_text(f"{os.getpid()} {time.time():.1f}", encoding="utf-8")
    except Exception:
        pass


def heartbeat_loop():
    """后台线程：从进程一起来就每 5 秒打一次心跳。
    为什么必须独立线程：模型加载要 20–30 秒，那段里主线程还没进循环，
    宿主如果只看主循环的心跳，会以为引擎卡死，于是不断重启（今晚就是这么翻车的）。"""
    while True:
        beat()
        time.sleep(5)


def log(msg):
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass


def rms(x):
    return float(np.sqrt(np.mean(np.square(x))) + 1e-9)


class Ear:
    def __init__(self, mode, host, ctl, threshold, silence_ms, max_sec, model="iic/SenseVoiceSmall"):
        self.model_name = model
        self.base_threshold = float(threshold) if threshold else 0.012
        self.mode = mode
        self.host = host.rstrip("/")
        self.ctl = pathlib.Path(ctl) if ctl else None
        self.threshold = threshold
        self.silence_blocks = max(1, int(silence_ms / 1000 / BLOCK))
        self.max_blocks = int(max_sec / BLOCK)
        self.model = None

    def load(self):
        from funasr import AutoModel

        # 优先用本地已下载的模型目录：写 repo id 会让它每次启动都去远端核对 20 个文件
        # （实测多花 27 秒，网络差的时候更久）。本地目录存在就直接用。
        # 用 repo id 让 funasr 走它自己的缓存解析（直接用本地目录会缺 configuration.json
        # 之类的东西，实测会报 "No module named 'funasr.models.decoder'"）。
        # 想强制换模型就用 PLAY_ASR_MODEL。
        target = self.model_name or os.environ.get("PLAY_ASR_MODEL", "") or "iic/SenseVoiceSmall"
        # 推理设备：cuda（默认）/ cpu。cpu 不占显存，适合和游戏抢显卡的机器；
        # SenseVoiceSmall 是非自回归模型，CPU 上也能跑，只是慢一些。
        device = (os.environ.get("PLAY_ASR_DEVICE", "") or "cuda").strip().lower() or "cuda"
        t0 = time.time()
        self.model = AutoModel(model=target, disable_update=True, device=device)
        log(f"模型来源：{target}（device={device}）")
        log(f"识别模型就绪（{time.time() - t0:.1f}s；模式={self.mode}；阈值={self.threshold}）")
        warmup_matcher()

    def asr(self, audio):
        import tempfile
        # 留一份最后一段录音，方便查"为什么只认出尾巴"
        try:
            keep = pathlib.Path(os.environ.get("PLAY_EAR_SAMPLE", str(_LOG_DIR / "last_ptt.wav")))
            keep.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(keep), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SR)
                w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
            seg = 10
            per = max(1, len(audio) // seg)
            levels = [float(np.sqrt(np.mean(np.square(audio[i:i+per])))) for i in range(0, len(audio)-per+1, per)]
            log("分段电平: " + " ".join(f"{x:.3f}" for x in levels[:12]))
        except Exception as e:
            log(f"存样本失败：{e}")

        tmp = pathlib.Path(tempfile.gettempdir()) / f"ear-{int(time.time() * 1000)}.wav"
        with wave.open(str(tmp), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
        t = time.time()
        try:
            r = self.model.generate(input=str(tmp), language="zh", use_itn=True)
            text = TAG_RE.sub("", (r[0]["text"] if r else "")).strip()
        finally:
            try:
                tmp.unlink()
            except Exception:
                pass
        log(f"识别 {time.time() - t:.2f}s -> {text!r}")
        return text

    def send(self, text):
        if not text:
            return
        body = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.host + "/api/playmate/heard", data=body,
                                     headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                log(f"发送 -> {r.read().decode('utf-8', 'ignore')[:120]}")
        except Exception as e:
            log(f"发送失败：{e}")

    @staticmethod
    def meaningful(text):
        """只有标点/空白的结果不算话（实测：一声杂音会被识别成 '。'）。"""
        return re.search(r"[0-9A-Za-z一-鿿]", text or "") is not None

    def transcribe_and_send(self, buf):
        if len(buf) * BLOCK < 0.45:
            log(f"太短（{len(buf) * BLOCK:.2f}s），丢掉")
            return
        audio = np.concatenate(buf) if buf else np.zeros(0)
        text = self.asr(audio)
        # 纠错词表（每次重读，改完不用重启；匹配器有缓存，词表变了才重建）
        rules = load_vocab()
        if rules[0] or rules[1] or rules[2]:
            fixed = apply_vocab(text, rules, get_matcher(rules[2]))
            if fixed != text:
                log(f"词表纠错：{text[:40]!r} → {fixed[:40]!r}")
            text = fixed
        if not self.meaningful(text):
            log(f"没有实际内容（{text!r}），不发送")
            return
        self.send(text)

    # ---- 常驻听 ----
    def run_always(self):
        log("=== 开始常听（说完自动发送） ===")
        buf, speaking, quiet, voiced = [], False, 0, 0
        peak, last_report = 0.0, time.time()
        with sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=int(SR * BLOCK)) as stream:
            # 先量 1.5 秒环境底噪，自动定阈值。
            # 固定阈值在不同麦克风上差别太大 —— 这台机器上 0.012 高到听不见人说话。
            floor = []
            for _ in range(15):
                blk, _ = stream.read(int(SR * BLOCK))
                floor.append(rms(blk[:, 0]))
            # 用 20 分位而不是中位数：中位数容易被"校准那两秒正好在说话/有风扇"带高，
            # 阈值一高，人说话都过不去（实测踩过：底噪量成 0.0185 → 阈值 0.048，
            # 而说话峰值只有 0.0436，永远触发不了）。
            noise = float(np.percentile(floor, 20)) if floor else 0.0
            threshold = max(max(0.012, self.base_threshold), min(0.05, noise * 1.8))
            self.threshold = threshold
            log(f"底噪 {noise:.4f} → 自动阈值 {threshold:.4f}")

            while True:
                beat()
                if desired_mode("always") != "always":
                    log("模式切走了（always → 别的），本条循环退出")
                    return
                block, _ = stream.read(int(SR * BLOCK))
                mono = block[:, 0].copy()
                level = rms(mono)
                peak = max(peak, level)
                if time.time() - last_report > 10:
                    log(f"电平峰值 {peak:.4f}（阈值 {threshold:.4f}）")
                    peak, last_report = 0.0, time.time()

                loud = level >= threshold
                if not speaking:
                    # 连续两拍够响才算"开口"：单拍也可能是咔哒声
                    if loud:
                        voiced += 1
                        if voiced >= 2:
                            speaking, buf, quiet = True, [mono], 0
                            log(f"听到说话（{level:.3f}）")
                    else:
                        voiced = 0
                    continue
                # 已经在说话：攒帧，静音够了就收尾
                buf.append(mono)
                quiet = 0 if loud else quiet + 1
                if quiet >= self.silence_blocks or len(buf) >= self.max_blocks:
                    log(f"一句结束（{len(buf) * BLOCK:.1f}s）")
                    self.transcribe_and_send(buf)
                    speaking, buf, quiet, voiced = False, [], 0, 0

    # ---- 按住说 ----
    def run_ptt(self):
        """热键模式：**只在录音时打开麦克风**，说完立刻关掉。

        为什么要这样：常听模式可以一直占着麦克风，但热键模式绝大多数时间是闲着的，
        一直占着会让系统的"麦克风正在使用"图标一直亮、也让用户不放心。
        打开/关闭 InputStream 的代价约 100–300 毫秒，可以接受。
        """
        log(f"=== 热键模式：按一下开始，说完安静约 1 秒自动发送（空闲时不占麦克风） ===")
        # 启动时先读一次当前内容：上次残留的 start 令牌不该让程序一进来就录。
        # 但"刚按下不久的"（30 秒内）要接上 —— 引擎加载那几秒里按的那一下
        # 本来会被当成残留丢掉，表现就是"热键没反应"（2026-11-04 的现象）。
        try:
            cur = (
                self.ctl.read_text(encoding="utf-8").strip().lstrip("\ufeff").strip()
                if (self.ctl and self.ctl.exists())
                else ""
            )
            last = ""
            if cur.startswith("start:"):
                try:
                    ts = int(cur.split(":", 1)[1]) / 1000.0
                    last = "" if (time.time() - ts) < 30 else cur
                except Exception:
                    last = cur
            else:
                last = cur
        except Exception:
            last = ""
        while True:
            if desired_mode("ptt") != "ptt":
                log("模式切走了（ptt → 别的），本条循环退出")
                return
            cmd = ""
            try:
                if self.ctl and self.ctl.exists():
                    cmd = self.ctl.read_text(encoding="utf-8").strip().lstrip("﻿").strip()
            except Exception:
                cmd = ""
            beat()
            if cmd == last or not cmd.startswith("start"):
                time.sleep(0.5)
                continue
            last = cmd
            log("按下：打开麦克风开始录")
            buf, speech_seen, quiet = [], False, 0
            threshold = 0.02
            done = False
            try:
                with sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=int(SR * BLOCK)) as stream:
                    # 量 1 秒底噪再定门槛（原来只量 0.5 秒，正好有人在动/说话就量高了，
                    # 门槛冲到 0.034，人说话峰值 0.03 都过不去 —— 2026-11-04 的坑）
                    floor = []
                    for _ in range(10):
                        blk, _ = stream.read(int(SR * BLOCK))
                        floor.append(rms(blk[:, 0]))
                    noise = float(np.percentile(floor, 20)) if floor else 0.0
                    # 上限压到 0.025：这台机器说话峰值常在 0.03 左右，门槛再高就永远不触发
                    threshold = max(max(0.010, self.base_threshold), min(0.025, noise * 1.5))
                    log(f"底噪 {noise:.4f} → 讲话门槛 {threshold:.4f}")
                    while not done:
                        blk, _ = stream.read(int(SR * BLOCK))
                        mono = blk[:, 0].copy()
                        buf.append(mono)
                        level = rms(mono)
                        if level >= threshold * 1.4:
                            speech_seen = True
                            quiet = 0
                        elif speech_seen:
                            quiet += 1
                            if quiet >= int(1.0 / BLOCK):
                                done = True
                        # 手写 stop 也立刻收尾
                        try:
                            if self.ctl.exists() and self.ctl.read_text(encoding="utf-8").strip().lstrip("﻿").strip() == "stop":
                                done = True
                        except Exception:
                            pass
                        if len(buf) >= self.max_blocks:
                            done = True
                    # 收尾缓冲：别切掉最后一个字（必须在 with 里面，麦克风还没关）
                    for _ in range(3):
                        try:
                            tail, _ = stream.read(int(SR * BLOCK))
                            buf.append(tail[:, 0].copy())
                        except Exception:
                            break
            except Exception as e:
                log(f"录音出错：{e}")
                continue
            if not speech_seen:
                log("只录到底噪，没有讲话，丢掉")
                continue
            log(f"结束：{len(buf) * BLOCK:.1f}s，开始识别")
            self.transcribe_and_send(buf)


def _host_addr(host):
    """把 --host 拆成 (hostname, port)，容忍不带 scheme 的写法。"""
    from urllib.parse import urlparse

    s = (host or "").strip()
    if "://" not in s:
        s = "http://" + s
    u = urlparse(s)
    return (u.hostname or "127.0.0.1"), (u.port or (443 if u.scheme == "https" else 80))


def host_watchdog(host, every=5.0, misses=3):
    """宿主没了，本进程就跟着走。

    Windows 不会级联杀子进程：DSH 一关，这里 spawn 出来的引擎就成了孤儿 ——
    麦克风被占着，本机还多出一个找不到来路的 python 进程。更麻烦的是它锁着
    claim_port 那个端口，下次 DSH 起来时新引擎抢不到就直接退出，表现成"一直
    听没反应"，而日志里什么异常都没有。

    multiprocessing 的父子链在 spawn 之后也断了，按 pid 追并不可靠，所以改成
    问端口：宿主还听不听得到，比 pid 实在。连续 misses 次连不上就认定它走了。
    """
    import socket
    import subprocess as _sp

    h, p = _host_addr(host)
    bad = 0
    while True:
        time.sleep(every)
        try:
            with socket.create_connection((h, p), timeout=2.0):
                bad = 0
                continue
        except OSError:
            bad += 1
        log(f"宿主没响应（{bad}/{misses}）")
        if bad < misses:
            continue
        log("宿主已退出，引擎跟着退")
        _bye()
        # taskkill 只有 Windows 有：/T 连子进程树一起收。其他平台这一步会静默
        # 跳过，只靠下面的 os._exit 收掉自己。
        try:
            _sp.run(["taskkill", "/PID", str(os.getpid()), "/T", "/F"], capture_output=True)
        except Exception:
            pass
        os._exit(0)


def claim_port(port=7872):
    """单实例：抢一个本地端口。抢不到说明已经有引擎在跑，本进程直接退出。
    插件可能被两个 profile 各加载一次（注册两遍），多个引擎同时开同一个麦克风，
    谁都收不全 —— 表现就是"一直听没反应"。"""
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(1)
        return sock
    except OSError:
        log(f"端口 {port} 已被占用 —— 已有引擎在跑，本进程退出")
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["always", "ptt"], default="always")
    ap.add_argument("--host", default="http://127.0.0.1:3080")
    ap.add_argument("--ctl", default="")
    ap.add_argument("--threshold", type=float, default=0.012)
    ap.add_argument("--silence-ms", type=int, default=700)
    ap.add_argument("--max-sec", type=float, default=15)
    ap.add_argument("--model", default=os.environ.get("PLAY_ASR_MODEL", "iic/SenseVoiceSmall"))
    a = ap.parse_args()
    beat()
    import threading

    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=host_watchdog, args=(a.host,), daemon=True).start()
    holder = claim_port()
    if holder is None:
        return
    ear = Ear(a.mode, a.host, a.ctl, a.threshold, a.silence_ms, a.max_sec, a.model)
    log(f"启动 mode={a.mode} host={a.host} th={a.threshold}")
    ear.load()
    # 模型只加载一次；之后靠模式文件热切换（改文件 = 毫秒级，不用重启）
    mode = desired_mode(a.mode)
    while True:
        if mode == "ptt":
            ear.run_ptt()
        else:
            ear.run_always()
        new_mode = desired_mode(mode)
        if new_mode == mode:
            break
        log(f"切换模式：{mode} → {new_mode}（不重启、不重新加载模型）")
        mode = new_mode


def _bye():
    try:
        HB_PATH.unlink(missing_ok=True)
    except Exception:
        pass


if __name__ == "__main__":
    import atexit

    atexit.register(_bye)
    main()
