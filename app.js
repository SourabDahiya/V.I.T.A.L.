/**
 * V.I.T.A.L: Visual Identification and Tracking of Ancestral Lineages
 * Standalone Modern Scientific Web Application Controller
 */

// Distinct vibrant color palette for multi-track plotting
const COHORT_PALETTE = [
  "#00f2fe", "#10b981", "#f43f5e", "#fbbf24", "#a855f7", 
  "#ec4899", "#38bdf8", "#34d399", "#f97316", "#06b6d4"
];

const state = {
  appMode: "demo", // "demo" or "pipeline"
  specimenId: "6bba_48816121",
  demoSpecimens: [],
  processedRuns: [],
  activeTab: "tab-cinema",
  summary: null,
  stage1: null,
  stage2: null,
  lineage: null,
  
  // Tab 1 state
  cinemaFrame: 0,
  
  // Tab 2 state
  detectFrame: 0,
  detectMode: "mip", // "mip" or "slice"
  detectZ: 32,
  
  // Tab 3 state
  globalProj: "3d", // "3d" or "2d"
  selectedSingleTrack: null,
  singleProj: "3d",
  selectedCohort: [],
  cohortProj: "3d",
  
  // Tab 4 state
  selectedLineageCell: null,
  
  // Pipeline input source state
  pipelineSource: "library", // "library", "upload", or "path"
  customRecordingId: null,
};

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initEventListeners();
  loadSpecimens();
});

function initTabs() {
  const tabBtns = document.querySelectorAll(".nav-tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      switchTab(targetTab);
    });
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;
  
  // Update button classes
  document.querySelectorAll(".nav-tab-btn").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
  });
  
  // Update panel classes
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.toggle("active", p.id === tabId);
  });
  
  // Render active tab view
  renderActiveTab();
}

function renderActiveTab() {
  if (state.activeTab === "tab-cinema") renderCinemaTab();
  else if (state.activeTab === "tab-detection") renderDetectionTab();
  else if (state.activeTab === "tab-trajectories") renderTrajectoriesTab();
  else if (state.activeTab === "tab-lineage") renderLineageTab();
  else if (state.activeTab === "tab-accuracy") renderAccuracyTab();
}

function initEventListeners() {
  // Specimen Selector
  const specSelect = document.getElementById("specimen-select");
  specSelect.addEventListener("change", (e) => {
    state.specimenId = e.target.value;
    document.getElementById("active-specimen-pill").textContent = state.specimenId;
    loadSpecimenData(state.specimenId);
  });

  // Tab 1: Cinema Scrubber Slider
  const scrubSlider = document.getElementById("cinema-scrub-slider");
  scrubSlider.addEventListener("input", (e) => {
    state.cinemaFrame = parseInt(e.target.value);
    document.getElementById("cinema-frame-val").textContent = String(state.cinemaFrame).padStart(2, '0');
    updateCinemaScrubber();
  });

  // Tab 2: Detect Frame Slider & Select
  const detectFrameSlider = document.getElementById("detect-frame-slider");
  const detectFrameSelect = document.getElementById("detect-frame-select");
  const detectBadgeVal = document.getElementById("detect-frame-badge-val");

  if (detectFrameSlider) {
    detectFrameSlider.addEventListener("input", (e) => {
      state.detectFrame = parseInt(e.target.value);
      if (detectFrameSelect) detectFrameSelect.value = state.detectFrame;
      if (detectBadgeVal) detectBadgeVal.textContent = `Frame ${String(state.detectFrame).padStart(2, '0')}`;
      loadStage1Frame();
    });
  }

  if (detectFrameSelect) {
    detectFrameSelect.addEventListener("change", (e) => {
      state.detectFrame = parseInt(e.target.value);
      if (detectFrameSlider) detectFrameSlider.value = state.detectFrame;
      if (detectBadgeVal) detectBadgeVal.textContent = `Frame ${String(state.detectFrame).padStart(2, '0')}`;
      loadStage1Frame();
    });
  }

  // Pipeline Timepoint Draggable Range Slider Bar
  const pipeRangeSlider = document.getElementById("pipeline-range-slider");
  const pipeStartInput = document.getElementById("pipeline-t-start");
  const pipeEndInput = document.getElementById("pipeline-t-end");
  const pipeBadge = document.getElementById("pipeline-time-badge");

  function syncPipelineTimeUI() {
    let s = parseInt(pipeStartInput ? pipeStartInput.value : 0) || 0;
    let e = parseInt(pipeEndInput ? pipeEndInput.value : 20) || 20;
    if (s < 0) s = 0;
    if (e > 99) e = 99;
    if (s >= e) s = Math.max(0, e - 1);
    
    if (pipeStartInput) pipeStartInput.value = s;
    if (pipeEndInput) pipeEndInput.value = e;
    if (pipeRangeSlider) pipeRangeSlider.value = e;
    
    const count = e - s + 1;
    if (pipeBadge) {
      pipeBadge.textContent = `t = ${s} to ${e} • ${count} frames`;
    }

    // Update active preset button highlight
    document.querySelectorAll(".preset-pill").forEach(p => {
      const isMatch = (s === 0 && ((e === 20 && p.textContent.includes("20f")) ||
                                   (e === 40 && p.textContent.includes("40f")) ||
                                   (e === 99 && p.textContent.includes("100f"))));
      p.classList.toggle("active", isMatch);
    });
  }

  if (pipeRangeSlider) {
    pipeRangeSlider.addEventListener("input", (e) => {
      const endVal = parseInt(e.target.value);
      if (pipeEndInput) pipeEndInput.value = endVal;
      syncPipelineTimeUI();
    });
  }

  if (pipeStartInput) {
    pipeStartInput.addEventListener("input", syncPipelineTimeUI);
  }
  if (pipeEndInput) {
    pipeEndInput.addEventListener("input", syncPipelineTimeUI);
  }

  window.setPipelineRange = function(start, end) {
    if (pipeStartInput) pipeStartInput.value = start;
    if (pipeEndInput) pipeEndInput.value = end;
    syncPipelineTimeUI();
  };

  // Tab 2: Detect Mode Radios
  document.querySelectorAll("input[name='detect-mode']").forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.detectMode = e.target.value;
      const zContainer = document.getElementById("detect-z-container");
      zContainer.style.display = state.detectMode === "slice" ? "block" : "none";
      loadStage1Frame();
    });
  });

  // Tab 2: Optical Z Slider
  const zSlider = document.getElementById("detect-z-slider");
  zSlider.addEventListener("input", (e) => {
    state.detectZ = parseInt(e.target.value);
    document.getElementById("detect-z-val").textContent = state.detectZ;
    loadStage1Frame();
  });

  // Tab 3: Global Projection Radio
  document.querySelectorAll("input[name='global-proj']").forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.globalProj = e.target.value;
      renderGlobalTrajectory();
    });
  });

  // Tab 3: Single Track Select
  const singleTrackSelect = document.getElementById("single-track-select");
  singleTrackSelect.addEventListener("change", (e) => {
    state.selectedSingleTrack = parseInt(e.target.value);
    renderSingleTrajectory();
  });

  // Tab 3: Single Projection Radio
  document.querySelectorAll("input[name='single-proj']").forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.singleProj = e.target.value;
      renderSingleTrajectory();
    });
  });

  // Tab 3: Cohort Projection Radio
  document.querySelectorAll("input[name='cohort-proj']").forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.cohortProj = e.target.value;
      renderCohortTrajectory();
    });
  });

  // Tab 3: Add to Cohort Dropdown
  const cohortAddSelect = document.getElementById("cohort-add-select");
  cohortAddSelect.addEventListener("change", (e) => {
    const tid = parseInt(e.target.value);
    if (!isNaN(tid) && !state.selectedCohort.includes(tid)) {
      state.selectedCohort.push(tid);
      updateCohortChips();
      renderCohortTrajectory();
    }
    cohortAddSelect.value = "";
  });

  // Tab 4: Lineage Cell Select
  const lineageSelect = document.getElementById("lineage-cell-select");
  lineageSelect.addEventListener("change", (e) => {
    state.selectedLineageCell = parseInt(e.target.value);
    renderLineageInspector();
  });
}

