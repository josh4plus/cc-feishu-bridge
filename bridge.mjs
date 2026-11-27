#!/usr/bin/env node
/**
 * 飞书 ↔ Claude Code 桥接
 *
 * 长连接（WebSocket）收飞书消息 → 喂给常驻的 `claude` 子进程 → 回复到飞书。
 * 一个飞书会话（chat_id）对应一段 Claude 会话，sessionId 存在 state.json，重启后自动续聊。
 *
 * 配置：config.json（见 config.example.json）
 * 启动：./scripts/start.sh
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import { mdToPost, FEISHU_RULES } from './feishu-format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');
const STATE_PATH = join(HERE, 'state.json');
const LOG_DIR = join(HERE, 'logs');
const INBOX = join(HERE, 'inbox');
mkdirSync(LOG_DIR, { recursive: true });

// 每次启动换一个日志文件，避免无限增长
const LOG_PATH = join(LOG_DIR, `bridge-${new Date().toISOString().slice(0, 10)}.log`);

if (!existsSync(CONFIG_PATH)) {
  console.error(`缺少配置文件：${CONFIG_PATH}`);
  console.error('先执行：cp config.example.json config.json 然后填入 appId / appSecret');
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const APP_ID = config.appId;
const APP_SECRET = config.appSecret;
if (!APP_ID || !APP_SECRET || APP_ID.startsWith('cli_xxx')) {
  console.error('config.json 里 appId / appSecret 还没填。');
  process.exit(1);
}

const CLAUDE_BIN = config.claudeBin || 'claude';
const WORKDIR = resolve(config.workdir || process.env.HOME || process.cwd());
const TIMEOUT_MS = (config.timeoutSeconds ?? 600) * 1000;
const MAX_REPLY = config.maxReplyChars ?? 26000;
const ALLOWED = new Set(config.allowedOpenIds || []);
const ALLOWED_TOOLS = typeof config.allowedTools === 'string' ? config.allowedTools : '';
const REPLY_FORMAT = config.replyFormat === 'post' ? 'post' : 'text';
// 未配置 → 用 bypassPermissions（后台无人审批）；配置成 "" → 不传该参数，走 claude 默认
const PERM_MODE = config.claudePermissionMode === undefined ? 'bypassPermissions' : config.claudePermissionMode;
const EXTRA_PROMPT = config.appendSystemPrompt || '';
const MERGE_MS = config.mergeSeconds ? config.mergeSeconds * 1000 : 3000;
const STREAM = config.stream !== false;                    // 流式卡片开关，默认开
const STREAM_INTERVAL = config.streamIntervalMs ?? 500;    // 两次更新之间的最小间隔

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch (e) { /* 日志写不进去也不能影响主流程 */ }
  process.stdout.write(line);
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 1), 'utf8');
}

// ── 飞书 Open API 直连（只在需要控制回复类型/回复锚点时用） ────────────
let TOKEN = { val: '', exp: 0 };
async function tenantToken() {
  if (TOKEN.val && Date.now() < TOKEN.exp) return TOKEN.val;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`换取 tenant_access_token 失败：${j.code} ${j.msg}`);
  TOKEN = { val: j.tenant_access_token, exp: Date.now() + (j.expire || 7000) * 1000 - 60000 };
  return TOKEN.val;
}

