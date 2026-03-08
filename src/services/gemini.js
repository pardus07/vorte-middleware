/**
 * Google Gemini SDK initialization and model factory.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

/** @type {GoogleGenerativeAI} */
let genAI = null;

/**
 * Initialize the Gemini SDK.
 * @param {string} apiKey
 * @returns {object} Gemini service object with model getters
 */
function initGemini(apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);

  return {
    /**
     * Get a generative model instance.
     * @param {string} modelName e.g. "gemini-2.5-flash"
     * @param {object} [opts] optional config
     */
    getModel(modelName, opts = {}) {
      return genAI.getGenerativeModel({
        model: modelName,
        ...opts,
      });
    },

    /**
     * Get the embedding model.
     * @param {string} modelName default "text-embedding-004"
     */
    getEmbeddingModel(modelName = "text-embedding-004") {
      return genAI.getGenerativeModel({ model: modelName });
    },

    /** Raw SDK reference */
    sdk: genAI,
  };
}

module.exports = { initGemini };
