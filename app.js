/* ================= שבצ"ק — לוגיקת צד לקוח ================= */
const HOUR = 3600000;
const uid = () => Math.random().toString(36).slice(2, 9);
const pad = n => String(n).padStart(2, '0');
const $ = id => document.getElementById(id);

/* ---------- מצב ברירת מחדל ---------- */
function defaultState() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return {
    config: { startDateTime: local, durationHours: 24, restHours: 8, nightStart: 22, nightEnd: 6, standbyRestNight: 3 },
    soldiers: [],
    positions: [],
    schedule: null,
    history: [],
  };
}

let state = defaultState();

/* ================= אבטחה (מופעל רק אם השרת דורש קוד — כלומר בענן) ================= */
let TOKEN = localStorage.getItem('shibutz_token') || null;
function setToken(t) { TOKEN = t; if (t) localStorage.setItem('shibutz_token', t); else localStorage.removeItem('shibutz_token'); }
async function api(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {});
  const res = await fetch(url, opts);
  if (res.status === 401) { setToken(null); showGate('ההרשאה פגה — יש להיכנס מחדש'); throw new Error('unauthorized'); }
  return res;
}

/* ================= טעינה ושמירה ================= */
async function loadState() {
  try {
    const res = await api('/api/state');
    const data = await res.json();
    if (data && data.config) {
      state = Object.assign(defaultState(), data);
      state.config = Object.assign(defaultState().config, data.config || {});
    }
  } catch (e) { if (e.message !== 'unauthorized') console.warn('טעינה נכשלה', e); }
}

let saveTimer = null;
function saveState() {
  const el = $('saveStatus');
  el.textContent = 'שומר…'; el.classList.add('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      el.textContent = 'נשמר ✓'; el.classList.remove('saving');
    } catch (e) {
      if (e.message !== 'unauthorized') { el.textContent = 'שגיאת שמירה'; el.classList.remove('saving'); }
    }
  }, 400);
}

