#!/usr/bin/env node
/**
 * 冒烟检查：语法 → 加载 → 路由注册 → 跨站拦截。
 *
 * 不启动宿主、不读 ~/.dsh、不联网：
 *   - node --check 四个 lib 文件
 *   - import 模块，断言 name / apply
 *   - 假 ctx 调 apply，断言只注册 prefix /dsh-tokenrhythm-bill
 *   - 假 req 打三种 Sec-Fetch-Site，断言跨站得 403
 *
 * 403 分支在全部 handler 之前就 return，不会触碰 state 文件，所以在
 * 没有 ~/.dsh 的 CI 容器里同样可跑。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_ROUTE = 'prefix /dsh-tokenrhythm-bill'

let failures = 0
const pass = (name) => console.log(`  ok   ${name}`)
const fail = (name, detail) => {
  failures += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : ' — ' + detail}`)
}
const assert = (cond, name, detail) => (cond ? pass(name) : fail(name, detail))

// ---- 1. 语法 ----
console.log('1) 语法检查')
for (const f of ['lib/index.js', 'lib/client.js', 'lib/common.js', 'lib/creds.js']) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' })
    pass(f)
  } catch (error) {
    const first = String((error && error.stderr) || (error && error.message) || '').split('\n')[0]
    fail(f, first)
  }
}

// ---- 2. 加载 ----
console.log('2) 模块加载')
const mod = await import(pathToFileURL(join(root, 'lib/index.js')).href)
assert(mod.name === 'dsh-tokenrhythm-bill', 'name 导出正确', `got ${String(mod.name)}`)
assert(typeof mod.apply === 'function', 'apply 是函数')

// ---- 3. 路由注册 ----
console.log('3) 路由注册')
const routes = []
let handler = null
const ctx = {
  webServer: {
    register(route) {
      routes.push(`${route.kind} ${route.path}`)
      handler = route.handler
      return () => {}
    },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on() {},
  inject: {},
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  settings: { get() { return undefined } },
}
try {
  mod.apply(ctx)
  pass('apply 未抛异常')
} catch (error) {
  fail('apply 未抛异常', String((error && error.message) || error))
}
assert(routes.length === 1, '只注册一条路由', JSON.stringify(routes))
assert(routes[0] === EXPECTED_ROUTE, `路由是 ${EXPECTED_ROUTE}`, String(routes[0]))

// ---- 4. 跨站拦截 ----
console.log('4) 跨站拦截')
const makeReq = (secFetchSite) => {
  const headers = secFetchSite === null ? {} : { 'sec-fetch-site': secFetchSite }
  return { method: 'GET', url: '/dsh-tokenrhythm-bill/manifest', headers, [Symbol.asyncIterator]: async function* () {} }
}
const makeRes = () => {
  const res = { status: 0, body: '' }
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body = body === undefined ? '' : String(body) }
  return res
}

if (typeof handler !== 'function') {
  fail('拿到 handler', 'apply 没有注册 handler')
} else {
  for (const site of ['cross-site', 'same-site']) {
    const res = makeRes()
    try {
      await handler(makeReq(site), res)
      assert(res.status === 403, `Sec-Fetch-Site: ${site} → 403`, `got ${res.status}`)
    } catch (error) {
      fail(`Sec-Fetch-Site: ${site} → 403`, String((error && error.message) || error))
    }
  }
  for (const site of [null, 'same-origin', 'none']) {
    const res = makeRes()
    try {
      await handler(makeReq(site), res)
      const label = site === null ? '(无头)' : site
      assert(res.status !== 403, `Sec-Fetch-Site: ${label} → 放行`, `got ${res.status}`)
    } catch {
      // handler 内部欠环境（无 state 文件等）时允许抛错：断言的是"没被跨站规则拦下"
      pass(`Sec-Fetch-Site: ${site === null ? '(无头)' : site} → 放行（handler 内部异常，非 403）`)
    }
  }
}

// ---- 5. provider 作用域（R1/R2 回归锁）----
// /key、/models、/model-check 只能碰基元。这三处曾各自手写 find 且都漏了过滤，
// 所以口径收进 pickScopedProvider 并在这里锁死：谁改宽谁红。
console.log('5) provider 作用域')
const pick = mod.pickScopedProvider
const roster = [
  { id: 'tokenrhythm', baseURL: 'https://tokenrhythm.studio/v1', balanceCapable: true },
  { id: 'henry', baseURL: 'https://api.henry.test/v1', balanceCapable: false },
  { id: 'flagstr', baseURL: 'https://x.test/v1', balanceCapable: 'true' },
  { id: 'noflag', baseURL: '' },
]
if (typeof pick !== 'function') {
  fail('pickScopedProvider 已导出', `got ${typeof pick}`)
} else {
  assert(pick(roster, 'tokenrhythm') === roster[0], '基元 id 命中')
  assert(pick(roster, 'henry') === null, '非基元 id 被拒')
  assert(pick(roster, 'flagstr') === null, 'balanceCapable 为真值字符串也拒（必须 === true）')
  assert(pick(roster, 'noflag') === null, '缺 balanceCapable 被拒')
  assert(pick(roster, '') === null, '空 id 不做隐式兜底')
  assert(pick(roster, 'TOKENRHYTHM') === null, 'id 不做大小写归一')
  assert(pick(null, 'tokenrhythm') === null, '名册非数组返回 null')
  // 源码级：三条路由都必须走这个函数（定义算 1 处，调用应再出现 3 处）
  const srcIndex = readFileSync(join(root, 'lib/index.js'), 'utf8')
  const hits = (srcIndex.match(/\bpickScopedProvider\(/g) || []).length
  assert(hits >= 4, '三条路由都走 pickScopedProvider', `只找到 ${hits} 处（含定义，期望 ≥4）`)
}

// ---- 6. 到期时间哨兵（长期有效不能被渲染成「到期 2099-12-31」）----
// 平台对长期有效的额度回 expiresAt = 2099-12-31T15:59:59Z。它不是日期而是占位，
// 平台自己的额度页显示「长期有效」；插件若照渲染，客户端 fmtDay 只打 M-D，
// 会退化成「到期 12-31」——看着像本月月底。
console.log('6) 到期时间哨兵')
const SENTINEL = '2099-12-31T15:59:59.000Z'
const REAL_EXPIRY = '2026-11-26T03:41:26.252Z'
const walletJson = {
  data: {
    summary: { nextExpiryAt: REAL_EXPIRY },
    list: [
      { id: 'a', source: 'recharge_bonus', sourceLabel: '充值活动赠额', grantedCny: '50', consumedCny: '0', remainingCny: '50', status: 'ACTIVE', expiresAt: SENTINEL },
      { id: 'b', source: 'invite', sourceLabel: '邀请奖励', grantedCny: '58', consumedCny: '0', remainingCny: '58', status: 'ACTIVE', expiresAt: REAL_EXPIRY },
    ],
    total: 2,
  },
}
const w = mod.normalizeWalletCredits(walletJson)
const bonus = (w.items || []).find((it) => it.id === 'a')
const invite = (w.items || []).find((it) => it.id === 'b')
assert(bonus && bonus.expiresAt === null, '长期有效（2099 哨兵）归一为 null', bonus && bonus.expiresAt)
assert(invite && invite.expiresAt !== null, '真实到期日照常保留', invite && invite.expiresAt)
assert(bonus && invite && bonus.grantedCny === 50, '哨兵不影响金额解析')

const expiring = mod.normalizeExpiringCredits(walletJson)
assert(Array.isArray(expiring) && expiring.length === 1, '哨兵条目不进临期列表', JSON.stringify(expiring && expiring.length))
assert(expiring && expiring[0].expireAt === new Date(REAL_EXPIRY).toISOString(), '临期列表只剩真实到期的那条')

const bal = mod.normalizeBalance({ summary: { nextExpiryAt: SENTINEL } }, null, null)
assert(bal.nextExpiryAt === null, 'nextExpiryAt 上的哨兵同样归一为 null', bal.nextExpiryAt)

// ---- 汇总 ----
if (failures > 0) {
  console.log(`\n冒烟失败：${failures} 项`)
  process.exit(1)
}
console.log('\n冒烟通过')
