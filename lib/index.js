/**
 * dsh-tokenrhythm-bill host half: a plain Cordis plugin running in the host
 * process. It reads the provider roster from ~/.dsh/settings.yaml
 * (llm-pi-ai.providers, flow and block layouts alike) — or, on DSH 0.1.7+
 * where that document was retired, from the active profile's patch layer
 * (profiles/<name>/cordis.patch.yml, same section under `- id: llm-pi-ai`) —
 * plus API keys from ~/.dsh/.credentials.yaml / environment variables, then
 * answers the browser half's JSON calls over the webServer:
 *
 *   /manifest   provider roster + session status (masked)
 *   /models     proxied GET {baseURL}/v1/models (60s cache, 1 retry on 5xx gw)
 *   /balance    proxied tokenrhythm usage-summary + me (web session cookie)
 *   /model-check POST probe-now for ticked chat models (DSH key, 1-token, TTL cache)
 *   /session    paste/clear the tokenrhythm web cookie (stored host-side only)
 *   /prefs      panel geometry persistence
 *
 * Security boundary: API keys and the session cookie live only in host memory
 * and ~/.dsh/tokenrhythm-bill-state.json (mode 0600); every response to the
 * browser carries masked hints only (e.g. "sk_tr…(49)"), never the secret.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  accountCredsError, findAccount, maskPassword, pickBoundAccount, sanitizeAccountPool, sanitizeSessionPool,
  upsertPoolAccount,
} from './creds.js'
import { fileURLToPath } from 'node:url'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const PKG_VERSION = (() => {
  try { return String(require('../package.json').version || '') } catch { return '' }
})()

// ---- upstreams ----
// 余额只支持基元律动（其控制台在 tokenrhythm.studio）：网页会话 Cookie 才能查
// 余额（API Key 实测 401），模型清单则各提供商都能用各自 Key 查 /v1/models。
const TOKENRHYTHM_BASE = 'https://tokenrhythm.studio'
const MODELS_TTL_MS = 60 * 1000
const UPSTREAM_TIMEOUT_MS = 15 * 1000
const RETRYABLE_STATUS = new Set([502, 503, 504])

/** 定时等待（**一处定义**：退避、抖动、冷却三处的等待都走它，别再各写一份 Promise）。*/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 「用量」页签（0.5.5）----
// 日历固定展示最近 30 天：usage/panel 的 range 只认 7d/30d，30d 是与「月度用量」
// 最贴合的窗口，且汇总/按模型/按客户端都能一次拿到。
const USAGE_DAYS = 30
const USAGE_RANGE = '30d'
// 单页条数：usage/panel 的 pageSize 上限是 100。
const USAGE_DAY_PAGE_SIZE = 100
// 每日模型明细行数上限（tooltip 里要能放下，尾部散着的小模型不进浮层）。
const MODEL_ROWS_PER_DAY = 6
// panel 的 topCostCalls 条数上限：平台本身只给 3 条，多要也拿不到。0.5.5 起界面
// 不再展示单笔花费（30 天日历 + 拆分已能回答「钱花在哪」），这个常量保留是为了
// normalizeUsagePanel 忠实还原平台响应，删了它就要动到已测试的解析契约。
const TOP_COST_CALLS = 3
// 用量数据缓存 TTL：与模型列表同口径 60s。日历要打 30 个按天请求，不能跟着
// 面板 60s 自动刷新空转——由页签打开/手动刷新触发，缓存命中才零请求。
const USAGE_TTL_MS = 60 * 1000

// =====================================================================
// 纯函数（导出供 node:test 单测）：YAML 解析 / 归一化 / 掩码
// =====================================================================

// 去掉 YAML 注释：逐字符扫描，字符串（'…" / "…"）内的 # 不算注释；
// # 只有出现在行首或前一个字符是空白时才开启注释。
/** 临期判定：expAt 距现在不足 margin 秒。解不出 expAt → false（一路用到平台说不过为止） */
export function stepSessionNearExpiry(expAt, margin, now) {
  if (typeof expAt !== 'number' || !Number.isFinite(expAt) || expAt <= 0) return false
  return expAt - now < margin
}

export function stripYamlComments(text) {
  const s = String(text)
  let out = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      out += c
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; out += c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      const nl = s.indexOf('\n', i)
      if (nl === -1) break
      i = nl - 1 // keep the newline itself
      continue
    }
    out += c
  }
  return out
}

// 顶层扫描：跳过字符串内部、按 {} / [] 维护深度，只在**深度 0 且不在引号内**时把字符交给 onTop。
// onTop 返回 true 即「找到了，就地停」（返回该处下标；没找到返回 -1）。
// splitTopLevel 与 indexOfTopLevelColon 原先各抄了一份同样的引号/深度规则——两份只要有一处走神，
// 哪怕只是漏掉单引号，同一个 map 的「切分」与「找冒号」就会各说各话，解析出来的键值悄悄地错。
function scanTopLevel(s, onTop) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') { depth--; continue }
    if (onTop(c, i, depth) === true) return i
  }
  return -1
}

// 按 sep 切分，但只在深度 0（不在 {} / [] 内、不在字符串内）处切。
function splitTopLevel(s, sep) {
  const parts = []
  let start = 0
  scanTopLevel(s, (c, i, depth) => {
    if (c !== sep || depth !== 0) return false
    parts.push(s.slice(start, i))
    start = i + 1
    return false
  })
  parts.push(s.slice(start))
  return parts
}

// 从 from 起找与之配对的右括号，返回 { end, inner }；找不到返回 null。
function matchBracket(text, from, open, close) {
  let depth = 0
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return { end: i, inner: text.slice(from + 1, i) }
    }
  }
  return null
}

function unquote(v) {
  const s = String(v).trim()
  if (s.length >= 2 && ((s[0] === '\'' && s[s.length - 1] === '\'') || (s[0] === '"' && s[s.length - 1] === '"'))) {
    return s.slice(1, -1)
  }
  return s
}

// 解析 flow 标量 / {map} / [array]。只求能用：标量保留字符串（数字由调用方按需转换）。
function parseFlowValue(s) {
  const t = String(s).trim()
  if (t.startsWith('{')) {
    const m = matchBracket(t, 0, '{', '}')
    return m ? parseFlowMap(m.inner) : null
  }
  if (t.startsWith('[')) {
    const m = matchBracket(t, 0, '[', ']')
    return m ? parseFlowArray(m.inner) : null
  }
  return unquote(t)
}

function parseFlowMap(inner) {
  const out = {}
  for (const raw of splitTopLevel(inner, ',')) {
    const entry = raw.trim()
    if (entry === '') continue
    const i = indexOfTopLevelColon(entry)
    if (i === -1) continue
    const key = unquote(entry.slice(0, i))
    if (key === '') continue
    out[key] = parseFlowValue(entry.slice(i + 1))
  }
  return out
}

function parseFlowArray(inner) {
  const out = []
  for (const raw of splitTopLevel(inner, ',')) {
    const t = raw.trim()
    if (t === '') continue
    out.push(parseFlowValue(t))
  }
  return out
}

// 首个深度 0 的 `: `（key 后必须紧跟值，兼容 "key:" 换行写法——此时返回首个冒号）。
function indexOfTopLevelColon(s) {
  return scanTopLevel(s, (c, i, depth) => {
    if (c !== ':' || depth !== 0) return false
    const next = s[i + 1]
    return next === undefined || next === ' ' || next === '\t' || next === '\n'
  })
}

// 把多行文本折成 [{indent, text}]（已去注释、去空行）。tab 按 2 空格折算防呆。
function toLines(text) {
  const lines = []
  for (const raw of String(text).split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, '  ')
    const t = expanded.trim()
    if (t === '') continue
    lines.push({ indent: expanded.length - expanded.trimStart().length, text: t })
  }
  return lines
}

// block 布局解析：从 lines[i]（缩进 indent 的映射）开始解析嵌套 map / list。
// 返回 { value, next }；next 为该块之后的第一行下标。
function parseBlockMap(lines, i, indent) {
  const out = {}
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent < indent) break
    if (ln.indent > indent) { i++; continue } // 容忍意外深缩进：跳过
    const ci = indexOfTopLevelColon(ln.text)
    if (ci === -1) { i++; continue }
    const key = unquote(ln.text.slice(0, ci))
    const rest = ln.text.slice(ci + 1).trim()
    i++
    if (rest === '') {
      // 嵌套块：map 或 list，由下一行是否以 "- " 开头决定。
      if (i < lines.length && lines[i].indent > indent && /^-(\s|$)/.test(lines[i].text)) {
        const lst = parseBlockList(lines, i, lines[i].indent)
        out[key] = lst.value
        i = lst.next
      } else if (i < lines.length && lines[i].indent > indent) {
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out[key] = sub.value
        i = sub.next
      } else {
        out[key] = null
      }
    } else {
      out[key] = parseFlowValue(rest)
    }
  }
  return { value: out, next: i }
}

function parseBlockList(lines, i, indent) {
  const out = []
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent !== indent || !/^-(\s|$)/.test(ln.text)) {
      if (ln.indent < indent || (ln.indent === indent && !/^-(\s|$)/.test(ln.text))) break
      i++
      continue
    }
    let item = ln.text.replace(/^-\s*/, '')
    i++
    if (item === '') {
      // "- " 后换行的块项（"- id: x" 不属于这种）。
      if (i < lines.length && lines[i].indent > indent) {
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out.push(sub.value)
        i = sub.next
      } else {
        out.push(null)
      }
    } else if (item.startsWith('{') || item.startsWith('[')) {
      out.push(parseFlowValue(item))
    } else {
      // "- id: x" 形式：首键在 item 里，后续键在更深缩进的行里。
      const ci = indexOfTopLevelColon(item)
      if (ci >= 0 && i < lines.length && lines[i].indent > ln.indent) {
        const firstKey = unquote(item.slice(0, ci))
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out.push({ [firstKey]: parseFlowValue(item.slice(ci + 1)), ...sub.value })
        i = sub.next
      } else if (ci >= 0) {
        const firstKey = unquote(item.slice(0, ci))
        out.push({ [firstKey]: parseFlowValue(item.slice(ci + 1)) })
      } else {
        out.push(parseFlowValue(item))
      }
    }
  }
  return { value: out, next: i }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asStr = (v) => (v === undefined || v === null ? '' : String(v)).trim()

function normalizeProviderEntry(id, entry) {
  if (!isObj(entry)) return null
  const modelsRaw = entry.models
  const models = (Array.isArray(modelsRaw) ? modelsRaw : [])
    .map((m) => isObj(m)
      ? { id: asStr(m.id || m.name), name: asStr(m.name || m.id), contextWindow: toNum(m.contextWindow ?? m.context_window) }
      : null)
    .filter((m) => m !== null && m.id !== '')
  const baseURL = asStr(entry.baseURL || entry.base_url)
  return {
    id: asStr(id),
    displayName: asStr(entry.displayName || entry.display_name) || asStr(id),
    apiKeyEnv: asStr(entry.apiKeyEnv || entry.api_key_env),
    baseURL,
    models,
    balanceCapable: /tokenrhythm/i.test(baseURL),
  }
}

/**
 * 解析 settings.yaml 的 llm-pi-ai.providers 段。同时支持 flow（带大括号，本机实际
 * 布局）与 block（缩进式）两种写法；models 支持 { id, name, contextWindow } flow 项
 * 与 `- id:` block 项。解析失败/缺段返回空数组，绝不抛错（面板按「无提供商」展示）。
 * 返回 [{id, displayName, apiKeyEnv, baseURL, models, balanceCapable}]。
 */
export function parseSettingsProviders(text) {
  const clean = stripYamlComments(String(text == null ? '' : text).replace(/\t/g, '  '))
  const lines = toLines(clean)
  // 每个保留行在 clean 里的起始偏移（flow 提取需要精确到字符；与 lines 下标对齐）。
  const offsets = []
  {
    let offset = 0
    for (const raw of clean.split('\n')) {
      if (raw.trim() !== '') offsets.push(offset)
      offset += raw.length + 1
    }
  }
  // 找 providers: 键（任意缩进——真实文件在 llm-pi-ai: 之下）。
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^providers\s*:/.test(lines[i].text)) { idx = i; break }
  }
  if (idx === -1) return []
  const rest = lines[idx].text.replace(/^providers\s*:/, '').trim()

  // 判别 flow / block：`providers:` 之后（同行或下一保留行）第一个非空白字符
  // 是 `{` → 外层 flow map；否则按 block 缩进布局解析。
  let valueAt = -1
  if (rest !== '') {
    if (rest.startsWith('{')) valueAt = offsets[idx] + clean.slice(offsets[idx]).indexOf(rest)
  } else if (idx + 1 < lines.length) {
    const start = offsets[idx + 1]
    const tail = clean.slice(start)
    valueAt = start + (tail.length - tail.trimStart().length)
  }
  if (valueAt !== -1 && clean[valueAt] === '{') {
    const m = matchBracket(clean, valueAt, '{', '}')
    if (m === null) return []
    const map = parseFlowMap(m.inner)
    const out = []
    for (const key of Object.keys(map)) {
      const p = normalizeProviderEntry(key, map[key])
      if (p !== null) out.push(p)
    }
    return out
  }

  // block 布局：providers: 换行 + 更深缩进。
  if (idx + 1 < lines.length && lines[idx + 1].indent > lines[idx].indent) {
    const sub = parseBlockMap(lines, idx + 1, lines[idx + 1].indent)
    const out = []
    for (const key of Object.keys(sub.value)) {
      const p = normalizeProviderEntry(key, sub.value[key])
      if (p !== null) out.push(p)
    }
    return out
  }
  return []
}

/**
 * 解析 profile 补丁层（profiles/<name>/cordis.patch.yml）里 llm-pi-ai 条目的 providers 段。
 *
 * 为什么需要它：DSH 0.1.7 起 settings.yaml 被废除——设置服务把 ~/.dsh/settings.yaml
 * 改名成 settings.yaml.imported，各段写进「当前 profile 的补丁层」，此后补丁层才是活存储，
 * 原文件不再重建（重建会造成第二次导入，把 Setup 默认值盖回用户的选择上）。
 * 于是 provider 名册的活来源从 settings.yaml 变成了补丁层；只认旧路径的插件会
 * 把自己配置好的 provider 全数看丢，面板显示「没有基元律动提供商」。
 *
 * 布局差异：settings.yaml 是 `llm-pi-ai:\n  providers:\n    …`；补丁层是顶层 YAML 数组，
 * providers 藏在 `- id: llm-pi-ai` 条目的 `config:` 底下。段内布局（flow / block）
 * 与原来一致，所以把 providers: 块原样重排成一份最小文档、复用 parseSettingsProviders，
 * 不另写一套 YAML 解析。
 *
 * 只认 block 写法的 `- id: llm-pi-ai` 条目首行（设置服务就是这么写的）；flow 写法的
 * 条目行不认，返回 []。找不到条目或没有 providers 段 → []，绝不抛错。
 */
export function parsePatchProviders(text) {
  const clean = stripYamlComments(String(text == null ? '' : text).replace(/\t/g, '  '))
  const lines = toLines(clean)
  for (let i = 0; i < lines.length; i++) {
    // 认 id 不认 name：id 是设置服务写进去的稳定键，name 是包名（历史上有过改名）。
    const m = /^-\s*id:\s*["']?([A-Za-z0-9_@/.-]+)["']?\s*$/.exec(lines[i].text)
    if (m === null || m[1] !== 'llm-pi-ai') continue
    // 条目范围：到下一个同级 `- ` 为止（补丁层顶层是数组，条目之间互为兄弟）。
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^-\s/.test(lines[j].text) && lines[j].indent <= lines[i].indent) { end = j; break }
    }
    for (let j = i; j < end; j++) {
      const lm = /^providers\s*:(.*)$/.exec(lines[j].text)
      if (lm === null) continue
      const rest = lm[1].trim()
      // flow：providers: { … } 与键同一行
      if (rest.startsWith('{')) return parseSettingsProviders('providers: ' + rest)
      // block：providers: 换行 + 更深缩进。按各自绝对缩进原样重排——
      // parseSettingsProviders 只比相对缩进，基线无所谓。
      if (j + 1 < end && lines[j + 1].indent > lines[j].indent) {
        const body = lines.slice(j + 1, end).map((l) => ' '.repeat(l.indent) + l.text).join('\n')
        return parseSettingsProviders('providers:\n' + body)
      }
      return []
    }
    return []
  }
  return []
}

/**
 * 从 .credentials.yaml 文本里取 envName 对应的键值。行级正则优先（兼容 refs:
 * 嵌套与旧平铺两种布局），再退化为全文内的键值搜索（单行 flow 布局）。
 * 匹配不到返回 null；绝不抛错。
 */
export function extractCredentialFromText(envName, text) {
  const name = String(envName || '').trim()
  if (name === '' || text == null) return null
  const clean = stripYamlComments(String(text))
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    if (/^\s*#/.test(line)) continue
    const m = new RegExp('^\\s*-?\\s*' + esc + '\\s*:\\s*(.*?)\\s*$').exec(line)
    if (m !== null) {
      const v = unquote(m[1].replace(/,\s*$/, ''))
      if (v !== '') return v
    }
  }
  const flow = new RegExp('[,{\\s]' + esc + '\\s*:\\s*([^\\s,}\\]]+)')
  const fm = flow.exec(clean)
  if (fm !== null) {
    const v = unquote(fm[1])
    if (v !== '') return v
  }
  return null
}

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const toBool = (v) => {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return true
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  return null
}
// 依次尝试候选键，返回第一个可用的数值/布尔。
function pickNum(obj, keys) {
  for (const k of keys) { const n = toNum(obj[k]); if (n !== null) return n }
  return null
}
function pickBool(obj, keys) {
  for (const k of keys) { const b = toBool(obj[k]); if (b !== null) return b }
  return null
}

/**
 * 归一化 /v1/models 返回：容忍 {data:[…]} 信封或裸数组；字段名多候选兼容，
 * 数值解析失败记 null 不抛错。字段见实施文档 §5.1 Model。
 */
export function normalizeModels(json) {
  const list = Array.isArray(json)
    ? json
    : (isObj(json) && Array.isArray(json.data) ? json.data : [])
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id || raw.model || raw.name)
    if (id === '') continue
    const rc = isObj(raw.responses_capabilities) ? raw.responses_capabilities : {}
    const inPrice = pickNum(raw, ['input_price_per_million', 'inputPricePerMillion', 'input_price', 'prompt_price_per_million'])
    const outPrice = pickNum(raw, ['output_price_per_million', 'outputPricePerMillion', 'output_price', 'completion_price_per_million'])
    const cachePrice = pickNum(raw, ['cache_price_per_million', 'cachePricePerMillion', 'cache_read_price_per_million', 'cached_input_price_per_million', 'cache_read_input_price_per_million'])
    const effIn = pickNum(raw, ['effective_input_price_per_million', 'effectiveInputPricePerMillion', 'effective_input_price', 'discount_input_price_per_million'])
    const effOut = pickNum(raw, ['effective_output_price_per_million', 'effectiveOutputPricePerMillion', 'effective_output_price', 'discount_output_price_per_million'])
    const effCache = pickNum(raw, ['effective_cache_price_per_million', 'effectiveCachePricePerMillion', 'effective_cache_read_price_per_million', 'effective_cache_price', 'discount_cache_read_price_per_million'])
    const responses = (() => {
      const direct = toBool(raw.supports_responses)
      if (direct !== null) return direct
      return Object.keys(rc).length > 0
    })()
    out.push({
      id,
      contextLength: pickNum(raw, ['context_length', 'contextLength', 'context_window', 'max_context_tokens']),
      maxOutput: pickNum(raw, ['max_output_tokens', 'maxOutput', 'max_completion_tokens', 'max_tokens', 'output_token_limit']),
      currency: asStr(raw.currency) || 'CNY',
      inPrice,
      outPrice,
      cachePrice,
      effInPrice: effIn,
      effOutPrice: effOut,
      effCachePrice: effCache,
      hasDiscount: toBool(raw.has_discount) ?? (() => {
        const pairs = [[effIn, inPrice], [effOut, outPrice], [effCache, cachePrice]]
        let any = false
        for (const [eff, base] of pairs) {
          if (eff !== null && base !== null && eff < base) any = true
        }
        return any
      })(),
      tools: pickBool(raw, ['supports_tools', 'tool_call', 'function_calling']) ?? toBool(raw.tools) ?? false,
      reasoning: pickBool(raw, ['supports_reasoning', 'reasoning', 'thinking']) ?? false,
      vision: pickBool(raw, ['supports_vision', 'vision', 'multimodal']) ?? false,
      responses,
      webSearch: toBool(rc.webSearch) ?? toBool(rc.web_search) ?? false,
    })
  }
  return out
}