async function loadSpecimens() {
  try {
    const res = await fetch("/api/specimens");
    state.demoSpecimens = await res.json();

    // Also fetch any newly processed runs
    try {
      const availRes = await fetch("/api/available-recordings");
      const availData = await availRes.json();
      state.processedRuns = availData.processed_runs || [];
    } catch (e) {
      state.processedRuns = [];
    }

    renderSpecimenDropdown();
  } catch (err) {
    console.error("Failed to load specimens:", err);
  }
}

function renderSpecimenDropdown() {
  const select = document.getElementById("specimen-select");
  if (!select) return;
  select.innerHTML = "";

  if (state.appMode === "demo") {
    // IN DEMO MODE: ONLY the 3 original demo recordings
    (state.demoSpecimens || []).forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `⚡ Specimen ${s.id} (${s.detections} cells, ${s.divisions} mitoses)`;
      select.appendChild(opt);
    });

    const isCurrentDemo = (state.demoSpecimens || []).some(s => s.id === state.specimenId);
    if (!isCurrentDemo && state.demoSpecimens && state.demoSpecimens.length > 0) {
      state.specimenId = state.demoSpecimens[0].id;
    }
  } else {
    // IN PROCESSING MODE: ONLY processed recordings from vital/runs
    if (!state.processedRuns || state.processedRuns.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "🔬 (No recordings processed yet - select & run below)";
      select.appendChild(opt);
    } else {
      state.processedRuns.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.id;
        const detStr = r.detections !== undefined ? `${r.detections} cells, ` : "";
        const divStr = r.divisions !== undefined ? `${r.divisions} mitoses` : "";
        opt.textContent = `🔬 Processed Specimen ${r.id} (${detStr}${divStr})`.replace(" ()", "");
        select.appendChild(opt);
      });

      const isCurrentProc = state.processedRuns.some(r => r.id === state.specimenId);
      if (!isCurrentProc && state.processedRuns.length > 0) {
        state.specimenId = state.processedRuns[0].id;
      }
    }
  }

  if (state.specimenId) {
    select.value = state.specimenId;
    document.getElementById("active-specimen-pill").textContent = state.specimenId;
    loadSpecimenData(state.specimenId);
  }
}

async function loadSpecimenData(recId) {
  try {
    // 1. Fetch Summary
    const summaryRes = await fetch(`/api/specimen/${recId}/summary`);
    state.summary = await summaryRes.json();
    
    // Update Top Metric Cards
    updateTopMetricCards();
    
    // Set default tracks
    if (state.summary.track_ids && state.summary.track_ids.length > 0) {
      state.selectedSingleTrack = state.summary.track_ids[0];
      state.selectedCohort = state.summary.track_ids.slice(0, Math.min(4, state.summary.track_ids.length));
    }
    
    // 2. Fetch Stage 2 Data (trajectories)
    const s2Res = await fetch(`/api/specimen/${recId}/stage2`);
    state.stage2 = await s2Res.json();

    // 3. Fetch Stage 1 summary info
    const s1Res = await fetch(`/api/specimen/${recId}/stage1?t=0`);
    state.stage1 = await s1Res.json();
    
    // Populate dropdowns
    populateDetectFrameDropdown();
    populateTrackDropdowns();
    updateCohortChips();

    // Reset Lineage cache
    state.lineage = null;

    // Render active tab
    renderActiveTab();
  } catch (err) {
    console.error("Error loading specimen data:", err);
  }
}

function updateTopMetricCards() {
  if (!state.summary) return;
  const s = state.summary.summary || {};
  const evalInfo = s.evaluation || {};
  
  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setEl("metric-total-cells", s.total_detections || 0);
  setEl("metric-track-lines", s.total_tracks || 0);
  setEl("metric-progenitor-roots", s.total_roots || 0);
  setEl("metric-mitotic-divisions", s.total_divisions || 0);
  setEl("metric-lineage-depth", `${s.max_lineage_depth || 1} Gen`);
  
  const jaccard = evalInfo.edge_jaccard !== undefined ? evalInfo.edge_jaccard.toFixed(3) : "N/A";
  setEl("metric-edge-jaccard", jaccard);
}

