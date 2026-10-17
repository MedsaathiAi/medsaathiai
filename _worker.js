// HealthgenzAI — Cloudflare Pages worker (replaces the Vercel /api files)
// Routes: /api/chat, /api/create-order, /api/verify-payment,
//         /api/create-subscription, /api/verify-subscription, /api/webhook,
//         /__/auth/* and /__/firebase/* (Firebase login proxy), / (index.html)
//
// Secrets needed in Cloudflare (Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
//   RAZORPAY_WEBHOOK_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL

const FIREBASE_PROJECT_ID = "medsaathiai-6fde9";
const FIREBASE_AUTH_HOST = "https://medsaathiai-6fde9.firebaseapp.com";

// ---------- Prices / limits (same as before) ----------
const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 4096;
const PLAN_LIMITS = { basic: 15, plus: 25, pro: 50 };
const DEFAULT_LIMIT = 25;

const SUB_PLAN_IDS = { plus: "plan_TnR92Td51kS8NV" }; // ₹299 / 3 months
const PLAN_BY_ID = {
  "plan_TnR7KL6vdmWqMg": "basic",
  "plan_TnR92Td51kS8NV": "plus",
  "plan_TnRA6SRPyDFD7O": "pro"
};

const PACKS = {
  s: { amount: 4900,  questions: 10, days: 30 }, // ₹49  — 1 mahina
  m: { amount: 9900,  questions: 20, days: 60 }, // ₹99  — 2 mahine
  l: { amount: 19900, questions: 45, days: 60 }  // ₹199 — 2 mahine
};

// =====================================================
// Router
// =====================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Firebase login popup proxy (needed because authDomain = www.healthgenzai.com)
      if (path.startsWith("/__/auth/") || path.startsWith("/__/firebase/")) {
        return proxyFirebase(request, url);
      }

      if (path.startsWith("/api/")) {
        const route = path.replace(/\/+$/, "");
        if (route === "/api/webhook") return await handleWebhook(request, env);
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        if (route === "/api/chat") return await handleChat(request, env);
        if (route === "/api/create-order") return await handleCreateOrder(request, env);
        if (route === "/api/verify-payment") return await handleVerifyPayment(request, env);
        if (route === "/api/create-subscription") return await handleCreateSubscription(request, env);
        if (route === "/api/verify-subscription") return await handleVerifySubscription(request, env);
        return json({ error: "Not found" }, 404);
      }

      // Only the app page is public — other repo files are not served
      if (path === "/" || path === "/index.html") {
        return env.ASSETS.fetch(request); // Cloudflare serves index.html for "/"
      }
      return new Response("Not found", { status: 404 });

    } catch (err) {
      console.error("WORKER ERROR:", err && err.stack ? err.stack : err);
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};

// =====================================================
// /api/chat
// =====================================================
async function handleChat(request, env) {
  const uid = await requireUser(request, env);
  if (!uid) return json({ error: "Login required" }, 401);

  const body = await request.json().catch(() => ({}));
  const { system, messages } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "Invalid request" }, 400);
  }

  const user = (await dbGet(env, "users/" + uid)) || {};
  let giveBack = null; // returns the question if the AI call fails

  if (user.unlimited !== true) {
    let monthlyFull = false;
    let limit = DEFAULT_LIMIT;

    // a) Subscribers: monthly limit first
    if (user.subscribed === true) {
      limit = PLAN_LIMITS[user.plan] || DEFAULT_LIMIT;
      const usagePath = "users/" + uid + "/usage/" + monthKeyIST();
      const r = await dbTransaction(env, usagePath, (count) => {
        const current = count || 0;
        if (current >= limit) return undefined; // limit reached
        return current + 1;
      });
      if (r.committed) {
        giveBack = () => dbTransaction(env, usagePath, (c) => Math.max(0, (c || 0) - 1));
      } else {
        monthlyFull = true;
      }
    }

    // b) No subscription, or monthly limit full: use a question pack
    if (!giveBack) giveBack = await usePackQuestion(env, uid);

    if (!giveBack) {
      if (monthlyFull) {
        return json({
          error: "Limit reached",
          message: "⚠️ Is mahine ke aapke " + limit + " sawaal poore ho gaye hain. Agle mahine se phir se sawaal pooch sakte hain."
        }, 429);
      }
      return json({
        error: "No plan",
        message: "⚠️ Aapke sawaal khatam ho gaye hain. Naya pack ya subscription lene ke liye page refresh karein."
      }, 403);
    }
  }

  // Call Claude with server-fixed settings (system prompt cached to save cost)
  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
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
  } catch (e) {
    if (giveBack) await giveBack();
    throw e;
  }

  if (!upstream.ok || !upstream.body) {
    if (giveBack) await giveBack();
    const errText = await upstream.text();
    return new Response(errText, { status: upstream.status || 500 });
  }

  // Stream the answer straight to the browser
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}

