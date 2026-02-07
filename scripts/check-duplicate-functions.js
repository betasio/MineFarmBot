'use strict'

const fs = require('fs')
const path = require('path')

const target = path.join(process.cwd(), 'bot.js')
const src = fs.readFileSync(target, 'utf8')

const regex = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm
const counts = new Map()
let match
while ((match = regex.exec(src)) !== null) {
  const name = match[1]
  counts.set(name, (counts.get(name) || 0) + 1)
}

const duplicates = [...counts.entries()].filter(([, c]) => c > 1)
if (duplicates.length > 0) {
  console.error('[FAIL] Duplicate function declarations found in bot.js:')
  for (const [name, count] of duplicates) {
    console.error(`  - ${name}: ${count}`)
  }
  process.exit(1)
}

console.log('[OK] No duplicate function declarations in bot.js')
