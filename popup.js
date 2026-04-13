// ============================================================
// PawPath — popup.js
// Entry point: loads state from chrome.storage.local, renders
// the planner grid, sidebar, and mascot, and wires up drag-and-drop.
// ============================================================

// ---------- Constants ----------

// Quarter names shown in the planner (6 starting from current)
const QUARTER_ORDER = ['Autumn', 'Winter', 'Spring', 'Summer'];

// Difficulty thresholds for card border color
const DIFF_GREEN = 70;  // >= 70% 4.0 rate → green
const DIFF_AMBER = 40;  // 40-69%          → amber
                         // < 40%           → red

// Mascot states and their speech bubbles
const MASCOT_STATES = {
  dead:     { img: 'dead.png',     msg: 'I... I can\'t even... 💀' },
  stunned:  { img: 'stunned.png',  msg: 'TWENTY credits?! 😵' },
  cry:      { img: 'cry.png',      msg: 'Please, drop something... 😭' },
  sad:      { img: 'sad.png',      msg: 'This looks rough... 😢' },
  tired:    { img: 'tired.png',    msg: 'Heavy quarter ahead... 😮‍💨' },
  confused: { img: 'confused.png', msg: 'Something seems off! 🤔' },
  cool:     { img: 'cool.png',     msg: 'Easy quarter, let\'s goooo 😎' },
  smile:    { img: 'smile.png',    msg: 'I believe in you! 🐾' },
};

// Storage keys
const KEY_UNPLANNED  = 'unplannedCourses';   // [{courseCode, courseName, credits}]
const KEY_DIFFICULTY = 'difficultyData';      // {courseCode: percentage}
const KEY_PLANNER    = 'plannerState';        // {quarterId: [courseCode, ...]}
const KEY_SYNC       = 'syncStatus';          // {myplan, dawgpath, timeschedule}

// ---------- State (in-memory mirror of storage) ----------
let state = {
  unplanned:   [],    // array of course objects not yet assigned
  difficulty:  {},    // courseCode → 4.0% number
  planner:     {},    // quarterId  → [courseCode, ...]
  allCourses:  {},    // courseCode → {courseCode, courseName, credits}
  syncStatus:  { myplan: false, dawgpath: false, timeschedule: false },
  quarters:    [],    // [{id, label, year}] — 6 quarters from now
};

// Track the dragged item so drop handlers know what's moving
let dragInfo = null;  // { courseCode, sourceType: 'sidebar'|'quarter', sourceQuarter: id|null }

// ---------- Initialisation ----------

document.addEventListener('DOMContentLoaded', async () => {
  await loadFromStorage();
  state.quarters = buildQuarterList();
  render();
  wireSettingsButton();
});

// Load all relevant keys from chrome.storage.local
async function loadFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [KEY_UNPLANNED, KEY_DIFFICULTY, KEY_PLANNER, KEY_SYNC],
      (result) => {
        const unplanned  = result[KEY_UNPLANNED]  || [];
        state.difficulty = result[KEY_DIFFICULTY] || {};
        state.planner    = result[KEY_PLANNER]    || {};
        state.syncStatus = result[KEY_SYNC]        || { myplan: false, dawgpath: false, timeschedule: false };

        // Build a master lookup of all known courses
        state.allCourses = {};
        unplanned.forEach(c => { state.allCourses[c.courseCode] = c; });

        // Also register any courses that exist only in planner quarters
        Object.values(state.planner).flat().forEach(code => {
          if (!state.allCourses[code]) {
            state.allCourses[code] = { courseCode: code, courseName: '', credits: 0 };
          }
        });

        // Unplanned = courses from storage not placed in any quarter
        const plannedCodes = new Set(Object.values(state.planner).flat());
        state.unplanned = unplanned.filter(c => !plannedCodes.has(c.courseCode));

        resolve();
      }
    );
  });
}

// Save current state back to chrome.storage.local
function saveToStorage() {
  const unplannedFull = state.unplanned.map(c => state.allCourses[c.courseCode] || c);
  chrome.storage.local.set({
    [KEY_UNPLANNED]: [
      ...unplannedFull,
      // also save planned courses so we have full metadata
      ...Object.values(state.planner).flat().map(code => state.allCourses[code]).filter(Boolean),
    ],
    [KEY_PLANNER]: state.planner,
  });
}

