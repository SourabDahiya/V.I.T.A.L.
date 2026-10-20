"""V.I.T.A.L - Visual Identification and Tracking of Ancestral Lineages
Production Web Server and REST API Backend.

Serves the standalone modern web application without Streamlit:
- High-performance REST endpoints for 3D cell detections, trajectories, and lineage graphs
- Dual Application Modes: "⚡ Demo Mode" and "🔬 Process New Recording"
- Live pipeline execution engine with asynchronous task tracking and progress reporting
- Dynamic MIP and optical slice rendering directly from 4D Zarr microscopy volumes
- Video streaming with HTTP 206 byte-range support for seamless scrubbing
- Scientific file exports: CSVs and GEFF v1.1 lineage graphs
"""

import os
import io
import json
import zipfile
import mimetypes
import threading
import uuid
import time
from pathlib import Path
from typing import Dict, Any, Optional
import functools

import numpy as np
import pandas as pd
from PIL import Image
from flask import Flask, jsonify, request, send_file, send_from_directory, Response, abort

# Set up project root
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
import sys
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

from vital.config import (
    TRAIN_DIR,
    TEST_DIR,
    DEMO_CACHE_DIR,
    DEMO_RECORDINGS,
    SCALE_Z,
    SCALE_Y,
    SCALE_X,
)
from vital.io.zarr_reader import ZarrReader
from vital.lineage.graph_builder import LineageGraphBuilder

RUNS_DIR = WORKSPACE_ROOT / "vital" / "runs"
RUNS_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="")

# Background Pipeline Execution Tasks Store
PIPELINE_TASKS: Dict[str, Dict[str, Any]] = {}
CUSTOM_RECORDINGS: Dict[str, Path] = {}


# -----------------------------------------------------------------------------
# CACHES AND HELPERS
# -----------------------------------------------------------------------------
def get_specimen_dir(rec_id: str) -> Path:
    """Find directory containing the specimen's processed output."""
    run_dir = RUNS_DIR / rec_id
    if run_dir.exists() and (run_dir / "cells_stage2.csv").exists():
        return run_dir
    demo_dir = DEMO_CACHE_DIR / rec_id
    if demo_dir.exists():
        return demo_dir
    return run_dir


@functools.lru_cache(maxsize=32)
def get_zarr_reader(recording_id: str) -> Optional[ZarrReader]:
    """Cache ZarrReader instances for fast frame rendering."""
    # 1. Check custom session registry
    if recording_id in CUSTOM_RECORDINGS and CUSTOM_RECORDINGS[recording_id].exists():
        try:
            return ZarrReader(CUSTOM_RECORDINGS[recording_id])
        except Exception as e:
            print(f"Error loading custom Zarr for {recording_id}: {e}")

    # 2. Check RUNS_DIR session directory
    run_zarr = RUNS_DIR / recording_id / f"{recording_id}.zarr"
    if run_zarr.exists():
        try:
            return ZarrReader(run_zarr)
        except Exception as e:
            print(f"Error loading runs Zarr for {recording_id}: {e}")

    # 3. Check train and test dataset directories
    for root in [TRAIN_DIR, TEST_DIR]:
        path = root / f"{recording_id}.zarr"
        if path.exists():
            try:
                return ZarrReader(path)
            except Exception as e:
                print(f"Error loading Zarr for {recording_id}: {e}")
    return None


def clean_val(v):
    """Recursively convert numpy types to Python native types for JSON serialization."""
    if isinstance(v, (np.integer, int)):
        return int(v)
    elif isinstance(v, (np.floating, float)):
        return 0.0 if np.isnan(v) or np.isinf(v) else float(v)
    elif isinstance(v, (np.ndarray, list)):
        return [clean_val(x) for x in v]
    elif isinstance(v, dict):
        return {k: clean_val(val) for k, val in v.items()}
    return v


# -----------------------------------------------------------------------------
# ROOT ROUTE
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    """Serve the single-page application."""
    return send_from_directory(app.static_folder, "index.html")


