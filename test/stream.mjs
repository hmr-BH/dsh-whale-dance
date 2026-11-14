/**
 * 验证「3-4 秒缓冲 + 流式播放」：
 * 1. resolveTrack 传 BV 时应当尽快返回（不等整首下载完）；
 * 2. 返回时音频文件已经有一段可播数据；
 * 3. 音频路由应该边下边发，随文件增长继续输出字节，不会 0 字节收尾。
 *
 * 运行：node test/stream.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dance-stream-'))
process.env.DSH_HOME = tmpHome

const { resolveTrack, streamBilibiliAudio } = await import(pathToFileURL(path.resolve('index.js')).href)

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const BV = process.env.DSH_TEST_BVID || 'BV1hXbN6VEKV'

// 1. 直接流式解析一个明确 BV：应当在远早于整首下载完成时就返回
const startedAt = Date.now()
const track = await resolveTrack({ songName: '朋友的酒', bvid: BV })
const elapsed = Date.now() - startedAt
check('streaming resolve returns a track', track.found === true, `${track.song} / ${track.audioSource} / ${elapsed}ms`)
check('streaming resolve uses bilibili audio', track.audioSource === 'bilibili', String(track.audioSource))

const prebuffered = track.audioPath && fs.existsSync(track.audioPath) ? fs.statSync(track.audioPath).size : 0
check('prebuffer has playable bytes', prebuffered > 32 * 1024, `${prebuffered} bytes after ${elapsed}ms`)

// 2. 预缓冲目标约 4 秒：不应一次就把整首下完（除非歌很短）
if (track.streamingBvid) {
  const entry = (await import(pathToFileURL(path.resolve('index.js')).href)).streamingAudios?.get?.(track.streamingBvid)
  if (entry) {
    check('prebuffer is smaller than full file', entry.written < entry.total || entry.done,
      `${entry.written}/${entry.total} bytes`)
  }
} else {
  console.log('SKIP streaming entry inspection — 本次已整段下载完成')
}

// 3. 文件应当在解析返回后继续增长（后台续传）
if (track.audioPath) {
  const before = fs.statSync(track.audioPath).size
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const after = fs.statSync(track.audioPath).size
  check('audio keeps streaming after resolve', after > before, `${before} -> ${after} bytes`)
}

// 4. 独立验证 streamBilibiliAudio 的预缓冲与后台续传
try {
  const result = await streamBilibiliAudio(BV)
  check('stream api returns a file', typeof result.file === 'string' && fs.existsSync(result.file), result.file)
  const first = fs.statSync(result.file).size
  await result.writePromise
  const finalSize = fs.statSync(result.file).size
  check('stream api finishes downloading', finalSize > first, `${first} -> ${finalSize} bytes`)
  const head = fs.readFileSync(result.file).subarray(4, 8).toString('ascii')
  check('stream api payload is mp4 audio', head === 'ftyp', head)
} catch (error) {
  check('stream api returns a file', false, error instanceof Error ? error.message : String(error))
}

fs.rmSync(tmpHome, { recursive: true, force: true })
const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
