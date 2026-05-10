import axios from 'axios';
import { TwitchProfile } from '../types';

const DATA_QUERY = `
  query UserData($login: String!, $followCursor: Cursor, $followerCursor: Cursor) {
    user(login: $login) {
      id
      login
      displayName
      profileImageURL(width: 150)
      follows(first: 100, after: $followCursor) {
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
      followers(first: 100, after: $followerCursor) {
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
  const followEdges: any[] = [];
  const followerEdges: any[] = [];
  let followCursor: string | null = null;
  let followerCursor: string | null = null;
  let hasNextFollowPage = true;
  let hasNextFollowerPage = true;
  let profile: any = null;

  try {
    // Initial fetch to get profile and first batch of both
    const initialResponse = await axios.post('/api/twitch-gql', {
      operationName: 'UserData',
      query: DATA_QUERY,
      variables: {
        login: login.toLowerCase().trim(),
        followCursor: null,
        followerCursor: null
      }
    });

    if (initialResponse.data?.errors) {
      console.error('Twitch GQL Success with Errors:', JSON.stringify(initialResponse.data.errors, null, 2));
      throw new Error(initialResponse.data.errors[0]?.message || 'GraphQL Error');
    }

    const user = initialResponse.data?.data?.user;
    if (!user) return null;

    profile = {
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      profileImageURL: user.profileImageURL,
    };

    // Process initial follows
    if (user.follows?.edges) followEdges.push(...user.follows.edges);
    hasNextFollowPage = user.follows?.pageInfo?.hasNextPage || false;
    followCursor = user.follows?.pageInfo?.endCursor || null;

    // Process initial followers
    if (user.followers?.edges) followerEdges.push(...user.followers.edges);
    hasNextFollowerPage = user.followers?.pageInfo?.hasNextPage || false;
    followerCursor = user.followers?.pageInfo?.endCursor || null;

    // Fetch remaining follows if any
    while (hasNextFollowPage && followEdges.length < 5000) {
      const resp = await axios.post('/api/twitch-gql', {
        operationName: 'UserData',
        query: DATA_QUERY,
        variables: {
          login: login.toLowerCase().trim(),
          followCursor,
          followerCursor: null // Not used in this loop
        }
      });
      const u = resp.data?.data?.user;
      if (!u || !u.follows) break;
      followEdges.push(...u.follows.edges);
      hasNextFollowPage = u.follows.pageInfo.hasNextPage;
      followCursor = u.follows.pageInfo.endCursor;
    }

    // Fetch remaining followers if any
    while (hasNextFollowerPage && followerEdges.length < 5000) {
      const resp = await axios.post('/api/twitch-gql', {
        operationName: 'UserData',
        query: DATA_QUERY,
        variables: {
          login: login.toLowerCase().trim(),
          followCursor: null, // Not used in this loop
          followerCursor
        }
      });
      const u = resp.data?.data?.user;
      if (!u || !u.followers) break;
      followerEdges.push(...u.followers.edges);
      hasNextFollowerPage = u.followers.pageInfo.hasNextPage;
      followerCursor = u.followers.pageInfo.endCursor;
    }

    if (profile) {
      profile.following = {
        totalCount: user.follows?.totalCount || followEdges.length,
        edges: followEdges,
        pageInfo: { hasNextPage: false, endCursor: null }
      };
      profile.followers = {
        totalCount: user.followers?.totalCount || followerEdges.length,
        edges: followerEdges,
        pageInfo: { hasNextPage: false, endCursor: null }
      };
    }

    return profile;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}
