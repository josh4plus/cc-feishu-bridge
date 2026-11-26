---
name: cc-feishu-bridge
description: >-
  把 Claude Code 接到飞书，让你在手机上跟本机的 Claude 对话：飞书发消息 →
  本机 claude 会话处理 → 结果回飞书，支持续聊、图片/文件/语音附件、群聊 @ 触发。
  当用户说「在飞书里用 Claude」「配置飞书机器人」「飞书通道」「手机上跟 Claude 说话」
  「把 CC 接到飞书」「飞书 bridge」时使用。本技能包含完整的飞书开放平台配置步骤、
  一键安装脚本和排错表，从零到能收到回复大约 10 分钟。
argument-hint: [安装|排错|启动|停止|状态]
user-invocable: true
allowed-tools: Bash, Read, Write, Edit
---

# Claude Code ↔ 飞书

在飞书里发一句话，本机的 Claude Code 接住，干完活把结果发回来。

**你（Claude）执行这个技能时**：先判断用户走到哪一步了——已经装好了就跳到「启动/排错」，
没装就从「第 1 步：飞书开放平台」开始。别跳步，飞书后台配置漏一步就连不上。

---

## 它是怎么跑的

```
飞书 App（手机/电脑）
   ↕  WebSocket 长连接（不用公网 IP、不用内网穿透）
bridge.mjs（本机 Node 进程）
   ↕  常驻子进程，stdin/stdout 走 stream-json
claude（你本机的 Claude Code CLI）
```

几个关键设计，排错时要记住：

- **长连接是反向连出去的**，所以家里电脑、公司内网、没有公网 IP 都能用，不需要 nginx、不需要域名、不需要备案。
- **每个飞书会话对应一段 Claude 会话**，`chat_id → sessionId` 存在 `state.json`，重启进程不丢上下文。
- **claude 是常驻子进程**，不是每条消息新起一个，所以第二轮对话能记住第一轮。
- **要审批的工具调用在飞书里弹不出窗**，所以默认 `bypassPermissions`（见下面「安全」）。

---

## 前置条件

| 要求 | 怎么查 |
|---|---|
| Node.js ≥ 20 | `node -v` |
| Claude Code 已装且已登录 | `claude --version`，终端里跑 `claude` 能正常对话 |
| 一个飞书账号，且**能创建企业自建应用** | 大多数公司账号可以；个人免费版飞书也可以 |
| 电脑能上网 | 不需要公网 IP |

---

## 第 1 步：在飞书开放平台创建应用

打开 https://open.feishu.cn/app → 右上角「创建企业自建应用」。

- 名称随便，比如 `我的 Claude`
- 图标随便传一张
- 创建完进入应用详情页，**记下 `App ID` 和 `App Secret`**（在「凭证与基础信息」页）
  - App ID 形如 `cli_a1b2c3d4e5f6g7h8`
  - App Secret 是一串 32 位字符

**这两个就是 config.json 里的 `appId` 和 `appSecret`。**

> 注意：不要用「群自定义机器人」的 webhook 地址。那种只能单向发消息，收不到消息，本技能用不了。

---

## 第 2 步：开启机器人能力

左侧「添加应用能力」→ 找到「机器人」→ 点「添加」。

不加这个，后面所有消息接口都会报错。

---

## 第 3 步：开通权限

左侧「权限管理」→ 搜索并开通下面 4 个。**一个都不能少**：

| 权限 | 用途 | 不开的后果 |
|---|---|---|
| `im:message.p2p_msg:readonly` | 收单聊消息 | 私聊发消息机器人没反应 |
| `im:message.group_at_msg:readonly` | 收群里 @ 机器人的消息 | 群里 @ 它没反应 |
| `im:message:send_as_bot` | 以机器人身份发消息 | 能收到但回不了 |
| `im:message:readonly` | 下载消息里的图片/文件附件 | 发图片给它会失败 |