# -----------------------------------------------------------------------------
# API ROUTES: SPECIMEN CATALOG & APPLICATION MODES
# -----------------------------------------------------------------------------
@app.route("/api/specimens")
def get_specimens():
    """List precomputed demo specimens with high-level stats."""
    manifest_path = DEMO_CACHE_DIR / "demo_manifest.json"
    manifest = {}
    if manifest_path.exists():
        with open(manifest_path, "r") as f:
            manifest = json.load(f)

    result = []
    for rec_id in DEMO_RECORDINGS:
        info = manifest.get(rec_id, {})
        eval_info = info.get("evaluation", {})
        result.append({
            "id": rec_id,
            "name": f"Specimen {rec_id}",
            "detections": info.get("total_detections", 0),
            "tracks": info.get("total_tracks", 0),
            "divisions": info.get("total_divisions", 0),
            "roots": info.get("total_roots", 0),
            "edge_jaccard": round(eval_info.get("edge_jaccard", 0.0), 4),
            "division_jaccard": round(eval_info.get("division_jaccard", 0.0), 4),
            "elapsed_seconds": info.get("elapsed_seconds", 0.8),
            "is_demo": True,
        })
    return jsonify(clean_val(result))


@app.route("/api/available-recordings")
def get_available_recordings():
    """Catalog of all dataset recordings available for live pipeline execution."""
    train_zarrs = sorted([p.stem for p in TRAIN_DIR.glob("*.zarr")])
    test_zarrs = sorted([p.stem for p in TEST_DIR.glob("*.zarr")])
    
    # Detailed processed runs from vital/runs
    processed_runs = []
    processed_ids = set()
    for d in sorted(RUNS_DIR.iterdir()):
        if d.is_dir() and (d / "cells_stage2.csv").exists():
            rec_id = d.name
            processed_ids.add(rec_id)
            info = {}
            sum_path = d / "summary_report.json"
            if sum_path.exists():
                try:
                    with open(sum_path, "r") as f:
                        info = json.load(f)
                except Exception:
                    pass
            eval_info = info.get("evaluation", {})
            processed_runs.append({
                "id": rec_id,
                "name": f"Processed Specimen {rec_id}",
                "detections": info.get("total_detections", 0),
                "tracks": info.get("total_tracks", 0),
                "divisions": info.get("total_divisions", 0),
                "roots": info.get("total_roots", 0),
                "edge_jaccard": round(eval_info.get("edge_jaccard", 0.0), 4),
                "division_jaccard": round(eval_info.get("division_jaccard", 0.0), 4),
                "elapsed_seconds": info.get("elapsed_seconds", 0.0),
                "is_demo": False,
            })

    items = []
    # Candidate recordings for processing (excluding the 3 demo recordings)
    for z in train_zarrs:
        if z in DEMO_RECORDINGS:
            continue
        is_processed = z in processed_ids
        has_gt = (TRAIN_DIR / f"{z}.geff").exists()
        items.append({
            "id": z,
            "split": "train",
            "label": f"train: {z} {'(✅ Processed)' if is_processed else '(Ready to Process)'}",
            "has_gt": has_gt,
            "is_processed": is_processed,
        })

    for z in test_zarrs:
        if z in DEMO_RECORDINGS:
            continue
        is_processed = z in processed_ids
        items.append({
            "id": z,
            "split": "test",
            "label": f"test: {z} {'(✅ Processed)' if is_processed else '(Ready to Process)'}",
            "has_gt": False,
            "is_processed": is_processed,
        })

    return jsonify(clean_val({
        "total_available": len(items),
        "processed_runs": processed_runs,
        "processed_ids": list(processed_ids),
        "recordings": items,
    }))


