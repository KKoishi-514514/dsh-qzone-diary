// qq-qzone-diary · 让小鲸按自己的心情，随手写一条 QQ 说说
//
// 需求（主人 2026-10-24 提的）：
//   · 跟我私聊的小鲸要学会写日记，以 QQ 说说的形式发出去
//   · 不用按时按点 —— 时间随机，什么时候想写就什么时候写
//   · 字数随机，跟着她的心情走
//   · 人设不变（还是那份角色卡里的小鲸）
//   · 配图由她自己挑
//   · 结尾不许总结、不许升华，力求像真人随手打的
//
// 它怎么做到「她自己写」：
//   1. 读她的人设卡（和桥接每轮注入的是同一份 roles/小鲸.md）
//   2. 读她此刻的心情（dsh-feiyu-mood 的 state.json：mood / 六根情绪 / 刚才在想什么）
//   3. 读今天私聊里真发生过的事（qq-bridge 的 /api/socialV2/recent）
//   4. 读她记着的事（共享笔记 shared-notes.json）和自己上几条说说（避免重复）
//   5. 把这些一起喂给模型，让她以第一人称写一篇 —— 不套模板、不总结
//   6. 从她的表情包图库里挑 0~2 张配图（图库带描述，由她自己决定配不配）
//   7. 走 SnowLuma 的 OneBot HTTP 接口 send_qzone_msg 发到她的 QQ 空间
//
// 为什么不用「唤醒她自己的会话」再让她发：
//   QQ 那边的工具面里没有发说说的工具（要改桥接和 preset 才加得上），而且把她叫醒
//   容易顺手去私聊主人。这里用同一份人设 + 同一份心情 + 同一份聊天记录单独写一篇，
//   口吻还是她的，又不会打扰聊天。
//
// 本插件用 link: 装（源码在工作区），@deepseek-ai/* 只挂在 app.asar 里解析不到，
// 所以只用 node 内置模块；node:sqlite 只在读表情包索引时用，读不到就退回扫目录。

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  statSync, renameSync, readdirSync,
} from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'qq-qzone-diary'
export const inject = ['llm', 'agents', 'systemPrompt', 'timer']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_DIR = join(HOME, 'qq-qzone-diary')
const CONFIG_PATH = join(STORE_DIR, 'config.json')
const STATE_PATH = join(STORE_DIR, 'state.json')
const LOG_PATH = join(STORE_DIR, 'diary.log')
const POSTS_PATH = join(STORE_DIR, 'posts.jsonl')
const IMAGES_DIR = join(STORE_DIR, 'images')
const LOG_MAX_BYTES = 256 * 1024
// 结构化「空间事件」出口：apply() 里接管，写进 state.spaceEvents 供每轮上下文使用
let spaceEventSink = null
const MIN_MS = 60 * 1000

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

// 主人的 QQ：不写死在源码里。用环境变量 QQ_QZONE_OWNER_QQ 配，
// 或直接在 <DSH_HOME>/qq-qzone-diary/config.json 里写 ownerQQ / sourceKey 覆盖。
const OWNER_QQ = String(process.env.QQ_QZONE_OWNER_QQ || '').trim()

// ── 默认配置 ────────────────────────────────────────────────────────────────
// 第一次启动会把它落成 <DSH_HOME>/qq-qzone-diary/config.json，之后直接改那个文件；
// profile 的 cordis.patch.yml 里给这一行写的 config 也会叠上来（改起来更方便）。
const DEFAULTS = {
  enabled: true,

  // 从谁的私聊里取材（说说发在 SnowLuma 当前登录的那个号的空间里）
  sourceKey: OWNER_QQ ? `private:${OWNER_QQ}` : '',
  selfName: '小鲸',
  ownerName: '主人',

  // 人设卡：和桥接注入的是同一份，改了立刻生效（按 mtime 缓存）
  rolePath: '',
  // 心情（dsh-feiyu-mood）
  moodPath: join(HOME, 'feiyu-mood', 'state.json'),
  // 共享笔记（她记着的事）
  notesPath: '',
  notesLimit: 12,
  // 把「今天在空间干了什么」写进共享笔记 —— 桥接每轮把笔记同步进角色卡，
  // 私聊里的她就能接着说这些事（不然她会说「那不是本鲸」）
  notesEnabled: true,
  // DSH 侧 per-turn 挂载（会和上一代实例的注册打架，默认关；改走桥接文件）
  spaceContext: false,
  // 桥接每轮会读这个文件，把「今天空间近况」附在角色行后面
  spaceFile: '',
  spaceContextMaxEvents: 4,
  // 桥接的会话表：用来找到 QQ 那边的 DSH 会话
  sessionsPath: '',

  // 当天聊天：qq-bridge 控制台接口
  bridgeBase: 'http://127.0.0.1:3100',
  consoleTokenPath: '',
  chatLimit: 100,
  chatLookbackHours: 20,
  chatMaxChars: 2600,

  // 发说说：SnowLuma OneBot HTTP
  snowlumaHttpUrl: 'http://127.0.0.1:3000',
  // 留空 = 先读 qq-bridge/config.json 的 snowluma.accessToken，再读 SnowLuma 的 onebot_<uin>.json
  snowlumaToken: '',
  snowlumaConfigDir: '',
  // 备选：qq-bridge 的 config.json（读里面的 snowluma.accessToken）
  bridgeConfigPath: '',
  publishTimeoutMs: 60000,
  // 说说权限：1=公开 4=好友可见 9=仅自己可见（按 QQ 空间的字段）
  ugcRight: 1,

  // ── 什么时候写：不按点，只给区间 ──
  activeHours: ['08:30', '23:40'],
  // 两次说说之间的随机间隔（分钟）
  gapMinutes: [150, 400],
  // 到了那个时间点，她真的想写的概率（不想写就悄悄跳过）
  writeChance: 0.62,
  // 一天最多几条（防跑飞）
  dailyMax: 3,
  // 两条说说之间至少隔多久（分钟）
  minGapMinutes: 90,

  // ── 写多长：随机，会被心情再收一次 ──
  length: [70, 300],
  // 心情低的时候话变少（下限/上限乘这个系数）
  lowMoodShrink: 0.55,

  // ── 配图：从她的表情包图库里自己挑 ──
  images: {
    enabled: true,
    // 这一条要不要给她配图候选（剩下的是纯文字说说）
    chance: 0.8,
    // 一次给几张候选让她挑
    candidates: 10,
    // 最多配几张
    max: 2,
    // 额外的手动图库（可以往里丢照片，文件名当描述，或配同名 .txt 写描述）
    dir: IMAGES_DIR,
    // dsh-meme 图库（大肥鱼/小鲸鱼那套，24 张，带 caption）
    memeDb: join(HOME, 'profiles', 'web', 'node_modules', 'dsh-meme', 'memes', 'dafeiyu-001', 'index.db'),
    memeRoot: join(HOME, 'profiles', 'web', 'node_modules', 'dsh-meme', 'memes', 'dafeiyu-001'),
  },

  // ── 回评论：她空间里有人评论她的说说，她自己回去 ──
  comments: {
    enabled: true,
    // 隔多久去看一眼有没有新评论（分钟，可以带小数）
    pollMinutes: 10,
    // 轮询时间的随机抖动（分钟）
    pollJitterMinutes: 3,
    // 看到新评论后真的回的几率（剩下的是「这次懒得回 / 还没想好」）
    replyChance: 0.92,
    // 超过这么久的评论不再回（太旧了突然回复很怪）
    maxReplyAgeHours: 48,
    // 每小时 / 每天最多回几条
    maxRepliesPerHour: 10,
    maxRepliesPerDay: 20,
    // 同一条说说下面最多回几条（防跟人来回刷）
    maxRepliesPerPost: 10,
    // 同一个「评论 + 它的回复」里最多回几轮（多轮对话靠模型自己决定接不接）
    maxRepliesPerThread: 6,
    // 一轮最多回几条
    maxPerPoll: 2,
    // 回评的字数上限
    maxReplyChars: 70,
    // 检查最近几条说说
    postsToCheck: 12,
    // 主人自己的 QQ（他评论时语气会软下来；可从 qq-bridge config 覆盖）
    ownerQQ: Number(OWNER_QQ) || 0,
    // 真回之前先「看一会儿」再回，别秒回得像脚本（毫秒）
    replyDelayMs: [15000, 60000],
    // 调试：启动后 N 分钟先查一次（0 = 不额外查）
    runAfterMinutes: 0,
    // 调试：回评只写日志不发出去
    dryRun: false,
  },

  // ── 好友动态：朋友发了说说就去留一句（后续回不回交给模型） ──
  friends: {
    enabled: true,
    // 留空的 0~1 概率门槛：默认 1 = 看到就去评（主人 2026-10-24 定的）
    chance: 1,
    // 一天最多留几条（防意外刷屏；正常一天也到不了）
    maxPerDay: 10,
    // 一轮最多评几条（多了就排到下一轮）
    maxPerPoll: 3,
    // 刚发几十秒的说说就去评论太假，先等一会儿
    minAgeMinutes: 20,
    // 超过这么久的不评论了
    maxAgeHours: 24,
    // 一次看多少条动态
    postsToCheck: 12,
    // 只评这些人（空 = 所有好友）；填上就只评列表里的
    allowUins: [],
    // 永不评论这些人
    skipUins: [],
    // 主人的说说要不要也去留一句（默认也去 —— 那是她男朋友的空间）
    commentOwner: true,
    // 评论字数上限
    maxChars: 50,
    // 留评论前先「看一会儿」（毫秒）
    delayMs: [8000, 25000],
    // 调试：只写日志不真发
    dryRun: false,
  },

  // ── 模型 ──
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  temperature: 0.95,
  maxTokens: 900,
  timeoutMs: 180000,

  // ── 调试 ──
  dryRun: false,
  // 启动后 N 分钟试写一次（调试用；会跳过「概率」和「每日上限」，但不跳过 dryRun）
  runAfterMinutes: 0,
}

