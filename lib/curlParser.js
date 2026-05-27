export function parseCurl(curlString) {
  try {
    const str = curlString.replace(/\\\n/g, ' ').replace(/\\\r\n/g, ' ').trim();

    // Extract serviceToken
    let serviceToken = null;
    const stPatterns = [
      /serviceToken="([^"]+)"/,
      /serviceToken=([^;"\s]+)/
    ];
    for (const pat of stPatterns) {
      const m = str.match(pat);
      if (m) { serviceToken = m[1]; break; }
    }

    // Extract userId
    let userId = null;
    const uidPatterns = [
      /userId=(\d+)/,
      /userId="(\d+)"/
    ];
    for (const pat of uidPatterns) {
      const m = str.match(pat);
      if (m) { userId = m[1]; break; }
    }

    // Extract xiaomichatbot_ph
    let phToken = null;
    const phPatterns = [
      /xiaomichatbot_ph="([^"]+)"/,
      /xiaomichatbot_ph=([^;"\s&]+)/,
      /xiaomichatbot_ph=([^'"&\s]+)/
    ];
    for (const pat of phPatterns) {
      const m = str.match(pat);
      if (m) { phToken = m[1]; break; }
    }

    // Also try URL-encoded ph from the URL itself
    if (!phToken) {
      const urlPhMatch = str.match(/xiaomichatbot_ph=([^&\s'"]+)/);
      if (urlPhMatch) {
        phToken = decodeURIComponent(urlPhMatch[1]);
      }
    }

    if (!serviceToken) return { error: 'Could not extract serviceToken from cURL' };
    if (!userId) return { error: 'Could not extract userId from cURL' };
    if (!phToken) return { error: 'Could not extract xiaomichatbot_ph from cURL' };

    return { serviceToken, userId, phToken };
  } catch (e) {
    return { error: `Parse error: ${e.message}` };
  }
}
