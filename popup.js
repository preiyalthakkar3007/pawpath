// ============================================================
// PawPath — popup.js  (Course Decision Tool)
//
// Flow:
//  1. On open: load storage, render workload summary, set mascot.
//  2. User types a course code + presses Enter / clicks →
//  3. Difficulty appears immediately from chrome.storage.local.
//  4. Time Schedule is fetched to get sections + instructor names.
//  5. RMP ratings are fetched per instructor via background.js.
//  6. All three columns render as data arrives; mascot reacts to
//     the searched course's 4.0 rate.
// ============================================================

'use strict';

// ---- Constants ----

const UW_SCHOOL_ID = 'U2Nob29sLTE1MzA=';   // base64("School-1530")
const UW_SCHOOL_NUM = '1530';                // numeric ID for RMP search URLs

const QUARTER_URL_CODE = { Autumn: 'AUT', Winter: 'WIN', Spring: 'SPR', Summer: 'SUM' };
const QUARTER_START_MONTH = { Autumn: 9, Winter: 1, Spring: 4, Summer: 7 };
const QUARTER_ORDER = ['Winter', 'Spring', 'Summer', 'Autumn'];

// Mascot reactions to a course's 4.0 rate (checked in order, highest first)
const COURSE_MASCOT_STATES = [
  { minPct: 50,  img: 'cool.png',    msg: 'Easy A potential 😎' },
  { minPct: 35,  img: 'smile.png',   msg: 'Manageable! 🐾' },
  { minPct: 20,  img: 'tired.png',   msg: 'Gonna need to study... 😫' },
  { minPct: 10,  img: 'sad.png',     msg: 'Buckle up 😢' },
  { minPct: 0,   img: 'dead.png',    msg: 'You sure about this? 💀' },
];

// Default (no course searched or no difficulty data)
const DEFAULT_MASCOT = { img: 'smile.png', msg: 'What course are we checking? 🐾' };

// ---- Minimal app state ----
const state = {
  plannedCourses: {},
  detectedQuarter: null,
  selectedQuarter: null,   // quarter the user has selected in the pill row
  lastParsed: null,        // last successfully parsed course (for re-fetching on quarter change)
  syncStatus: {},
};

// ============================================================
// Initialisation
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Load everything from storage in one round-trip
  const data = await getStorage([
    'plannedCourses', 'detectedQuarter', 'syncStatus',
  ]);

  state.plannedCourses  = data.plannedCourses  || {};
  state.detectedQuarter = data.detectedQuarter || deriveQuarterFromDate();
  state.selectedQuarter = { ...state.detectedQuarter };
  state.syncStatus      = data.syncStatus      || {};

  renderSyncPills();
  renderWorkloadBar();
  renderQuarterPills();
  updateMascot(DEFAULT_MASCOT);

  // Wire search input
  document.getElementById('search-btn').addEventListener('click', onSearchClick);
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') onSearchClick();
  });

  document.getElementById('settings-btn').addEventListener('click', () => {
    alert(
      'PawPath — Sync sources\n\n' +
      '• myplan.uw.edu       → planned/registered courses\n' +
      '• dawgpath.uw.edu     → 4.0% difficulty data\n' +
      '• washington.edu/students/timeschd → RMP ratings'
    );
  });
});

// ============================================================
// Search entry point
// ============================================================

function onSearchClick() {
  const raw    = document.getElementById('search-input').value;
  const parsed = parseCourseInput(raw);
  const errEl  = document.getElementById('search-error');

  if (!parsed) {
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  doSearch(parsed);
}

async function doSearch(parsed) {
  const { dept, num, code, deptUrl } = parsed;
  state.lastParsed = parsed;
  const q = state.selectedQuarter;

  showResultsCard(code);
  showColumnLoading('diff-body');
  showColumnLoading('prof-body');
  showColumnLoading('sect-body');

  // DawgPath and Time Schedule fire concurrently; render each column
  // independently as the data arrives.
  const dawgPromise = fetchDawgPathData(code);
  const tsPromise   = fetchTimeScheduleSections(deptUrl, num, q.quarter, q.year);

  // Difficulty renders as soon as DawgPath responds
  dawgPromise.then(dawgData => {
    renderDifficultyColumn(dawgData);
    updateMascotForDifficulty(dawgData ? computeFourOPct(dawgData) : null);
  });

  // Sections render as soon as Time Schedule responds, then RMP follows
  const { sections, instructorNames } = await tsPromise;
  renderSectionsColumn(sections, q);

  const profResults = await fetchAllProfessorRatings(instructorNames);
  renderProfessorsColumn(profResults);
}

// ============================================================
// Difficulty column  (DawgPath API)
// ============================================================

// Fetch course data from the DawgPath API via the background service worker.
// The background worker uses credentials:'include' to forward the browser's
// existing UW SSO session cookie, bypassing the CORS/SSO redirect that
// blocks direct fetches from the popup.
function fetchDawgPathData(courseCode) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'GET_DAWGPATH_DATA', courseCode },
      response => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response?.data ?? null);
      }
    );
  });
}

