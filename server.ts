import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_FILE = path.join(__dirname, 'server.log');

// Overwrite log file on startup
try {
  fs.writeFileSync(LOG_FILE, '=== Server Started ===\n');
} catch (e) {}

function logToFile(...args: any[]) {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

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

    console.log(`[Integrity] Fetching new Twitch integrity token (${cleanToken ? 'auth' : 'public'})...`);
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
      console.log(`[Integrity] Cached token. Expires: ${new Date(expiration).toISOString()}`);
      return res.data.token;
    }
  } catch (error: any) {
    console.error('[Integrity] Failed to fetch integrity token:', error.message);
  }

  return '';
}

async function startServer() {
  const app = reportAppStatusAndGetApp();
  const PORT = 3000;

  app.use(express.json());

  app.post('/internal/data/stream', async (req, res) => {
    const { opName } = req.body;
    let token = '';
    try {
      logToFile(`[Proxy] Process ${opName || 'unknown'}`);
      const clientToken = req.headers['x-twitch-token'] as string;
      const rawToken = clientToken ? clientToken.trim() : (process.env.TWITCH_OAUTH_TOKEN ? process.env.TWITCH_OAUTH_TOKEN.trim() : '');
      token = cleanTwitchToken(rawToken);
      
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
        logToFile('[Proxy] No OAuth token configured. Directing unauthenticated request using Mobile Client ID...');
        try {
          const response = await axios.post('https://gql.twitch.tv/gql', req.body, {
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
          return res.json(payload);
        } catch (error: any) {
          logToFile('[Proxy] Unauthenticated Mobile Client ID request failed:', error.message);
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
        logToFile('[Proxy] Using Authenticated Web Client ID with Client-Integrity & X-Device-Id');
      } else {
        // Fallback if integrity fails to load
        requestHeaders = {
          'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID
          'Content-Type': 'application/json',
          'Authorization': `OAuth ${token}`,
          'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
        };
        logToFile('[Proxy] Integrity fetch failed. Falling back to Authenticated Mobile Client ID (No Integrity Needed)');
      }

      try {
        let response = await axios.post('https://gql.twitch.tv/gql', req.body, {
          headers: requestHeaders,
        });

        // Handle GraphQL integrity check or authentication errors embedded in a successful 200 response
        const hasIntegrityOrAuthError = !!response.data?.errors?.some((err: any) => 
          err.message?.toLowerCase().includes('failed integrity check') ||
          err.code === 'IntegrityCheckFailed' ||
          err.message?.toLowerCase().includes('authorization') ||
          err.message?.toLowerCase().includes('invalid oauth')
        );

        // Log Remote Errors to help identify specific Twitch GQL API constraints
        if (response.data?.errors) {
          logToFile('Remote Errors:', JSON.stringify(response.data.errors, null, 2));
        }

        if (hasIntegrityOrAuthError) {
          logToFile(`[Proxy] Detected integrity or auth error (GQL status 200). Current Client ID: ${requestHeaders['Client-ID']}`);
          
          // If Web Client ID failed, retry using the Authenticated Mobile Client ID (no integrity requirement)
          if (requestHeaders['Client-ID'] !== '85lcqzxpb9bqu9z6ga1ol55du') {
            try {
              logToFile('[Proxy] Web Client ID GQL failed integrity/auth. Retrying with Authenticated Mobile Client ID...');
              const mobileHeaders: Record<string, string> = {
                'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du',
                'Content-Type': 'application/json',
                'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
                'Authorization': `OAuth ${token}`,
              };

              const mobileResponse = await axios.post('https://gql.twitch.tv/gql', req.body, {
                headers: mobileHeaders,
              });

              const mobileHasIntegrityOrAuthError = !!mobileResponse.data?.errors?.some((err: any) => 
                err.message?.toLowerCase().includes('failed integrity check') ||
                err.code === 'IntegrityCheckFailed' ||
                err.message?.toLowerCase().includes('authorization') ||
                err.message?.toLowerCase().includes('invalid oauth')
              );

              if (!mobileHasIntegrityOrAuthError) {
                logToFile('[Proxy] Mobile Client ID GQL retry succeeded!');
                const payload = {
                  ...mobileResponse.data,
                  _authStatus: {
                    configured: true,
                    valid: !mobileResponse.data?.errors,
                    error: mobileResponse.data?.errors ? 'GraphQL execution had errors' : null
                  }
                };
                return res.json(payload);
              } else {
                logToFile('[Proxy] Mobile Client ID GQL retry also had integrity/auth errors. Falling back to unauthenticated Mobile Client ID...');
              }
            } catch (mobileError: any) {
              logToFile('[Proxy] Mobile Client ID GQL retry failed:', mobileError.message);
            }
          }

          // Ultimate fallback to unauthenticated Mobile Client ID
          try {
            logToFile('[Proxy] Falling back to unauthenticated Mobile Client ID...');
            const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', req.body, {
              headers: fallbackHeaders,
            });

            const payload = {
              ...fallbackResponse.data,
              _authStatus: {
                configured: true,
                valid: false,
                error: 'The provided Twitch OAuth token is invalid, expired, or rejected.'
              }
            };
            return res.json(payload);
          } catch (fallbackError: any) {
            logToFile('[Proxy] Unauthenticated Mobile Client ID fallback failed:', fallbackError.message);
          }
        }

        const payload = {
          ...response.data,
          _authStatus: {
            configured: true,
            valid: !response.data?.errors,
            error: response.data?.errors ? 'GraphQL execution had errors' : null
          }
        };

        return res.json(payload);
      } catch (error: any) {
        // If we used a token and got 401 or other HTTP error, fallback to unauthenticated request!
        if (token && (error.response?.status === 401 || error.response?.status === 403)) {
          console.warn('[Proxy] Auth token was invalid or rejected. Retrying unauthenticated...');
          
          try {
            const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', req.body, {
              headers: fallbackHeaders,
            });

            const payload = {
              ...fallbackResponse.data,
              _authStatus: {
                configured: true,
                valid: false,
                error: `Invalid or expired TWITCH_OAUTH_TOKEN (${error.response?.status} error)`
              }
            };

            return res.json(payload);
          } catch (fallbackError: any) {
            console.error('[Proxy] fallback failed:', fallbackError.message);
            throw fallbackError;
          }
        }
        throw error;
      }
    } catch (error: any) {
      const responseData = error.response?.data;
      console.error('Proxy Error Status:', error.response?.status);
      console.error('Proxy Error Data:', JSON.stringify(responseData, null, 2));
      
      res.status(error.response?.status || 500).json({ 
        error: 'Terminal execution failed',
        details: responseData || error.message,
        _authStatus: {
          configured: !!token,
          valid: false,
          error: error.message
        }
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

function reportAppStatusAndGetApp() {
  return express();
}

startServer();
