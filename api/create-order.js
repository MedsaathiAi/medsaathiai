module.exports = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: "API WORKING",
      method: req.method,
      env: {
        RAZORPAY_KEY_ID: !!process.env.RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: !!process.env.RAZORPAY_KEY_SECRET,
        TEST_VAR: process.env.TEST_VAR || null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
    });
  }
};
