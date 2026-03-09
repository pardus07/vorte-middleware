/**
 * Vorte Website Scraper Service
 *
 * Scrapes vorte.com.tr to extract product catalog, prices, company info.
 * Caches results in memory with TTL to avoid excessive requests.
 *
 * Used by the AI assistant to answer product/price questions with REAL
 * website data instead of hallucinating or using Google Search.
 *
 * Architecture:
 *   - On first request (or cache expiry): fetches & parses HTML pages
 *   - Caches parsed data in memory (default TTL: 1 hour)
 *   - Returns structured data for injection into AI context
 */

const cheerio = require("cheerio");

// ==================== Configuration ====================

const BASE_URL = "https://vorte.com.tr";

const PAGES_TO_SCRAPE = [
  { url: "/", key: "homepage", label: "Ana Sayfa" },
  { url: "/erkek", key: "men", label: "Erkek Ürünleri" },
  { url: "/kadin", key: "women", label: "Kadın Ürünleri" },
  { url: "/hakkimizda", key: "about", label: "Hakkımızda" },
  { url: "/iletisim", key: "contact", label: "İletişim" },
  { url: "/toptan-satis", key: "wholesale", label: "Toptan Satış" },
];

// Cache TTL: 1 hour (in milliseconds)
const CACHE_TTL_MS = 60 * 60 * 1000;

// ==================== Cache ====================

let cachedData = null;
let cacheTimestamp = 0;
let isScraping = false;
let scrapePromise = null;

// ==================== Public API ====================

/**
 * Get the full website data (cached).
 * Returns structured product catalog, company info, etc.
 *
 * @param {object} logger - Pino logger instance
 * @returns {Promise<WebsiteData>} Parsed website data
 */
async function getWebsiteData(logger) {
  const now = Date.now();

  // Return cached data if still fresh
  if (cachedData && (now - cacheTimestamp) < CACHE_TTL_MS) {
    logger?.debug("Using cached website data");
    return cachedData;
  }

  // If already scraping, wait for it to finish
  if (isScraping && scrapePromise) {
    logger?.debug("Scrape already in progress, waiting...");
    return scrapePromise;
  }

  // Start new scrape
  isScraping = true;
  scrapePromise = scrapeAllPages(logger)
    .then((data) => {
      cachedData = data;
      cacheTimestamp = Date.now();
      isScraping = false;
      scrapePromise = null;
      return data;
    })
    .catch((err) => {
      isScraping = false;
      scrapePromise = null;
      logger?.error({ error: err.message }, "Website scrape failed");
      // Return stale cache if available
      if (cachedData) {
        logger?.warn("Returning stale cached data after scrape failure");
        return cachedData;
      }
      throw err;
    });

  return scrapePromise;
}

/**
 * Build a text context string from website data.
 * This is injected into the AI system prompt / chat context.
 *
 * @param {object} logger - Pino logger instance
 * @returns {Promise<string>} Formatted text context
 */
async function buildWebsiteContext(logger) {
  try {
    const data = await getWebsiteData(logger);
    return formatAsContext(data);
  } catch (err) {
    logger?.error({ error: err.message }, "Failed to build website context");
    return "WEB SİTESİ VERİLERİ: Şu anda web sitesine erişilemiyor.";
  }
}

/**
 * Force refresh the cache (e.g., after product update).
 */
function invalidateCache() {
  cachedData = null;
  cacheTimestamp = 0;
}

// ==================== Scraping Logic ====================

/**
 * Scrape all pages and aggregate data.
 */
async function scrapeAllPages(logger) {
  logger?.info("Starting website scrape of vorte.com.tr");
  const startTime = Date.now();

  const results = {};

  for (const page of PAGES_TO_SCRAPE) {
    try {
      const html = await fetchPage(page.url, logger);
      results[page.key] = parsePage(html, page.key, logger);
      logger?.debug({ page: page.key, url: page.url }, "Page scraped successfully");
    } catch (err) {
      logger?.warn({ page: page.key, url: page.url, error: err.message }, "Failed to scrape page");
      results[page.key] = null;
    }
  }

  // Also try to scrape individual product pages found in category pages
  const productUrls = extractProductUrls(results);
  const productDetails = [];

  for (const productUrl of productUrls) {
    try {
      const html = await fetchPage(productUrl, logger);
      const detail = parseProductDetailPage(html, logger);
      if (detail) {
        productDetails.push(detail);
      }
    } catch (err) {
      logger?.debug({ url: productUrl, error: err.message }, "Failed to scrape product detail");
    }
  }

  const elapsed = Date.now() - startTime;
  logger?.info(
    { elapsed, pageCount: PAGES_TO_SCRAPE.length, productCount: productDetails.length },
    "Website scrape complete"
  );

  return {
    scrapedAt: new Date().toISOString(),
    products: mergeProductData(results, productDetails),
    company: extractCompanyInfo(results),
    wholesale: extractWholesaleInfo(results),
    contact: extractContactInfo(results),
  };
}

