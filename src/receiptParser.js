import { uid } from "./storage.js";

const MONEY_RE =
  /(?:RM|MYR|USD|SGD|EUR|GBP|AED|TRY|\$)?\s*(-?\d{1,3}(?:,\d{3})*(?:[.,]\d{2})|-?\d+(?:[.,]\d{2}))/gi;

function moneyToNumber(value) {
  const clean = String(value).trim();
  const hasCommaDecimal = clean.includes(",") && !clean.includes(".");
  const normalized = hasCommaDecimal
    ? clean.replace(",", ".")
    : clean.replace(/,/g, "");
  return Number.parseFloat(normalized);
}

function amountsIn(line) {
  return [...line.matchAll(MONEY_RE)]
    .map((match) => ({
      raw: match[0],
      value: moneyToNumber(match[1]),
      index: match.index ?? 0,
    }))
    .filter((entry) => Number.isFinite(entry.value));
}

function detectCurrency(text, fallback = "RM") {
  if (/\bRM\b|\bMYR\b/i.test(text)) return "RM";
  if (/\bSGD\b/i.test(text)) return "SGD";
  if (/\bUSD\b|\$/i.test(text)) return "USD";
  if (/\bEUR\b/i.test(text)) return "EUR";
  if (/\bGBP\b/i.test(text)) return "GBP";
  if (/\bTRY\b/i.test(text)) return "TRY";
  return fallback;
}

function cleanItemName(name) {
  return name
    .replace(/(?:RM|MYR|USD|SGD|EUR|GBP|\$)/gi, "")
    .replace(/\b(?:qty|quantity|pcs|pc)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[*#:\-\s]+|[*#:\-\s]+$/g, "")
    .trim();
}

function extractQuantity(name) {
  const trimmed = name.trim();
  const candidates = [
    {
      match: trimmed.match(/^(\d+(?:\.\d+)?)\s+(.{2,})$/),
      qtyIndex: 1,
      nameIndex: 2,
    },
    {
      match: trimmed.match(/(.{2,})\s+\b(?:x|qty)\s*(\d+(?:\.\d+)?)\b/i),
      qtyIndex: 2,
      nameIndex: 1,
    },
    {
      match: trimmed.match(/\b(\d+(?:\.\d+)?)\s*x\b\s*(.{2,})?/i),
      qtyIndex: 1,
      nameIndex: 2,
    },
    {
      match: trimmed.match(/(.{2,})\s+(\d+(?:\.\d+)?)$/),
      qtyIndex: 2,
      nameIndex: 1,
    },
  ];

  for (const candidate of candidates) {
    const match = candidate.match;
    if (!match) continue;
    const numeric = Number.parseFloat(match[candidate.qtyIndex]);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 99) continue;
    return {
      qty: numeric,
      name: cleanItemName(match[candidate.nameIndex] || trimmed) || "Receipt item",
    };
  }

  return { qty: 1, name: cleanItemName(trimmed) || "Receipt item" };
}

function isPaymentLine(lower) {
  return /(cash|change|visa|master|amex|card|paid|payment|tender|approval|auth|merchant|invoice|receipt no|table|server|cashier)/i.test(
    lower,
  );
}

function classifyLine(lower) {
  if (/(grand\s*)?total|amount due|balance due|net amount|payable/i.test(lower)) {
    if (!/subtotal|sub total/i.test(lower)) return "total";
  }
  if (/sub\s*total/i.test(lower)) return "subtotal";
  if (/sst|vat|gst|service tax|tax\b/i.test(lower)) return "tax";
  if (/service charge|svc|service fee/i.test(lower)) return "service";
  if (/discount|promo|voucher|rebate|less/i.test(lower)) return "discount";
  if (/rounding|delivery|packing|packaging|bag|fee|surcharge/i.test(lower)) return "fee";
  return "item";
}

export function parseReceiptText(rawText, fallbackCurrency = "RM") {
  const text = rawText.replace(/[|]/g, " ").replace(/\t/g, " ");
  const currency = detectCurrency(text, fallbackCurrency);
  const receipt = {
    items: [],
    fees: [],
    subtotal: 0,
    total: 0,
    currency,
    rawText,
  };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    const found = amountsIn(line);
    if (!found.length) continue;

    const amount = found[found.length - 1];
    const lower = line.toLowerCase();
    const kind = classifyLine(lower);

    if (kind === "total") {
      receipt.total = Math.max(receipt.total, amount.value);
      continue;
    }

    if (kind === "subtotal") {
      receipt.subtotal = amount.value;
      continue;
    }

    if (kind === "tax" || kind === "service" || kind === "discount" || kind === "fee") {
      const signedAmount =
        kind === "discount" ? -Math.abs(amount.value) : amount.value;
      receipt.fees.push({
        id: uid("fee"),
        label:
          kind === "tax"
            ? "Tax / SST / VAT"
            : kind === "service"
              ? "Service charge"
              : kind === "discount"
                ? "Discount"
                : cleanItemName(line.slice(0, amount.index)) || "Other fee",
        amount: signedAmount,
        splitMode: kind === "discount" ? "proportional" : "proportional",
        memberIds: [],
        shares: {},
      });
      continue;
    }

    if (isPaymentLine(lower)) continue;

    const namePart = line.slice(0, amount.index).trim();
    const quantity = extractQuantity(namePart);
    const lineTotal = Math.abs(amount.value);
    receipt.items.push({
      id: uid("item"),
      name: quantity.name,
      quantity: quantity.qty,
      unitPrice: Number((lineTotal / quantity.qty).toFixed(2)),
      splitMode: quantity.qty > 1 ? "quantity" : "equal",
      memberIds: [],
      shares: {},
    });
  }

  const detectedItemsTotal = receipt.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  const detectedFeesTotal = receipt.fees.reduce((sum, fee) => sum + fee.amount, 0);
  const detectedTotal = detectedItemsTotal + detectedFeesTotal;
  const variance = receipt.total ? receipt.total - detectedTotal : 0;

  if (receipt.total && Math.abs(variance) >= 0.01) {
    receipt.fees.push({
      id: uid("fee"),
      label: "Rounding / receipt adjustment",
      amount: Number(variance.toFixed(2)),
      splitMode: "proportional",
      memberIds: [],
      shares: {},
    });
  }

  return receipt;
}
