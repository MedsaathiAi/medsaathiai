module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    console.log("KEY_ID:", process.env.RAZORPAY_KEY_ID);
    console.log("SECRET_EXISTS:", !!process.env.RAZORPAY_KEY_SECRET);

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
        amount: 14900,
        currency: "INR",
        receipt: "receipt_" + Date.now()
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
  orderId: data.id,
  amount: data.amount,
  currency: data.currency,
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
