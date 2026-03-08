/**
 * POST /api/vision — Gemini Vision Proxy
 *
 * Request body (from Android VisionRequest):
 *   { messages, images (base64[]), model, system_prompt, max_tokens }
 *
 * Response (ChatResponse):
 *   { text, model, input_tokens, output_tokens, finish_reason, error }
 */

const express = require("express");
const { logApiCall } = require("../middleware/logger");

const router = express.Router();

router.post("/", async (req, res, next) => {
  const start = Date.now();
  const {
    messages = [],
    images = [],
    model = "gemini-2.5-flash",
    system_prompt = "",
    max_tokens = 2048,
  } = req.body;

  try {
    if (!messages.length && !images.length) {
      return res.status(400).json({
        text: "",
        error: "messages or images required",
        model,
        input_tokens: 0,
        output_tokens: 0,
      });
    }

    const genModel = req.gemini.getModel(model, {
      generationConfig: { maxOutputTokens: max_tokens },
      ...(system_prompt ? { systemInstruction: system_prompt } : {}),
    });

    // Build multimodal content
    const parts = [];

    // Add text from messages
    for (const msg of messages) {
      parts.push({ text: `${msg.role}: ${msg.content}` });
    }

    // Add images as inline data
    for (const imgBase64 of images) {
      // Detect MIME type from base64 header or default to jpeg
      let mimeType = "image/jpeg";
      let data = imgBase64;

      if (imgBase64.startsWith("data:")) {
        const match = imgBase64.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          data = match[2];
        }
      }

      parts.push({
        inlineData: { mimeType, data },
      });
    }

    const result = await genModel.generateContent({ contents: [{ parts }] });
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
      error: null,
    };

    logApiCall(req.log, {
      endpoint: "/api/vision",
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
      endpoint: "/api/vision",
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
