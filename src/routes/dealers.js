/**
 * Dealer Management Proxy Routes
 *
 * Proxies requests from Android app to Vorte web admin API.
 * Mobile app never accesses vorte.com.tr directly — all requests go through middleware.
 * Middleware adds X-Server-Api-Key header for admin authentication.
 *
 * Routes:
 *   POST   /api/dealers/apply          → POST  vorte.com.tr/api/dealer-application
 *   GET    /api/dealers                → GET   vorte.com.tr/api/admin/dealers
 *   GET    /api/dealers/:id            → GET   vorte.com.tr/api/admin/dealers/:id
 *   PUT    /api/dealers/:id            → PUT   vorte.com.tr/api/admin/dealers/:id
 *   PUT    /api/dealers/:id/approve    → PUT   vorte.com.tr/api/admin/dealers/:id  (status: ACTIVE)
 *   GET    /api/dealers/:id/payments   → GET   vorte.com.tr/api/admin/dealers/:id/payments
 *   POST   /api/dealers/:id/payments   → POST  vorte.com.tr/api/admin/dealers/:id/payments
 *   GET    /api/dealers/:id/orders     → GET   vorte.com.tr/api/admin/dealers/:id/orders
 */

const express = require("express");
const router = express.Router();

const VORTE_WEB_URL = process.env.VORTE_WEB_URL || "https://www.vorte.com.tr";
const VORTE_SERVER_API_KEY = process.env.VORTE_SERVER_API_KEY || "";

/**
 * Forward request to Vorte web API with admin auth header.
 */
async function proxyToWeb(method, path, body, query, log) {
  const url = new URL(path, VORTE_WEB_URL);

  // Append query params
  if (query && Object.keys(query).length > 0) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Server-Api-Key": VORTE_SERVER_API_KEY,
    },
  };

  if (body && (method === "POST" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  log.info({ method, url: url.toString() }, "Proxy → Vorte Web API");

  const response = await fetch(url.toString(), options);
  const data = await response.json();

  if (!response.ok) {
    log.warn(
      { status: response.status, error: data.error || data.message },
      "Vorte Web API error"
    );
  }

  return { status: response.status, data };
}

// ==================== Dealer Application (Public) ====================

/**
 * POST /api/dealers/apply
 * Create a new dealer application (status: PENDING)
 */
router.post("/apply", async (req, res, next) => {
  try {
    const { status, data } = await proxyToWeb(
      "POST",
      "/api/dealer-application",
      req.body,
      null,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

// ==================== Dealer List ====================

/**
 * GET /api/dealers
 * List all dealers with optional filters
 * Query: page, limit, status, search, tier, city, sort
 */
router.get("/", async (req, res, next) => {
  try {
    const { status, data } = await proxyToWeb(
      "GET",
      "/api/admin/dealers",
      null,
      req.query,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

// ==================== Dealer Detail ====================

/**
 * GET /api/dealers/:id
 * Get single dealer details
 */
router.get("/:id", async (req, res, next) => {
  try {
    // Exclude sub-routes
    if (req.params.id === "apply") return next();

    const { status, data } = await proxyToWeb(
      "GET",
      `/api/admin/dealers/${req.params.id}`,
      null,
      null,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

// ==================== Dealer Update ====================

/**
 * PUT /api/dealers/:id
 * Update dealer fields
 */
router.put("/:id", async (req, res, next) => {
  try {
    // Exclude sub-routes
    if (req.params.id === "apply") return next();

    const { status, data } = await proxyToWeb(
      "PUT",
      `/api/admin/dealers/${req.params.id}`,
      req.body,
      null,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

// ==================== Dealer Approve ====================

/**
 * PUT /api/dealers/:id/approve
 * Approve a pending dealer (sets status to ACTIVE)
 */
router.put("/:id/approve", async (req, res, next) => {
  try {
    const { status, data } = await proxyToWeb(
      "PUT",
      `/api/admin/dealers/${req.params.id}`,
      { status: "ACTIVE" },
      null,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

// ==================== Dealer Payments ====================

/**
 * GET /api/dealers/:id/payments
 * Get dealer payment history (cari hesap)
 */
router.get("/:id/payments", async (req, res, next) => {
  try {
    const { status, data } = await proxyToWeb(
      "GET",
      `/api/admin/dealers/${req.params.id}/payments`,
      null,
      req.query,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/dealers/:id/payments
 * Add a payment record
 */
router.post("/:id/payments", async (req, res, next) => {
  try {
    const { status, data } = await proxyToWeb(
      "POST",
      `/api/admin/dealers/${req.params.id}/payments`,
      req.body,
      null,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

// ==================== Dealer Orders ====================

/**
 * GET /api/dealers/:id/orders
 * Get dealer order history
 */
router.get("/:id/orders", async (req, res, next) => {
  try {
    const { status, data } = await proxyToWeb(
      "GET",
      `/api/admin/dealers/${req.params.id}/orders`,
      null,
      req.query,
      req.log
    );
    res.status(status).json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
