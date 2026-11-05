/**
 * @name BiliMusic 音源
 * @description 接管取流：用哔哩哔哩的音频/视频轨作为播放源
 * @version 1.4.0
 * @author WorkBuddy
 *
 * 工作方式（重要，别期待它做搜索）：
 *   你在 LX 内置源（酷我/酷狗/QQ/网易/咪咕）里搜索，LX 拿到「歌名 + 歌手」，
 *   播放时调用本脚本的 musicUrl，脚本去 B站搜同名视频，取可直连的地址返回。
 *
 *   LX 自定义源协议的硬边界（app.asar 实测）：
 *     - sources 的 key 只能是 kw/kg/tx/wy/mg/local
 *     - 非 local 源的 actions 只能是 ['musicUrl']，没有 search
 *     - 搜索永远走内置源模块，和本脚本无关
 *   所以本脚本只能做「取流接管」，永远不能把 B站变成一个能搜的歌源。
 *
 * ============================================================
 * v1.4.0：清理调试设施，转为静默运行
 *   - 新增 DEBUG 开关（默认 false）：关闭时不打印任何日志、不弹 DevTools
 *   - 删除启动自检 selfTest（原来每次加载都会搜一次「周杰伦」并发 3 条日志）
 *   - 失败也静默：LX 自己会弹「换源失败」，不需要脚本再喊
 *   排查问题时把 DEBUG 改成 true 即可恢复全部输出。
 * ============================================================
 * v1.3.0 修复（这是「脚本全绿、LX 播放全红」的真正原因）
 *
 * 现象：脚本日志一切正常（验流 HTTP 206），但 LX 一播放就失败。
 *
 * 根因：B站 CDN 有强防盗链，只认 Referer = https://www.bilibili.com/
 *   同一台机器、同一个地址，实测三种请求：
 *       无 Referer                        -> 403 Forbidden
 *       Referer: http://www.kuwo.cn/      -> 403 Forbidden   ← LX 播放时带的是这个
 *       Referer: https://www.kugou.com/   -> 403 Forbidden
 *       Referer: https://www.bilibili.com/-> 206 OK
 *   而 DASH 音频地址（dash.audio[].baseUrl，192kbps 那条）属于「网页端签名」，
 *   必须带 B站 Referer。LX 的自定义源协议只能返回一个 url 字符串，
 *   没法附带请求头，LX 取流时带的是当前音源（酷我/酷狗）的 Referer —— 必然 403。
 *   旧版脚本自己验流时带了 B站 Referer，所以自检永远通过，把问题掩盖了。
 *
 * 解法：改走 B站「移动网页」通道 platform=html5。
 *   该通道返回 durl（一个整合了音视频的 mp4 直链），实测对 Referer 完全不校验：
 *       无 Referer / 酷我 Referer / 酷狗 Referer / 移动UA / 桌面UA -> 全部 206
 *   已用 3 个不同视频（含合集分P）交叉验证。
 *   代价：拿不到 DASH 的 192k 纯音频，音质是整合 mp4 里的 AAC（通常 64kbps）。
 *   若以后要回 192k，唯一出路是在本机跑一个带 Referer 的转发服务，
 *   让脚本返回 http://127.0.0.1:端口/... 再由转发服务去取 B站地址。
 *
 * 其它沿用 v1.2.0 的修复：
 *   - lx.request 会把 JSON 响应提前 parse 成对象，getJSON 必须先认对象。
 *   - inited 的字段名是 openDevTools（不是 openDevMode）。
 *   - qualitys 里不能出现 192k（合法值只有 128k/320k/flac/flac24bit）。
 * ============================================================
 */

