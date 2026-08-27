import type { Evidence } from "./quant.js";
import { orderByPerformance, recordSuccess, recordFailure, canCall, noteCall } from "./modelStats.js";
import { loadBlockUntil, saveBlockUntil } from "./budget.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_TTL_MS = 60 * 60 * 1000;
// The free quota is per key, so asking more providers only wastes it.
const MAX_MODELS_PER_PREDICTION = 4;

export type Prediction = {
  probability: number;
  confidence: "low" | "medium" | "high";
  reasoning: string;
  key_factors: [string, string, string];
};

export type PredictionResult =
  | { status: "ok"; prediction: Prediction; model: string }
  | { status: "unavailable"; reason: string };

/**
 * Provider enforced shape. A model that supports this cannot answer with prose,
 * which on a fixed daily allowance matters more than raw capability: a request
 * that comes back unparseable is a request that cannot be retried for free.
 */
const PREDICTION_SCHEMA = {
  type: "object",
  properties: {
    probability: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string", maxLength: 200 },
    key_factors: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
  },
  required: ["probability", "confidence", "reasoning", "key_factors"],
  additionalProperties: false,
} as const;

/**
 * Schema capable first, strongest to fastest, then the one model with a real
 * settled track record. nemotron-3-ultra cannot be held to a schema, but it is
 * 15/18 on settled windows in predictions.json, which outweighs the parse risk
 * for a fourth slot. MAX_MODELS_PER_PREDICTION means all four get asked.
 */
const PREFERRED = [/glm-5/i, /nemotron-3-super/i, /lfm-2\.5/i, /nemotron-3-ultra/i];

let cachedModels: { ids: string[]; fetchedAt: number } | null = null;
// Ids the catalog reports as accepting a json_schema response format.
let schemaCapable = new Set<string>();

export function supportsSchema(id: string): boolean {
  return schemaCapable.has(id);
}

/**
 * OpenRouter caps free models per ACCOUNT per day, not per model. When that cap
 * is hit every id in the catalog returns the same 429, so walking the fallback
 * list spends four requests to learn one fact. Latch the reset instead.
 */
class DailyQuotaError extends Error {
  constructor(readonly resetAt: number) {
    super("daily free quota exhausted");
  }
}

// Restored across restarts: rediscovering the cap costs real requests.
let quotaResetAt = loadBlockUntil();

/** Milliseconds until the free tier resets, or 0 when there is budget. */
export function quotaBlockedFor(): number {
  return Date.now() < quotaResetAt ? quotaResetAt - Date.now() : 0;
}

function describeBlock(): string {
  const mins = Math.ceil(quotaBlockedFor() / 60_000);
  return `daily free model quota exhausted, resets in ${mins} min`;
}

type CatalogModel = {
  id: string;
  pricing?: Record<string, string>;
  architecture?: { output_modalities?: string[] };
  supported_parameters?: string[];
};

// Classifiers and media models are zero priced but can never answer a contract.
const UNUSABLE = /safety|moderation|guard|lyria|whisper|tts|embed/i;
/**
 * A meta router that dispatches to an unnamed free model. The tracker stores
 * result.model against every record, so this id would attribute predictions
 * from several different models to one row and quietly corrupt the scoreboard.
 */
const UNATTRIBUTABLE = /^openrouter\/(free|auto)$/i;

