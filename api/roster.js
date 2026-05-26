// 7/2 7/2 7/3 roster pattern: 28-day cycle, 21 duty / 7 off (75% utilisation)
const PATTERN = [
  { status: 'DUTY', days: 7 },
  { status: 'OFF',  days: 2 },
  { status: 'DUTY', days: 7 },
  { status: 'OFF',  days: 2 },
  { status: 'DUTY', days: 7 },
  { status: 'OFF',  days: 3 },
];

const CYCLE_LENGTH = 28;

// Pre-built lookup: position in cycle → status
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

function isoToDate(str) {
  const d = new Date(str + 'T00:00:00Z');
  if (isNaN(d)) throw new Error(`Invalid date: ${str}`);
  return d;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

// Assign each crew member a group and derive their cycle offset.
// Groups are spread evenly through the 28-day cycle so coverage is continuous.
function buildCrew(names, groups) {
  return names.map((name, i) => {
    const group = i % groups;
    // Spread groups evenly: group g starts at floor(g * 28 / groups)
    const cycleOffset = Math.floor((group * CYCLE_LENGTH) / groups);
    return { name, group, cycleOffset };
  });
}

function generateNames(count) {
  return Array.from({ length: count }, (_, i) => `Crew ${i + 1}`);
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      startDate = toISO(new Date()),
      days: daysParam = '28',
      crewCount: countParam,
      crew: crewParam,
      groups: groupsParam = '4',
    } = req.query;

    // Parse & validate
    const start = isoToDate(startDate);
    const days = Math.min(Math.max(parseInt(daysParam, 10) || 28, 1), 365);
    const groups = Math.min(Math.max(parseInt(groupsParam, 10) || 4, 1), 28);

    let names;
    if (crewParam) {
      names = crewParam.split(',').map(n => n.trim()).filter(Boolean);
    } else {
      const count = Math.min(Math.max(parseInt(countParam, 10) || 20, 1), 10000);
      names = generateNames(count);
    }

    const crew = buildCrew(names, groups);

    // Build per-day summary
    const dailySchedule = [];
    for (let d = 0; d < days; d++) {
      const date = toISO(addDays(start, d));
      const onDuty = [];
      const offDuty = [];
      for (const member of crew) {
        if (statusOnDay(member.cycleOffset, d) === 'DUTY') {
          onDuty.push(member.name);
        } else {
          offDuty.push(member.name);
        }
      }
      dailySchedule.push({ date, onDuty, offDuty, totalOnDuty: onDuty.length, totalOffDuty: offDuty.length });
    }

    // Build per-crew schedule
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

    res.status(200).json({
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
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
