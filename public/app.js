// 우리반 회의 — 먼저 각자 쓰고, 한꺼번에 공개하고, 익명으로 투표하는 학급회의 도구
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc,
  collection, onSnapshot, writeBatch, serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ───────────── 설정 ───────────── */
const params = new URLSearchParams(location.search);
const useEmulator = params.has("emulator");
const configMissing = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR");
const config = useEmulator && configMissing
  ? { apiKey: "demo-key", projectId: "demo-classroom", authDomain: "localhost" }
  : firebaseConfig;

const MINORITY_RATIO = 0.5; // 1위 득표의 50% 이하를 받은 의견을 "소수 의견"으로 표시
const PHASES = [
  ["collect", "각자 쓰기"], ["reveal", "동시 공개·묶기"], ["vote", "익명 투표"], ["result", "결과"],
];

const $app = document.getElementById("app");
let db, auth, user;

/* ───────────── 유틸 ───────────── */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, "<br>");

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function friendlyError(e) {
  console.error(e);
  if (e?.code === "permission-denied") return "지금 단계에서는 할 수 없어요. 화면을 새로고침해 보세요.";
  if (e?.code === "unavailable") return "인터넷 연결을 확인해 주세요.";
  return "문제가 생겼어요: " + (e?.message || e);
}

async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(friendlyError(e)); } finally { if (btn) btn.disabled = false; }
}

function shuffle(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 학생마다 다른(하지만 새로고침해도 같은) 순서를 만들기 위한 시드 난수
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hostedKey = "classroom-meeting:hosted";
function loadHosted() {
  try { return JSON.parse(localStorage.getItem(hostedKey)) || []; } catch { return []; }
}
function saveHosted(code, topic) {
  try {
    const list = loadHosted().filter((m) => m.code !== code);
    list.unshift({ code, topic, at: Date.now() });
    localStorage.setItem(hostedKey, JSON.stringify(list.slice(0, 10)));
  } catch { /* 저장 불가 환경은 무시 */ }
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}${location.search}#/join/${code}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast("복사했어요");
}

/* ───────────── 라우팅 ───────────── */
let session = null; // 현재 회의 화면 상태

function cleanup() {
  if (!session) return;
  Object.values(session.unsubs).forEach((u) => u && u());
  clearInterval(session.timer);
  session = null;
}

function route() {
  cleanup();
  const [, view, code] = location.hash.replace(/^#\/?/, "/").split("/");
  if ((view === "host" || view === "join") && /^\d{6}$/.test(code || "")) {
    openMeeting(code, view === "host");
  } else {
    renderHome();
  }
  window.scrollTo(0, 0);
}

/* ───────────── 첫 화면 ───────────── */
function renderHome() {
  const hosted = loadHosted();
  $app.innerHTML = `
    <section class="hero">
      <h1>먼저 각자 쓰고,<br>한꺼번에 공개해요</h1>
      <p class="muted">다른 친구 의견을 보기 전에 익명으로 내 생각을 먼저 적어요.
      첫 의견이나 목소리 큰 의견에 휩쓸리지 않는 학급회의!</p>
    </section>

    <section class="card">
      <h2>회의 참여하기</h2>
      <p class="muted small">사회자가 알려 준 6자리 참여 코드를 입력하세요.</p>
      <form id="joinForm" class="row">
        <input id="joinCode" class="code-input" inputmode="numeric" autocomplete="off"
          maxlength="6" placeholder="000000" aria-label="참여 코드" required />
        <button class="btn primary">입장</button>
      </form>
    </section>

    <details class="card" id="createBox">
      <summary><h2 class="inline">사회자: 새 회의 만들기</h2></summary>
      <form id="createForm" class="stack">
        <label>안건 <span class="req">*</span>
          <input name="topic" maxlength="200" required placeholder="예) 체육대회 반티 디자인 정하기" />
        </label>
        <label>설명 (선택)
          <textarea name="detail" maxlength="500" rows="2" placeholder="예) 예산은 1인 15,000원 이하예요."></textarea>
        </label>
        <div class="grid2">
          <label>1인당 투표 수
            <select name="votes">
              <option value="1">1표</option>
              <option value="2">2표</option>
              <option value="3">3표</option>
            </select>
          </label>
          <label>참여 인원 (선택)
            <input name="expected" type="number" min="0" max="200" inputmode="numeric" placeholder="예) 28" />
          </label>
        </div>
        <button class="btn primary block">회의 만들고 참여 코드 받기</button>
      </form>
    </details>

    ${hosted.length ? `
    <section class="card">
      <h2>내가 만든 회의</h2>
      <ul class="plain">
        ${hosted.map((m) => `<li><a href="#/host/${m.code}"><b class="mono">${m.code}</b> · ${esc(m.topic)}</a></li>`).join("")}
      </ul>
    </section>` : ""}

    <section class="card how">
      <h2>이렇게 진행돼요</h2>
      <ol>
        <li><b>각자 쓰기</b> — 코드로 입장해 익명으로 의견을 적어요. 마감 전에는 아무도(사회자도) 다른 의견을 볼 수 없어요.</li>
        <li><b>동시 공개</b> — 마감하면 모든 의견이 <u>무작위 순서</u>로 한꺼번에 공개돼요.</li>
        <li><b>비슷한 의견 묶기</b> — 사회자가 겹치는 의견을 하나로 합쳐요.</li>
        <li><b>익명 투표</b> — 학생마다 의견 순서를 다르게 섞어서 보여 주고, 중간 결과는 숨겨요.</li>
        <li><b>결과</b> — 득표 그래프와 함께 <u>소수 의견</u>도 기록해요.</li>
      </ol>
    </section>
  `;

  const joinInput = document.getElementById("joinCode");
  joinInput.addEventListener("input", () => { joinInput.value = joinInput.value.replace(/\D/g, ""); });
  document.getElementById("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = joinInput.value.trim();
    if (!/^\d{6}$/.test(code)) return toast("6자리 숫자를 입력하세요");
    act(e.submitter, async () => {
      const snap = await getDoc(doc(db, "meetings", code));
      if (!snap.exists()) return toast("그런 코드의 회의가 없어요");
      location.hash = snap.data().hostUid === user.uid ? `#/host/${code}` : `#/join/${code}`;
    });
  });

  document.getElementById("createForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    act(e.submitter, async () => {
      const code = await uniqueCode();
      const topic = f.get("topic").trim();
      if (!topic) return toast("안건을 입력하세요");
      await setDoc(doc(db, "meetings", code), {
        topic,
        detail: f.get("detail").trim(),
        hostUid: user.uid,
        phase: "collect",
        votesPerStudent: Number(f.get("votes")) || 1,
        expected: Math.max(0, Math.min(200, parseInt(f.get("expected"), 10) || 0)),
        opinionCount: 0,
        voteCount: 0,
        deadlineAt: null,
        conclusion: "",
        createdAt: serverTimestamp(),
      });
      saveHosted(code, topic);
      location.hash = `#/host/${code}`;
    });
  });
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const snap = await getDoc(doc(db, "meetings", code));
    if (!snap.exists()) return code;
  }
  throw new Error("코드를 만들지 못했어요. 다시 시도해 주세요.");
}

