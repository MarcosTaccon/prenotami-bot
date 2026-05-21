import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import "dotenv/config";

// Ativa patches anti-detecção (bypassam Radware, fingerprinting, etc.)
chromium.use(StealthPlugin());

const EMAIL          = process.env.PRENOTAMI_EMAIL;
const PASSWORD       = process.env.PRENOTAMI_PASSWORD;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const INTERVAL       = parseInt(process.env.CHECK_INTERVAL_SECONDS ?? "180") * 1000;

const BASE       = "https://prenotami.esteri.it";
const IS_SERVER  = process.env.RAILWAY_ENVIRONMENT !== undefined || process.env.IS_SERVER === "true";
const SCREENSHOT = IS_SERVER ? "/tmp/ultima_verificacao.png" : "C:/Users/Marcos/Documents/Marcos/CLAUDE/PRENOTAMI-BOT/ultima_verificacao.png";

// Apenas estes serviços são monitorados e geram notificação
const PRIORITY_SERVICES = [
  { id: "5967", name: "Richiesta CIE",                    emoji: "🪪" },
  { id: "4705", name: "Passaporte — Consulado Curitiba",  emoji: "🛂" },
  { id: "5623", name: "Passaporte — Florianópolis",       emoji: "🛂" },
];

const ALL_SERVICES = PRIORITY_SERVICES;

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

// Textos que aparecem no popup/alerta quando NÃO há vagas
const NO_AVAIL = [
  "all appointments for this service are currently booked",
  "nessun appuntamento disponibile",
  "non sono disponibili appuntamenti",
  "al momento non sono disponibili",
  "agenda completa",
  "no appointments available",
  "tutti gli appuntamenti per questo servizio sono attualmente prenotati",
];

// Textos que indicam presença de formulário de agendamento (HAR vagas)
const HAS_AVAIL = [
  "seleziona data",
  "scegli data",
  "seleziona un orario",
  "scegli orario",
  "seleccione fecha",
  "choose date",
  "choose a date",
  "select date",
];

async function doLogin(page) {
  log("Carregando home do Prenotami...");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // Tenta obter a URL OAuth do link na home; se não achar, vai direto para /Services
  // que redireciona para o login automaticamente
  let oauthUrl = await page.$eval('a[href*="iam.esteri.it"]', (el) => el.href).catch(() => null);

  if (!oauthUrl) {
    log("Link OAuth não encontrado na home — tentando via /Services...");
    await page.goto(`${BASE}/Services`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    // /Services redireciona para login quando não autenticado
    oauthUrl = await page.$eval('a[href*="iam.esteri.it"]', (el) => el.href).catch(() => null);
  }

  if (!oauthUrl) { log("URL OAuth não encontrada!"); return false; }

  log("Abrindo login IAM...");
  await page.goto(oauthUrl, { waitUntil: "commit", timeout: 90_000 });
  await page.waitForSelector('input[name="callback_1"]', { timeout: 90_000 });
  await page.waitForTimeout(500);

  await page.fill('input[name="callback_1"]', EMAIL);
  await page.fill('input[name="callback_2"]', PASSWORD);
  await page.click('button:has-text("Next")');

  await page.waitForURL("**/prenotami.esteri.it/**", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  if (page.url().includes("iam.esteri.it")) {
    log("Login falhou — ainda no IAM.");
    return false;
  }
  log(`Login OK — ${page.url()}`);
  return true;
}

// Verifica um serviço específico. Retorna true se há vaga, false se não.
async function checkService(page, service) {
  const url = `${BASE}/Services/Booking/${service.id}`;
  try {
    // Configura listener de dialog ANTES de navegar
    let dialogText = "";
    page.once("dialog", async (dialog) => {
      dialogText = dialog.message().toLowerCase();
      await dialog.accept();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Verifica popup nativo (alert/confirm do browser)
    if (dialogText && NO_AVAIL.some((p) => dialogText.includes(p))) {
      log(`  [${service.name}] Sem vagas (popup)`);
      return false;
    }

    // Verifica texto da página (inclui modais HTML)
    const body = (await page.innerText("body")).toLowerCase();

    if (NO_AVAIL.some((p) => body.includes(p))) {
      log(`  [${service.name}] Sem vagas`);
      // Fecha qualquer modal OK que esteja aberto
      await page.click('button:has-text("OK"), button:has-text("Ok")').catch(() => {});
      return false;
    }

    if (HAS_AVAIL.some((p) => body.includes(p))) {
      log(`  [${service.name}] *** VAGA DISPONÍVEL! ***`);
      return true;
    }

    // Verifica se a URL mudou para página de serviços (sem vaga → redireciona)
    if (page.url().includes("/Services") && !page.url().includes("/Booking/")) {
      log(`  [${service.name}] Sem vagas (redirecionado)`);
      return false;
    }

    // Verifica calendário com dias clicáveis
    const days = await page.$$(".day-available, .available, td.active:not(.disabled), [class*='available']:not([class*='disabled'])");
    if (days.length > 0) {
      log(`  [${service.name}] *** CALENDÁRIO COM ${days.length} DIA(S) DISPONÍVEL! ***`);
      return true;
    }

    log(`  [${service.name}] Sem indicadores claros`);
    return false;
  } catch (e) {
    log(`  [${service.name}] Erro: ${e.message.split("\n")[0]}`);
    return false;
  }
}

// Verifica todos os serviços em ordem de prioridade.
// Retorna o serviço com vaga ou null.
async function checkAllSlots(page) {
  log("Verificando serviços em ordem de prioridade...");

  for (const service of ALL_SERVICES) {
    const hasSlot = await checkService(page, service);
    if (hasSlot) return service;
  }

  return null;
}

async function main() {
  log("=== Prenotami Bot iniciado ===");

  const browser = await chromium.launch({
    headless: IS_SERVER,          // headless no servidor, visível no PC
    channel:  IS_SERVER ? undefined : "chrome",  // Chrome real só no PC
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      ...(IS_SERVER ? ["--disable-gpu"] : ["--start-minimized"]),
    ],
  });

  while (true) {
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

    try {
      const logged = await doLogin(page);

      if (logged) {
        const found = await checkAllSlots(page);

        if (found) {
          await page.screenshot({ path: SCREENSHOT, fullPage: true });
          await telegram(
            `${found.emoji} <b>VAGA DISPONÍVEL!</b>\n\n` +
            `<b>Serviço:</b> ${found.name}\n\n` +
            "👉 Acesse AGORA:\n" +
            `${BASE}/Services/Booking/${found.id}\n\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}`,
            SCREENSHOT
          );
          log(`Vaga detectada em [${found.name}]! Pausando 10 minutos...`);
          await new Promise((r) => setTimeout(r, 600_000));
        } else {
          log(`Sem vagas em nenhum serviço. Próxima verificação em ${INTERVAL / 1000}s.`);
        }
      } else {
        log("Login falhou — aguardando 5 min para tentar novamente.");
        await new Promise((r) => setTimeout(r, 300_000));
      }
    } catch (e) {
      log(`Erro geral: ${e.message.split("\n")[0]}`);
    } finally {
      await ctx.close();
    }

    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch(console.error);
