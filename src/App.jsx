import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  Clipboard,
  FileImage,
  HelpCircle,
  Plus,
  ReceiptText,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import Tesseract from "tesseract.js";
import {
  computeReceiptSplit,
  computeSimpleExpenseShares,
  formatMoney,
  itemTotal,
  money,
  summarizeTrip,
} from "./calculations.js";
import { buildGroupMessage, buildReceiptMessage } from "./messages.js";
import { parseReceiptText } from "./receiptParser.js";
import { loadGroups, saveGroups, uid } from "./storage.js";
import {
  isSupabaseConfigured,
  loadRemoteGroups,
  saveRemoteGroups,
  supabase,
} from "./supabaseClient.js";

const SAMPLE_MEMBERS = ["Omar", "Muhammad", "Zak", "Umar", "Abdullah"];
const TODAY = new Date().toISOString().slice(0, 10);

function makeDefaultGroup() {
  return {
    id: uid("group"),
    name: "New Trip",
    currency: "RM",
    members: [],
    expenses: [],
    createdAt: new Date().toISOString(),
  };
}

function hasOnlyOldSampleData(groups) {
  if (!Array.isArray(groups) || groups.length !== 1) return false;
  const [group] = groups;
  const names = (group.members || []).map((member) => member.name);
  return (
    group.name === "KL Dinner" &&
    (group.expenses || []).length === 0 &&
    names.length === SAMPLE_MEMBERS.length &&
    SAMPLE_MEMBERS.every((name, index) => names[index] === name)
  );
}

function emptyReceipt(group) {
  return {
    items: [],
    fees: [],
    total: 0,
    subtotal: 0,
    currency: group.currency || "RM",
    rawText: "",
    participantIds: group.members.map((member) => member.id),
  };
}

function selectedMembers(group, ids) {
  const active = new Set(ids?.length ? ids : group.members.map((member) => member.id));
  return group.members.filter((member) => active.has(member.id));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeAiReceipt(aiReceipt, group, currentReceipt) {
  const currency = aiReceipt.currency || currentReceipt.currency || group.currency || "RM";
  const items = (aiReceipt.items || []).map((item) => {
    const quantity = Math.max(numberOrZero(item.quantity) || 1, 0.01);
    const lineTotal = numberOrZero(item.total);
    const unitPrice = item.unit_price == null
      ? money(lineTotal / quantity)
      : numberOrZero(item.unit_price);

    return {
      id: uid("item"),
      name: item.name || "Receipt item",
      quantity,
      unitPrice,
      splitMode: quantity > 1 ? "quantity" : "equal",
      memberIds: [],
      shares: {},
    };
  });

  const fees = (aiReceipt.fees || []).map((fee) => ({
    id: uid("fee"),
    label: fee.label || "Receipt fee",
    amount: numberOrZero(fee.amount),
    splitMode:
      fee.category === "tax" || fee.category === "service"
        ? "proportional"
        : "equal",
    memberIds: currentReceipt.participantIds,
    shares: {},
  }));

  const discounts = (aiReceipt.discounts || []).map((discount) => ({
    id: uid("fee"),
    label: discount.label || "Discount",
    amount: -Math.abs(numberOrZero(discount.amount)),
    splitMode: "proportional",
    memberIds: currentReceipt.participantIds,
    shares: {},
  }));

  return {
    ...currentReceipt,
    items,
    fees: [...fees, ...discounts],
    subtotal: numberOrZero(aiReceipt.subtotal),
    total: numberOrZero(aiReceipt.total),
    currency,
    rawText: aiReceipt.raw_text || "",
  };
}

async function copyText(text, onCopied) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
  onCopied?.();
}

