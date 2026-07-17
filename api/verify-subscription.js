const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
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
};
