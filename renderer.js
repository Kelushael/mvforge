'use strict';

const { ipcRenderer } = require('electron');
const MusicTempo       = require('music-tempo');
const path             = require('path');
const fs               = require('fs');

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    filePath:    null,
    audioBuffer: null,
    bpm:         null,
    duration:    null,
    grid:        null,
    lyricsGrid:  [],
    pythonCmd:   null,
    clips:       [],   // [{name, path, duration}]
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const el = {
    dropSection:    $('dropSection'),
    dropZone:       $('dropZone'),
    mainContent:    $('mainContent'),
    browseBtn:      $('browseBtn'),
    bpmInput:       $('bpmInput'),
    redetectBtn:    $('redetectBtn'),
    trackName:      $('trackName'),
    trackDuration:  $('trackDuration'),
    transcribeBtn:  $('transcribeBtn'),
    manualBtn:      $('manualBtn'),
    statusBar:      $('statusBar'),
    statusText:     $('statusText'),
    manualModal:    $('manualModal'),
    lyricsInput:    $('lyricsInput'),
    manualCancelBtn:$('manualCancelBtn'),
    manualApplyBtn: $('manualApplyBtn'),
    lyricsSection:  $('lyricsSection'),
    lyricsGrid:     $('lyricsGrid'),
    wordCount:      $('wordCount'),
    exportBar:      $('exportBar'),
    exportJson:        $('exportJson'),
    exportLrc:         $('exportLrc'),
    resetBtn:          $('resetBtn'),
    headerStatus:      $('headerStatus'),
    waveformCanvas:    $('waveformCanvas'),
    timelineCanvas:    $('timelineCanvas'),
    waveformScroll:    $('waveformScroll'),
    timelineScroll:    $('timelineScroll'),
    // Footage tracker
    footageSection:    $('footageSection'),
    footageFill:       $('footageFill'),
    footagePct:        $('footagePct'),
    footageAdded:      $('footageAdded'),
    footageRemaining:  $('footageRemaining'),
    footageTotal:      $('footageTotal'),
    footageClearBtn:   $('footageClearBtn'),
    clipDrop:          $('clipDrop'),
    clipList:          $('clipList'),
};

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
    bg:       '#0a0a0a',
    surface:  '#141414',
    border:   '#262626',
    text:     '#e2e2e2',
    muted:    '#444',
    muted2:   '#666',
    downbeat: '#ff4757',
    half:     '#ff7f50',
    quarter:  '#ffd32a',
    offbeat:  '#2ed573',
    waveform: '#1e3a5f',
    ruler:    '#181818',
};

// ── Grid Math ─────────────────────────────────────────────────────────────────
function calcGrid(bpm) {
    const q = 60.0 / bpm;
    return {
        eighth_note:    q / 2,
        quarter_note:   q,
        half_note:      q * 2,
        downbeat_whole: q * 4,
    };
}

function snapToGrid(t, eighth) {
    return Math.round(t / eighth) * eighth;
}

function classifyBeat(snapped, grid) {
    const { quarter_note: q, half_note: h, downbeat_whole: db } = grid;
    const eps = 1e-4;
    const near = (v, mod) => {
        const r = ((v % mod) + mod) % mod;
        return r < eps || (mod - r) < eps;
    };
    if (near(snapped, db)) return 'downbeat';
    if (near(snapped, h))  return 'half';
    if (near(snapped, q))  return 'quarter';
    return 'offbeat';
}

function updateGridStats() {
    const { bpm, duration, grid } = state;
    if (!bpm || !duration || !grid) return;

    const fmt   = (s) => s.toFixed(4) + 's';
    const cuts  = (iv) => Math.floor(duration / iv).toLocaleString();

    $('statDownbeat').textContent     = fmt(grid.downbeat_whole);
    $('statDownbeatCount').textContent = cuts(grid.downbeat_whole) + ' cuts';
    $('statHalf').textContent          = fmt(grid.half_note);
    $('statHalfCount').textContent     = cuts(grid.half_note) + ' cuts';
    $('statQuarter').textContent       = fmt(grid.quarter_note);
    $('statQuarterCount').textContent  = cuts(grid.quarter_note) + ' cuts';
    $('statOffbeat').textContent       = fmt(grid.eighth_note);
    $('statOffbeatCount').textContent  = cuts(grid.eighth_note) + ' cuts';
}

