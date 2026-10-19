# dsh-session-trash — DeepSeek Harness 桌面版会话回收站

[English](README.md) | 中文

从侧边栏把一个会话移入**可还原的回收站**，再在 **设置 → 会话回收站** 里还原或永久清除它。

![会话回收站图标](icon.svg)

## 为什么需要它

Harness 会永久保留每一个会话日志。`sessionPersistence` 本身没有删除 API（“Nothing deletes session files”），工作区注册表只提供归档（日志仍留在磁盘上）。这个插件补上了缺失的能力，并把它做成最安全的形态：**可还原**的移动、**仅用户**触发、**任何路径都不经过网络传输**。

## 功能

| 位置 | 作用 |
|---|---|
| 会话行 → `…` 菜单 | **移入回收站**，确认框显示标题、原路径与占用大小 |
| 设置 → **会话回收站** | 已删除会话列表，可**还原**、**永久清除**、**清空回收站** |
| Harness 启动时 | 静默清除超过 `retentionDays`（默认 30 天）的条目 |

删除动作是用一次 `rename` **移动会话目录**到 `$DSH_HOME/session-trash/<UTC 时间戳>-<会话 id>/`，并在旁边写入 `manifest.json`。全程不复制文件，所以中断不会留下“删了一半”的会话；移动失败时两个目录都保持原样。

## 当前限制

- **用本地目录（link）安装时，改动即时生效**：两半都是纯 JavaScript、无需构建，所以改完刷新页面即可加载新的 Client；Host 半需要重载插件或重启 Harness。
- 会话是在 `$DSH_HOME/sessions/<项目>/` 下按编码后的 id 匹配的，这正是自带 JSONL 后端的布局；换成别的持久化后端需要另写定位逻辑。
- 被删日志引用过的附件不会回收，投影缓存行留待自愈，这两点见「作用范围」。

## 安装

与其他插件完全一致的安装位置。

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-session-trash
```

或用本地目录：在「设置 → 插件 → 添加」里指向该目录（或调用 `plugin_manager` 的 `install_bundle`）。插件插入的 Loader 行名为 `dsh-session-trash`，安装后立即启用。

如果 Plugin Manager 返回 `restart-required`，请重启 Harness。

## 配置

bundle patch 会从 DSH 主目录推导两个根目录，默认值无需手工填写。要改就在 profile 自己的 patch 层覆盖：

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

## 安全设计

删除是破坏性操作，所以代码绝大多数用来“拒绝”，而不是用来“删除”。

1. **默认可还原。** 删除是移动，不是 unlink；永久清除是回收站页面里另一个明确的动作。
2. **路径不经过网络。** 客户端只发 `{ op, sessionId }` 或 `{ op, trashId }`；Host 用自己的根目录解析标识符，请求体里根本没有 `path` 字段可用。
3. **标识符白名单**（`^[A-Za-z0-9._-]+$`、≤ 200 字符、不是 `.`/`..`），解析后再用 `realpath` + `path.relative` 断言在根目录内，符号链接和构造的 id 都无法越界。
4. **目录必须自证身份。** 移动前读取日志首行 header，`header.id` 与请求的会话不一致即拒绝。
5. **运行中与父会话一律拒绝。** 有活跃 Agent 或存在子会话时返回稳定的 `live` / `has-children`，目录原样不动。
6. **只 `rename`，绝不“复制后删除”。** `EXDEV`/`EPERM`/`EBUSY` 直接回报 `cross-volume` / `busy`，不存在会留下副本或半个副本的兜底路径。
7. **变更串行化。** 每个服务一条 promise 链，并在真正移动前重跑全部预检，压缩“对话框到执行”之间的窗口。
8. **不注册任何 agent 工具。** Host 半一个工具都不加，只有用户在界面上点击才能删除会话，模型无法调用。
9. **单一端点，走标准鉴权。** `POST /api/session-trash` 挂在 `ctx.connection.fetch` 上，继承 Harness 的 Host/Origin 与浏览器凭据校验；请求体上限 64 KiB、操作是封闭集合、错误只返回稳定 `code` 与固定文案，绝不泄露文件系统路径。
10. **日志才是事实来源。** 删除只做两件旁路工作：把会话从 workspace 的 pin/archive 集合里去掉，并发出 `api-session/removed` —— 这正是侧边栏已经在监听的事件，所以列表行立即消失，不需要插件私有状态。

## 作用范围

- **允许**：任何未运行、且没有子会话的会话。
- **拒绝**：正在运行的会话、有子会话的会话、无法证明属于该会话的目录、配置根目录之外的任何路径。
- **不触碰**：被删日志引用过的附件（附件存储全局共享且不可变），以及投影缓存行（它们只是提示，会自愈）。

## 验证

```bash
npm test     # node --test：路径、配置、回收站服务、HTTP 路由
```

测试会用真实的 Zstandard 日志搭建临时会话根，断言：只读预检、身份不符拒绝、运行中/子会话拒绝、原子移动、manifest 往返、还原冲突、清除越界（`../../etc` 被拒绝）、损坏 manifest 处理、保留期清理、容量拒绝、并发串行化，以及每一组 HTTP 状态码/错误码。

## 目录结构

```text
index.js            Host 入口：配置、路由、启动清理
lib/paths.js        路径与标识符安全（纯函数）
lib/config.js       配置解析与根目录互斥
lib/sessions.js     只读定位、header 解析、阻断原因
lib/trash.js        唯一的破坏性模块
lib/routes.js       唯一的 POST 端点
client.js           侧边栏菜单行、确认对话框、设置页
locale/{en,zh}.json 插件清单元数据
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
