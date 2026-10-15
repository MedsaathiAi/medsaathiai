import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

// Fixed on the server so nobody can switch to a costlier model or bigger limit
const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 4096;

// Monthly question limit for subscribers (₹299 / 3 months = 25 per month)
const PLAN_LIMITS = { basic: 15, plus: 25, pro: 50 };
const DEFAULT_LIMIT = 25;

// Month key in Indian time, e.g. "2026-10"
function monthKeyIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCFullYear() + "-" + String(ist.getUTCMonth() + 1).padStart(2, "0");
}

// Use 1 question from the pack that expires first. Returns a function that gives it back, or null if no pack left.
async function usePackQuestion(uid) {
  const packsRef = admin.database().ref("users/" + uid + "/packs");
  let usedId = null;
  const result = await packsRef.transaction((packs) => {
    usedId = null;
    if (packs === null) return null; // not loaded yet / no packs (Firebase retries with real data)
    const now = Date.now();
    const ids = Object.keys(packs)
      .filter((id) => packs[id] && packs[id].left > 0 && packs[id].expiresAt > now)
      .sort((a, b) => packs[a].expiresAt - packs[b].expiresAt);
    if (ids.length === 0) return; // abort — nothing left
    usedId = ids[0];
    packs[usedId].left = packs[usedId].left - 1;
    return packs;
  });
  if (!result.committed || !usedId) return null;
  const leftRef = admin.database().ref("users/" + uid + "/packs/" + usedId + "/left");
  return () => leftRef.transaction((c) => (c || 0) + 1);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Check the user is logged in (Firebase login token)
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) {
    return res.status(401).json({ error: "Login required" });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: "Invalid login" });
  }

  let giveBack = null; // returns the question if the AI call fails

  try {
    const snap = await admin.database().ref("users/" + uid).get();
    const user = snap.val() || {};

    const { system, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Invalid request" });
    }

    // 2. Decide which questions to use (unlimited accounts skip this)
    if (user.unlimited !== true) {
      let monthlyFull = false;
      let limit = DEFAULT_LIMIT;

      // a) Subscribers: monthly limit first
      if (user.subscribed === true) {
        limit = PLAN_LIMITS[user.plan] || DEFAULT_LIMIT;
        const usageRef = admin.database().ref("users/" + uid + "/usage/" + monthKeyIST());
        const result = await usageRef.transaction((count) => {
          const current = count || 0;
          if (current >= limit) return; // abort — limit reached
          return current + 1;
        });
        if (result.committed) {
          giveBack = () => usageRef.transaction((c) => Math.max(0, (c || 0) - 1));
        } else {
          monthlyFull = true;
        }
      }

      // b) No subscription, or monthly limit full: use a question pack
      if (!giveBack) {
        giveBack = await usePackQuestion(uid);
      }

      if (!giveBack) {
        if (monthlyFull) {
          return res.status(429).json({
            error: "Limit reached",
            message: "⚠️ Is mahine ke aapke " + limit + " sawaal poore ho gaye hain. Agle mahine se phir se sawaal pooch sakte hain."
          });
        }
        return res.status(403).json({
          error: "No plan",
          message: "⚠️ Aapke sawaal khatam ho gaye hain. Naya pack ya subscription lene ke liye page refresh karein."
        });
      }
    }

    // 3. Call Claude with server-fixed settings (system prompt cached to save cost)
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: system
          ? [{ type: "text", text: String(system), cache_control: { type: "ephemeral" } }]
          : undefined,
        messages
      })
    });

    if (!response.ok || !response.body) {
      // AI call failed — give the question back to the user
      if (giveBack) await giveBack();
      const errText = await response.text();
      return res.status(response.status || 500).send(errText);
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();

  } catch (err) {
    if (!res.headersSent) {
      if (giveBack) {
        try { await giveBack(); } catch (_) {}
      }
      return res.status(500).json({ error: err.message });
    }
    res.end();
  }
}