// ── Audio Loading ─────────────────────────────────────────────────────────────
async function loadAudioFile(filePath) {
    setStatus('Loading audio...');
    const audioCtx  = new AudioContext();
    const nodeBuf   = fs.readFileSync(filePath);
    const arrayBuf  = nodeBuf.buffer.slice(
        nodeBuf.byteOffset,
        nodeBuf.byteOffset + nodeBuf.byteLength
    );

    const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
    state.audioBuffer = audioBuffer;
    state.duration    = audioBuffer.duration;
    state.filePath    = filePath;

    const m = Math.floor(audioBuffer.duration / 60);
    const s = Math.floor(audioBuffer.duration % 60);
    el.trackName.textContent     = path.basename(filePath);
    el.trackDuration.textContent = `${m}:${s.toString().padStart(2, '0')}`;

    return audioBuffer;
}

async function detectBPM(audioBuffer) {
    setStatus('Detecting BPM...');
    try {
        const channelData = audioBuffer.getChannelData(0);
        const mt = new MusicTempo(channelData);
        const bpm = mt.tempo;
        if (bpm >= 40 && bpm <= 280) return Math.round(bpm * 10) / 10;
    } catch (e) {
        console.warn('music-tempo error:', e);
    }
    return null;
}

// ── Canvas: Pixel-per-beat layout ─────────────────────────────────────────────
const PX_PER_BEAT = 30; // pixels per quarter note at 1x zoom

function canvasWidth() {
    const { bpm, duration } = state;
    if (!bpm || !duration) return 800;
    return Math.ceil((duration / (60 / bpm)) * PX_PER_BEAT) + 60;
}

function timeToX(t) {
    return (t / state.duration) * canvasWidth();
}

// ── Canvas: Waveform ──────────────────────────────────────────────────────────
function drawWaveform() {
    const { audioBuffer } = state;
    if (!audioBuffer) return;

    const dpr      = window.devicePixelRatio || 1;
    const dispW    = canvasWidth();
    const dispH    = 56;
    const cnv      = el.waveformCanvas;

    cnv.width        = dispW * dpr;
    cnv.height       = dispH * dpr;
    cnv.style.width  = dispW + 'px';
    cnv.style.height = dispH + 'px';

    const ctx  = cnv.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, dispW, dispH);

    const data  = audioBuffer.getChannelData(0);
    const step  = Math.max(1, Math.floor(data.length / dispW));
    const mid   = dispH / 2;

    ctx.strokeStyle = C.waveform;
    ctx.lineWidth   = 1;

    for (let i = 0; i < dispW; i++) {
        let mn = 0, mx = 0;
        for (let j = 0; j < step; j++) {
            const s = data[i * step + j] || 0;
            if (s < mn) mn = s;
            if (s > mx) mx = s;
        }
        ctx.beginPath();
        ctx.moveTo(i + 0.5, mid + mn * mid * 0.95);
        ctx.lineTo(i + 0.5, mid + mx * mid * 0.95);
        ctx.stroke();
    }

    // Center line
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(dispW, mid);
    ctx.stroke();
}

