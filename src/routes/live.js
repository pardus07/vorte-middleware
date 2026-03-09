/**
 * WebSocket /api/live — Gemini Live Voice Pipeline
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
 *   Raw audio bytes from Gemini TTS (AI speech)
 *
 * Architecture:
 *   1. Android records mic → PCM → WebSocket → Middleware
 *   2. Middleware accumulates audio (simplified VAD with silence detection)
 *   3. After silence: PCM → WAV → Gemini generateContent → transcription
 *   4. Transcription → Gemini chat session → AI response text
 *   5. (Optional) AI response → Gemini TTS → audio bytes → Android
 *   6. Android plays audio / shows text
 */

/**
 * Convert raw PCM audio buffer to WAV format by prepending the standard WAV header.
 *
 * @param {Buffer} pcmBuffer  Raw PCM audio bytes (16-bit signed, little-endian)
 * @param {number} sampleRate Sample rate in Hz (e.g., 16000)
 * @param {number} numChannels Number of channels (1 = mono, 2 = stereo)
 * @param {number} bitsPerSample Bits per sample (16)
 * @returns {Buffer} Complete WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const dataSize = pcmBuffer.length;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // WAV header is 44 bytes
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write("RIFF", 0);                          // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);            // ChunkSize
  header.write("WAVE", 8);                           // Format

  // "fmt " sub-chunk
  header.write("fmt ", 12);                          // Subchunk1ID
  header.writeUInt32LE(16, 16);                      // Subchunk1Size (PCM = 16)
  header.writeUInt16LE(1, 20);                       // AudioFormat (PCM = 1)
  header.writeUInt16LE(numChannels, 22);              // NumChannels
  header.writeUInt32LE(sampleRate, 24);               // SampleRate
  header.writeUInt32LE(byteRate, 28);                 // ByteRate
  header.writeUInt16LE(blockAlign, 32);               // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);            // BitsPerSample

  // "data" sub-chunk
  header.write("data", 36);                          // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);                // Subchunk2Size

  return Buffer.concat([header, pcmBuffer]);
}

// New SDK for chat with Google Search grounding
const { GoogleGenAI } = require("@google/genai");

/**
 * Handle a single WebSocket connection for live voice.
 */
