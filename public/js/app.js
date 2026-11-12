// 화면을 그리고 버튼을 처리하는 파일입니다.
// 서버와 주고받는 일은 db.js 에 있습니다.

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

const APP_NAME = '소곤소곤 학급회의';
const PHASES = ['collect', 'review', 'vote', 'result'];
const PHASE_LABELS = ['의견 쓰기', '한꺼번에 공개', '투표', '결과'];

let DB = null; // db.js 모듈
let MODE = null; // 'live' | 'emulator' | 'unconfigured'
let UID = null; // 내 익명 uid
let M = null; // 지금 들어와 있는 회의의 상태

// ═════════════════════════════════════════════════════════════════════════
// 작은 도구들
// ═════════════════════════════════════════════════════════════════════════

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 저장 공간을 못 쓰는 브라우저에서는 그냥 넘어갑니다 */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 무시 */
    }
  },
};

const draftKey = (code) => `sogon:draft:${code}`;
const hostJoinKey = (code) => `sogon:hostjoin:${code}`;

function rememberMeeting(code, topic, isHost) {
  let list = [];
  try {
    list = JSON.parse(store.get('sogon:recent') || '[]');
  } catch {
    list = [];
  }
  list = list.filter((item) => item.code !== code);
  list.unshift({ code, topic, isHost, at: Date.now() });
  store.set('sogon:recent', JSON.stringify(list.slice(0, 4)));
}

function recentMeetings() {
  try {
    const list = JSON.parse(store.get('sogon:recent') || '[]');
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return list.filter((item) => item.at > dayAgo);
  } catch {
    return [];
  }
}

function prettyCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}${location.search}#/m/${code}`;
}