function isFree(model: CatalogModel): boolean {
  const p = model.pricing;
  if (!p) return false;
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

/**
 * Zero priced is not the same as usable. The catalog carries music and content
 * safety models at zero cost; asking them for JSON burns the daily free quota
 * for a guaranteed failure, so filter on what the model can actually emit.
 */
function canPredict(model: CatalogModel): boolean {
  const out = model.architecture?.output_modalities;
  if (out && !(out.length === 1 && out[0] === "text")) return false;
  return !UNUSABLE.test(model.id) && !UNATTRIBUTABLE.test(model.id);
}

// Never hardcode an id. Rank the zero priced set and keep a primary plus fallback.
export async function freeModels(): Promise<string[]> {
  if (cachedModels && Date.now() - cachedModels.fetchedAt < MODEL_TTL_MS) return cachedModels.ids;

  const res = await fetch(MODELS_URL);
  if (!res.ok) throw new Error(`model list ${res.status}`);
  const json = (await res.json()) as { data: CatalogModel[] };

  const usable = json.data.filter((m) => isFree(m) && canPredict(m));
  schemaCapable = new Set(
    usable.filter((m) => m.supported_parameters?.includes("structured_outputs")).map((m) => m.id),
  );
  const free = usable.map((m) => m.id);
  const score = (id: string) => {
    const i = PREFERRED.findIndex((rx) => rx.test(id));
    return i === -1 ? PREFERRED.length : i;
  };
  const ids = free.sort((a, b) => score(a) - score(b));

  if (ids.length === 0) throw new Error("no zero priced models available");
  cachedModels = { ids, fetchedAt: Date.now() };
  return ids;
}

export function isPrediction(value: unknown): value is Prediction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (typeof v.probability !== "number" || !Number.isFinite(v.probability)) return false;
  if (v.probability < 0 || v.probability > 1) return false;
  if (v.confidence !== "low" && v.confidence !== "medium" && v.confidence !== "high") return false;
  if (typeof v.reasoning !== "string" || v.reasoning.length === 0 || v.reasoning.length > 200) return false;
  if (!Array.isArray(v.key_factors) || v.key_factors.length !== 3) return false;
  return v.key_factors.every((f) => typeof f === "string" && f.length > 0);
}

// Models sometimes wrap JSON in prose or fences despite instructions.
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * A schema pins the fields but not every provider honours maxLength. On a fixed
 * daily allowance, trimming an overlong narrative beats spending another
 * request to ask for a shorter one.
 */
function normalize(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (typeof v.reasoning === "string" && v.reasoning.length > 200) {
    v.reasoning = `${v.reasoning.slice(0, 197).trimEnd()}...`;
  }
  return v;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function buildPrompt(e: Evidence): string {
  const minutes = (e.tauSeconds / 60).toFixed(1);
  const distance = ((e.spot / e.strike - 1) * 100).toFixed(3);
  const market = e.marketProbability === null ? "no trades yet" : pct(e.marketProbability);

  return [
    `Contract: will ${e.asset} be at or above ${e.strike} when the window closes in ${minutes} minutes?`,
    ``,
    `Computed evidence, all from live venue data. Do not override these numbers with your own price beliefs.`,
    `- Spot now: ${e.spot}`,
    `- Strike: ${e.strike} (spot is ${distance}% from strike)`,
    `- Time to expiry: ${e.tauSeconds} seconds`,
    `- Annualised realised volatility: ${e.vol.toFixed(3)}`,
    `- Lognormal digital estimate: ${pct(e.modelProbability)}`,
    `- Historical base rate at similar moneyness: ${pct(e.baseRateProbability)} over ${e.baseRateSample} settled windows`,
    `- Current market implied: ${market}`,
    ``,
    `Reconcile the estimates into one probability that the up side resolves true.`,
    `Weight the digital estimate most when the sample size is small.`,
    `Set confidence from how much the estimates agree and how large the sample is.`,
    `Widely disagreeing estimates or a sample under 30 means low confidence.`,
    ``,
    `Reply with only this JSON object and nothing else. No prose. No markdown fences.`,
    `{"probability": 0.0, "confidence": "low", "reasoning": "under 200 chars", "key_factors": ["", "", ""]}`,
  ].join("\n");
}

async function callModel(model: string, prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: "You output a single raw JSON object. Never use markdown fences or prose." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1200,
    // Ask providers to skip visible reasoning; ignored where unsupported.
    reasoning: { exclude: true },
  };

  // Where the provider can enforce the shape, let it. The prompt still asks for
  // bare JSON so the models without this support behave exactly as before.
  if (supportsSchema(model)) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "prediction", strict: true, schema: PREDICTION_SCHEMA },
    };
  }

  const res = await fetch(CHAT_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string; metadata?: { limit_source?: string; headers?: Record<string, string> } } }
      | null;
    const meta = body?.error?.metadata;
    const daily =
      meta?.limit_source === "openrouter_free_tier_daily" ||
      /free-models-per-day/i.test(body?.error?.message ?? "");

    if (daily) {
      // Trust the reset header; fall back to an hour so a missing one still backs off.
      const reset = Number(meta?.headers?.["X-RateLimit-Reset"] ?? 0);
      throw new DailyQuotaError(reset > Date.now() ? reset : Date.now() + 3_600_000);
    }
    throw new Error("rate_limited");
  }
  if (!res.ok) throw new Error(`chat ${res.status}`);

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("empty completion");
  return content;
}