// Compute the % of students who earned a 4.0 from gpa_distro.
// Returns a number (one decimal place) or null if no data.
function computeFourOPct(data) {
  const distro = data?.gpa_distro;
  console.log('[PawPath] gpa_distro raw:', JSON.stringify(distro));
  if (!Array.isArray(distro) || distro.length === 0) return null;
  const total = distro.reduce((s, d) => s + (d.count ?? 0), 0);
  if (total === 0) return null;
  // gpa field may be a number (40) or a string ("40") or a decimal string ("4.0")
  const fourO = distro.find(d =>
    d.gpa === 40 || d.gpa === '40' || d.gpa === '4.0' || Number(d.gpa) === 40
  )?.count ?? 0;
  const pct = Math.round((fourO / total) * 1000) / 10;
  console.log('[PawPath] fourO count:', fourO, '/ total:', total, '=> pct:', pct);
  return pct;
}

function renderDifficultyColumn(data) {
  const body = document.getElementById('diff-body');

  if (!data) {
    body.innerHTML = `
      <div id="diff-no-data">
        No DawgPath data<br>for this course yet.
      </div>`;
    return;
  }

  const pct      = computeFourOPct(data);
  const pctStr   = pct !== null ? `${pct}%` : '--';
  const cls      = pct === null ? 'diff-none'
                 : pct >= 50   ? 'diff-green'
                 : pct >= 20   ? 'diff-amber'
                 :               'diff-red';
  const barColor = pct === null ? '#c4b8e8'
                 : pct >= 50   ? '#22c55e'
                 : pct >= 20   ? '#f59e0b'
                 :               '#ef4444';

  const coi    = data.coi ?? null;
  const coiStr = coi !== null
    ? (coi >= 0 ? `+${coi.toFixed(2)}` : coi.toFixed(2))
    : null;
  const coiColor = coi === null ? '#9d9db8' : coi >= 0 ? '#22c55e' : '#ef4444';

  const bottleneck = data.is_bottleneck === true;
  const gateway    = data.is_gateway    === true;
  const prereqs    = Array.isArray(data.prerequisites) ? data.prerequisites : [];

  let html = `
    <div id="diff-pct-big" class="${cls}">${escHtml(pctStr)}</div>
    <div id="diff-sublabel">got a 4.0</div>
    <div id="diff-bar-wrap">
      <div id="diff-bar-fill" style="width:0%;background:${barColor}"></div>
    </div>`;

  if (coiStr !== null) {
    html += `
    <div class="diff-coi">
      <span class="diff-coi-val" style="color:${coiColor}">${escHtml(coiStr)}</span>
      <span class="diff-coi-label">Outcome Index</span>
    </div>`;
  }

  if (bottleneck) html += `<div class="diff-badge diff-badge-warn">⚠️ Bottleneck</div>`;
  if (gateway)    html += `<div class="diff-badge diff-badge-good">🚀 Gateway</div>`;

  if (prereqs.length > 0) {
    html += `
    <div class="diff-prereqs">
      <span class="diff-prereqs-label">Prereqs</span>
      ${escHtml(prereqs.join(', '))}
    </div>`;
  }

  html += `<div class="diff-attr"><a href="https://dawgpath.uw.edu" target="_blank">via DawgPath</a></div>`;

  body.innerHTML = html;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const fill = body.querySelector('#diff-bar-fill');
      if (fill && pct !== null) fill.style.width = `${pct}%`;
    });
  });
}

// ============================================================
// Professors column
// ============================================================

// instructorNames: string[] from Time Schedule (normalised "F LastName")
async function fetchAllProfessorRatings(instructorNames) {
  const unique = [...new Set(instructorNames.filter(Boolean))];
  if (unique.length === 0) return [];

  const results = await Promise.allSettled(
    unique.map(name => fetchProfessorRating(name))
  );

  return unique.map((name, i) => ({
    name,
    rating: results[i].status === 'fulfilled' ? results[i].value : null,
  }));
}