# -----------------------------------------------------------------------------
# LIVE PIPELINE EXECUTION (PROCESS NEW RECORDING)
# -----------------------------------------------------------------------------
def execute_pipeline_background(task_id: str, recording_id: str, time_start: int, time_end: int, use_gt_detections: bool):
    """Execute V.I.T.A.L pipeline in a background worker thread."""
    try:
        PIPELINE_TASKS[task_id] = {
            "task_id": task_id,
            "status": "running",
            "progress": 0.10,
            "message": "Initializing tracking modules & calibrating physical voxel scales...",
            "recording_id": recording_id,
            "start_time": time.time(),
        }

        from vital.io.video_generator import generate_embryo_timelapse_videos
        from scripts.run_pipeline import run_vital_pipeline

        target_dir = RUNS_DIR / recording_id
        target_dir.mkdir(parents=True, exist_ok=True)

        def update_prog(msg, pct):
            if task_id in PIPELINE_TASKS:
                PIPELINE_TASKS[task_id]["progress"] = round(pct, 2)
                PIPELINE_TASKS[task_id]["message"] = msg

        custom_path = CUSTOM_RECORDINGS.get(recording_id)
        if not custom_path:
            cand = target_dir / f"{recording_id}.zarr"
            if cand.exists():
                custom_path = cand

        # Execute 3-Stage Pipeline
        summary = run_vital_pipeline(
            recording_id=recording_id,
            output_dir=target_dir,
            time_start=time_start,
            time_end=time_end,
            use_gt_detections=use_gt_detections,
            progress_callback=update_prog,
            custom_zarr_path=custom_path,
        )

        # Video Generation
        PIPELINE_TASKS[task_id]["progress"] = 0.90
        PIPELINE_TASKS[task_id]["message"] = "Rendering dual-stream timelapse videos and GEFF v1.1 export..."
        s2_path = target_dir / "cells_stage2.csv"
        s2_df = pd.read_csv(s2_path) if s2_path.exists() else None
        generate_embryo_timelapse_videos(recording_id, target_dir, s2_df, custom_zarr_path=custom_path)

        elapsed = round(time.time() - PIPELINE_TASKS[task_id]["start_time"], 2)
        PIPELINE_TASKS[task_id]["status"] = "completed"
        PIPELINE_TASKS[task_id]["progress"] = 1.0
        PIPELINE_TASKS[task_id]["message"] = f"Pipeline complete in {elapsed}s! All 5 tabs updated."
        PIPELINE_TASKS[task_id]["elapsed_seconds"] = elapsed
        PIPELINE_TASKS[task_id]["summary"] = summary

    except Exception as e:
        print(f"Pipeline task {task_id} failed: {e}")
        PIPELINE_TASKS[task_id]["status"] = "failed"
        PIPELINE_TASKS[task_id]["message"] = f"Execution error: {str(e)}"


@app.route("/api/pipeline/run", methods=["POST"])
def run_pipeline_api():
    """Trigger live pipeline processing for an embryo specimen."""
    data = request.get_json() or {}
    recording_id = data.get("recording_id", "").strip()
    if not recording_id:
        abort(400, "recording_id is required")

    time_start = int(data.get("time_start", 0))
    time_end = int(data.get("time_end", 20))
    use_gt_detections = bool(data.get("use_gt_detections", True))

    task_id = str(uuid.uuid4())[:8]
    PIPELINE_TASKS[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "progress": 0.05,
        "message": f"Queued processing for specimen {recording_id} (t={time_start}..{time_end})...",
        "recording_id": recording_id,
    }

    thread = threading.Thread(
        target=execute_pipeline_background,
        args=(task_id, recording_id, time_start, time_end, use_gt_detections),
        daemon=True,
    )
    thread.start()

    return jsonify({
        "task_id": task_id,
        "status": "started",
        "recording_id": recording_id,
    })


@app.route("/api/pipeline/status/<task_id>")
def get_pipeline_status(task_id: str):
    """Poll pipeline execution status and progress."""
    task = PIPELINE_TASKS.get(task_id)
    if not task:
        abort(404, "Task not found")
    return jsonify(clean_val(task))


