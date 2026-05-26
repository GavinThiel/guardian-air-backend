// Flight Time Limitations checker (aligned with EASA ORO.FTL / CAO 48 principles)
// POST /api/ftl-check
// Body: { duties: [ { date, departureTime, sectors, totalFlightMins } ] }
// Returns compliance status for each duty period and rolling totals.

const MAX_FDP_BY_SECTORS = {
  // [sectors]: max FDP minutes (EASA ORO.FTL.205 Table 1, early start 06:00–13:59 UTC)
  1: 13 * 60,
  2: 12 * 60 + 30,
  3: 12 * 60,
  4: 11 * 60 + 30,
  5: 11 * 60,
  6: 10 * 60 + 30,
};
const MAX_FDP_DEFAULT = 10 * 60; // ≥7 sectors or unspecified

const MAX_DAILY_FLIGHT_MINS = 9 * 60;          // 9 hours
const MAX_WEEKLY_FLIGHT_MINS = 60 * 60;        // 60 hours in any 7 consecutive days
const MAX_28DAY_FLIGHT_MINS = 100 * 60;        // 100 hours in any 28 consecutive days
const MAX_ANNUAL_FLIGHT_MINS = 1000 * 60;      // 1000 hours per calendar year
const MIN_REST_MINS = 10 * 60;                 // 10 hours minimum rest between duties (FDP ≤ 13 h)
const MIN_REST_EXTENDED_MINS = 11 * 60;        // 11 h if FDP > 10 h

function maxFdpMins(sectors) {
  const s = Math.min(sectors || 1, 6);
  return MAX_FDP_BY_SECTORS[s] ?? MAX_FDP_DEFAULT;
}

function parseDateTime(dateStr, timeStr) {
  // timeStr: "HH:MM" UTC
  const dt = new Date(`${dateStr}T${timeStr}:00Z`);
  if (isNaN(dt)) throw new Error(`Invalid date/time: ${dateStr} ${timeStr}`);
  return dt;
}

function minutesBetween(a, b) {
  return Math.round((b - a) / 60000);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { duties: rawDuties } = body || {};
  if (!Array.isArray(rawDuties) || rawDuties.length === 0) {
    return res.status(400).json({ error: '`duties` array is required' });
  }

  try {
    // Parse and sort duties chronologically
    const duties = rawDuties.map((d, i) => {
      if (!d.date) throw new Error(`duties[${i}].date is required (YYYY-MM-DD)`);
      if (!d.departureTime) throw new Error(`duties[${i}].departureTime is required (HH:MM UTC)`);
      if (!d.endTime && !d.fdpMins) throw new Error(`duties[${i}] needs endTime (HH:MM UTC) or fdpMins`);

      const start = parseDateTime(d.date, d.departureTime);
      let fdpMins;
      if (d.fdpMins) {
        fdpMins = parseInt(d.fdpMins, 10);
      } else {
        const end = parseDateTime(d.date, d.endTime);
        fdpMins = minutesBetween(start, end <= start ? new Date(end.getTime() + 86400000) : end);
      }
      const sectors = parseInt(d.sectors, 10) || 1;
      const flightMins = parseInt(d.totalFlightMins, 10) || Math.round(fdpMins * 0.8);

      return { index: i, date: d.date, start, fdpMins, sectors, flightMins };
    }).sort((a, b) => a.start - b.start);

    const results = [];
    let cumulativeFlightMins = 0;

    for (let i = 0; i < duties.length; i++) {
      const duty = duties[i];
      const violations = [];
      const warnings = [];

      // 1. FDP limit
      const fdpLimit = maxFdpMins(duty.sectors);
      if (duty.fdpMins > fdpLimit) {
        violations.push(`FDP ${duty.fdpMins} min exceeds limit of ${fdpLimit} min for ${duty.sectors} sector(s)`);
      } else if (duty.fdpMins > fdpLimit - 30) {
        warnings.push(`FDP ${duty.fdpMins} min is within 30 min of the ${fdpLimit} min limit`);
      }

      // 2. Daily flight time
      if (duty.flightMins > MAX_DAILY_FLIGHT_MINS) {
        violations.push(`Daily flight time ${duty.flightMins} min exceeds 9-hour (${MAX_DAILY_FLIGHT_MINS} min) limit`);
      }

      // 3. Rest before this duty (gap from previous duty end)
      if (i > 0) {
        const prev = duties[i - 1];
        const prevEnd = new Date(prev.start.getTime() + prev.fdpMins * 60000);
        const restMins = minutesBetween(prevEnd, duty.start);
        const requiredRest = prev.fdpMins > 10 * 60 ? MIN_REST_EXTENDED_MINS : MIN_REST_MINS;
        if (restMins < requiredRest) {
          violations.push(`Rest period ${restMins} min is below required ${requiredRest} min after a ${prev.fdpMins}-min FDP`);
        }
      }

      // 4. Rolling 7-day flight time
      const sevenDaysAgo = new Date(duty.start.getTime() - 7 * 86400000);
      const rolling7 = duties
        .slice(0, i + 1)
        .filter(d => d.start >= sevenDaysAgo)
        .reduce((s, d) => s + d.flightMins, 0);
      if (rolling7 > MAX_WEEKLY_FLIGHT_MINS) {
        violations.push(`Rolling 7-day flight time ${rolling7} min exceeds ${MAX_WEEKLY_FLIGHT_MINS} min limit`);
      }

      // 5. Rolling 28-day flight time
      const twentyEightDaysAgo = new Date(duty.start.getTime() - 28 * 86400000);
      const rolling28 = duties
        .slice(0, i + 1)
        .filter(d => d.start >= twentyEightDaysAgo)
        .reduce((s, d) => s + d.flightMins, 0);
      if (rolling28 > MAX_28DAY_FLIGHT_MINS) {
        violations.push(`Rolling 28-day flight time ${rolling28} min exceeds ${MAX_28DAY_FLIGHT_MINS} min limit`);
      }

      cumulativeFlightMins += duty.flightMins;

      results.push({
        index: duty.index,
        date: duty.date,
        fdpMins: duty.fdpMins,
        fdpLimitMins: fdpLimit,
        flightMins: duty.flightMins,
        sectors: duty.sectors,
        rolling7DayFlightMins: rolling7,
        rolling28DayFlightMins: rolling28,
        compliant: violations.length === 0,
        violations,
        warnings,
      });
    }

    const totalViolations = results.reduce((s, r) => s + r.violations.length, 0);

    res.status(200).json({
      compliant: totalViolations === 0,
      totalDuties: duties.length,
      totalViolations,
      cumulativeFlightMins,
      limits: {
        maxFdpBySectors: MAX_FDP_BY_SECTORS,
        maxDailyFlightMins: MAX_DAILY_FLIGHT_MINS,
        maxWeeklyFlightMins: MAX_WEEKLY_FLIGHT_MINS,
        max28DayFlightMins: MAX_28DAY_FLIGHT_MINS,
        maxAnnualFlightMins: MAX_ANNUAL_FLIGHT_MINS,
        minRestMins: MIN_REST_MINS,
      },
      results,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