// ---------- Quarter Utilities ----------

// Returns the current UW quarter based on today's date
function getCurrentQuarter() {
  const now   = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year  = now.getFullYear();

  let quarter;
  if (month >= 9 && month <= 12)       quarter = 'Autumn';
  else if (month >= 1 && month <= 3)   quarter = 'Winter';
  else if (month >= 4 && month <= 6)   quarter = 'Spring';
  else                                  quarter = 'Summer';

  return { quarter, year };
}

// Build an ordered list of 6 quarters starting from the current one
function buildQuarterList() {
  const { quarter: startQ, year: startY } = getCurrentQuarter();
  const quarters = [];
  let qIdx = QUARTER_ORDER.indexOf(startQ);
  let y    = startY;

  for (let i = 0; i < 6; i++) {
    const q = QUARTER_ORDER[qIdx];
    quarters.push({ id: `${q}-${y}`, label: `${q} ${y}`, year: y });
    qIdx++;
    if (qIdx >= QUARTER_ORDER.length) { qIdx = 0; y++; }
  }
  return quarters;
}

// ---------- Difficulty Helpers ----------

function getDifficultyClass(courseCode) {
  const pct = state.difficulty[courseCode];
  if (pct === undefined || pct === null) return 'difficulty-green'; // unknown → neutral green
  if (pct >= DIFF_GREEN) return 'difficulty-green';
  if (pct >= DIFF_AMBER) return 'difficulty-amber';
  return 'difficulty-red';
}

function getDifficultyPct(courseCode) {
  const pct = state.difficulty[courseCode];
  if (pct === undefined || pct === null) return null;
  return Math.round(pct);
}

// ---------- Render: Top-Level ----------

function render() {
  renderSyncPills();

  // If MyPlan hasn't been synced yet and no planner data, show empty state
  const hasAnyData = state.unplanned.length > 0 ||
    Object.values(state.planner).some(arr => arr.length > 0);

  if (!hasAnyData && !state.syncStatus.myplan) {
    renderEmptyState();
    updateMascot(null); // null → confused state
    return;
  }

  renderSidebar();
  renderGrid();
  updateMascotFromGrid();
}

// ---------- Render: Sync Pills ----------

function renderSyncPills() {
  const pills = [
    { id: 'pill-myplan',       key: 'myplan'       },
    { id: 'pill-dawgpath',     key: 'dawgpath'     },
    { id: 'pill-timeschedule', key: 'timeschedule' },
  ];

  pills.forEach(({ id, key }) => {
    const el  = document.getElementById(id);
    const paw = el.querySelector('.pill-paw');
    if (state.syncStatus[key]) {
      el.classList.add('synced');
      paw.textContent = '🐾';
    } else {
      el.classList.remove('synced');
      paw.textContent = '⬜';
    }
  });
}

// ---------- Render: Empty State ----------

function renderEmptyState() {
  // Replace grid content with the empty state message
  const grid = document.getElementById('planner-grid');
  grid.innerHTML = `
    <div id="empty-state">
      <span class="empty-icon">🐾</span>
      <strong>No courses synced yet</strong>
      Visit <em>MyPlan</em> first to sync your courses!
    </div>
  `;

  // Sidebar also empty
  const sidebar = document.getElementById('unplanned-list');
  sidebar.innerHTML = '<div class="sidebar-empty">Visit<br>MyPlan<br>first!</div>';

  updateMascot('confused');
  document.getElementById('speech-text').textContent =
    'Visit MyPlan first to sync your courses! 🐾';
}

// ---------- Render: Sidebar ----------

function renderSidebar() {
  const list = document.getElementById('unplanned-list');
  list.innerHTML = '';

  if (state.unplanned.length === 0) {
    list.innerHTML = '<div class="sidebar-empty">All placed!</div>';
    return;
  }

  state.unplanned.forEach(course => {
    const chip = document.createElement('div');
    chip.className = 'course-chip';
    chip.textContent = course.courseCode;
    chip.title = `${course.courseName} (${course.credits} cr)`;
    chip.draggable = true;
    chip.dataset.courseCode = course.courseCode;

    // Drag events
    chip.addEventListener('dragstart', (e) => onDragStart(e, course.courseCode, 'sidebar', null));
    chip.addEventListener('dragend',   () => onDragEnd());

    list.appendChild(chip);
  });
}