搜索框里直接粘权限标识就能搜到，搜不到就换成中文名搜：
「读取用户发给机器人的单聊消息」「获取群组中用户@机器人消息」「以应用的身份发消息」「获取单聊、群组消息」。

---

## 第 4 步：事件订阅 + 选长连接

左侧「事件与回调」→「事件配置」：

1. **订阅方式选「使用长连接接收事件」**——这一步是关键，选错了就只能填公网地址，收不到消息。
2. 点「添加事件」→ 搜索 `接收消息` → 勾选 **「接收消息 v2.0」**（事件标识 `im.message.receive_v1`）→ 添加。

保存后页面应该显示「长连接已配置」之类的状态。**此时不用点「验证」，你的程序启动后会自动连上。**

---

## 第 5 步：发布版本 + 设可用范围

这两步最容易被跳过，导致「代码全对但一条消息都收不到」。

**5.1 设可用范围**：「应用发布」→「版本管理与发布」→ 左侧「可用范围」→ 把你自己（和要用的人）加进去。
不在可用范围里的人，机器人给他发消息会被拒。

**5.2 发布版本**：右上角「创建版本」→ 填版本号（如 `1.0.0`）→ 填更新说明 → 「保存」→「申请线上发布」。

- 如果你是管理员，直接点通过即可。
- 不是管理员的话，要等公司管理员在管理后台审批。

**只有发布通过后，权限和事件才真正生效。** 改完权限必须重新发版，这点踩过很多次。

---

## 第 6 步：本地安装

**推荐装成技能**（装一次，以后任何会话说「配飞书」就能自动加载本技能）：

```bash
git clone https://github.com/josh4plus/cc-feishu-bridge.git ~/.claude/skills/cc-feishu-bridge
cd ~/.claude/skills/cc-feishu-bridge
chmod +x scripts/*.sh
./scripts/setup.sh
```

装完**重开一个 Claude Code 会话**，技能才会被扫描到。

不想要技能、只想当普通程序跑，克隆到任意目录效果一样（比如 `~/cc-feishu-bridge`），
下面的命令把路径换成你的即可。

`setup.sh` 会检查 Node 版本、找 `claude` 的绝对路径、`npm install`、生成 `config.json`（权限 600）。

然后编辑 `config.json`，至少填这两个：

```json
{
  "appId": "cli_你刚才的AppID",
  "appSecret": "你刚才的AppSecret"
}
```

其余字段可以先不管，默认值能跑。完整字段说明见文末。

---

## 第 7 步：跑探针，拿到你自己的 open_id

白名单要填你的 open_id，但你在飞书后台看不到这个值——用探针拿：

```bash
node probe.mjs
```

终端出现 `长连接已发起，等待飞书消息…` 之后，**去飞书里找到这个机器人**，给它发一条「你好」。

- 怎么找：飞书搜索框搜你刚起的应用名（如「我的 Claude」）。
- 如果搜不到：说明第 5 步的「可用范围」没加你，或者版本还没发布。

它会回你一条消息，内容是你的 `open_id` 和 `chat_id`，形如：

