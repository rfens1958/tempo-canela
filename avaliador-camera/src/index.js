// Cloudflare Worker: avalia com o Claude a foto da câmera do Parque Mundo a Vapor (Canela), o radar
// de Porto Alegre e o satélite GOES-19, para a página "Tempo em Canela".
//   GET /      -> avaliação (JSON)
//   GET /foto  -> a foto que foi avaliada (JPEG)
// A foto e a avaliação ficam guardadas no KV e só são renovadas 1 hora depois da
// renovação anterior, por mais vezes que a página seja aberta.
import Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "node:buffer";
import { hourly, recordCamera } from "./verify.js";

// Câmera 130 de camerasdaserra.com.br; as chaves do KV levam o número (e a versão da análise),
// para outra câmera ou outro formato de resposta começar do zero
const CAM_ID = "130-v3";
const CAM_NAME = "Parque Mundo a Vapor, Canela";
const CAM_URL = "https://files.rbt.psi.br/images/camerasdaserra/snapshots/6a875242028a1003e435c252/thumbnail.jpg";
const KEY_LAST = `last-${CAM_ID}`, KEY_PHOTO = `photo-${CAM_ID}`;
const RENEW_MS = 60 * 60 * 1000;
// Radar de Porto Alegre (Climatempo): radar_poa_1 é a imagem mais recente; as seguintes são cada vez mais
// antigas (~3,5 min entre elas), por isso a 9 fica uns 30 min antes da 1.
const RADAR_URL = (n) => `https://statics.climatempo.com.br/radar_poa/pngs/latest/radar_poa_${n}.png?nocache=${Date.now()}`;
// GOES-19 infravermelho (banda 13) via RealEarth/SSEC, centrado em Canela, norte para cima
const SAT_URL = () => `https://realearth.ssec.wisc.edu/api/image?products=G19-ABI-FD-BAND13&center=-29.37,-50.82&zoom=6&width=800&height=800&t=${Date.now()}`;
const ALLOWED_ORIGINS = ["https://rfens1958.github.io", "null"]; // "null" = página aberta como ficheiro local

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Uma ou duas frases em português do Brasil descrevendo o tempo visível agora." },
    category: { type: "string", enum: ["sun", "partly", "cloud", "fog", "drizzle", "rain", "showers", "storm", "snow", "night"] },
    daylight: { type: "string", enum: ["dia", "noite", "crepúsculo"] },
    sky: { type: "string", enum: ["limpo", "poucas nuvens", "parcialmente nublado", "nublado", "encoberto", "não visível"] },
    precipitation: { type: "string", enum: ["sem chuva", "garoa", "chuva fraca", "chuva moderada", "chuva forte", "indeterminado"] },
    ground: { type: "string", enum: ["seco", "úmido", "molhado", "com poças"] },
    visibility: { type: "string", enum: ["boa", "moderada", "reduzida", "muito reduzida"] },
    fog: { type: "boolean" },
    confidence: { type: "string", enum: ["alta", "média", "baixa"] },
    radar_time: { type: "string", description: "Hora local da imagem mais recente do radar, lida na legenda, no formato HH:MM." },
    radar_summary: { type: "string", description: "Uma frase curta: onde há chuva no radar em relação a Canela, intensidade e deslocamento." },
    satellite_summary: { type: "string", description: "Uma frase curta: nuvens sobre Canela e sistemas que se aproximam no satélite." },
    rain_next_3h: { type: "string", enum: ["improvável", "possível", "provável", "muito provável"] },
    rain_eta_hours: { type: "number", description: "Horas a partir de agora até a chuva chegar a Canela; 0 se já chove; -1 se não deve chover nas próximas 3 horas." },
    trend: { type: "string", enum: ["melhora", "estável", "piora"] },
    nowcast_summary: { type: "string", description: "Uma frase em português do Brasil sobre o que esperar em Canela nas próximas 3 horas, combinando câmera, radar e satélite." },
    // German versions for the page's German edition (an Austrian engineer on the Alpen Park works)
    radar_summary_de: { type: "string", description: "radar_summary em alemão (padrão da Áustria)." },
    satellite_summary_de: { type: "string", description: "satellite_summary em alemão (padrão da Áustria)." },
    nowcast_summary_de: { type: "string", description: "nowcast_summary em alemão (padrão da Áustria)." },
  },
  required: ["summary", "category", "daylight", "sky", "precipitation", "ground", "visibility", "fog", "confidence",
    "radar_time", "radar_summary", "satellite_summary", "rain_next_3h", "rain_eta_hours", "trend", "nowcast_summary",
    "radar_summary_de", "satellite_summary_de", "nowcast_summary_de"],
  additionalProperties: false,
};