@app.route("/api/pipeline/upload-dataset", methods=["POST"])
def upload_custom_dataset():
    """Upload custom embryo dataset (.zip of .zarr or 4D .tif) for stateless in-memory / session analysis."""
    if "file" not in request.files:
        abort(400, "No file uploaded")
    file = request.files["file"]
    if not file or not file.filename:
        abort(400, "Invalid file")

    filename = file.filename
    clean_stem = Path(filename).stem.replace(" ", "_")
    session_id = f"custom_{clean_stem}"
    session_dir = RUNS_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    try:
        if filename.endswith(".zip"):
            zip_path = session_dir / "uploaded.zip"
            file.save(str(zip_path))
            with zipfile.ZipFile(str(zip_path), "r") as zf:
                zf.extractall(str(session_dir))
            zip_path.unlink(missing_ok=True)

            zarr_candidates = list(session_dir.glob("*.zarr")) + [
                p for p in session_dir.iterdir() if p.is_dir() and ((p / ".zarray").exists() or (p / ".zgroup").exists())
            ]
            if zarr_candidates:
                zarr_target = zarr_candidates[0]
                final_zarr = session_dir / f"{session_id}.zarr"
                if zarr_target != final_zarr:
                    import shutil
                    if final_zarr.exists():
                        shutil.rmtree(final_zarr)
                    shutil.move(str(zarr_target), str(final_zarr))
                zarr_path = final_zarr
            else:
                zarr_path = session_dir / f"{session_id}.zarr"

        elif filename.lower().endswith((".tif", ".tiff")):
            import tifffile
            tif_bytes = file.read()
            vol = tifffile.imread(io.BytesIO(tif_bytes))
            if vol.ndim == 3:
                vol = vol[np.newaxis, ...]
            elif vol.ndim > 4:
                vol = vol.reshape((-1,) + vol.shape[-3:])
            import zarr
            zarr_path = session_dir / f"{session_id}.zarr"
            zarr.save(str(zarr_path), vol)
        else:
            abort(400, "Unsupported file format. Please upload .zarr.zip or .tif.")

        CUSTOM_RECORDINGS[session_id] = zarr_path
        reader = ZarrReader(zarr_path)

        return jsonify({
            "status": "success",
            "recording_id": session_id,
            "filename": filename,
            "num_frames": reader.num_frames,
            "shape": list(reader.shape),
            "message": f"Successfully loaded {filename} ({reader.num_frames} frames, {reader.shape[1]} z-slices). Ready for analysis!"
        })
    except Exception as e:
        print(f"Error handling custom upload: {e}")
        abort(500, f"Error processing uploaded dataset: {str(e)}")


@app.route("/api/pipeline/load-path", methods=["POST"])
def load_custom_dataset_path():
    """Mount external .zarr directory from local disk for zero-copy session analysis."""
    data = request.get_json() or {}
    folder_path = data.get("folder_path", "").strip()
    if not folder_path:
        abort(400, "folder_path is required")

    p = Path(folder_path)
    if not p.exists():
        abort(404, f"Path not found: {folder_path}")

    zarr_dir = p if ((p / ".zarray").exists() or (p / ".zgroup").exists() or p.suffix == ".zarr") else None
    if not zarr_dir:
        sub_zarrs = list(p.glob("*.zarr"))
        if sub_zarrs:
            zarr_dir = sub_zarrs[0]

    if not zarr_dir:
        abort(400, f"No valid Zarr store found at {folder_path}. Missing .zarray or .zgroup.")

    try:
        clean_stem = zarr_dir.stem.replace(" ", "_")
        session_id = f"ext_{clean_stem}"
        CUSTOM_RECORDINGS[session_id] = zarr_dir
        (RUNS_DIR / session_id).mkdir(parents=True, exist_ok=True)
        reader = ZarrReader(zarr_dir)

        return jsonify({
            "status": "success",
            "recording_id": session_id,
            "filename": zarr_dir.name,
            "num_frames": reader.num_frames,
            "shape": list(reader.shape),
            "message": f"Successfully linked {zarr_dir.name} ({reader.num_frames} frames, {reader.shape[1]} z-slices). Ready for analysis!"
        })
    except Exception as e:
        print(f"Error mounting external path {folder_path}: {e}")
        abort(500, f"Error opening Zarr at {folder_path}: {str(e)}")


