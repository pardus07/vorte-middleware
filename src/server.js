/**
 * Vorte AI Asistan — Middleware Proxy Server
 *
 * Routes:
 *   POST /api/chat    — Gemini Chat (text)
 *   POST /api/vision  — Gemini Vision (text + images)
 *   POST /api/search  — Gemini + Google Search Grounding
 *   POST /api/tts     — Gemini TTS (returns audio bytes)
 *   POST /api/embed   — Text Embedding
 *   WS   /api/live    — Gemini Live API (real-time voice)
 *
 * Security: Device token auth, rate limiting, helmet headers
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { createLogger } = require("./middleware/logger");
const { authMiddleware } = require("./middleware/auth");
const { createRateLimiter } = require("./middleware/rateLimiter");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { initGemini } = require("./services/gemini");

// Routes
const chatRoute = require("./routes/chat");
const visionRoute = require("./routes/vision");
const searchRoute = require("./routes/search");
const ttsRoute = require("./routes/tts");
const embedRoute = require("./routes/embed");
const { handleLiveWebSocket } = require("./routes/live");

const logger = createLogger();
const app = express();
const server = http.createServer(app);

// ==================== Validation ====================

if (!process.env.GEMINI_API_KEY) {
  logger.fatal("GEMINI_API_KEY is not set. Exiting.");
  process.exit(1);
}

// ==================== Initialize Gemini ====================

const gemini = initGemini(process.env.GEMINI_API_KEY);

// ==================== Middleware ====================

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" })); // Large for base64 images
app.use(authMiddleware);
app.use(createRateLimiter());

// Attach gemini + logger to request
app.use((req, res, next) => {
  req.gemini = gemini;
  req.log = logger;
  next();
});

// ==================== Health Check ====================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "vorte-middleware",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
  });
});

// ==================== API Routes ====================

app.use("/api/chat", chatRoute);
app.use("/api/vision", visionRoute);
app.use("/api/search", searchRoute);
app.use("/api/tts", ttsRoute);
app.use("/api/embed", embedRoute);

// ==================== WebSocket (Gemini Live) ====================

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  // Only upgrade for /api/live path
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/api/live") {
    socket.destroy();
    return;
  }

  // Auth check for WebSocket
  const authHeader = request.headers["authorization"];
  const token = authHeader?.replace("Bearer ", "");
  const prefix = process.env.ALLOWED_TOKEN_PREFIX || "vrt_";

  if (!token || !token.startsWith(prefix)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    logger.warn({ ip: request.socket.remoteAddress }, "WS auth rejected");
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const deviceId = request.headers["x-device-id"] || "unknown";
  logger.info({ deviceId }, "Live WebSocket connected");
  handleLiveWebSocket(ws, gemini, logger, deviceId);
});

// ==================== Error Handling ====================

app.use(notFoundHandler);
app.use(errorHandler);

// ==================== Start Server ====================

const PORT = parseInt(process.env.PORT || "3000", 10);

server.listen(PORT, "0.0.0.0", () => {
  logger.info(`Vorte Middleware running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
  logger.info(`Endpoints: chat, vision, search, tts, embed, live(ws)`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received. Shutting down gracefully...");
  wss.clients.forEach((client) => client.close(1001, "Server shutting down"));
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  logger.info("SIGINT received. Shutting down...");
  server.close(() => process.exit(0));
});
