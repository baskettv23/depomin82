// DEPOMIN82: canales en vivo y eventos deportivos desde depomin82.es.tl.
// Un plugin para Kino (https://kinotvapp.github.io/kino-plugins/).
// El sitio publica enlaces acortados que redirigen a streams HLS (varios de
// ellos a páginas con reproductor). Este plugin lee la página, arma canales
// en vivo y, al reproducir, sigue cada enlace hasta el stream real.

const SITE = "https://depomin82.es.tl/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CATEGORIES = [
  { id: "canales", title: "Canales", country: "PR", genre: "entretenimiento" },
  { id: "eventos", title: "Eventos del día", genre: "deportes" },
];

const SHORTEN_LABEL = /ap\.lc|is\.gd|ln\.run|shorten\.tv|rb\.gy|lc\.cx|bit\.ly|vaughn\.live/i;
const EVENTS_SKIP = /bloquea|anuncios|sonido|unmute|donativo|google|local time|guarda la pagina|grin\.gif|afiliad|timezone/i;

const REDIRECTS = [301, 302, 303, 307, 308];

// ---- utilidades -----------------------------------------------------------

function decodeEnt(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&ntilde;/g, "ñ").replace(/&Ntilde;/g, "Ñ")
    .replace(/&aacute;/g, "á").replace(/&Aacute;/g, "Á")
    .replace(/&eacute;/g, "é").replace(/&Eacute;/g, "É")
    .replace(/&iacute;/g, "í").replace(/&Iacute;/g, "Í")
    .replace(/&oacute;/g, "ó").replace(/&Oacute;/g, "Ó")
    .replace(/&uacute;/g, "ú").replace(/&Uacute;/g, "Ú")
    .replace(/&uuml;/g, "ü").replace(/&Uuml;/g, "Ü")
    .replace(/&auml;/g, "ä").replace(/&Auml;/g, "Ä")
    .replace(/&ouml;/g, "ö").replace(/&Ouml;/g, "Ö")
    .replace(/&ccedil;/g, "ç").replace(/&Ccedil;/g, "Ç")
    .replace(/&deg;/g, "°").replace(/&ordm;/g, "º")
    .replace(/&times;/g, "×")
    .replace(/&iquest;/g, "¿").replace(/&iexcl;/g, "¡");
}