const CAM_TEXT = `Imagem 1 - CÂMERA. Foto mais recente de uma câmera pública no Parque Mundo a Vapor, em Canela (Serra Gaúcha, RS, cerca de 830 m de altitude). Ela mostra a roda-gigante, uma avenida com carros e uma vista ampla do céu e dos morros ao fundo. O carimbo no topo da imagem mostra a data e a hora local.`;

const RADAR_TEXT = `Imagens 2 e 3 - RADAR meteorológico de Porto Alegre (refletividade em dBZ; a hora local está na legenda, em baixo à direita). A imagem 2 é a mais recente e a imagem 3 é cerca de 30 minutos anterior: compare-as para estimar o deslocamento e a velocidade das áreas de chuva. Canela NÃO está marcada no mapa: fica a cerca de 56% da largura e 31% da altura da imagem (a partir do canto superior esquerdo), cerca de 40 km a leste-sudeste de Caxias do Sul, entre Caxias do Sul e Torres e mais perto de Caxias. Escala aproximada: o círculo tracejado tem 150 km de raio em torno de Porto Alegre. Ecos abaixo de ~20 dBZ costumam ser chuva muito fraca ou ruído; fora do círculo o radar perde qualidade.`;

const SAT_TEXT = `Imagem 4 - SATÉLITE GOES-19, infravermelho (banda 13), sem contornos de mapa, norte para cima. Canela está exatamente no CENTRO da imagem. Cada pixel tem cerca de 2 km; a imagem cobre uns 1.700 km de lado. O oceano Atlântico fica a leste (a costa passa uns 100 km a leste de Canela) e a Lagoa dos Patos a sul-sudoeste. Nuvens claras são frias e altas (as mais brancas e compactas indicam convecção ou sistemas organizados); tons cinzentos escuros são superfície ou nuvens baixas.`;

const PROMPT = (nowLocal) => `Agora são ${nowLocal} (hora local de Canela). Tenha em conta que o radar pode estar atrasado em relação a agora.

1) Pela CÂMERA, avalie o tempo que se vê AGORA: céu e nuvens, nevoeiro ou neblina (comuns na região), visibilidade dos morros e prédios ao fundo, se está chovendo (pingos, gotas na lente, faróis e para-brisas, guarda-chuvas) e o estado do chão e do asfalto (seco, úmido, molhado, poças). Distinga chão molhado de chuva caindo: chão molhado sozinho indica chuva recente, não necessariamente chuva agora. Se for noite, avalie o que as luzes permitem ver e baixe a confiança. No "summary", escreva em português do Brasil, em uma ou duas frases curtas e concretas, sem mencionar a câmera nem a imagem. Para "category" escolha o ícone que melhor representa a condição atual ("night" só se estiver escuro).

2) Pelo RADAR e pelo SATÉLITE, faça uma previsão de curtíssimo prazo (próximas 3 horas) para Canela: há chuva perto, ela se aproxima ou se afasta, a que velocidade, e há nuvens organizadas a caminho? Seja conservador: só use "provável" ou "muito provável" se houver chuva no radar a uma distância e com um deslocamento compatíveis com chegar a Canela dentro de 3 horas, ou se já estiver chovendo. Sem ecos relevantes num raio de ~100 km e sem sistemas organizados no satélite, a chuva é "improvável". Escreva "radar_summary", "satellite_summary" e "nowcast_summary" em português do Brasil, em frases curtas e concretas, com distâncias e direções aproximadas. Repita esses três textos em alemão (padrão da Áustria) em "radar_summary_de", "satellite_summary_de" e "nowcast_summary_de", com o mesmo conteúdo.`;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" };
}

function json(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request), ...extra },
  });
}

const toBase64 = (buffer) => Buffer.from(buffer).toString("base64");

