const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestGet({ request }) {
  const { searchParams } = new URL(request.url);
  const icao = searchParams.get('icao');
  if (!icao) {
    return new Response(JSON.stringify({ error: 'ICAO required' }), { status: 400, headers: CORS });
  }

  const base = 'https://aviationweather.gov/api/data';

  try {
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

    return new Response(JSON.stringify({ metar: metar.trim() || null, taf: taf.trim() || null, notams }), {
      status: 200,
      headers: CORS,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}