/**
 * Fetch a page's HTML content.
 */
async function fetchPage(path, logger) {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "VorteAIAsistan/1.0 (Internal Product Scraper)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "tr-TR,tr;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

/**
 * Parse a page based on its key.
 */
function parsePage(html, pageKey, logger) {
  const $ = cheerio.load(html);

  switch (pageKey) {
    case "homepage":
      return parseHomepage($, logger);
    case "men":
    case "women":
      return parseCategoryPage($, pageKey, logger);
    case "about":
      return parseAboutPage($, logger);
    case "contact":
      return parseContactPage($, logger);
    case "wholesale":
      return parseWholesalePage($, logger);
    default:
      return { rawText: $("main, .content, article, body").text().trim().slice(0, 2000) };
  }
}

// ==================== Page Parsers ====================

function parseHomepage($, logger) {
  const products = [];
  const featuredInfo = [];

  // Extract product cards
  $('[class*="product"], [class*="card"], [data-product]').each((_, el) => {
    const product = extractProductFromElement($, el);
    if (product.name) {
      products.push(product);
    }
  });

  // Extract featured/promotional text
  $('[class*="hero"], [class*="banner"], [class*="feature"], [class*="benefit"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 5 && text.length < 500) {
      featuredInfo.push(text);
    }
  });

  // If no structured products found, try a broader approach
  if (products.length === 0) {
    products.push(...extractProductsFromText($));
  }

  return { products, featuredInfo };
}

function parseCategoryPage($, category, logger) {
  const products = [];

  // Try multiple selectors for product cards
  const selectors = [
    '[class*="product"]',
    '[class*="card"]',
    '[data-product]',
    'article',
    '.grid > div',
    '[class*="item"]',
  ];

  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const product = extractProductFromElement($, el);
      if (product.name && !seen.has(product.name)) {
        seen.add(product.name);
        product.category = category === "men" ? "Erkek" : "Kadın";
        products.push(product);
      }
    });

    if (products.length > 0) break;
  }

  // Fallback: extract from text
  if (products.length === 0) {
    products.push(...extractProductsFromText($, category));
  }

  return { products, category };
}

function parseAboutPage($, logger) {
  const sections = [];

  $("main, .content, article, .about, [class*='about']").each((_, el) => {
    $("p, h1, h2, h3, h4, li", el).each((_, child) => {
      const text = $(child).text().trim();
      if (text && text.length > 3) {
        sections.push(text);
      }
    });
  });

  // Fallback
  if (sections.length === 0) {
    const bodyText = $("body").text().trim();
    if (bodyText) {
      sections.push(bodyText.slice(0, 2000));
    }
  }

  return { sections };
}

function parseContactPage($, logger) {
  const info = {};

  // Extract structured contact data
  const fullText = $("body").text();

  // Phone
  const phoneMatch = fullText.match(/(?:\+90|0)\s*[\d\s]{10,13}/);
  if (phoneMatch) info.phone = phoneMatch[0].trim();

  // Email
  const emailMatch = fullText.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) info.email = emailMatch[0];

  // Address - look for common Turkish address patterns
  $('[class*="address"], address, [class*="location"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 10) {
      info.address = text;
    }
  });

  // Working hours
  const hoursMatch = fullText.match(/(?:Pazartesi|Hafta içi|Çalışma)[^.]*(?:\d{2}:\d{2}[^.]*)/i);
  if (hoursMatch) info.workingHours = hoursMatch[0].trim();

  // Social media links
  info.socialMedia = [];
  $('a[href*="instagram"], a[href*="facebook"], a[href*="twitter"], a[href*="linkedin"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) info.socialMedia.push(href);
  });

  return info;
}

function parseWholesalePage($, logger) {
  const sections = [];

  $("main, .content, article, [class*='wholesale'], [class*='toptan']").each((_, el) => {
    $("p, h1, h2, h3, h4, li, dt, dd", el).each((_, child) => {
      const text = $(child).text().trim();
      if (text && text.length > 3) {
        sections.push(text);
      }
    });
  });

  return { sections };
}

// ==================== Product Extraction ====================

