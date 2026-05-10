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
  const [loadingAll, setLoadingAll] = useState(false);
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

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username.trim()) return;

    // Increment request ID to cancel any ongoing "Load All" loops
    loadRequestId.current += 1;
    const currentRequestId = loadRequestId.current;

    setLoading(true);
    setError(null);
    
    try {
      const data = await fetchProfile(username);
      
      // If a new search was started, ignore this result
      if (currentRequestId !== loadRequestId.current) return;

      if (data) {
        setProfile(data);
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

  const handleToggleTab = (tab: 'following' | 'followers') => {
    if (!profile) return;
    setActiveTab(tab);
  };

  const handleLoadAll = async () => {
    console.log('[App] handleLoadAll started');
    if (!profile || loadingAll) {
      console.log('[App] handleLoadAll skipped:', { profile: !!profile, loadingAll });
      return;
    }
    
    // Increment request ID to cancel any ongoing "Load All" loops
    loadRequestId.current += 1;
    const currentRequestId = loadRequestId.current;
    const initialTab = activeTab;
    
    setLoadingAll(true);
    setError(null);
    
    // Use local variables to track progress within the loop
    const initialData = initialTab === 'following' ? profile.following : profile.followers;
    console.log(`[App] initialData for ${initialTab}:`, { 
      totalCount: initialData.totalCount, 
      edgesCount: initialData.edges.length,
      hasNextPage: initialData.pageInfo.hasNextPage,
      cursor: initialData.pageInfo.endCursor 
    });

    let currentEdges = [...initialData.edges];
    let currentCursor = initialData.pageInfo.endCursor || (currentEdges.length > 0 ? currentEdges[currentEdges.length - 1].cursor : null);
    let hasNextPage = !!initialData.pageInfo.hasNextPage;
    let totalLoaded = currentEdges.length;
    const login = profile.login;

    try {
      while (hasNextPage) {
        // Stop if a new search was started or tab switched
        if (loadRequestId.current !== currentRequestId) {
          console.log('[App] Loop stopped: request ID mismatch');
          break;
        }
        if (activeTab !== initialTab) {
          console.log('[App] Loop stopped: tab switched');
          break;
        }

        console.log(`[App] Iterating: cursor=${currentCursor}, totalLoaded=${totalLoaded}`);
        let result;
        try {
          // Re-fetch login just in case it mutated
          const currentLogin = profile.login;
          result = initialTab === 'following' 
            ? await fetchFollowsPage(currentLogin, currentCursor)
            : await fetchFollowersPage(currentLogin, currentCursor);
        } catch (fetchErr: any) {
          console.error(`Fetch error in ${initialTab} loop:`, fetchErr);
          // If we hit a 400 or other terminal error, stop the loop
          hasNextPage = false;
          setError(`Twitch pagination stopped: ${fetchErr.message || 'Unknown network error'}`);
          break;
        }

        // Standard checks after async network call
        if (loadRequestId.current !== currentRequestId) break;
        if (activeTab !== initialTab) break;

        if (result && result.edges) {
          const newEdges = result.edges || [];
          console.log(`[Pagination] Tab: ${initialTab}, Fetched: ${newEdges.length}, hasNextPage: ${result.pageInfo?.hasNextPage}, endCursor: ${result.pageInfo?.endCursor}`);
          
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
          currentCursor = result.pageInfo?.endCursor || (newEdges.length > 0 ? newEdges[newEdges.length - 1].cursor : null);
          hasNextPage = !!result.pageInfo?.hasNextPage;

          if (filteredNew.length > 0) {
            currentEdges = [...currentEdges, ...filteredNew];
            totalLoaded = currentEdges.length;

            // Incrementally update UI state
            setProfile(prev => {
              if (!prev || prev.login !== login) return prev;
              const updated = { ...prev };
              if (initialTab === 'following') {
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

          // If cursor didn't move AND we got no new edges, stop
          if (filteredNew.length === 0 && currentCursor === previousCursor) {
            hasNextPage = false;
          }
        } else {
          hasNextPage = false;
          if (totalLoaded < (initialTab === 'following' ? profile.following.totalCount : profile.followers.totalCount)) {
            setError(`Completed loading up to ${totalLoaded} ${initialTab}. Twitch may have limited the pagination.`);
          }
        }

        // Small delay to be nice to Twitch GQL and keep UI responsive
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (err) {
      console.error('Error loading all data:', err);
      setError('An error occurred while loading all data. Recent progress was saved.');
    } finally {
      if (loadRequestId.current === currentRequestId) {
        setLoadingAll(false);
      }
    }
  };

  const currentFollows = profile ? (activeTab === 'following' ? profile.following.edges : profile.followers.edges) : [];
  const hasMore = profile ? (activeTab === 'following' ? profile.following.pageInfo.hasNextPage : profile.followers.pageInfo.hasNextPage) : false;

  const sortedFollows = [...currentFollows].sort((a, b) => {
    const dateA = new Date(a.followedAt).getTime();
    const dateB = new Date(b.followedAt).getTime();
    return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
  });

  return (
    <div className="min-h-screen bg-[#0e0e10] text-zinc-100 flex flex-col font-sans selection:bg-[#9146ff] selection:text-white overflow-x-hidden overflow-y-scroll">
      {/* Navigation */}
      <nav className="h-16 border-b border-zinc-800 bg-[#18181b] sticky top-0 z-50">
        <div className="max-w-7xl mx-auto w-full h-full px-4 md:px-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#9146ff] rounded-md flex items-center justify-center shadow-lg shadow-[#9146ff]/20">
              <Users className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight">Twitch<span className="text-[#a970ff]">Follows</span></span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400">
          </div>
        </div>
      </nav>

      {/* Hero / Search Section */}
      <main className="flex-1 flex flex-col p-4 md:p-8 gap-8 max-w-7xl mx-auto w-full">
        <div className="flex flex-col gap-4 w-full">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Search Follows</h1>
          <p className="text-zinc-400 text-base whitespace-nowrap">
            Enter a username to display who they follow and who follows them.
          </p>
          <form onSubmit={handleSearch} className="relative group mt-4 h-14 md:h-16 max-w-md">
            <input
              id="username-input"
              type="text"
              placeholder="Twitch Username..."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-full bg-[#18181b] border-2 border-zinc-800 focus:border-[#a970ff] rounded-2xl pl-6 pr-18 outline-none transition-all text-lg font-medium shadow-2xl"
            />
            <button 
              id="search-button"
              type="submit"
              disabled={loading}
              className="absolute right-2 top-2 bottom-2 aspect-square bg-[#9146ff] hover:bg-[#772ce8] rounded-xl font-bold transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center justify-center"
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
              <div id="profile-sidebar" className="bg-[#18181b] rounded-2xl border border-zinc-800 p-6 flex flex-col gap-6 shadow-xl sticky top-24">
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-full border-2 border-zinc-800 bg-zinc-900 overflow-hidden">
                    <img src={profile.profileImageURL} alt={profile.displayName} className="w-full h-full rounded-full object-cover" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold">{profile.displayName}</h2>
                    <a 
                      href={`https://twitch.tv/${profile.login}`} 
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#9146ff]/10 text-[#a970ff] rounded text-[10px] font-bold uppercase tracking-wider hover:bg-[#9146ff]/20 transition-colors"
                    >
                      Visit Channel <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => handleToggleTab('following')}
                    className={`p-4 rounded-xl border transition-all text-left ${activeTab === 'following' ? 'bg-[#9146ff]/10 border-[#9146ff] ring-1 ring-[#9146ff]' : 'bg-zinc-900/50 border-zinc-800/50 hover:border-zinc-700'}`}
                  >
                    <span className={`text-[10px] uppercase font-bold tracking-widest block mb-1 ${activeTab === 'following' ? 'text-[#a970ff]' : 'text-zinc-500'}`}>Following</span>
                    <p className="text-2xl font-bold">{profile.following.totalCount.toLocaleString()}</p>
                  </button>
                  <button 
                    onClick={() => handleToggleTab('followers')}
                    className={`p-4 rounded-xl border transition-all text-left ${activeTab === 'followers' ? 'bg-[#9146ff]/10 border-[#9146ff] ring-1 ring-[#9146ff]' : 'bg-zinc-900/50 border-zinc-800/50 hover:border-zinc-700'}`}
                  >
                    <span className={`text-[10px] uppercase font-bold tracking-widest block mb-1 ${activeTab === 'followers' ? 'text-[#a970ff]' : 'text-zinc-500'}`}>Followers</span>
                    <p className="text-2xl font-bold">{profile.followers.totalCount.toLocaleString()}</p>
                  </button>
                </div>


              </div>
            </div>

            {/* Main Feed */}
            <div id="timeline-feed" className="lg:col-span-8 flex flex-col gap-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-bold text-zinc-200">
                  <span className="capitalize">{activeTab}</span>
                  <span className="text-zinc-500 font-normal ml-2 font-mono text-xs">
                    {currentFollows.length.toLocaleString()} of {activeTab === 'following' ? profile.following.totalCount.toLocaleString() : profile.followers.totalCount.toLocaleString()}
                  </span>
                </h3>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setSortOrder('desc')}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold transition-colors ${sortOrder === 'desc' ? 'bg-[#9146ff] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    NEWEST
                  </button>
                  <button 
                    onClick={() => setSortOrder('asc')}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold transition-colors ${sortOrder === 'asc' ? 'bg-[#9146ff] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    OLDEST
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {sortedFollows.map((follow, index) => (
                  <div
                    key={`${follow.node.id}-${follow.followedAt}-${index}`}
                    className="bg-[#18181b] border border-zinc-800 p-4 rounded-xl flex items-center justify-between group hover:border-[#9146ff] transition-all hover:bg-[#1c1c21]"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-10 h-10 md:w-12 md:h-12 rounded-full overflow-hidden border-2 border-zinc-800 transition-colors shrink-0">
                        <img src={follow.node.profileImageURL} alt={follow.node.displayName} className="w-full h-full object-cover" />
                      </div>
                      <h4 className="text-sm md:text-base tracking-tight group-hover:text-[#a970ff] transition-colors truncate">{follow.node.displayName}</h4>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <div className="flex items-center justify-end gap-1.5 opacity-80">
                        <Calendar className="w-3 h-3 text-[#a970ff]" />
                        <p className="text-sm text-zinc-400 whitespace-nowrap">
                          Followed {new Date(follow.followedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at {new Date(follow.followedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {hasMore && (
                <div className="mt-6 flex justify-center">
                  <button
                    onClick={handleLoadAll}
                    disabled={loadingAll}
                    className="flex items-center gap-2 px-8 py-3 bg-[#9146ff] hover:bg-[#772ce8] disabled:opacity-50 text-white rounded-xl font-bold transition-all border border-[#a970ff]/20 shadow-lg active:scale-95 shadow-[#9146ff]/20"
                  >
                    {loadingAll ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-white" /> Loading Data ({currentFollows.length.toLocaleString()})...
                      </>
                    ) : (
                      'Load All Data'
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Status Footer */}
      <footer className="h-10 border-t border-zinc-800 bg-[#18181b]">
        <div className="max-w-7xl mx-auto w-full h-full px-4 md:px-8 flex items-center justify-between text-[10px] text-zinc-500 uppercase tracking-widest font-bold">
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