;(function () {
const VERSION = '1.4.0'
const L = globalThis.lx

/* 调试开关：false = 静默运行，不弹 DevTools、不打印任何日志。
   排查问题时改成 true，DevTools 会自动弹出并输出每一步细节。 */
const DEBUG = false

/* 日志出口：DEBUG 关闭时全部静默，连 console 都不碰 */
const LOG = (msg) => {
  if (!DEBUG) return
  try {
    console.log('[BiliMusic v' + VERSION + '] ' + msg)
  } catch (e) {}
}
const ERR = (msg) => {
  if (!DEBUG) return
  try {
    console.error('[BiliMusic v' + VERSION + '] ' + msg)
  } catch (e) {}
}

LOG('脚本开始执行')

if (!L || !L.EVENT_NAMES || !L.send || !L.on || !L.request) {
  LOG('宿主 lx 不完整，脚本无法工作')
  return
}

const { EVENT_NAMES, request, on, send } = L
LOG('宿主就绪：lx.version=' + L.version + '，env=' + L.env)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const TIMEOUT = 15000

/* ---------------------------------------------------------------- 基础请求 */

let cookie = ''
let cookiePromise = null

const httpRaw = (url, opts) =>
  new Promise((resolve, reject) => {
    request(
      url,
      {
        method: (opts && opts.method) || 'GET',
        headers: Object.assign({}, (opts && opts.headers) || {}),
        timeout: TIMEOUT,
      },
      (err, resp) => {
        if (err) return reject(err)
        resolve(resp)
      }
    )
  })

/* 调 B站 API：必须带 UA + Referer + 匿名 Cookie，否则搜索会被 412 */
const apiHeaders = (extra) =>
  Object.assign(
    {
      'User-Agent': UA,
      Referer: REFERER,
      Cookie: cookie,
      Accept: '*/*',
    },
    extra || {}
  )

/* 取 CDN 资源：只带 UA。
   ⚠️ 这是刻意的：要复现 LX 播放器真实的请求环境。
   LX 取流时不会带 B站 Referer（带的是当前内置源的 Referer），
   所以这里也绝对不能带 Referer，否则验流会「骗过自己」。 */
const plainHeaders = (extra) =>
  Object.assign({ 'User-Agent': UA, Accept: '*/*' }, extra || {})

/* 桌面版 resp.body 可能已经是对象/字符串/Buffer，统一转成文本 */
const toText = (body) => {
  if (body == null) return ''
  if (typeof body === 'string') return body
  try {
    const bufUtil = L.utils && L.utils.buffer
    if (bufUtil && bufUtil.bufToString) {
      return bufUtil.bufToString(body, 'utf8')
    }
  } catch (e) {}
  if (body.data && Array.isArray(body.data)) {
    try {
      return decodeURIComponent(escape(String.fromCharCode.apply(null, body.data)))
    } catch (e) {
      return String.fromCharCode.apply(null, body.data)
    }
  }
  return String(body)
}

const isBufferLike = (v) =>
  !!v &&
  typeof v === 'object' &&
  (v.type === 'Buffer' || typeof v.pipe === 'function' || typeof v.readUInt8 === 'function')

/* 关键：LX 2.x 的 lx.request 对 JSON 响应会先 JSON.parse 再放进 resp.body，
   所以这里必须先认「已经是对象」的情况，否则 JSON.parse('[object Object]') 必挂。 */
const getJSON = async (url) => {
  const resp = await httpRaw(url, { headers: apiHeaders() })
  const status = resp && resp.statusCode
  if (status && status >= 400) {
    throw new Error('HTTP ' + status + ' <- ' + String(url).slice(0, 90))
  }
  const body = resp && resp.body
  if (body && typeof body === 'object' && !Array.isArray(body) && !isBufferLike(body)) {
    return body
  }
  const raw = toText(body)
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error('返回的不是 JSON（前 60 字：' + raw.slice(0, 60) + '）')
  }
}

/* 匿名指纹：没有 buvid3，B站搜索会直接回 412 */
const ensureCookie = () => {
  if (cookie) return Promise.resolve()
  if (!cookiePromise) {
    cookiePromise = getJSON('https://api.bilibili.com/x/frontend/finger/spi')
      .then((d) => {
        if (d.code === 0 && d.data) {
          cookie = 'buvid3=' + d.data.b_3 + '; buvid4=' + d.data.b_4
        }
      })
      .catch(() => {
        cookiePromise = null
      })
  }
  return cookiePromise
}

/* ---------------------------------------------------------------- 匹配打分 */

const cleanTitle = (s) => String(s || '').replace(/<[^>]+>/g, '')

/* 只取域名用于日志：不引入新依赖，正则足够 */
const hostOf = (u) => {
  const m = String(u || '').match(/^https?:\/\/([^\/]+)/)
  return m ? m[1] : '?'
}

const parseDuration = (v) => {
  if (typeof v === 'number') return v
  const s = String(v || '')
  if (s.indexOf(':') >= 0) {
    const p = s.split(':').map((x) => parseInt(x, 10) || 0)
    if (p.length === 2) return p[0] * 60 + p[1]
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  }
  const n = parseInt(s, 10)
  return isNaN(n) ? 0 : n
}

const singerText = (musicInfo) => {
  const sg = musicInfo.singer
  if (!sg) return ''
  if (Array.isArray(sg)) return sg.map((x) => (x && x.name) || x || '').join(' ')
  return String(sg)
}

/* 归一化：去掉标点和空白，让 "APT." 能匹配到标题里的 "APT" */
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\s\-_.·・,，、!！?？'"“”‘’()（）\[\]【】]/g, '')

const COLLECTION = /合集|串烧|连播|精选|小时|热歌|歌单|榜单/
const MUSIC_WORD = /歌词|无损|高音质|纯享|完整版|hifi/i

const scoreOf = (item, name, singer, wantDur) => {
  const title = norm(item.title)
  const nName = norm(name)
  let s = 0
  if (nName && title.indexOf(nName) >= 0) s += 50
  if (singer) {
    // 按「、」等分隔符拆，保留 "Bruno Mars" 这种带空格的完整名字
    const parts = singer.split(/[、,，&\/]+/).map((x) => x.trim()).filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const p = norm(parts[i])
      if (p && title.indexOf(p) >= 0) {
        s += 20
        break
      }
    }
  }
  if (COLLECTION.test(item.title)) s -= 15
  if (MUSIC_WORD.test(item.title)) s += 8

  const dur = parseDuration(item.duration)
  if (wantDur) {
    const diff = Math.abs(dur - wantDur)
    if (diff <= 20) s += 30
    else if (diff <= 60) s += 12
    else if (diff > 180) s -= 25
  } else if (dur >= 100 && dur <= 420) {
    s += 15
  }
  return s
}

