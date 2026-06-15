import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MessageSquare, 
  Search, 
  Plus, 
  ThumbsUp, 
  MessageCircle, 
  User, 
  Clock, 
  Tag,
  Filter,
  MoreVertical,
  Flag,
  Share2,
  Trash2,
  Lock,
  Link as LinkIcon,
  Check
} from 'lucide-react';
import { projectId, publicAnonKey } from '../utils/supabase/info';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  
} from './ui/dialog';
import { useAuth } from './auth/AuthProvider';

interface Post {
  id: string;
  author: string;
  authorId?: string;
  title: string;
  content: string;
  tags: string[];
  likes: number;
  replies: number;
  timestamp: number;
  category: 'General' | 'Research' | 'Support' | 'Stimuli';
  likedBy?: string[];
}

const API_BASE = `https://${projectId}.supabase.co/functions/v1/make-server-79af63fc`;

export function Community() {
  const { user, session, isAdmin } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [isPosting, setIsPosting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [newPost, setNewPost] = useState({ title: '', content: '', category: 'General' as const });
  const [isLoading, setIsLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchPosts();
  }, []);

  const fetchPosts = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/posts`, {
        headers: {
          'Authorization': `Bearer ${publicAnonKey}`
        }
      });
      
      if (!response.ok) throw new Error('Failed to fetch');
      
      const fetchedPosts = await response.json();
      const sortedPosts = (fetchedPosts as Post[])
        .filter(p => p && p.id)
        .sort((a, b) => b.timestamp - a.timestamp);
      
      if (sortedPosts.length === 0) {
        setPosts([]);
      } else {
        setPosts(sortedPosts);
      }
    } catch (err) {
      console.error('Error fetching posts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPost.title || !newPost.content) return;
    if (!user) {
      alert('You must be logged in to post.');
      return;
    }

    const postToSubmit = {
      title: newPost.title,
      content: newPost.content,
      category: newPost.category,
      tags: [newPost.category]
    };

    try {
      const response = await fetch(`${API_BASE}/posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`
        },
        body: JSON.stringify(postToSubmit)
      });

      if (!response.ok) throw new Error('Failed to save post');

      const data = await response.json();
      if (data.success && data.post) {
        setPosts([data.post, ...posts]);
        setNewPost({ title: '', content: '', category: 'General' });
        setIsPosting(false);
      }
    } catch (err) {
      console.error('Error saving post:', err);
      alert('Failed to post. Please try again.');
    }
  };

  const handleDeletePost = async (postId: string | null) => {
    if (!postId) return;
    setDeleteLoading(true);
    try {
      const response = await fetch(`${API_BASE}/posts/${postId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`
        }
      });

      if (!response.ok) throw new Error('Failed to delete post');

      setPosts(posts.filter(p => p.id !== postId));
      setPendingDeleteId(null);
    } catch (err) {
      console.error('Error deleting post:', err);
      setErrorMessage('Failed to delete post.');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleLike = async (postId: string) => {
    if (!user) {
      alert('Please log in to like posts.');
      return;
    }

    // Optimistic UI update
    const originalPosts = [...posts];
    setPosts(posts.map(p => {
      if (p.id === postId) {
        const isLiked = p.likedBy?.includes(user.id);
        const newLikes = isLiked ? p.likes - 1 : p.likes + 1;
        const newLikedBy = isLiked 
          ? (p.likedBy || []).filter(id => id !== user.id)
          : [...(p.likedBy || []), user.id];
        return { ...p, likes: newLikes, likedBy: newLikedBy };
      }
      return p;
    }));

    try {
      const response = await fetch(`${API_BASE}/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`
        }
      });

      if (!response.ok) throw new Error('Failed to like post');
      
      const data = await response.json();
      // Sync with server state
      setPosts(currentPosts => currentPosts.map(p => {
        if (p.id === postId) {
          return { ...p, likes: data.likes, likedBy: data.likedBy };
        }
        return p;
      }));

    } catch (err) {
      console.error('Like error:', err);
      // Revert optimistic update
      setPosts(originalPosts);
    }
  };

  const handleShare = (postId: string) => {
    const url = `${window.location.origin}?post=${postId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(postId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const filteredPosts = posts.filter(post => {
    const matchesSearch = post.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                         post.content.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = activeCategory === 'All' || post.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="py-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-12">
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Community Forum</h2>
          <p className="text-slate-500">Connect with other cognitive scientists and LDT researchers.</p>
        </div>
        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search discussions..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
            />
          </div>
          <button 
            onClick={() => {
              if (user) {
                setIsPosting(true);
              } else {
                alert('Please sign in to start a discussion.');
              }
            }}
            className="bg-blue-600 text-white px-5 py-2 rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-100"
          >
            <Plus className="w-4 h-4" />
            New Post
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Categories</h3>
            <div className="space-y-1">
              {['All', 'General', 'Research', 'Stimuli', 'Support'].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-between ${
                    activeCategory === cat 
                      ? 'bg-blue-50 text-blue-600' 
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {cat}
                  {activeCategory === cat && <div className="w-1.5 h-1.5 rounded-full bg-blue-600"></div>}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 p-6 rounded-3xl text-white">
            <h3 className="font-bold mb-2">Community Stats</h3>
            <div className="space-y-4 mt-4">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Total Researchers</span>
                <span className="font-bold">2,481</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Discussions</span>
                <span className="font-bold">{posts.length}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Online Now</span>
                <span className="font-bold">142</span>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-3">
          <AnimatePresence mode="wait">
            {isPosting ? (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="bg-white p-8 rounded-3xl border border-slate-200 shadow-xl mb-8"
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-slate-900">Create New Discussion</h3>
                  <button onClick={() => setIsPosting(false)} className="text-slate-400 hover:text-slate-600 p-2">✕</button>
                </div>
                <form onSubmit={handleSubmitPost} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Topic Title</label>
                    <input 
                      type="text" 
                      placeholder="e.g. Best practices for dual-monitor LDT setups"
                      value={newPost.title}
                      onChange={(e) => setNewPost({...newPost, title: e.target.value})}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500/20 outline-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Category</label>
                    <select 
                      value={newPost.category}
                      onChange={(e) => setNewPost({...newPost, category: e.target.value as any})}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500/20 outline-none appearance-none"
                    >
                      <option value="General">General Discussion</option>
                      <option value="Research">Methodology & Research</option>
                      <option value="Stimuli">Stimuli Assets</option>
                      <option value="Support">Technical Support</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Content</label>
                    <textarea 
                      rows={6}
                      placeholder="What's on your mind? Share findings, ask questions, or provide feedback..."
                      value={newPost.content}
                      onChange={(e) => setNewPost({...newPost, content: e.target.value})}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500/20 outline-none resize-none"
                      required
                    ></textarea>
                  </div>
                  <div className="flex gap-4 pt-4">
                    <button 
                      type="submit"
                      className="flex-1 bg-blue-600 text-white py-4 rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-100"
                    >
                      Publish to Community
                    </button>
                    <button 
                      type="button"
                      onClick={() => setIsPosting(false)}
                      className="px-8 bg-slate-50 text-slate-500 py-4 rounded-2xl font-bold hover:bg-slate-100 transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="space-y-4">
            {isLoading ? (
              <div className="py-20 text-center">
                <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-slate-500 text-sm">Syncing with community cloud...</p>
              </div>
            ) : filteredPosts.length > 0 ? (
              filteredPosts.map((post) => (
                <motion.div
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  key={post.id}
                  className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md hover:border-blue-100 transition-all group"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-slate-50 rounded-full flex items-center justify-center text-slate-400 border border-slate-100">
                        <User className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                          {post.author}
                          {post.author === 'Dr. Sarah Chen' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-500 font-medium">Expert</span>
                          )}
                        </p>
                        <p className="text-[10px] text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(post.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${
                        post.category === 'Research' ? 'bg-purple-50 text-purple-600 border-purple-100' :
                        post.category === 'Stimuli' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                        post.category === 'Support' ? 'bg-green-50 text-green-600 border-green-100' :
                        'bg-blue-50 text-blue-600 border-blue-100'
                      }`}>
                        {post.category}
                      </span>
                      
                      {/* Delete Action for Admin or Author */}
                      {(isAdmin || (user && user.id === post.authorId)) && (
                        <button 
                          onClick={() => setPendingDeleteId(post.id)}
                          className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                          title="Delete Post"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <h4 className="text-lg font-bold text-slate-900 mb-2 group-hover:text-blue-600 transition-colors">{post.title}</h4>
                  <p className="text-slate-500 text-sm leading-relaxed mb-6">
                    {post.content}
                  </p>

                  <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                    <div className="flex items-center gap-6">
                      <button 
                        onClick={() => handleLike(post.id)}
                        className={`flex items-center gap-1.5 text-xs font-bold transition-colors group/action ${
                          post.likedBy?.includes(user?.id || '') 
                            ? 'text-blue-600' 
                            : 'text-slate-400 hover:text-blue-600'
                        }`}
                      >
                        <div className={`p-1.5 rounded-lg transition-colors ${
                          post.likedBy?.includes(user?.id || '') 
                            ? 'bg-blue-50' 
                            : 'group-hover/action:bg-blue-50'
                        }`}>
                          <ThumbsUp className={`w-4 h-4 ${post.likedBy?.includes(user?.id || '') ? 'fill-blue-600' : ''}`} />
                        </div>
                        {post.likes}
                      </button>
                      <button className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-blue-600 transition-colors group/action">
                        <div className="p-1.5 rounded-lg group-hover/action:bg-blue-50 transition-colors">
                          <MessageCircle className="w-4 h-4" />
                        </div>
                        {post.replies}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => handleShare(post.id)}
                        className="p-2 text-slate-300 hover:text-blue-500 transition-colors relative"
                        title="Copy Link"
                      >
                        {copiedId === post.id ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <LinkIcon className="w-4 h-4" />
                        )}
                      </button>
                      <button className="p-2 text-slate-300 hover:text-red-500 transition-colors">
                        <Flag className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="bg-slate-50 rounded-3xl p-20 text-center border-2 border-dashed border-slate-200">
                <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-sm">
                  <Search className="w-8 h-8 text-slate-300" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-2">No discussions found</h3>
                <p className="text-slate-500 max-w-sm mx-auto">
                  Try adjusting your search filters or be the first to start a conversation in this category.
                </p>
                {user ? (
                  <button 
                    onClick={() => setIsPosting(true)}
                    className="mt-6 text-blue-600 font-bold hover:underline"
                  >
                    Start a new discussion
                  </button>
                ) : (
                  <div className="mt-6 flex flex-col items-center gap-2">
                    <p className="text-xs text-slate-400">Sign in to contribute</p>
                    <div className="flex items-center gap-2 text-sm text-slate-400">
                      <Lock className="w-3 h-3" /> Login required
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Delete confirmation dialog */}
      <Dialog open={!!pendingDeleteId} onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete discussion</DialogTitle>
            <DialogDescription>Are you sure you want to delete this discussion? This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setPendingDeleteId(null)}
              className="px-4 py-2 bg-slate-50 rounded-md mr-2"
            >
              Cancel
            </button>
            <button
              onClick={() => handleDeletePost(pendingDeleteId)}
              className="px-4 py-2 bg-red-600 text-white rounded-md"
              disabled={deleteLoading}
            >
              {deleteLoading ? 'Deleting...' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error dialog */}
      <Dialog open={!!errorMessage} onOpenChange={(open) => { if (!open) setErrorMessage(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setErrorMessage(null)}
              className="px-4 py-2 bg-blue-600 text-white rounded-md"
            >
              OK
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
