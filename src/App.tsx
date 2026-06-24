import React, { useState, useRef, useEffect } from 'react';
import { Search, Loader2, ArrowUpDown, ExternalLink, Calendar, Users, Info, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { fetchProfile, fetchFollowsPage, fetchFollowersPage } from './services/twitchService';
import { TwitchProfile, FollowEdge } from './types';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Silence harmless Vite development environment errors in console and window
if (typeof window !== 'undefined') {
  const originalError = console.error;
  const originalWarn = console.warn;
  
  const shouldSuppress = (msg: string) => {
    const lowercase = msg.toLowerCase();
    return (
      lowercase.includes('websocket') || 
      lowercase.includes('closed without opened') || 
      lowercase.includes('integritycheckfailed')
    );
  };

  console.error = function (...args: any[]) {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    if (shouldSuppress(msg)) {
      return;
    }
    originalError.apply(console, args);
  };

  console.warn = function (...args: any[]) {
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    if (shouldSuppress(msg)) {
      return;
    }
    originalWarn.apply(console, args);
  };

  // Immediate top-level capture-phase error & rejection interception
  const handleWSRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = (reason?.message || String(reason || '')).toLowerCase();
    if (message.includes('websocket') || message.includes('closed without opened')) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }
  };

  const handleWSError = (event: ErrorEvent) => {
    const message = (event.message || '').toLowerCase();
    if (message.includes('websocket') || message.includes('closed without opened')) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }
  };

  window.addEventListener('unhandledrejection', handleWSRejection, { capture: true });
  window.addEventListener('error', handleWSError, { capture: true });
}

