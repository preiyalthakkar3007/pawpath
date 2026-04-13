// ============================================================
// PawPath — content-scripts/degree-audit.js
// Runs on: myplan.uw.edu  and  myuw.uw.edu  (all paths)
//
// Targets the MyPlan Academic Planner grid view, which renders
// a horizontal grid of quarter columns.  Each column has a
// quarter heading ("Autumn 2025") and sub-sections whose labels
// are one of: COMPLETED | REGISTERED | PLANNED | BACKUP.
//
// Scraping rules by column type:
//   COMPLETED quarters  →  scrape COMPLETED section, capture GPA
//   CURRENT quarter     →  scrape REGISTERED section only
//   FUTURE quarters     →  scrape PLANNED section only, skip BACKUP
//
// Only <a> anchor elements are accepted as course codes; plain-text
// room codes (SAV 264, OUG 136) and nav links are ignored.
//
// Storage output:
//   "plannedCourses"   {quarterLabel: [{courseCode,courseName,credits}]}
//   "completedCourses" [{courseCode,courseName,credits,gpa}]
//   "unplannedCourses" [] — kept empty here; user drags courses in
//   "detectedQuarter"  {quarter,year} of current detected quarter
//   "syncStatus"       {..., myplan: true}
// ============================================================

(function () {
  'use strict';

  // ---- Patterns ----

  // Full text of an element must be exactly a UW course code
  const CODE_EXACT_RE = /^([A-Z][A-Z& ]{1,5})\s+(\d{1,3}[A-Z]?)$/;

  // Credit badge text: "5 CR", "3 CREDITS", "4CR", "4 cr", "5 CR."
  const CREDIT_BADGE_RE = /^(\d+)\s*CR(?:EDIT)?S?\.?$/i;

  // Quarter column heading text: "Autumn 2025", "Spring 2026"
  const QUARTER_HEADING_RE = /^(Autumn|Winter|Spring|Summer)\s+(\d{4})$/i;

  // Quarter name anywhere in a longer string (for current-quarter banner)
  const QUARTER_IN_TEXT_RE = /\b(Autumn|Winter|Spring|Summer)\s+(\d{4})\b/i;

  // MyPlan current-quarter banner: "Spring 2026 WEEK 3 OF 10"
  const WEEK_BANNER_RE = /\bWEEK\s+\d+\s+OF\s+\d+\b/i;

  // GPA value: 0.0 – 4.0, optionally followed by " / 4.0"
  const GPA_RE = /^([0-4](?:\.\d{1,2})?)(?:\s*\/\s*4\.?0?)?$/;

  // Section label words (all-caps on page)
  const SECTION_LABELS = new Set(['COMPLETED', 'REGISTERED', 'PLANNED', 'BACKUP']);

  // ---- Quarter ordering (chronological) ----
  // Map each quarter to its approximate start month so we can compare
  // across year boundaries: Autumn 2025 < Winter 2026 < Spring 2026 …
  const QUARTER_START_MONTH = { Autumn: 9, Winter: 1, Spring: 4, Summer: 7 };

  function quarterKey(quarter, year) {
    // Returns a sortable integer: year * 12 + startMonth
    const q = quarter.charAt(0).toUpperCase() + quarter.slice(1).toLowerCase();
    return year * 12 + (QUARTER_START_MONTH[q] ?? 0);
  }

  function normaliseQuarterName(raw) {
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  // ============================================================
  // 1 — Detect the current quarter
  // ============================================================

  function detectCurrentQuarter() {
    // Priority 1: element whose text includes the "WEEK N OF N" banner
    // This is unique to the current quarter's header on MyPlan.
    for (const el of document.querySelectorAll('*')) {
      const text = el.textContent?.trim() ?? '';
      if (text.length > 120 || !WEEK_BANNER_RE.test(text)) continue;
      const m = text.match(QUARTER_IN_TEXT_RE);
      if (m) return { quarter: normaliseQuarterName(m[1]), year: +m[2] };
    }

    // Priority 2: any heading element containing a quarter name
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const m = el.textContent.trim().match(QUARTER_IN_TEXT_RE);
      if (m) return { quarter: normaliseQuarterName(m[1]), year: +m[2] };
    }

    // Fallback: derive from today's date
    return deriveQuarterFromDate();
  }

  function deriveQuarterFromDate() {
    const month = new Date().getMonth() + 1; // 1-12
    let quarter;
    if      (month >= 9)  quarter = 'Autumn';
    else if (month >= 7)  quarter = 'Summer';
    else if (month >= 4)  quarter = 'Spring';
    else                  quarter = 'Winter';
    return { quarter, year: new Date().getFullYear() };
  }

  // ============================================================
  // 2 — Find all quarter columns
  // ============================================================

  // Returns [{quarter, year, label, columnEl}, ...]
  function findQuarterColumns() {
    const seen    = new Set();  // dedup by column element reference
    const columns = [];

    // Find every element whose text is exactly a quarter name heading
    for (const el of document.querySelectorAll('*')) {
      const text = directTextOf(el);
      const m    = text.match(QUARTER_HEADING_RE);
      if (!m) continue;

      const quarter = normaliseQuarterName(m[1]);
      const year    = +m[2];
      const label   = `${quarter} ${year}`;

      // Walk up to find the column container that holds section labels
      const columnEl = findColumnContainer(el);
      if (!columnEl || seen.has(columnEl)) continue;

      seen.add(columnEl);
      columns.push({ quarter, year, label, columnEl });
    }

    return columns;
  }

  // Walk up from a quarter heading element until we reach an ancestor
  // that contains at least one recognised section label (COMPLETED /
  // REGISTERED / PLANNED / BACKUP) among its descendants, but whose
  // total text is short enough that it's a single column, not the grid.
  function findColumnContainer(headingEl) {
    let node = headingEl.parentElement;
    for (let depth = 0; depth < 10; depth++) {
      if (!node || node === document.body) break;
      const textLen = (node.textContent ?? '').length;
      if (textLen > 4000) break;  // gone too far up — multiple columns in view
      if (hasSectionLabelDescendant(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  // True if any descendant's exact text equals a section label word
  function hasSectionLabelDescendant(el) {
    for (const child of el.querySelectorAll('*')) {
      if (SECTION_LABELS.has(directTextOf(child).toUpperCase())) return true;
    }
    return false;
  }

  // ============================================================
  // 3 — Classify a column as completed / current / future
  // ============================================================

  function classifyColumn(colQuarter, colYear, currentQuarter, currentYear) {
    const colNum  = quarterKey(colQuarter, colYear);
    const currNum = quarterKey(currentQuarter, currentYear);
    if (colNum < currNum)  return 'completed';
    if (colNum === currNum) return 'current';
    return 'future';
  }

  // ============================================================
  // 4 — Find section labels within a column
  // ============================================================

  // Returns section label elements in DOM order, deduplicated to the
  // outermost match (so nested wrappers don't produce duplicates).
  function findSectionLabelsIn(columnEl) {
    const candidates = [];

    const walker = document.createTreeWalker(columnEl, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      // textContent must equal the label — nothing else in the element
      const full = (node.textContent ?? '').trim().toUpperCase();
      if (!SECTION_LABELS.has(full)) continue;
      // directTextOf check ensures the label isn't a wrapper containing
      // other text besides the label word
      const own = directTextOf(node).toUpperCase();
      if (own === full) candidates.push(node);
    }

    // Keep only outermost: discard any node that is a descendant of another
    return candidates.filter(
      n1 => !candidates.some(n2 => n2 !== n1 && n2.contains(n1))
    );
  }

  // ============================================================
  // 5 — Get courses from a specific section type within a column
  // ============================================================

  // Finds the section label for `sectionType` inside `columnEl`, then
  // collects all course anchors that appear in DOM order between that
  // label and the next section label in the same column.
  function getCoursesFromSection(columnEl, sectionType, includeGpa) {
    const allLabels = findSectionLabelsIn(columnEl);

    // Find the label element for the requested section type
    const labelEl = allLabels.find(
      el => (el.textContent ?? '').trim().toUpperCase() === sectionType
    );
    if (!labelEl) return [];

    // Determine the "stop" element: the next section label in DOM order
    const labelIdx = allLabels.indexOf(labelEl);
    const stopEl   = allLabels[labelIdx + 1] ?? null;

    // Walk the column in DOM order, capturing <a> elements in the range
    // [after labelEl … before stopEl]
    const courses  = [];
    let capturing  = false;
    const walker   = document.createTreeWalker(columnEl, NodeFilter.SHOW_ELEMENT);
    let node;

    while ((node = walker.nextNode())) {
      if (node === labelEl) { capturing = true; continue; }
      if (stopEl && node === stopEl) break;
      if (!capturing) continue;

      if (node.tagName?.toLowerCase() !== 'a') continue;

      const text      = directTextOf(node);
      const codeMatch = text.match(CODE_EXACT_RE);
      if (!codeMatch) continue;

      const courseCode = `${codeMatch[1].trim()} ${codeMatch[2]}`;
      if (courses.some(c => c.courseCode === courseCode)) continue; // dedup

      const card = findCardContainer(node);
      if (!card) continue;

      const entry = {
        courseCode,
        courseName: extractCourseName(card, node),
        credits:    extractCredits(card),
      };

      if (includeGpa) entry.gpa = extractGpa(card);

      courses.push(entry);
    }

    return courses;
  }

  // ============================================================
  // 6 — Card-level data extraction
  // ============================================================

  // Walk up from an anchor to find the enclosing card: the nearest
  // ancestor that contains a credit badge.  Returns null if none found
  // within 8 levels or text exceeds 600 chars (not a single card).
  function findCardContainer(anchorEl) {
    let node = anchorEl.parentElement;
    for (let depth = 0; depth < 8; depth++) {
      if (!node) break;
      if ((node.textContent ?? '').length > 600) break;
      if (containsCreditBadge(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function containsCreditBadge(container) {
    for (const el of container.querySelectorAll('*')) {
      if (CREDIT_BADGE_RE.test(directTextOf(el))) return true;
    }
    for (const child of container.childNodes) {
      if (child.nodeType === Node.TEXT_NODE &&
          CREDIT_BADGE_RE.test(child.textContent.trim())) return true;
    }
    return false;
  }

  function extractCredits(card) {
    for (const el of card.querySelectorAll('*')) {
      const m = directTextOf(el).match(CREDIT_BADGE_RE);
      if (m) return +m[1];
    }
    const m2 = (card.textContent ?? '').match(/\b(\d+)\s*CR(?:EDIT)?S?\b/i);
    return m2 ? +m2[1] : 0;
  }

  // Find the course name: the first element after the anchor in DOM order
  // whose direct text looks like a human-readable name (not a code, not
  // a badge, not a short UI label).
  function extractCourseName(card, anchorEl) {
    const allEls  = Array.from(card.querySelectorAll('*'));
    const startAt = allEls.indexOf(anchorEl) + 1;

    // First pass: elements after the anchor
    for (let i = startAt; i < allEls.length; i++) {
      const name = asCourseName(allEls[i]);
      if (name) return name;
    }
    // Second pass: anything in the card
    for (const el of allEls) {
      if (el === anchorEl) continue;
      const name = asCourseName(el);
      if (name) return name;
    }
    return '';
  }

  function asCourseName(el) {
    const t = directTextOf(el);
    if (!t || t.length < 4 || t.length > 120) return null;
    if (CREDIT_BADGE_RE.test(t))               return null;
    if (CODE_EXACT_RE.test(t))                 return null;
    if (GPA_RE.test(t.trim()))                 return null;  // don't confuse GPA with name
    if (/^\d+$/.test(t))                       return null;
    if (SECTION_LABELS.has(t.trim().toUpperCase())) return null;
    if (/^(add|remove|drop|view|edit|details?|more|status|waitlist(?:ed)?|credits?|units?)$/i.test(t)) return null;
    return t;
  }

  // GPA: look for a decimal number between 0.0 and 4.0 in the card.
  // Prefer a dedicated element over a raw text scan to avoid false matches.
  function extractGpa(card) {
    for (const el of card.querySelectorAll('*')) {
      const t = directTextOf(el).trim();
      const m = t.match(GPA_RE);
      if (m) {
        const v = parseFloat(m[1]);
        if (v >= 0 && v <= 4.0) return v;
      }
    }
    return null;
  }

  // ============================================================
  // 7 — Text helpers
  // ============================================================

  // Text that belongs ONLY to this element's own text nodes (not children).
  // Falls back to full textContent when the element has ≤1 child (leaf wrapper).
  function directTextOf(el) {
    let t = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) t += node.textContent;
    }
    t = t.trim();
    if (!t && el.children.length <= 1) t = (el.textContent ?? '').trim();
    return t;
  }

  // ============================================================
  // 8 — Main extraction
  // ============================================================

  function extractAll() {
    const currentQ = detectCurrentQuarter();
    const columns  = findQuarterColumns();

    const plannedCourses   = {};   // { "Spring 2026": [{...}] }
    const completedCourses = [];   // [{..., gpa}]

    for (const col of columns) {
      const type = classifyColumn(col.quarter, col.year, currentQ.quarter, currentQ.year);

      let courses = [];

      if (type === 'completed') {
        courses = getCoursesFromSection(col.columnEl, 'COMPLETED', true);
        completedCourses.push(...courses);

      } else if (type === 'current') {
        courses = getCoursesFromSection(col.columnEl, 'REGISTERED', false);
        if (courses.length > 0) plannedCourses[col.label] = courses;

      } else {
        // future
        courses = getCoursesFromSection(col.columnEl, 'PLANNED', false);
        if (courses.length > 0) plannedCourses[col.label] = courses;
        // BACKUP is intentionally ignored
      }
    }

    return { plannedCourses, completedCourses, currentQ, columnCount: columns.length };
  }

  // ============================================================
  // 9 — Storage
  // ============================================================

  function saveToStorage({ plannedCourses, completedCourses, currentQ }) {
    chrome.storage.local.get('syncStatus', (result) => {
      const status = result['syncStatus'] || {};
      chrome.storage.local.set({
        plannedCourses,
        completedCourses,
        // unplannedCourses is left to user management; we merge without clobbering
        detectedQuarter: currentQ,
        syncStatus: { ...status, myplan: true },
      });
    });
  }

  // ============================================================
  // 10 — Toast
  // ============================================================

  function showToast(message) {
    const existing = document.getElementById('pawpath-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'pawpath-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position:      'fixed',
      bottom:        '20px',
      right:         '20px',
      background:    '#4b2e83',
      color:         '#ffffff',
      padding:       '10px 16px',
      borderRadius:  '8px',
      fontSize:      '13px',
      fontFamily:    'system-ui, sans-serif',
      boxShadow:     '0 3px 12px rgba(75,46,131,0.4)',
      zIndex:        '2147483647',
      opacity:       '0',
      transition:    'opacity 0.3s ease',
      pointerEvents: 'none',
    });
    document.body.appendChild(toast);

    requestAnimationFrame(() => requestAnimationFrame(() => { toast.style.opacity = '1'; }));
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  // ============================================================
  // 11 — Scan loop (debounced)
  // ============================================================

  let scanTimer   = null;
  let lastSyncSig = '';

  function scheduleScan(delay = 1200) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const result = extractAll();
      const { plannedCourses, completedCourses, currentQ, columnCount } = result;

      if (columnCount === 0) return; // planner grid not visible on this page

      // Deduplicate against last sync
      const allCodes = [
        ...Object.values(plannedCourses).flat().map(c => c.courseCode),
        ...completedCourses.map(c => c.courseCode),
      ].sort().join(',');

      if (allCodes === lastSyncSig) return;
      lastSyncSig = allCodes;

      saveToStorage({ plannedCourses, completedCourses, currentQ });

      const plannedCount   = Object.values(plannedCourses).flat().length;
      const completedCount = completedCourses.length;
      showToast(
        `PawPath synced ${plannedCount} planned + ${completedCount} completed courses 🐾`
      );
    }, delay);
  }

  // ============================================================
  // 12 — MutationObserver (SPA navigation support)
  // ============================================================

  const observer = new MutationObserver((mutations) => {
    if (mutations.some(m => m.addedNodes.length > 0)) scheduleScan(800);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan — give React time to hydrate the grid
  scheduleScan(1800);

})();