function App() {
  const initialGroups = useMemo(() => {
    const savedGroups = loadGroups();
    if (!savedGroups || hasOnlyOldSampleData(savedGroups)) return [makeDefaultGroup()];
    return savedGroups;
  }, []);
  const [groups, setGroups] = useState(initialGroups);
  const [activeGroupId, setActiveGroupId] = useState(initialGroups[0]?.id);
  const [newGroupName, setNewGroupName] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [tab, setTab] = useState("receipt");
  const [showGuide, setShowGuide] = useState(false);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured);
  const [authUser, setAuthUser] = useState(null);
  const [authMessage, setAuthMessage] = useState("");
  const [remoteLoaded, setRemoteLoaded] = useState(!isSupabaseConfigured);
  const [syncStatus, setSyncStatus] = useState(
    isSupabaseConfigured ? "Checking account" : "Local only",
  );
  const [toast, setToast] = useState("");
  const groupsRef = useRef(initialGroups);

  const group = groups.find((entry) => entry.id === activeGroupId) || groups[0];
  const summary = useMemo(() => summarizeTrip(group), [group]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const user = data.session?.user || null;
      setAuthUser(user);
      setAuthReady(true);
      setRemoteLoaded(!user);
      setSyncStatus(user ? "Loading account" : "Local only");
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const user = session?.user || null;
      setAuthUser(user);
      setRemoteLoaded(!user);
      setSyncStatus(user ? "Loading account" : "Local only");
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !authReady || !authUser) return undefined;

    let cancelled = false;
    setRemoteLoaded(false);
    setSyncStatus("Loading account");

    loadRemoteGroups(authUser.id)
      .then(async (remoteGroups) => {
        if (cancelled) return;

        if (remoteGroups?.length) {
          const nextGroups = hasOnlyOldSampleData(remoteGroups)
            ? [makeDefaultGroup()]
            : remoteGroups;
          setGroups(nextGroups);
          setActiveGroupId(nextGroups[0]?.id);
          saveGroups(nextGroups);
        } else {
          await saveRemoteGroups(authUser.id, groupsRef.current);
        }

        if (!cancelled) {
          setRemoteLoaded(true);
          setSyncStatus("Saved");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRemoteLoaded(true);
          setSyncStatus("Sync error");
          setAuthMessage(error.message || "Could not load account data.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authReady, authUser?.id]);

  useEffect(() => {
    saveGroups(groups);
  }, [groups]);

  useEffect(() => {
    if (!isSupabaseConfigured || !authUser || !remoteLoaded) return undefined;

    setSyncStatus("Saving");
    const timeout = window.setTimeout(() => {
      saveRemoteGroups(authUser.id, groups)
        .then(() => setSyncStatus("Saved"))
        .catch((error) => {
          setSyncStatus("Sync error");
          setAuthMessage(error.message || "Could not save account data.");
        });
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [groups, authUser?.id, remoteLoaded]);

  async function signIn(email, password) {
    if (!supabase) return;
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthMessage(error ? error.message : "Logged in.");
  }

  async function signUp(email, password) {
    if (!supabase) return;
    setAuthMessage("");
    const { error } = await supabase.auth.signUp({ email, password });
    setAuthMessage(error ? error.message : "Account created. Check email if needed.");
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setAuthUser(null);
    setRemoteLoaded(true);
    setSyncStatus("Local only");
    setAuthMessage("");
  }

  function updateActiveGroup(updater) {
    setGroups((current) =>
      current.map((entry) =>
        entry.id === group.id ? updater(entry) : entry,
      ),
    );
  }

  function addGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const next = {
      id: uid("group"),
      name,
      currency: "RM",
      members: [],
      expenses: [],
      createdAt: new Date().toISOString(),
    };
    setGroups((current) => [...current, next]);
    setActiveGroupId(next.id);
    setNewGroupName("");
  }

  function addMember() {
    const name = newMemberName.trim();
    if (!name) return;
    updateActiveGroup((entry) => ({
      ...entry,
      members: [...entry.members, { id: uid("member"), name }],
    }));
    setNewMemberName("");
  }

  function updateCurrency(currency) {
    updateActiveGroup((entry) => ({ ...entry, currency }));
  }

  function saveExpense(expense) {
    updateActiveGroup((entry) => ({
      ...entry,
      expenses: [{ ...expense, id: uid("expense"), createdAt: new Date().toISOString() }, ...entry.expenses],
    }));
    setToast("Saved to trip balance");
    window.setTimeout(() => setToast(""), 1800);
  }

  function deleteExpense(expenseId) {
    updateActiveGroup((entry) => ({
      ...entry,
      expenses: entry.expenses.filter((expense) => expense.id !== expenseId),
    }));
  }

  if (!group) return null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Trip group receipt tool</p>
          <h1>Receipt Splitter</h1>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button" onClick={() => setShowGuide(true)}>
            <HelpCircle size={16} />
            How to use
          </button>
          <select
            value={group.currency}
            onChange={(event) => updateCurrency(event.target.value)}
            aria-label="Currency"
          >
            <option value="RM">RM</option>
            <option value="SGD">SGD</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="TRY">TRY</option>
          </select>
          {toast && <span className="toast"><Check size={16} />{toast}</span>}
        </div>
      </header>

      <AuthPanel
        authMessage={authMessage}
        authReady={authReady}
        isConfigured={isSupabaseConfigured}
        onSignIn={signIn}
        onSignOut={signOut}
        onSignUp={signUp}
        syncStatus={syncStatus}
        user={authUser}
      />

      {showGuide && <GuideOverlay onClose={() => setShowGuide(false)} />}

      <section className="layout">
        <aside className="side-panel">
          <div className="panel-heading">
            <h2>Trip Groups</h2>
          </div>
          <div className="group-list">
            {groups.map((entry) => (
              <button
                className={`group-button ${entry.id === group.id ? "active" : ""}`}
                key={entry.id}
                onClick={() => setActiveGroupId(entry.id)}
              >
                <span>{entry.name}</span>
                <small>{entry.members.length} members</small>
              </button>
            ))}
          </div>
          <div className="inline-form">
            <input
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              placeholder="Trip name"
            />
            <button className="icon-button" onClick={addGroup} aria-label="Add trip group">
              <Plus size={18} />
            </button>
          </div>

          <div className="panel-heading members-heading">
            <h2>People</h2>
          </div>
          <div className="member-list">
            {group.members.length ? (
              group.members.map((member) => (
                <span className="member-pill" key={member.id}>
                  {member.name}
                </span>
              ))
            ) : (
              <div className="empty-state compact-empty">No people added yet.</div>
            )}
          </div>
          <div className="inline-form">
            <input
              value={newMemberName}
              onChange={(event) => setNewMemberName(event.target.value)}
              placeholder="Add name"
              onKeyDown={(event) => {
                if (event.key === "Enter") addMember();
              }}
            />
            <button className="primary-icon-button" onClick={addMember}>
              <Plus size={16} />
              Add Person
            </button>
          </div>
        </aside>

        <section className="main-panel">
          <TripDashboard
            group={group}
            summary={summary}
            onCopy={() =>
              copyText(
                buildGroupMessage(group, summary, group.currency),
                () => setToast("Group summary copied"),
              )
            }
          />

          <nav className="tabs" aria-label="Workspace">
            <button className={tab === "receipt" ? "active" : ""} onClick={() => setTab("receipt")}>
              <ReceiptText size={16} />
              Receipt
            </button>
            <button className={tab === "manual" ? "active" : ""} onClick={() => setTab("manual")}>
              <Plus size={16} />
              Expense
            </button>
            <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
              <Clipboard size={16} />
              Trip Ledger
            </button>
          </nav>

          {tab === "receipt" && (
            <ReceiptWorkspace
              group={group}
              onSaveExpense={saveExpense}
              onToast={setToast}
            />
          )}
          {tab === "manual" && (
            <ManualExpenseForm
              group={group}
              onSaveExpense={saveExpense}
            />
          )}
          {tab === "history" && (
            <ExpenseLedger
              group={group}
              onDeleteExpense={deleteExpense}
            />
          )}
        </section>
      </section>
    </main>
  );
}

function AuthPanel({
  authMessage,
  authReady,
  isConfigured,
  onSignIn,
  onSignOut,
  onSignUp,
  syncStatus,
  user,
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(action) {
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) return;
    setBusy(true);
    try {
      await action(cleanEmail, password);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  if (!isConfigured) {
    return (
      <section className="auth-strip">
        <div>
          <strong>Local only</strong>
          <span>Database is not connected.</span>
        </div>
      </section>
    );
  }

  if (!authReady) {
    return (
      <section className="auth-strip">
        <div>
          <strong>Account</strong>
          <span>Checking account</span>
        </div>
      </section>
    );
  }

  if (user) {
    return (
      <section className="auth-strip">
        <div>
          <strong>{user.email}</strong>
          <span>{syncStatus}</span>
          {authMessage && <span>{authMessage}</span>}
        </div>
        <button className="secondary-button" onClick={onSignOut}>
          Log out
        </button>
      </section>
    );
  }

  return (
    <section className="auth-strip auth-form">
      <div>
        <strong>Account</strong>
        <span>{authMessage || syncStatus}</span>
      </div>
      <input
        autoComplete="email"
        inputMode="email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
        type="email"
        value={email}
      />
      <input
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        type="password"
        value={password}
      />
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => submit(onSignIn)}
      >
        Log in
      </button>
      <button
        className="primary-button"
        disabled={busy}
        onClick={() => submit(onSignUp)}
      >
        Sign up
      </button>
    </section>
  );
}

function GuideOverlay({ onClose }) {
  return (
    <div className="guide-backdrop" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <section className="guide-panel">
        <div className="guide-header">
          <div>
            <p className="eyebrow">Quick start</p>
            <h2 id="guide-title">How to use Receipt Splitter</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close guide">
            <X size={18} />
          </button>
        </div>

        <div className="guide-grid">
          <article className="guide-card">
            <div className="guide-visual people-visual">
              <span />
              <span />
              <span />
            </div>
            <strong>1. Add people</strong>
            <p>Create a trip group and add the friends who will share expenses.</p>
          </article>

          <article className="guide-card">
            <div className="guide-visual upload-visual">
              <FileImage size={34} />
              <span />
            </div>
            <strong>2. Upload a receipt</strong>
            <p>Choose a photo, take a picture, drag it in, or paste a screenshot.</p>
          </article>

          <article className="guide-card">
            <div className="guide-visual scan-visual">
              <Sparkles size={28} />
              <div>
                <span />
                <span />
                <span />
              </div>
            </div>
            <strong>3. Read with AI</strong>
            <p>Use AI Read Receipt, then edit any item, quantity, tax, or fee.</p>
          </article>

          <article className="guide-card">
            <div className="guide-visual split-visual">
              <span className="mini-item" />
              <span className="mini-person" />
              <span className="mini-person" />
            </div>
            <strong>4. Split items</strong>
            <p>Tap names or drag items to people. Shared items split equally or custom.</p>
          </article>

          <article className="guide-card">
            <div className="guide-visual summary-visual">
              <span />
              <span />
              <span />
            </div>
            <strong>5. Copy summary</strong>
            <p>Save the receipt to the trip and copy the WhatsApp message.</p>
          </article>
        </div>

        <div className="guide-footer">
          <button className="primary-button" onClick={onClose}>
            <Check size={16} />
            Start splitting
          </button>
        </div>
      </section>
    </div>
  );
}

function TripDashboard({ group, summary, onCopy }) {
  return (
    <section className="dashboard">
      <div className="dashboard-title">
        <div>
          <p className="eyebrow">Active trip</p>
          <h2>{group.name}</h2>
        </div>
        <button className="secondary-button" onClick={onCopy}>
          <Clipboard size={16} />
          Copy Group Summary
        </button>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <span>Total trip spending</span>
          <strong>{formatMoney(summary.total, group.currency)}</strong>
        </div>
        <div className="stat-card">
          <span>Receipts and expenses</span>
          <strong>{group.expenses.length}</strong>
        </div>
        <div className="stat-card">
          <span>Members</span>
          <strong>{group.members.length}</strong>
        </div>
      </div>

      <div className="balance-grid">
        {Object.values(summary.byMember).map((entry) => (
          <article className="person-card compact" key={entry.member.id}>
            <div className="person-card-header">
              <strong>{entry.member.name}</strong>
              <span className={entry.balance >= 0 ? "positive" : "negative"}>
                {formatMoney(entry.balance, group.currency)}
              </span>
            </div>
            <dl>
              <div>
                <dt>Paid</dt>
                <dd>{formatMoney(entry.paid, group.currency)}</dd>
              </div>
              <div>
                <dt>Share</dt>
                <dd>{formatMoney(entry.share, group.currency)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <div className="settlement-strip">
        <strong>Settlement</strong>
        <div>
          {summary.settlements.length ? (
            summary.settlements.map((settlement) => (
              <span key={`${settlement.from.id}-${settlement.to.id}-${settlement.amount}`}>
                {settlement.from.name} pays {settlement.to.name}{" "}
                {formatMoney(settlement.amount, group.currency)}
              </span>
            ))
          ) : (
            <span>All settled</span>
          )}
        </div>
      </div>
    </section>
  );
}

function ReceiptWorkspace({ group, onSaveExpense, onToast }) {
  const [receipt, setReceipt] = useState(() => emptyReceipt(group));
  const [title, setTitle] = useState("Receipt");
  const [date, setDate] = useState(TODAY);
  const [paidBy, setPaidBy] = useState(group.members[0]?.id || "");
  const [imageUrl, setImageUrl] = useState("");
  const [attachmentName, setAttachmentName] = useState("");
  const [ocrStatus, setOcrStatus] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isAiReading, setIsAiReading] = useState(false);
  const [draggedItemId, setDraggedItemId] = useState("");
  const uploadRef = useRef(null);
  const cameraRef = useRef(null);

  useEffect(() => {
    setReceipt(emptyReceipt(group));
    setPaidBy(group.members[0]?.id || "");
  }, [group.id]);

  const membersForReceipt = useMemo(
    () => selectedMembers(group, receipt.participantIds),
    [group, receipt.participantIds],
  );
  const split = useMemo(
    () => computeReceiptSplit(receipt, group.members),
    [receipt, group.members],
  );

  function updateReceipt(patch) {
    setReceipt((current) => ({ ...current, ...patch }));
  }

  function updateItem(itemId, updater) {
    setReceipt((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === itemId ? updater(item) : item,
      ),
    }));
  }

  function updateFee(feeId, updater) {
    setReceipt((current) => ({
      ...current,
      fees: current.fees.map((fee) => (fee.id === feeId ? updater(fee) : fee)),
    }));
  }

  async function readFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setOcrStatus("Please attach an image file.");
      return;
    }

    const dataUrl = await fileToDataUrl(file);

    setImageUrl(dataUrl);
    setAttachmentName(file.name || "Receipt image");
    setIsScanning(true);
    setOcrStatus("Starting OCR");

    try {
      const result = await Tesseract.recognize(dataUrl, "eng", {
        logger: (message) => {
          if (message.status) {
            const progress = message.progress
              ? ` ${Math.round(message.progress * 100)}%`
              : "";
            setOcrStatus(`${message.status}${progress}`);
          }
        },
      });
      const parsed = parseReceiptText(result.data.text, group.currency);
      setReceipt({
        ...parsed,
        participantIds: receipt.participantIds?.length
          ? receipt.participantIds
          : group.members.map((member) => member.id),
      });
      setOcrStatus(`Detected ${parsed.items.length} items and ${parsed.fees.length} fees`);
    } catch (error) {
      setOcrStatus("OCR failed. You can still add items manually.");
      console.error(error);
    } finally {
      setIsScanning(false);
    }
  }

  function readImageFromEvent(event) {
    const files = event.dataTransfer?.files || event.clipboardData?.files;
    const image = [...(files || [])].find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    readFile(image);
  }

  async function readWithAi() {
    if (!imageUrl) {
      onToast("Attach a receipt image first");
      return;
    }

    setIsAiReading(true);
    setOcrStatus("AI reading receipt");

    try {
      const response = await fetch("/api/read-receipt-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl,
          currency: receipt.currency || group.currency,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "AI receipt reading failed.");

      setReceipt((current) => normalizeAiReceipt(payload.receipt, group, current));
      if (payload.receipt.merchant) setTitle(payload.receipt.merchant);
      setOcrStatus(
        `AI detected ${(payload.receipt.items || []).length} items and ${[
          ...(payload.receipt.fees || []),
          ...(payload.receipt.discounts || []),
        ].length} fees`,
      );
    } catch (error) {
      setOcrStatus(error.message || "AI receipt reading failed.");
    } finally {
      setIsAiReading(false);
    }
  }

  function addItem() {
    setReceipt((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          id: uid("item"),
          name: "New item",
          quantity: 1,
          unitPrice: 0,
          splitMode: "equal",
          memberIds: [],
          shares: {},
        },
      ],
    }));
  }

  function addFee() {
    setReceipt((current) => ({
      ...current,
      fees: [
        ...current.fees,
        {
          id: uid("fee"),
          label: "Service charge",
          amount: 0,
          splitMode: "proportional",
          memberIds: current.participantIds,
          shares: {},
        },
      ],
    }));
  }

  function toggleReceiptParticipant(memberId) {
    setReceipt((current) => {
      const active = new Set(current.participantIds);
      if (active.has(memberId)) active.delete(memberId);
      else active.add(memberId);
      const participantIds = [...active];
      return {
        ...current,
        participantIds,
        items: current.items.map((item) => ({
          ...item,
          memberIds: item.memberIds.filter((id) => participantIds.includes(id)),
        })),
      };
    });
  }

  function toggleItemMember(itemId, memberId) {
    updateItem(itemId, (item) => {
      const selected = new Set(item.memberIds || []);
      const shares = { ...(item.shares || {}) };
      if (selected.has(memberId)) {
        selected.delete(memberId);
        delete shares[memberId];
      } else {
        selected.add(memberId);
        shares[memberId] =
          item.splitMode === "percent"
            ? money(100 / selected.size)
            : item.splitMode === "quantity"
              ? 1
              : item.splitMode === "amount"
                ? money(itemTotal(item) / selected.size)
                : "";
      }
      return { ...item, memberIds: [...selected], shares };
    });
  }

  function assignItemToMember(itemId, memberId) {
    updateItem(itemId, (item) => {
      if (item.memberIds?.includes(memberId)) return item;
      return {
        ...item,
        memberIds: [...(item.memberIds || []), memberId],
        shares: {
          ...(item.shares || {}),
          [memberId]: item.splitMode === "quantity" ? 1 : "",
        },
      };
    });
  }

  function shareItemWithAll(itemId) {
    updateItem(itemId, (item) => ({
      ...item,
      splitMode: "equal",
      memberIds: receipt.participantIds,
      shares: {},
    }));
  }

  function saveReceiptExpense() {
    if (!paidBy) {
      onToast("Choose who paid first");
      return;
    }

    const shares = Object.fromEntries(
      Object.entries(split.byMember).map(([memberId, entry]) => [
        memberId,
        entry.total,
      ]),
    );

    onSaveExpense({
      title,
      amount: split.calculatedTotal,
      currency: receipt.currency || group.currency,
      paidBy,
      participantIds: receipt.participantIds,
      splitType: "byItem",
      date,
      notes: "",
      shares,
      attachment: imageUrl
        ? { name: attachmentName || "Receipt image", dataUrl: imageUrl }
        : null,
      receipt: {
        ...receipt,
        attachmentName,
        imageUrl,
      },
    });
  }

  const receiptMessage = buildReceiptMessage(
    group,
    title,
    split,
    membersForReceipt,
    receipt.currency || group.currency,
  );

  return (
    <section className="workspace-grid">
      <div className="editor-stack">
        <section
          className="tool-panel upload-panel"
          onDrop={readImageFromEvent}
          onDragOver={(event) => event.preventDefault()}
          onPaste={readImageFromEvent}
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Receipt upload</p>
              <h2>Scan</h2>
            </div>
            <div className="button-row">
              <input
                ref={uploadRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  readFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(event) => {
                  readFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <button className="primary-button" onClick={() => uploadRef.current?.click()}>
                <Upload size={16} />
                Upload Receipt
              </button>
              <button className="secondary-button" onClick={() => cameraRef.current?.click()}>
                <Camera size={16} />
                Take Photo
              </button>
              <button
                className="secondary-button"
                onClick={readWithAi}
                disabled={!imageUrl || isAiReading}
              >
                <Sparkles size={16} />
                AI Read Receipt
              </button>
            </div>
          </div>

          <label className="attachment-drop">
            <FileImage size={22} />
            <span>{attachmentName || "Receipt image"}</span>
            <input
              className="file-control"
              type="file"
              accept="image/*"
              onChange={(event) => {
                readFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>

          <div className="receipt-meta-grid">
            <label>
              Expense title
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              Date
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              Who paid
              <select value={paidBy} onChange={(event) => setPaidBy(event.target.value)}>
                <option value="">Select payer</option>
                {group.members.map((member) => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
            </label>
            <label>
              Total amount
              <input
                type="number"
                step="0.01"
                value={receipt.total || ""}
                onChange={(event) => updateReceipt({ total: Number(event.target.value || 0) })}
              />
            </label>
          </div>

          <div className="participant-row">
            <span><Users size={16} /> Split with</span>
            {group.members.map((member) => (
              <button
                key={member.id}
                className={receipt.participantIds.includes(member.id) ? "chip selected" : "chip"}
                onClick={() => toggleReceiptParticipant(member.id)}
              >
                {member.name}
              </button>
            ))}
          </div>

          {(imageUrl || ocrStatus) && (
            <div className="scan-result">
              {imageUrl ? (
                <img className="receipt-preview" src={imageUrl} alt="Uploaded receipt preview" />
              ) : (
                <div className="empty-preview"><FileImage size={28} /></div>
              )}
              <div>
                <strong>{isAiReading ? "AI reading receipt" : isScanning ? "Scanning receipt" : "Receipt status"}</strong>
                <p>{ocrStatus}</p>
              </div>
            </div>
          )}
        </section>

        <section className="tool-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Detected lines</p>
              <h2>Items</h2>
            </div>
            <button className="secondary-button" onClick={addItem}>
              <Plus size={16} />
              Split Item
            </button>
          </div>
          <div className="item-list">
            {receipt.items.length ? (
              receipt.items.map((item) => (
                <ReceiptItemEditor
                  key={item.id}
                  item={item}
                  members={membersForReceipt}
                  currency={receipt.currency || group.currency}
                  onUpdate={(updater) => updateItem(item.id, updater)}
                  onDelete={() =>
                    setReceipt((current) => ({
                      ...current,
                      items: current.items.filter((entry) => entry.id !== item.id),
                    }))
                  }
                  onToggleMember={(memberId) => toggleItemMember(item.id, memberId)}
                  onShareAll={() => shareItemWithAll(item.id)}
                  onDragStart={() => setDraggedItemId(item.id)}
                />
              ))
            ) : (
              <div className="empty-state">No receipt items yet.</div>
            )}
          </div>
        </section>

        <section className="tool-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Tax, service, discounts</p>
              <h2>Fees</h2>
            </div>
            <button className="secondary-button" onClick={addFee}>
              <Plus size={16} />
              Add Fee
            </button>
          </div>
          <div className="fee-list">
            {receipt.fees.map((fee) => (
              <FeeEditor
                key={fee.id}
                fee={fee}
                members={membersForReceipt}
                currency={receipt.currency || group.currency}
                onUpdate={(updater) => updateFee(fee.id, updater)}
                onDelete={() =>
                  setReceipt((current) => ({
                    ...current,
                    fees: current.fees.filter((entry) => entry.id !== fee.id),
                  }))
                }
              />
            ))}
            {!receipt.fees.length && <div className="empty-state">No tax or service lines yet.</div>}
          </div>
        </section>
      </div>

      <aside className="summary-stack">
        <section className="tool-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Assign items</p>
              <h2>People Cards</h2>
            </div>
            <button className="primary-button" onClick={() => onToast("Calculated")}>
              <Check size={16} />
              Calculate
            </button>
          </div>
          <div className="people-drop-grid">
            {membersForReceipt.map((member) => {
              const breakdown = split.byMember[member.id];
              return (
                <article
                  key={member.id}
                  className="person-card drop-card"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => draggedItemId && assignItemToMember(draggedItemId, member.id)}
                >
                  <div className="person-card-header">
                    <strong>{member.name}</strong>
                    <span>{formatMoney(breakdown.total, receipt.currency || group.currency)}</span>
                  </div>
                  <ul className="assigned-list">
                    {breakdown.items.map((item) => (
                      <li key={`${item.id}-${member.id}`}>
                        <span>{item.name}</span>
                        <b>{formatMoney(item.amount, receipt.currency || group.currency)}</b>
                      </li>
                    ))}
                    {!breakdown.items.length && <li className="muted-line">Drop or tap items</li>}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>

        <section className="tool-panel final-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Final summary</p>
              <h2>Breakdown</h2>
            </div>
          </div>
          <div className="summary-list">
            {membersForReceipt.map((member) => {
              const breakdown = split.byMember[member.id];
              return (
                <div className="summary-row" key={member.id}>
                  <strong>{member.name}</strong>
                  <span>Subtotal {formatMoney(breakdown.itemSubtotal, receipt.currency || group.currency)}</span>
                  <span>Tax/service {formatMoney(breakdown.feeTotal, receipt.currency || group.currency)}</span>
                  <b>{formatMoney(breakdown.total, receipt.currency || group.currency)}</b>
                </div>
              );
            })}
          </div>
          {Math.abs(split.unassignedTotal) > 0.01 && (
            <div className="warning-line">
              Unassigned: {formatMoney(split.unassignedTotal, receipt.currency || group.currency)}
            </div>
          )}
          <div className="total-row">
            <span>Grand Total</span>
            <strong>{formatMoney(split.calculatedTotal, receipt.currency || group.currency)}</strong>
          </div>
          <div className="button-row stretch">
            <button
              className="secondary-button"
              onClick={() =>
                copyText(receiptMessage, () => onToast("Receipt message copied"))
              }
            >
              <Clipboard size={16} />
              Copy WhatsApp Message
            </button>
            <button className="primary-button" onClick={saveReceiptExpense}>
              <Check size={16} />
              Save to Trip
            </button>
          </div>
        </section>
      </aside>
    </section>
  );
}

function ReceiptItemEditor({
  item,
  members,
  currency,
  onUpdate,
  onDelete,
  onToggleMember,
  onShareAll,
  onDragStart,
}) {
  const selected = new Set(item.memberIds || []);
  const needsShares = ["quantity", "amount", "percent"].includes(item.splitMode);

  function updateField(field, value) {
    onUpdate((current) => ({ ...current, [field]: value }));
  }

  return (
    <article className="item-card" draggable onDragStart={onDragStart}>
      <div className="item-main-grid">
        <label className="wide-input">
          Item name
          <input value={item.name} onChange={(event) => updateField("name", event.target.value)} />
        </label>
        <label>
          Qty
          <input
            type="number"
            min="0"
            step="0.25"
            value={item.quantity}
            onChange={(event) => updateField("quantity", Number(event.target.value || 0))}
          />
        </label>
        <label>
          Unit price
          <input
            type="number"
            min="0"
            step="0.01"
            value={item.unitPrice}
            onChange={(event) => updateField("unitPrice", Number(event.target.value || 0))}
          />
        </label>
        <label>
          Split
          <select value={item.splitMode} onChange={(event) => updateField("splitMode", event.target.value)}>
            <option value="equal">Equal</option>
            <option value="quantity">Quantity</option>
            <option value="amount">Custom amount</option>
            <option value="percent">Custom percent</option>
          </select>
        </label>
      </div>

      <div className="item-actions">
        <span>{formatMoney(itemTotal(item), currency)}</span>
        <button className="tiny-button" onClick={onShareAll}>Share Item</button>
        <button className="icon-button danger" onClick={onDelete} aria-label="Delete item">
          <Trash2 size={16} />
        </button>
      </div>

      <div className="chip-row">
        {members.map((member) => (
          <button
            key={member.id}
            className={selected.has(member.id) ? "chip selected" : "chip"}
            onClick={() => onToggleMember(member.id)}
          >
            {member.name}
          </button>
        ))}
      </div>

      {needsShares && selected.size > 0 && (
        <div className="share-grid">
          {members
            .filter((member) => selected.has(member.id))
            .map((member) => (
              <label key={member.id}>
                {member.name}
                <input
                  type="number"
                  step={item.splitMode === "percent" ? "1" : "0.01"}
                  value={item.shares?.[member.id] || ""}
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      shares: {
                        ...(current.shares || {}),
                        [member.id]: Number(event.target.value || 0),
                      },
                    }))
                  }
                />
              </label>
            ))}
        </div>
      )}
    </article>
  );
}

function FeeEditor({ fee, members, currency, onUpdate, onDelete }) {
  const selected = new Set(fee.memberIds?.length ? fee.memberIds : members.map((member) => member.id));

  function toggleMember(memberId) {
    onUpdate((current) => {
      const next = new Set(current.memberIds?.length ? current.memberIds : members.map((member) => member.id));
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return { ...current, memberIds: [...next] };
    });
  }

  return (
    <article className="fee-card">
      <div className="item-main-grid fee-grid">
        <label className="wide-input">
          Fee label
          <input
            value={fee.label}
            onChange={(event) =>
              onUpdate((current) => ({ ...current, label: event.target.value }))
            }
          />
        </label>
        <label>
          Amount
          <input
            type="number"
            step="0.01"
            value={fee.amount}
            onChange={(event) =>
              onUpdate((current) => ({ ...current, amount: Number(event.target.value || 0) }))
            }
          />
        </label>
        <label>
          Split type
          <select
            value={fee.splitMode}
            onChange={(event) =>
              onUpdate((current) => ({ ...current, splitMode: event.target.value }))
            }
          >
            <option value="equal">Equal</option>
            <option value="proportional">By subtotal</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <button className="icon-button danger align-end" onClick={onDelete} aria-label="Delete fee">
          <Trash2 size={16} />
        </button>
      </div>
      <div className="chip-row">
        {members.map((member) => (
          <button
            key={member.id}
            className={selected.has(member.id) ? "chip selected" : "chip"}
            onClick={() => toggleMember(member.id)}
          >
            {member.name}
          </button>
        ))}
      </div>
      {fee.splitMode === "manual" && (
        <div className="share-grid">
          {members
            .filter((member) => selected.has(member.id))
            .map((member) => (
              <label key={member.id}>
                {member.name}
                <input
                  type="number"
                  step="0.01"
                  value={fee.shares?.[member.id] || ""}
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      shares: {
                        ...(current.shares || {}),
                        [member.id]: Number(event.target.value || 0),
                      },
                    }))
                  }
                />
              </label>
            ))}
        </div>
      )}
      <span className="fee-total">{formatMoney(fee.amount, currency)}</span>
    </article>
  );
}

function ManualExpenseForm({ group, onSaveExpense }) {
  const [form, setForm] = useState({
    title: "",
    amount: "",
    currency: group.currency,
    paidBy: group.members[0]?.id || "",
    participantIds: group.members.map((member) => member.id),
    splitType: "equal",
    date: TODAY,
    notes: "",
    attachment: null,
    customShares: {},
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      currency: group.currency,
      paidBy: group.members[0]?.id || "",
      participantIds: group.members.map((member) => member.id),
    }));
  }, [group.id]);

  const shares = computeSimpleExpenseShares(form);

  function updateForm(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function toggleParticipant(memberId) {
    const active = new Set(form.participantIds);
    if (active.has(memberId)) active.delete(memberId);
    else active.add(memberId);
    updateForm({ participantIds: [...active] });
  }

  async function attachManualPhoto(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    updateForm({
      attachment: {
        name: file.name || "Expense photo",
        dataUrl: await fileToDataUrl(file),
      },
    });
  }

  function saveManualExpense() {
    onSaveExpense({
      ...form,
      amount: Number(form.amount || 0),
      shares,
      splitType:
        form.splitType === "customAmount"
          ? "customAmount"
          : form.splitType === "customPercent"
            ? "customPercent"
            : "equal",
    });
    updateForm({
      title: "",
      amount: "",
      notes: "",
      attachment: null,
      customShares: {},
    });
  }

  return (
    <section className="tool-panel manual-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Manual expense</p>
          <h2>Expense Without Receipt</h2>
        </div>
        <button className="primary-button" onClick={saveManualExpense}>
          <Check size={16} />
          Save Expense
        </button>
      </div>

      <div className="manual-grid">
        <label>
          Expense title
          <input value={form.title} onChange={(event) => updateForm({ title: event.target.value })} />
        </label>
        <label>
          Amount
          <input
            type="number"
            step="0.01"
            value={form.amount}
            onChange={(event) => updateForm({ amount: event.target.value })}
          />
        </label>
        <label>
          Currency
          <input value={form.currency} onChange={(event) => updateForm({ currency: event.target.value })} />
        </label>
        <label>
          Who paid
          <select value={form.paidBy} onChange={(event) => updateForm({ paidBy: event.target.value })}>
            {group.members.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={form.date} onChange={(event) => updateForm({ date: event.target.value })} />
        </label>
        <label>
          Split type
          <select value={form.splitType} onChange={(event) => updateForm({ splitType: event.target.value })}>
            <option value="equal">Equal</option>
            <option value="customAmount">Custom amount</option>
            <option value="customPercent">Custom percentage</option>
          </select>
        </label>
        <label className="wide-input">
          Notes
          <input value={form.notes} onChange={(event) => updateForm({ notes: event.target.value })} />
        </label>
        <label className="wide-input">
          Attachment / photo
          <input
            className="file-control"
            type="file"
            accept="image/*"
            onChange={(event) => {
              attachManualPhoto(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      {form.attachment && (
        <div className="attachment-preview-row">
          <img src={form.attachment.dataUrl} alt={form.attachment.name} />
          <span>{form.attachment.name}</span>
          <button
            className="tiny-button"
            onClick={() => updateForm({ attachment: null })}
          >
            Remove
          </button>
        </div>
      )}

      <div className="participant-row">
        <span><Users size={16} /> Shared by</span>
        {group.members.map((member) => (
          <button
            key={member.id}
            className={form.participantIds.includes(member.id) ? "chip selected" : "chip"}
            onClick={() => toggleParticipant(member.id)}
          >
            {member.name}
          </button>
        ))}
      </div>

      {form.splitType !== "equal" && (
        <div className="share-grid">
          {group.members
            .filter((member) => form.participantIds.includes(member.id))
            .map((member) => (
              <label key={member.id}>
                {member.name}
                <input
                  type="number"
                  step={form.splitType === "customPercent" ? "1" : "0.01"}
                  value={form.customShares[member.id] || ""}
                  onChange={(event) =>
                    updateForm({
                      customShares: {
                        ...form.customShares,
                        [member.id]: Number(event.target.value || 0),
                      },
                    })
                  }
                />
              </label>
            ))}
        </div>
      )}

      <div className="summary-list manual-summary">
        {group.members
          .filter((member) => form.participantIds.includes(member.id))
          .map((member) => (
            <div className="summary-row" key={member.id}>
              <strong>{member.name}</strong>
              <b>{formatMoney(shares[member.id] || 0, form.currency || group.currency)}</b>
            </div>
          ))}
      </div>
    </section>
  );
}

function ExpenseLedger({ group, onDeleteExpense }) {
  const memberById = Object.fromEntries(group.members.map((member) => [member.id, member]));

  return (
    <section className="tool-panel ledger-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Saved under this trip</p>
          <h2>Trip Ledger</h2>
        </div>
      </div>
      <div className="ledger-list">
        {group.expenses.map((expense) => (
          <article className="ledger-item" key={expense.id}>
            <div>
              <strong>{expense.title}</strong>
              <span>
                {expense.date} - paid by {memberById[expense.paidBy]?.name || "Unknown"}
              </span>
              {expense.attachment && (
                <span className="attachment-name">
                  Attachment: {expense.attachment.name}
                </span>
              )}
            </div>
            {expense.attachment?.dataUrl && (
              <img
                className="ledger-thumb"
                src={expense.attachment.dataUrl}
                alt={expense.attachment.name}
              />
            )}
            <b>{formatMoney(expense.amount, expense.currency || group.currency)}</b>
            <button className="icon-button danger" onClick={() => onDeleteExpense(expense.id)} aria-label="Delete expense">
              <Trash2 size={16} />
            </button>
          </article>
        ))}
        {!group.expenses.length && <div className="empty-state">No expenses saved yet.</div>}
      </div>
    </section>
  );
}

export default App;
