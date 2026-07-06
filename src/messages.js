import { formatMoney } from "./calculations.js";

export function buildReceiptMessage(group, receiptTitle, split, members, currency) {
  const lines = ["Receipt Split:", ""];

  for (const member of members) {
    const breakdown = split.byMember[member.id];
    if (!breakdown || breakdown.total <= 0) continue;

    lines.push(`${member.name}:`);
    for (const item of breakdown.items) {
      const qty = item.quantity ? ` x${item.quantity}` : "";
      lines.push(`* ${item.name}${qty}: ${formatMoney(item.amount, currency)}`);
    }
    if (Math.abs(breakdown.feeTotal) > 0) {
      lines.push(
        `* Share of tax/service: ${formatMoney(breakdown.feeTotal, currency)}`,
      );
    }
    lines.push(`Total: ${formatMoney(breakdown.total, currency)}`, "");
  }

  lines.push(`Grand Total: ${formatMoney(split.calculatedTotal, currency)}`);
  if (group?.name) lines.push(`Group: ${group.name}`);
  if (receiptTitle) lines.push(`Expense: ${receiptTitle}`);

  return lines.join("\n");
}

export function buildGroupMessage(group, tripSummary, currency) {
  const lines = [`${group.name} Summary:`, ""];
  lines.push(`Total spending: ${formatMoney(tripSummary.total, currency)}`, "");

  for (const entry of Object.values(tripSummary.byMember)) {
    lines.push(
      `${entry.member.name}: paid ${formatMoney(entry.paid, currency)}, share ${formatMoney(
        entry.share,
        currency,
      )}, balance ${formatMoney(entry.balance, currency)}`,
    );
  }

  lines.push("", "Settlement:");
  if (tripSummary.settlements.length) {
    for (const settlement of tripSummary.settlements) {
      lines.push(
        `${settlement.from.name} pays ${settlement.to.name} ${formatMoney(
          settlement.amount,
          currency,
        )}`,
      );
    }
  } else {
    lines.push("All settled.");
  }

  return lines.join("\n");
}