function extractProductFromElement($, el) {
  const $el = $(el);
  const product = {};

  // Name: look for headings, title attributes, specific classes
  const nameEl = $el.find('h2, h3, h4, [class*="name"], [class*="title"]').first();
  product.name = nameEl.text()?.trim() || $el.attr("data-name") || "";

  // Price: look for price elements
  const priceEl = $el.find('[class*="price"], [class*="fiyat"]').first();
  let priceText = priceEl.text()?.trim() || "";

  // Also check for price in data attributes
  if (!priceText) {
    priceText = $el.attr("data-price") || "";
  }

  // Parse price value
  const priceMatch = priceText.match(/[\d.,]+/);
  if (priceMatch) {
    product.price = priceMatch[0].replace(".", "").replace(",", ".");
    product.priceFormatted = `₺${priceMatch[0]}`;
  }

  // URL
  const linkEl = $el.find("a").first();
  product.url = linkEl.attr("href") || "";

  // Image
  const imgEl = $el.find("img").first();
  product.image = imgEl.attr("src") || imgEl.attr("data-src") || "";

  // Description
  const descEl = $el.find('[class*="desc"], [class*="description"], p').first();
  product.description = descEl.text()?.trim() || "";

  // Sizes (look for size buttons/options)
  const sizes = [];
  $el.find('[class*="size"], [class*="beden"], option, [class*="variant"]').each((_, sizeEl) => {
    const sizeText = $(sizeEl).text()?.trim();
    if (sizeText && /^(X{0,2}S|S|M|L|XL|XXL|2XL|3XL|\d{2,3})$/i.test(sizeText)) {
      sizes.push(sizeText.toUpperCase());
    }
  });
  if (sizes.length > 0) {
    product.sizes = [...new Set(sizes)];
  }

  // Colors
  const colors = [];
  $el.find('[class*="color"], [class*="renk"]').each((_, colorEl) => {
    const colorText = $(colorEl).text()?.trim() || $(colorEl).attr("title") || "";
    if (colorText && colorText.length < 30) {
      colors.push(colorText);
    }
  });
  if (colors.length > 0) {
    product.colors = colors;
  }

  return product;
}

/**
 * Fallback: extract products from page text when structured elements aren't found.
 */
function extractProductsFromText($, category) {
  const products = [];
  const bodyText = $("body").text();

  // Look for price patterns: "₺149,90" or "149,90 TL"
  const priceRegex = /([A-Za-zÇçĞğıİÖöŞşÜü\s-]+)\s*(?:₺|TL\s*)?([\d.,]+)\s*(?:₺|TL)?/g;
  let match;

  while ((match = priceRegex.exec(bodyText)) !== null) {
    const name = match[1].trim();
    const price = match[2];
    if (name.length > 3 && name.length < 100) {
      products.push({
        name,
        price: price.replace(".", "").replace(",", "."),
        priceFormatted: `₺${price}`,
        category: category === "men" ? "Erkek" : category === "women" ? "Kadın" : "",
      });
    }
  }

  return products;
}

/**
 * Extract individual product page URLs from category results.
 */
function extractProductUrls(results) {
  const urls = new Set();

  for (const key of ["homepage", "men", "women"]) {
    const page = results[key];
    if (page?.products) {
      for (const product of page.products) {
        if (product.url && product.url.includes("/urun/")) {
          urls.add(product.url);
        }
      }
    }
  }

  return Array.from(urls);
}

/**
 * Parse an individual product detail page.
 */
function parseProductDetailPage(html, logger) {
  const $ = cheerio.load(html);

  const product = {};

  // Product name
  product.name = $("h1, [class*='product-title'], [class*='product-name']").first().text()?.trim() || "";

  // Price
  const priceText = $('[class*="price"], [class*="fiyat"]').first().text()?.trim() || "";
  const priceMatch = priceText.match(/[\d.,]+/);
  if (priceMatch) {
    product.price = priceMatch[0].replace(".", "").replace(",", ".");
    product.priceFormatted = `₺${priceMatch[0]}`;
  }

  // Description
  product.description = $('[class*="description"], [class*="aciklama"], .product-info p').text()?.trim() || "";

  // SKU
  product.sku = $('[class*="sku"], [class*="kod"]').text()?.trim() || "";

  // Sizes
  const sizes = [];
  $('[class*="size"], [class*="beden"], [data-size]').each((_, el) => {
    const size = $(el).text()?.trim() || $(el).attr("data-size");
    if (size && /^(X{0,2}S|S|M|L|XL|XXL|2XL|3XL|\d{2,3})$/i.test(size)) {
      sizes.push(size.toUpperCase());
    }
  });
  product.sizes = [...new Set(sizes)];

  // Colors
  const colors = [];
  $('[class*="color"], [class*="renk"], [data-color]').each((_, el) => {
    const color = $(el).text()?.trim() || $(el).attr("title") || $(el).attr("data-color") || "";
    if (color && color.length < 30) colors.push(color);
  });
  product.colors = [...new Set(colors)];

  // Stock info
  const stockText = $('[class*="stock"], [class*="stok"]').text()?.trim() || "";
  if (stockText) product.stock = stockText;

  // Material / Fabric
  const materialText = $('[class*="material"], [class*="kumas"], [class*="fabric"]').text()?.trim() || "";
  if (materialText) product.material = materialText;

  if (!product.name) return null;
  return product;
}

