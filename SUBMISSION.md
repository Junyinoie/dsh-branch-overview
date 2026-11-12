# 上架 DSH Market 指南（dsh-branch-overview）

本目录已经按 dsh-market 的收录要求准备好：

- 根目录有 `cordis.patch.yml`（市场 collector 的 DSH 插件特征检测通过）
- 包名 `dsh-branch-overview`（无作用域，可直接发布/引用）
- `package.json` 的 `dsh.bundle` + `dsh.client` 声明完整
- 已建本地 git 仓库，当前版本 `0.3.0`（发布时打 tag `v0.3.0`）

## 1. 建 GitHub 仓库并推送（需要你的 GitHub 账号）

```bash
cd dsh-branch-overview
git remote add origin git@github.com:Junyinoie/dsh-branch-overview.git
git push -u origin main --tags
```

## 2. 打 topic（最快被自动收录）

仓库页面 → About ⚙ → Topics 添加：

```
dsh-plugin  dsh  deepseek-harness  deepseek-harness-plugin  git  branch  worktree  cordis
```

collector 每天 06:00 扫描 `dsh-plugin` 等 topic；仓库不是 fork/archived、且特征检测通过即收录。

## 3. 同时提一个收录 issue（更稳，可写作者自述）

<https://github.com/2BingLing/dsh-market/issues/new?template=submit_plugin.md>

```
标题：[提交插件] dsh-branch-overview

- 仓库地址：https://github.com/Junyinoie/dsh-branch-overview
- 插件类型：cordis 插件
- 一句话简介：在 DSH 输入框显示当前会话仓库与分支，可保存到本地分支、推送、切换分支，master 只允许拉取。
- 安装命令：dsh plugin --profile web add github:Junyinoie/dsh-branch-overview
- 作者自述：
  dsh-branch-overview 把「分支管理」放进 DSH 工作区：输入框左侧芯片直接显示 仓库 + 当前分支，
  点开即可按目录筛选分支、保存到本地分支、推送或切换；master 仅允许快进拉取，不能保存或推送。
  有本地提交未推送时显示 未推送 N，切换前会要求先保存；弹窗里的 ? 图标给出每种状态的说明。
  全部 git 操作只在你点击时执行，Host 端只读扫描 + 显式确认，不自动暂存或丢弃改动。
```

收录后市场会自动回复 ✅ 并关闭 issue；次日 06:00 数据更新出现在 Web 站与插件市场面板。

## 4. 收录后可选

- README 顶部挂收录徽章（见 dsh-market 的 `PLUGIN-BADGE.md`，高分精选需评分 ≥ 80）
- 后续发版：改 `package.json` 版本 → `git commit` + `git tag vX.Y.Z` + push；市场每日刷新元数据

## 备注：包名与安装命令

- 未发布到 npm，所以安装命令统一用 git 源：`dsh plugin --profile web add github:Junyinoie/dsh-branch-overview`
- 如果以后要发 npm（`dsh-branch-overview` 这个名字目前未被占用），执行：
  ```bash
  npm login
  npm publish    # 在 dsh-branch-overview 目录
  ```
  然后安装命令可简化为 `dsh plugin --profile web add dsh-branch-overview`
