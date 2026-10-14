// Plan IDs are fixed here on the server — the browser only says "basic", "plus" or "pro"
const PLAN_IDS = {
  basic: "plan_TnR7KL6vdmWqMg", // ₹199 / 3 months, 15 questions per month
  plus:  "plan_TnR92Td51kS8NV", // ₹299 / 3 months, 25 questions per month
  pro:   "plan_TnRA6SRPyDFD7O"  // ₹499 / 3 months, 50 questions per month
};

const TRIAL_DAYS = 7;
const TRIAL_FEE_PAISE = 1500; // ₹15

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

    // Trial ends after 7 days — real billing starts then
    const startAt = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 24 * 60 * 60;

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
        start_at: startAt,
        notes: {
          userId: req.body && req.body.userId ? req.body.userId : "",
          plan: planKey
        },
        addons: [
          {
            item: {
              name: "7 Din Trial",
              amount: TRIAL_FEE_PAISE,
              currency: "INR"
            }
          }
        ]
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
