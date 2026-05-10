import React, { useState } from 'react';
import { Search, Loader2, ArrowUpDown, ExternalLink, Calendar, Users, Info } from 'lucide-react';
import { fetchFollows } from './services/twitchService';
import { TwitchProfile, FollowEdge } from './types';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export default function App() {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<TwitchProfile | null>(null);
  const [follows, setFollows] = useState<FollowEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const [activeTab, setActiveTab] = useState<'following' | 'followers'>('following');

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username.trim()) return;

    setLoading(true);
    setError(null);
    setProfile(null);
    setFollows([]);
    setActiveTab('following');

    try {
      const data = await fetchFollows(username);
      if (data) {
        setProfile(data);
        setFollows(data.following.edges);
      } else {
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
        displayMessage = details || displayMessage;
      }
      
      setError(displayMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTab = (tab: 'following' | 'followers') => {
    if (!profile) return;
    setActiveTab(tab);
    setFollows(tab === 'following' ? profile.following.edges : profile.followers.edges);
  };

  const sortedFollows = [...follows].sort((a, b) => {
    const dateA = new Date(a.followedAt).getTime();
    const dateB = new Date(b.followedAt).getTime();
    return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
  });

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="min-h-screen bg-[#0e0e10] text-zinc-100 flex flex-col font-sans selection:bg-[#9146ff] selection:text-white overflow-x-hidden">
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
        <div className="flex flex-col gap-4 max-w-2xl w-full">
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight">Search Follows</h1>
          <p className="text-zinc-400 text-base md:text-lg">
            Enter a username to display their following and followers.
          </p>
          <form onSubmit={handleSearch} className="relative group mt-4 h-14 md:h-16">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <Search className="w-6 h-6 text-zinc-500 group-focus-within:text-[#a970ff] transition-colors" />
            </div>
            <input
              id="username-input"
              type="text"
              placeholder="Twitch Username..."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-full bg-[#18181b] border-2 border-zinc-800 focus:border-[#a970ff] rounded-2xl pl-14 pr-32 outline-none transition-all text-lg font-medium shadow-2xl"
            />
            <button 
              id="search-button"
              type="submit"
              disabled={loading}
              className="absolute right-2 top-2 bottom-2 w-28 bg-[#9146ff] hover:bg-[#772ce8] rounded-xl font-bold transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Analyze'}
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
                    <p className="text-zinc-500 text-sm">@{profile.login}</p>
                    <a 
                      href={`https://twitch.tv/${profile.login}`} 
                      className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 bg-[#9146ff]/10 text-[#a970ff] rounded text-[10px] font-bold uppercase tracking-wider hover:bg-[#9146ff]/20 transition-colors"
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
                <h3 className="font-bold text-zinc-300">
                  <span className="capitalize">{activeTab}</span> History 
                  <span className="text-zinc-600 font-normal ml-2 font-mono text-xs">
                    {follows.length.toLocaleString()} of {activeTab === 'following' ? profile.following.totalCount.toLocaleString() : profile.followers.totalCount.toLocaleString()}
                  </span>
                </h3>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setSortOrder('desc')}
                    className={`px-3 py-1 rounded text-[10px] font-bold transition-colors ${sortOrder === 'desc' ? 'bg-[#9146ff] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    NEWEST
                  </button>
                  <button 
                    onClick={() => setSortOrder('asc')}
                    className={`px-3 py-1 rounded text-[10px] font-bold transition-colors ${sortOrder === 'asc' ? 'bg-[#9146ff] text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
                  >
                    OLDEST
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {sortedFollows.map((follow) => (
                  <div
                    key={`${follow.node.id}-${follow.followedAt}`}
                    className="bg-[#18181b] border border-zinc-800 p-4 rounded-xl flex items-center justify-between group hover:border-[#9146ff] transition-all hover:bg-[#1c1c21]"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-zinc-800 transition-colors">
                        <img src={follow.node.profileImageURL} alt={follow.node.displayName} className="w-full h-full object-cover" />
                      </div>
                      <div>
                        <h4 className="font-bold text-sm tracking-tight group-hover:text-[#a970ff] transition-colors">{follow.node.displayName}</h4>
                        <p className="text-zinc-500 text-[10px] font-mono">@{follow.node.login}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="flex items-center justify-end gap-1.5" id={`date-${follow.node.id}`}>
                        <Calendar className="w-3 h-3 text-[#a970ff]" />
                        <p className="text-sm font-bold text-zinc-200">{new Date(follow.followedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                      <p className="text-zinc-600 text-[10px] uppercase font-bold tracking-tight mt-0.5">
                        Followed at {new Date(follow.followedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
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
            <span className="hidden sm:inline">GQL Node: AWS-W1</span>
          </div>
          <div>
            <span>&copy; 2026 Twitch Follows</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
