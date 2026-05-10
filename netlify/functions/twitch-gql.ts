import { Handler } from '@netlify/functions';
import axios from 'axios';

const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    
    const response = await axios.post('https://gql.twitch.tv/gql', body, {
      headers: {
        'Client-Id': '85lcqzxpb9bqu9z6ga1ol55du', // Mobile Client ID
        'Content-Type': 'application/json',
        'User-Agent': 'Twitch/16.9.1 (iPhone; iOS 17.5.1; Scale/3.00)',
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
      body: JSON.stringify(error.response?.data || { error: 'Internal Server Error' }),
    };
  }
};

export { handler };
