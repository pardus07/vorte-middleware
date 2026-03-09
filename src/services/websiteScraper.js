/**
 * Vorte Website Scraper Service
 *
 * Scrapes vorte.com.tr to extract product catalog, prices, company info.
 * Optimized for Next.js SSR sites — extracts data from:
 *   1. __NEXT_DATA__ JSON (most reliable)
 *   2. __next_f.push() flight data streams
 *   3. HTML elements via cheerio (fallback)
 *   4. Full page text pattern matching (last resort)
 *
 * Caches results in memory with TTL to avoid excessive requests.
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

// Known product detail pages (scraped individually for full data)
const KNOWN_PRODUCT_URLS = [
  "/urun/erkek-modal-boxer-gri",
  "/urun/erkek-modal-boxer-lacivert",
  "/urun/erkek-modal-boxer-siyah",
  "/urun/kadin-modal-kulot-ten",
  "/urun/kadin-modal-kulot-beyaz",
  "/urun/kadin-modal-kulot-siyah",
];

// Cache TTL: 1 hour
const CACHE_TTL_MS = 60 * 60 * 1000;

// ==================== Cache ====================

let cachedData = null;
let cacheTimestamp = 0;
let isScraping = false;
let scrapePromise = null;

// ==================== Public API ====================

async function getWebsiteData(logger) {
  const now = Date.now();

  if (cachedData && (now - cacheTimestamp) < CACHE_TTL_MS) {
    logger?.debug("Using cached website data");
    return cachedData;
  }

  if (isScraping && scrapePromise) {
    logger?.debug("Scrape already in progress, waiting...");
    return scrapePromise;
  }

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
      if (cachedData) {
        logger?.warn("Returning stale cached data after scrape failure");
        return cachedData;
      }
      throw err;
    });

  return scrapePromise;
}

async function buildWebsiteContext(logger) {
  try {
    const data = await getWebsiteData(logger);
    return formatAsContext(data);
  } catch (err) {
    logger?.error({ error: err.message }, "Failed to build website context");
    return "WEB SİTESİ VERİLERİ: Şu anda web sitesine erişilemiyor.";
  }
}

function invalidateCache() {
  cachedData = null;
  cacheTimestamp = 0;
}

// ==================== Main Scrape Logic ====================

async function scrapeAllPages(logger) {
  logger?.info("Starting website scrape of vorte.com.tr");
  const startTime = Date.now();

  const results = {};

  // Scrape main pages
  for (const page of PAGES_TO_SCRAPE) {
    try {
      const html = await fetchPage(page.url, logger);
      results[page.key] = parsePage(html, page.key, logger);
      logger?.debug({ page: page.key }, "Page scraped");
    } catch (err) {
      logger?.warn({ page: page.key, error: err.message }, "Page scrape failed");
      results[page.key] = null;
    }
  }

  // Scrape individual product pages for detailed info
  const productDetails = [];
  const allProductUrls = new Set(KNOWN_PRODUCT_URLS);

  // Add any URLs found from category pages
  for (const key of ["homepage", "men", "women"]) {
    const page = results[key];
    if (page?.products) {
      for (const p of page.products) {
        if (p.url && p.url.includes("/urun/")) {
          allProductUrls.add(p.url);
        }
      }
    }
  }

  for (const productUrl of allProductUrls) {
    try {
      const html = await fetchPage(productUrl, logger);
      const detail = parseProductPage(html, logger);
      if (detail && detail.name) {
        productDetails.push(detail);
        logger?.debug({ product: detail.name, price: detail.priceFormatted }, "Product scraped");
      }
    } catch (err) {
      logger?.debug({ url: productUrl, error: err.message }, "Product scrape failed");
    }
  }

  const elapsed = Date.now() - startTime;

  // Merge all data
  const products = mergeProducts(results, productDetails);

  logger?.info(
    { elapsed, productCount: products.length, detailPages: productDetails.length },
    "Website scrape complete"
  );

  return {
    scrapedAt: new Date().toISOString(),
    products,
    company: extractCompanyInfo(results),
    wholesale: extractWholesaleInfo(results),
    contact: extractContactInfo(results),
  };
}

async function fetchPage(path, logger) {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

// ==================== Page Parsers ====================

function parsePage(html, pageKey, logger) {
  const $ = cheerio.load(html);

  // Try Next.js data extraction first (most reliable)
  const nextData = extractNextData($, html);

  switch (pageKey) {
    case "homepage":
    case "men":
    case "women":
      return parseProductListPage($, html, pageKey, nextData, logger);
    case "about":
      return parseTextPage($, logger);
    case "contact":
      return parseContactPage($, html, logger);
    case "wholesale":
      return parseTextPage($, logger);
    default:
      return { rawText: $("body").text().trim().slice(0, 3000) };
  }
}

/**
 * Extract __NEXT_DATA__ JSON from Next.js SSR pages.
 */
