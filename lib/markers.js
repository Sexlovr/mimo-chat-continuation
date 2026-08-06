// Zero-width markers for per-message session tracking.
//
// Uses U+200B (ZWSP) and U+2060 (WORD JOINER) to encode the id as bits, with
// U+200C (ZWNJ) as the sentinel delimiter. All three are category "Cf" (Format):
//   - genuinely zero-width in browser renderers (SillyTavern/Janitor)
//   - NOT removed by String.prototype.trim() (Cf is not whitespace)
//   - preserved through NFC/NFD normalization
//   - NOT "tagged ASCII" (unlike U+E0000+ plane-14 tag chars, which some
//     renderers/fonts de-tag into visible glyphs) -> reliably invisible here.
// Payload (ZWSP/WJ) never contains ZWNJ, so the delimiters are unambiguous.
//
// Layout appended to every pro assistant reply:
//   <visible reply>\u200C<64 zero-width bits>\u200C
// Each hex char of the id -> 4 bits (ZWSP=0, WJ=1); 16 hex chars => 64 bits.

const ZERO = '\u200B';   // bit 0
const ONE  = '\u2060';   // bit 1
const SENT = '\u200C';   // sentinel delimiter (ZWNJ)
const MARKER_RE = /\u200C([\u200B\u2060]+?)\u200C/g;

import crypto from 'crypto';

export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(c => c && c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('\n');
    }
    return '';
}

export function genMarkerId() {
    // 16 hex chars = 64 bits; encodes to 64 zero-width chars.
    return crypto.randomBytes(8).toString('hex');
}

export function genSessionId() {
    return 'sess_' + crypto.randomBytes(8).toString('hex');
}

export function encodeMarker(id) {
    let bits = '';
    for (const c of String(id)) {
        const v = parseInt(c, 16);
        bits += (v & 8) ? ONE : ZERO;
        bits += (v & 4) ? ONE : ZERO;
        bits += (v & 2) ? ONE : ZERO;
        bits += (v & 1) ? ONE : ZERO;
    }
    return SENT + bits + SENT;
}

export function decodeMarker(text) {
    if (!text) return null;
    MARKER_RE.lastIndex = 0;
    const m = MARKER_RE.exec(text);
    if (!m) return null;
    const bits = m[1];
    if (bits.length < 8 || bits.length % 4 !== 0) return null; // not our marker
    let id = '';
    for (let i = 0; i + 4 <= bits.length; i += 4) {
        let v = 0;
        for (let j = 0; j < 4; j++) v = (v << 1) | (bits[i + j] === ONE ? 1 : 0);
        id += v.toString(16);
    }
    return id;
}

export function stripMarkers(text) {
    return String(text || '').replace(MARKER_RE, '');
}

/**
 * Locate the continuation point in an OpenAI messages array.
 *
 * Rule (handles continuation, regeneration/swipe, delete-and-restart, fork):
 *   parent = the latest ASSISTANT message carrying our marker that comes
 *            BEFORE the latest USER message.
 *   prompt = the latest USER message.
 *
 * If no marked assistant precedes the latest user message => birth (null).
 */
export function findContinuationParent(messages) {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUser = i; break; }
    }
    if (lastUser < 0) return null;
    for (let i = lastUser - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const text = contentToText(m.content);
        const id = decodeMarker(text);
        if (id) {
            return {
                markerId: id,
                parentIndex: i,
                userIndex: lastUser,
                userText: contentToText(messages[lastUser].content)
            };
        }
    }
    return null;
}
