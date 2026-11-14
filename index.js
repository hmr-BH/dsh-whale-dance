/**
 * dsh-whale-dance — 宿主半区。
 *
 * 提供两件事：
 * 1. 给模型一组工具：按歌名在 B 站搜索候选、按播放量排序；选定 BV 后下载音频（约 4 秒预缓冲 + 流式播放）并开始蹦迪。
 * 2. 给浏览器半区提供状态与音频路由：`/dsh-dance/state.json`、`/dsh-dance/audio`、
 *    `/dsh-dance/stop`。所有路由都经过 DSH 的浏览器信任栅栏。
 *
 * 本文件只依赖 Node 内建模块，不引入 Harness Client 包，也不读写其他插件的私有数据。 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-whale-dance'
export const inject = ['tools', 'webServer']

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** B 站接口需要一个 buvid3 cookie，否则常见 412 风控。 */
const BILI_COOKIE = 'buvid3=7B3D9F0A-2C41-4B6E-9B60-5D2A8E7C1F00infoc; b_nut=1700000000'

const BILI_HEADERS = {
  'User-Agent': USER_AGENT,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
  Cookie: BILI_COOKIE,
}

const NETEASE_HEADERS = {
  'User-Agent': USER_AGENT,
  Referer: 'https://music.163.com/',
  Accept: 'application/json, text/plain, */*',
}

const BILI_SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type'
const BILI_VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const BILI_PLAY_URL = 'https://api.bilibili.com/x/player/playurl'
const NETEASE_SEARCH_URL = 'https://music.163.com/api/search/get'
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric'
const NETEASE_OUTER_URL = 'https://music.163.com/song/media/outer/url'

/** 音频缓存目录（DSH_HOME 或 ~/.dsh 下）。 */
function cacheRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, '.dsh-whale-dance')
}