function extractNextData($, html) {
  try {
    // Method 1: __NEXT_DATA__ script tag
    const nextDataScript = $("#__NEXT_DATA__").html();
    if (nextDataScript) {
      return JSON.parse(nextDataScript);
    }

    // Method 2: Look for __next_f.push() data in script tags
    const flightData = [];
    $("script").each((_, el) => {
      const text = $(el).html() || "";
      const matches = text.matchAll(/self\.__next_f\.push\(\[[\d,]*"([^"]*)"\]\)/g);
      for (const m of matches) {
        try {
          flightData.push(m[1]);
        } catch {}
      }
    });

    if (flightData.length > 0) {
      return { _flightData: flightData.join("") };
    }
  } catch {}

  return null;
}

/**
 * Parse a product listing page (homepage, /erkek, /kadin).
 * Uses multiple strategies to find product data.
 */
function parseProductListPage($, html, pageKey, nextData, logger) {
  const products = [];
  const seen = new Set();

  // Strategy 1: Extract from __NEXT_DATA__ JSON
  if (nextData && !nextData._flightData) {
    try {
      const pageProps = nextData.props?.pageProps;
      if (pageProps?.products) {
        for (const p of pageProps.products) {
          const product = normalizeNextProduct(p, pageKey);
          if (product.name && !seen.has(product.name)) {
            seen.add(product.name);
            products.push(product);
          }
        }
      }
    } catch {}
  }

  // Strategy 2: Extract product-like JSON from flight data or script tags
  if (products.length === 0) {
    const scriptProducts = extractProductsFromScripts($, html, pageKey);
    for (const p of scriptProducts) {
      if (p.name && !seen.has(p.name)) {
        seen.add(p.name);
        products.push(p);
      }
    }
  }

  // Strategy 3: Parse HTML elements
  if (products.length === 0) {
    const htmlProducts = extractProductsFromHtml($, pageKey);
    for (const p of htmlProducts) {
      if (p.name && !seen.has(p.name)) {
        seen.add(p.name);
        products.push(p);
      }
    }
  }

  // Strategy 4: Extract from full page text
  if (products.length === 0) {
    const textProducts = extractProductsFromText($, pageKey);
    for (const p of textProducts) {
      if (p.name && !seen.has(p.name)) {
        seen.add(p.name);
        products.push(p);
      }
    }
  }

  logger?.debug({ page: pageKey, productCount: products.length, strategy: products.length > 0 ? "found" : "none" }, "Product extraction");

  return { products, category: pageKey };
}

/**
 * Normalize a product from Next.js pageProps format.
 */
function normalizeNextProduct(p, pageKey) {
  const product = {
    name: p.name || p.title || "",
    description: p.description || "",
    category: pageKey === "men" ? "Erkek" : pageKey === "women" ? "Kadın" : "",
  };

  // Price
  const price = p.price || p.salePrice || p.basePrice;
  if (price) {
    product.price = String(price);
    product.priceFormatted = `₺${String(price).replace(".", ",")}`;
  }

  // URL
  if (p.slug) product.url = `/urun/${p.slug}`;
  else if (p.url) product.url = p.url;

  // Variants/sizes
  if (p.variants) {
    product.sizes = p.variants
      .map((v) => v.size || v.name)
      .filter(Boolean);
    product.colors = [...new Set(p.variants.map((v) => v.color).filter(Boolean))];
  }

  if (p.sku) product.sku = p.sku;
  if (p.stock !== undefined) product.stock = String(p.stock);

  return product;
}

/**
 * Extract product data from inline scripts (JSON-LD, embedded data).
 */
function extractProductsFromScripts($, html, pageKey) {
  const products = [];

  // Try JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).html());
      if (ld["@type"] === "Product" || ld["@type"] === "ItemList") {
        const items = ld.itemListElement || [ld];
        for (const item of items) {
          const p = item.item || item;
          if (p.name) {
            products.push({
              name: p.name,
              description: p.description || "",
              priceFormatted: p.offers?.price ? `₺${p.offers.price}` : "",
              price: p.offers?.price ? String(p.offers.price) : "",
              url: p.url || "",
              category: pageKey === "men" ? "Erkek" : pageKey === "women" ? "Kadın" : "",
            });
          }
        }
      }
    } catch {}
  });

  // Try extracting product-like patterns from any script content
  if (products.length === 0) {
    const allScripts = $("script").map((_, el) => $(el).html() || "").get().join("\n");

    // Look for product name + price patterns in script data
    // Pattern: "name":"Erkek Modal Boxer Gri"..."price":14990 or "price":"149.90"
    const nameMatches = allScripts.matchAll(/"(?:name|title)"\s*:\s*"([^"]*(?:Boxer|Külot|Atlet|Çorap|Tayt|Sütyen)[^"]*)"/gi);
    for (const m of nameMatches) {
      const name = m[1];
      // Try to find price near this match
      const idx = m.index;
      const nearby = allScripts.slice(Math.max(0, idx - 200), idx + 500);
      const priceMatch = nearby.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/);
      if (priceMatch) {
        let price = parseFloat(priceMatch[1]);
        // If price > 1000, it might be in cents (14990 → 149.90)
        if (price > 1000) price = price / 100;
        products.push({
          name,
          price: String(price),
          priceFormatted: `₺${price.toFixed(2).replace(".", ",")}`,
          category: pageKey === "men" ? "Erkek" : pageKey === "women" ? "Kadın" : "",
        });
      }
    }
  }

  return products;
}

