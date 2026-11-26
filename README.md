# cc-feishu-bridge

把 Claude Code 接到飞书。手机发一句话，家里那台电脑上的 Claude 干活，结果飞书发回来。

```
飞书 App  ←──长连接──→  bridge.mjs  ←──stream-json──→  claude
```

- **不需要公网 IP**：WebSocket 是从你电脑反向连出去的，内网、家宽、公司网都能跑
- **能续聊**：每个飞书会话对应一段 Claude 会话，重启不丢上下文
- **手机随时用**：地铁上问一句「昨天晚上那个脚本跑完没」
- **能收附件**：图片、文件、视频都能传，图片模型直接看
- **能主动推**：`node send.mjs file report.html`

## 安装成 Claude Code 技能（推荐）

克隆到技能目录，重开会话，之后说「配飞书」就会自动加载：

```bash
git clone https://github.com/josh4plus/cc-feishu-bridge.git ~/.claude/skills/cc-feishu-bridge
cd ~/.claude/skills/cc-feishu-bridge
```

只想当普通程序用，克隆到任意目录也一样。

## 快速开始

```bash
./scripts/setup.sh          # 检查环境、装依赖、生成 config.json
vim config.json             # 填 appId / appSecret
node probe.mjs              # 飞书里给机器人发条消息，拿到你的 open_id
vim config.json             # open_id 填进 allowedOpenIds
./scripts/start.sh          # 启动
```

**完整步骤在 [SKILL.md](SKILL.md)**，包括飞书开放平台每一步怎么点、权限要开哪四个、排错表。
照着做 10 分钟能通。

## 文件

| 文件 | 作用 |
|---|---|
| `bridge.mjs` | 桥接主程序 |
| `probe.mjs` | 只读探针，用来拿 open_id |
| `send.mjs` | 主动推送文本/文件/图片 |
| `feishu-format.mjs` | 飞书消息格式规则 |
| `config.example.json` | 配置模板 |
| `scripts/` | 安装、启动、停止、状态 |

## 要求

- Node.js ≥ 20
- Claude Code 已安装并登录
- 飞书企业自建应用（免费版也行）

## 安全提醒

`config.json` 里有应用密钥，已加进 `.gitignore`。默认 `bypassPermissions`——飞书里没有弹窗可点，
所以 Claude 会无人值守地执行工具，**只给可信的人用，务必填 `allowedOpenIds` 白名单**。
细节见 SKILL.md 的「安全」一节。

## License

MIT