/* ================= עזרי זמן ================= */
const startMsOf = () => Date.parse(state.config.startDateTime);
const fmtTime = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = ms => { const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const fmtDay = ms => dayNames[new Date(ms).getDay()];
// המרת חותמת זמן לפורמט של שדה datetime-local (זמן מקומי)
const toLocalInput = ms => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function isNightHour(hour) {
  const s = +state.config.nightStart, e = +state.config.nightEnd;
  return s > e ? (hour >= s || hour < e) : (hour >= s && hour < e);
}
// סיווג משמרת כ"לילה" לפי אמצע המשמרת (מדויק יותר משעת ההתחלה)
function slotIsNight(start, end) {
  return isNightHour(new Date(start + (end - start) / 2).getHours());
}
// כיתת כוננות
function isStandbyPos(posId) {
  const p = state.positions.find(x => x.id === posId);
  return !!(p && p.type === 'כיתת כוננות');
}
// דרישת המנוחה (מילישניות) של משמרת: עמדה/משימה רגילה = מנוחה מלאה; כוננות = הרבה פחות
// (כוננות יום כמעט ללא מנוחה; כוננות לילה מינימום 2-3 שעות)
const STANDBY_REST_DAY_H = 0; // כוננות יום — לא צריך מנוחה מיוחדת
function slotRestMs(sl) {
  if (!isStandbyPos(sl.posId)) return (+state.config.restHours) * HOUR;
  const nightH = state.config.standbyRestNight != null ? +state.config.standbyRestNight : 3;
  return (slotIsNight(sl.start, sl.end) ? nightH : STANDBY_REST_DAY_H) * HOUR;
}
// מאזני היסטוריה לכל לוחם (לפי שם) — לצורך הוגנות בין סבבים
function historyTallies() {
  const t = {};
  const g = name => t[name] || (t[name] = { nights: 0, hours: 0, shifts: 0, pos: {} });
  state.history.forEach(h => (h.slots || []).forEach(sl => {
    const m = g(sl.name);
    m.hours += (sl.end - sl.start) / HOUR;
    m.shifts += 1;
    if (slotIsNight(sl.start, sl.end)) m.nights += 1;
    m.pos[sl.pos] = (m.pos[sl.pos] || 0) + 1;
  }));
  return t;
}

/* ================= חישוב משמרות לכל עמדה ================= */
function ensureShifts() {
  const start = startMsOf();
  const dur = +state.config.durationHours;
  const end = start + dur * HOUR;
  state._endMs = end; state._startMs = start;
  state.positions.forEach(p => {
    p._shifts = [];
    const len = +p.shiftLen;
    if (!(len > 0)) return;
    const n = Math.ceil(dur / len);
    for (let s = 0; s < n; s++) {
      const ss = start + s * len * HOUR;
      if (ss >= end) break;
      const se = Math.min(ss + len * HOUR, end);
      p._shifts.push({ index: s, start: ss, end: se });
    }
  });
}

const slotKey = (posId, shiftIndex, seat) => `${posId}|${shiftIndex}|${seat}`;

/* ================= מנוע השיבוץ ================= */
function generateSchedule(keepManual) {
  ensureShifts();
  const restMs = +state.config.restHours * HOUR;
  const present = state.soldiers.filter(s => s.present);

  // בניית מפת המשבצות
  const oldSlots = (state.schedule && state.schedule.slots) || {};
  const slots = {};
  state.positions.forEach(p => {
    p._shifts.forEach(sh => {
      for (let seat = 0; seat < +p.count; seat++) {
        const key = slotKey(p.id, sh.index, seat);
        const prev = oldSlots[key];
        if (keepManual && prev && prev.manual && prev.soldierId) {
          slots[key] = { posId: p.id, shiftIndex: sh.index, seat, start: sh.start, end: sh.end, soldierId: prev.soldierId, manual: true, violation: false };
        } else {
          slots[key] = { posId: p.id, shiftIndex: sh.index, seat, start: sh.start, end: sh.end, soldierId: null, manual: false, violation: false };
        }
      }
    });
  });

  // משקלות פונקציית העלות (נמוך=עדיף). לילות וסבב-עמדות במשקל דומיננטי לפי בקשת המשתמש.
  const NIGHT_W = 1000;  // איזון לילות — הגורם החזק ביותר במשמרת לילה
  const POS_W = 120;     // סבב עמדות — כמה פעמים הלוחם כבר עשה את העמדה הזו
  const REPEAT_W = 300;  // קנס על חזרה מיידית לאותה עמדה שהלוחם עשה קודם
  const HOURS_W = 6;     // איזון עדין של סה"כ שעות
  const SHIFT_W = 12;    // איזון עדין של מספר משמרות
  const HIST_W = 0.6;    // משקל ההיסטוריה (מנחה בין סבבים בלי להשתלט לחלוטין)
  const REST_W = 800;    // קנס חמור על מנוחה מתחת למינימום — במצב חוסר ממקסם מנוחה ומונע ירידה-ועלייה מיידית

  const posName = id => { const p = state.positions.find(x => x.id === id); return p ? p.name : id; };
  const hist = historyTallies();

  // טראקר לכל לוחם נוכח, מאותחל ממאזני ההיסטוריה (במשקל מופחת)
  const tr = {};
  present.forEach(s => {
    const h = hist[s.name] || { nights: 0, hours: 0, shifts: 0, pos: {} };
    const pos = {};
    Object.keys(h.pos).forEach(pn => pos[pn] = h.pos[pn] * HIST_W);
    tr[s.id] = { hours: h.hours * HIST_W, shifts: h.shifts * HIST_W, nights: h.nights * HIST_W, pos, intervals: [] };
  });

  // === המשכיות בין סבבים ===
  // משמרות מסבבים קודמים שהסתיימו סמוך לתחילת הסבב הנוכחי נכנסות לחישוב המנוחה בלבד
  // (השעות/הלילות כבר נספרו דרך historyTallies), כדי שלוחם לא ירד ממשמרת ויעלה מיד בסבב החדש.
  const nightH = state.config.standbyRestNight != null ? +state.config.standbyRestNight : 3;
  const carryFrom = state._startMs - Math.max(restMs, 12 * HOUR);
  state.history.forEach(h => (h.slots || []).forEach(hs => {
    if (!(hs.end > carryFrom && hs.end <= state._startMs)) return;
    const s = present.find(x => x.name === hs.name);
    if (!s || !tr[s.id]) return;
    const req = hs.standby ? (slotIsNight(hs.start, hs.end) ? nightH * HOUR : 0) : restMs;
    tr[s.id].intervals.push({ start: hs.start, end: hs.end, pos: hs.pos, req });
  }));

  // הזרקת שיבוצים קיימים (ידניים ששומרו) לטראקר — נספרים במלוא המשקל
  Object.values(slots).forEach(sl => {
    const T = tr[sl.soldierId];
    if (!sl.soldierId || !T) return;
    const pn = posName(sl.posId), night = slotIsNight(sl.start, sl.end);
    T.intervals.push({ start: sl.start, end: sl.end, pos: pn, req: slotRestMs(sl) });
    T.hours += (sl.end - sl.start) / HOUR; T.shifts += 1; if (night) T.nights += 1;
    T.pos[pn] = (T.pos[pn] || 0) + 1;
  });

  // סדר השיבוץ: קודם עמדות/משימות רגילות (ש.ג וכו'), ואחר כך כיתת כוננות.
  // כך העמדות התובעניות מקבלות עדיפות מכל מצבת הלוחמים, והכוננות משמשת מאגר גמיש
  // שסופג את מי שפנוי — כלומר מי שיורד מעמדה זמין לכוננות, ולוחם מהכוננות זמין לעמדה.
  const empties = Object.values(slots).filter(sl => !sl.soldierId)
    .sort((a, b) => (isStandbyPos(a.posId) - isStandbyPos(b.posId)) || a.start - b.start || a.posId.localeCompare(b.posId) || a.seat - b.seat);

  for (const sl of empties) {
    const pn = posName(sl.posId), night = slotIsNight(sl.start, sl.end);
    // מועמדים: נוכחים, שאינם חסומים לעמדה זו, ושאינם חופפים בזמן (אילוצים קשיחים)
    const pool = present.filter(s => !(s.blocked || []).includes(sl.posId) && !tr[s.id].intervals.some(a => a.start < sl.end && a.end > sl.start));
    if (pool.length === 0) continue; // חוסר — נשארת ריקה

    const slotReqMs = slotRestMs(sl); // דרישת המנוחה של המשבצת הנוכחית (כוננות = פחות)
    const scored = pool.map(s => {
      const T = tr[s.id];
      // פער מנוחה + חוסר-מנוחה חמור ביותר מול השכנים. הדרישה לכל צמד = המינימום בין שתי המשמרות
      // (אם אחת מהן כוננות — המעבר קל, כי כוננות עצמה נחשבת מנוחה)
      let minGap = Infinity, worstShortMs = 0, lastPos = null, lastEnd = -Infinity;
      T.intervals.forEach(a => {
        let g = null;
        if (a.end <= sl.start) { g = sl.start - a.end; if (a.end > lastEnd) { lastEnd = a.end; lastPos = a.pos; } }
        else if (a.start >= sl.end) { g = a.start - sl.end; }
        if (g == null) return;
        minGap = Math.min(minGap, g);
        const reqPair = Math.min(slotReqMs, a.req != null ? a.req : restMs);
        if (g < reqPair) worstShortMs = Math.max(worstShortMs, reqPair - g);
      });
      // עלות משוקללת — נמוך=עדיף
      let cost = HOURS_W * T.hours + SHIFT_W * T.shifts + POS_W * (T.pos[pn] || 0);
      if (night) cost += NIGHT_W * T.nights;      // איזון לילות מופעל רק במשמרת לילה
      if (lastPos === pn) cost += REPEAT_W;        // הימנעות מחזרה מיידית לאותה עמדה
      // קנס מנוחה: פעיל רק כשמשבצים מתחת למינימום הנדרש — ממקסם את פער המנוחה
      if (worstShortMs > 0) cost += REST_W * worstShortMs / HOUR;
      cost += Math.random() * 0.5;                 // שובר-שוויון אקראי (מונע הטיה קבועה)
      return { s, gap: minGap, cost, restOk: worstShortMs === 0 };
    });

    const rested = scored.filter(x => x.restOk);
    const chooseFrom = rested.length ? rested : scored; // אם אין מנוחה מספקת — משבצים בכל זאת
    chooseFrom.sort((a, b) => a.cost - b.cost || b.gap - a.gap);
    const pick = chooseFrom[0];

    // עדכון הטראקר
    sl.soldierId = pick.s.id;
    const T = tr[pick.s.id];
    T.intervals.push({ start: sl.start, end: sl.end, pos: pn, req: slotReqMs });
    T.hours += (sl.end - sl.start) / HOUR; T.shifts += 1; if (night) T.nights += 1;
    T.pos[pn] = (T.pos[pn] || 0) + 1;
  }

  state.schedule = { generatedAt: Date.now(), startMs: state._startMs, endMs: state._endMs, slots };
  recomputeFlags();
}

/* חישוב מחדש של דגלי חריגה (מנוחה קצרה / כפילות) — נקרא גם אחרי עדכון ידני */
function recomputeFlags() {
  if (!state.schedule) return;
  const slots = state.schedule.slots;
  const byS = {};
  Object.values(slots).forEach(sl => {
    if (sl.soldierId) (byS[sl.soldierId] = byS[sl.soldierId] || []).push(sl);
    sl.violation = false; sl.overlap = false;
  });
  Object.values(byS).forEach(list => {
    for (const sl of list) {
      for (const o of list) {
        if (o === sl) continue;
        if (o.start < sl.end && o.end > sl.start) { sl.overlap = true; sl.violation = true; }
        else {
          // מעבר/חילוף מול כיתת כוננות אינו נחשב "מנוחה קצרה" — הכוננות היא מנוחה/זמינות
          if (isStandbyPos(sl.posId) || isStandbyPos(o.posId)) continue;
          const gap = o.end <= sl.start ? sl.start - o.end : o.start - sl.end;
          if (gap < +state.config.restHours * HOUR) sl.violation = true;
        }
      }
    }
  });
}

/* ================= התראות ופתרונות ================= */
function computeIssues() {
  const slots = Object.values(state.schedule.slots);
  const total = slots.length;
  // חוסר "אמיתי" = עמדה/משימה שאינה מאויישת. משבצת כוננות ריקה אינה חוסר — הכוננות גמישה.
  const unfilled = slots.filter(s => !s.soldierId && !isStandbyPos(s.posId)).length;
  const unfilledStandby = slots.filter(s => !s.soldierId && isStandbyPos(s.posId)).length;
  const restViol = slots.filter(s => s.soldierId && s.violation && !s.overlap).length;
  const overlaps = slots.filter(s => s.overlap).length;
  const absentMap = {}; state.soldiers.forEach(s => absentMap[s.id] = !s.present);
  const absentAssigned = slots.filter(s => s.soldierId && absentMap[s.soldierId]).length;

  // אומדן כמות לוחמים נדרשת לכיסוי מלא עם המנוחה שהוגדרה
  const rest = +state.config.restHours;
  let needed = 0;
  state.positions.forEach(p => { needed += +p.count * (+p.shiftLen + rest) / +p.shiftLen; });
  needed = Math.ceil(needed);
  const presentCount = state.soldiers.filter(s => s.present).length;

  return { total, unfilled, unfilledStandby, restViol, overlaps, absentAssigned, needed, presentCount };
}

function renderWarnings() {
  const box = $('warningsBox');
  box.innerHTML = '';
  if (!state.schedule) return;
  const i = computeIssues();
  const suggestions = [];

  if (i.unfilled > 0 || i.restViol > 0 || i.overlaps > 0) {
    suggestions.push('הגדלת אורך המשמרת בעמדות — פחות משמרות בסבב = יותר מנוחה לכל לוחם.');
    suggestions.push('הפחתת מספר הלוחמים הנדרשים במקביל בעמדה.');
    suggestions.push('הפחתת מספר העמדות/המשימות הפעילות בסבב זה.');
    if (i.presentCount < i.needed)
      suggestions.push(`לכיסוי מלא עם מנוחה של ${state.config.restHours} שעות דרושים כ־${i.needed} לוחמים נוכחים — כרגע יש ${i.presentCount}. ניתן להוסיף לוחמים או לסמן חסרים כנוכחים.`);
  }

  const html = [];
  if (i.unfilled > 0)
    html.push(`<div class="warn err"><span class="ic">⛔</span><div><strong>חוסר לוחמים: ${i.unfilled} משבצות לא מאוישות</strong>אין מספיק לוחמים נוכחים לכיסוי כל העמדות בו־זמנית.</div></div>`);
  if (i.overlaps > 0)
    html.push(`<div class="warn err"><span class="ic">⚠️</span><div><strong>${i.overlaps} משבצות בכפילות</strong>לוחם משובץ לשתי משימות חופפות בזמן — כנראה עקב עדכון ידני. יש לתקן.</div></div>`);
  if (i.restViol > 0)
    html.push(`<div class="warn warn-y"><span class="ic">🌙</span><div><strong>${i.restViol} משבצות עם מנוחה מתחת ל־${state.config.restHours} שעות</strong>שובצו בכל זאת עקב חוסר/עומס (מסומן באדום בטבלה).</div></div>`);
  if (i.absentAssigned > 0)
    html.push(`<div class="warn err"><span class="ic">🚫</span><div><strong>${i.absentAssigned} משבצות עם לוחם שסומן כחסר</strong>שנה אותו לנוכח או עדכן ידנית את המשבצת.</div></div>`);
  if (i.unfilledStandby > 0)
    html.push(`<div class="warn good"><span class="ic">🚨</span><div><strong>${i.unfilledStandby} משבצות כוננות פתוחות — וזה תקין</strong>כיתת הכוננות היא מאגר גמיש; העמדות אויישו קודם, ומי שפנוי זמין לכוננות (ומהכוננות אפשר לשלוף לעמדה בעת הצורך).</div></div>`);

  if (suggestions.length)
    html.push(`<div class="warn warn-y"><span class="ic">💡</span><div><strong>פתרונות אפשריים</strong><ul>${suggestions.map(s => `<li>${s}</li>`).join('')}</ul></div></div>`);

  if (!html.length && i.total > 0)
    html.push(`<div class="warn good"><span class="ic">✅</span><div><strong>שיבוץ תקין!</strong>כל המשבצות מאוישות עם מנוחה של לפחות ${state.config.restHours} שעות בין משמרות.</div></div>`);

  box.innerHTML = html.join('');
}

/* ================= רינדור הגדרות ================= */
function renderSetup() {
  const c = state.config;
  $('startDateTime').value = c.startDateTime;
  $('durationHours').value = c.durationHours;
  $('restHours').value = c.restHours;
  $('nightStart').value = c.nightStart;
  $('nightEnd').value = c.nightEnd;
  $('standbyRestNight').value = c.standbyRestNight != null ? c.standbyRestNight : 3;

  // לוחמים
  state.soldiers.forEach(s => { if (!Array.isArray(s.blocked)) s.blocked = []; }); // נירמול
  $('soldierCounter').textContent = state.soldiers.length;
  const ul = $('soldierList'); ul.innerHTML = '';
  state.soldiers.forEach(s => {
    const li = document.createElement('li');
    li.className = 'chip ' + (s.present ? 'present' : 'absent');
    const nBlocked = (s.blocked || []).length;
    const badge = nBlocked ? `<span class="block-badge" title="${nBlocked} עמדות אסורות">⛔${nBlocked}</span>` : '';
    li.innerHTML = `<span class="dot" title="לחץ להחלפת נוכח/חסר"></span><span class="nm" title="לחץ להחלפת נוכח/חסר">${s.name}</span>${badge}<button class="lock" title="הגבלות עמדה">🔒</button><button class="rm" title="מחק">✕</button>`;
    li.querySelector('.nm').onclick = () => { s.present = !s.present; recomputeFlags(); commit(); };
    li.querySelector('.dot').onclick = () => { s.present = !s.present; recomputeFlags(); commit(); };
    li.querySelector('.lock').onclick = (e) => { e.stopPropagation(); openBlockModal(s.id); };
    li.querySelector('.rm').onclick = (e) => { e.stopPropagation(); state.soldiers = state.soldiers.filter(x => x.id !== s.id); commit(); };
    ul.appendChild(li);
  });
  const present = state.soldiers.filter(s => s.present).length;
  const absent = state.soldiers.length - present;
  $('presentSummary').textContent = state.soldiers.length ? `נוכחים: ${present} · חסרים: ${absent}` : '';

  // עמדות
  $('posCounter').textContent = state.positions.length;
  ensureShifts();
  const tb = $('posTable').querySelector('tbody'); tb.innerHTML = '';
  state.positions.forEach(p => {
    const tr = document.createElement('tr');
    const icon = p.type === 'משימה' ? '🎯' : p.type === 'כיתת כוננות' ? '🚨' : '🛡️';
    tr.innerHTML = `<td>${p.name}</td><td>${icon} ${p.type}</td><td>${p.shiftLen} ש'</td><td>${p.count}</td><td>${(p._shifts || []).length}</td>
      <td><button class="icon-btn edit-pos" title="ערוך">✏️</button> <button class="icon-btn del-pos" title="מחק">🗑️</button></td>`;
    tr.querySelector('.edit-pos').onclick = () => openPosModal(p.id);
    tr.querySelector('.del-pos').onclick = () => {
      state.positions = state.positions.filter(x => x.id !== p.id);
      state.soldiers.forEach(s => { if (Array.isArray(s.blocked)) s.blocked = s.blocked.filter(id => id !== p.id); });
      commit();
    };
    tb.appendChild(tr);
  });
}

/* ================= רינדור השיבוץ — בלוק נפרד לכל עמדה/משימה ================= */
function renderSchedule() {
  const wrap = $('scheduleWrap');
  if (!state.positions.length) { wrap.innerHTML = '<p class="empty-state">הוסף עמדות ולוחמים בטאב ההגדרות תחילה.</p>'; return; }
  if (!state.schedule) { wrap.innerHTML = '<p class="empty-state">עדיין אין שיבוץ. לחץ "צור שיבוץ אוטומטי".</p>'; return; }
  ensureShifts();
  const slots = state.schedule.slots;
  const soldierName = id => { const s = state.soldiers.find(x => x.id === id); return s ? s.name : '—'; };
  const isAbsent = id => { const s = state.soldiers.find(x => x.id === id); return s ? !s.present : false; };
  const typeIcon = t => t === 'משימה' ? '🎯' : t === 'כיתת כוננות' ? '🚨' : '🛡️';

  let html = '<div class="pos-board">';
  state.positions.forEach(p => {
    html += `<section class="pos-block">
      <header class="pos-block-head">
        <div class="pbh-title">${typeIcon(p.type)} ${p.name}</div>
        <div class="pbh-sub">${p.type} · משמרת ${p.shiftLen} ש' · ${p.count} לוחמים במקביל · ${(p._shifts || []).length} משמרות</div>
      </header>`;

    // קיבוץ המשמרות לפי יום
    let lastDay = null;
    (p._shifts || []).forEach(sh => {
      const dayKey = fmtDate(sh.start);
      if (dayKey !== lastDay) {
        if (lastDay !== null) html += '</div>'; // סגירת קבוצת יום קודמת
        html += `<div class="day-label">📅 ${fmtDay(sh.start)} · ${dayKey}</div><div class="shift-cards">`;
        lastDay = dayKey;
      }
      const shiftNight = slotIsNight(sh.start, sh.end);
      html += `<div class="shift-card${shiftNight ? ' night' : ''}">
        <div class="shift-hours"><span dir="ltr">${fmtTime(sh.start)}–${fmtTime(sh.end)}</span>${shiftNight ? ' <span class="moon">🌙</span>' : ''}</div>
        <div class="shift-people">`;
      for (let seat = 0; seat < +p.count; seat++) {
        const key = slotKey(p.id, sh.index, seat);
        const sl = slots[key];
        if (!sl) continue;
        let cls = 'slot ', label = '', flag = '';
        if (!sl.soldierId) { cls += 'empty'; label = 'לא מאויש'; }
        else {
          label = soldierName(sl.soldierId);
          if (sl.manual) cls += 'manual'; else cls += 'auto';
          if (sl.violation) cls += ' violation';
          if (sl.overlap) flag = '<span class="warn-flag">כפילות!</span>';
          else if (sl.violation) flag = '<span class="warn-flag">מנוחה קצרה</span>';
          if (isAbsent(sl.soldierId)) { cls += ' violation'; flag = '<span class="warn-flag">חסר!</span>'; }
        }
        html += `<div class="${cls}" data-key="${key}" title="לחץ לעדכון ידני"><span class="slot-name">${label}</span>${flag}</div>`;
      }
      html += '</div></div>';
    });
    if (lastDay !== null) html += '</div>'; // סגירת קבוצת היום האחרונה
    html += '</section>';
  });
  html += '</div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.slot').forEach(el => {
    el.onclick = () => openEditModal(el.dataset.key);
  });
}

