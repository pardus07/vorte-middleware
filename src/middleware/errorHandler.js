/**
 * Global error handling middleware.
 *
 * Catches unhandled errors and returns consistent JSON responses
 * matching the Android app's expected error format.
 */

function errorHandler(err, req, res, _next) {
  const logger = req.log || console;

  // Determine status code
  let statusCode = err.statusCode || err.status || 500;

  // Google API errors
  if (err.message?.includes("429") || err.status === 429) {
    statusCode = 429;
  } else if (err.message?.includes("401") || err.message?.includes("403")) {
    statusCode = 401;
  }

  // Log the error
  logger.error(
    {
      statusCode,
      path: req.path,
      method: req.method,
      deviceId: req.deviceId,
      error: err.message,
      stack: process.env.NODE_ENV !== "production" ? err.stack : undefined,
    },
    "Request error"
  );

  // Return consistent error response (matches Android ChatResponse/SearchResponse format)
  res.status(statusCode).json({
    text: "",
    error: sanitizeErrorMessage(err.message, statusCode),
    model: "",
    input_tokens: 0,
    output_tokens: 0,
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
    text: "",
  });
}

/**
 * Sanitize error messages for client consumption.
 * Removes internal details, keeps user-friendly messages.
 */
function sanitizeErrorMessage(message, statusCode) {
  if (!message) return "Internal server error";

  // Don't leak API key or internal paths
  if (message.includes("API key") || message.includes("api_key")) {
    return "Server configuration error";
  }

  switch (statusCode) {
    case 429:
      return "Rate limit exceeded. Please wait and try again.";
    case 401:
    case 403:
      return "Authentication failed";
    case 400:
      return message; // Client errors are safe to forward
    case 500:
    default:
      return process.env.NODE_ENV === "production"
        ? "Internal server error"
        : message;
  }
}

module.exports = { errorHandler, notFoundHandler };