# -----------------------------------------------------------------------------
# SPECIMEN DATA & VISUALIZATION ENDPOINTS
# -----------------------------------------------------------------------------
@app.route("/api/specimen/<rec_id>/summary")
def get_specimen_summary(rec_id: str):
    """Retrieve full summary metrics, evaluation, and track metadata."""
    rec_dir = get_specimen_dir(rec_id)
    if not rec_dir.exists():
        abort(404, f"Specimen {rec_id} not found")

    rep_path = rec_dir / "summary_report.json"
    summary = {}
    if rep_path.exists():
        with open(rep_path, "r") as f:
            summary = json.load(f)

    # Load Stage 2 tracks to extract track metrics
    s2_path = rec_dir / "cells_stage2.csv"
    stage2_df = pd.read_csv(s2_path) if s2_path.exists() else pd.DataFrame()

    tracks_meta = []
    track_lengths = {}
    if not stage2_df.empty:
        if "z_um" not in stage2_df.columns:
            stage2_df["z_um"] = stage2_df["z"] * SCALE_Z
            stage2_df["y_um"] = stage2_df["y"] * SCALE_Y
            stage2_df["x_um"] = stage2_df["x"] * SCALE_X

        for tid, group in stage2_df.groupby("track_id"):
            tid = int(tid)
            grp_sorted = group.sort_values(by="t")
            num_frames = len(grp_sorted)
            track_lengths[tid] = num_frames

            # Calculate displacement
            dz = np.diff(grp_sorted["z_um"])
            dy = np.diff(grp_sorted["y_um"])
            dx = np.diff(grp_sorted["x_um"])
            step_dists = np.sqrt(dz**2 + dy**2 + dx**2) if len(grp_sorted) > 1 else np.array([0.0])
            tot_disp = float(np.sum(step_dists))
            avg_vel = float(tot_disp / (num_frames - 1)) if num_frames > 1 else 0.0

            net_dz = grp_sorted["z_um"].iloc[-1] - grp_sorted["z_um"].iloc[0]
            net_dy = grp_sorted["y_um"].iloc[-1] - grp_sorted["y_um"].iloc[0]
            net_dx = grp_sorted["x_um"].iloc[-1] - grp_sorted["x_um"].iloc[0]
            net_disp = float(np.sqrt(net_dz**2 + net_dy**2 + net_dx**2))

            tracks_meta.append({
                "track_id": tid,
                "frames": num_frames,
                "start_t": int(grp_sorted["t"].iloc[0]),
                "end_t": int(grp_sorted["t"].iloc[-1]),
                "total_displacement": round(tot_disp, 2),
                "net_displacement": round(net_disp, 2),
                "avg_velocity": round(avg_vel, 2),
                "parent_track_id": int(grp_sorted["parent_track_id"].iloc[0]) if "parent_track_id" in grp_sorted.columns else -1,
                "event": str(grp_sorted["event"].iloc[-1]) if "event" in grp_sorted.columns else "migration",
            })

    all_tids = sorted([t["track_id"] for t in tracks_meta])

    payload = {
        "recording_id": rec_id,
        "summary": summary,
        "tracks_meta": tracks_meta,
        "track_ids": all_tids,
        "total_tracks": len(all_tids),
        "mean_track_len": round(float(np.mean(list(track_lengths.values()))), 1) if track_lengths else 0.0,
        "longest_track": int(max(track_lengths.values())) if track_lengths else 0,
        "total_points": len(stage2_df),
        "physical_box": {
            "z_um": 104.0,
            "y_um": 104.0,
            "x_um": 104.0,
            "scale_z": SCALE_Z,
            "scale_y": SCALE_Y,
            "scale_x": SCALE_X,
        }
    }
    return jsonify(clean_val(payload))