/* ================= עדכון ידני (מודאל) ================= */
let editingKey = null;
function openEditModal(key) {
  editingKey = key;
  const sl = state.schedule.slots[key];
  const p = state.positions.find(x => x.id === sl.posId);
  $('editModalTitle').textContent = `עדכון ידני — ${p ? p.name : ''}`;
  $('editModalInfo').textContent = `${fmtDay(sl.start)} ${fmtDate(sl.start)} · ‎${fmtTime(sl.start)}–${fmtTime(sl.end)}‎`;
  const sel = $('editModalSelect');
  sel.innerHTML = '<option value="">— ריק —</option>';
  // רק לוחמים נוכחים שאינם חסומים לעמדה זו; חסר/חסום לא ניתן להכניס
  state.soldiers.filter(s => s.present && !(s.blocked || []).includes(sl.posId)).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    if (s.id === sl.soldierId) opt.selected = true;
    sel.appendChild(opt);
  });
  $('editModal').classList.add('open');
}

/* ================= מודאל הגבלות עמדה ללוחם ================= */
let blockingSoldierId = null;
function openBlockModal(soldierId) {
  blockingSoldierId = soldierId;
  const s = state.soldiers.find(x => x.id === soldierId);
  if (!s) return;
  if (!Array.isArray(s.blocked)) s.blocked = [];
  $('blockModalTitle').textContent = `הגבלות עמדה — ${s.name}`;
  const list = $('blockModalList');
  if (!state.positions.length) {
    list.innerHTML = '<p class="hint">אין עדיין עמדות. הוסף עמדות תחילה.</p>';
  } else {
    list.innerHTML = state.positions.map(p =>
      `<label class="block-item"><input type="checkbox" value="${p.id}" ${s.blocked.includes(p.id) ? 'checked' : ''}>
       <span>${p.type === 'משימה' ? '🎯' : '🛡️'} ${p.name} <small>(${p.type})</small></span></label>`
    ).join('');
  }
  $('blockModal').classList.add('open');
}
function closeBlockModal() { $('blockModal').classList.remove('open'); blockingSoldierId = null; }
function saveBlockModal() {
  const s = state.soldiers.find(x => x.id === blockingSoldierId);
  if (s) {
    s.blocked = [...$('blockModalList').querySelectorAll('input:checked')].map(i => i.value);
    recomputeFlags();
  }
  commit();
  closeBlockModal();
}