/* ───────────── 회의 화면 공통 ───────────── */
function openMeeting(code, wantHost) {
  const ref = doc(db, "meetings", code);
  session = {
    code, ref, wantHost, isHost: false,
    meeting: null, cards: [], votes: [], myOpinion: undefined, myVote: undefined,
    editing: false, selected: new Set(), unsubs: {}, key: null, timer: null,
  };
  const s = session;
  $app.innerHTML = `<p class="muted center pad">회의에 들어가는 중…</p>`;

  s.unsubs.meeting = onSnapshot(ref, (snap) => {
    if (session !== s) return;
    if (!snap.exists()) {
      $app.innerHTML = `<section class="card center"><h2>회의를 찾을 수 없어요</h2>
        <p class="muted">코드를 다시 확인해 주세요.</p><a class="btn" href="#/">처음으로</a></section>`;
      return;
    }
    s.meeting = snap.data();
    s.isHost = s.meeting.hostUid === user.uid;
    if (s.isHost) saveHosted(code, s.meeting.topic);
    if (s.wantHost && !s.isHost) { location.hash = `#/join/${code}`; return; }
    syncSubscriptions();
    render();
  }, (e) => toast(friendlyError(e)));

  s.timer = setInterval(updateLive, 1000);
}

function sub(name, enabled, makeUnsub) {
  const s = session;
  if (enabled && !s.unsubs[name]) s.unsubs[name] = makeUnsub();
  if (!enabled && s.unsubs[name]) { s.unsubs[name](); delete s.unsubs[name]; }
}

function syncSubscriptions() {
  const s = session;
  const { phase } = s.meeting;
  const onErr = (e) => { if (e.code !== "permission-denied") toast(friendlyError(e)); };
  const cardsVisible = s.isHost || ["reveal", "vote", "result"].includes(phase);

  sub("cards", cardsVisible, () => onSnapshot(collection(s.ref, "cards"), (qs) => {
    if (session !== s) return;
    s.cards = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
    render();
  }, onErr));

  sub("votes", phase === "result", () => onSnapshot(collection(s.ref, "votes"), (qs) => {
    if (session !== s) return;
    s.votes = qs.docs.map((d) => d.data());
    render();
  }, onErr));

  if (!s.isHost) {
    sub("myOpinion", true, () => onSnapshot(doc(s.ref, "opinions", user.uid), (d) => {
      if (session !== s) return;
      s.myOpinion = d.exists() ? d.data() : null;
      render();
    }, onErr));
    sub("myVote", true, () => onSnapshot(doc(s.ref, "votes", user.uid), (d) => {
      if (session !== s) return;
      s.myVote = d.exists() ? d.data() : null;
      render();
    }, onErr));
  }
}

