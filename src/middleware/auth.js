/**
 * Device token authentication middleware.
 *
 * The Android app sends:
 *   Authorization: Bearer vrt_{uuid}
 *   X-Device-Id: {uuid}
 *
 * This middleware validates the token prefix and extracts device info.
 * In production, you'd also check against a device registry DB.
 */

function authMiddleware(req, res, next) {
  // Skip auth for health check
  if (req.path === "/health") {
    return next();
  }

  const authHeader = req.headers["authorization"];
  const deviceId = req.headers["x-device-id"];

  if (!authHeader) {
    return res.status(401).json({
      error: "Authorization header required",
      text: "",
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const prefix = process.env.ALLOWED_TOKEN_PREFIX || "vrt_";

  if (!token.startsWith(prefix)) {
    return res.status(403).json({
      error: "Invalid device token",
      text: "",
    });
  }

  // Attach device info to request
  req.deviceId = deviceId || "unknown";
  req.deviceToken = token;

  next();
}

module.exports = { authMiddleware };
