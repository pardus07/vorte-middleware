/**
 * Rate limiting middleware.
 *
 * Default: 30 requests per minute per IP.
 * Configurable via RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS env vars.
 */

const rateLimit = require("express-rate-limit");

function createRateLimiter() {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
  const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "30", 10);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Rate limit by device ID if available, otherwise by IP
      return req.deviceId || req.ip;
    },
    handler: (req, res) => {
      res.status(429).json({
        error: "Rate limit exceeded. Please try again later.",
        text: "",
        retry_after_ms: windowMs,
      });
    },
  });
}

module.exports = { createRateLimiter };
