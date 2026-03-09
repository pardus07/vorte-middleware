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
    const model = req.gemini.getModel("gemini-2.5-flash-preview-tts", {
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

    const prompt = `Asagidaki Turkce metni dogal ve sicak bir tonla sesli oku:\n\n${text}`;

    const result = await model.generateContent(prompt);
    const response = result.response;

    // Check for inline audio data
    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find(
      (p) => p.inlineData?.mimeType?.startsWith("audio/")
    );

    if (audioPart?.inlineData?.data) {
      // Diagnostic logging
      const rawData = audioPart.inlineData.data;
      const dataType = typeof rawData;
      const mimeType = audioPart.inlineData.mimeType;
      req.log.info({
        tts_diag: true,
        mimeType,
        dataType,
        dataLength: rawData.length,
        isString: dataType === "string",
        first40chars: dataType === "string" ? rawData.substring(0, 40) : "N/A",
      }, "TTS audio diagnostic");

      const audioBuffer = Buffer.from(rawData, "base64");

      // Log decoded buffer info
      const first20hex = audioBuffer.slice(0, 20).toString("hex");
      // Find first non-zero byte
      let firstNonZero = -1;
      for (let i = 0; i < Math.min(audioBuffer.length, 1000); i++) {
        if (audioBuffer[i] !== 0) { firstNonZero = i; break; }
      }
      req.log.info({
        tts_diag: true,
        bufferLength: audioBuffer.length,
        first20hex,
        firstNonZeroByte: firstNonZero,
        durationEstSec: (audioBuffer.length / (24000 * 2)).toFixed(1),
      }, "TTS decoded buffer diagnostic");

      const durationMs = Date.now() - start;
      logApiCall(req.log, {
        endpoint: "/api/tts",
        model: "gemini-2.5-flash-preview-tts",
        durationMs,
        inputTokens: 0,
        outputTokens: 0,
        deviceId: req.deviceId,
        success: true,
      });

      res.set("Content-Type", mimeType || "audio/pcm");
      res.set("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } else {
      // No audio data — return 204
      const durationMs = Date.now() - start;
      logApiCall(req.log, {
        endpoint: "/api/tts",
        model: "gemini-2.5-flash-preview-tts",
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
      model: "gemini-2.5-flash-preview-tts",
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
