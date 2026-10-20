"""End-to-End Pipeline Runner for V.I.T.A.L.

Executes all 3 stages:
Stage 1: 3D Cell Segmentation (Cellpose cyto3) & Feature Extraction (regionprops)
Stage 2: Hungarian Spatiotemporal Tracking & Geometric Division Detection
Stage 3: Lineage Graph Construction (GEFF v1.1 export) & Ground-Truth Evaluation
"""

import os
import sys
from pathlib import Path
import argparse
import json
import time
import pandas as pd
import networkx as nx

# Add workspace to path
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

from vital.config import (
    TRAIN_DIR,
    TEST_DIR,
    DEMO_CACHE_DIR,
    VOXEL_SCALE,
    MAX_MATCH_DISTANCE_UM,
    DIVISION_MIN_DIST_UM,
    DIVISION_MAX_DIST_UM,
)
from vital.io.zarr_reader import ZarrReader
from vital.io.geff_reader import GeffReader, GeffWriter
from vital.segmentation.segmenter import get_segmenter
from vital.tracking.features import extract_frame_features, detections_to_dataframe
from vital.tracking.tracker import HungarianTracker
from vital.lineage.graph_builder import LineageGraphBuilder
from vital.eval.evaluator import LineageEvaluator


def run_vital_pipeline(
    recording_id: str,
    output_dir: Path,
    time_start: int = 0,
    time_end: int = 100,
    use_gt_detections: bool = False,
    progress_callback=None,
    custom_zarr_path: Optional[Path] = None,
) -> dict:
    """Execute the full 3-stage pipeline for a given recording."""
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    # Locate input files
    zarr_path = None
    geff_path = None

    if custom_zarr_path and Path(custom_zarr_path).exists():
        zarr_path = Path(custom_zarr_path)
    elif (output_dir / f"{recording_id}.zarr").exists():
        zarr_path = output_dir / f"{recording_id}.zarr"
    else:
        for root_dir in [TRAIN_DIR, TEST_DIR]:
            candidate_zarr = root_dir / f"{recording_id}.zarr"
            candidate_geff = root_dir / f"{recording_id}.geff"
            if candidate_zarr.exists():
                zarr_path = candidate_zarr
            if candidate_geff.exists():
                geff_path = candidate_geff

    if zarr_path is None and not (use_gt_detections and geff_path and geff_path.exists()):
        raise FileNotFoundError(f"Recording '{recording_id}.zarr' not found in dataset or runs.")

    # ---------------------------------------------------------
    # STAGE 1: DETECTION
    # ---------------------------------------------------------
    if progress_callback:
        progress_callback("Stage 1: Cell Detection & Feature Extraction...", 0.1)
    print(f"[{recording_id}] Starting Stage 1: Detection...")

    detections_by_frame = {}
    next_det_id = 1
    all_detections = []

    if use_gt_detections and geff_path and geff_path.exists():
        print(f"[{recording_id}] Using ground truth detections from {geff_path.name}")
        gt_reader = GeffReader(geff_path)
        gt_nodes_df = gt_reader.get_nodes_dataframe()
        for t, group in gt_nodes_df.groupby("t"):
            t = int(t)
            if not (time_start <= t <= time_end):
                continue
            frame_dets = []
            for _, row in group.iterrows():
                det = {
                    "detection_id": next_det_id,
                    "t": t,
                    "z": float(row["z"]),
                    "y": float(row["y"]),
                    "x": float(row["x"]),
                    "z_um": float(row["z_um"]),
                    "y_um": float(row["y_um"]),
                    "x_um": float(row["x_um"]),
                    "volume": 250,  # nominal voxel volume
                    "mean_intensity": 1000.0,
                }
                next_det_id += 1
                frame_dets.append(det)
                all_detections.append(det)
            detections_by_frame[t] = frame_dets
    else:
        reader = ZarrReader(zarr_path)
        segmenter = get_segmenter()
        t_max = min(time_end, reader.num_frames - 1)

        total_frames_to_run = t_max - time_start + 1
        for idx, t in enumerate(range(time_start, t_max + 1)):
            if progress_callback:
                prog = 0.1 + 0.4 * (idx / max(1, total_frames_to_run))
                progress_callback(f"Stage 1: Segmenting 3D Frame {t}/{t_max}...", prog)

            volume = reader.get_frame(t)
            mask = segmenter.segment(volume)
            frame_dets, next_det_id = extract_frame_features(
                mask_3d=mask,
                intensity_3d=volume,
                t=t,
                start_detection_id=next_det_id,
            )
            detections_by_frame[t] = frame_dets
            all_detections.extend(frame_dets)

    stage1_df = detections_to_dataframe(all_detections)
    stage1_path = output_dir / "cells_stage1.csv"
    stage1_df.to_csv(stage1_path, index=False)
    print(f"[{recording_id}] Stage 1 complete. Saved {len(stage1_df)} detections to {stage1_path.name}")

    # ---------------------------------------------------------
    # STAGE 2: TRACKING + DIVISION DETECTION
    # ---------------------------------------------------------
    if progress_callback:
        progress_callback("Stage 2: Hungarian Tracking & Division Detection...", 0.55)
    print(f"[{recording_id}] Starting Stage 2: Tracking + Division Detection...")

    tracker = HungarianTracker()
    stage2_df = tracker.track_all_frames(detections_by_frame)
    stage2_path = output_dir / "cells_stage2.csv"
    stage2_df.to_csv(stage2_path, index=False)
    print(f"[{recording_id}] Stage 2 complete. Saved {len(stage2_df)} tracking steps ({len(tracker.division_events)} divisions) to {stage2_path.name}")

    # ---------------------------------------------------------
    # STAGE 3: LINEAGE GRAPH & GEFF EXPORT
    # ---------------------------------------------------------
    if progress_callback:
        progress_callback("Stage 3: Building Lineage Graphs & GEFF v1.1 Export...", 0.75)
    print(f"[{recording_id}] Starting Stage 3: Lineage Graph Reconstruction...")

    builder = LineageGraphBuilder()
    spatio_graph = builder.build_spatiotemporal_graph(stage2_df)
    tree = builder.build_track_hierarchy_graph(stage2_df)
    lineage_metrics = builder.compute_lineage_metrics(tree, spatio_graph)

    # Export GEFF v1.1
    geff_output_path = output_dir / "lineage_output.geff"
    GeffWriter.write(spatio_graph, geff_output_path, overwrite=True)
    print(f"[{recording_id}] Lineage graph exported to {geff_output_path.name}")

    # ---------------------------------------------------------
    # EVALUATION (IF GROUND TRUTH IS AVAILABLE)
    # ---------------------------------------------------------
    eval_results = {}
    if geff_path and geff_path.exists():
        if progress_callback:
            progress_callback("Evaluating against Ground Truth Lineage...", 0.90)
        print(f"[{recording_id}] Evaluating predictions against ground truth {geff_path.name}...")
        gt_reader = GeffReader(geff_path)
        evaluator = LineageEvaluator()
        eval_results = evaluator.evaluate(gt_reader.graph, spatio_graph)
        print(f"[{recording_id}] Evaluation Complete: Edge Jaccard = {eval_results['edge_jaccard']:.4f}, Division Jaccard = {eval_results['division_jaccard']:.4f}")

    elapsed = time.time() - start_time
    summary_report = {
        "recording_id": recording_id,
        "elapsed_seconds": round(elapsed, 2),
        "total_detections": len(stage1_df),
        "total_tracks": lineage_metrics["total_tracks"],
        "total_divisions": lineage_metrics["total_divisions"],
        "total_roots": lineage_metrics["total_roots"],
        "max_lineage_depth": lineage_metrics["max_lineage_depth"],
        "evaluation": eval_results,
    }

    summary_path = output_dir / "summary_report.json"
    with open(summary_path, "w") as f:
        json.dump(summary_report, f, indent=2)

    if progress_callback:
        progress_callback("Pipeline Finished Successfully!", 1.0)

    return summary_report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run V.I.T.A.L Cell Tracking Pipeline")
    parser.add_argument("recording_id", type=str, help="Recording ID, e.g. 6bba_48816121")
    parser.add_argument("--output_dir", type=str, default="vital/runs/run_latest")
    parser.add_argument("--time_start", type=int, default=0)
    parser.add_argument("--time_end", type=int, default=100)
    parser.add_argument("--use_gt_detections", action="store_true", help="Benchmark tracking using GT detections")
    args = parser.parse_args()

    out_path = Path(args.output_dir)
    res = run_vital_pipeline(
        recording_id=args.recording_id,
        output_dir=out_path,
        time_start=args.time_start,
        time_end=args.time_end,
        use_gt_detections=args.use_gt_detections,
    )
    print("\n--- Summary Report ---")
    print(json.dumps(res, indent=2))
