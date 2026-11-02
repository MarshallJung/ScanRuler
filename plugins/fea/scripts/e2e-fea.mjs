// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test for the Structural FEA workspace (`plugins/fea/`):
// loads a watertight cantilever beam STL in headless Chrome, switches to the
// Structural FEA workspace (`[data-test=workspace-fea]`), verifies Gate 1-2
// watertight preflight, assigns a Fixed Dirichlet restraint to the root patch
// and a distributed shear force to the tip patch, verifies Gate 4 rigidity
// (Rank 6/6), runs the Tet10 + PCG + ZZ-SPR solver, and asserts that the
// post-solve trust banner, displacement/stress/FoS readouts, and MapLegend
// render cleanly with zero console errors.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUT_DIR,
  check,
  finish,
  launchApp,
  loadScan,
  shotPath,
  sleep,
} from '../../../scripts/e2e-lib.mjs'

function makeBoxStl(x0, x1, y0, y1, z0, z1) {
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ]
  const tris = [
    [v[0], v[2], v[1]],
    [v[0], v[3], v[2]],
    [v[4], v[5], v[6]],
    [v[4], v[6], v[7]],
    [v[0], v[1], v[5]],
    [v[0], v[5], v[4]],
    [v[3], v[7], v[6]],
    [v[3], v[6], v[2]],
    [v[0], v[4], v[7]],
    [v[0], v[7], v[3]],
    [v[1], v[2], v[6]],
    [v[1], v[6], v[5]],
  ]
  const buf = Buffer.alloc(84 + 50 * tris.length)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((tri, i) => {
    tri.flat().forEach((coord, k) => {
      buf.writeFloatLE(coord, 84 + 50 * i + 12 + 4 * k)
    })
  })
  return buf
}

mkdirSync(OUT_DIR, { recursive: true })
const SCAN = join(OUT_DIR, 'fea-cantilever-beam.stl')
writeFileSync(SCAN, makeBoxStl(0, 50, 0, 10, 0, 10))

const { browser, page, consoleErrors } = await launchApp({
  width: 1500,
  height: 950,
  protocolTimeout: 180_000,
})

const text = (sel) =>
  page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())

await page.click('[data-test=support-card] .sc-x').catch(() => {})
await loadScan(page, SCAN, { timeout: 60_000, settle: 400 })
await page.click('[data-test=workspace-fea]')
await page.waitForSelector('[data-test=fea-panel]', { timeout: 30_000 })
await page.waitForSelector('[data-test=fea-preflight-badge]', { timeout: 30_000 })

const preflightBadge = await text('[data-test=fea-preflight-badge]')
check(preflightBadge === 'Watertight', `Gate 1-2 preflight badge reads "${preflightBadge}"`)

// 1) Assign Fixed restraint on Patch #0
await page.select('[data-test=fea-patch-select]', '0')
await page.waitForSelector('[data-test=fea-bc-editor]', { timeout: 10_000 })
await page.select('[data-test=fea-bc-kind]', 'dirichlet')
await page.click('[data-test=fea-bc-save]')

// 2) Assign Distributed Force on Patch #4
await page.select('[data-test=fea-patch-select]', '4')
await page.waitForSelector('[data-test=fea-bc-editor]', { timeout: 10_000 })
await page.select('[data-test=fea-bc-kind]', 'traction')
await page.click('[data-test=fea-bc-save]')

await page.waitForFunction(
  () => document.querySelector('[data-test=fea-rigidity-badge]')?.textContent?.includes('Restrained'),
  { timeout: 15_000 },
)
const rigBadge = await text('[data-test=fea-rigidity-badge]')
check(rigBadge.includes('Restrained (6/6)'), `Gate 4 rigidity badge reads "${rigBadge}"`)

// 3) Run coarse Tet10 FEA solve
await page.select('[data-test=fea-mesh-preset]', 'coarse')
await page.click('[data-test=fea-solve-btn]')
await page.waitForSelector('[data-test=fea-trust-banner]', { timeout: 60_000 })
await sleep(300)

const maxDisp = await text('[data-test=fea-max-disp]')
const maxVm = await text('[data-test=fea-max-vm]')
const minFos = await text('[data-test=fea-min-fos]')
check(Boolean(maxDisp && maxVm && minFos), `Solved metrics displayed: |u|=${maxDisp}, vm=${maxVm}, FoS=${minFos}`)
check(Boolean(await page.$('[data-test=fea-legend]')), 'MapLegend is rendered over the 3D viewport')

await page.screenshot({ path: shotPath('fea-cantilever-solved.png') })
await finish(browser, consoleErrors)
