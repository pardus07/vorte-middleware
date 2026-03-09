/**
 * Vorte Website Scraper Service
 *
 * Scrapes ALL pages from vorte.com.tr using sitemap.xml for discovery.
 * Covers: products, blog posts, company info, policies, contact.
 *
 * Extraction strategies (Next.js SSR):
 *   1. __NEXT_DATA__ JSON
 *   2. JSON-LD structured data
 *   3. HTML elements via cheerio
 *   4. Full page text (last resort)
 *
 * Caches results in memory with 1-hour TTL.
 */

const cheerio = require("cheerio");

const BASE_URL = "https://www.vorte.com.tr";
const CACHE_TTL_MS = 60 * 60 * 1000;

// ==================== Cache ====================

let cachedData = null;
let cacheTimestamp = 0;
let isScraping = false;
let scrapePromise = null;

// ==================== Public API ====================

async function getWebsiteData(logger) {
  const now = Date.now();

  if (cachedData && now - cacheTimestamp < CACHE_TTL_MS) {
    logger?.debug("Using cached website data");
    return cachedData;
  }

  if (isScraping && scrapePromise) {
    logger?.debug("Scrape already in progress, waiting...");
    return scrapePromise;
  }

  isScraping = true;
  scrapePromise = scrapeWebsite(logger)
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

// ==================== Sitemap Discovery ====================

async function discoverPages(logger) {
  try {
    const xml = await fetchPage("/sitemap.xml", logger);
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = [];
    $("url").each((_, el) => {
      const loc = $("loc", el).text().trim();
      if (loc) urls.push(loc.replace("https://www.vorte.com.tr", "").replace("https://vorte.com.tr", "") || "/");
    });
    logger?.info({ urlCount: urls.length }, "Sitemap discovered");
    return urls;
  } catch (err) {
    logger?.warn({ error: err.message }, "Sitemap fetch failed, using fallback URLs");
    return FALLBACK_URLS;
  }
}

// Fallback if sitemap fails
const FALLBACK_URLS = [
  "/",
  "/erkek-ic-giyim",
  "/kadin-ic-giyim",
  "/toptan",
  "/hakkimizda",
  "/iletisim",
  "/blog",
  "/urun/erkek-modal-boxer-gri",
  "/urun/erkek-modal-boxer-lacivert",
  "/urun/erkek-modal-boxer-siyah",
  "/urun/kadin-modal-kulot-ten",
  "/urun/kadin-modal-kulot-beyaz",
  "/urun/kadin-modal-kulot-siyah",
];

function categorizeUrl(path) {
  if (path === "/") return "homepage";
  if (path.startsWith("/urun/")) return "product";
  if (path.startsWith("/blog")) return path === "/blog" ? "blog_index" : "blog_post";
  if (path === "/erkek-ic-giyim" || path === "/kadin-ic-giyim") return "category";
  if (path === "/iletisim") return "contact";
  if (path === "/hakkimizda") return "about";
  if (path === "/toptan") return "wholesale";
  if (["/gizlilik-politikasi", "/kvkk", "/mesafeli-satis", "/iade-politikasi", "/kullanim-kosullari"].includes(path)) return "policy";
  return "other";
}

// ==================== Main Scrape ====================

async function scrapeWebsite(logger) {
  logger?.info("Starting full website scrape of vorte.com.tr");
  const startTime = Date.now();

  // Step 1: Discover all pages from sitemap
  const allPaths = await discoverPages(logger);

  // Step 2: Categorize and scrape
  const products = [];
  const blogPosts = [];
  let company = null;
  let wholesale = null;
  let contact = null;
  const policies = [];

  for (const path of allPaths) {
    const type = categorizeUrl(path);
    try {
      const html = await fetchPage(path, logger);
      const $ = cheerio.load(html);

      switch (type) {
        case "homepage":
        case "category": {
          const pageProducts = parseProductListPage($, html, path, logger);
          for (const p of pageProducts) {
            if (!products.find((x) => x.name === p.name)) products.push(p);
          }
          break;
        }
        case "product": {
          const product = parseProductPage($, html, logger);
          if (product?.name) {
            const idx = products.findIndex((x) => x.name === product.name);
            if (idx >= 0) products[idx] = { ...products[idx], ...product };
            else products.push(product);
          }
          break;
        }
        case "blog_post": {
          const post = parseBlogPost($, path, logger);
          if (post?.title) blogPosts.push(post);
          break;
        }
        case "blog_index": {
          // Blog index may have additional post links — we already get them from sitemap
          break;
        }
        case "about": {
          company = parseTextPage($, logger);
          break;
        }
        case "wholesale": {
          wholesale = parseTextPage($, logger);
          break;
        }
        case "contact": {
          contact = parseContactPage($, logger);
          break;
        }
        case "policy": {
          const policy = parsePolicyPage($, path, logger);
          if (policy) policies.push(policy);
          break;
        }
      }

      logger?.debug({ path, type }, "Page scraped");
    } catch (err) {
      logger?.warn({ path, type, error: err.message }, "Page scrape failed");
    }
  }

  const elapsed = Date.now() - startTime;
  logger?.info(
    { elapsed, products: products.length, blogs: blogPosts.length, policies: policies.length },
    "Website scrape complete"
  );

  return {
    scrapedAt: new Date().toISOString(),
    products,
    blogPosts,
    company,
    wholesale,
    contact,
    policies,
  };
}

// ==================== Fetch ====================

async function fetchPage(path, logger) {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

// ==================== Product Parsers ====================

function parseProductListPage($, html, path, logger) {
  const products = [];
  const seen = new Set();
  const category = path.includes("erkek") ? "Erkek" : path.includes("kadin") ? "Kadın" : "";

  // Strategy 1: __NEXT_DATA__
  const nextData = extractNextData($);
  if (nextData?.props?.pageProps?.products) {
    for (const p of nextData.props.pageProps.products) {
      const product = normalizeProduct(p, category);
      if (product.name && !seen.has(product.name)) {
        seen.add(product.name);
        products.push(product);
      }
    }
  }

  // Strategy 2: JSON-LD
  if (products.length === 0) {
    for (const p of extractJsonLdProducts($, category)) {
      if (p.name && !seen.has(p.name)) {
        seen.add(p.name);
        products.push(p);
      }
    }
  }

  // Strategy 3: HTML
  if (products.length === 0) {
    for (const p of extractHtmlProducts($, category)) {
      if (p.name && !seen.has(p.name)) {
        seen.add(p.name);
        products.push(p);
      }
    }
  }

  return products;
}

function parseProductPage($, html, logger) {
  const product = {};

  // __NEXT_DATA__
  const nextData = extractNextData($);
  if (nextData?.props?.pageProps?.product) {
    const p = nextData.props.pageProps.product;
    const cat = /erkek/i.test(p.name || p.category || "") ? "Erkek" : "Kadın";
    return normalizeProduct(p, cat);
  }

  // JSON-LD
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

  // HTML fallback
  if (!product.name) product.name = $("h1").first().text()?.trim() || "";

  if (!product.priceFormatted) {
    const priceText = $('[class*="price"], [class*="fiyat"]').first().text()?.trim() || "";
    const m = priceText.match(/(\d+)[.,](\d{2})/);
    if (m) {
      product.price = `${m[1]}.${m[2]}`;
      product.priceFormatted = `₺${m[1]},${m[2]}`;
    }
  }

  if (!product.description) {
    product.description =
      $('meta[name="description"]').attr("content") ||
      $('[class*="description"]').first().text()?.trim() ||
      "";
  }

  // Sizes
  const pageText = $("body").text();
  const sizeMatches = pageText.match(/\b(S|M|L|XL|XXL|2XL|3XL)\b/g);
  if (sizeMatches) product.sizes = [...new Set(sizeMatches)];

  // Color from URL or title
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const colorMap = { gri: "Gri", lacivert: "Lacivert", siyah: "Siyah", beyaz: "Beyaz", ten: "Ten", kirmizi: "Kırmızı", mavi: "Mavi" };
  for (const [slug, name] of Object.entries(colorMap)) {
    if (canonical.includes(slug) || product.name?.toLowerCase().includes(slug)) {
      product.colors = [name];
      break;
    }
  }

  // Category
  if (/erkek/i.test(product.name)) product.category = "Erkek";
  else if (/kadın|kadin/i.test(product.name)) product.category = "Kadın";

  // Material
  if (/modal/i.test(product.name + " " + (product.description || ""))) product.material = "Modal";
  else if (/penye/i.test(product.name + " " + (product.description || ""))) product.material = "Penye";

  if (!product.name) return null;
  return product;
}

// ==================== Blog Parser ====================

function parseBlogPost($, path, logger) {
  const post = { url: `${BASE_URL}${path}` };

  // JSON-LD Article/BlogPosting
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).html());
      if (ld["@type"] === "BlogPosting" || ld["@type"] === "Article") {
        post.title = ld.headline || ld.name || "";
        post.description = ld.description || "";
        post.datePublished = ld.datePublished || "";
        post.author = ld.author?.name || "";
      }
    } catch {}
  });

  // __NEXT_DATA__
  if (!post.title) {
    const nextData = extractNextData($);
    const pageProps = nextData?.props?.pageProps;
    if (pageProps?.post || pageProps?.blog || pageProps?.article) {
      const p = pageProps.post || pageProps.blog || pageProps.article;
      post.title = p.title || p.name || "";
      post.description = p.description || p.excerpt || p.summary || "";
      post.datePublished = p.publishedAt || p.createdAt || p.date || "";
      post.content = p.content || p.body || "";
    }
  }

  // HTML fallback
  if (!post.title) {
    post.title = $("h1").first().text()?.trim() || "";
  }

  if (!post.description) {
    post.description = $('meta[name="description"]').attr("content") || "";
  }

  // Extract article content
  if (!post.content) {
    const contentParts = [];
    $("article, [class*='blog-content'], [class*='article'], [class*='post-content'], main").first().find("h2, h3, p, li").each((_, el) => {
      const text = $(el).text()?.trim();
      if (text && text.length > 10 && text.length < 1000) {
        contentParts.push(text);
      }
    });

    // Fallback: get from body, filtering nav/header/footer
    if (contentParts.length === 0) {
      $("main p, article p, [class*='content'] p").each((_, el) => {
        const text = $(el).text()?.trim();
        if (text && text.length > 20) contentParts.push(text);
      });
    }

    post.content = contentParts.join("\n");
  }

  // Limit content to prevent context bloat
  if (post.content && post.content.length > 1500) {
    post.content = post.content.slice(0, 1500) + "...";
  }

  return post.title ? post : null;
}