// 解 {data:{…}} 信封；非对象原样返回。
function unwrapEnvelope(json) {
  return isObj(json) && isObj(json.data) ? json.data : json
}

/**
 * 归一化平台「模型列表」页接口（/api/models，会话 Cookie）：比 /v1/models 多出
 * 显示名 / 类型（chat|image）/ 模态 / 图片单价。分类口径与平台一致：
 *   文本 = type chat、图像 = type image、视频/音频/向量 = capabilities 对应位。
 * 返回与 normalizeModels 同构的 Model（多 name / perImagePrice / categories）。
 */
export function normalizePlatformModels(json) {
  // 信封形态：[数组] / {data:[数组]} / {data:{list:[数组]}}。
  let list = []
  if (Array.isArray(json)) list = json
  else if (isObj(json) && Array.isArray(json.data)) list = json.data
  else if (isObj(json) && isObj(json.data) && Array.isArray(json.data.list)) list = json.data.list
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id)
    if (id === '') continue
    const caps = isObj(raw.capabilities) ? raw.capabilities : {}
    const modalities = Array.isArray(raw.modalities) ? raw.modalities.map(asStr) : []
    const kind = asStr(raw.type) || 'chat'
    const categories = []
    if (kind === 'chat') categories.push('text')
    if (kind === 'image') categories.push('image')
    if (modalities.includes('video') || toBool(caps.video) === true) categories.push('video')
    if (toBool(caps.audio) === true) categories.push('audio')
    if (toBool(caps.embeddings) === true) categories.push('vector')
    const inPrice = toNum(raw.inputPrice)
    const outPrice = toNum(raw.outputPrice)
    const cachePrice = toNum(raw.cacheReadPrice)
    const effIn = toNum(raw.effectiveInputPrice)
    const effOut = toNum(raw.effectiveOutputPrice)
    const effCache = toNum(raw.effectiveCacheReadPrice)
    out.push({
      id,
      name: asStr(raw.name) || id,
      // 来源（无问 / DeepSeek / 阿里云…）：取平台 providerBrands 品牌名列表——
      // 同一模型可能经多个上游提供（如 deepseek 同时标 DeepSeek/阿里云/无问），
      // 缺失时回退 providerDisplayName → provider 键。
      provider: (Array.isArray(raw.providerBrands) && raw.providerBrands.length > 0
        ? [...new Set(raw.providerBrands
            .map((b) => (isObj(b) ? asStr(b.providerBrandName) : ''))
            .filter((s) => s !== ''))].join(' / ')
        : '') || asStr(raw.providerDisplayName) || asStr(raw.provider),
      platformStatus: asStr(raw.status) || null,
      kind,
      categories,
      contextLength: toNum(raw.contextWindow),
      maxOutput: toNum(raw.maxOutputTokens),
      currency: asStr(raw.currency) || 'CNY',
      inPrice,
      outPrice,
      cachePrice,
      effInPrice: effIn,
      effOutPrice: effOut,
      effCachePrice: effCache,
      hasDiscount: toBool(raw.hasDiscount) ?? ([effIn, effOut, effCache].some((eff, i) => {
        const base = [inPrice, outPrice, cachePrice][i]
        return eff !== null && base !== null && eff < base
      })),
      tools: toBool(caps.tools) ?? false,
      reasoning: toBool(caps.reasoning) ?? false,
      vision: toBool(caps.vision) ?? false,
      responses: toBool(caps.responses) ?? false,
      webSearch: false,
      perImagePrice: toNum(raw.pricePerImage),
    })
  }
  return out
}

/**
 * 归一化峰谷分时计价表：/api/model-price-schedules（公开接口，无需会话）。
 * 平台给每个参与分时的模型一份 peak/valley 配置，谷时段打折、峰时段原价。
 * 信封 {data:{items:[…],asOf}}；返回 { modelId → schedule, asOf } 便于按模型 ID 索引。
 *
 * 实测样本（deepseek-flash）：
 *   peak  { startTime:'08:00', endTime:'22:00', listPrice:{inputPrice:'2',outputPrice:'8',cacheReadPrice:'0.04'}, discountPrice:null }
 *   valley{ startTime:'22:00', endTime:'08:00', listPrice:{inputPrice:'1',outputPrice:'4',cacheReadPrice:'0.02'}, discountPrice:null }
 *   expectedPeriod:'PEAK' | 'VALLEY'（平台当前所处时段）、nextSwitchAt:ISO（下次切换）
 *
 * 缺失/脏数据一律不生成条目（该模型就不显示峰谷徽章），绝不抛错打断模型列表。
 */
export function normalizePriceSchedules(json) {
  const data = isObj(json) ? unwrapEnvelope(json) : {}
  const items = Array.isArray(data.items) ? data.items : []
  const out = {}
  for (const raw of items) {
    if (!isObj(raw)) continue
    const modelId = asStr(raw.modelId)
    if (modelId === '') continue
    // 时段价格：listPrice 必有，discountPrice 可选（谷时段常配折扣价）。
    const period = (p) => {
      if (!isObj(p)) return null
      const lp = isObj(p.listPrice) ? p.listPrice : {}
      const dp = isObj(p.discountPrice) ? p.discountPrice : null
      return {
        startTime: asStr(p.startTime),
        endTime: asStr(p.endTime),
        listPrice: {
          inputPrice: toNum(lp.inputPrice),
          outputPrice: toNum(lp.outputPrice),
          cacheReadPrice: toNum(lp.cacheReadPrice),
        },
        discountPrice: dp ? {
          inputPrice: toNum(dp.inputPrice),
          outputPrice: toNum(dp.outputPrice),
          cacheReadPrice: toNum(dp.cacheReadPrice),
        } : null,
      }
    }
    const peak = period(raw.peak)
    const valley = period(raw.valley)
    // 峰谷都没解析出价格 → 视为无效条目，跳过。
    if ((!peak || peak.listPrice.inputPrice === null) && (!valley || valley.listPrice.inputPrice === null)) continue
    const expectedPeriod = asStr(raw.expectedPeriod).toUpperCase()
    out[modelId] = {
      modelId,
      currency: asStr(raw.currency) || 'CNY',
      billingUnit: toNum(raw.billingUnit) ?? 1000000,
      timezone: asStr(raw.timezone) || 'Asia/Shanghai',
      peak,
      valley,
      expectedPeriod: expectedPeriod === 'PEAK' || expectedPeriod === 'VALLEY' ? expectedPeriod : '',
      nextSwitchAt: asStr(raw.nextSwitchAt),
    }
  }
  return { schedules: out, asOf: asStr(data.asOf) }
}

/**
 * 解析 /api/usage/panel（range=30d）为「用量」页签所需的稳定形状。
 *
 * 平台实测口径（2026-09-22，账号 182****3825）：
 *   - {data:{summary, byModel[], byClientApp[], topTokenCalls[], topCostCalls[],
 *            items[], total, page, pageSize, nextCursor}}
 *   - range 只接受 7d / 30d；24h/90d/1d/all → 400；groupBy/dimension/startAt/endAt
 *     等参数一律被忽略（响应与不带时逐字节相同）→ **没有按天聚合，日历不能靠它**。
 *   - pageSize 上限 100（200 起 400）；翻页到第 3 页起必然 503 限流。
 *   - summary.calls=2307 含失败，而 byModel/byClientApp/items 合计 = total=2295 =
 *     successCalls —— 分组只含成功调用，差值就是失败+中止。
 *   - usageTokenSemantics='inclusive_cache'：totalTokens = input + output，
 *     cacheReadTokens 是 inputTokens 的**子集**（不是叠加项）。
 *   - costCny/actualCostUsd 汇率恒为 6.8；inputCostCny 等逐项拆分全为 null 且
 *     costBreakdownComplete=false —— 逐项成本平台没实现，只能信汇总 costCny。
 *   - costCny 字符串（'67.75571396'），转 number；脏值按 null。
 *
 * 返回 { summary, byModel, byClientApp, topCostCalls, meta }，任何一层畸形都降级
 * 为空数组/零值，绝不抛错打断页签。
 */
export function normalizeUsagePanel(json) {
  const data = isObj(json) ? unwrapEnvelope(json) : {}
  const money = (v) => {
    const n = toNum(v)
    return n === null || !Number.isFinite(n) ? 0 : n
  }
  const metricBlock = (raw) => {
    const s = isObj(raw) ? raw : {}
    return {
      calls: toNum(s.calls) ?? 0,
      successCalls: toNum(s.successCalls) ?? 0,
      errorCalls: toNum(s.errorCalls) ?? 0,
      abortedCalls: toNum(s.abortedCalls) ?? 0,
      inputTokens: toNum(s.inputTokens) ?? 0,
      outputTokens: toNum(s.outputTokens) ?? 0,
      totalTokens: toNum(s.totalTokens) ?? 0,
      cacheReadTokens: toNum(s.cacheReadTokens) ?? 0,
      cacheCreationTokens: toNum(s.cacheCreationTokens) ?? null,
      reasoningTokens: toNum(s.reasoningTokens) ?? null,
      costCny: money(s.costCny),
      actualCostUsd: money(s.actualCostUsd),
      tokenSavingCny: money(s.tokenSavingCny),
      fusionEquivalentOpusCny: money(s.fusionEquivalentOpusCny),
      cacheReadComplete: s.cacheReadComplete === true,
      cacheWriteComplete: s.cacheWriteComplete === true,
      costBreakdownComplete: s.costBreakdownComplete === true,
      cacheReadMissingCalls: toNum(s.cacheReadMissingCalls) ?? 0,
      cacheWriteMissingCalls: toNum(s.cacheWriteMissingCalls) ?? 0,
      tokenRequestCount: toNum(s.tokenRequestCount) ?? 0,
      imageRequestCount: toNum(s.imageRequestCount) ?? 0,
    }
  }
  const groupRow = (raw, keyField) => {
    const g = isObj(raw) ? raw : {}
    const b = metricBlock(g)
    // 分组行的身份字段比汇总多一个（modelId/model 或 clientApp）
    return { ...b, [keyField]: asStr(g[keyField]), model: asStr(g.model) }
  }
  const callRow = (raw) => {
    const c = isObj(raw) ? raw : {}
    return {
      id: asStr(c.id),
      traceId: asStr(c.traceId),
      requestAt: asStr(c.requestAt),
      time: asStr(c.time),
      modelId: asStr(c.modelId),
      model: asStr(c.model) || asStr(c.modelId) || '未知模型',
      clientApp: asStr(c.clientApp),
      agent: asStr(c.agent),
      conversationSummary: asStr(c.conversationSummary),
      requestPreview: asStr(c.requestPreview),
      inputTokens: toNum(c.inputTokens) ?? 0,
      outputTokens: toNum(c.outputTokens) ?? 0,
      totalTokens: toNum(c.totalTokens) ?? 0,
      cacheReadTokens: toNum(c.cacheReadTokens) ?? 0,
      reasoningTokens: toNum(c.reasoningTokens) ?? null,
      costCny: money(c.costCny),
      usageTokenSemantics: asStr(c.usageTokenSemantics),
    }
  }
  const groups = (rawList, keyField) => (Array.isArray(rawList) ? rawList : [])
    .filter((r) => isObj(r) && asStr(r[keyField]) !== '')
    .map((r) => groupRow(r, keyField))
  return {
    summary: metricBlock(data.summary),
    byModel: groups(data.byModel, 'modelId'),
    byClientApp: groups(data.byClientApp, 'clientApp'),
    topCostCalls: (Array.isArray(data.topCostCalls) ? data.topCostCalls : [])
      .filter((r) => isObj(r))
      .map(callRow)
      .slice(0, TOP_COST_CALLS),
    meta: {
      // total 是平台侧的记录总数（= 成功调用数），items 只是其中一页
      total: toNum(data.total) ?? 0,
      page: toNum(data.page) ?? 0,
      pageSize: toNum(data.pageSize) ?? 0,
      referenceModel: asStr(data.summary && data.summary.referenceModel),
      savingClientApp: asStr(data.summary && data.summary.savingClientApp),
    },
  }
}

/**
 * 把 /api/usage-daily 的原始行（date × modelId × apiKeyId × clientApp）分桶成
 * 「日历直接可用」的按天数组。
 *
 * 这个接口是关键突破（0.5.5 定案前一直在用按天窗口一个一个请求它，其实没必要）：
 *   · data 是**扁平行数组**，每行一个 日期+模型+Key+客户端 组合；
 *   · range/startDate/endAt/page/pageSize **全部被忽略**（实测怎么传都返回同样
 *     的 122 行 / 95440B），所以它固定吐一整份近 8 周的按天明细；
 *   · 关键是**它本来就是按天的**：把 date 相同的行累加，就是当天的调用数/花费/
 *     模型明细——日历每格要的东西全在里面，一个请求拿完，无需按天逐日打。
 *
 * 口径核对（2026-09-22，账号 18258683825）：分桶出的最近 30 自然日合计
 * ¥242.49619028、10094 次，与 /api/usage/panel?range=30d 的 summary
 * costCny/calls **逐位相同**——两个接口互相印证，聚合口径可信。
 *
 * days 固定铺满「今天往前 USAGE_DAYS 天」（含今天、升序），当天没有行的填 0 并把
 * hasData=false：客户端要能区分「真的没调用」和「这一天不在数据覆盖范围内」。
 * 后者只有 dump 历史不够长时才会出现，用 meta.earliestDate 让界面如实说明。
 *
 * @param json  usage-daily 原始响应
 * @param today 本机「今天」的 Date（只在测试里注入，运行期传 new Date()）
 */
export function normalizeUsageDaily(json, today) {
  const rows = Array.isArray(json && json.data) ? json.data : []
  const money = (v) => { const n = toNum(v); return n === null || !Number.isFinite(n) ? 0 : n }
  const nz = (v) => { const n = toNum(v); return n === null || !Number.isFinite(n) || n < 0 ? 0 : n }

  const buckets = new Map()
  const earliest = { date: '', latest: '' }
  for (const raw of rows) {
    if (!isObj(raw)) continue
    const date = asStr(raw.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (earliest.date === '' || date < earliest.date) earliest.date = date
    if (date > earliest.latest) earliest.latest = date

    let b = buckets.get(date)
    if (b === undefined) {
      b = {
        date, rows: 0,
        calls: 0, successCalls: 0, errorCalls: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
        costCny: 0, tokenSavingUsd: 0, fusionEquivalentOpusUsd: 0,
        models: new Map(), apps: new Map(),
      }
      buckets.set(date, b)
    }
    b.rows++
    b.calls += nz(raw.calls)
    b.successCalls += nz(raw.successCalls)
    b.errorCalls += nz(raw.errorCalls)
    b.inputTokens += nz(raw.inputTokens)
    b.outputTokens += nz(raw.outputTokens)
    b.cacheReadTokens += nz(raw.cacheReadTokens)
    b.reasoningTokens += nz(raw.reasoningTokens)
    // tokenSavingUsd / fusionEquivalentOpusUsd 只有 opensquilla 有值，其余行没有，
    // 累加时按 0 走（不能记 null，否则客户端要判两种空）。
    b.tokenSavingUsd += money(raw.tokenSavingUsd)
    b.fusionEquivalentOpusUsd += money(raw.fusionEquivalentOpusUsd)

    const modelName = asStr(raw.model) || asStr(raw.modelId) || '未知模型'
    const modelId = asStr(raw.modelId) || modelName
    const mKey = modelId + '\u0000' + modelName
    const cost = money(raw.costCny)
    let m = b.models.get(mKey)
    if (m === undefined) {
      m = { modelId, model: modelName, calls: 0, costCny: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, rows: 0 }
      b.models.set(mKey, m)
    }
    m.calls += nz(raw.calls)
    m.costCny += cost
    m.inputTokens += nz(raw.inputTokens)
    m.outputTokens += nz(raw.outputTokens)
    m.cacheReadTokens += nz(raw.cacheReadTokens)
    m.rows++

    // 当天合计也要累：早先只加了模型桶和客户端桶，忘了这一天自己的总额，
    // 结果 calendar.costCny 恒为 0（单测把这个洞照出来了）。
    b.costCny += cost

    const appName = asStr(raw.clientApp) || 'unknown'
    let a = b.apps.get(appName)
    if (a === undefined) {
      a = { clientApp: appName, calls: 0, costCny: 0 }
      b.apps.set(appName, a)
    }
    a.calls += nz(raw.calls)
    a.costCny += cost
  }

  // 金额精度对齐平台：costCny/actualCostUsd 实测都是 8 位小数字符串
  // （'7.78293208'）。按 6 位舍入会在多行/多天累加时悄悄丢钱，
  // 与 usage/panel 的 summary 逐位对照就对不上了，故统一保留 8 位。
  const r8 = (v) => Math.round(v * 1e8) / 1e8
  const finalize = (b) => {
    const models = [...b.models.values()]
      .map((m) => ({
        modelId: m.modelId, model: m.model,
        calls: m.calls,
        costCny: r8(m.costCny),
        inputTokens: m.inputTokens, outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens, rows: m.rows,
      }))
      .sort((x, y) => y.costCny - x.costCny || y.calls - x.calls)
    return {
      date: b.date,
      hasData: true,
      rows: b.rows,
      calls: b.calls,
      successCalls: b.successCalls,
      errorCalls: b.errorCalls,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      totalTokens: b.inputTokens + b.outputTokens,
      cacheReadTokens: b.cacheReadTokens,
      reasoningTokens: b.reasoningTokens,
      costCny: r8(b.costCny),
      tokenSavingUsd: r8(b.tokenSavingUsd),
      fusionEquivalentOpusUsd: r8(b.fusionEquivalentOpusUsd),
      models: models.slice(0, MODEL_ROWS_PER_DAY),
      modelCount: models.length,
      apps: [...b.apps.values()]
        .map((a) => ({ clientApp: a.clientApp, calls: a.calls, costCny: r8(a.costCny) }))
        .sort((x, y) => y.costCny - x.costCny || y.calls - x.calls),
    }
  }
  const empty = (date) => ({
    date,
    hasData: false,
    rows: 0,
    calls: 0, successCalls: 0, errorCalls: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0,
    costCny: 0, tokenSavingUsd: 0, fusionEquivalentOpusUsd: 0,
    models: [], modelCount: 0, apps: [],
  })

  const keyOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
  const anchor = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date()
  const days = []
  let withData = 0
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    d.setDate(d.getDate() - i)
    const key = keyOf(d)
    const b = buckets.get(key)
    if (b === undefined) days.push(empty(key))
    else { days.push(finalize(b)); withData++ }
  }
  return {
    days,
    meta: {
      rowCount: rows.filter((r) => isObj(r)).length,
      daysTotal: USAGE_DAYS,
      daysWithData: withData,
      // dump 覆盖到的最早一天：比它还早的日期属于「无数据」而非「无调用」。
      earliestDate: earliest.date,
      latestDate: earliest.latest,
    },
  }
}
export function categoryCounts(models) {
  const counts = { all: 0, text: 0, image: 0, audio: 0, video: 0, vector: 0 }
  for (const m of models) {
    counts.all++
    for (const c of m.categories || []) {
      if (counts[c] !== undefined) counts[c]++
    }
  }
  return counts
}

/**
 * 归一化余额：/api/usage-summary + /api/me。容忍 {data:{…}} 信封与 snake_case
 * 变体；字段缺失记 null。字段含义（平台实测）：
 *   balanceCny 账户余额 / availableBalanceCny 可用 / frozenBalanceCny 冻结 /
 *   expiringBalanceCny 限时额度（到期失效部分）/ nextExpiryAt 最近到期时间
 */
/**
 * 从 /api/me 响应提取账户名（name > nickname > username > email > id）。
 * 容忍 {data:{…}} 信封与脏数据；全部缺失返回空串。Cookie 模式下
 * manifest / session 路由用它标注「数据账号」。
 */
export function accountNameFromMe(meJson) {
  const me = isObj(meJson) ? unwrapEnvelope(meJson) : {}
  return [me.name, me.nickname, me.username, me.email, me.id]
    .map(asStr).find((v) => v !== '') || ''
}

/**
 * 从 /api/me/identity-verification 响应提取实名认证状态（0.6.2 新增，平台实测）：
 *   status: 'unverified'|'verified'|'reviewing'|'rejected'（平台前端分包证实的状态机）
 *   nextAction / rejectionReasonCode: rejected 时的原因与下一步
 *   migration.apiAccess: 'allowed'|'blocked'——blocked 时平台对 API 调用抛 403
 *     IDENTITY_VERIFICATION_REQUIRED（实名门禁），徽章必须警示
 *   migration.required / deadlineAt / remainingDays: 实名迁移宽限期
 * 只留徽章需要的字段；信封 code!==0 / 缺 data / 空 status 一律 null——宁可缺不编。
 * 也容忍直接传内层 data（调用方/单测省一层信封）。
 */
