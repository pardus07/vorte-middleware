/**
 * POST /api/chat — Gemini Chat Proxy
 *
 * Request body (from Android ChatRequest):
 *   { messages, model, system_prompt, max_tokens, temperature, cache_id }
 *
 * Response (ChatResponse):
 *   { text, model, input_tokens, output_tokens, finish_reason, cache_id, error }
 */

const express = require("express");
const { logApiCall } = require("../middleware/logger");

const router = express.Router();

router.post("/", async (req, res, next) => {
  const start = Date.now();
  const {
    messages = [],
    model = "gemini-2.5-flash",
    system_prompt = "",
    max_tokens = 2048,
    temperature = 0.7,
    cache_id = null,
  } = req.body;

  try {
    // Validate
    if (!messages.length) {
      return res.status(400).json({
        text: "",
        error: "messages array is required",
        model,
        input_tokens: 0,
        output_tokens: 0,
      });
    }

    // Get Gemini model
    const genModel = req.gemini.getModel(model, {
      generationConfig: {
        maxOutputTokens: max_tokens,
        temperature,
      },
    });

    // Build contents array for Gemini SDK
    const contents = [];

    // System instruction (if provided and no cache)
    let systemInstruction;
    if (system_prompt && !cache_id) {
      systemInstruction = system_prompt;
    }

    // Convert messages to Gemini format
    for (const msg of messages) {
      const role = msg.role === "assistant" ? "model" : "user";
      contents.push({
        role,
        parts: [{ text: msg.content }],
      });
    }

    // Call Gemini
    const chatModel = req.gemini.getModel(model, {
      generationConfig: {
        maxOutputTokens: max_tokens,
        temperature,
      },
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const result = await chatModel.generateContent({ contents });
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata || {};

    const durationMs = Date.now() - start;
    const responseData = {
      text,
      model,
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
      finish_reason: response.candidates?.[0]?.finishReason || "STOP",
      cache_id: null,
      error: null,
    };

    logApiCall(req.log, {
      endpoint: "/api/chat",
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
      endpoint: "/api/chat",
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
