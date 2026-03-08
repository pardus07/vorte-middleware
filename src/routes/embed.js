/**
 * POST /api/embed — Text Embedding Proxy
 *
 * Request body (from Android EmbedRequest):
 *   { texts[], model }
 *
 * Response (EmbedResponse):
 *   { embeddings[][], error }
 */

const express = require("express");
const { logApiCall } = require("../middleware/logger");

const router = express.Router();

router.post("/", async (req, res, next) => {
  const start = Date.now();
  const {
    texts = [],
    model = "text-embedding-004",
  } = req.body;

  try {
    if (!texts.length) {
      return res.status(400).json({
        embeddings: [],
        error: "texts array is required",
      });
    }

    if (texts.length > 100) {
      return res.status(400).json({
        embeddings: [],
        error: "Maximum 100 texts per request",
      });
    }

    const embeddingModel = req.gemini.getModel(model);

    // Batch embed — process all texts
    const embeddings = [];
    for (const text of texts) {
      const result = await embeddingModel.embedContent(text);
      embeddings.push(result.embedding.values);
    }

    const durationMs = Date.now() - start;
    logApiCall(req.log, {
      endpoint: "/api/embed",
      model,
      durationMs,
      inputTokens: texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
      outputTokens: 0,
      deviceId: req.deviceId,
      success: true,
    });

    res.json({
      embeddings,
      error: null,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    logApiCall(req.log, {
      endpoint: "/api/embed",
      model,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      deviceId: req.deviceId,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
