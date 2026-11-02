// SPDX-License-Identifier: AGPL-3.0-only

import * as THREE from 'three'
import {
  type Colormap,
  type FieldScale,
  colormapById,
  paintField,
} from '../../../src/core/field/colormap'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { hatch } from '../../../src/viewer/hatch'
import type { SceneLayer, SceneLayerHost } from '../../../src/viewer/sceneLayers'
import { evaluateRbmModeDisplacements } from '../core/rigidity'
import type {
  BoundaryCondition,
  FeaFieldKind,
  FeaSolutionPayload,
  RigidityReport,
  WeldedSurfaceMesh,
} from '../core/types'
import type { FeaHoverReadout } from '../state/feaStore'
import { HarmonicAnimator } from './rbmAnimator'

const PATCH_BASE_RGB: readonly [number, number, number] = [148, 158, 172]
const PATCH_HOVER_RGB: readonly [number, number, number] = [91, 156, 245]
const PATCH_SELECTED_RGB: readonly [number, number, number] = [59, 140, 255]
const PATCH_DIRICHLET_RGB: readonly [number, number, number] = [45, 212, 122]
const PATCH_ROBIN_RGB: readonly [number, number, number] = [240, 168, 48]
const PATCH_LOAD_RGB: readonly [number, number, number] = [239, 95, 95]
const PATCH_RBE3_RGB: readonly [number, number, number] = [167, 139, 250]

export interface FeaSceneRenderParams {
  welded: WeldedSurfaceMesh | null
  bcs: readonly BoundaryCondition[]
  selectedPatchId: number | null
  hoveredPatchId: number | null
  rigidity: RigidityReport | null
  activeRbmModeIndex: number | null
  solution: FeaSolutionPayload | null
  activeField: FeaFieldKind
  deformScale: number
  excludeSingularities: boolean
  oscillateDeformed: boolean
  colormapId: string
}

export class FeaScene {
  private host: SceneLayerHost
  private removeLayer: () => void
  private group = new THREE.Group()
  private bodyMesh: THREE.Mesh | null = null
  private wireSegments: THREE.LineSegments | null = null
  private singularMesh: THREE.Mesh | null = null
  private glyphGroup: THREE.Group | null = null
  private raycaster = new THREE.Raycaster()
  private animator = new HarmonicAnimator()

  private currentWelded: WeldedSurfaceMesh | null = null
  private framedWelded: WeldedSurfaceMesh | null = null
  private currentSolution: FeaSolutionPayload | null = null
  private currentActiveField: FeaFieldKind = 'vonMises'
  private currentBaseCoords: Float32Array | null = null
  private currentDispVectors: Float32Array | null = null
  private currentSubTriToTri6: Int32Array | null = null
  private currentSubTriToNode: Uint32Array | null = null
  private lastHoveredPatch: number | null = null

  onPatchPick: ((patchId: number) => void) | null = null
  onPatchHover: ((patchId: number | null) => void) | null = null
  onSolutionHover: ((readout: FeaHoverReadout | null) => void) | null = null

  constructor(scene: SceneManager) {
    this.host = scene.layerHost()
    this.host.partGroup.add(this.group)
    this.removeLayer = scene.addLayer(this.layer())
  }

  private currentFrameBox(): THREE.Box3 | null {
    const w = this.currentWelded
    if (!w) return null
    const off = w.centroidOffset
    return new THREE.Box3(
      new THREE.Vector3(w.bboxMin[0] + off[0], w.bboxMin[1] + off[1], w.bboxMin[2] + off[2]),
      new THREE.Vector3(w.bboxMax[0] + off[0], w.bboxMax[1] + off[1], w.bboxMax[2] + off[2]),
    )
  }

