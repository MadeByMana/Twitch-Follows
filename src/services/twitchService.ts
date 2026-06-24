import axios from 'axios';
import { TwitchProfile } from '../types';

function getAuthHeaders() {
  const token = localStorage.getItem('twitch_oauth_token');
  if (token) {
    return {
      headers: {
        'x-twitch-token': token.trim()
      }
    };
  }
  return {};
}

const USER_BASE_QUERY = `
  query GetDataA($login: String!) {
    user(login: $login) {
      id
      login
      displayName
      profileImageURL(width: 150)
      following: follows(first: 1) {
        totalCount
      }
      followers(first: 1) {
        totalCount
      }
    }
  }
`;

const FOLLOWS_QUERY = `
  query GetDataB($login: String!, $cursor: Cursor) {
    user(login: $login) {
      follows(first: 100, order: DESC, after: $cursor) {
        totalCount
        edges {
          followedAt
          cursor
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

const FOLLOWERS_QUERY = `
  query GetDataC($login: String!, $cursor: Cursor) {
    user(login: $login) {
      followers(first: 100, order: DESC, after: $cursor) {
        totalCount
        edges {
          followedAt
          cursor
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

export async function fetchProfile(login: string): Promise<TwitchProfile | null> {
  console.log('[Service] fetchProfile:', login);
  try {
    const loginLower = login.toLowerCase().trim();
    
    const response = await axios.post('/internal/data/stream', {
      opName: 'GetDataA',
      query: `
        query GetDataA($login: String!) {
          user(login: $login) {
            id
            login
            displayName
            profileImageURL(width: 150)
            following: follows(first: 100, order: DESC) {
              totalCount
              edges {
                followedAt
                cursor
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
            followers(first: 100, order: DESC) {
              totalCount
              edges {
                followedAt
                cursor
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
      `,
      variables: { login: loginLower }
    }, getAuthHeaders());

    if (response.data?.errors) {
      const msg = response.data.errors[0]?.message || 'GraphQL Error';
      console.error('[Service] QueryA Errors:', response.data.errors);
      throw new Error(msg);
    }

    const user = response.data?.data?.user;
    if (!user) return null;

    return {
      id: user.id as string,
      login: user.login as string,
      displayName: user.displayName as string,
      profileImageURL: user.profileImageURL as string,
      following: {
        totalCount: (user.following?.totalCount || 0) as number,
        edges: (user.following?.edges || []) as any[],
        pageInfo: (user.following?.pageInfo || { hasNextPage: false, endCursor: null })
      },
      followers: {
        totalCount: (user.followers?.totalCount || 0) as number,
        edges: (user.followers?.edges || []) as any[],
        pageInfo: (user.followers?.pageInfo || { hasNextPage: false, endCursor: null })
      },
      _authStatus: response.data?._authStatus
    };
  } catch (error) {
    console.error('[Service] Error in fetchProfile:', error);
    throw error;
  }
}

export async function fetchFollowsPage(login: string, cursor: string | null): Promise<any> {
  console.log('[Service] fetchFollowsPage:', login, cursor);
  try {
    const loginLower = login.toLowerCase().trim();
    const resp = await axios.post('/internal/data/stream', {
      opName: 'GetDataB',
      query: FOLLOWS_QUERY,
      variables: { login: loginLower, cursor }
    }, getAuthHeaders());

    if (resp.data?.errors) {
      const msg = `GetDataB Errors: ${JSON.stringify(resp.data.errors)}`;
      console.error('[Service]', msg);
      throw new Error(msg);
    }
    
    return resp.data?.data?.user?.follows;
  } catch (error: any) {
    console.error('[Service] Error in fetchFollowsPage:', error);
    throw error;
  }
}

export async function fetchFollowersPage(login: string, cursor: string | null): Promise<any> {
  console.log('[Service] fetchFollowersPage:', login, cursor);
  try {
    const loginLower = login.toLowerCase().trim();
    const resp = await axios.post('/internal/data/stream', {
      opName: 'GetDataC',
      query: FOLLOWERS_QUERY,
      variables: { login: loginLower, cursor }
    }, getAuthHeaders());

    if (resp.data?.errors) {
      const msg = `GetDataC Errors: ${resp.data.errors[0]?.message || JSON.stringify(resp.data.errors)}`;
      console.error('[Service]', msg);
      throw new Error(msg);
    }
    
    const followers = resp.data?.data?.user?.followers;
    if (!followers) {
      console.warn('[Service] No followers returned in QueryC');
      return null;
    }

    return followers;
  } catch (error: any) {
    console.error('[Service] Error in fetchFollowersPage:', error);
    throw error;
  }
}