/* ================= מודאל עריכת עמדה/משימה ================= */
let editingPosId = null;
function openPosModal(id) {
  const p = state.positions.find(x => x.id === id);
  if (!p) return;
  editingPosId = id;
  $('posEditName').value = p.name;
  $('posEditType').value = p.type;
  $('posEditShiftLen').value = p.shiftLen;
  $('posEditCount').value = p.count;
  $('posModal').classList.add('open');
}
function closePosModal() { $('posModal').classList.remove('open'); editingPosId = null; }
function savePosModal() {
  const p = state.positions.find(x => x.id === editingPosId);
  if (!p) return closePosModal();
  const name = $('posEditName').value.trim();
  if (!name) { $('posEditName').focus(); return; }
  const newLen = +$('posEditShiftLen').value || p.shiftLen;
  const newCount = +$('posEditCount').value || p.count;
  // שינוי אורך משמרת/כמות משנה את מבנה המשמרות — השיבוץ הקיים כבר לא תואם
  const structChanged = (newLen !== +p.shiftLen || newCount !== +p.count) && !!state.schedule;
  if (structChanged && !confirm('שינוי אורך המשמרת או כמות הלוחמים משנה את מבנה המשמרות.\nהשיבוץ הקיים לא יתאים ותצטרך ליצור שיבוץ מחדש.\n\nלהמשיך?')) return;

  p.name = name;
  p.type = $('posEditType').value;
  p.shiftLen = newLen;
  p.count = newCount;
  ensureShifts();
  recomputeFlags(); // שינוי סוג (למשל לכיתת כוננות) מעדכן מיד את דגלי החריגה
  commit();
  closePosModal();
  if (structChanged) alert('העמדה עודכנה. מומלץ ללחוץ "צור שיבוץ אוטומטי" כדי לבנות שיבוץ תואם.');
}

