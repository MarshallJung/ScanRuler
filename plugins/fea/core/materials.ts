// SPDX-License-Identifier: AGPL-3.0-only

import type { IsotropicMaterial } from './types'

export const DEFAULT_MATERIAL_ID = '6061-T6'

export const CURATED_MATERIALS: readonly IsotropicMaterial[] = [
  {
    id: 'A356-T6',
    name: 'A356-T6 Cast Aluminum',
    youngsModulusMPa: 72400,
    poissonsRatio: 0.33,
    densityKgM3: 2680,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 200,
    ultimateTensileMPa: 260,
  },
  {
    id: '6061-T6',
    name: '6061-T6 Aluminum',
    youngsModulusMPa: 68900,
    poissonsRatio: 0.33,
    densityKgM3: 2700,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 276,
    ultimateTensileMPa: 310,
  },
  {
    id: '7075-T6',
    name: '7075-T6 Aerospace Aluminum',
    youngsModulusMPa: 71700,
    poissonsRatio: 0.33,
    densityKgM3: 2810,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 503,
    ultimateTensileMPa: 572,
  },
  {
    id: '4130',
    name: '4130 Chromoly Steel',
    youngsModulusMPa: 205000,
    poissonsRatio: 0.29,
    densityKgM3: 7850,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 460,
    ultimateTensileMPa: 560,
  },
  {
    id: '1018',
    name: '1018 Mild Steel',
    youngsModulusMPa: 200000,
    poissonsRatio: 0.29,
    densityKgM3: 7870,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 370,
    ultimateTensileMPa: 440,
  },
  {
    id: 'Ti-6Al-4V',
    name: 'Ti-6Al-4V Titanium',
    youngsModulusMPa: 113800,
    poissonsRatio: 0.34,
    densityKgM3: 4430,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 880,
    ultimateTensileMPa: 950,
  },
  {
    id: 'EN-GJL-250',
    name: 'EN-GJL-250 Grey Cast Iron',
    youngsModulusMPa: 110000,
    poissonsRatio: 0.26,
    densityKgM3: 7200,
    failureCriterion: 'brittle',
    ultimateTensileMPa: 250,
    ultimateCompressiveMPa: 825,
  },
  {
    id: 'PA12',
    name: 'PA12 SLS Nylon',
    youngsModulusMPa: 1700,
    poissonsRatio: 0.39,
    densityKgM3: 1010,
    failureCriterion: 'ductile',
    yieldStrengthMPa: 40,
    ultimateTensileMPa: 48,
  },
]

export function getMaterialPreset(id: string): IsotropicMaterial | undefined {
  return CURATED_MATERIALS.find((m) => m.id.toLowerCase() === id.toLowerCase())
}

/**
 * Gate 3.1 (Thermodynamic Positivity) & Gate 3.2 (Volumetric Locking Guard).
 */
export function validateIsotropicMaterial(material: IsotropicMaterial): {
  passed: boolean
  errors: string[]
} {
  const errors: string[] = []
  const { youngsModulusMPa: e, poissonsRatio: nu } = material

  if (!Number.isFinite(e) || e <= 0) {
    errors.push(`Gate 3.1: Young's modulus E (${e} MPa) must be strictly positive.`)
  }
  if (!Number.isFinite(nu) || nu <= -1.0 || nu >= 0.5) {
    errors.push(`Gate 3.1: Poisson's ratio ν (${nu}) must satisfy -1.0 < ν < 0.5.`)
  } else if (nu > 0.45) {
    errors.push(
      `Gate 3.2: Poisson's ratio ν (${nu}) exceeds 0.45 (near-incompressible volumetric locking threshold for pure-displacement elements).`,
    )
  }

  if (material.failureCriterion === 'ductile') {
    if (!material.yieldStrengthMPa || material.yieldStrengthMPa <= 0) {
      errors.push('Gate 3.1: Ductile material requires a positive tensile yield strength σ_y.')
    }
  } else {
    if (
      !material.ultimateTensileMPa ||
      material.ultimateTensileMPa <= 0 ||
      !material.ultimateCompressiveMPa ||
      material.ultimateCompressiveMPa <= 0
    ) {
      errors.push(
        'Gate 3.1: Brittle material requires positive ultimate tensile and compressive strengths.',
      )
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  }
}

/**
 * Construct the 6x6 symmetric positive-definite isotropic elasticity matrix C
 * in engineering Voigt ordering:
 *   [sigma_xx, sigma_yy, sigma_zz, tau_xy, tau_yz, tau_xz]^T
 *   = C * [eps_xx, eps_yy, eps_zz, gamma_xy, gamma_yz, gamma_xz]^T
 */
export function buildIsotropicVoigt6x6(
  youngsModulusMPa: number,
  poissonsRatio: number,
): Float64Array {
  const e = youngsModulusMPa
  const nu = poissonsRatio
  const factor = e / ((1 + nu) * (1 - 2 * nu))
  const c11 = factor * (1 - nu)
  const c12 = factor * nu
  const g = e / (2 * (1 + nu))

  const c = new Float64Array(36)
  c[0] = c11; c[1] = c12; c[2] = c12
  c[6] = c12; c[7] = c11; c[8] = c12
  c[12] = c12; c[13] = c12; c[14] = c11
  c[21] = g
  c[28] = g
  c[35] = g
  return c
}

/**
 * Construct the 6x6 isotropic compliance matrix C^{-1} in engineering Voigt
 * ordering for Zienkiewicz-Zhu energy-norm error integration (`Gate 7.6`).
 */
export function buildIsotropicComplianceVoigt6x6(
  youngsModulusMPa: number,
  poissonsRatio: number,
): Float64Array {
  const invE = 1 / youngsModulusMPa
  const off = -poissonsRatio / youngsModulusMPa
  const invG = (2 * (1 + poissonsRatio)) / youngsModulusMPa

  const s = new Float64Array(36)
  s[0] = invE; s[1] = off; s[2] = off
  s[6] = off; s[7] = invE; s[8] = off
  s[12] = off; s[13] = off; s[14] = invE
  s[21] = invG
  s[28] = invG
  s[35] = invG
  return s
}
