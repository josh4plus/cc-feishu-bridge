#!/usr/bin/env node
/**
 * 往飞书发消息：文本 / 文件 / 图片。
 *
 * 桥接进程（bridge.mjs）只负责「对话」。这个脚本负责「主动推送」——
 * 比如让 Claude 把生成的报告、截图推到飞书，或者定时任务发通知。
 *
 * 用法：
 *   node send.mjs text "你好"
 *   node send.mjs text "你好" --to oc_xxxxxxxx
 *   node send.mjs file /abs/path/report.html
 *   node send.mjs image /abs/path/chart.png
 *
 * 不指定 --to 时发到 config.json 的 defaultChatId（手动填一个 chat_id）。
 */

import { readFileSync, existsSync, openAsBlob } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');

function usage() {
  console.log(`用法:
  node send.mjs text "内容" [--to oc_xxx]
  node send.mjs file <文件路径> [--to oc_xxx]
  node send.mjs image <图片路径> [--to oc_xxx]`);
  process.exit(1);
}

const [kind, payload] = process.argv.slice(2);
if (!kind || !payload) usage();
if (!['text', 'file', 'image'].includes(kind)) usage();

const toIdx = process.argv.indexOf('--to');
const target = toIdx > 0 ? process.argv[toIdx + 1] : null;

if (!existsSync(CONFIG_PATH)) {
  console.error('缺少 config.json，先 cp config.example.json config.json 并填 appId/appSecret');
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const chatId = target || config.defaultChatId;
if (!chatId) {
  console.error('没有目标会话：传 --to oc_xxx，或在 config.json 里填 defaultChatId');
  process.exit(1);
}

async function token() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`换取 token 失败：${j.code} ${j.msg}`);
  return j.tenant_access_token;
}

async function sendMessage(tk, msgType, content) {
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`发送失败：${j.code} ${j.msg}`);
  return j.data.message_id;
}

async function upload(tk, filePath, isImage) {
  if (!existsSync(filePath)) throw new Error('文件不存在：' + filePath);
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  if (isImage) {
    form.append('image_type', 'message');
    form.append('image', blob, basename(filePath));
  } else {
    form.append('file_type', 'stream');
    form.append('file_name', basename(filePath));
    form.append('file', blob, basename(filePath));
  }
  const url = isImage
    ? 'https://open.feishu.cn/open-apis/im/v1/images'
    : 'https://open.feishu.cn/open-apis/im/v1/files';
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: form });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`上传失败：${j.code} ${j.msg}`);
  return isImage ? j.data.image_key : j.data.file_key;
}

(async () => {
  try {
    const tk = await token();
    let messageId;
    if (kind === 'text') {
      messageId = await sendMessage(tk, 'text', { text: payload });
    } else if (kind === 'file') {
      const key = await upload(tk, resolve(payload), false);
      messageId = await sendMessage(tk, 'file', { file_key: key });
    } else {
      const key = await upload(tk, resolve(payload), true);
      messageId = await sendMessage(tk, 'image', { image_key: key });
    }
    console.log('已发送 message_id=' + messageId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