// ---------- Render: Planner Grid ----------

function renderGrid() {
  const grid = document.getElementById('planner-grid');
  grid.innerHTML = '';

  state.quarters.forEach(q => {
    const codes   = state.planner[q.id] || [];
    const col     = buildQuarterColumn(q, codes);
    grid.appendChild(col);
  });
}

// Build a single quarter column DOM element
function buildQuarterColumn(quarter, courseCodes) {
  const totalCredits = courseCodes.reduce((sum, code) => {
    return sum + (state.allCourses[code]?.credits || 0);
  }, 0);

  const redCount   = courseCodes.filter(c => getDifficultyClass(c) === 'difficulty-red').length;
  const amberCount = courseCodes.filter(c => getDifficultyClass(c) === 'difficulty-amber').length;
  const isOverload = totalCredits >= 18 || redCount >= 3;

  const col = document.createElement('div');
  col.className = 'quarter-col';
  col.dataset.quarterId = quarter.id;

  // Header
  const header = document.createElement('div');
  header.className = 'quarter-header';
  header.innerHTML = `
    <span class="quarter-name">${quarter.label}</span>
    <span class="quarter-credits">${totalCredits} cr</span>
  `;
  col.appendChild(header);

  // Drop zone
  const dropZone = document.createElement('div');
  dropZone.className = 'quarter-drop-zone';
  dropZone.dataset.quarterId = quarter.id;

  courseCodes.forEach(code => {
    const card = buildCourseCard(code);
    if (card) dropZone.appendChild(card);
  });

  // Overload warning chip
  if (isOverload) {
    const warn = document.createElement('div');
    warn.className = 'overload-warning';
    warn.textContent = '⚠️ Heavy quarter';
    dropZone.appendChild(warn);
  }

  // Wire drop zone events
  dropZone.addEventListener('dragover',  (e) => onDragOver(e, dropZone));
  dropZone.addEventListener('dragleave', ()  => onDragLeave(dropZone));
  dropZone.addEventListener('drop',      (e) => onDrop(e, quarter.id));

  col.appendChild(dropZone);
  return col;
}

// Build a course card DOM element
function buildCourseCard(courseCode) {
  const course    = state.allCourses[courseCode];
  if (!course) return null;

  const diffClass = getDifficultyClass(courseCode);
  const pct       = getDifficultyPct(courseCode);

  const card = document.createElement('div');
  card.className = `course-card ${diffClass}`;
  card.draggable = true;
  card.dataset.courseCode = courseCode;

  const pctDisplay = pct !== null ? `${pct}% got 4.0` : 'No data';
  const barWidth   = pct !== null ? pct : 50;

  card.innerHTML = `
    <div class="card-top-row">
      <span class="card-code">${course.courseCode}</span>
      <span class="card-credit-pill">${course.credits || '?'}cr</span>
    </div>
    <div class="card-name">${course.courseName || '—'}</div>
    <div class="card-progress-bar">
      <div class="card-progress-fill" style="width:${barWidth}%"></div>
    </div>
    <div class="card-progress-pct">${pctDisplay}</div>
  `;

  card.addEventListener('dragstart', (e) => {
    // Find which quarter this card is in
    const zone = e.target.closest('.quarter-drop-zone');
    const qId  = zone ? zone.dataset.quarterId : null;
    onDragStart(e, courseCode, 'quarter', qId);
  });
  card.addEventListener('dragend', () => onDragEnd());

  return card;
}

// ---------- Drag and Drop ----------

function onDragStart(e, courseCode, sourceType, sourceQuarter) {
  dragInfo = { courseCode, sourceType, sourceQuarter };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', courseCode); // required for Firefox

  // Add visual feedback after a microtask so the ghost image renders first
  setTimeout(() => {
    const el = e.target;
    el.classList.add('dragging');
  }, 0);
}

function onDragEnd() {
  // Remove dragging class from all draggable items
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  dragInfo = null;
}

function onDragOver(e, dropZone) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropZone.classList.add('drag-over');
}

