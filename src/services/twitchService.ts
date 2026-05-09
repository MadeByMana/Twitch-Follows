import axios from 'axios';
import { TwitchProfile } from '../types';

const FOLLOWS_QUERY = `
  query UserFollowingList($login: String!, $cursor: Cursor) {
    user(login: $login) {
      id
      login
      displayName
      profileImageURL(width: 150)
      follows(first: 100, after: $cursor) {
        totalCount
        edges {
          followedAt
          node {
            id
            login
            displayName
            profileImageURL(width: 70)
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export async function fetchFollows(login: string, cursor: string | null = null): Promise<TwitchProfile | null> {
  try {
    const response = await axios.post('/api/twitch-gql', {
      operationName: 'UserFollowingList',
      query: FOLLOWS_QUERY,
      variables: {
        login: login.toLowerCase().trim(),
        ...(cursor && { cursor })
      }
    });

    if (response.data?.errors) {
      console.error('Twitch GQL Success with Errors:', JSON.stringify(response.data.errors, null, 2));
      throw new Error(response.data.errors[0]?.message || 'GraphQL Error');
    }

    const user = response.data?.data?.user;
    if (user && user.follows) {
      // Map 'follows' back to our internal 'following' property if we want to keep types unchanged,
      // or update types. Let's just update the user object we return.
      user.following = user.follows;
    }

    return user || null;
  } catch (error) {
    console.error('Error fetching follows:', error);
    throw error;
  }
}
