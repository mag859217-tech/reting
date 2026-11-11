/* ============ Настройки ============ */
const API_URL = "/graphql";                 // запросы идут через server.js
const ORGANIZATION_ID = "04329772-ff8b-4123-a65b-298e1fa799fb";
const CONCURRENCY = 5;                      // сколько запросов одновременно
const TOP_N = 30, TOP_CARDS = 10;           // топ-30: 10 карточек + 20 в списке
const STORE = "ithub-rating-v2", SKEY = "ithub-rating-settings";
const DEFAULTS = { wPoints: 70, theme: "auto" };   // формула: 70% баллы + 30% посещаемость

/* ============ GraphQL ============ */
let token = null;
async function gql(operationName, query, variables) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apollographql-client-name": "web",
      ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ operationName, query, variables })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Сервер вернул не JSON (HTTP ${res.status}). Начало ответа: ${text.slice(0, 120).replace(/\s+/g, " ")}`); }
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}
async function signIn(email, password) {
  const q = `query SignIn($input: SignInInput!){signIn(input:$input){user{id} accessToken}}`;
  token = (await gql("SignIn", q, { input: { email, password } })).signIn.accessToken;
}
async function getAllStudents() {
  const q = `query GetCuratorGroups($input: CuratorGroupsInput!){
    curatorGroups(input:$input){ items{ id name isArchived students{ id firstName lastName } } page hasMore totalPages }}`;
  const byId = new Map();
  let page = 1, more = true;
  while (more) {
    const input = { organizationId: ORGANIZATION_ID };
    if (page > 1) input.page = page;
    const r = (await gql("GetCuratorGroups", q, { input })).curatorGroups;
    r.items.filter(g => !g.isArchived).forEach(g => g.students.forEach(s =>
      byId.set(s.id, { id: s.id, name: `${s.lastName} ${s.firstName}`, group: g.name })));
    more = r.hasMore; page++;
  }
  return [...byId.values()];
}
async function getPerformance(studentId) {
  const q = `query P($input: SearchStudentDisciplinesInput!){
    searchStudentDisciplines(input:$input){
      scoreForAnsweredTasks maxScoreForAnsweredTasks
      disciplineAttendance{percent total visited} }}`;
  return (await gql("P", q, { input: { studentId } })).searchStudentDisciplines;
}
// Сырые показатели ученика; итоговый рейтинг считается при отрисовке (формулу можно менять)
function calcRaw(disciplines) {
  let got = 0, max = 0, visited = 0, total = 0; const att = [];
  disciplines.forEach(x => {
    got += x.scoreForAnsweredTasks || 0;
    max += x.maxScoreForAnsweredTasks || 0;
    const a = x.disciplineAttendance;
    if (a && a.total > 0) { att.push(a.percent); visited += a.visited || 0; total += a.total; }
  });
  return { points: Math.round(got), maxPoints: Math.round(max), pointsPct: max ? got / max * 100 : 0,
    attendance: att.length ? att.reduce((a, b) => a + b, 0) / att.length : 0, visited, total };
}
async function pool(items, limit, worker) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k]); }
  }));
  return out;
}
async function loadAll(email, password) {
  await signIn(email, password);
  const students = await getAllStudents();
  if (!students.length) throw new Error("Список учеников пуст: у аккаунта нет групп куратора.");
  return pool(students, CONCURRENCY, async s => ({ ...s, ...calcRaw(await getPerformance(s.id)) }));
}

/* ============ Состояние ============ */
const ALL = new Map();          // id ученика -> сырые данные
let updatedAt = null;
const state = { group: "", view: "top", q: "", sortKey: "score", sortDir: -1 };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || "{}")); } catch {}
const saveSettings = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch {} };

const GROUP_COLORS = new Map();
const PALETTE = ["#c6538c", "#216ba5", "#2f9e6b", "#d9822b", "#7c5cc4", "#0e9aa7", "#b7791f", "#d53f8c"];
const isDemo = id => String(id).startsWith("demo-");

function save() {   // данные хранятся только в этой вкладке (sessionStorage)
  try { sessionStorage.setItem(STORE, JSON.stringify({ updatedAt, students: [...ALL.values()].filter(s => !isDemo(s.id)) })); } catch {}
}
function restore() {
  try {
    const d = JSON.parse(sessionStorage.getItem(STORE) || "null");
    if (d) { d.students.forEach(s => ALL.set(s.id, s)); updatedAt = d.updatedAt; }
  } catch {}
}

/* ============ Хелперы ============ */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = s => String(s).toLowerCase().replace(/ё/g, "е");
const fmtScore = v => v.toFixed(1);
const fmtAtt = v => Math.round(v) + "%";
const attClass = v => v >= 90 ? "ok" : v >= 75 ? "warn" : "bad";
const color = g => { if (!GROUP_COLORS.has(g)) GROUP_COLORS.set(g, PALETTE[GROUP_COLORS.size % PALETTE.length]); return GROUP_COLORS.get(g); };
const chip = g => `<span class="chip" style="background:${color(g)}1f;color:${color(g)}" title="${esc(g)}">${esc(g)}</span>`;
const clamp = v => Math.max(0, Math.min(100, v));
let toastTimer;
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("on"), 2200); }

// Расчёт рейтинга и мест (общий и внутри группы)
function prepare() {
  const w = settings.wPoints / 100;
  const arr = [...ALL.values()].map(s => ({ ...s, score: w * s.pointsPct + (1 - w) * s.attendance }));
  arr.sort((a, b) => b.score - a.score || b.points - a.points || a.name.localeCompare(b.name, "ru"));
  const per = new Map();
  arr.forEach((s, i) => { s.rankAll = i + 1; s.rankGroup = (per.get(s.group) || 0) + 1; per.set(s.group, s.rankGroup); });
  arr.forEach(s => s.groupSize = per.get(s.group));
  return arr;
}
function getScope() {
  const arr = prepare();
  const scope = state.group ? arr.filter(s => s.group === state.group) : arr;
  const rankOf = s => state.group ? s.rankGroup : s.rankAll;
  return { arr, scope, rankOf };
}

// Одни и те же три показателя с теми же подписями — в карточках, списке и таблице
const metrics = s => `<div class="m">
  <div><span class="lab">Баллы</span><b>${s.points}</b></div>
  <div><span class="lab">Посещаемость</span><b class="${attClass(s.attendance)}">${fmtAtt(s.attendance)}</b></div>
  <div class="sc"><span class="lab">Рейтинг</span><b>${fmtScore(s.score)}</b></div></div>`;
const rankBadge = n => `<span class="rank ${n <= 3 ? "r" + n : ""}">${n}</span>`;

/* ============ Отрисовка ============ */
const EMPTY = `<div class="empty"><b>Пока нет данных</b>
  <span>Добавь аккаунт куратора, чтобы построить рейтинг, или посмотри демо.</span>
  <button class="btn btn-main" data-open>Добавить аккаунт</button></div>`;

function render() {
  const { arr, scope, rankOf } = getScope();
  $("toolbar").hidden = !arr.length;
  if (!arr.length) { $("summary").innerHTML = ""; $("app").innerHTML = EMPTY; return; }

  const groups = [...new Set(arr.map(s => s.group))].sort((a, b) => a.localeCompare(b, "ru"));
  groups.forEach(color);
  if (state.group && !groups.includes(state.group)) { state.group = ""; return render(); }

  const q = norm(state.q.trim());
  const mode = q ? "all" : state.view;
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === mode)));

  // вкладки групп
  $("tabs").innerHTML = [`<button class="tab ${state.group ? "" : "on"}" data-g="">Все группы<i>${arr.length}</i></button>`]
    .concat(groups.map(g => `<button class="tab ${g === state.group ? "on" : ""}" data-g="${esc(g)}">${esc(g)}<i>${arr.filter(s => s.group === g).length}</i></button>`)).join("");

  // сводка по выбранной вкладке
  const avg = k => scope.reduce((a, s) => a + s[k], 0) / scope.length;
  const gc = new Set(scope.map(s => s.group)).size;
  const when = updatedAt ? new Date(updatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  $("summary").innerHTML = `
    <div class="sum">
      <div><b>${scope.length}</b><span>Учеников в рейтинге</span></div>
      <div><b>${gc}</b><span>${gc === 1 ? "Группа" : "Групп"}</span></div>
      <div><b>${fmtScore(avg("score"))}</b><span>Средний рейтинг</span></div>
      <div><b>${fmtAtt(avg("attendance"))}</b><span>Средняя посещаемость</span></div>
    </div>
    <p class="meta">Рейтинг = ${settings.wPoints}% баллы + ${100 - settings.wPoints}% посещаемость. При равном рейтинге выше тот, у кого больше баллов. Нажми на ученика, чтобы увидеть подробности.${when ? " Обновлено: " + when + "." : ""}</p>`;

  $("app").innerHTML = mode === "top" ? topHTML(scope, rankOf) : tableHTML(scope, rankOf, q);
}

function topHTML(scope, rankOf) {
  const top = scope.slice(0, TOP_N);
  const label = state.group ? esc(state.group) : "все группы";
  const cards = top.slice(0, TOP_CARDS).map(s => `
    <article class="card ${rankOf(s) === 1 ? "first" : ""}" data-id="${esc(s.id)}" tabindex="0" role="button" aria-label="${esc(s.name)}, подробности">
      <div class="head">${rankBadge(rankOf(s))}${chip(s.group)}</div>
      <div class="name">${esc(s.name)}</div>
      <div class="bar"><i style="width:${clamp(s.score)}%"></i></div>
      ${metrics(s)}
    </article>`).join("");
  const rows = top.slice(TOP_CARDS).map(s => `
    <li class="row" data-id="${esc(s.id)}" tabindex="0" role="button" aria-label="${esc(s.name)}, подробности">
      ${rankBadge(rankOf(s))}
      <div class="who"><div class="name">${esc(s.name)}</div>${chip(s.group)}</div>
      ${metrics(s)}
    </li>`).join("");
  return `<div class="sec-head"><h2>Топ-${Math.min(TOP_CARDS, top.length)}</h2><span>${label}</span></div>
    <div class="top">${cards}</div>
    ${rows ? `<div class="sec-head"><h2>Места ${TOP_CARDS + 1}–${top.length}</h2><span>${label}</span></div><ul class="rest">${rows}</ul>` : ""}`;
}

function tableHTML(scope, rankOf, q) {
  let rows = q ? scope.filter(s => norm(s.name + " " + s.group).includes(q)) : [...scope];
  const k = state.sortKey, dir = state.sortDir;
  rows.sort((a, b) => {
    const r = (k === "name" || k === "group") ? a[k].localeCompare(b[k], "ru") : a[k] - b[k];
    return (r * dir) || a.name.localeCompare(b.name, "ru");
  });
  const th = (key, title, cls = "") => `<th class="${cls} ${k === key ? "on" : ""}" data-sort="${key}" tabindex="0">${title}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  const body = rows.map(s => `
    <tr data-id="${esc(s.id)}" tabindex="0">
      <td class="c-rank">${rankBadge(rankOf(s))}</td>
      <td class="nm">${esc(s.name)}</td>
      <td>${chip(s.group)}</td>
      <td class="num">${s.points}</td>
      <td class="num ${attClass(s.attendance)}">${fmtAtt(s.attendance)}</td>
      <td class="num"><div class="sc"><div class="mini"><i style="width:${clamp(s.score)}%"></i></div>${fmtScore(s.score)}</div></td>
    </tr>`).join("");
  if (!rows.length) return `<div class="empty"><b>Никого не найдено</b><span>Попробуй изменить запрос.</span></div>`;
  return `<div class="sec-head"><h2>${q ? "Результаты поиска" : "Все ученики"}</h2><span>${state.group ? esc(state.group) : "все группы"}</span></div>
    <p class="count">Показано ${rows.length} из ${scope.length}. Нажми на заголовок столбца, чтобы отсортировать.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th class="c-rank">Место</th>${th("name", "Ученик")}${th("group", "Группа")}${th("points", "Баллы", "num")}${th("attendance", "Посещаемость", "num")}${th("score", "Рейтинг", "num")}
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ============ Карточка ученика ============ */
function openStudent(id) {
  const arr = prepare();
  const s = arr.find(x => String(x.id) === String(id));
  if (!s) return;
  const same = arr.filter(x => x.group === s.group);
  const gAvg = same.reduce((a, x) => a + x.score, 0) / same.length;
  const diff = s.score - gAvg;
  const above = same[s.rankGroup - 2];
  const notes = [
    `${diff >= 0 ? "Выше" : "Ниже"} среднего рейтинга группы на ${Math.abs(diff).toFixed(1)}.`,
    above ? `До места ${s.rankGroup - 1} в группе не хватает ${(above.score - s.score).toFixed(1)} рейтинга.` : "Лучший результат в своей группе."
  ].join(" ");
  $("sd-body").innerHTML = `
    <div class="sd-top"><div><div class="name">${esc(s.name)}</div>${chip(s.group)}</div>
      <button type="button" class="x" data-close aria-label="Закрыть">×</button></div>
    <div class="sd-score"><b>${fmtScore(s.score)}</b><span>рейтинг</span></div>
    <div class="sd-grid">
      <div><span class="lab">Место в группе</span><b>${s.rankGroup} из ${s.groupSize}</b></div>
      <div><span class="lab">Место среди всех</span><b>${s.rankAll} из ${arr.length}</b></div>
    </div>
    <div class="sd-bar"><div class="wrow"><span>Баллы: ${s.points} из ${s.maxPoints}</span><b>${s.pointsPct.toFixed(0)}%</b></div><div class="bar"><i style="width:${clamp(s.pointsPct)}%"></i></div></div>
    <div class="sd-bar"><div class="wrow"><span>Посещаемость${s.total ? `: ${s.visited} из ${s.total} занятий` : ""}</span><b class="${attClass(s.attendance)}">${fmtAtt(s.attendance)}</b></div><div class="bar"><i style="width:${clamp(s.attendance)}%"></i></div></div>
    <p class="sd-note">${notes}</p>`;
  $("sdlg").showModal();
}

/* ============ Экспорт ============ */
function exportCsv() {
  const { scope, rankOf } = getScope();
  const num = v => v.toFixed(1).replace(".", ",");
  const head = ["Место", "Ученик", "Группа", "Баллы", "Макс. баллов", "Баллы, %", "Посещаемость, %", "Рейтинг"];
  const rows = scope.map(s => [rankOf(s), s.name, s.group, s.points, s.maxPoints, num(s.pointsPct), num(s.attendance), num(s.score)]);
  const cell = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = "\uFEFF" + [head, ...rows].map(r => r.map(cell).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `rating-${(state.group || "all").replace(/[^\wА-Яа-я.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a); a.click(); a.remove();
  toast("Таблица скачана");
}
async function copyTop() {
  const { scope, rankOf } = getScope();
  const text = `Топ-${Math.min(10, scope.length)} · ${state.group || "все группы"}\n` +
    scope.slice(0, 10).map(s => `${rankOf(s)}. ${s.name} (${s.group}) — ${fmtScore(s.score)}`).join("\n");
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast("Топ-10 скопирован");
}

/* ============ Тема и настройки ============ */
function applyTheme() {
  const t = settings.theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = t;
  $("theme").textContent = t === "dark" ? "☀" : "☾";
}
function syncSettingsUI() {
  $("wp").value = settings.wPoints;
  $("wpv").textContent = settings.wPoints + "%";
  $("wav").textContent = (100 - settings.wPoints) + "%";
}

/* ============ События ============ */
const dlg = $("dlg");
const showError = t => { $("err").textContent = t; $("err").classList.toggle("on", !!t); };
const openLogin = () => { showError(""); dlg.showModal(); $("email").focus(); };

document.addEventListener("click", e => {
  const t = e.target;
  if (!t.closest("#menu")) $("menu").open = false;
  if (t.closest("[data-close]")) return t.closest("dialog").close();
  if (t.closest("[data-open]")) return openLogin();
  const tab = t.closest(".tab");
  if (tab) { state.group = tab.dataset.g; return render(); }
  const v = t.closest("[data-view]");
  if (v) { state.view = v.dataset.view; state.q = ""; $("q").value = ""; return render(); }
  const th = t.closest("th[data-sort]");
  if (th) {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir *= -1;
    else { state.sortKey = k; state.sortDir = (k === "name" || k === "group") ? 1 : -1; }
    return render();
  }
  const act = t.closest("[data-act]");
  if (act) {
    $("menu").open = false;
    ({ csv: exportCsv, copy: copyTop, print: () => window.print() })[act.dataset.act]();
    return;
  }
  const item = t.closest("[data-id]");
  if (item) openStudent(item.dataset.id);
});
document.querySelectorAll("dialog").forEach(d => d.addEventListener("click", e => { if (e.target === d) d.close(); }));

document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-id]")) { e.preventDefault(); openStudent(e.target.dataset.id); }
  if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) { e.preventDefault(); $("q").focus(); }
  if (e.key === "Escape" && document.activeElement === $("q")) { $("q").value = ""; state.q = ""; render(); }
});
$("q").addEventListener("input", e => { state.q = e.target.value; render(); });

