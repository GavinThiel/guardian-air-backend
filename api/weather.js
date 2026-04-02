export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { icao } = req.query;
  if (!icao) return res.status(400).json({ error: 'ICAO required' });

  const base = 'https://aviationweather.gov/api/data';

  try {
    const [metarRes, tafRes, notamRes] = await Promise.all([
      fetch(`${base}/metar?ids=${icao}&format=raw`),
      fetch(`${base}/taf?ids=${icao}&format=raw`),
      fetch(`${base}/notam?icaoLocation=${icao}&format=json`)
    ]);

    const metar = await metarRes.text();
    const taf = await tafRes.text();
    const notamJson = await notamRes.json().catch(() => []);

    const notams = Array.isArray(notamJson)
      ? notamJson.slice(0, 8).map(n => ({
          id: n.notamID || n.id || '',
          text: n.traditionalMessage || n.message || n.text || ''
        }))
      : [];

    res.status(200).json({
      metar: metar.trim() || null,
      taf: taf.trim() || null,
      notams
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