/**
 * Extract products from HTML elements using cheerio.
 */
function extractProductsFromHtml($, pageKey) {
  const products = [];
  const selectors = [
    '[class*="product"]',
    '[class*="card"]',
    '[data-product]',
    'article',
    '.grid > div',
    '[class*="item"]',
    'a[href*="/urun/"]',
  ];

  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $el = $(el);

      // Find product name
      const nameEl = $el.find("h2, h3, h4, h5, [class*='name'], [class*='title']").first();
      let name = nameEl.text()?.trim() || "";

      // If no name from child, try this element's text (for anchor tags)
      if (!name && $el.is("a")) {
        name = $el.text()?.trim().split("\n")[0]?.trim() || "";
      }

      if (!name || name.length < 5 || name.length > 100 || seen.has(name)) return;

      // Only include if it looks like a product name
      if (!/boxer|külot|atlet|çorap|tayt|sütyen|modal|penye/i.test(name)) return;

      seen.add(name);

      const product = { name, category: pageKey === "men" ? "Erkek" : pageKey === "women" ? "Kadın" : "" };

      // Price
      const priceEl = $el.find('[class*="price"], [class*="fiyat"]').first();
      const priceText = priceEl.text()?.trim() || $el.text()?.match(/₺?\s*(\d+[.,]\d{2})\s*(?:TL)?/)?.[0] || "";
      const priceMatch = priceText.match(/(\d+)[.,](\d{2})/);
      if (priceMatch) {
        product.price = `${priceMatch[1]}.${priceMatch[2]}`;
        product.priceFormatted = `₺${priceMatch[1]},${priceMatch[2]}`;
      }

      // URL
      const linkEl = $el.is("a") ? $el : $el.find("a").first();
      const href = linkEl.attr("href") || "";
      if (href.includes("/urun/")) product.url = href;

      products.push(product);
    });

    if (products.length >= 3) break;
  }

  return products;
}

/**
 * Last resort: extract product data from full page text.
 */