```
已登记 ✅
你的 open_id：ou_7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d
会话 chat_id：oc_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

**把 open_id 填进 config.json 的 `allowedOpenIds`**，`chat_id` 填进 `defaultChatId`（给 send.mjs 用）。
填完 Ctrl-C 停掉探针。

> `allowedOpenIds` 留空数组 = 任何人都能用（风险自负）。填了就只认名单里的人。

---

## 第 8 步：启动

```bash
./scripts/start.sh
```

看日志确认真连上了：

```bash
tail -f logs/launch.out
```

要看到这几行才算成功：

```
[ws] ws client ready
长连接已发起，等待飞书消息…
```

**验证闭环**：回飞书给机器人发「介绍一下你现在的工作目录」。

- 回复了 → 通了。
- 没回复但日志有 `← [p2p]` → 是 claude 那边的问题，看日志里的 stderr。
- 完全没日志 → 长连接没建起来，回第 4 步检查订阅方式。

接着发第二条「刚才我问你什么了」——如果它答得出来，说明续聊正常（`state.json` 生效）。

---

## 日常命令

```bash
./scripts/status.sh    # 在不在跑 + 今天日志尾巴
./scripts/stop.sh      # 停（会连带杀掉 claude 子进程）
./scripts/start.sh     # 起
```

进程是 `nohup` 起来的，关掉终端也不影响，但**电脑重启就没了**，需要重新 `start.sh`。
想开机自启，见文末「进阶」。

---

## 主动推送（不靠对话）

桥接只负责「用户说话 → Claude 回话」。如果想让 Claude 主动把报告推到飞书：

```bash
node send.mjs text "跑完了，3 个异常"
node send.mjs file /Users/me/report.html
node send.mjs image /Users/me/chart.png
node send.mjs text "发给别人" --to oc_别人的chatid
```

也可以直接在 Claude 会话里让它调这个脚本——它生成的 html 报告、截图都能这样推过来。

---

## 排错表

按现象查，不要瞎试：

**飞书里发消息，机器人完全没反应**

1. `./scripts/status.sh` 看进程在不在。不在就 `start.sh`。
2. 日志里有没有 `[ws] ws client ready`。没有 → 事件订阅没选「长连接」，或 appId/appSecret 填错（日志会报 token 错误）。
3. 日志里有没有 `← [p2p]`。有 → 消息收到了，问题在下游。
4. 有没有 `✗ 拒绝非白名单用户 ou_xxx`。有 → 这个 open_id 不在 `allowedOpenIds` 里，加进去重启。

**日志报 `token 10014` / `app secret invalid`**
App Secret 复制错了，或者复制时带了空格。重新从「凭证与基础信息」复制，`chmod 600 config.json` 别丢。

**机器人回「抱歉，这个机器人只对绑定用户开放」**
白名单生效了，但没收你。把你自己的 open_id 加进 `allowedOpenIds`。注意 open_id 是**应用维度**的，换应用就变，别拿别的应用的 open_id 来填。

**回复一句「❌ claude 进程退出了」**
`config.json` 的 `claudeBin` 找不到。后台进程的 PATH 和你终端里的不一样——填绝对路径：
```bash
which claude
# 把输出填进 config.json 的 claudeBin
```
（`setup.sh` 一般已经自动填好了。）

**它一直不回，直到超时**
Claude 在处理长任务（超过 `timeoutSeconds`，默认 600 秒）。要么等，要么把这个值调大。超时后它会回你已经跑出来的部分，再发一条会重新开始。

**消息发出去但飞书里不显示新消息**
超过 `maxReplyChars`（默认 26000 字）被截断了，或者飞书限频（同一会话 5 QPS）。看日志有没有 `✗ 发送失败`。

**一次发好几条，机器人只回了一次**
正常。`mergeSeconds`（默认 3 秒）内连发的消息会合并成一轮，避免把半句话喂给 Claude。

**群里 @ 它没反应**
两个条件：机器人在群里 + 真的 @ 到了（消息里带 at 标记）。纯文本写「@我的Claude」不算，要用飞书的 @ 选人。

**重连后它把老消息又答了一遍**
不该发生（有 `message_id` 去重 + 启动时间过滤）。如果发生了，删掉 `logs/seen.json` 重启，并把日志报给我看。

**换了权限 / 加了事件，还是没变**
飞书要求改完权限重新「创建版本并发布」。没发版等于没改。

---

## 安全

- **`config.json` 里是应用密钥，等价于密码。** 已加进 `.gitignore`，别手滑提交。文件权限设 600。
- **默认 `bypassPermissions`**：飞书里没有弹窗让你点「允许」，所以必须让 claude 无人值守地跑工具。这意味着**它可以在你电脑上执行命令、改文件**。
  - 只给可信的人用（`allowedOpenIds` 白名单）。
  - 想收紧：把 `claudePermissionMode` 改成 `"default"`，把 `allowedTools` 写成 `"Read,Grep,Glob"`（只读）。代价是写文件/跑命令会卡住失败。
- **应用密钥泄露了怎么办**：飞书开放平台 →「凭证与基础信息」→ 重置 App Secret，然后更新 config.json 重启。
- 这台电脑关机/睡眠时，机器人不回话。想 7×24 就放一台常开的机器上。

---

## config.json 完整字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` | 必填 | 飞书应用的 App ID |
| `appSecret` | 必填 | 飞书应用的 App Secret |
| `botOpenId` | `""` | 机器人自己的 open_id，填了能防自己回自己。不填也基本没事 |
| `allowedOpenIds` | `[]` | 白名单。空数组 = 谁都能用 |
| `defaultChatId` | `""` | `send.mjs` 不传 `--to` 时发到哪 |
| `claudeBin` | `"claude"` | claude 可执行文件。后台启动建议填绝对路径 |
| `workdir` | 用户主目录 | Claude 的工作目录，它能看到这里的文件 |
| `timeoutSeconds` | `600` | 单轮最长等待，超时杀掉进程并回已生成的部分 |
| `mergeSeconds` | `3` | 连发消息的合并窗口 |
| `maxReplyChars` | `26000` | 单条回复上限，超了截断 |
| `claudePermissionMode` | `"bypassPermissions"` | 权限模式。设 `""` 则不传该参数 |
| `allowedTools` | `""` | 非空时传 `--allowedTools`，会收窄可用工具 |
| `replyFormat` | `"text"` | `text` 纯文本（推荐）；`post` 富文本，表格会降级成「｜」分隔 |
| `appendSystemPrompt` | `""` | 追加在飞书格式规则后面的自定义提示 |
| `ffmpegPath` | `"ffmpeg"` | 语音转码用，没有 ffmpeg 就填绝对路径或留空 |
| `transcribeCommand` | `""` | 语音转写命令，`{input}` 会被替换成音频路径，stdout 即文字 |
| `ocrCommand` | `""` | 图片 OCR 命令，同上。不配也行——图片会交给模型用 Read 直接看 |