function closeEditModal() { $('editModal').classList.remove('open'); editingKey = null; }
function saveEditModal() {
  if (!editingKey) return;
  const sl = state.schedule.slots[editingKey];
  const val = $('editModalSelect').value;
  sl.soldierId = val || null;
  sl.manual = true;
  recomputeFlags();
  commit();
  closeEditModal();
}
function clearEditModal() {
  if (!editingKey) return;
  const sl = state.schedule.slots[editingKey];
  sl.soldierId = null; sl.manual = true;
  recomputeFlags(); commit(); closeEditModal();
}

/* ================= שיתוף בוואטסאפ ================= */
function scheduleToText() {
  const s = state.schedule;
  let txt = `🎖️ שבצ"ק\n${fmtDay(s.startMs)} ${fmtDate(s.startMs)} ${fmtTime(s.startMs)} — ${fmtDay(s.endMs)} ${fmtDate(s.endMs)} ${fmtTime(s.endMs)}\n`;
  state.positions.forEach(p => {
    txt += `\n🎯 ${p.name}\n`;
    p._shifts.forEach(sh => {
      const names = [];
      for (let seat = 0; seat < +p.count; seat++) {
        const sl = s.slots[slotKey(p.id, sh.index, seat)];
        if (sl && sl.soldierId) { const so = state.soldiers.find(x => x.id === sl.soldierId); names.push(so ? so.name : '?'); }
        else names.push('— חסר —');
      }
      txt += `  ‎${fmtTime(sh.start)}-${fmtTime(sh.end)}‎ | ${names.join(', ')}\n`;
    });
  });
  return txt;
}
function soldierToText(soldierId) {
  const s = state.schedule;
  const so = state.soldiers.find(x => x.id === soldierId);
  const mine = [];
  Object.values(s.slots).forEach(sl => {
    if (sl.soldierId === soldierId) {
      const p = state.positions.find(x => x.id === sl.posId);
      mine.push({ start: sl.start, end: sl.end, name: p ? p.name : '' });
    }
  });
  mine.sort((a, b) => a.start - b.start);
  let txt = `🎖️ שבצ"ק אישי — ${so ? so.name : ''}\n`;
  if (!mine.length) txt += '\nאין משמרות משובצות.\n';
  mine.forEach(m => { txt += `\n${fmtDay(m.start)} ${fmtDate(m.start)} ‎${fmtTime(m.start)}-${fmtTime(m.end)}‎ · ${m.name}`; });
  const totalH = mine.reduce((a, m) => a + (m.end - m.start) / HOUR, 0);
  txt += `\n\nסה"כ: ${mine.length} משמרות · ${totalH} שעות`;
  return txt;
}
function openWhatsApp(text) {
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}