function ensureCacheDir() {
  const dir = cacheRoot()
  try {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/** 当前蹦迪状态（进程内单例；只有一个挂件，因此一次只跳一首）。 */
let currentDance = idleDance()
/** 最近一次浏览器轮询状态的时间，用来判断界面是否真的连着。 */
let lastClientSeenAt = 0
/** 最近一次客户端上报的界面版本；低于 20 说明页面里还是旧版动画/旧音频逻辑。 */
let lastClientVersion = 0

function idleDance() {
  return { version: 0, status: 'idle' }
}

function bumpDance(next) {
  currentDance = { ...next, version: (currentDance.version || 0) + 1, updatedAt: Date.now() }
  return currentDance
}

function danceForClient(dance) {
  if (dance.status !== 'playing') return { version: dance.version || 0, status: 'idle' }
  return {
    version: dance.version,
    status: 'playing',
    id: dance.id,
    song: dance.song,
    artist: dance.artist,
    dj: dance.dj,
    audioUrl: dance.audioPath ? `/dsh-dance/audio?v=${encodeURIComponent(dance.id)}` : null,
    audioType: dance.audioType || null,
    audioSource: dance.audioSource || 'none',
    fallbackUrl: dance.audioSource === 'bilibili' && dance.fallbackId > 0 ? '/dsh-dance/audio?fallback=1' : null,
    bilibiliUrl: dance.bilibiliUrl || null,
    bilibiliTitle: dance.bilibiliTitle || null,
    lyrics: dance.lines || [],
    keyLyrics: dance.keyLyrics || [],
    durationSec: dance.durationSec || 0,
    startedAt: dance.startedAt,
  }
}

// ---------------------------------------------------------------------------
// 网络小工具
// ---------------------------------------------------------------------------

async function requestJson(url, headers, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json()
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDuration(text) {
  const match = /^(\d+):(\d{1,2})$/.exec(String(text || '').trim())
  if (!match) return 0
  return Number(match[1]) * 60 + Number(match[2])
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(value / 60)
  const rest = String(value % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

/** 只有一句「来首歌 / 蹦一个」而不是歌词或歌名时，给出可执行的提示。 */
const GENERIC_DANCE_REQUEST = /^(来首歌|放首歌|来首音乐|来点音乐|来个音乐|蹦一个|蹦迪|来蹦迪|蹦起来|跳起来|跳个舞|来首dj|dj|music|dance)$/i

/** 表示「想听某一首」的说法，用来区分歌名和普通歌词。 */
const TITLE_INTENT = /(来首|放首|放个|听首|唱首|播首|来个|点一首|点个|播放|《|》|「|」)/i

/** 去掉「来首 / 放个 / 书名号」等外壳，得到更适合搜索的歌名。 */
function cleanTitleQuery(text) {
  return String(text || '')
    .replace(/来首|放首|放个|听首|唱首|播首|来个|点一首|点个|播放/g, '')
    .replace(/[《》「」“”]/g, '')
    .trim()
}

/** 把 LRC 文本解析成按时间排序的歌词行。 */
export function parseLrc(raw) {
  const lines = []
  const seen = new Set()
  const metadata = /^(作词|作曲|编曲|制作人|词|曲|词曲|OP|SP|出品|发行|监制|混音|母带|和声|录音|统筹|吉他|贝斯|鼓|键盘|弦乐|策划|原唱|翻唱|音乐制作|制作|录音师|混音师|母带师|混音助理|人声编辑|配唱)\s*[:：]/i
  const source = String(raw || '')
  for (const line of source.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) {
      const plain = line.trim()
      if (plain.length > 0 && !plain.startsWith('{') && !metadata.test(plain)) {
        if (!seen.has(plain)) {
          seen.add(plain)
          lines.push({ t: lines.length * 4, text: plain })
        }
      }
      continue
    }
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    if (text.length === 0 || metadata.test(text)) continue
    for (const stamp of stamps) {
      const minutes = Number(stamp[1])
      const seconds = Number(stamp[2])
      const fractionRaw = stamp[3]
      const fraction = fractionRaw === undefined
        ? 0
        : Number(fractionRaw.padEnd(3, '0')) / 1000
      const time = minutes * 60 + seconds + fraction
      const key = `${time.toFixed(2)}|${text}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push({ t: time, text })
    }
  }
  lines.sort((a, b) => a.t - b.t)
  const bounded = []
  for (const line of lines) {
    if (bounded.length > 0 && line.t - bounded[bounded.length - 1].t < 0.2) {
      bounded[bounded.length - 1] = line
    } else {
      bounded.push(line)
    }
  }
  return bounded.slice(0, 200)
}

/** 在 B 站搜视频（标题/简介/标签）。 */
export async function searchBilibili(keyword, options = {}) {
  const query = String(keyword || '').trim()
  if (query.length === 0) return []
  const url = `${BILI_SEARCH_URL}?search_type=video&keyword=${encodeURIComponent(query)}&page=1`
  const payload = await requestJson(url, BILI_HEADERS, options.timeoutMs)
  if (payload.code !== 0) throw new Error(`bilibili search failed: ${payload.code}`)
  const list = Array.isArray(payload.data?.result) ? payload.data.result : []
  return list.map((item) => ({
    bvid: String(item.bvid || ''),
    title: stripHtml(item.title),
    author: stripHtml(item.author),
    description: stripHtml(item.description).slice(0, 400),
    tag: stripHtml(item.tag),
    duration: item.duration,
    durationSec: parseDuration(item.duration),
    play: Number(item.play) || 0,
    pubdate: Number(item.pubdate) || 0,
    cover: String(item.pic || '').startsWith('//') ? `https:${item.pic}` : String(item.pic || ''),
  })).filter((video) => video.bvid.length > 0 && video.title.length > 0)
}

/** 从 URL / 文本里提取 BV 号。 */
export function normalizeBvid(value) {
  const match = String(value || '').match(/BV[0-9A-Za-z]{10}/)
  return match ? match[0] : ''
}

/** 按播放量从高到低排候选；只保留标题/简介命中歌名、时长正常的视频。 */
export function rankBilibiliByPlay(videos, songName, options = {}) {
  const songKey = normalizeText(songName)
  const excludeDj = options.excludeDj === true
  const excludeCover = options.excludeCover === true
  const excludeHonk = options.excludeHonk === true
  const pool = []
  for (const video of videos || []) {
    const haystack = normalizeText(`${video.title || ''} ${video.description || ''} ${video.tag || ''}`)
    if (excludeDj && DJ_WORD.test(haystack)) continue
    if (excludeCover && /翻唱|翻自|cover|女声版|男声版|合唱版|翻版/i.test(haystack)) continue
    if (excludeHonk && /honk|鬼畜|恶搞|整活|搞笑|抽象|沙雕/i.test(haystack)) continue
    const duration = Number(video.durationSec || 0)
    if (duration > 0 && (duration < 30 || duration > 900)) continue
    pool.push({
      video,
      play: Number(video.play) || 0,
      hasSong: songKey.length > 0 && haystack.includes(songKey),
    })
  }
  const matching = pool.filter((entry) => entry.hasSong)
  const ranked = matching.length > 0 ? matching : pool
  ranked.sort((a, b) => b.play - a.play || Number(b.hasSong) - Number(a.hasSong))
  return ranked[0]?.video || null
}

/** 直接按 BV 取视频元数据（不经过搜索）。 */
export async function fetchBilibiliView(bvid, options = {}) {
  const view = await requestJson(`${BILI_VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, BILI_HEADERS, options.timeoutMs)
  if (view.code !== 0 || !view.data) throw new Error('指定的 B 站视频不可用')
  const data = view.data
  return {
    bvid,
    title: stripHtml(data.title),
    author: stripHtml(data.owner?.name || ''),
    description: stripHtml(data.desc || '').slice(0, 400),
    tag: '',
    durationSec: Number(data.duration) || 0,
    play: Number(data.stat?.view) || 0,
    pubdate: Number(data.pubdate) || 0,
    cover: String(data.pic || '').startsWith('//') ? `https:${data.pic}` : String(data.pic || ''),
    cid: Number(data.cid) || 0,
  }
}

/** 在网易云搜歌曲。 */
export async function searchNetease(keyword, options = {}) {
  const query = String(keyword || '').trim()
  if (query.length === 0) return []
  const url = `${NETEASE_SEARCH_URL}?s=${encodeURIComponent(query)}&type=1&limit=12&offset=0`
  const payload = await requestJson(url, NETEASE_HEADERS, options.timeoutMs)
  if (payload.code !== 200) throw new Error(`netease search failed: ${payload.code}`)
  const songs = payload.result?.songs
  if (!Array.isArray(songs)) return []
  return songs.map((song) => ({
    id: Number(song.id),
    name: String(song.name || ''),
    artists: Array.isArray(song.artists) ? song.artists.map((artist) => String(artist.name || '')).filter(Boolean) : [],
    durationSec: Math.max(0, Math.round(Number(song.duration || 0) / 1000)),
  })).filter((song) => Number.isFinite(song.id) && song.id > 0)
}

/** 抓取网易云歌词；没有就返回空数组。 */
export async function fetchNeteaseLyrics(songId, options = {}) {
  const url = `${NETEASE_LYRIC_URL}?id=${Number(songId)}&lv=-1&kv=-1&tv=-1`
  const payload = await requestJson(url, NETEASE_HEADERS, options.timeoutMs)
  const lines = parseLrc(payload?.lrc?.lyric || '')
  return lines
}

/** 抓取 B 站视频的人工/自动字幕，作为歌词兜底。 */
async function fetchBilibiliSubtitleLyrics(bvid, cid, options = {}) {
  try {
    const url = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`
    const payload = await requestJson(url, BILI_HEADERS, options.timeoutMs)
    const subtitles = payload?.data?.subtitle?.subtitles
    if (!Array.isArray(subtitles) || subtitles.length === 0) return []
    const item = subtitles.find((entry) => /zh/i.test(String(entry.lan || ''))) || subtitles[0]
    const subtitleUrl = String(item.subtitle_url || '')
    if (!subtitleUrl) return []
    const absolute = subtitleUrl.startsWith('//') ? `https:${subtitleUrl}` : subtitleUrl
    const body = await requestJson(absolute, BILI_HEADERS, options.timeoutMs)
    if (!Array.isArray(body?.body)) return []
    return body.body
      .map((row) => ({ t: Number(row.from) || 0, text: stripHtml(row.content) }))
      .filter((row) => row.text.length > 0)
      .sort((a, b) => a.t - b.t)
      .slice(0, 200)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 选片与下载
// ---------------------------------------------------------------------------

const DJ_WORD = /(dj|remix|电摇|电音|慢摇|串烧|蹦迪|舞曲|土嗨)/i

/** 视频标题/简介/标签是否像 DJ/Remix 版本。 */
export function isDjBilibiliVideo(video) {
  return Boolean(video && DJ_WORD.test(`${video.title || ''} ${video.description || ''} ${video.tag || ''}`))
}

/**
 * 从 B 站候选里挑一个最适合当伴奏的视频：优先明确 DJ/Remix，其次标题命中原名，
 * 时长 45 秒到 7 分钟优先，播放量作为次级权重；超长串烧/合集降权。 */
export function pickBilibiliVideo(videos, songName, options = {}) {
  const wantDj = options.wantDj === true
  const songKey = String(songName || '').toLowerCase()
  let best = null
  for (const video of videos || []) {
    const title = String(video.title || '')
    const haystack = `${title} ${video.description || ''} ${video.tag || ''}`
    const hasSong = songKey.length > 0 && haystack.toLowerCase().includes(songKey)
    const hasDj = DJ_WORD.test(haystack)
    const duration = Number(video.durationSec || 0)
    let score = 0
    if (hasSong) score += 45
    if (hasDj) score += wantDj ? 40 : 8
    if (duration >= 45 && duration <= 420) score += 25
    else if (duration > 420 && duration <= 900) score -= 10
    else if (duration > 900) score -= 35
    score += Math.min(20, Math.log10((Number(video.play) || 0) + 10) * 4)
    if (title.includes('合集') || title.includes('串烧') || title.includes('歌单')) score -= 18
    if (wantDj && !hasDj) score -= 30
    if (best === null || score > best.score) best = { score, video }
  }
  return best === null ? null : best.video
}

function isMp4Audio(buffer) {
  return buffer.length > 1024 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
}

function isMp3(buffer) {
  if (buffer.length < 1024) return false
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0
}

/** 正在边下边播的音频条目：bvid -> entry。 */
const streamingAudios = new Map()

/** 预缓冲目标：约 4 秒音频数据，最低 64KB，最高 2MB。 */
function prebufferTarget(total, durationSec) {
  const seconds = 4
  if (total > 0 && durationSec > 0) {
    const bytesPerSecond = total / durationSec
    return Math.max(64 * 1024, Math.min(2 * 1024 * 1024, Math.round(bytesPerSecond * seconds)))
  }
  return 128 * 1024
}

function waitForGrowth(entry, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      entry.waiters.delete(finish)
      resolve()
    }
    entry.waiters.add(finish)
    setTimeout(finish, timeoutMs)
  })
}

function notifyGrowth(entry) {
  for (const waiter of entry.waiters) {
    try { waiter() } catch {}
  }
  entry.waiters.clear()
}

async function readHead(file, length) {
  try {
    const handle = await fs.promises.open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      return buffer
    } finally {
      await handle.close()
    }
  } catch {
    return Buffer.alloc(0)
  }
}

async function fetchAudioStream(url, options = {}) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(options.streamTimeoutMs || 120000)
      const signal = options.signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, options.signal]) : timeout)
        : timeout
      const response = await fetch(url, { headers: { ...BILI_HEADERS }, signal })
      if (response.ok && response.body) return response
      lastError = new Error(`audio HTTP ${response.status}`)
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw lastError || new Error('audio fetch failed')
}

/**
 * 下载 B 站音频并边下边播：先攒够约 4 秒数据就返回，剩余部分后台继续写入同一文件，
 * 音频路由会随着文件增长持续下发，浏览器可以立刻开始播放。 */
export async function streamBilibiliAudio(bvid, options = {}) {
  const view = await requestJson(`${BILI_VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, BILI_HEADERS, options.timeoutMs)
  if (view.code !== 0 || view.data?.cid === undefined) throw new Error('bilibili video unavailable')
  const cid = view.data.cid
  const durationSec = Number(view.data.duration) || 0
  const play = await requestJson(
    `${BILI_PLAY_URL}?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=16&fourk=1`,
    BILI_HEADERS,
    options.timeoutMs,
  )
  if (play.code !== 0) throw new Error(`bilibili playurl failed: ${play.code}`)
  const audioTracks = Array.isArray(play.data?.dash?.audio) ? play.data.dash.audio : []
  if (audioTracks.length === 0) throw new Error('no audio track')
  const preferred = audioTracks
    .slice()
    .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0]

  const controller = new AbortController()
  const response = await fetchAudioStream(preferred.baseUrl, { ...options, signal: controller.signal })
  const total = Number(response.headers.get('content-length')) || 0
  const dir = ensureCacheDir() || os.tmpdir()
  const file = path.join(dir, `stream-${bvid}-${Date.now()}.m4s`)
  const entry = {
    bvid,
    file,
    type: 'audio/mp4',
    written: 0,
    total,
    done: false,
    error: null,
    durationSec,
    cid,
    waiters: new Set(),
    controller,
  }
  streamingAudios.set(bvid, entry)

  const target = prebufferTarget(total, durationSec)
  const writePromise = (async () => {
    const handle = await fs.promises.open(file, 'w')
    try {
      const reader = response.body?.getReader?.()
      if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer())
        await handle.write(buffer, 0, buffer.length, 0)
        entry.written = buffer.length
      } else {
        let position = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.length === 0) continue
          const chunk = Buffer.from(value)
          await handle.write(chunk, 0, chunk.length, position)
          position += chunk.length
          entry.written = position
          notifyGrowth(entry)
        }
      }
    } catch (error) {
      entry.error = error instanceof Error ? error : new Error(String(error))
    } finally {
      try { await handle.close() } catch {}
      entry.done = true
      notifyGrowth(entry)
    }
  })()

  const deadline = Date.now() + (options.prebufferTimeoutMs || 15000)
  while (!entry.done && entry.written < target && !entry.error) {
    if (Date.now() > deadline) break
    await waitForGrowth(entry, 120)
  }
  if (entry.error && entry.written === 0) {
    streamingAudios.delete(bvid)
    throw entry.error
  }
  if (entry.written === 0) throw new Error('unexpected audio payload')
  const head = await readHead(file, 2048)
  if (!isMp4Audio(head)) {
    try { controller.abort() } catch {}
    streamingAudios.delete(bvid)
    throw new Error('unexpected audio payload')
  }
  return { file, entry, contentType: 'audio/mp4', durationSec, cid, writePromise }
}

/** 下载 B 站视频的音频流（audio/mp4，整段下载，保留给测试与兜底）。 */
export async function downloadBilibiliAudio(bvid, options = {}) {
  const view = await requestJson(`${BILI_VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, BILI_HEADERS, options.timeoutMs)
  if (view.code !== 0 || view.data?.cid === undefined) throw new Error('bilibili video unavailable')
  const cid = view.data.cid
  const durationSec = Number(view.data.duration) || 0
  const play = await requestJson(
    `${BILI_PLAY_URL}?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=16&fourk=1`,
    BILI_HEADERS,
    options.timeoutMs,
  )
  if (play.code !== 0) throw new Error(`bilibili playurl failed: ${play.code}`)
  const audioTracks = Array.isArray(play.data?.dash?.audio) ? play.data.dash.audio : []
  if (audioTracks.length === 0) throw new Error('no audio track')
  // 优先常见的高码率 AAC（30280/30216/30232），否则取带宽最高的一条。
  const preferred = audioTracks
    .slice()
    .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0]
  const headers = { ...BILI_HEADERS }
  const response = await fetch(preferred.baseUrl, {
    headers,
    signal: AbortSignal.timeout(options.downloadTimeoutMs || 60000),
  })
  if (!response.ok) throw new Error(`audio HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!isMp4Audio(buffer)) throw new Error('unexpected audio payload')
  const dir = ensureCacheDir()
  if (dir === null) return { buffer, ext: 'm4s', contentType: 'audio/mp4', durationSec, cid }
  const file = path.join(dir, `bili-${bvid}.m4s`)
  fs.writeFileSync(file, buffer)
  return { file, buffer, ext: 'm4s', contentType: 'audio/mp4', durationSec, cid }
}

/** 下载网易云外链 mp3。 */
export async function downloadNeteaseAudio(songId, options = {}) {
  const url = `${NETEASE_OUTER_URL}?id=${Number(songId)}.mp3`
  const response = await fetch(url, {
    headers: NETEASE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.downloadTimeoutMs || 60000),
  })
  if (!response.ok) throw new Error(`audio HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!isMp3(buffer)) throw new Error('unexpected audio payload')
  const dir = ensureCacheDir()
  if (dir === null) return { buffer, ext: 'mp3', contentType: 'audio/mpeg' }
  const file = path.join(dir, `netease-${Number(songId)}.mp3`)
  fs.writeFileSync(file, buffer)
  return { file, buffer, ext: 'mp3', contentType: 'audio/mpeg' }
}

function chooseNeteaseTrack(songs, songName, wantDj) {
  const normalized = String(songName || '').toLowerCase()
  const exact = songs.filter((song) => song.name.toLowerCase() === normalized)
  const fuzzy = songs.filter((song) => song.name.toLowerCase().includes(normalized) || normalized.includes(song.name.toLowerCase()))
  const pool = exact.length > 0 ? exact : fuzzy
  const djTracks = pool.filter((song) => DJ_WORD.test(song.name))
  const plainTracks = pool.filter((song) => !DJ_WORD.test(song.name))
  if (wantDj) return djTracks[0] || pool[0] || songs[0] || null
  return plainTracks[0] || pool[0] || songs[0] || null
}

/** 去掉空白、标点与符号，用于判断歌词片段是否真的出现在某首歌的歌词里。 */
function normalizeText(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/**
 * 判断用户给的歌词片段是否能在这组歌词中找到足够长的连续片段。
 * 网易云搜索是模糊匹配，没有这道校验时「随便一句话」也可能被判成某首歌。 */
export function hintMatchesLyrics(lines, hint) {
  const source = normalizeText(hint)
  const text = normalizeText((lines || []).map((line) => line.text).join(''))
  if (source.length < 4 || text.length === 0) return false
  const size = Math.min(8, source.length)
  for (let index = 0; index + size <= source.length; index += 1) {
    if (text.includes(source.slice(index, index + size))) return true
  }
  return false
}

/**
 * 从完整歌词里挑「关键歌词」：优先副歌（重复次数多的行），其次均匀抽一些中段行。
 * 这些行会在鲸鱼气泡里循环展示，不再做逐句卡拉 OK 对齐，避免 B 站版本与前奏对不上。 */
export function extractKeyLyrics(lines, limit = 10) {
  const entries = (lines || [])
    .map((line) => ({ t: Number(line.t) || 0, text: String(line.text || '').trim() }))
    .filter((line) => line.text.length >= 4 && line.text.length <= 30)
  if (entries.length === 0) return []
  const counts = new Map()
  for (const entry of entries) {
    const key = normalizeText(entry.text)
    if (key.length === 0) continue
    const record = counts.get(key) || { count: 0, first: entry }
    record.count += 1
    counts.set(key, record)
  }
  const repeated = [...counts.values()]
    .filter((record) => record.count >= 2)
    .sort((a, b) => b.count - a.count || a.first.t - b.first.t)
    .map((record) => record.first.text)
  const sampled = []
  const stride = Math.max(1, Math.floor(entries.length / limit))
  for (let index = 0; index < entries.length && sampled.length < limit; index += stride) {
    sampled.push(entries[index].text)
  }
  if (repeated.length > 0) {
    const result = repeated.slice(0, limit)
    if (result.length < 4) {
      for (const text of sampled) {
        if (result.length >= Math.min(6, limit)) break
        if (!result.includes(text)) result.push(text)
      }
    }
    return result
  }
  return sampled
}

/** 歌名模糊比对：用于拒绝模型瞎猜的歌名和搜索接口的无关结果。 */
function songNameMatches(candidates, songName) {
  const target = normalizeText(songName)
  if (target.length === 0) return false
  return candidates.some((candidate) => {
    const name = normalizeText(candidate.name || candidate.title || '')
    return name.length > 0 && (name.includes(target) || target.includes(name))
  })
}

async function cleanupCache(dir) {
  if (dir === null) return
  try {
    const active = new Set()
    for (const entry of streamingAudios.values()) {
      if (!entry.done) active.add(path.basename(entry.file))
    }
    const entries = fs.readdirSync(dir)
      .filter((entry) => /\.(m4s|mp3)$/.test(entry) && !active.has(entry))
      .map((entry) => {
        const full = path.join(dir, entry)
        try {
          return { full, mtime: fs.statSync(full).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(24)) {
      try { fs.unlinkSync(entry.full) } catch {}
    }
  } catch {}
}

/**
 * 完整解析一首歌：确认歌名 → 在 B 站找 DJ/原版 → 找歌词 → 准备音频。
 * 所有网络访问都在宿主进程内完成，浏览器只拿到同源的状态与音频路由。 */
export async function resolveTrack(input, options = {}) {
  const lyricsHint = String(input?.lyrics || '').trim().slice(0, 400)
  const directBvid = normalizeBvid(input?.bvid || input?.bilibiliUrl)
  let songName = String(input?.songName || '').trim().slice(0, 80)
  if (lyricsHint.length === 0 && songName.length === 0) throw new Error('想听哪首歌？发一句歌词或歌名')
  if (songName.length === 0 && GENERIC_DANCE_REQUEST.test(normalizeText(lyricsHint))) {
    throw new Error('想听哪首歌？给我一句歌词或歌名，例如「哦耶耶，桃花谢了有玫瑰」')
  }

  let neteaseSongs = []
  let matched = null
  let verifiedLines = null
  if (songName.length === 0) {
    const hasTitleIntent = TITLE_INTENT.test(lyricsHint)
    const searchHint = hasTitleIntent ? cleanTitleQuery(lyricsHint) : lyricsHint
    if (searchHint.length < 2) throw new Error('想听哪首歌？给我一句歌词或歌名')
    neteaseSongs = await searchNetease(searchHint, options)
    if (neteaseSongs.length === 0) throw new Error('没有找到这首歌（歌词搜索无结果）')

    // 先看输入本身是不是歌名（例如「来首朋友的酒」「《朋友的酒》」），是就直接采用，别拿歌名去歌词里找。
    const hintNormalized = normalizeText(searchHint)
    const hintLength = hintNormalized.length
    const titleCandidate = neteaseSongs.find((candidate) => {
      const name = normalizeText(candidate.name)
      if (name.length < 3) return false
      if (hintLength <= 8 && name === hintNormalized) return true
      return hasTitleIntent && hintLength <= 24 && hintNormalized.includes(name)
    })
    if (titleCandidate) {
      matched = titleCandidate
      songName = titleCandidate.name
    } else {
      for (const candidate of neteaseSongs.slice(0, 4)) {
        let candidateLines = []
        try { candidateLines = await fetchNeteaseLyrics(candidate.id, options) } catch {}
        if (candidateLines.length > 0 && hintMatchesLyrics(candidateLines, lyricsHint)) {
          matched = candidate
          verifiedLines = candidateLines
          songName = candidate.name
          break
        }
      }
    }
    if (matched === null) throw new Error('没有找到与这段歌词匹配的歌曲')
  }
  if (songName.length === 0) throw new Error('没有找到这首歌')

  // 网易云补充候选（也用于判断是否有 DJ 版本、以及取歌词/兜底音频）。
  try {
    if (neteaseSongs.length === 0) neteaseSongs = await searchNetease(songName, options)
  } catch {}
  const djNetease = chooseNeteaseTrack(neteaseSongs, songName, true)
  const plainNetease = chooseNeteaseTrack(neteaseSongs, songName, false)

  let djVideos = []
  let plainVideos = []
  if (!directBvid) {
    try { djVideos = await searchBilibili(`${songName} DJ`, options) } catch {}
    try { plainVideos = await searchBilibili(songName, options) } catch {}
  }
  const requestedVersion = input?.version === 'original'
    ? 'original'
    : input?.version === 'dj'
      ? 'dj'
      : 'auto'
  let video = null
  let hasDj = false
  if (directBvid) {
    // 大肥鱼自己搜到并指定的 BV：直接下载这个视频的音频，不再让工具改选。
    video = await fetchBilibiliView(directBvid, options)
    hasDj = isDjBilibiliVideo(video)
  } else if (requestedVersion === 'original') {
    video = rankBilibiliByPlay([...plainVideos, ...djVideos], songName, { excludeDj: true, excludeCover: true, excludeHonk: true })
    hasDj = false
  } else if (requestedVersion === 'dj') {
    const djPool = [...djVideos, ...plainVideos].filter((candidate) => isDjBilibiliVideo(candidate))
    video = rankBilibiliByPlay(djPool, songName, { excludeCover: true, excludeHonk: true })
      || rankBilibiliByPlay([...djVideos, ...plainVideos], songName, { excludeDj: true, excludeCover: true, excludeHonk: true })
    hasDj = isDjBilibiliVideo(video)
  } else {
    // auto：标题匹配的前提下，播放量最高的就是最可能想听的版本；排除明确翻唱/HONK。
    video = rankBilibiliByPlay([...djVideos, ...plainVideos], songName, { excludeCover: true, excludeHonk: true })
    hasDj = isDjBilibiliVideo(video)
  }
  const song = matched || chooseNeteaseTrack(neteaseSongs, songName, hasDj) || { id: 0, name: songName, artists: [], durationSec: 0 }
  const videoHaystack = video ? `${video.title} ${video.description || ''} ${video.tag || ''}` : ''
  const videoMatchesName = video
    ? normalizeText(videoHaystack).includes(normalizeText(songName))
    : false
  if (!directBvid && !songNameMatches(neteaseSongs, songName) && !videoMatchesName) {
    throw new Error('没有找到这首歌')
  }

  // 歌词：优先与版本一致的网易云曲目，其次另一版本，最后 B 站字幕。
  let lines = verifiedLines || []
  if (lines.length < 4) {
    const lyricTracks = []
    if (hasDj && djNetease) lyricTracks.push(djNetease)
    lyricTracks.push(plainNetease, djNetease)
    if (song.id > 0) lyricTracks.push(song)
    const seenIds = new Set()
    for (const track of lyricTracks) {
      if (!track || track.id <= 0 || seenIds.has(track.id)) continue
      seenIds.add(track.id)
      try {
        lines = await fetchNeteaseLyrics(track.id, options)
      } catch {}
      if (lines.length >= 4) break
    }
  }

  let cid = 0
  let durationSec = video?.durationSec || song.durationSec || 0
  let audioPath = null
  let audioType = null
  let audioSource = 'none'
  let streaming = false

  if (video) {
    try {
      const streamed = await streamBilibiliAudio(video.bvid, options)
      cid = streamed.cid
      durationSec = durationSec || streamed.durationSec
      audioPath = streamed.file
      audioType = streamed.contentType
      audioSource = 'bilibili'
      streaming = !streamed.entry.done
    } catch (error) {
      if (directBvid) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`这个 B 站视频的音频取不到（${reason}），请换一个候。BV`)
      }
    }
  }

  if (lines.length < 4 && video && cid > 0) {
    try {
      const subtitleLines = await fetchBilibiliSubtitleLyrics(video.bvid, cid, options)
      if (subtitleLines.length >= 4) lines = subtitleLines
    } catch {}
  }

  if (audioPath === null && audioSource === 'none') {
    const fallbackTrack = hasDj ? (djNetease || plainNetease || song) : (plainNetease || song)
    if (fallbackTrack && fallbackTrack.id > 0) {
      try {
        const downloaded = await downloadNeteaseAudio(fallbackTrack.id, options)
        if (downloaded.file) {
          audioPath = downloaded.file
          audioType = downloaded.contentType
          audioSource = 'netease'
          durationSec = durationSec || fallbackTrack.durationSec
        }
      } catch {}
    }
  }

  const fallbackTrack = hasDj ? (djNetease || plainNetease || song) : (plainNetease || song)
  return {
    found: true,
    song: songName,
    artist: song.artists.join(' / '),
    dj: hasDj,
    bilibiliUrl: video ? `https://www.bilibili.com/video/${video.bvid}` : null,
    bilibiliBvid: video?.bvid || null,
    bilibiliTitle: video?.title || null,
    bilibiliDurationSec: video?.durationSec || 0,
    lyrics: lines,
    keyLyrics: extractKeyLyrics(lines),
    lyricLineCount: lines.length,
    audioPath,
    audioType,
    audioSource,
    streamingBvid: streaming ? video?.bvid || null : null,
    durationSec,
    fallbackId: fallbackTrack && fallbackTrack.id > 0 ? fallbackTrack.id : 0,
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function connectionFence(ctx, req, res) {
  try {
    const connection = ctx.get?.('connection')
    const rejection = connection?.requestRejection?.(req)
    if (rejection !== undefined && rejection !== null && rejection !== false) {
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      res.end()
      return true
    }
  } catch {
    res.statusCode = 403
    res.end()
    return true
  }
  return false
}

function serveAudio(req, res, audioPath, audioType) {
  let stat
  try {
    stat = fs.statSync(audioPath)
  } catch {
    res.statusCode = 404
    res.end('no audio')
    return
  }
  const size = stat.size
  const type = audioType || 'audio/mp4'
  const rangeHeader = String(req.headers.range || '')
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  let start = 0
  let end = size - 1
  let status = 200
  if (match) {
    const startRaw = match[1]
    const endRaw = match[2]
    if (startRaw === '' && endRaw !== '') {
      const suffix = Number(endRaw)
      start = Math.max(0, size - suffix)
    } else {
      start = startRaw === '' ? 0 : Number(startRaw)
      if (endRaw !== '') end = Number(endRaw)
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${size}`)
      res.end()
      return
    }
    end = Math.min(end, size - 1)
    status = 206
  }
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(end - start + 1))
  if (status === 206) res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(audioPath, { start, end })
  stream.on('error', () => {
    try { res.destroy() } catch {}
  })
  res.on('close', () => {
    try { stream.destroy() } catch {}
  })
  stream.pipe(res)
}

/** 读取仍在增长的文件：边下边发，Range 请求也照常支持。 */
function serveGrowingAudio(req, res, entry) {
  const type = entry.type || 'audio/mp4'
  // total 来自 B 站 content-length，已知时才能给出准确的 content-range。
  const size = Number(entry.total) > 0 ? Number(entry.total) : 0
  const rangeHeader = String(req.headers.range || '')
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  let start = 0
  let end = size > 0 ? size - 1 : -1
  let status = 200
  if (match && size > 0) {
    const startRaw = match[1]
    const endRaw = match[2]
    if (startRaw === '' && endRaw !== '') {
      start = Math.max(0, size - Number(endRaw))
    } else {
      start = startRaw === '' ? 0 : Number(startRaw)
      if (endRaw !== '') end = Number(endRaw)
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${size}`)
      res.end()
      return
    }
    end = Math.min(end, size - 1)
    status = 206
  }
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'no-store')
  if (size > 0) {
    res.setHeader('content-length', String(end - start + 1))
    if (status === 206) res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
  }
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  let closed = false
  let cursor = start
  res.on('close', () => { closed = true })

  ;(async () => {
    let handle = null
    try {
      handle = await fs.promises.open(entry.file, 'r')
      for (;;) {
        if (closed) return
        const available = (size > 0 ? Math.min(end, size - 1) : Number.MAX_SAFE_INTEGER) - cursor + 1
        if (available <= 0) break
        const want = Math.min(64 * 1024, available)
        const buffer = Buffer.alloc(want)
        const { bytesRead } = await handle.read(buffer, 0, want, cursor)
        if (bytesRead > 0) {
          cursor += bytesRead
          if (!res.write(buffer.subarray(0, bytesRead))) {
            await new Promise((resolve) => res.once('drain', resolve))
          }
          continue
        }
        // 文件暂时读完：等后台下载继续写入。
        if (entry.done) break
        if (size > 0) {
          const remaining = Math.min(end, size - 1) - cursor + 1
          // 请求的是完整文件或超过已下载的尾部：等待增长；请求区间已给完则结束。
          if (remaining <= 0) break
        }
        await waitForGrowth(entry, 250)
      }
    } catch {
      try { res.destroy() } catch {}
    } finally {
      try { if (handle) await handle.close() } catch {}
      try { if (!closed) res.end() } catch {}
    }
  })()
}

async function ensureFallbackAudio() {
  const dance = currentDance
  if (dance.status !== 'playing' || !(dance.fallbackId > 0)) return null
  try {
    if (dance.fallbackAudioPath && fs.existsSync(dance.fallbackAudioPath)) {
      return { file: dance.fallbackAudioPath, type: 'audio/mpeg' }
    }
    const downloaded = await downloadNeteaseAudio(dance.fallbackId)
    if (!downloaded.file) return null
    dance.fallbackAudioPath = downloaded.file
    return { file: downloaded.file, type: downloaded.contentType || 'audio/mpeg' }
  } catch {
    return null
  }
}

function stopStreamingAudios(exceptBvid) {
  for (const [bvid, entry] of streamingAudios) {
    if (bvid === exceptBvid) continue
    if (!entry.done) {
      try { entry.controller.abort() } catch {}
    }
    streamingAudios.delete(bvid)
  }
}

function registerDanceRoutes(ctx) {
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-dance/state.json',
    handler: (req, res) => {
      if (connectionFence(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      lastClientSeenAt = Date.now()
      const reportedVersion = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('cv')) || 0
      lastClientVersion = Math.max(lastClientVersion, reportedVersion)
      const dance = currentDance
      if (
        dance.status === 'playing'
        && Number.isFinite(dance.startedAt)
        && Date.now() - dance.startedAt > Math.max(240, (Number(dance.durationSec) || 0) + 120) * 1000
      ) {
        bumpDance({ status: 'idle' })
      }
      sendJson(res, 200, { ok: true, ...danceForClient(currentDance) })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-dance/audio',
    handler: async (req, res) => {
      if (connectionFence(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end()
        return
      }
      const fallback = new URL(req.url || '/', 'http://localhost').searchParams.get('fallback') === '1'
      if (fallback) {
        const ensured = await ensureFallbackAudio()
        if (!ensured) {
          res.statusCode = 404
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('no fallback audio')
          return
        }
        serveAudio(req, res, ensured.file, ensured.type)
        return
      }
      const dance = currentDance
      if (dance.status !== 'playing' || !dance.audioPath) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('no audio')
        return
      }
      const streamEntry = dance.streamingBvid ? streamingAudios.get(dance.streamingBvid) : null
      if (streamEntry && !streamEntry.done && !streamEntry.error) {
        serveGrowingAudio(req, res, streamEntry)
        return
      }
      serveAudio(req, res, dance.audioPath, dance.audioType)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-dance/stop',
    handler: (req, res) => {
      if (connectionFence(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      if (currentDance.status === 'playing') {
        if (currentDance.streamingBvid) stopStreamingAudios(currentDance.streamingBvid)
        bumpDance({ status: 'idle' })
      }
      sendJson(res, 200, { ok: true })
    },
  }))

  return disposers
}

// ---------------------------------------------------------------------------
// 工具与提示词
// ---------------------------------------------------------------------------

function toolResultSummary(track, uiConnected = true) {
  const parts = [
    `已找到《${track.song}》${track.artist ? ` — ${track.artist}` : ''}`,
    track.dj ? '版本：B 站 DJ 版' : '版本：原版',
  ]
  if (track.bilibiliUrl) parts.push(`B 站：${track.bilibiliUrl}`)
  parts.push(`歌词行数：${track.lyricLineCount}`)
  if (track.audioSource === 'none') parts.push('音频：没有取到可播放音频，已用合成节拍代替')
  else parts.push(`音频来源：${track.audioSource === 'bilibili' ? 'B 站' : '网易云兜底'}`)
  parts.push(uiConnected
    ? '已开始播放；如果没装小鲸鱼挂件，只会播放音乐和灯光。按 ESC 或点右上角的「结束」停止，右上角还能调音量（会记住）。'
    : '当前没有检测到打开的 DSH 界面，动画不会显示；请在界面里打开本插件后再试。')
  return parts.join('\n')
}

function formatPlayCount(value) {
  const count = Number(value) || 0
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

function formatDurationSec(value) {
  const total = Math.max(0, Math.round(Number(value) || 0))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function createSearchTool() {
  return {
    name: 'whale_dance_search',
    description:
      '按歌名在 B 站搜索候选版本，返回按播放量从高到低排序的 BV 号、标题、UP 主、播放量、时长，以及 DJ/翻唱/纯音乐/HONK/混编等标记。' +
      '只搜索、不播放；大肥鱼看完列表后自己选一个，把它的 bvid 传给 whale_dance 播放。可以用 keywords 补充用户提到的器乐/角色/版本关键词。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        song_name: {
          type: 'string',
          description: '已确认的歌名，例如「雨爱」「朋友的酒」。',
        },
        keywords: {
          type: 'string',
          description: '可选的补充关键词，例如「琵琶」「司凤」「1.2x」「纯音乐」；会拼在歌名后面搜索。',
        },
        limit: {
          type: 'integer',
          description: '返回候选数量，默认 12，最多 20。',
        },
      },
      required: ['song_name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          song: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bvid: { type: 'string' },
                title: { type: 'string' },
                author: { type: 'string' },
                play: { type: 'integer' },
                durationSec: { type: 'integer' },
                dj: { type: 'boolean' },
                cover: { type: 'boolean' },
                honk: { type: 'boolean' },
                instrumental: { type: 'boolean' },
                remix: { type: 'boolean' },
                url: { type: 'string' },
              },
              required: ['bvid', 'title', 'author', 'play', 'durationSec', 'dj', 'cover', 'honk', 'instrumental', 'remix', 'url'],
            },
          },
          message: { type: 'string' },
        },
        required: ['found', 'song', 'candidates', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.message || '') }],
    },
    timeoutMs: 90000,
    async execute(args) {
      const songName = typeof args?.song_name === 'string' ? args.song_name.trim() : ''
      const keywords = typeof args?.keywords === 'string' ? args.keywords.trim() : ''
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 12))
      if (songName.length === 0) {
        return { found: false, song: '', candidates: [], message: '请先把歌名发给工具，例如「雨爱」。' }
      }
      const base = [songName, keywords].filter(Boolean).join(' ')
      const queries = [base]
      if (!/dj|remix/i.test(base)) queries.push(`${base} DJ`)
      const videos = new Map()
      for (const query of queries) {
        try {
          const result = await searchBilibili(query)
          for (const video of result) videos.set(video.bvid, video)
        } catch {}
      }
      const sorted = [...videos.values()].sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0)).slice(0, limit)
      const candidates = sorted.map((video) => {
        const haystack = `${video.title} ${video.author} ${video.description} ${video.tag}`
        return {
          bvid: video.bvid,
          title: video.title,
          author: video.author || '',
          play: Number(video.play) || 0,
          durationSec: Number(video.durationSec) || 0,
          dj: DJ_WORD.test(haystack),
          cover: /翻唱|翻自|cover|女声版|男声版|合唱版|翻版/i.test(haystack),
          honk: /honk|鬼畜|恶搞|整活|搞笑|抽象|沙雕/i.test(haystack),
          instrumental: /纯音乐|伴奏|instrumental|钢琴|琵琶|古筝|二胡|笛子|箫|吉他|小提琴|器乐|演奏|古琴|唢呐/i.test(haystack),
          remix: /混编|mix|串烧|合集|二创|剪辑|改编|remix|女声|男声/i.test(haystack),
          url: `https://www.bilibili.com/video/${video.bvid}`,
        }
      })
      if (candidates.length === 0) {
        return {
          found: false,
          song: songName,
          candidates: [],
          message: `没有搜到。{base}」的 B 站候选。可以换一种关键词（例如加「原版」「琵琶」「纯音乐」）再搜，或用你自己搜到。BV 直接调用 whale_dance。`,
        }
      }
      const lines = [`。{songName}」按播放量排序的候选（${candidates.length} 个）：`]
      candidates.forEach((candidate, index) => {
        const tags = []
        if (candidate.dj) tags.push('DJ')
        if (candidate.cover) tags.push('翻唱')
        if (candidate.instrumental) tags.push('纯音。器乐')
        if (candidate.remix) tags.push('混编/剪辑')
        if (candidate.honk) tags.push('HONK/恶搞')
        lines.push(
          `${index + 1}. ${candidate.bvid} | ${formatPlayCount(candidate.play)}播放 | ${formatDurationSec(candidate.durationSec)}` +
          `${tags.length > 0 ? ` | ${tags.join('/')}` : ''} | ${candidate.title} | UP:${candidate.author}`,
        )
      })
      const eligible = candidates.filter((candidate) => !candidate.cover && !candidate.honk && !candidate.remix
        && (candidate.durationSec === 0 || candidate.durationSec <= 900))
      const topDj = eligible.find((candidate) => candidate.dj)
      const topPlain = eligible.find((candidate) => !candidate.dj)
      if (topDj && topPlain) {
        lines.push(
          `参考（已排除翻。HONK/混编/超长）：DJ 最。${topDj.bvid}。{formatPlayCount(topDj.play)}播放）；` +
          `。DJ 最。${topPlain.bvid}。{formatPlayCount(topPlain.play)}播放）。没有点名特定版本时，DJ 和非 DJ 哪个播放量高就选哪个。`,
        )
      }
      lines.push('看完后按用户想听的内容选一个，把 bvid 传给 whale_dance；不要选无关的翻唱/HONK/混编，也不要在这一步播放。')
      return {
        found: true,
        song: songName,
        candidates,
        message: lines.join('\n'),
      }
    },
  }
}

