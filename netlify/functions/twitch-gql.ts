import { Handler } from '@netlify/functions';
import axios from 'axios';

const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let opName = 'unknown';
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    opName = body.opName || 'unknown';
    console.log(`[Netlify Proxy] Process ${opName}`);
    
    const response = await axios.post('https://gql.twitch.tv/gql', body, {
      headers: {
        'Client-Id': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID
        'Content-Type': 'application/json',
        'User-Agent': 'Twitch/15.8.1 (iPhone; iOS 15.5; Scale/2.00)',
        'X-Device-Id': '8b2e1a4d7c6f0a3b9e5d2c8f6a1b4e9f',
      },
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(response.data),
    };
  } catch (error: any) {
    console.error('Twitch GQL Function Error:', error.response?.status, error.response?.data);
    
    return {
      statusCode: error.response?.status || 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        error: 'Remote Proxy Error', 
        details: error.response?.data || error.message,
        opName 
      }),
    };
  }
};

export { handler };
