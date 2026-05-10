export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
  profileImageURL: string;
}

export interface FollowEdge {
  followedAt: string;
  node: TwitchUser;
}

export interface FollowingData {
  totalCount: number;
  edges: FollowEdge[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

export interface TwitchProfile extends TwitchUser {
  following: FollowingData;
  followers: FollowingData;
}
