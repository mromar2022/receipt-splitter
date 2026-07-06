export function money(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value, currency = "RM") {
  return `${currency} ${money(value).toFixed(2)}`;
}

export function itemTotal(item) {
  return money(Number(item.quantity || 0) * Number(item.unitPrice || 0));
}

function distributeCustom(total, shares, selectedIds, mode) {
  const raw = selectedIds.map((id) => Number(shares?.[id] || 0));
  const rawSum = raw.reduce((sum, value) => sum + value, 0);

  if (mode === "amount") {
    if (rawSum <= 0) return distributeEqual(total, selectedIds);
    return Object.fromEntries(
      selectedIds.map((id, index) => [id, money((total * raw[index]) / rawSum)]),
    );
  }

  if (mode === "percent") {
    if (rawSum <= 0) return distributeEqual(total, selectedIds);
    return Object.fromEntries(
      selectedIds.map((id, index) => [id, money((total * raw[index]) / rawSum)]),
    );
  }

  return distributeEqual(total, selectedIds);
}

function distributeEqual(total, selectedIds) {
  if (!selectedIds.length) return {};
  const base = money(total / selectedIds.length);
  const result = Object.fromEntries(selectedIds.map((id) => [id, base]));
  const drift = money(total - selectedIds.reduce((sum) => sum + result[selectedIds[0]], 0));
  if (Math.abs(drift) >= 0.01) {
    result[selectedIds[0]] = money(result[selectedIds[0]] + drift);
  }
  return result;
}

function distributeQuantity(total, shares, selectedIds) {
  const raw = selectedIds.map((id) => Number(shares?.[id] || 0));
  const rawSum = raw.reduce((sum, value) => sum + value, 0);
  if (rawSum <= 0) return distributeEqual(total, selectedIds);
  return Object.fromEntries(
    selectedIds.map((id, index) => [id, money((total * raw[index]) / rawSum)]),
  );
}

export function computeReceiptSplit(receipt, members) {
  const memberIds = members.map((member) => member.id);
  const activeIds = receipt.participantIds?.length
    ? receipt.participantIds
    : memberIds;
  const byMember = Object.fromEntries(
    memberIds.map((id) => [
      id,
      { itemSubtotal: 0, feeTotal: 0, total: 0, items: [], fees: [] },
    ]),
  );
  let unassignedTotal = 0;

  for (const item of receipt.items) {
    const selectedIds = (item.memberIds?.length ? item.memberIds : []).filter(
      (id) => byMember[id],
    );
    const total = itemTotal(item);

    if (!selectedIds.length) {
      unassignedTotal += total;
      continue;
    }

    let distributed = {};
    if (item.splitMode === "quantity") {
      distributed = distributeQuantity(total, item.shares, selectedIds);
    } else if (item.splitMode === "amount") {
      distributed = distributeCustom(total, item.shares, selectedIds, "amount");
    } else if (item.splitMode === "percent") {
      distributed = distributeCustom(total, item.shares, selectedIds, "percent");
    } else {
      distributed = distributeEqual(total, selectedIds);
    }

    for (const memberId of selectedIds) {
      const amount = distributed[memberId] || 0;
      byMember[memberId].itemSubtotal = money(
        byMember[memberId].itemSubtotal + amount,
      );
      byMember[memberId].items.push({
        id: item.id,
        name: item.name,
        amount,
        quantity:
          item.splitMode === "quantity"
            ? Number(item.shares?.[memberId] || 0)
            : undefined,
      });
    }
  }

  for (const fee of receipt.fees) {
    const selectedIds = (fee.memberIds?.length ? fee.memberIds : activeIds).filter(
      (id) => byMember[id],
    );

    if (!selectedIds.length) {
      unassignedTotal += Number(fee.amount || 0);
      continue;
    }

    const amount = Number(fee.amount || 0);
    let distributed = {};

    if (fee.splitMode === "equal") {
      distributed = distributeEqual(amount, selectedIds);
    } else if (fee.splitMode === "manual") {
      distributed = distributeCustom(amount, fee.shares, selectedIds, "amount");
    } else {
      const subtotal = selectedIds.reduce(
        (sum, id) => sum + byMember[id].itemSubtotal,
        0,
      );
      if (subtotal <= 0) {
        distributed = distributeEqual(amount, selectedIds);
      } else {
        distributed = Object.fromEntries(
          selectedIds.map((id) => [
            id,
            money((amount * byMember[id].itemSubtotal) / subtotal),
          ]),
        );
      }
    }

    for (const memberId of selectedIds) {
      const share = distributed[memberId] || 0;
      byMember[memberId].feeTotal = money(byMember[memberId].feeTotal + share);
      byMember[memberId].fees.push({
        id: fee.id,
        label: fee.label,
        amount: share,
      });
    }
  }

  for (const memberId of memberIds) {
    byMember[memberId].total = money(
      byMember[memberId].itemSubtotal + byMember[memberId].feeTotal,
    );
  }

  const calculatedTotal = money(
    Object.values(byMember).reduce((sum, member) => sum + member.total, 0),
  );

  return {
    byMember,
    calculatedTotal,
    unassignedTotal: money(unassignedTotal),
    itemTotal: money(receipt.items.reduce((sum, item) => sum + itemTotal(item), 0)),
    feeTotal: money(receipt.fees.reduce((sum, fee) => sum + Number(fee.amount || 0), 0)),
  };
}

