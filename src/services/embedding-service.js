const { pipeline } = require("@xenova/transformers");

class EmbeddingService {
  constructor({ modelId = "Xenova/all-MiniLM-L6-v2" } = {}) {
    this.modelId = modelId;
    this._pipelinePromise = null;
    this._vectorCache = new Map();
  }

  async _getPipeline() {
    if (!this._pipelinePromise) {
      this._pipelinePromise = pipeline("feature-extraction", this.modelId, { quantized: true });
    }
    return this._pipelinePromise;
  }

  async embedText(text = "") {
    const input = String(text || "").trim();
    if (!input) return [];
    const cached = this._vectorCache.get(input);
    if (cached) return cached.slice();
    const extractor = await this._getPipeline();
    const output = await extractor(input, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data || []);
    this._vectorCache.set(input, vector);
    return vector.slice();
  }

  cosineSimilarity(left = [], right = []) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let i = 0; i < left.length; i += 1) {
      const lv = Number(left[i]) || 0;
      const rv = Number(right[i]) || 0;
      dot += lv * rv;
      leftNorm += lv * lv;
      rightNorm += rv * rv;
    }
    if (!leftNorm || !rightNorm) return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }
}

module.exports = { EmbeddingService };
