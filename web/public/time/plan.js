const el = id => document.getElementById(id);
const parts = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow', dateStyle:'short', timeStyle:'short', hourCycle:'h23'});
const monthName = new Intl.DateTimeFormat('ru-RU', {month:'long', year:'numeric', timeZone:'UTC'});
const dayName = new Intl.DateTimeFormat('ru-RU', {weekday:'long', day:'numeric', month:'long', timeZone:'UTC'});
const stamp = date => new Date(date + 'T00:00:00Z');
const moscow = () => parts.format(new Date()).split(' ');
const minutesText = minutes => Math.floor(minutes/60) + ':' + String(minutes%60).padStart(2,'0');

let today = moscow()[0], selected = today, days = [], status, plan = [];
let busy = false, workDirty = false, planDirty = false;
const current = () => days.find(day => day.date === selected);

function announce(text, error = false) {
  el('notice').textContent = text;
  el('notice').hidden = !text;
  el('notice').classList.toggle('error', error);
}
async function request(url, body, method = 'PUT') {
  const options = body === undefined ? {} : {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)};
  const response = await fetch('/api' + url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Действие не выполнено.');
  return data;
}
async function run(action) {
  if (busy) return;
  busy = true;
  el('work-fields').disabled = el('plan-fields').disabled = true;
  try {
    await action();
  } catch (error) {
    announce(error.message || 'Попробуйте ещё раз.', true);
  } finally {
    busy = false;
    el('work-fields').disabled = el('plan-fields').disabled = false;
  }
}
function canNavigate() {
  return !busy && (!(workDirty || planDirty) || confirm('Уйти со страницы дня без сохранения изменений?'));
}

function renderCalendar() {
  const month = selected.slice(0,7);
  el('month').value = month;
  el('month-label').textContent = monthName.format(stamp(month + '-01'));
  el('export').href = '/api/time/report.csv?month=' + month;
  const recorded = days.filter(day => day.minutes !== null);
  const total = recorded.reduce((sum, day) => sum + day.minutes, 0);
  el('total').textContent = Math.floor(total/60) + ' ч' + (total%60 ? ' ' + total%60 + ' мин' : '');
  el('logged-days').textContent = String(recorded.length);
  el('missing').disabled = !days.some(day => day.date <= today && day.minutes === null);
  const fragment = document.createDocumentFragment();
  for (const weekday of ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']) {
    const label = document.createElement('span');
    label.className = 'weekday';
    label.textContent = weekday;
    fragment.append(label);
  }
  const offset = (stamp(month + '-01').getUTCDay() + 6)%7;
  for (let i=0; i<offset; i++) fragment.append(document.createElement('span'));
  for (const day of days) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-cell';
    button.classList.toggle('today', day.date === today);
    button.classList.toggle('has-hours', day.minutes !== null);
    button.setAttribute('aria-pressed', String(day.date === selected));
    const hours = day.minutes === null ? (day.date <= today ? '—' : '') : minutesText(day.minutes);
    const workLabel = hours && hours !== '—' ? ' · ' + hours : day.date <= today ? ' · часы не указаны' : '';
    button.setAttribute('aria-label', dayName.format(stamp(day.date)) + workLabel + (day.plan?.length ? ' · есть план' : ''));
    const date = document.createElement('span');
    date.textContent = String(Number(day.date.slice(-2)));
    if (day.plan?.length) date.classList.add('has-plan');
    const value = document.createElement('small');
    value.textContent = hours;
    button.append(date, value);
    button.onclick = () => {
      if (day.date === selected || !canNavigate()) return;
      selected = day.date;
      renderCalendar();
      renderDay();
      el('day-label').focus({preventScroll:true});
      if (matchMedia('(max-width: 780px)').matches) el('day-label').scrollIntoView({block:'start'});
    };
    fragment.append(button);
  }
  el('calendar').replaceChildren(fragment);
}