function extractProductsFromText($, pageKey) {
  const products = [];
  const bodyText = $("body").text();

  // Look for Turkish product names followed by prices
  const patterns = [
    // "Erkek Modal Boxer Gri" ... "₺149,90" or "149,90 TL"
    /((?:Erkek|Kadın)\s+(?:Modal|Penye|Likralı)?\s*(?:Boxer|Külot|Atlet|Tayt|Çorap|Sütyen)\s+\w+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      const name = match[1].trim();
      if (name.length < 5) continue;

      // Look for price within 200 chars after the name
      const after = bodyText.slice(match.index, match.index + 300);
      const priceMatch = after.match(/₺?\s*(\d+)[.,](\d{2})\s*(?:TL)?/);

      const product = {
        name,
        category: pageKey === "men" ? "Erkek" : pageKey === "women" ? "Kadın" : "",
      };

      if (priceMatch) {
        product.price = `${priceMatch[1]}.${priceMatch[2]}`;
        product.priceFormatted = `₺${priceMatch[1]},${priceMatch[2]}`;
      }

      products.push(product);
    }
  }

  return products;
}

/**
 * Parse an individual product detail page.
 * This is the most reliable — each page has full product info.
 */
function parseProductPage(html, logger) {
  const $ = cheerio.load(html);
  const product = {};

  // Extract from __NEXT_DATA__ first
  const nextData = extractNextData($, html);
  if (nextData?.props?.pageProps?.product) {
    const p = nextData.props.pageProps.product;
    return normalizeNextProduct(p, p.category?.includes("erkek") ? "men" : "women");
  }

  // Extract from JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).html());
      if (ld["@type"] === "Product") {
        product.name = ld.name || "";
        product.description = ld.description || "";
        if (ld.offers?.price) {
          product.price = String(ld.offers.price);
          product.priceFormatted = `₺${String(ld.offers.price).replace(".", ",")}`;
        }
        if (ld.sku) product.sku = ld.sku;
        if (ld.image) product.image = Array.isArray(ld.image) ? ld.image[0] : ld.image;
      }
    } catch {}
  });

  // Extract from HTML elements
  if (!product.name) {
    product.name = $("h1").first().text()?.trim() || "";
  }

  if (!product.priceFormatted) {
    const priceText = $('[class*="price"], [class*="fiyat"]').first().text()?.trim() || "";
    const priceMatch = priceText.match(/(\d+)[.,](\d{2})/);
    if (priceMatch) {
      product.price = `${priceMatch[1]}.${priceMatch[2]}`;
      product.priceFormatted = `₺${priceMatch[1]},${priceMatch[2]}`;
    }
  }

  if (!product.description) {
    product.description = $('[class*="description"], [class*="aciklama"], meta[name="description"]')
      .first()
      .attr("content") || $('[class*="description"]').first().text()?.trim() || "";
  }

  // Extract sizes from page text
  const pageText = $("body").text();
  const sizeMatches = pageText.match(/\b(S|M|L|XL|XXL|2XL|3XL)\b/g);
  if (sizeMatches) {
    product.sizes = [...new Set(sizeMatches)];
  }

  // Extract color from URL or title
  const url = $('link[rel="canonical"]').attr("href") || "";
  const colorMap = {
    gri: "Gri",
    lacivert: "Lacivert",
    siyah: "Siyah",
    beyaz: "Beyaz",
    ten: "Ten",
    kirmizi: "Kırmızı",
    mavi: "Mavi",
  };
  for (const [slug, name] of Object.entries(colorMap)) {
    if (url.includes(slug) || product.name?.toLowerCase().includes(slug)) {
      product.colors = [name];
      break;
    }
  }

  // Determine category from name
  if (product.name) {
    if (/erkek/i.test(product.name)) product.category = "Erkek";
    else if (/kadın|kadin/i.test(product.name)) product.category = "Kadın";

    // Set URL from known pattern
    const slug = product.name
      .toLowerCase()
      .replace(/ı/g, "i").replace(/ö/g, "o").replace(/ü/g, "u")
      .replace(/ş/g, "s").replace(/ç/g, "c").replace(/ğ/g, "g")
      .replace(/\s+/g, "-");
    product.url = `/urun/${slug}`;
  }

  // Material from description or page text
  if (/modal/i.test(product.name || product.description)) {
    product.material = "Modal";
  } else if (/penye/i.test(product.name || product.description)) {
    product.material = "Penye";
  }

  if (!product.name) return null;
  return product;
}