function onDragLeave(dropZone) {
  dropZone.classList.remove('drag-over');
}

function onDrop(e, targetQuarterId) {
  e.preventDefault();
  const dropZone = e.currentTarget;
  dropZone.classList.remove('drag-over');

  if (!dragInfo) return;

  const { courseCode, sourceType, sourceQuarter } = dragInfo;

  // Remove from source
  if (sourceType === 'sidebar') {
    state.unplanned = state.unplanned.filter(c => c.courseCode !== courseCode);
  } else if (sourceType === 'quarter' && sourceQuarter) {
    state.planner[sourceQuarter] = (state.planner[sourceQuarter] || []).filter(c => c !== courseCode);
  }

  // Add to target quarter
  if (!state.planner[targetQuarterId]) state.planner[targetQuarterId] = [];
  if (!state.planner[targetQuarterId].includes(courseCode)) {
    state.planner[targetQuarterId].push(courseCode);
  }

  saveToStorage();
  renderGrid();
  renderSidebar();
  updateMascotFromGrid();
}

// Also allow dropping back to the sidebar
(function wireSidebarDrop() {
  // Wait for DOM
  document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.addEventListener('dragover',  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    sidebar.addEventListener('drop',      (e) => {
      e.preventDefault();
      if (!dragInfo) return;
      const { courseCode, sourceType, sourceQuarter } = dragInfo;

      // Remove from source quarter if applicable
      if (sourceType === 'quarter' && sourceQuarter) {
        state.planner[sourceQuarter] = (state.planner[sourceQuarter] || []).filter(c => c !== courseCode);
      }

      // Add back to unplanned if not already there
      if (!state.unplanned.find(c => c.courseCode === courseCode)) {
        const course = state.allCourses[courseCode];
        if (course) state.unplanned.push(course);
      }

      saveToStorage();
      renderGrid();
      renderSidebar();
      updateMascotFromGrid();
    });
  });
})();

// ---------- Mascot Logic ----------

// Pick a mascot state based on the aggregate across ALL 6 quarters
function computeGlobalMascotState() {
  let maxCredits  = 0;
  let totalRed    = 0;
  let totalAmber  = 0;
  let totalCourses = 0;

  state.quarters.forEach(q => {
    const codes   = state.planner[q.id] || [];
    const credits = codes.reduce((s, c) => s + (state.allCourses[c]?.credits || 0), 0);
    const red     = codes.filter(c => getDifficultyClass(c) === 'difficulty-red').length;
    const amber   = codes.filter(c => getDifficultyClass(c) === 'difficulty-amber').length;
    if (credits > maxCredits) maxCredits = credits;
    totalRed    += red;
    totalAmber  += amber;
    totalCourses += codes.length;
  });

  // Worst-case mascot logic (ordered from worst to best)
  if (maxCredits >= 20 && totalRed >= 3)       return 'dead';
  if (maxCredits >= 20)                         return 'stunned';
  if (maxCredits >= 18 && totalRed >= 2)        return 'cry';
  if (totalRed >= 3 || (totalRed >= 2 && totalAmber >= 2)) return 'sad';
  if (maxCredits >= 16 || totalAmber >= 3)      return 'tired';
  if (totalCourses === 0)                       return 'confused';
  if (maxCredits <= 12 && totalRed === 0 && totalAmber === 0) return 'cool';
  return 'smile';
}

function updateMascotFromGrid() {
  const key = computeGlobalMascotState();
  updateMascot(key);
}

function updateMascot(stateKey) {
  const s   = stateKey ? MASCOT_STATES[stateKey] : MASCOT_STATES.confused;
  const img = document.getElementById('mascot-img');
  const txt = document.getElementById('speech-text');
  img.src           = `images/${s.img}`;
  txt.textContent   = s.msg;
}

// ---------- Settings ----------

function wireSettingsButton() {
  document.getElementById('settings-btn').addEventListener('click', () => {
    // Placeholder — could open an options page in the future
    alert('PawPath Settings\n\nVisit the pages below to sync your courses:\n• myplan.uw.edu — course list\n• dawgpath.uw.edu — difficulty data\n• washington.edu/students/timeschd — RMP ratings');
  });
}