function cleanText(s) {
  return decodeEnt(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(s) {
  return cleanText(s).replace(/[=]+/g, " ").replace(/\s+/g, " ").replace(/^[=<>:\s]+|[=<>:\s]+$/g, "").trim();
}

function slugify(s) {
  const base = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "canal";
}

function toItems(list, prefix) {
  const items = [];
  const used = new Set();
  for (const c of list) {
    if (!c.name || !c.urls.length) continue;
    let id = prefix + slugify(c.name);
    let n = 2;
    while (used.has(id)) id = prefix + slugify(c.name) + "-" + n++;
    used.add(id);
    items.push({
      id,
      ref: c.urls.join("|"),
      title: c.name.slice(0, 200),
      kind: "live",
    });
  }
  return items;
}

// ---- lectura del sitio -----------------------------------------------------

async function fetchSite() {
  const cached = kino.storage.get("site:html");
  if (cached) return cached;
  const r = await kino.fetch(SITE, { headers: { "User-Agent": UA }, timeoutMs: 20000 });
  if (!r.ok) throw kino.error("unavailable", "depomin82.es.tl respondió " + r.status);
  const html = r.text();
  try {
    kino.storage.set("site:html", html, { ttlMs: 50 * 60 * 1000 });
  } catch (e) {
    kino.log("cache: no guardada", e.message);
  }
  return html;
}

function parseChannels(html) {
  const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/);
  if (!table) return [];
  const channels = [];
  const seen = new Set();
  const rows = table[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
  for (const row of rows) {
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
    let pendingName = "";
    for (const cell of cells) {
      const hrefs = [...cell.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const withoutLinks = cell.replace(/<a[^>]*>[\s\S]*?<\/a>/g, " ");
      const text = cleanName(withoutLinks);
      if (!hrefs.length) {
        if (text) pendingName = text;
        continue;
      }
      const name = (text || pendingName || "").trim();
      if (!name || name.length < 2 || !/[a-z0-9]{2,}/i.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) {
        pendingName = "";
        continue;
      }
      seen.add(key);
      channels.push({ name, urls: hrefs });
      pendingName = "";
    }
  }
  return channels;
}

function parseEvents(html) {
  const tableEnd = html.indexOf("</table>");
  let seg = tableEnd !== -1 ? html.slice(tableEnd + 8) : html;
  const counter = seg.indexOf("gnrcounter");
  if (counter !== -1) seg = seg.slice(0, counter);

  const events = [];
  const seen = new Set();
  const lines = seg.split(/<br\s*\/?>/gi);
  for (const line of lines) {
    if (!/<a\b/i.test(line)) continue;
    const hrefs = [...line.matchAll(/href=["']((?:https?:)?\/\/[^"' >]+)/gi)]
      .map((m) => m[1].replace(/&amp;/g, "&"));
    if (!hrefs.length) continue;

    let name = cleanName(
      line.replace(/<a[^>]*>[\s\S]*?<\/a>/g, " ").replace(/<[^>]*>/g, " ")
    );
    name = name
      .replace(new RegExp("\\b(" + SHORTEN_LABEL.source + ")\\/[\\S]*", "gi"), " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name || name.length < 4) continue;
    if (EVENTS_SKIP.test(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ name: name.slice(0, 120), urls: hrefs });
  }
  return events;
}

// ---- resolución de streams -------------------------------------------------

function isStreamish(url) {
  const path = String(url).replace(/\?.*$/, "");
  return /\.(?:m3u8|m3u|mpd|mp4)$/i.test(path);
}

function extractStream(text) {
  if (!text) return null;
  const t = String(text).replace(/\\\//g, "/").replace(/&amp;/g, "&");
  let m = t.match(/https?:\/\/[^"'<>\s\\]+?\.(?:m3u8|m3u)(?:[^"'<>\s\\]*)/i);
  if (m) return m[0].replace(/[?#]\s*$/, "");
  m = t.match(/https?:\/\/[^"'<>\s\\]+?\.mpd(?:[^"'<>\s\\]*)/i);
  if (m) return m[0];
  m = t.match(/(?:https?:)?\/\/[^"'<>\s\\]+?\.m3u8(?:[^"'<>\s\\]*)/i);
  if (m) return (m[0].startsWith("//") ? "https:" : "") + m[0].replace(/[?#]\s*$/, "");
  return null;
}

async function readText(r) {
  try {
    return await r.text();
  } catch (e) {
    return "";
  }
}

function streamOf(url) {
  return { url: url.trim(), headers: { "User-Agent": UA, Referer: SITE } };
}

function noStream() {
  return Promise.reject(kino.error("unavailable", "No se encontró el video en este enlace"));
}

async function streamFrom(url, hops = 0) {
  if (hops > 4) return noStream();
  const opts = { headers: { "User-Agent": UA, Referer: SITE }, timeoutMs: 20000 };

  // 1) sin seguir: leemos la primera redirección y decidimos nosotros.
  let r = null;
  try {
    r = await kino.fetch(url, Object.assign({}, opts, { redirect: "manual" }));
  } catch (e) {
    if (e.code === "host_not_allowed") throw e;
  }

  if (r && REDIRECTS.indexOf(r.status) !== -1) {
    const loc = (r.headers.location || "").trim();
    if (loc) {
      let target = null;
      try {
        target = new URL(loc, url);
      } catch (e) {
        target = null;
      }
      if (target) {
        const href = target.href;
        if (isStreamish(href)) return streamOf(href);
        if (target.hostname === new URL(url).hostname) return streamFrom(href, hops + 1);
        if (/playm3u8\.html/i.test(target.pathname)) {
          const q = target.search || "";
          let qs = q;
          try { qs = decodeURIComponent(q); } catch (e) { /* dejamos q */ }
          let m = qs.match(/https?:\/\/[^&]+(?:\.m3u8|\.mpd|\.m3u)(?=[&]|$)/i);
          if (m) return streamOf(m[0]);
          return extractOrFail(href);
        }
        return extractOrFail(href);
      }
    }
    return noStream();
  }

  // 2) respuesta directa: ¿stream o página HTML con el enlace adentro?
  if (r) {
    const ct = String(r.headers["content-type"] || "").toLowerCase();
    if (ct.indexOf("mpegurl") !== -1 || ct.indexOf("dash") !== -1 || isStreamish(r.url)) {
      return streamOf(r.url || url);
    }
    const found = extractStream(await readText(r));
    if (found) return streamOf(found);
  }

  // 3) último intento: dejar que Kino siga las redirecciones hasta el final.
  try {
    const f = await kino.fetch(url, Object.assign({}, opts, { redirect: "follow" }));
    if (isStreamish(f.url)) return streamOf(f.url);
    const found = extractStream(await readText(f));
    if (found) return streamOf(found);
  } catch (e) {
    if (e.code === "host_not_allowed") throw e;
  }

  return noStream();
}

async function extractOrFail(pageUrl) {
  const opts = { headers: { "User-Agent": UA, Referer: SITE }, timeoutMs: 20000 };
  let r;
  try {
    r = await kino.fetch(pageUrl, Object.assign({}, opts));
  } catch (e) {
    if (e.code === "host_not_allowed") throw e;
    return noStream();
  }
  const ct = String(r.headers["content-type"] || "").toLowerCase();
  if (ct.indexOf("mpegurl") !== -1 || isStreamish(r.url)) return streamOf(r.url || pageUrl);
  const found = extractStream(await readText(r));
  if (found) return streamOf(found);
  return noStream();
}

export async function resolve(ref) {
  const urls = String(ref || "").split("|").filter(Boolean);
  if (!urls.length) throw kino.error("not_found");

  let start = 0;
  const rot = "rot:" + urls[0].slice(0, 40);
  try {
    const t = kino.storage.get(rot);
    if (t) start = Math.min(Number(t) || 0, urls.length - 1);
  } catch (e) { /* almacenamiento lleno: empezamos por el primero */ }

  let last = null;
  for (let i = 0; i < urls.length; i++) {
    const idx = (start + i) % urls.length;
    try {
      const s = await streamFrom(urls[idx]);
      try {
        kino.storage.set(rot, String((idx + 1) % urls.length));
      } catch (e) { /* ignora */ }
      return s;
    } catch (e) {
      last = e;
    }
  }

  if (last && last.code === "host_not_allowed") {
    throw kino.error("unavailable", "Un servidor del canal no está permitido", {
      userMessage: "Cuando Kino pregunte por el servidor del canal, toca Permitir.",
    });
  }
  throw kino.error("unavailable", "No se encontró el video en DEPOMIN82");
}

// ---- funciones que Kino llama ----------------------------------------------

export async function liveCategories() {
  return CATEGORIES.map((c) => ({ id: c.id, title: c.title, country: c.country, genre: c.genre }));
}

export async function liveChannels({ categoryId }) {
  const html = await fetchSite();
  if (categoryId === "canales") return { items: toItems(parseChannels(html), "dep-") };
  if (categoryId === "eventos") return { items: toItems(parseEvents(html), "dep-ev-") };
  return { items: [] };
}

export async function home() {
  return [];
}