function renderTelegram() {
  el('telegram-state').textContent = status.linked ? 'Подключён' : 'Ждёт привязки';
  el('telegram-state').classList.toggle('connected', status.linked);
  const prompt = {sent:'Сегодняшний вопрос отправлен.', sending:'Доставка ожидает подтверждения.', unconfirmed:'Telegram не подтвердил доставку. Часы можно заполнить здесь.'}[status.promptState];
  el('telegram-info').textContent = !status.botEnabled ? 'Бот сейчас отключён в системе.'
    : status.linked ? (prompt || 'Ответ на вечернее сообщение появится в календаре.')
    : 'Откройте личную ссылку на своём аккаунте Telegram и нажмите Start. Затем обновите страницу.';
  el('pair').hidden = status.linked || !status.botEnabled || !el('pair-link').hidden;
  el('reminders-control').hidden = !status.linked;
  el('reminders').checked = status.reminders;
  if (status.linked) {
    el('pair-link').hidden = true;
    el('pair-link').removeAttribute('href');
  }
}

function editPlan() {
  planDirty = true;
  el('save-plan').disabled = false;
  updatePlanProgress();
}
function updatePlanProgress() {
  const items = plan.flatMap(block => block.items);
  el('check-progress').textContent = items.length ? items.filter(item => item.done).length + ' из ' + items.length + ' выполнено' : '';
}
function renderPlan() {
  el('empty-plan').hidden = plan.length > 0;
  el('add-block').disabled = plan.length >= 30;
  const [,now] = moscow();
  const fragment = document.createDocumentFragment();
  for (const [index,block] of plan.entries()) {
    const node = el('block-template').content.firstElementChild.cloneNode(true);
    const title = node.querySelector('.block-title');
    const start = node.querySelector('[data-start]');
    const end = node.querySelector('[data-end]');
    const add = node.querySelector('[data-add-item]');
    node.classList.toggle('active-block', selected === today && !!block.start && !!block.end && block.start <= now && now < block.end);
    for (const [input,key] of [[title,'title'],[start,'start'],[end,'end']]) {
      input.value = block[key];
      input.oninput = () => { block[key] = input.value; editPlan(); };
    }
    node.querySelector('[data-remove-block]').onclick = () => { plan.splice(index,1); editPlan(); renderPlan(); };
    const list = node.querySelector('[data-items]');
    for (const [itemIndex,item] of block.items.entries()) {
      const row = el('item-template').content.firstElementChild.cloneNode(true);
      const [check,text] = row.querySelectorAll('input');
      check.checked = item.done;
      text.value = item.text;
      check.onchange = () => { item.done = check.checked; row.classList.toggle('done',item.done); editPlan(); };
      text.oninput = () => { item.text = text.value; editPlan(); };
      row.classList.toggle('done', item.done);
      row.querySelector('button').onclick = () => { block.items.splice(itemIndex,1); editPlan(); renderPlan(); };
      list.append(row);
    }
    add.disabled = block.items.length >= 20;
    add.onclick = () => {
      block.items.push({id:crypto.randomUUID(), text:'', done:false});
      editPlan();
      renderPlan();
      el('blocks').children[index].querySelector('.plan-item:last-child input[type=text]').focus();
    };
    fragment.append(node);
  }
  el('blocks').replaceChildren(fragment);
  updatePlanProgress();
}
function renderDay() {
  const day = current();
  el('day-label').textContent = dayName.format(stamp(day.date));
  el('day-label').tabIndex = -1;
  el('work-form').hidden = day.date > today;
  el('future').hidden = day.date <= today;
  el('hours').value = day.minutes === null ? '' : minutesText(day.minutes);
  el('note').value = day.note;
  el('work-state').textContent = day.minutes === null ? 'Часы не указаны' : 'Записано ' + minutesText(day.minutes);
  workDirty = planDirty = false;
  plan = structuredClone(day.plan || []);
  el('save-plan').disabled = true;
  if (day.initialPlan) {
    try {
      const old = JSON.parse(localStorage.getItem('ruspet.day-plan.' + day.date) || '[]');
      const items = plan.flatMap(block => block.items);
      if (Array.isArray(old) && items.some(item => old.includes(item.id))) {
        for (const item of items) item.done = old.includes(item.id);
        editPlan();
        announce('Отметки из прежнего планера загружены. Сохраните план, чтобы видеть их с других устройств.');
      }
    } catch {}
  }
  renderPlan();
}
function loadDate(date) {
  if (!canNavigate()) return;
  run(async () => {
    const data = await request('/time/month?month=' + date.slice(0,7));
    selected = date;
    today = data.today;
    days = data.days;
    status = data.status;
    announce('');
    renderCalendar();
    renderDay();
    renderTelegram();
    el('workspace').hidden = el('export').hidden = false;
  });
}
function shiftMonth(by) {
  const date = stamp(selected.slice(0,7) + '-01');
  date.setUTCMonth(date.getUTCMonth()+by);
  const month = date.toISOString().slice(0,7);
  if (month >= '1900-01' && month <= '9998-12') loadDate(month === today.slice(0,7) ? today : month + '-01');
}
el('prev').onclick = () => shiftMonth(-1);
el('next').onclick = () => shiftMonth(1);
el('today').onclick = () => loadDate(moscow()[0]);
el('refresh').onclick = () => loadDate(selected);
el('month').onchange = event => {
  const month = event.target.value;
  if (month && event.target.validity.valid) loadDate(month === today.slice(0,7) ? today : month + '-01');
  event.target.value = selected.slice(0,7);
};
el('missing').onclick = () => {
  if (!canNavigate()) return;
  const missing = days.filter(day => day.date <= today && day.minutes === null);
  const day = missing.find(day => day.date > selected) || missing[0];
  if (!day) return;
  if (day.date !== selected) {
    selected = day.date;
    renderCalendar();
    renderDay();
  }
  el('hours').focus();
};
el('work-form').oninput = () => {
  workDirty = true;
  el('work-state').textContent = 'Есть изменения';
};
el('work-form').onsubmit = event => {
  event.preventDefault();
  const value = el('hours').value.trim();
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  const minutes = match ? Number(match[1])*60+Number(match[2]) : null;
  if (value && (minutes === null || minutes > 1440)) {
    announce('Укажите время в формате 7:30, максимум 24:00.', true);
    el('hours').focus();
    return;
  }
  run(async () => {
    const saved = await request('/time/days/' + selected + '/work', {minutes, note:el('note').value, loggedAt:current().loggedAt});
    Object.assign(current(), {minutes:saved.minutes, note:saved.note, loggedAt:saved.loggedAt});
    workDirty = false;
    el('hours').value = minutes === null ? '' : minutesText(minutes);
    el('note').value = saved.note;
    el('work-state').textContent = minutes === null ? 'Часы не указаны' : 'Записано ' + minutesText(minutes);
    renderCalendar();
    announce('Запись за ' + dayName.format(stamp(selected)) + ' сохранена.');
  });
};
el('add-block').onclick = () => {
  plan.push({start:'',end:'',title:'',items:[]});
  editPlan();
  renderPlan();
  el('blocks').lastElementChild.querySelector('.block-title').focus();
};
el('plan-form').onsubmit = event => {
  event.preventDefault();
  if (plan.some(block => block.start && block.end && block.start >= block.end)) {
    announce('Время окончания блока должно быть позже начала.', true);
    return;
  }
  run(async () => {
    const saved = await request('/time/days/' + selected + '/plan', plan);
    Object.assign(current(), {plan:saved.plan, initialPlan:false});
    plan = structuredClone(saved.plan);
    planDirty = false;
    el('save-plan').disabled = true;
    renderPlan();
    renderCalendar();
    announce('План сохранён.');
  });
};
el('pair').onclick = () => run(async () => {
  const {url} = await request('/telegram/pairing', {}, 'POST');
  el('pair-link').href = url;
  el('pair-link').hidden = false;
  el('pair').hidden = true;
  announce('Ссылка действует 15 минут. Откройте её в своём Telegram.');
});
el('reminders').onchange = () => run(async () => {
  const enabled = el('reminders').checked;
  el('reminders').checked = status.reminders;
  const data = await request('/time/reminders', {enabled});
  status.reminders = data.enabled;
  renderTelegram();
  announce(data.enabled ? 'Вечернее напоминание включено.' : 'Вечернее напоминание выключено.');
});
window.addEventListener('beforeunload', event => {
  if (workDirty || planDirty) {
    event.preventDefault();
    event.returnValue = true;
  }
});
loadDate(today);