/* ================= סטטיסטיקות ================= */
function statsFromSlots(slots, soldiersMeta) {
  // soldiersMeta: [{key(name), present}] ; slots use resolved names
  const map = {};
  const ensure = name => map[name] || (map[name] = { name, hours: 0, shifts: 0, positions: new Set(), night: 0, day: 0, shortRest: 0, present: true });
  soldiersMeta.forEach(s => { const m = ensure(s.name); m.present = s.present; });
  slots.forEach(sl => {
    if (!sl.name) return;
    const m = ensure(sl.name);
    m.hours += (sl.end - sl.start) / HOUR;
    m.shifts += 1;
    m.positions.add(sl.pos);
    if (slotIsNight(sl.start, sl.end)) m.night += 1; else m.day += 1;
    if (sl.violation) m.shortRest += 1;
  });
  return Object.values(map).map(m => ({ ...m, positions: m.positions.size }));
}

function collectCurrent() {
  if (!state.schedule) return { rows: [], meta: [] };
  const slots = Object.values(state.schedule.slots).filter(s => s.soldierId).map(sl => {
    const so = state.soldiers.find(x => x.id === sl.soldierId);
    const p = state.positions.find(x => x.id === sl.posId);
    return { start: sl.start, end: sl.end, name: so ? so.name : '?', pos: p ? p.name : '?', violation: sl.violation };
  });
  const meta = state.soldiers.map(s => ({ name: s.name, present: s.present }));
  return { rows: statsFromSlots(slots, meta), meta };
}
function collectHistory() {
  const slots = [], metaMap = {};
  state.history.forEach(h => {
    (h.slots || []).forEach(sl => slots.push(sl));
    (h.soldiers || []).forEach(s => { if (!(s.name in metaMap)) metaMap[s.name] = s.present; });
  });
  const meta = Object.keys(metaMap).map(name => ({ name, present: metaMap[name] }));
  return { rows: statsFromSlots(slots, meta), meta };
}

function renderStats() {
  const src = $('statsSource').value;
  const { rows } = src === 'all' ? collectHistory() : collectCurrent();
  rows.sort((a, b) => b.hours - a.hours);

  // כרטיסי סיכום
  const totalHours = rows.reduce((a, r) => a + r.hours, 0);
  const totalShifts = rows.reduce((a, r) => a + r.shifts, 0);
  const present = rows.filter(r => r.present).length;
  const avg = rows.length ? (totalHours / rows.length).toFixed(1) : 0;
  $('statsSummary').innerHTML = `
    <div class="stat-card"><div class="num">${rows.length}</div><div class="lbl">לוחמים</div></div>
    <div class="stat-card"><div class="num">${present}</div><div class="lbl">נוכחים</div></div>
    <div class="stat-card hl"><div class="num">${totalHours}</div><div class="lbl">סה"כ שעות שמירה</div></div>
    <div class="stat-card"><div class="num">${totalShifts}</div><div class="lbl">סה"כ משמרות</div></div>
    <div class="stat-card"><div class="num">${avg}</div><div class="lbl">ממוצע שעות ללוחם</div></div>
    <div class="stat-card"><div class="num">${state.history.length}</div><div class="lbl">סבבים בהיסטוריה</div></div>`;

  const maxH = Math.max(1, ...rows.map(r => r.hours));
  const tb = $('statsTable').querySelector('tbody'); tb.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name}</td>
      <td><span class="status-dot ${r.present ? 'present' : 'absent'}"></span>${r.present ? 'נוכח' : 'חסר'}</td>
      <td class="bar-cell"><div class="bar" style="width:${(r.hours / maxH * 100).toFixed(0)}%"></div><span>${r.hours}</span></td>
      <td>${r.shifts}</td><td>${r.positions}</td><td>${r.night}</td><td>${r.day}</td>
      <td>${r.shortRest ? '⚠️ ' + r.shortRest : '0'}</td>`;
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = `<tr><td colspan="8" class="empty-state">אין נתונים להצגה.</td></tr>`;

  // היסטוריה
  const hl = $('historyList');
  hl.innerHTML = state.history.length ? '<h2 style="color:var(--khaki-dark)">📜 סבבים שמורים</h2>' : '';
  state.history.slice().reverse().forEach(h => {
    const div = document.createElement('div');
    div.className = 'history-item';
    const d = new Date(h.savedAt);
    div.innerHTML = `<div><strong>${h.label}</strong><div class="meta">נשמר: ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${(h.slots || []).length} שיבוצים</div></div>
      <button class="btn danger ghost small">מחק</button>`;
    div.querySelector('button').onclick = () => { state.history = state.history.filter(x => x.id !== h.id); commit(); };
    hl.appendChild(div);
  });
}

function exportCSV() {
  const src = $('statsSource').value;
  const { rows } = src === 'all' ? collectHistory() : collectCurrent();
  const header = ['לוחם', 'סטטוס', 'סהכ שעות', 'משמרות', 'עמדות שונות', 'לילה', 'יום', 'מנוחה קצרה'];
  const lines = [header.join(',')];
  rows.forEach(r => lines.push([r.name, r.present ? 'נוכח' : 'חסר', r.hours, r.shifts, r.positions, r.night, r.day, r.shortRest].join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shibutz-stats-${Date.now()}.csv`;
  a.click();
}

