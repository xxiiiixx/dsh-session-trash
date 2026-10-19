# dsh-session-trash

**DeepSeek Harness 桌面版会话回收站** —— 从侧边栏菜单把会话移入可还原的回收站，
再在 **设置 → 会话回收站** 里还原或永久清除。

[English](README.md) | 中文

![会话回收站图标](icon.svg)

## 简介

Harness 会永久保留每一个会话日志。`sessionPersistence` 本身没有删除 API
（*"Nothing deletes session files"*），工作区注册表只提供归档，日志仍留在磁盘上。
这个插件补上了缺失的能力，并把它做成最安全的形态：**可还原**的移动、
**仅用户**触发、**任何文件路径都不经过网络传输**。

## 目录

- [使用](#使用)
- [配置](#配置)
- [安全设计](#安全设计)
- [作用范围](#作用范围)
- [验证](#验证)
- [更多](#更多)
- [免责声明](#免责声明)
- [已知限制](#已知限制)

-----

<a id="使用"></a>
## 使用

| 位置 | 作用 |
|---|---|
| 会话行 → `…` 菜单 | **移入回收站** —— 直接采用原生 `MenuItemButton` 的尺寸（高度、内边距、图标位、文字节奏）与危险配色 |
| 确认框 | 移动前显示标题、原路径与占用大小；确认键用原生“描边 + 红字”，取消键为描边 |
| 设置 → **会话回收站** | 列出已删除会话，可**还原**、**永久清除**、**清空回收站** |
| Harness 启动时 | 静默清除超过 `retentionDays`（默认 30 天）的条目 |

删除动作是用一次 `rename` **移动会话目录**到
`$DSH_HOME/session-trash/<UTC 时间戳>-<会话 id>/`，并在旁边写入 `manifest.json`。
全程不复制文件，所以中断不会留下“删了一半”的会话；移动失败时两个目录都保持原样。

### 安装

与其他插件完全一致的安装位置：

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-session-trash
```

或用本地目录：在「设置 → 插件 → 添加」里指向该目录（或调用 `plugin_manager`
的 `install_bundle`）。插入的 Loader 行名为 `dsh-session-trash`，安装后立即启用。
如果 Plugin Manager 返回 `restart-required`，请重启 Harness。

### 更新已安装的版本

从 GitHub 安装是**把包复制**进 profile 的 `node_modules`，**不会**链接回源码目录。
所以只改维护目录里的代码不会生效，必须先推送、再替换已安装的副本。

```bash
cd <你的维护目录>
git add -A && git commit -m "..." && git push
```

然后让 Plugin Manager 重装这个 bundle（`remove_bundle` 之后 `install_bundle`
指向 `github:xxiiiixx/dsh-session-trash`，或在「设置 → 插件」里做同样两步）。
重装软件包后需要重启 Harness 才能加载新的 Host 端 JavaScript 代次；Client 端刷新
页面即可。

如果你更希望改完立刻生效，就用**目录路径**安装——那会在 profile 里生成一个
junction 链接，此后一旦移动或重命名该目录，插件就会失效，因为链接仍指向旧位置。

<a id="配置"></a>
## 配置

bundle patch 插入 Host 行时不带任何配置：插件在激活时从运行中的 DSH 主目录推导
两个根目录，所以正常安装无需按机器改动。每个字段都可以在 profile 自己的 patch
层覆盖。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sessionsRoot` | `$DSH_HOME/sessions` | 会话日志所在根目录 |
| `trashRoot` | `$DSH_HOME/session-trash` | 已删除会话移入的目录，必须与 `sessionsRoot` 同卷 |
| `retentionDays` | `30` | 自动清理天数，`0` 表示关闭 |
| `sweepOnStart` | `true` | 每次 Host 启动执行一次清理 |
| `maxTrashEntries` | `500` | 超过该数量拒绝新删除，`0` 表示不限 |

```yaml
- id: dsh-session-trash
  name: 'dsh-session-trash'
  config:
    retentionDays: 90
```

<a id="安全设计"></a>
## 安全设计

删除是破坏性操作，所以这个插件绝大部分代码用来“拒绝”，而不是用来“删除”。

1. **默认可还原。** 删除是移动，不是 unlink；永久清除是回收站页面里另一个明确的动作。
2. **路径不经过网络。** 客户端只发 `{ op, sessionId }` 或 `{ op, trashId }`；
   Host 用自己的根目录解析标识符，请求体里根本没有 `path` 字段可用。
3. **标识符白名单**（`^[A-Za-z0-9._-]+$`、≤ 200 字符、不是 `.`/`..`），解析后再用
   `realpath` + `path.relative` 断言在根目录内，符号链接和构造的 id 都无法越界。
4. **目录必须自证身份。** 移动前读取日志首行 header，`header.id` 与请求的会话不一致即拒绝。
5. **只有正在进行的轮次会阻止删除。** 判定口径与原生归档完全一致：只有该会话的
   Agent `status === 'running'` 才算忙。仅仅还驻留在注册表里的空闲 Agent **不会**
   阻止删除——你已经停止的会话就该能删。若 Agent 接口无法报告状态，则按“正在运行”
   处理：宁可直接拒绝，也不去猜一个可能仍在写入的日志。
6. **派生的 subagent 会话跟着父会话走，分叉不走。** `origin: subagent` 的会话只为父会话
   跑子任务，已停止的会移入**同一个**回收站条目，还原时一起回来；分叉（`isSeeded`）
   是从父会话历史播种后独立存在的会话，留在原地且**不会阻塞**父会话删除。
   仍在运行的派生会话、或自身还有子会话的派生会话，会拒绝整个搬运并说明原因。
7. **只 `rename`，绝不“复制后删除”。** `EXDEV`/`EPERM`/`EBUSY` 直接回报
   `cross-volume` / `busy`，不存在会留下副本或半个副本的兜底路径。
8. **变更串行化。** 每个服务一条 promise 链，并在真正移动前重跑全部预检，
   压缩“对话框到执行”之间的窗口。
9. **不注册任何 agent 工具。** Host 半一个工具都不加，只有用户在界面上点击才能删除
   会话，模型无法调用。
10. **单一端点，走标准鉴权。** `POST /api/session-trash` 挂在 `ctx.connection.fetch`
    上，继承 Harness 的 Host/Origin 与浏览器凭据校验；请求体上限 64 KiB、操作是封闭
    集合、错误只返回稳定 `code` 与固定文案，绝不泄露文件系统路径。
11. **日志才是事实来源。** 删除只做两件旁路工作：把会话从 workspace 的 pin/archive
    集合里去掉，并发出 `api-session/removed` —— 这正是侧边栏已经在监听的事件，所以
    列表行立即消失，不需要插件私有状态。

<a id="作用范围"></a>
## 作用范围

- **允许**：任何未运行、且其派生会话（若有）都已停止的会话。
- **拒绝**：正在运行的会话或派生会话、自身还有子会话的派生会话、无法证明属于该会话的
  目录，以及配置根目录之外的任何路径。
- **不触碰**：被删日志引用过的附件（附件存储全局共享且不可变），以及投影缓存行
  （它们只是提示，会自愈）。

<a id="验证"></a>
## 验证

```bash
npm test            # 65 项：路径、配置、回收站服务、HTTP 路由、Client bundle
npm run e2e         # 通过 HTTP handler 走一遍完整流程
npm run audit       # 对真实会话逐个给出只读判定
npm run check:css   # 与宿主自身样式表逐条比对复制的规则
npm run check:liveness
```

测试会用真实的 Zstandard 日志搭建临时会话根，断言：只读预检、身份不符拒绝、
运行中/派生会话拒绝、原子移动与回滚、manifest 往返、还原冲突、清除越界
（`../../etc` 被拒绝）、损坏 manifest 处理、保留期清理、容量拒绝、并发串行化。
Client 套件会在桩化的模块加载器里**真正执行** `client.js`，断言样式表在任何槽
注册之前就已注入 —— 这正是曾让菜单行看起来像浏览器默认按钮的那个回归。

<a id="更多"></a>
## 更多

- [CHANGELOG](CHANGELOG.md) —— 每个版本改了什么、为什么改。
- `@deepseek-ai/dsh-session-persistence-jsonl` —— 本插件读取与移动的磁盘布局。
- `@deepseek-ai/dsh-workspace` —— 删除后需要更新的 `sessionIds` 注册表。

<a id="免责声明"></a>
## 免责声明

**本插件会删除数据，请在安装前读完这一节。**

- **删了什么由你负责。** 插件会把会话日志移出 `sessionsRoot`，并可应你的要求永久清除。
  你确认的那次删除，改变的是你自己的文件；作者不对会话丢失、历史丢失或无法重建的工作
  承担责任。第一次使用前，请先备份任何不能承受丢失的内容。
- **按“原样”提供，不附带任何担保。** 本软件以 MIT 许可证发布，该许可证按“原样”
  提供软件，不附带任何明示或暗示的担保，并免除因使用本软件所生损害的责任。
  以 [LICENSE](LICENSE) 的条文为准。
- **与 DeepSeek 无隶属关系。** 这是独立的第三方插件，未获得 DeepSeek 的认可、赞助或
  支持。DeepSeek Harness 及其标识归各自所有者所有，此处提及只是为了说明本插件与什么
  协同工作。
- **它依赖可能变化的内部实现。** 插件读取自带 JSONL 后端的磁盘布局，并以复制样式的方式
  依赖宿主自己的菜单组件。Harness 升级可能改动其中任何一处，插件届时可能不再正常工作。
  在把它用于重要数据之前，先拿一个你丢得起的会话验证一遍。
- **移动可能被拒绝或中途失败。** 插件会返回 `cross-volume`、`busy`、`live`、
  `has-children` 等错误码，而不是硬删；搬运中途失败会把已移动的部分放回。**被拒绝是
  安全的结果，不是缺陷**——请不要靠手工改文件去绕过它。
- **只有人能删除。** 插件不注册任何 agent 工具。如果某个会话被删了，那是有人点了按钮，
  责任也在那个人。
- **不承诺支持。** 欢迎提 Issue 和 PR，但不承诺响应时间、修复时限或持续维护。

<a id="已知限制"></a>
## 已知限制

- **本地目录安装没有构建步骤。** 两半都是纯 JavaScript，所以目录安装直接加载。
  改动 Client 刷新页面即可；改动 Host 需要重载插件或重启 Harness，因为 Node 按进程
  缓存 ES 模块。
- 会话是在 `$DSH_HOME/sessions/<项目>/` 下按编码后的 id 匹配的，这正是自带 JSONL
  后端的布局；换成别的持久化后端需要另写定位逻辑。
- 回收站不能跨卷：`trashRoot` 必须与 `sessionsRoot` 同卷。默认两者都在 `$DSH_HOME`
  下，所以只有手动挪动其中一个时才会遇到。

## 许可证

MIT，见 [LICENSE](LICENSE)。
