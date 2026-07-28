// netlify/functions/tts.js
//
// This is a serverless proxy: the browser (admin.html) sends it plain text,
// it calls Google's Gemini text-to-speech model using the secret
// GEMINI_API_KEY (stored in Netlify Environment Variables — never exposed to
// the browser), and sends back a ready-to-play WAV audio file as base64.
//
// Gemini's TTS models return raw PCM audio (not a playable file by itself),
// so this function wraps that PCM data into a proper WAV file before
// sending it back, so the browser can play/decode it directly.

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed. Use POST.' })
        };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'GEMINI_API_KEY environment variable is not set on Netlify.' })
        };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    const text = (payload.text || '').trim();
    const voiceName = payload.voice || 'Kore'; // default voice
    if (!text) {
        return { statusCode: 400, body: JSON.stringify({ error: '"text" field is required.' }) };
    }

    // Model name can be swapped later (e.g. to a newer TTS-preview model)
    // without changing anything else in this function.
    const MODEL = 'gemini-2.5-flash-preview-tts';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    try {
        const geminiResp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: text }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } }
                    }
                }
            })
        });

        const data = await geminiResp.json();

        if (!geminiResp.ok) {
            return {
                statusCode: geminiResp.status,
                body: JSON.stringify({ error: data.error || data })
            };
        }

        const part = data && data.candidates && data.candidates[0] &&
            data.candidates[0].content && data.candidates[0].content.parts &&
            data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].inlineData;

        if (!part || !part.data) {
            return {
                statusCode: 502,
                body: JSON.stringify({ error: 'Gemini did not return any audio.', raw: data })
            };
        }

        const pcmBuffer = Buffer.from(part.data, 'base64');
        const mimeType = part.mimeType || 'audio/L16;rate=24000';
        const rateMatch = mimeType.match(/rate=(\d+)/);
        const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

        const wavBuffer = pcmToWav(pcmBuffer, sampleRate, 1, 16);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                audioBase64: wavBuffer.toString('base64'),
                mimeType: 'audio/wav',
                sampleRate: sampleRate
            })
        };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};

// Wraps raw 16-bit PCM audio data in a standard WAV file header so browsers
// can play it directly via new Audio() / <audio> / decodeAudioData().
function pcmToWav(pcmBuffer, sampleRate, channels, bitDepth) {
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmBuffer.length;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(buffer, 44);

    return buffer;
}
