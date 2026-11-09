// Autoverificação da página "Tempo em Canela".
// De hora em hora (cron): guarda o que os 10 modelos e os ensembles previam para as próximas 24 h e as
// observações (METAR do aeroporto de Caxias do Sul). Uma vez por dia: confronta previsões e observações do
// dia anterior e recalcula as estatísticas dos últimos 30 dias, incluindo as correções que a página aplica.
//
// Chaves no KV (CAMERA):
//   fc:YYYY-MM-DDTHH      previsões feitas nessa hora (local), para as 24 h seguintes
//   obs:<site>:YYYY-MM-DD observações do dia, por hora local
//   ver:YYYY-MM-DD        resultado da conferência desse dia
//   stats                 agregado dos últimos 30 dias + correções
//   changes               histórico das mudanças nas correções (para avisar o utilizador)

export const TZ = "America/Sao_Paulo";
export const MODELS = [
  "ecmwf_ifs025", "ecmwf_aifs025_single", "gfs_seamless", "ncep_aigfs025", "icon_seamless",
  "gem_seamless", "jma_seamless", "meteofrance_seamless", "ukmo_seamless", "cma_grapes_global",
];
// canela: observada pela câmera (chuva e céu, quando há análise); sbcx: METAR do aeroporto de Caxias do Sul
export const SITES = {
  canela: { lat: -29.3656, lon: -50.8158 },
  sbcx: { lat: -29.1971, lon: -51.1875, metar: "SBCX" },
};
const WET_MM = 0.2; // chuva numa hora: 0,2 mm ou mais
const STATS_DAYS = 30;
export const LEARN_MIN_DAYS = 14; // as correções só entram com pelo menos 14 dias conferidos
const LEARN_MIN_PAIRS = 100;
export const BUCKETS = [["1-3h", 1, 3], ["4-12h", 4, 12], ["13-24h", 13, 24]];
const RULES = ["pagina", "ensemble", "maioria", ...MODELS];
const SKY_HOURS = [6, 18]; // the sky is checked in daylight, the same hours the page's sunshine covers
const MODEL_NAME = {
  ecmwf_ifs025: "ECMWF IFS", ecmwf_aifs025_single: "ECMWF AIFS", gfs_seamless: "GFS", ncep_aigfs025: "AIGFS", icon_seamless: "ICON",
  gem_seamless: "GEM", jma_seamless: "JMA GSM", meteofrance_seamless: "ARPEGE", ukmo_seamless: "UKMO", cma_grapes_global: "GRAPES",
};
const median = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// ---------- horas locais (Brasil sem horário de verão: UTC-3 fixo) ----------
export function localKey(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
export const keyToDate = (key) => new Date(`${key}:00-03:00`);
export const addHours = (key, h) => localKey(new Date(keyToDate(key).getTime() + h * 3600e3));
export const addDaysISO = (date, n) => localKey(new Date(keyToDate(`${date}T12:00`).getTime() + n * 86400e3)).slice(0, 10);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ---------- registo de hora em hora ----------
export async function snapshotForecasts(env, now = new Date()) {
  const nowKey = localKey(now);
  const ids = Object.keys(SITES);
  const lat = ids.map((s) => SITES[s].lat).join(","), lon = ids.map((s) => SITES[s].lon).join(",");
  const q = (extra) => new URLSearchParams({ latitude: lat, longitude: lon, timezone: TZ, forecast_days: "2", ...extra });
  const [det, ens] = await Promise.all([
    fetch("https://api.open-meteo.com/v1/forecast?" + q({ hourly: "temperature_2m,precipitation,cloud_cover", models: MODELS.join(",") })).then((r) => r.json()),
    fetch("https://ensemble-api.open-meteo.com/v1/ensemble?" + q({ hourly: "precipitation", models: "ecmwf_ifs025,gfs025" })).then((r) => r.json()),
  ]);
  const dets = Array.isArray(det) ? det : [det], enss = Array.isArray(ens) ? ens : [ens];
  const endKey = addHours(nowKey, 24);
  const snap = { made: now.toISOString(), key: nowKey, sites: {} };
  ids.forEach((site, si) => {
    const d = dets[si], e = enss[si], hours = {};
    d.hourly.time.forEach((t, i) => {
      if (t <= nowKey || t > endKey) return;
      hours[t] = {
        m: MODELS.map((m) => round1(d.hourly[`temperature_2m_${m}`]?.[i])),
        p: MODELS.map((m) => round1(d.hourly[`precipitation_${m}`]?.[i])),
        c: MODELS.map((m) => d.hourly[`cloud_cover_${m}`]?.[i] ?? null),
      };
    });
    if (e?.hourly) {
      const keys = Object.keys(e.hourly).filter((k) => k.startsWith("precipitation"));
      e.hourly.time.forEach((t, i) => {
        if (!hours[t]) return;
        let wet = 0, total = 0;
        keys.forEach((k) => { const v = e.hourly[k][i]; if (v != null) { total++; if (v >= WET_MM) wet++; } });
        hours[t].e = [wet, total];
      });
    }
    snap.sites[site] = hours;
  });
  await env.CAMERA.put(`fc:${nowKey.slice(0, 13)}`, JSON.stringify(snap), { expirationTtl: 40 * 86400 });
  return snap;
}

// METAR: temperatura do grupo "TT/DD", chuva pelos códigos de tempo presente (RA, DZ, SH, TS) ou recente (RE..)
// e nebulosidade (%) pela camada mais coberta: FEW 1-2 oitavos, SCT 3-4, BKN 5-7, OVC 8
const METAR_COVER = { SKC: 0, CLR: 0, NSC: 0, NCD: 0, FEW: 19, SCT: 44, BKN: 75, OVC: 100 };
export function parseMetar(raw) {
  const body = raw.replace(/\s(RMK|TEMPO|BECMG)\s.*$/, "");
  const tm = body.match(/\s(M?\d{2})\/(M?\d{2}|\/\/)?(\s|$)/);
  const t = tm ? (tm[1].startsWith("M") ? -1 : 1) * +tm[1].replace("M", "") : null;
  const wet = /(^|\s)(RE)?[-+]?(VC)?(TS|SH)?(RA|DZ|GR|GS)\b|(^|\s)[-+]?TS(\s|$)/.test(body.replace(/\sVC\w+/g, ""));
  let c = /\sCAVOK(\s|$)/.test(body) ? 0 : null;
  for (const m of body.matchAll(/\s(SKC|CLR|NSC|NCD|FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)?/g)) c = Math.max(c ?? 0, METAR_COVER[m[1]]);
  if (/\sVV(\d{3}|\/\/\/)/.test(body)) c = 100; // sky obscured (fog)
  return { t, wet, c };
}

export async function recordMetar(env) {
  const site = "sbcx";
  const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${SITES[site].metar}&format=json&hours=6`);
  if (!r.ok) return 0;
  const list = await r.json();
  const byDate = {};
  list.forEach((m) => {
    // Only the routine hourly reports (HH:00); SPECIs in between are skipped
    const when = new Date(m.reportTime || m.obsTime * 1000);
    if (when.getUTCMinutes() !== 0) return;
    const key = localKey(when), { t, wet, c } = parseMetar(m.rawOb || "");
    (byDate[key.slice(0, 10)] ||= {})[key.slice(11, 13)] = { t, wet, c, raw: m.rawOb };
  });
  for (const [date, hours] of Object.entries(byDate)) {
    const k = `obs:${site}:${date}`;
    const doc = (await env.CAMERA.get(k, "json")) || {};
    await env.CAMERA.put(k, JSON.stringify({ ...doc, ...hours }), { expirationTtl: 40 * 86400 });
  }
  return list.length;
}

// Chamado depois de cada análise da câmera: regista se chovia em Canela na hora da foto e, de dia, o céu
const CAMERA_COVER = { limpo: 5, "poucas nuvens": 20, "parcialmente nublado": 45, nublado: 75, encoberto: 95 };
export async function recordCamera(env, result) {
  const wetCats = ["garoa", "chuva fraca", "chuva moderada", "chuva forte"];
  const wet = result.precipitation === "indeterminado" ? null : wetCats.includes(result.precipitation);
  const c = result.daylight === "dia" ? CAMERA_COVER[result.sky] ?? null : null;
  if (wet == null && c == null) return;
  const key = localKey(new Date(result.image_time));
  const k = `obs:canela:${key.slice(0, 10)}`;
  const doc = (await env.CAMERA.get(k, "json")) || {};
  doc[key.slice(11, 13)] = { t: null, wet, c, src: "camera" };
  await env.CAMERA.put(k, JSON.stringify(doc), { expirationTtl: 40 * 86400 });
}

// ---------- conferência diária ----------
const emptyCont = () => [0, 0, 0, 0]; // [acerto, falha (não previu), falso alarme, acerto negativo]
function addCont(c, forecastWet, obsWet) {
  c[forecastWet ? (obsWet ? 0 : 2) : (obsWet ? 1 : 3)]++;
}

export async function verifyDay(env, date) {
  // Snapshots that can cover any hour of `date`: from the previous day 00h up to `date` 22h
  const snapKeys = [];
  for (let k = `${addDaysISO(date, -1)}T00:00`; k < `${date}T23:00`; k = addHours(k, 1)) snapKeys.push(k);
  const snaps = (await Promise.all(snapKeys.map((k) => env.CAMERA.get(`fc:${k.slice(0, 13)}`, "json")))).filter(Boolean);
  const out = { date, snapshots: snaps.length, sites: {} };
  for (const site of Object.keys(SITES)) {
    const obs = (await env.CAMERA.get(`obs:${site}:${date}`, "json")) || {};
    const temp = {}, rain = {}, rel = Array.from({ length: 10 }, () => [0, 0]);
    const sky = {}; // model -> [n, soma dos erros, soma dos erros absolutos] da nebulosidade (pontos %)
    const sun = [0, 0, 0]; // [n, céu limpo previsto (como a página o calcula), céu limpo observado]
    let obsHours = 0;
    for (const [hh, o] of Object.entries(obs)) {
      const key = `${date}T${hh}:00`;
      const daylight = +hh >= SKY_HOURS[0] && +hh <= SKY_HOURS[1];
      obsHours++;
      for (const s of snaps) {
        const f = s.sites[site]?.[key];
        if (!f) continue;
        const lead = Math.round((keyToDate(key) - keyToDate(s.key)) / 3600e3);
        const bucket = BUCKETS.find(([, a, b]) => lead >= a && lead <= b)?.[0];
        if (!bucket) continue;
        if (o.t != null) {
          const tb = (temp[bucket] ||= {});
          f.m.forEach((v, i) => {
            if (v == null) return;
            const a = (tb[MODELS[i]] ||= [0, 0, 0]); // [n, soma dos erros, soma dos erros absolutos]
            a[0]++; a[1] += v - o.t; a[2] += Math.abs(v - o.t);
          });
        }
        if (o.wet != null) {
          const rb = (rain[bucket] ||= Object.fromEntries(RULES.map((r) => [r, emptyCont()])));
          const valid = f.p.filter((v) => v != null);
          const wetModels = valid.filter((v) => v >= WET_MM).length;
          const majority = valid.length > 0 && wetModels / valid.length >= 0.5;
          const prob = f.e && f.e[1] >= 20 ? f.e[0] / f.e[1] : null;
          if (prob != null) {
            addCont(rb.ensemble, prob >= 0.5, o.wet);
            addCont(rb.pagina, prob >= 0.5 && majority, o.wet);
            const bin = Math.min(9, Math.floor(prob * 10));
            rel[bin][0]++; if (o.wet) rel[bin][1]++;
          }
          addCont(rb.maioria, majority, o.wet);
          f.p.forEach((v, i) => { if (v != null) addCont(rb[MODELS[i]], v >= WET_MM, o.wet); });
        }
        if (o.c != null && daylight && f.c) {
          f.c.forEach((v, i) => {
            if (v == null) return;
            const a = (sky[MODELS[i]] ||= [0, 0, 0]);
            a[0]++; a[1] += v - o.c; a[2] += Math.abs(v - o.c);
          });
          // The page's clear-sky share for the hour: median of the models, an hour in which a model rains counting little
          const clear = median(f.c.map((v, i) => (v == null ? null : (1 - v / 100) * ((f.p[i] ?? 0) >= 0.5 ? 0.3 : 1))));
          if (clear != null) { sun[0]++; sun[1] += clear; sun[2] += 1 - o.c / 100; }
        }
      }
    }
    out.sites[site] = { obsHours, temp, rain, rel, sky, sun };
  }
  await env.CAMERA.put(`ver:${date}`, JSON.stringify(out), { expirationTtl: 400 * 86400 });
  return out;
}

// ---------- estatísticas dos últimos 30 dias e correções ----------
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
function scores(c) {
  const [hit, miss, fa, cn] = c;
  return {
    n: hit + miss + fa + cn, hit, miss, fa, cn,
    pod: pct(hit, hit + miss), // das horas em que choveu, quantas foram previstas
    far: pct(fa, hit + fa), // dos avisos de chuva, quantos não se confirmaram
    acc: pct(hit + cn, hit + miss + fa + cn), // acerto geral (chuva e sem chuva)
  };
}

export async function rebuildStats(env, today = localKey(new Date()).slice(0, 10)) {
  const previous = await env.CAMERA.get("stats", "json");
  const dates = Array.from({ length: STATS_DAYS }, (_, i) => addDaysISO(today, -1 - i));
  const vers = (await Promise.all(dates.map((d) => env.CAMERA.get(`ver:${d}`, "json")))).filter(Boolean);
  const days = vers.filter((v) => Object.values(v.sites).some((s) => s.obsHours > 0));
  const stats = { updated: new Date().toISOString(), days: days.length, from: days.at(-1)?.date ?? null, to: days[0]?.date ?? null, sites: {} };
  for (const site of Object.keys(SITES)) {
    const tempAll = {}, tempByBucket = {}, rainByBucket = {}, rainAll = Object.fromEntries(RULES.map((r) => [r, emptyCont()]));
    const rel = Array.from({ length: 10 }, () => [0, 0]);
    const skyAll = {}, sunAll = [0, 0, 0];
    let obsHours = 0;
    for (const v of days) {
      const s = v.sites[site];
      if (!s) continue;
      obsHours += s.obsHours;
      for (const [m, a] of Object.entries(s.sky || {})) { const t = (skyAll[m] ||= [0, 0, 0]); t[0] += a[0]; t[1] += a[1]; t[2] += a[2]; }
      (s.sun || [0, 0, 0]).forEach((x, i) => { sunAll[i] += x; });
      for (const [b, models] of Object.entries(s.temp)) for (const [m, a] of Object.entries(models)) {
        for (const tgt of [(tempAll[m] ||= [0, 0, 0]), ((tempByBucket[b] ||= {})[m] ||= [0, 0, 0])]) { tgt[0] += a[0]; tgt[1] += a[1]; tgt[2] += a[2]; }
      }
      for (const [b, rules] of Object.entries(s.rain)) for (const [r, c] of Object.entries(rules)) {
        const tb = ((rainByBucket[b] ||= {})[r] ||= emptyCont());
        c.forEach((x, i) => { tb[i] += x; rainAll[r][i] += x; });
      }
      s.rel.forEach(([n, w], i) => { rel[i][0] += n; rel[i][1] += w; });
    }
    const tempOut = Object.fromEntries(Object.entries(tempAll).map(([m, [n, sum, abs]]) => [m, { n, bias: round1(sum / n), mae: round1(abs / n) }]));
    stats.sites[site] = {
      obsHours,
      temp: tempOut,
      tempByBucket: Object.fromEntries(Object.entries(tempByBucket).map(([b, ms]) => [b, Object.fromEntries(Object.entries(ms).map(([m, [n, sum, abs]]) => [m, { n, bias: round1(sum / n), mae: round1(abs / n) }]))])),
      rain: Object.fromEntries(Object.entries(rainAll).map(([r, c]) => [r, scores(c)])),
      rainByBucket: Object.fromEntries(Object.entries(rainByBucket).map(([b, rules]) => [b, Object.fromEntries(Object.entries(rules).map(([r, c]) => [r, scores(c)]))])),
      reliability: rel.map(([n, w], i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n, observed: pct(w, n) })),
      sky: Object.fromEntries(Object.entries(skyAll).map(([m, [n, sum, abs]]) => [m, { n, bias: Math.round(sum / n), mae: Math.round(abs / n) }])),
      // Clear sky over the daylight hours checked: what the page expected and what was seen
      sun: { n: sunAll[0], predicted: sunAll[0] ? Math.round((sunAll[1] / sunAll[0]) * 100) : null, observed: sunAll[0] ? Math.round((sunAll[2] / sunAll[0]) * 100) : null },
    };
  }

  // Learned corrections (from Caxias do Sul METAR, the site with temperature and hourly observations)
  const ref = stats.sites.sbcx;
  const active = stats.days >= LEARN_MIN_DAYS;
  const bias = {}, weights = {};
  let wSum = 0;
  for (const m of MODELS) {
    const t = ref.temp[m];
    if (!t || t.n < LEARN_MIN_PAIRS) continue;
    bias[m] = t.bias;
    weights[m] = 1 / Math.max(0.5, t.mae) ** 2;
    wSum += weights[m];
  }
  for (const m of Object.keys(weights)) weights[m] = Math.round((weights[m] / wSum) * 1000) / 1000;
  // Ensemble rain chance calibration: observed frequency per 10% bin, where the bin has enough cases
  const calib = ref.reliability.map((r) => (r.n >= 20 ? r.observed : null));
  // Sunshine: ratio of observed to expected clear sky, from Caxias do Sul (METAR) and the Canela camera together
  const sunN = Object.values(stats.sites).reduce((a, s) => a + s.sun.n, 0);
  const sunPred = Object.values(stats.sites).reduce((a, s) => a + (s.sun.predicted ?? 0) * s.sun.n, 0);
  const sunObs = Object.values(stats.sites).reduce((a, s) => a + (s.sun.observed ?? 0) * s.sun.n, 0);
  const sunFactor = sunN >= LEARN_MIN_PAIRS && sunPred > 0 ? Math.round(Math.min(1.5, Math.max(0.5, sunObs / sunPred)) * 100) / 100 : null;
  stats.learning = { active, minDays: LEARN_MIN_DAYS, tempBias: bias, weights, rainCalib: calib, sunFactor };

  // Tell the user what the self-checking changed: compare with yesterday's corrections and keep a log
  const items = describeChanges(previous?.learning, stats.learning, stats.days);
  const log = (await env.CAMERA.get("changes", "json")) || [];
  if (items.length) {
    log.unshift({ date: today, items });
    await env.CAMERA.put("changes", JSON.stringify(log.slice(0, 60)));
  }
  stats.changes = log.slice(0, 10);
  await env.CAMERA.put("stats", JSON.stringify(stats));
  return stats;
}

// Each change in both languages: { pt, de }
const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1).replace(".", ",");
const dec2 = (v) => v.toFixed(2).replace(".", ",");
export function describeChanges(prev, cur, days) {
  const out = [];
  if (!cur.active) {
    if (prev?.active) out.push({ pt: `Correções automáticas suspensas: só ${days} dias conferidos (são precisos ${cur.minDays}).`, de: `Automatische Korrekturen ausgesetzt: nur ${days} ausgewertete Tage (nötig sind ${cur.minDays}).` });
    return out;
  }
  if (!prev?.active) {
    const nT = Object.keys(cur.tempBias).length, nC = cur.rainCalib.filter((x) => x != null).length;
    out.push({
      pt: `Correções automáticas ativadas após ${days} dias conferidos: temperatura de ${nT} modelos, pesos do consenso, chance de chuva calibrada em ${nC} ${nC === 1 ? "faixa" : "faixas"}${cur.sunFactor != null ? `, horas de sol ×${dec2(cur.sunFactor)}` : ''}.`,
      de: `Automatische Korrekturen aktiviert nach ${days} ausgewerteten Tagen: Temperatur von ${nT} Modellen, Gewichte im Konsens, Regenwahrscheinlichkeit in ${nC} ${nC === 1 ? "Stufe" : "Stufen"} kalibriert${cur.sunFactor != null ? `, Sonnenstunden ×${dec2(cur.sunFactor)}` : ''}.`,
    });
    return out;
  }
  for (const [m, b] of Object.entries(cur.tempBias)) {
    const was = prev.tempBias?.[m];
    if (was == null || Math.abs(b - was) >= 0.5) {
      out.push({ pt: `Temperatura do ${MODEL_NAME[m]}: correção passa de ${was == null ? "nenhuma" : sgn(-was) + " °C"} para ${sgn(-b)} °C.`, de: `Temperatur ${MODEL_NAME[m]}: Korrektur von ${was == null ? "keiner" : sgn(-was) + " °C"} auf ${sgn(-b)} °C.` });
    }
  }
  const top = (w) => Object.entries(w || {}).sort((a, b) => b[1] - a[1])[0];
  const [topNow, wNow] = top(cur.weights) || [], [topWas] = top(prev.weights) || [];
  if (topNow && topNow !== topWas) out.push({ pt: `O modelo com mais peso no consenso passou a ser o ${MODEL_NAME[topNow]} (${Math.round(wNow * 100)}%).`, de: `Das Modell mit dem höchsten Gewicht im Konsens ist jetzt ${MODEL_NAME[topNow]} (${Math.round(wNow * 100)} %).` });
  cur.rainCalib.forEach((v, i) => {
    const was = prev.rainCalib?.[i];
    if (v != null && (was == null || Math.abs(v - was) >= 10)) {
      out.push({ pt: `Chance de chuva: quando os ensembles indicam ${i * 10}–${i * 10 + 10}%, a página passa a mostrar ${v}%.`, de: `Regenwahrscheinlichkeit: zeigen die Ensembles ${i * 10}–${i * 10 + 10} %, zeigt die Seite jetzt ${v} %.` });
    }
  });
  if (cur.sunFactor != null && (prev.sunFactor == null || Math.abs(cur.sunFactor - prev.sunFactor) >= 0.1)) {
    const more = cur.sunFactor < 1;
    out.push({
      pt: `Horas de sol: fator de correção passa a ×${dec2(cur.sunFactor)} (os modelos previam ${more ? "mais" : "menos"} sol do que o observado).`,
      de: `Sonnenstunden: Korrekturfaktor jetzt ×${dec2(cur.sunFactor)} (die Modelle sagten ${more ? "mehr" : "weniger"} Sonne voraus als beobachtet).`,
    });
  }
  return out;
}

// Corre a cada hora: regista, e uma vez por dia (01h local) confere o dia anterior
export async function hourly(env, now = new Date()) {
  const results = await Promise.allSettled([snapshotForecasts(env, now), recordMetar(env)]);
  const key = localKey(now);
  const stats = await env.CAMERA.get("stats", "json");
  if (key.slice(11, 13) === "01" || !stats) {
    const yesterday = addDaysISO(key.slice(0, 10), -1);
    await verifyDay(env, yesterday);
    await rebuildStats(env, key.slice(0, 10));
  }
  return results.map((r) => r.status);
}
