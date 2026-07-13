module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const auth = Buffer.from(keyId + ':' + keySecret).toString('base64');

    const amountInPaise = 14900; // ₹149

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + auth,
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: 'medsaathi_' + Date.now(),
      }),
    });

    const order = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: 'Order create nahi ho paya', details: order });
      return res.status(500).json({ error: 'Order create nahi ho paya' });
    }

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: keyId,
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Order create nahi ho paya' });
  }
};

