import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseLrc,
  pickBilibiliVideo,
  rankBilibiliByPlay,
  resolveTrack,
  searchBilibili,
  searchNetease,
  hintMatchesLyrics,
  extractKeyLyrics,
} from '../index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// 0. 歌词片段校验：真歌词通过、随便一句话不通过
check('hintMatchesLyrics accepts real lyric',
  hintMatchesLyrics([{ t: 0, text: '哦耶耶 桃花谢了有玫瑰' }], '哦耶耶，桃花谢了有玫瑰'))
check('hintMatchesLyrics rejects random text',
  !hintMatchesLyrics([{ t: 0, text: '以为能够看见阳光' }], '这是一句根本不存在的测试歌词abczzz，不要播放'))
check('extractKeyLyrics prefers repeated chorus lines',
  extractKeyLyrics([
    { t: 0, text: '作词 : 测试' },
    { t: 10, text: '第一句普通歌词' },
    { t: 20, text: '哦耶耶桃花谢了有玫瑰' },
    { t: 30, text: '第二句普通歌词' },
    { t: 40, text: '哦耶耶桃花谢了有玫瑰' },
    { t: 50, text: '哦耶耶桃花谢了有玫瑰' },
  ])[0] === '哦耶耶桃花谢了有玫瑰',
  JSON.stringify(extractKeyLyrics([
    { t: 10, text: '第一句普通歌词' },
    { t: 20, text: '哦耶耶桃花谢了有玫瑰' },
    { t: 30, text: '第二句普通歌词' },
    { t: 40, text: '哦耶耶桃花谢了有玫瑰' },
    { t: 50, text: '哦耶耶桃花谢了有玫瑰' },
  ])))

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dance-test-'))
process.env.DSH_HOME = tmpHome

// 1. LRC parsing
const lrc = parseLrc('[00:00.00]作词 : 测试\n[00:12.30]哦耶耶\n[00:15.20][00:45.20]桃花谢了有玫瑰\n[00:18.00]\n')
check('parseLrc timed lines', lrc.length === 3 && lrc[0].text === '哦耶耶' && lrc[1].t === 15.2 && lrc[2].t === 45.2,
  JSON.stringify(lrc))

// 2. Video picker prefers a normal-length DJ video over a long compilation
const picked = pickBilibiliVideo([
  { bvid: 'BV1', title: '朋友的酒DJ 循环歌单 合集', durationSec: 2574, play: 3_000_000, tag: 'DJ' },
  { bvid: 'BV2', title: '《朋友的酒DJ》空城计的小曲 哦耶桃花谢了有玫瑰', durationSec: 246, play: 380_000, tag: 'DJ' },
], '朋友的酒', { wantDj: true })
check('pickBilibiliVideo chooses short DJ version', picked?.bvid === 'BV2', picked?.title)

// 自动模式按播放量：标题命中的候选里选播放量最高的
const ranked = rankBilibiliByPlay([
  { bvid: 'BVA', title: '朋友的酒 原版', durationSec: 240, play: 1200 },
  { bvid: 'BVB', title: '朋友的酒 DJ 现场', durationSec: 230, play: 880000 },
  { bvid: 'BVC', title: '无关视频', durationSec: 200, play: 990000 },
], '朋友的酒')
check('rankBilibiliByPlay prefers most-viewed matching video', ranked?.bvid === 'BVB', `${ranked?.bvid} / ${ranked?.title}`)

// 3. Network: search the lyric on Netease
const songs = await searchNetease('哦耶耶，桃花谢了有玫瑰')
check('netease lyric search finds a song', songs.length > 0, songs.slice(0, 2).map((s) => `${s.name}/${s.artists.join(',')}`).join(' | '))

// 4. Network: Bilibili DJ search
const videos = await searchBilibili('朋友的酒 DJ')
check('bilibili DJ search returns videos', videos.length > 0, `${videos.length} videos, first=${videos[0]?.title}`)

