/**
 * 集成冒烟测试：用真实的 Node HTTP 服务转发插件路由，验证
 * 状态 JSON、音频 Range / 流式响应、停止接口、旧客户端刷新提示与工具注册。
 * 会真实联网（B 站/网易云），只用于本机验证。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { apply } from '../index.js'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dance-route-'))
process.env.DSH_HOME = tmpHome

const routes = new Map()
const tools = new Map()
const fakeCtx = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: () => undefined,
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  tools: {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
}

apply(fakeCtx)

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (!handler) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(String(error))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

check('registers whale_dance_search tool', tools.has('whale_dance_search'))
check('registers whale_dance tool', tools.has('whale_dance'))
check('registers whale_dance_stop tool', tools.has('whale_dance_stop'))
check('registers state route', routes.has('/dsh-dance/state.json'))

// 旧版客户端（不带 cv）请求状态后，工具应先要求刷新，而不是启动动画
await fetch(`${base}/dsh-dance/state.json`)
const staleAttempt = await tools.get('whale_dance').execute(
  { lyrics: '哦耶耶，桃花谢了有玫瑰', song_name: '朋友的酒' },
  { signal: new AbortController().signal },
)
check('stale client is asked to refresh', staleAttempt.found === false && staleAttempt.message.includes('刷新'),
  staleAttempt.message)

// 新版客户端（cv=20）轮询后，工具正常启动
const before = await (await fetch(`${base}/dsh-dance/state.json?cv=20`)).json()
check('initial state is idle', before.status === 'idle')

// 触发一次真实解析并开舞
const started = await tools.get('whale_dance').execute(
  { lyrics: '哦耶耶，桃花谢了有玫瑰', song_name: '朋友的酒' },
  { signal: new AbortController().signal },
)
check('tool reports found', started.found === true, `${started.song} / dj=${started.dj} / ${started.audioSource}`)
check('tool reports UI started', started.message.includes('已开始播放') || started.message.includes('没有检测到打开的 DSH 界面'),
  started.message.split('\n')[0])

// 状态路由
const stateResponse = await fetch(`${base}/dsh-dance/state.json?cv=20`)
const state = await stateResponse.json()
check('state route is 200', stateResponse.status === 200)
check('state route reports playing', state.status === 'playing' && state.audioUrl !== null,
  `${state.song} / ${state.audioUrl}`)
check('state carries key lyrics', Array.isArray(state.keyLyrics) && state.keyLyrics.length > 0,
  `${state.keyLyrics?.length || 0} lines`)

// 音频 Range 路由：必须真的有字节且能收尾
const audioResponse = await fetch(`${base}${state.audioUrl}`, { headers: { range: 'bytes=0-4095' } })
const audioBytes = Buffer.from(await audioResponse.arrayBuffer())
check('audio route is 206', audioResponse.status === 206)
check('audio route streams bytes', audioBytes.length === 4096, `${audioBytes.length} bytes`)
check('audio route content type', String(audioResponse.headers.get('content-type')).includes('audio/'), audioResponse.headers.get('content-type'))

// 流式播放：解析返回后音频文件仍在后台增长，完整请求应拿到整首而不是只有预缓冲
const fullAudio = await fetch(`${base}${state.audioUrl}`)
const fullBytes = Buffer.from(await fullAudio.arrayBuffer())
check('audio route streams the whole file', fullBytes.length > 256 * 1024, `${fullBytes.length} bytes`)
check('streamed audio is mp4', fullBytes.subarray(4, 8).toString('ascii') === 'ftyp',
  fullBytes.subarray(4, 8).toString('ascii'))

// 兜底音频路由（网易云 mp3）。网络可能抖动，404 时记为跳过，不算失败。
const fallbackResponse = await fetch(`${base}/dsh-dance/audio?fallback=1`, { headers: { range: 'bytes=0-1023' } })
if (fallbackResponse.status === 206) {
  const fallbackBytes = Buffer.from(await fallbackResponse.arrayBuffer())
  check('fallback audio route is 206', true)
  check('fallback audio streams bytes', fallbackBytes.length === 1024, `${fallbackBytes.length} bytes`)
  check('fallback audio content type', String(fallbackResponse.headers.get('content-type')).includes('audio/mpeg'),
    fallbackResponse.headers.get('content-type'))
} else {
  console.log(`SKIP fallback audio route — HTTP ${fallbackResponse.status}（网络侧网易云外链本次不可用）`)
}

// 停止路由
const stopResponse = await fetch(`${base}/dsh-dance/stop`, { method: 'POST' })
const stop = await stopResponse.json()
check('stop route is 200', stopResponse.status === 200 && stop.ok === true)
const idleResponse = await fetch(`${base}/dsh-dance/state.json?cv=20`)
const idle = await idleResponse.json()
check('state returns idle after stop', idle.status === 'idle')

server.close()
fs.rmSync(tmpHome, { recursive: true, force: true })
const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
