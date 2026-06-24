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

    console.log('[Integrity] Fetching new Twitch integrity token...');
    const res = await axios.post('https://gql.twitch.tv/integrity', {}, { headers, timeout: 5000 });
    
    if (res.data?.token) {
      cachedIntegrityToken = res.data.token;
      integrityTokenExpiry = res.data.expiration || (Date.now() + 1800000);
      console.log(`[Integrity] Cached token. Expires: ${new Date(integrityTokenExpiry).toISOString()}`);
      return cachedIntegrityToken;
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
      token = clientToken ? clientToken.trim() : (process.env.TWITCH_OAUTH_TOKEN ? process.env.TWITCH_OAUTH_TOKEN.trim() : '');
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
          'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID (no integrity requirement)
          'Content-Type': 'application/json',
          'Authorization': token.toLowerCase().startsWith('oauth ') ? token : `OAuth ${token}`,
          'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
        };
        logToFile('[Proxy] Using Authenticated Mobile Client ID (No Integrity Needed)');
      } else {
        requestHeaders = { ...fallbackHeaders };
        logToFile('[Proxy] Using Unauthenticated Mobile Client ID');
      }

      try {
        let response = await axios.post('https://gql.twitch.tv/gql', req.body, {
          headers: requestHeaders,
        });

        // Handle authentication errors embedded in a successful 200 response
        const hasAuthError = !!response.data?.errors?.some((err: any) => 
          err.message?.toLowerCase().includes('authorization') ||
          err.message?.toLowerCase().includes('invalid oauth')
        );

        // Only log Remote Errors if they aren't going to be gracefully handled by the fallback
        if (response.data?.errors && !(hasAuthError && requestHeaders['Authorization'])) {
          logToFile('Remote Errors:', JSON.stringify(response.data.errors, null, 2));
        }

        if (hasAuthError && requestHeaders['Authorization']) {
          // Fallback to unauthenticated mobile client ID
          try {
            logToFile('[Proxy] Falling back to unauthenticated Mobile Client ID due to auth error...');
            const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', req.body, {
              headers: fallbackHeaders,
            });
            
            if (fallbackResponse.data?.errors) {
              logToFile('Remote Errors (unauthenticated fallback):', JSON.stringify(fallbackResponse.data.errors, null, 2));
            }

            const payload = {
              ...fallbackResponse.data,
              _authStatus: {
                configured: true,
                valid: false,
                error: 'Fell back to unauthenticated due to remote auth error in response body'
              }
            };
            return res.json(payload);
          } catch (fallbackError: any) {
            logToFile('[Proxy] GraphQL error fallback failed:', fallbackError.message);
          }
        }

        const payload = {
          ...response.data,
          _authStatus: {
            configured: !!token,
            valid: !!token && !response.data?.errors,
            error: token ? (response.data?.errors ? 'GraphQL execution had errors' : null) : 'No TWITCH_OAUTH_TOKEN configured in environment'
          }
        };

        return res.json(payload);
      } catch (error: any) {
        // If we used an Authorization token and got 401, fallback to unauthenticated request!
        if (requestHeaders['Authorization'] && error.response?.status === 401) {
          console.warn('[Proxy] TWITCH_OAUTH_TOKEN was invalid or expired (got 401). Retrying unauthenticated...');
          
          try {
            const fallbackResponse = await axios.post('https://gql.twitch.tv/gql', req.body, {
              headers: fallbackHeaders, // original unauthenticated headers
            });

            if (fallbackResponse.data?.errors) {
              console.error('Remote Errors (unauthenticated):', JSON.stringify(fallbackResponse.data.errors, null, 2));
            }

            const payload = {
              ...fallbackResponse.data,
              _authStatus: {
                configured: true,
                valid: false,
                error: 'Invalid or expired TWITCH_OAUTH_TOKEN (401 Unauthorized)'
              }
            };

            return res.json(payload);
          } catch (fallbackError: any) {
            console.error('Proxy fallback failed:', fallbackError.message);
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