async function feishu(path, method, body) {
  const token = await tenantToken();
  const res = await fetch('https://open.feishu.cn/open-apis' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function truncate(text) {
  return text.length > MAX_REPLY ? text.slice(0, MAX_REPLY) + '\n…（过长已截断）' : text;
}

function msgBody(text) {
  return REPLY_FORMAT === 'post'
    ? { msg_type: 'post', content: JSON.stringify(mdToPost(text)) }
    : { msg_type: 'text', content: JSON.stringify({ text }) };
}

async function createMessage(chatId, text) {
  const j = await feishu('/im/v1/messages?receive_id_type=chat_id', 'POST', {
    receive_id: chatId, ...msgBody(truncate(text)),
  });
  if (j.code !== 0) throw new Error(`${j.code} ${j.msg}`);
  return j.data.message_id;
}

/** 回复某条消息（飞书会把它挂在这条消息下面，并给用户推送提醒） */
async function replyMessage(messageId, text) {
  const j = await feishu('/im/v1/messages/' + messageId + '/reply', 'POST', msgBody(truncate(text)));
  if (j.code !== 0) throw new Error(`${j.code} ${j.msg}`);
  return j.data.message_id;
}

async function react(messageId, emoji) {
  try {
    const j = await feishu('/im/v1/messages/' + messageId + '/reactions', 'POST', {
      reaction_type: { emoji_type: emoji },
    });
    if (j.code !== 0) { log(`✗ 加表情 ${j.code} ${j.msg}`); return null; }
    return j.data.reaction_id;
  } catch { return null; }
}

async function unreact(messageId, reactionId) {
  if (!reactionId) return;
  try { await feishu('/im/v1/messages/' + messageId + '/reactions/' + reactionId, 'DELETE'); } catch { /* 忽略 */ }
}

// ── 流式卡片（CardKit）──────────────────────────────────────────────────
// 四步：建卡 → 节流更新 → 失败重开 → 收尾关掉 streaming_mode。
// 不关最后那步的话，飞书会话列表会一直显示"正在生成"。
const STREAM_ELEMENT = 'stream_md';

/** 收尾时写进会话列表的一行摘要：取正文首个非空行，去掉 markdown 记号 */
function summarize(text, max = 30) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '已完成';
  const clean = line.replace(/[*_`#>]/g, '').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function streamCardJson() {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '[生成中]' },
      streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' },
    },
    body: { elements: [{ tag: 'markdown', element_id: STREAM_ELEMENT, content: '' }] },
  };
}

/** 建卡片实体并发到会话（挂在触发消息下，用户才会收到提醒）。失败返回 null。 */
async function createStreamCard(chatId, replyToMessageId) {
  const created = await feishu('/cardkit/v1/cards', 'POST', {
    type: 'card_json',
    data: JSON.stringify(streamCardJson()),
  });
  if (created.code !== 0) { log(`✗ 建卡失败 ${created.code} ${created.msg}`); return null; }
  const cardId = created.data?.card_id;
  if (!cardId) return null;

  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  try {
    if (replyToMessageId) {
      const j = await feishu('/im/v1/messages/' + replyToMessageId + '/reply', 'POST', {
        msg_type: 'interactive', content,
      });
      if (j.code !== 0) throw new Error(`${j.code} ${j.msg}`);
    } else {
      const j = await feishu('/im/v1/messages?receive_id_type=chat_id', 'POST', {
        receive_id: chatId, msg_type: 'interactive', content,
      });
      if (j.code !== 0) throw new Error(`${j.code} ${j.msg}`);
    }
  } catch (e) {
    log(`✗ 建了卡但发不出去：${e.message}`);
    return null;
  }
  return cardId;
}

async function updateStreamText(cardId, text, sequence) {
  const j = await feishu(
    `/cardkit/v1/cards/${cardId}/elements/${STREAM_ELEMENT}/content`, 'PUT',
    { content: text, sequence },
  );
  if (j.code !== 0) { log(`✗ 更新卡片 ${j.code} ${j.msg}`); return false; }
  return true;
}

async function setStreamingMode(cardId, enabled, sequence, summary) {
  // 只关 streaming_mode 不换 summary，飞书会话列表会一直显示建卡时的「[生成中]」
  const cfg = { streaming_mode: enabled };
  if (summary) cfg.summary = { content: summary };
  const j = await feishu(`/cardkit/v1/cards/${cardId}/settings`, 'PATCH', {
    settings: JSON.stringify({ config: cfg }),
    sequence,
    uuid: randomUUID(),
  });
  if (j.code !== 0) { log(`✗ 设置 streaming=${enabled} ${j.code} ${j.msg}`); return false; }
  return true;
}

/**
 * 建卡 + 节流更新的持有者。
 * push() 是同步的：只记最新文本，由内部定时器按节流节奏往飞书推。
 */
class StreamCard {
  constructor(chatId, replyToMessageId) {
    this.chatId = chatId;
    this.replyTo = replyToMessageId;
    this.cardId = null;
    this.text = '';
    this.sequence = 0;
    this.lastSendAt = 0;      // 上次「决定发送」的时刻，节流的锚点
    this.failed = false;
    this.timer = null;
    this.chain = Promise.resolve();   // 所有更新排队串行，避免 PUT 乱序
  }

  async start() {
    this.cardId = await createStreamCard(this.chatId, this.replyTo);
    if (!this.cardId) this.failed = true;
    return this.cardId;
  }

  /** 只记录文本；按节流节奏决定何时真的推 */
  push(text) {
    this.text = truncate(text);
    if (this.failed || !this.cardId) return;
    const wait = this.lastSendAt + STREAM_INTERVAL - Date.now();
    if (wait <= 0) this.send();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.send(); }, wait);
    }
  }

  /** 同步登记一次发送（锚点立刻更新），实际请求排队执行 */
  send() {
    if (this.failed || !this.cardId) return this.chain;
    this.lastSendAt = Date.now();
    const snapshot = this.text;
    this.chain = this.chain.then(() => this.doUpdate(snapshot)).catch(() => {});
    return this.chain;
  }

  async doUpdate(snapshot) {
    if (this.failed || !this.cardId) return;
    const seq = ++this.sequence;
    let ok = await updateStreamText(this.cardId, snapshot, seq);
    if (!ok) {
      // 飞书会因超时把 streaming_mode 关掉，单靠重试救不回来，必须先重开
      this.sequence = seq + 1;
      if (await setStreamingMode(this.cardId, true, this.sequence)) {
        this.sequence += 1;
        ok = await updateStreamText(this.cardId, snapshot, this.sequence);
      }
    }
    if (!ok) {
      this.failed = true;
      log('✗ 流式更新连续失败，改用普通消息');
    }
  }

  /** 收尾：等排队中的更新落定，推最终内容，再显式关掉 streaming_mode */
  async finish() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.failed || !this.cardId) return false;
    await this.chain;
    if (this.failed) return false;

    this.sequence += 1;
    let ok = await updateStreamText(this.cardId, this.text, this.sequence);
    if (!ok) {
      this.sequence += 1;
      await setStreamingMode(this.cardId, true, this.sequence);
      this.sequence += 1;
      ok = await updateStreamText(this.cardId, this.text, this.sequence);
      if (!ok) { this.failed = true; return false; }
    }
    this.sequence += 1;
    const summary = summarize(this.text);
    if (!await setStreamingMode(this.cardId, false, this.sequence, summary)) {
      this.sequence += 1;
      await setStreamingMode(this.cardId, false, this.sequence, summary);
    }
    return true;
  }
}

// ── 附件处理 ──────────────────────────────────────────────────────────
// 图片：直接下载，让模型用 Read 打开（Claude Code 原生支持读图，跨平台）。
// 语音/OCR：本地工具依赖重，做成可插拔命令，没配就只给文件路径。
const FFMPEG = config.ffmpegPath || 'ffmpeg';

async function downloadResource(messageId, fileKey, kind, dest) {
  const token = await tenantToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${encodeURIComponent(fileKey)}?type=${kind}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function runCmd(cmd, args, input) {
  return new Promise((resolvePromise) => {
    let p;
    try {
      p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
    } catch {
      return resolvePromise({ code: -1, out: '' });
    }
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolvePromise({ code, out }));
    p.on('error', () => resolvePromise({ code: -1, out: '' }));   // 命令不存在
    if (input) { try { p.stdin.end(input); } catch { /* 忽略 */ } }
  });
}

/**
 * 自定义转写命令：把 {input} 换成音频路径，stdout 就是文字。
 * 例："whisper {input} --language zh --output-txt --output_dir /tmp && cat /tmp/x.txt"
 * 留空则不转写。
 */
async function transcribeAudio(file) {
  if (!config.transcribeCommand) return '';
  const withWav = file.replace(/\.[^.]+$/, '') + '.wav';
  const conv = await runCmd(FFMPEG, ['-v', 'error', '-y', '-i', file, '-ar', '16000', '-ac', '1', withWav]);
  const input = conv.code === 0 ? withWav : file;
  const parts = config.transcribeCommand.replace(/\{input\}/g, JSON.stringify(input)).split(/\s+/);
  const r = await runCmd(parts[0], parts.slice(1));
  return r.code === 0 ? r.out.trim() : '';
}

async function ocrImage(file) {
  if (!config.ocrCommand) return '';
  const parts = config.ocrCommand.replace(/\{input\}/g, JSON.stringify(file)).split(/\s+/);
  const r = await runCmd(parts[0], parts.slice(1));
  return r.code === 0 ? r.out.trim() : '';
}

function extractText(message) {
  try {
    const c = JSON.parse(message.content || '{}');
    return (c.text || '').replace(/@_user_\d+/g, '').trim();
  } catch {
    return '';
  }
}

/** 把任意类型的飞书消息变成给模型的一段话；不支持的类型返回空串。 */
async function messageToText(msg) {
  const type = msg.message_type || msg.msg_type;
  if (type === 'text') return extractText(msg);

  let c = {};
  try { c = JSON.parse(msg.content || '{}'); } catch { return ''; }
  const id = msg.message_id;
  const day = new Date().toISOString().slice(0, 10);

  try {
    if (type === 'image' && c.image_key) {
      const dest = join(INBOX, day, id + '.jpg');
      await downloadResource(id, c.image_key, 'image', dest);
      const text = await ocrImage(dest);
      log(`· 收到图片 ${dest}${text ? `（OCR ${text.length} 字）` : ''}`);
      return `[用户发来一张图片，本地路径：${dest}]\n要看画面内容就用 Read 打开这个文件。` +
        (text ? `\n画面文字 OCR（可能不全，以你看到的为准）：${text}` : '');
    }
    if (type === 'audio' && c.file_key) {
      const dest = join(INBOX, day, id + '.opus');
      await downloadResource(id, c.file_key, 'audio', dest);
      const text = await transcribeAudio(dest);
      log(`· 收到语音 ${dest}${text ? `（转写 ${text.length} 字）` : '（未转写）'}`);
      return text
        ? `[用户发来一段语音，转写如下]\n${text}`
        : `[用户发来一段语音，文件在 ${dest}，但没配置语音转写（config.transcribeCommand）]`;
    }
    if (type === 'file' && c.file_key) {
      const safe = (c.file_name || id + '.bin').replace(/[/\\]/g, '_');
      const dest = join(INBOX, day, `${id}-${safe}`);
      await downloadResource(id, c.file_key, 'file', dest);
      log(`· 收到文件 ${dest}`);
      return `[用户发来一个文件：${dest}（原始文件名 ${c.file_name || '未知'}）]`;
    }
    if (type === 'media' && c.file_key) {
      const dest = join(INBOX, day, id + '.mp4');
      await downloadResource(id, c.file_key, 'media', dest);
      log(`· 收到视频 ${dest}`);
      return `[用户发来一段视频：${dest}]`;
    }
    if (type === 'post') {
      const hits = JSON.stringify(c).replace(/\\"/g, '"').match(/"text":"([^"]*)"/g);
      return (hits || []).map((s) => s.slice(8, -1)).join('').trim();
    }
  } catch (e) {
    log(`✗ 处理附件失败：${e.message}`);
    return `[用户发来一个附件，但下载/处理失败：${e.message}]`;
  }
  return '';
}

// ── Claude 常驻进程 ───────────────────────────────────────────────────
const SESSIONS = new Map();

function buildPrompt() {
  return EXTRA_PROMPT ? FEISHU_RULES + '\n\n' + EXTRA_PROMPT : FEISHU_RULES;
}

function getSession(chatId) {
  const cur = SESSIONS.get(chatId);
  if (cur && cur.proc && cur.proc.exitCode === null) return cur;

  const st = loadState();
  const sid = st[chatId]?.sessionId;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (PERM_MODE) args.push('--permission-mode', PERM_MODE);
  if (ALLOWED_TOOLS) args.push('--allowedTools', ALLOWED_TOOLS);
  args.push('--append-system-prompt', buildPrompt());
  if (sid) args.push('--resume', sid);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: WORKDIR,
    env: { ...process.env, HOME: process.env.HOME || WORKDIR },
  });
  const s = { proc, buf: '', pending: null };

  proc.stdout.on('data', (d) => {
    s.buf += d.toString();
    let i;
    while ((i = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, i).trim();
      s.buf = s.buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (s.pending) s.pending(ev);
    }
  });
  proc.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) log('· claude stderr: ' + t.slice(0, 300)); });
  proc.on('exit', (code) => {
    if (SESSIONS.get(chatId) === s) SESSIONS.delete(chatId);
    if (s.pending) {
      const f = s.pending;
      s.pending = null;
      f({ type: 'result', result: `❌ claude 进程退出了（code ${code}），下条消息会重启` });
    }
  });
  proc.on('error', (e) => {
    if (SESSIONS.get(chatId) === s) SESSIONS.delete(chatId);
    log(`✗ 启动 claude 失败：${e.message}（检查 config.claudeBin 是否指向可执行文件）`);
  });

  SESSIONS.set(chatId, s);
  log(`启动常驻 claude 进程 chat=${chatId.slice(-6)} resume=${sid ? 'yes' : 'no'}`);
  return s;
}

function askOnce(chatId, prompt, onProgress) {
  return new Promise((resolvePromise) => {
    const s = getSession(chatId);
    let live = '';
    const timer = setTimeout(() => {
      try { s.proc.kill('SIGKILL'); } catch { /* 忽略 */ }
      SESSIONS.delete(chatId);
      const mins = Math.round(TIMEOUT_MS / 60000);
      resolvePromise({
        text: live
          ? live + `\n\n⏱ 跑到 ${mins} 分钟被中止，以上是已经生成的部分。`
          : `⏱ 跑了 ${mins} 分钟还没产出内容，已中止。可以直接再发一次。`,
        sessionId: null,
      });
    }, TIMEOUT_MS);

    s.pending = (ev) => {
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        const t = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (t) { live = live ? live + '\n\n' + t : t; onProgress(live); }
      }
      if (ev.type === 'result') {
        clearTimeout(timer);
        s.pending = null;
        resolvePromise({ text: ev.result || live || '(空回复)', sessionId: ev.session_id });
      }
    };

    s.proc.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }) + '\n');
  });
}

async function handleTurn(chatId, prompt, parts) {
  const state = loadState();
  const triggerId = parts.length ? parts[0].msgId : null;

  const card = STREAM ? new StreamCard(chatId, triggerId) : null;
  if (card) await card.start();

  let res;
  try {
    res = await askOnce(chatId, prompt, (live) => { if (card) card.push(live); });
  } catch (e) {
    // 卡片已经发出去了，异常也要把卡收尾，否则会一直显示"生成中"
    res = { text: `❌ 处理失败：${e.message}`, sessionId: null };
  }

  state[chatId] = { sessionId: res.sessionId, updated: new Date().toISOString() };
  saveState(state);
  log(`→ 回复 ${res.text.length} 字`);

  // 流式卡片成功就到此为止；建卡失败或中途失败才退回普通消息
  let streamed = false;
  if (card && !card.failed) {
    card.text = truncate(res.text || card.text);
    streamed = await card.finish();
  }

  try {
    if (!streamed) {
      if (triggerId) await replyMessage(triggerId, res.text);   // 回复原消息 → 用户收到提醒
      else await createMessage(chatId, res.text);
    }
  } catch (e) {
    log(`✗ 发送失败：${e.message}`);
  }
  for (const p of parts) {
    await unreact(p.msgId, p.rid);
    await react(p.msgId, 'DONE');
  }
}

// ── 事件分发 ──────────────────────────────────────────────────────────
const BOOT_TS = Date.now();

// 飞书断线重连会重放事件，必须按 message_id 去重
const SEEN_PATH = join(LOG_DIR, 'seen.json');
let SEEN = new Set();
try { SEEN = new Set(JSON.parse(readFileSync(SEEN_PATH, 'utf8'))); } catch { /* 首次运行 */ }
function markSeen(id) {
  SEEN.add(id);
  const arr = Array.from(SEEN).slice(-300);
  SEEN = new Set(arr);
  try { writeFileSync(SEEN_PATH, JSON.stringify(arr), 'utf8'); } catch { /* 忽略 */ }
}

// 同一会话串行，避免两条消息同时续同一个 session
const queues = new Map();
function enqueue(key, task) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

async function reply(chatId, text) {
  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: truncate(text) }) },
    });
  } catch (e) {
    log(`✗ 发消息失败：${e.message}`);
  }
}

const buffers = new Map();

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const msg = data.message;
    const sender = data.sender?.sender_id?.open_id || '';
    const chatId = msg.chat_id;
    const chatType = msg.chat_type;

    if (SEEN.has(msg.message_id)) { log('跳过重复消息 ' + msg.message_id.slice(-8)); return; }
    if (msg.create_time && Number(msg.create_time) < BOOT_TS - 60000) {
      log('跳过启动前的旧消息 ' + new Date(Number(msg.create_time)).toLocaleTimeString('zh-CN', { hour12: false }));
      return;
    }
    markSeen(msg.message_id);

    if (config.botOpenId && sender === config.botOpenId) return;   // 别回自己
    if (data.sender?.sender_type === 'bot') return;               // 别回别的机器人

    if (ALLOWED.size > 0 && !ALLOWED.has(sender)) {
      log(`✗ 拒绝非白名单用户 ${sender}`);
      await reply(chatId, '抱歉，这个机器人只对绑定用户开放。');
      return;
    }

    // 白名单之后才处理附件，避免陌生人触发下载/转写
    const text = await messageToText(msg);
    if (!text) return;

    if (chatType === 'group' && !text.startsWith('/')) {
      // 群里必须真的 @ 到机器人
      if (!msg.mentions || msg.mentions.length === 0) return;
    }

    log(`← [${chatType}] ${sender}: ${text.slice(0, 80)}`);

    const b = buffers.get(chatId) || { parts: [], timer: null };
    b.parts.push({ text, rid: null, msgId: msg.message_id });
    if (!b.timer) {
      b.timer = setTimeout(() => {
        buffers.delete(chatId);
        const merged = b.parts.map((x) => x.text).join('\n');
        const snapshot = b.parts.slice();
        enqueue(chatId, () => handleTurn(chatId, merged, snapshot));
      }, MERGE_MS);
    }
    buffers.set(chatId, b);
  },
});

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

log(`启动 app=${APP_ID} claude=${CLAUDE_BIN} workdir=${WORKDIR} 白名单=${ALLOWED.size || '不限'} 回复格式=${REPLY_FORMAT}`);
wsClient.start({ eventDispatcher: dispatcher });
log('长连接已发起，等待飞书消息…（Ctrl-C 退出）');

process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); process.exit(0); });
