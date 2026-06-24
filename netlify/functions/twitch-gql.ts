import { Handler } from '@netlify/functions';
import axios from 'axios';

let cachedIntegrityToken = '';
let integrityTokenExpiry = 0;

async function getIntegrityToken(token: string): Promise<string> {
  const now = Date.now();
  if (cachedIntegrityToken && integrityTokenExpiry > now + 60000) {
    return cachedIntegrityToken;
  }

  try {
    const headers: Record<string, string> = {
      'Client-ID': 'kimne7iekaqgq7vqcsq7z4ff5nywb9',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.twitch.tv',
      'Referer': 'https://www.twitch.tv/',
    };

    if (token) {
      headers['Authorization'] = token.toLowerCase().startsWith('oauth ') ? token : `OAuth ${token}`;
    }

    console.log('[Netlify Integrity] Fetching new Twitch integrity token...');
    const res = await axios.post('https://gql.twitch.tv/integrity', {}, { headers, timeout: 5000 });
    
    if (res.data?.token) {
      cachedIntegrityToken = res.data.token;
      integrityTokenExpiry = res.data.expiration || (Date.now() + 1800000);
      console.log(`[Netlify Integrity] Cached token. Expires: ${new Date(integrityTokenExpiry).toISOString()}`);
      return cachedIntegrityToken;
    }
  } catch (error: any) {
    console.error('[Netlify Integrity] Failed to fetch integrity token:', error.message);
  }

  return '';
}

