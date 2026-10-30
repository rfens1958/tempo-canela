// Cloudflare Worker: avalia a foto da câmera da Praça João Corrêa (Canela) com o Claude
// para a página "Tempo em Canela".
//   GET /      -> avaliação (JSON)
//   GET /foto  -> a foto que foi avaliada (JPEG)
// A foto e a avaliação ficam guardadas no KV e só são renovadas 1 hora depois da
// renovação anterior, por mais vezes que a página seja aberta.
import Anthropic from "@anthropic-ai/sdk";

const CAM_URL = "https://files.rbt.psi.br/images/camerasdaserra/snapshots/6ac50858030d8003e45e1f7f/thumbnail.jpg";
const RENEW_MS = 60 * 60 * 1000;
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
  },
  required: ["summary", "category", "daylight", "sky", "precipitation", "ground", "visibility", "fog", "confidence"],
  additionalProperties: false,
};

const PROMPT = `Esta é a foto mais recente de uma câmera pública na Praça João Corrêa, no centro de Canela (Serra Gaúcha, RS, 837 m de altitude). O carimbo no topo da imagem mostra a data e a hora local.

Avalie o tempo que se vê AGORA na foto: céu, nevoeiro ou neblina (comuns na região), visibilidade dos morros e prédios ao fundo, se está chovendo (pingos, guarda-chuvas abertos, gotas na lente) e o estado do chão (seco, úmido, molhado, poças). Distinga chão molhado de chuva caindo: chão molhado sozinho indica chuva recente, não necessariamente chuva agora. Se for noite, avalie o que as luzes permitem ver e baixe a confiança.

No resumo, escreva em português do Brasil, em uma ou duas frases curtas e concretas, sem mencionar a câmera nem a imagem. Para "category" escolha o ícone que melhor representa a condição atual ("night" só se estiver escuro).`;

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

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
    if (request.method !== "GET") return json({ error: "Use GET." }, 405, request);
    const path = new URL(request.url).pathname;

    if (path === "/foto") {
      const photo = await env.CAMERA.get("photo", "arrayBuffer");
      if (!photo) return new Response("Ainda não há foto avaliada.", { status: 404, headers: corsHeaders(request) });
      return new Response(photo, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600", ...corsHeaders(request) },
      });
    }

    const last = await env.CAMERA.get("last", "json");
    if (last && Date.now() - Date.parse(last.renewed_at) < RENEW_MS) return json(last, 200, request, { "X-Cache": "HIT" });

    if (!env.ANTHROPIC_API_KEY) return json({ error: "Falta configurar a chave ANTHROPIC_API_KEY no Worker." }, 503, request);

    const img = await fetch(CAM_URL + "?t=" + Date.now(), { cf: { cacheTtl: 0 } });
    if (!img.ok) return last ? json(last, 200, request, { "X-Cache": "STALE" }) : json({ error: `A câmera não respondeu (HTTP ${img.status}).` }, 502, request);
    const imageTime = new Date(img.headers.get("Last-Modified") || Date.now()).toISOString();

    // The camera has not published a new photo: keep the previous assessment for another hour
    if (last && last.image_time === imageTime) {
      const kept = { ...last, renewed_at: new Date().toISOString() };
      ctx.waitUntil(env.CAMERA.put("last", JSON.stringify(kept)));
      return json(kept, 200, request, { "X-Cache": "SAME-PHOTO" });
    }

    const photo = await img.arrayBuffer();
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
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(photo) } },
            { type: "text", text: PROMPT },
          ],
        }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return json({ error: "A chave da API do Claude é inválida." }, 502, request);
      if (error instanceof Anthropic.RateLimitError) return json({ error: "Limite de pedidos da API atingido; tente daqui a pouco." }, 503, request);
      if (error instanceof Anthropic.APIError) return json({ error: `Erro da API do Claude (${error.status}).` }, 502, request);
      throw error;
    }

    if (response.stop_reason === "refusal") return json({ error: "O Claude recusou avaliar esta imagem." }, 502, request);
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return json({ error: `Resposta sem texto (${response.stop_reason}).` }, 502, request);

    const result = {
      ...JSON.parse(text),
      camera: "Praça João Corrêa, Canela",
      image_url: CAM_URL,
      image_time: imageTime,
      analyzed_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      model: response.model,
    };
    // Photo first, so /foto never serves an older photo than the stored assessment describes
    await env.CAMERA.put("photo", photo);
    await env.CAMERA.put("last", JSON.stringify(result));
    return json(result, 200, request, { "X-Cache": "MISS" });
  },
};