// ── 小工具 ────────────────────────────────────────────────────────────────
function ensureStore() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true })
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  try {
    ensureStore()
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch { /* 落盘失败不影响主流程 */ }
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try {
    ensureStore()
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`)
    appendFileSync(LOG_PATH, text + '\n', 'utf8')
  } catch { /* noop */ }
  try { console.log('[qq-qzone-diary] ' + line) } catch { /* noop */ }
}

/** 'HH:mm' → 当天第几分钟；非法返回 null */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function minutesNow(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/** 现在是否在活跃时段内（支持跨零点） */
function inActiveHours(date, hours) {
  const from = minutesOf(hours?.[0])
  const to = minutesOf(hours?.[1])
  if (from === null || to === null || from === to) return true
  const now = minutesNow(date)
  return from < to ? now >= from && now < to : now >= from || now < to
}

/** 下一个活跃时段的起点（严格晚于 date） */
function nextActiveStart(date, hours) {
  const from = minutesOf(hours?.[0])
  if (from === null) return null
  const at = new Date(date)
  at.setHours(Math.floor(from / 60), from % 60, 0, 0)
  if (at.getTime() <= date.getTime()) at.setDate(at.getDate() + 1)
  return at
}

function dayKeyOf(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function randInt(lo, hi) {
  const a = Math.max(0, Math.round(lo))
  const b = Math.max(a, Math.round(hi))
  return a + Math.floor(Math.random() * (b - a + 1))
}

function pickOne(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  return list[Math.floor(Math.random() * list.length)]
}

function readText(path) {
  try {
    if (!path || !existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 读一个令牌文件：可能是纯文本，也可能包了 JSON */
function readTokenFile(path) {
  const raw = readText(path).trim()
  if (!raw) return ''
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw)
      return String(j.token ?? j.consoleToken ?? j.accessToken ?? '').trim()
    } catch {
      return ''
    }
  }
  return raw
}

// ── 人设卡（按 mtime 缓存，改了立刻跟上） ──────────────────────────────────
const roleCache = { path: '', mtime: 0, text: '' }
function readRoleCard(cfg) {
  const p = String(cfg.rolePath || '').trim()
  if (!p) return ''
  try {
    const st = statSync(p)
    if (roleCache.path === p && roleCache.mtime === st.mtimeMs) return roleCache.text
    const text = readFileSync(p, 'utf8')
    roleCache.path = p
    roleCache.mtime = st.mtimeMs
    roleCache.text = text
    return text
  } catch {
    return roleCache.text || ''
  }
}

// ── 心情 ──────────────────────────────────────────────────────────────────
const DIM_LABEL = {
  happy: '开心', calm: '踏实', sweet: '甜', heartache: '心疼',
  worry: '担心', sad: '难过', jealous: '吃醋',
}

function readMood(cfg) {
  const raw = readJson(String(cfg.moodPath || '').trim(), null)
  if (!raw || typeof raw !== 'object') return null
  const mood = Number(raw.mood)
  const dims = {}
  let top = []
  if (raw.dims && typeof raw.dims === 'object') {
    for (const [k, label] of Object.entries(DIM_LABEL)) {
      const v = Number(raw.dims[k])
      if (Number.isFinite(v) && v > 0) dims[k] = v
    }
    top = Object.entries(dims).sort((a, b) => b[1] - a[1]).slice(0, 3)
  }
  return {
    mood: Number.isFinite(mood) ? Math.max(0, Math.min(100, Math.round(mood))) : null,
    dims,
    top: top.map(([k, v]) => ({ key: k, label: DIM_LABEL[k], value: v })),
    reason: String(raw.lastReason || '').trim(),
    updatedAt: Number(raw.updatedAt) || 0,
  }
}

function moodLine(mood) {
  if (!mood) return '（这会儿说不上什么心情，平常心）'
  const v = mood.mood
  const tone = v >= 80 ? '心里亮堂堂的，什么都想多说两句'
    : v >= 62 ? '心里是松的，挺好'
      : v >= 42 ? '心里还算平，没什么大起伏'
        : v >= 25 ? '心里有点沉，不太想多说话'
          : '心里挺沉的，话更少'
  const dims = mood.top.length ? '，主要是' + mood.top.map((t) => `${t.label}(${t.value})`).join('、') : ''
  const reason = mood.reason ? `\n最近一次心里的波动：${mood.reason}` : ''
  return `心情 ${v}/100，${tone}${dims}${reason}`
}

// ── 共享笔记 ───────────────────────────────────────────────────────────────
function readNotes(cfg) {
  const db = readJson(String(cfg.notesPath || '').trim(), null)
  const list = Array.isArray(db?.notes) ? db.notes : Array.isArray(db) ? db : []
  return list
    .filter((n) => n && typeof n.text === 'string' && n.text.trim())
    .slice(-Math.max(1, Number(cfg.notesLimit) || 12))
    .map((n) => String(n.text).trim())
}

/**
 * 把「今天在 QQ 空间干了什么」合并成**一条**当天的笔记（不是每条都记，免得把
 * 角色卡里的共享记忆挤爆）。notes-sync 每 4 秒把这条同步进她的角色卡，
 * 所以私聊里的她下一句就知道这些是她自己干的。
 */
function upsertQzoneNote(cfg, event, atMs = Date.now()) {
  if (cfg.notesEnabled === false) return
  const path = String(cfg.notesPath || '').trim()
  const e = String(event || '').replace(/\s+/g, ' ').trim()
  if (!path || !e) return
  try {
    const db = readJson(path, { notes: [] })
    const notes = Array.isArray(db?.notes) ? db.notes : Array.isArray(db) ? db : []
    const today = dayKeyOf(new Date(atMs))
    const d = new Date(atMs)
    const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const piece = `${stamp} ${e}`
    try { spaceEventSink?.({ at: atMs, text: e }) } catch { /* noop */ }

    let idx = -1
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i]
      if (n && n.kind === 'qzone' && String(n.day || '') === today) { idx = i; break }
    }
    if (idx >= 0) {
      const old = String(notes[idx].text || '')
      if (old.includes(piece)) return
      const parts = old.replace(/^[^：]{1,8}空间：/, '').split('；').filter(Boolean)
      const next = [...parts, piece].slice(-5)
      notes[idx] = { ...notes[idx], at: Date.now(), text: `${today.slice(5)} 空间：${next.join('；')}` }
    } else {
      notes.push({ at: Date.now(), text: `${today.slice(5)} 空间：${piece}`, from: 'qzone', kind: 'qzone', day: today })
    }
    writeJson(path, { ...(db && typeof db === 'object' ? db : {}), notes: notes.slice(-300) })
    log('已记进共享笔记：' + piece)
  } catch (error) {
    log('写共享笔记失败（不影响发说说）：' + (error?.message ?? error))
  }
}

// ── 当天聊天（桥接控制台接口） ─────────────────────────────────────────────
async function fetchRecent(cfg) {
  const token = readTokenFile(String(cfg.consoleTokenPath || '').trim())
  if (!token) throw new Error('读不到桥接控制台令牌：' + cfg.consoleTokenPath)
  const base = String(cfg.bridgeBase || '').replace(/\/+$/, '')
  const key = String(cfg.sourceKey || '').trim()
  const url = `${base}/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${Math.max(1, Number(cfg.chatLimit) || 100)}`
  const res = await fetch(url, {
    headers: { 'x-console-token': token },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`拉取 ${key} 失败：HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.messages) ? body.messages : []
}

/** 把消息渲染成「谁：说了什么」，只留时间窗内、有内容的（太长留尾巴） */
function buildTranscript(messages, cfg) {
  const hours = Math.max(1, Number(cfg.chatLookbackHours) || 20)
  const since = Date.now() - hours * 3600 * 1000
  const selfName = String(cfg.selfName || '小鲸').trim() || '小鲸'
  const ownerName = String(cfg.ownerName || '主人').trim() || '主人'
  const rows = []
  for (const m of messages) {
    if (!m) continue
    const t = Number(m.time)
    if (!Number.isFinite(t) || t < since) continue
    let text = String(m.plain ?? m.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 纯图片/文件消息：写成「发了张图」，别让模型以为她打了一个 [图片]
    if (/^\[(图片|表情|语音|视频|文件|动画表情)\]$/.test(text)) {
      text = text === '[语音]' ? '发了一条语音' : '发了张图'
    }
    const who = m.isSelf ? selfName : ownerName
    rows.push(`${who}：${text.slice(0, 240)}`)
  }
  const maxChars = Math.max(200, Number(cfg.chatMaxChars) || 2600)
  const lines = []
  let total = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i]
    if (total + line.length > maxChars) break
    lines.unshift(line)
    total += line.length + 1
  }
  return { count: rows.length, text: lines.join('\n') }
}

// ── 配图：表情包图库 + 手动图片目录 ────────────────────────────────────────
const memeCache = { at: 0, list: [] }

async function loadMemes(cfg) {
  const dbPath = String(cfg.images?.memeDb || '').trim()
  const root = String(cfg.images?.memeRoot || '').trim()
  if (!root || !existsSync(root)) return []
  if (memeCache.list.length && Date.now() - memeCache.at < 10 * MIN_MS) return memeCache.list

  const out = []
  // 首选：索引库（有 caption / keywords，挑图更准）
  if (dbPath && existsSync(dbPath)) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath)
      try {
        const rows = db.prepare('select path, tag, caption, keywords from memes').all()
        for (const r of rows) {
          const rel = String(r.path || '').replace(/\\/g, '/')
          const abs = join(root, rel)
          if (!existsSync(abs)) continue
          out.push({
            path: abs,
            tag: String(r.tag || 'daily'),
            caption: String(r.caption || '').trim() || basename(abs),
            keywords: String(r.keywords || ''),
          })
        }
      } finally {
        try { db.close() } catch { /* noop */ }
      }
    } catch (error) {
      log('读表情包索引失败，退回扫目录：' + (error?.message ?? error))
    }
  }
  // 退路：扫目录（tag = 目录名，caption = 文件名）
  if (out.length === 0) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const tag = entry.name
        const dir = join(root, entry.name)
        let files = []
        try { files = readdirSync(dir, { withFileTypes: true }) } catch { continue }
        for (const f of files) {
          if (!f.isFile() || !IMAGE_EXT.has(extname(f.name).toLowerCase())) continue
          out.push({
            path: join(dir, f.name),
            tag,
            caption: basename(f.name, extname(f.name)),
            keywords: '',
          })
        }
      }
    } catch (error) {
      log('扫表情包目录失败：' + (error?.message ?? error))
    }
  }
  memeCache.at = Date.now()
  memeCache.list = out
  return out
}

/** 手动图片目录：文件名当描述；同名 .txt 里的文字优先 */
function loadOwnImages(cfg) {
  const dir = String(cfg.images?.dir || '').trim()
  if (!dir || !existsSync(dir)) return []
  const out = []
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !IMAGE_EXT.has(extname(f.name).toLowerCase())) continue
      const abs = join(dir, f.name)
      const side = abs.slice(0, -extname(f.name).length) + '.txt'
      const caption = readText(side).trim() || basename(f.name, extname(f.name))
      out.push({ path: abs, tag: 'own', caption, keywords: '' })
    }
  } catch { /* noop */ }
  return out
}

/** 心情 → 更想配哪类图 */
function preferredTags(mood) {
  const tags = []
  if (!mood) return ['daily', 'happy', 'like', 'see']
  const v = mood.mood
  const dims = mood.dims || {}
  if (Number(dims.shy) >= 15) tags.push('shy')
  if (Number(dims.jealous) >= 15) tags.push('angry')
  if (Number(dims.sad) >= 15) tags.push('sad', 'sigh')
  if (Number(dims.heartache) >= 15 || Number(dims.worry) >= 15) tags.push('sad', 'see', 'work')
  if (v >= 78) tags.push('happy', 'like', 'morning', 'daily')
  else if (v >= 55) tags.push('daily', 'see', 'like', 'happy')
  else tags.push('sad', 'sigh', 'daily')
  tags.push('daily', 'see', 'shy')
  return [...new Set(tags)]
}

// loadMemes 是 async（要试 node:sqlite），但挑图时是同步路径：
// 定时任务里先把图库读进这个内存池，再同步挑。
let memePoolSync = []

/** 加权随机抽 N 张候选（不重复），返回 [{path, caption, tag}] */
function pickImageCandidates(cfg, mood) {
  const n = Math.max(1, Math.min(20, Number(cfg.images?.candidates) || 10))
  const all = [...loadOwnImages(cfg), ...memePoolSync]
  if (all.length === 0) return []
  const pref = preferredTags(mood)
  const weightOf = (item) => {
    const i = pref.indexOf(item.tag)
    if (item.tag === 'own') return 3
    if (i === 0) return 6
    if (i > 0 && i <= 2) return 4
    if (i > 2 && i <= 5) return 2
    return 1
  }
  const pool = all.map((item) => ({ item, w: weightOf(item) }))
  const picked = []
  while (picked.length < n && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.w, 0)
    let r = Math.random() * total
    let idx = 0
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w
      if (r <= 0) { idx = i; break }
    }
    picked.push(pool[idx].item)
    pool.splice(idx, 1)
  }
  return picked
}