// ==================== Other Page Parsers ====================

function parseTextPage($, logger) {
  const sections = [];

  $("main, article, [class*='content'], [class*='about'], [class*='toptan']")
    .first()
    .find("h1, h2, h3, h4, p, li")
    .each((_, child) => {
      const text = $(child).text().trim();
      if (text && text.length > 3 && text.length < 500) sections.push(text);
    });

  if (sections.length === 0) {
    const bodyText = $("body").text().trim();
    const lines = bodyText.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 10 && l.length < 500);
    sections.push(...lines.slice(0, 20));
  }

  return { sections };
}

function parseContactPage($, logger) {
  const info = {};
  const fullText = $("body").text();

  const phoneMatch = fullText.match(/(?:\+90|0)\s*5?\d[\d\s]{8,12}/);
  if (phoneMatch) info.phone = phoneMatch[0].replace(/\s+/g, " ").trim();

  const emailMatch = fullText.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) info.email = emailMatch[0];

  const addrMatch = fullText.match(/((?:Dumlupınar|[\w]+\s+Mah\.?)[\s\S]{10,120}(?:Bursa|İstanbul|Ankara)\s*\d{5})/i);
  if (addrMatch) info.address = addrMatch[1].replace(/\s+/g, " ").trim();

  const hoursMatch = fullText.match(/Pazartesi[\s\S]{5,60}?\d{2}:\d{2}/i);
  if (hoursMatch) info.workingHours = hoursMatch[0].replace(/\s+/g, " ").trim();

  info.socialMedia = [];
  $('a[href*="instagram"], a[href*="facebook"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) info.socialMedia.push(href);
  });

  return info;
}

