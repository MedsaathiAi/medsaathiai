import crypto from "crypto";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

// Must match create-order.js
const PACKS = {
  s: { amount: 4900,  questions: 10, days: 30 }, // ₹49  — 1 mahina
  m: { amount: 9900,  questions: 20, days: 60 }, // ₹99  — 2 mahine
  l: { amount: 19900, questions: 45, days: 60 }  // ₹199 — 2 mahine
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Check the user is logged in
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, error: "Login required" });

    let uid;
    try {
      uid = (await admin.auth().verifyIdToken(idToken)).uid;
    } catch (e) {
      return res.status(401).json({ success: false, error: "Invalid login" });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    // Check the payment is genuine
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, error: "Signature verification failed" });
    }

    // Read the order from Razorpay (not from the browser) to know which pack was paid for
    const rpAuth = Buffer.from(
      process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET
    ).toString("base64");
    const orderRes = await fetch(
      "https://api.razorpay.com/v1/orders/" + encodeURIComponent(razorpay_order_id),
      { headers: { "Authorization": "Basic " + rpAuth } }
    );
    const order = await orderRes.json();
    const packKey = order && order.notes && order.notes.pack;
    const pack = PACKS[packKey];

    if (!orderRes.ok || !pack || order.amount !== pack.amount) {
      return res.status(400).json({ success: false, error: "Unknown pack" });
    }
    if (order.notes.userId !== uid) {
      return res.status(403).json({ success: false, error: "Order belongs to another user" });
    }

    // Add the pack once (same order verified again does nothing)
    const packRef = admin.database().ref("users/" + uid + "/packs/" + razorpay_order_id);
    await packRef.transaction((existing) => {
      if (existing) return; // already added
      return {
        pack: packKey,
        left: pack.questions,
        total: pack.questions,
        boughtAt: Date.now(),
        expiresAt: Date.now() + pack.days * 24 * 60 * 60 * 1000,
        paymentId: razorpay_payment_id
      };
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
