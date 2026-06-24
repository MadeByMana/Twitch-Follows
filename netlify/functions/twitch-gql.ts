import { Handler } from '@netlify/functions';
import axios from 'axios';

function cleanTwitchToken(token: string): string {
  let clean = (token || '').trim();
  if (clean.toLowerCase().startsWith('oauth:')) {
    clean = clean.slice(6).trim();
  } else if (clean.toLowerCase().startsWith('oauth ')) {
    clean = clean.slice(6).trim();
  }
  return clean;
}

let cachedAuthIntegrityToken = '';
let authIntegrityExpiry = 0;
let cachedPublicIntegrityToken = '';
let publicIntegrityExpiry = 0;
const DEVICE_ID = 'f25e79ad3bca81d9f0c237a8b8d910fe';

async function getIntegrityToken(token: string): Promise<string> {
  const cleanToken = cleanTwitchToken(token);
  const now = Date.now();
  if (cleanToken) {
    if (cachedAuthIntegrityToken && authIntegrityExpiry > now + 60000) {
      return cachedAuthIntegrityToken;
    }
  } else {
    if (cachedPublicIntegrityToken && publicIntegrityExpiry > now + 60000) {
      return cachedPublicIntegrityToken;
    }
  }

  try {
    const headers: Record<string, string> = {
      'Client-ID': 'kimne7iekaqgq7vqcsq7z4ff5nywb9',
      'X-Device-Id': DEVICE_ID,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.twitch.tv',
      'Referer': 'https://www.twitch.tv/',
    };

    if (cleanToken) {
      headers['Authorization'] = `OAuth ${cleanToken}`;
    }

    console.log(`[Netlify Integrity] Fetching new Twitch integrity token (${cleanToken ? 'auth' : 'public'})...`);
    const res = await axios.post('https://gql.twitch.tv/integrity', {}, { headers, timeout: 5000 });
    
    if (res.data?.token) {
      const expiration = res.data.expiration || (Date.now() + 1800000);
      if (cleanToken) {
        cachedAuthIntegrityToken = res.data.token;
        authIntegrityExpiry = expiration;
      } else {
        cachedPublicIntegrityToken = res.data.token;
        publicIntegrityExpiry = expiration;
      }
      console.log(`[Netlify Integrity] Cached token. Expires: ${new Date(expiration).toISOString()}`);
      return res.data.token;
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
  let token = '';

  try {
    console.log(`[Netlify Proxy] Process ${opName || 'unknown'}`);
    const clientToken = event.headers['x-twitch-token'] || event.headers['X-Twitch-Token'];
    const rawToken = clientToken ? clientToken.trim() : (process.env.TWITCH_OAUTH_TOKEN ? process.env.TWITCH_OAUTH_TOKEN.trim() : '');
    token = cleanTwitchToken(rawToken);
    const configSource = clientToken ? 'local' : (process.env.TWITCH_OAUTH_TOKEN ? 'server' : '');
    
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

    // FAST PATH: If no Twitch OAuth Token is configured, use the Mobile Client ID directly (Zero latency, no useless integrity requests)
    if (!token) {
      console.log('[Netlify Proxy] No OAuth token configured. Directing unauthenticated request using Mobile Client ID...');
      try {
        const response = await axios.post('https://gql.twitch.tv/gql', body, {
          headers: fallbackHeaders,
        });

        const payload = {
          ...response.data,
          _authStatus: {
            configured: false,
            valid: false,
            error: null
          }
        };
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        };
      } catch (error: any) {
        console.error('[Netlify Proxy] Unauthenticated Mobile Client ID request failed:', error.message);
        throw error;
      }
    }

    // 2. Try the primary Web Client ID with Client-Integrity & X-Device-Id
    let requestHeaders: Record<string, string>;
    const integrityToken = await getIntegrityToken(token);

    if (integrityToken) {
      requestHeaders = {
        'Client-ID': 'kimne7iekaqgq7vqcsq7z4ff5nywb9', // Web Client ID
        'Client-Integrity': integrityToken,
        'X-Device-Id': DEVICE_ID,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.twitch.tv',
        'Referer': 'https://www.twitch.tv/',
        'Authorization': `OAuth ${token}`,
      };
      console.log('[Netlify Proxy] Using Authenticated Web Client ID with Client-Integrity & X-Device-Id');
    } else {
      // Fallback if integrity fails to load
      requestHeaders = {
        'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID
        'Content-Type': 'application/json',
        'Authorization': `OAuth ${token}`,
        'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
      };
      console.log('[Netlify Proxy] Integrity fetch failed. Falling back to Authenticated Mobile Client ID (No Integrity Needed)');
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

      if (hasIntegrityOrAuthError) {
        console.log(`[Netlify Proxy] Detected integrity or auth error (GQL status 200). Current Client ID: ${requestHeaders['Client-ID']}`);
        
        // If Web Client ID failed, retry using the Authenticated Mobile Client ID (no integrity requirement)
        if (requestHeaders['Client-ID'] !== '85lcqzxpb9bqu9z6ga1ol55du') {
          try {
            console.log('[Netlify Proxy] Web Client ID GQL failed integrity/auth. Retrying with Authenticated Mobile Client ID...');
            const mobileHeaders: Record<string, string> = {
              'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du',
              'Content-Type': 'application/json',
              'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
              'Authorization': `OAuth ${token}`,
            };

            const mobileResponse = await axios.post('https://gql.twitch.tv/gql', body, {
              headers: mobileHeaders,
            });

            const mobileHasAuthError = !!mobileResponse.data?.errors?.some((err: any) => 
              err.message?.toLowerCase().includes('authorization') ||
              err.message?.toLowerCase().includes('invalid oauth') ||
              err.message?.toLowerCase().includes('token is invalid') ||
              err.message?.toLowerCase().includes('token invalid')
            );

            const mobileHasIntegrityOrAuthError = mobileHasAuthError || !!mobileResponse.data?.errors?.some((err: any) => 
              err.message?.toLowerCase().includes('failed integrity check') ||
              err.code === 'IntegrityCheckFailed'
            );

            if (!mobileHasIntegrityOrAuthError) {
              console.log('[Netlify Proxy] Mobile Client ID GQL retry succeeded!');
              const payload = {
                ...mobileResponse.data,
                _authStatus: {
                  configured: configSource,
                  valid: !mobileHasAuthError,
                  error: mobileResponse.data?.errors ? 'GraphQL execution had errors' : null
                }
              };
              return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              };
            } else {
              console.log('[Netlify Proxy] Mobile Client ID GQL retry also had integrity/auth errors. Falling back to unauthenticated Mobile Client ID...');
            }
          } catch (mobileError: any) {
            console.error('[Netlify Proxy] Mobile Client ID GQL retry failed:', mobileError.message);
          }
        }

        // Ultimate fallback to unauthenticated Mobile Client ID
        try {
          console.log('[Netlify Proxy] Falling back to unauthenticated Mobile Client ID...');
          const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', body, {
            headers: fallbackHeaders,
          });

          const payload = {
            ...fallbackResponse.data,
            _authStatus: {
              configured: configSource,
              valid: false,
              error: 'The provided Twitch OAuth token is invalid, expired, or rejected.'
            }
          };
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          };
        } catch (fallbackError: any) {
          console.error('[Netlify Proxy] Unauthenticated Mobile Client ID fallback failed:', fallbackError.message);
        }
      }

      const isTokenInvalid = !!response.data?.errors?.some((err: any) =>
        err.message?.toLowerCase().includes('authorization') ||
        err.message?.toLowerCase().includes('invalid oauth') ||
        err.message?.toLowerCase().includes('token is invalid') ||
        err.message?.toLowerCase().includes('token invalid')
      );

      const payload = {
        ...response.data,
        _authStatus: {
          configured: configSource,
          valid: !isTokenInvalid,
          error: response.data?.errors ? 'GraphQL execution had errors' : null
        }
      };

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };
    } catch (error: any) {
      // If we used a token and got 401 or other HTTP error, fallback to unauthenticated request!
      if (token && (error.response?.status === 401 || error.response?.status === 403)) {
        console.warn('[Netlify Proxy] Auth token was invalid or rejected. Retrying unauthenticated...');
        
        try {
          const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', body, {
            headers: fallbackHeaders,
          });

          const payload = {
            ...fallbackResponse.data,
            _authStatus: {
              configured: configSource,
              valid: false,
              error: `Invalid or expired TWITCH_OAUTH_TOKEN (${error.response?.status} error)`
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
    const tokenHeader = event.headers['x-twitch-token'] || event.headers['X-Twitch-Token'];
    const configSource = tokenHeader ? 'local' : (process.env.TWITCH_OAUTH_TOKEN ? 'server' : '');
    
    return {
      statusCode: error.response?.status || 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Terminal execution failed',
        details: responseData || error.message,
        _authStatus: {
          configured: configSource,
          valid: false,
          error: error.message
        }
      })
    };
  }
};

export { handler };
