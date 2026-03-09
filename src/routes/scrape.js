/**
 * GET  /api/scrape        — Get cached website data (or trigger scrape)
 * POST /api/scrape/refresh — Force refresh the cache
 *
 * Used for debugging and manual cache management.
 */

const express = require("express");
const {
  getWebsiteData,
  buildWebsiteContext,
  invalidateCache,
} = require("../services/websiteScraper");

const router = express.Router();

/**
 * GET /api/scrape
 * Returns the current cached website data (scrapes if cache is empty).
 */
router.get("/", async (req, res, next) => {
  try {
    const data = await getWebsiteData(req.log);
    res.json({
      status: "ok",
      data,
      contextPreview: (await buildWebsiteContext(req.log)).slice(0, 500) + "...",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scrape/refresh
 * Force-refreshes the cache by re-scraping vorte.com.tr.
 */
router.post("/refresh", async (req, res, next) => {
  try {
    req.log.info("Manual cache refresh requested");
    invalidateCache();
    const data = await getWebsiteData(req.log);
    const context = await buildWebsiteContext(req.log);

    res.json({
      status: "ok",
      message: "Cache refreshed successfully",
      productCount: data.products?.length || 0,
      contextLength: context.length,
      scrapedAt: data.scrapedAt,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