// 5. Full resolve for the sample lyric
const track = await resolveTrack({ lyrics: '哦耶耶，桃花谢了有玫瑰', songName: '朋友的酒' })
check('resolveTrack found song', track.found && track.song.length > 0, `${track.song} / ${track.artist} / dj=${track.dj}`)
check('resolveTrack has Bilibili URL', typeof track.bilibiliUrl === 'string' && track.bilibiliUrl.includes('bilibili.com'),
  String(track.bilibiliUrl))
check('resolveTrack has lyrics', track.lyricLineCount >= 4, `${track.lyricLineCount} lines, first=${track.lyrics[0]?.text}`)
check('resolveTrack prepared audio', track.audioSource !== 'none' && track.audioType !== null,
  `${track.audioSource} ${track.audioType} ${track.audioPath ? fs.statSync(track.audioPath).size : 0} bytes`)

// 大肥鱼选好 BV 后，工具必须严格播放这个视频
if (track.bilibiliBvid) {
  const direct = await resolveTrack({
    lyrics: '哦耶耶，桃花谢了有玫瑰',
    songName: '朋友的酒',
    bvid: track.bilibiliBvid,
  })
  check('direct BV is played exactly as chosen',
    direct.found && direct.bilibiliBvid === track.bilibiliBvid && direct.audioSource === 'bilibili',
    `${direct.bilibiliBvid} / ${direct.audioSource}`)
}

// 6. 反例：瞎猜的歌名不应被接受
let rejectedNonsenseName = false
try {
  await resolveTrack({ lyrics: '这是一句根本不存在的测试歌词abczzz，不要播放', songName: '不存在的测试歌曲zzz' })
} catch {
  rejectedNonsenseName = true
}
check('rejects nonexistent song name', rejectedNonsenseName)

// 7. 反例：只给一句话、不给歌名，也不应误匹配到别的歌
let rejectedNonsenseLyric = false
try {
  await resolveTrack({ lyrics: '这是一句根本不存在的测试歌词abczzz，不要播放' })
} catch {
  rejectedNonsenseLyric = true
}
check('rejects unmatched lyric-only input', rejectedNonsenseLyric)

// 8. 只给歌词（不给歌名）时能凭歌词真实匹配到歌曲
const inferred = await resolveTrack({ lyrics: '哦耶耶，桃花谢了有玫瑰' })
check('infers song from lyric-only input', inferred.found && inferred.song === '朋友的酒',
  `${inferred.song} / dj=${inferred.dj} / lines=${inferred.lyricLineCount}`)

// 9. 网易云兜底音频可下载（浏览器端 B 站音频失败时会切换到它）
const { downloadNeteaseAudio } = await import('../index.js')
let fallbackAudio = null
try {
  fallbackAudio = await downloadNeteaseAudio(1939837729)
} catch {}
check('netease fallback audio downloads', Boolean(fallbackAudio && fallbackAudio.buffer.length > 100000),
  fallbackAudio ? `${fallbackAudio.contentType} ${fallbackAudio.buffer.length} bytes` : 'failed')

// 10. 只给歌名的输入（「来首朋友的酒」）也能解析
const titleOnly = await resolveTrack({ lyrics: '来首朋友的酒' })
check('resolves title-only request', titleOnly.found && titleOnly.song === '朋友的酒',
  `${titleOnly.song} / dj=${titleOnly.dj}`)

// 10b. 模型可要求原版：不能是 DJ 视频
const original = await resolveTrack({ lyrics: '哦耶耶，桃花谢了有玫瑰', song_name: '朋友的酒', version: 'original' })
check('original version avoids DJ video',
  original.found && original.dj === false
  && !(original.bilibiliTitle && /(dj|remix|电摇|电音|串烧)/i.test(original.bilibiliTitle)),
  `${original.bilibiliTitle || '(no bilibili)'} / audio=${original.audioSource}`)

// 11. 只说「来首歌」时给出明确提示，而不是误匹配
let genericMessage = ''
try {
  await resolveTrack({ lyrics: '来首歌' })
} catch (error) {
  genericMessage = error instanceof Error ? error.message : String(error)
}
check('generic dance request asks for a song', genericMessage.includes('想听哪首歌'), genericMessage)

fs.rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