  private layer(): SceneLayer {
    return {
      order: 12,
      dispose: () => {},
      navTargets: () => (this.bodyMesh ? [this.bodyMesh] : []),
      frameBox: () => this.currentFrameBox(),
      click: (x, y) => {
        const hit = this.raycastBody(x, y)
        if (!hit || hit.faceIndex == null) return false
        const patchId = this.patchIdFromFaceIndex(hit.faceIndex)
        if (patchId === null) return false
        this.onPatchPick?.(patchId)
        return true
      },
      hover: (at) => {
        if (!at || !this.bodyMesh) {
          if (this.lastHoveredPatch !== null) {
            this.lastHoveredPatch = null
            this.onPatchHover?.(null)
            this.host.setCursor('')
          }
          this.onSolutionHover?.(null)
          return false
        }
        const hit = this.raycastBody(at.x, at.y)
        if (!hit || hit.faceIndex == null) {
          if (this.lastHoveredPatch !== null) {
            this.lastHoveredPatch = null
            this.onPatchHover?.(null)
            this.host.setCursor('')
          }
          this.onSolutionHover?.(null)
          return false
        }

        const patchId = this.patchIdFromFaceIndex(hit.faceIndex)
        if (patchId !== this.lastHoveredPatch) {
          this.lastHoveredPatch = patchId
          this.onPatchHover?.(patchId)
          this.host.setCursor(patchId !== null ? 'pointer' : '')
        }

        if (this.currentSolution && this.currentSubTriToNode && this.currentSubTriToTri6) {
          const fIdx = hit.faceIndex
          const nodeIdx = this.currentSubTriToNode[fIdx * 3] ?? 0
          const tri6Idx = this.currentSubTriToTri6[fIdx] ?? 0
          const readout = this.buildHoverReadout(nodeIdx, tri6Idx)
          this.onSolutionHover?.(readout)
        } else {
          this.onSolutionHover?.(null)
        }
        return true
      },
    }
  }

  update(params: FeaSceneRenderParams): void {
    this.animator.stop()
    this.clearMeshes()

    this.currentWelded = params.welded
    this.currentSolution = params.solution
    this.currentActiveField = params.activeField

    if (!params.welded) {
      this.host.invalidate()
      return
    }

    const offset = params.welded.centroidOffset
    const colormap = colormapById(params.colormapId)

    if (params.solution) {
      this.buildSolvedContourMesh(
        params.welded,
        params.solution,
        params.activeField,
        params.deformScale,
        params.excludeSingularities,
        colormap,
      )
      if (params.oscillateDeformed && params.deformScale > 0) {
        this.animator.start((phaseSin) => {
          this.applyDeformationPhase(0.5 * (1 + phaseSin))
        }, 1.0)
      }
    } else {
      this.buildPreSolveSurfaceMesh(
        params.welded,
        params.bcs,
        params.selectedPatchId,
        params.hoveredPatchId,
        params.rigidity,
        params.activeRbmModeIndex,
      )
    }

    this.buildBoundaryGlyphs(params.welded, params.bcs, offset)

    if (params.welded !== this.framedWelded) {
      this.framedWelded = params.welded
      const box = this.currentFrameBox()
      if (box) {
        const radius = Math.max(1e-3, box.min.distanceTo(box.max) * 0.5)
        this.host.sizeStage(radius, box)
      }
    }

    this.host.invalidate()
  }

  clear(): void {
    this.animator.stop()
    this.clearMeshes()
    this.currentWelded = null
    this.currentSolution = null
    this.host.invalidate()
  }

  dispose(): void {
    this.clear()
    this.removeLayer()
    this.host.partGroup.remove(this.group)
  }

