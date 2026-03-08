/**
 * Structured JSON logger using pino.
 *
 * Logs include:
 * - Timestamp, level, message
 * - Request method, path, device ID
 * - Response status, duration
 * - Model used, token counts
 */

const pino = require("pino");

function createLogger() {
  const level = process.env.LOG_LEVEL || "info";
  const isDev = process.env.NODE_ENV !== "production";

  return pino({
    level,
    transport: isDev
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined,
    // Production: raw JSON (Coolify/Docker logs)
    ...(isDev
      ? {}
      : {
          formatters: {
            level: (label) => ({ level: label }),
          },
          timestamp: pino.stdTimeFunctions.isoTime,
        }),
  });
}

/**
 * Log an API call with model info and token usage.
 */
function logApiCall(logger, { endpoint, model, durationMs, inputTokens, outputTokens, deviceId, success, error }) {
  const data = {
    endpoint,
    model,
    durationMs,
    inputTokens,
    outputTokens,
    deviceId,
    success,
  };

  if (success) {
    logger.info(data, `API call: ${endpoint}`);
  } else {
    logger.error({ ...data, error }, `API call failed: ${endpoint}`);
  }
}

module.exports = { createLogger, logApiCall };