export function realnameFromIdentity(json) {
  if (!isObj(json)) return null
  if (json.code !== undefined && json.code !== 0) return null
  const data = isObj(json.data) ? json.data : json
  if (data === null) return null
  const status = asStr(data.status)
  if (status === '') return null
  const mig = isObj(data.migration) ? data.migration : {}
  const dlRaw = asStr(mig.deadlineAt)
  const dl = dlRaw !== '' && !Number.isNaN(new Date(dlRaw).getTime()) ? dlRaw : null
  const remaining = Number(mig.remainingDays)
  return {
    status,
    nextAction: asStr(data.nextAction) || null,
    rejectionReason: asStr(data.rejectionReasonCode) || null,
    apiAccess: asStr(mig.apiAccess) || null,
    required: mig.required === true,
    deadlineAt: dl,
    remainingDays: Number.isFinite(remaining) ? remaining : null,
  }
}

// ---- 模型批量连通检测（/model-check）：真实 1-token 请求，走用户自己的 key。
// 选哪些模型、多久一次全由客户端决定（面板打开期间）；host 只执行「这一轮」，
// 60s TTL 内存缓存防重复计费；并发与抖动参数沿用状态站防风控经验值。----
export const CHECK_MAX_MODELS = 30
export const CHECK_TTL_MS = 60 * 1000
const CHECK_TIMEOUT_MS = 30 * 1000
const CHECK_CONCURRENCY = 3
const CHECK_JITTER_MS = 15 * 1000

/**
 * 单模型连通探测分类（口径与状态站一致）：
 * 200→up；429→degraded（上游限流不算模型故障）；http=0→down（网络/超时）；
 * 401/403→auth_error；404→model_not_found；≥500→server_error；其余 4xx→client_error。
 */
export function classifyProbe(http, detail) {
  const d = String(detail || '')
  if (http === 200) return { status: 'up', error: null, errorKind: null }
  if (http === 429) return { status: 'degraded', error: d.slice(0, 120) || 'HTTP 429', errorKind: 'rate_limited' }
  if (http === 0) return {
    status: 'down',
    error: d.slice(0, 120) || '网络错误',
    errorKind: /time|abort|aborterror/i.test(d) ? 'timeout' : 'network_error',
  }
  if (http === 401 || http === 403) return { status: 'down', error: '认证失败（API Key 无效或无权限）HTTP ' + http, errorKind: 'auth_error' }
  if (http === 404) return { status: 'down', error: d.slice(0, 120) || '模型不存在 HTTP 404', errorKind: 'model_not_found' }
  if (http >= 500) return { status: 'down', error: 'HTTP ' + http, errorKind: 'server_error' }
  return { status: 'down', error: ('HTTP ' + http + (d ? ' ' + d.slice(0, 60) : '')).slice(0, 120), errorKind: 'client_error' }
}

/**
 * 构建一轮批量检测的执行计划：字符串化 + trim、去重、≤CHECK_MAX_MODELS，
 * TTL（默认 60s）内已有结果的模型跳过（force 时全探）。
 * cache 接受 Map 或 {model: {ts,…}} 对象。返回 { toProbe, cachedResults }。
 */
export function buildCheckPlan(models, cache, force, now, ttl) {
  const ttlMs = Number(ttl) > 0 ? Number(ttl) : CHECK_TTL_MS
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const hit = (id) => {
    if (cache == null) return null
    try {
      if (typeof cache.get === 'function') return cache.get(id) || null
      return isObj(cache) ? (cache[id] || null) : null
    } catch { return null }
  }
  const seen = {}
  const toProbe = []
  const cachedResults = {}
  const list = Array.isArray(models) ? models : []
  for (const raw of list) {
    if (typeof raw !== 'string') continue // 只接受字符串模型 ID（数字/对象等一律无效）
    const id = asStr(raw)
    if (id === '' || seen[id]) continue
    seen[id] = true
    if (toProbe.length >= CHECK_MAX_MODELS) break
    const h = hit(id)
    if (!force && h && typeof h === 'object' && typeof h.ts === 'number' && nowMs - h.ts < ttlMs) {
      cachedResults[id] = {
        status: h.status, ms: h.ms, error: h.error || null, errorKind: h.errorKind || null,
        checkedAt: h.checkedAt, cached: true,
      }
      continue
    }
    toProbe.push(id)
  }
  return { toProbe, cachedResults }
}

export function normalizeBalance(summaryJson, meJson, expiringJson) {
  const s = unwrapEnvelope(summaryJson) || {}
  const account = accountNameFromMe(meJson)
  return {
    balanceCny: pickNum(s, ['balanceCny', 'balance', 'availableBalanceCny', 'available_balance_cny']),
    availableBalanceCny: pickNum(s, ['availableBalanceCny', 'available_balance_cny']),
    frozenBalanceCny: pickNum(s, ['frozenBalanceCny', 'frozen_balance_cny']),
    expiringBalanceCny: pickNum(s, ['expiringBalanceCny', 'expiring_balance_cny']),
    nextExpiryAt: asStr(s.nextExpiryAt || s.next_expiry_at) || null,
    // 逐笔限时额度以 /api/wallet/expiring-credits 为权威（expiringJson），
    // 该接口请求失败（null/undefined）时回退 usage-summary 深扫兜底。
    expiringItems: normalizeExpiringCredits(expiringJson) ?? extractExpiringItems(summaryJson),
    inputTokens: pickNum(s, ['inputTokens', 'input_tokens']),
    outputTokens: pickNum(s, ['outputTokens', 'output_tokens']),
    costCny: pickNum(s, ['totalCostCny', 'total_cost_cny', 'costCny', 'cost_cny', 'cost']),
    calls: pickNum(s, ['calls']),
    successCalls: pickNum(s, ['successCalls', 'success_calls']),
    currency: asStr(s.currency) || 'CNY',
    account,
    fetchedAt: Date.now(),
  }
}

// ---- 逐笔限时额度提取 ----
// 平台字段名未长期稳定：先试已知候选键，再深度扫描兜底——数组中每项同时含
// 「金额字段」与「到期时间字段」即认。按到期时间升序；缺失/为空返回 []。
const EXPIRING_LIST_KEYS = [
  'expiringItems', 'expiring_items', 'expiringList', 'expiring_list',
  'gifts', 'giftList', 'gift_list', 'grants', 'promotions', 'promotionList',
  'quotaList', 'quota_list', 'quotas', 'presentList', 'present_list', 'rewards',
]
const MONEY_KEY_RE = /(amount|balance|quota|money|cny|price|value)/i
const TIME_KEY_RE = /(expire|expiry|expir|deadline|end.?time|end.?at|valid|due|until)/i
const NAME_KEY_RE = /(name|title|label|remark|desc|source|note)/i

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
// 金额容错直接复用上方 toNum（数字 / 带千分位的数字串都认）
// 时间形态：ISO/日期串、秒或毫秒时间戳
const isTimeLike = (v) => (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v))
  || (isFiniteNum(v) && v > 1e9)

function toExpireAtMs(v) {
  if (isFiniteNum(v)) return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** 从单个明细对象里抠出 { name?, amountCny, expireAt(ISO) }；缺金额或时间则丢弃。 */
function parseExpiringItem(item) {
  if (!isObj(item)) return null
  let amountCny = null
  let expireMs = null
  let name = ''
  for (const [key, value] of Object.entries(item)) {
    if (amountCny === null && !TIME_KEY_RE.test(key) && MONEY_KEY_RE.test(key)) {
      const n = toNum(value)
      if (n !== null) amountCny = n
    }
    if (expireMs === null && isTimeLike(value) && TIME_KEY_RE.test(key)) expireMs = toExpireAtMs(value)
    if (name === '' && typeof value === 'string' && NAME_KEY_RE.test(key) && !TIME_KEY_RE.test(value)) name = value
  }
  if (amountCny === null || expireMs === null || !Number.isFinite(expireMs)) return null
  const out = { amountCny, expireAt: new Date(expireMs).toISOString() }
  if (name !== '') out.name = name
  return out
}

const sortByExpire = (items) => items.slice().sort((a, b) => Date.parse(a.expireAt) - Date.parse(b.expireAt))

/** 深度扫描（≤4 层）：找到第一个「每项都能抠出金额+时间」的数组即收工。 */
function deepScanExpiring(node, depth) {
  if (depth > 4 || !isObj(node) && !Array.isArray(node)) return []
  if (Array.isArray(node)) {
    const items = node.map(parseExpiringItem).filter(Boolean)
    if (items.length > 0 && items.length >= Math.ceil(node.length / 2)) return sortByExpire(items)
    return []
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value) || isObj(value)) {
      const hit = deepScanExpiring(value, depth + 1)
      if (hit.length > 0) return hit
    }
  }
  return []
}

/**
 * 从 /api/usage-summary 提取逐笔限时额度 [{name?, amountCny, expireAt(ISO)}]。
 * 候选键直取 → 深度扫描兜底；任何形态都取不到时返回 []（UI 侧据此不渲染悬浮卡）。
 */
export function extractExpiringItems(summaryJson) {
  const s = summaryJson && isObj(summaryJson) ? unwrapEnvelope(summaryJson) : null
  if (!s) return []
  for (const key of EXPIRING_LIST_KEYS) {
    const arr = s[key]
    if (!Array.isArray(arr) || arr.length === 0) continue
    const items = arr.map(parseExpiringItem).filter(Boolean)
    if (items.length > 0) return sortByExpire(items)
  }
  return deepScanExpiring(s, 0)
}

/**
 * 归一化 /api/wallet/expiring-credits 响应（逐笔限时额度的权威来源，平台实测形态：
 * data.list[] = {id, source, sourceLabel, grantedCny, remainingCny, grantedAt, expiresAt}，
 * data.summary = {expiringBalanceCny, nextExpiryAt}）。
 * 映射为 [{name?, amountCny(剩余), expireAt}] 按到期升序；响应不可用（非对象信封 /
 * 无 list 数组）返回 null，调用方回退 usage-summary 深扫；剩余 ≤0 的条目丢弃。
 */
export function normalizeExpiringCredits(expiringJson) {
  const d = expiringJson && isObj(expiringJson) ? unwrapEnvelope(expiringJson) : null
  if (!d || !Array.isArray(d.list)) return null
  const items = []
  for (const raw of d.list) {
    if (!isObj(raw)) continue
    const amountCny = toNum(raw.remainingCny ?? raw.remaining_cny)
    const expireMs = Date.parse(asStr(raw.expiresAt || raw.expires_at))
    if (amountCny === null || amountCny <= 0 || !Number.isFinite(expireMs)) continue
    const name = asStr(raw.sourceLabel || raw.source_label || raw.source)
    const item = { amountCny, expireAt: new Date(expireMs).toISOString() }
    if (name !== '') item.name = name
    items.push(item)
  }
  return sortByExpire(items)
}

/**
 * 解析 /api/wallet/expiring-credits 为「资金明细」区块所需的稳定形状。
 *
 * 平台实测（2026-09-22，账号 182****3825）：
 *   - {data:{asOf, summary:{expiringBalanceCny, nextExpiryAt,
 *            cumulativeGiftGrantedCny},
 *            rechargePrincipal:{source, sourceLabel, grantedCny, consumedCny,
 *            remainingCny, status, expiresAt},
 *            list:[...], total, page, pageSize}}
 *   - list 每项：id / source / sourceLabel / grantedCny / consumedCny /
 *     remainingCny / status / grantedAt / expiresAt。
 *   - status 实测有 ACTIVE / USED_UP。这个 normalizer 一律如实保留（含 USED_UP、
 *     remaining=0），因为「解析层不过滤」——**已用完不展示是展示层的决定**
 *     （2026-10-20 定稿，见余额页渲染处 stillUsable），解析层把台账交全，
 *     将来想在别处（比如悬停卡）展示历史也不缺数据。
 *   - 金额都是字符串（'18.45596260'），按 8 位小数的数处理。
 *   - 这个接口已被 fetchExpiringCredits 用于「入口悬停限时余额时间线」，但那条链路
 *     只取 remaining>0 且有过期时间的项；这里要的是**完整资金台账**（含用完的），
 *     所以另写一个 normalizer，不复用 normalizeExpiringCredits 的过滤口径。
 *
 * 返回 { summary, principal, items, total }；任何一层畸形都降级为空，绝不抛错。
 */
export function normalizeWalletCredits(json) {
  const data = isObj(json) ? unwrapEnvelope(json) : {}
  const num = (v) => {
    const n = toNum(v)
    return n === null || !Number.isFinite(n) ? 0 : n
  }
  const dateStr = (v) => {
    const s = asStr(v)
    if (s === '') return null
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  const row = (raw) => {
    if (!isObj(raw)) return null
    const label = asStr(raw.sourceLabel || raw.source_label || raw.source)
    return {
      id: asStr(raw.id),
      source: asStr(raw.source),
      sourceLabel: label,
      grantedCny: num(raw.grantedCny ?? raw.granted_cny),
      consumedCny: num(raw.consumedCny ?? raw.consumed_cny),
      remainingCny: num(raw.remainingCny ?? raw.remaining_cny),
      status: asStr(raw.status),
      grantedAt: dateStr(raw.grantedAt ?? raw.granted_at),
      expiresAt: dateStr(raw.expiresAt ?? raw.expires_at),
    }
  }
  const rawSummary = isObj(data.summary) ? data.summary : {}
  const principal = row(isObj(data.rechargePrincipal) ? data.rechargePrincipal : null)
  const items = (Array.isArray(data.list) ? data.list : [])
    .map(row)
    .filter((it) => it !== null)
    // 到期近的排前面：临期额度最该被看见。
    .sort((a, b) => {
      const ta = a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)
      const tb = b.expiresAt === null ? Infinity : Date.parse(b.expiresAt)
      if (ta !== tb) return ta - tb
      return b.grantedCny - a.grantedCny
    })
  return {
    asOf: dateStr(data.asOf),
    summary: {
      expiringBalanceCny: num(rawSummary.expiringBalanceCny ?? rawSummary.expiring_balance_cny),
      cumulativeGiftGrantedCny: num(rawSummary.cumulativeGiftGrantedCny ?? rawSummary.cumulative_gift_granted_cny),
      nextExpiryAt: dateStr(rawSummary.nextExpiryAt ?? rawSummary.next_expiry_at),
    },
    principal: principal === null ? null : {
      sourceLabel: principal.sourceLabel || '充值本金',
      grantedCny: principal.grantedCny,
      consumedCny: principal.consumedCny,
      remainingCny: principal.remainingCny,
      status: principal.status,
    },
    items,
    total: toNum(data.total) ?? items.length,
  }
}

// ---- 更新检测（npm dist-tags 比对）----

/** 解析 v?x.y.z[-prerelease] 的数字三元组；不可解析返回 null。 */
const parseVersionTriple = (value) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim())
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** remote 是否比 local 新（仅比较三元组，忽略 prerelease 后缀）；任一不可解析返回 false。 */
export function isNewerVersion(local, remote) {
  const a = parseVersionTriple(local)
  const b = parseVersionTriple(remote)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i]
  }
  return false
}

/** 从 registry dist-tags 响应提取 latest 版本串；兼容 {latest} 与 {dist-tags:{latest}} 两形态，无合法版本返回 null。 */
export function normalizeDistTags(json) {
  const d = isObj(json) ? json : {}
  const tags = isObj(d['dist-tags']) ? d['dist-tags'] : d
  const latest = asStr(tags.latest)
  return parseVersionTriple(latest) !== null ? latest : null
}

/** 更新状态持久化字段清洗：只留合法键（版本串必须可解析，时间必须为正数）。 */
export function sanitizeUpdate(raw) {
  if (!isObj(raw)) return {}
  const out = {}
  const latest = asStr(raw.latestVersion)
  if (parseVersionTriple(latest) !== null) out.latestVersion = latest
  const checkedAt = toNum(raw.checkedAt)
  if (checkedAt !== null && checkedAt > 0) out.checkedAt = checkedAt
  const current = asStr(raw.currentAtCheck)
  if (parseVersionTriple(current) !== null) out.currentAtCheck = current
  const ignored = asStr(raw.ignoredVersion)
  if (parseVersionTriple(ignored) !== null) out.ignoredVersion = ignored
  return out
}

/** 入口胶囊余额模式清洗：只认 total（总余额）/ expiring（限时总余额），其余返回 null。 */
export function sanitizeEntryBalance(v) {
  return v === 'total' || v === 'expiring' ? v : null
}

/** 清枢智汇入口胶囊口径清洗：total（总余额）/ expiring（限时余额）/ planMoney（套餐余额）/
 * planToken（套餐 token），其余返回 null。口径本身只是一句话，认不出就不落库——客户端那边
 * normalizeTfEntryMode 会把认不出的值回落到 total，两边各自兜底、不互相依赖。 */
export function sanitizeTfEntryMode(v) {
  return v === 'total' || v === 'expiring' || v === 'planMoney' || v === 'planToken' ? v : null
}

/** OpenCSG 入口胶囊口径清洗：balance（账户余额）/ api（API 调用量）/ pending（待发放余额），
 * 其余返回 null。与清枢那套同一约定：口径只是一句话，认不出就不落库——客户端那边
 * normalizeOcEntryMode 会把认不出的值回落到 balance，两边各自兜底、不互相依赖。
 *
 * 老存档里可能存着 `vip` / `usage`（0.7.0 的口径，随用户定案「不需要套餐」一并废弃）：
 * 它们**不是**本版本认识的取值，这里回 null、客户端回落到 balance。**刻意不做**
 * 「vip → api」这类迁移映射：老值说的是「会员档位」，而档位已经不在卡片上了，猜一个近似的
 * 口径等于替用户改设置——回落成最直白的余额更老实。 */
export function sanitizeOcEntryMode(v) {
  return v === 'balance' || v === 'api' || v === 'pending' ? v : null
}

/** 安装模式：检查各 profile 的 node_modules 安装项——是符号链接（junction）且指向本包 → 'local'，
 * 否则 npm 副本。不能用 import.meta.url 的 realpath 比较：Node 解析默认 realpath，
 * 经 junction 加载时模块路径已是真实路径，跟谁比都相等。 */
export function detectInstallMode(home = (process.env.DSH_HOME && String(process.env.DSH_HOME)) || join(os.homedir(), '.dsh')) {
  try {
    const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
    const profiles = join(home, 'profiles')
    for (const name of existsSync(profiles) ? readdirSync(profiles) : []) {
      const entry = join(profiles, name, 'node_modules', 'dsh-tokenrhythm-bill')
      try {
        if (!lstatSync(entry).isSymbolicLink()) continue
        if (realpathSync(entry) === root) return 'local'
      } catch { /* 跳过坏条目 */ }
    }
  } catch { return 'npm' }
  return 'npm'
}

/** 掩码：前 5 位…(长度)，如 "sk_tr…(49)"；空值返回空串。 */
export function maskSecret(value) {
  const s = String(value || '')
  if (s === '') return ''
  return s.slice(0, 5) + '…(' + s.length + ')'
}

// 从粘贴内容里提取 tr_session 的值：兼容整段 Cookie / "tr_session=sess_x" / 裸 sess_x。
export function extractSessionCookie(input) {
  const s = String(input || '').trim()
  if (s === '') return ''
  const m = /tr_session\s*=\s*([A-Za-z0-9._-]+)/.exec(s)
  if (m !== null) return m[1]
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s
  return ''
}

// 从粘贴内容里提取 tr_csrf 的值（CSRF 双提交令牌，与 tr_session 同源下发）；
// 仅当用户粘贴整段 Cookie 时可能带上，裸 session 粘贴则没有（走自愈补取）。
export function extractCsrfCookie(input) {
  const s = String(input || '').trim()
  if (s === '') return ''
  const m = /tr_csrf\s*=\s*([A-Za-z0-9._-]+)/.exec(s)
  return m !== null ? m[1] : ''
}

/**
 * 归一化平台「我的 API Key」列表（/api/api-keys）：容忍信封与字段变体。
 * 平台列表只给掩码（maskedKey + keyPrefix），完整 Key 仅创建响应返回一次。
 * 返回 [{id, name, masked, status, lastUsedAt, createdAt}]。
 */
