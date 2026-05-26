const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// 7/2 7/2 7/3 pattern: 28-day cycle, 21 duty / 7 off (75% utilisation)
const PATTERN = [
  { status: 'DUTY', days: 7 },
  { status: 'OFF',  days: 2 },
  { status: 'DUTY', days: 7 },
  { status: 'OFF',  days: 2 },
  { status: 'DUTY', days: 7 },
  { status: 'OFF',  days: 3 },
];

const CYCLE_LENGTH = 28;

const CYCLE_MAP = (() => {
  const map = new Array(CYCLE_LENGTH);
  let pos = 0;
  for (const block of PATTERN) {
    for (let i = 0; i < block.days; i++) map[pos++] = block.status;
  }
  return map;
})();

function statusOnDay(cycleOffset, dayIndex) {
  const pos = ((dayIndex + cycleOffset) % CYCLE_LENGTH + CYCLE_LENGTH) % CYCLE_LENGTH;
  return CYCLE_MAP[pos];
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

function buildCrew(names, groups) {
  return names.map((name, i) => {
    const group = i % groups;
    const cycleOffset = Math.floor((group * CYCLE_LENGTH) / groups);
    return { name, group, cycleOffset };
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestGet({ request }) {
  const { searchParams } = new URL(request.url);

  try {
    const startDate = searchParams.get('startDate') || toISO(new Date());
    const days = Math.min(Math.max(parseInt(searchParams.get('days') || '28', 10), 1), 365);
    const groups = Math.min(Math.max(parseInt(searchParams.get('groups') || '4', 10), 1), 28);

    const start = new Date(startDate + 'T00:00:00Z');
    if (isNaN(start)) throw new Error(`Invalid startDate: ${startDate}`);

    let names;
    const crewParam = searchParams.get('crew');
    if (crewParam) {
      names = crewParam.split(',').map(n => n.trim()).filter(Boolean);
    } else {
      const count = Math.min(Math.max(parseInt(searchParams.get('crewCount') || '20', 10), 1), 10000);
      names = Array.from({ length: count }, (_, i) => `Crew ${i + 1}`);
    }

    const crew = buildCrew(names, groups);

    const dailySchedule = [];
    for (let d = 0; d < days; d++) {
      const date = toISO(addDays(start, d));
      const onDuty = [];
      const offDuty = [];
      for (const member of crew) {
        (statusOnDay(member.cycleOffset, d) === 'DUTY' ? onDuty : offDuty).push(member.name);
      }
      dailySchedule.push({ date, onDuty, offDuty, totalOnDuty: onDuty.length, totalOffDuty: offDuty.length });
    }

    const crewSchedules = {};
    for (const member of crew) {
      crewSchedules[member.name] = {
        group: member.group,
        cycleOffset: member.cycleOffset,
        days: Array.from({ length: days }, (_, d) => ({
          date: toISO(addDays(start, d)),
          status: statusOnDay(member.cycleOffset, d),
        })),
      };
    }

    const body = JSON.stringify({
      meta: {
        pattern: '7/2 7/2 7/3',
        cycleLength: CYCLE_LENGTH,
        dutyDaysPerCycle: 21,
        offDaysPerCycle: 7,
        utilisationPct: 75,
        startDate: toISO(start),
        days,
        crewCount: names.length,
        groups,
        groupOffsets: Array.from({ length: groups }, (_, g) => ({
          group: g,
          cycleOffset: Math.floor((g * CYCLE_LENGTH) / groups),
        })),
      },
      dailySchedule,
      crewSchedules,
    });

    return new Response(body, { status: 200, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: CORS });
  }
}
