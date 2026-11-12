# dsh-branch-overview（分支管理 + 切换）

把「分支管理」做成 DSH Web 界面里的插件，两个入口：

1. **左侧导航栏「分支管理」面板**：汇总各工作区 git 仓库的分支与提交情况；
2. **对话输入框左侧的分支芯片**（Composer 工具行）：显示当前会话目录所属仓库与分支，点开即可**保存、推送、拉取或切换分支**。

## 当前形态：只保留输入框芯片

`client.js` 顶部的 `SHOW_PANEL = false` 关闭了左侧导航的「分支管理」入口与全屏面板，插件现在只贡献**输入框左侧的分支芯片**。想恢复面板把该常量改成 `true` 即可。

## 芯片与分支列表

- 显示 `仓库名 + 当前分支`，以及：
  - **`未保存 N`**（琥珀）：已跟踪文件里还没保存到本地分支的改动；
  - **`未跟踪 M`**（灰）：新文件数量，保存时会一并保存；
  - **`未推送 N`**（蓝）：本地已有提交但远端没有。
- 会话目录下有多个仓库时带 `N仓库` 角标，点开可切仓库；选择会按目录记住。
- 点击打开分支列表：支持筛选、多仓库切换、查看同步状态与最近提交。
- 点击「切换」执行 `git switch`；远端分支会先创建本地跟踪分支。
- 被其它 worktree 占用的分支会标「工作树占用」并禁止切换。

## 快捷操作

| 按钮 | 出现位置 | 实际执行 |
|---|---|---|
| **保存** | 当前分支行，且不是 `master` | 把当前分支全部改动提交到本地：`git add -A`（排除 `.dsh-backups/`、`.tmp/`、`.cache/`、`.DS_Store`）后 `git commit`。提交说明默认由改动路径生成中文摘要（如 `保存：资金看板、司库可视化看板（3 个文件）`），也可由调用方传入 `message`。**不推送**，不创建 stash |
| **推送** | 除 `master` 外的所有分支行 | 当前分支有上游 → `git push`；无上游 → `git push -u origin <分支>`；非当前分支 → `git push origin <分支>`。没有已提交内容时按钮置灰；有未保存改动时先确认「保存并推送」。不强推；失败显示 git 原始错误 |
| **拉取** | 仅 `master` 行 | 不切换分支：`git fetch origin master:master` 快进本地 master；若 master 正被检出则 `git pull --ff-only`。分叉或 master 在别的 worktree 里时 git 会拒绝 |
| **切换** | 所有分支行 | 工作区干净才执行 `git switch`；有未保存改动时先提示保存。例外：`master` 禁止保存，若 master 上有改动，允许确认后把改动带到工作分支 |

### 保存的边界

- 不提供文件选择：一次保存当前分支全部改动。
- 自动排除本地临时内容：`.dsh-backups/`、`.tmp/`、`.cache/`、`.DS_Store`。
- 合并、rebase、cherry-pick、revert 进行中时禁止保存。
- detached HEAD 或 `master` 上禁止保存。
- 保存后重新检查工作区；如果 hook 又改了文件，不会继续切换。
- 保存只到本地分支；需要远端时再点「推送」。

### 切换的边界

- 工作区有未保存改动时，提示「保存并切换」/「取消」，不会自动清空或暂存。
- `master` 有改动时只能把改动带到工作分支（会二次确认）；`master` 本身不允许保存。
- 分支名按完整名称精确匹配，`yhj/JTSM-7838` 不会被解析成 `JTSM-7838`。
- 切换失败时保留现场并显示 git 错误。

## 安全边界

- 读取使用 `git for-each-ref / status / worktree list / remote refs`。
- 写操作只有显式点击的 `save / push / pull / switch`，Host 端对同一仓库串行执行。
- **不再提供暂存、丢弃、强制切换入口**。
- `master` 不允许保存或推送，只允许拉取。
- 推送前有确认；不执行 `push --force`。
- 拉取只允许 `master`，且只做快进，不自动合并/rebase。

## 状态说明（芯片弹窗里的 `?` 按钮）

展示每种徽标的含义与对应操作：当前 / 未保存 / 未跟踪 / 未推送 / 工作树占用 / 已同步 / 领先·落后·分叉 / 无上游 / 上游已删除。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里给该行加 config：

```yaml
- id: branch-overview
  config:
    repos: [/absolute/path/to/repo]   # 额外扫描不在工作区里的仓库
    depth: 2                          # 工作区内向下扫描层数（1~2，默认 2）
```

## 安装

```bash
# npm（推荐，市场更新也走这个源）
dsh plugin --profile web add dsh-branch-overview
# 桌面版把 web 换成 desktop

# GitHub（备选）
dsh plugin --profile web add github:Junyinoie/dsh-branch-overview

# 本地目录（开发）
dsh plugin --profile desktop add link:/绝对路径/dsh-branch-overview
```

## 开发与测试

```bash
npm test
```

测试覆盖：保存包含新文件、排除本地备份、`master` 保存/推送保护、脏工作区切换、保存后切换、脏 `master` 迁移、带 `/` 分支切换、rebase 中禁止保存。

## 发布与更新流程

插件同时发布在 npm 和 GitHub。DSH 市场对已安装插件的更新执行 `dsh plugin add dsh-branch-overview@latest`，所以每次发版必须同步发布 npm；只推 GitHub 标签时，市场更新会失败。

1. 修改代码并更新 `package.json` 版本（当前为 `0.3.1`）。
2. `npm test` 通过。
3. 提交并推送 `main`，打标签 `vX.Y.Z` 并推送标签。
4. 在插件目录发布 npm：

```bash
npm login --auth-type=web   # 首次登录
npm publish --access public
```

`npm publish` 会要求 npm 账号的 2FA 验证码；按提示输入即可。

5. 验证：

```bash
npm view dsh-branch-overview version
```

6. 已安装用户在 DSH 市场的「已安装」里点检查更新/更新，完成后重启 DSH。

```bash
git add -A
git commit -m "feat: 中文提交说明与推送禁用态"
git tag v0.3.1
git push origin main --tags
```

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 端：扫描、保存、推送、拉取、切换 |
| `client.js` | 浏览器端：分支芯片、切换对话框、快捷操作 |
| `cordis.patch.yml` | bundle 补丁，插入 `branch-overview` 行 |
| `locale/*.json` · `icon.svg` | 插件管理页的名称/描述与图标 |
| `test/index.test.js` | Node 测试，使用临时 git 仓库验证写操作 |

Host 端通过 `workspaceRegistry` 取工作区列表；芯片通过会话 `cwd` 定位仓库。