export function computeSimpleExpenseShares(expense) {
  const selectedIds = expense.participantIds || [];
  const total = Number(expense.amount || 0);
  if (!selectedIds.length) return {};

  if (expense.splitType === "customAmount") {
    return distributeCustom(total, expense.customShares, selectedIds, "amount");
  }

  if (expense.splitType === "customPercent") {
    return distributeCustom(total, expense.customShares, selectedIds, "percent");
  }

  return distributeEqual(total, selectedIds);
}

export function summarizeTrip(group) {
  const members = group.members || [];
  const summary = Object.fromEntries(
    members.map((member) => [
      member.id,
      { member, paid: 0, share: 0, balance: 0 },
    ]),
  );

  for (const expense of group.expenses || []) {
    if (summary[expense.paidBy]) {
      summary[expense.paidBy].paid = money(
        summary[expense.paidBy].paid + Number(expense.amount || 0),
      );
    }

    const shares =
      expense.shares ||
      (expense.receipt ? {} : computeSimpleExpenseShares(expense));
    for (const [memberId, amount] of Object.entries(shares)) {
      if (!summary[memberId]) continue;
      summary[memberId].share = money(summary[memberId].share + Number(amount || 0));
    }
  }

  for (const entry of Object.values(summary)) {
    entry.balance = money(entry.paid - entry.share);
  }

  const total = money(
    (group.expenses || []).reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
  );

  return { byMember: summary, total, settlements: simplifySettlements(summary) };
}

export function simplifySettlements(summary) {
  const creditors = Object.values(summary)
    .filter((entry) => entry.balance > 0.01)
    .map((entry) => ({ ...entry, remaining: entry.balance }))
    .sort((a, b) => b.remaining - a.remaining);
  const debtors = Object.values(summary)
    .filter((entry) => entry.balance < -0.01)
    .map((entry) => ({ ...entry, remaining: Math.abs(entry.balance) }))
    .sort((a, b) => b.remaining - a.remaining);
  const settlements = [];

  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtors[debtorIndex] && creditors[creditorIndex]) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = money(Math.min(debtor.remaining, creditor.remaining));
    if (amount > 0) {
      settlements.push({
        from: debtor.member,
        to: creditor.member,
        amount,
      });
    }
    debtor.remaining = money(debtor.remaining - amount);
    creditor.remaining = money(creditor.remaining - amount);
    if (debtor.remaining <= 0.01) debtorIndex += 1;
    if (creditor.remaining <= 0.01) creditorIndex += 1;
  }

  return settlements;
}
