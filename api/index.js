const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Trust Vercel's proxy for accurate client IP tracking (Rate limiting)
app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, or server-to-server)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS Policy Violation: Origin not allowed.'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
  })
);

// Rate Limiter: Prevent brute force / denial of service
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});

app.use('/api/', apiLimiter);

// In-memory store for transaction statuses (In production, replace with Redis or PostgreSQL)
const transactionStore = new Map();

async function getDarajaToken() {
  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  const env = process.env.DARAJA_ENV || 'sandbox'; // 'sandbox' or 'production'

  if (!consumerKey || !consumerSecret) {
    throw new Error('M-Pesa Consumer Credentials missing in environment variables.');
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const baseUrl =
    env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

  const response = await axios.get(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 10000
    }
  );

  return {
    token: response.data.access_token,
    baseUrl
  };
}

app.post('/api/v1/mpesa/qr/generate', async (req, res) => {
  try {
    const { amount, ref } = req.body;

    // Strict Input Validation
    const parsedAmount = Math.floor(Number(amount));
    if (isNaN(parsedAmount) || parsedAmount < 1 || parsedAmount > 300000) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Must be an integer between 1 and 300,000.'
      });
    }

    // Sanitize Reference String (alphanumeric only, max 12 chars)
    const sanitizedRef = (ref || `DON${Date.now()}`)
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 12)
      .toUpperCase();

    const { token, baseUrl } = await getDarajaToken();

    const payload = {
      MerchantName: process.env.MERCHANT_NAME || 'Art of Music',
      RefNo: sanitizedRef,
      Amount: parsedAmount,
      TrxCode: process.env.PAYMENT_TYPE || 'PB',
      CPI: process.env.BUSINESS_SHORT_CODE,
      Size: '300'
    };

    const darajaRes = await axios.post(
      `${baseUrl}/mpesa/qrcode/v1/generate`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (darajaRes.data.ResponseCode === '00') {
      // Register pending transaction in store
      transactionStore.set(sanitizedRef, {
        status: 'PENDING',
        amount: parsedAmount,
        createdAt: Date.now()
      });

      return res.status(200).json({
        success: true,
        qrCodeBase64: darajaRes.data.QRCode,
        transactionRef: sanitizedRef
      });
    }

    return res.status(500).json({
      success: false,
      message: darajaRes.data.ResponseDescription || 'M-Pesa QR generation failed.'
    });
  } catch (error) {
    console.error('[QR Generation Error]:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to process M-Pesa QR request.'
    });
  }
});

// -----------------------------------------------------------------------------
// 4. ENDPOINT: PAYMENT STATUS POLLING (For Squarespace Frontend)
// -----------------------------------------------------------------------------
app.get('/api/v1/mpesa/qr/status', (req, res) => {
  const { ref } = req.query;

  if (!ref) {
    return res.status(400).json({ success: false, message: 'Missing reference.' });
  }

  const record = transactionStore.get(ref);

  if (!record) {
    return res.json({ paid: false, status: 'NOT_FOUND' });
  }

  if (record.status === 'COMPLETED') {
    return res.json({ paid: true, status: 'COMPLETED', receipt: record.receipt });
  }

  return res.json({ paid: false, status: record.status });
});

// -----------------------------------------------------------------------------
// 5. ENDPOINT: C2B WEBHOOK CONFIRMATION (From Safaricom)
// -----------------------------------------------------------------------------
app.post('/api/v1/mpesa/c2b/confirmation', (req, res) => {
  try {
    const c2bData = req.body;
    const accountRef = (c2bData.BillRefNumber || '').trim().toUpperCase();
    const receiptNo = c2bData.TransID;

    if (accountRef && transactionStore.has(accountRef)) {
      const existing = transactionStore.get(accountRef);
      transactionStore.set(accountRef, {
        ...existing,
        status: 'COMPLETED',
        receipt: receiptNo,
        updatedAt: Date.now()
      });
    }

    // Always respond quickly to Safaricom with accepted status
    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  } catch (err) {
    console.error('[C2B Webhook Error]:', err.message);
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// Export for Vercel
module.exports = app;

// Local Development Server listener
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on http://localhost:${PORT}`);
  });
}