// ============================================================================
// TAB 1: EMBRYO TIMELAPSE CINEMA
// ============================================================================
function renderCinemaTab() {
  const recId = state.specimenId;
  
  // Set video sources
  const vidRaw = document.getElementById("video-raw");
  const vidAnn = document.getElementById("video-ann");
  vidRaw.src = `/api/video/${recId}/embryo_timelapse_raw.mp4`;
  vidAnn.src = `/api/video/${recId}/embryo_timelapse_annotated.mp4`;
  
  // Download buttons
  document.getElementById("btn-dl-raw-vid").href = `/api/video/${recId}/embryo_timelapse_raw.mp4`;
  document.getElementById("btn-dl-ann-vid").href = `/api/video/${recId}/embryo_timelapse_annotated.mp4`;

  updateCinemaScrubber();
}

async function updateCinemaScrubber() {
  const t = state.cinemaFrame;
  const recId = state.specimenId;
  
  // Update frozen MIP image
  const mipImg = document.getElementById("cinema-freeze-img");
  mipImg.src = `/api/specimen/${recId}/frame-mip/${t}`;

  // Filter stage 2 cells active at frame t
  if (!state.stage2 || !state.stage2.tracks) return;
  const activeNow = state.stage2.tracks.filter(tr => tr.t === t);
  const divNow = activeNow.filter(tr => tr.event === "division");

  // Update diagnostics
  document.getElementById("diag-active-count").textContent = `${activeNow.length} cells`;
  document.getElementById("diag-div-count").textContent = divNow.length;

  let meanZ = 0.0;
  let meanZSlice = 0;
  if (activeNow.length > 0) {
    const sumZ = activeNow.reduce((acc, curr) => acc + curr.z_um, 0);
    meanZ = sumZ / activeNow.length;
    meanZSlice = Math.round(activeNow.reduce((acc, curr) => acc + curr.z, 0) / activeNow.length);
  }
  document.getElementById("diag-mean-depth").textContent = `Z = ${meanZ.toFixed(1)} µm (Slice ~${meanZSlice})`;

  // Mitosis alert
  const alertBox = document.getElementById("cinema-mitosis-alert");
  if (divNow.length > 0) {
    alertBox.style.display = "flex";
    alertBox.innerHTML = `🚨 Mitotic Division in progress at frame t=${t}: Track #${divNow[0].track_id}!`;
  } else {
    alertBox.style.display = "none";
  }

  // Active Cells Table (Unique spot detection IDs: 1 to ~900)
  const tableBody = document.querySelector("#cinema-cells-table tbody");
  tableBody.innerHTML = "";
  activeNow.forEach(cell => {
    const spotId = cell.detection_id || cell.cell_id || cell.track_id;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b style="color:var(--accent-cyan);">Cell #${spotId}</b></td>
      <td>${cell.z_um.toFixed(1)}</td>
      <td>${cell.y_um.toFixed(1)}</td>
      <td>${cell.x_um.toFixed(1)}</td>
      <td><span class="badge-val ${cell.event === 'division' ? 'rose' : 'emerald'}">${cell.event}</span></td>
    `;
    tableBody.appendChild(tr);
  });
}

// ============================================================================
// TAB 2: SLICE-BY-SLICE EXPLORER (DETECTION)
// ============================================================================
function populateDetectFrameDropdown() {
  const select = document.getElementById("detect-frame-select");
  const slider = document.getElementById("detect-frame-slider");
  const badgeVal = document.getElementById("detect-frame-badge-val");
  if (!select) return;
  select.innerHTML = "";
  const counts = (state.stage1 && state.stage1.frame_counts) || {};
  
  for (let t = 0; t < 100; t++) {
    const opt = document.createElement("option");
    opt.value = t;
    const cnt = counts[t] || 0;
    opt.textContent = `Frame ${String(t).padStart(2, '0')} (${cnt} cells)`;
    select.appendChild(opt);
  }
  select.value = state.detectFrame;
  if (slider) slider.value = state.detectFrame;
  if (badgeVal) badgeVal.textContent = `Frame ${String(state.detectFrame).padStart(2, '0')}`;
}

async function loadStage1Frame() {
  const t = state.detectFrame;
  const recId = state.specimenId;

  // 1. Fetch detections for this frame
  const res = await fetch(`/api/specimen/${recId}/stage1?t=${t}`);
  const data = await res.json();
  const detections = data.detections || [];
  
  // Update badge
  document.getElementById("detect-frame-badge").innerHTML = `
    💡 Frame <code style="color:var(--accent-cyan); background:rgba(0,0,0,0.4); padding:2px 8px; border-radius:4px;">t = ${String(t).padStart(2, '0')} / 99</code>:
    <span style="color:var(--accent-emerald); margin-left:10px;">${detections.length} Cells Detected</span>
  `;

  // Update image
  const imgUrl = state.detectMode === "mip" 
    ? `/api/specimen/${recId}/frame-mip/${t}`
    : `/api/specimen/${recId}/frame-slice/${t}/${state.detectZ}`;
  
  // Render Plotly 2D image with cell markers
  renderDetectPlotly(imgUrl, detections);

  // Update detection table (Displays persistent Cell Track ID and raw Detection ID)
  const tableBody = document.querySelector("#detect-cells-table tbody");
  tableBody.innerHTML = "";
  detections.forEach(c => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b style="color:var(--accent-emerald);">#${c.unique_id || c.detection_id}</b></td>
      <td><span style="color:var(--accent-cyan); font-weight:700;">Cell #${c.track_id || c.cell_id}</span></td>
      <td>${c.z.toFixed(1)}</td>
      <td>${c.y.toFixed(1)}</td>
      <td>${c.x.toFixed(1)}</td>
      <td>${c.volume}</td>
    `;
    tableBody.appendChild(tr);
  });

  // Setup download button
  document.getElementById("btn-dl-stage1").href = `/api/download/${recId}/stage1`;
}

