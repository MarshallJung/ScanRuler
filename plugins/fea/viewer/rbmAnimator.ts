// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manages a lightweight `requestAnimationFrame` sinusoidal phase loop for:
 * 1) Gate 4.3 unconstrained Rigid-Body Mode (RBM) animation, and
 * 2) Stage 4 deformed-shape harmonic oscillation.
 */
export class HarmonicAnimator {
  private rafId: number | null = null
  private startTime = 0

  start(onFrame: (phaseSin: number) => void, freqHz = 1.25): void {
    this.stop()
    if (typeof requestAnimationFrame === 'undefined') return
    this.startTime = performance.now()
    const omega = 2 * Math.PI * freqHz

    const tick = (now: number) => {
      const elapsedSec = (now - this.startTime) * 0.001
      const phaseSin = Math.sin(omega * elapsedSec)
      onFrame(phaseSin)
      this.rafId = requestAnimationFrame(tick)
    }

    this.rafId = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  get active(): boolean {
    return this.rafId !== null
  }
}