export function normalizePlatformKeys(json) {
  let list = []
  if (Array.isArray(json)) list = json
  else if (isObj(json) && Array.isArray(json.data)) list = json.data
  else if (isObj(json) && isObj(json.data)) {
    if (Array.isArray(json.data.list)) list = json.data.list
    else if (Array.isArray(json.data.keys)) list = json.data.keys
  }
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const masked = asStr(raw.maskedKey || raw.masked_key || raw.key || raw.masked)
    const prefix = asStr(raw.keyPrefix || raw.key_prefix)
    const id = asStr(raw.id)
    if (id === '' && masked === '' && prefix === '') continue
    out.push({
      id,
      name: asStr(raw.name) || '未命名密钥',
      masked: masked !== '' ? masked : prefix + '****',
      prefix,
      status: asStr(raw.status) || 'enabled',
      lastUsedAt: asStr(raw.lastUsedAt || raw.last_used_at) || null,
      createdAt: asStr(raw.createdAt || raw.created_at) || null,
    })
  }
  return out
}

/**
 * 基元 provider 定位（纯函数，测试真跑）。对话头部角标那条链上「查哪一枚 provider」只有这一处判据。
 *
 * 为什么不写成 `providers.find((p) => p.balanceCapable)`：基元的 provider 可以是**多枚共用同一个
 * baseURL 的短键**——名字是用户在 DSH 设置里给 `llm-pi-ai.config.providers` 起的映射键，本机实测
 * 就是 `jy`（基元）与 `jy131`（基元1）两枚都指向 tokenrhythm.studio。`find` 只会命中名册第一枚，
 * 于是第二枚的会话① 核对归属时拿的是**别人的** apiKeyEnv（核错钥匙）、② 回带的 providerId 永远是
 * 第一枚，客户端「这个会话在用基元吗」判否，角标整枚不出现（v0.7.3 用户现场报告的那条）。
 *
 * 语义：
 *   · 点名了（wantId 非空）且名册里找得到 → **只认它**（用户起的短键也认），`wanted` 一并带回；
 *   · 点名了但不是基元 → `denied: true`：调用方必须**就地拒答**——不读钥匙、不碰会话、一次上游都不打
 *     （下面那条链遇 401 会用绑定账号自动重登，非基元会话问一句不能有任何副作用）；
 *   · 没点名（面板 / 账号动作 / 老客户端）或点名的 id 已不在名册里 → 退回名册第一枚基元 provider。
 */
export function trResolveProvider(providers, wantId) {
  const list = Array.isArray(providers) ? providers : []
  const isTr = (p) => isObj(p) && p.balanceCapable === true
  const want = asStr(wantId)
  if (want !== '') {
    const hit = list.find((p) => isObj(p) && asStr(p.id) === want) || null
    if (hit !== null) return { provider: isTr(hit) ? hit : null, wanted: hit, denied: !isTr(hit) }
  }
  return { provider: list.find(isTr) || null, wanted: null, denied: false }
}

/**
 * 本机这把 key 与平台返回的那把是同一条吗——平台只给掩码，所以只能做**头尾指纹**：
 * 头（平台的 keyPrefix）或尾（掩码 `****` 之后那段）任一命中即算。两处共用这一份，
 * 别让口径漂移：
 *   · 「密钥」页签的 copyable（点「复制完整值」的前提：本机得真有对应的明文）；
 *   · 对话头部角标的「这把 key 属于这个账号吗」（角标描述的对象必须跟着宿主走）。
 * 本机 key 为空一律不匹配——没得比，也不该拿空串去 startsWith（那会全命中）。
 */
export function trKeyMatchesPlatform(localKey, platformKey) {
  const lk = asStr(localKey)
  if (lk === '' || !isObj(platformKey)) return false
  const prefix = asStr(platformKey.prefix)
  if (prefix !== '' && lk.startsWith(prefix)) return true
  const masked = asStr(platformKey.masked)
  const suffix = masked.includes('****') ? masked.split('****').pop() : ''
  return suffix !== '' && lk.endsWith(suffix)
}

/**
 * 账号列表净化（宿主持久化用）：只接受 {account, password}，去掉空项与超长值。
 * 明文密码按用户要求保存在本机 state 文件（0600），供面板内查看与一键登录。
 */
export function sanitizeAccounts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const account = asStr(raw.account)
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (account === '' || account.length > 64 || password.length > 256) continue
    const key = account.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ account, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
  }
  return out
}

/**
 * 已存账号里挑选自动重登凭据（「cookie 即身份」的保守守卫）：
 * 仅当 activeAccount 非空且命中（大小写不敏感）且有密码时返回该条目；
 * activeAccount 为空（纯 cookie 粘贴 / 身份未知 / 未命中）一律 null ——
 * 宁可不自动重登，也绝不把 A 账号重登到 B 的会话上。
 */
export function pickReloginAccount(state) {
  return pickBoundAccount(state, undefined, 'account')
}

/**
 * 账号名匹配（/session 粘贴新 cookie 后的身份对齐用）：返回命中的账号条目或 null。
 */
export function matchAccountName(accounts, name) {
  return findAccount(accounts, 'account', name)
}

// =====================================================================
// 基元「本机明文密钥副本」（用户定稿 2026-10-23）
// =====================================================================
// 判据是**平台还愿不愿意再给一次明文**，不是「哪家看起来更该存」：
//   · 基元：/api/api-keys 列表只回掩码（maskedKey + keyPrefix），也没有按 id 单取明文的口
//     —— 完整值离开创建响应就再也拿不回来，所以创建时落一份副本，之后按 id 单取复制；
//   · 阶跃：ListAccessKeys 每次都回完整 accessKey，随时能再要一次 —— 不存（存了只是多一处
//     明文落点，收益为零）；
//   · OpenCSG：与基元同一处境，已按同一套落盘（state.oc.savedKeys）。
// 存法：state.trKeys，与账号密码同一份 0600 state 文件。认领靠**平台密钥 id**（列表行与
// 创建响应都有），不靠头尾指纹——指纹只回答「本机在用的这把是不是某一行」，两件事别混。
// 非数组/全脏 → 空数组：与其它净化器同一口径（读侧永不抛，脏数据最多丢副本不丢功能）。

/** 单机最多留几把（新建的往最前插，超限从尾部丢——最老的最可能已经删了）。 */
export const TR_SAVED_KEY_MAX = 50
/** 明文 token 限长（实测基元 key 49 字符；256 足够，防历史脏数据把 state 撑爆）。 */
export const TR_SAVED_KEY_TOKEN_MAX = 256

/**
 * 一条本机副本净化 → 记录 | null。
 * id 是唯一认领键：没有 id 就永远对不上列表行，直接丢（存了也复制不了）。
 */
export function trSavedKeyEntry(raw, nowMs) {
  if (!isObj(raw)) return null
  const id = asStr(raw.id)
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (id === '' || id.length > 64) return null
  if (token === '' || token.length > TR_SAVED_KEY_TOKEN_MAX) return null
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
  const createdAtMs = toNum(raw.createdAtMs)
  const savedAt = toNum(raw.savedAt)
  return {
    id,
    name: asStr(raw.name).slice(0, 128) || '未命名密钥',
    token,
    createdAtMs: createdAtMs === null ? now : createdAtMs,
    savedAt: savedAt === null ? now : savedAt,
  }
}

/** 整表净化：逐条过 trSavedKeyEntry、同 id 去重（保序）、截到上限。 */
export function sanitizeTrSavedKeys(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    const rec = trSavedKeyEntry(raw, Date.now())
    if (rec === null || seen.has(rec.id)) continue
    seen.add(rec.id)
    out.push(rec)
    if (out.length >= TR_SAVED_KEY_MAX) break
  }
  return out
}

/**
 * 新增一条（新在前、同 id 覆盖旧记录、超限截尾）。纯函数：返回新数组，不改入参。
 * 净化没过就**原样退回入参**——调用方据此判断「这条没被接受」（引用相等），不必再查一次。
 */
export function trSavedKeysAdd(list, rec, nowMs) {
  const cur = Array.isArray(list) ? list : []
  const clean = trSavedKeyEntry(rec, nowMs)
  if (clean === null) return cur
  return [clean, ...cur.filter((r) => !isObj(r) || r.id !== clean.id)].slice(0, TR_SAVED_KEY_MAX)
}

/** 丢掉一条（按 id）。纯函数：返回新数组；id 为空/没命中就是**原数组**（引用相等 = 没删到）。 */
export function trSavedKeysDrop(list, id) {
  const cur = Array.isArray(list) ? list : []
  const want = asStr(id)
  if (want === '') return cur
  const next = cur.filter((r) => !(isObj(r) && r.id === want))
  return next.length === cur.length ? cur : next
}

// =====================================================================
// Cordis 插件半区：路由注册（全部包在 effect 里，卸载即回收）
// =====================================================================

export const name = 'dsh-tokenrhythm-bill'

export const inject = ['webServer']

