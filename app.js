/* global Dexie, Chart, FullCalendar */
const db = new Dexie("financePlannerDB");
db.version(1).stores({
  transactions: "++id, date, type, category, accountId",
  accounts: "++id, name, type",
  loans: "++id, name, dueDay",
  creditCards: "++id, name, dueDay",
  insurances: "++id, policyName, nextDueDate",
  assets: "++id, name, date",
  settings: "id"
});

let chart = null;
let calendar = null;
let deferredPrompt = null;

const $ = (id) => document.getElementById(id);
const toNum = (v) => Number(v || 0);
const todayStr = () => new Date().toISOString().slice(0, 10);

function fmt(n) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD"
  }).format(Number(n || 0));
}

document.addEventListener("DOMContentLoaded", async () => {
  await seedData();
  setupTabs();
  setupPWAInstall();
  setupForms();
  await renderAccountSelect();
  initCalendar();
  await renderAll();
  registerSW();
});

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("show"));
      btn.classList.add("active");
      $(btn.dataset.target).classList.add("show");
      if (btn.dataset.target === "calendar" && calendar) calendar.updateSize();
    });
  });
}

function setupPWAInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $("installBtn").hidden = false;
  });

  $("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("installBtn").hidden = true;
  });
}

function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  }
}

async function seedData() {
  const count = await db.accounts.count();
  if (!count) {
    await db.accounts.bulkAdd([
      { name: "Cash", type: "cash" },
      { name: "Main Bank", type: "bank" },
      { name: "Credit Card", type: "credit" }
    ]);
  }

  const settings = await db.settings.get(1);
  if (!settings) await db.settings.put({ id: 1, currency: "USD" });
}

function setupForms() {
  $("txForm").date.value = todayStr();
  $("assetForm").date.value = todayStr();

  $("txForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);

    await db.transactions.add({
      date: f.get("date"),
      type: f.get("type"),
      amount: toNum(f.get("amount")),
      category: f.get("category"),
      accountId: Number(f.get("accountId")),
      note: (f.get("note") || "").toString().trim()
    });

    e.target.reset();
    $("txForm").date.value = todayStr();
    await renderAll();
  });

  $("loanForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);

    await db.loans.add({
      name: f.get("name"),
      principal: toNum(f.get("principal")),
      interestRate: toNum(f.get("interestRate")),
      emi: toNum(f.get("emi")),
      dueDay: Number(f.get("dueDay") || 1),
      remaining: toNum(f.get("remaining"))
    });

    e.target.reset();
    await renderAll();
  });

  $("cardForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);

    await db.creditCards.add({
      name: f.get("name"),
      limit: toNum(f.get("limit")),
      statementDay: Number(f.get("statementDay") || 1),
      dueDay: Number(f.get("dueDay") || 1),
      outstanding: toNum(f.get("outstanding")),
      apr: toNum(f.get("apr"))
    });

    e.target.reset();
    await renderAll();
  });

  $("insuranceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);

    await db.insurances.add({
      policyName: f.get("policyName"),
      premium: toNum(f.get("premium")),
      frequency: f.get("frequency"),
      nextDueDate: f.get("nextDueDate"),
      coverage: toNum(f.get("coverage"))
    });

    e.target.reset();
    await renderAll();
  });

  $("assetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);

    await db.assets.add({
      name: f.get("name"),
      type: f.get("type"),
      value: toNum(f.get("value")),
      date: f.get("date")
    });

    e.target.reset();
    $("assetForm").date.value = todayStr();
    await renderAll();
  });

  $("txTable").addEventListener("click", async (e) => {
    const btn = e.target.closest(".delete-btn");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    await db.transactions.delete(id);
    await renderAll();
  });

  $("exportBtn").addEventListener("click", exportBackup);
  $("importInput").addEventListener("change", importBackup);
}

async function renderAll() {
  await Promise.all([
    renderDashboard(),
    renderTransactions(),
    renderDebtAndAssetLists(),
    renderDueList(),
    refreshCalendarEvents()
  ]);
}

async function renderAccountSelect() {
  const accounts = await db.accounts.toArray();
  $("accountSelect").innerHTML = accounts
    .map((a) => `<option value="${a.id}">${a.name}</option>`)
    .join("");
}