  private buildPreSolveSurfaceMesh(
    welded: WeldedSurfaceMesh,
    bcs: readonly BoundaryCondition[],
    selectedPatchId: number | null,
    hoveredPatchId: number | null,
    rigidity: RigidityReport | null,
    activeRbmModeIndex: number | null,
  ): void {
    const triCount = welded.indices.length / 3
    const posAttr = new Float32Array(triCount * 9)
    const colAttr = new Uint8Array(triCount * 9)
    const offset = welded.centroidOffset

    const bcColorByPatch = new Map<number, readonly [number, number, number]>()
    for (let i = 0; i < bcs.length; i++) {
      const bc = bcs[i]
      if (bc.type === 'dirichlet') bcColorByPatch.set(bc.patchId, PATCH_DIRICHLET_RGB)
      else if (bc.type === 'robin') bcColorByPatch.set(bc.patchId, PATCH_ROBIN_RGB)
      else if (bc.type === 'rbe3') bcColorByPatch.set(bc.patchId, PATCH_RBE3_RGB)
      else bcColorByPatch.set(bc.patchId, PATCH_LOAD_RGB)
    }

    // Optional RBM mode animation displacement per welded vertex
    let rbmVertexDisp: Float32Array | null = null
    if (
      rigidity &&
      activeRbmModeIndex !== null &&
      activeRbmModeIndex >= 0 &&
      activeRbmModeIndex < rigidity.freeModes.length
    ) {
      const diag = Math.hypot(
        welded.bboxMax[0] - welded.bboxMin[0],
        welded.bboxMax[1] - welded.bboxMin[1],
        welded.bboxMax[2] - welded.bboxMin[2],
      )
      rbmVertexDisp = evaluateRbmModeDisplacements(
        welded.positions,
        rigidity.centroid,
        rigidity.freeModes[activeRbmModeIndex],
        0.12 * Math.max(1, diag),
      )
    }

    const dispAttr = rbmVertexDisp ? new Float32Array(triCount * 9) : null

    for (let t = 0; t < triCount; t++) {
      const pid = welded.trianglePatch[t]
      let rgb = bcColorByPatch.get(pid) ?? PATCH_BASE_RGB
      if (pid === selectedPatchId) rgb = PATCH_SELECTED_RGB
      else if (pid === hoveredPatchId) rgb = PATCH_HOVER_RGB

      for (let k = 0; k < 3; k++) {
        const vi = welded.indices[t * 3 + k]
        const dst = (t * 3 + k) * 3
        posAttr[dst] = welded.positions[vi * 3] + offset[0]
        posAttr[dst + 1] = welded.positions[vi * 3 + 1] + offset[1]
        posAttr[dst + 2] = welded.positions[vi * 3 + 2] + offset[2]
        colAttr[dst] = rgb[0]
        colAttr[dst + 1] = rgb[1]
        colAttr[dst + 2] = rgb[2]
        if (dispAttr && rbmVertexDisp) {
          dispAttr[dst] = rbmVertexDisp[vi * 3]
          dispAttr[dst + 1] = rbmVertexDisp[vi * 3 + 1]
          dispAttr[dst + 2] = rbmVertexDisp[vi * 3 + 2]
        }
      }
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(posAttr, 3))
    geom.setAttribute('color', new THREE.BufferAttribute(colAttr, 3, true))
    geom.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.1,
      side: THREE.DoubleSide,
    })

    this.bodyMesh = new THREE.Mesh(geom, mat)
    this.group.add(this.bodyMesh)

    // Subtle patch wireframe
    const wireGeom = new THREE.WireframeGeometry(geom)
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x1e2530,
      transparent: true,
      opacity: 0.18,
    })
    this.wireSegments = new THREE.LineSegments(wireGeom, wireMat)
    this.group.add(this.wireSegments)

    if (dispAttr) {
      this.currentBaseCoords = posAttr.slice()
      this.currentDispVectors = dispAttr
      this.animator.start((phaseSin) => {
        this.applyDeformationPhase(phaseSin)
      }, 1.25)
    }
  }

  /**
   * Build the 4-subtriangle subdivided quadratic `Tri6` contour mesh:
   *   (0, 3, 5), (3, 1, 4), (5, 4, 2), (3, 4, 5)
   * and overlay `hatch(material)` on `Gate 7.4` singular faces.
   */
  private buildSolvedContourMesh(
    welded: WeldedSurfaceMesh,
    solution: FeaSolutionPayload,
    activeField: FeaFieldKind,
    deformScale: number,
    excludeSingularities: boolean,
    colormap: Colormap,
  ): void {
    const { mesh, displacements, singularFaceMask } = solution
    const tri6Count = mesh.tri6.length / 6
    const subTriCount = tri6Count * 4
    const offset = welded.centroidOffset

    const nodeScalars = getScalarFieldArray(solution, activeField)
    const scale = computeFieldScaleForFea(solution, activeField, excludeSingularities)
    const nodeColors = new Uint8Array((mesh.nodes.length / 3) * 3)
    paintField(nodeScalars, scale, colormap, nodeColors)

    const basePos = new Float32Array(subTriCount * 9)
    const dispVec = new Float32Array(subTriCount * 9)
    const curPos = new Float32Array(subTriCount * 9)
    const colAttr = new Uint8Array(subTriCount * 9)
    const subTriToTri6 = new Int32Array(subTriCount)
    const subTriToNode = new Uint32Array(subTriCount * 3)

    const SUB_TRIS: ReadonlyArray<readonly [number, number, number]> = [
      [0, 3, 5],
      [3, 1, 4],
      [5, 4, 2],
      [3, 4, 5],
    ]

    const singularPosList: number[] = []
    const singularColList: number[] = []

    for (let f = 0; f < tri6Count; f++) {
      const b6 = f * 6
      const isSingular = singularFaceMask[f] === 1
      for (let s = 0; s < 4; s++) {
        const subIdx = f * 4 + s
        subTriToTri6[subIdx] = f
        const st = SUB_TRIS[s]
        for (let k = 0; k < 3; k++) {
          const nid = mesh.tri6[b6 + st[k]]
          subTriToNode[subIdx * 3 + k] = nid
          const dst = (subIdx * 3 + k) * 3

          const bx = mesh.nodes[nid * 3] + offset[0]
          const by = mesh.nodes[nid * 3 + 1] + offset[1]
          const bz = mesh.nodes[nid * 3 + 2] + offset[2]

          const dx = displacements[nid * 3] * deformScale
          const dy = displacements[nid * 3 + 1] * deformScale
          const dz = displacements[nid * 3 + 2] * deformScale

          basePos[dst] = bx
          basePos[dst + 1] = by
          basePos[dst + 2] = bz

          dispVec[dst] = dx
          dispVec[dst + 1] = dy
          dispVec[dst + 2] = dz

          curPos[dst] = bx + dx
          curPos[dst + 1] = by + dy
          curPos[dst + 2] = bz + dz

          const r = nodeColors[nid * 3]
          const g = nodeColors[nid * 3 + 1]
          const b = nodeColors[nid * 3 + 2]
          colAttr[dst] = r
          colAttr[dst + 1] = g
          colAttr[dst + 2] = b

          if (excludeSingularities && isSingular) {
            singularPosList.push(bx + dx, by + dy, bz + dz)
            singularColList.push(r, g, b)
          }
        }
      }
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(curPos, 3))
    geom.setAttribute('color', new THREE.BufferAttribute(colAttr, 3, true))
    geom.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.08,
      side: THREE.DoubleSide,
    })

    this.bodyMesh = new THREE.Mesh(geom, mat)
    this.group.add(this.bodyMesh)

    this.currentBaseCoords = basePos
    this.currentDispVectors = dispVec
    this.currentSubTriToTri6 = subTriToTri6
    this.currentSubTriToNode = subTriToNode

    // Gate 7.4: Hatched singularity exclusion overlay using src/viewer/hatch.ts
    if (excludeSingularities && singularPosList.length > 0) {
      const sGeom = new THREE.BufferGeometry()
      sGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(singularPosList), 3))
      sGeom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(singularColList), 3, true))
      sGeom.computeVertexNormals()

      const sMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.5,
        metalness: 0.08,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      hatch(sMat)
      this.singularMesh = new THREE.Mesh(sGeom, sMat)
      this.group.add(this.singularMesh)
    }
  }

  private applyDeformationPhase(factor: number): void {
    if (!this.bodyMesh || !this.currentBaseCoords || !this.currentDispVectors) return
    const posAttr = this.bodyMesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array
    const base = this.currentBaseCoords
    const disp = this.currentDispVectors
    for (let i = 0; i < arr.length; i++) {
      arr[i] = base[i] + factor * disp[i]
    }
    posAttr.needsUpdate = true
    this.bodyMesh.geometry.computeVertexNormals()
    this.host.invalidate()
  }

  private buildBoundaryGlyphs(
    welded: WeldedSurfaceMesh,
    bcs: readonly BoundaryCondition[],
    offset: readonly [number, number, number],
  ): void {
    if (bcs.length === 0) return
    const glyphGroup = new THREE.Group()
    const diag = Math.max(
      10,
      Math.hypot(
        welded.bboxMax[0] - welded.bboxMin[0],
        welded.bboxMax[1] - welded.bboxMin[1],
        welded.bboxMax[2] - welded.bboxMin[2],
      ),
    )
    const glyphLen = 0.08 * diag

    for (let i = 0; i < bcs.length; i++) {
      const bc = bcs[i]
      const patch = welded.patches.find((p) => p.id === bc.patchId)
      if (!patch) continue

      const origin = new THREE.Vector3(
        patch.centroid[0] + offset[0],
        patch.centroid[1] + offset[1],
        patch.centroid[2] + offset[2],
      )
      const normal = new THREE.Vector3(patch.normal[0], patch.normal[1], patch.normal[2]).normalize()
      if (normal.lengthSq() < 0.1) normal.set(0, 0, 1)

      if (bc.type === 'dirichlet') {
        const coneGeom = new THREE.ConeGeometry(glyphLen * 0.28, glyphLen * 0.65, 12)
        const coneMat = new THREE.MeshBasicMaterial({ color: 0x2dd47a })
        const cone = new THREE.Mesh(coneGeom, coneMat)
        cone.position.copy(origin).addScaledVector(normal, glyphLen * 0.35)
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().negate())
        glyphGroup.add(cone)
      } else if (bc.type === 'robin') {
        const cylGeom = new THREE.CylinderGeometry(glyphLen * 0.2, glyphLen * 0.2, glyphLen * 0.6, 12)
        const cylMat = new THREE.MeshBasicMaterial({ color: 0xf0a830, wireframe: true })
        const cyl = new THREE.Mesh(cylGeom, cylMat)
        cyl.position.copy(origin).addScaledVector(normal, glyphLen * 0.3)
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal)
        glyphGroup.add(cyl)
      } else if (bc.type === 'pressure') {
        const dir = bc.pressureMPa >= 0 ? normal.clone().negate() : normal.clone()
        const start = origin.clone().addScaledVector(normal, glyphLen * 0.9)
        const arrow = new THREE.ArrowHelper(dir, start, glyphLen * 0.85, 0x5b9cf5, glyphLen * 0.28, glyphLen * 0.18)
        glyphGroup.add(arrow)
      } else if (bc.type === 'traction') {
        const vec = bc.tractionMPa ?? bc.totalForceN ?? [0, -1, 0]
        const dir = new THREE.Vector3(vec[0], vec[1], vec[2])
        if (dir.lengthSq() > 1e-12) {
          dir.normalize()
          const arrow = new THREE.ArrowHelper(dir, origin, glyphLen, 0xef5f5f, glyphLen * 0.28, glyphLen * 0.18)
          glyphGroup.add(arrow)
        }
      } else if (bc.type === 'rbe3') {
        const refPt = new THREE.Vector3(
          bc.refPointMm[0] + offset[0],
          bc.refPointMm[1] + offset[1],
          bc.refPointMm[2] + offset[2],
        )
        const sphereGeom = new THREE.SphereGeometry(glyphLen * 0.2, 12, 12)
        const sphereMat = new THREE.MeshBasicMaterial({ color: 0xa78bfa })
        const sphere = new THREE.Mesh(sphereGeom, sphereMat)
        sphere.position.copy(refPt)
        glyphGroup.add(sphere)

        const linePts = [refPt.x, refPt.y, refPt.z, origin.x, origin.y, origin.z]
        const lineGeom = new THREE.BufferGeometry()
        lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3))
        const lineMat = new THREE.LineBasicMaterial({ color: 0xa78bfa })
        glyphGroup.add(new THREE.LineSegments(lineGeom, lineMat))
      }
    }

    this.glyphGroup = glyphGroup
    this.group.add(glyphGroup)
  }

  private raycastBody(clientX: number, clientY: number): THREE.Intersection | null {
    if (!this.bodyMesh) return null
    const rect = this.host.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.host.partGroup.updateMatrixWorld(true)
    this.raycaster.setFromCamera(ndc, this.host.camera())
    const hits = this.raycaster.intersectObject(this.bodyMesh, false)
    return hits.length > 0 ? hits[0] : null
  }

  private patchIdFromFaceIndex(faceIndex: number): number | null {
    if (this.currentSolution && this.currentSubTriToTri6) {
      const tri6Idx = this.currentSubTriToTri6[faceIndex]
      if (tri6Idx === undefined) return null
      return this.currentSolution.mesh.tri6Patch[tri6Idx] ?? null
    }
    if (this.currentWelded) {
      return this.currentWelded.trianglePatch[faceIndex] ?? null
    }
    return null
  }

  private buildHoverReadout(nodeIdx: number, tri6Idx: number): FeaHoverReadout | null {
    const s = this.currentSolution
    if (!s) return null
    const singular = s.singularFaceMask[tri6Idx] === 1
    switch (this.currentActiveField) {
      case 'vonMises':
        return { label: 'von Mises Stress', value: s.vonMises[nodeIdx] ?? 0, unit: 'MPa', singular }
      case 'sigma1':
        return { label: 'Max Principal (σ₁)', value: s.sigma1[nodeIdx] ?? 0, unit: 'MPa', singular }
      case 'sigma3':
        return { label: 'Min Principal (σ₃)', value: s.sigma3[nodeIdx] ?? 0, unit: 'MPa', singular }
      case 'displacement': {
        const ux = s.displacements[nodeIdx * 3] ?? 0
        const uy = s.displacements[nodeIdx * 3 + 1] ?? 0
        const uz = s.displacements[nodeIdx * 3 + 2] ?? 0
        return { label: 'Displacement |u|', value: Math.hypot(ux, uy, uz), unit: 'len', singular }
      }
      case 'safetyFactor':
        return { label: 'Safety Factor (FoS)', value: s.safetyFactor[nodeIdx] ?? 15, unit: 'fos', singular }
      case 'etaZz':
        return { label: 'ZZ Error η_ZZ', value: s.nodalEtaZz[nodeIdx] ?? 0, unit: 'pct', singular }
    }
  }

  private clearMeshes(): void {
    if (this.bodyMesh) {
      this.bodyMesh.geometry.dispose()
      ;(this.bodyMesh.material as THREE.Material).dispose()
      this.group.remove(this.bodyMesh)
      this.bodyMesh = null
    }
    if (this.wireSegments) {
      this.wireSegments.geometry.dispose()
      ;(this.wireSegments.material as THREE.Material).dispose()
      this.group.remove(this.wireSegments)
      this.wireSegments = null
    }
    if (this.singularMesh) {
      this.singularMesh.geometry.dispose()
      ;(this.singularMesh.material as THREE.Material).dispose()
      this.group.remove(this.singularMesh)
      this.singularMesh = null
    }
    if (this.glyphGroup) {
      this.group.remove(this.glyphGroup)
      this.glyphGroup = null
    }
    this.currentBaseCoords = null
    this.currentDispVectors = null
    this.currentSubTriToTri6 = null
    this.currentSubTriToNode = null
  }
}