// ── Canvas: Beat Grid Timeline ────────────────────────────────────────────────
function drawTimeline() {
    const { bpm, duration, grid, lyricsGrid } = state;
    if (!bpm || !duration) return;

    const dpr   = window.devicePixelRatio || 1;
    const dispW = canvasWidth();
    const dispH = 90;
    const cnv   = el.timelineCanvas;

    cnv.width        = dispW * dpr;
    cnv.height       = dispH * dpr;
    cnv.style.width  = dispW + 'px';
    cnv.style.height = dispH + 'px';

    const ctx = cnv.getContext('2d');
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, dispW, dispH);

    const RULER_H = 18;
    const GRID_H  = dispH - RULER_H;

    // Ruler background
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, dispW, RULER_H);

    // Time ruler ticks + labels
    ctx.fillStyle  = C.muted2;
    ctx.font       = '9px monospace';
    ctx.textAlign  = 'left';

    const secStep = duration > 120 ? 10 : duration > 60 ? 5 : 2;
    for (let sec = 0; sec <= duration; sec += secStep) {
        const x = timeToX(sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        ctx.fillStyle = C.border;
        ctx.fillRect(x, 0, 1, RULER_H);
        ctx.fillStyle = C.muted2;
        ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, x + 3, RULER_H - 5);
    }

    // Beat grid lines — draw finest first so coarser overdraw
    const drawGrid = (interval, color, heightFraction, opacity, width) => {
        ctx.globalAlpha = opacity;
        ctx.strokeStyle = color;
        ctx.lineWidth   = width;
        for (let t = 0; t <= duration + interval / 2; t += interval) {
            const x = timeToX(t);
            const lineH = GRID_H * heightFraction;
            ctx.beginPath();
            ctx.moveTo(x, RULER_H + GRID_H - lineH);
            ctx.lineTo(x, dispH);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    };

    drawGrid(grid.eighth_note,    C.offbeat,  0.18, 0.30, 0.5);
    drawGrid(grid.quarter_note,   C.quarter,  0.35, 0.45, 0.7);
    drawGrid(grid.half_note,      C.half,     0.58, 0.60, 1.0);
    drawGrid(grid.downbeat_whole, C.downbeat, 1.00, 0.90, 1.5);

    // Measure numbers on downbeats
    ctx.fillStyle = C.downbeat + 'aa';
    ctx.font      = '8px monospace';
    ctx.textAlign = 'center';
    let measure = 1;
    for (let t = 0; t <= duration; t += grid.downbeat_whole) {
        const x = timeToX(t);
        ctx.fillText(measure, x, RULER_H + 10);
        measure++;
    }

    // Word markers
    if (lyricsGrid.length) {
        const color = { downbeat: C.downbeat, half: C.half, quarter: C.quarter, offbeat: C.offbeat };

        ctx.font      = '8px monospace';
        ctx.textAlign = 'left';

        for (const entry of lyricsGrid) {
            const x  = timeToX(entry.snapped_start);
            const cl = color[entry.type];

            // Dot
            ctx.fillStyle = cl;
            ctx.beginPath();
            ctx.arc(x, RULER_H + 4, 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Rotated label
            ctx.save();
            ctx.translate(x + 3, dispH - 3);
            ctx.rotate(-Math.PI / 2);
            ctx.fillStyle = cl + 'cc';
            ctx.textAlign = 'left';
            ctx.fillText(entry.word, 0, 0);
            ctx.restore();
        }
    }
}

// ── Sync scroll between waveform and timeline ─────────────────────────────────
function syncScroll(src, dst) {
    dst.scrollLeft = src.scrollLeft;
}

el.waveformScroll.addEventListener('scroll', () => syncScroll(el.waveformScroll, el.timelineScroll));
el.timelineScroll.addEventListener('scroll', () => syncScroll(el.timelineScroll, el.waveformScroll));

// ── Lyrics Grid UI ────────────────────────────────────────────────────────────
function renderLyricsGrid() {
    el.lyricsGrid.innerHTML = '';

    for (const entry of state.lyricsGrid) {
        const chip = document.createElement('div');
        chip.className = `word-chip ${entry.type}`;
        chip.title     = `${entry.snapped_start.toFixed(4)}s · ${entry.type}`;

        const wordEl   = document.createElement('div');
        wordEl.className = 'chip-word';
        wordEl.textContent = entry.word;

        const timeEl   = document.createElement('div');
        timeEl.className = 'chip-time';
        timeEl.textContent = entry.snapped_start.toFixed(3) + 's';

        chip.appendChild(wordEl);
        chip.appendChild(timeEl);
        el.lyricsGrid.appendChild(chip);
    }

    el.wordCount.textContent = `· ${state.lyricsGrid.length} words`;
    el.lyricsSection.classList.remove('hidden');
    el.exportBar.classList.remove('hidden');
}

// ── Process raw words → grid entries ─────────────────────────────────────────
function processWords(words) {
    // words: [{word, start}] or [{word, raw_start}]
    const { grid } = state;
    state.lyricsGrid = words.map((w) => {
        const raw     = parseFloat(w.start ?? w.raw_start ?? 0);
        const snapped = snapToGrid(raw, grid.eighth_note);
        return {
            word:          w.word,
            raw_start:     parseFloat(raw.toFixed(4)),
            snapped_start: parseFloat(snapped.toFixed(4)),
            type:          classifyBeat(snapped, grid),
        };
    });

    renderLyricsGrid();
    drawTimeline(); // Re-draw with word markers
}

function distributeManualLyrics(text) {
    const words      = text.trim().split(/\s+/).filter(Boolean);
    const { duration, grid } = state;
    const totalBeats = Math.floor(duration / grid.quarter_note);
    const step       = Math.max(1, Math.floor(totalBeats / words.length));

    processWords(words.map((word, i) => ({
        word,
        start: i * step * grid.quarter_note,
    })));
}

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(msg) {
    if (msg) {
        el.statusBar.classList.remove('hidden');
        el.statusText.textContent    = msg;
        el.headerStatus.textContent  = msg;
    } else {
        el.statusBar.classList.add('hidden');
        el.headerStatus.textContent  = '';
    }
}

// ── BPM apply ────────────────────────────────────────────────────────────────
function applyBPM(bpm) {
    if (!bpm || bpm <= 0) return;
    state.bpm    = bpm;
    state.grid   = calcGrid(bpm);
    el.bpmInput.value = bpm;
    updateGridStats();
    drawTimeline();

    // Re-snap existing lyrics to new grid
    if (state.lyricsGrid.length) {
        processWords(state.lyricsGrid.map((e) => ({ word: e.word, start: e.raw_start })));
    }
}

// ── Main file handler ─────────────────────────────────────────────────────────
async function handleFile(filePath) {
    if (!filePath) return;

    el.dropSection.classList.add('hidden');
    el.mainContent.classList.remove('hidden');

    try {
        const audioBuffer = await loadAudioFile(filePath);
        const detected    = await detectBPM(audioBuffer);

        applyBPM(detected || 120);
        drawWaveform();
        drawTimeline();
        setStatus(null);

        if (!detected) {
            el.bpmInput.focus();
            el.bpmInput.select();
            setStatus('BPM detection failed — enter BPM manually');
        }
    } catch (err) {
        setStatus('Error: ' + err.message);
        console.error(err);
    }
}

// ── Transcription ─────────────────────────────────────────────────────────────
async function handleTranscribe() {
    if (!state.filePath || !state.pythonCmd) return;

    el.transcribeBtn.disabled = true;
    setStatus('Loading Whisper model...');

    const onProgress = (_, msg) => {
        if (msg) setStatus(msg.slice(0, 100));
    };
    ipcRenderer.on('transcribe-progress', onProgress);

    const result = await ipcRenderer.invoke('transcribe', {
        audioPath:  state.filePath,
        pythonCmd:  state.pythonCmd,
        modelSize:  'base',
    });

    ipcRenderer.removeListener('transcribe-progress', onProgress);
    el.transcribeBtn.disabled = false;

    if (!result.ok) {
        setStatus('Transcription failed: ' + result.error);
        return;
    }

    setStatus(null);
    processWords(result.data.words);
}

// ── Export ────────────────────────────────────────────────────────────────────
function buildJSON() {
    const { bpm, duration, grid, lyricsGrid, filePath } = state;
    return JSON.stringify({
        metadata: {
            track:            path.basename(filePath),
            bpm:              Math.round(bpm * 100) / 100,
            duration_seconds: Math.round(duration * 100) / 100,
            grid_intervals: {
                quarter_note:   parseFloat(grid.quarter_note.toFixed(6)),
                eighth_note:    parseFloat(grid.eighth_note.toFixed(6)),
                half_note:      parseFloat(grid.half_note.toFixed(6)),
                downbeat_whole: parseFloat(grid.downbeat_whole.toFixed(6)),
            },
        },
        lyrics_grid: lyricsGrid,
    }, null, 4);
}

function buildLRC() {
    return state.lyricsGrid.map((e) => {
        const t = e.snapped_start;
        const m = Math.floor(t / 60);
        const s = t % 60;
        return `[${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}] ${e.word}`;
    }).join('\n');
}

async function handleExportJSON() {
    const base  = path.basename(state.filePath, path.extname(state.filePath));
    const saved = await ipcRenderer.invoke('save-file', {
        content: buildJSON(), defaultName: base + '_grid.json', ext: 'json',
    });
    if (saved) el.headerStatus.textContent = 'Saved: ' + path.basename(saved);
}

async function handleExportLRC() {
    const base  = path.basename(state.filePath, path.extname(state.filePath));
    const saved = await ipcRenderer.invoke('save-file', {
        content: buildLRC(), defaultName: base + '.lrc', ext: 'lrc',
    });
    if (saved) el.headerStatus.textContent = 'Saved: ' + path.basename(saved);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetApp() {
    Object.assign(state, {
        filePath: null, audioBuffer: null, bpm: null,
        duration: null, grid: null, lyricsGrid: [], clips: [],
    });
    el.mainContent.classList.add('hidden');
    el.dropSection.classList.remove('hidden');
    el.lyricsSection.classList.add('hidden');
    el.exportBar.classList.add('hidden');
    el.lyricsGrid.innerHTML = '';
    el.headerStatus.textContent = '';
    setStatus(null);
}

// ── Init: find Python ─────────────────────────────────────────────────────────
async function initPython() {
    state.pythonCmd = await ipcRenderer.invoke('find-python');
    if (!state.pythonCmd) {
        el.transcribeBtn.disabled = true;
        el.transcribeBtn.title    = 'Python not found — use Paste Lyrics';
    }
}

// ── Footage Tracker ───────────────────────────────────────────────────────────

function fmtSec(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Get duration from any media file via hidden HTML5 element
function getMediaDuration(filePath) {
    return new Promise((resolve) => {
        const safeUrl = `file://${filePath.replace(/\\/g, '/')}`;
        const vid = document.createElement('video');
        vid.preload = 'metadata';
        vid.onloadedmetadata = () => resolve(isFinite(vid.duration) ? vid.duration : null);
        vid.onerror = () => {
            // Fallback: try as audio
            const aud = document.createElement('audio');
            aud.preload = 'metadata';
            aud.onloadedmetadata = () => resolve(isFinite(aud.duration) ? aud.duration : null);
            aud.onerror = () => resolve(null);
            aud.src = safeUrl;
        };
        vid.src = safeUrl;
    });
}

async function addClips(filePaths) {
    for (const fp of filePaths) {
        const dur = await getMediaDuration(fp);
        if (dur && dur > 0) {
            state.clips.push({ name: path.basename(fp), path: fp, duration: dur });
        }
    }
    updateFootageTracker();
}

function removeClip(index) {
    state.clips.splice(index, 1);
    updateFootageTracker();
}

function clearClips() {
    state.clips = [];
    updateFootageTracker();
}

function updateFootageTracker() {
    const songDur   = state.duration || 0;
    const totalClip = state.clips.reduce((s, c) => s + c.duration, 0);
    const rawPct    = songDur > 0 ? (totalClip / songDur) * 100 : 0;
    const displayPct = Math.min(rawPct, 100);
    const remaining = Math.max(songDur - totalClip, 0);
    const done      = rawPct >= 100;
    const over      = rawPct > 100;

    // Fill bar
    el.footageFill.style.width = displayPct + '%';
    el.footageFill.className   = 'footage-fill' + (over ? ' over' : done ? ' done' : '');

    // Percent label
    el.footagePct.textContent = Math.round(rawPct) + '%';
    el.footagePct.className   = 'footage-pct' + (over ? ' over' : done ? ' done' : '');

    // Stats
    el.footageAdded.textContent     = fmtSec(totalClip);
    el.footageTotal.textContent     = songDur > 0 ? fmtSec(songDur) : '—';
    el.footageRemaining.textContent = done ? '✓ FULL' : songDur > 0 ? fmtSec(remaining) : '—';
    el.footageRemaining.className   = done ? 'footage-remaining done' : 'footage-remaining';

    renderClipList(songDur);
}

function renderClipList(songDur) {
    el.clipList.innerHTML = '';

    for (let i = 0; i < state.clips.length; i++) {
        const clip    = state.clips[i];
        const clipPct = songDur > 0 ? Math.min((clip.duration / songDur) * 100, 100) : 0;

        const row = document.createElement('div');
        row.className = 'clip-row';
        row.innerHTML = `
            <div class="clip-name" title="${clip.name}">${clip.name}</div>
            <div class="clip-dur">${fmtSec(clip.duration)}</div>
            <div class="clip-bar"><div class="clip-bar-fill" style="width:${clipPct.toFixed(1)}%"></div></div>
            <button class="clip-remove" data-i="${i}">✕</button>
        `;
        el.clipList.appendChild(row);
    }

    el.clipList.querySelectorAll('.clip-remove').forEach((btn) => {
        btn.addEventListener('click', () => removeClip(parseInt(btn.dataset.i)));
    });
}

// ── Event Listeners ───────────────────────────────────────────────────────────

// Drag & drop
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop',     (e) => e.preventDefault());

el.dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
el.dropZone.addEventListener('dragleave', ()  => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file.path);
});
el.dropZone.addEventListener('click', async () => {
    const fp = await ipcRenderer.invoke('open-file');
    if (fp) handleFile(fp);
});
el.browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const fp = await ipcRenderer.invoke('open-file');
    if (fp) handleFile(fp);
});