function handleLiveWebSocket(ws, gemini, logger, deviceId) {
  let chatSession = null;  // New SDK chat (with search grounding)
  let isSetup = false;
  let sessionConfig = null;
  let isProcessing = false;

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
      logger.error({ deviceId, error: err.message, stack: err.stack }, "Live WS message error");
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
   * Setup the Gemini session.
   * Creates a CHAT session for conversation continuity (text-only, with history).
   * Audio transcription is done separately using generateContent.
   */
  async function setupSession(config) {
    if (isSetup) {
      logger.warn({ deviceId }, "Session already setup, ignoring");
      return;
    }

    sessionConfig = config;

    try {
      // Use new @google/genai SDK for chat with Google Search grounding
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const chatModelName = "gemini-2.5-flash";

      chatSession = ai.chats.create({
        model: chatModelName,
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction: config.system_prompt || "",
          maxOutputTokens: 2048,
          temperature: 0.7,
        },
      });

      isSetup = true;

      logger.info(
        {
          deviceId,
          chatModel: chatModelName,
          language: config.language,
          bargeIn: config.enable_barge_in,
          searchGrounding: true,
        },
        "Live session setup complete (with Google Search)"
      );

      // Client transitions to LISTENING when it receives the Connected event (onOpen)
    } catch (err) {
      logger.error({ deviceId, error: err.message, stack: err.stack }, "Session setup failed");
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
   * Uses simple VAD (Voice Activity Detection) based on RMS amplitude.
   *
   * Key insight: Android sends audio CONTINUOUSLY (including silence),
   * so we can't just use "no data received" as silence detection.
   * Instead, we measure the actual audio level of each chunk.
   */
  let audioBuffer = [];
  let silenceTimer = null;
  let audioChunkCount = 0;
  let speechChunkCount = 0; // chunks with actual speech (above threshold)
  let isSpeaking = false;    // user is currently speaking
  const SILENCE_TIMEOUT_MS = 1200;   // 1.2s of silence after speech = end of utterance
  const MIN_SPEECH_CHUNKS = 3;      // Minimum speech chunks to be considered real speech
  const NOISE_THRESHOLD = 500;      // RMS amplitude threshold for speech detection (16-bit PCM)

  /**
   * Calculate RMS (Root Mean Square) amplitude of 16-bit PCM audio.
   * Returns a value roughly 0-32768; typical silence is < 200, speech > 500.
   */
  function calculateRms(pcmBuffer) {
    if (pcmBuffer.length < 2) return 0;

    let sumOfSquares = 0;
    const sampleCount = Math.floor(pcmBuffer.length / 2);

    for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
      // Read 16-bit signed little-endian sample
      const sample = pcmBuffer.readInt16LE(i);
      sumOfSquares += sample * sample;
    }

    return Math.sqrt(sumOfSquares / sampleCount);
  }

  async function handleAudioData(data) {
    if (!isSetup || isProcessing) return;

    const chunk = Buffer.from(data);
    const rms = calculateRms(chunk);

    const isActiveAudio = rms > NOISE_THRESHOLD;

    if (isActiveAudio) {
      // User is speaking — accumulate audio
      audioBuffer.push(chunk);
      audioChunkCount++;
      speechChunkCount++;
      isSpeaking = true;

      // Reset silence timer when we detect speech
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      // Send partial transcript indicator (throttled)
      if (speechChunkCount % 8 === 1) {
        sendJson(ws, {
          type: "transcript_partial",
          content: "Dinleniyor...",
        });
      }
    } else if (isSpeaking) {
      // User was speaking but now it's silent — keep accumulating
      // (captures trailing silence to avoid cutting off words)
      audioBuffer.push(chunk);
      audioChunkCount++;

      // Start/reset silence countdown
      if (!silenceTimer) {
        silenceTimer = setTimeout(async () => {
          silenceTimer = null;
          isSpeaking = false;

          if (speechChunkCount >= MIN_SPEECH_CHUNKS) {
            logger.info(
              { deviceId, speechChunks: speechChunkCount, totalChunks: audioChunkCount },
              "Speech ended, processing audio"
            );
            await processAccumulatedAudio();
          } else {
            // Too little speech — probably noise, discard
            logger.debug(
              { deviceId, speechChunks: speechChunkCount, rms: Math.round(rms) },
              "Discarding short audio (noise)"
            );
            audioBuffer = [];
            audioChunkCount = 0;
            speechChunkCount = 0;
          }
        }, SILENCE_TIMEOUT_MS);
      }
    }
    // else: silence and user hasn't started speaking — ignore completely
  }

  /**
   * Process accumulated audio:
   * 1. Convert PCM → WAV
   * 2. Send to Gemini for transcription (generateContent with audio)
   * 3. Send transcription to chat session for response
   * 4. Return transcript + response to client
   */
  async function processAccumulatedAudio() {
    if (audioBuffer.length === 0 || !chatSession) return;
    if (isProcessing) return;

    isProcessing = true;

    const fullPcm = Buffer.concat(audioBuffer);
    audioBuffer = [];
    audioChunkCount = 0;
    speechChunkCount = 0;
    isSpeaking = false;

    // Check minimum audio size (at least ~0.2s of audio at 16kHz 16-bit mono = 6400 bytes)
    if (fullPcm.length < 6400) {
      logger.debug({ deviceId, bytes: fullPcm.length }, "Audio too short, skipping");
      isProcessing = false;
      return;
    }

    logger.info({ deviceId, audioBytes: fullPcm.length, durationSec: (fullPcm.length / 32000).toFixed(1) }, "Processing audio");

    // Notify client we're processing
    sendJson(ws, { type: "transcript_partial", content: "İşleniyor..." });

    try {
      // ── Step 1: Convert PCM to WAV ──
      const wavBuffer = pcmToWav(fullPcm, 16000, 1, 16);
      const audioBase64 = wavBuffer.toString("base64");

      // ── Step 2: Transcribe audio using Gemini ──
      const transcribeModel = gemini.getModel("gemini-2.0-flash", {
        generationConfig: {
          maxOutputTokens: 256,
          temperature: 0.1, // Low temperature for accurate transcription
        },
      });

      const transcribeResult = await transcribeModel.generateContent([
        {
          inlineData: {
            mimeType: "audio/wav",
            data: audioBase64,
          },
        },
        {
          text: "Bu ses kaydında kullanıcı ne söylüyor? Sadece söylediğini yaz, başka hiçbir şey ekleme. Eğer ses anlaşılmıyorsa veya sessizse sadece [anlaşılmadı] yaz.",
        },
      ]);

      const transcript = transcribeResult.response.text().trim();

      logger.info({ deviceId, transcript }, "Audio transcribed");

      // Check if transcription is empty or unintelligible
      if (!transcript || transcript === "[anlaşılmadı]" || transcript.length < 2) {
        logger.info({ deviceId }, "Transcription empty or unintelligible, skipping");
        sendJson(ws, { type: "response_end" });
        isProcessing = false;
        return;
      }

      // Send final transcript to client
      sendJson(ws, {
        type: "transcript_final",
        content: transcript,
      });

      // ── Step 3: Send transcription to chat session for AI response ──
      // Uses new @google/genai SDK with Google Search grounding
      const chatResult = await chatSession.sendMessage({ message: transcript });
      const responseText = chatResult.text;

      logger.info({ deviceId, responseLength: responseText.length }, "Chat response generated");

      // Send response text to client
      sendJson(ws, {
        type: "response_text",
        content: responseText,
      });

      // ── Step 4: Generate TTS audio using Gemini REST API ──
      try {
        const audioData = await generateTtsAudio(
          responseText,
          sessionConfig?.voice_name === "default" ? "Kore" : (sessionConfig?.voice_name || "Kore"),
          logger,
          deviceId
        );

        if (audioData && ws.readyState === ws.OPEN) {
          ws.send(audioData);
        }
      } catch (ttsErr) {
        // TTS is optional — don't fail the whole response
        logger.warn({ deviceId, error: ttsErr.message }, "TTS generation failed (non-critical)");
      }

      // Signal response end
      sendJson(ws, { type: "response_end" });
    } catch (err) {
      logger.error({ deviceId, error: err.message, stack: err.stack }, "Audio processing failed");
      sendJson(ws, {
        type: "error",
        content: err.message || "Ses işleme hatası",
        code: -1,
      });
    } finally {
      isProcessing = false;
    }
  }

  // ==================== Text Input ====================

  async function handleTextInput(text) {
    if (!chatSession || !text) return;
    if (isProcessing) return;

    isProcessing = true;

    try {
      sendJson(ws, {
        type: "transcript_final",
        content: text,
      });

      const result = await chatSession.sendMessage({ message: text });
      const responseText = result.text;

      sendJson(ws, {
        type: "response_text",
        content: responseText,
      });

      // Optional TTS for text input responses
      try {
        const audioData = await generateTtsAudio(
          responseText,
          sessionConfig?.voice_name === "default" ? "Kore" : (sessionConfig?.voice_name || "Kore"),
          logger,
          deviceId
        );
        if (audioData && ws.readyState === ws.OPEN) {
          ws.send(audioData);
        }
      } catch (ttsErr) {
        logger.warn({ deviceId, error: ttsErr.message }, "TTS generation failed (non-critical)");
      }

      sendJson(ws, { type: "response_end" });
    } catch (err) {
      logger.error({ deviceId, error: err.message, stack: err.stack }, "Text processing failed");
      sendJson(ws, {
        type: "error",
        content: err.message,
        code: -1,
      });
    } finally {
      isProcessing = false;
    }
  }

  // ==================== Barge-in ====================

  function handleBargeIn() {
    logger.debug({ deviceId }, "Barge-in received");
    // Clear any pending audio processing
    audioBuffer = [];
    audioChunkCount = 0;
    speechChunkCount = 0;
    isSpeaking = false;
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // ==================== Cleanup ====================

  function cleanup() {
    chatSession = null;
    isSetup = false;
    isProcessing = false;
    audioBuffer = [];
    audioChunkCount = 0;
    speechChunkCount = 0;
    isSpeaking = false;
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

/**
 * Generate TTS audio using Gemini REST API.
 * Uses gemini-2.5-flash-preview-tts model for natural Turkish voice.
 * Output: PCM 16-bit, 24kHz, mono.
 *
 * @param {string} text Text to convert to speech
 * @param {string} voiceName Voice name (e.g., "Kore", "Puck", "Aoede")
 * @param {object} logger Pino logger
 * @param {string} deviceId Device identifier for logging
 * @returns {Buffer|null} PCM audio buffer or null on failure
 */
async function generateTtsAudio(text, voiceName = "Kore", logger, deviceId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.error({ deviceId }, "GEMINI_API_KEY not set for TTS");
    return null;
  }

  const ttsModelName = "gemini-2.5-flash-preview-tts";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${ttsModelName}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [{ text: text }]
    }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName }
        }
      }
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    logger.error({ deviceId, status: response.status, body: errText.slice(0, 200) }, "TTS REST API error");
    throw new Error(`TTS API returned ${response.status}`);
  }

  const result = await response.json();
  const audioBase64 = result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!audioBase64) {
    logger.warn({ deviceId }, "No audio data in TTS response");
    return null;
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");
  logger.info({ deviceId, audioBytes: audioBuffer.length, durationSec: (audioBuffer.length / 48000).toFixed(1) }, "Gemini TTS audio generated");
  return audioBuffer;
}

module.exports = { handleLiveWebSocket };