async function renderTransactions() {
  const [txs, accounts] = await Promise.all([
    db.transactions.orderBy("id").reverse().limit(50).toArray(),
    db.accounts.toArray()
  ]);

  const mapAcc = Object.fromEntries(accounts.map((a) => [a.id, a.name]));

  $("txTable").innerHTML = txs.map((t) => `
    <tr>
      <td>${t.date}</td>
      <td>${t.type}</td>
      <td>${t.category}</td>
      <td>${fmt(t.amount)}</td>
      <td>${mapAcc[t.accountId] || "-"}</td>
      <td>${t.note || ""}</td>
      <td><button class="delete-btn" data-id="${t.id}">Delete</button></td>
    </tr>
  `).join("");
}

async function renderDashboard() {
  const txs = await db.transactions.toArray();
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const monthTx = txs.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return d.getFullYear() === y && d.getMonth() === m;
  });

  const income = monthTx
    .filter((t) => t.type === "income")
    .reduce((sum, t) => sum + toNum(t.amount), 0);

  const expense = monthTx
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + toNum(t.amount), 0);

  const [loans, cards, assets] = await Promise.all([
    db.loans.toArray(),
    db.creditCards.toArray(),
    db.assets.toArray()
  ]);

  const totalDebt =
    loans.reduce((s, l) => s + toNum(l.remaining), 0) +
    cards.reduce((s, c) => s + toNum(c.outstanding), 0);

  const totalAssets = assets.reduce((s, a) => s + toNum(a.value), 0);

  $("mIncome").textContent = fmt(income);
  $("mExpense").textContent = fmt(expense);
  $("mNet").textContent = fmt(income - expense);
  $("totalDebt").textContent = fmt(totalDebt);
  $("totalAssets").textContent = fmt(totalAssets);

  renderExpenseChart(monthTx);
}

function renderExpenseChart(monthTx) {
  const byCat = {};
  monthTx
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      byCat[t.category] = (byCat[t.category] || 0) + toNum(t.amount);
    });

  const labels = Object.keys(byCat);
  const values = Object.values(byCat);

  const ctx = $("expenseChart").getContext("2d");
  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: labels.length ? labels : ["No expenses"],
      datasets: [{ data: values.length ? values : [1] }]
    },
    options: {
      plugins: {
        legend: {
          labels: { color: "#e2e8f0" }
        }
      }
    }
  });
}

async function renderDebtAndAssetLists() {
  const [loans, cards, ins, assets] = await Promise.all([
    db.loans.toArray(),
    db.creditCards.toArray(),
    db.insurances.toArray(),
    db.assets.toArray()
  ]);

  $("loanList").innerHTML = loans.length
    ? loans.map((l) =>
        `<li>${l.name} — Remaining: ${fmt(l.remaining)} | Due day: ${l.dueDay}</li>`
      ).join("")
    : "<li>No loans yet.</li>";

  $("cardList").innerHTML = cards.length
    ? cards.map((c) =>
        `<li>${c.name} — Outstanding: ${fmt(c.outstanding)} | Due day: ${c.dueDay}</li>`
      ).join("")
    : "<li>No cards yet.</li>";

  $("insuranceList").innerHTML = ins.length
    ? ins.map((i) =>
        `<li>${i.policyName} — Premium: ${fmt(i.premium)} | Next due: ${i.nextDueDate}</li>`
      ).join("")
    : "<li>No insurance yet.</li>";

  $("assetList").innerHTML = assets.length
    ? assets.map((a) =>
        `<li>${a.name} (${a.type}) — ${fmt(a.value)}</li>`
      ).join("")
    : "<li>No assets yet.</li>";
}

function nextDateForDay(day) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const dayThisMonth = Math.min(day, new Date(y, m + 1, 0).getDate());
  let due = new Date(y, m, dayThisMonth);

  const today = new Date(y, m, now.getDate());
  if (due < today) {
    const nm = (m + 1) % 12;
    const ny = m === 11 ? y + 1 : y;
    const dayNextMonth = Math.min(day, new Date(ny, nm + 1, 0).getDate());
    due = new Date(ny, nm, dayNextMonth);
  }
  return due;
}