function fetchProfessorRating(professorName) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_RMP_RATING', professorName, schoolId: UW_SCHOOL_ID },
      (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response?.rating ?? null);
      }
    );
  });
}

function renderProfessorsColumn(profResults) {
  const body = document.getElementById('prof-body');

  if (profResults.length === 0) {
    body.innerHTML = `<div class="col-empty-msg">No instructor<br>info available.</div>`;
    return;
  }

  body.innerHTML = '';

  profResults.forEach(({ name, rating }) => {
    const row = document.createElement('div');
    row.className = 'prof-row';

    // Build the RMP search URL for this professor at UW
    const searchUrl = `https://www.ratemyprofessors.com/search/professors/${UW_SCHOOL_NUM}?q=${encodeURIComponent(name)}`;
    row.title = `Open RMP profile for ${name}`;
    row.addEventListener('click', () => chrome.tabs.create({ url: searchUrl }));

    if (!rating || rating.numRatings === 0) {
      row.innerHTML = `
        <div class="prof-name">
          <span class="prof-name-text">${escHtml(name)}</span>
        </div>
        <span class="prof-no-rating">No ratings yet</span>`;
    } else {
      const stars     = rating.avgRating?.toFixed(1) ?? '?';
      const diff      = rating.avgDifficulty?.toFixed(1) ?? '?';
      const wta       = rating.wouldTakeAgainPercent !== null && rating.wouldTakeAgainPercent !== undefined
                          ? Math.round(rating.wouldTakeAgainPercent) + '%'
                          : '?';

      row.innerHTML = `
        <div class="prof-name">
          <span class="prof-name-text">${escHtml(name)}</span>
          <span class="prof-rating-badge">⭐ ${stars}</span>
        </div>
        <span class="prof-meta">Diff ${diff} · ${wta} again</span>`;
    }

    body.appendChild(row);
  });
}

// ============================================================
// Sections column
// ============================================================

async function fetchTimeScheduleSections(deptUrl, courseNum, quarter, year) {
  const qCode = (QUARTER_URL_CODE[quarter] ?? 'SPR') + year; // e.g. SPR2026
  const url = `https://www.washington.edu/students/timeschd/pub/${qCode}/${deptUrl}.html`;

  let html;
  try {
    console.log('[PawPath] Time Schedule fetch:', url);
    const resp = await fetch(url, { credentials: 'omit' });
    console.log('[PawPath] Time Schedule status:', resp.status, resp.url);
    if (!resp.ok) return { sections: [], instructorNames: [] };
    html = await resp.text();
    console.log('[PawPath] Time Schedule HTML (first 500):', html.slice(0, 500));
  } catch (err) {
    console.log('[PawPath] Time Schedule fetch error:', err);
    return { sections: [], instructorNames: [] };
  }

  return parseTimeScheduleHtml(html, courseNum);
}

