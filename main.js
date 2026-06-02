import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import "dotenv/config";

chromium.use(StealthPlugin());

const EMAIL          = process.env.PRENOTAMI_EMAIL;
const PASSWORD       = process.env.PRENOTAMI_PASSWORD;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const INTERVAL       = parseInt(process.env.CHECK_INTERVAL_SECONDS ?? "10") * 1000;

const BASE       = "https://prenotami.esteri.it";
const IS_SERVER  = process.env.RAILWAY_ENVIRONMENT !== undefined || process.env.IS_SERVER === "true";
const SCREENSHOT = IS_SERVER ? "/tmp/ultima_verificacao.png" : "C:/Users/Marcos/Documents/Marcos/CLAUDE/PRENOTAMI-BOT/ultima_verificacao.png";

const SERVICES = [
  { id: "5967", name: "Richiesta CIE",                   emoji: "🪪" },
  { id: "4705", name: "Passaporte — Consulado Curitiba", emoji: "🛂" },
  { id: "5623", name: "Passaporte — Florianópolis",      emoji: "🛂" },
];

function log(msg) {
  console.log(`[${new Date().toLocaleString("pt-BR")}] ${msg}`);
}

async function telegram(text, photoPath = null) {
  try {
    if (photoPath) {
      const { readFileSync } = await import("fs");
      const form = new globalThis.FormData();
      form.append("chat_id", CHAT_ID);
      form.append("caption", text);
      form.append("parse_mode", "HTML");
      form.append("photo", new Blob([readFileSync(photoPath)], { type: "image/png" }), "screenshot.png");
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, { method: "POST", body: form });
    } else {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
      });
    }
    log("Telegram enviado.");
  } catch (e) {
    log(`Erro Telegram: ${e.message}`);
  }
}

const NO_AVAIL = [
  "all appointments for this service are currently booked",
  "tutti gli appuntamenti per questo servizio sono attualmente prenotati",
  "nessun appuntamento disponibile",
  "non sono disponibili appuntamenti",
  "al momento non sono disponibili",
  "agenda completa",
  "no appointments available",
];

const HAS_AVAIL = [
  "seleziona data", "scegli data",
  "seleziona un orario", "scegli orario",
  "choose date", "choose a date", "select date",
];

async function doLogin(page) {
  log("Fazendo login...");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  let oauthUrl = await page.$eval('a[href*="iam.esteri.it"]', el => el.href).catch(() => null);
  if (!oauthUrl) {
    await page.goto(`${BASE}/Services`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    oauthUrl = await page.$eval('a[href*="iam.esteri.it"]', el => el.href).catch(() => null);
  }
  if (!oauthUrl) { log("URL OAuth não encontrada!"); return false; }

  await page.goto(oauthUrl, { waitUntil: "commit", timeout: 90_000 });
  await page.waitForSelector('input[name="callback_1"]', { timeout: 90_000 });
  await page.waitForTimeout(500);
  await page.fill('input[name="callback_1"]', EMAIL);
  await page.fill('input[name="callback_2"]', PASSWORD);
  await page.click('button:has-text("Next")');
  await page.waitForURL("**/prenotami.esteri.it/**", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (page.url().includes("iam.esteri.it")) { log("Login falhou."); return false; }
  log(`Login OK — ${page.url()}`);
  return true;
}

// Verifica um serviço. Reutiliza a sessão aberta — sem novo login.
async function checkService(page, service) {
  const url = `${BASE}/Services/Booking/${service.id}`;
  try {
    // Captura dialog (popup "sem vagas") que dispara ao carregar a página
    let dialogText = "";
    const dialogPromise = new Promise(resolve => {
      page.once("dialog", async (dialog) => {
        dialogText = dialog.message().toLowerCase();
        await dialog.accept();
        resolve();
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

    // Aguarda dialog por até 1500ms (dispara logo após o carregamento)
    await Promise.race([dialogPromise, new Promise(r => setTimeout(r, 1500))]);

    // Sessão expirou → redireciona para login
    if (page.url().includes("iam.esteri.it") || page.url().includes("/Home")) {
      return "expired";
    }

    if (dialogText && NO_AVAIL.some(p => dialogText.includes(p))) {
      log(`  [${service.name}] Sem vagas (popup)`);
      return false;
    }

    const body = (await page.innerText("body").catch(() => "")).toLowerCase();

    if (NO_AVAIL.some(p => body.includes(p))) {
      await page.click('button:has-text("OK"), button:has-text("Ok")').catch(() => {});
      log(`  [${service.name}] Sem vagas`);
      return false;
    }

    if (HAS_AVAIL.some(p => body.includes(p))) {
      log(`  [${service.name}] *** VAGA! ***`);
      return true;
    }

    if (page.url().includes("/Services") && !page.url().includes("/Booking/")) {
      log(`  [${service.name}] Sem vagas (redirecionado)`);
      return false;
    }

    const days = await page.$$(".day-available, .available, td.active:not(.disabled)");
    if (days.length > 0) {
      log(`  [${service.name}] *** CALENDÁRIO DISPONÍVEL! ***`);
      return true;
    }

    log(`  [${service.name}] Sem indicadores`);
    return false;
  } catch (e) {
    log(`  [${service.name}] Erro: ${e.message.split("\n")[0]}`);
    return false;
  }
}

async function createSession(browser) {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport:  { width: 1366, height: 768 },
    locale:    "pt-BR",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
    Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages",  { get: () => ["pt-BR", "pt", "en-US"] });
    window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function main() {
  log("=== Prenotami Bot iniciado ===");

  const browser = await chromium.launch({
    headless: IS_SERVER,
    channel:  IS_SERVER ? undefined : "chrome",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      ...(IS_SERVER ? ["--disable-gpu"] : ["--start-minimized"]),
    ],
  });

  let ctx, page;
  const notified = new Set();
  let ciclos = 0;

  // Login inicial
  ({ ctx, page } = await createSession(browser));
  let loggedIn = await doLogin(page);

  while (true) {
    // Se sessão inválida, refaz login
    if (!loggedIn) {
      await ctx.close().catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      ({ ctx, page } = await createSession(browser));
      loggedIn = await doLogin(page);
      if (!loggedIn) {
        await new Promise(r => setTimeout(r, 120_000));
        continue;
      }
    }

    ciclos++;
    try {
      let found = null;
      for (const service of SERVICES) {
        const result = await checkService(page, service);

        if (result === "expired") {
          log("Sessão expirou — refazendo login...");
          loggedIn = false;
          break;
        }

        if (result === true) {
          found = service;
          break;
        }
      }

      if (found) {
        if (!notified.has(found.id)) {
          await page.screenshot({ path: SCREENSHOT, fullPage: true }).catch(() => {});
          await telegram(
            `${found.emoji} <b>VAGA DISPONÍVEL!</b>\n\n` +
            `<b>Serviço:</b> ${found.name}\n\n` +
            `👉 Acesse AGORA:\n${BASE}/Services/Booking/${found.id}\n\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}`,
            SCREENSHOT
          );
          notified.add(found.id);
        }
      } else if (found === null) {
        notified.clear();
      }

      // Log resumido a cada 10 ciclos para não poluir
      if (ciclos % 10 === 0) log(`${ciclos} verificações completas — sem vagas.`);

    } catch (e) {
      log(`Erro: ${e.message.split("\n")[0]}`);
      loggedIn = false;
    }

    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

main().catch(console.error);
