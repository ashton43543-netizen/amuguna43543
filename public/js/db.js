// Firebase(익명 로그인 + Firestore)와 주고받는 일은 모두 이 파일에 모여 있습니다.
// 화면 코드(app.js)는 여기 있는 함수만 부릅니다.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig } from '../firebase-config.js';

// 에뮬레이터 포트 (firebase.json 과 같아야 합니다)
const EMULATOR_AUTH_PORT = 9099;
const EMULATOR_FIRESTORE_PORT = 8080;
const EMULATOR_PROJECT = 'demo-classroom';

export const MAX_OPINION_LENGTH = 200;
export const MAX_TOPIC_LENGTH = 120;

let auth;
let db;

/** firebase-config.js 를 아직 채우지 않았는지 */
function configIsEmpty() {
  const key = String(firebaseConfig.apiKey || '');
  const project = String(firebaseConfig.projectId || '');
  return !key || !project || key.includes('여기에') || project.includes('여기에');
}

/** 내 컴퓨터나 같은 와이파이 안의 주소로 열었는지 (연습 모드 판단용) */
function isLocalAddress(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * 어떤 방식으로 동작할지 정합니다.
 *  - 'live'         : 설정을 채웠음 → 실제 Firebase 프로젝트 사용
 *  - 'emulator'     : 설정이 비어 있고 내 컴퓨터에서 열었음 → 연습 모드
 *  - 'unconfigured' : 설정이 비어 있는데 인터넷에 올라가 있음 → 안내 화면
 * 주소 끝에 ?emulator=1 을 붙이면 설정을 채운 뒤에도 연습 모드로 열 수 있습니다.
 */
export function detectMode() {
  const forceEmulator = new URLSearchParams(location.search).get('emulator') === '1';
  if (forceEmulator) return 'emulator';
  if (!configIsEmpty()) return 'live';
  return isLocalAddress(location.hostname) ? 'emulator' : 'unconfigured';
}

/** Firebase 를 시작하고 익명으로 로그인합니다. 내 uid 를 돌려줍니다. */
export async function start(mode) {
  if (mode === 'emulator') {
    const app = initializeApp({
      apiKey: 'demo-api-key',
      projectId: EMULATOR_PROJECT,
      authDomain: `${EMULATOR_PROJECT}.firebaseapp.com`,
    });
    auth = getAuth(app);
    db = getFirestore(app);
    const host = location.hostname;
    connectAuthEmulator(auth, `http://${host}:${EMULATOR_AUTH_PORT}`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, EMULATOR_FIRESTORE_PORT);
  } else {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }

  const user = await new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(
      auth,
      (u) => {
        stop();
        resolve(u);
      },
      reject,
    );
  });
  if (user) return user.uid;
  const result = await signInAnonymously(auth);
  return result.user.uid;
}

// ── 경로 ────────────────────────────────────────────────────────────────
const meetingRef = (code) => doc(db, 'meetings', code);
const memberRef = (code, uid) => doc(db, 'meetings', code, 'members', uid);
const secretRef = (code, uid) => doc(db, 'meetings', code, 'secrets', uid);
const opinionRef = (code, key) => doc(db, 'meetings', code, 'opinions', key);
const voteRef = (code, key) => doc(db, 'meetings', code, 'votes', key);
const cardsCol = (code) => collection(db, 'meetings', code, 'cards');

// ── 무작위 도구 ─────────────────────────────────────────────────────────
function randomInt(max) {
  // 0 이상 max 미만의 정수 (치우침 없이)
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

function randomString(length, alphabet) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomKey = () => randomString(24, KEY_ALPHABET);

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 회의 만들기 · 찾기 ──────────────────────────────────────────────────

/** 새 회의를 만들고 참여 코드(숫자 6자리)를 돌려줍니다. */
export async function createMeeting({ topic, votesPerPerson }) {
  const uid = auth.currentUser.uid;
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomString(6, '0123456789');
    try {
      // 이미 있는 코드라면 "수정"으로 취급되어 규칙이 거부합니다 → 다른 코드로 다시 시도
      await setDoc(meetingRef(code), {
        topic,
        hostUid: uid,
        phase: 'collect',
        revealed: false,
        votesPerPerson,
        locked: false,
        timerEndsAt: null,
        createdAt: serverTimestamp(),
      });
      return code;
    } catch (err) {
      lastError = err;
      if (err.code !== 'permission-denied') break;
    }
  }
  throw lastError;
}

export async function meetingExists(code) {
  const snap = await getDoc(meetingRef(code));
  return snap.exists();
}

// ── 입장 ────────────────────────────────────────────────────────────────

