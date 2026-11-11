const plan = document.querySelector('[data-date]');
const taskBoxes = Array.from(plan.querySelectorAll('input[data-task]'));
const progress = document.getElementById('progress');
const progressText = document.getElementById('progress-text');
const currentTitle = document.getElementById('current-title');
const currentDetail = document.getElementById('current-detail');
const jump = document.getElementById('jump-current');
const storageKey = 'ruspet.day-plan.' + plan.dataset.date;

function loadChecked() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

function updateProgress() {
  const completed = taskBoxes.filter(box => box.checked);
  progress.max = taskBoxes.length;
  progress.value = completed.length;
  progressText.textContent = completed.length + ' из ' + taskBoxes.length;
  return completed;
}

const checked = loadChecked();
for (const box of taskBoxes) box.checked = checked.has(box.dataset.task);
updateProgress();
plan.addEventListener('change', event => {
  if (!taskBoxes.includes(event.target)) return;
  const completed = updateProgress();
  try {
    localStorage.setItem(storageKey, JSON.stringify(completed.map(box => box.dataset.task)));
  } catch {
    // The checkboxes still work while the page is open.
  }
});

const seconds = value => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60;
};
const slots = Array.from(plan.querySelectorAll('[data-start]'), row => ({
  row,
  start: seconds(row.dataset.start),
  end: seconds(row.dataset.end),
  title: row.querySelector('h2').textContent,
}));
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

let current;
function updateClock() {
  const parts = Object.fromEntries(clock.formatToParts().map(part => [part.type, part.value]));
  const date = [parts.year, parts.month, parts.day].join('-');
  const time = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const next = date === plan.dataset.date ? slots.find(slot => slot.start <= time && time < slot.end) : undefined;
  if (next !== current) {
    current?.row.classList.remove('is-current');
    next?.row.classList.add('is-current');
    current = next;
  }
  jump.hidden = !current;
  const moscow = parts.hour + ':' + parts.minute + ' МСК';
  if (current) {
    currentTitle.textContent = current.title;
    currentDetail.textContent = moscow + ' · до конца блока ' + Math.ceil((current.end - time) / 60) + ' мин';
  } else {
    currentTitle.textContent = date > plan.dataset.date || date === plan.dataset.date && time >= slots.at(-1).end
      ? 'Рабочий день по плану завершён'
      : 'Первый блок в ' + slots[0].row.dataset.start;
    currentDetail.textContent = 'Сейчас ' + moscow;
  }
}

jump.addEventListener('click', () => current?.row.scrollIntoView({block: 'center'}));
updateClock();
setInterval(updateClock, 15000);