const visibleCards = () => session.cards.filter((c) => !c.hidden && !c.mergedInto);

// 같은 내용이면 다시 그리지 않는다(입력 중인 글이 지워지지 않도록). 숫자·타이머는 updateLive가 갱신.
function render(force = false) {
  const s = session;
  if (!s?.meeting) return;
  const m = s.meeting;
  const viewKey = JSON.stringify([
    s.isHost, m.phase, m.topic, m.detail, m.votesPerStudent, !!m.deadlineAt,
    s.cards, s.votes.length,
    // undefined(불러오는 중)와 null(아직 안 냄)을 구분해야 하므로 문자열로 바꿔 둔다
    s.isHost ? null : [s.myOpinion ?? String(s.myOpinion), s.myVote ?? String(s.myVote), s.editing],
  ]);
  if (!force && viewKey === s.key) return updateLive();
  s.key = viewKey;

  // 다시 그려도 사용자가 입력 중이던 글은 지키기
  const drafts = {};
  $app.querySelectorAll("textarea[data-dirty]").forEach((ta) => { drafts[ta.name] = ta.value; });

  const body = s.isHost ? hostView() : studentView();
  $app.innerHTML = `
    <section class="meeting-head">
      ${stepper(m.phase)}
      <h1 class="topic">${esc(m.topic)}</h1>
      ${m.detail ? `<p class="muted">${nl2br(m.detail)}</p>` : ""}
      <p class="small muted">참여 코드 <b class="mono">${s.code}</b>${s.isHost ? " · 사회자 화면" : ""}</p>
    </section>
    ${body}
  `;
  Object.entries(drafts).forEach(([name, value]) => {
    const ta = $app.querySelector(`textarea[name="${name}"]`);
    if (ta) { ta.value = value; ta.dataset.dirty = "1"; }
  });
  bindActions();
  updateLive();
}

function stepper(phase) {
  const idx = Math.max(0, PHASES.findIndex(([p]) => p === (phase === "closed" ? "reveal" : phase)));
  return `<ol class="stepper">${PHASES.map(([, label], i) =>
    `<li class="${i < idx ? "done" : i === idx ? "now" : ""}">${label}</li>`).join("")}</ol>`;
}

