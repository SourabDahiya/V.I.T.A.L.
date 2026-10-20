# 🧬 V.I.T.A.L: Visual Identification and Tracking of Ancestral Lineages

**V.I.T.A.L** is an end-to-end full-stack scientific application for **3D+time cell segmentation, spatiotemporal tracking, and ancestral lineage tree reconstruction** from zebrafish light-sheet fluorescence microscopy data (CZ Biohub Kaggle Challenge: *Cell Tracking During Development*).

---

## 🔬 Core Mission & Philosophy

Rather than treating tracking as a black-box machine learning challenge or focusing solely on submission CSVs, **V.I.T.A.L focuses on visual understanding and biological insight**:
1. **How cells migrate and divide in 3D developmental space.**
2. **Interactive exploratory visualization:** 3D/2D optical section slicing, 3D animated trajectories, and genealogical family-tree lineage trees.
3. **Transparent, interpretable algorithms:** Pretrained 3D Cellpose cyto3 + Hungarian matching on physical Euclidean distances + rule-based geometric division detection.
4. **Comprehensive Cell History Dossier:** In-depth biological profiling of individual cell lifespans, ancestral roots, tortuosity, velocity kinetics, and division progeny.

---

## 📐 Microscopy Data Geometry & Scales

- **Input Format**: OME-Zarr v3 light-sheet microscopy volumes
- **Shape**: $(T=100, Z=64, Y=256, X=256)$ with `uint16` intensity, chunked as $(1, 64, 256, 256)$
- **Physical Scale**:
  - $Z = 1.625\ \mu\text{m / voxel}$
  - $Y = 0.40625\ \mu\text{m / voxel}$
  - $X = 0.40625\ \mu\text{m / voxel}$
- **Lineage Graphs**: GEFF v1.1 format (`nodes/ids`, `nodes/props {t,z,y,x}`, `edges [src, dst]`)

---

## 🏗️ 3-Stage Pipeline Architecture

```
                      ┌────────────────────────────────────────┐
                      │          4D OME-Zarr v3 Volume         │
                      │       (T=100, Z=64, Y=256, X=256)      │
                      └──────────────────┬─────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1 — 3D Cell Detection & Feature Extraction                                │
│ • 3D Cellpose 'cyto3' instance segmentation with optical anisotropy factor = 4.0 │
│ • skimage.measure.regionprops_table: 3D centroids (z,y,x), volume, mean intensity│
│ • Output: cells_stage1.csv                                                       │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 2 — Hungarian Tracking & Geometric Mitosis Detection                       │
│ • Frame-to-frame linking via scipy.optimize.linear_sum_assignment               │
│ • Physical cost matrix: d = sqrt((dz*1.625)^2 + (dy*0.40625)^2 + (dx*0.40625)^2) │
│ • Cutoff: d <= 7.0 µm for 1-to-1 migration                                       │
│ • Rule-Based Division: parent terminal bifurcation into 2 daughters (1.5-16.0 µm)│
│ • Output: cells_stage2.csv                                                       │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 3 — Lineage Graph & Evaluation                                             │
│ • networkx.DiGraph spatiotemporal graph + hierarchical family tree               │
│ • GEFF v1.1 serialization (lineage_output.geff)                                 │
│ • Edge Jaccard: TP/(TP+FP+FN) * min(1, N_gt/N_pred)                              │
│ • Division Jaccard: micro-averaged daughter matching                             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Demo Mode & Precomputed Showcase

V.I.T.A.L ships with **Demo Mode**, pre-loaded with top division-rich recordings pre-computed and cached in `vital/app/demo_cache/` for instant zero-latency exploration:

| Recording ID | Mitotic Divisions | Progenitor Roots | Total Nodes | Edge Jaccard | Division Jaccard | Showcase Highlights |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`6bba_48816121`** | **5 Divisions** | 17 Roots | 935 Nodes | **0.9696** | **0.5000** | Highest division count in the dataset; rich multi-generation family tree |
| **`6bba_df673a83`** | **4 Divisions** | 14 Roots | 668 Nodes | **0.9878** | **1.0000** | Perfect 1.0000 division matching; crisp bifurcations and clean tracking |
| **`6bba_4ffd3da3`** | **3 Divisions** | 17 Roots | 706 Nodes | **0.9683** | **0.3750** | High-velocity migratory trajectories alongside developmental mitosis |

---

## 🚀 Running the Application

### 1. Installation
```bash
# Clone the repository
git clone https://github.com/<your-username>/V.I.T.A.L.git
cd V.I.T.A.L

# Install scientific dependencies
pip install -r requirements.txt
```

### 2. Launch the High-Performance Web Dashboard
```bash
python web/server.py
```
Open **`http://localhost:5000`** in any web browser.

> **Note on Demo Mode:** The repository includes precomputed benchmark specimens in `vital/app/demo_cache/`. You can immediately explore all 5 scientific visualization tabs without downloading the 83.5 GB raw dataset!

### 3. Run Command-Line Pipeline on Any Recording
```bash
# Run on a train recording using ground-truth benchmark
python scripts/run_pipeline.py 6bba_48816121 --use_gt_detections --output_dir vital/runs/test_run

# Run full Cellpose 3D segmentation on frames 0-10
python scripts/run_pipeline.py 6bba_df673a83 --time_start 0 --time_end 10 --output_dir vital/runs/cellpose_run
```

---

## 🖥️ Web Interface Features

1. **🔬 1. Slice-by-Slice Explorer**:
   - Dual time ($t$) and optical depth ($z$) sliders.
   - High-contrast fluorescence microscopy slice with overlaid detected cell centroid markers.
   - Temporal population trends and Z-depth frequency histograms.
2. **🚀 2. Trajectories & Dynamics**:
   - 2D physical trajectory projection and interactive 3D spatial track view.
   - Mitotic division location markers (rose stars) and interactive events table.
   - Population mean velocity profile over developmental time.
3. **🌳 3. Ancestral Lineage Tree**:
   - Interactive Plotly family-tree diagram with time flowing downwards ($t=0 \to 100$).
   - Green markers for progenitor root lines, rose markers for mitotic division points, and cyan lines for migration.
   - Lifespan, speed, and depth summary cards.
4. **🎯 4. Ground-Truth Evaluation**:
   - Official Edge Jaccard and Division Jaccard scores with penalty ratios and TP/FP/FN breakdown.
5. **📜 5. Cell History Dossier (Summarize Cell History in Last)**:
   - Search or select any `track_id`.
   - Biological narrative summary of the cell's lifespan, parentage, distance, and fate.
   - Individual cell instantaneous velocity profile and 3D coordinate audit history table.
6. **💾 6. Exports & Download Center**:
   - One-click downloads for `cells_stage1.csv`, `cells_stage2.csv`, `lineage_output.geff`, and `summary_report.json`.
