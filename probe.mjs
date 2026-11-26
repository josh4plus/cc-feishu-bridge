#!/usr/bin/env node
/**
 * 只读探针：连上飞书长连接，把收到的消息（发送者 open_id、chat_id、文本）记下来，
 * 并回一条「已登记」。不调用 claude、不执行任何命令。
 *
 * 用途：第一次配置时，你还不知道自己的 open_id（白名单要填它）。
 * 跑这个 → 在飞书里给机器人发一条消息 → 它会把你需要的信息回给你。
 *
 * 用法：node probe.mjs
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');

if (!existsSync(CONFIG_PATH)) {
  console.error(`缺少配置文件：${CONFIG_PATH}`);
  console.error('先执行：cp config.example.json config.json 然后填入 appId / appSecret');
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if (!config.appId || !config.appSecret) {
  console.error('config.json 里 appId / appSecret 还没填。');
  process.exit(1);
}

mkdirSync(join(HERE, 'logs'), { recursive: true });
const LOG = join(HERE, 'logs', 'probe.log');

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  appendFileSync(LOG, line);
  process.stdout.write(line);
}

const client = new lark.Client({ appId: config.appId, appSecret: config.appSecret });

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const msg = data.message;
    const openId = data.sender?.sender_id?.open_id || '';
    const chatId = msg.chat_id || '';
    let text = '';
    try { text = (JSON.parse(msg.content || '{}').text || '').trim(); } catch { /* 非文本消息 */ }

    log(`收到 chat_type=${msg.chat_type} open_id=${openId} chat_id=${chatId} text=${text.slice(0, 60)}`);

    try {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({
            text: `已登记 ✅\n你的 open_id：${openId}\n会话 chat_id：${chatId}\n\n`
              + `把 open_id 填进 config.json 的 allowedOpenIds 数组，再启动正式桥接。`,
          }),
        },
      });
    } catch (e) {
      log(`回消息失败：${e.message}`);
    }
  },
});

const wsClient = new lark.WSClient({
  appId: config.appId,
  appSecret: config.appSecret,
  loggerLevel: lark.LoggerLevel.info,
});

log('只读探针启动（不调用 claude），等待飞书消息…（Ctrl-C 退出）');
wsClient.start({ eventDispatcher: dispatcher });