// Radar and satellite sites block Anthropic's URL fetcher (robots.txt), so the Worker downloads them;
// a missing image just leaves that part of the analysis out
async function imageBlock(url, mediaType) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    return { type: "image", source: { type: "base64", media_type: mediaType, data: toBase64(await r.arrayBuffer()) } };
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
    if (request.method !== "GET") return json({ error: "Use GET." }, 405, request);
    const path = new URL(request.url).pathname;

    if (path === "/stats") {
      const stats = await env.CAMERA.get("stats", "json");
      return json(stats || { days: 0 }, 200, request, { "Cache-Control": "public, max-age=600" });
    }

    if (path === "/foto") {
      const photo = await env.CAMERA.get(KEY_PHOTO, "arrayBuffer");
      if (!photo) return new Response("Ainda não há foto avaliada.", { status: 404, headers: corsHeaders(request) });
      return new Response(photo, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600", ...corsHeaders(request) },
      });
    }

    const last = await env.CAMERA.get(KEY_LAST, "json");
    if (last && Date.now() - Date.parse(last.renewed_at) < RENEW_MS) return json(last, 200, request, { "X-Cache": "HIT" });

    if (!env.ANTHROPIC_API_KEY) return json({ error: "Falta configurar a chave ANTHROPIC_API_KEY no Worker." }, 503, request);

    const img = await fetch(CAM_URL + "?t=" + Date.now(), { cf: { cacheTtl: 0 } });
    if (!img.ok) return last ? json(last, 200, request, { "X-Cache": "STALE" }) : json({ error: `A câmera não respondeu (HTTP ${img.status}).` }, 502, request);
    const imageTime = new Date(img.headers.get("Last-Modified") || Date.now()).toISOString();

    // The camera has not published a new photo: keep the previous assessment for another hour
    if (last && last.image_time === imageTime) {
      const kept = { ...last, renewed_at: new Date().toISOString() };
      ctx.waitUntil(env.CAMERA.put(KEY_LAST, JSON.stringify(kept)));
      return json(kept, 200, request, { "X-Cache": "SAME-PHOTO" });
    }

    const photo = await img.arrayBuffer();
    const nowLocal = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const [radarNow, radarBefore, sat] = await Promise.all([
      imageBlock(RADAR_URL(1), "image/png"), imageBlock(RADAR_URL(9), "image/png"), imageBlock(SAT_URL(), "image/png"),
    ]);
    const missing = [!(radarNow && radarBefore) && "radar", !sat && "satélite"].filter(Boolean);
    const missingText = missing.length ? `\n\nAtenção: não foi possível obter ${missing.join(" e ")} desta vez; baseie a previsão no que estiver disponível e baixe a confiança.` : "";
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    let response;
    try {
      response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: CAM_TEXT },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(photo) } },
            ...(radarNow && radarBefore ? [{ type: "text", text: RADAR_TEXT }, radarNow, radarBefore] : []),
            ...(sat ? [{ type: "text", text: SAT_TEXT }, sat] : []),
            { type: "text", text: PROMPT(nowLocal) + missingText },
          ],
        }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return json({ error: "A chave da API do Claude é inválida." }, 502, request);
      if (error instanceof Anthropic.RateLimitError) return json({ error: "Limite de pedidos da API atingido; tente daqui a pouco." }, 503, request);
      if (error instanceof Anthropic.APIError) return json({ error: `Erro da API do Claude (${error.status}): ${error.message}` }, 502, request);
      throw error;
    }

    if (response.stop_reason === "refusal") return json({ error: "O Claude recusou avaliar esta imagem." }, 502, request);
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return json({ error: `Resposta sem texto (${response.stop_reason}).` }, 502, request);

    const result = {
      ...JSON.parse(text),
      camera: CAM_NAME,
      image_url: CAM_URL,
      image_time: imageTime,
      analyzed_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      model: response.model,
    };
    // Photo first, so /foto never serves an older photo than the stored assessment describes
    await env.CAMERA.put(KEY_PHOTO, photo);
    await env.CAMERA.put(KEY_LAST, JSON.stringify(result));
    ctx.waitUntil(recordCamera(env, result).catch(() => {}));
    return json(result, 200, request, { "X-Cache": "MISS" });
  },

  // Autoverificação: registo de previsões e observações de hora em hora (ver verify.js)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourly(env, new Date(event.scheduledTime)));
  },
};