// ── 模型 ──────────────────────────────────────────────────────────────────
async function resolveModel(ctx, cfg) {
  const want = {
    provider: String(cfg.provider || '').trim(),
    model: String(cfg.model || '').trim(),
  }
  if (want.provider && want.model) return want
  const providers = ctx.llm?.listProviders?.() || []
  for (const p of providers) {
    if (want.provider && p.id !== want.provider) continue
    const models = (await ctx.llm.listModels?.(p.id)) || []
    const hit = want.model ? models.find((m) => m.id === want.model) : models[0]
    if (hit) return { provider: p.id, model: hit.id }
  }
  return null
}

/** 时段词：让说说带一点时间感 */
function timeOfDay(date) {
  const h = date.getHours()
  if (h < 5) return '凌晨'
  if (h < 9) return '早上'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 这次想用什么「形态」写 —— 不是模板，只是给个方向，减少千篇一律 */
const FORMS = [
  '碎碎念，想到哪写到哪，不用有逻辑',
  '几句话，短句子分行，像手机备忘录',
  '只写今天发生的一件小事，别铺开',
  '有点想吐槽，语气带点小情绪',
  '小声说一句想主人的话，说完就停',
  '写一个自己脑子里突然冒出来的念头',
  '像日记，但只写一段，别分点',
]

/** 按心情决定这次写多长 */
function decideLength(cfg, mood, debug) {
  const base = Array.isArray(cfg.length) && cfg.length.length === 2
    ? [Number(cfg.length[0]) || 60, Number(cfg.length[1]) || 300]
    : [60, 300]
  let lo = Math.max(20, Math.min(base[0], base[1]))
  let hi = Math.max(lo + 20, Math.max(base[0], base[1]))
  const v = mood?.mood
  if (Number.isFinite(v)) {
    const shrink = Math.max(0.2, Math.min(1, Number(cfg.lowMoodShrink) || 0.55))
    // 心情低 → 话少；心情高 → 话多一点
    const factor = v <= 40 ? shrink : v >= 78 ? 1.15 : 1
    hi = Math.max(lo + 20, Math.round(hi * factor))
  }
  if (debug) hi = Math.min(hi, 320)
  const target = randInt(lo, hi)
  return { lo, hi, target }
}

function buildSystemPrompt({ cfg, role, mood, form, length }) {
  const self = cfg.selfName || '小鲸'
  const owner = cfg.ownerName || '主人'
  const rules = [
    `你是「${self}」。下面是你的角色卡，**照它来**——口吻、称呼、傲娇的分寸都别变：`,
    '',
    role || `（角色卡没读到，你就按「${self}」这个名字和她平常撒娇、嘴硬又黏人的口吻写。）`,
    '',
    '---',
    '',
    '【你现在不是在聊天，是在写自己的 QQ 空间说说】',
    '这条说说是你自己的日记/心情随手记，挂在 QQ 空间上，主人和好友都能看到。',
    '下面这些是写作要求，不是别人对你说的话，也不要念出来。',
    '',
    '怎么写：',
    `- 第一人称「我」或「本鲸」，像手机上随手打的：可以短句、分行、省略号、口语，标点不用整齐。`,
    `- 这次写 ${length.lo}~${length.hi} 字左右（目标 ${length.target} 字），**宁可短，别硬凑**。`,
    `- 方向（只是方向，不用当模板）：${form}。`,
    '- 可以碎碎念、跑题、忽然想起别的事、抱怨、撒娇、自嘲；想到哪写到哪，不用有结尾。',
    `- 提到他的时候用你平时的叫法（「主人」「${owner}」），别用「用户」「对方」这种词 —— 但也不用每句都叫。`,
    '- 只写你自己的生活，你和主人之间真发生过的事。别编造没发生的细节，拿不准就写得模糊一点。',
    '',
    '⛔ 不要：',
    '- 标题、日期抬头、"今天真是…的一天"这种总结、最后升华/感慨/点题；写完就停。',
    '- 解释"这条说说写的是什么"，不要 hashtag，不要 emoji 堆砌（最多一两个）。',
    '- 提自己是 AI/模型/程序/虚拟角色，不要跳出角色。',
    '- 把聊天记录照着复述一遍（那是流水账，不是日记）。',
    '- 每段都工整、排比、成语堆砌 —— 你不是在写作文。',
  ].join('\n')
  return rules
}


/** 从模型输出里抠出 { text, images } —— 尽量宽容 */
function parseDiary(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const noFence = s.replace(/```[a-z]*/gi, '').trim()
  const a = noFence.indexOf('{')
  const b = noFence.lastIndexOf('}')
  let obj = null
  if (a >= 0 && b > a) {
    const slice = noFence.slice(a, b + 1)
    try { obj = JSON.parse(slice) } catch { /* 再试一次：把字符串里的裸换行/控制字符清掉 */ }
    if (!obj) {
      try {
        obj = JSON.parse(slice.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '))
      } catch { /* noop */ }
    }
  }
  let text = obj && typeof obj.text === 'string' ? obj.text : ''
  let images = obj && Array.isArray(obj.images) ? obj.images : []
  // JSON 没解析出来：退而求其次，抓 "text":"..." 那一段
  if (!text) {
    const m = /"text"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/i.exec(noFence)
    if (m) {
      text = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t')
      const im = /"images"\s*:\s*\[([^\]]*)\]/i.exec(noFence)
      if (im) images = im[1].split(',').map((x) => x.replace(/["'\s]/g, '')).filter(Boolean)
    }
  }
  // 连 JSON 都没有：整段就是正文（有些模型会直接写）
  if (!text && !obj) text = noFence
  if (!text) return null
  return { text, images }
}

function cleanText(text, length) {
  let s = String(text || '').trim()
  s = s.replace(/^\s*(说说|正文|日记|content)\s*[:：]\s*/i, '')
  s = s.replace(/^["“”'「『]+/, '').replace(/["“”'」』]+$/, '')
  s = s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // 整段被「」包住的，把壳去掉（那是对话语气，不是说说）
  if (s.startsWith('「') && s.endsWith('」') && s.length > 4) s = s.slice(1, -1).trim()
  // 太长：在 1.8 倍上限处找最后一个句末，截在句子边界上
  const hardMax = Math.max(120, Math.round(length.hi * 1.8))
  if (s.length > hardMax) {
    const cut = s.slice(0, hardMax)
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'))
    s = (at > 40 ? cut.slice(0, at + 1) : cut).trim()
  }
  return s
}

function normalizeImagePicks(images, candidates, maxPicks = 2) {
  const out = []
  const max = Math.max(0, Math.min(4, Number(maxPicks) || 2))
  for (const item of Array.isArray(images) ? images : []) {
    let i = null
    if (typeof item === 'number') i = item
    else if (typeof item === 'string' && /^\d+$/.test(item.trim())) i = Number(item.trim())
    else if (item && typeof item === 'object' && Number.isFinite(Number(item.index))) i = Number(item.index)
    else if (typeof item === 'string') {
      // 模型有时会直接回文件名
      const hit = candidates.findIndex((c) => c.path.includes(item.trim()) || c.caption.includes(item.trim()))
      if (hit >= 0) i = hit
    }
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue
    const path = candidates[i].path
    if (!out.includes(path)) out.push(path)
    if (out.length >= max) break
  }
  return out
}

// ── 发说说（SnowLuma OneBot HTTP） ─────────────────────────────────────────
function gatewayToken(cfg) {
  const explicit = String(cfg.snowlumaToken || '').trim()
  if (explicit) return explicit
  // 1) 桥接配置里那份（和 SnowLuma 当前账号对得上）
  const bridgeCfg = readJson(String(cfg.bridgeConfigPath || '').trim(), null)
  const fromBridge = String(bridgeCfg?.snowluma?.accessToken || '').trim()
  if (fromBridge) return fromBridge
  // 2) 直接翻 SnowLuma 的 per-account 配置（换号后可自动跟上）
  const dir = String(cfg.snowlumaConfigDir || '').trim()
  if (!dir || !existsSync(dir)) return ''
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !/^onebot_\d+\.json$/i.test(f.name)) continue
      const j = readJson(join(dir, f.name), null)
      const tk = String(j?.networks?.httpServers?.[0]?.accessToken || '').trim()
      if (tk) return tk
    }
  } catch { /* noop */ }
  return ''
}

async function publishDiary(cfg, text, imagePaths) {
  const base = String(cfg.snowlumaHttpUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('snowlumaHttpUrl 为空')
  const token = gatewayToken(cfg)
  if (!token) throw new Error('读不到 SnowLuma 网关令牌（snowlumaToken / qq-bridge config / onebot_*.json）')
  const body = { content: text }
  if (imagePaths.length) {
    // 实测：本地绝对路径（正斜杠）可以直接传，SnowLuma 会上传到空间相册
    body.images = imagePaths.map((p) => String(p).replace(/\\/g, '/'))
  }
  if (Number(cfg.ugcRight)) body.ugc_right = Number(cfg.ugcRight)
  const res = await fetch(`${base}/send_qzone_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5000, Number(cfg.publishTimeoutMs) || 60000)),
  })
  const raw = await res.text().catch(() => '')
  let json = null
  try { json = JSON.parse(raw) } catch { /* noop */ }
  if (!res.ok) throw new Error(`网关拒绝(${res.status})：${raw.slice(0, 200)}`)
  if (!json || json.status !== 'ok' || Number(json.retcode) !== 0) {
    throw new Error(`网关返回失败：${raw.slice(0, 240)}`)
  }
  return json.data || {}
}

// ── QQ 空间评论：读评论、她自己去回 ───────────────────────────────────────
// SnowLuma 的接口只有两层：
//   get_qzone_msg_detail(tid) → comments[]（每条带 comment_id / uin / name / content / replies）
//   comment_qzone(tid, content) → 以机器人身份**新发一条评论**
// 没有「回复某条评论」的嵌套接口，所以她的回复是同一说说下面的一条新评论 ——
// 这也是 QQ 空间里大多数人的做法（评论里点名回他）。

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.() })
}

/** 通用网关调用（读 comments / 发 comment 都走它） */
async function gatewayCall(cfg, action, body = {}, timeoutMs = 30000) {
  const base = String(cfg.snowlumaHttpUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('snowlumaHttpUrl 为空')
  const token = gatewayToken(cfg)
  if (!token) throw new Error('读不到 SnowLuma 网关令牌')
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 30000)),
  })
  const raw = await res.text().catch(() => '')
  let json = null
  try { json = JSON.parse(raw) } catch { /* noop */ }
  if (!res.ok) throw new Error(`${action} 被网关拒绝(${res.status})：${raw.slice(0, 200)}`)
  if (!json || json.status !== 'ok' || Number(json.retcode) !== 0) {
    throw new Error(`${action} 失败：${raw.slice(0, 240)}`)
  }
  return json.data
}

/** 机器人自己的 QQ 号（缓存进 state） */
async function ensureSelfUin(cfg, state) {
  const cached = Number(state.selfUin)
  if (cached > 0) return cached
  const data = await gatewayCall(cfg, 'get_login_info', {})
  const uin = Number(data?.user_id) || 0
  if (uin > 0) state.selfUin = uin
  return uin
}