/* ---------------------------------------------------------------- B 站接口 */

const searchVideo = async (keyword) => {
  await ensureCookie()
  if (!cookie) {
    throw new Error('拿不到 B站匿名指纹（buvid3），搜索会被风控拦')
  }
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' +
    encodeURIComponent(keyword)
  const d = await getJSON(url)
  if (d.code === -412 || d.code === 412) {
    throw new Error(
      '搜索被 B站风控拦截（412）。多半是请求层没带上 Cookie 头，或本机 IP 被限流'
    )
  }
  if (d.code !== 0) throw new Error('搜索失败 code=' + d.code)
  const list = (d.data && d.data.result) || []
  return list
    .filter((it) => it && it.bvid)
    .map((it) => ({
      bvid: it.bvid,
      title: cleanTitle(it.title),
      author: it.author,
      duration: it.duration,
    }))
}

/* 在合集的各个分 P 里找目标曲目，返回下标；找不到返回 -1 */
const pickPageIndex = (pages, name, wantDur) => {
  const n = norm(name)
  if (!n) return -1
  let best = -1
  let bestScore = 0
  pages.forEach((p, i) => {
    const part = norm(p.part)
    let s = 0
    if (part && part.indexOf(n) >= 0) s += 60
    else if (part && n.indexOf(part) >= 0 && part.length >= 2) s += 40
    if (wantDur && p.duration) {
      const d = Math.abs(p.duration - wantDur)
      if (d <= 15) s += 30
      else if (d <= 40) s += 10
    }
    if (s > bestScore) {
      bestScore = s
      best = i
    }
  })
  return bestScore >= 30 ? best : -1
}

/* ---------- 取流核心 ----------

   只用 platform=html5 通道：
     - 返回 durl（音视频整合的 mp4 直链），对 Referer 完全不校验
     - 桌面 UA 也能用，不需要伪装手机
     - 合集分 P 一样有效（已实测）
   曾尝试但不可行的：
     - fnval=4048 的 DASH 音频（192k）→ 必须 B站 Referer，LX 给不了
     - 手动把 os=html5 / platform=html5 改到 DASH 地址上 → 签名失效 403
*/
const QN = 64 // 尽量拿 720p（音频码率随封装走，视频清晰度无所谓）