// Use 1 question from the pack that expires first. Returns a "give back" function, or null.
async function usePackQuestion(env, uid) {
  const packsPath = "users/" + uid + "/packs";
  let usedId = null;
  const r = await dbTransaction(env, packsPath, (packs) => {
    usedId = null;
    if (!packs) return undefined;
    const now = Date.now();
    const ids = Object.keys(packs)
      .filter((id) => packs[id] && packs[id].left > 0 && packs[id].expiresAt > now)
      .sort((a, b) => packs[a].expiresAt - packs[b].expiresAt);
    if (ids.length === 0) return undefined;
    usedId = ids[0];
    packs[usedId].left = packs[usedId].left - 1;
    return packs;
  });
  if (!r.committed || !usedId) return null;
  const leftPath = packsPath + "/" + usedId + "/left";
  return () => dbTransaction(env, leftPath, (c) => (c || 0) + 1);
}

// =====================================================
// /api/create-order  (one-time question packs)
// =====================================================
async function handleCreateOrder(request, env) {
  const uid = await requireUser(request, env);
  if (!uid) return json({ success: false, error: "Login required" }, 401);

  const body = await request.json().catch(() => ({}));
  const packKey = body && body.pack;
  const pack = PACKS[packKey];
  if (!pack) return json({ success: false, error: "Invalid pack" }, 400);

  const res = await razorpay(env, "POST", "/v1/orders", {
    amount: pack.amount,
    currency: "INR",
    receipt: "pack_" + packKey + "_" + Date.now(),
    notes: { userId: uid, pack: packKey }
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("RAZORPAY ORDER ERROR:", JSON.stringify(data));
    return json(data, res.status);
  }
  return json({ success: true, orderId: data.id, amount: data.amount, keyId: env.RAZORPAY_KEY_ID });
}

// =====================================================
// /api/verify-payment  (adds the pack after payment)
// =====================================================
async function handleVerifyPayment(request, env) {
  const uid = await requireUser(request, env);
  if (!uid) return json({ success: false, error: "Login required" }, 401);

  const body = await request.json().catch(() => ({}));
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};

  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, razorpay_order_id + "|" + razorpay_payment_id);
  if (!safeEqual(expected, razorpay_signature)) {
    return json({ success: false, error: "Signature verification failed" }, 400);
  }

  // Read the order from Razorpay (not from the browser) to know which pack was paid for
  const orderRes = await razorpay(env, "GET", "/v1/orders/" + encodeURIComponent(razorpay_order_id));
  const order = await orderRes.json();
  const packKey = order && order.notes && order.notes.pack;
  const pack = PACKS[packKey];
  if (!orderRes.ok || !pack || order.amount !== pack.amount) {
    return json({ success: false, error: "Unknown pack" }, 400);
  }
  if (order.notes.userId !== uid) {
    return json({ success: false, error: "Order belongs to another user" }, 403);
  }

  // Add the pack once (same order verified again does nothing)
  const now = Date.now();
  await dbTransaction(env, "users/" + uid + "/packs/" + razorpay_order_id, (existing) => {
    if (existing) return undefined; // already added
    return {
      pack: packKey,
      left: pack.questions,
      total: pack.questions,
      boughtAt: now,
      expiresAt: now + pack.days * 24 * 60 * 60 * 1000,
      paymentId: razorpay_payment_id
    };
  });

  return json({ success: true });
}

// =====================================================
// /api/create-subscription  (₹299 / 3 months, no trial)
// =====================================================
async function handleCreateSubscription(request, env) {
  const body = await request.json().catch(() => ({}));
  const planKey = body && body.plan;
  const planId = SUB_PLAN_IDS[planKey];
  if (!planId) return json({ success: false, error: "Invalid plan" }, 400);

  const res = await razorpay(env, "POST", "/v1/subscriptions", {
    plan_id: planId,
    total_count: 100,
    quantity: 1,
    customer_notify: 1,
    notes: { userId: body && body.userId ? String(body.userId) : "", plan: planKey }
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("RAZORPAY SUBSCRIPTION ERROR:", JSON.stringify(data));
    return json(data, res.status);
  }
  return json({ success: true, subscriptionId: data.id, keyId: env.RAZORPAY_KEY_ID });
}

// =====================================================
// /api/verify-subscription
// =====================================================
async function handleVerifySubscription(request, env) {
  const uid = await requireUser(request, env);
  if (!uid) return json({ success: false, error: "Login required" }, 401);

  const body = await request.json().catch(() => ({}));
  const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = body || {};

  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, razorpay_payment_id + "|" + razorpay_subscription_id);
  if (!safeEqual(expected, razorpay_signature)) {
    return json({ success: false, error: "Signature verification failed" }, 400);
  }

  // Which plan is it really? Ask Razorpay, not the browser
  const subRes = await razorpay(env, "GET", "/v1/subscriptions/" + encodeURIComponent(razorpay_subscription_id));
  const sub = await subRes.json();
  const plan = PLAN_BY_ID[sub && sub.plan_id];
  if (!subRes.ok || !plan) return json({ success: false, error: "Unknown plan" }, 400);

  await dbPatch(env, "users/" + uid, {
    subscribed: true,
    autopay: true,
    plan,
    subscriptionId: razorpay_subscription_id,
    trialEndsAt: null,
    trialUsed: null
  });

  return json({ success: true });
}