**附件是怎么处理的**：图片/文件/视频都会下载到 `inbox/日期/` 然后告诉模型路径，图片模型能自己看。
语音需要你自己配 `transcribeCommand`（比如 whisper），不配就只给路径。

---

## 进阶

**开机自启（macOS）**

创建 `~/Library/LaunchAgents/cc.feishu.bridge.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cc.feishu.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /Users/你的用户名/cc-feishu-bridge && node bridge.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/你的用户名/cc-feishu-bridge/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>/Users/你的用户名/cc-feishu-bridge/logs/launchd.out</string>
</dict>
</plist>
```

然后 `launchctl load ~/Library/LaunchAgents/cc.feishu.bridge.plist`。
注意用 `/bin/bash -lc` 而不是直接跑 node——要加载你 shell 的 PATH，否则找不到 claude。

**开机自启（Linux）**

```
# ~/.config/systemd/user/cc-feishu-bridge.service
[Unit]
Description=Claude Code Feishu Bridge
After=network.target

[Service]
WorkingDirectory=%h/cc-feishu-bridge
ExecStart=/usr/bin/node bridge.mjs
Restart=always
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

`systemctl --user enable --now cc-feishu-bridge`

**多个飞书会话互相隔离**
天生就是：每个 `chat_id` 一段独立 claude 会话。群聊里 @ 它，等于群里所有人共用一个会话。

**换个模型 / 用别的 CLI**
`claudeBin` 只是个可执行文件路径，指向别的兼容 CLI 也行，只要支持 `-p --input-format stream-json --output-format stream-json`。