export default function App() {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<TwitchProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [usePagination, setUsePagination] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [jumpPageVal, setJumpPageVal] = useState('1');
  const [filterText, setFilterText] = useState('');
  const [syncStarted, setSyncStarted] = useState(false);
  const [loadingFollowing, setLoadingFollowing] = useState(false);
  const [loadingFollowers, setLoadingFollowers] = useState(false);
  const [activeTab, setActiveTab] = useState<'following' | 'followers'>('following');
  const loadRequestId = useRef(0);

  useEffect(() => {
    setJumpPageVal(currentPage.toString());
  }, [currentPage]);

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
    setCurrentPage(1);
    setUsePagination(true);
    setFilterText('');
    setSyncStarted(false);
    
    try {
      const data = await fetchProfile(activeUsername);
      
      // If a new search was started, ignore this result
      if (currentRequestId !== loadRequestId.current) return;

      if (data) {
        setProfile(data);
        
        // Intelligently check if the user has a large list of follows/followers.
        // The notification should only appear when a user has over 1000 results in at least one of the two categories individually.
        const isLargeUser = data.following.totalCount > 1000 || data.followers.totalCount > 1000;
        
        if (isLargeUser) {
          setSyncStarted(false);
          triggerBackgroundLoad(data, currentRequestId, 500);
        } else {
          setSyncStarted(true);
          triggerBackgroundLoad(data, currentRequestId);
        }
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

  const triggerBackgroundLoad = async (initialProfile: TwitchProfile, requestId: number, maxItems?: number) => {
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

          if (maxItems && currentEdges.length >= maxItems) {
            console.log(`[App] [Background] Loop paused for ${tab}: reached auto-limit of ${maxItems}`);
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
    setCurrentPage(1);
    setFilterText('');
  };

  const hasMore = profile ? (activeTab === 'following' ? profile.following.pageInfo.hasNextPage : profile.followers.pageInfo.hasNextPage) : false;

  const followingIds = React.useMemo(() => {
    if (!profile) return new Set<string>();
    return new Set(profile.following.edges.map(e => e?.node?.id).filter(Boolean));
  }, [profile?.following.edges]);

  const followersIds = React.useMemo(() => {
    if (!profile) return new Set<string>();
    return new Set(profile.followers.edges.map(e => e?.node?.id).filter(Boolean));
  }, [profile?.followers.edges]);

  const sortedFollows = React.useMemo(() => {
    if (!profile) return [];
    const edges = activeTab === 'following' ? profile.following.edges : profile.followers.edges;
    const filtered = edges.filter(e => e && e.node);
    return filtered.sort((a, b) => {
      const dateA = a.followedAt ? new Date(a.followedAt).getTime() : 0;
      const dateB = b.followedAt ? new Date(b.followedAt).getTime() : 0;
      return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
    });
  }, [profile?.following.edges, profile?.followers.edges, activeTab, sortOrder]);

  const filteredFollows = React.useMemo(() => {
    if (!filterText.trim()) return sortedFollows;
    const lower = filterText.toLowerCase();
    return sortedFollows.filter(e => 
      e.node.login.toLowerCase().includes(lower) || 
      e.node.displayName.toLowerCase().includes(lower)
    );
  }, [sortedFollows, filterText]);

  const itemsPerPage = 100;
  const totalPages = Math.ceil(filteredFollows.length / itemsPerPage);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 4) {
        pages.push(1, 2, 3, 4, 5, '...', totalPages);
      } else if (currentPage >= totalPages - 3) {
        pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
      } else {
        pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
      }
    }
    return pages;
  };

  const handleJumpPageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setJumpPageVal(e.target.value);
  };

  const handleJumpPageBlur = () => {
    const val = parseInt(jumpPageVal, 10);
    if (!isNaN(val) && val >= 1 && val <= totalPages) {
      setCurrentPage(val);
      document.getElementById('timeline-feed')?.scrollIntoView({ behavior: 'smooth' });
    } else {
      setJumpPageVal(currentPage.toString());
    }
  };

  const handleJumpPageKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = parseInt(jumpPageVal, 10);
      if (!isNaN(val) && val >= 1 && val <= totalPages) {
        setCurrentPage(val);
        document.getElementById('timeline-feed')?.scrollIntoView({ behavior: 'smooth' });
      } else {
        setJumpPageVal(currentPage.toString());
      }
    }
  };

  const displayedFollows = usePagination
    ? filteredFollows.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
    : filteredFollows;

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
            {/* Sync control banner if there is more data on Twitch and background sync hasn't started */}
            {hasMore && !syncStarted && (
              <div className="col-span-full bg-[#18181b] border border-amber-500/20 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-500 shrink-0">
                    <Info className="w-5 h-5" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-semibold text-white">Large Follower List Available</h4>
                    <p className="text-xs text-zinc-400 max-w-2xl leading-relaxed">
                      To keep the page incredibly snappy and avoid hitting API rate limits, automatic background syncing is paused after the first 500 items. 
                      You can navigate the current page below, or sync all remaining items in the background.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSyncStarted(true);
                    triggerBackgroundLoad(profile, loadRequestId.current);
                  }}
                  className="px-5 py-2.5 bg-[#934afb] hover:bg-[#8035e8] text-white rounded-xl text-xs font-semibold transition-all shrink-0 active:scale-95 cursor-pointer whitespace-nowrap flex items-center gap-2 shadow-lg"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Sync All Remaining Data
                </button>
              </div>
            )}

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
                    <span className={`text-[10px] uppercase font-semibold block mb-1 ${activeTab === 'following' ? 'text-[#934afb]' : 'text-zinc-500 hover:text-[#934afb]/80 transition-colors'}`}>Following</span>
                    <p className="text-2xl font-semibold">{profile.following.totalCount.toLocaleString()}</p>
                  </button>
                  <button 
                    onClick={() => handleToggleTab('followers')}
                    className={`p-4 rounded-xl border transition-all text-left hover:border-[#934afb] cursor-pointer ${activeTab === 'followers' ? 'bg-[#934afb]/10 border-[#934afb]' : 'bg-zinc-900/50 border-zinc-800/50'}`}
                  >
                    <span className={`text-[10px] uppercase font-semibold block mb-1 ${activeTab === 'followers' ? 'text-[#934afb]' : 'text-zinc-500 hover:text-[#934afb]/80 transition-colors'}`}>Followers</span>
                    <p className="text-2xl font-semibold">{profile.followers.totalCount.toLocaleString()}</p>
                  </button>
                </div>


              </div>
            </div>

            {/* Main Feed */}
            <div id="timeline-feed" className="lg:col-span-8 flex flex-col gap-4">
              <div className="flex items-center justify-between mb-2 gap-3 flex-wrap md:flex-nowrap">
                <div className="flex items-center gap-3.5">
                  <h3 className="font-semibold text-zinc-200 shrink-0">
                    <span className="capitalize">{activeTab}</span>{' '}
                    <span className="text-zinc-500 font-normal font-mono text-xs ml-1.5">
                      {filteredFollows.length === 0 ? '0' : (usePagination ? (currentPage - 1) * itemsPerPage + 1 : 1).toLocaleString()} to {(usePagination ? Math.min(currentPage * itemsPerPage, filteredFollows.length) : filteredFollows.length).toLocaleString()} of {filteredFollows.length.toLocaleString()}
                    </span>
                  </h3>

                  {/* Filter results search bar placed inside the tab header bar, to the right of follower count */}
                  <div className="relative w-44 h-[calc(var(--spacing)*5.5)]">
                    <input
                      type="text"
                      placeholder="Filter Results..."
                      value={filterText}
                      onChange={(e) => {
                        setFilterText(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="w-full h-full bg-[#18181b] border border-zinc-800/60 hover:border-zinc-700 focus:border-[#934afb] rounded-lg px-3 pt-0 pb-[2px] outline-none transition-all text-xs font-medium text-white placeholder-zinc-500 leading-none select-text"
                    />
                  </div>

                  {(loadingFollowing || loadingFollowers) && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#934afb]/10 text-[#934afb] text-[10px] font-semibold animate-pulse uppercase tracking-wider shrink-0">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Syncing...
                    </span>
                  )}
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                  <button 
                    onClick={() => {
                      setUsePagination(!usePagination);
                      setCurrentPage(1);
                    }}
                    className={`inline-flex items-center justify-center px-3 py-1.5 rounded text-[10px] font-semibold transition-colors leading-none cursor-pointer ${!usePagination ? 'bg-[#934afb] text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                  >
                    SHOW ALL
                  </button>
                  <button 
                    onClick={() => setSortOrder('desc')}
                    className={`inline-flex items-center justify-center px-3 py-1.5 rounded text-[10px] font-semibold transition-colors leading-none cursor-pointer ${sortOrder === 'desc' ? 'bg-[#934afb] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    NEWEST
                  </button>
                  <button 
                    onClick={() => setSortOrder('asc')}
                    className={`inline-flex items-center justify-center px-3 py-1.5 rounded text-[10px] font-semibold transition-colors leading-none cursor-pointer ${sortOrder === 'asc' ? 'bg-[#934afb] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    OLDEST
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {displayedFollows.length > 0 ? (
                  displayedFollows.map((follow, index) => {
                    const isMutual = followingIds.has(follow.node.id) && followersIds.has(follow.node.id);
                    return (
                      <div
                        key={`${follow.node.id}-${follow.followedAt}-${index}`}
                        onClick={() => handleSearch(undefined, follow.node.login)}
                        className="bg-[#18181b] border border-transparent p-4 md:p-5 rounded-xl flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4 group hover:border-[#934afb] transition-all hover:bg-[#1c1c21] cursor-pointer select-none"
                      >
                        <div className="flex items-center gap-4 min-w-0 w-full md:w-auto">
                          <div className="w-10 h-10 md:w-10 md:h-10 rounded-full overflow-hidden transition-colors shrink-0">
                            <img src={follow.node.profileImageURL} alt={follow.node.displayName} className="w-full h-full object-cover" />
                          </div>
                          <div className="flex flex-col gap-1.5 md:gap-1 min-w-0 flex-1 md:flex-initial">
                            {/* First line: username and pill */}
                            <div className="flex items-center gap-2 min-w-0 overflow-visible">
                              <h4 className="text-sm md:text-base tracking-tight font-medium group-hover:text-[#934afb] transition-colors overflow-visible whitespace-nowrap leading-none">
                                {follow.node.displayName}
                              </h4>
                              {isMutual && (
                                <span 
                                  className="inline-flex items-center justify-center px-2 rounded-full text-[9px] md:text-[10px] font-semibold bg-[#934afb]/15 text-[#934afb] border border-[#934afb]/30 shrink-0 pointer-events-none select-none leading-none translate-y-0 md:translate-y-[1.5px]"
                                  style={{ paddingBlock: 'calc(var(--spacing) * 1)' }}
                                >
                                  FOLLOWS BACK
                                </span>
                              )}
                            </div>
                            {/* Second line on mobile: followed date */}
                            <div className="md:hidden">
                              <p className="text-xs text-zinc-400 leading-normal">
                                <Calendar className="inline-block w-3 h-3 text-[#934afb] mr-1 align-baseline translate-y-[1px]" />
                                Followed {new Date(follow.followedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at {new Date(follow.followedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </div>
                        </div>
                        
                        {/* On desktop: displayed on the right side */}
                        <div className="hidden md:block text-right shrink-0 ml-4 opacity-80">
                          <p className="text-sm text-zinc-400 whitespace-nowrap leading-normal py-1 -my-1">
                            <Calendar className="inline-block w-3.5 h-3.5 text-[#934afb] mr-1.5 align-baseline translate-y-[1.5px]" />
                            Followed {new Date(follow.followedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at {new Date(follow.followedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    );
                  })
                ) : sortedFollows.length > 0 ? (
                  <div className="bg-[#18181b] border border-dashed border-zinc-800/80 rounded-2xl p-8 flex flex-col items-center text-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400">
                      <Search className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-white">No results found</h4>
                      <p className="text-xs text-zinc-400 mt-1">No users matching "{filterText}" were found in this list.</p>
                    </div>
                  </div>
                ) : (
                  !(loadingFollowing || loadingFollowers) && (
                    (activeTab === 'following' ? profile.following.totalCount : profile.followers.totalCount) === 0 ? (
                      <div className="bg-[#18181b] border border-dashed border-zinc-800/80 rounded-2xl p-8 flex flex-col items-center text-center gap-3 w-full">
                        <div className="w-10 h-10 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400">
                          <Users className="w-5 h-5" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-white">No {activeTab} found</h4>
                          <p className="text-xs text-zinc-400 mt-1">This Twitch user is not {activeTab === 'following' ? 'following anyone' : 'followed by anyone'} yet.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-[#18181b] border border-zinc-800/80 rounded-2xl p-6 md:p-8 flex flex-col items-center text-center gap-4 max-w-xl mx-auto mt-4 w-full animate-fade-in">
                        <div className="w-12 h-12 rounded-full bg-[#934afb]/10 flex items-center justify-center text-[#934afb]">
                          <Info className="w-6 h-6" />
                        </div>
                        <div className="flex flex-col gap-2">
                          <h4 className="text-base font-semibold text-white">Followers List Restricted by Twitch</h4>
                          <p className="text-sm text-zinc-400 leading-relaxed">
                            Twitch recently enforced stricter GraphQL authorization. Unauthenticated public requests can retrieve the totals, but are restricted from listing individual user profiles.
                          </p>
                          
                          {profile._authStatus && (
                            <div className="mt-2.5 p-3 rounded-xl bg-zinc-900/90 border border-zinc-800/80 flex flex-col gap-2 text-left text-xs">
                              <span className="font-semibold text-zinc-300 font-mono uppercase tracking-wider text-[10px]">Security Diagnostics:</span>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border-t border-zinc-800/40 pt-2">
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-zinc-400">Token Configured:</span>
                                  <span className={`font-mono px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase leading-none ${profile._authStatus.configured ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}`}>
                                    {profile._authStatus.configured ? 'YES' : 'NO'}
                                  </span>
                                </div>
                                {profile._authStatus.configured && (
                                  <div className="flex items-center justify-between gap-4">
                                    <span className="text-zinc-400">Token Status:</span>
                                    <span className={`font-mono px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase leading-none ${profile._authStatus.valid ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                                      {profile._authStatus.valid ? 'ACTIVE' : 'INVALID / EXPIRED (401)'}
                                    </span>
                                  </div>
                                )}
                              </div>
                              {profile._authStatus.error && (
                                <div className="border-t border-zinc-800/40 pt-1.5 mt-0.5">
                                  <p className="text-red-400/90 text-[11px] leading-normal font-mono break-all">
                                    Error: {profile._authStatus.error}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="w-full border-t border-zinc-800/60 my-1 pt-4 flex flex-col gap-3 text-left">
                          <span className="text-xs font-semibold text-zinc-300 font-mono uppercase tracking-wider">How to Unlock lists:</span>
                          <p className="text-xs text-zinc-400 leading-relaxed">
                            To load full details, configure a secure <code className="bg-zinc-800/80 px-1.5 py-0.5 rounded text-white font-mono text-[10px]">TWITCH_OAUTH_TOKEN</code> in your environment secrets.
                          </p>
                          <ol className="list-decimal list-inside text-xs text-zinc-400 space-y-1 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/40 font-sans">
                            <li>Open the <span className="text-[#934afb] font-medium">Twitch website</span> in your browser and log in.</li>
                            <li>Open Developer Tools (<kbd className="bg-zinc-800 px-1 py-0.5 rounded font-mono text-[10px]">F12</kbd> or right-click &gt; Inspect).</li>
                            <li>Go to the <strong className="text-zinc-300">Console</strong> or <strong className="text-zinc-300">Network</strong> tab, copy your <strong className="text-zinc-300">Authorization</strong> token (starts with <code className="bg-zinc-800/80 px-1 py-0.5 rounded font-mono text-[10px]">OAuth</code>).</li>
                            <li>Add the token as <code className="bg-zinc-800/80 px-1 py-0.5 rounded text-white font-mono text-[10px]">TWITCH_OAUTH_TOKEN</code> in your workspace secrets.</li>
                          </ol>
                        </div>
                      </div>
                    )
                  )
                )}
              </div>

              {/* Pagination Controls */}
              {usePagination && totalPages > 1 && (
                <div className="flex flex-col lg:flex-row items-center justify-between gap-4 mt-6 px-4 md:px-5 py-4">
                  <div className="text-xs text-zinc-400 font-mono text-center lg:text-left">
                    <span className="capitalize text-zinc-300 font-semibold">{activeTab}</span>{' '}
                    {filteredFollows.length === 0 ? '0' : (usePagination ? (currentPage - 1) * itemsPerPage + 1 : 1).toLocaleString()} to {(usePagination ? Math.min(currentPage * itemsPerPage, filteredFollows.length) : filteredFollows.length).toLocaleString()} of {filteredFollows.length.toLocaleString()}
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {/* Previous Button */}
                    <button
                      disabled={currentPage === 1}
                      onClick={() => {
                        setCurrentPage(prev => Math.max(prev - 1, 1));
                        document.getElementById('timeline-feed')?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold cursor-pointer disabled:cursor-not-allowed transition-all select-none"
                    >
                      &lt;
                    </button>

                    {/* Page Numbers */}
                    {getPageNumbers().map((page, index) => {
                      if (page === '...') {
                        return (
                          <span
                            key={`ellipsis-${index}`}
                            className="w-8 h-8 flex items-center justify-center text-zinc-500 select-none font-mono text-xs"
                          >
                            ...
                          </span>
                        );
                      }
                      const pageNum = page as number;
                      const isActive = pageNum === currentPage;
                      return (
                        <button
                          key={`page-${pageNum}`}
                          onClick={() => {
                            setCurrentPage(pageNum);
                            document.getElementById('timeline-feed')?.scrollIntoView({ behavior: 'smooth' });
                          }}
                          className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs font-semibold transition-all select-none cursor-pointer ${
                            isActive
                              ? 'bg-[#934afb] text-white shadow-md shadow-[#934afb]/10'
                              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}

                    {/* Next Button */}
                    <button
                      disabled={currentPage === totalPages}
                      onClick={() => {
                        setCurrentPage(prev => Math.min(prev + 1, totalPages));
                        document.getElementById('timeline-feed')?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold cursor-pointer disabled:cursor-not-allowed transition-all select-none"
                    >
                      &gt;
                    </button>

                    {/* Jump to Input */}
                    <span className="text-xs text-zinc-400 font-mono ml-2 flex items-center gap-1.5">
                      Page{' '}
                      <input
                        type="text"
                        value={jumpPageVal}
                        onChange={handleJumpPageChange}
                        onBlur={handleJumpPageBlur}
                        onKeyDown={handleJumpPageKeyDown}
                        className="w-12 h-8 text-center bg-zinc-800 text-white border border-zinc-700/80 rounded-lg focus:outline-none focus:border-[#934afb] font-semibold text-xs transition-colors"
                      />{' '}
                      of {totalPages}
                    </span>
                  </div>
                </div>
              )}

              {/* Toggle views or status if background syncing */}
              <div className="mt-6 flex flex-col justify-center items-center gap-3">
                {usePagination && filteredFollows.length > 100 && (
                  <button
                    onClick={() => setUsePagination(false)}
                    className="flex items-center gap-2 px-8 py-3 bg-[#934afb] hover:bg-[#8035e8] text-white rounded-xl font-semibold transition-all border border-transparent hover:border-[#934afb]/20 active:scale-95 cursor-pointer text-sm select-none"
                  >
                    Show All Results (No Pagination)
                  </button>
                )}
                {!usePagination && filteredFollows.length > 100 && (
                  <button
                    onClick={() => {
                      setUsePagination(true);
                      setCurrentPage(1);
                    }}
                    className="flex items-center gap-2 px-6 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl font-semibold transition-all active:scale-95 cursor-pointer text-xs select-none"
                  >
                    Switch to Paginated View (100 per page)
                  </button>
                )}
                {(loadingFollowing || loadingFollowers) && (
                  <span className="text-xs text-zinc-500 font-mono animate-pulse flex items-center gap-1.5 bg-[#934afb]/5 border border-[#934afb]/10 px-3 py-1.5 rounded-full mt-1">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#934afb]" />
                    Still syncing live in background: {sortedFollows.length.toLocaleString()} loaded so far...
                  </span>
                )}
              </div>
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
            {profile?._authStatus && (
              <span className="flex items-center gap-1.5">
                Auth: <span className={profile._authStatus.valid ? 'text-green-500' : 'text-amber-500'}>
                  {profile._authStatus.valid ? 'Active Token' : 'Unauthenticated (Fallback)'}
                </span>
              </span>
            )}
          </div>
          <div>
            <span>Made By Mana &copy; 2026</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