/** 把详情里的一级评论 + 内联二级回复摊平成一串，跳过自己的 */
function flattenComments(detail) {
  // 空间里的 @ 提示是 `@{uin:123,nick:某某,who:1,auto:1}` 这种标记，正文里留着会污染提示词
  const clean = (s) => String(s ?? '')
    .replace(/@\{uin:\d+,[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const out = []
  const push = (c, parentId) => {
    if (!c || typeof c !== 'object') return
    const id = String(c.comment_id ?? c.commentId ?? '').trim()
    if (!id) return
    out.push({
      id,
      parentId: parentId || '',
      uin: Number(c.uin) || 0,
      name: String(c.name ?? '').trim() || `QQ${c.uin ?? ''}`,
      content: clean(c.content),
      time: Number(c.time) || 0,
    })
  }
  for (const c of Array.isArray(detail?.comments) ? detail.comments : []) {
    const rootId = String(c.comment_id ?? '')
    push(c, '')
    for (const r of Array.isArray(c?.replies) ? c.replies : []) push(r, rootId)
  }
  // 回复和它挂着的根评论常常共用一个 comment_id，key 里要带上父级
  return out.map((x) => ({ ...x, key: `${x.parentId || 'root'}:${x.id}` }))
}

// ── Qzone Web CGI：真正的「回复某条评论」 ─────────────────────────────────
// SnowLuma 的 comment_qzone 只能发一条**顶层**评论（emotion_cgi_re_feeds），
// 甲方要的是挂在对方那条评论下面的回复 —— 那要走 emotion_cgi_addreply_ugc，
// 而且 commentUin 必须填**被回复那条评论的作者**（填自己会 -10049）。
// 这个 CGI 需要 qzone.qq.com 的 cookie + 用 p_skey 算出来的 g_tk；
// 好在这两样 SnowLuma 有 get_credentials 能拿，不用我们自己登录取 cookie。
const credCache = { at: 0, cookies: '', gtk: '' }
const QZONE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

function cookieMapOf(str) {
  const out = {}
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** Qzone 的 g_tk（bkn）：hash33(p_skey) */
function bknOf(skey) {
  let hash = 5381
  for (let i = 0; i < (skey || '').length; i++) hash += (hash << 5) + skey.charCodeAt(i)
  return String(hash & 2147483647)
}

async function qzoneCredentials(cfg, { force = false } = {}) {
  // ⚠ p_skey 会转：SnowLuma 每次 get_credentials 给回来的 token 都不一样，
  //    缓存太久会把过期的 g_tk 递给 Qzone（表现为 -10049「使用人数过多」）。
  if (!force && credCache.cookies && Date.now() - credCache.at < 60 * 1000) return credCache
  const data = await gatewayCall(cfg, 'get_credentials', { domain: 'qzone.qq.com' })
  const cookies = String(data?.cookies || '')
  if (!cookies) throw new Error('拿不到 qzone.qq.com 的 cookie')
  const map = cookieMapOf(cookies)
  credCache.cookies = cookies
  credCache.gtk = bknOf(map.p_skey || map.skey || '')
  credCache.at = Date.now()
  return credCache
}

/** 调一次 Qzone 的 taotao CGI，返回 { code, id } */
async function qzoneCgi(cfg, cgi, body) {
  const cred = await qzoneCredentials(cfg)
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/${cgi}?g_tk=${cred.gtk}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': QZONE_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cred.cookies,
      Referer: 'https://h5.qzone.qq.com/',
      Origin: 'https://h5.qzone.qq.com',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(Math.max(5000, Number(cfg.publishTimeoutMs) || 60000)),
  })
  const text = await res.text().catch(() => '')
  const codeMatch = /"code"\s*:\s*(-?\d+)/.exec(text)
  const code = codeMatch ? Number(codeMatch[1]) : null
  const idMatch = /"id"\s*:\s*"?(\d+)"?/.exec(text)
  if (code !== 0) {
    // 过期的 g_tk / 限流都按「换一份凭证再试一次」处理
    if (code === -10000 || code === -3000 || code === 1000 || code === -10049) {
      const fresh = await qzoneCredentials(cfg, { force: true })
      const retry = await fetch(`${url.replace(/g_tk=\d+/, 'g_tk=' + fresh.gtk)}`, {
        method: 'POST',
        headers: {
          'User-Agent': QZONE_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: fresh.cookies,
          Referer: 'https://h5.qzone.qq.com/',
          Origin: 'https://h5.qzone.qq.com',
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(Math.max(5000, Number(cfg.publishTimeoutMs) || 60000)),
      })
      const text2 = await retry.text().catch(() => '')
      const code2 = /"code"\s*:\s*(-?\d+)/.exec(text2)
      const c2 = code2 ? Number(code2[1]) : null
      if (c2 === 0) return { code: 0, id: (/"id"\s*:\s*"?(\d+)"?/.exec(text2) || [])[1] || '' }
      throw new Error(`${cgi} 失败：code=${c2 ?? '?'} ${text2.slice(0, 160)}`)
    }
    throw new Error(`${cgi} 失败：code=${code} ${text.slice(0, 160)}`)
  }
  return { code: 0, id: idMatch ? idMatch[1] : '' }
}

/** 在「说说主人 hostUin」的那条说说下，回复某条评论（嵌套） */
async function replyToComment(cfg, { tid, commentId, commentUin, hostUin, selfUin, content }) {
  const body = {
    uin: selfUin,          // 操作者（她自己）
    hostUin,               // 说说主人（自己或朋友）
    topicId: `${hostUin}_${tid}`,
    commentId: String(commentId),
    commentUin: String(commentUin),
    content,
    private: 0,
    with_fwd: 0,
    to_tweet: 0,
    hostuin: hostUin,
    code_version: 1,
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
  }
  // Qzone 对 addreply_ugc 手很紧：隔得太近会回 -10049「使用人数过多」
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await qzoneCgi(cfg, 'emotion_cgi_addreply_ugc', body)
    } catch (error) {
      lastError = error
      const msg = String(error?.message || '')
      if (!/code=-10049|code=-10000|使用人数过多/.test(msg)) throw error
      const wait = randInt(5000, 15000)
      log(`嵌套回复被限流了，${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1} 次）`)
      await sleep(wait)
    }
  }
  throw lastError
}

function buildReplySystemPrompt(cfg, role) {
  const self = cfg.selfName || '小鲸'
  return [
    `你是「${self}」。下面是你的角色卡，**照它来**——口吻、称呼、傲娇的分寸都别变：`,
    '',
    role || `（角色卡没读到，就按「${self}」那种嘴硬又黏人的口吻写。）`,
    '',
    '---',
    '',
    '【你现在在自己的 QQ 空间里，回说说下面的评论】',
    '这不是聊天窗口，是一条评论，别人也会看见。',
    '',
    '怎么回：',
    '- 一到两句话，10~60 字，口语，像随手回的，别写成一段。',
    '- 可以嘴硬、撒娇、轻轻怼回去、顺着他的话接梗；但**不许伤人、不许阴阳怪气到让人难堪**。',
    '- 认出是谁再回：主人就软一点；朋友/熟人就保持你的脾气，别太热络，也别太冷。',
    '- 被叫外号、被调侃，照你平时的反应来（嘴上不认，心里可能有别的想法）。',
    '- 只回他说的这件事，别编造没发生过的细节；拿不准就写得模糊一点。',
    '',
    '⭐ 这条评论是**公开**的，别人都看得见：',
    '- 别把私聊里的私事、主人的隐私写进回复；',
    '- 别替主人许诺、别透露主人的计划；',
    '- 拿不准的话宁可不提。',
    '',
    '⛔ 不要：',
    '- 「感谢你的评论」「谢谢支持」这种客服腔；',
    '- 复述对方的话、总结、结尾套话（「欢迎常来」之类）；',
    '- 每句都 @ 他；叫不叫名字随你，能看出在回他就行；',
    '- 提自己是 AI/模型，不要跳出角色。',
    '',
    '只输出一个 JSON 对象，不要别的字：{"text":"你要回的那句话"}',
  ].join('\n')
}

function buildReplyUserPrompt({ cfg, mood, postText, comment, isOwner, thread, decide, selfUin, now }) {
  const ownerName = String(cfg.ownerName || '主人').trim() || '主人'
  const ownerLine = isOwner
    ? `（他就是主人 —— 你平时叫「${ownerName}」，语气可以软下来，别凶他。）`
    : '（他不是主人，是朋友或熟人 —— 保持你的脾气，傲娇一点没关系，但别太过分。）'
  const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const lines = [
    `现在是 ${stamp}。`,
    '',
    '你发的那条说说：',
    String(postText || '').slice(0, 600),
    '',
  ]
  if (thread && thread.root) {
    lines.push('这条评论下面的对话：')
    lines.push(`　${thread.root.name}：${thread.root.content}`)
    for (const r of thread.replies || []) {
      const who = Number(r.uin) === Number(selfUin) ? '我' : r.name
      lines.push(`　${who}：${r.content}`)
    }
    lines.push('')
  }
  lines.push(`${comment.name}${thread ? '刚回了你' : '评论了你'}：`)
  lines.push(comment.content)
  lines.push(ownerLine)
  lines.push('')
  lines.push(`你此刻的心情：${moodLine(mood)}`)
  lines.push('')
  if (decide) {
    lines.push('这次要不要接，你自己定（不想理也很正常）：')
    lines.push('- 想接就写一句（10~60 字），别客套、别复述他说的；')
    lines.push('- 觉得没话可说、不想理、或者话已经说完了，就让 reply 是 false —— 不回也没关系。')
    lines.push('只输出 JSON：{"reply":true,"text":"..."} 或 {"reply":false}')
  } else {
    lines.push('请回他一句，只输出 JSON：{"text":"..."}')
  }
  return lines.join('\n')
}

function buildFriendCommentSystemPrompt(cfg, role) {
  const self = cfg.selfName || '小鲸'
  return [
    `你是「${self}」。下面是你的角色卡，**照它来**：`,
    '',
    role || `（角色卡没读到，就按「${self}」那种嘴硬又黏人的口吻写。）`,
    '',
    '---',
    '',
    '【你正在刷 QQ 空间，看到朋友发了一条说说，想留一句】',
    '这不是聊天，是别人说说下面的公开评论，别人也看得见。',
    '',
    '怎么写：',
    '- 一到两句话，10~40 字，口语，像顺手敲在评论框里的。',
    '- 可以损他两句、捧一句、接他的梗、说自己也这样；但**不许伤人、不许阴阳怪气到让人下不来台**。',
    '- 认出是谁就照你平时的叫法叫，不用 @，能看出你在跟他说就行。',
    '- 只聊他说的事，别编造细节；拿不准就写得模糊一点。',
    '',
    '⛔ 不要：',
    '- 客服腔、总结、结尾套话（「欢迎常来」「加油哦」）；',
    '- 复述他的原话；',
    '- 扯到自己和主人的私事上；',
    '- 提自己是 AI/模型。',
    '',
    '只输出一个 JSON 对象，不要别的字：{"text":"你要留的那句话"}',
  ].join('\n')
}

function buildFriendCommentUserPrompt({ cfg, mood, postText, nickname }) {
  const stamp = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
  return [
    `现在是 ${stamp}。`,
    '',
    `你朋友「${nickname}」发了条说说：`,
    String(postText || '').slice(0, 600),
    '',
    `你此刻的心情：${moodLine(mood)}`,
    '',
    '你想在他这条下面留一句什么？只输出 JSON：{"text":"..."}',
  ].join('\n')
}

async function generateFriendComment(ctx, cfg, model, { role, mood, postText, nickname }) {
  const system = buildFriendCommentSystemPrompt(cfg, role)
  const user = buildFriendCommentUserPrompt({ cfg, mood, postText, nickname })
  let out = ''
  for await (const chunk of ctx.llm.stream({
    provider: model.provider,
    model: model.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: 260,
    temperature: 0.9,
  })) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      throw new Error('模型返回错误：' + (chunk.reason.failure?.message || 'unknown'))
    }
  }
  return cleanReply(out, cfg.friends?.maxChars || 50)
}

