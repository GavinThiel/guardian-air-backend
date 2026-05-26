const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const MAX_FDP_BY_SECTORS = { 1: 780, 2: 750, 3: 720, 4: 690, 5: 660, 6: 630 };
const MAX_FDP_DEFAULT = 600;
const MAX_DAILY_FLIGHT_MINS = 540;
const MAX_WEEKLY_FLIGHT_MINS = 3600;
const MAX_28DAY_FLIGHT_MINS = 6000;
const MAX_ANNUAL_FLIGHT_MINS = 60000;
const MIN_REST_MINS = 600;
const MIN_REST_EXTENDED_MINS = 660;

function maxFdpMins(sectors) {
  return MAX_FDP_BY_SECTORS[Math.min(sectors || 1, 6)] ?? MAX_FDP_DEFAULT;
}

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS });
  }

  const { duties: rawDuties } = body || {};
  if (!Array.isArray(rawDuties) || rawDuties.length === 0) {
    return new Response(JSON.stringify({ error: '`duties` array is required' }), { status: 400, headers: CORS });
  }

  try {
    const duties = rawDuties.map((d, i) => {
      if (!d.date) throw new Error(`duties[${i}].date required (YYYY-MM-DD)`);
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

      const fdpLimit = maxFdpMins(duty.sectors);
      if (duty.fdpMins > fdpLimit) {
        violations.push(`FDP ${duty.fdpMins} min exceeds limit of ${fdpLimit} min for ${duty.sectors} sector(s)`);
      } else if (duty.fdpMins > fdpLimit - 30) {
        warnings.push(`FDP ${duty.fdpMins} min is within 30 min of the ${fdpLimit} min limit`);
      }

      if (duty.flightMins > MAX_DAILY_FLIGHT_MINS) {
        violations.push(`Daily flight time ${duty.flightMins} min exceeds 540 min (9 h) limit`);
      }

      if (i > 0) {
        const prev = duties[i - 1];
        const prevEnd = new Date(prev.start.getTime() + prev.fdpMins * 60000);
        const restMins = Math.round((duty.start - prevEnd) / 60000);
        const requiredRest = prev.fdpMins > 600 ? MIN_REST_EXTENDED_MINS : MIN_REST_MINS;
        if (restMins < requiredRest) {
          violations.push(`Rest ${restMins} min is below required ${requiredRest} min`);
        }
      }

      const sevenDaysAgo = new Date(duty.start.getTime() - 7 * 86400000);
      const rolling7 = duties.slice(0, i + 1).filter(d => d.start >= sevenDaysAgo).reduce((s, d) => s + d.flightMins, 0);
      if (rolling7 > MAX_WEEKLY_FLIGHT_MINS) {
        violations.push(`Rolling 7-day flight time ${rolling7} min exceeds ${MAX_WEEKLY_FLIGHT_MINS} min`);
      }

      const twentyEightDaysAgo = new Date(duty.start.getTime() - 28 * 86400000);
      const rolling28 = duties.slice(0, i + 1).filter(d => d.start >= twentyEightDaysAgo).reduce((s, d) => s + d.flightMins, 0);
      if (rolling28 > MAX_28DAY_FLIGHT_MINS) {
        violations.push(`Rolling 28-day flight time ${rolling28} min exceeds ${MAX_28DAY_FLIGHT_MINS} min`);
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

    return new Response(JSON.stringify({
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
    }), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: CORS });
  }
}