// Parse the UW Time Schedule HTML for one course's sections.
// UW page structure: <a name="NNN"> marks each course; section rows are
// <tr> elements with a 5-digit SLN in the first cell.
function parseTimeScheduleHtml(html, courseNum) {
  const parser   = new DOMParser();
  const doc      = parser.parseFromString(html, 'text/html');
  const sections = [];
  const instructorNamesRaw = [];

  const numStr    = String(parseInt(courseNum, 10));       // "340"
  const numPad3   = numStr.padStart(3, '0');               // "340"
  const numPad4   = numStr.padStart(4, '0');               // "0340"
  const numPad5   = numStr.padStart(5, '0');               // "00340"

  // Strategy 1: find named anchor — UW uses various zero-padding conventions
  let anchor =
    doc.querySelector(`a[name="${numStr}"]`)   ||
    doc.querySelector(`a[name="${numPad3}"]`)  ||
    doc.querySelector(`a[name="${numPad4}"]`)  ||
    doc.querySelector(`a[name="${numPad5}"]`)  ||
    doc.querySelector(`a[name="${courseNum}"]`);

  // Strategy 2: text-scan all numeric named anchors for one whose
  // surrounding bold/heading text contains the course number
  if (!anchor) {
    for (const a of doc.querySelectorAll('a[name]')) {
      const n = (a.getAttribute('name') ?? '').trim();
      if (!/^\d+$/.test(n)) continue;
      const parentText = (a.parentElement?.textContent ?? '');
      // Match "INFO 340" or standalone " 340 " or opening "340"
      if (new RegExp(`\\b${numStr}\\b`).test(parentText)) {
        anchor = a;
        break;
      }
    }
  }

  console.log('[PawPath] TS anchor found:', anchor ? anchor.outerHTML.slice(0, 120) : 'NOT FOUND',
    '| numStr:', numStr, 'pad4:', numPad4);
  if (!anchor) return { sections, instructorNames: [] };

  // Walk the document in DOM order; capture TR rows between this anchor
  // and the next numeric named anchor (= the next course on the page).
  const allEls    = [...doc.querySelectorAll('tr, a[name]')];
  let capturing   = false;

  for (const el of allEls) {
    if (el === anchor) { capturing = true; continue; }
    if (!capturing) continue;

    // Stop at the next course anchor (numeric name, different from ours)
    if (el.tagName === 'A') {
      const n = (el.getAttribute('name') ?? '').trim();
      if (/^\d+$/.test(n) && parseInt(n, 10) !== parseInt(numStr, 10)) break;
      continue;
    }

    if (el.tagName !== 'TR') continue;
    const cells = [...el.querySelectorAll('td')];
    if (cells.length < 5) continue;

    // Cell 0 contains the SLN (possibly inside an <a> tag, possibly with
    // trailing section letter: "14476" or "14476 A")
    const cell0Text = (cells[0]?.textContent ?? '').trim();
    const slnMatch  = cell0Text.match(/^(\d{5})/);
    if (!slnMatch) continue;
    const sln = slnMatch[1];

    // Detect whether the section letter is tacked onto cell 0
    const combined = cell0Text.match(/^\d{5}\s+([A-Z]\w*)/);

    let section, type, days, timeRaw, bldgRm, instructor, statusText;

    if (combined) {
      // Compact layout: 0:[SLN+Sect]  1:Cred  2:Type  3:Days  4:Time  5:Bldg  ...
      section    = combined[1];
      type       = (cells[1]?.textContent ?? '').trim().toUpperCase();
      days       = (cells[2]?.textContent ?? '').trim();
      timeRaw    = (cells[3]?.textContent ?? '').trim();
      bldgRm     = buildBldgRoom(cells, 4);
    } else {
      // Standard layout: 0:SLN  1:Sect  2:Cred  3:Type  4:Days  5:Time  6:Bldg  ...
      section    = (cells[1]?.textContent ?? '').trim();
      type       = (cells[3]?.textContent ?? '').trim().toUpperCase();
      days       = (cells[4]?.textContent ?? '').trim();
      timeRaw    = (cells[5]?.textContent ?? '').trim();
      bldgRm     = buildBldgRoom(cells, 6);
    }

    // Last two cells are always Status and Instructor
    const lastIdx  = cells.length - 1;
    instructor  = (cells[lastIdx]?.textContent ?? '').trim();
    statusText  = (cells[lastIdx - 1]?.textContent ?? '').trim().toLowerCase();

    // Confirm this looks like a real data row (section or instructor present)
    if (!section && !instructor) continue;

    let status = 'open';
    if (/clos|cls|full/i.test(statusText))      status = 'closed';
    else if (/res|add\s*code/i.test(statusText)) status = 'res';

    sections.push({
      sln,
      section,
      type: type || 'LEC',
      days,
      time: formatUWTime(timeRaw),
      bldgRm,
      instructor,
      status,
    });

    if (instructor && !/^(to be|arr|staff|tba)/i.test(instructor)) {
      instructorNamesRaw.push(instructor);
    }
  }

  const instructorNames = [
    ...new Set(instructorNamesRaw.map(normalizeInstructorName).filter(Boolean)),
  ];

  console.log('[PawPath] TS parsed sections:', sections.length, '| instructors:', instructorNames);
  return { sections, instructorNames };
}

// Concatenate building + room cells (column 6 and possibly 7)
function buildBldgRoom(cells, startIdx) {
  const a = (cells[startIdx]?.textContent ?? '').trim();
  const b = (cells[startIdx + 1]?.textContent ?? '').trim();
  // Column 7 is a room number if it's digits only or starts with digits
  if (b && /^\d/.test(b)) return `${a} ${b}`.trim();
  return a;
}

