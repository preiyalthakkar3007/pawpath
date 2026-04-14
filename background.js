// ============================================================
// PawPath — background.js  (Manifest V3 Service Worker)
//
// Handles RateMyProfessor GraphQL API calls on behalf of content
// scripts (avoids CORS restrictions in content-script context).
//
// Message format received from content scripts:
//   { type: 'GET_RMP_RATING', professorName: string, schoolId: string }
//
// Response sent back:
//   { rating: { avgRating, avgDifficulty, wouldTakeAgainPercent } | null }
// ============================================================

'use strict';

// RateMyProfessor GraphQL endpoint
const RMP_GRAPHQL_URL = 'https://www.ratemyprofessors.com/graphql';

// UW Seattle school node ID on RMP (School-1530 base64 encoded)
// This is the RMP internal ID for University of Washington.
const UW_RMP_SCHOOL_NODE_ID = 'U2Nob29sLTE1MzA=';

// Simple in-memory cache so repeated queries for the same professor
// don't hit the network again within the same service-worker lifetime.
const ratingCache = new Map(); // professorName → rating object or null

// ---- Message listener ----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'GET_RMP_RATING') return false;

  const { professorName, schoolId } = message;
  const cacheKey = professorName.toLowerCase();

  if (ratingCache.has(cacheKey)) {
    sendResponse({ rating: ratingCache.get(cacheKey) });
    return false; // synchronous response
  }

  // Async fetch — must return true to keep the message channel open
  fetchRmpRating(professorName, schoolId || UW_RMP_SCHOOL_NODE_ID)
    .then(rating => {
      ratingCache.set(cacheKey, rating);
      sendResponse({ rating });
    })
    .catch(() => {
      sendResponse({ rating: null });
    });

  return true; // keep channel open for async response
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
