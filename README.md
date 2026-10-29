# dsh-tokenrhythm

基元律动（tokenrhythm.studio）费用中心的 DSH 插件，**单渠道精简版**。

基于上游 [162568316/dsh-tokenrhythm-bill](https://github.com/162568316/dsh-tokenrhythm-bill)
v0.7.5（MIT）改造：**物理移除**了阶跃 StepFun / ZCode / 清枢智汇 TierFlow / OpenCSG 四家的
全部代码、路由与 UI，只保留基元律动一家；并按个人使用习惯做了界面收敛。

包名仍为 `dsh-tokenrhythm-bill`（必须与 `cordis.patch.yml` 的 `name` 一致），仓库名是本项目自己的。

## 功能

| 功能 | 说明 |
| --- | --- |
| 余额 / 限时额度 | 走 `tokenrhythm.studio` 网页会话 Cookie |
| 用量热力日历 | 近 30 天，按模型 / 按客户端拆分 |
| 模型价格卡 | 分类筛选、折扣、峰谷分时计价 |
| 密钥管理 | 列表掩码、复制完整值、新建 / 删除 |
| 连通检测 | 真实 1-token 探测（**默认关闭**，手动开启才计费） |
| 账号管理 | 多账号、密码登录、Cookie 粘贴、自动续期 |
| 余额角标 | 对话头部按在用密钥显示账户余额 |

## 相对上游移除的内容

**四家渠道（物理删除）**

- `lib/step.js`、`lib/tierflow.js`、`lib/opencsg.js`、`lib/zcode.js` —— 模块文件已删
- `/dsh-tokenrhythm-bill/stepfun/*`、`/tierflow/*`、`/opencsg/*`、`/zcode/*` —— 全部路由
  （均返回 404）
- `index.js` 中四家的实现、净化器、会话池、持久化分支
- `client.js` 中四家的页签 UI 与三个外链按钮（`opencsg.com` / `tierflow.cn` / `platform.stepfun.com`）
- `SYS_KEYS` 由 `['tr','step','zcode','tf','oc']` 收窄为 `['tr']`

**界面收敛（本轮）**

- 输入行两个快捷按钮（计划模式 `/plan`、压缩上下文 `/compact`）—— 整块 `ComposerActions` 移除
- 设置里的「系统管理」分组页签 —— 只剩一家渠道后该分组无意义，整块移除，
  设置页签仅保留 `基元 | 关于`
- 设置弹窗高度修复：面板只有 `max-height`、没有 `height`，弹窗 `inset:0` 会跟着被压扁
  到 ~300px；现在设置打开时面板撑到 `min(80vh,760px)`，卡片改为 `height:auto` 自适应

## 出网域名

```
https://tokenrhythm.studio                    # 基元平台 API
https://raw.githubusercontent.com             # 版本检查（读本仓库 main 的 package.json）
https://cdn.jsdelivr.net/gh                   # 同上，raw 连不上时兜底
https://api.github.com                        # 同上，最后兜底（tags 列表）
```

不再触碰 `platform.stepfun.com` / `account.stepfun.com` / `api.stepfun.com` /
`tierflow.cn` / `opencsg.com` / `zcode.z.ai` / `open.bigmodel.cn` / `~/.zcode/v2`。

## 版本与更新

版本号 `0.1.x` 起，与上游脱钩。

「检查更新」的版本源就是**本仓库 `main` 分支的 `package.json`** —— push 一个更高的
`version` 即生效，不必发 release。检查结果本地缓存 24h，失败时降级显示上次结果。

更新命令：

```sh
dsh plugin --profile desktop add github:DongHua3/dsh-tokenrhythm
```

## 安装

```sh
dsh plugin --profile desktop remove dsh-tokenrhythm-bill
dsh plugin --profile desktop add github:DongHua3/dsh-tokenrhythm
```

装完**必须重启 DSH**。若从本地目录安装，把上面的 `github:...` 换成目录路径。

## 凭据存放

本机 `~/.dsh/tokenrhythm-bill-state.json`（首次写入时 `mode 0o600`）。Cookie / 密码 /
密钥只落在 host 进程，不经浏览器、不上传任何第三方。

## 已知缺陷（上游 0.7.5 原样存在，非本项目引入）

ESLint `no-undef` 报 3 处：`client.js` 的 `cur`、`setTfPlansScope`、`setStepKeyCreated`。
三者都有定义，属于作用域分析误报；后两者所在分支已被 `SYS_KEYS=['tr']` 判死，不会执行。

## 本地检查

```sh
node scripts/smoke.mjs
```

语法 / 加载 / 路由注册 / 跨站拦截四项，CI 在每次 push 时跑同一脚本。

## 许可

沿用上游 MIT。原始版权归 162568316 与贡献者所有。