function renderSectionsColumn(sections, quarter) {
  const body = document.getElementById('sect-body');

  if (sections.length === 0) {
    const qLabel = `${quarter.quarter} ${quarter.year}`;
    body.innerHTML = `<div class="col-empty-msg">No sections found<br>for ${qLabel}.</div>`;
    return;
  }

  body.innerHTML = '';

  sections.forEach(sec => {
    const row = document.createElement('div');
    row.className = 'section-row';

    const dotClass = sec.status === 'open'   ? 'dot-open'
                   : sec.status === 'closed' ? 'dot-closed'
                   :                           'dot-res';

    const instrDisplay = sec.instructor
      ? formatInstructorForDisplay(sec.instructor)
      : '';

    row.innerHTML = `
      <div class="section-top">
        <span class="section-status-dot ${dotClass}"></span>
        <span class="section-id">${escHtml(sec.section)}</span>
        <span class="section-type">${escHtml(sec.type)}</span>
      </div>
      ${sec.days || sec.time
        ? `<span class="section-time">${escHtml(sec.days)} ${escHtml(sec.time)}</span>`
        : ''}
      ${sec.bldgRm
        ? `<span class="section-room">${escHtml(sec.bldgRm)}</span>`
        : ''}
      ${instrDisplay
        ? `<span class="section-instructor">${escHtml(instrDisplay)}</span>`
        : ''}`;

    body.appendChild(row);
  });
}

// ============================================================
// Workload summary bar
// ============================================================

function renderWorkloadBar() {
  const q = state.detectedQuarter;
  if (!q) return;

  const qLabel  = `${q.quarter} ${q.year}`;
  const courses = state.plannedCourses?.[qLabel] ?? [];
  const totalCr = courses.reduce((s, c) => s + (c.credits || 0), 0);

  document.getElementById('wl-quarter').textContent = qLabel;
  document.getElementById('wl-credits').textContent = totalCr ? `${totalCr} cr` : '-- cr';

  // Difficulty avg is no longer cached locally; workload bar shows credits only.
  const avgEl = document.getElementById('wl-avg');
  avgEl.textContent = '--';
  avgEl.className   = 'wl-avg-val';
}

// ============================================================
// Quarter selector pills
// ============================================================

// Return `count` consecutive quarters starting from `base`.
function computeNextQuarters(base, count = 4) {
  const list = [];
  let { quarter, year } = base;
  for (let i = 0; i < count; i++) {
    list.push({ quarter, year });
    const idx = QUARTER_ORDER.indexOf(quarter);
    if (idx === QUARTER_ORDER.length - 1) {
      quarter = QUARTER_ORDER[0];
      year++;
    } else {
      quarter = QUARTER_ORDER[idx + 1];
    }
  }
  return list;
}

function renderQuarterPills() {
  const row = document.getElementById('quarter-row');
  row.innerHTML = '';

  const quarters = computeNextQuarters(state.detectedQuarter, 4);
  const sel = state.selectedQuarter;

  quarters.forEach(({ quarter, year }) => {
    const btn = document.createElement('button');
    btn.className = 'quarter-pill';
    // Short label: "Spr '26"
    const shortQ = quarter.slice(0, 3);
    const shortY = String(year).slice(2);
    btn.textContent = `${shortQ} '${shortY}`;
    btn.title = `${quarter} ${year}`;

    if (sel && sel.quarter === quarter && sel.year === year) {
      btn.classList.add('selected');
    }

    btn.addEventListener('click', () => {
      state.selectedQuarter = { quarter, year };
      renderQuarterPills();

      // Re-fetch sections for the currently searched course, if any
      if (state.lastParsed) {
        showColumnLoading('sect-body');
        fetchTimeScheduleSections(
          state.lastParsed.deptUrl,
          state.lastParsed.num,
          quarter,
          year
        ).then(({ sections }) => {
          renderSectionsColumn(sections, state.selectedQuarter);
        });
      }
    });

    row.appendChild(btn);
  });
}

// ============================================================
// Sync pills
// ============================================================

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

// ============================================================
// Mascot
// ============================================================

// isQuarter: true when reacting to the overall quarter average (softer messaging)
function updateMascotForDifficulty(pct, isQuarter = false) {
  if (pct === null || pct === undefined) {
    updateMascot(DEFAULT_MASCOT);
    return;
  }

  if (isQuarter) {
    // Quieter reactions for overall quarter difficulty
    if (pct >= 50) updateMascot({ img: 'cool.png',  msg: 'Solid quarter lineup 😎' });
    else if (pct >= 35) updateMascot({ img: 'smile.png', msg: 'Looks manageable 🐾' });
    else if (pct >= 20) updateMascot({ img: 'tired.png', msg: 'Tough quarter ahead 😮‍💨' });
    else                updateMascot({ img: 'sad.png',   msg: 'This quarter is rough... 😢' });
    return;
  }

  // Per-course reactions
  const state_ = COURSE_MASCOT_STATES.find(s => pct >= s.minPct) ?? COURSE_MASCOT_STATES.at(-1);
  updateMascot(state_);
}

