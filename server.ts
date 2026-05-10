import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.post('/internal/data/stream', async (req, res) => {
    const { opName } = req.body;
    try {
      console.log(`[Proxy] Process ${opName || 'unknown'}`);
      const response = await axios.post('https://gql.twitch.tv/gql', req.body, {
        headers: {
          'Client-ID': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID
          'Content-Type': 'application/json',
          'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
          'X-Device-Id': '8b2e1a4d7c6f0a3b9e5d2c8f6a1b4e9f',
        },
      });

      if (response.data?.errors) {
        console.error('Remote Errors:', JSON.stringify(response.data.errors, null, 2));
      }

      res.json(response.data);
    } catch (error: any) {
      const responseData = error.response?.data;
      console.error('Proxy Error Status:', error.response?.status);
      console.error('Proxy Error Data:', JSON.stringify(responseData, null, 2));
      
      res.status(error.response?.status || 500).json({ 
        error: 'Terminal execution failed',
        details: responseData || error.message
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

startServer();
