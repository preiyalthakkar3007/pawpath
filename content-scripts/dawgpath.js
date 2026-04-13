// ============================================================
// PawPath — content-scripts/dawgpath.js
// Runs on: dawgpath.uw.edu
//
// Reads course difficulty / 4.0-percentage data from DawgPath's
// DOM and saves a {courseCode: percentage} map to storage under
// the key "difficultyData".  Also marks the "dawgpath" sync pill.
// ============================================================

(function () {
  'use strict';

  // UW course code pattern
  const COURSE_CODE_RE = /\b([A-Z&]{2,6})\s+(\d{1,3}[A-Z]?)\b/;
  // Percentage patterns: "72%", "72.3%", "72.3 %"
  const PCT_RE         = /(\d{1,3}(?:\.\d+)?)\s*%/;

  // ---- Extract difficulty data from the current DawgPath page ----

  async function extractDifficulty() {
    const diffMap = {}; // courseCode → pct (number)

    // DawgPath is a Vue/React SPA — wait for it to render
    await new Promise(r => setTimeout(r, 1500));

    // Strategy 1: look for explicit stat elements
    // DawgPath typically shows a "4.0 Rate" label alongside a percentage
    const statLabels = document.querySelectorAll(
      '[class*="stat"], [class*="rate"], [class*="grade"], [class*="gpa"], [class*="metric"]'
    );

    statLabels.forEach(el => {
      const text = el.innerText || el.textContent || '';
      if (!/4\.0|rate|pct|percent/i.test(text)) return;
      const pctMatch = text.match(PCT_RE);
      if (!pctMatch) return;

      // Walk up to find the parent container that also holds the course code
      let container = el;
      for (let i = 0; i < 6; i++) {
        container = container.parentElement;
        if (!container) break;
        const containerText = container.innerText || '';
        const codeMatch = containerText.match(COURSE_CODE_RE);
        if (codeMatch) {
          const code = `${codeMatch[1]} ${codeMatch[2]}`;
          diffMap[code] = parseFloat(pctMatch[1]);
          break;
        }
      }
    });

    // Strategy 2: broad text-based sweep when selectors return nothing
    if (Object.keys(diffMap).length === 0) {
      // Look for rows/cards that contain both a course code and a percentage
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            const tag = node.tagName?.toLowerCase();
            if (['script', 'style', 'noscript'].includes(tag)) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        const text = node.innerText || node.textContent || '';
        if (text.length < 5 || text.length > 400) continue;

        const codeMatch = text.match(COURSE_CODE_RE);
        const pctMatch  = text.match(PCT_RE);

        if (codeMatch && pctMatch) {
          const code = `${codeMatch[1]} ${codeMatch[2]}`;
          const pct  = parseFloat(pctMatch[1]);
          // Only overwrite if we get a more specific (narrower) element
          if (!diffMap[code]) {
            diffMap[code] = pct;
          }
        }
      }
    }

    return diffMap;
  }

  // ---- Toast ----

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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { toast.style.opacity = '1'; });
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  // ---- Main ----

  async function run() {
    const diffMap = await extractDifficulty();
    const count   = Object.keys(diffMap).length;

    if (count === 0) return; // nothing found on this page

    // Merge with existing difficulty data
    chrome.storage.local.get('difficultyData', (result) => {
      const existing = result['difficultyData'] || {};
      const merged   = { ...existing, ...diffMap };

      chrome.storage.local.get('syncStatus', (s) => {
        const status = s['syncStatus'] || {};
        chrome.storage.local.set({
          difficultyData: merged,
          syncStatus: { ...status, dawgpath: true },
        });
      });
    });

    showToast(`PawPath synced difficulty data for ${count} course(s) 🐾`);
  }

  run();
})();