export function getScalarFieldArray(
  solution: FeaSolutionPayload,
  field: FeaFieldKind,
): Float32Array {
  switch (field) {
    case 'vonMises':
      return solution.vonMises
    case 'sigma1':
      return solution.sigma1
    case 'sigma3':
      return solution.sigma3
    case 'safetyFactor':
      return solution.safetyFactor
    case 'etaZz':
      return solution.nodalEtaZz
    case 'displacement': {
      const n = solution.displacements.length / 3
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        out[i] = Math.hypot(
          solution.displacements[i * 3],
          solution.displacements[i * 3 + 1],
          solution.displacements[i * 3 + 2],
        )
      }
      return out
    }
  }
}

export function computeFieldScaleForFea(
  solution: FeaSolutionPayload,
  field: FeaFieldKind,
  excludeSingularities: boolean,
): FieldScale {
  if (field === 'safetyFactor') {
    return {
      low: 0.5,
      high: 5.0,
      bands: 12,
      validMin: 0,
      validMax: 100,
      reversed: true,
    }
  }

  if (field === 'vonMises') {
    const peak = excludeSingularities
      ? solution.metrics.maxVonMisesMaskedMPa
      : solution.metrics.maxVonMisesRawMPa
    return {
      low: 0,
      high: Math.max(1e-3, peak),
      bands: 12,
      validMin: 0,
      validMax: 1e12,
    }
  }

  if (field === 'displacement') {
    return {
      low: 0,
      high: Math.max(1e-6, solution.metrics.maxDisplacementMm),
      bands: 12,
      validMin: 0,
      validMax: 1e12,
    }
  }

  if (field === 'etaZz') {
    const arr = solution.nodalEtaZz
    let maxVal = 5
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > maxVal) maxVal = arr[i]
    }
    return {
      low: 0,
      high: Math.max(1, maxVal),
      bands: 10,
      validMin: 0,
      validMax: 100,
    }
  }

  // Signed principal stresses sigma1 / sigma3
  const arr = field === 'sigma1' ? solution.sigma1 : solution.sigma3
  let minVal = Infinity
  let maxVal = -Infinity
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < minVal) minVal = arr[i]
    if (arr[i] > maxVal) maxVal = arr[i]
  }
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || Math.abs(maxVal - minVal) < 1e-6) {
    minVal = -1
    maxVal = 1
  }
  return {
    low: minVal,
    high: maxVal,
    bands: 12,
    validMin: -1e12,
    validMax: 1e12,
  }
}

const feaScenes = new WeakMap<SceneManager, FeaScene>()

export function feaSceneOf(scene: SceneManager): FeaScene
export function feaSceneOf(scene: SceneManager | null): FeaScene | null
export function feaSceneOf(scene: SceneManager | null): FeaScene | null {
  if (!scene) return null
  let inst = feaScenes.get(scene)
  if (!inst) {
    inst = new FeaScene(scene)
    feaScenes.set(scene, inst)
  }
  return inst
}