function renderDetectPlotly(imgUrl, detections) {
  // Filter detections if in slice mode (near z)
  let visibleDets = detections;
  if (state.detectMode === "slice") {
    visibleDets = detections.filter(d => Math.abs(d.z - state.detectZ) <= 3.0);
  }

  const traceMarkers = {
    x: visibleDets.map(d => d.x),
    y: visibleDets.map(d => d.y),
    mode: 'markers+text',
    type: 'scatter',
    marker: {
      size: 14,
      color: 'rgba(0, 242, 254, 0.85)',
      symbol: 'circle-open',
      line: { color: '#00f2fe', width: 2.5 }
    },
    text: visibleDets.map(d => `Cell #${d.track_id || d.cell_id}`),
    textposition: 'top center',
    textfont: { color: '#00f2fe', size: 10 },
    hoverinfo: 'text',
    hovertext: visibleDets.map(d => 
      `<b>Cell Track #${d.track_id || d.cell_id}</b><br>Detection Spot: #${d.detection_id}<br>Z=${d.z.toFixed(1)}, Y=${d.y.toFixed(1)}, X=${d.x.toFixed(1)}<br>Physical: (${d.z_um.toFixed(1)}, ${d.y_um.toFixed(1)}, ${d.x_um.toFixed(1)}) µm<br>Volume: ${d.volume} voxels`
    ),
    name: 'Detected Cells'
  };

  const layout = {
    title: {
      text: state.detectMode === 'mip' ? `MIP Projection with Detections (t=${state.detectFrame})` : `Optical Section (z=${state.detectZ}, t=${state.detectFrame})`,
      font: { color: '#ffffff', size: 15 }
    },
    xaxis: { range: [0, 256], color: '#cbd5e1', showgrid: false, zeroline: false },
    yaxis: { range: [256, 0], color: '#cbd5e1', showgrid: false, zeroline: false }, // inverted for image
    images: [{
      source: imgUrl,
      xref: "x",
      yref: "y",
      x: 0,
      y: 0,
      sizex: 256,
      sizey: 256,
      sizing: "stretch",
      layer: "below"
    }],
    plot_bgcolor: '#080c15',
    paper_bgcolor: '#080c15',
    margin: { l: 20, r: 20, t: 40, b: 20 },
    height: 440
  };

  Plotly.newPlot('detect-chart-box', [traceMarkers], layout, { responsive: true, displayModeBar: false });
}

function renderDetectionTab() {
  if (state.summary && state.stage1) {
    const counts = Object.values(state.stage1.frame_counts || {});
    const totalUnique = state.summary.summary.total_detections || 0;
    const avgCells = counts.length ? (counts.reduce((a,b)=>a+b,0) / counts.length).toFixed(1) : "0.0";
    const peakCount = counts.length ? Math.max(...counts) : 0;
    const seedCount = state.stage1.frame_counts[0] || 0;

    document.getElementById("det-unique-cells").textContent = totalUnique;
    document.getElementById("det-avg-cells").textContent = avgCells;
    document.getElementById("det-peak-cells").textContent = `${peakCount} cells`;
    const seedEl = document.getElementById("det-seed-cells");
    if (seedEl) seedEl.textContent = `${seedCount} cells`;
  }
  loadStage1Frame();
}

// ============================================================================
// TAB 3: TRAJECTORIES & DYNAMICS (TRACKING)
// ============================================================================
function populateTrackDropdowns() {
  if (!state.summary || !state.summary.track_ids) return;
  const tids = state.summary.track_ids;

  // Single track select
  const singleSelect = document.getElementById("single-track-select");
  singleSelect.innerHTML = "";
  tids.forEach(tid => {
    const opt = document.createElement("option");
    opt.value = tid;
    const meta = state.summary.tracks_meta.find(t => t.track_id === tid);
    opt.textContent = `Cell Track #${tid} (${meta ? meta.frames : 0} frames tracked)`;
    singleSelect.appendChild(opt);
  });
  if (state.selectedSingleTrack !== null) singleSelect.value = state.selectedSingleTrack;

  // Cohort add select
  const cohortSelect = document.getElementById("cohort-add-select");
  cohortSelect.innerHTML = `<option value="">+ Add cell to cohort...</option>`;
  tids.forEach(tid => {
    const opt = document.createElement("option");
    opt.value = tid;
    opt.textContent = `Cell #${tid}`;
    cohortSelect.appendChild(opt);
  });
}

function updateCohortChips() {
  const container = document.getElementById("cohort-chips");
  container.innerHTML = "";
  state.selectedCohort.forEach((tid, idx) => {
    const chip = document.createElement("div");
    chip.className = "cohort-chip";
    const color = COHORT_PALETTE[idx % COHORT_PALETTE.length];
    chip.style.borderColor = color;
    chip.innerHTML = `
      <span style="color:${color}">●</span> Cell #${tid}
      <span class="close-chip" onclick="removeCohortTrack(${tid})">&times;</span>
    `;
    container.appendChild(chip);
  });
}

window.removeCohortTrack = function(tid) {
  state.selectedCohort = state.selectedCohort.filter(id => id !== tid);
  updateCohortChips();
  renderCohortTrajectory();
};

function renderTrajectoriesTab() {
  if (!state.summary) return;

  // Trajectory Summary Cards
  document.getElementById("traj-total-tracks").textContent = state.summary.total_tracks || 0;
  document.getElementById("traj-mean-len").textContent = `${state.summary.mean_track_len || 0} frames`;
  document.getElementById("traj-longest-track").textContent = `${state.summary.longest_track || 0} frames`;
  document.getElementById("traj-total-points").textContent = state.summary.total_points || 0;

  // Setup download button
  document.getElementById("btn-dl-stage2").href = `/api/download/${state.specimenId}/stage2`;

  renderGlobalTrajectory();
  renderSingleTrajectory();
  renderCohortTrajectory();
}

