// /api/create-payment.js
// Creates an Aviagram payment and returns the redirect URL

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, val]) => res.setHeader(key, val));
    return res.status(200).end();
  }

  Object.entries(corsHeaders).forEach(([key, val]) => res.setHeader(key, val));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { orderId, amount, currency, originalCurrency, convertCurrency, paymentMethod } = req.body;

    if (!orderId || !amount || !currency) {
      return res.status(400).json({
        error: "Missing required fields: orderId, amount, currency",
      });
    }

    // Base64 encode clientId:clientSecret
    const credentials = Buffer.from(
      `${process.env.AVIAGRAM_CLIENT_ID}:${process.env.AVIAGRAM_CLIENT_SECRET}`
    ).toString("base64");

    const body = {
      amount: String(amount),
      currency,
      webhook_url: `${process.env.BASE_URL}/api/webhook?secret=${process.env.WEBHOOK_SECRET}`,
    };

    if (paymentMethod) body.payment_method = paymentMethod;
    if (originalCurrency) body.originalCurrency = originalCurrency;
    if (convertCurrency) body.convertCurrency = String(convertCurrency);

    const response = await fetch("https://aviagram.app/api/payment/createForm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Aviagram API error:", response.status, errorText);
      return res.status(502).json({ error: "Payment gateway error", details: errorText });
    }

    const data = await response.json();
    console.log(`Payment created: Aviagram=${data.orderId} Shopify=${orderId}`);

    return res.status(200).json({
      success: true,
      aviagramOrderId: data.orderId,
      redirectUrl: data.redirect_url,
      shopifyOrderId: orderId,
    });
  } catch (error) {
    console.error("Create payment error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
