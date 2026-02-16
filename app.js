require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const axios = require("axios");
const { Server } = require("socket.io");
const { BakongKHQR, khqrData, MerchantInfo } = require("bakong-khqr");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(cors());
app.use(express.json());
      
const server = http.createServer(app);
const io = new Server(server, {
  path: "/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});
              
// CONFIGURATION
const TOKEN = process.env.BAKONG_TOKEN?.trim() || null;
const MERCHANT_ID = process.env.BAKONG_MERCHANT_ID?.trim() || null;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const BAKONG_ENABLED = !!(TOKEN && MERCHANT_ID);

// EXPANDED PRODUCT CATALOG (Sync this with Frontend for Display)
const productsCatalog = [
    { id: 1, name: "Nike Air Max", category: "Shoes", price: 100 },
    { id: 2, name: "Adidas Ultraboost", category: "Shoes", price: 100 },
    { id: 3, name: "Classic White Tee", category: "Apparel", price: 100 },
    { id: 4, name: "Urban Hoodie", category: "Apparel", price: 100 },
    { id: 5, name: "Smart Watch Series 7", category: "Electronics", price: 250 },
    { id: 6, name: "Wireless Headphones", category: "Electronics", price: 150 },
    { id: 7, name: "Denim Jacket", category: "Apparel", price: 120 },
    { id: 8, name: "Leather Wallet", category: "Accessories", price: 50 },
];

const pendingOrders = new Map();
const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }) : null;

// --- API ROUTES ---

app.post("/api/create-order", (req, res) => {
  try {
    const { customer, cart } = req.body;
    if (!customer || !cart || cart.length === 0) return res.status(400).json({ error: "Invalid data" });

    // 1. Calculate Total (Server Side Security)
    const amountKHR = cart.reduce((sum, item) => {
      const product = productsCatalog.find(p => p.id === item.id);
      return product ? sum + (product.price * item.qty) : sum;
    }, 0);

    if (amountKHR <= 0) return res.status(400).json({ error: "Invalid total" });

    // 2. Generate QR Data
    const billNumber = "INV-" + Date.now();
    // SET EXPIRATION: Current Time + 5 Minutes
    const expirationTimestamp = Date.now() + (5 * 60 * 1000); 
    
    let qrString = "mock_qr_string_testing";
    let md5 = "mock_md5_" + Date.now();

    if (BAKONG_ENABLED) {
      const optionalData = {
        currency: khqrData.currency.khr,
        amount: amountKHR,
        billNumber,
        storeLabel: "Sokpheak Store",
        terminalLabel: "POS-001",
        expirationTimestamp: expirationTimestamp // Bakong Logic
      };

      const merchantInfo = new MerchantInfo(
        MERCHANT_ID, "Sokpheak Store", "Phnom Penh", "POS001", "DEV_BANK", optionalData
      );

      const khqr = new BakongKHQR();
      const result = khqr.generateMerchant(merchantInfo);
      
      if (result && result.data) {
        qrString = result.data.qr;
        md5 = result.data.md5;
      }
    }

    // 3. Store Order
    pendingOrders.set(md5, { customer, cart, amount: amountKHR, billNumber });

    // 4. Send Response with Expiry Time for Frontend Countdown
    res.json({ qrString, md5, amountKHR, expireAt: expirationTimestamp });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/api/check-status", async (req, res) => {
  const { md5 } = req.body;
  if (!md5) return res.status(400).json({ error: "MD5 missing" });

  // If mock mode, return pending (wait for socket or manual trigger)
  if (!BAKONG_ENABLED) return res.json({ status: "pending" });

  try {
    const response = await axios.post(
      "https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5",
      { md5, merchantId: MERCHANT_ID },
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    if (response.data && response.data.responseCode === 0) {
      handleSuccess(md5);
      return res.json({ status: "success" });
    }
  } catch (e) { /* ignore error */ }

  res.json({ status: "pending" });
});

function handleSuccess(md5) {
  if (!pendingOrders.has(md5)) return;
  const order = pendingOrders.get(md5);

  io.emit("payment-success", { md5 });

  if (bot && TELEGRAM_CHAT_ID) {
    const items = order.cart.map(i => `- ${i.name} (${i.qty})`).join("\n");
    bot.sendMessage(TELEGRAM_CHAT_ID, 
      `✅ *Payment Received!*\nTotal: ${order.amount} KHR\nFrom: ${order.customer.name}\n\nItems:\n${items}`, 
      { parse_mode: "Markdown" }
    );
  }
  pendingOrders.delete(md5);
}

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));