const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = event.body ? JSON.parse(event.body) : {};
  const { opName } = body;

  try {
    console.log(`[Netlify Proxy] Process ${opName || 'unknown'}`);
    let token = process.env.TWITCH_OAUTH_TOKEN ? process.env.TWITCH_OAUTH_TOKEN.trim() : '';
    
    // Exclude obvious placeholder strings or empty values
    if (
      token && (
        token.toUpperCase().includes('YOUR_') || 
        token.toUpperCase().includes('DUMMY') || 
        token.toUpperCase().includes('PLACEHOLDER') || 
        token.length < 5
      )
    ) {
      token = '';
    }

    // 1. Prepare unauthenticated fallback headers (using Mobile Client ID)
    const fallbackHeaders: Record<string, string> = {
      'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID
      'Content-Type': 'application/json',
      'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
    };

    // 2. Choose active request headers
    let requestHeaders: Record<string, string>;
    if (token) {
      requestHeaders = {
        'Client-ID': 'kimne7iekaqgq7vqcsq7z4ff5nywb9', // Web Client ID
        'Content-Type': 'application/json',
        'Authorization': token.toLowerCase().startsWith('oauth ') ? token : `OAuth ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.twitch.tv',
        'Referer': 'https://www.twitch.tv/',
      };

      const integrityToken = await getIntegrityToken(token);
      if (integrityToken) {
        requestHeaders['Client-Integrity'] = integrityToken;
      }
      console.log('[Netlify Proxy] Using Authenticated Web Client ID with Browser Headers & Client-Integrity');
    } else {
      requestHeaders = { ...fallbackHeaders };
      console.log('[Netlify Proxy] Using Unauthenticated Mobile Client ID');
    }

    try {
      let response = await axios.post('https://gql.twitch.tv/gql', body, {
        headers: requestHeaders,
      });

      // Handle GraphQL integrity check or authentication errors embedded in a successful 200 response
      const hasIntegrityOrAuthError = !!response.data?.errors?.some((err: any) => 
        err.message?.toLowerCase().includes('failed integrity check') ||
        err.code === 'IntegrityCheckFailed' ||
        err.message?.toLowerCase().includes('authorization') ||
        err.message?.toLowerCase().includes('invalid oauth')
      );

      if (hasIntegrityOrAuthError && requestHeaders['Authorization']) {
        // If the Web Client ID failed with an integrity error, first retry using the Authenticated Mobile Client ID (no integrity requirement)
        if (requestHeaders['Client-ID'] !== '85lcqzxpb9bqu9z6ga1ol55du') {
          try {
            console.log('[Netlify Proxy] Web Client ID failed integrity/auth. Retrying with Authenticated Mobile Client ID...');
            const authenticatedMobileHeaders = {
              'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du',
              'Content-Type': 'application/json',
              'Authorization': token.toLowerCase().startsWith('oauth ') ? token : `OAuth ${token}`,
              'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
            };
            const mobileAuthResponse = await axios.post('https://gql.twitch.tv/gql', body, {
              headers: authenticatedMobileHeaders,
            });

            const mobileHasIntegrityOrAuthError = !!mobileAuthResponse.data?.errors?.some((err: any) => 
              err.message?.toLowerCase().includes('failed integrity check') ||
              err.code === 'IntegrityCheckFailed' ||
              err.message?.toLowerCase().includes('authorization') ||
              err.message?.toLowerCase().includes('invalid oauth')
            );

            if (!mobileHasIntegrityOrAuthError) {
              console.log('[Netlify Proxy] Authenticated Mobile Client ID retry succeeded!');
              const payload = {
                ...mobileAuthResponse.data,
                _authStatus: {
                  configured: true,
                  valid: !mobileAuthResponse.data?.errors,
                  error: null
                }
              };
              return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              };
            } else {
              console.log('[Netlify Proxy] Authenticated Mobile Client ID retry also had integrity/auth errors.');
            }
          } catch (mobileAuthError: any) {
            console.error('[Netlify Proxy] Authenticated Mobile Client ID retry failed:', mobileAuthError.message);
          }
        }

        // If the authenticated mobile client ID also failed, or was already used, fallback to unauthenticated mobile client ID
        try {
          console.log('[Netlify Proxy] Falling back to unauthenticated Mobile Client ID...');
          const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', body, {
            headers: fallbackHeaders,
          });

          const payload = {
            ...fallbackResponse.data,
            _authStatus: {
              configured: true,
              valid: false,
              error: 'Fell back to unauthenticated due to remote integrity or auth error in response body'
            }
          };
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          };
        } catch (fallbackError: any) {
          console.error('[Netlify Proxy] GraphQL error fallback failed:', fallbackError.message);
        }
      }

      const payload = {
        ...response.data,
        _authStatus: {
          configured: !!token,
          valid: !response.data?.errors,
          error: token ? (response.data?.errors ? 'GraphQL execution had errors' : null) : 'No TWITCH_OAUTH_TOKEN configured in environment'
        }
      };

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };
    } catch (error: any) {
      // If we used an Authorization token and got 401, fallback to unauthenticated request!
      if (requestHeaders['Authorization'] && error.response?.status === 401) {
        console.warn('[Netlify Proxy] TWITCH_OAUTH_TOKEN was invalid or expired (got 401). Retrying unauthenticated...');
        
        try {
          const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', body, {
            headers: fallbackHeaders,
          });

          const payload = {
            ...fallbackResponse.data,
            _authStatus: {
              configured: true,
              valid: false,
              error: 'Invalid or expired TWITCH_OAUTH_TOKEN (401 Unauthorized)'
            }
          };

          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          };
        } catch (fallbackError: any) {
          console.error('[Netlify Proxy] fallback failed:', fallbackError.message);
          throw fallbackError;
        }
      }
      throw error;
    }
  } catch (error: any) {
    const responseData = error.response?.data;
    console.error('[Netlify Proxy] Error Status:', error.response?.status);
    console.error('[Netlify Proxy] Error Data:', JSON.stringify(responseData, null, 2));
    
    return {
      statusCode: error.response?.status || 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Terminal execution failed',
        details: responseData || error.message,
        _authStatus: {
          configured: !!process.env.TWITCH_OAUTH_TOKEN,
          valid: false,
          error: error.message
        }
      })
    };
  }
};

export { handler };
