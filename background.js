// ============================================================
// PawPath — background.js  (Manifest V3 Service Worker)
//
// Handles cross-origin fetches on behalf of the popup:
//
//   GET_RMP_RATING   { professorName, schoolId }
//     → { rating: { avgRating, avgDifficulty, wouldTakeAgainPercent, numRatings } | null }
//
//   GET_DAWGPATH_DATA  { courseCode }
//     → raw DawgPath API JSON object, or null on error
//     Uses credentials:'include' to forward the browser's UW SSO session
//     cookie, which avoids the CORS-breaking SSO redirect.
// ============================================================

'use strict';

// RateMyProfessor GraphQL endpoint
const RMP_GRAPHQL_URL = 'https://www.ratemyprofessors.com/graphql';

// UW Seattle school node ID on RMP (School-1530 base64 encoded)
// This is the RMP internal ID for University of Washington.
const UW_RMP_SCHOOL_NODE_ID = 'U2Nob29sLTE1MzA=';

// In-memory caches (live for the service-worker lifetime)
const ratingCache  = new Map(); // professorName → rating | null
const dawgCache    = new Map(); // courseCode    → data   | null

// ---- Message listener ----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_RMP_RATING') {
    const { professorName, schoolId } = message;
    const key = professorName.toLowerCase();

    if (ratingCache.has(key)) {
      sendResponse({ rating: ratingCache.get(key) });
      return false;
    }

    fetchRmpRating(professorName, schoolId || UW_RMP_SCHOOL_NODE_ID)
      .then(rating => {
        ratingCache.set(key, rating);
        sendResponse({ rating });
      })
      .catch(() => sendResponse({ rating: null }));

    return true; // keep channel open
  }

  if (message.type === 'GET_DAWGPATH_DATA') {
    const { courseCode } = message;
    const key = courseCode.toUpperCase();

    if (dawgCache.has(key)) {
      sendResponse({ data: dawgCache.get(key) });
      return false;
    }

    fetch(
      `https://dawgpath.uw.edu/api/v1/courses/${encodeURIComponent(courseCode)}`,
      { credentials: 'include' }
    )
      .then(resp => {
        if (!resp.ok) throw new Error(resp.status);
        return resp.json();
      })
      .then(data => {
        dawgCache.set(key, data);
        sendResponse({ data });
      })
      .catch(() => sendResponse({ data: null }));

    return true; // keep channel open
  }

  return false; // unknown message type — don't hold the channel
});

// ---- RateMyProfessor GraphQL fetch ----

async function fetchRmpRating(professorName, schoolNodeId) {
  const query = `
    query NewSearchTeachersQuery($text: String!, $schoolID: ID!) {
      newSearch {
        teachers(query: { text: $text, schoolID: $schoolID }) {
          edges {
            node {
              id
              firstName
              lastName
              avgRating
              avgDifficulty
              wouldTakeAgainPercent
              numRatings
              department
            }
          }
        }
      }
    }
  `;

  const variables = { text: professorName, schoolID: schoolNodeId || UW_RMP_SCHOOL_NODE_ID };

  let data;
  try {
    data = await graphqlRequest(query, variables);
  } catch (e) {
    return null;
  }

  const edges = data?.data?.newSearch?.teachers?.edges;
  if (!edges || edges.length === 0) return null;

  const node = edges[0].node;
  if (!node || node.numRatings === 0) return null;

  return {
    avgRating:             node.avgRating,
    avgDifficulty:         node.avgDifficulty,
    wouldTakeAgainPercent: node.wouldTakeAgainPercent,
    numRatings:            node.numRatings,
    department:            node.department ?? null,
  };
}

// Low-level GraphQL POST helper
async function graphqlRequest(query, variables) {
  const response = await fetch(RMP_GRAPHQL_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Basic dGVzdDp0ZXN0', // RMP public basic auth token
      'User-Agent':    'Mozilla/5.0',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`RMP API error: ${response.status}`);
  }

  return response.json();
}
