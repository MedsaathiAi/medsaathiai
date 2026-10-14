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

// Question limits
const TRIAL_LIMIT = 5; // total questions in the 7-day ₹15 trial
const PLAN_LIMITS = {  // questions per month after the trial
  basic: 15, // ₹199 / 3 months
  plus: 25,  // ₹299 / 3 months
  pro: 50    // ₹499 / 3 months
};

// Month key in Indian time, e.g. "2026-10"
function monthKeyIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCFullYear() + "-" + String(ist.getUTCMonth() + 1).padStart(2, "0");
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

  let usageRef = null;

  try {
    // 2. Check the user has an active subscription
    const snap = await admin.database().ref("users/" + uid).get();
    const user = snap.val() || {};
    if (user.subscribed !== true && user.unlimited !== true) {
      return res.status(403).json({ error: "Subscription not active" });
    }

    const { system, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Invalid request" });
    }

    // 3. Question limit (skipped for unlimited accounts)
    if (user.unlimited !== true) {
      const inTrial = typeof user.trialEndsAt === "number" && Date.now() < user.trialEndsAt;
      // Trial: 5 questions total. After trial: monthly limit of the plan (old accounts without a plan get Basic)
      const limit = inTrial ? TRIAL_LIMIT : (PLAN_LIMITS[user.plan] || PLAN_LIMITS.basic);
      usageRef = inTrial
        ? admin.database().ref("users/" + uid + "/trialUsed")
        : admin.database().ref("users/" + uid + "/usage/" + monthKeyIST());

      const result = await usageRef.transaction((count) => {
        const current = count || 0;
        if (current >= limit) return; // abort — limit reached
        return current + 1;
      });

      if (!result.committed) {
        usageRef = null;
        return res.status(429).json({
          error: "Limit reached",
          message: inTrial
            ? "⚠️ Trial ke aapke " + limit + " sawaal poore ho gaye hain. Trial khatam hone ke baad aapke plan ke sawaal shuru ho jayenge."
            : "⚠️ Is mahine ke aapke " + limit + " sawaal poore ho gaye hain. Agle mahine se phir se sawaal pooch sakte hain."
        });
      }
    }

    // 4. Call Claude with server-fixed settings (system prompt cached to save cost)
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
      if (usageRef) await usageRef.transaction((c) => Math.max(0, (c || 0) - 1));
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
      if (usageRef) {
        try { await usageRef.transaction((c) => Math.max(0, (c || 0) - 1)); } catch (_) {}
      }
      return res.status(500).json({ error: err.message });
    }
    res.end();
  }
}