@app.route("/api/specimen/<rec_id>/stage1")
def get_specimen_stage1(rec_id: str):
    """Get Stage 1 cell detections mapped to persistent track IDs. Optionally filter by t."""
    rec_dir = get_specimen_dir(rec_id)
    s1_path = rec_dir / "cells_stage1.csv"
    if not s1_path.exists():
        abort(404, "Stage 1 detections not found")

    df = pd.read_csv(s1_path)
    if "detection_id" not in df.columns and "cell_id" in df.columns:
        df["detection_id"] = df["cell_id"]
    elif "cell_id" not in df.columns and "detection_id" in df.columns:
        df["cell_id"] = df["detection_id"]

    if "z_um" not in df.columns:
        df["z_um"] = df["z"] * SCALE_Z
        df["y_um"] = df["y"] * SCALE_Y
        df["x_um"] = df["x"] * SCALE_X

    frame_counts = df.groupby("t").size().to_dict()
    frame_counts = {int(k): int(v) for k, v in frame_counts.items()}

    t_arg = request.args.get("t")
    if t_arg is not None:
        try:
            t_val = int(t_arg)
            df = df[df["t"] == t_val]
        except ValueError:
            pass

    # Map detection_id to persistent track_id from stage2 tracking
    det_to_track = {}
    s2_path = rec_dir / "cells_stage2.csv"
    if s2_path.exists():
        df_s2 = pd.read_csv(s2_path)
        if "detection_id" in df_s2.columns and "track_id" in df_s2.columns:
            for _, r2 in df_s2.iterrows():
                det_to_track[int(r2["detection_id"])] = int(r2["track_id"])

    # Exclude mean_intensity as requested in previous requirements
    records = []
    for _, row in df.iterrows():
        det_id = int(row.get("unique_id", row.get("cell_id", row.get("detection_id", 0))))
        trk_id = det_to_track.get(det_id, det_id)
        records.append({
            "unique_id": det_id,
            "detection_id": det_id,
            "track_id": trk_id,
            "cell_id": trk_id,
            "t": int(row["t"]),
            "z": round(float(row["z"]), 2),
            "y": round(float(row["y"]), 2),
            "x": round(float(row["x"]), 2),
            "z_um": round(float(row["z_um"]), 2),
            "y_um": round(float(row["y_um"]), 2),
            "x_um": round(float(row["x_um"]), 2),
            "volume": int(row.get("volume", 250)),
        })

    return jsonify(clean_val({
        "recording_id": rec_id,
        "total_detections": len(records),
        "frame_counts": frame_counts,
        "detections": records,
    }))


@app.route("/api/specimen/<rec_id>/stage2")
def get_specimen_stage2(rec_id: str):
    """Get Stage 2 tracked cell trajectories. Optionally filter by track_ids or t."""
    rec_dir = get_specimen_dir(rec_id)
    s2_path = rec_dir / "cells_stage2.csv"
    if not s2_path.exists():
        abort(404, "Stage 2 tracks not found")

    df = pd.read_csv(s2_path)
    if "z_um" not in df.columns:
        df["z_um"] = df["z"] * SCALE_Z
        df["y_um"] = df["y"] * SCALE_Y
        df["x_um"] = df["x"] * SCALE_X

    t_arg = request.args.get("t")
    if t_arg is not None:
        try:
            t_val = int(t_arg)
            df = df[df["t"] == t_val]
        except ValueError:
            pass

    track_id_arg = request.args.get("track_id")
    if track_id_arg is not None:
        try:
            tid_val = int(track_id_arg)
            df = df[df["track_id"] == tid_val]
        except ValueError:
            pass

    records = []
    for _, row in df.iterrows():
        det_id = int(row["detection_id"]) if "detection_id" in row and pd.notna(row["detection_id"]) else (int(row["cell_id"]) if "cell_id" in row and pd.notna(row["cell_id"]) else int(row["track_id"]))
        records.append({
            "track_id": int(row["track_id"]),
            "detection_id": det_id,
            "cell_id": det_id,
            "t": int(row["t"]),
            "z": round(float(row["z"]), 2),
            "y": round(float(row["y"]), 2),
            "x": round(float(row["x"]), 2),
            "z_um": round(float(row["z_um"]), 2),
            "y_um": round(float(row["y_um"]), 2),
            "x_um": round(float(row["x_um"]), 2),
            "event": str(row.get("event", "migration")),
            "parent_track_id": int(row.get("parent_track_id", -1)),
        })

    return jsonify(clean_val({
        "recording_id": rec_id,
        "count": len(records),
        "tracks": records,
    }))


