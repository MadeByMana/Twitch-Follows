import React, { useState, useRef, useEffect } from 'react';
import { Search, Loader2, ArrowUpDown, ExternalLink, Calendar, Users, Info } from 'lucide-react';
import { fetchProfile, fetchFollowsPage, fetchFollowersPage } from './services/twitchService';
import { TwitchProfile, FollowEdge } from './types';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export default function App() {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<TwitchProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [showAll, setShowAll] = useState(false);
  const [loadingFollowing, setLoadingFollowing] = useState(false);
  const [loadingFollowers, setLoadingFollowers] = useState(false);
  const [activeTab, setActiveTab] = useState<'following' | 'followers'>('following');
  const loadRequestId = useRef(0);
  
  // Suppression for harmless Vite/Development websocket errors that can sometimes leak to UI
  useEffect(() => {
    const handleRejection = (event: PromiseRejectionEvent) => {
      const message = event.reason?.message || String(event.reason);
      if (message.includes('WebSocket closed without opened') || message.includes('failed to connect to websocket')) {
        event.preventDefault();
        // Silently swallow these benign dev-server errors
        return;
      }
    };
    const handleError = (event: ErrorEvent) => {
      if (event.message.includes('WebSocket closed without opened') || event.message.includes('failed to connect to websocket')) {
        event.preventDefault();
        return;
      }
    };
    window.addEventListener('unhandledrejection', handleRejection);
    window.addEventListener('error', handleError);
    return () => {
      window.removeEventListener('unhandledrejection', handleRejection);
      window.removeEventListener('error', handleError);
    };
  }, []);

  const handleSearch = async (e?: React.FormEvent, targetUsername?: string) => {
    if (e) e.preventDefault();
    const activeUsername = targetUsername !== undefined ? targetUsername : username;
    if (!activeUsername.trim()) return;

    if (targetUsername !== undefined) {
      setUsername(targetUsername);
    }

    // Increment request ID to cancel any ongoing "Load All" loops
    loadRequestId.current += 1;
    const currentRequestId = loadRequestId.current;

    setLoading(true);
    setError(null);
    
    try {
      const data = await fetchProfile(activeUsername);
      
      // If a new search was started, ignore this result
      if (currentRequestId !== loadRequestId.current) return;

      if (data) {
        setProfile(data);
        setShowAll(false);
        triggerBackgroundLoad(data, currentRequestId);
      } else {
        setProfile(null);
        setError('User not found. Check the username and try again.');
      }
    } catch (err: any) {
      console.error('Fetch Error:', err);
      const details = err.response?.data?.details || err.message;
      let displayMessage = 'Failed to fetch data from Twitch.';
      
      if (details && typeof details === 'object') {
        if (details.error === 'Bad Request') {
          displayMessage = 'Twitch rejected the request (400 Bad Request). This usually means the query structure or headers are rejected by Twitch\'s API Gateway.';
        } else {
          displayMessage = `Technical Error: ${JSON.stringify(details)}`;
        }
      } else {
        const messageString = typeof details === 'string' ? details : String(details);
        displayMessage = messageString.includes('WebSocket closed without opened')
          ? 'The connection was interrupted. Please try again.' 
          : (details || displayMessage);
      }
      
      setError(displayMessage);
    } finally {
      setLoading(false);
    }
  };

  const triggerBackgroundLoad = async (initialProfile: TwitchProfile, requestId: number) => {
    // Reset separate states for following/followers tracking
    setLoadingFollowing(!!initialProfile.following.pageInfo.hasNextPage);
    setLoadingFollowers(!!initialProfile.followers.pageInfo.hasNextPage);

    const loadTab = async (tab: 'following' | 'followers', startProfile: TwitchProfile) => {
      const initialData = tab === 'following' ? startProfile.following : startProfile.followers;
      if (!initialData.pageInfo.hasNextPage) {
        return;
      }

      let currentEdges = [...initialData.edges];
      let currentCursor = initialData.pageInfo.endCursor || (currentEdges.length > 0 ? (currentEdges[currentEdges.length - 1] as any).cursor : null);
      let hasNextPage = !!initialData.pageInfo.hasNextPage;
      const login = startProfile.login;

      try {
        while (hasNextPage) {
          if (loadRequestId.current !== requestId) {
            console.log(`[App] [Background] Loop stopped for ${tab}: request ID mismatch`);
            break;
          }

          console.log(`[App] [Background] Fetching ${tab}: cursor=${currentCursor}`);
          let result;
          try {
            result = tab === 'following'
              ? await fetchFollowsPage(login, currentCursor)
              : await fetchFollowersPage(login, currentCursor);
          } catch (fetchErr: any) {
            console.error(`[Background] Fetch error in ${tab} loop:`, fetchErr);
            hasNextPage = false;
            setError(`Twitch pagination stopped or ratelimited on ${tab}: ${fetchErr.message || 'Unknown network error'}`);
            break;
          }

          if (loadRequestId.current !== requestId) break;

          if (result && result.edges) {
            const newEdges = (result.edges || []).filter((e: any) => e && e.node);
            console.log(`[Background] Tab: ${tab}, Fetched: ${newEdges.length}, hasNextPage: ${result.pageInfo?.hasNextPage}`);

            if (newEdges.length === 0 && result.pageInfo?.hasNextPage) {
              hasNextPage = false;
            }

            const seen = new Set(currentEdges.map(e => `${e?.node?.id || 'no-id'}-${e?.followedAt || 'no-date'}`));
            const filteredNew = newEdges.filter((e: any) => {
              if (!e || !e.node) return false;
              const key = `${e.node.id}-${e.followedAt}`;
              return !seen.has(key);
            });

            const previousCursor = currentCursor;
            currentCursor = result.pageInfo?.endCursor || (newEdges.length > 0 ? (newEdges[newEdges.length - 1] as any).cursor : null);
            hasNextPage = !!result.pageInfo?.hasNextPage;

            if (filteredNew.length > 0) {
              currentEdges = [...currentEdges, ...filteredNew];

              setProfile(prev => {
                if (!prev || prev.login !== login) return prev;
                const updated = { ...prev };
                if (tab === 'following') {
                  updated.following = {
                    ...prev.following,
                    edges: currentEdges,
                    pageInfo: result.pageInfo
                  };
                } else {
                  updated.followers = {
                    ...prev.followers,
                    edges: currentEdges,
                    pageInfo: result.pageInfo
                  };
                }
                return updated;
              });
            }

            if (filteredNew.length === 0 && currentCursor === previousCursor) {
              hasNextPage = false;
            }
          } else {
            hasNextPage = false;
          }

          // Small delay to be polite to Twitch APIs
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        console.error(`[Background] Error loading all data for ${tab}:`, err);
      } finally {
        if (loadRequestId.current === requestId) {
          if (tab === 'following') {
            setLoadingFollowing(false);
          } else {
            setLoadingFollowers(false);
          }
        }
      }
    };

    // Fire off both page fetches to execute concurrently
    Promise.all([
      loadTab('following', initialProfile),
      loadTab('followers', initialProfile)
    ]).catch(err => {
      console.error('[Background] Promise.all execution errors:', err);
    });
  };

  const handleToggleTab = (tab: 'following' | 'followers') => {
    if (!profile) return;
    setActiveTab(tab);
  };

  const currentFollows = profile ? (activeTab === 'following' ? profile.following.edges : profile.followers.edges).filter(e => e && e.node) : [];
  const hasMore = profile ? (activeTab === 'following' ? profile.following.pageInfo.hasNextPage : profile.followers.pageInfo.hasNextPage) : false;

  const followingIds = React.useMemo(() => {
    if (!profile) return new Set<string>();
    return new Set(profile.following.edges.map(e => e?.node?.id).filter(Boolean));
  }, [profile?.following.edges]);

  const followersIds = React.useMemo(() => {
    if (!profile) return new Set<string>();
    return new Set(profile.followers.edges.map(e => e?.node?.id).filter(Boolean));
  }, [profile?.followers.edges]);

  const sortedFollows = [...currentFollows].sort((a, b) => {
    const dateA = new Date(a.followedAt).getTime();
    const dateB = new Date(b.followedAt).getTime();
    return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
  });

  const displayedFollows = showAll ? sortedFollows : sortedFollows.slice(0, 100);

  return (
    <div className="min-h-dvh bg-[#0e0e10] text-zinc-100 flex flex-col font-sans selection:bg-[#934afb] selection:text-white">
      {/* Navigation */}
      <nav className="h-16 border-b border-zinc-800 bg-[#18181b] shrink-0 z-50">
        <div className="max-w-7xl mx-auto w-full h-full px-4 md:px-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#934afb] rounded-md flex items-center justify-center">
              <Users className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight pt-0 pb-[2px] md:pb-[3px] leading-none inline-block">Twitch<span className="text-[#934afb]">Follows</span></span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400">
          </div>
        </div>
      </nav>

      {/* Hero / Search Section */}
      <main className="flex-1 w-full">
        <div className="max-w-7xl mx-auto w-full p-4 md:p-8 flex flex-col gap-8">
          <div className="flex flex-col gap-4 w-full">
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Search Follows</h1>
            <p className="text-zinc-400 text-base md:whitespace-nowrap">
              Enter a username to display who they follow and who follows them.
            </p>
            <form onSubmit={handleSearch} className="relative group mt-4 h-14 md:h-16 max-w-md">
            <input
              id="username-input"
              type="text"
              placeholder="Twitch Username..."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-full bg-[#18181b] border border-transparent hover:border-zinc-800 focus:border-[#934afb] rounded-2xl pl-6 pr-18 pt-0 pb-[3px] md:pb-[4px] outline-none transition-all text-lg font-medium leading-none"
            />
            <button 
              id="search-button"
              type="submit"
              disabled={loading}
              className="absolute right-2 top-2 bottom-2 aspect-square bg-[#934afb] hover:bg-[#8035e8] rounded-xl font-semibold transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center cursor-pointer"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5 text-white" />}
            </button>
          </form>
          {error && (
            <div className="text-red-400 text-sm flex items-center gap-2 mt-2 px-2">
              <Info className="w-4 h-4" /> {error}
            </div>
          )}
        </div>

        {profile && (
          <div 
            id="content-grid"
            className="grid grid-cols-1 lg:grid-cols-12 gap-8"
          >
            {/* Sidebar */}
            <div className="lg:col-span-4 flex flex-col gap-6">
              <div id="profile-sidebar" className="bg-[#18181b] rounded-2xl p-6 flex flex-col gap-6 sticky top-24 transition-all duration-200">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-zinc-900 overflow-hidden">
                    <img src={profile.profileImageURL} alt={profile.displayName} className="w-full h-full rounded-full object-cover" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-semibold">{profile.displayName}</h2>
                    <a 
                      href={`https://twitch.tv/${profile.login}`} 
                      className="mt-2 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#934afb]/10 text-[#934afb] rounded text-[10px] font-semibold uppercase hover:bg-[#934afb]/20 transition-colors leading-none"
                    >
                      <span>Visit Channel</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => handleToggleTab('following')}
                    className={`p-4 rounded-xl border transition-all text-left hover:border-[#934afb] cursor-pointer ${activeTab === 'following' ? 'bg-[#934afb]/10 border-[#934afb]' : 'bg-zinc-900/50 border-zinc-800/50'}`}
                  >
                    <span className={`text-[10px] uppercase font-semibold tracking-wider block mb-1 ${activeTab === 'following' ? 'text-[#934afb]' : 'text-zinc-500 hover:text-[#934afb]/80 transition-colors'}`}>Following</span>
                    <p className="text-2xl font-semibold">{profile.following.totalCount.toLocaleString()}</p>
                  </button>
                  <button 
                    onClick={() => handleToggleTab('followers')}
                    className={`p-4 rounded-xl border transition-all text-left hover:border-[#934afb] cursor-pointer ${activeTab === 'followers' ? 'bg-[#934afb]/10 border-[#934afb]' : 'bg-zinc-900/50 border-zinc-800/50'}`}
                  >
                    <span className={`text-[10px] uppercase font-semibold tracking-wider block mb-1 ${activeTab === 'followers' ? 'text-[#934afb]' : 'text-zinc-500 hover:text-[#934afb]/80 transition-colors'}`}>Followers</span>
                    <p className="text-2xl font-semibold">{profile.followers.totalCount.toLocaleString()}</p>
                  </button>
                </div>


              </div>
            </div>

            {/* Main Feed */}
            <div id="timeline-feed" className="lg:col-span-8 flex flex-col gap-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-zinc-200">
                    <span className="capitalize">{activeTab}</span>
                    <span className="text-zinc-500 font-normal ml-2 font-mono text-xs">
                      {displayedFollows.length.toLocaleString()} of {activeTab === 'following' ? profile.following.totalCount.toLocaleString() : profile.followers.totalCount.toLocaleString()}
                    </span>
                  </h3>
                  {(loadingFollowing || loadingFollowers) && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#934afb]/10 text-[#934afb] text-[10px] font-semibold animate-pulse uppercase tracking-wider">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Syncing...
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setSortOrder('desc')}
                    className={`inline-flex items-center justify-center px-3 py-1.5 rounded text-[10px] font-semibold tracking-wider transition-colors leading-none cursor-pointer ${sortOrder === 'desc' ? 'bg-[#934afb] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    NEWEST
                  </button>
                  <button 
                    onClick={() => setSortOrder('asc')}
                    className={`inline-flex items-center justify-center px-3 py-1.5 rounded text-[10px] font-semibold tracking-wider transition-colors leading-none cursor-pointer ${sortOrder === 'asc' ? 'bg-[#934afb] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    OLDEST
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {displayedFollows.map((follow, index) => {
                  const isMutual = followingIds.has(follow.node.id) && followersIds.has(follow.node.id);
                  return (
                    <div
                      key={`${follow.node.id}-${follow.followedAt}-${index}`}
                      onClick={() => handleSearch(undefined, follow.node.login)}
                      className="bg-[#18181b] border border-transparent p-4 rounded-xl flex items-center justify-between group hover:border-[#934afb] transition-all hover:bg-[#1c1c21] cursor-pointer select-none"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-8 h-8 md:w-10 md:h-10 rounded-full overflow-hidden transition-colors shrink-0">
                          <img src={follow.node.profileImageURL} alt={follow.node.displayName} className="w-full h-full object-cover" />
                        </div>
                        <div className="flex items-baseline gap-2 min-w-0">
                          <h4 className="text-sm md:text-base tracking-tight group-hover:text-[#934afb] transition-colors truncate leading-normal py-1 -my-1">{follow.node.displayName}</h4>
                          {isMutual && (
                            <span className="inline-block px-2 py-1 rounded-full text-[10px] font-semibold bg-[#934afb]/15 text-[#934afb] border border-[#934afb]/30 shrink-0 pointer-events-none select-none leading-none align-baseline">
                              FOLLOWS BACK
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-4 opacity-80">
                        <p className="text-sm text-zinc-400 whitespace-nowrap leading-normal py-1 -my-1">
                          <Calendar className="inline-block w-3.5 h-3.5 text-[#934afb] mr-1.5 align-baseline translate-y-[1.5px]" />
                          Followed {new Date(follow.followedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at {new Date(follow.followedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Toggle to Show All or Show Less if there are more items to show */}
              {(sortedFollows.length > 100 || hasMore) && (
                <div className="mt-6 flex flex-col justify-center items-center gap-2">
                  <button
                    onClick={() => setShowAll(prev => !prev)}
                    className="flex items-center gap-2 px-8 py-3 bg-[#934afb] hover:bg-[#8035e8] text-white rounded-xl font-semibold transition-all border border-transparent hover:border-[#934afb]/20 active:scale-95"
                  >
                    {showAll ? 'Show Less (First 100)' : `Show All Data (${(activeTab === 'following' ? profile.following.totalCount : profile.followers.totalCount).toLocaleString()} items)`}
                  </button>
                  {(loadingFollowing || loadingFollowers) && (
                    <span className="text-xs text-zinc-500 font-mono">
                      Still syncing live in the background: {currentFollows.length.toLocaleString()} loaded so far...
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </main>

      {/* Status Footer */}
      <footer className="h-10 border-t border-zinc-800 bg-[#18181b]">
        <div className="max-w-7xl mx-auto w-full h-full px-4 md:px-8 flex items-center justify-between text-[10px] text-zinc-500 uppercase tracking-widest font-semibold pt-0 pb-[2px] md:pb-[3px] leading-none">
          <div className="flex gap-6">
            <span className="flex items-center gap-1.5">
              Status: <span className="text-green-500">API Connected</span>
            </span>
          </div>
          <div>
            <span>Made By Mana &copy; 2026</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
