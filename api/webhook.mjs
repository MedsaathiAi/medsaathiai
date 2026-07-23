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

export async function POST(request) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-razorpay-signature");

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const event = JSON.parse(rawBody);
    console.log("WEBHOOK EVENT:", event.event);

    if (event.event === "subscription.charged" || event.event === "subscription.activated") {
      const subscriptionEntity = event.payload.subscription.entity;
      const notes = subscriptionEntity.notes || {};
      const userId = notes.userId;

      if (userId) {
        await admin.database().ref("users/" + userId).update({
          subscribed: true
        });
        console.log("Updated Firebase for user:", userId);
      }
    }

    if (event.event === "subscription.cancelled" || event.event === "subscription.halted") {
      const subscriptionEntity = event.payload.subscription.entity;
      const notes = subscriptionEntity.notes || {};
      const userId = notes.userId;

      if (userId) {
        await admin.database().ref("users/" + userId).update({
          subscribed: false
        });
        console.log("Subscription cancelled/halted for user:", userId);
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