function parsePolicyPage($, path, logger) {
  const nameMap = {
    "/gizlilik-politikasi": "Gizlilik Politikası",
    "/kvkk": "KVKK Aydınlatma Metni",
    "/mesafeli-satis": "Mesafeli Satış Sözleşmesi",
    "/iade-politikasi": "İade ve Değişim Politikası",
    "/kullanim-kosullari": "Kullanım Koşulları",
  };

  const title = nameMap[path] || $("h1").first().text()?.trim() || path;

  const sections = [];
  $("main, article, [class*='content'], [class*='policy'], [class*='legal']")
    .first()
    .find("h2, h3, p, li")
    .each((_, el) => {
      const text = $(el).text()?.trim();
      if (text && text.length > 5 && text.length < 800) sections.push(text);
    });

  // Limit to keep context manageable
  const summary = sections.slice(0, 15).join("\n");

  return { title, path, summary };
}

// ==================== Extraction Helpers ====================

function extractNextData($) {
  try {
    const script = $("#__NEXT_DATA__").html();
    if (script) return JSON.parse(script);
  } catch {}
  return null;
}

function normalizeProduct(p, category) {
  const product = {
    name: p.name || p.title || "",
    description: p.description || "",
    category: category || "",
  };

  const price = p.price || p.salePrice || p.basePrice;
  if (price) {
    product.price = String(price);
    product.priceFormatted = `₺${String(price).replace(".", ",")}`;
  }

  if (p.slug) product.url = `/urun/${p.slug}`;
  else if (p.url) product.url = p.url;

  if (p.variants) {
    product.sizes = p.variants.map((v) => v.size || v.name).filter(Boolean);
    product.colors = [...new Set(p.variants.map((v) => v.color).filter(Boolean))];
  }

  if (p.sku) product.sku = p.sku;
  if (p.stock !== undefined) product.stock = String(p.stock);

  return product;
}