/* ================= שמירת סבב להיסטוריה ================= */
function archiveCurrent(silent) {
  if (!state.schedule) { if (!silent) alert('אין שיבוץ לשמירה.'); return false; }
  const slots = Object.values(state.schedule.slots).filter(s => s.soldierId).map(sl => {
    const so = state.soldiers.find(x => x.id === sl.soldierId);
    const p = state.positions.find(x => x.id === sl.posId);
    // standby נשמר כדי שהמשכיות המנוחה בין סבבים תדע שזו הייתה כוננות (מנוחה מוקלת)
    return { start: sl.start, end: sl.end, name: so ? so.name : '?', pos: p ? p.name : '?', standby: isStandbyPos(sl.posId), violation: !!sl.violation };
  });
  const label = `${fmtDate(state.schedule.startMs)} ${fmtTime(state.schedule.startMs)} — ${fmtDate(state.schedule.endMs)} ${fmtTime(state.schedule.endMs)}`;
  state.history.push({
    id: uid(), savedAt: Date.now(), label,
    config: { ...state.config },
    soldiers: state.soldiers.map(s => ({ name: s.name, present: s.present })),
    slots,
  });
  if (!silent) { commit(); alert('הסבב נשמר להיסטוריה ✓'); }
  return true;
}

/* ================= המשך לסבב הבא (המשכיות רציפה) ================= */
function continueRound() {
  if (!state.schedule) { alert('אין סבב נוכחי. צור שיבוץ תחילה, ואז תוכל להמשיך ממנו.'); return; }
  const endMs = state.schedule.endMs;
  const msg = 'הסבב הנוכחי יישמר להיסטוריה, וייווצר סבב חדש שמתחיל בדיוק בסיומו.\n\n' +
    'ההמשכיות תישמר: מי שירד ממשמרת בסוף הסבב יקבל מנוחה, והסבב בעמדות/משימות ימשיך לפי ההיסטוריה.\n' +
    '(לוחמים חסרים לא ישובצו; עדכונים ידניים בסבב הקודם כבר נשמרו בהיסטוריה.)\n\nלהמשיך?';
  if (!confirm(msg)) return;
  archiveCurrent(true);                      // שומר את הסבב הנוכחי (בשקט)
  state.config.startDateTime = toLocalInput(endMs); // הסבב החדש מתחיל בדיוק בסיום הקודם
  generateSchedule(false);                   // המנוע מתחשב בהיסטוריה + במנוחה שנגררת מהסבב הקודם
  commit();
  alert(`נוצר סבב חדש בהמשך לקודם ✓\nמתחיל: ${fmtDay(endMs)} ${fmtDate(endMs)} ${fmtTime(endMs)}`);
}

/* ================= commit — רינדור + שמירה ================= */
function commit() {
  saveState();
  renderSetup();
  renderSchedule();
  renderWarnings();
  renderStats();
}