// =====================================================
// /api/webhook  (Razorpay subscription events)
// =====================================================
async function handleWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, signature)) {
    return json({ error: "Invalid signature" }, 400);
  }

  const event = JSON.parse(raw);
  const subEntity = event && event.payload && event.payload.subscription && event.payload.subscription.entity;
  const userId = subEntity && subEntity.notes && subEntity.notes.userId;

  if (userId) {
    if (event.event === "subscription.activated" || event.event === "subscription.charged") {
      await dbPatch(env, "users/" + userId, { subscribed: true });
    } else if (event.event === "subscription.cancelled" || event.event === "subscription.halted") {
      await dbPatch(env, "users/" + userId, { subscribed: false });
    }
  }

  return json({ status: "ok" });
}

// =====================================================
// Firebase login proxy
// =====================================================
async function proxyFirebase(request, url) {
  const target = FIREBASE_AUTH_HOST + url.pathname + url.search;
  const init = {
    method: request.method,
    headers: request.headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return fetch(target, init);
}

// =====================================================
// Helpers: responses, time, Razorpay, HMAC
// =====================================================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Month key in Indian time, e.g. "2026-10"
function monthKeyIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCFullYear() + "-" + String(ist.getUTCMonth() + 1).padStart(2, "0");
}

function razorpay(env, method, path, bodyObj) {
  const init = {
    method,
    headers: {
      "Authorization": "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET)
    }
  };
  if (bodyObj) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(bodyObj);
  }
  return fetch("https://api.razorpay.com" + path, init);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// =====================================================
// Helpers: base64url
// =====================================================
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToB64url(str) {
  return bytesToB64url(new TextEncoder().encode(str));
}

// =====================================================
// Firebase login check (replaces admin.auth().verifyIdToken)
// =====================================================
let jwkCache = { keys: null, expires: 0 };

async function getGoogleJwks() {
  if (jwkCache.keys && Date.now() < jwkCache.expires) return jwkCache.keys;
  const res = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const data = await res.json();
  const cc = res.headers.get("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  const ttl = m ? parseInt(m[1], 10) * 1000 : 60 * 60 * 1000;
  jwkCache = { keys: data.keys || [], expires: Date.now() + ttl };
  return jwkCache.keys;
}

// Returns the user's uid, or null if the login token is missing/invalid
async function requireUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    return await verifyFirebaseToken(token);
  } catch (e) {
    console.error("TOKEN CHECK FAILED:", e && e.message);
    return null;
  }
}

async function verifyFirebaseToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Bad token");
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("Bad token header");

  let keys = await getGoogleJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwkCache.expires = 0; // keys may have rotated
    keys = await getGoogleJwks();
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("Unknown key");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!ok) throw new Error("Bad signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("Wrong audience");
  if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID) throw new Error("Wrong issuer");
  if (!payload.exp || payload.exp < now) throw new Error("Token expired");
  if (payload.iat && payload.iat > now + 300) throw new Error("Token from the future");
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("No user");
  return payload.sub;
}

// =====================================================
// Firebase database (replaces firebase-admin) — REST API with service account
// =====================================================
let accessTokenCache = { token: null, expires: 0 };

async function getAccessToken(env) {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expires) return accessTokenCache.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const unsigned = strToB64url(JSON.stringify(header)) + "." + strToB64url(JSON.stringify(claims));

  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + bytesToB64url(sig);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Google login for database failed: " + JSON.stringify(data));
  }
  accessTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

function dbUrl(env, path) {
  return env.FIREBASE_DATABASE_URL.replace(/\/+$/, "") + "/" + path + ".json";
}

async function dbGet(env, path) {
  const res = await fetch(dbUrl(env, path), {
    headers: { "Authorization": "Bearer " + (await getAccessToken(env)) }
  });
  if (!res.ok) throw new Error("DB read failed: " + res.status + " " + (await res.text()));
  return res.json();
}

async function dbPatch(env, path, obj) {
  const res = await fetch(dbUrl(env, path), {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + (await getAccessToken(env)), "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  });
  if (!res.ok) throw new Error("DB update failed: " + res.status + " " + (await res.text()));
  return res.json();
}

// Safe read-change-write (like Firebase transaction): retries if someone else changed it meanwhile.
// fn returns the new value, or undefined to cancel.
async function dbTransaction(env, path, fn, maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    const token = await getAccessToken(env);
    const getRes = await fetch(dbUrl(env, path), {
      headers: { "Authorization": "Bearer " + token, "X-Firebase-ETag": "true" }
    });
    if (!getRes.ok) throw new Error("DB read failed: " + getRes.status + " " + (await getRes.text()));
    const etag = getRes.headers.get("ETag");
    const current = await getRes.json();

    const next = fn(current === null ? null : current);
    if (next === undefined) return { committed: false, value: current };

    const putRes = await fetch(dbUrl(env, path), {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "if-match": etag
      },
      body: JSON.stringify(next)
    });
    if (putRes.status === 412) continue; // changed meanwhile — try again
    if (!putRes.ok) throw new Error("DB write failed: " + putRes.status + " " + (await putRes.text()));
    return { committed: true, value: next };
  }
  throw new Error("DB busy, please try again");
}
