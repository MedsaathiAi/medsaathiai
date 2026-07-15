module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const testVar = process.env.TEST_VAR;

    return res.status(200).json({
      message: "NEW CODE WORKING",
      testVar: testVar || null,
      keyIdExists: !!keyId,
      keySecretExists: !!keySecret
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
};