let toastTimer = null;
function toast(message) {
  $toast.textContent = message;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 주소(연습 모드)에서는 위 방법이 막혀 있어서 옛 방식으로 한 번 더 시도합니다.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// 사람마다 다른(하지만 그 사람에게는 항상 같은) 순서로 섞기 위한 도구
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle(list, seedText) {
  let a = hashString(seedText);
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function errorMessage(err) {
  const code = err && err.code ? String(err.code) : '';
  if (code === 'permission-denied') return '지금은 할 수 없는 동작이에요. 화면을 새로고침해 보세요.';
  if (code === 'unavailable' || code === 'auth/network-request-failed')
    return '인터넷 연결을 확인해 주세요.';
  return '문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
}

// ═════════════════════════════════════════════════════════════════════════
// 확인 창
// ═════════════════════════════════════════════════════════════════════════

function closeModal() {
  $modal.innerHTML = '';
  $modal.classList.remove('open');
  document.body.classList.remove('modal-open');
}

/** 확인 창을 띄우고, 확인이면 true(입력란이 있으면 입력한 글), 취소면 false 를 돌려줍니다. */
function ask({ title, message = '', bodyHtml = '', ok = '확인', cancel = '취소', input = null }) {
  return new Promise((resolve) => {
    $modal.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        ${message ? `<p class="sheet-msg">${esc(message)}</p>` : ''}
        ${bodyHtml}
        ${
          input
            ? `<label class="field-label" for="ask-input">${esc(input.label)}</label>
               <textarea id="ask-input" class="input" rows="3" maxlength="${input.max}">${esc(input.value)}</textarea>`
            : ''
        }
        <div class="sheet-actions">
          ${cancel ? `<button type="button" class="btn ghost" data-modal="cancel">${esc(cancel)}</button>` : ''}
          <button type="button" class="btn primary" data-modal="ok">${esc(ok)}</button>
        </div>
      </div>`;
    $modal.classList.add('open');
    document.body.classList.add('modal-open');
    const finish = (value) => {
      $modal.onclick = null;
      closeModal();
      resolve(value);
    };
    $modal.onclick = (event) => {
      const button = event.target.closest('[data-modal]');
      if (button) {
        if (button.dataset.modal === 'cancel') return finish(false);
        if (input) {
          const value = document.getElementById('ask-input').value.trim();
          if (!value) return toast('내용을 적어 주세요.');
          return finish(value);
        }
        return finish(true);
      }
      if (event.target === $modal && cancel) finish(false);
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════
// 시작
// ═════════════════════════════════════════════════════════════════════════

const LOGO = `
  <svg class="logo" viewBox="0 0 64 64" aria-hidden="true">
    <rect x="6" y="10" width="38" height="28" rx="10" fill="#fff"/>
    <path d="M16 36v9l10-9z" fill="#fff"/>
    <rect x="24" y="26" width="34" height="24" rx="9" fill="#FFCB47"/>
    <path d="M48 48v8l-9-8z" fill="#FFCB47"/>
    <circle cx="18" cy="24" r="2.6" fill="#1F6F5C"/>
    <circle cx="26" cy="24" r="2.6" fill="#1F6F5C"/>
    <circle cx="34" cy="24" r="2.6" fill="#1F6F5C"/>
  </svg>`;

function screenMessage({ title, bodyHtml, actionsHtml = '' }) {
  $app.innerHTML = `
    <main class="page center">
      <section class="card notice">
        <h1>${esc(title)}</h1>
        ${bodyHtml}
        ${actionsHtml}
      </section>
    </main>`;
}

function showSetupGuide() {
  screenMessage({
    title: '아직 Firebase 설정이 비어 있어요',
    bodyHtml: `
      <p>이 앱은 Firebase 에 연결해야 동작해요. 앱을 올린 사람이 아래 순서대로 한 번만 설정하면 돼요.</p>
      <ol class="steps-list">
        <li>Firebase 콘솔에서 프로젝트를 만들고 <b>익명 로그인</b>과 <b>Firestore</b>를 켭니다.</li>
        <li>웹 앱을 등록하고 나오는 <b>firebaseConfig</b> 값을 복사합니다.</li>
        <li><code>public/firebase-config.js</code> 파일의 <code>여기에_붙여넣기</code> 자리에 붙여 넣습니다.</li>
        <li><code>npm run deploy</code> 로 다시 배포합니다.</li>
      </ol>
      <p class="muted">자세한 방법은 함께 들어 있는 <b>README.md</b> 의 "실제로 배포하기"에 있어요.
      설정 없이 먼저 써 보고 싶다면 내 컴퓨터에서 <code>npm run dev</code> 로 연습 모드를 켜 보세요.</p>`,
  });
}

function showStartError(err) {
  const code = err && err.code ? String(err.code) : '';
  let hint = '인터넷 연결을 확인한 뒤 새로고침해 주세요.';
  if (MODE === 'emulator') {
    hint =
      '연습 모드 서버(에뮬레이터)에 연결하지 못했어요. 컴퓨터에서 <code>npm run dev</code> 가 켜져 있는지 확인해 주세요.';
  } else if (
    code === 'auth/configuration-not-found' ||
    code === 'auth/admin-restricted-operation' ||
    code === 'auth/operation-not-allowed'
  ) {
    hint =
      'Firebase 콘솔 → Authentication → 로그인 방법에서 <b>익명</b> 로그인을 켰는지 확인해 주세요.';
  } else if (code.startsWith('auth/api-key') || code === 'auth/invalid-api-key') {
    hint = '<code>public/firebase-config.js</code> 에 붙여 넣은 값이 맞는지 확인해 주세요.';
  }
  screenMessage({
    title: '연결하지 못했어요',
    bodyHtml: `<p>${hint}</p>${code ? `<p class="muted">오류 코드: ${esc(code)}</p>` : ''}`,
    actionsHtml: `<button type="button" class="btn primary block" data-act="reload">새로고침</button>`,
  });
}

async function boot() {
  try {
    DB = await import('./db.js');
  } catch (err) {
    console.error(err);
    screenMessage({
      title: '앱을 불러오지 못했어요',
      bodyHtml: '<p>인터넷 연결을 확인한 뒤 새로고침해 주세요.</p>',
      actionsHtml: `<button type="button" class="btn primary block" data-act="reload">새로고침</button>`,
    });
    return;
  }
  MODE = DB.detectMode();
  if (MODE === 'unconfigured') {
    showSetupGuide();
    return;
  }
  try {
    UID = await DB.start(MODE);
  } catch (err) {
    console.error(err);
    showStartError(err);
    return;
  }
  document.body.classList.toggle('practice', MODE === 'emulator');
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  closeModal();
  $toast.classList.remove('show');
  leaveMeeting();
  const match = location.hash.match(/^#\/m\/(\d{6})$/);
  if (match) enterMeeting(match[1]);
  else renderHome();
  window.scrollTo(0, 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 첫 화면
// ═════════════════════════════════════════════════════════════════════════

function renderHome() {
  document.title = APP_NAME;
  const recent = recentMeetings();
  $app.innerHTML = `
    <main class="page home">
      <header class="hero">
        ${LOGO}
        <h1>${APP_NAME}</h1>
        <p>먼저 조용히 쓰고, 한꺼번에 열어 보고,<br>공정하게 정해요.</p>
      </header>

      <section class="card">
        <h2>회의에 참여하기</h2>
        <form data-form="join" class="stack" novalidate>
          <label class="field-label" for="join-code">선생님·반장이 알려 준 참여 코드</label>
          <input id="join-code" class="input code-input" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="off" maxlength="6" placeholder="숫자 6자리">
          <button type="submit" class="btn primary block">입장하기</button>
        </form>
        <p class="hint">이름도 로그인도 필요 없어요. 누가 무엇을 썼는지 아무도 알 수 없어요.</p>
      </section>

      ${
        recent.length
          ? `<section class="card">
               <h2>방금 참여한 회의</h2>
               <ul class="recent">
                 ${recent
                   .map(
                     (item) => `
                   <li><a href="#/m/${esc(item.code)}">
                     <span class="recent-topic">${esc(item.topic)}</span>
                     <span class="recent-meta">${item.isHost ? '사회자 · ' : ''}${prettyCode(esc(item.code))}</span>
                   </a></li>`,
                   )
                   .join('')}
               </ul>
             </section>`
          : ''
      }

      <details class="card create" ${store.get('sogon:topic') ? 'open' : ''}>
        <summary><span>새 회의 만들기</span><small>사회자(선생님·반장)용</small></summary>
        <form data-form="create" class="stack" novalidate>
          <label class="field-label" for="topic">오늘의 안건</label>
          <textarea id="topic" class="input" rows="3" maxlength="120"
                    placeholder="예) 체육대회 반티를 어떤 것으로 할까요?"></textarea>
          <span class="field-label">한 사람이 투표할 수 있는 표 수</span>
          <div class="segmented" role="radiogroup" aria-label="1인당 표 수">
            ${[1, 2, 3]
              .map(
                (n) => `
              <label><input type="radio" name="votes" value="${n}" ${n === 1 ? 'checked' : ''}><span>${n}표</span></label>`,
              )
              .join('')}
          </div>
          <label class="check">
            <input type="checkbox" id="host-join">
            <span>나도 의견을 내고 투표할래요 <small>(반장이 사회를 볼 때)</small></span>
          </label>
          <button type="submit" class="btn primary block">회의 만들고 참여 코드 받기</button>
        </form>
      </details>

      <section class="how">
        <h2>이렇게 진행돼요</h2>
        <ol>
          <li><b>먼저 쓰기</b><span>다른 사람 의견을 보기 전에 각자 익명으로 의견을 적어요.</span></li>
          <li><b>한꺼번에 공개</b><span>마감하면 모든 의견이 무작위 순서로 동시에 열려요.</span></li>
          <li><b>비밀 투표</b><span>투표가 끝날 때까지 중간 결과는 아무도 볼 수 없어요.</span></li>
          <li><b>결과 보기</b><span>득표 그래프와 함께 소수 의견도 놓치지 않고 살펴봐요.</span></li>
        </ol>
      </section>
    </main>`;
  const topic = document.getElementById('topic');
  topic.value = store.get('sogon:topic') || '';
}

async function submitJoinForm(form) {
  const input = form.querySelector('#join-code');
  const code = input.value.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('참여 코드는 숫자 6자리예요.');
    input.focus();
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    if (await DB.meetingExists(code)) {
      location.hash = `#/m/${code}`;
    } else {
      toast('그런 코드의 회의가 없어요. 다시 확인해 주세요.');
      button.disabled = false;
    }
  } catch (err) {
    console.error(err);
    toast(errorMessage(err));
    button.disabled = false;
  }
}

async function submitCreateForm(form) {
  const topic = form.querySelector('#topic').value.trim();
  if (!topic) {
    toast('안건을 적어 주세요.');
    form.querySelector('#topic').focus();
    return;
  }
  const votesPerPerson = Number(form.querySelector('input[name=votes]:checked').value);
  const hostJoins = form.querySelector('#host-join').checked;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const code = await DB.createMeeting({ topic, votesPerPerson });
    if (hostJoins) store.set(hostJoinKey(code), '1');
    store.remove('sogon:topic');
    location.hash = `#/m/${code}`;
  } catch (err) {
    console.error(err);
    toast(errorMessage(err));
    button.disabled = false;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 회의 화면: 상태와 구독
// ═════════════════════════════════════════════════════════════════════════

function enterMeeting(code) {
  M = {
    code,
    meeting: undefined, // undefined = 불러오는 중, null = 없는 회의
    members: [],
    role: 'pending', // pending | joined | spectator | hostOnly
    secret: null,
    myOpinion: undefined,
    myVote: undefined,
    cards: null,
    votes: null,
    editing: false,
    pick: new Set(), // 투표에서 고른 카드
    mergeSel: new Set(), // 사회자가 묶으려고 고른 카드
    votesChoice: null, // 사회자가 투표 시작 전에 고른 표 수
    pendingWrite: false,
    lastLocked: null,
    revealing: false,
    revealFailed: false,
    joining: false,
    busy: false,
    html: {},
    retries: {},
    unsub: {},
    ticker: null,
  };
  $app.innerHTML = `
    <div class="meeting">
      <header class="topbar">
        <a class="brand" href="#/" aria-label="첫 화면으로">${LOGO}<span>${APP_NAME}</span></a>
        <span class="code-chip" title="참여 코드">코드 ${prettyCode(code)}</span>
      </header>
      <div id="r-steps"></div>
      <main class="page">
        <div id="r-topic"></div>
        <div id="r-host"></div>
        <div id="r-body"><div class="loading"><span class="spinner"></span>회의를 불러오는 중…</div></div>
      </main>
      <div id="r-foot"></div>
    </div>`;

  const session = M;
  const onError = (err) => {
    if (M !== session) return;
    console.warn(err);
    if (err && err.code !== 'permission-denied') toast(errorMessage(err));
  };
  M.onError = onError;
  M.unsub.meeting = DB.watchMeeting(
    code,
    (data, pending) => {
      if (M !== session) return;
      M.meeting = data;
      M.pendingWrite = pending;
      onMeetingChange();
    },
    (err) => {
      onError(err);
      if (M === session && M.meeting === undefined) {
        M.meeting = null;
        render();
      }
    },
  );
  M.unsub.members = DB.watchMembers(
    code,
    (list) => {
      if (M !== session) return;
      M.members = list;
      patchLive();
    },
    onError,
  );
  M.ticker = setInterval(patchLive, 500);
}

function leaveMeeting() {
  if (!M) return;
  Object.values(M.unsub).forEach((stop) => stop && stop());
  clearInterval(M.ticker);
  M = null;
}

const isHost = () => !!(M && M.meeting && M.meeting.hostUid === UID);

/**
 * 필요한 구독만 켜고, 필요 없어진 구독은 끕니다.
 * 사회자가 방금 단계를 바꿨다면 서버에 반영된 뒤에 켭니다(그 전에는 규칙이 거부합니다).
 * 혹시 거부되더라도 잠시 뒤 몇 번 더 시도합니다.
 */
function watch(name, wanted, startFn) {
  if (wanted && !M.unsub[name] && !M.pendingWrite) {
    const session = M;
    M.unsub[name] = startFn((err) => {
      if (M !== session) return;
      console.warn(name, err);
      M.unsub[name] = null;
      M.retries[name] = (M.retries[name] || 0) + 1;
      if (M.retries[name] <= 4) setTimeout(() => M === session && onMeetingChange(), 1200);
      else toast(errorMessage(err));
    });
  }
  if (!wanted && M.unsub[name]) {
    M.unsub[name]();
    M.unsub[name] = null;
  }
}

function onMeetingChange() {
  const session = M;
  const meeting = M.meeting;
  if (!meeting) {
    render();
    return;
  }
  document.title = `${meeting.topic} · ${APP_NAME}`;
  if (M.votesChoice === null) M.votesChoice = meeting.votesPerPerson;
  // 입장이 잠겨서 못 들어왔다면, 잠금이 풀리는 순간 다시 입장을 시도합니다.
  const justUnlocked = M.lastLocked === true && !meeting.locked;
  M.lastLocked = meeting.locked;
  if (M.role === 'pending' || (M.role === 'spectator' && justUnlocked)) decideRole();

  const phase = meeting.phase;
  const joined = M.role === 'joined';
  const guard = (fn) => (value) => {
    if (M !== session) return;
    fn(value);
    render();
  };

  watch('myOpinion', joined && phase === 'collect', (onError) =>
    DB.watchMyOpinion(
      M.code,
      M.secret.opKey,
      guard((opinion) => {
        const first = M.myOpinion === undefined;
        M.myOpinion = opinion;
        // 고치다가 화면이 새로고침된 경우: 저장해 둔 글이 있으면 이어서 고칩니다.
        const draft = store.get(draftKey(M.code));
        if (first && opinion && draft && draft.trim() && draft !== opinion.text) M.editing = true;
      }),
      onError,
    ),
  );
  watch('myVote', joined && (phase === 'vote' || phase === 'result'), (onError) =>
    DB.watchMyVote(
      M.code,
      M.secret.voteKey,
      guard((vote) => {
        M.myVote = vote;
      }),
      onError,
    ),
  );
  watch('cards', phase !== 'collect', (onError) =>
    DB.watchCards(
      M.code,
      guard((cards) => {
        M.cards = cards;
        const ids = new Set(cards.map((c) => c.id));
        for (const id of [...M.mergeSel]) if (!ids.has(id)) M.mergeSel.delete(id);
      }),
      onError,
    ),
  );
  watch('votes', phase === 'result', (onError) =>
    DB.watchVotes(
      M.code,
      guard((votes) => {
        M.votes = votes;
      }),
      onError,
    ),
  );

  // 사회자 기기: 마감 직후 의견을 섞어서 한꺼번에 공개합니다.
  // (마감이 서버에 반영된 뒤에만 의견을 읽을 수 있으므로 반영을 기다립니다.)
  if (isHost() && phase === 'review' && !meeting.revealed && !M.pendingWrite) runReveal();

  render();
}

/** 내가 참여자인지, 구경만 하는지, 사회자 전용인지 정합니다. */
async function decideRole() {
  if (M.joining) return;
  const session = M;
  M.joining = true;
  try {
    let secret = await DB.getMySecret(M.code);
    if (M !== session) return;
    if (!secret) {
      const hostWantsIn = store.get(hostJoinKey(M.code)) === '1';
      if (isHost() && !hostWantsIn) {
        M.role = 'hostOnly';
      } else {
        secret = await DB.join(M.code);
        if (M !== session) return;
      }
    }
    if (secret) {
      M.secret = secret;
      M.role = 'joined';
    }
  } catch (err) {
    if (M !== session) return;
    if (err && err.code === 'permission-denied') {
      M.role = isHost() ? 'hostOnly' : 'spectator';
    } else {
      console.error(err);
      toast(errorMessage(err));
      M.role = isHost() ? 'hostOnly' : 'spectator';
    }
  } finally {
    if (M === session) M.joining = false;
  }
  if (M !== session) return;
  rememberMeeting(M.code, M.meeting.topic, isHost());
  onMeetingChange();
}

async function runReveal() {
  if (M.revealing) return;
  const session = M;
  M.revealing = true;
  M.revealFailed = false;
  try {
    await DB.revealOpinions(M.code);
  } catch (err) {
    console.error(err);
    if (M === session) M.revealFailed = true;
  } finally {
    if (M === session) {
      M.revealing = false;
      render();
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 회의 화면: 그리기
//
// 화면을 구역(steps, topic, host, body, foot)으로 나누고, 구역의 HTML 이
// 실제로 달라졌을 때만 다시 그립니다. 인원 수·타이머처럼 자주 바뀌는 값은
// HTML 에 넣지 않고 patchLive() 가 글자만 바꿉니다.
// → 글을 쓰는 도중에 입력란이 지워지는 일이 없습니다.
// ═════════════════════════════════════════════════════════════════════════

function setRegion(name, html) {
  if (M.html[name] === html) return false;
  const el = document.getElementById(`r-${name}`);
  if (!el) return false;
  const open = [...el.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k);
  el.innerHTML = html;
  M.html[name] = html;
  open.forEach((k) => {
    const d = el.querySelector(`details[data-k="${CSS.escape(k)}"]`);
    if (d) d.open = true;
  });
  return true;
}

function render() {
  if (!M) return;
  const meeting = M.meeting;
  if (meeting === undefined) return;
  if (meeting === null) {
    setRegion('steps', '');
    setRegion('topic', '');
    setRegion('host', '');
    setRegion('foot', '');
    setRegion(
      'body',
      `<section class="card notice">
         <h1>회의를 찾을 수 없어요</h1>
         <p>참여 코드 <b>${prettyCode(M.code)}</b> 를 다시 확인해 주세요.</p>
         <a class="btn primary block" href="#/">첫 화면으로</a>
       </section>`,
    );
    return;
  }
  setRegion('steps', stepsHtml());
  setRegion('topic', topicHtml());
  setRegion('host', isHost() ? hostHtml() : '');
  if (setRegion('body', bodyHtml())) afterBodyRender();
  setRegion('foot', footHtml());
  patchLive();
}

function stepsHtml() {
  const current = PHASES.indexOf(M.meeting.phase);
  return `
    <ol class="stepper" aria-label="회의 진행 단계">
      ${PHASE_LABELS.map(
        (label, i) => `
        <li class="${i < current ? 'done' : ''} ${i === current ? 'now' : ''}" ${i === current ? 'aria-current="step"' : ''}>
          <span class="dot">${i < current ? '✓' : i + 1}</span><span class="step-label">${label}</span>
        </li>`,
      ).join('')}
    </ol>`;
}

function topicHtml() {
  const meeting = M.meeting;
  const timer = meeting.timerEndsAt && (meeting.phase === 'collect' || meeting.phase === 'vote');
  return `
    <section class="topic">
      <span class="eyebrow">오늘의 안건</span>
      <h1>${esc(meeting.topic)}</h1>
      <div class="chips">
        <span class="chip">참여 <b data-live="joined">0</b>명</span>
        ${meeting.phase === 'vote' || meeting.phase === 'review' ? `<span class="chip">1인당 ${meeting.phase === 'review' && isHost() ? M.votesChoice : meeting.votesPerPerson}표</span>` : ''}
        ${timer ? `<span class="chip timer" data-timer><span data-live="timer"></span></span>` : ''}
      </div>
    </section>`;
}

function timerText() {
  const end = M.meeting && M.meeting.timerEndsAt;
  if (!end) return { text: '', over: false };
  const left = Math.ceil((end.toMillis() - Date.now()) / 1000);
  if (left <= 0) return { text: '시간이 다 됐어요', over: true };
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  return { text: `남은 시간 ${m}:${s}`, over: false };
}

/** 자주 바뀌는 숫자·타이머만 골라서 바꿉니다. */
function patchLive() {
  if (!M || !M.meeting) return;
  const joined = M.members.length;
  const submitted = M.members.filter((m) => m.submitted).length;
  const voted = M.members.filter((m) => m.voted).length;
  const timer = timerText();
  const values = { joined, submitted, voted, timer: timer.text };
  $app.querySelectorAll('[data-live]').forEach((el) => {
    const value = String(values[el.dataset.live] ?? '');
    if (el.textContent !== value) el.textContent = value;
  });
  $app.querySelectorAll('[data-bar]').forEach((el) => {
    const part = values[el.dataset.bar] || 0;
    const width = joined ? `${Math.min(100, Math.round((part / joined) * 100))}%` : '0%';
    if (el.style.width !== width) el.style.width = width;
  });
  $app.querySelectorAll('[data-timer]').forEach((el) => el.classList.toggle('over', timer.over));
}

// ── 카드 한 장 ──────────────────────────────────────────────────────────

function cardHtml(card, no, { act = '', selected = false, tools = false } = {}) {
  const merged = card.texts.length > 1;
  return `
    <li class="opinion ${act ? 'selectable' : ''} ${selected ? 'selected' : ''}"
        ${act ? `data-act="${act}" data-id="${esc(card.id)}" role="checkbox" aria-checked="${selected}" tabindex="0"` : ''}>
      <span class="no">${no}</span>
      <div class="opinion-main">
        <p class="opinion-text">${esc(card.label)}</p>
        ${
          merged
            ? `<details class="bundle" data-k="b-${esc(card.id)}">
                 <summary>비슷한 의견 ${card.texts.length}개를 묶었어요</summary>
                 <ul>${card.texts.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
               </details>`
            : ''
        }
        ${
          tools
            ? `<div class="card-tools">
                 ${merged ? `<button type="button" class="link-btn" data-act="unmerge" data-id="${esc(card.id)}">묶음 풀기</button>` : ''}
                 <button type="button" class="link-btn danger" data-act="hide" data-id="${esc(card.id)}">가리기</button>
               </div>`
            : ''
        }
      </div>
      ${act ? `<span class="tick" aria-hidden="true"></span>` : ''}
    </li>`;
}

const visibleCards = () => (M.cards || []).filter((c) => !c.hidden);
const hiddenCount = () => (M.cards || []).filter((c) => c.hidden).length;
const cardNumber = (card) => visibleCards().findIndex((c) => c.id === card.id) + 1;

function hiddenNoteHtml() {
  const n = hiddenCount();
  return n ? `<p class="hint center">사회자가 부적절하다고 판단해 가린 의견 ${n}개는 표시하지 않아요.</p>` : '';
}

const loadingHtml = (text) => `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;

// ── 본문 ────────────────────────────────────────────────────────────────

function bodyHtml() {
  const phase = M.meeting.phase;
  if (M.role === 'pending') return loadingHtml('입장하는 중…');
  if (phase === 'collect') return collectHtml();
  if (phase === 'review') return reviewHtml();
  if (phase === 'vote') return voteHtml();
  return resultHtml();
}

function collectHtml() {
  if (M.role === 'spectator') {
    return `
      <section class="card notice">
        <h2>지금은 입장이 잠겨 있어요</h2>
        <p>사회자에게 입장을 열어 달라고 말해 주세요. 열리면 이 화면이 자동으로 바뀌어요.</p>
      </section>`;
  }
  if (M.role === 'hostOnly') {
    return `
      <section class="card quiet">
        <h2>지금은 각자 조용히 쓰는 시간</h2>
        <p>학생들이 다른 사람의 의견을 보지 않고 자기 생각을 먼저 적고 있어요.
        제출 인원이 충분히 모이면 위의 <b>마감</b> 버튼을 눌러 주세요.</p>
      </section>`;
  }
  if (M.myOpinion === undefined) return loadingHtml('불러오는 중…');

  if (M.myOpinion && !M.editing) {
    return `
      <section class="card done">
        <div class="done-badge">제출 완료</div>
        <h2>의견이 익명으로 제출됐어요</h2>
        <p>마감되면 모든 의견이 무작위 순서로 한꺼번에 공개돼요.<br>
        지금까지 <b data-live="submitted">0</b>명이 제출했어요.</p>
        <details class="mine" data-k="mine">
          <summary>내가 쓴 의견 보기</summary>
          <p class="mine-text">${esc(M.myOpinion.text)}</p>
        </details>
        <button type="button" class="btn ghost block" data-act="edit-opinion">마감 전까지 고칠 수 있어요 · 수정하기</button>
      </section>`;
  }

  return `
    <section class="card">
      <h2>${M.myOpinion ? '의견 고치기' : '내 의견 쓰기'}</h2>
      <p class="privacy-note">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>
        <span>마감 전에는 <b>친구들도, 사회자도</b> 내 의견을 볼 수 없어요. 이름도 남지 않아요.</span>
      </p>
      <form data-form="opinion" class="stack" novalidate>
        <label class="field-label" for="opinion">남의 눈치 보지 말고 내 생각을 적어 주세요</label>
        <textarea id="opinion" class="input" rows="5" maxlength="${DB.MAX_OPINION_LENGTH}"
                  placeholder="의견과 이유를 함께 적으면 더 좋아요."></textarea>
        <div class="form-row">
          <span class="saved-note">쓰는 중인 글은 이 기기에 자동 저장돼요</span>
          <span class="counter"><span id="opinion-count">0</span>/${DB.MAX_OPINION_LENGTH}</span>
        </div>
        <button type="submit" class="btn primary block">${M.myOpinion ? '고친 의견 제출' : '익명으로 제출'}</button>
        ${M.myOpinion ? `<button type="button" class="btn ghost block" data-act="cancel-edit">고치지 않기</button>` : ''}
      </form>
    </section>`;
}

/** 본문을 새로 그린 직후: 입력란에 저장해 둔 글을 되살립니다. */
function afterBodyRender() {
  const area = document.getElementById('opinion');
  if (!area) return;
  const draft = store.get(draftKey(M.code));
  area.value = draft !== null ? draft : M.myOpinion ? M.myOpinion.text : '';
  updateOpinionCounter();
}

function updateOpinionCounter() {
  const area = document.getElementById('opinion');
  const count = document.getElementById('opinion-count');
  if (area && count) count.textContent = String(area.value.length);
}

function reviewHtml() {
  const host = isHost();
  if (!M.meeting.revealed || M.cards === null) {
    if (host && M.revealFailed) {
      return `
        <section class="card notice">
          <h2>공개하다가 멈췄어요</h2>
          <p>인터넷 연결을 확인한 뒤 다시 시도해 주세요. 의견은 안전하게 보관돼 있어요.</p>
          <button type="button" class="btn primary block" data-act="retry-reveal">다시 공개하기</button>
        </section>`;
    }
    return loadingHtml('의견을 섞어서 한꺼번에 공개하는 중…');
  }
  const cards = visibleCards();
  const intro = host
    ? `<p class="lead">비슷한 의견을 <b>눌러서 고른 뒤</b> 아래 <b>묶기</b> 버튼으로 합쳐 주세요. 정리가 끝나면 투표를 시작하세요.</p>`
    : `<p class="lead">모든 의견이 <b>무작위 순서</b>로 한꺼번에 공개됐어요. 누가 썼는지는 아무도 몰라요.
       사회자가 비슷한 의견을 묶고 나면 투표가 시작돼요.</p>`;
  if (!cards.length) {
    return `${intro}<section class="card notice"><h2>공개할 의견이 없어요</h2><p>제출된 의견이 없거나 모두 가려졌어요.</p></section>${hiddenNoteHtml()}`;
  }
  return `
    ${intro}
    <h2 class="list-title">공개된 의견 <b>${cards.length}</b>개</h2>
    <ol class="opinions">
      ${cards
        .map((card, i) =>
          cardHtml(card, i + 1, {
            act: host ? 'toggle-merge' : '',
            selected: M.mergeSel.has(card.id),
            tools: host,
          }),
        )
        .join('')}
    </ol>
    ${hiddenNoteHtml()}`;
}

function voteHtml() {
  if (M.cards === null) return loadingHtml('불러오는 중…');
  const max = M.meeting.votesPerPerson;
  const cards = visibleCards();

  if (M.role !== 'joined') {
    const why =
      M.role === 'spectator'
        ? '입장이 잠긴 뒤에 들어와서 이번 투표에는 참여할 수 없어요.'
        : '사회자 화면이에요. 학생들이 비밀 투표를 하고 있어요.';
    return `
      <p class="lead">${why} 결과는 투표가 마감되면 한꺼번에 공개돼요.</p>
      <ol class="opinions">${cards.map((card, i) => cardHtml(card, i + 1)).join('')}</ol>
      ${hiddenNoteHtml()}`;
  }
  if (M.myVote === undefined) return loadingHtml('불러오는 중…');

  if (M.myVote) {
    const mine = cards.filter((c) => M.myVote.choices.includes(c.id));
    return `
      <section class="card done">
        <div class="done-badge">투표 완료</div>
        <h2>소중한 한 표가 접수됐어요</h2>
        <p>결과는 사회자가 투표를 마감하면 한꺼번에 공개돼요.<br>
        지금까지 <b data-live="voted">0</b>명이 투표했어요.</p>
        <details class="mine" data-k="myvote">
          <summary>내가 고른 의견 보기</summary>
          <ul class="mine-list">${mine.map((c) => `<li>${esc(c.label)}</li>`).join('')}</ul>
        </details>
      </section>`;
  }

  // 사람마다 보이는 순서를 다르게 섞어서, 위쪽에 있는 의견이 유리해지지 않게 합니다.
  const ordered = seededShuffle(cards, `${UID}:${M.code}`);
  return `
    <p class="lead">가장 좋다고 생각하는 의견을 <b>${max === 1 ? '1개' : `최대 ${max}개`}</b> 골라 주세요.
    보이는 순서는 사람마다 다르게 섞여 있고, 중간 결과는 아무도 볼 수 없어요.</p>
    <ol class="opinions">
      ${ordered
        .map((card) =>
          cardHtml(card, cardNumber(card), { act: 'toggle-pick', selected: M.pick.has(card.id) }),
        )
        .join('')}
    </ol>
    ${hiddenNoteHtml()}`;
}

// ── 결과 ────────────────────────────────────────────────────────────────

function tally() {
  const cards = visibleCards();
  const counts = new Map(cards.map((c) => [c.id, 0]));
  let total = 0;
  for (const vote of M.votes) {
    for (const id of vote.choices || []) {
      if (counts.has(id)) {
        counts.set(id, counts.get(id) + 1);
        total += 1;
      }
    }
  }
  const rows = cards
    .map((card, i) => ({ card, no: i + 1, votes: counts.get(card.id) }))
    .sort((a, b) => b.votes - a.votes || a.no - b.no);
  const max = rows.length ? rows[0].votes : 0;
  let rank = 0;
  let prev = null;
  rows.forEach((row, i) => {
    if (row.votes !== prev) rank = i + 1;
    prev = row.votes;
    row.rank = rank;
    row.winner = max > 0 && row.votes === max;
    // 소수 의견: 1위 득표의 절반 이하를 받은 의견 (0표 포함)
    row.minority = !row.winner && row.votes * 2 <= max;
  });
  return { rows, total, max, ballots: M.votes.length, winners: rows.filter((r) => r.winner) };
}

function resultHtml() {
  if (M.cards === null || M.votes === null) return loadingHtml('결과를 집계하는 중…');
  const t = tally();
  const joined = M.members.length;
  if (!t.rows.length) {
    return `<section class="card notice"><h2>집계할 의견이 없어요</h2></section>`;
  }
  const headline = !t.max
    ? '투표한 사람이 없어요'
    : t.winners.length > 1
      ? `공동 1위가 ${t.winners.length}개예요`
      : '가장 많은 표를 받은 의견';
  const minority = t.rows.filter((r) => r.minority);
  return `
    <section class="card result-top">
      <span class="eyebrow">${headline}</span>
      ${
        t.max
          ? t.winners
              .map(
                (r) => `<p class="winner-text">${esc(r.card.label)}</p>
                        <p class="winner-meta">${r.votes}표 · 전체 ${t.total}표 중 ${Math.round((r.votes / t.total) * 100)}%</p>`,
              )
              .join('')
          : '<p class="muted">표가 없어서 순위를 정할 수 없어요.</p>'
      }
      ${t.winners.length > 1 ? `<p class="hint">표가 같아요. 공동 1위 의견들을 놓고 한 번 더 이야기해 보세요.</p>` : ''}
      <div class="stats">
        <div><b>${joined}</b><span>참여</span></div>
        <div><b>${t.ballots}</b><span>투표</span></div>
        <div><b>${t.total}</b><span>전체 표</span></div>
      </div>
    </section>

    <section class="card">
      <h2>득표 결과</h2>
      <ol class="chart">
        ${t.rows
          .map(
            (r) => `
          <li class="${r.winner ? 'win' : ''}">
            <div class="chart-head">
              <span class="rank">${r.rank}위</span>
              <span class="chart-label">${esc(r.card.label)}</span>
            </div>
            <div class="chart-bar">
              <div class="track"><div class="fill" style="width:${t.max ? Math.max(r.votes ? 4 : 0, Math.round((r.votes / t.max) * 100)) : 0}%"></div></div>
              <span class="num">${r.votes}표</span>
            </div>
            ${
              r.card.texts.length > 1
                ? `<details class="bundle" data-k="r-${esc(r.card.id)}">
                     <summary>비슷한 의견 ${r.card.texts.length}개 묶음</summary>
                     <ul>${r.card.texts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
                   </details>`
                : ''
            }
          </li>`,
          )
          .join('')}
      </ol>
    </section>

    ${
      minority.length
        ? `<section class="card minority">
             <h2>소수 의견도 함께 봐요</h2>
             <p class="hint">표는 적었지만 놓치면 아까운 생각일 수 있어요. 결정에 반영할 점이 없는지 살펴봐요.</p>
             <ul class="minority-list">
               ${minority
                 .map(
                   (r) => `
                 <li>
                   <p>${esc(r.card.label)}</p>
                   ${r.card.texts.length > 1 ? `<ul class="sub">${r.card.texts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
                   <span class="votes-tag">${r.votes}표</span>
                 </li>`,
                 )
                 .join('')}
             </ul>
           </section>`
        : ''
    }
    ${hiddenNoteHtml()}
    <div class="stack">
      <button type="button" class="btn ghost block" data-act="copy-result">결과를 글로 복사하기 (회의록용)</button>
      <a class="btn ghost block" href="#/">첫 화면으로</a>
    </div>`;
}

function resultText() {
  const t = tally();
  const lines = [
    `[학급회의 결과] ${M.meeting.topic}`,
    `참여 ${M.members.length}명 · 투표 ${t.ballots}명 · 전체 ${t.total}표`,
    '',
    ...t.rows.map((r) => `${r.rank}위 (${r.votes}표) ${r.card.label}`),
  ];
  const minority = t.rows.filter((r) => r.minority);
  if (minority.length) {
    lines.push('', '소수 의견', ...minority.map((r) => `- ${r.card.label} (${r.votes}표)`));
  }
  return lines.join('\n');
}

// ── 사회자 도구 ─────────────────────────────────────────────────────────

function timerRowHtml() {
  const on = !!M.meeting.timerEndsAt;
  return `
    <div class="tool-row">
      <span class="tool-label">타이머</span>
      <div class="pill-row">
        ${[1, 2, 3, 5].map((m) => `<button type="button" class="pill" data-act="timer" data-sec="${m * 60}">${m}분</button>`).join('')}
        ${on ? `<button type="button" class="pill off" data-act="timer" data-sec="0">끄기</button>` : ''}
      </div>
    </div>`;
}

function lockRowHtml() {
  const locked = M.meeting.locked;
  return `
    <div class="tool-row">
      <span class="tool-label">입장 잠그기<small>우리 반이 다 들어오면 켜 두세요</small></span>
      <button type="button" class="switch ${locked ? 'on' : ''}" role="switch" aria-checked="${locked}"
              aria-label="입장 잠그기" data-act="toggle-lock"><span></span></button>
    </div>`;
}

function hostHtml() {
  const meeting = M.meeting;
  const phase = meeting.phase;
  let inner = '';

  if (phase === 'collect') {
    inner = `
      <div class="invite">
        <div>
          <span class="invite-label">참여 코드</span>
          <strong class="invite-code">${prettyCode(M.code)}</strong>
        </div>
        <div class="invite-actions">
          <button type="button" class="btn small" data-act="show-invite">QR·크게 보기</button>
          <button type="button" class="btn small ghost" data-act="copy-link">링크 복사</button>
        </div>
      </div>
      <div class="progress">
        <div class="progress-text">제출 <b data-live="submitted">0</b>명 / 참여 <b data-live="joined">0</b>명</div>
        <div class="track"><div class="fill" data-bar="submitted"></div></div>
      </div>
      ${timerRowHtml()}
      ${lockRowHtml()}
      ${
        M.role === 'hostOnly'
          ? `<div class="tool-row">
               <span class="tool-label">반장도 참여하나요?<small>사회자도 마감 전에는 의견을 볼 수 없어요</small></span>
               <button type="button" class="btn small ghost" data-act="host-join">나도 참여</button>
             </div>`
          : ''
      }
      <button type="button" class="btn primary block" data-act="close">제출 마감하고 한꺼번에 공개</button>
      <p class="hint center">사회자도 마감 전에는 의견 내용을 볼 수 없고, 제출 인원만 보여요.</p>`;
  } else if (phase === 'review') {
    inner = `
      <div class="tool-row">
        <span class="tool-label">1인당 표 수</span>
        <div class="pill-row">
          ${[1, 2, 3].map((n) => `<button type="button" class="pill ${M.votesChoice === n ? 'active' : ''}" data-act="set-votes" data-n="${n}">${n}표</button>`).join('')}
        </div>
      </div>
      ${lockRowHtml()}
      <button type="button" class="btn primary block" data-act="start-vote" ${meeting.revealed ? '' : 'disabled'}>정리 끝 · 투표 시작</button>
      <p class="hint center">투표가 시작되면 의견을 더 묶거나 가릴 수 없어요.</p>`;
  } else if (phase === 'vote') {
    inner = `
      <div class="progress">
        <div class="progress-text">투표 <b data-live="voted">0</b>명 / 참여 <b data-live="joined">0</b>명</div>
        <div class="track"><div class="fill" data-bar="voted"></div></div>
      </div>
      ${timerRowHtml()}
      ${lockRowHtml()}
      <button type="button" class="btn primary block" data-act="end-vote">투표 마감하고 결과 공개</button>
      <p class="hint center">사회자도 마감 전에는 중간 결과를 볼 수 없어요.</p>`;
  } else {
    inner = `<p class="hint">회의가 끝났어요. 결과 화면을 함께 보며 마무리해 주세요.</p>`;
  }
  return `
    <section class="card host">
      <h2 class="host-title"><span class="host-tag">사회자 도구</span></h2>
      ${inner}
    </section>`;
}

// ── 아래쪽 고정 막대 ────────────────────────────────────────────────────

function footHtml() {
  const phase = M.meeting.phase;
  if (phase === 'vote' && M.role === 'joined' && M.myVote === null && M.cards) {
    const max = M.meeting.votesPerPerson;
    const n = M.pick.size;
    return `
      <div class="footbar">
        <span class="foot-text"><b>${n}</b> / ${max}표 선택</span>
        <button type="button" class="btn primary" data-act="cast-vote" ${n ? '' : 'disabled'}>투표하기</button>
      </div>`;
  }
  if (phase === 'review' && isHost() && M.mergeSel.size) {
    const n = M.mergeSel.size;
    return `
      <div class="footbar">
        <span class="foot-text"><b>${n}</b>개 선택</span>
        <button type="button" class="btn ghost" data-act="clear-merge">취소</button>
        <button type="button" class="btn primary" data-act="merge" ${n >= 2 ? '' : 'disabled'}>하나로 묶기</button>
      </div>`;
  }
  return '';
}

// ═════════════════════════════════════════════════════════════════════════
// 버튼 처리
// ═════════════════════════════════════════════════════════════════════════

/** 서버에 쓰는 동작을 감싸서, 두 번 눌림을 막고 실패하면 알려 줍니다. */
async function run(task, failMessage) {
  if (!M || M.busy) return false;
  const session = M;
  session.busy = true;
  try {
    await task();
    return true;
  } catch (err) {
    console.error(err);
    toast(err && err.code === 'permission-denied' && failMessage ? failMessage : errorMessage(err));
    return false;
  } finally {
    session.busy = false;
  }
}

const actions = {
  reload() {
    location.reload();
  },

  // ── 학생 ──
  'edit-opinion'() {
    M.editing = true;
    store.set(draftKey(M.code), M.myOpinion.text);
    render();
    const area = document.getElementById('opinion');
    if (area) area.focus();
  },

  'cancel-edit'() {
    M.editing = false;
    store.remove(draftKey(M.code));
    render();
  },

  'toggle-pick'(el) {
    const id = el.dataset.id;
    const max = M.meeting.votesPerPerson;
    if (M.pick.has(id)) M.pick.delete(id);
    else if (max === 1) M.pick = new Set([id]);
    else if (M.pick.size >= max) return toast(`최대 ${max}개까지 고를 수 있어요.`);
    else M.pick.add(id);
    render();
  },

  async 'cast-vote'() {
    const choices = [...M.pick].filter((id) => visibleCards().some((c) => c.id === id));
    if (!choices.length) return;
    const max = M.meeting.votesPerPerson;
    const labels = visibleCards().filter((c) => choices.includes(c.id));
    const yes = await ask({
      title: '이대로 투표할까요?',
      message:
        choices.length < max
          ? `${max}표 중 ${choices.length}표만 골랐어요. 투표한 뒤에는 바꿀 수 없어요.`
          : '투표한 뒤에는 바꿀 수 없어요.',
      bodyHtml: `<ul class="confirm-list">${labels.map((c) => `<li>${esc(c.label)}</li>`).join('')}</ul>`,
      ok: '투표하기',
      cancel: '다시 고르기',
    });
    if (!yes || !M) return;
    const ok = await run(
      () => DB.castVote(M.code, M.secret.voteKey, choices),
      '투표가 이미 마감됐거나, 이미 투표했어요.',
    );
    if (ok && M) M.pick.clear();
  },

  // ── 사회자 ──
  'show-invite'() {
    const url = joinUrl(M.code);
    let qr = '';
    try {
      const code = window.qrcode(0, 'M');
      code.addData(url);
      code.make();
      qr = code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (err) {
      console.warn(err);
    }
    ask({
      title: '이렇게 들어오세요',
      bodyHtml: `
        <div class="invite-big">
          ${qr ? `<div class="qr">${qr}</div>` : ''}
          <p class="invite-step">카메라로 QR 을 찍거나, 아래 주소에서 코드를 입력해요</p>
          <p class="invite-url">${esc(location.host + location.pathname)}</p>
          <strong class="invite-code huge">${prettyCode(M.code)}</strong>
        </div>`,
      ok: '닫기',
      cancel: '',
    });
  },

  async 'copy-link'() {
    toast((await copyText(joinUrl(M.code))) ? '참여 링크를 복사했어요.' : '복사하지 못했어요.');
  },

  timer(el) {
    run(() => DB.setTimer(M.code, Number(el.dataset.sec)));
  },

  'toggle-lock'() {
    run(() => DB.setLocked(M.code, !M.meeting.locked));
  },

  async 'host-join'() {
    const yes = await ask({
      title: '참여자로도 들어갈까요?',
      message: '사회를 보면서 의견을 내고 투표할 수 있어요. 참여 인원에 1명으로 포함돼요.',
      ok: '참여하기',
    });
    if (!yes || !M) return;
    store.set(hostJoinKey(M.code), '1');
    M.role = 'pending';
    render();
    decideRole();
  },

  async close() {
    const joined = M.members.length;
    const submitted = M.members.filter((m) => m.submitted).length;
    const yes = await ask({
      title: '제출을 마감할까요?',
      message:
        `참여 ${joined}명 중 ${submitted}명이 제출했어요. ` +
        '마감하면 더 이상 의견을 내거나 고칠 수 없고, 모든 의견이 무작위 순서로 한꺼번에 공개돼요.',
      ok: '마감하고 공개',
    });
    if (!yes || !M) return;
    run(() => DB.closeSubmissions(M.code));
  },

  'retry-reveal'() {
    runReveal();
    render();
  },

  'toggle-merge'(el) {
    const id = el.dataset.id;
    if (M.mergeSel.has(id)) M.mergeSel.delete(id);
    else M.mergeSel.add(id);
    render();
  },

  'clear-merge'() {
    M.mergeSel.clear();
    render();
  },

  async merge() {
    const cards = visibleCards().filter((c) => M.mergeSel.has(c.id));
    if (cards.length < 2) return;
    const label = await ask({
      title: `의견 ${cards.length}개를 하나로 묶기`,
      message: '원래 의견들은 묶음 안에 그대로 남아서 누구나 펼쳐 볼 수 있어요.',
      bodyHtml: `<ul class="confirm-list">${cards.flatMap((c) => c.texts).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`,
      input: { label: '투표에 보여 줄 대표 문장', value: cards[0].label, max: DB.MAX_OPINION_LENGTH },
      ok: '묶기',
    });
    if (!label || !M) return;
    const ok = await run(() => DB.mergeCards(M.code, cards, label));
    if (ok && M) {
      M.mergeSel.clear();
      render();
    }
  },

  async unmerge(el) {
    const card = (M.cards || []).find((c) => c.id === el.dataset.id);
    if (!card) return;
    const yes = await ask({
      title: '묶음을 풀까요?',
      message: `묶여 있던 의견 ${card.texts.length}개가 다시 각각의 카드가 돼요.`,
      ok: '풀기',
    });
    if (!yes || !M) return;
    run(() => DB.unmergeCard(M.code, card));
  },

  async hide(el) {
    const card = (M.cards || []).find((c) => c.id === el.dataset.id);
    if (!card) return;
    const yes = await ask({
      title: '이 의견을 가릴까요?',
      message:
        '욕설·장난처럼 회의에 맞지 않는 글만 가려 주세요. 가린 의견은 되돌릴 수 없고, 가린 개수는 모두에게 표시돼요.',
      bodyHtml: `<ul class="confirm-list"><li>${esc(card.label)}</li></ul>`,
      ok: '가리기',
    });
    if (!yes || !M) return;
    M.mergeSel.delete(card.id);
    run(() => DB.hideCard(M.code, card));
  },

  'set-votes'(el) {
    M.votesChoice = Number(el.dataset.n);
    render();
  },

  async 'start-vote'() {
    const count = visibleCards().length;
    if (count < 2) return toast('투표하려면 의견이 2개 이상 있어야 해요.');
    const yes = await ask({
      title: '투표를 시작할까요?',
      message: `의견 ${count}개 · 1인당 ${M.votesChoice}표. 시작하면 의견을 더 묶거나 가릴 수 없어요.`,
      ok: '투표 시작',
    });
    if (!yes || !M) return;
    M.mergeSel.clear();
    run(() => DB.startVote(M.code, M.votesChoice));
  },

  async 'end-vote'() {
    const joined = M.members.length;
    const voted = M.members.filter((m) => m.voted).length;
    const yes = await ask({
      title: '투표를 마감할까요?',
      message: `참여 ${joined}명 중 ${voted}명이 투표했어요. 마감하면 결과가 모두에게 공개돼요.`,
      ok: '마감하고 결과 공개',
    });
    if (!yes || !M) return;
    run(() => DB.endVote(M.code));
  },

  async 'copy-result'() {
    toast((await copyText(resultText())) ? '결과를 복사했어요. 회의록에 붙여 넣으세요.' : '복사하지 못했어요.');
  },
};

async function submitOpinionForm(form) {
  const area = form.querySelector('#opinion');
  const text = area.value.trim();
  if (!text) {
    toast('의견을 적어 주세요.');
    area.focus();
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  const isFirst = !M.myOpinion;
  const ok = await run(
    () => DB.saveOpinion(M.code, M.secret.opKey, text, isFirst),
    '제출이 이미 마감됐어요.',
  );
  if (!M) return;
  if (ok) {
    store.remove(draftKey(M.code));
    M.editing = false;
    // 서버가 알려 주기 전에 화면부터 바꿉니다(곧 구독으로 같은 값이 들어옵니다).
    M.myOpinion = { text };
    render();
    toast(isFirst ? '익명으로 제출했어요.' : '고친 의견을 제출했어요.');
  } else {
    button.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#modal')) return;
  const el = event.target.closest('[data-act]');
  if (!el || el.disabled) return;
  // 카드 안의 "묶음 펼치기"를 눌렀을 때는 카드 선택으로 치지 않습니다.
  if (el.matches('li.opinion') && event.target.closest('details, .card-tools')) return;
  const handler = actions[el.dataset.act];
  if (handler) handler(el);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target;
  if (el.matches && el.matches('li.opinion[data-act]')) {
    event.preventDefault();
    actions[el.dataset.act](el);
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'join') submitJoinForm(form);
  else if (form.dataset.form === 'create') submitCreateForm(form);
  else if (form.dataset.form === 'opinion') submitOpinionForm(form);
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'opinion' && M) {
    // 탭이 새로고침돼도 쓰던 글이 남도록, 글자를 칠 때마다 이 기기에 저장합니다.
    store.set(draftKey(M.code), el.value);
    updateOpinionCounter();
  } else if (el.id === 'topic') {
    store.set('sogon:topic', el.value);
  } else if (el.id === 'join-code') {
    el.value = el.value.replace(/\D/g, '').slice(0, 6);
  }
});

boot();
