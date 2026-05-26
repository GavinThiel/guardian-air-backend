// Guardian Air – Cloudflare Worker
// Upload this file via Cloudflare Dashboard → Workers → Create Worker → paste/upload

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ─── WEATHER ────────────────────────────────────────────────────────────────

async function handleWeather(url) {
  const icao = url.searchParams.get('icao');
  if (!icao) return json({ error: 'ICAO required' }, 400);

  const base = 'https://aviationweather.gov/api/data';
  const [metarRes, tafRes, notamRes] = await Promise.all([
    fetch(`${base}/metar?ids=${icao}&format=raw`),
    fetch(`${base}/taf?ids=${icao}&format=raw`),
    fetch(`${base}/notam?icaoLocation=${icao}&format=json`),
  ]);

  const metar = await metarRes.text();
  const taf = await tafRes.text();
  const notamJson = await notamRes.json().catch(() => []);

  const notams = Array.isArray(notamJson)
    ? notamJson.slice(0, 8).map(n => ({
        id: n.notamID || n.id || '',
        text: n.traditionalMessage || n.message || n.text || '',
      }))
    : [];

  return json({ metar: metar.trim() || null, taf: taf.trim() || null, notams });
}

// ─── ROSTER ─────────────────────────────────────────────────────────────────

// 7/2 7/2 7/3 pattern: 28-day cycle, 21 duty / 7 off (75% utilisation)
const CYCLE_LENGTH = 28;
const CYCLE_MAP = (() => {
  const pattern = [
    { status: 'DUTY', days: 7 }, { status: 'OFF', days: 2 },
    { status: 'DUTY', days: 7 }, { status: 'OFF', days: 2 },
    { status: 'DUTY', days: 7 }, { status: 'OFF', days: 3 },
  ];
  const map = new Array(CYCLE_LENGTH);
  let pos = 0;
  for (const block of pattern) {
    for (let i = 0; i < block.days; i++) map[pos++] = block.status;
  }
  return map;
})();

function statusOnDay(cycleOffset, dayIndex) {
  const pos = ((dayIndex + cycleOffset) % CYCLE_LENGTH + CYCLE_LENGTH) % CYCLE_LENGTH;
  return CYCLE_MAP[pos];
}

function toISO(date) { return date.toISOString().slice(0, 10); }
function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }

function handleRoster(url) {
  const startDate = url.searchParams.get('startDate') || toISO(new Date());
  const days      = Math.min(Math.max(parseInt(url.searchParams.get('days')      || '28',  10), 1), 365);
  const groups    = Math.min(Math.max(parseInt(url.searchParams.get('groups')    || '4',   10), 1), 28);

  const start = new Date(startDate + 'T00:00:00Z');
  if (isNaN(start)) return json({ error: `Invalid startDate: ${startDate}` }, 400);

  let names;
  const crewParam = url.searchParams.get('crew');
  if (crewParam) {
    names = crewParam.split(',').map(n => n.trim()).filter(Boolean);
  } else {
    const count = Math.min(Math.max(parseInt(url.searchParams.get('crewCount') || '20', 10), 1), 10000);
    names = Array.from({ length: count }, (_, i) => `Crew ${i + 1}`);
  }

  const crew = names.map((name, i) => {
    const group = i % groups;
    return { name, group, cycleOffset: Math.floor((group * CYCLE_LENGTH) / groups) };
  });

  const dailySchedule = [];
  for (let d = 0; d < days; d++) {
    const date = toISO(addDays(start, d));
    const onDuty = [], offDuty = [];
    for (const m of crew) {
      (statusOnDay(m.cycleOffset, d) === 'DUTY' ? onDuty : offDuty).push(m.name);
    }
    dailySchedule.push({ date, onDuty, offDuty, totalOnDuty: onDuty.length, totalOffDuty: offDuty.length });
  }

  const crewSchedules = {};
  for (const m of crew) {
    crewSchedules[m.name] = {
      group: m.group,
      cycleOffset: m.cycleOffset,
      days: Array.from({ length: days }, (_, d) => ({
        date: toISO(addDays(start, d)),
        status: statusOnDay(m.cycleOffset, d),
      })),
    };
  }

  return json({
    meta: {
      pattern: '7/2 7/2 7/3', cycleLength: CYCLE_LENGTH,
      dutyDaysPerCycle: 21, offDaysPerCycle: 7, utilisationPct: 75,
      startDate: toISO(start), days, crewCount: names.length, groups,
      groupOffsets: Array.from({ length: groups }, (_, g) => ({
        group: g, cycleOffset: Math.floor((g * CYCLE_LENGTH) / groups),
      })),
    },
    dailySchedule,
    crewSchedules,
  });
}

// ─── FTL CHECK ───────────────────────────────────────────────────────────────

const FDP_LIMITS   = { 1: 780, 2: 750, 3: 720, 4: 690, 5: 660, 6: 630 };
const MAX_DAILY    = 540;
const MAX_7DAY     = 3600;
const MAX_28DAY    = 6000;
const MIN_REST     = 600;
const MIN_REST_EXT = 660;

