<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Structural FEA Plugin (`plugins/fea/`)

Browser-based 3D Linear Elastostatic Finite Element Analysis workspace for `ScanRuler`.

## Architecture

- **`core/`**: Pure TypeScript numerical kernels (`TypedArray`-backed, zero DOM/React imports):
  - `types.ts`: Canonical interfaces and typed-array buffers.
  - `materials.ts`: Curated isotropic engineering materials, Voigt $6\times 6$ stiffness & compliance tensors (`Gate 3.1–3.2`).
  - `patches.ts`: Dual-path CAD `faceHash` and $30^\circ$ dihedral flood-fill patch segmentation, virtual patch merging, and fingerprint rebinding.
  - `preflight.ts`: Coordinate centering (`Gate 1.3`), B-Rep seam welding (`Gate 2.1`), watertight topology & self-intersection audit (`Gate 2.1–2.5`), and ray-cast wall-thickness check (`Gate 2.6`).
  - `rigidity.ts`: $6\times 6$ rigid-body restraint Gram matrix eigensolver (`Gate 4.1–4.3`) and free-mode animator.
  - `elements.ts`: 10-node quadratic tetrahedron (`Tet10`) 4-point Keast quadrature, 6-node quadratic triangle (`Tri6`) 6-point Dunavant quadrature, Jacobian determinants, and Knupp mean-ratio quality metric (`Gate 5.2–5.3`).
  - `mesher.ts`: Conforming rectilinear and quality-guarded boundary-snapping `Tet10` volume mesher (`Gate 5.1–5.4`).
  - `bsrMatrix.ts`: Reverse Cuthill–McKee (`RCM`) bandwidth reduction and symmetric $3\times 3$ Block Compressed Sparse Row (`BSR-3`) matrix-vector multiplication.
  - `assembly.ts`: Global stiffness assembly, continuum `RBE3` distributing coupling, Robin foundation springs, symmetric Dirichlet elimination, and global force/moment equilibrium recovery (`Gate 6.1, 6.3, 6.4`).
  - `solver.ts`: Double-precision (`Float64Array`) Preconditioned Conjugate Gradient (`PCG`) with matrix-free Symmetric $3\times 3$ Block Gauss–Seidel and coarse rigid-body mode (`R`) deflation (`Gate 6.2`).
  - `postprocess.ts`: Zienkiewicz–Zhu Superconvergent Patch Recovery (`ZZ-SPR`), closed-form Cardano principal stresses, von Mises / Rankine / Mohr–Coulomb failure factors, energy-norm error $\eta_{\text{ZZ}}\%$ (`Gate 7.6`), and $2h_e$ singularity masking (`Gate 7.4`).
- **`worker/`**: Dedicated Web Worker RPC layer (`protocol.ts`, `feaWorker.ts`, `feaClient.ts`).
- **`state/`**: Zustand store (`feaStore.ts`) integrated with undo/redo history and `.scanproj` persistence.
- **`viewer/`**: Three.js `SceneLayer` (`feaScene.ts`) with 4-subtriangle `Tri6` contour rendering, `hatch()` singularity masking, and harmonic animation (`rbmAnimator.ts`).
- **`ui/`**: 4-stage progressive disclosure sidebar (`FeaPanel.tsx`, `BcEditorModal.tsx`, `FeaTrustBanner.tsx`).
- **`app/`**: Host integration (`useFeaPlugin.tsx`, `feaCommands.ts`, `feaReadout.ts`, `projectSection.ts`).
