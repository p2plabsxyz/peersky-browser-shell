#!/usr/bin/env node
// Prints where a shell run of the probe extensions differs from Chrome's.
//
//   PROBE_RESULTS_OUT=/tmp/shell.json npm test -- --files spec/chrome-api-parity-spec.ts
//   node script/probe-diff.js /tmp/shell.json [tabs,windows] [probe|peer|pages]
const path = require('node:path')
const { diffResults } = require('../spec/probe-compare.js')

const fixtures = path.join(__dirname, '..', 'spec', 'fixtures', 'chrome-api-probe')
const chrome = require(path.join(fixtures, 'chrome-results.json'))
const known = require(path.join(fixtures, 'known-differences.json')).differences
const shellFile = process.argv[2]
if (!shellFile) {
  console.error('usage: node script/probe-diff.js <shell-results.json> [suites] [side]')
  process.exit(1)
}
const shell = require(path.resolve(shellFile))
const side = process.argv[4] || 'probe'
// Known differences that are only placeholders for unfinished work are ignored here.
const real = known.filter((k) => !/work for 2\.0\.0 in progress/.test(k.reason))
const suites = process.argv[3] ? process.argv[3].split(',') : Object.keys(shell[side] || {})
for (const suite of suites) {
  if (!shell[side] || !shell[side][suite]) {
    console.log(`== ${side}.${suite}: not run`)
    continue
  }
  const diff = diffResults({ [side]: { [suite]: chrome[side][suite] } }, { [side]: { [suite]: shell[side][suite] } }, real)
  console.log(`== ${side}.${suite}: ${diff.length} differences`)
  for (const d of diff) {
    console.log(`  ${d.path.replace(`${side}.${suite}.`, '')}`)
    console.log(`     chrome: ${JSON.stringify(d.chrome)}`)
    console.log(`     shell:  ${JSON.stringify(d.shell)}`)
  }
}