// BPM controls
el.bpmInput.addEventListener('change', () => applyBPM(parseFloat(el.bpmInput.value)));
el.bpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyBPM(parseFloat(el.bpmInput.value));
});
el.redetectBtn.addEventListener('click', async () => {
    if (!state.audioBuffer) return;
    el.redetectBtn.textContent = '...';
    const bpm = await detectBPM(state.audioBuffer);
    el.redetectBtn.textContent = '↺';
    if (bpm) applyBPM(bpm);
    setStatus(null);
});

// Transcription
el.transcribeBtn.addEventListener('click', handleTranscribe);

// Manual lyrics
el.manualBtn.addEventListener('click',       () => el.manualModal.classList.remove('hidden'));
el.manualCancelBtn.addEventListener('click', () => el.manualModal.classList.add('hidden'));
el.manualApplyBtn.addEventListener('click',  () => {
    const text = el.lyricsInput.value.trim();
    if (text) distributeManualLyrics(text);
    el.manualModal.classList.add('hidden');
});
el.manualModal.addEventListener('click', (e) => {
    if (e.target === el.manualModal) el.manualModal.classList.add('hidden');
});

// Export
el.exportJson.addEventListener('click', handleExportJSON);
el.exportLrc.addEventListener('click',  handleExportLRC);

// Reset
el.resetBtn.addEventListener('click', resetApp);

// ── Footage Tracker Events ────────────────────────────────────────────────────

el.clipDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.clipDrop.classList.add('drag-over');
});
el.clipDrop.addEventListener('dragleave', () => el.clipDrop.classList.remove('drag-over'));
el.clipDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.clipDrop.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
    if (files.length) addClips(files);
});
el.clipDrop.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('open-clips');
    if (result && result.length) addClips(result);
});

el.footageClearBtn.addEventListener('click', clearClips);

// ── Boot ──────────────────────────────────────────────────────────────────────
initPython();
