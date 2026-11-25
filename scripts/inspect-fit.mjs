#!/usr/bin/env node
/**
 * 查看 FIT 文件的消息结构 —— 排平台兼容性问题用。
 *
 * 背景：迈金这类严格平台会**静默丢弃**不合规的 FIT
 * （上传接口返回 success_count=1，但活动列表里永远不出现）。
 * 定位这类问题第一步就是对比「能入库的文件」和「被丢弃的文件」的结构差异。
 *
 * 用法：node scripts/inspect-fit.mjs <file.fit> [更多文件...]
 */
import { readFileSync } from 'node:fs';
import { inspectFit } from '../packages/fitkit/dist/index.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node scripts/inspect-fit.mjs <file.fit> [...]');
  process.exit(1);
}

for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f);
  } catch (err) {
    console.log(f, '→ 读取失败:', err.message);
    continue;
  }
  const s = await inspectFit(buf);
  console.log('===', f.split('/').pop(), `(${buf.length} bytes)`);
  console.log('  消息:', Object.entries(s.counts).map(([k, v]) => `${k}×${v}`).join(' '));
  if (s.fileId) {
    console.log('  file_id:', `m=${s.fileId.manufacturer}`, `p=${s.fileId.product}`, `name=${s.fileId.productName ?? ''}`, `type=${s.fileId.type}`);
  }
  if (s.session) {
    console.log('  session:', `sport=${s.session.sport}`, `sub_sport=${s.session.subSport}`, `dist=${s.session.totalDistance}`, `elapsed=${s.session.totalElapsedSec}`, `timer=${s.session.totalTimerSec}`, `avg_speed=${s.session.avgSpeed}`);
  }
  if (s.laps) {
    console.log('  laps:', `×${s.laps.count}`, `首个dist=${s.laps.firstDistance}`, `末个dist=${s.laps.lastDistance}`, `trigger=${s.laps.trigger}`);
  }
  for (const d of s.deviceInfos ?? []) {
    console.log('  device_info:', `m=${d.manufacturer}`, `p=${d.product}`, `type=${d.deviceType}`, `name=${d.name ?? ''}`);
  }
  if (s.warnings.length) console.log('  ⚠', s.warnings.join('; '));
}