// ==================== Data Merging ====================

/**
 * Merge products from all sources, deduplicating by name.
 */
function mergeProductData(pageResults, productDetails) {
  const productMap = new Map();

  // Add products from category pages
  for (const key of ["homepage", "men", "women"]) {
    const page = pageResults[key];
    if (page?.products) {
      for (const p of page.products) {
        if (p.name) {
          const existing = productMap.get(p.name) || {};
          productMap.set(p.name, { ...existing, ...p });
        }
      }
    }
  }

  // Overlay with detail page data (more complete)
  for (const detail of productDetails) {
    if (detail.name) {
      const existing = productMap.get(detail.name) || {};
      productMap.set(detail.name, { ...existing, ...detail });
    }
  }

  return Array.from(productMap.values());
}

// ==================== Info Extractors ====================

function extractCompanyInfo(results) {
  const about = results.about;
  if (!about) return null;

  return {
    sections: about.sections || [],
  };
}

function extractWholesaleInfo(results) {
  const wholesale = results.wholesale;
  if (!wholesale) return null;

  return {
    sections: wholesale.sections || [],
  };
}

function extractContactInfo(results) {
  return results.contact || null;
}

// ==================== Context Formatter ====================

/**
 * Format scraped data as a text context for AI consumption.
 * This text is injected into the system prompt or chat context.
 */
function formatAsContext(data) {
  const lines = [];

  lines.push("=== VORTE.COM.TR WEB SİTESİ VERİLERİ ===");
  lines.push(`(Son güncelleme: ${data.scrapedAt})`);
  lines.push("");

  // Products
  if (data.products && data.products.length > 0) {
    lines.push("── ÜRÜN KATALOĞU ──");
    for (const p of data.products) {
      lines.push(`• ${p.name}`);
      if (p.priceFormatted) lines.push(`  Fiyat: ${p.priceFormatted}`);
      if (p.category) lines.push(`  Kategori: ${p.category}`);
      if (p.description) lines.push(`  Açıklama: ${p.description.slice(0, 200)}`);
      if (p.sizes && p.sizes.length > 0) lines.push(`  Bedenler: ${p.sizes.join(", ")}`);
      if (p.colors && p.colors.length > 0) lines.push(`  Renkler: ${p.colors.join(", ")}`);
      if (p.material) lines.push(`  Kumaş: ${p.material}`);
      if (p.stock) lines.push(`  Stok: ${p.stock}`);
      if (p.sku) lines.push(`  Ürün Kodu: ${p.sku}`);
      if (p.url) lines.push(`  URL: ${BASE_URL}${p.url}`);
      lines.push("");
    }
  } else {
    lines.push("── ÜRÜN KATALOĞU ──");
    lines.push("Şu anda web sitesinden ürün bilgisi alınamadı.");
    lines.push("");
  }

  // Company Info
  if (data.company?.sections?.length > 0) {
    lines.push("── ŞİRKET BİLGİLERİ ──");
    for (const section of data.company.sections.slice(0, 10)) {
      lines.push(`  ${section}`);
    }
    lines.push("");
  }

  // Contact
  if (data.contact) {
    lines.push("── İLETİŞİM BİLGİLERİ ──");
    if (data.contact.phone) lines.push(`  Telefon: ${data.contact.phone}`);
    if (data.contact.email) lines.push(`  E-posta: ${data.contact.email}`);
    if (data.contact.address) lines.push(`  Adres: ${data.contact.address}`);
    if (data.contact.workingHours) lines.push(`  Çalışma Saatleri: ${data.contact.workingHours}`);
    if (data.contact.socialMedia?.length > 0) {
      lines.push(`  Sosyal Medya: ${data.contact.socialMedia.join(", ")}`);
    }
    lines.push("");
  }

  // Wholesale
  if (data.wholesale?.sections?.length > 0) {
    lines.push("── TOPTAN SATIŞ BİLGİLERİ ──");
    for (const section of data.wholesale.sections.slice(0, 10)) {
      lines.push(`  ${section}`);
    }
    lines.push("");
  }

  lines.push("=== VERİ SONU ===");

  return lines.join("\n");
}

// ==================== Exports ====================

module.exports = {
  getWebsiteData,
  buildWebsiteContext,
  invalidateCache,
};