@app.route("/api/specimen/<rec_id>/lineage")
def get_specimen_lineage(rec_id: str):
    """Generate and return ancestral lineage tree and relationship dictionary."""
    rec_dir = get_specimen_dir(rec_id)
    s2_path = rec_dir / "cells_stage2.csv"
    if not s2_path.exists():
        abort(404, "Tracking data not found for lineage tree")

    df = pd.read_csv(s2_path)
    builder = LineageGraphBuilder()
    tree = builder.build_track_hierarchy_graph(df)
    metrics = builder.compute_lineage_metrics(tree)

    # Detailed relationship map for each cell
    relationships = {}
    for node in tree.nodes():
        node = int(node)
        cell_data = tree.nodes[node]
        parents = [int(p) for p in tree.predecessors(node)]
        daughters = [int(d) for d in tree.successors(node)]
        siblings = []
        if parents:
            parent_id = parents[0]
            siblings = [int(s) for s in tree.successors(parent_id) if s != node]

        grandchildren = []
        for d in daughters:
            grandchildren.extend([int(gc) for gc in tree.successors(d)])

        is_progenitor = len(parents) == 0
        has_division = len(daughters) >= 2

        relationships[node] = {
            "track_id": node,
            "role": "Progenitor Root" if is_progenitor else "Daughter Branch",
            "parent": parents[0] if parents else None,
            "siblings": siblings,
            "has_division": has_division,
            "daughters": daughters,
            "grandchildren": grandchildren,
            "start_t": int(cell_data.get("start_t", 0)),
            "end_t": int(cell_data.get("end_t", 0)),
            "lifespan": int(cell_data.get("lifespan", 0)),
            "mean_speed_um": round(float(cell_data.get("mean_speed_um_per_frame", 0.0)), 2),
            "total_displacement_um": round(float(cell_data.get("total_displacement_um", 0.0)), 2),
        }

    # Generate Plotly figure JSON for direct browser rendering
    plotly_fig = builder.generate_plotly_lineage_tree(tree)
    plotly_json = json.loads(plotly_fig.to_json())

    return jsonify(clean_val({
        "recording_id": rec_id,
        "metrics": metrics,
        "relationships": relationships,
        "tree_plotly": plotly_json,
    }))


# -----------------------------------------------------------------------------
# MICROSCOPY SLICE & MIP IMAGE RENDERING
# -----------------------------------------------------------------------------
@app.route("/api/specimen/<rec_id>/frame-mip/<int:t>")
def get_frame_mip(rec_id: str, t: int):
    """Render 2D Maximum Intensity Projection (MIP) for frame t as PNG."""
    reader = get_zarr_reader(rec_id)
    if reader is None:
        abort(404, f"Zarr recording {rec_id} not found")

    try:
        t = max(0, min(99, t))
        mip = reader.get_max_projection(t, axis=0)

        # Contrast stretch & normalize to 8-bit
        min_v = float(mip.min())
        max_v = float(mip.max())
        if max_v > min_v:
            norm = np.clip((mip - min_v) / (max_v - min_v) * 255.0, 0, 255).astype(np.uint8)
        else:
            norm = np.zeros_like(mip, dtype=np.uint8)

        img = Image.fromarray(norm).resize((768, 768), resample=Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype="image/png")
    except Exception as e:
        abort(500, f"Error rendering MIP: {e}")


@app.route("/api/specimen/<rec_id>/frame-slice/<int:t>/<int:z>")
def get_frame_slice(rec_id: str, t: int, z: int):
    """Render optical depth section slice (z) for frame t as PNG."""
    reader = get_zarr_reader(rec_id)
    if reader is None:
        abort(404, f"Zarr recording {rec_id} not found")

    try:
        t = max(0, min(99, t))
        z = max(0, min(63, z))
        slc = reader.get_slice(t, z)

        min_v = float(slc.min())
        max_v = float(slc.max())
        if max_v > min_v:
            norm = np.clip((slc - min_v) / (max_v - min_v) * 255.0, 0, 255).astype(np.uint8)
        else:
            norm = np.zeros_like(slc, dtype=np.uint8)

        img = Image.fromarray(norm).resize((768, 768), resample=Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype="image/png")
    except Exception as e:
        abort(500, f"Error rendering slice: {e}")