function updateMascot({ img, msg }) {
  document.getElementById('mascot-img').src  = `images/${img}`;
  document.getElementById('speech-text').textContent = msg;
}

// ============================================================
// UI helpers
// ============================================================

function showResultsCard(courseCode) {
  document.getElementById('empty-state').style.display  = 'none';
  document.getElementById('results-card').removeAttribute('hidden');

  document.getElementById('res-code-badge').textContent = courseCode;
  document.getElementById('res-name-text').textContent  = '';   // filled in by diff data if available

  // Reset column bodies to empty while new data loads
  ['diff-body', 'prof-body', 'sect-body'].forEach(id => {
    document.getElementById(id).innerHTML = '';
  });
}

// Insert shimmer loading placeholder into a column
function showColumnLoading(bodyId) {
  document.getElementById(bodyId).innerHTML = `
    <div class="col-loading">
      <div class="shimmer-line long"></div>
      <div class="shimmer-line short"></div>
      <div class="shimmer-line long"></div>
      <div class="shimmer-line short"></div>
    </div>`;
}

// ============================================================
// Time / name formatting utilities
// ============================================================

// Convert UW Time Schedule time string "930-1020" → "9:30–10:20",
// "1230-220P" → "12:30–2:20pm"
function formatUWTime(raw) {
  if (!raw) return '';
  const t = raw.trim();
  if (/^(arr|tba|to be)/i.test(t)) return 'TBA';

  // Apply colon formatting: "930" → "9:30", "1230" → "12:30"
  const addColon = (s) => s.replace(/^(\d{1,2})(\d{2})$/, '$1:$2');

  const m = t.match(/^(\d{3,4})-(\d{3,4})(P?)$/i);
  if (!m) return t;

  const start = addColon(m[1]);
  const end   = addColon(m[2]) + (m[3].toUpperCase() === 'P' ? 'pm' : '');
  return `${start}–${end}`;
}

// "BROCK,P" or "BROCK P" → "P Brock" (for RMP search)
function normalizeInstructorName(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (/^(to be|arr|staff|tba)/i.test(s)) return null;

  if (s.includes(',')) {
    const [last, first] = s.split(',').map(p => p.trim());
    return `${first.charAt(0)} ${toTitleCase(last)}`;
  }
  const parts = s.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[1].charAt(0)} ${toTitleCase(parts[0])}`;
  }
  return toTitleCase(s);
}

// "BROCK P" → "Brock" (short display name for sections column)
function formatInstructorForDisplay(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (/^(to be|arr|staff|tba)/i.test(s)) return '';

  if (s.includes(',')) {
    const [last, first] = s.split(',').map(p => p.trim());
    return `${first.charAt(0)}. ${toTitleCase(last)}`;
  }
  const parts = s.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[1].charAt(0)}. ${toTitleCase(parts[0])}`;
  }
  return toTitleCase(s);
}

function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Prevent XSS when injecting user-data strings into innerHTML
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Course input parsing
// ============================================================

// Accepts: "INFO 340", "INFO340", "info340", "C LIT 240", "c& c 101"
// Returns: { dept, num, code, deptUrl } or null
function parseCourseInput(raw) {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase().replace(/\s+/g, ' ');

  // Match one or more letter/symbol groups (dept) followed by a course number
  const m = clean.match(/^((?:[A-Z][A-Z&]* ?)+?)\s*(\d{1,3}[A-Z]?)$/);
  if (!m) return null;

  const dept    = m[1].trim();
  const num     = m[2].trim();
  const deptUrl = dept.toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '');

  if (!deptUrl) return null;

  return { dept, num, code: `${dept} ${num}`, deptUrl };
}

// ============================================================
// Quarter utilities
// ============================================================

function deriveQuarterFromDate() {
  const month = new Date().getMonth() + 1;
  let quarter;
  if      (month >= 9) quarter = 'Autumn';
  else if (month >= 7) quarter = 'Summer';
  else if (month >= 4) quarter = 'Spring';
  else                 quarter = 'Winter';
  return { quarter, year: new Date().getFullYear() };
}

// ============================================================
// Storage helper
// ============================================================

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