$("theme").onclick = () => { settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; saveSettings(); applyTheme(); };
$("settings").onclick = () => { syncSettingsUI(); $("setdlg").showModal(); };
$("wp").addEventListener("input", e => { settings.wPoints = +e.target.value; saveSettings(); syncSettingsUI(); render(); });
$("wp-reset").onclick = () => { settings.wPoints = DEFAULTS.wPoints; saveSettings(); syncSettingsUI(); render(); };

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  showError("");
  if (!/^https?:$/.test(location.protocol) || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    return showError("Страница открыта неправильно. Запусти start.bat (или «node server.js») и открой http://localhost:3000");
  }
  const btn = $("go");
  btn.disabled = true; btn.classList.add("busy");
  try {
    const rated = await loadAll($("email").value.trim(), $("pass").value);
    [...ALL.keys()].forEach(k => isDemo(k) && ALL.delete(k));
    rated.forEach(s => ALL.set(s.id, s));
    updatedAt = Date.now();
    save();
    $("form").reset();
    dlg.close();
    render();
  } catch (err) {
    showError("Ошибка: " + err.message);
  } finally { btn.disabled = false; btn.classList.remove("busy"); token = null; }
});

$("reset").onclick = () => { ALL.clear(); Object.assign(state, { group: "", q: "", view: "top" }); $("q").value = ""; updatedAt = null; save(); render(); };
$("demo").onclick = () => {
  ALL.clear(); Object.assign(state, { group: "", q: "" }); $("q").value = ""; updatedAt = Date.now();
  const names = ["Алиев Умар", "Бекова Мадина", "Гойгов Ибрагим", "Дзарахов Тимур", "Евлоев Расул", "Жеков Лом-Али", "Зязиков Ахмед", "Ильясов Хасан", "Картоев Висхан", "Льянов Баха", "Мальсагова Алина", "Нальгиев Ян"];
  ["1П1-9.26", "1П2-9.26", "1П3-9.26"].forEach((g, gi) => Array.from({ length: 18 }, (_, i) => {
    const pct = 35 + Math.random() * 65, att = 55 + Math.random() * 45;
    ALL.set(`demo-${gi}-${i}`, { id: `demo-${gi}-${i}`, name: `${names[(i + gi * 4) % 12]}`, group: g,
      points: Math.round(pct * 6), maxPoints: 600, pointsPct: pct, attendance: att, total: 60, visited: Math.round(att * .6) });
  }));
  render();
};

applyTheme();
syncSettingsUI();
restore();
render();