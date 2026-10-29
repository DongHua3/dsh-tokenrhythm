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

// ---- 4b. 明文凭据路由 fail-closed ----
// 这五条回传的东西能直接拿去登录平台（密码）或调用 API（密钥）。它们不能跟其余路由
// 共用 fail-open 的门：没有 Sec-Fetch-Site 就拒，浏览器（same-origin/none）不受影响。
console.log('4b) 明文凭据路由 fail-closed')
const reqFor = (url, site, method) => ({
  method: method || 'GET',
  url,
  headers: site === null ? {} : { 'sec-fetch-site': site },
  [Symbol.asyncIterator]: async function* () {},
})
const SENSITIVE = [
  ['account/password?account=x', 'GET'],
  ['key?provider=tokenrhythm', 'GET'],
  ['key-reveal', 'GET'],
  ['keys/reveal?id=x', 'GET'],
  ['keys/create', 'POST'],
]
if (typeof handler === 'function') {
  for (const [p, m] of SENSITIVE) {
    const bare = makeRes()
    try { await handler(reqFor('/dsh-tokenrhythm-bill/' + p, null, m), bare) } catch { /* 拦截前不该抛 */ }
    assert(bare.status === 403, `${p.split('?')[0]} 无头 → 403`, `got ${bare.status}`)

    const browser = makeRes()
    try { await handler(reqFor('/dsh-tokenrhythm-bill/' + p, 'same-origin', m), browser) } catch { /* 允许 handler 内部异常 */ }
    assert(browser.status !== 403, `${p.split('?')[0]} same-origin → 放行`, `got ${browser.status}`)
  }
  // 非敏感路由必须保持原来的 fail-open：旧 WebView / 脚本还在用
  const openRes = makeRes()
  try { await handler(reqFor('/dsh-tokenrhythm-bill/prefs', null), openRes) } catch { /* 允许内部异常 */ }
  assert(openRes.status !== 403, 'prefs 无头仍放行（fail-open 不变）', `got ${openRes.status}`)
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

// ---- 7. 会到期 / 长期有效 的派生合计 ----
// 平台 expiringBalanceCny 把长期有效的额度也算了进去（名字与语义不符），
// 所以插件按 expiresAt 自己切一刀。这组断言用实测数额做基准。
console.log('7) 会到期 / 长期有效')
const wAll = mod.normalizeWalletCredits({
  data: {
    summary: { expiringBalanceCny: '109.325489', nextExpiryAt: REAL_EXPIRY },
    rechargePrincipal: { sourceLabel: '充值本金', grantedCny: '50', consumedCny: '0', remainingCny: '50', status: 'ACTIVE', expiresAt: null },
    list: [
      { id: 'a', sourceLabel: '充值活动赠额', grantedCny: '50', consumedCny: '0', remainingCny: '50', status: 'ACTIVE', expiresAt: SENTINEL },
      { id: 'b', sourceLabel: '邀请奖励', grantedCny: '58', consumedCny: '0', remainingCny: '58', status: 'ACTIVE', expiresAt: REAL_EXPIRY },
      { id: 'c', sourceLabel: '实名认证奖励', grantedCny: '18', consumedCny: '16.674511', remainingCny: '1.325489', status: 'ACTIVE', expiresAt: REAL_EXPIRY },
      { id: 'd', sourceLabel: '旧邀请', grantedCny: '68', consumedCny: '68', remainingCny: '0', status: 'USED_UP', expiresAt: REAL_EXPIRY },
      { id: 'e', sourceLabel: '过期奖励', grantedCny: '68', consumedCny: '68', remainingCny: '0', status: 'EXPIRED', expiresAt: REAL_EXPIRY },
    ],
    total: 5,
  },
})
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6
assert(near(wAll.summary.expiringRealCny, 59.325489), '会到期 = 真实到期日那几笔之和', wAll.summary.expiringRealCny)
assert(near(wAll.summary.permanentCny, 100), '长期有效 = 本金 50 + 哨兵赠额 50', wAll.summary.permanentCny)
assert(near(wAll.summary.expiringBalanceCny, 109.325489), '平台字段原样保留（不改写）', wAll.summary.expiringBalanceCny)
assert(!near(wAll.summary.expiringRealCny, wAll.summary.expiringBalanceCny), '派生值与平台字段确实不同（否则等于没切）')
// USED_UP / EXPIRED / remaining=0 一律不进任何一边
assert(near(wAll.summary.expiringRealCny + wAll.summary.permanentCny, 159.325489), '两边之和 = 全部未花额度（9 位小数级一致）')

// 排序：长期有效聚在列表头上，会到期的按临近程度往后排。
// （之前把 null 当 Infinity 垫底，导致长期有效的条目被拆到列表首尾两处。）
const orderIds = wAll.items.filter((it) => it.status === 'ACTIVE' && it.remainingCny > 0).map((it) => it.id)
assert(orderIds[0] === 'a', '长期有效排在会到期的前面', JSON.stringify(orderIds))
const realTimes = wAll.items.filter((it) => it.expiresAt !== null).map((it) => Date.parse(it.expiresAt))
assert(JSON.stringify(realTimes) === JSON.stringify(realTimes.slice().sort((x, y) => x - y)), '会到期的仍按时间升序')

// ---- 汇总 ----
if (failures > 0) {
  console.log(`\n冒烟失败：${failures} 项`)
  process.exit(1)
}
console.log('\n冒烟通过')
