// api/tts.js
// Node.js Serverless function for Vercel (NOT Edge)
// Uses ElevenLabs to synthesize speech and returns audio/mpeg

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.set(CORS_HEADERS);
    return res.status(200).end();
  }

  // Quick health/hint
  if (req.method === 'GET') {
    res.set(CORS_HEADERS);
    return res.status(200).json({
      ok: true,
      hint: 'POST { text, voiceId?, voice? ("alt"), model? }',
    });
  }

  if (req.method !== 'POST') {
    res.set(CORS_HEADERS);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const defaultVoice = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const altVoice = process.env.ELEVENLABS_ALT_VOICE_ID;

  if (!apiKey) {
    res.set(CORS_HEADERS);
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set' });
  }
  if (!defaultVoice) {
    res.set(CORS_HEADERS);
    return res.status(500).json({ error: 'ELEVENLABS_DEFAULT_VOICE_ID is not set' });
  }

  const { text, voiceId, voice, model = 'eleven_monolingual_v1' } = req.body || {};
  if (!text || typeof text !== 'string') {
    res.set(CORS_HEADERS);
    return res.status(400).json({ error: 'Missing "text" (string)' });
  }

  // Resolve voice: explicit > "alt" > default
  const resolvedVoice =
    voiceId || (voice === 'alt' && altVoice) || defaultVoice;

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoice}/stream?optimize_streaming_latency=2`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: model,
          // Tweak to taste:
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
            style: 0.0,
            use_speaker_boost: true,
          },
          // output_format: 'mp3_44100_128' // optional
        }),
      }
    );

    if (!r.ok) {
      const details = await r.text().catch(() => '');
      res.set(CORS_HEADERS);
      return res
        .status(502)
        .json({ error: `ElevenLabs ${r.status}`, details: details.slice(0, 600) });
    }

    // Return the audio as mp3
    const arrayBuffer = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.set({
      ...CORS_HEADERS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    });
    return res.status(200).send(buffer);
  } catch (e) {
    res.set(CORS_HEADERS);
    return res.status(500).json({ error: 'TTS request failed', details: e.message });
  }
};
