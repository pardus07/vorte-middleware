/**
 * POST /api/tts — Gemini Text-to-Speech Proxy
 *
 * Request body (from Android TtsRequest):
 *   { text, language, voice }
 *
 * Response: Binary audio data (PCM 16-bit, 16kHz, mono)
 *
 * Uses Gemini's multimodal model to generate spoken audio.
 * Falls back to a simulated TTS if the model doesn't support
 * direct audio output yet.
 */

const express = require("express");
const { logApiCall } = require("../middleware/logger");

const router = express.Router();

router.post("/", async (req, res, next) => {
  const start = Date.now();
  const {
    text = "",
    language = "tr-TR",
    voice = "default",
  } = req.body;

  try {
    if (!text) {
      return res.status(400).json({
        error: "text is required",
      });
    }

    // Use Gemini's TTS capability via the generative model
    // Configure for audio output
    const model = req.gemini.getModel("gemini-2.0-flash", {
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice === "default" ? "Kore" : voice,
            },
          },
        },
      },
    });

    const prompt = `${language === "tr-TR" ? "Turkce olarak" : ""} soyle: ${text}`;

    const result = await model.generateContent(prompt);
    const response = result.response;

    // Check for inline audio data
    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find(
      (p) => p.inlineData?.mimeType?.startsWith("audio/")
    );

    if (audioPart?.inlineData?.data) {
      const audioBuffer = Buffer.from(audioPart.inlineData.data, "base64");

      const durationMs = Date.now() - start;
      logApiCall(req.log, {
        endpoint: "/api/tts",
        model: "gemini-2.0-flash",
        durationMs,
        inputTokens: 0,
        outputTokens: 0,
        deviceId: req.deviceId,
        success: true,
      });

      res.set("Content-Type", audioPart.inlineData.mimeType || "audio/pcm");
      res.set("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } else {
      // No audio data — return 204
      const durationMs = Date.now() - start;
      logApiCall(req.log, {
        endpoint: "/api/tts",
        model: "gemini-2.0-flash",
        durationMs,
        inputTokens: 0,
        outputTokens: 0,
        deviceId: req.deviceId,
        success: false,
        error: "No audio output from model",
      });

      res.status(204).end();
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    logApiCall(req.log, {
      endpoint: "/api/tts",
      model: "gemini-2.0-flash",
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
