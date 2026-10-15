import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

// Question packs — prices fixed here on the server
const PACKS = {
  s: { amount: 4900,  questions: 10 }, // ₹49  — 10 sawaal, 1 mahina
  m: { amount: 9900,  questions: 20 }, // ₹99  — 20 sawaal, 2 mahine
  l: { amount: 19900, questions: 45 }  // ₹199 — 45 sawaal, 2 mahine
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

    const packKey = req.body && req.body.pack;
    const pack = PACKS[packKey];
    if (!pack) return res.status(400).json({ success: false, error: "Invalid pack" });

    const auth = Buffer.from(
      process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET
    ).toString("base64");

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + auth
      },
      body: JSON.stringify({
        amount: pack.amount,
        currency: "INR",
        receipt: "pack_" + packKey + "_" + Date.now(),
        notes: { userId: uid, pack: packKey }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("RAZORPAY ORDER ERROR:", JSON.stringify(data));
      return res.status(response.status).json(data);
    }

    return res.status(200).json({
      success: true,
      orderId: data.id,
      amount: data.amount,
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