function updateLive() {
  const s = session;
  if (!s?.meeting) return;
  const m = s.meeting;
  const total = m.expected ? ` / ${m.expected}명` : "명";
  document.querySelectorAll("[data-live=opinionCount]").forEach((el) => { el.textContent = `${m.opinionCount}${total}`; });
  document.querySelectorAll("[data-live=voteCount]").forEach((el) => { el.textContent = `${m.voteCount}${total}`; });
  document.querySelectorAll("[data-live=progress]").forEach((el) => {
    const n = el.dataset.kind === "vote" ? m.voteCount : m.opinionCount;
    el.style.width = m.expected ? `${Math.min(100, (n / m.expected) * 100)}%` : "0";
  });
  document.querySelectorAll("[data-live=conclusion]").forEach((el) => {
    el.innerHTML = m.conclusion ? `<h3>📝 회의 결론</h3><p>${nl2br(m.conclusion)}</p>` : "";
    el.hidden = !m.conclusion;
  });
  document.querySelectorAll("[data-live=countdown]").forEach((el) => {
    if (!m.deadlineAt) { el.textContent = ""; el.hidden = true; return; }
    el.hidden = false;
    const left = Math.round((m.deadlineAt - Date.now()) / 1000);
    if (left <= 0) {
      el.textContent = "⏰ 시간이 끝났어요";
      el.classList.add("over");
    } else {
      el.classList.remove("over");
      el.textContent = `⏱ 남은 시간 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    }
  });
}

function bindActions() {
  $app.querySelectorAll("[data-action]").forEach((el) => {
    const evt = el.tagName === "FORM" ? "submit"
      : (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "click";
    el.addEventListener(evt, (e) => {
      if (evt === "submit") e.preventDefault();
      const fn = actions[el.dataset.action];
      if (fn) fn(el, e);
    });
  });
  $app.querySelectorAll("textarea").forEach((ta) => {
    ta.addEventListener("input", () => { ta.dataset.dirty = "1"; });
  });
  $app.querySelectorAll("textarea[maxlength]").forEach((ta) => {
    const counter = $app.querySelector(`[data-count-for="${ta.name}"]`);
    if (!counter) return;
    const upd = () => { counter.textContent = `${ta.value.length}/${ta.maxLength}`; };
    ta.addEventListener("input", upd); upd();
  });
}

function cardHtml(c, { showSize = true, extra = "" } = {}) {
  const grouped = c.items && c.items.length > 1;
  return `
    <div class="op-text">${nl2br(c.text)}</div>
    ${!grouped && c.reason ? `<div class="op-reason">이유: ${nl2br(c.reason)}</div>` : ""}
    ${grouped ? `
      <details class="group">
        <summary>${showSize ? `비슷한 의견 ${c.items.length}개 묶음` : "묶인 의견 보기"}</summary>
        <ul>${c.items.map((it) => `<li>${nl2br(it.text)}${it.reason ? `<div class="op-reason">이유: ${nl2br(it.reason)}</div>` : ""}</li>`).join("")}</ul>
      </details>` : ""}
    ${extra}`;
}

/* ───────────── 사회자 화면 ───────────── */
function hostView() {
  const s = session;
  const m = s.meeting;
  switch (m.phase) {
    case "collect": {
      const url = joinUrl(s.code);
      return `
      <section class="card center">
        <p class="muted small">학생들에게 아래 코드나 QR을 보여 주세요</p>
        <div class="big-code mono">${s.code}</div>
        <div class="qr" id="qr">${qrSvg(url)}</div>
        <button class="btn small" data-action="copyLink">참여 링크 복사</button>
      </section>
      <section class="card">
        <div class="stat"><span>의견 제출</span><b data-live="opinionCount"></b></div>
        ${m.expected ? `<div class="bar"><i data-live="progress" data-kind="opinion"></i></div>` : ""}
        <p class="muted small">🔒 마감 전에는 사회자도 의견 내용을 볼 수 없어요. 제출한 인원 수만 보여요.</p>
        <p class="countdown" data-live="countdown" hidden></p>
        <div class="row wrap">
          <span class="small muted">타이머</span>
          <button class="btn small" data-action="timer" data-min="3">3분</button>
          <button class="btn small" data-action="timer" data-min="5">5분</button>
          <button class="btn small" data-action="timer" data-min="10">10분</button>
          ${m.deadlineAt ? `<button class="btn small" data-action="timer" data-min="0">끄기</button>` : ""}
        </div>
      </section>
      <button class="btn primary block lg" data-action="closeAndReveal">마감하고 한꺼번에 공개하기</button>`;
    }
    case "closed":
      return `
      <section class="card center">
        <p>의견을 섞어서 공개하는 중이에요…</p>
        <p class="muted small">오래 걸리면 아래 버튼을 눌러 주세요.</p>
        <button class="btn primary" data-action="closeAndReveal">공개 마치기</button>
      </section>`;
    case "reveal": {
      const cards = s.cards.filter((c) => !c.mergedInto);
      const sel = s.selected;
      return `
      <section class="card">
        <p class="small">모든 의견이 <b>무작위 순서</b>로 공개됐어요. 학생 화면에도 같은 목록이 보여요.</p>
        <p class="small muted">비슷한 의견을 2개 이상 체크하고 <b>묶기</b>를 누르세요. 부적절한 표현은 <b>숨기기</b>로 가릴 수 있어요.</p>
      </section>
      ${cards.length === 0 ? `<p class="muted center pad">제출된 의견이 없어요.</p>` : ""}
      <ul class="cards">
        ${cards.map((c, i) => `
          <li class="op ${c.hidden ? "is-hidden" : ""} ${sel.has(c.id) ? "is-selected" : ""}">
            <label class="pick">
              <input type="checkbox" data-action="toggleSelect" data-id="${c.id}" ${sel.has(c.id) ? "checked" : ""} ${c.hidden ? "disabled" : ""}/>
              <span class="num">${i + 1}</span>
            </label>
            <div class="op-body">
              ${cardHtml(c)}
              <div class="row wrap tools">
                ${c.items?.length > 1 ? `<button class="btn tiny" data-action="unmerge" data-id="${c.id}">묶음 풀기</button>` : ""}
                <button class="btn tiny" data-action="toggleHide" data-id="${c.id}">${c.hidden ? "다시 보이기" : "숨기기"}</button>
              </div>
            </div>
          </li>`).join("")}
      </ul>
      <div class="sticky-actions">
        <button class="btn block" data-action="merge" ${sel.size < 2 ? "disabled" : ""}>선택한 의견 묶기 (${sel.size})</button>
        <div class="row">
          <label class="grow small">1인당
            <select data-action="setVotes" class="inline-select">
              ${[1, 2, 3].map((n) => `<option value="${n}" ${m.votesPerStudent === n ? "selected" : ""}>${n}표</option>`).join("")}
            </select>
          </label>
          <button class="btn primary grow2" data-action="startVote">익명 투표 시작</button>
        </div>
      </div>`;
    }
    case "vote":
      return `
      <section class="card">
        <div class="stat"><span>투표 완료</span><b data-live="voteCount"></b></div>
        ${m.expected ? `<div class="bar"><i data-live="progress" data-kind="vote"></i></div>` : ""}
        <p class="muted small">🔒 투표가 끝날 때까지 중간 결과는 아무도 볼 수 없어요. (1인당 ${m.votesPerStudent}표)</p>
      </section>
      <section class="card">
        <h3>투표 중인 의견 ${visibleCards().length}개</h3>
        <ol class="plain-list">${visibleCards().map((c) => `<li>${esc(c.text)}</li>`).join("")}</ol>
      </section>
      <button class="btn primary block lg" data-action="endVote">투표 마감하고 결과 공개</button>`;
    case "result":
      return resultView(true);
    default:
      return "";
  }
}

function qrSvg(text) {
  if (typeof window.qrcode !== "function") return "";
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag(6, 2);
  } catch { return ""; }
}

/* ───────────── 학생 화면 ───────────── */
function studentView() {
  const s = session;
  const m = s.meeting;
  switch (m.phase) {
    case "collect": {
      if (s.myOpinion === undefined) return `<p class="muted center pad">불러오는 중…</p>`;
      if (s.myOpinion && !s.editing) {
        return `
        <section class="card done-card">
          <h2>✅ 제출 완료</h2>
          <div class="my-op">${cardHtml({ text: s.myOpinion.text, reason: s.myOpinion.reason })}</div>
          <button class="btn small" data-action="edit">마감 전까지 수정하기</button>
        </section>
        <section class="card center">
          <p>다른 친구들의 의견은 <b>마감 후 한꺼번에</b> 공개돼요.</p>
          <div class="stat"><span>지금까지 제출</span><b data-live="opinionCount"></b></div>
          <p class="countdown" data-live="countdown" hidden></p>
        </section>`;
      }
      const o = s.myOpinion || { text: "", reason: "" };
      return `
      <section class="card">
        <p class="countdown" data-live="countdown" hidden></p>
        <form class="stack" data-action="submitOpinion">
          <label>내 의견 <span class="req">*</span>
            <textarea name="text" maxlength="300" rows="4" required placeholder="안건에 대한 내 생각을 자유롭게 적어 주세요.">${esc(o.text)}</textarea>
            <span class="counter" data-count-for="text"></span>
          </label>
          <label>그렇게 생각한 이유 (선택)
            <textarea name="reason" maxlength="300" rows="3" placeholder="이유를 적으면 친구들이 의견을 더 잘 이해할 수 있어요.">${esc(o.reason)}</textarea>
            <span class="counter" data-count-for="reason"></span>
          </label>
          <ul class="tips small muted">
            <li>🔒 이름은 저장되지 않아요. 마감 전에는 누구도 내 의견을 볼 수 없어요.</li>
            <li>🙏 특정 친구를 비난하는 표현은 사회자가 숨길 수 있어요.</li>
          </ul>
          <button class="btn primary block lg">${s.myOpinion ? "수정한 의견 저장" : "익명으로 제출하기"}</button>
          ${s.myOpinion ? `<button type="button" class="btn block" data-action="cancelEdit">취소</button>` : ""}
        </form>
      </section>
      <p class="center small muted">지금까지 <b data-live="opinionCount"></b> 제출</p>`;
    }
    case "closed":
      return `<section class="card center"><h2>⏳ 마감됐어요</h2><p class="muted">곧 모든 의견이 한꺼번에 공개돼요.</p></section>`;
    case "reveal":
      return `
      <section class="card"><p class="small">📢 모든 의견이 <b>무작위 순서</b>로 공개됐어요. 사회자가 비슷한 의견을 묶는 동안 천천히 읽어 보세요.</p></section>
      ${visibleCards().length === 0 ? `<p class="muted center pad">공개된 의견이 없어요.</p>` : ""}
      <ul class="cards">
        ${visibleCards().map((c) => `<li class="op"><div class="op-body">${cardHtml(c)}</div></li>`).join("")}
      </ul>`;
    case "vote": {
      if (s.myVote === undefined) return `<p class="muted center pad">불러오는 중…</p>`;
      if (s.myVote) {
        return `<section class="card center"><h2>🗳️ 투표 완료</h2>
          <p class="muted">결과는 투표가 마감되면 공개돼요.</p>
          <div class="stat"><span>투표한 인원</span><b data-live="voteCount"></b></div></section>`;
      }
      const max = m.votesPerStudent;
      // 학생마다 순서를 다르게 섞어 "목록 위쪽 의견"이 유리해지지 않게 한다
      const list = shuffle(visibleCards().slice(), seededRandom(user.uid + s.code));
      return `
      <section class="card"><p class="small">마음에 드는 의견을 <b>${max}개${max > 1 ? "까지" : ""}</b> 골라 주세요.
        투표는 익명이고, 중간 결과는 보이지 않아요. <span class="muted">(순서는 사람마다 다르게 섞여 있어요)</span></p></section>
      <ul class="cards">
        ${list.map((c) => `
          <li class="op votable ${s.selected.has(c.id) ? "is-selected" : ""}" data-action="pickVote" data-id="${c.id}">
            <span class="check">${s.selected.has(c.id) ? "✔" : ""}</span>
            <div class="op-body">${cardHtml(c, { showSize: false })}</div>
          </li>`).join("")}
      </ul>
      <div class="sticky-actions">
        <button class="btn primary block lg" data-action="submitVote" ${s.selected.size === 0 ? "disabled" : ""}>
          ${s.selected.size}/${max} 선택 · 투표하기</button>
      </div>`;
    }
    case "result":
      return resultView(false);
    default:
      return "";
  }
}

/* ───────────── 결과 ───────────── */
function computeResult() {
  const s = session;
  const cards = visibleCards();
  const tally = Object.fromEntries(cards.map((c) => [c.id, 0]));
  s.votes.forEach((v) => (v.choices || []).forEach((id) => { if (id in tally) tally[id]++; }));
  const voters = s.votes.length;
  const rows = cards.map((c) => ({ ...c, count: tally[c.id] }))
    .sort((a, b) => b.count - a.count || a.order - b.order);
  const max = rows[0]?.count || 0;
  rows.forEach((r) => {
    r.top = max > 0 && r.count === max;
    r.share = voters ? r.count / voters : 0;
    // 1위 득표의 절반 이하를 받은 의견(0표 포함)은 "소수 의견"으로 따로 기록한다
    r.minority = max > 0 && !r.top && r.count <= max * MINORITY_RATIO;
  });
  return { rows, voters, max };
}

function resultView(isHost) {
  const m = session.meeting;
  const { rows, voters, max } = computeResult();
  const minority = rows.filter((r) => r.minority);
  return `
    <section class="card">
      <h2>📊 투표 결과</h2>
      <p class="small muted">투표 ${voters}명 · 1인당 ${m.votesPerStudent}표 · 의견 ${m.opinionCount}개 제출</p>
      ${rows.length === 0 ? `<p class="muted">투표할 의견이 없었어요.</p>` : ""}
      <ul class="chart">
        ${rows.map((r) => `
          <li class="${r.top ? "top" : ""} ${r.minority ? "minor" : ""}">
            <div class="chart-label">${r.top ? "🏆 " : ""}${esc(r.text)}</div>
            <div class="chart-bar">
              <div class="track"><i style="width:${Math.round(r.share * 100)}%"></i></div>
              <span>${r.count}표${voters ? ` · ${Math.round(r.share * 100)}%` : ""}</span>
            </div>
          </li>`).join("")}
      </ul>
      <p class="small muted">%는 투표한 사람 중 그 의견을 고른 비율이에요${m.votesPerStudent > 1 ? " (1인 여러 표라 합이 100%를 넘을 수 있어요)" : ""}.</p>
    </section>

    ${minority.length ? `
    <section class="card minority">
      <h2>🌱 소수 의견</h2>
      <p class="small muted">1위 득표의 절반 이하를 받은 의견이에요. 표는 적었지만 결론을 실행할 때 보완점이 될 수 있어서 함께 기록해요.</p>
      <ul class="cards">
        ${minority.map((r) => `<li class="op"><div class="op-body">${cardHtml(r, { extra: `<div class="small muted">${r.count}표</div>` })}</div></li>`).join("")}
      </ul>
    </section>` : ""}

    ${isHost ? `
    <section class="card">
      <h2>📝 회의 결론</h2>
      <form class="stack" data-action="saveConclusion">
        <textarea name="conclusion" rows="3" maxlength="1000" placeholder="예) 1위 의견으로 결정. 소수 의견(가격 부담)은 반비 지원으로 보완.">${esc(m.conclusion)}</textarea>
        <button class="btn">결론 저장 (학생 화면에도 표시)</button>
      </form>
      <div class="row wrap">
        <button class="btn primary grow" data-action="copyMinutes">회의록 복사</button>
        <a class="btn grow" href="#/">새 회의 만들기</a>
      </div>
    </section>` : `<section class="card conclusion" data-live="conclusion" hidden></section>`}
  `;
}

function minutesText() {
  const m = session.meeting;
  const { rows, voters } = computeResult();
  const date = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const lines = [
    `[학급회의 회의록] ${date}`,
    `안건: ${m.topic}`,
    m.detail ? `설명: ${m.detail}` : null,
    `참여: 의견 ${m.opinionCount}개 제출 · ${voters}명 투표 (1인당 ${m.votesPerStudent}표)`,
    "",
    "■ 투표 결과",
    ...rows.map((r, i) => `${i + 1}. ${r.text} — ${r.count}표${r.items?.length > 1 ? ` (비슷한 의견 ${r.items.length}개)` : ""}`),
  ];
  const minority = rows.filter((r) => r.minority);
  if (minority.length) {
    lines.push("", "■ 소수 의견");
    minority.forEach((r) => {
      lines.push(`- ${r.text}${r.reason ? ` (이유: ${r.reason})` : ""}`);
    });
  }
  if (m.conclusion) lines.push("", "■ 결론", m.conclusion);
  return lines.filter((l) => l !== null).join("\n");
}

/* ───────────── 동작 ───────────── */
const actions = {
  copyLink: () => copyText(joinUrl(session.code)),

  timer: (btn) => act(btn, async () => {
    const min = Number(btn.dataset.min);
    await updateDoc(session.ref, { deadlineAt: min ? Date.now() + min * 60000 : null });
  }),

  closeAndReveal: (btn) => {
    const s = session;
    const m = s.meeting;
    const notYet = m.expected > m.opinionCount ? `\n(참여 인원 ${m.expected}명 중 ${m.expected - m.opinionCount}명은 아직 내지 않았어요)` : "";
    if (m.phase === "collect" &&
      !confirm(`의견 제출을 마감할까요?\n지금까지 낸 의견 ${m.opinionCount}개가 무작위 순서로 한꺼번에 공개돼요.${notYet}`)) return;
    act(btn, async () => {
      if (s.meeting.phase === "collect") await updateDoc(s.ref, { phase: "closed", deadlineAt: null });
      const [ops, existing] = await Promise.all([
        getDocs(collection(s.ref, "opinions")),
        getDocs(collection(s.ref, "cards")),
      ]);
      const batch = writeBatch(db);
      if (existing.empty) {
        // 의견을 섞은 뒤, 작성자(uid) 정보 없이 공개용 카드로 복사한다
        const list = shuffle(ops.docs.map((d) => d.data()));
        list.forEach((o, i) => {
          const item = { text: o.text, reason: o.reason || "" };
          batch.set(doc(collection(s.ref, "cards")), {
            ...item, order: i, hidden: false, mergedInto: null, origin: item, items: [item],
          });
        });
      }
      batch.update(s.ref, { phase: "reveal" });
      await batch.commit();
    });
  },

  toggleSelect: (el) => {
    const sel = session.selected;
    el.checked ? sel.add(el.dataset.id) : sel.delete(el.dataset.id);
    render(true);
  },

  toggleHide: (btn) => act(btn, async () => {
    const c = session.cards.find((x) => x.id === btn.dataset.id);
    session.selected.delete(c.id);
    await updateDoc(doc(session.ref, "cards", c.id), { hidden: !c.hidden });
  }),

  merge: (btn) => {
    const s = session;
    const chosen = s.cards.filter((c) => s.selected.has(c.id)).sort((a, b) => a.order - b.order);
    if (chosen.length < 2) return;
    openMergeDialog(chosen, (text) => act(btn, async () => {
      const [target, ...rest] = chosen;
      const restIds = new Set(rest.map((c) => c.id));
      const batch = writeBatch(db);
      batch.update(doc(s.ref, "cards", target.id), {
        text,
        items: chosen.flatMap((c) => c.items || [c.origin]),
      });
      rest.forEach((c) => batch.update(doc(s.ref, "cards", c.id), { mergedInto: target.id }));
      // 이미 다른 묶음에 들어 있던 카드도 새 대표 카드로 옮긴다
      s.cards.filter((c) => restIds.has(c.mergedInto))
        .forEach((c) => batch.update(doc(s.ref, "cards", c.id), { mergedInto: target.id }));
      s.selected.clear(); // 서버 응답을 기다리지 않고 바로 선택 해제
      render(true);
      await batch.commit();
      toast("의견을 묶었어요");
    }));
  },

  unmerge: (btn) => act(btn, async () => {
    const s = session;
    const target = s.cards.find((c) => c.id === btn.dataset.id);
    const batch = writeBatch(db);
    batch.update(doc(s.ref, "cards", target.id), { text: target.origin.text, items: [target.origin] });
    s.cards.filter((c) => c.mergedInto === target.id)
      .forEach((c) => batch.update(doc(s.ref, "cards", c.id), { mergedInto: null, items: [c.origin], text: c.origin.text }));
    await batch.commit();
  }),

  setVotes: (sel) => act(null, () => updateDoc(session.ref, { votesPerStudent: Number(sel.value) })),

  startVote: (btn) => {
    const n = visibleCards().length;
    if (n === 0) return toast("투표할 의견이 없어요");
    if (!confirm(`의견 ${n}개로 익명 투표를 시작할까요?\n(시작하면 묶기·숨기기를 할 수 없어요)`)) return;
    act(btn, () => updateDoc(session.ref, { phase: "vote" }));
  },

  endVote: (btn) => {
    if (!confirm(`투표를 마감하고 결과를 공개할까요?\n현재 ${session.meeting.voteCount}명이 투표했어요.`)) return;
    act(btn, () => updateDoc(session.ref, { phase: "result" }));
  },

  saveConclusion: (form) => act(form.querySelector("button"), async () => {
    await updateDoc(session.ref, { conclusion: form.conclusion.value.trim() });
    toast("결론을 저장했어요");
  }),

  copyMinutes: () => copyText(minutesText()),

  // 학생
  submitOpinion: (form) => {
    const s = session;
    const text = form.text.value.trim();
    const reason = form.reason.value.trim();
    if (!text) return toast("의견을 적어 주세요");
    act(form.querySelector("button"), async () => {
      const opRef = doc(s.ref, "opinions", user.uid);
      if (s.myOpinion) {
        await updateDoc(opRef, { text, reason, at: serverTimestamp() });
        toast("수정했어요");
      } else {
        const batch = writeBatch(db);
        batch.set(opRef, { text, reason, at: serverTimestamp() });
        batch.update(s.ref, { opinionCount: increment(1) });
        await batch.commit();
        toast("익명으로 제출했어요");
      }
      s.editing = false;
      render(true);
    });
  },

  edit: () => { session.editing = true; render(true); },
  cancelEdit: () => { session.editing = false; render(true); },

  pickVote: (li, e) => {
    if (e.target.closest("details")) return; // "묶인 의견 보기"를 펼칠 때는 선택하지 않음
    const s = session;
    const id = li.dataset.id;
    const max = s.meeting.votesPerStudent;
    if (s.selected.has(id)) s.selected.delete(id);
    else if (max === 1) { s.selected.clear(); s.selected.add(id); }
    else if (s.selected.size >= max) return toast(`${max}개까지 고를 수 있어요`);
    else s.selected.add(id);
    const y = window.scrollY;
    render(true);
    window.scrollTo(0, y);
  },

  submitVote: (btn) => {
    const s = session;
    const valid = new Set(visibleCards().map((c) => c.id));
    const choices = [...s.selected].filter((id) => valid.has(id));
    if (!choices.length) return toast("의견을 골라 주세요");
    if (!confirm(`${choices.length}개 의견에 투표할까요?\n투표 후에는 바꿀 수 없어요.`)) return;
    act(btn, async () => {
      const batch = writeBatch(db);
      batch.set(doc(s.ref, "votes", user.uid), { choices, at: serverTimestamp() });
      batch.update(s.ref, { voteCount: increment(1) });
      await batch.commit();
      s.selected.clear();
      toast("투표했어요");
    });
  },
};

function openMergeDialog(chosen, onOk) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog";
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h3>의견 ${chosen.length}개 묶기</h3>
      <p class="small muted">투표 화면에 보일 대표 문장을 정하세요. 원래 의견들은 묶음 안에 그대로 남아요.</p>
      <div class="chips">${chosen.map((c, i) => `<button type="button" class="chip" data-i="${i}">${esc(c.text)}</button>`).join("")}</div>
      <textarea name="text" rows="3" maxlength="300" required>${esc(chosen[0].text)}</textarea>
      <div class="row">
        <button value="cancel" class="btn grow" formnovalidate>취소</button>
        <button value="ok" class="btn primary grow">묶기</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const ta = dlg.querySelector("textarea");
  dlg.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { ta.value = chosen[b.dataset.i].text; }));
  dlg.addEventListener("close", () => {
    const text = ta.value.trim();
    if (dlg.returnValue === "ok" && text) onOk(text);
    dlg.remove();
  });
  dlg.showModal();
}

/* ───────────── 시작 ───────────── */
function renderSetupNeeded() {
  $app.innerHTML = `
    <section class="card">
      <h2>⚙️ Firebase 설정이 필요해요</h2>
      <p><code>public/firebase-config.js</code> 파일에 내 Firebase 프로젝트 설정값을 붙여 넣어 주세요.
      자세한 방법은 README.md에 있어요.</p>
      <p class="small muted">설정 없이 내 컴퓨터에서 시험해 보려면 Firebase 에뮬레이터를 켜고
      주소 끝에 <code>?emulator</code>를 붙여 접속하세요.</p>
    </section>`;
}

async function start() {
  if (configMissing && !useEmulator) return renderSetupNeeded();
  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  if (useEmulator) {
    connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, location.hostname, 8080);
  }
  user = await new Promise((resolve, reject) => {
    const off = onAuthStateChanged(auth, async (u) => {
      if (u) { off(); resolve(u); return; }
      try { await signInAnonymously(auth); } catch (e) { off(); reject(e); }
    });
  }).catch((e) => {
    $app.innerHTML = `<section class="card"><h2>접속하지 못했어요</h2>
      <p class="muted">Firebase 콘솔에서 <b>Authentication → 익명(Anonymous)</b> 로그인을 켰는지 확인해 주세요.</p>
      <p class="small muted">${esc(e.code || e.message)}</p></section>`;
    return null;
  });
  if (!user) return;
  window.addEventListener("hashchange", route);
  route();
}

start();