function createDanceTool() {
  return {
    name: 'whale_dance',
    description:
      '播放用户选定的 B 站版本：通常先用 `whale_dance_search` 拿到按播放量排序的候选，选好后把候选的 `bvid` 传进来，工具会直接下载这个视频的音频并让小鲸鱼开始蹦迪。' +
      '也可以不传 `bvid`，此时按歌名/歌词自动选一个高播放量的匹配版本（兼容旧用法）。至少提供 `bvid`，或 `lyrics`/`song_name` 之一。调用成功后用一两句话回复歌名、版本和 B 站链接；用户按 ESC 结束。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lyrics: {
          type: 'string',
          description: '用户在聊天里输入的歌词片段/歌曲开头原文，例如「哦耶耶，桃花谢了有玫瑰」。不要改写；如果用户只给了歌名，可以填歌名本身。',
        },
        song_name: {
          type: 'string',
          description: '已确认的歌名（例如「朋友的酒」）；配合 bvid 时也建议填，用于匹配歌词。',
        },
        bvid: {
          type: 'string',
          description: '从 whale_dance_search 候选里选中的 BV 号，例如 BV1KR4y1k7rA；也接受完整的 B 站视频链接。传了就严格播放这个视频，不再自动改选。',
        },
        version: {
          type: 'string',
          enum: ['auto', 'dj', 'original'],
          description: '仅在未传 bvid、走自动选片时使用；传了 bvid 会被忽略。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          song: { type: 'string' },
          artist: { type: 'string' },
          dj: { type: 'boolean' },
          bilibiliUrl: { type: 'string' },
          bilibiliTitle: { type: 'string' },
          lyricLineCount: { type: 'integer' },
          audioSource: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['found', 'song', 'artist', 'dj', 'bilibiliUrl', 'bilibiliTitle', 'lyricLineCount', 'audioSource', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.message || '') }],
    },
    timeoutMs: 180000,
    async execute(args) {
      const lyrics = typeof args?.lyrics === 'string' ? args.lyrics : ''
      const songName = typeof args?.song_name === 'string' ? args.song_name : ''
      const bvid = typeof args?.bvid === 'string' ? args.bvid : ''
      const version = args?.version === 'dj' || args?.version === 'original' ? args.version : 'auto'
      const queryText = lyrics.trim() || songName.trim() || bvid.trim()
      const uiConnected = Date.now() - lastClientSeenAt < 15000
      if (uiConnected && lastClientVersion < 20) {
        return {
          found: false,
          song: songName || queryText,
          artist: '',
          dj: false,
          bilibiliUrl: '',
          bilibiliTitle: '',
          lyricLineCount: 0,
          audioSource: 'none',
          message: '插件界面还是旧版本，请先按 Ctrl+F5 刷新页面，然后再发一次歌名或歌词。',
        }
      }
      try {
        const track = await resolveTrack({ lyrics, songName, version, bvid })
        // 换歌时中断上一首仍在下载的流式音频，避免后台继续占用带宽。
        if (track.streamingBvid) stopStreamingAudios(track.streamingBvid)
        // 没有取到音频也开跳：浏览器端会用合成节拍兜底。
        bumpDance({
          status: 'playing',
          id: randomUUID(),
          song: track.song,
          artist: track.artist,
          dj: track.dj,
          lines: track.lyrics,
          keyLyrics: track.keyLyrics,
          audioPath: track.audioPath,
          audioType: track.audioType,
          audioSource: track.audioSource,
          streamingBvid: track.streamingBvid,
          fallbackId: track.fallbackId,
          fallbackAudioPath: null,
          bilibiliUrl: track.bilibiliUrl,
          bilibiliTitle: track.bilibiliTitle,
          durationSec: track.durationSec,
          startedAt: Date.now(),
        })
        cleanupCache(cacheRoot())
        const uiConnected = Date.now() - lastClientSeenAt < 15000
        const message = toolResultSummary(track, uiConnected)
        return {
          found: true,
          song: track.song,
          artist: track.artist,
          dj: track.dj,
          bilibiliUrl: track.bilibiliUrl || '',
          bilibiliTitle: track.bilibiliTitle || '',
          lyricLineCount: track.lyricLineCount,
          audioSource: track.audioSource,
          message,
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          found: false,
          song: songName || queryText,
          artist: '',
          dj: false,
          bilibiliUrl: '',
          bilibiliTitle: '',
          lyricLineCount: 0,
          audioSource: 'none',
          message: `没有开始蹦迪：${reason}。请如实告诉用户没找到这首歌，不要假装已经播放。`,
        }
      }
    },
  }
}

