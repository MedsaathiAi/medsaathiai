// Only one subscription plan now: ₹299 / 3 months, 25 questions per month (no trial)
const PLAN_IDS = {
  plus: "plan_TnR92Td51kS8NV"
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const planKey = req.body && req.body.plan;
    const planId = PLAN_IDS[planKey];
    if (!planId) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan"
      });
    }

    const auth = Buffer.from(
      process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET
    ).toString("base64");

    const response = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + auth
      },
      body: JSON.stringify({
        plan_id: planId,
        total_count: 100,
        quantity: 1,
        customer_notify: 1,
        notes: {
          userId: req.body && req.body.userId ? req.body.userId : "",
          plan: planKey
        }
      })
    });

    const data = await response.json();

    console.log("STATUS:", response.status);
    console.log("RAZORPAY RESPONSE:", JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json({
      success: true,
      subscriptionId: data.id,
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