// One retry on the primary, then the fallback model, then a degraded result.
export async function predict(
  evidence: Evidence,
  apiKey: string,
  budgetMs = 45_000,
  /** Model to try first. A bot that names one should be read by that one. */
  preferred?: string | null,
): Promise<PredictionResult> {
  if (quotaBlockedFor() > 0) return { status: "unavailable", reason: describeBlock() };

  const deadline = Date.now() + budgetMs;
  // Never spend more than a third of the budget on one provider.
  const perCall = () => Math.max(4_000, Math.min(20_000, deadline - Date.now()));
  const prompt = buildPrompt(evidence);

  let models: string[];
  try {
    // Measured latency and reliability decide the order, not a static list.
    models = orderByPerformance(await freeModels()).slice(0, MAX_MODELS_PER_PREDICTION);
    // The operator's choice leads, and gets a second attempt at the back of the
    // queue. Providers answer "temporarily overloaded" often enough that one
    // refusal is not evidence the model is unavailable, and the alternative is
    // silently reading with a model the operator did not choose.
    if (preferred) models = [preferred, ...models.filter((m) => m !== preferred), preferred];
  } catch (err) {
    return { status: "unavailable", reason: (err as Error).message };
  }

  // Walk the top ranked models in order, not the whole catalog: the daily cap is
  // per account, so a fifth attempt after four failures costs a request that a
  // later card will need. A model that answers 429 is skipped immediately.
  let lastReason = "no free model returned valid JSON";
  const secondPass: string[] = [];

  for (const model of models) {
    if (Date.now() >= deadline) {
      lastReason = "ran out of time before a model answered";
      break;
    }
    if (!canCall()) return { status: "unavailable", reason: "outbound rate budget spent for this minute" };
    noteCall();
    const startedAt = Date.now();
    try {
      const raw = await callModel(model, prompt, apiKey, perCall());
      const parsed = normalize(extractJson(raw));
      if (isPrediction(parsed)) {
        recordSuccess(model, Date.now() - startedAt);
        return { status: "ok", prediction: parsed, model };
      }
      recordFailure(model, false);
      lastReason = `${model} returned unusable JSON`;
      secondPass.push(model);
    } catch (err) {
      // The account cap is not this model's fault. Latch it, skip the fallbacks
      // that would fail identically, and leave the model's record unpoisoned.
      if (err instanceof DailyQuotaError) {
        quotaResetAt = err.resetAt;
        saveBlockUntil(err.resetAt);
        return { status: "unavailable", reason: describeBlock() };
      }
      const message = (err as Error).message;
      recordFailure(model, message === "rate_limited");
      lastReason = `${model}: ${message}`;
      // Rate limits are transient, malformed output is not: retry the former.
      if (message === "rate_limited") secondPass.push(model);
    }
  }

  for (const model of secondPass.slice(0, 1)) {
    if (Date.now() >= deadline || !canCall()) break;
    noteCall();
    const startedAt = Date.now();
    try {
      const raw = await callModel(model, prompt, apiKey, perCall());
      const parsed = normalize(extractJson(raw));
      if (isPrediction(parsed)) {
        recordSuccess(model, Date.now() - startedAt);
        return { status: "ok", prediction: parsed, model };
      }
    } catch (err) {
      if (err instanceof DailyQuotaError) {
        quotaResetAt = err.resetAt;
        saveBlockUntil(err.resetAt);
        return { status: "unavailable", reason: describeBlock() };
      }
      // Already recorded in lastReason.
    }
  }

  return { status: "unavailable", reason: lastReason };
}
