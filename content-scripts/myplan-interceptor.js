// PawPath — myplan-interceptor.js
// Runs at document_start on myplan.uw.edu.
// Wraps window.fetch to intercept /api/details responses and cache them in
// chrome.storage.local so popup.js can read section data without re-fetching.

(function () {
  'use strict';

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';

    if (url.includes('/api/details?courseId=')) {
      const courseIdMatch = url.match(/courseId=([a-f0-9-]+)/);
      const clone = response.clone();
      clone.json().then(data => {
        const courseId = courseIdMatch?.[1] ?? null;
        chrome.storage.local.set({ myplan_course_details: { courseId, data } });
        console.log(
          '[PawPath] intercepted course details | courseId:', courseId,
          '| termList length:',
          data?.courseOfferingInstitutionList?.[0]?.courseOfferingTermList?.length ?? 0
        );
      }).catch(() => {});
    }

    return response;
  };
})();