const PROMPT_TEXT = [
  '## 小鲸鱼一键蹦迪',
  '当用户发来的消息本身像歌词/歌曲开头（例如「哦耶耶，桃花谢了有玫瑰」「你是我的小呀小苹果」），或者明确要求「来首歌 / 蹦一个 / 跳起来」时，按下面的三步流程走。',
  '',
  '### 必须按顺序',
  '1. **先由你自己确认歌名**：用你的搜索能力根据歌词/描述确认歌名；用户已经给出歌名就不用再搜。',
  '2. **再调用 `whale_dance_search`**：把歌名放进 `song_name`；用户提到器乐、角色、版本线索（如「琵琶」「司凤」「1.2x」「纯音乐」）放进 `keywords`。这个工具只搜索、不播放，会返回按 B 站播放量从高到低排的候选：BV、标题、UP 主、播放量、时长，以及 DJ/翻唱/纯音乐/混编/HONK 标记。',
  '3. **你从候选里选一个**，把它的 `bvid` 传给 `whale_dance`（同时带 `song_name` 和原始 `lyrics`）开始播放。不要跳过第 2 步直接让 `whale_dance` 自动选；只有搜索工具完全不可用时才用它的无 bvid 兼容模式。',
  '4. 如果你已经通过自己的搜索拿到了更准确的 BV（例如官方 Hi-Res 完整版、用户点名的器乐/角色版），可以直接把这个 `bvid` 传给 `whale_dance`；不要用无关的高播放视频替代用户点名的版本。',
  '',
  '### 怎么选（按优先级，冲突时从上到下）',
  '1. **用户明确指令最高**：明确说「不要 DJ / 要原版」就排除 DJ 候选；明确说「要 DJ 版」就优先 DJ；明确点名某个 BV/UP 主/版本就按点名来。',
  '2. **再锁定内容/角色/器乐/版本线索**（例如「琵琶」「司凤」「1.2x」「纯音乐」「Hi-Res」）：只有标题/简介明确包含这些线索的候选才算匹配；没有线索时按歌名匹配。',
  '3. **在锁定范围内比较播放量**：分别取播放量最高的 **DJ 版**和播放量最高的 **非 DJ 版（原版/普通版）**；**DJ 播放量更高就播 DJ，非 DJ 更高就播非 DJ**。没有点名线索时也直接比较这两个头部候选，谁播放量高选谁。不要默认 DJ，也不要默认官方原曲。',
  '4. 播放量接近或相同时，再看标题是否最贴合、时长是否正常，并排除无关翻唱、无关混编/串烧、HONK/鬼畜/恶搞和超长合集。',
  '- 这里说的「原版」不是必须选官方原唱，而是**用户所指内容的那个对应演绎**。翻唱/混编标记只用来排除**无关**的翻唱/二创，不排除用户点名内容的对应版本。',
  '- 器乐/角色/剧情对应的版本就是该内容的「原版」：例如用户要**琵琶曲**，就锁定琵琶演奏版，再在琵琶版里比较 DJ/非 DJ 播放量（哪怕标题带 **1.2x/DJ**），不要选原版流行歌或无关翻唱。',
  '- 用户要**《雨爱》**时，按本插件约定优先锁定**「雨爱司凤版」**这个内容：在司凤版候选里选播放量最高的一个（例如 `BV1faak6AEzm` 那类标题），**不要**被播放量更高的官方《雨爱》原曲带走，也不要选其他无关翻唱、HONK/鬼畜或超长合集。',
  '- 候选都不匹配或搜索为空：换关键词再搜，或用你自己的搜索找到准确 BV；不要编造 BV，也不要随便播一个无关视频。找不到就问用户要 BV/更明确的版本名。',
  '',
  '播放成功后用一两句话回复歌名、实际选择的版本和 B 站链接，并说明「按 ESC 结束蹦迪」。如果工具返回 `found: false`，如实说明没找到/音频取不到，不要假装已经播放。工具要求刷新时，请用户按 `Ctrl+F5`。用户说「别跳了 / 停下 / 结束蹦迪」时调用 `whale_dance_stop`。',
  '如果用户只说「来首歌 / 蹦一个」而没给歌名或歌词，先请用户补一句歌词或歌名；普通讨论歌曲、没有要跳舞的意思时不要调用这些工具。',
].join('\n')

