/**
 * WebSocket /api/live — Gemini Live API Real-time Voice
 *
 * Protocol:
 *
 * Client → Server (text frames):
 *   { type: "setup", language, system_prompt, model, enable_barge_in, voice_name, audio_config }
 *   { type: "text", content }
 *   { type: "barge_in" }
 *
 * Client → Server (binary frames):
 *   Raw PCM audio bytes (16-bit, 16kHz, mono)
 *
 * Server → Client (text frames):
 *   { type: "transcript_partial", content }
 *   { type: "transcript_final", content }
 *   { type: "response_text", content }
 *   { type: "response_end" }
 *   { type: "error", content, code }
 *
 * Server → Client (binary frames):
 *   Raw audio bytes from Gemini (AI speech)
 *
 * Architecture:
 *   Android ↔ This WebSocket ↔ Gemini Live API (via SDK)
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Handle a single WebSocket connection for live voice.
 */
function handleLiveWebSocket(ws, gemini, logger, deviceId) {
  let session = null;
  let isSetup = false;
  let sessionConfig = null;

  // ==================== Client Message Handling ====================

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        // Binary = audio data from microphone
        await handleAudioData(data);
      } else {
        // Text = JSON control message
        const message = JSON.parse(data.toString());
        await handleControlMessage(message);
      }
    } catch (err) {
      logger.error({ deviceId, error: err.message }, "Live WS message error");
      sendJson(ws, {
        type: "error",
        content: err.message || "Processing error",
        code: -1,
      });
    }
  });

  ws.on("close", (code, reason) => {
    logger.info({ deviceId, code }, "Live WS disconnected");
    cleanup();
  });

  ws.on("error", (err) => {
    logger.error({ deviceId, error: err.message }, "Live WS error");
    cleanup();
  });

  // ==================== Control Messages ====================

  async function handleControlMessage(message) {
    switch (message.type) {
      case "setup":
        await setupSession(message);
        break;

      case "text":
        await handleTextInput(message.content);
        break;

      case "barge_in":
        handleBargeIn();
        break;

      default:
        logger.warn({ deviceId, type: message.type }, "Unknown WS message type");
    }
  }

  /**
   * Setup the Gemini Live session.
   */
  async function setupSession(config) {
    if (isSetup) {
      logger.warn({ deviceId }, "Session already setup, ignoring");
      return;
    }

    sessionConfig = config;

    try {
      // Create a Gemini model for the live session
      const modelName = config.model || "gemini-2.5-flash";
      const model = gemini.getModel(modelName, {
        generationConfig: {
          responseModalities: ["AUDIO", "TEXT"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: config.voice_name === "default" ? "Kore" : config.voice_name,
              },
            },
          },
        },
        ...(config.system_prompt
          ? { systemInstruction: config.system_prompt }
          : {}),
      });

      // Start a chat session for the live interaction
      session = model.startChat({
        history: [],
      });

      isSetup = true;

      logger.info(
        {
          deviceId,
          model: modelName,
          language: config.language,
          bargeIn: config.enable_barge_in,
        },
        "Live session setup complete"
      );

      // Notify client that setup is complete
      // (The client transitions to LISTENING state on receiving Connected event)
    } catch (err) {
      logger.error({ deviceId, error: err.message }, "Session setup failed");
      sendJson(ws, {
        type: "error",
        content: `Session setup failed: ${err.message}`,
        code: 500,
      });
    }
  }

  // ==================== Audio Handling ====================

  /**
   * Handle incoming audio data from the microphone.
   * In this implementation, we accumulate audio and process
   * when silence is detected (simplified VAD).
   */
  let audioBuffer = [];
  let silenceTimer = null;
  const SILENCE_TIMEOUT_MS = 1500; // 1.5s of no audio = end of speech

  async function handleAudioData(data) {
    if (!isSetup) return;

    audioBuffer.push(Buffer.from(data));

    // Reset silence timer
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      await processAccumulatedAudio();
    }, SILENCE_TIMEOUT_MS);

    // Send partial transcript indicator
    sendJson(ws, {
      type: "transcript_partial",
      content: "...",
    });
  }

  /**
   * Process accumulated audio: send to Gemini for transcription + response.
   */
  async function processAccumulatedAudio() {
    if (audioBuffer.length === 0 || !session) return;

    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    try {
      // Convert audio to base64 for Gemini
      const audioBase64 = fullAudio.toString("base64");

      // Send audio to Gemini as inline data
      const result = await session.sendMessage([
        {
          inlineData: {
            mimeType: "audio/pcm;rate=16000",
            data: audioBase64,
          },
        },
      ]);

      const response = result.response;

      // Send final transcript (if we got text back)
      const textParts = response.candidates?.[0]?.content?.parts?.filter(
        (p) => p.text
      );

      if (textParts?.length) {
        const responseText = textParts.map((p) => p.text).join("");

        // Send transcript final
        sendJson(ws, {
          type: "transcript_final",
          content: "Ses mesaji",
        });

        // Send response text
        sendJson(ws, {
          type: "response_text",
          content: responseText,
        });
      }

      // Check for audio response
      const audioParts = response.candidates?.[0]?.content?.parts?.filter(
        (p) => p.inlineData?.mimeType?.startsWith("audio/")
      );

      if (audioParts?.length) {
        for (const audioPart of audioParts) {
          const audioData = Buffer.from(audioPart.inlineData.data, "base64");
          // Send binary audio to client
          if (ws.readyState === ws.OPEN) {
            ws.send(audioData);
          }
        }
      }

      // Signal response end
      sendJson(ws, { type: "response_end" });
    } catch (err) {
      logger.error({ deviceId, error: err.message }, "Audio processing failed");
      sendJson(ws, {
        type: "error",
        content: err.message || "Audio processing failed",
        code: -1,
      });
    }
  }

  // ==================== Text Input ====================

  async function handleTextInput(text) {
    if (!session || !text) return;

    try {
      sendJson(ws, {
        type: "transcript_final",
        content: text,
      });

      const result = await session.sendMessage(text);
      const response = result.response;
      const responseText = response.text();

      sendJson(ws, {
        type: "response_text",
        content: responseText,
      });

      // Check for audio
      const audioParts = response.candidates?.[0]?.content?.parts?.filter(
        (p) => p.inlineData?.mimeType?.startsWith("audio/")
      );

      if (audioParts?.length) {
        for (const audioPart of audioParts) {
          const audioData = Buffer.from(audioPart.inlineData.data, "base64");
          if (ws.readyState === ws.OPEN) {
            ws.send(audioData);
          }
        }
      }

      sendJson(ws, { type: "response_end" });
    } catch (err) {
      logger.error({ deviceId, error: err.message }, "Text processing failed");
      sendJson(ws, {
        type: "error",
        content: err.message,
        code: -1,
      });
    }
  }

  // ==================== Barge-in ====================

  function handleBargeIn() {
    logger.debug({ deviceId }, "Barge-in received");
    // Clear any pending audio processing
    audioBuffer = [];
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // ==================== Cleanup ====================

  function cleanup() {
    session = null;
    isSetup = false;
    audioBuffer = [];
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }
}

/**
 * Send a JSON message over WebSocket.
 */
function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

module.exports = { handleLiveWebSocket };
