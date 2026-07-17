module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const auth = Buffer.from(
      process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET
    ).toString("base64");

    // Trial ends after 2 months — real billing starts then
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() + 2);
    const startAt = Math.floor(startDate.getTime() / 1000);

    const response = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + auth
      },
      body: JSON.stringify({
        plan_id: "plan_TETbGaTxThu98U",
        total_count: 100,
        quantity: 1,
        customer_notify: 1,
        start_at: startAt,
        notes: { userId: req.body && req.body.userId ? req.body.userId : "" },
        addons: [
          {
            item: {
              name: "Mandate Setup Fee",
              amount: 100,
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