function normalizeInsuranceDue(nextDueDate, frequency) {
  let d = new Date(nextDueDate + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  while (d < today) {
    if (frequency === "monthly") d.setMonth(d.getMonth() + 1);
    else if (frequency === "quarterly") d.setMonth(d.getMonth() + 3);
    else d.setFullYear(d.getFullYear() + 1);
  }

  return d;
}

async function getDueEvents() {
  const [loans, cards, ins] = await Promise.all([
    db.loans.toArray(),
    db.creditCards.toArray(),
    db.insurances.toArray()
  ]);

  const events = [];

  loans.forEach((l) => {
    const d = nextDateForDay(Number(l.dueDay || 1));
    events.push({
      title: `Loan Due: ${l.name}`,
      date: d.toISOString().slice(0, 10),
      color: "#f59e0b"
    });
  });

  cards.forEach((c) => {
    const d = nextDateForDay(Number(c.dueDay || 1));
    events.push({
      title: `Card Due: ${c.name}`,
      date: d.toISOString().slice(0, 10),
      color: "#ef4444"
    });
  });

  ins.forEach((i) => {
    const d = normalizeInsuranceDue(i.nextDueDate, i.frequency);
    events.push({
      title: `Insurance Due: ${i.policyName}`,
      date: d.toISOString().slice(0, 10),
      color: "#22c55e"
    });
  });

  return events;
}

async function renderDueList() {
  const dueEvents = await getDueEvents();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const in14 = new Date(today);
  in14.setDate(in14.getDate() + 14);

  const filtered = dueEvents
    .map((e) => ({ ...e, d: new Date(e.date + "T00:00:00") }))
    .filter((e) => e.d >= today && e.d <= in14)
    .sort((a, b) => a.d - b.d);

  $("dueList").innerHTML = filtered.length
    ? filtered.map((e) => `<li>${e.date} — ${e.title}</li>`).join("")
    : "<li>No dues in next 14 days.</li>";
}

function initCalendar() {
  calendar = new FullCalendar.Calendar($("calendarView"), {
    initialView: "dayGridMonth",
    height: 700,
    events: []
  });
  calendar.render();
}

async function refreshCalendarEvents() {
  if (!calendar) return;

  const txs = await db.transactions.toArray();
  const dueEvents = await getDueEvents();

  const txEvents = txs.map((t) => ({
    title: `${t.type === "income" ? "🟢" : t.type === "expense" ? "🔴" : "🔵"} ${t.category}: ${fmt(t.amount)}`,
    date: t.date,
    color: t.type === "income" ? "#22c55e" : t.type === "expense" ? "#ef4444" : "#60a5fa"
  }));

  calendar.removeAllEvents();
  [...txEvents, ...dueEvents].forEach((e) => calendar.addEvent(e));
}

async function exportBackup() {
  const data = {
    exportedAt: new Date().toISOString(),
    transactions: await db.transactions.toArray(),
    accounts: await db.accounts.toArray(),
    loans: await db.loans.toArray(),
    creditCards: await db.creditCards.toArray(),
    insurances: await db.insurances.toArray(),
    assets: await db.assets.toArray(),
    settings: await db.settings.toArray()
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `finance-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const text = await file.text();
  const data = JSON.parse(text);

  if (!confirm("This will overwrite existing local data. Continue?")) return;

  await db.transaction("rw", db.tables, async () => {
    for (const t of db.tables) await t.clear();

    if (data.accounts?.length) await db.accounts.bulkAdd(data.accounts);
    if (data.transactions?.length) await db.transactions.bulkAdd(data.transactions);
    if (data.loans?.length) await db.loans.bulkAdd(data.loans);
    if (data.creditCards?.length) await db.creditCards.bulkAdd(data.creditCards);
    if (data.insurances?.length) await db.insurances.bulkAdd(data.insurances);
    if (data.assets?.length) await db.assets.bulkAdd(data.assets);
    if (data.settings?.length) await db.settings.bulkAdd(data.settings);
  });

  await renderAccountSelect();
  await renderAll();
  e.target.value = "";
  alert("Backup imported.");
}