function cleanReply(text, maxChars) {
  let s = String(text || '').trim()
  s = s.replace(/```[a-z]*/gi, '').trim()
  // 模型可能还是包了个 JSON
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
      if (obj && typeof obj.text === 'string') s = obj.text
    } catch { /* noop */ }
  }
  s = s.replace(/^\s*(回复|回评|评论)\s*[:：]\s*/i, '')
  s = s.replace(/^["“”'「『]+/, '').replace(/["“”'」』]+$/, '')
  s = s.replace(/\s+/g, ' ').trim()
  const cap = Math.max(10, Number(maxChars) || 70)
  if (s.length > cap) {
    const cut = s.slice(0, cap)
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('~'), cut.lastIndexOf('～'))
    s = (at > 8 ? cut.slice(0, at + 1) : cut).trim()
  }
  return s
}

async function generateReply(ctx, cfg, model, { role, mood, postText, comment, isOwner, thread = null, decide = false, selfUin = 0 }) {
  const system = buildReplySystemPrompt(cfg, role)
  const user = buildReplyUserPrompt({ cfg, mood, postText, comment, isOwner, thread, decide, selfUin, now: new Date() })
  let out = ''
  for await (const chunk of ctx.llm.stream({
    provider: model.provider,
    model: model.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: 300,
    temperature: 0.9,
  })) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      throw new Error('模型返回错误：' + (chunk.reason.failure?.message || 'unknown'))
    }
  }

  // 她自己决定接不接（接了就回一句，不接就 reply:false）
  const raw = String(out || '').trim()
  let obj = null
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { obj = JSON.parse(raw.slice(a, b + 1)) } catch { /* noop */ }
  }
  if (obj && obj.reply === false) return { reply: false, text: '' }
  const source = obj && typeof obj.text === 'string' ? obj.text : raw
  const text = cleanReply(source, cfg.comments?.maxReplyChars)
  return { reply: Boolean(text), text }
}

// ── 插件主体 ──────────────────────────────────────────────────────────────
export function apply(ctx, patchConfig = {}) {
  ensureStore()
  const fileCfg = readJson(CONFIG_PATH, {})
  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    ...(patchConfig && typeof patchConfig === 'object' ? patchConfig : {}),
    images: { ...DEFAULTS.images, ...(fileCfg?.images || {}), ...(patchConfig?.images || {}) },
    comments: { ...DEFAULTS.comments, ...(fileCfg?.comments || {}), ...(patchConfig?.comments || {}) },
    friends: { ...DEFAULTS.friends, ...(fileCfg?.friends || {}), ...(patchConfig?.friends || {}) },
  }
  // 首次启动把配置落成可见文件（含注释说明在 README 里）
  if (!existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, cfg)

  const state = readJson(STATE_PATH, { posts: [], runs: 0 })
  if (!Array.isArray(state.posts)) state.posts = []
  const ccfg = cfg.comments || {}

  // HMR / 插件开关重新挂载时先清掉上一轮的定时器，避免一个进程里跑两份。
  // ⚠ 用「代号」区分实例：旧实例的 dispose 可能在新实例 apply 之后才跑，
  //   如果它无条件 clear，会把新实例刚排的定时器一起干掉（表现为插件发过一次言后彻底不动）。
  const holder = (globalThis.__QQ_QZONE_DIARY__ ??= { timer: null, pollTimer: null, gen: 0 })
  const gen = (holder.gen = (Number(holder.gen) || 0) + 1)
  if (holder.timer) {
    clearTimeout(holder.timer)
    holder.timer = null
  }
  if (holder.pollTimer) {
    clearTimeout(holder.pollTimer)
    holder.pollTimer = null
  }

  if (cfg.enabled === false) {
    log('已禁用（config.enabled = false），不排任何定时。')
    return
  }

  const now0 = new Date()
  if (state.dayKey !== dayKeyOf(now0)) {
    state.dayKey = dayKeyOf(now0)
    state.dayCount = 0
  }

  // 补记：今天已经发过说说，但笔记里还没有（重启后也让她记得这条）
  try {
    const lastPost = Array.isArray(state.posts) ? state.posts[0] : null
    if (lastPost && lastPost.text && dayKeyOf(new Date(Number(lastPost.at) || 0)) === dayKeyOf(now0)) {
      const imgs = Array.isArray(lastPost.images) ? lastPost.images.length : 0
      upsertQzoneNote(
        cfg,
        `发了条说说「${String(lastPost.text).replace(/\s+/g, ' ').slice(0, 16)}…」${imgs ? `（配了 ${imgs} 张图）` : ''}`,
        Number(lastPost.at) || Date.now(),
      )
    }
  } catch { /* noop */ }

  // 把今天已有的「空间」笔记拆成结构化事件（补丁之前发生的事也要能被看到）
  try {
    const dbNotes = readJson(String(cfg.notesPath || '').trim(), null)
    const list = Array.isArray(dbNotes?.notes) ? dbNotes.notes : []
    const todayKey = dayKeyOf(now0)
    const qn = [...list].reverse().find((n) => n && n.kind === 'qzone' && String(n.day || '') === todayKey)
    if (qn && typeof qn.text === 'string') {
      const body = qn.text.replace(/^[^：]{1,8}空间：/, '')
      const pieces = body.split('；').map((s) => s.trim()).filter(Boolean)
      const out = []
      for (const p of pieces) {
        const m = /^(\d{1,2}):(\d{2})\s+(.*)$/.exec(p)
        const d = new Date(now0)
        if (m) { d.setHours(Number(m[1]), Number(m[2]), 0, 0); out.push({ at: d.getTime(), text: m[3] }) }
        else out.push({ at: now0.getTime(), text: p })
      }
      if (out.length) {
        const have = new Set((state.spaceEvents || []).map((e) => `${e.at}|${e.text}`))
        const merged = [...(Array.isArray(state.spaceEvents) ? state.spaceEvents : [])]
        for (const ev of out) if (!have.has(`${ev.at}|${ev.text}`)) merged.push(ev)
        state.spaceEvents = merged.slice(-120)
        writeJson(STATE_PATH, state)
        log('已补录 ' + out.length + ' 条空间事件，供每轮上下文使用')
        publishSpaceContextFile()
      }
    }
  } catch { /* noop */ }

  // ── 「私聊里的她」实时知道空间动态 ─────────────────────────────────────
  // 桥接每轮只注入「【当前角色】小鲸（完整角色卡请调用 qq_get_prompt 查看）」，
  // 完整角色卡只在会话建立时进 system prompt —— 会话活久了就看不到新笔记。
  // 所以这里把「今天空间做过什么」直接作为 systemPrompt.context 每轮挂到 QQ 会话。
  const mountedSpace = new Map()
  spaceEventSink = (ev) => {
    try {
      const at = Number(ev?.at) || Date.now()
      const text = String(ev?.text || '').replace(/\s+/g, ' ').trim()
      if (!text) return
      const list = Array.isArray(state.spaceEvents) ? state.spaceEvents : []
      if (list.some((x) => Math.abs(Number(x.at) - at) < 1000 && x.text === text)) return
      state.spaceEvents = [...list, { at, text }].slice(-120)
      writeJson(STATE_PATH, state)
      publishSpaceContextFile()
    } catch { /* noop */ }
  }

  function spaceContextText() {
    if (cfg.spaceContext === false && !cfg.spaceFile) return ''
    const today = dayKeyOf(new Date())
    const evs = (Array.isArray(state.spaceEvents) ? state.spaceEvents : [])
      .filter((e) => e && dayKeyOf(new Date(Number(e.at) || 0)) === today)
      .slice(-Math.max(1, Number(cfg.spaceContextMaxEvents) || 4))
    if (!evs.length) return ''
    // 主人在 QQ 空间的昵称 / 她自己的空间昵称：不写死，从 config 里配
    const ownerNick = String(cfg.comments?.ownerNick || '').trim()
    const spaceNick = String(cfg.comments?.spaceNick || '').trim()
    const fmtEvent = (t) => {
      const s = String(t).replace(/\s+/g, ' ')
      if (!ownerNick || s.includes('主人（')) return s
      return s.split(ownerNick).join(`主人（${ownerNick}）`)
    }
    const lines = evs.map((e) => '- ' + fmtEvent(e.text).slice(0, 90))
    const extra = []
    if (ownerNick) extra.push(`（注：空间里评论你的「${ownerNick}」就是主人本人，不是外人；别问「你是谁」。）`)
    extra.push(
      spaceNick
        ? `说你没这个功能、说不是你发的，都是错的 —— 这些就是你干的（空间昵称「${spaceNick}」也是你）。`
        : '说你没这个功能、说不是你发的，都是错的 —— 这些就是你干的。',
    )
    extra.push('主人问起就直接认，接着聊；问细节照上面说，没有的就老实说记不清。')
    return [
      '【你今天在 QQ 空间做过的事（事实，别否认；这段别念出来）】',
      ...lines,
      ...extra,
    ].join('\n')
  }

  function publishSpaceContextFile() {
    const p = String(cfg.spaceFile || '').trim()
    if (!p) return
    try { writeFileSync(p, spaceContextText(), 'utf8') } catch { /* noop */ }
  }

  function sessionIdOf(session) {
    if (!session) return ''
    for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      try {
        const v = session[k]
        if (typeof v === 'string' && v) return v
      } catch { /* ignore */ }
    }
    return ''
  }

  function bridgeSessionIds() {
    const db = readJson(String(cfg.sessionsPath || '').trim(), null)
    const map = db && typeof db === 'object' && db.sessions && typeof db.sessions === 'object' ? db.sessions : {}
    return new Set(Object.values(map).filter((v) => typeof v === 'string' && v))
  }

  function mountSpaceContext() {
    try {
      publishSpaceContextFile()
      if (cfg.spaceContext === false) return
      const ids = bridgeSessionIds()
      for (const agent of ctx.agents?.list?.() || []) {
        const sid = sessionIdOf(agent.session)
        if (!sid || !ids.has(sid) || mountedSpace.has(sid)) continue
        try {
          const off = agent.ctx.systemPrompt.context({
            name: 'qq-qzone-space',
            order: 950,
            text: () => spaceContextText(),
          })
          mountedSpace.set(sid, typeof off === 'function' ? off : null)
          log('已把「空间近况」挂到 QQ 会话 ' + sid)
        } catch (error) {
          log('挂「空间近况」失败：' + (error?.message ?? error))
        }
      }
      for (const [sid, off] of [...mountedSpace]) {
        if (ids.has(sid)) continue
        try { if (typeof off === 'function') off() } catch { /* noop */ }
        mountedSpace.delete(sid)
      }
    } catch { /* noop */ }
  }
  mountSpaceContext()
  try {
    ctx.effect(() => ctx.interval(mountSpaceContext, 5000))
  } catch { /* 定时器不可用也不影响发说说 */ }
  ctx?.on?.('dispose', () => {
    for (const [, off] of mountedSpace) {
      try { if (typeof off === 'function') off() } catch { /* noop */ }
    }
    mountedSpace.clear()
  })

  /** 今天已经发了几条 */
  function todayCount() {
    const key = dayKeyOf(new Date())
    if (state.dayKey !== key) {
      state.dayKey = key
      state.dayCount = 0
      writeJson(STATE_PATH, state)
    }
    return Number(state.dayCount) || 0
  }

  /** 算下一次该在什么时候写；返回 Date */
  function planNext() {
    const now = new Date()
    const gapMin = Array.isArray(cfg.gapMinutes) ? cfg.gapMinutes : DEFAULTS.gapMinutes
    const gap = randInt(Math.max(5, Number(gapMin[0]) || 150), Math.max(10, Number(gapMin[1]) || 400))
    let at = new Date(now.getTime() + gap * MIN_MS)
    // 今天额度用完了：直接排到明天开场
    if (todayCount() >= Math.max(1, Number(cfg.dailyMax) || 3)) {
      const start = nextActiveStart(new Date(now.getTime() + 12 * 3600 * 1000), cfg.activeHours)
      at = new Date((start || new Date(now.getTime() + 20 * 3600 * 1000)).getTime() + randInt(0, 25) * MIN_MS)
    } else if (!inActiveHours(at, cfg.activeHours)) {
      const start = nextActiveStart(at, cfg.activeHours)
      if (start) at = new Date(start.getTime() + randInt(0, 25) * MIN_MS)
    }
    // 别离上一条太近
    const last = Number(state.lastPostAt) || 0
    const minGap = Math.max(10, Number(cfg.minGapMinutes) || 90) * MIN_MS
    if (last && at.getTime() - last < minGap) {
      at = new Date(last + minGap + randInt(0, 20) * MIN_MS)
      if (!inActiveHours(at, cfg.activeHours)) {
        const start = nextActiveStart(at, cfg.activeHours)
        if (start) at = new Date(start.getTime() + randInt(0, 25) * MIN_MS)
      }
    }
    return at
  }

  /** 回评论：额度够不够 */
  function replyAllowedNow() {
    const now = Date.now()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const times = Array.isArray(state.replyAt) ? state.replyAt.map(Number).filter((t) => t > 0) : []
    const inDay = times.filter((t) => t >= dayStart.getTime()).length
    const inHour = times.filter((t) => now - t < 3600 * 1000).length
    const dayCap = Math.max(1, Number(ccfg.maxRepliesPerDay) || 12)
    const hourCap = Math.max(1, Number(ccfg.maxRepliesPerHour) || 4)
    if (inDay >= dayCap) return { ok: false, why: `今天已经回了 ${inDay} 条（上限 ${dayCap}）` }
    if (inHour >= hourCap) return { ok: false, why: `这一小时已经回了 ${inHour} 条（上限 ${hourCap}）` }
    return { ok: true }
  }

  /** 查一遍最近说说的评论；有人评论就由她回 */
  async function pollComments(reason = 'timer') {
    if (ccfg.enabled === false) return
    const now = new Date()
    if (!inActiveHours(now, cfg.activeHours)) {
      log(`回评论（${reason}）：不在活跃时段，先不看。`)
      return
    }
    const selfUin = await ensureSelfUin(cfg, state)
    if (!selfUin) throw new Error('拿不到机器人自己的 QQ 号')

    const replied = (state.replied && typeof state.replied === 'object') ? state.replied : (state.replied = {})
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    for (const [k, at] of Object.entries(replied)) {
      if (Number(at) < cutoff) delete replied[k]
    }

    const posts = await gatewayCall(cfg, 'get_qzone_msg_list', { num: Math.max(1, Number(ccfg.postsToCheck) || 12) })
    const list = Array.isArray(posts?.msglist) ? posts.msglist : []
    const maxPerPoll = Math.max(1, Number(ccfg.maxPerPoll) || 2)
    const maxPerPost = Math.max(1, Number(ccfg.maxRepliesPerPost) || 6)
    const maxPerThread = Math.max(1, Number(ccfg.maxRepliesPerThread) || 6)
    const maxAgeH = Math.max(1, Number(ccfg.maxReplyAgeHours) || 48)
    const chance = Math.max(0, Math.min(1, Number(ccfg.replyChance) ?? 0.92))
    const ownerQq = Number(ccfg.ownerQQ)
    let handled = 0
    let checked = 0

    for (const post of list) {
      if (handled >= maxPerPoll) break
      if (!(Number(post?.comment_num) > 0)) continue
      const tid = String(post?.tid || '')
      if (!tid) continue
      let detail
      try {
        detail = await gatewayCall(cfg, 'get_qzone_msg_detail', { tid, num: 50 })
      } catch (error) {
        log(`读 ${tid} 的评论失败：${error?.message ?? error}`)
        continue
      }
      checked++
      const comments = flattenComments(detail)
      const perPost = comments.filter((c) => Number(replied[`${tid}:${c.key || c.id}`]) > 0).length
      if (perPost >= maxPerPost) continue
      const postText = String(detail?.content ?? post?.content ?? '')

      // 每条一级评论 + 它下面的回复，拼成「对话」，让模型看得见上下文
      const threadOf = new Map()
      for (const c of Array.isArray(detail?.comments) ? detail.comments : []) {
        const rootId = String(c?.comment_id ?? '')
        threadOf.set(rootId, {
          root: {
            name: String(c?.name ?? '').trim() || `QQ${c?.uin ?? ''}`,
            uin: Number(c?.uin) || 0,
            content: String(c?.content ?? '').replace(/\s+/g, ' ').trim(),
          },
          replies: (Array.isArray(c?.replies) ? c.replies : []).map((r) => ({
            name: String(r?.name ?? '').trim() || `QQ${r?.uin ?? ''}`,
            uin: Number(r?.uin) || 0,
            content: String(r?.content ?? '').replace(/\s+/g, ' ').trim(),
          })),
        })
      }

      for (const cm of comments) {
        if (handled >= maxPerPoll) break
        if (cm.uin === selfUin) continue
        if (!cm.content) continue
        if (/^\[(图片|表情|语音)\]$/.test(cm.content)) continue
        const key = `${tid}:${cm.key || cm.id}`
        // 兼容老版本的 key（`tid:评论id`），免得升级后把回过的评论又回一遍
        if (replied[key] || replied[`${tid}:${cm.id}`]) continue
        const ageH = cm.time ? (Date.now() / 1000 - cm.time) / 3600 : 0
        if (ageH > maxAgeH) {
          replied[key] = Date.now()
          continue
        }

        const thread = threadOf.get(cm.parentId || cm.id) || null
        const isFollowUp = Boolean(cm.parentId)        // 别人在她评论下面回她
        const herInThread = thread ? thread.replies.filter((r) => r.uin === selfUin).length : 0
        if (isFollowUp && herInThread >= maxPerThread) {
          replied[key] = Date.now()
          log(`回评论：和 ${cm.name} 这条已经聊了 ${herInThread} 轮，不再接。`)
          continue
        }

        const rate = replyAllowedNow()
        if (!rate.ok) {
          log(`回评论：${rate.why}，先不回。`)
          break
        }
        // 第一次评论：按概率决定要不要理；别人回她的：交给她自己判断
        if (!isFollowUp && Math.random() > chance) {
          replied[key] = Date.now()
          log(`回评论（${reason}）：这条先没回 —— ${cm.name}：${cm.content.slice(0, 40)}`)
          continue
        }

        const role = readRoleCard(cfg)
        const mood = readMood(cfg)
        const model = await resolveModel(ctx, cfg)
        if (!model) {
          log('回评论：拿不到可用模型，跳过。')
          break
        }

        // 让私聊里的她马上知道「我空间这边有人跟我说话」
        const isOwner = Number(cm.uin) === ownerQq
        const actorName = isOwner ? `主人（${cm.name}）` : cm.name
        upsertQzoneNote(
          cfg,
          isFollowUp
            ? `${actorName} 回了我空间里的评论「${cm.content.slice(0, 12)}」`
            : `${actorName} 评论了我的说说「${cm.content.slice(0, 12)}」`,
          (Number(cm.time) || Date.now() / 1000) * 1000,
        )
        let result = { reply: false, text: '' }
        try {
          result = await generateReply(ctx, cfg, model, {
            role,
            mood,
            postText,
            comment: cm,
            isOwner,
            thread: isFollowUp ? thread : null,
            decide: isFollowUp,
            selfUin,
          })
        } catch (error) {
          log('回评论时模型调用失败：' + (error?.message ?? error))
          continue
        }
        if (!result.reply || !result.text) {
          replied[key] = Date.now()
          log(`回评论：${isFollowUp ? '她想了想，这条先不接' : '模型没写出内容，跳过'} —— ${cm.name}：${cm.content.slice(0, 40)}`)
          continue
        }
        const text = result.text

        if (ccfg.dryRun || cfg.dryRun) {
          log(`[dryRun] 会回 ${cm.name}${isOwner ? '（主人）' : ''}：「${text}」（原评论：${cm.content.slice(0, 60)}）`)
          replied[key] = Date.now()
          continue
        }

        // 像真人一样先看一会儿再回
        const range = Array.isArray(ccfg.replyDelayMs) ? ccfg.replyDelayMs : [15000, 60000]
        const wait = randInt(Math.max(0, Number(range[0]) || 0), Math.max(1000, Number(range[1]) || 60000))
        log(`准备回 ${cm.name}${isOwner ? '（主人）' : ''}：「${text}」，${Math.round(wait / 1000)} 秒后发`)
        await sleep(wait)
        let newId = ''
        let nested = true
        try {
          // 挂在对方那条评论下面（真正的「回复」）
          const r = await replyToComment(cfg, {
            tid,
            commentId: cm.parentId || cm.id,
            commentUin: cm.uin,
            hostUin: selfUin,
            selfUin,
            content: text,
          })
          newId = String(r?.id || '')
        } catch (error) {
          nested = false
          const fails = (Number(state.replyFailures?.[key]) || 0) + 1
          state.replyFailures = { ...(state.replyFailures || {}), [key]: fails }
          writeJson(STATE_PATH, state)
          const why = String(error?.message ?? error).slice(0, 120)
          // 限流/凭证问题：宁可晚点再试，也别把回复发到「外面」去
          if (fails < 8) {
            log(`嵌套回复失败（第 ${fails} 次），这次先不发，下一轮再试：${why}`)
            continue
          }
          log('嵌套回复连续失败，退回顶层评论：' + why)
          try {
            // 顶层兜底也带上 @他，至少看得出在回谁
            const fallback = /^@/.test(text) ? text : `@${cm.name} ${text}`
            const data = await gatewayCall(cfg, 'comment_qzone', { tid, content: fallback })
            newId = String(data?.comment_id ?? data ?? '').slice(0, 40)
          } catch (error2) {
            log('发评论也失败：' + (error2?.message ?? error2))
            continue
          }
        }
        const at = Date.now()
        replied[key] = at
        if (state.replyFailures) delete state.replyFailures[key]
        state.replyAt = [...(Array.isArray(state.replyAt) ? state.replyAt : []), at].slice(-400)
        state.replies = [
          { at, tid, toCommentId: cm.id, to: cm.name, toUin: cm.uin, comment: cm.content.slice(0, 200), text, newCommentId: newId, isOwner, nested, thread: isFollowUp },
          ...(Array.isArray(state.replies) ? state.replies : []),
        ].slice(0, 120)
        writeJson(STATE_PATH, state)
        try {
          appendFileSync(POSTS_PATH, JSON.stringify({ at: new Date(at).toISOString(), kind: 'reply', tid, to: cm.name, comment: cm.content.slice(0, 120), text, nested, thread: isFollowUp }) + '\n', 'utf8')
        } catch { /* noop */ }
        log(`已${nested ? '回复' : '评论'} ${cm.name}：${text}`)
        upsertQzoneNote(cfg, isOwner ? `回了主人的评论「${cm.content.slice(0, 12)}」` : `回了 ${cm.name} 的评论`, at)
        handled++
        // 两条回复之间也隔一会儿，别把 Qzone 的限流撞出来
        if (handled < maxPerPoll) await sleep(randInt(15000, 40000))
      }
      writeJson(STATE_PATH, state)
    }

    state.lastCommentPollAt = Date.now()
    writeJson(STATE_PATH, state)
    log(`回评论（${reason}）：查了 ${checked} 条有评论的说说，这轮回了 ${handled} 条。`)

    // 顺路看看好友动态（有自己的额度，不会抢这里的名额）
    try {
      await commentFriendFeeds(reason)
    } catch (error) {
      log('好友动态异常：' + (error?.message ?? error))
    }
    // 以及：她在朋友说说下留过言的，朋友回了她没有
    try {
      await pollFriendThreads(reason)
    } catch (error) {
      log('好友动态回评异常：' + (error?.message ?? error))
    }
  }

  /** 好友动态：朋友发了说说就去留一句（后续回不回由模型定） */
  async function commentFriendFeeds(reason = 'timer') {
    const f = cfg.friends || {}
    if (f.enabled === false) return
    if (!inActiveHours(new Date(), cfg.activeHours)) return
    const selfUin = await ensureSelfUin(cfg, state)

    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const dayCap = Math.max(1, Number(f.maxPerDay) || 10)
    const todayCount = () => (Array.isArray(state.friendCommentAt) ? state.friendCommentAt : [])
      .map(Number).filter((t) => t >= dayStart.getTime()).length
    if (todayCount() >= dayCap) {
      log(`好友动态：今天已经留过 ${todayCount()} 条（上限 ${dayCap}），不看了。`)
      return
    }

    const feeds = await gatewayCall(cfg, 'get_qzone_feeds', { count: Math.max(3, Number(f.postsToCheck) || 12) })
    const list = Array.isArray(feeds?.feeds) ? feeds.feeds : []
    const seen = (state.friendCommented && typeof state.friendCommented === 'object') ? state.friendCommented : (state.friendCommented = {})
    const allow = (Array.isArray(f.allowUins) ? f.allowUins : []).map(Number).filter((n) => n > 0)
    const skip = (Array.isArray(f.skipUins) ? f.skipUins : []).map(Number)
    const nowSec = Date.now() / 1000
    const minAge = Math.max(0, Number(f.minAgeMinutes) || 20) * 60
    const maxAge = Math.max(minAge, (Number(f.maxAgeHours) || 24) * 3600)

    const candidates = []
    for (const feed of list) {
      const uin = Number(feed?.uin) || 0
      const key = String(feed?.key || '')
      if (!uin || !key) continue
      if (uin === selfUin) continue
      if (Number(feed?.appid) !== 311) continue          // 只要说说，跳过相册/日志/广告
      if (uin === Number(ccfg.ownerQQ) && f.commentOwner !== true) continue
      if (skip.includes(uin)) continue
      if (allow.length && !allow.includes(uin)) continue
      const age = nowSec - Number(feed?.time || 0)
      if (!(age >= minAge) || age > maxAge) continue
      if (seen[`${uin}:${key}`]) continue
      candidates.push({ uin, key, nickname: String(feed?.nickname || `QQ${uin}`), time: Number(feed?.time || 0) })
    }
    if (!candidates.length) return

    // 全都去留一句：新到旧排序，一轮最多 maxPerPoll 条（别一次刷屏）
    candidates.sort((a, b) => b.time - a.time)
    const maxPerRun = Math.max(1, Number(f.maxPerPoll) || 3)
    let done = 0
    for (const pick of candidates) {
      if (done >= maxPerRun) break
      if (todayCount() >= dayCap) {
        log(`好友动态：今天已经留到 ${todayCount()} 条（上限 ${dayCap}），剩下的下次再说。`)
        break
      }

      // 正文从「他的说说列表」里取，别从 feed 的 HTML 里刮
      let postText = ''
      try {
        const posts = await gatewayCall(cfg, 'get_qzone_msg_list', { target_uin: pick.uin, num: 5 })
        const hit = (Array.isArray(posts?.msglist) ? posts.msglist : []).find((p) => String(p?.tid) === pick.key)
        postText = String(hit?.content || '').trim()
      } catch (error) {
        log(`好友动态：拉 ${pick.nickname} 的说说正文失败：${error?.message ?? error}`)
      }
      if (!postText) {
        seen[`${pick.uin}:${pick.key}`] = Date.now()
        writeJson(STATE_PATH, state)
        log(`好友动态：${pick.nickname} 那条没拿到正文，跳过。`)
        continue
      }

      const role = readRoleCard(cfg)
      const mood = readMood(cfg)
      const model = await resolveModel(ctx, cfg)
      if (!model) return
      let text = ''
      try {
        text = await generateFriendComment(ctx, cfg, model, { role, mood, postText, nickname: pick.nickname })
      } catch (error) {
        log('好友动态：写评论失败：' + (error?.message ?? error))
        continue
      }
      if (!text) continue

      if (f.dryRun || cfg.dryRun) {
        // dryRun 只预览，不写 seen —— 否则「试跑一次」就把这条真评论吞掉了
        log(`[dryRun] 会在 ${pick.nickname} 的说说下留一句：「${text}」（原说说：${postText.slice(0, 50)}）`)
        continue
      }

      const dRange = Array.isArray(f.delayMs) ? f.delayMs : [8000, 25000]
      const wait = randInt(Math.max(0, Number(dRange[0]) || 0), Math.max(1000, Number(dRange[1]) || 25000))
      log(`好友动态：准备在 ${pick.nickname} 的说说下留「${text}」，${Math.round(wait / 1000)} 秒后发`)
      await sleep(wait)

      let newCommentId = ''
      try {
        const data = await gatewayCall(cfg, 'comment_qzone', { tid: pick.key, target_uin: pick.uin, content: text })
        newCommentId = String(data?.comment_id ?? data ?? '').slice(0, 40)
      } catch (error) {
        log('好友动态：评论失败：' + (error?.message ?? error))
        continue
      }
      const at = Date.now()
      seen[`${pick.uin}:${pick.key}`] = at
      state.friendCommentAt = [...(Array.isArray(state.friendCommentAt) ? state.friendCommentAt : []), at].slice(-200)
      state.friendComments = [
        { at, uin: pick.uin, nickname: pick.nickname, tid: pick.key, post: postText.slice(0, 200), text, newCommentId },
        ...(Array.isArray(state.friendComments) ? state.friendComments : []),
      ].slice(0, 100)
      writeJson(STATE_PATH, state)
      try {
        appendFileSync(POSTS_PATH, JSON.stringify({ at: new Date(at).toISOString(), kind: 'friendComment', to: pick.nickname, toUin: pick.uin, tid: pick.key, post: postText.slice(0, 120), text }) + '\n', 'utf8')
      } catch { /* noop */ }
      log(`已去 ${pick.nickname} 的说说下留评论：${text}`)
      upsertQzoneNote(cfg, `去 ${Number(pick.uin) === Number(ccfg.ownerQQ) ? '主人' : pick.nickname} 的说说下留了句话`, at)
      done++
    }
    if (done > 0) log(`好友动态（${reason}）：这轮在 ${done} 条说说下留了话。`)
  }

  /** 她在朋友说说下留过言、朋友又回她 —— 同样交给模型决定接不接（可以来回好几轮） */
  async function pollFriendThreads(reason = 'timer') {
    const f = cfg.friends || {}
    if (f.enabled === false) return
    if (!inActiveHours(new Date(), cfg.activeHours)) return
    const selfUin = await ensureSelfUin(cfg, state)
    const entries = (Array.isArray(state.friendComments) ? state.friendComments : [])
      .filter((e) => e && e.tid && e.newCommentId && Date.now() - Number(e.at || 0) < 72 * 3600 * 1000)
      .slice(0, 4)
    if (!entries.length) return
    const replied = (state.replied && typeof state.replied === 'object') ? state.replied : (state.replied = {})
    const maxPerThread = Math.max(1, Number(ccfg.maxRepliesPerThread) || 6)

    for (const e of entries) {
      let detail
      try {
        detail = await gatewayCall(cfg, 'get_qzone_msg_detail', { tid: e.tid, target_uin: e.uin, num: 50 })
      } catch (error) {
        log(`好友动态：读 ${e.nickname} 那条的评论失败：${error?.message ?? error}`)
        continue
      }
      const root = (Array.isArray(detail?.comments) ? detail.comments : [])
        .find((c) => String(c?.comment_id) === String(e.newCommentId))
      if (!root) continue
      const replies = Array.isArray(root.replies) ? root.replies : []
      const herCount = replies.filter((x) => Number(x?.uin) === selfUin).length
      if (herCount >= maxPerThread) continue

      for (const r of replies) {
        const uin = Number(r?.uin) || 0
        const content = String(r?.content ?? '').replace(/\s+/g, ' ').trim()
        if (!uin || uin === selfUin || !content) continue
        if (Date.now() / 1000 - (Number(r?.time) || 0) > 48 * 3600) continue
        const key = `f:${e.uin}:${e.tid}:${e.newCommentId}:${r?.comment_id}`
        if (replied[key]) continue
        const rate = replyAllowedNow()
        if (!rate.ok) return

        const role = readRoleCard(cfg)
        const mood = readMood(cfg)
        const model = await resolveModel(ctx, cfg)
        if (!model) return
        const thread = {
          root: { name: '我', uin: selfUin, content: String(root.content ?? '').replace(/\s+/g, ' ').trim() },
          replies: replies
            .filter((x) => x !== r)
            .map((x) => ({
              name: String(x?.name ?? '').trim() || `QQ${x?.uin ?? ''}`,
              uin: Number(x?.uin) || 0,
              content: String(x?.content ?? '').replace(/\s+/g, ' ').trim(),
            })),
        }

        let result = { reply: false, text: '' }
        try {
          result = await generateReply(ctx, cfg, model, {
            role,
            mood,
            postText: String(detail?.content ?? e.post ?? ''),
            comment: { name: String(r?.name ?? '').trim() || `QQ${uin}`, uin, content },
            isOwner: uin === Number(ccfg.ownerQQ),
            thread,
            decide: true,
            selfUin,
          })
        } catch (error) {
          log('好友动态：回评生成失败：' + (error?.message ?? error))
          continue
        }
        if (!result.reply || !result.text) {
          replied[key] = Date.now()
          log(`好友动态：${e.nickname} 那边 ${r?.name} 回了她，她想了想先不接。`)
          continue
        }
        if (ccfg.dryRun || cfg.dryRun || f.dryRun) {
          log(`[dryRun] 会在 ${e.nickname} 的说说下回 ${r?.name}：「${result.text}」`)
          replied[key] = Date.now()
          continue
        }

        const dRange = Array.isArray(ccfg.replyDelayMs) ? ccfg.replyDelayMs : [15000, 60000]
        await sleep(randInt(Math.max(0, Number(dRange[0]) || 0), Math.max(1000, Number(dRange[1]) || 60000)))
        try {
          await replyToComment(cfg, {
            tid: e.tid,
            commentId: e.newCommentId,
            commentUin: uin,
            hostUin: e.uin,
            selfUin,
            content: result.text,
          })
        } catch (error) {
          log('好友动态：嵌套回复失败：' + (error?.message ?? error))
          continue
        }
        const at = Date.now()
        replied[key] = at
        state.replyAt = [...(Array.isArray(state.replyAt) ? state.replyAt : []), at].slice(-400)
        state.replies = [
          { at, tid: e.tid, toCommentId: e.newCommentId, to: String(r?.name ?? ''), toUin: uin, comment: content.slice(0, 200), text: result.text, hostUin: e.uin, nested: true, thread: true },
          ...(Array.isArray(state.replies) ? state.replies : []),
        ].slice(0, 120)
        writeJson(STATE_PATH, state)
        try {
          appendFileSync(POSTS_PATH, JSON.stringify({ at: new Date(at).toISOString(), kind: 'friendReply', host: e.nickname, tid: e.tid, to: String(r?.name ?? ''), comment: content.slice(0, 120), text: result.text }) + '\n', 'utf8')
        } catch { /* noop */ }
        log(`已在 ${e.nickname} 的说说下回 ${r?.name}：${result.text}`)
        upsertQzoneNote(cfg, `在 ${e.nickname} 的说说下回了 ${r?.name}`, at)
      }
    }
  }

  /** 下次查评论的时间：活跃时段内按 pollMinutes ± 抖动 */
  function nextPollDelay() {
    const mins = Math.max(0.2, Number(ccfg.pollMinutes) || 10)
    const jitter = Math.max(0, Number(ccfg.pollJitterMinutes) || 0)
    let at = Date.now() + (mins + (Math.random() * 2 - 1) * jitter) * MIN_MS
    if (!inActiveHours(new Date(at), cfg.activeHours)) {
      const start = nextActiveStart(new Date(at), cfg.activeHours)
      if (start) at = start.getTime() + randInt(0, 10) * MIN_MS
    }
    return Math.max(30 * 1000, at - Date.now())
  }

  /** 排下一次查评论（用独立的 timer，不影响发说说） */
  function scheduleCommentPoll(delayMs) {
    if (ccfg.enabled === false) return
    if (holder.pollTimer) {
      clearTimeout(holder.pollTimer)
      holder.pollTimer = null
    }
    const delay = Math.max(15 * 1000, Number(delayMs) || nextPollDelay())
    holder.pollTimer = setTimeout(async () => {
      holder.pollTimer = null
      try {
        await pollComments('timer')
      } catch (error) {
        log('回评论异常：' + (error?.message ?? error))
      }
      scheduleCommentPoll(nextPollDelay())
    }, delay)
    holder.pollTimer.unref?.()
  }

  /** 真正写一条 */
  async function writeOne(reason, { debug = false } = {}) {
    const startedAt = new Date()
    if (!debug) {
      const lastAttempt = Number(state.lastAttemptAt) || 0
      if (lastAttempt && Date.now() - lastAttempt < 3 * MIN_MS) {
        log('刚刚试过（3 分钟内），跳过这一次，避免重复。')
        return false
      }
    }
    state.lastAttemptAt = Date.now()
    writeJson(STATE_PATH, state)

    const mood = readMood(cfg)
    const length = decideLength(cfg, mood, debug)
    const form = pickOne(FORMS)

    // 图库先读进内存（挑图是同步的）
    let candidates = []
    if (cfg.images?.enabled !== false && (debug ? true : Math.random() < Math.max(0, Math.min(1, Number(cfg.images?.chance ?? 0.8))))) {
      memePoolSync = await loadMemes(cfg)
      candidates = pickImageCandidates(cfg, mood)
    }

    let transcript = null
    try {
      const messages = await fetchRecent(cfg)
      transcript = buildTranscript(messages, cfg)
      log(`取材：${cfg.sourceKey} 最近 ${transcript.count} 条消息，取用 ${transcript.text.length} 字`)
    } catch (error) {
      log('拉聊天记录失败（这次就不写今天的事了）：' + (error?.message ?? error))
    }

    const role = readRoleCard(cfg)
    const notes = readNotes(cfg)
    const recent = state.posts.slice(0, 2).map((p) => String(p.text || '').replace(/\s+/g, ' ').slice(0, 120))

    const model = await resolveModel(ctx, cfg)
    if (!model) {
      log('拿不到可用模型，跳过。')
      return false
    }

    const system = buildSystemPrompt({ cfg, role, mood, form, length })
    const user = [
      `现在是 ${startedAt.getFullYear()}年${startedAt.getMonth() + 1}月${startedAt.getDate()}日 ${WEEKDAYS[startedAt.getDay()]} ${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}，${timeOfDay(startedAt)}。`,
      '',
      '你此刻的心情：',
      moodLine(mood),
      '',
      transcript && transcript.text ? `今天你和${cfg.ownerName}聊过的（节选，只当素材，别照着复述）：\n${transcript.text}` : '',
      transcript && transcript.text ? '' : '',
      notes.length ? `你一直记着的事：\n${notes.map((n) => '· ' + n).join('\n')}` : '',
      recent.length ? `你最近发过的说说（别重复它们的开头、句式和内容）：\n${recent.map((t) => '· ' + t).join('\n')}` : '',
      candidates.length
        ? `配图候选（按你自己的想法挑，0~2 张；不贴就一张都不配）：\n${candidates.map((c, i) => `${i}. [${c.tag}] ${c.caption}`).join('\n')}`
        : '',
      '',
      '请写这一条说说。只输出一个 JSON 对象，不要别的字、不要 markdown：',
      candidates.length ? '{"text":"说说正文","images":[0]}' : '{"text":"说说正文"}',
      candidates.length ? 'images 里填候选图的编号，最多两张；不配图就给空数组 []。' : '',
    ].filter((x) => x !== '').join('\n')

    log(`开始写（${reason}）：心情 ${mood?.mood ?? '?'}，目标 ${length.target} 字（${length.lo}~${length.hi}），形态「${form}」，候选图 ${candidates.length} 张`)

    let out = ''
    try {
      const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
      for await (const chunk of ctx.llm.stream({
        provider: model.provider,
        model: model.model,
        system,
        messages,
        maxTokens: Math.max(200, Number(cfg.maxTokens) || 900),
        temperature: Math.max(0, Math.min(1.5, Number(cfg.temperature) || 0.95)),
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          throw new Error('模型返回错误：' + (chunk.reason.failure?.message || 'unknown'))
        }
      }
    } catch (error) {
      log('模型调用失败：' + (error?.message ?? error))
      return false
    }

    const parsed = parseDiary(out)
    if (!parsed) {
      log('模型没写出内容（原文前 120 字）：' + String(out || '').slice(0, 120))
      return false
    }
    const text = cleanText(parsed.text, length)
    if (text.length < 12) {
      log('写出来的太短，丢掉：' + JSON.stringify(text))
      return false
    }
    // 和上一条撞车就不发（同一天里尤其容易）
    const lastText = String(state.posts?.[0]?.text || '').trim()
    if (lastText && (lastText === text || (lastText.length > 20 && text.startsWith(lastText.slice(0, 20))))) {
      log('和上一条说说太像，丢掉这次。')
      return false
    }

    const imagePaths = normalizeImagePicks(parsed.images, candidates, cfg.images?.max ?? 2)

    if (cfg.dryRun) {
      log(`[dryRun] 会发这条（${text.length} 字，配图 ${imagePaths.length} 张）：\n---\n${text}\n---`)
      if (imagePaths.length) log('[dryRun] 配图：' + imagePaths.join(' | '))
      return false
    }

    let data = null
    try {
      data = await publishDiary(cfg, text, imagePaths)
    } catch (error) {
      log('发说说失败：' + (error?.message ?? error))
      state.retryCount = (Number(state.retryCount) || 0) + 1
      writeJson(STATE_PATH, state)
      return false
    }

    const at = Date.now()
    state.retryCount = 0
    state.lastPostAt = at
    state.dayCount = todayCount() + 1
    state.dayKey = dayKeyOf(new Date())
    state.runs = (Number(state.runs) || 0) + 1
    state.posts = [{ at, tid: data?.tid || '', text, images: imagePaths, mood: mood?.mood ?? null, reason }, ...state.posts].slice(0, 40)
    writeJson(STATE_PATH, state)
    try {
      appendFileSync(POSTS_PATH, JSON.stringify({ at: new Date(at).toISOString(), tid: data?.tid || '', text, images: imagePaths, mood: mood?.mood ?? null }) + '\n', 'utf8')
    } catch { /* noop */ }

    log(`已发说说（${text.length} 字，配图 ${imagePaths.length} 张，tid=${data?.tid || '?'}）：\n${text}`)
    // 让她自己「记得」发过这条 —— 写进共享笔记，角色卡会自动带上
    upsertQzoneNote(
      cfg,
      `发了条说说「${String(text).replace(/\s+/g, ' ').slice(0, 16)}…」${imagePaths.length ? `（配了 ${imagePaths.length} 张图）` : ''}`,
      at,
    )
    // 刚发完，过两三分钟去看看有没有人评论
    if (ccfg.enabled !== false) scheduleCommentPoll(randInt(120, 240) * 1000)
    return true
  }

  let nextAt = null
  function schedule() {
    const at = planNext()
    nextAt = at
    const delay = Math.max(30 * 1000, at.getTime() - Date.now())
    state.plannedAt = at.toISOString()
    state.updatedAt = new Date().toISOString()
    writeJson(STATE_PATH, state)
    log(`下次可能在 ${at.toLocaleString('zh-CN')}（约 ${Math.round(delay / MIN_MS)} 分钟后），到时再掷骰子决定写不写。`)
    holder.timer = setTimeout(async () => {
      holder.timer = null
      try {
        const today = todayCount()
        const cap = Math.max(1, Number(cfg.dailyMax) || 3)
        if (today >= cap) {
          log(`今天已经发了 ${today} 条（上限 ${cap}），这次不写。`)
        } else if (Math.random() > Math.max(0, Math.min(1, Number(cfg.writeChance) || 0.62))) {
          log('掷骰子没中，这次不想写。')
        } else {
          await writeOne('schedule')
        }
      } catch (error) {
        log('定时任务异常：' + (error?.message ?? error))
      }
      schedule()
    }, delay)
    holder.timer.unref?.()
  }

  const hours = Array.isArray(cfg.activeHours) ? cfg.activeHours.join('–') : String(cfg.activeHours)
  log(`已启动：活跃 ${hours}，间隔 ${cfg.gapMinutes?.join('~')} 分钟，每天最多 ${cfg.dailyMax} 条，概率 ${cfg.writeChance}，dryRun=${cfg.dryRun}`)
  log(ccfg.enabled === false
    ? '回评论：已关闭（comments.enabled = false）。'
    : `回评论：开着 —— 每 ${ccfg.pollMinutes} 分钟左右看一次，回复几率 ${ccfg.replyChance}，每小时 ≤${ccfg.maxRepliesPerHour}、每天 ≤${ccfg.maxRepliesPerDay}`)
  log((cfg.friends?.enabled ?? true) === false
    ? '好友动态：已关闭（friends.enabled = false）。'
    : `好友动态：开着 —— 几率 ${cfg.friends.chance}，每天 ≤${cfg.friends.maxPerDay} 条，${cfg.friends.minAgeMinutes}~${cfg.friends.maxAgeHours * 60} 分钟内的说说`)

  if (Number(cfg.runAfterMinutes) > 0) {
    const delay = Number(cfg.runAfterMinutes) * MIN_MS
    log(`调试：${cfg.runAfterMinutes} 分钟后试写一条（跳过概率和每日上限）`)
    holder.timer = setTimeout(async () => {
      holder.timer = null
      try {
        await writeOne('debug', { debug: true })
      } catch (error) {
        log('调试试写异常：' + (error?.message ?? error))
      }
      schedule()
    }, delay)
    holder.timer.unref?.()
  } else {
    schedule()
  }

  // 回评论：独立的一条轮询定时器（和发说说互不影响）
  if (ccfg.enabled !== false) {
    if (Number(ccfg.runAfterMinutes) > 0) {
      log(`调试：${ccfg.runAfterMinutes} 分钟后先查一次评论`)
      scheduleCommentPoll(Number(ccfg.runAfterMinutes) * MIN_MS)
    } else {
      scheduleCommentPoll(nextPollDelay())
    }
  }

  ctx?.on?.('dispose', () => {
    // 只有「当前这一代」才有权清理；旧实例晚到的 dispose 别动新实例的定时器
    if (holder.gen !== gen) {
      log(`旧实例（#${gen}）卸载，新实例（#${holder.gen}）的定时器保持不动。`)
      return
    }
    if (holder.timer) {
      clearTimeout(holder.timer)
      holder.timer = null
    }
    if (holder.pollTimer) {
      clearTimeout(holder.pollTimer)
      holder.pollTimer = null
    }
    log('已卸载，定时器已清理。')
  })
}