// ==================== Text Page Parser ====================

function parseTextPage($, logger) {
  const sections = [];

  // Get all text content from main/article/body
  $("main, article, [class*='content'], [class*='about'], [class*='toptan']").each((_, el) => {
    $("h1, h2, h3, h4, p, li", el).each((_, child) => {
      const text = $(child).text().trim();
      if (text && text.length > 3 && text.length < 500) {
        sections.push(text);
      }
    });
  });

  // Fallback: get from body
  if (sections.length === 0) {
    const bodyText = $("body").text().trim();
    // Split by newlines and filter meaningful lines
    const lines = bodyText.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 10 && l.length < 500);
    sections.push(...lines.slice(0, 20));
  }

  return { sections };
}

// ==================== Contact Page Parser ====================

function parseContactPage($, html, logger) {
  const info = {};
  const fullText = $("body").text();

  // Phone
  const phoneMatch = fullText.match(/(?:\+90|0)\s*5?\d[\d\s]{8,12}/);
  if (phoneMatch) info.phone = phoneMatch[0].replace(/\s+/g, " ").trim();

  // Email
  const emailMatch = fullText.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) info.email = emailMatch[0];

  // Address
  const addrMatch = fullText.match(/((?:Dumlupınar|[\w]+\s+Mah\.?)[\s\S]{10,120}(?:Bursa|İstanbul|Ankara)\s*\d{5})/i);
  if (addrMatch) info.address = addrMatch[1].replace(/\s+/g, " ").trim();

  // Working hours
  const hoursMatch = fullText.match(/Pazartesi[\s\S]{5,60}?\d{2}:\d{2}/i);
  if (hoursMatch) info.workingHours = hoursMatch[0].replace(/\s+/g, " ").trim();

  // Social media
  info.socialMedia = [];
  $('a[href*="instagram"], a[href*="facebook"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) info.socialMedia.push(href);
  });

  return info;
}

// ==================== Data Merging ====================

function mergeProducts(pageResults, productDetails) {
  const productMap = new Map();

  // Add from category pages
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

  // Overlay with detail page data (most complete)
  for (const detail of productDetails) {
    if (detail.name) {
      const existing = productMap.get(detail.name) || {};
      productMap.set(detail.name, { ...existing, ...detail });
    }
  }

  return Array.from(productMap.values());
}

function extractCompanyInfo(results) {
  const about = results.about;
  if (!about) return null;
  return { sections: about.sections || [] };
}

function extractWholesaleInfo(results) {
  const wholesale = results.wholesale;
  if (!wholesale) return null;
  return { sections: wholesale.sections || [] };
}

function extractContactInfo(results) {
  return results.contact || null;
}

// ==================== Context Formatter ====================

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
      if (p.sizes?.length > 0) lines.push(`  Bedenler: ${p.sizes.join(", ")}`);
      if (p.colors?.length > 0) lines.push(`  Renkler: ${p.colors.join(", ")}`);
      if (p.material) lines.push(`  Kumaş: ${p.material}`);
      if (p.sku) lines.push(`  Ürün Kodu: ${p.sku}`);
      if (p.url) lines.push(`  URL: ${BASE_URL}${p.url}`);
      lines.push("");
    }
  } else {
    lines.push("── ÜRÜN KATALOĞU ──");
    lines.push("Şu anda web sitesinden ürün bilgisi alınamadı.");
    lines.push("");
  }

  // Company
  if (data.company?.sections?.length > 0) {
    lines.push("── ŞİRKET BİLGİLERİ ──");
    for (const s of data.company.sections.slice(0, 10)) {
      lines.push(`  ${s}`);
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
    for (const s of data.wholesale.sections.slice(0, 10)) {
      lines.push(`  ${s}`);
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