async function handleFtlCheck(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { duties: raw } = body || {};
  if (!Array.isArray(raw) || !raw.length) return json({ error: '`duties` array is required' }, 400);

  const duties = raw.map((d, i) => {
    if (!d.date)          throw new Error(`duties[${i}].date required (YYYY-MM-DD)`);
    if (!d.departureTime) throw new Error(`duties[${i}].departureTime required (HH:MM UTC)`);
    if (!d.endTime && !d.fdpMins) throw new Error(`duties[${i}] needs endTime or fdpMins`);

    const start = new Date(`${d.date}T${d.departureTime}:00Z`);
    if (isNaN(start)) throw new Error(`Invalid date/time at duties[${i}]`);

    let fdpMins;
    if (d.fdpMins) {
      fdpMins = parseInt(d.fdpMins, 10);
    } else {
      let end = new Date(`${d.date}T${d.endTime}:00Z`);
      if (end <= start) end = new Date(end.getTime() + 86400000);
      fdpMins = Math.round((end - start) / 60000);
    }

    const sectors    = parseInt(d.sectors, 10) || 1;
    const flightMins = parseInt(d.totalFlightMins, 10) || Math.round(fdpMins * 0.8);
    return { index: i, date: d.date, start, fdpMins, sectors, flightMins };
  }).sort((a, b) => a.start - b.start);

  const results = [];
  let cumulativeFlightMins = 0;

  for (let i = 0; i < duties.length; i++) {
    const duty = duties[i];
    const violations = [], warnings = [];

    const fdpLimit = FDP_LIMITS[Math.min(duty.sectors, 6)] ?? 600;
    if (duty.fdpMins > fdpLimit)
      violations.push(`FDP ${duty.fdpMins} min exceeds limit of ${fdpLimit} min for ${duty.sectors} sector(s)`);
    else if (duty.fdpMins > fdpLimit - 30)
      warnings.push(`FDP ${duty.fdpMins} min is within 30 min of the ${fdpLimit} min limit`);

    if (duty.flightMins > MAX_DAILY)
      violations.push(`Daily flight time ${duty.flightMins} min exceeds 540 min (9 h) limit`);

    if (i > 0) {
      const prev    = duties[i - 1];
      const prevEnd = new Date(prev.start.getTime() + prev.fdpMins * 60000);
      const rest    = Math.round((duty.start - prevEnd) / 60000);
      const req     = prev.fdpMins > 600 ? MIN_REST_EXT : MIN_REST;
      if (rest < req) violations.push(`Rest ${rest} min is below required ${req} min`);
    }

    const ago7  = new Date(duty.start.getTime() - 7  * 86400000);
    const ago28 = new Date(duty.start.getTime() - 28 * 86400000);
    const r7    = duties.slice(0, i + 1).filter(d => d.start >= ago7 ).reduce((s, d) => s + d.flightMins, 0);
    const r28   = duties.slice(0, i + 1).filter(d => d.start >= ago28).reduce((s, d) => s + d.flightMins, 0);

    if (r7  > MAX_7DAY)  violations.push(`Rolling 7-day flight time ${r7} min exceeds ${MAX_7DAY} min`);
    if (r28 > MAX_28DAY) violations.push(`Rolling 28-day flight time ${r28} min exceeds ${MAX_28DAY} min`);

    cumulativeFlightMins += duty.flightMins;
    results.push({
      index: duty.index, date: duty.date,
      fdpMins: duty.fdpMins, fdpLimitMins: fdpLimit,
      flightMins: duty.flightMins, sectors: duty.sectors,
      rolling7DayFlightMins: r7, rolling28DayFlightMins: r28,
      compliant: violations.length === 0, violations, warnings,
    });
  }

  const totalViolations = results.reduce((s, r) => s + r.violations.length, 0);
  return json({
    compliant: totalViolations === 0,
    totalDuties: duties.length, totalViolations, cumulativeFlightMins,
    limits: { FDP_LIMITS, maxDailyFlightMins: MAX_DAILY, maxWeeklyFlightMins: MAX_7DAY, max28DayFlightMins: MAX_28DAY, minRestMins: MIN_REST },
    results,
  });
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    const url      = new URL(request.url);
    const method   = request.method;
    const path     = url.pathname.replace(/\/$/, '');

    if (method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });

    try {
      if (path === '/api/weather'   && method === 'GET')  return await handleWeather(url);
      if (path === '/api/roster'    && method === 'GET')  return handleRoster(url);
      if (path === '/api/ftl-check' && method === 'POST') return await handleFtlCheck(request);

      return json({ error: 'Not found', availableRoutes: [
        'GET  /api/weather?icao=EGLL',
        'GET  /api/roster?startDate=YYYY-MM-DD&crewCount=N&days=N&groups=N',
        'POST /api/ftl-check',
      ]}, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