const playUrlOf = (bvid, cid) =>
  'https://api.bilibili.com/x/player/playurl?bvid=' +
  encodeURIComponent(bvid) +
  '&cid=' +
  cid +
  '&fnval=1&fnver=0&fourk=0&platform=html5&qn=' +
  QN +
  '&high_quality=1'

/* 返回 { urls: [主地址, ...备用], picked, quality, size } 或 null */
const audioUrlOf = async (bvid, name, wantDur) => {
  const v = await getJSON(
    'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)
  )
  if (v.code !== 0) throw new Error('取视频信息失败 code=' + v.code)

  const pages = (v.data && v.data.pages) || []
  let cid = null
  let picked = ''

  /* 兜底：B站 里 12 秒这种超短视频（片段/预告/鬼畜切片）不可能是完整歌曲。
     之前的 bug：时长权重只扣 25 分，歌名对上（+50）就能压过它，
     结果「点播放只响了 12 秒」。这里直接排除，宁可不命中也不放错。 */
  if ((v.data.duration || 0) > 0 && v.data.duration < 40) {
    LOG('跳过超短视频 ' + bvid + '（' + v.data.duration + 's，不可能是完整歌曲）')
    return null
  }

  if (pages.length > 1) {
    // 合集：必须定位到具体那一 P，否则会放成第一首
    const idx = pickPageIndex(pages, name, wantDur)
    if (idx < 0) {
      LOG('跳过合集 ' + bvid + '（' + pages.length + 'P，里面没找到「' + name + '」）')
      return null
    }
    cid = pages[idx].cid
    picked = 'P' + (idx + 1) + ' ' + (pages[idx].part || '')
  } else {
    cid = (pages[0] && pages[0].cid) || v.data.cid
    picked = pages[0] && pages[0].part ? pages[0].part : v.data.title
    // 单个长视频却只要一首短歌，多半是串烧合集，拆不开，跳过
    if (wantDur && wantDur < 600 && v.data.duration > 900) {
      LOG('跳过串烧 ' + bvid + '（单P ' + v.data.duration + 's，拆不开）')
      return null
    }
  }

  const p = await getJSON(playUrlOf(bvid, cid))
  if (p.code !== 0) {
    throw new Error('取播放地址失败 code=' + p.code + '（' + (p.message || '') + '）')
  }
  const durl = (p.data && p.data.durl) || []
  if (!durl.length) {
    throw new Error('没有可直连的播放地址（可能要大会员/充电专属）')
  }
  if (durl.length > 1) {
    LOG('注意：' + bvid + ' 的 durl 有 ' + durl.length + ' 段，只取第 1 段')
  }
  const first = durl[0]
  const urls = [first.url]
    .concat(first.backup_url || first.backupUrl || [])
    .filter(Boolean)

  LOG(
    '命中 ' + bvid + ' → ' + picked + '（qn=' + (p.data.quality || '?') +
      '，' + Math.round((first.size || 0) / 1024 / 1024) + 'MB，' +
      Math.round((p.data.timelength || 0) / 1000) + 's，备用地址 ' +
      (urls.length - 1) + ' 个）'
  )
  return { urls: urls, picked: picked, quality: p.data.quality, size: first.size }
}

/* ---------------------------------------------------------------- 主流程 */

/* 返回地址前自己先验一次流：**以 LX 的身份**验（不带 Referer）。
   这样「解析失败」和「解析成功但播放器取不动」就能分开定位。 */
const verifyAudio = async (url) => {
  const resp = await httpRaw(url, {
    headers: plainHeaders({ Range: 'bytes=0-1023' }),
  })
  const code = resp && resp.statusCode
  if (code === 200 || code === 206) {
    const ct = (resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])) || ''
    LOG('以 LX 身份验流通过：HTTP ' + code + '（' + ct + '）')
    return
  }
  throw new Error('音频地址验流失败 HTTP ' + code + '（LX 也会取不到）')
}

/* B站地址带 deadline 签名，约 2 小时失效，缓存必须带过期时间 */
const CACHE_TTL = 90 * 60 * 1000
const cache = new Map()

const cacheGet = (key) => {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.t > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return hit.url
}