function createStopTool() {
  return {
    name: 'whale_dance_stop',
    description: '结束当前的小鲸鱼蹦迪：停止音乐并让挂件回到原位。用户说「别跳了 / 停下 / 结束蹦迪」时调用；用户自己按 ESC 也会结束。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopped: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['stopped', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.message || '') }],
    },
    execute() {
      const wasPlaying = currentDance.status === 'playing'
      if (wasPlaying) bumpDance({ status: 'idle' })
      return Promise.resolve({
        stopped: wasPlaying,
        message: wasPlaying ? '已结束蹦迪，小鲸鱼回到原位。' : '当前没有正在进行的蹦迪。',
      })
    },
  }
}

function registerToolAndPrompt(ctx) {
  const disposers = []
  try {
    disposers.push(ctx.tools.register(createSearchTool()))
    disposers.push(ctx.tools.register(createDanceTool()))
    disposers.push(ctx.tools.register(createStopTool()))
  } catch (error) {
    console.warn(`[dsh-whale-dance] 注册工具失败。{error instanceof Error ? error.message : String(error)}`)
  }
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      disposers.push(systemPrompt.section({
        name: 'whale-dance',
        order: 95,
        text: PROMPT_TEXT,
      }))
    } catch (error) {
      console.warn(`[dsh-whale-dance] 注册提示词失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return disposers
}

// ---------------------------------------------------------------------------

/**
 * Cordis 入口。
 * @param ctx 宿主上下文（tools、webServer、connection、systemPrompt） */
export function apply(ctx) {
  const disposers = []
  disposers.push(...registerDanceRoutes(ctx))
  disposers.push(...registerToolAndPrompt(ctx))
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    bumpDance({ status: 'idle' })
  }, 'dsh-whale-dance: resources')
}

/** 供本地测试使用。 */
export { cacheRoot, danceForClient }
