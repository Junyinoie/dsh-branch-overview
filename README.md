# dsh-branch-overview（分支管理 + 切换）

把「分支管理」做成 DSH Web 界面里的插件，两个入口：

1. **左侧导航栏「分支管理」面板**：汇总各工作区 git 仓库的分支与提交情况；
2. **对话输入框左侧的分支芯片**（Composer 工具行）：显示当前会话目录所属仓库与分支，点开即可**随时切换分支**。

## 当前形态：只保留输入框芯片

`client.js` 顶部的 `SHOW_PANEL = false` 关闭了左侧导航的「分支管理」入口与全屏面板，插件现在只贡献**输入框左侧的分支芯片**（工作区里的仓库/分支展示 + 切换）。想恢复面板把该常量改成 `true` 即可（面板代码保留在文件里，Host 路由不变）。

## 面板显示什么（SHOW_PANEL = true 时）

按仓库分组（工作区本身是仓库就直接展示；工作区是项目容器时扫描其子目录里的仓库）：

- **当前分支**、未提交改动数、工作树数量、stash 数量、远端分支数量
- 每个**本地分支**：上游分支、同步状态（已同步 / 领先 N / 落后 N / 分叉 / 无上游 / 上游已删除）、最近提交说明、作者、提交时间
- 分支是否**当前检出**、是否被某个 **git worktree** 占用
- 顶部筛选与刷新；每 60 秒自动刷新；每个仓库有「切换分支」按钮，每行有「切换」操作

## Composer 分支芯片

- 出现在输入框工具行左侧（`conversation.input.left`），显示 `仓库名 + 当前分支`，并区分两个独立状态：
  - **`未保存 N`**（琥珀）= **已跟踪文件**里还没 commit 的改动，只标当前分支；**`未跟踪 M`**（灰）单独标出未跟踪的新文件（`未保存`/`丢弃`/`暂存` 都不处理它们）；
  - **`未推送 N`**（蓝）= 本地已有 commit 但远端没有；有 upstream 的分支用 ahead 数，无 upstream 的用 `git rev-list --count <branch> --not --remotes`（最多探测 30 个分支）。
- 会话目录下有多个仓库时，芯片带 `N仓库` 角标（悬停列出仓库名）；点开可切仓库
- 记住你在该目录下选过的仓库（localStorage，按目录），下次打开/新会话直接显示它；仓库被删掉时自动回退
- 点击打开切换对话框：多仓库可切换标签；支持按分支名/提交说明/上游筛选；每行显示同步状态与最近提交
- 点击「切换」即执行 `git switch`；远端分支（如 `origin/foo`）会先创建本地跟踪分支再切过去
- **工作区有未提交改动时会先确认**（这些改动会被带到新分支）
- 被其它 worktree 占用的分支会标「工作树占用」并禁止在这里切换

## 分支名精确到末级

分支名按 `/` 分层渲染：父级目录（如 `yhj/1102/`）用弱化色，**末级名称**（如 `renzi`）用正常色并加粗；空间不足时只截断父级，末级永远完整显示，悬停可看完整分支名。Composer 芯片、面板行、切换对话框三处一致。

## 状态说明（芯片弹窗里的 `?` 按钮）

弹窗右上角有一个 `?` 图标，点开后展示每种徽标的含义与对应的危险操作：当前 / 未保存 / 未跟踪 / 未推送 / 工作树占用 / 已同步 / 领先·落后·分叉 / 无上游 / 上游已删除，并逐条标注「危险操作」（丢弃不可恢复、推送影响远端、切换会携带改动等）。再点一次回到分支列表。

## 快捷操作（芯片分支列表里）

| 按钮 | 出现位置 | 实际执行 |
|---|---|---|
| **拉取** | 仅 `master` 行 | 不切换分支：`git fetch origin master:master` 快进本地 master；若 master 正被检出则 `git pull --ff-only`。本地有分叉或 master 在别的 worktree 里时 git 会拒绝，错误原样显示 |
| **暂存** | 仅当前分支行（且仓库有未提交改动） | `git stash push -m "dsh-branch-overview <分支> <时间>"`，成功后显示 `stash@{n}`；不包含未跟踪文件 |
| **推送** | 除 master 外的所有分支行 | 当前分支且已有上游 → `git push`；当前分支无上游 → `git push -u origin <分支>`；其它分支 → `git push origin <分支>`。点击前会二次确认，失败显示 git 原始错误 |

| **丢弃** | 仅当前分支行（且仓库有未提交改动） | 带二次确认：确认后执行 `git restore --source=HEAD --staged --worktree .`，丢弃已跟踪文件的改动（含已暂存），**不可撤销**；未跟踪文件不受影响。Host 侧还要求请求显式带 `confirm: true`，否则返回 `confirm-required` |

切换按钮与快捷操作互斥（任一在执行时其余按钮禁用）。

切换分支时若工作区有未提交改动，会弹出提示：**暂存并切换** / **取消**。插件不会自动暂存，只有你点「暂存并切换」才会 `git stash push`（可用 `git stash pop` 恢复）。

## 安全边界

- 读取只用到 `git for-each-ref / status / worktree list / stash list`
- 唯一的写操作是 `/plugin/branch-overview/switch` 里的 `git switch`：不提交、不动 index、不改配置
- `git switch` 失败（冲突、分支不存在等）会把 git 的原始错误返回给界面

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里给该行加 config：

```yaml
- id: branch-overview
  config:
    repos: [/absolute/path/to/repo]   # 额外扫描不在工作区里的仓库
    depth: 2                          # 工作区内向下扫描层数（1~2，默认 2）
```

## 安装（GitHub / 市场）

```bash
# 从 GitHub 安装（市场收录后也可在插件市场一键安装）
dsh plugin --profile web add github:Junyinoie/dsh-branch-overview
# 桌面版把 web 换成 desktop

# 本地目录（开发）
dsh plugin --profile desktop add link:/绝对路径/dsh-branch-overview
```

上架流程见 [SUBMISSION.md](SUBMISSION.md)。

## 分发给同事

```bash
# 在插件目录重新打包（npm 缓存不可写时用临时 cache）
npm pack --pack-destination ../dist --cache /tmp/dsh-npm-cache
```

产物在 `../dist/`：`local-dsh-branch-overview-<version>.tgz`、`INSTALL.md`、`install.sh`、`dsh-branch-overview-<version>-share.zip`。同事安装：

```bash
dsh plugin --profile desktop add "/绝对路径/local-dsh-branch-overview-0.2.0.tgz"
```

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 端：`/plugin/branch-overview/scan`（只读）与 `/plugin/branch-overview/switch`（显式切换） |
| `client.js` | 浏览器端：侧边栏图标 + 主面板 + Composer 分支芯片与切换对话框 |
| `cordis.patch.yml` | bundle 补丁，插入 `branch-overview` 行 |
| `locale/*.json` · `icon.svg` | 插件管理页的名称/描述与图标 |

Host 端通过 `workspaceRegistry` 取工作区列表；Composer 芯片通过会话 `cwd` 定位仓库。