const resolveUrl = async (musicInfo) => {
  const name = musicInfo.name || ''
  const singer = singerText(musicInfo)
  const wantDur = parseDuration(musicInfo.interval)
  if (!name) throw new Error('歌曲名为空，无法去 B站匹配')

  const key = (name + '|' + singer + '|' + wantDur).toLowerCase()
  const cached = cacheGet(key)
  if (cached) {
    LOG('缓存命中：' + name)
    return cached
  }

  const keyword = (name + ' ' + singer).trim()
  const list = await searchVideo(keyword)
  if (!list.length) throw new Error('B站没搜到：' + keyword)

  const scored = list.map((it) => ({ it: it, s: scoreOf(it, name, singer, wantDur) }))
  scored.sort((a, b) => b.s - a.s)
  LOG('搜索「' + keyword + '」→ ' + list.length + ' 条，首位：' + scored[0].it.title)

  // 依次试前几个候选：单篇直接用；合集必须能在分 P 里找到这首歌才算数
  let lastErr = null
  const tried = Math.min(scored.length, 5)
  for (let i = 0; i < tried; i++) {
    try {
      const cand = await audioUrlOf(scored[i].it.bvid, name, wantDur)
      if (!cand) continue
      for (let j = 0; j < cand.urls.length; j++) {
        try {
          await verifyAudio(cand.urls[j])
          cache.set(key, { url: cand.urls[j], t: Date.now() })
          LOG('返回地址成功（第 ' + (i + 1) + ' 个候选，第 ' + (j + 1) + '/' + cand.urls.length + ' 个地址）')
          LOG('  实际地址来自：' + hostOf(cand.urls[j]) + '，长度 ' + cand.urls[j].length)
          return cand.urls[j]
        } catch (e) {
          lastErr = e
          LOG('第 ' + (j + 1) + ' 个地址不可用，换下一个：' + (e && e.message))
        }
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('前 ' + tried + ' 个结果都没匹配到「' + name + '」')
}

/* ---------------------------------------------------------------- 事件注册 */

const handleRequest = ({ action, source, info }) => {
  const mi = (info && info.musicInfo) || {}
  LOG(
    '收到请求 action=' + action + ' source=' + source +
      ' 音质=' + ((info && info.type) || '?') +
      ' 歌曲=「' + (mi.name || '?') + '」歌手=「' + singerText(mi) + '」时长=' + (mi.interval || '?')
  )

  try {
    switch (action) {
      case 'musicUrl':
        return resolveUrl(mi).catch((err) => {
          ERR('取流失败：' + (err && err.message))
          throw err
        })
      case 'pic':
        return Promise.resolve(mi.img || '')
      case 'lyric':
        return Promise.resolve({ lyric: '', tlyric: null, rlyric: null, lxlyric: null })
      default:
        return Promise.reject(new Error('不支持的操作: ' + action))
    }
  } catch (e) {
    ERR('处理请求时抛错：' + (e && e.message))
    return Promise.reject(e)
  }
}

/* 接管全部内置源的取流；每个源用独立对象，避免共享引用在 IPC 序列化时出问题 */
const mkSource = () => ({
  name: 'B站音源',
  type: 'music',
  actions: ['musicUrl'],
  qualitys: ['128k', '320k'],
})

const sources = {
  kw: mkSource(),
  kg: mkSource(),
  tx: mkSource(),
  wy: mkSource(),
  mg: mkSource(),
}

/* 初始化必须包 try/catch：否则任何意外都会让 LX 只显示「初始化失败」四个字，查不出病因。
   ⚠️ inited 必须**同步**发出：LX 在脚本求值结束时就要拿到它，
   放进 await 之后会被判定为初始化超时（踩过一次）。
   ⚠️ 字段名是 openDevTools，不是 openDevMode（LX 只认前者）。 */
try {
  on(EVENT_NAMES.request, handleRequest)
  send(EVENT_NAMES.inited, {
    openDevTools: DEBUG,
    status: true,
    sources: sources,
  })
  LOG('初始化完成，已接管 ' + Object.keys(sources).length + ' 个音源的取流')
} catch (e) {
  const msg = e && e.stack ? e.stack : String(e)
  ERR('初始化失败：' + msg)
  try {
    send(EVENT_NAMES.inited, { openDevTools: DEBUG, status: false, message: msg })
  } catch (e2) {
    ERR('连失败原因都发不出去：' + (e2 && e2.message))
  }
}
})()
