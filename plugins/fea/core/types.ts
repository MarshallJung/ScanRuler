// SPDX-License-Identifier: AGPL-3.0-only

export type Vec3Tuple = [number, number, number]

export interface IsotropicMaterial {
  id: string
  name: string
  youngsModulusMPa: number
  poissonsRatio: number
  densityKgM3: number
  failureCriterion: 'ductile' | 'brittle'
  yieldStrengthMPa?: number
  ultimateTensileMPa?: number
  ultimateCompressiveMPa?: number
}

export interface PatchFingerprint {
  kind: string
  centroid: [number, number, number]
  normal: [number, number, number]
  area: number
}

export interface PatchDescriptor {
  id: number
  kind: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other'
  centroid: [number, number, number]
  normal: [number, number, number]
  area: number
  perimeter: number
  sliverRatio: number
  triangleCount: number
}

export interface ReentrantEdge {
  vA: number
  vB: number
  patchA: number
  patchB: number
  internalAngleDeg: number
}

export interface WeldedSurfaceMesh {
  positions: Float32Array
  indices: Uint32Array
  trianglePatch: Int32Array
  patches: PatchDescriptor[]
  reentrantEdges: ReentrantEdge[]
  centroidOffset: [number, number, number]
  bboxMin: [number, number, number]
  bboxMax: [number, number, number]
}

export interface PreflightReport {
  passed: boolean
  openEdgeCount: number
  nonManifoldEdgeCount: number
  selfIntersectionCount: number
  signedVolumeMm3: number
  surfaceAreaMm2: number
  eulerCharacteristic: number
  sliverPatchCount: number
  minWallThicknessMm: number
  slendernessRatio: number
  blockingErrors: string[]
  warnings: string[]
}

export interface DirichletBoundaryCondition {
  id: string
  patchId: number
  type: 'dirichlet'
  subtype: 'fixed' | 'sliding_normal' | 'prescribed'
  displacementMm?: {
    ux?: number
    uy?: number
    uz?: number
  }
  fingerprint?: PatchFingerprint
}

export interface RobinBoundaryCondition {
  id: string
  patchId: number
  type: 'robin'
  stiffnessNPerMm3: number
  fingerprint?: PatchFingerprint
}

export interface PressureBoundaryCondition {
  id: string
  patchId: number
  type: 'pressure'
  pressureMPa: number
  fingerprint?: PatchFingerprint
}

export interface TractionBoundaryCondition {
  id: string
  patchId: number
  type: 'traction'
  tractionMPa?: [number, number, number]
  totalForceN?: [number, number, number]
  fingerprint?: PatchFingerprint
}

export interface Rbe3BoundaryCondition {
  id: string
  patchId: number
  type: 'rbe3'
  refPointMm: [number, number, number]
  forceN: [number, number, number]
  momentNmm: [number, number, number]
  fingerprint?: PatchFingerprint
}

export type BoundaryCondition =
  | DirichletBoundaryCondition
  | RobinBoundaryCondition
  | PressureBoundaryCondition
  | TractionBoundaryCondition
  | Rbe3BoundaryCondition

export interface RigidityReport {
  passed: boolean
  rank: number
  singularValues: [number, number, number, number, number, number]
  freeModes: Array<[number, number, number, number, number, number]>
  centroid: [number, number, number]
  characteristicLength: number
  blockingErrors: string[]
}

export type FeaMeshPreset = 'coarse' | 'medium' | 'fine'

export interface FeaMeshSettings {
  preset: FeaMeshPreset
  targetEdgeMm: number
}

export interface Tet10VolumeMesh {
  nodes: Float64Array
  tet10: Uint32Array
  tri6: Uint32Array
  tri6Patch: Int32Array
  tri6ParentTet: Int32Array
  cornerNodeCount: number
  totalVolumeMm3: number
  volumeDriftRatio: number
  minJacobianDet: number
  minKnuppQuality: number
  meanKnuppQuality: number
  invertedCount: number
}

export interface BsrMatrix3x3 {
  blockRows: number
  rowPtr: Int32Array
  colIdx: Int32Array
  values: Float64Array
  diagPtr: Int32Array
}

export interface EquilibriumReport {
  appliedForceN: [number, number, number]
  reactionForceN: [number, number, number]
  forceImbalanceRatio: number
  appliedMomentNmm: [number, number, number]
  reactionMomentNmm: [number, number, number]
  momentImbalanceRatio: number
  passed: boolean
}

export type FeaFieldKind =
  | 'vonMises'
  | 'sigma1'
  | 'sigma3'
  | 'displacement'
  | 'safetyFactor'
  | 'etaZz'

export interface FeaMetrics {
  nodeCount: number
  elementCount: number
  dofCount: number
  solverIterations: number
  solverResidual: number
  solveTimeMs: number
  maxDisplacementMm: number
  maxVonMisesRawMPa: number
  maxVonMisesMaskedMPa: number
  minSafetyFactorRaw: number
  minSafetyFactorMasked: number
  etaZzPercent: number
  maxStressJumpRatio: number
  maxStrain: number
  maxRotationDeg: number
  smallStrainValid: boolean
  smallRotationValid: boolean
  equilibrium: EquilibriumReport
  singularFaceCount: number
}

export interface FeaSolutionPayload {
  mesh: Tet10VolumeMesh
  displacements: Float32Array
  reactions: Float32Array
  vonMises: Float32Array
  sigma1: Float32Array
  sigma3: Float32Array
  safetyFactor: Float32Array
  nodalEtaZz: Float32Array
  singularFaceMask: Uint8Array
  metrics: FeaMetrics
}