/* ================= חיבור אירועים ================= */
function bindEvents() {
  // טאבים
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-' + t.dataset.tab).classList.add('active');
  });

  // הגדרות תצורה
  const bindCfg = (id, key, num) => $(id).oninput = () => { state.config[key] = num ? +$(id).value : $(id).value; commit(); };
  bindCfg('startDateTime', 'startDateTime', false);
  bindCfg('durationHours', 'durationHours', true);
  bindCfg('restHours', 'restHours', true);
  bindCfg('nightStart', 'nightStart', true);
  bindCfg('nightEnd', 'nightEnd', true);
  bindCfg('standbyRestNight', 'standbyRestNight', true);

  // לוחמים
  $('addBulkSoldiers').onclick = () => {
    const names = $('bulkSoldiers').value.split('\n').map(s => s.trim()).filter(Boolean);
    names.forEach(n => state.soldiers.push({ id: uid(), name: n, present: true, blocked: [] }));
    $('bulkSoldiers').value = '';
    commit();
  };

  // עמדות
  $('addPos').onclick = () => {
    const name = $('posName').value.trim();
    if (!name) { $('posName').focus(); return; }
    state.positions.push({
      id: uid(), name, type: $('posType').value,
      shiftLen: +$('posShiftLen').value || 2, count: +$('posCount').value || 1,
    });
    $('posName').value = '';
    commit();
  };

  // שיבוץ
  $('btnGenerate').onclick = () => {
    if (!state.positions.length) { alert('הוסף עמדות תחילה.'); return; }
    if (!state.soldiers.filter(s => s.present).length) { alert('אין לוחמים נוכחים לשיבוץ.'); return; }
    generateSchedule(false); commit();
  };
  $('btnRegenKeepManual').onclick = () => { if (!state.schedule) { generateSchedule(false); } else { generateSchedule(true); } commit(); };
  $('btnClearSchedule').onclick = () => { if (confirm('לנקות את השיבוץ הנוכחי?')) { state.schedule = null; commit(); } };

  $('btnWhatsAppAll').onclick = () => { if (!state.schedule) { alert('אין שיבוץ.'); return; } openWhatsApp(scheduleToText()); };
  $('btnWhatsAppSoldier').onclick = () => {
    if (!state.schedule) { alert('אין שיבוץ.'); return; }
    const list = state.soldiers;
    if (!list.length) return;
    const menu = list.map((s, idx) => `${idx + 1}. ${s.name}`).join('\n');
    const ans = prompt('בחר לוחם לפי מספר:\n' + menu);
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < list.length) openWhatsApp(soldierToText(list[idx].id));
  };
  $('btnContinueRound').onclick = continueRound;
  $('btnArchive').onclick = () => archiveCurrent(false);

  // מודאל עדכון ידני
  $('editModalSave').onclick = saveEditModal;
  $('editModalClear').onclick = clearEditModal;
  $('editModalCancel').onclick = closeEditModal;
  $('editModal').onclick = e => { if (e.target === $('editModal')) closeEditModal(); };

  // מודאל הגבלות עמדה
  $('blockModalSave').onclick = saveBlockModal;
  $('blockModalCancel').onclick = closeBlockModal;
  $('blockModal').onclick = e => { if (e.target === $('blockModal')) closeBlockModal(); };

  // מודאל עריכת עמדה/משימה
  $('posEditSave').onclick = savePosModal;
  $('posEditCancel').onclick = closePosModal;
  $('posModal').onclick = e => { if (e.target === $('posModal')) closePosModal(); };

  // סטטיסטיקות
  $('statsSource').onchange = renderStats;
  $('btnExportStats').onclick = exportCSV;
  $('btnClearHistory').onclick = () => { if (confirm('למחוק את כל ההיסטוריה השמורה?')) { state.history = []; commit(); } };

  // שיתוף
  $('btnShareApp').onclick = shareApp;
  $('btnRefreshShare').onclick = renderShareLinks;
}

/* ================= שיתוף האפליקציה ================= */
let shareInfo = { lan: [], public: null };
async function renderShareLinks() {
  const box = $('shareLinks');
  if (!box) return;
  try {
    const res = await api('/api/share-info');
    shareInfo = await res.json();
  } catch (e) { return; }
  const cur = location.origin.startsWith('http') ? location.origin : null;
  let html = '';
  if (shareInfo.public) html += `<div class="link-row public"><span class="lbl">🌍 מכל מקום:</span> <a href="${shareInfo.public}" target="_blank">${shareInfo.public}</a></div>`;
  if (cur && !cur.includes('localhost') && cur !== shareInfo.public) html += `<div class="link-row"><span class="lbl">🔗 כתובת נוכחית:</span> <a href="${cur}" target="_blank">${cur}</a></div>`;
  (shareInfo.lan || []).forEach(u => html += `<div class="link-row"><span class="lbl">📶 באותה רשת:</span> <a href="${u}" target="_blank">${u}</a></div>`);
  if (!shareInfo.public) html += `<p class="hint">🌍 לגישה מכל מקום (דאטה סלולרי): הפעל את <b>start-share.cmd</b> ואז לחץ "רענן קישורים".</p>`;
  box.innerHTML = html || '<p class="hint">אין קישורים זמינים.</p>';
}
function bestShareUrl() {
  if (shareInfo.public) return shareInfo.public;
  const cur = location.origin;
  if (cur.startsWith('http') && !cur.includes('localhost')) return cur;
  return (shareInfo.lan && shareInfo.lan[0]) || cur;
}
function shareApp() {
  const url = bestShareUrl();
  const msg = `🎖️ שבצ"ק — לצפייה ולעריכת השמירות:\n${url}`;
  if (url.includes('localhost')) alert('הכתובת הנוכחית מקומית בלבד. הפעל את start-share.cmd כדי לקבל לינק שאפשר לשתף.');
  openWhatsApp(msg);
}

/* ================= מסך כניסה (רק כשהשרת דורש קוד) ================= */
function showGate(err) {
  const gate = $('authGate');
  if (!gate) return;
  gate.classList.add('open');
  $('authErr').textContent = err || '';
  setTimeout(() => $('authInput').focus(), 50);
}
function hideGate() { const g = $('authGate'); if (g) g.classList.remove('open'); }
async function handleLogin() {
  const code = $('authInput').value.trim();
  if (!code) return;
  $('authErr').textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await res.json();
    if (!res.ok || !data.ok) { $('authErr').textContent = data.error || 'שגיאה'; return; }
    setToken(data.token);
    hideGate();
    await startApp();
  } catch (e) { $('authErr').textContent = 'שגיאת חיבור לשרת'; }
}

let appStarted = false;
async function startApp() {
  await loadState();
  if (!appStarted) { bindEvents(); appStarted = true; }
  renderSetup();
  renderSchedule();
  renderWarnings();
  renderStats();
  renderShareLinks();
}

/* ================= אתחול ================= */
(async function init() {
  // כפתורי מסך הכניסה
  if ($('authSubmit')) {
    $('authSubmit').onclick = handleLogin;
    $('authInput').onkeydown = e => { if (e.key === 'Enter') handleLogin(); };
  }
  let required = false;
  try { required = (await (await fetch('/api/auth-status')).json()).required; } catch (e) {}
  if (!required) { hideGate(); return startApp(); }        // מקומי — ללא קוד
  // ענן — נדרש קוד. בדוק אסימון קיים
  if (TOKEN) {
    try {
      const r = await fetch('/api/state', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (r.status !== 401) { hideGate(); return startApp(); }
    } catch (e) {}
    setToken(null);
  }
  showGate();
})();