/** 이미 입장했다면 내 비밀 열쇠를, 아니면 null 을 돌려줍니다. */
export async function getMySecret(code) {
  const snap = await getDoc(secretRef(code, auth.currentUser.uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * 회의에 참여자로 입장합니다. 내 비밀 열쇠를 돌려줍니다.
 * 입장이 잠겨 있으면 permission-denied 오류가 납니다.
 */
export async function join(code) {
  const existing = await getMySecret(code);
  if (existing) return existing;
  const uid = auth.currentUser.uid;
  const secret = { opKey: randomKey(), voteKey: randomKey() };
  const batch = writeBatch(db);
  batch.set(memberRef(code, uid), { submitted: false, voted: false });
  batch.set(secretRef(code, uid), secret);
  await batch.commit();
  return secret;
}

// ── 실시간 구독 (돌려주는 함수를 부르면 구독이 끝납니다) ────────────────

export function watchMeeting(code, onData, onError) {
  // 내 기기에서 보낸 변경이 서버에 실제로 반영됐는지(pending)도 함께 알려 줍니다.
  return onSnapshot(
    meetingRef(code),
    { includeMetadataChanges: true },
    (snap) => onData(snap.exists() ? snap.data() : null, snap.metadata.hasPendingWrites),
    onError,
  );
}

export function watchMembers(code, onData, onError) {
  return onSnapshot(
    collection(db, 'meetings', code, 'members'),
    (snap) => onData(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    onError,
  );
}

export function watchMyOpinion(code, opKey, onData, onError) {
  return onSnapshot(
    opinionRef(code, opKey),
    (snap) => onData(snap.exists() ? snap.data() : null),
    onError,
  );
}

export function watchMyVote(code, voteKey, onData, onError) {
  return onSnapshot(
    voteRef(code, voteKey),
    (snap) => onData(snap.exists() ? snap.data() : null),
    onError,
  );
}

export function watchCards(code, onData, onError) {
  return onSnapshot(
    cardsCol(code),
    (snap) => {
      const cards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cards.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
      onData(cards);
    },
    onError,
  );
}

export function watchVotes(code, onData, onError) {
  return onSnapshot(
    collection(db, 'meetings', code, 'votes'),
    (snap) => onData(snap.docs.map((d) => d.data())),
    onError,
  );
}

// ── 학생: 의견 · 투표 ───────────────────────────────────────────────────

/** 의견을 처음 내거나(isFirst) 마감 전에 고칩니다. */
export async function saveOpinion(code, opKey, text, isFirst) {
  if (!isFirst) {
    await updateDoc(opinionRef(code, opKey), { text });
    return;
  }
  const batch = writeBatch(db);
  batch.set(opinionRef(code, opKey), { text });
  batch.update(memberRef(code, auth.currentUser.uid), { submitted: true });
  await batch.commit();
}

/** 투표합니다. 한 번 내면 고칠 수 없습니다. */
export async function castVote(code, voteKey, choices) {
  const batch = writeBatch(db);
  batch.set(voteRef(code, voteKey), { choices });
  batch.update(memberRef(code, auth.currentUser.uid), { voted: true });
  await batch.commit();
}

// ── 사회자: 진행 ────────────────────────────────────────────────────────

export function setLocked(code, locked) {
  return updateDoc(meetingRef(code), { locked });
}

/** 타이머를 켭니다(초 단위). 0 이면 끕니다. */
export function setTimer(code, seconds) {
  return updateDoc(meetingRef(code), {
    timerEndsAt: seconds > 0 ? Timestamp.fromMillis(Date.now() + seconds * 1000) : null,
  });
}

/** 의견 제출을 마감합니다. 이 순간부터 아무도 의견을 내거나 고칠 수 없습니다. */
export function closeSubmissions(code) {
  return updateDoc(meetingRef(code), { phase: 'review', timerEndsAt: null });
}

/**
 * 마감된 의견을 무작위로 섞어 카드로 한꺼번에 공개합니다.
 * 카드 만들기 + 원본 지우기 + "공개됨" 표시를 한 묶음으로 처리하므로
 * 일부만 공개되는 일은 없습니다. 중간에 끊겨도 다시 부르면 이어서 처리됩니다.
 */
export async function revealOpinions(code) {
  const snap = await getDocs(collection(db, 'meetings', code, 'opinions'));
  const order = shuffled(snap.docs);
  const batch = writeBatch(db);
  order.forEach((opinion, index) => {
    const text = String(opinion.data().text || '');
    batch.set(doc(cardsCol(code)), { label: text, texts: [text], order: index, hidden: false });
    batch.delete(opinion.ref);
  });
  batch.update(meetingRef(code), { revealed: true });
  await batch.commit();
}

/** 비슷한 카드 여러 장을 하나로 묶습니다. 원래 의견들은 묶음 안에 그대로 남습니다. */
export async function mergeCards(code, cards, label) {
  const [target, ...rest] = cards;
  const batch = writeBatch(db);
  batch.update(doc(cardsCol(code), target.id), {
    label,
    texts: cards.flatMap((c) => c.texts),
  });
  rest.forEach((c) => batch.delete(doc(cardsCol(code), c.id)));
  await batch.commit();
}

/** 묶음을 풀어 원래 의견들을 각각의 카드로 되돌립니다. */
export async function unmergeCard(code, card) {
  const batch = writeBatch(db);
  card.texts.forEach((text, index) => {
    const data = { label: text, texts: [text], order: card.order + index * 0.001, hidden: false };
    if (index === 0) batch.set(doc(cardsCol(code), card.id), data);
    else batch.set(doc(cardsCol(code)), data);
  });
  await batch.commit();
}

/** 부적절한 카드를 가립니다. 내용은 서버에서도 지워지고, 가렸다는 사실만 남습니다. */
export function hideCard(code, card) {
  return updateDoc(doc(cardsCol(code), card.id), { label: '', texts: [], hidden: true });
}

export function startVote(code, votesPerPerson) {
  return updateDoc(meetingRef(code), { phase: 'vote', votesPerPerson, timerEndsAt: null });
}

export function endVote(code) {
  return updateDoc(meetingRef(code), { phase: 'result', timerEndsAt: null });
}
