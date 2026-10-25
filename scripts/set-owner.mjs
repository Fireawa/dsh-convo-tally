/**
 * Replace the __OWNER__ placeholder with your GitHub username.
 *
 *   node scripts/set-owner.mjs <github-username>
 *
 * Only touches the files listed below; the replacement is idempotent, so
 * re-running it is safe.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const FILES = ['package.json', 'README.md', 'README.en.md', 'LICENSE']
const owner = process.argv[2]

if (owner === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
  console.error('用法: node scripts/set-owner.mjs <github-用户名>')
  console.error('用户名规则: 1~39 个字母/数字/连字符，不能以连字符开头或结尾。')
  process.exit(1)
}

let changed = 0
for (const file of FILES) {
  const before = readFileSync(file, 'utf8')
  const after = before.split('__OWNER__').join(owner)
  if (after === before) continue
  writeFileSync(file, after, 'utf8')
  changed += 1
  console.log(`✔ ${file}`)
}

console.log(changed === 0
  ? '没有找到 __OWNER__：可能已经设置过了。'
  : `完成：__OWNER__ → ${owner}（${changed} 个文件）。`)
