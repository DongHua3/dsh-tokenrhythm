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

// ---- 汇总 ----
if (failures > 0) {
  console.log(`\n冒烟失败：${failures} 项`)
  process.exit(1)
}
console.log('\n冒烟通过')
