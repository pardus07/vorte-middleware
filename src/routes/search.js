/**
 * POST /api/search — Gemini + Google Search Grounding
 *
 * Request body (from Android SearchRequest):
 *   { query, model, system_prompt }
 *
 * Response (SearchResponse):
 *   { text, sources[], model, input_tokens, output_tokens, error }
 */

const express = require("express");
const { logApiCall } = require("../middleware/logger");

const router = express.Router();

router.post("/", async (req, res, next) => {
  const start = Date.now();
  const {
    query = "",
    model = "gemini-2.5-flash",
    system_prompt = "",
  } = req.body;

  try {
    if (!query) {
      return res.status(400).json({
        text: "",
        sources: [],
        error: "query is required",
        model,
        input_tokens: 0,
        output_tokens: 0,
      });
    }

    // Enable Google Search Grounding via tools
    const genModel = req.gemini.getModel(model, {
      ...(system_prompt ? { systemInstruction: system_prompt } : {}),
      tools: [{ googleSearch: {} }],
    });

    const result = await genModel.generateContent(query);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata || {};

    // Extract grounding sources
    const sources = [];
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web?.uri) {
          sources.push(chunk.web.uri);
        }
      }
    }

    const durationMs = Date.now() - start;
    const responseData = {
      text,
      sources,
      model,
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
      error: null,
    };

    logApiCall(req.log, {
      endpoint: "/api/search",
      model,
      durationMs,
      inputTokens: responseData.input_tokens,
      outputTokens: responseData.output_tokens,
      deviceId: req.deviceId,
      success: true,
    });

    res.json(responseData);
  } catch (err) {
    const durationMs = Date.now() - start;
    logApiCall(req.log, {
      endpoint: "/api/search",
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
