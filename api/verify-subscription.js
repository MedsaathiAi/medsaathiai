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

// Razorpay plan ID -> plan name (same IDs as create-subscription.js)
const PLAN_BY_ID = {
  "plan_TnR7KL6vdmWqMg": "basic",
  "plan_TnR92Td51kS8NV": "plus",
  "plan_TnRA6SRPyDFD7O": "pro"
};
const TRIAL_DAYS = 7;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    // Check the user is logged in (Firebase login token)
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      return res.status(401).json({
        success: false,
        error: "Invalid login"
      });
    }

    const {
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    const body = razorpay_payment_id + "|" + razorpay_subscription_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: "Signature verification failed"
      });
    }

    // Payment is genuine. Find out which plan it really is from Razorpay (not from the browser)
    const rpAuth = Buffer.from(
      process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET
    ).toString("base64");
    const subRes = await fetch(
      "https://api.razorpay.com/v1/subscriptions/" + encodeURIComponent(razorpay_subscription_id),
      { headers: { "Authorization": "Basic " + rpAuth } }
    );
    const sub = await subRes.json();
    const plan = PLAN_BY_ID[sub && sub.plan_id];
    if (!subRes.ok || !plan) {
      return res.status(400).json({
        success: false,
        error: "Unknown plan"
      });
    }

    const userRef = admin.database().ref("users/" + uid);
    const existing = (await userRef.get()).val() || {};

    // Same subscription verified again: don't restart the trial
    if (existing.subscriptionId === razorpay_subscription_id) {
      await userRef.update({ subscribed: true, autopay: true, plan });
      return res.status(200).json({ success: true });
    }

    // New subscription: 7-day trial with 5 questions starts now
    await userRef.update({
      subscribed: true,
      autopay: true,
      plan,
      subscriptionId: razorpay_subscription_id,
      trialEndsAt: Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
      trialUsed: 0
    });

    return res.status(200).json({
      success: true
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