# -----------------------------------------------------------------------------
# VIDEO STREAMING (WITH HTTP 206 BYTE-RANGE SUPPORT)
# -----------------------------------------------------------------------------
@app.route("/api/video/<rec_id>/<video_name>")
def stream_video(rec_id: str, video_name: str):
    """Stream MP4 videos with partial byte range support for smooth scrubbing."""
    rec_dir = get_specimen_dir(rec_id)
    video_path = rec_dir / video_name
    if not video_path.exists() or not video_path.is_file():
        # Fallback to demo cache
        video_path = DEMO_CACHE_DIR / rec_id / video_name

    if not video_path.exists() or not video_path.is_file():
        abort(404, f"Video {video_name} not found")

    file_size = os.path.getsize(video_path)
    range_header = request.headers.get("Range", None)

    if not range_header:
        return send_file(video_path, mimetype="video/mp4")

    # Handle Range: bytes=start-end
    byte1, byte2 = 0, None
    m = range_header.replace("bytes=", "").split("-")
    if m[0]:
        byte1 = int(m[0])
    if len(m) > 1 and m[1]:
        byte2 = int(m[1])

    length = file_size - byte1
    if byte2 is not None:
        length = byte2 - byte1 + 1

    with open(video_path, "rb") as f:
        f.seek(byte1)
        data = f.read(length)

    rv = Response(data, 206, mimetype="video/mp4", direct_passthrough=True)
    rv.headers.add("Content-Range", f"bytes {byte1}-{byte1 + length - 1}/{file_size}")
    rv.headers.add("Accept-Ranges", "bytes")
    rv.headers.add("Content-Length", str(length))
    return rv


# -----------------------------------------------------------------------------
# DOWNLOADS
# -----------------------------------------------------------------------------
@app.route("/api/download/<rec_id>/<file_type>")
def download_file(rec_id: str, file_type: str):
    """Download CSV and GEFF scientific artifacts."""
    rec_dir = get_specimen_dir(rec_id)
    if not rec_dir.exists():
        abort(404, "Specimen not found")

    if file_type == "stage1":
        file_path = rec_dir / "cells_stage1.csv"
        if not file_path.exists():
            abort(404, "Stage 1 detections not found")
        df = pd.read_csv(file_path)
        if "unique_id" not in df.columns:
            uid = df["detection_id"] if "detection_id" in df.columns else (df["cell_id"] if "cell_id" in df.columns else np.arange(1, len(df) + 1))
            df.insert(0, "unique_id", uid)
        if "cell_id" not in df.columns:
            df.insert(1, "cell_id", df["unique_id"])

        s2_path = rec_dir / "cells_stage2.csv"
        if "track_id" not in df.columns and s2_path.exists():
            try:
                s2_df = pd.read_csv(s2_path)
                if "detection_id" in s2_df.columns and "track_id" in s2_df.columns:
                    det_to_track = dict(zip(s2_df["detection_id"], s2_df["track_id"]))
                    df.insert(2, "track_id", df["unique_id"].map(det_to_track).fillna(df["unique_id"]).astype(int))
            except Exception:
                pass

        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        buf.seek(0)
        return send_file(buf, as_attachment=True, download_name=f"{rec_id}_cells_stage1.csv", mimetype="text/csv")
    elif file_type == "stage2":
        file_path = rec_dir / "cells_stage2.csv"
        return send_file(file_path, as_attachment=True, download_name=f"{rec_id}_cells_stage2.csv", mimetype="text/csv")
    elif file_type == "stage3":
        s3_path = rec_dir / "lineage_stage3.csv"
        if not s3_path.exists():
            s2_path = rec_dir / "cells_stage2.csv"
            df = pd.read_csv(s2_path)
            builder = LineageGraphBuilder()
            tree = builder.build_track_hierarchy_graph(df)
            stage3_df = builder.generate_lineage_stage3_dataframe(df, tree)
            stage3_df.to_csv(s3_path, index=False)
        return send_file(s3_path, as_attachment=True, download_name=f"{rec_id}_lineage_stage3.csv", mimetype="text/csv")
    elif file_type == "geff":
        geff_path = rec_dir / "lineage_output.geff"
        if geff_path.is_dir():
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in geff_path.rglob("*"):
                    if f.is_file():
                        zf.write(f, arcname=f.relative_to(geff_path))
            buf.seek(0)
            return send_file(buf, as_attachment=True, download_name=f"{rec_id}_lineage_output.geff.zip", mimetype="application/zip")
        elif geff_path.is_file():
            return send_file(geff_path, as_attachment=True, download_name=f"{rec_id}_lineage_output.geff", mimetype="application/octet-stream")
        abort(404, "GEFF file not found")
    else:
        abort(400, "Invalid file type requested")


if __name__ == "__main__":
    print("[V.I.T.A.L] Starting Standalone Scientific Web Server on http://localhost:5000 ...")
    app.run(host="0.0.0.0", port=5000, debug=False)
