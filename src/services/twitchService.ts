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

export async function fetchFollows(login: string): Promise<TwitchProfile | null> {
  const allEdges: any[] = [];
  let currentCursor: string | null = null;
  let hasNextPage = true;
  let profile: any = null;

  try {
    while (hasNextPage) {
      const response = await axios.post('/api/twitch-gql', {
        operationName: 'UserFollowingList',
        query: FOLLOWS_QUERY,
        variables: {
          login: login.toLowerCase().trim(),
          ...(currentCursor && { cursor: currentCursor })
        }
      });

      if (response.data?.errors) {
        console.error('Twitch GQL Success with Errors:', JSON.stringify(response.data.errors, null, 2));
        throw new Error(response.data.errors[0]?.message || 'GraphQL Error');
      }

      const user = response.data?.data?.user;
      if (!user) break;

      if (!profile) {
        profile = {
          id: user.id,
          login: user.login,
          displayName: user.displayName,
          profileImageURL: user.profileImageURL,
        };
      }

      if (user.follows?.edges) {
        allEdges.push(...user.follows.edges);
      }

      hasNextPage = user.follows?.pageInfo?.hasNextPage || false;
      currentCursor = user.follows?.pageInfo?.endCursor || null;

      // Safety break to prevent infinite loops or excessive memory usage
      // Twitch following count can be large, but let's limit it to a reasonable number for this preview
      // Most users follow < 2000 channels.
      if (allEdges.length > 5000) break;
    }

    if (profile) {
      profile.following = {
        totalCount: allEdges.length,
        edges: allEdges,
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        }
      };
    }

    return profile;
  } catch (error) {
    console.error('Error fetching follows:', error);
    throw error;
  }
}
