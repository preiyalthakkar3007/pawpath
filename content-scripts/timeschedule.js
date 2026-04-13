// ============================================================
// PawPath — content-scripts/timeschedule.js
// Runs on: washington.edu/students/timeschd/*
//
// Detects instructor names on the UW Time Schedule page and asks
// background.js to fetch their RateMyProfessor rating. Injects a
// small gold pill next to each instructor name showing the rating.
// ============================================================

(function () {
  'use strict';

  // UW's school ID on RateMyProfessor
  const UW_SCHOOL_ID = 'U2Nob29sLTEzMDk='; // base64("School-1309") — RMP internal ID for UW

  // Regex to detect UW instructor name patterns in Time Schedule HTML.
  // The page typically shows names as "LASTNAME,F" or "LASTNAME, FIRSTNAME" in <td> cells.
  // We cast a wide net and rely on context to filter noise.
  const INSTRUCTOR_RE = /^[A-Z][A-Z\-']+,\s*[A-Z]\.?(?:\s+[A-Z]\.?)?$/;

  // Track which names we've already processed to avoid duplicate requests
  const processed = new Set();

  // ---- Find instructor elements on the page ----

  function findInstructorElements() {
    const results = []; // [{element, name}]

    // Time Schedule is a static HTML table
    // Instructors appear in <td> cells — scan all td / anchor text
    const cells = document.querySelectorAll('td, a');
    cells.forEach(el => {
      const raw = (el.innerText || el.textContent || '').trim();
      if (raw.length < 3 || raw.length > 50) return;
      if (INSTRUCTOR_RE.test(raw)) {
        results.push({ element: el, name: normalizeInstructorName(raw) });
      }
    });

    // Broader fallback: any text node that looks like "LASTNAME, F"
    if (results.length === 0) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const raw = node.textContent.trim();
        if (raw.length < 3 || raw.length > 50) continue;
        if (INSTRUCTOR_RE.test(raw)) {
          results.push({ element: node.parentElement, name: normalizeInstructorName(raw) });
        }
      }
    }

    return results;
  }

  // Convert "LASTNAME,F" → "F LASTNAME" for the RMP search
  function normalizeInstructorName(raw) {
    const parts = raw.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      const last  = toTitleCase(parts[0]);
      const first = parts[1].charAt(0).toUpperCase();
      return `${first} ${last}`;
    }
    return toTitleCase(raw);
  }

  function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  // ---- Inject rating pill next to an element ----

  function injectRatingPill(element, rating) {
    // Don't inject twice
    if (element.dataset.pawpathInjected) return;
    element.dataset.pawpathInjected = 'true';

    const pill = document.createElement('span');
    pill.className = 'pawpath-rmp-pill';

    let label;
    if (rating === null) {
      label = '⭐ N/A';
      pill.title = 'No RateMyProfessor data found';
    } else {
      label = `⭐ ${rating.avgRating.toFixed(1)}`;
      pill.title = [
        `RateMyProfessor Rating: ${rating.avgRating.toFixed(1)}/5`,
        `Difficulty: ${rating.avgDifficulty ? rating.avgDifficulty.toFixed(1) : 'N/A'}/5`,
        `Would take again: ${rating.wouldTakeAgainPercent !== null ? Math.round(rating.wouldTakeAgainPercent) + '%' : 'N/A'}`,
      ].join('\n');
    }

    pill.textContent = label;
    Object.assign(pill.style, {
      display:       'inline-block',
      background:    '#b7a57a',
      color:         '#2d1a5e',
      borderRadius:  '10px',
      padding:       '1px 6px',
      fontSize:      '11px',
      fontWeight:    '600',
      marginLeft:    '5px',
      verticalAlign: 'middle',
      fontFamily:    'system-ui, sans-serif',
      cursor:        'default',
      whiteSpace:    'nowrap',
    });

    // Insert after the element's text
    element.insertAdjacentElement('afterend', pill);
  }

  // ---- Fetch rating via background.js message passing ----

  async function fetchRating(professorName) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'GET_RMP_RATING', professorName, schoolId: UW_SCHOOL_ID },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response?.rating || null);
        }
      );
    });
  }

  // ---- Main ----

  async function run() {
    // Give the page a moment to load fully
    await new Promise(r => setTimeout(r, 500));

    const instructors = findInstructorElements();

    for (const { element, name } of instructors) {
      if (processed.has(name)) continue;
      processed.add(name);

      // Fetch rating asynchronously and inject pill when ready
      fetchRating(name).then(rating => {
        injectRatingPill(element, rating);
      });
    }

    // Also mark timeschedule as synced in storage
    if (instructors.length > 0) {
      chrome.storage.local.get('syncStatus', (result) => {
        const status = result['syncStatus'] || {};
        chrome.storage.local.set({ syncStatus: { ...status, timeschedule: true } });
      });
    }
  }

  run();
})();
