import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_BODY_BYTES = 14 * 1024 * 1024;
const DEFAULT_MODEL = "gpt-5.5";

function isMissingSetting(value) {
  return (
    !value ||
    value === "undefined" ||
    value === "null" ||
    value === "sk-your-key-here"
  );
}

const receiptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "merchant",
    "date",
    "currency",
    "subtotal",
    "total",
    "items",
    "fees",
    "discounts",
    "raw_text",
  ],
  properties: {
    merchant: { type: "string" },
    date: { type: "string" },
    currency: { type: "string" },
    subtotal: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quantity", "unit_price", "total", "notes"],
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          unit_price: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
          notes: { type: "string" },
        },
      },
    },
    fees: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "amount", "rate_percent", "base_amount", "category", "notes"],
        properties: {
          label: { type: "string" },
          amount: { type: "number" },
          rate_percent: { type: ["number", "null"] },
          base_amount: { type: ["number", "null"] },
          category: {
            type: "string",
            enum: ["tax", "service", "fee", "rounding", "other"],
          },
          notes: { type: "string" },
        },
      },
    },
    discounts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "amount", "rate_percent", "base_amount", "notes"],
        properties: {
          label: { type: "string" },
          amount: { type: "number" },
          rate_percent: { type: ["number", "null"] },
          base_amount: { type: ["number", "null"] },
          notes: { type: "string" },
        },
      },
    },
    raw_text: { type: "string" },
  },
};

function loadDotEnv(cwd = process.cwd()) {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && isMissingSetting(process.env[key])) process.env[key] = value;
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Receipt image is too large. Try a smaller photo."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON request."));
      }
    });

    req.on("error", reject);
  });
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;

  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return "";
}

function normalizeOpenAIError(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed.error?.message || `OpenAI request failed (${status}).`;
  } catch {
    return `OpenAI request failed (${status}).`;
  }
}

export async function readReceiptWithOpenAI({ imageUrl, currency }) {
  loadDotEnv();

  const apiKey = process.env.OPENAI_API_KEY;
  if (isMissingSetting(apiKey)) {
    const error = new Error("Set OPENAI_API_KEY on the server to use AI receipt reading.");
    error.statusCode = 400;
    throw error;
  }

  if (!imageUrl || !String(imageUrl).startsWith("data:image/")) {
    const error = new Error("Attach a receipt image before using AI reading.");
    error.statusCode = 400;
    throw error;
  }

  const model = isMissingSetting(process.env.OPENAI_MODEL)
    ? DEFAULT_MODEL
    : process.env.OPENAI_MODEL;
  const prompt = [
    "Read this restaurant or shop receipt image.",
    "Extract the receipt name or merchant, purchasable items, quantities, unit prices, line totals, discounts, taxes, service charges, fees, subtotal, total, currency, merchant, date, and important receipt notes.",
    "For service charge, service tax, SST, VAT, GST, discounts, and fees, include the printed percentage rate in rate_percent when shown, the base amount in base_amount when shown, and the final amount charged in amount.",
    "Return date as YYYY-MM-DD when possible.",
    "Keep numbers as decimal amounts only.",
    `If currency is unclear, use ${currency || "RM"}.`,
    "Do not invent lines that are not on the receipt. Use null for unknown numeric totals.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "receipt_extract",
          strict: true,
          schema: receiptSchema,
        },
      },
      max_output_tokens: 2200,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(normalizeOpenAIError(response.status, bodyText));
    error.statusCode = response.status;
    throw error;
  }

  const result = JSON.parse(bodyText);
  const outputText = extractOutputText(result);
  if (!outputText) {
    const error = new Error("AI did not return receipt data.");
    error.statusCode = 502;
    throw error;
  }

  return {
    model,
    receipt: JSON.parse(outputText),
  };
}

export async function handleReceiptAiRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const result = await readReceiptWithOpenAI(body);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || "Could not read receipt with AI.",
    });
  }
}