function renderGlobalTrajectory() {
  if (!state.stage2 || !state.stage2.tracks) return;
  const tracks = state.stage2.tracks;

  const dataTraces = [];
  const trackGroups = {};
  tracks.forEach(pt => {
    if (!trackGroups[pt.track_id]) trackGroups[pt.track_id] = [];
    trackGroups[pt.track_id].push(pt);
  });

  if (state.globalProj === "3d") {
    // 3D Line Tracks for all cells
    Object.keys(trackGroups).forEach(tid => {
      const pts = trackGroups[tid].sort((a,b) => a.t - b.t);
      dataTraces.push({
        type: 'scatter3d',
        mode: 'lines',
        x: pts.map(p => p.x_um),
        y: pts.map(p => p.y_um),
        z: pts.map(p => p.z_um),
        line: { width: 3.5, color: pts.map(p => p.t), colorscale: 'Viridis' },
        hoverinfo: 'text',
        hovertext: pts.map(p => `Cell #${tid} (t=${p.t})<br>Pos: (${p.x_um.toFixed(1)}, ${p.y_um.toFixed(1)}, ${p.z_um.toFixed(1)}) µm`),
        showlegend: false
      });
    });

    const layout = {
      title: { text: `<b>Global Tissue Flow (${Object.keys(trackGroups).length} Cells)</b>`, font: { color: '#ffffff', size: 16 } },
      scene: {
        xaxis: { title: 'X (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
        yaxis: { title: 'Y (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
        zaxis: { title: 'Z (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
        bgcolor: '#080c15'
      },
      plot_bgcolor: '#080c15',
      paper_bgcolor: '#080c15',
      font: { color: '#ffffff' },
      margin: { l: 10, r: 10, t: 40, b: 10 },
      height: 520
    };
    Plotly.newPlot('global-traj-chart', dataTraces, layout, { responsive: true });
  } else {
    // 2D Projection
    Object.keys(trackGroups).forEach(tid => {
      const pts = trackGroups[tid].sort((a,b) => a.t - b.t);
      dataTraces.push({
        type: 'scatter',
        mode: 'lines',
        x: pts.map(p => p.x_um),
        y: pts.map(p => p.y_um),
        line: { width: 2.5, color: '#00f2fe' },
        hoverinfo: 'none',
        showlegend: false
      });
    });

    const layout = {
      title: { text: `<b>2D Multi-Track Projection (All Cells)</b>`, font: { color: '#ffffff', size: 16 } },
      xaxis: { title: 'X Position (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)' },
      yaxis: { title: 'Y Position (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)' },
      plot_bgcolor: '#080c15',
      paper_bgcolor: '#080c15',
      font: { color: '#ffffff' },
      margin: { l: 20, r: 20, t: 40, b: 20 },
      height: 520
    };
    Plotly.newPlot('global-traj-chart', dataTraces, layout, { responsive: true });
  }
}

function renderSingleTrajectory() {
  if (!state.stage2 || !state.stage2.tracks || state.selectedSingleTrack === null) return;
  const tid = state.selectedSingleTrack;
  const trackPts = state.stage2.tracks.filter(p => p.track_id === tid).sort((a,b) => a.t - b.t);
  if (trackPts.length === 0) return;

  const meta = state.summary && state.summary.tracks_meta.find(t => t.track_id === tid);
  if (meta) {
    const totDispEl = document.getElementById("single-tot-disp");
    if (totDispEl) totDispEl.textContent = `${meta.total_displacement} µm`;
    const netDispEl = document.getElementById("single-net-disp");
    if (netDispEl) netDispEl.textContent = `Net: ${meta.net_displacement} µm`;
    const avgVelEl = document.getElementById("single-avg-vel");
    if (avgVelEl) avgVelEl.textContent = `${meta.avg_velocity} µm/frame`;
    const framesEl = document.getElementById("single-frames-tracked");
    if (framesEl) framesEl.textContent = `${meta.frames} frames`;
    const spanEl = document.getElementById("single-frame-span");
    if (spanEl) spanEl.textContent = `t=${meta.start_t} to t=${meta.end_t}`;
  }

  // Update Time Steps Table
  const tableBody = document.querySelector("#single-track-table tbody");
  tableBody.innerHTML = "";
  trackPts.forEach(pt => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${pt.t}</td>
      <td>${pt.z.toFixed(1)}</td>
      <td>${pt.y.toFixed(1)}</td>
      <td>${pt.x.toFixed(1)}</td>
      <td>${pt.z_um.toFixed(1)}</td>
      <td>${pt.y_um.toFixed(1)}</td>
      <td>${pt.x_um.toFixed(1)}</td>
    `;
    tableBody.appendChild(tr);
  });

  // Plot Chart
  if (state.singleProj === "3d") {
    const traceLine = {
      type: 'scatter3d',
      mode: 'lines+markers',
      x: trackPts.map(p => p.x_um),
      y: trackPts.map(p => p.y_um),
      z: trackPts.map(p => p.z_um),
      line: { width: 6.5, color: '#00f2fe' },
      marker: { size: 4.5, color: trackPts.map(p => p.t), colorscale: 'Viridis', showscale: true },
      name: `Track #${tid}`,
      hoverinfo: 'text',
      hovertext: trackPts.map(p => `t=${p.t}<br>(${p.x_um.toFixed(1)}, ${p.y_um.toFixed(1)}, ${p.z_um.toFixed(1)}) µm`)
    };

    const traceStart = {
      type: 'scatter3d',
      mode: 'markers+text',
      x: [trackPts[0].x_um],
      y: [trackPts[0].y_um],
      z: [trackPts[0].z_um],
      marker: { size: 10, color: '#10b981', symbol: 'diamond' },
      text: ['🚀 START'],
      textposition: 'top center',
      textfont: { color: '#ffffff', size: 12 },
      name: 'Start'
    };

    const traceEnd = {
      type: 'scatter3d',
      mode: 'markers+text',
      x: [trackPts[trackPts.length - 1].x_um],
      y: [trackPts[trackPts.length - 1].y_um],
      z: [trackPts[trackPts.length - 1].z_um],
      marker: { size: 10, color: '#f43f5e', symbol: 'circle' },
      text: ['🏁 END'],
      textposition: 'top center',
      textfont: { color: '#ffffff', size: 12 },
      name: 'End'
    };

    const layout = {
      title: { text: `<b>3D Path for Cell #${tid}</b>`, font: { color: '#ffffff', size: 16 } },
      scene: {
        xaxis: { title: 'X (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
        yaxis: { title: 'Y (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
        zaxis: { title: 'Z Depth (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
        bgcolor: '#080c15'
      },
      plot_bgcolor: '#080c15',
      paper_bgcolor: '#080c15',
      font: { color: '#ffffff' },
      margin: { l: 10, r: 10, t: 40, b: 10 },
      height: 460
    };
    Plotly.newPlot('single-traj-chart', [traceLine, traceStart, traceEnd], layout, { responsive: true });
  } else {
    // 2D Projection
    const trace = {
      type: 'scatter',
      mode: 'lines+markers',
      x: trackPts.map(p => p.x_um),
      y: trackPts.map(p => p.y_um),
      line: { width: 4, color: '#00f2fe' },
      marker: { size: 6, color: trackPts.map(p => p.t), colorscale: 'Plasma' },
      name: `Track #${tid}`
    };
    const layout = {
      title: { text: `<b>2D Projection Trajectory for Cell #${tid}</b>`, font: { color: '#ffffff', size: 16 } },
      xaxis: { title: 'X Position (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)' },
      yaxis: { title: 'Y Position (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)' },
      plot_bgcolor: '#080c15',
      paper_bgcolor: '#080c15',
      font: { color: '#ffffff' },
      margin: { l: 20, r: 20, t: 40, b: 20 },
      height: 460
    };
    Plotly.newPlot('single-traj-chart', [trace], layout, { responsive: true });
  }
}

function renderCohortTrajectory() {
  if (!state.stage2 || !state.stage2.tracks || state.selectedCohort.length === 0) return;
  const cohort = state.selectedCohort;
  const traces = [];

  cohort.forEach((tid, idx) => {
    const pts = state.stage2.tracks.filter(p => p.track_id === tid).sort((a,b) => a.t - b.t);
    if (pts.length === 0) return;
    const color = COHORT_PALETTE[idx % COHORT_PALETTE.length];

    if (state.cohortProj === "3d") {
      traces.push({
        type: 'scatter3d',
        mode: 'lines+markers',
        x: pts.map(p => p.x_um),
        y: pts.map(p => p.y_um),
        z: pts.map(p => p.z_um),
        line: { width: 6.5, color: color },
        marker: { size: 4.5, color: color },
        name: `Cell #${tid}`,
        hoverinfo: 'text',
        hovertext: pts.map(p => `Cell #${tid} (t=${p.t})<br>(${p.x_um.toFixed(1)}, ${p.y_um.toFixed(1)}, ${p.z_um.toFixed(1)}) µm`)
      });
    } else {
      traces.push({
        type: 'scatter',
        mode: 'lines+markers',
        x: pts.map(p => p.x_um),
        y: pts.map(p => p.y_um),
        line: { width: 4, color: color },
        marker: { size: 6, color: color },
        name: `Cell #${tid}`
      });
    }
  });

  const layout = {
    title: { text: `<b>3D Trajectories for Selected Cohort (${cohort.length} Cells)</b>`, font: { color: '#ffffff', size: 16 } },
    scene: {
      xaxis: { title: 'X (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
      yaxis: { title: 'Y (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
      zaxis: { title: 'Z Depth (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)', backgroundcolor: 'rgba(15,23,42,0.6)' },
      bgcolor: '#080c15'
    },
    xaxis: { title: 'X Position (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)' },
    yaxis: { title: 'Y Position (µm)', color: '#ffffff', gridcolor: 'rgba(255,255,255,0.15)' },
    plot_bgcolor: '#080c15',
    paper_bgcolor: '#080c15',
    font: { color: '#ffffff' },
    margin: { l: 10, r: 10, t: 40, b: 10 },
    height: 480
  };

  Plotly.newPlot('cohort-traj-chart', traces, layout, { responsive: true });
}

// ============================================================================
// TAB 4: ANCESTRAL LINEAGE TREE
// ============================================================================
async function renderLineageTab() {
  const recId = state.specimenId;
  
  if (!state.lineage || state.lineage.recording_id !== recId) {
    const res = await fetch(`/api/specimen/${recId}/lineage`);
    state.lineage = await res.json();
  }

  const m = state.lineage.metrics || {};
  document.getElementById("lin-roots").textContent = m.total_roots || 0;
  document.getElementById("lin-divs").textContent = m.total_divisions || 0;
  document.getElementById("lin-depth").textContent = `${m.max_lineage_depth || 1} Generations`;
  
  const divRatio = m.total_tracks ? ((m.total_divisions / m.total_tracks) * 100).toFixed(1) : "0.0";
  document.getElementById("lin-ratio").textContent = `${divRatio}%`;

  // Plot Tree
  if (state.lineage.tree_plotly) {
    const fig = state.lineage.tree_plotly;
    fig.layout.plot_bgcolor = '#080c15';
    fig.layout.paper_bgcolor = '#080c15';
    fig.layout.font = { color: '#ffffff' };
    Plotly.newPlot('lineage-tree-chart', fig.data, fig.layout, { responsive: true });
  }

  // Populate lineage select
  const select = document.getElementById("lineage-cell-select");
  select.innerHTML = "";
  const rels = state.lineage.relationships || {};
  const cids = Object.keys(rels).map(Number).sort((a,b) => a - b);
  
  cids.forEach(cid => {
    const opt = document.createElement("option");
    opt.value = cid;
    const r = rels[cid];
    opt.textContent = `Cell ID #${cid} ${r.has_division ? '(🌿 Has Lineage / Mitosis)' : '(Simple Migration)'}`;
    select.appendChild(opt);
  });

  if (cids.length > 0) {
    if (state.selectedLineageCell === null || !rels[state.selectedLineageCell]) {
      state.selectedLineageCell = cids[0];
    }
    select.value = state.selectedLineageCell;
    renderLineageInspector();
  }

  // Setup download buttons
  document.getElementById("btn-dl-stage3").href = `/api/download/${recId}/stage3`;
  document.getElementById("btn-dl-geff").href = `/api/download/${recId}/geff`;
}

function renderLineageInspector() {
  if (!state.lineage || !state.lineage.relationships || state.selectedLineageCell === null) return;
  const r = state.lineage.relationships[state.selectedLineageCell];
  if (!r) return;

  document.getElementById("lin-card-cell-id").textContent = `#${r.track_id}`;
  document.getElementById("lin-role").textContent = r.role;
  document.getElementById("lin-parent").textContent = r.parent !== null ? `Cell #${r.parent}` : "None (Progenitor Origin)";
  document.getElementById("lin-siblings").textContent = r.siblings.length > 0 ? r.siblings.join(", ") : "None";
  
  document.getElementById("lin-has-div").textContent = r.has_division ? "Yes (Bifurcates)" : "No";
  document.getElementById("lin-daughters").textContent = r.daughters.length > 0 ? r.daughters.map(d=>`#${d}`).join(", ") : "None";
  document.getElementById("lin-granddaughters").textContent = r.grandchildren.length > 0 ? r.grandchildren.map(g=>`#${g}`).join(", ") : "None";
  
  document.getElementById("lin-lifespan").textContent = `${r.lifespan} frames (t=${r.start_t} → t=${r.end_t})`;
  document.getElementById("lin-speed").textContent = `${r.mean_speed_um} µm/frame`;
}

// ============================================================================
// TAB 5: GROUND TRUTH & ACCURACY (EVALUATION)
// ============================================================================
function renderAccuracyTab() {
  if (!state.summary || !state.summary.summary) return;
  updateTopMetricCards();
  const evalInfo = state.summary.summary.evaluation || {};

  const edgeJaccard = evalInfo.edge_jaccard !== undefined ? evalInfo.edge_jaccard.toFixed(4) : "0.0000";
  const divJaccard = evalInfo.division_jaccard !== undefined ? evalInfo.division_jaccard.toFixed(4) : "0.0000";
  const divTp = evalInfo.division_tp || 0;
  const divFn = evalInfo.division_fn || 0;
  const nGtNodes = evalInfo.n_gt_nodes || 0;

  document.getElementById("acc-edge-jaccard").textContent = edgeJaccard;
  document.getElementById("acc-div-jaccard").textContent = divJaccard;
  document.getElementById("acc-matched-mitoses").textContent = `${divTp} / ${divTp + divFn}`;
  document.getElementById("acc-gt-nodes").textContent = nGtNodes;

  // Breakdown Table
  const edgeTp = evalInfo.edge_tp || 0;
  const edgeFp = evalInfo.edge_fp || 0;
  const edgeFn = evalInfo.edge_fn || 0;
  const divFp = evalInfo.division_fp || 0;

  const edgePrec = (edgeTp + edgeFp > 0) ? (edgeTp / (edgeTp + edgeFp)).toFixed(3) : "0.000";
  const edgeRec = (edgeTp + edgeFn > 0) ? (edgeTp / (edgeTp + edgeFn)).toFixed(3) : "0.000";
  const divPrec = (divTp + divFp > 0) ? (divTp / (divTp + divFp)).toFixed(3) : "0.000";
  const divRec = (divTp + divFn > 0) ? (divTp / (divTp + divFn)).toFixed(3) : "0.000";

  const tableBody = document.querySelector("#accuracy-breakdown-table tbody");
  tableBody.innerHTML = `
    <tr>
      <td><b>Directed Migration Edges</b></td>
      <td><span class="badge-val emerald">${edgeTp}</span></td>
      <td><span class="badge-val">${edgeFp}</span></td>
      <td><span class="badge-val">${edgeFn}</span></td>
      <td>${edgePrec}</td>
      <td>${edgeRec}</td>
      <td><b style="color:var(--accent-cyan);">${edgeJaccard}</b></td>
    </tr>
    <tr>
      <td><b>Mitotic Division Events</b></td>
      <td><span class="badge-val emerald">${divTp}</span></td>
      <td><span class="badge-val">${divFp}</span></td>
      <td><span class="badge-val">${divFn}</span></td>
      <td>${divPrec}</td>
      <td>${divRec}</td>
      <td><b style="color:var(--accent-emerald);">${divJaccard}</b></td>
    </tr>
  `;
}

// ============================================================================
// APPLICATION MODES & PIPELINE EXECUTION
// ============================================================================
window.setAppMode = function(mode) {
  state.appMode = mode;
  const btnDemo = document.getElementById("btn-mode-demo");
  const btnPipe = document.getElementById("btn-mode-pipeline");
  const panel = document.getElementById("pipeline-execution-panel");
  const badge = document.getElementById("app-mode-badge");

  if (mode === "demo") {
    btnDemo.classList.add("active");
    btnPipe.classList.remove("active");
    panel.classList.remove("active");
    badge.textContent = "● Demo Mode Active (3 Precomputed Specimens)";
    badge.style.borderColor = "var(--accent-emerald)";
    badge.style.color = "var(--accent-emerald)";
    badge.style.background = "rgba(16, 185, 129, 0.15)";
  } else {
    btnPipe.classList.add("active");
    btnDemo.classList.remove("active");
    panel.classList.add("active");
    badge.textContent = "● Process New Recording Active";
    badge.style.borderColor = "var(--accent-cyan)";
    badge.style.color = "var(--accent-cyan)";
    badge.style.background = "rgba(0, 242, 254, 0.15)";
    loadAvailableRecordings();
  }

  // Update specimen dropdown strictly according to active mode
  renderSpecimenDropdown();
};

let availableRecordingsLoaded = false;
async function loadAvailableRecordings() {
  if (availableRecordingsLoaded) return;
  try {
    const res = await fetch("/api/available-recordings");
    const data = await res.json();
    const select = document.getElementById("pipeline-rec-select");
    select.innerHTML = "";
    
    (data.recordings || []).forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `${r.label}`;
      if (r.id === "44b6_0113de3b") {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
    availableRecordingsLoaded = true;
  } catch (err) {
    console.error("Failed to load available recordings:", err);
  }
}

window.switchPipelineSource = function(src) {
  state.pipelineSource = src;
  const btnLib = document.getElementById("btn-src-library");
  const btnUp = document.getElementById("btn-src-upload");
  const btnPath = document.getElementById("btn-src-path");

  const paneLib = document.getElementById("pipeline-source-library");
  const paneUp = document.getElementById("pipeline-source-upload");
  const panePath = document.getElementById("pipeline-source-path");

  if (btnLib) btnLib.classList.toggle("active", src === "library");
  if (btnUp) btnUp.classList.toggle("active", src === "upload");
  if (btnPath) btnPath.classList.toggle("active", src === "path");

  if (paneLib) paneLib.style.display = src === "library" ? "block" : "none";
  if (paneUp) paneUp.style.display = src === "upload" ? "block" : "none";
  if (panePath) panePath.style.display = src === "path" ? "block" : "none";
};

window.uploadCustomDataset = async function() {
  const fileInput = document.getElementById("pipeline-file-input");
  const statusEl = document.getElementById("pipeline-upload-status");
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--accent-rose);">⚠️ Please select a .zarr.zip or .tif file first.</span>`;
    return;
  }

  const file = fileInput.files[0];
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--accent-cyan);">⏳ Uploading & unpacking ${file.name}...</span>`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/pipeline/upload-dataset", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (res.ok && data.status === "success") {
      state.customRecordingId = data.recording_id;
      if (statusEl) statusEl.innerHTML = `✅ <span style="color:var(--accent-emerald); font-weight:600;">${data.message}</span>`;
      
      if (data.num_frames) {
        const slider = document.getElementById("pipeline-range-slider");
        const tEnd = document.getElementById("pipeline-t-end");
        if (slider) slider.max = data.num_frames - 1;
        if (tEnd) tEnd.max = data.num_frames - 1;
      }
    } else {
      if (statusEl) statusEl.innerHTML = `❌ <span style="color:var(--accent-rose);">${data.message || data.error || "Upload failed."}</span>`;
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `❌ <span style="color:var(--accent-rose);">${err.message}</span>`;
  }
};

window.loadCustomDatasetPath = async function() {
  const pathInput = document.getElementById("pipeline-path-input");
  const statusEl = document.getElementById("pipeline-path-status");
  const folderPath = pathInput ? pathInput.value.trim() : "";
  if (!folderPath) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--accent-rose);">⚠️ Please enter a folder path to a .zarr dataset.</span>`;
    return;
  }

  if (statusEl) statusEl.innerHTML = `<span style="color:var(--accent-cyan);">⏳ Verifying Zarr at ${folderPath}...</span>`;

  try {
    const res = await fetch("/api/pipeline/load-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_path: folderPath }),
    });
    const data = await res.json();
    if (res.ok && data.status === "success") {
      state.customRecordingId = data.recording_id;
      if (statusEl) statusEl.innerHTML = `✅ <span style="color:var(--accent-emerald); font-weight:600;">${data.message}</span>`;
      
      if (data.num_frames) {
        const slider = document.getElementById("pipeline-range-slider");
        const tEnd = document.getElementById("pipeline-t-end");
        if (slider) slider.max = data.num_frames - 1;
        if (tEnd) tEnd.max = data.num_frames - 1;
      }
    } else {
      if (statusEl) statusEl.innerHTML = `❌ <span style="color:var(--accent-rose);">${data.message || data.error || "Failed to load path."}</span>`;
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `❌ <span style="color:var(--accent-rose);">${err.message}</span>`;
  }
};

window.triggerPipelineRun = async function() {
  let recId;
  if (state.pipelineSource === "upload" || state.pipelineSource === "path") {
    if (!state.customRecordingId) {
      alert("Please load your custom dataset first using the 'Load' button!");
      return;
    }
    recId = state.customRecordingId;
  } else {
    const recSelect = document.getElementById("pipeline-rec-select");
    recId = recSelect ? recSelect.value : "";
    if (!recId) {
      alert("Please select a target recording!");
      return;
    }
  }

  const tStart = parseInt(document.getElementById("pipeline-t-start").value) || 0;
  const tEnd = parseInt(document.getElementById("pipeline-t-end").value) || 20;
  const useGt = document.getElementById("pipeline-use-gt").checked;

  const btn = document.getElementById("btn-run-pipeline");
  btn.disabled = true;
  btn.textContent = "⏳ Running Pipeline...";

  const progressSection = document.getElementById("pipeline-progress-section");
  const progressFill = document.getElementById("pipeline-progress-fill");
  const statusText = document.getElementById("pipeline-status-text");
  const pctText = document.getElementById("pipeline-pct-text");
  const consoleLog = document.getElementById("pipeline-console-log");

  progressSection.style.display = "block";
  progressFill.style.width = "5%";
  statusText.textContent = `Starting pipeline for ${recId}...`;
  pctText.textContent = "5%";
  consoleLog.innerHTML = `<div>[${new Date().toLocaleTimeString()}] Initializing V.I.T.A.L pipeline for ${recId}...</div>`;

  try {
    const res = await fetch("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recording_id: recId,
        time_start: tStart,
        time_end: tEnd,
        use_gt_detections: useGt,
      }),
    });
    const initData = await res.json();
    const taskId = initData.task_id;

    // Poll task progress every 700ms
    const pollInterval = setInterval(async () => {
      try {
        const pollRes = await fetch(`/api/pipeline/status/${taskId}`);
        const taskInfo = await pollRes.json();

        const pct = Math.round((taskInfo.progress || 0) * 100);
        progressFill.style.width = `${pct}%`;
        pctText.textContent = `${pct}%`;
        statusText.textContent = taskInfo.message || "Processing...";

        if (taskInfo.message) {
          const line = `<div>[${new Date().toLocaleTimeString()}] ${taskInfo.message}</div>`;
          if (!consoleLog.innerHTML.includes(taskInfo.message)) {
            consoleLog.innerHTML += line;
            consoleLog.scrollTop = consoleLog.scrollHeight;
          }
        }

        if (taskInfo.status === "completed") {
          clearInterval(pollInterval);
          btn.disabled = false;
          btn.textContent = "🚀 Run Live Pipeline";
          progressFill.style.width = "100%";
          pctText.textContent = "100%";
          statusText.innerHTML = `✅ <span style="color:var(--accent-emerald);">Pipeline Finished in ${taskInfo.elapsed_seconds || 1}s!</span>`;

          // Refresh processed runs from backend
          try {
            const availRes = await fetch("/api/available-recordings");
            const availData = await availRes.json();
            state.processedRuns = availData.processed_runs || [];
          } catch (e) {
            if (!state.processedRuns.some(r => r.id === recId)) {
              state.processedRuns.unshift({ id: recId, detections: (taskInfo.summary && taskInfo.summary.total_detections) || 0, divisions: (taskInfo.summary && taskInfo.summary.total_divisions) || 0 });
            }
          }

          state.specimenId = recId;
          renderSpecimenDropdown();
        } else if (taskInfo.status === "failed") {
          clearInterval(pollInterval);
          btn.disabled = false;
          btn.textContent = "🚀 Run Live Pipeline";
          statusText.innerHTML = `❌ <span style="color:var(--accent-rose);">${taskInfo.message}</span>`;
        }
      } catch (pollErr) {
        console.error("Poll error:", pollErr);
      }
    }, 700);

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "🚀 Run Live Pipeline";
    alert(`Failed to start pipeline: ${err.message}`);
  }
};