export function apply(ctx) {
  // ---- DSH 目录与文件 ----
  const dshDir = () => (process.env.DSH_HOME && String(process.env.DSH_HOME))
    || (typeof os !== 'undefined' && os.homedir ? join(os.homedir(), '.dsh') : null)
  const settingsPath = () => { const d = dshDir(); return d === null ? null : join(d, 'settings.yaml') }
  const credentialsPath = () => { const d = dshDir(); return d === null ? null : join(d, '.credentials.yaml') }
  // 会话 Cookie + 面板几何都存这个文件（0600），不进浏览器、不进 settings。
  const statePath = () => { const d = dshDir(); return d === null ? null : join(d, 'tokenrhythm-bill-state.json') }
  // 旧项目名（dsh-model-balance）时代的 state 文件：新文件缺失时读它做一次性迁移。
  const legacyStatePath = () => { const d = dshDir(); return d === null ? null : join(d, 'model-balance-state.json') }

  const readTextSafe = (file) => {
    if (file === null) return ''
    try { return existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return '' }
  }

  // ---- 持久化状态（cookie / 账号列表 / prefs）：读写都 best-effort ----
  // 「某家什么都没配」的形状只写一份：初始 state 与「换账号/清空」共用这几个空壳，
  // 免得两处各写一遍字段表——漏一个字段就是「清空后仍是旧账号」这类脏状态。
  let stateLoaded = false
  let state = { cookie: '', csrf: '', prefs: {}, accounts: [], activeAccount: '', update: {}, trKeys: [] }

  const loadState = () => {
    if (stateLoaded) return state
    stateLoaded = true
    const file = statePath()
    if (file === null) return state
    let text = readTextSafe(file)
    if (text.trim() === '') text = readTextSafe(legacyStatePath()) // 迁移：旧名 state 兜底
    try {
      const data = JSON.parse(text)
      if (isObj(data)) {
        if (typeof data.cookie === 'string') state.cookie = data.cookie
        if (typeof data.csrf === 'string') state.csrf = data.csrf
        if (typeof data.activeAccount === 'string') state.activeAccount = data.activeAccount
        if (isObj(data.prefs)) state.prefs = data.prefs
        state.accounts = sanitizeAccounts(data.accounts)
        state.update = sanitizeUpdate(data.update)
        // 基元「创建时落盘」的明文密钥副本（见 sanitizeTrSavedKeys 那段：平台只给一次，
        // 不给副本就再也复制不出来）。与账号密码同一份 0600 文件、同一信任边界。
        state.trKeys = sanitizeTrSavedKeys(data.trKeys)
      }
    } catch { /* 不可读 → 空状态 */ }
    return state
  }
  const saveState = () => {
    const file = statePath()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cookie: state.cookie, csrf: state.csrf, prefs: state.prefs, accounts: state.accounts, activeAccount: state.activeAccount, update: state.update, trKeys: state.trKeys, savedAt: Date.now() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch { /* best-effort：丢持久化不丢功能 */ }
  }

  // ---- 启用的系统（0.6.2「系统管理」）----
  // 面板里能出现哪几家（基元 / 阶跃 / ZCode / 清枢智汇 / OpenCSG）：**默认只有基元**，另四家要在
  // 设置 → 系统管理里显式勾上才出现。prefs.systems 是权威；老存档里只有 0.6.x 的
  // ZCode 总开关（prefs.zcode），缺 systems 时按它推导——老用户开过 ZCode 的不会被悄悄关掉。
  // 不变式：**至少留一个**（全关等于面板空转），任何入口进来的全关状态都落回基元。
  const SYS_KEYS = ['tr']
  const systemsOf = (prefs) => {
    const p = isObj(prefs) ? prefs : {}
    const raw = isObj(p.systems) ? p.systems : {}
    const out = {}
    for (const k of SYS_KEYS) {
      if (typeof raw[k] === 'boolean') out[k] = raw[k]
      else if (k === 'zcode') out[k] = p.zcode === true
      else out[k] = k === 'tr'
    }
    // 逐键判空而不是硬点四家人的名字：以后再加系统时这条不变式不会漏改。
    if (!SYS_KEYS.some((k) => out[k] === true)) out.tr = true
    return out
  }
  // 「设置 → 系统管理」里拖出来的顺序（sysOrder）。存的是**完整排列**：SYS_KEYS 每个键都在、
  // 不重、不丢——客户端拿到就能直接按它排，不必再补一遍（两边各补一遍迟早补出不一样）。
  // 认不出的键丢掉、缺的按默认序补末尾；非数组 / 一个都不认识 → null（调用方据此整段忽略，
  // 不拿一个空结论去覆盖已存的顺序）。
  const sanitizeSysOrder = (v) => {
    if (!Array.isArray(v)) return null
    const out = []
    for (const k of v) if (typeof k === 'string' && SYS_KEYS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k)
    if (out.length === 0) return null
    for (const k of SYS_KEYS) if (out.indexOf(k) < 0) out.push(k)
    return out
  }
  // 读口：老存档没有 sysOrder 就是默认序（SYS_KEYS 顺序），与加这个字段之前完全一致——
  // 升级不该让任何人打开面板发现系统顺序变了。
  const sysOrderOf = (prefs) => sanitizeSysOrder(isObj(prefs) ? prefs.sysOrder : undefined) || SYS_KEYS.slice()
  const sanitizePrefs = (input) => {
    const out = {}
    if (!isObj(input)) return out
    if (isObj(input.panel)) {
      const p = input.panel
      const panel = {}
      for (const k of ['x', 'y', 'w', 'h']) {
        const n = toNum(p[k])
        if (n !== null) panel[k] = n
      }
      if (Object.keys(panel).length > 0) out.panel = panel
    }
    const eb = sanitizeEntryBalance(input.entryBalance)
    if (eb !== null) out.entryBalance = eb
    // 清枢智汇入口胶囊口径（设置 → 清枢 → 胶囊接管（清枢智汇））：四选一，认不出就不写。
    const tfm = sanitizeTfEntryMode(input.entryTfMode)
    if (tfm !== null) out.entryTfMode = tfm
    // OpenCSG 入口胶囊口径（设置 → OpenCSG → 胶囊接管（OpenCSG））：三选一，认不出就不写。
    const ocm = sanitizeOcEntryMode(input.entryOcMode)
    if (ocm !== null) out.entryOcMode = ocm
    // ZCode 集成总开关（默认关闭——插件面向所有用户，读 ~/.zcode/v2 凭证必须显式
    // 开启）。只在请求显式携带时才写入：面板几何等其它 prefs POST 不覆盖此开关。
    if (input.zcode !== undefined) out.zcode = input.zcode === true
    // 启用的系统（设置 → 系统管理）：白名单三个布尔值。**全 false 的请求整段忽略**——
    // 客户端点最后一个开关时会自己拦下并提示，这里是不被绕过的第二道（老客户端/手改 prefs
    // 都堵住）。写 systems 的同时镜像老的 zcode 总开关，让 zcodeEnabled() 只有一份真相；
    // 少了哪个键也没关系，systemsOf() 会按老 zcode / 默认基元逐键补齐。
    if (isObj(input.systems)) {
      const sys = {}
      for (const k of SYS_KEYS) if (typeof input.systems[k] === 'boolean') sys[k] = input.systems[k]
      if (SYS_KEYS.some((k) => sys[k] === true)) {
        out.systems = sys
        if (typeof sys.zcode === 'boolean') out.zcode = sys.zcode
      }
    }
    // 「设置 → 系统管理」里拖出来的顺序：与 systems **分开存**（顺序和开关是两件事——
    // 关掉一家不该把它的位次也抹掉，再勾上时它回到原来那个位置）。认不出的写请求整段忽略。
    const so = sanitizeSysOrder(input.sysOrder)
    if (so !== null) out.sysOrder = so
    // 批量检测设置（模型页签）：开关 / 定时间隔 / 选中模型集。间隔走白名单，
    // 选中集每项必须是非控制字符的短字符串（模型 ID 形态），上限 CHECK_MAX_MODELS。
    if (isObj(input.check)) {
      const c = input.check
      const check = { mode: c.mode === true }
      if (c.interval !== undefined) {
        const iv = toNum(c.interval)
        check.interval = iv !== null && [5, 10, 15, 30, 60].indexOf(iv) >= 0 ? iv : 0
      }
      if (isObj(c.sel)) {
        const sel = {}
        let n = 0
        for (const k of Object.keys(c.sel)) {
          if (n >= CHECK_MAX_MODELS) break
          if (c.sel[k] === true && /^[^\x00-\x1f]{1,120}$/.test(k)) { sel[k] = true; n++ }
        }
        if (n > 0) check.sel = sel
      }
      out.check = check
    }
    return out
  }

  // 0.1.7+ 的活存储是「profile 补丁层」。候选顺序：
  //   ① 装着本插件的 profile —— 插件只在装了自己的 profile 里加载，这比猜「当前
  //      profile」可靠（profile 选择状态不在本插件可见范围内）
  //   ② 其余 profile，按名字排序保证确定性（同装插件时谁先谁后稳定可复现）
  // 家目录级补丁层（$DSH_HOME/cordis.patch.yml）对所有 profile 生效，排最后兜底。
  const patchLayerPaths = () => {
    const home = dshDir()
    if (home === null) return []
    const out = []
    const homePatch = join(home, 'cordis.patch.yml')
    if (existsSync(homePatch)) out.push(homePatch)
    const root = join(home, 'profiles')
    let names = []
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
    } catch { return out }
    const cands = []
    for (const name of names) {
      const patch = join(root, name, 'cordis.patch.yml')
      if (!existsSync(patch)) continue
      // name 必须一起存：下面排序的平手判据读它。曾漏掉 → a.name 为 undefined，
      // localeCompare 抛 TypeError，而调用方没有 try/catch，整个 /manifest 500，
      // 面板只显示「没有提供商」，真正原因被吞（实测踩过）。
      cands.push({ name, patch, mine: existsSync(join(root, name, 'node_modules', 'dsh-tokenrhythm-bill')) })
    }
    // 装着本插件的 profile 优先；平手按名字，保证同装多个时顺序确定可复现
    cands.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.name.localeCompare(b.name))
    for (const c of cands) out.push(c.patch)
    return out
  }

  // ---- provider / 凭据解析（每次现读，改 settings 即时生效）----
  // 来源按序：settings.yaml（0.1.6 及更早的活文件）→ profile 补丁层（0.1.7+ 的活存储）。
  // 只读不写：绝不替用户重建 settings.yaml——那会造成第二次导入，把 Setup 的默认值
  // 盖回用户已经改过的选择上（DSH 自己的注释明确写了这个坑）。
  // 与 parseSettingsProviders 同一契约：任何失败都化作 error 文案返回，绝不向外抛——
  // 抛出会让 /manifest 整个 500，面板只剩一句「没有提供商」，真正原因被吞掉。
  const readProviders = () => {
    const file = settingsPath()
    const legacyText = readTextSafe(file)
    if (legacyText.trim() !== '') {
      try { return { providers: parseSettingsProviders(legacyText), error: null } }
      catch (err) { return { providers: [], error: 'settings.yaml 解析失败: ' + String((err && err.message) || err) } }
    }
    let patches = []
    try { patches = patchLayerPaths() }
    catch (err) { return { providers: [], error: '枚举 profile 补丁层失败: ' + String((err && err.message) || err) } }
    if (patches.length === 0) {
      return {
        providers: [],
        error: file === null ? '无法定位 DSH 目录' : 'settings.yaml 不存在，也没找到任何 profile 的 cordis.patch.yml',
      }
    }
    let sawText = false
    let firstNonEmpty = null // 全家都没有 tokenrhythm 时的兜底：第一份非空名册
    for (const patch of patches) {
      const text = readTextSafe(patch)
      if (text.trim() === '') continue
      sawText = true
      let list = []
      try { list = parsePatchProviders(text) }
      catch (err) { return { providers: [], error: '补丁层解析失败: ' + String((err && err.message) || err) } }
      if (list.length === 0) continue
      // 本插件只为 tokenrhythm 余额而生：哪份补丁层里有可查余额的条目（baseURL 含
      // tokenrhythm）就用哪份，不再死守「第一个非空」。为什么不能只靠 patchLayerPaths
      // 的排序：mine 判据是「这个 profile 装没装本插件」，多个 profile 都装过就全部打平、
      // 退化按名字排——实测 web/desktop/work 三 profile 全装时 desktop 胜出，而
      // tokenrhythm 提供商配在 work 的补丁层里，于是先读到一份只有 tierflow 的名册，
      // 面板误报「未配置基元律动提供商，无法查询余额」。当前 profile 不在插件可见
      // 范围内（宿主进程环境里只有 DSH_HOME，没有 profile 标识），所以按内容选，
      // 比猜 profile 可靠。
      if (list.some((p) => p.balanceCapable)) return { providers: list, error: null }
      if (firstNonEmpty === null) firstNonEmpty = list
    }
    if (firstNonEmpty !== null) return { providers: firstNonEmpty, error: null }
    return {
      providers: [],
      error: sawText
        ? 'settings.yaml 与各 profile 补丁层里都没有 llm-pi-ai.providers 段'
        : 'settings.yaml 与各 profile 补丁层都为空或不可读',
    }
  }
  // env 变量优先（同音乐插件 readCredential 的次序），其次凭据文件 refs。
  const resolveKey = (provider) => {
    if (!provider || provider.apiKeyEnv === '') return ''
    try {
      const fromEnv = process.env && process.env[provider.apiKeyEnv]
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    } catch { /* env 不可用 → 落到文件 */ }
    return extractCredentialFromText(provider.apiKeyEnv, readTextSafe(credentialsPath())) || ''
  }

  // DSH 宿主真正「在用」的 key：宿主凭据 provider 的分层是 **文件 > 继承的 env**
  // （官方注释："The managed store wins because a credential the user explicitly saved
  // in the product must take effect consistently"），且 watch 在文件变更后 100ms 热重载、
  // 引用按请求解析。所以判断/切换「DSH 实际使用的 key」必须 file-first——上面 resolveKey
  // 的 env-first 是插件早年对宿主的错误近似，env 与文件并存时它会读错。阶跃的 key-plan
  // 角标与 key-use 切换统一走这个口径。
  const activeCredentialKey = (envName) => {
    const name = String(envName || '').trim()
    if (name === '') return { key: '', source: 'none' }
    const fromFile = extractCredentialFromText(name, readTextSafe(credentialsPath()))
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return { key: fromFile.trim(), source: 'file' }
    try {
      const fromEnv = process.env && process.env[name]
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { key: fromEnv.trim(), source: 'env' }
    } catch { /* env 不可用 */ }
    return { key: '', source: 'none' }
  }

  /**
   * 替换 .credentials.yaml 文本里 `NAME: value` 那一行的值——与 extractCredentialFromText
   * 同款行级正则（refs 流式映射 / 旧平铺 / `- NAME:` 列表项都兼容），保留缩进、冒号后的
   * 空格、行尾逗号；只碰这一行，其他字节（含 records 块与注释）原样。
   * 0 行命中 NO_REF；>1 行命中 AMBIGUOUS（分不清哪行生效就拒写）；值不在安全字符集
   * （YAML flow 里无引号也不歧义）UNSAFE_VALUE。绝不抛错。
   */
  function patchCredentialLine(text, envName, value) {
    const name = String(envName || '').trim()
    if (typeof text !== 'string' || text === '' || name === '') return { ok: false, code: 'NO_FILE' }
    if (!/^[A-Za-z0-9._\-]{8,256}$/.test(String(value || ''))) return { ok: false, code: 'UNSAFE_VALUE' }
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('^(\\s*-?\\s*)' + esc + '(\\s*:\\s*)([^\\r\\n]*?)(\\s*,?\\s*)$')
    const lines = text.split('\n')
    const hits = []
    for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) hits.push(i) }
    if (hits.length === 0) return { ok: false, code: 'NO_REF' }
    if (hits.length > 1) return { ok: false, code: 'AMBIGUOUS' }
    const m = re.exec(lines[hits[0]])
    const prev = m[3].replace(/^["']|["']$/g, '')
    lines[hits[0]] = m[1] + name + m[2] + value + m[4]
    return { ok: true, text: lines.join('\n'), prev }
  }

  // ---- /models 上游代理（60s 缓存 + 5xx 网关错重试 1 次）----
  const modelsCache = new Map() // providerId -> { models, ts }
  // ---- 峰谷分时计价表 TTL 缓存：/api/model-price-schedules 是公开接口（无需会话），
  // 与模型列表解耦——网关兜底路径也能拿到峰谷徽章数据。缓存结构与模型列表一致。 ----
  const schedulesCache = { data: null, ts: 0 }
  const fetchPriceSchedules = async () => {
    if (schedulesCache.data !== null && Date.now() - schedulesCache.ts < MODELS_TTL_MS) return schedulesCache.data
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/model-price-schedules')
      if (!res.ok) return schedulesCache.data
      const data = normalizePriceSchedules(await res.json().catch(() => null))
      schedulesCache.data = data
      schedulesCache.ts = Date.now()
      return data
    } catch {
      // 峰谷表拉取失败不该影响模型列表：返回旧缓存（没有就返回空表）。
      return schedulesCache.data
    }
  }
  // ---- /model-check 批量检测 TTL 缓存：model -> { ts, status, ms, error, errorKind, checkedAt } ----
  // 60s 内同模型不重复真实探测（防连续点「立即检测」重复计费）；force 绕过。
  const checkCache = new Map()
  const fetchWithTimeout = async (url, init) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  /**
   * 带 5xx 重试的 fetch：**只重试 502/503/504**（网关抖动）。4xx 与网络异常**不吞**——
   * 4xx 立刻返回，网络异常照常抛给调用方（各家对它的处置不同：/models 抛给用户看，
   * /usage 那几条用 .catch(() => null) 当「这次没数据」）。
   *
   * `waits` 是每轮重试前的等待（毫秒）；不给就是「立刻再试一次」。实测 /models 与
   * /call-logs 立刻重试就够；/usage-daily 限流凶，要 1.5s/3.5s/7s（见调用点）。
   *
   * 返回最后一次 Response（**可能仍是 5xx**）：够不够格当失败由调用方按 res.ok 判。
   */
  const fetchRetrying = async (url, init, waits) => {
    const schedule = Array.isArray(waits) ? waits : [0]
    let res = await fetchWithTimeout(url, init)
    for (const wait of schedule) {
      if (res === null || !RETRYABLE_STATUS.has(res.status)) break
      if (wait > 0) await sleep(wait)
      res = await fetchWithTimeout(url, init)
    }
    return res
  }

  const fetchUpstreamModels = async (provider, key) => {
    // baseURL 已以 /v1 等版本段结尾（settings 实际布局）时直接接 /models，
    // 否则补 /v1/models —— 避免拼出 /v1/v1/models。
    const base = provider.baseURL.replace(/\/+$/, '')
    const url = /\/v\d+$/.test(base) ? base + '/models' : base + '/v1/models'
    const init = { headers: { Authorization: 'Bearer ' + key } }
    const res = await fetchRetrying(url, init)
    const bodyText = await res.text()
    let json = null
    try { json = JSON.parse(bodyText) } catch { /* 非 JSON → 按状态码报错 */ }
    if (!res.ok) {
      const detail = isObj(json) && json.error ? String(json.error.message || json.error) : bodyText.slice(0, 200)
      const err = new Error('上游 ' + res.status + ': ' + detail)
      err.status = res.status
      throw err
    }
    return normalizeModels(json)
  }

  // ---- /balance 上游代理（网页会话 Cookie）----
  // 当日使用与花费趋势共用同一份 call-logs 分页（见 fetchUsageTrend），不再各自翻页——
  // 旧实现当日卡最多串行 10 页、趋势图又把今天的页重拉一遍，同样的日志每次刷新
  // 被平台吐两遍，且当日卡封顶 1000 次与趋势图数字对不上。
  const DAILY_LOG_PAGE_SIZE = 100

  // ---- 「当日使用」数据源：本地日分桶 + 按模型细分 ----
  // 0.5.5 起界面删掉了 7 日趋势图与「最近调用」，这组分桶现在只服务余额页的
  // 「当日使用」卡（今天 0 点起至今的调用/花费/tokens）。翻页早停判据仍按
  // 「凑满 N 个有记录日且最老记录早于第 N 新的 0 点」算——它保证最后一天
  // （也就是今天）的记录已经拉全，正是当日卡要的。
  // 当日使用卡片直接取今天的分桶（分页最新优先，今天的记录天然在最新几页且完整）。
  // 实测：pageSize 被服务端锁死 100（500 直接 400），但响应带 total。
  const TREND_TTL_MS = 5 * 60 * 1000 // 全量重翻间隔
  const TREND_TOPUP_TTL_MS = 60 * 1000 // 60s 内直接吃缓存；60s~5min 只补拉今天（1~2 页）
  const TREND_DAYS = 7
  const TREND_WINDOW_DAYS = 90
  const TREND_MAX_PAGES = 60
  const TREND_BATCH = 6
  // 缓存按账号隔离（state.activeAccount）：切换账号后旧账号的缓存不会被发给新账号，
  // 切回原账号也能立刻命中它自己的缓存，而不是看到别的账号的 ¥0。
  const trendCaches = new Map() // activeAccount -> { data, ts, buckets }

  const makeBucket = (dayStart) => ({
    key: dayStart.toDateString(),
    t: dayStart.getTime(),
    date: (dayStart.getMonth() + 1) + '-' + dayStart.getDate(),
    costCny: 0,
    calls: 0,
    successCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    models: new Map(),
  })

  // 把一页日志灌进分桶（toDateString 即本地时区日期）；字段口径：snake_case 兜底、
  // 非法数值按 0。返回本批已见最老记录的时间戳（无有效记录返回 Infinity）。
  const ingestInto = (buckets, list) => {
    let oldest = Infinity
    for (const item of list) {
      if (!isObj(item)) continue
      const t = new Date(item.requestAt || item.time || '')
      if (Number.isNaN(t.getTime())) continue
      const ts = t.getTime()
      if (ts < oldest) oldest = ts
      const dayStart = new Date(t)
      dayStart.setHours(0, 0, 0, 0)
      const key = dayStart.toDateString()
      let b = buckets.get(key)
      if (!b) {
        b = makeBucket(dayStart)
        buckets.set(key, b)
      }
      const cost = toNum(item.costCny) ?? 0
      b.costCny += cost
      b.calls++
      if (toNum(item.status) === 200) b.successCalls++
      b.inputTokens += toNum(item.inputTokens ?? item.input_tokens) ?? 0
      b.outputTokens += toNum(item.outputTokens ?? item.output_tokens) ?? 0
      b.cacheReadTokens += toNum(item.cacheReadTokens ?? item.cache_read_tokens) ?? 0
      const name = asStr(item.model || item.requestModelId) || '未知模型'
      const m = b.models.get(name) || { costCny: 0, calls: 0 }
      m.costCny += cost
      m.calls++
      b.models.set(name, m)
    }
    return oldest
  }

  // 当日使用卡片数据：今天的桶直读。旧实现当日卡封顶 10 页=1000 次、趋势图却拉全，
  // 同一面板两个「今天」数字互相矛盾；现在同源同数。
  const dailyFromBuckets = (buckets, todayStart) => {
    const b = buckets.get(todayStart.toDateString())
    return {
      inputTokens: b ? b.inputTokens : 0,
      outputTokens: b ? b.outputTokens : 0,
      cacheReadTokens: b ? b.cacheReadTokens : 0,
      costCny: b ? Math.round(b.costCny * 1e6) / 1e6 : 0,
      calls: b ? b.calls : 0,
      successCalls: b ? b.successCalls : 0,
      fetched: b ? b.calls : 0,
      since: todayStart.toISOString(),
    }
  }

  const fetchLogPage = async (cookie, page, startIso, endIso) => {
    const headers = trHeaders(cookie)
    const qs = 'startAt=' + encodeURIComponent(startIso) + '&endAt=' + encodeURIComponent(endIso)
      + '&page=' + page + '&pageSize=' + DAILY_LOG_PAGE_SIZE
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 5xx 网关错重试 1 次（与 /models 代理同口径，见 fetchRetrying）。
        const res = await fetchRetrying(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
        if (!res.ok) return null
        return await res.json().catch(() => null)
      } catch { if (attempt > 0) return null }
    }
    return null
  }

  // 只补拉今天：余额面板 60s 自动刷新，全量重翻不必跟着这么勤——缓存 60s~5min 之间
  // 只拉 1~2 页把今天的桶换新（页数按缓存里今天的调用量估）。覆盖判据：补拉页里
  // 最老一条记录早于今天 0 点（翻过了午夜线，今天必已完整），或整个窗口本就无记录。
  // 翻不过去（今天调用暴涨超出估计）或拉页失败 → 返回 null，走全量重翻。
  const topupToday = async (cookie, hit) => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const start = new Date(todayStart)
    start.setDate(start.getDate() - TREND_WINDOW_DAYS)
    const startIso = start.toISOString()
    const endIso = new Date().toISOString()
    const pages = Math.min(TREND_MAX_PAGES, Math.ceil((hit.data.daily ? hit.data.daily.calls : 0) / DAILY_LOG_PAGE_SIZE) + 1)
    const temp = new Map()
    let oldest = Infinity
    let ok = true
    for (let p = 1; p <= pages; p++) {
      const j = await fetchLogPage(cookie, p, startIso, endIso)
      if (j === null) { ok = false; break }
      const d = unwrapEnvelope(j)
      const list = isObj(d) && Array.isArray(d.list) ? d.list : []
      oldest = Math.min(oldest, ingestInto(temp, list))
      if (list.length < DAILY_LOG_PAGE_SIZE) break
    }
    if (!ok) return null
    const todayKey = todayStart.toDateString()
    if (oldest === Infinity || oldest < todayStart.getTime()) {
      // 已越过今天 0 点（或窗口内根本没有记录）：今天的桶可信，直接换新；
      // 今天的调用/花费由此恢复完整，dailyPartial 解除。
      const tb = temp.get(todayKey)
      if (tb) hit.buckets.set(todayKey, tb)
      else hit.buckets.delete(todayKey)
    } else {
      return null
    }
    hit.data = {
      ...hit.data,
      daily: dailyFromBuckets(hit.buckets, todayStart),
      dailyPartial: false,
    }
    hit.ts = Date.now()
    return hit.data
  }

  // 「当日使用」数据源：按天把 call-logs 的当日调用聚成桶，再把今天 0 点起的那个桶
  // 取出来给余额页。翻页逻辑（早停判据 / 缺页如实截断）沿用原趋势图那套，因为
  // 「今天到此刻花了多少」同样要求今天的记录拉全。
  // 注意：翻页只为「当日」这一个数字服务；超过窗口的页面不会再拉。
  const fetchUsageTrendFull = async (cookie, cacheKey) => {
    const start = new Date()
    start.setDate(start.getDate() - TREND_WINDOW_DAYS)
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    const startIso = start.toISOString()
    const endIso = end.toISOString()
    // 按需建桶（有记录的日子才有桶）；models 字段已无人消费（趋势图删了），
    // 但 ingestInto 顺手套一层成本为零，留着不影响正确性。
    const buckets = new Map()
    let oldestSeen = Infinity
    let fetchedCount = 0 // 只当计数用：不把最多 6000 条原始记录整个攥在内存里
    let pageFailed = false
    // 第一页失败不可静默：最新的 100 条（通常就是今天）缺了、更早的页面照常灌桶，
    // 早停判据照样成立——会得到「完整却缺了今天」的当日数字。宁可整体失败，
    // 让当日卡显示 —，也不装完整。
    const first = await fetchLogPage(cookie, 1, startIso, endIso)
    if (first === null) throw new Error('call-logs 第一页拉取失败')
    const firstData = unwrapEnvelope(first)
    const firstList = isObj(firstData) && Array.isArray(firstData.list) ? firstData.list : []
    const total = isObj(firstData) && Number.isFinite(Number(firstData.total)) ? Number(firstData.total) : 0
    fetchedCount += firstList.length
    oldestSeen = Math.min(oldestSeen, ingestInto(buckets, firstList))
    // 完整性判据：非空日凑满 TREND_DAYS 个、且已见最老记录早于其中第 TREND_DAYS
    // 新的 0 点（那天已完整，因而今天也完整）；或 90 天窗口内记录已全部拉取；
    // 或窗口内本就无记录（第一页成功且空、total=0，不算截断）。
    // 任一页拉取失败则永不判完整：缺页的数据不能冒充全量。
    const emptyWindow = firstList.length === 0 && total === 0
    const completenessNeed = () => {
      const active = [...buckets.values()].filter((b) => b.calls > 0).sort((a, b) => b.t - a.t)
      return active.length >= TREND_DAYS ? active[TREND_DAYS - 1].t : null
    }
    const complete = () => {
      if (pageFailed) return false
      if (emptyWindow) return true
      const need = completenessNeed()
      if (need !== null && oldestSeen < need) return true
      return total > 0 && fetchedCount >= total
    }
    for (let p = 2; p <= TREND_MAX_PAGES && !complete(); p += TREND_BATCH) {
      const batch = []
      for (let q = p; q < p + TREND_BATCH && q <= TREND_MAX_PAGES; q++) batch.push(q)
      const parts = await Promise.all(batch.map((pg) => fetchLogPage(cookie, pg, startIso, endIso)))
      let any = false
      for (const j of parts) {
        if (j === null) { pageFailed = true; continue }
        const d = unwrapEnvelope(j)
        if (isObj(d) && Array.isArray(d.list) && d.list.length > 0) {
          fetchedCount += d.list.length
          oldestSeen = Math.min(oldestSeen, ingestInto(buckets, d.list))
          any = true
        }
      }
      if (pageFailed || !any) break // 缺页要如实截断；整批无数据=越界/异常，后续页不会再有新记录
    }
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const result = {
      daily: dailyFromBuckets(buckets, todayStart),
      dailyPartial: pageFailed,
    }
    trendCaches.set(cacheKey, { data: result, ts: Date.now(), buckets })
    // 简单防膨胀：账号数远小于上限，超限清理最旧的一个即可。
    if (trendCaches.size > 12) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of trendCaches) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
      }
      if (oldestKey !== null) trendCaches.delete(oldestKey)
    }
    return result
  }

  // 入口：60s 内直接吃缓存；60s~5min 只补拉今天；超 5min（或补拉失败）全量重翻。
  const fetchUsageTrend = async (cookie) => {
    const cacheKey = state.activeAccount || '_'
    const hit = trendCaches.get(cacheKey)
    if (hit) {
      const age = Date.now() - hit.ts
      if (age < TREND_TOPUP_TTL_MS) return hit.data
      if (age < TREND_TTL_MS) {
        const topped = await topupToday(cookie, hit).catch(() => null)
        if (topped !== null) return topped
      }
    }
    return fetchUsageTrendFull(cookie, cacheKey)
  }

  // ---- 「用量」页签上游（0.5.5）----
  // 两个来源分工：
  //   1) /api/usage/panel?range=30d —— 一次请求拿到 30 天汇总、按模型、按客户端。
  //      它不支持任何按天参数（实测 groupBy/startAt/endAt/dimension 全被忽略，
  //      响应与不带时逐字节相同），所以日历的按天数据不能问它；而且它的游标翻页
  //      第 3 页起必然 503，想靠翻 items 拼出 30 天要约 99 个请求。
  //   2) /api/usage-daily —— 一次请求拿到 date × model × Key × clientApp 的扁平行，
  //      分桶即得 30 天日历每格的数据。
  //
  // 请求量控制：整个页签只需 **2 个请求**。早期方案是「一天一个 call-logs 窗口」，
  // 要 30 个请求，既慢又容易触发平台限流（约每 3 个请求 503 一次，还要挂 5s），
  // 已废弃。
  const usageCaches = new Map() // activeAccount -> { data, ts }

  const fetchUsagePanel = async (cookie) => {
    const path = TOKENRHYTHM_BASE + '/api/usage/panel?range=' + USAGE_RANGE + '&page=1&pageSize=' + USAGE_DAY_PAGE_SIZE
    const res = await fetchRetrying(path, { headers: trHeaders(cookie, state.csrf) }).catch(() => null)
    if (res === null || !res.ok) return null
    return await res.json().catch(() => null)
  }

  // /api/usage-daily：**日历的数据源**。data 是 date × modelId × apiKeyId ×
  // clientApp 的扁平行，按 date 分桶即得每天的调用数/花费/模型明细。
  // 实测它的 range/startDate/endDate/page/pageSize 全部被忽略（怎么传都回同样
  // 122 行），所以不带参数、固定拿一整份近 8 周明细，在 normalizeUsageDaily 里
  // 自行截到最近 30 天。
  // 限流比 panel 凶：探测时首个请求 503 挂了 6.5s，因此退避拉长到 1.5s/3.5s/7s。
  const fetchUsageDaily = async (cookie) => {
    const path = TOKENRHYTHM_BASE + '/api/usage-daily'
    const res = await fetchRetrying(path, { headers: trHeaders(cookie, state.csrf) }, [1500, 3500, 7000]).catch(() => null)
    if (res === null || !res.ok) return null
    return await res.json().catch(() => null)
  }

  const fetchUpstreamUsage = async (cookie) => {
    const cacheKey = state.activeAccount || '_'
    const hit = usageCaches.get(cacheKey)
    if (hit && Date.now() - hit.ts < USAGE_TTL_MS) return hit.data

    // 两个接口并发：panel 取汇总/按模型/按客户端，usage-daily 取日历按天明细。
    // 合计 2 个请求就能画完整个页签（曾按天逐日打 30 个，其实完全没必要——
    // usage-daily 的 data 本身就是按天铺开的扁平行）。
    const panelP = fetchUsagePanel(cookie)
    const dailyP = fetchUsageDaily(cookie)
    const [panelJson, dailyJson] = await Promise.all([panelP, dailyP])
    // panel 是页签主体，失败即整体失败；daily 失败则日历那一块留空，其余照常展示。
    if (panelJson === null) {
      const err = new Error('usage panel 上游无响应')
      err.status = 502
      throw err
    }
    const panel = normalizeUsagePanel(panelJson)
    const daily = normalizeUsageDaily(dailyJson, new Date())
    const out = {
      ...panel,
      daily,
      meta: {
        ...panel.meta,
        ...daily.meta,
        range: USAGE_RANGE,
        fetchedAt: Date.now(),
        // 交叉校验：日历窗口合计 vs panel 汇总。实测两者逐位相同（¥242.49619028），
        // 万一哪天平台改口径出现差值，界面据此如实说明而不是悄悄用其中一个。
        crossCheck: {
          dailyCalls: daily.days.reduce((a, d) => a + d.calls, 0),
          dailyCostCny: Math.round(daily.days.reduce((a, d) => a + d.costCny, 0) * 1e8) / 1e8,
          panelCalls: panel.summary.calls,
          panelCostCny: panel.summary.costCny,
        },
      },
    }
    usageCaches.set(cacheKey, { data: out, ts: Date.now() })
    if (usageCaches.size > 8) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of usageCaches) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
      }
      if (oldestKey !== null) usageCaches.delete(oldestKey)
    }
    return out
  }

  // ---- 平台请求统一头：实测网关对无 UA 的请求偶发 504，带上浏览器式头更稳。
  // 变更请求（POST/DELETE…）平台还做 CSRF 双提交 + fetch-metadata 校验：
  // 需 Origin/Sec-Fetch-*（浏览器自动带，node fetch 必须手动补）与
  // X-CSRF-Token（值 = tr_csrf cookie，随会话下发），缺失即 403 CSRF_INVALID。----
  const trHeaders = (cookie, csrf) => ({
    Cookie: csrf ? 'tr_session=' + cookie + '; tr_csrf=' + csrf : 'tr_session=' + cookie,
    Accept: 'application/json',
    'Content-Type': 'application/json', // 变更类请求 body 是 JSON 串；缺它平台按 text/plain 解析 → 400 请求参数类型错误
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: TOKENRHYTHM_BASE + '/account',
    Origin: TOKENRHYTHM_BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  })

  // ---- 账号密码登录平台（密码只在本次请求内存中出现）----
  const loginOnPlatform = async (account, password) => {
    let res
    try {
      res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ account, password }),
      })
    } catch (err) {
      return { ok: false, error: '登录请求失败：' + String((err && err.message) || err) }
    }
    if (res.status === 401) return { ok: false, error: '账号或密码错误' }
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json()
        if (isObj(j) && typeof j.message === 'string') detail = j.message
      } catch { /* 非 JSON 错误体 */ }
      return { ok: false, error: '登录失败（平台 ' + res.status + '）' + (detail ? '：' + detail : '') }
    }
    let cookie = ''
    let csrf = ''
    try {
      const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
      for (const line of cookies) {
        const m = /tr_session=([^;\s]+)/.exec(line)
        if (m !== null) cookie = m[1]
        const c = /tr_csrf=([^;\s]+)/.exec(line)
        if (c !== null) csrf = c[1]
      }
    } catch { /* 取不到 Set-Cookie → 按失败处理 */ }
    if (cookie === '') return { ok: false, error: '登录成功但未返回会话，请改用粘贴方式' }
    return { ok: true, cookie, csrf }
  }

  // ---- 逐笔限时额度（/api/wallet/expiring-credits，page/pageSize 分页）。----
  // 任一页失败按「首页前失败 → null（回退深扫）/ 中途失败 → 已得条目」降级，
  // 不阻塞余额主数据。
  const EXPIRING_PAGE_SIZE = 50
  const EXPIRING_MAX_PAGES = 5
  // 资金明细单页条数：明细区块一次展示全部来源（充值本金 + 每笔赠送），
  // pageSize 给大些省得翻页；平台实测 20~50 都正常返回。
  const WALLET_PAGE_SIZE = 50
  const fetchExpiringCredits = async (cookie) => {
    const headers = trHeaders(cookie)
    const merged = []
    for (let page = 1; page <= EXPIRING_MAX_PAGES; page++) {
      const res = await fetchWithTimeout(
        TOKENRHYTHM_BASE + '/api/wallet/expiring-credits?page=' + page + '&pageSize=' + EXPIRING_PAGE_SIZE,
        { headers },
      ).catch(() => null)
      const body = res !== null && res.ok ? await res.json().catch(() => null) : null
      const list = body && isObj(body.data) && Array.isArray(body.data.list) ? body.data.list : []
      if (res === null || !res.ok) return page === 1 ? null : { data: { list: merged } }
      merged.push(...list)
      const total = isObj(body.data) && Number.isFinite(Number(body.data.total)) ? Number(body.data.total) : 0
      if (list.length === 0 || merged.length >= total) break
    }
    return { data: { list: merged } }
  }

  // 资金明细拉取：仍按全量要（includeInactive=true），但**展示层**已把已用完的行滤掉
  // （2026-10-20 定稿，见 render 处 stillUsable）。这里不改成「只取 ACTIVE」的原因：
  // 平台的 inactive 口径未知，万一它顺手过滤掉「状态字缺失但还有钱」的行，就白丢可用额度；
  // 宁可多要几条回来自己判。悬停时间线那边仍走 normalizeExpiringCredits 自己的过滤口径
  // （只看 remaining>0 且有到期时间的）。
  const fetchWalletCredits = async (cookie) => {
    const headers = trHeaders(cookie)
    const res = await fetchWithTimeout(
      TOKENRHYTHM_BASE + '/api/wallet/expiring-credits?page=1&pageSize=' + WALLET_PAGE_SIZE + '&includeInactive=true',
      { headers },
    ).catch(() => null)
    if (res === null || !res.ok) return null
    return await res.json().catch(() => null)
  }

  const fetchUpstreamBalance = async (cookie, retried) => {
    const headers = trHeaders(cookie)
    const [summaryRes, meRes, expiring, wallet, rn] = await Promise.all([
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers }),
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers }).catch(() => null),
      fetchExpiringCredits(cookie),
      fetchWalletCredits(cookie).catch(() => null),
      // 实名状态搭车余额轮询（0.6.2）：fetchRealname 自带 5 分钟缓存 + 失败回退，
      // 这里 .catch 只防实现意外的同步抛错，不影响余额主链。
      fetchRealname(cookie).catch(() => null),
    ])
    if (summaryRes.status === 401 || (meRes !== null && meRes.status === 401)) {
      // 会话过期：用当前绑定账号自动重登一次（无绑定/重登失败 → 维持原报错），
      // 成功后用新 cookie 整体重试（retried 防递归）。
      if (retried !== true && (await reloginActive())) return fetchUpstreamBalance(state.cookie, true)
      const err = new Error('session expired')
      err.code = 'SESSION_EXPIRED'
      throw err
    }
    if (!summaryRes.ok) {
      const err = new Error('usage-summary 上游 ' + summaryRes.status)
      err.status = summaryRes.status
      throw err
    }
    const summary = await summaryRes.json().catch(() => null)
    const me = meRes !== null && meRes.ok ? await meRes.json().catch(() => null) : null
    // 只留「当日使用」所需的当日桶（call-logs 翻页）。趋势图与最近调用已在 0.5.5
    // 从界面移除——30 天体量都在「用量」页签，这里再翻几十页纯属浪费请求
    // （平台约每 3 个请求就 503 一次，还要挂 5s）。
    const trendAll = await fetchUsageTrend(cookie).catch(() => null)
    return {
      ...normalizeBalance(summary, me, expiring),
      daily: trendAll ? trendAll.daily : null,
      trendMeta: trendAll ? {
        dailyPartial: !!trendAll.dailyPartial,
      } : null,
      wallet: wallet === null ? null : normalizeWalletCredits(wallet),
      realname: rn,
    }
  }

  // Cookie 模式账户名缓存：manifest / session 路由标注「数据账号」用。
  // 以 cookie 为键（换会话自动失效），TTL 10 分钟；请求失败静默返回 null，
  // 前端回退「未登录（Cookie 模式）」文案——标注用途，宁可缺不阻塞。
  const meAccount = { cookie: '', name: null, ts: 0 }
  const ME_ACCOUNT_TTL_MS = 10 * 60 * 1000
  const fetchMeAccountName = async (cookie) => {
    if (cookie === '') return null
    if (meAccount.cookie === cookie && meAccount.name && Date.now() - meAccount.ts < ME_ACCOUNT_TTL_MS) return meAccount.name
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers: trHeaders(cookie) })
      if (!res.ok) return null
      const name = accountNameFromMe(await res.json().catch(() => null))
      if (name === '') return null
      meAccount.cookie = cookie
      meAccount.name = name
      meAccount.ts = Date.now()
      return name
    } catch { return null }
  }

  // 实名认证状态（/api/me/identity-verification，0.6.2）：余额页页首与设置页当前
  // 账号行的实名徽章数据源。每 cookie 缓存 5 分钟（换号自动失效）；请求失败回
  // 陈旧值、无可回退返 null——徽章宁可缺不编，且绝不阻塞余额主链。
  const realnameCache = { cookie: '', data: null, ts: 0 }
  const REALNAME_TTL_MS = 5 * 60 * 1000
  const fetchRealname = async (cookie) => {
    if (cookie === '') return null
    const fresh = realnameCache.cookie === cookie && realnameCache.data !== null
      && Date.now() - realnameCache.ts < REALNAME_TTL_MS
    if (!fresh) {
      try {
        const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me/identity-verification', { headers: trHeaders(cookie) })
        const body = res.ok ? await res.json().catch(() => null) : null
        const rn = realnameFromIdentity(body)
        if (rn !== null) {
          realnameCache.cookie = cookie
          realnameCache.data = rn
          realnameCache.ts = Date.now()
        }
      } catch { /* 失败保留陈旧值，走下面的回退 */ }
    }
    return realnameCache.cookie === cookie ? realnameCache.data : null
  }

  // ---- 会话验活（区别于 fetchMeAccountName 的名字缓存：只认实时 200）。
  // 成功结果缓存 60 秒，manifest 每次打开不必都打平台；失败不缓存，可立即重试。----
  let sessionProbeCache = { cookie: '', valid: false, name: null, ts: 0 }
  const PROBE_TTL_MS = 60 * 1000
  const probeSession = async (cookie) => {
    if (cookie === '') return { valid: false, name: null }
    if (sessionProbeCache.cookie === cookie && Date.now() - sessionProbeCache.ts < PROBE_TTL_MS) {
      return { valid: sessionProbeCache.valid, name: sessionProbeCache.name }
    }
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers: trHeaders(cookie) })
      if (res.status !== 200) return { valid: false, name: null }
      const name = accountNameFromMe(await res.json().catch(() => null))
      const out = { valid: name !== '', name: name || null }
      if (out.valid) sessionProbeCache = { cookie, valid: true, name: out.name, ts: Date.now() }
      return out
    } catch { return { valid: false, name: null } }
  }

  // ---- 会话自动续期：cookie 失效（401）时用「当前绑定账号」的已存密码重登一次。
  // 绑定由 /session 粘贴时对齐（matchAccountName），不存在绑定绝不自动重登；
  // 30 秒冷却防平台故障时反复打登录接口。成功更新 cookie/csrf/activeAccount 并落盘。----
  let lastReloginAt = 0
  const RELOGIN_COOLDOWN_MS = 30 * 1000
  const reloginActive = async () => {
    loadState()
    if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return false
    const acc = pickReloginAccount(state)
    if (acc === null) return false
    lastReloginAt = Date.now()
    const r = await loginOnPlatform(acc.account, acc.password)
    if (!r.ok) return false
    state.cookie = r.cookie
    if (r.csrf) state.csrf = r.csrf
    state.activeAccount = acc.account
    saveState()
    return true
  }

  // ---- 「当前使用的基元密钥」→ 账号 → 账户余额（对话头部角标，v0.7.3）----
  // 与阶跃「套餐」、OpenCSG「账户余额」两枚同格位、同手法，口径也同一句：角标描述的是
  // **DSH 真正在用的那把 key** 背后的账号（所以本地 key 走 file-first 的
  // activeCredentialKey，理由见它上方的分层说明；resolveKey 的 env-first 在角标链上禁用）。
  // 基元与那两家的**结构性差别**只有一条：基元**只有一个活会话**（state.cookie 单槽，
  // 切号 = 重新登录把它覆盖掉，没有 sessions 分槽可并存）。所以「这把 key 属于哪个账号」
  // 没法像阶跃/OpenCSG 那样逐账号反查——那要为池里每个账号真登一次，是这条链上最贵、
  // 也最容易触发平台风控的一步。能问的只有眼前这个会话：**它的**密钥列表里有没有这把 key。
  // 三种结论，处理各不相同：
  //   · hit     归属坐实：角标就是这把 key 背后的账号的账，悬停列出密钥名；
  //   · miss    列表读到了、里面没这把：DSH 在用的 key 大概属于另一个账号。余额**照旧
  //             显示**（它确实是本机绑定账号的账，面板余额页里同一个数，不是编的），
  //             悬停多一行说明归属对不上——既不藏主读数，也不假装对得上；
  //   · unknown 列表压根没读到（网络/会话）：只字不提归属。私下的诊断结论不该把主读数
  //             拖下水（「拿不到就 —，绝不编 0」的延伸）。
  // 余额取数**另走一个轻量口**：角标只要 usage-summary 一个请求，不跟 /balance 那份六请求
  // 重载荷（usage-summary + me + 限时额度 + 钱包 + 实名 + call-logs 翻页）混在一起——那份
  // 是面板与入口胶囊的，动它会连累它们，而且翻页那步在平台上约每三个请求就 503 一次。
  const TR_KEYMODE_TTL_MS = 10 * 60 * 1000 // 归属匹配：与阶跃/OpenCSG 同为 10 分钟
  const TR_LIGHTBAL_TTL_MS = 5 * 60 * 1000 // 余额快照：与入口胶囊那份同为 5 分钟
  const trKeyModeCache = new Map() // fp -> { ts, mode }（负结论也缓存：同一把 key 不必反复问）
  const trLightBal = { cookie: '', data: null, ts: 0 }
  let trLightBalTask = null // 单飞：{ cookie, p }
  // 指纹只留长度与头尾几个字符：它是 Map 的键，不该把明文 key 长期驻留在内存里。
  const trKeyFp = (key) => key.length + '#' + key.slice(0, 6) + '#' + key.slice(-4)
  const trNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  /** 轻量余额快照：只打 /api/usage-summary 一个口，读数交给同一个 normalizeBalance
   *  （与面板/胶囊同一把尺，绝不在角标这条路上另写一套取数）。401 用绑定账号自愈重登
   *  一次再重放——先重登、再用新 cookie 重放，不并发（同 fetchUpstreamBalance 的保序）。 */
  const trLightBalanceFetch = async (cookie) => {
    try {
      let res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers: trHeaders(cookie) })
      if (res.status === 401 && (await reloginActive())) {
        res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers: trHeaders(state.cookie) })
      }
      if (res.status === 401) return { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期（面板 → 余额 → 重新登录）' }
      if (!res.ok) return { ok: false, code: 'UPSTREAM_ERROR', error: '平台返回 ' + res.status }
      const b = normalizeBalance(await res.json().catch(() => null), null, null)
      return {
        ok: true,
        balanceCny: trNum(b.balanceCny),
        availableBalanceCny: trNum(b.availableBalanceCny),
        frozenBalanceCny: trNum(b.frozenBalanceCny),
        expiringBalanceCny: trNum(b.expiringBalanceCny),
        nextExpiryAt: b.nextExpiryAt || null,
      }
    } catch (err) {
      return { ok: false, code: 'UPSTREAM_ERROR', error: String((err && err.message) || err) }
    }
  }

  const fetchTrLightBalance = async (cookie, force) => {
    const hit = trLightBal.cookie === cookie && trLightBal.data !== null
      ? { data: trLightBal.data, ts: trLightBal.ts } : null
    if (force !== true && hit !== null && Date.now() - hit.ts < TR_LIGHTBAL_TTL_MS) {
      return { ok: true, ...hit.data, cached: true, atMs: hit.ts }
    }
    // 单飞：轮末刷新与 5 分钟轮询撞在一起时，平台只被问一次（同一 cookie 才算同一件事）
    const running = trLightBalTask
    if (running !== null && running.cookie === cookie) return running.p
    const task = { cookie, p: null }
    task.p = (async () => {
      try {
        const r = await trLightBalanceFetch(cookie)
        if (r.ok !== true) {
          // 取失败而手上有旧值 → 旧值照旧上屏（悬停的时间戳会说实话），不把已显示的数抹掉
          return hit === null ? r : { ok: true, ...hit.data, cached: true, stale: true, error: r.error, atMs: hit.ts }
        }
        const atMs = Date.now()
        trLightBal.cookie = cookie
        trLightBal.data = r
        trLightBal.ts = atMs
        return { ok: true, ...r, atMs }
      } finally {
        if (trLightBalTask === task) trLightBalTask = null
      }
    })()
    trLightBalTask = task
    return task.p
  }

  /** 这把 key 在本机绑定账号的密钥列表里吗。只回结论，掩码/明文一概不回（隐私口径）。
   *  读不到列表 → unknown，且**不缓存**：一次网络抖动不该被记住 10 分钟。 */
  const fetchTrKeyMode = async (key, fp, force) => {
    if (force !== true) {
      const hit = trKeyModeCache.get(fp)
      if (hit !== undefined && Date.now() - hit.ts < TR_KEYMODE_TTL_MS) return hit.mode
    }
    loadState()
    if (state.cookie === '') return { mode: 'unknown' }
    try {
      let up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
      if (up.status === 401 && (await reloginActive())) {
        up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
      }
      if (!up.ok) return { mode: 'unknown' }
      const keys = normalizePlatformKeys(await up.json().catch(() => null))
      const found = keys.find((k) => trKeyMatchesPlatform(key, k)) || null
      const mode = found === null
        ? { mode: 'miss' }
        : { mode: 'hit', match: { keyName: found.name, keyId: found.id } }
      trKeyModeCache.set(fp, { ts: Date.now(), mode })
      return mode
    } catch { return { mode: 'unknown' } }
  }

  /** 角标载荷：只带角标要用的字段（密钥名/ID + 五个读数 + 时间）。
   *  identifier（手机号/邮箱）、明文、掩码一概不出门——与阶跃 key-plan、OpenCSG
   *  key-account 同一个隐私口径（界面上出现手机号这件事，用户此前已点名否掉）。 */
  const trKeyBalancePayload = (providerId, mode, snap) => {
    const acc = snap !== null && snap.ok === true
      ? {
        balanceCny: trNum(snap.balanceCny),
        availableBalanceCny: trNum(snap.availableBalanceCny),
        frozenBalanceCny: trNum(snap.frozenBalanceCny),
        expiringBalanceCny: trNum(snap.expiringBalanceCny),
        nextExpiryAt: snap.nextExpiryAt || null,
        atMs: typeof snap.atMs === 'number' ? snap.atMs : null,
        stale: snap.stale === true,
      }
      : null
    return {
      ok: true,
      providerId,
      // 只有归属坐实时才摆密钥名（与阶跃/OpenCSG 同一规矩：没归属就不摆名字）
      key: mode !== null && mode.mode === 'hit' ? mode.match : null,
      keyLookup: mode !== null ? mode.mode : 'unknown',
      account: acc,
      accountError: acc === null ? ((snap && snap.error) || '基元余额暂不可用') : null,
    }
  }

  /** 对话头部角标取数：DSH 在用的基元 key → 本机绑定账号的密钥表核对 → 账户余额。
   *  force=1   密钥/账号刚动过 → 归属匹配表与余额快照都重来；
   *  refresh=1 一轮对话结束 → 只绕余额那 5 分钟，归属匹配照旧命中（轮末走这档）；
   *  provider  会话在用的基元 provider id（客户端带上来，只有角标组件读得到会话的模型选择）。
   *  为什么非要它：基元的 provider 可以是**多枚共用同一个 baseURL 的短键**——本机实测就有
   *  `jy`(基元) 与 `jy131`(基元1) 两枚都指向 tokenrhythm.studio。`find(balanceCapable)` 只会
   *  命中名册里第一枚，于是第二枚的会话：① 核对归属用的是别人的 apiKeyEnv（核错钥匙）；
   *  ② 回给客户端的 providerId 对不上会话在用的那个，角标整枚不出现。带了只认它。 */
  const fetchTrKeyBalance = async (force, refresh, wantProviderId) => {
    loadState()
    const { providers } = readProviders()
    // 查哪一枚 provider 只有 trResolveProvider 一处判据（点名只认它 / 点名不是基元就地拒答 /
    // 没点名退回第一枚）。拒答分支**排在下面读会话与钥匙之前**：非基元会话问一句必须零副作用
    // （一次上游都不打，更不能走到那条会用绑定账号自动重登的链上）。
    const picked = trResolveProvider(providers, wantProviderId)
    if (picked.denied) {
      const w = picked.wanted || {}
      return {
        ok: false, code: 'NO_PROVIDER', providerId: '',
        error: '当前 provider（' + asStr(w.id) + '）不是基元：baseURL ' + (asStr(w.baseURL) || '未配置'),
      }
    }
    const tp = picked.provider
    if (tp === null) {
      return { ok: false, code: 'NO_PROVIDER', providerId: '', error: '设置里没有基元 provider（baseURL 含 tokenrhythm）' }
    }
    const providerId = typeof tp.id === 'string' ? tp.id : ''
    // 没有会话就到此为止，**绝不往下走**：下面的取数遇 401 会用绑定账号自动重登（与面板
    // 余额同款自愈），而用户刚刚点过「清除会话」时那一步会把他清掉的会话悄悄登回来。
    // 未配置会话是「没有账可读」，不是「会话过期了」——两者不能混。
    if (state.cookie === '') {
      return { ok: false, code: 'NO_SESSION', providerId, error: '未配置基元会话（面板 → 余额 → 粘贴 Cookie）' }
    }
    const key = activeCredentialKey(tp.apiKeyEnv).key
    if (key === '') {
      return {
        ok: false, code: 'NO_KEY', providerId,
        error: tp.apiKeyEnv === ''
          ? '基元 provider 没配 apiKeyEnv，读不到本机在用的 key'
          : '未读到 ' + tp.apiKeyEnv + ' 的值（env 与 ~/.dsh/.credentials.yaml 都没有）',
      }
    }
    if (force === true) trKeyModeCache.clear()
    // 余额先问：它才是主读数，而 401 的自愈重登也在这条路上完成——先重登、再核对归属，
    // 两条链就不会各登一次（顺序反了就是两个 401 抢一次 30 秒冷却，必有一个被挡回）。
    const snap = await fetchTrLightBalance(state.cookie, force === true || refresh === true)
    const mode = await fetchTrKeyMode(key, trKeyFp(key), force === true)
    return trKeyBalancePayload(providerId, mode, snap)
  }

  // ---- shared HTTP helpers（同音乐插件）----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }
  /**
   * 跨站判定：本插件的 23 条路由都是裸的（宿主 dsh-host-webserver 只暴露 getOrigin()，
   * 没有统一 CSRF 防护）。读类接口因响应不带 Access-Control-Allow-Origin 被浏览器 CORS
   * 挡住，但写类接口（/accounts/remove、/keys/forget、/keys/create、/prefs、/redeem、
   * /update/ignore）会被盲打 CSRF 生效——副作用已经落地，攻击者只是看不到回包。
   *
   * 放行规则（fail-open）：
   *   无 Sec-Fetch-Site 头 → 放行。curl / Node 脚本 / 旧 WebView 都不带这个头，
   *                         fail-closed 会直接把它们的正常调用打断。
   *   same-origin / none → 放行（DSH 桌面端与 Web 端都同源访问 127.0.0.1:PORT）。
   *   cross-site / same-site → 403。
   *
   * 这是防浏览器跨站，不是认证；真正的凭据校验仍由各路由自身的会话逻辑负责。
   */
  const isSameOriginRequest = (req) => {
    const site = String((req && req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
    if (site === '') return true
    return site === 'same-origin' || site === 'none'
  }

  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname      // 跨站一律拦在路由分发之前：一处覆盖全部 23 条路由，不必逐条改 handler。
      if (!isSameOriginRequest(req)) {
        writeJson(res, { ok: false, error: 'forbidden' }, 403)
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/manifest' && req.method === 'GET') {
        loadState()
        const { providers, error } = readProviders()
        // 用户指定：面板只保留基元律动（tokenrhythm）的内容。
        const visible = providers.filter((p) => p.balanceCapable)
        // 数据账号标注：账号密码模式 activeAccount 是登录手机号，界面上应显示
        // 平台用户名，因此有会话 Cookie 时两种模式都取带缓存的 /api/me 账户名
        // （accountName；失败静默 → 前端回退 account / Cookie 模式文案）。
        // account 保留登录标识（手机号）：设置页账号列表的「当前」徽标靠它比对。
        const meName = state.cookie !== '' ? await fetchMeAccountName(state.cookie) : null
        const sessionAccount = state.activeAccount || meName || null
        // 会话验活：401 先按绑定账号自动重登再验（打开面板即自愈）。
        let probe = state.cookie !== '' ? await probeSession(state.cookie) : { valid: false, name: null }
        if (state.cookie !== '' && !probe.valid && (await reloginActive())) probe = await probeSession(state.cookie)
        // 实名徽章数据源（0.6.2）：开面板即有——余额页页首与设置页当前账号行的首帧
        // 从这里兜底，余额路由每 60s 轮询带新值。放 relogin 之后：重登换的新 cookie
        // 直接用；失败/无会话 → null（徽章不渲染，宁缺不编）。
        const realname = state.cookie !== '' ? await fetchRealname(state.cookie) : null
        writeJson(res, {
          ok: true,
          version: PKG_VERSION,
          // 启用的系统随 manifest 一起回（客户端首包播种 provider 要用，别等 /prefs 那一包）
          systems: systemsOf(state.prefs),
          // 「设置 → 系统管理」里拖出来的顺序，随首包一起回（客户端播种切换器 / 分组页签要用）
          sysOrder: sysOrderOf(state.prefs),
          providers: visible.map((p) => {
            const key = resolveKey(p)
            return {
              id: p.id,
              displayName: p.displayName,
              baseURL: p.baseURL,
              apiKeyEnv: p.apiKeyEnv,
              hasKey: key !== '',
              keyHint: maskSecret(key),
              balanceCapable: p.balanceCapable,
              modelCount: p.models.length,
            }
          }),
          session: { configured: state.cookie !== '', valid: probe.valid, hint: maskSecret(state.cookie), account: sessionAccount || null, accountName: meName || null, realname },
          error,
        })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/models' && req.method === 'GET') {
        const providerId = url.searchParams.get('provider') || ''
        const { providers } = readProviders()
        // 同 /key：只允许用基元的 key 拉模型列表，否则等于借本插件用别家 key 出网。
        const provider = providers.find((p) => p.id === providerId && p.balanceCapable === true)
        if (!provider) { writeJson(res, { ok: false, code: 'NO_PROVIDER', error: '未找到提供商: ' + providerId }, 404); return }
        if (provider.baseURL === '') { writeJson(res, { ok: false, code: 'NO_BASE_URL', error: '该提供商未配置 baseURL' }, 409); return }

        // 峰谷分时计价表：公开接口、与模型列表解耦，五种成功路径都随响应下发，
        // 客户端按模型 ID 查表决定要不要画「峰谷」徽章。拉取失败只丢徽章，不丢列表。
        // 先发起 Promise 不 await：与下面的模型列表拉取并发，不为峰谷表多付一次串行
        // 延迟（两个接口各自 15s 超时，串行最坏要等 30s）。
        const schedP = fetchPriceSchedules()
        const withSched = async (payload) => {
          const sched = (await schedP) || { schedules: {}, asOf: '' }
          return { ...payload, schedules: sched.schedules, schedulesAsOf: sched.asOf }
        }

        // 首选平台模型列表（/api/models，会话 Cookie）：带分类/模态/显示名。
        // 401（会话过期）或失败时静默回退到网关 /v1/models（API Key，无分类）。
        loadState()
        if (state.cookie !== '') {
          const hit = modelsCache.get(provider.id)
          if (hit !== undefined && hit.source === 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
            writeJson(res, await withSched({ ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'platform' }))
            return
          }
          try {
            const res2 = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/models', { headers: { Cookie: 'tr_session=' + state.cookie } })
            if (res2.ok) {
              const models = normalizePlatformModels(await res2.json().catch(() => null))
              const categories = categoryCounts(models)
              modelsCache.set(provider.id, { models, categories, source: 'platform', ts: Date.now() })
              writeJson(res, await withSched({ ok: true, provider: provider.id, models, cached: false, categories, source: 'platform' }))
              return
            }
          } catch { /* 平台接口不可用 → 走网关兜底 */ }
        }

        const key = resolveKey(provider)
        if (key === '') {
          writeJson(res, { ok: false, code: 'NO_KEY', error: '未读到 ' + provider.apiKeyEnv + '（env 与 ~/.dsh/.credentials.yaml 都没有）' }, 409)
          return
        }
        const hit = modelsCache.get(provider.id)
        if (hit !== undefined && hit.source !== 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
          writeJson(res, await withSched({ ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'gateway' }))
          return
        }
        try {
          const models = await fetchUpstreamModels(provider, key)
          modelsCache.set(provider.id, { models, source: 'gateway', ts: Date.now() })
          writeJson(res, await withSched({ ok: true, provider: provider.id, models, cached: false, source: 'gateway' }))
        } catch (err) {
          // 上游失败但有过期缓存：宁可给旧数据也别白屏。
          if (hit !== undefined && hit.source !== 'platform') { writeJson(res, await withSched({ ok: true, provider: provider.id, models: hit.models, cached: true, stale: true, source: 'gateway' })); return }
          writeJson(res, { ok: false, code: err.code || 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, err.status && err.status >= 400 ? err.status : 502)
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/balance' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未配置网页会话 Cookie' }); return }
        try {
          const balance = await fetchUpstreamBalance(state.cookie)
          writeJson(res, { ok: true, ...balance })
        } catch (err) {
          if (err && err.code === 'SESSION_EXPIRED') {
            writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期，请到「设置」页签重新粘贴 Cookie' })
            return
          }
          writeJson(res, { ok: false, code: 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, 502)
        }
        return
      }


      // 「用量」页签：panel（汇总/按模型/按客户端）+ usage-daily（日历按天）。
      // 合计 2 个上游请求，结果按账号缓存 60s。
      if (pathname === '/dsh-tokenrhythm-bill/usage' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未配置网页会话 Cookie' }); return }
        try {
          const usage = await fetchUpstreamUsage(state.cookie)
          writeJson(res, { ok: true, ...usage, account: state.activeAccount || meAccount.name || null })
        } catch (err) {
          if (err && err.code === 'SESSION_EXPIRED') {
            writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期，请到「设置」页签重新粘贴 Cookie' })
            return
          }
          writeJson(res, { ok: false, code: 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, 502)
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/session' && req.method === 'GET') {
        loadState()
        // 验活而非只看「有没有 cookie」：/api/me 200 才算有效；401 先按绑定账号
        // 自动重登一次再验。未配置 / 无绑定 / 重登失败 → valid=false。
        let probe = state.cookie !== '' ? await probeSession(state.cookie) : { valid: false, name: null }
        if (state.cookie !== '' && !probe.valid && (await reloginActive())) probe = await probeSession(state.cookie)
        writeJson(res, { ok: true, configured: state.cookie !== '', valid: probe.valid, account: probe.name, hint: maskSecret(state.cookie) })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/session' && req.method === 'POST') {
        const body = await readBody(req)
        const raw = body && typeof body.value === 'string' ? body.value : ''
        const cookie = extractSessionCookie(raw)
        const csrf = extractCsrfCookie(raw)
        loadState()
        state.cookie = cookie
        if (csrf !== '') state.csrf = csrf
        // 换 Cookie 即切号：解析新 cookie 的真实身份并对齐绑定。解析失败 / 未命中
        // 一律清空 activeAccount —— 宁可不自动重登，也绝不把旧账号重登到新会话上。
        let bound = false
        let sessionAccount = null
        if (cookie !== '') {
          sessionAccount = await fetchMeAccountName(cookie)
          const hit = matchAccountName(state.accounts, sessionAccount)
          if (hit !== null) { state.activeAccount = hit.account; bound = true }
          else state.activeAccount = ''
        } else {
          state.activeAccount = ''
        }
        saveState()
        writeJson(res, { ok: true, configured: cookie !== '', hint: maskSecret(cookie), account: sessionAccount, bound })
        return
      }

      // 账号密码登录：host 直接调平台登录接口，成功后从 Set-Cookie 提取
      // tr_session 存入 state（0600）。凭据同时并入 accounts（明文 0600，与账号
      // 管理一致）：会话过期后自动重登可用，登录事件与贴 Cookie 两条路径绑定语义一致。
      if (pathname === '/dsh-tokenrhythm-bill/auth/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        const r = await loginOnPlatform(account, password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        loadState()
        state.cookie = r.cookie
        if (r.csrf) state.csrf = r.csrf
        state.activeAccount = account
        const rest = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        state.accounts = sanitizeAccounts([...rest, { account, password, addedAt: Date.now() }])
        saveState()
        writeJson(res, { ok: true, configured: true, hint: maskSecret(r.cookie) })
        return
      }

      // 账号管理：添加 / 删除 / 一键登录。密码明文只留本机 state 文件；
      // 列表一律回掩码，只有点「眼睛」才走 /account/password 单取一次
      //（2026-10-23 对齐阶跃/清枢/OpenCSG 同一口径——原先基元整表带明文下发浏览器）。
      /**
       * 基元账号清单的公开形态：只回 account 与 pwMask。
       * 与另三家的形状差异：基元池允许「没有密码」的条目（历史 cookie 粘贴时代存下的
       * 存档；sanitizeAccounts 只拦超长，空串合法），maskPassword 对空密码回 ''，
       * 界面据此显示「未存密码」而不是一排点——与阶跃那条同一判读。
       */
      const trPublicAccounts = () => state.accounts.map((a) => ({
        account: a.account,
        pwMask: maskPassword(a.password),
      }))
      if (pathname === '/dsh-tokenrhythm-bill/accounts' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, accounts: trPublicAccounts() })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/add' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        loadState()
        const rest = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        state.accounts = sanitizeAccounts([...rest, { account, password, addedAt: Date.now() }])
        saveState()
        const r = await loginOnPlatform(account, password)
        if (r.ok) { state.cookie = r.cookie; if (r.csrf) state.csrf = r.csrf; state.activeAccount = account; saveState() }
        writeJson(res, { ok: true, saved: true, loggedIn: r.ok, hint: r.ok ? maskSecret(r.cookie) : null, error: r.error || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/remove' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account : ''
        loadState()
        state.accounts = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        saveState()
        writeJson(res, { ok: true, accounts: trPublicAccounts() })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account : ''
        loadState()
        const acc = state.accounts.find((a) => a.account.toLowerCase() === account.toLowerCase())
        if (!acc) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        const r = await loginOnPlatform(acc.account, acc.password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        state.cookie = r.cookie
        if (r.csrf) state.csrf = r.csrf
        state.activeAccount = acc.account
        saveState()
        writeJson(res, { ok: true, hint: maskSecret(r.cookie) })
        return
      }
      // 密码明文按需单取（与密钥、与另三家账号池同一口径：列表只见掩码，点「眼睛」才发这一次）。
      // 只认账号池内的 account（matchAccountName 大小写不敏感）——池外一律 404，不给探测面；
      // 「没有密码」的条目照常命中但回 ''（界面显示「未存密码」，眼睛本就禁用，这是兜底）。
      // 明文不进日志、不落盘、不进任何缓存。
      if (pathname === '/dsh-tokenrhythm-bill/account/password' && req.method === 'GET') {
        loadState()
        const hit = matchAccountName(state.accounts, url.searchParams.get('account') || '')
        if (hit === null) { writeJson(res, { ok: false, code: 'NO_ACCOUNT', error: '账号不在账号池中' }, 404); return }
        writeJson(res, { ok: true, account: hit.account, password: typeof hit.password === 'string' ? hit.password : '' })
        return
      }

      // ---- 基元本机密钥副本（state.trKeys）----
      // 三个动作都只在宿主内存与本机文件之间活动：浏览器永远只见掩码与 hasLocal 布尔标记，
      // 完整值只从 /keys/reveal 这一条显式路由出（点「复制完整值」才发这一次）。
      // 为什么基元要存、阶跃不存：见 sanitizeTrSavedKeys 上方那段「平台还愿不愿意再给一次明文」。
      //
      // 读只查**内存**：调用方先 loadState()（loadState 自带 stateLoaded 记忆，第一次才真读盘，
      // 所以这里多调几次也不贵）——要求调用方显式调一次，是为了让「查之前 state 是这次的」写在
      // 路由入口那行上，而不是藏在一次 find 里。
      const trSavedKeyFind = (id) => {
        const want = asStr(id)
        if (want === '') return null
        const rows = Array.isArray(state.trKeys) ? state.trKeys : []
        // 明文必须真的是非空字符串才算数：脏行（历史手改、旧版本写坏）在这里挡掉，
        // 否则 reveal 会把 `key: undefined` 当成功回给客户端。
        return rows.find((r) => isObj(r) && r.id === want
          && typeof r.token === 'string' && r.token !== '') || null
      }
      /** 创建成功即落本机（best-effort：写不进去不改变创建结果，只是少一个复制入口）。 */
      const trSavedKeySave = (rec) => {
        loadState()
        const before = Array.isArray(state.trKeys) ? state.trKeys : []
        const next = trSavedKeysAdd(before, rec, Date.now())
        if (next === before) return false // 净化没过（没 id / 没 token）→ 存了也认不回来
        state.trKeys = next
        saveState()
        return true
      }
      /**
       * 丢副本，返回真删掉的条数：一次进来一串 id——行上那颗按钮发 `[这一条]`，平台已删的
       * 孤儿副本发一串。**整串只写一次盘**（逐条调 = 每删一条就重写一遍整个 state 文件）。
       * 平台上的密钥不动，没有命中就是 no-op（不写盘）。
       */
      const trSavedKeyDrop = (ids) => {
        const list = Array.isArray(ids) ? ids : []
        if (list.length === 0) return 0
        loadState()
        let cur = Array.isArray(state.trKeys) ? state.trKeys : []
        const before = cur.length
        for (const one of list.slice(0, TR_SAVED_KEY_MAX)) cur = trSavedKeysDrop(cur, asStr(one))
        if (cur.length === before) return 0
        state.trKeys = cur
        saveState()
        return before - cur.length
      }

      // 平台「我的 API Key」：列表（平台只给掩码）与新建（完整 Key 只在创建响应出现一次）。
      if (pathname === '/dsh-tokenrhythm-bill/keys' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
        try {
          let up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
          // 401（会话过期）：按绑定账号自动重登一次后用新 cookie 重试。
          if (up.status === 401 && (await reloginActive())) {
            up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
          }
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          if (!up.ok) { writeJson(res, { ok: false, error: '平台返回 ' + up.status }, 502); return }
          // 平台列表只给打码值；本机凭据若与某把密钥的前缀/后缀一致，则标记可复制完整值。
          const { providers } = readProviders()
          const tProvider = providers.find((p) => p.balanceCapable)
          const localKey = tProvider ? resolveKey(tProvider) : ''
          const keys = normalizePlatformKeys(await up.json().catch(() => null))
          // 匹配判据与对话头部角标共用一份（trKeyMatchesPlatform）：两处对「本机这把 key
          // 是不是平台列出的这一条」必须同一个口径，否则页签说可复制、角标说不属于。
          // 本机那把 key 这里仍走 resolveKey（env 优先，本路由的历史口径）；角标走的是
          // file-first 的 activeCredentialKey（DSH 真正在用的那把）——两者只在
          // 「env 与凭据文件同时存在且不同」这一种情况下分叉。
          // 两个布尔标记说的不是一件事，别合并：
          //   copyable  = 本机**正在用**的那把（DSH 配置里的 key）是不是这一行 → 能凭指纹取回；
          //   hasLocal  = 这一行是**我们在面板里创建时落过盘**的 → 能按 id 零网络取回。
          for (const k of keys) {
            k.copyable = trKeyMatchesPlatform(localKey, k)
            k.hasLocal = trSavedKeyFind(k.id) !== null
          }
          // 平台已经删掉、本机还留着的副本（用户去官网删了 key 的那种）：**不自动清**——
          // 明文删了就再也拿不回来，宁可多留一份也不替用户做不可逆的决定。只把 id 回给界面，
          // 由用户点一下再清（界面不拿它做别的）。
          const listed = new Set(keys.map((k) => k.id))
          const orphanIds = (Array.isArray(state.trKeys) ? state.trKeys : [])
            .filter((r) => isObj(r) && typeof r.id === 'string' && r.id !== '' && !listed.has(r.id))
            .map((r) => r.id)
          writeJson(res, { ok: true, keys, localKnown: localKey !== '', orphanIds })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 对话头部角标（v0.7.3）：DSH 在用的基元密钥 → 本机绑定账号 → 账户余额快照。
      // 与 /stepfun/key-plan、/opencsg/key-account 同语义、同两个绕缓存档：
      //   force=1        密钥/账号刚动过 → 归属匹配表与余额快照都重来；
      //   refresh=1      一轮对话结束 → 只绕余额那 5 分钟，归属匹配照旧命中（轮末走这档）；
      //   provider=<id>  会话在用的基元 provider（多枚共用同一 baseURL 时决定核哪把钥匙）。
      // 与那两家一样不加系统开关闸门：门在客户端（角标只在会话真的在用基元时取数），
      // 路由本身只读——与 /balance、/keys 同级同律。
      if (pathname === '/dsh-tokenrhythm-bill/tr/key-balance' && req.method === 'GET') {
        writeJson(res, await fetchTrKeyBalance(url.searchParams.get('force') === '1',
          url.searchParams.get('refresh') === '1',
          // 会话在用的 provider（多枚共用同一 baseURL 时决定核哪把钥匙、回带哪个 id）。
          url.searchParams.get('provider') || ''))
        return
      }

      // 复制旧密钥：平台只存打码值，但本机凭据与其匹配时返回完整值。
      if (pathname === '/dsh-tokenrhythm-bill/key-reveal' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || ''
        const suffix = url.searchParams.get('suffix') || ''
        const { providers } = readProviders()
        const tProvider = providers.find((p) => p.balanceCapable)
        const localKey = tProvider ? resolveKey(tProvider) : ''
        if (localKey === '' || prefix === '' || suffix === '') { writeJson(res, { ok: false, error: '本机没有对应的完整密钥' }, 404); return }
        if (localKey.startsWith(prefix) && localKey.endsWith(suffix)) {
          writeJson(res, { ok: true, key: localKey })
        } else {
          writeJson(res, { ok: false, error: '本机没有对应的完整密钥' }, 404)
        }
        return
      }
      // ---- 变更类平台请求（POST/DELETE…）封装：平台的 CSRF 双提交 + fetch-metadata
      // 校验只针对非安全方法。遇 403 CSRF_INVALID 自愈：GET /api/auth/me 让平台重发
      // tr_csrf（可能同时轮换 tr_session），落盘新配对后重试一次；仍失败才报给界面。
      // 返回 { status, ok, body }；本机未登录返回 null。----
      const trMutate = async (path, init) => {
        loadState()
        if (state.cookie === '') return null
        const attempt = async (cookie, csrf) => {
          const res = await fetchWithTimeout(TOKENRHYTHM_BASE + path, {
            ...(init || {}),
            headers: { ...trHeaders(cookie, csrf), ...(init && init.headers ? init.headers : {}) },
          })
          return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
        }
        let r = await attempt(state.cookie, state.csrf)
        if (r.status !== 403 || !isObj(r.body) || String(r.body.code || '').toUpperCase() !== 'CSRF_INVALID') return r
        try {
          const me = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/auth/me', { headers: trHeaders(state.cookie, state.csrf) })
          const lines = typeof me.headers.getSetCookie === 'function'
            ? me.headers.getSetCookie()
            : (me.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
          for (const line of lines) {
            const s = /tr_session=([^;\s]+)/.exec(line)
            if (s !== null) state.cookie = s[1]
            const c = /tr_csrf=([^;\s]+)/.exec(line)
            if (c !== null) state.csrf = c[1]
          }
          saveState()
        } catch { /* 刷新失败 → 仍用现有配对重试一次 */ }
        const r2 = await attempt(state.cookie, state.csrf)
        // 401（会话过期）：按绑定账号自动重登一次后用新配对再试。
        if (r2.status === 401 && (await reloginActive())) return attempt(state.cookie, state.csrf)
        return r2
      }
      // ---- 兑换码（体验卡）：平台 POST /api/auth/exchange-code { code }。
      // 判读口径照抄平台前端自己的 api client（Ar 认信封 / jr 认业务码 / wr 取 data）：
      //   信封 = 含 code 且含 data|message|traceId，或含 data 且含 message|traceId；
      //   业务成功 = code 为 0 / '0' / 200 / '200' / 缺省；
      //   成功取 data 原样交出去，界面按 r.data.quota 取值——和网页端取值路径一致，
      //   不另立字段名、不改写类型（quota 是平台「金额契约」里的固定 8 位小数字符串，
      //   网页端按 wallet mode 渲染 = ¥ + 2 位小数 + ceil）。
      // 失败把平台 message 原样透传（实测无效码 = 400「体验卡无效、已过期或次数已用完」），
      // 不概括、不替平台下结论。平台没有「先校验再兑换」的接口，所以「不可撤销」只写在
      // 界面的确认步里。----
      if (pathname === '/dsh-tokenrhythm-bill/redeem' && req.method === 'POST') {
        const body = await readBody(req)
        const code = body && typeof body.code === 'string' ? body.code.trim().slice(0, 128) : ''
        if (code === '') { writeJson(res, { ok: false, error: '请输入体验卡。' }, 400); return }
        try {
          const up = await trMutate('/api/auth/exchange-code', { method: 'POST', body: JSON.stringify({ code }) })
          if (up === null) { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          const raw = up.body
          const obj = isObj(raw)
          const isEnv = obj && ((('code' in raw) && (('data' in raw) || ('message' in raw) || ('traceId' in raw)))
            || (('data' in raw) && (('message' in raw) || ('traceId' in raw))))
          const envCode = obj ? raw.code : undefined
          const bizOk = envCode === undefined || envCode === 0 || envCode === '0' || envCode === 200 || envCode === '200'
          const platformMsg = obj && typeof raw.message === 'string' && raw.message !== '' ? raw.message : ''
          if (!up.ok || !bizOk) {
            // 平台自己的措辞最准（无效 / 已过期 / 次数用完都在里面），原样交给界面显示。
            writeJson(res, {
              ok: false,
              code: envCode === undefined ? null : envCode,
              error: platformMsg || ('兑换失败（平台 ' + up.status + '）'),
            }, 502)
            return
          }
          const data = isEnv ? raw.data : raw
          if (!isObj(data) || data.quota === undefined || data.quota === null) {
            writeJson(res, { ok: false, error: '平台未返回到账额度' }, 502)
            return
          }
          writeJson(res, {
            ok: true,
            code: 0,
            message: platformMsg || 'ok',
            traceId: obj && typeof raw.traceId === 'string' ? raw.traceId : '',
            data,
          })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/keys/create' && req.method === 'POST') {
        const body = await readBody(req)
        const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
        if (name === '') { writeJson(res, { ok: false, error: '请填写密钥名称' }, 400); return }
        try {
          const up = await trMutate('/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) })
          if (up === null) { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          if (!up.ok) {
            const detail = isObj(up.body) && typeof up.body.message === 'string' ? up.body.message : ''
            writeJson(res, { ok: false, error: '创建失败（平台 ' + up.status + '）' + (detail ? '：' + detail : '') }, 502)
            return
          }
          const data = unwrapEnvelope(up.body)
          const fullKey = isObj(data) ? asStr(data.key || data.keyValue || data.secret) : ''
          if (fullKey === '') { writeJson(res, { ok: false, error: '平台未返回完整密钥' }, 502); return }
          const createdId = isObj(data) ? asStr(data.id) : ''
          // 平台只给这一次明文（列表之后只回掩码、没有按 id 单取的口）→ 当场落一份本机副本，
          // 之后那一行的「复制完整值」才有的可复制。best-effort：写不进去不改变创建结果，
          // 只是那一行退化成「仅创建时展示过一次」。
          const savedLocal = trSavedKeySave({ id: createdId, name, token: fullKey, createdAtMs: Date.now() })
          writeJson(res, { ok: true, id: createdId, name, key: fullKey, savedLocal })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 复制「创建时落过本机」的那份完整密钥（只在点「复制完整值」时发这一次；界面只见掩码）。
      // 与 /key-reveal 的分工：那条回答「DSH 正在用的那把是什么」（头尾指纹匹配平台行），
      // 这条回答「我当初建完存下来的那把是什么」（按 id 直取）——两者可能指向不同的行。
      if (pathname === '/dsh-tokenrhythm-bill/keys/reveal' && req.method === 'GET') {
        loadState()
        const hit = trSavedKeyFind(url.searchParams.get('id') || '')
        if (hit === null) {
          writeJson(res, { ok: false, error: '本机没有这把密钥的完整值（不是在本面板里创建的）' }, 404)
          return
        }
        writeJson(res, { ok: true, key: hit.token })
        return
      }
      // 忘掉本机副本：只删自己存的那份明文，平台上的密钥不动（与 OpenCSG apikey-forget 同款）。
      // 入口收 `ids` 数组而不是单个 `id`：行上那颗按钮发 [这一条的 id]，平台已删的孤儿副本
      // 一次发一串——同一套语义，不另开一条路由做「批量」。
      if (pathname === '/dsh-tokenrhythm-bill/keys/forget' && req.method === 'POST') {
        const body = await readBody(req)
        const ids = isObj(body) && Array.isArray(body.ids) ? body.ids : []
        if (ids.length === 0) { writeJson(res, { ok: false, error: '缺少密钥 id' }, 400); return }
        const removed = trSavedKeyDrop(ids)
        writeJson(res, removed > 0 ? { ok: true, removed } : { ok: false, removed: 0, error: '本机没有这些副本' }, removed > 0 ? 200 : 404)
        return
      }

      // 返回完整 API Key 供「复制」按钮写入剪贴板（仅本机请求；不在界面上明文渲染）。
      if (pathname === '/dsh-tokenrhythm-bill/key' && req.method === 'GET') {
        const providerId = url.searchParams.get('provider') || ''
        const { providers } = readProviders()
        // 只认基元（balanceCapable）：本插件不是凭据分发器，不能借一条 GET 把整份
        // provider 名册的明文 key 吐出去。客户端零调用此路由，收紧不影响界面。
        const provider = providers.find((p) => p.id === providerId && p.balanceCapable === true)
        if (!provider) { writeJson(res, { ok: false, error: '未找到提供商: ' + providerId }, 404); return }
        const key = resolveKey(provider)
        if (key === '') { writeJson(res, { ok: false, error: '未读到 ' + provider.apiKeyEnv }, 404); return }
        writeJson(res, { ok: true, key })
        return
      }

      // ---- /model-check 批量连通检测：真实 1-token 请求，走 DSH 已配置的 key（resolveKey）。
      // 选哪些模型、多久一次全由客户端决定（面板打开期间定时）；host 只执行「这一轮」：
      // 60s TTL 缓存防重复计费，并发 ≤3 + 每请求前随机抖动（瞬时并发会触发上游风控冻结）。
      if (pathname === '/dsh-tokenrhythm-bill/model-check' && req.method === 'POST') {
        const body = await readBody(req)
        const { providers } = readProviders()
        const wantId = body && typeof body.provider === 'string' ? body.provider.trim() : ''
        const provider = wantId !== ''
          ? (providers.find((p) => p.id === wantId && p.balanceCapable === true) || null)
          : (providers.find((p) => p.balanceCapable) || null)
        if (!provider) { writeJson(res, { ok: false, error: '没有可用提供商（检查 settings.yaml 或 profile 补丁层里的 llm-pi-ai.providers）' }, 404); return }
        const key = resolveKey(provider)
        if (key === '') { writeJson(res, { ok: false, code: 'NO_KEY', error: '未读到 ' + provider.apiKeyEnv + '（env 与 ~/.dsh/.credentials.yaml 都没有）' }, 409); return }
        const force = body && body.force === true
        const plan = buildCheckPlan(body ? body.models : null, checkCache, force, Date.now(), CHECK_TTL_MS)
        if (plan.toProbe.length === 0 && Object.keys(plan.cachedResults).length === 0) {
          writeJson(res, { ok: false, error: '请至少勾选一个模型（models 为字符串数组，最多 ' + CHECK_MAX_MODELS + ' 个）' }, 400); return
        }
        const base = (provider.baseURL || '').replace(/\/+$/, '')
        if (base === '') { writeJson(res, { ok: false, error: '提供商 ' + provider.id + ' 的 baseURL 为空，无法探测' }, 500); return }
        const chatUrl = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions'
        const results = {}
        for (const id of Object.keys(plan.cachedResults)) results[id] = plan.cachedResults[id]
        const started = Date.now()
        const queue = plan.toProbe.slice()
        let qIdx = 0
        const probeOne = async (modelId) => {
          await sleep(Math.floor(Math.random() * CHECK_JITTER_MS))
          const t0 = Date.now()
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS)
          let http = 0
          let detail = '网络错误'
          try {
            const r2 = await fetch(chatUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
              body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
              signal: ac.signal,
            })
            http = r2.status
            if (r2.ok) {
              detail = ''
              try { await r2.json() } catch { /* 200 非 JSON 也视为可达 */ }
            } else {
              const t = await r2.text().catch(() => '')
              let msg = t.slice(0, 160)
              try {
                const j = JSON.parse(t)
                if (isObj(j) && j.error !== undefined) msg = String((isObj(j.error) ? (j.error.message || j.error) : j.error))
              } catch { /* 保留原始文本 */ }
              detail = 'HTTP ' + http + (msg ? ' ' + msg : '')
            }
          } catch (err) {
            detail = (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))
              ? '超时（' + CHECK_TIMEOUT_MS + 'ms）'
              : String((err && err.message) || err)
          } finally {
            clearTimeout(timer)
          }
          const ms = Date.now() - t0
          const cls = classifyProbe(http, detail)
          const entry = { status: cls.status, ms, error: cls.error, errorKind: cls.errorKind, checkedAt: Math.floor(Date.now() / 1000), cached: false }
          results[modelId] = entry
          checkCache.set(modelId, Object.assign({ ts: Date.now() }, entry))
        }
        // 并发 ≤3 的 worker 池从共享队列取任务（JS 单线程，qIdx 无需锁）。
        await (async () => {
          const workers = []
          for (let w = 0; w < Math.min(CHECK_CONCURRENCY, queue.length); w++) {
            workers.push((async () => {
              while (qIdx < queue.length) {
                const id = queue[qIdx]
                qIdx++
                await probeOne(id)
              }
            })())
          }
          await Promise.all(workers)
        })()
        writeJson(res, {
          ok: true,
          provider: provider.id,
          results,
          probed: plan.toProbe.length,
          cached: Object.keys(plan.cachedResults).length,
          tookMs: Date.now() - started,
        })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'GET') {
        loadState()
        // systems 一律回规范化结果（缺 systems 的老存档也能直接读到完整三键）
        writeJson(res, { ok: true, prefs: { ...state.prefs, systems: systemsOf(state.prefs) } })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.prefs = { ...state.prefs, ...sanitizePrefs(body && body.prefs ? body.prefs : body) }
        saveState()
        writeJson(res, { ok: true, prefs: { ...state.prefs, systems: systemsOf(state.prefs) } })
        return
      }

      // ---- 更新检测：本仓库 main 的 package.json 就是版本源（push 即生效，不必发 release）。
      // 24h TTL，未过期零网络；失败降级回持久化结果。----
      const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
      let updateBusy = null // 单飞：并发请求共享同一次上游检查
      const UPDATE_REPO = 'DongHua3/dsh-tokenrhythm'
      const UPDATE_BRANCH = 'main'
      // 三条路按「国内可达性」排：GitHub raw 经常连不上，jsDelivr 走它的 CDN 兜底，
      // 最后才是 api.github.com 的 tags（要有 tag 才查得到，所以放末位）。
      const readRepoVersion = async () => {
        const sources = [
          'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/package.json',
          'https://cdn.jsdelivr.net/gh/' + UPDATE_REPO + '@' + UPDATE_BRANCH + '/package.json',
        ]
        for (const url of sources) {
          try {
            const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } })
            if (res === null || !res.ok) continue
            const pkg = await res.json().catch(() => null)
            const v = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : ''
            if (parseVersionTriple(v) !== null) return v
          } catch { /* 换下一个源 */ }
        }
        return null
      }
      const readTagVersion = async () => {
        try {
          const res = await fetchWithTimeout(
            'https://api.github.com/repos/' + UPDATE_REPO + '/tags?per_page=1',
            { headers: { accept: 'application/vnd.github+json' } },
          )
          if (res === null || !res.ok) return null
          const list = await res.json().catch(() => null)
          const name = Array.isArray(list) && list[0] && typeof list[0].name === 'string' ? list[0].name.trim() : ''
          const v = name.replace(/^v/i, '')
          return parseVersionTriple(v) === null ? null : v
        } catch { return null }
      }
      const fetchLatestVersion = async () => {
        const fromRepo = await readRepoVersion()
        return fromRepo !== null ? fromRepo : readTagVersion()
      }
      const updateResponse = (latest, checkedAt, stale) => {
        const current = PKG_VERSION
        const ignored = state.update.ignoredVersion || ''
        return {
          ok: true,
          current,
          latest,
          updateAvailable: isNewerVersion(current, latest) && latest !== ignored,
          ignoredVersion: ignored,
          installMode: detectInstallMode(),
          checkedAt,
          ...(stale ? { stale: true } : {}),
        }
      }
      const checkUpdate = async (force) => {
        loadState()
        const saved = state.update
        // 缓存只对「检测出它的那个版本」作数。插件被换过版本后（currentAtCheck 与当前
        // PKG_VERSION 不符），旧结果毫无意义——不拦的话换装后 24h 内一直显示旧的上游
        // 版本号（实测：换到自己仓库的 0.1.0 后仍提示“有新版本 v0.6.1”）。
        const cacheForThisVersion = saved.currentAtCheck === PKG_VERSION
        if (!force && cacheForThisVersion && saved.latestVersion && Date.now() - (saved.checkedAt || 0) < UPDATE_TTL_MS) {
          return updateResponse(saved.latestVersion, saved.checkedAt || 0, false)
        }
        if (updateBusy !== null) return updateBusy
        updateBusy = (async () => {
          const latest = await fetchLatestVersion()
          if (latest !== null) {
            state.update = { ...sanitizeUpdate(saved), latestVersion: latest, checkedAt: Date.now(), currentAtCheck: PKG_VERSION }
            saveState()
            return updateResponse(latest, state.update.checkedAt, false)
          }
          // 上游全挂：有持久化结果给旧值标 stale，否则静默失败（不阻塞设置页）
          if (saved.latestVersion && cacheForThisVersion) return { ...updateResponse(saved.latestVersion, saved.checkedAt || 0, true), error: '检查失败，显示上次结果' }
          return { ok: true, current: PKG_VERSION, latest: null, updateAvailable: false, installMode: detectInstallMode(), checkedAt: 0, error: '检查失败，稍后再试' }
        })()
        try { return await updateBusy } finally { updateBusy = null }
      }
      if (pathname === '/dsh-tokenrhythm-bill/update' && req.method === 'GET') {
        writeJson(res, await checkUpdate(url.searchParams.get('force') === '1'))
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/update/ignore' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.update = { ...sanitizeUpdate(state.update), ignoredVersion: asStr(body && body.version) ? asStr(body.version) : '' }
        if (state.update.ignoredVersion === '') delete state.update.ignoredVersion
        saveState()
        const saved = state.update
        writeJson(res, { ok: true, ...updateResponse(saved.latestVersion || null, saved.checkedAt || 0, false) })
        return
      }

      writeJson(res, { ok: false, error: 'not found' }, 404)
    } catch (err) {
      try { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500) } catch { /* socket 已断 */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tokenrhythm-bill', handler: serve }), 'tokenrhythm-bill: routes')
}
