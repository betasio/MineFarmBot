'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function walkJsFiles (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJsFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const root = process.cwd()
const files = walkJsFiles(root).sort()

if (files.length === 0) {
  console.log('[WARN] No JavaScript files found for syntax check.')
  process.exit(0)
}

let failed = false
for (const file of files) {
  const rel = path.relative(root, file)
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
    console.error(`[FAIL] Syntax check failed: ${rel}`)
    break
  }
}

if (failed) process.exit(1)
console.log(`[OK] Syntax check passed for ${files.length} file(s).`)