function extractJsonLdProducts($, category) {
  const products = [];
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
              category,
            });
          }
        }
      }
    } catch {}
  });
  return products;
}

function extractHtmlProducts($, category) {
  const products = [];
  const seen = new Set();

  $('a[href*="/urun/"], [class*="product"], [class*="card"]').each((_, el) => {
    const $el = $(el);
    const nameEl = $el.find("h2, h3, h4, h5, [class*='name'], [class*='title']").first();
    let name = nameEl.text()?.trim() || "";
    if (!name && $el.is("a")) name = $el.text()?.trim().split("\n")[0]?.trim() || "";
    if (!name || name.length < 5 || name.length > 100 || seen.has(name)) return;
    if (!/boxer|külot|atlet|çorap|tayt|sütyen|modal|penye/i.test(name)) return;

    seen.add(name);
    const product = { name, category };

    const priceText = $el.find('[class*="price"], [class*="fiyat"]').first().text()?.trim() || "";
    const m = priceText.match(/(\d+)[.,](\d{2})/);
    if (m) {
      product.price = `${m[1]}.${m[2]}`;
      product.priceFormatted = `₺${m[1]},${m[2]}`;
    }

    const href = ($el.is("a") ? $el : $el.find("a").first()).attr("href") || "";
    if (href.includes("/urun/")) product.url = href;

    products.push(product);
  });

  return products;
}

// ==================== Context Formatter ====================

function formatAsContext(data) {
  const lines = [];

  lines.push("=== VORTE.COM.TR WEB SİTESİ VERİLERİ ===");
  lines.push(`(Son güncelleme: ${data.scrapedAt})`);
  lines.push("");

  // Products
  if (data.products?.length > 0) {
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
  }

  // Blog Posts
  if (data.blogPosts?.length > 0) {
    lines.push("── BLOG YAZILARI ──");
    for (const post of data.blogPosts) {
      lines.push(`• ${post.title}`);
      if (post.datePublished) lines.push(`  Tarih: ${post.datePublished}`);
      if (post.description) lines.push(`  Özet: ${post.description.slice(0, 200)}`);
      if (post.url) lines.push(`  URL: ${post.url}`);
      if (post.content) {
        lines.push(`  İçerik:`);
        // Include content with indentation, limited
        const contentLines = post.content.split("\n").slice(0, 20);
        for (const cl of contentLines) {
          if (cl.trim()) lines.push(`    ${cl.trim()}`);
        }
      }
      lines.push("");
    }
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

  // Policies
  if (data.policies?.length > 0) {
    lines.push("── POLİTİKALAR VE YASAL BİLGİLER ──");
    for (const pol of data.policies) {
      lines.push(`• ${pol.title}`);
      if (pol.summary) {
        const summaryLines = pol.summary.split("\n").slice(0, 8);
        for (const sl of summaryLines) {
          if (sl.trim()) lines.push(`    ${sl.trim()}`);
        }
      }
      lines.push("");
    }
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
