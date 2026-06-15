import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Download, 
  PlayCircle, 
  BarChart2, 
  FileText, 
  Github, 
  ExternalLink, 
  Info,
  Users,
  ShieldCheck,
  User,
  LogOut,
  LayoutDashboard
} from 'lucide-react';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { Login } from './components/auth/Login';
import { Signup } from './components/auth/Signup';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { Hero } from './components/hero';
import { DownloadSection } from './components/download-section';
import { PracticeTask } from './components/practice-task';
import { DataAnalytics } from './components/data-analytics';
import { Docs } from './components/docs';
import { Community } from './components/community';

function AppContent() {
  const [activeTab, setActiveTab] = useState('home');
  const { user, isAdmin, signOut } = useAuth();
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  const renderContent = () => {
    switch (activeTab) {
      case 'home':
        return <Hero onGetStarted={() => setActiveTab('practice')} onDownload={() => setActiveTab('downloads')} />;
      case 'downloads':
        return <DownloadSection />;
      case 'practice':
        return <PracticeTask />;
      case 'analytics':
        return <DataAnalytics />;
      case 'docs':
        return <Docs />;
      case 'community':
        return <Community />;
      case 'login':
        return <Login onSuccess={() => setActiveTab('home')} onSwitchToSignup={() => setActiveTab('signup')} />;
      case 'signup':
        return <Signup onSuccess={() => setActiveTab('home')} onSwitchToLogin={() => setActiveTab('login')} />;
      case 'admin':
        return <AdminDashboard />;
      default:
        return <Hero onGetStarted={() => setActiveTab('practice')} onDownload={() => setActiveTab('downloads')} />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100 selection:text-blue-900">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div 
              className="flex items-center gap-2 cursor-pointer group"
              onClick={() => setActiveTab('home')}
            >
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold group-hover:bg-blue-700 transition-colors">
                L
              </div>
              <span className="text-xl font-bold tracking-tight text-slate-800">
                LDT <span className="text-blue-600">Web</span>
              </span>
            </div>

            <div className="hidden md:flex items-center space-x-1">
              {[
                { id: 'home', label: 'Overview', icon: Info },
                { id: 'downloads', label: 'Downloads', icon: Download },
                { id: 'practice', label: 'Practice Mode', icon: PlayCircle },
                { id: 'analytics', label: 'Visualizer', icon: BarChart2 },
                { id: 'docs', label: 'Docs', icon: FileText },
                { id: 'community', label: 'Community', icon: Users },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-1.5 text-sm font-medium transition-all px-3 py-2 rounded-lg ${
                    activeTab === item.id 
                      ? 'bg-blue-50 text-blue-600' 
                      : 'text-slate-600 hover:text-blue-600 hover:bg-slate-50'
                  }`}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-4">
              {user ? (
                <div className="relative">
                  <button 
                    onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                    className="flex items-center gap-2 pl-2 pr-1 py-1 bg-slate-100 hover:bg-slate-200 rounded-full transition-all"
                  >
                    <div className="w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                      {(user.user_metadata?.name?.[0] || user.email?.[0] || 'U').toUpperCase()}
                    </div>
                  </button>
                  
                  {isUserMenuOpen && (
                    <>
                      <div 
                        className="fixed inset-0 z-10" 
                        onClick={() => setIsUserMenuOpen(false)}
                      ></div>
                      <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-xl border border-slate-100 z-20 overflow-hidden py-1">
                        <div className="px-4 py-3 border-b border-slate-50">
                          <p className="text-sm font-bold text-slate-900 truncate">{user.user_metadata?.name || 'User'}</p>
                          <p className="text-xs text-slate-500 truncate">{user.email}</p>
                        </div>
                        
                        {isAdmin && (
                          <button
                            onClick={() => {
                              setActiveTab('admin');
                              setIsUserMenuOpen(false);
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2"
                          >
                            <ShieldCheck className="w-4 h-4" />
                            Admin Dashboard
                          </button>
                        )}

                        <button
                          onClick={() => {
                            setActiveTab('downloads');
                            setIsUserMenuOpen(false);
                          }}
                          className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2"
                        >
                          <Download className="w-4 h-4" />
                          My Downloads
                        </button>
                        
                        <div className="border-t border-slate-50 mt-1 pt-1">
                          <button
                            onClick={() => {
                              signOut();
                              setActiveTab('home');
                              setIsUserMenuOpen(false);
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 flex items-center gap-2"
                          >
                            <LogOut className="w-4 h-4" />
                            Sign Out
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setActiveTab('login')}
                    className="text-sm font-bold text-slate-600 hover:text-blue-600 px-3 py-2 transition-colors"
                  >
                    Log In
                  </button>
                  <button 
                    onClick={() => setActiveTab('signup')}
                    className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-slate-800 transition-all"
                  >
                    Sign Up
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-24 pb-12 min-h-[calc(100vh-80px)]">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center text-white text-xs font-bold">L</div>
                <span className="text-lg font-bold">LDT Version Control</span>
              </div>
              <p className="text-slate-500 text-sm max-w-sm mb-4">
                The Lexical Decision Task (LDT) web portal is designed for training, 
                distribution, and data visualization. For experimental-grade RT collection, 
                please use the desktop application.
              </p>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  v2.4.1 Stable
                </span>
                <span className="text-xs text-slate-400">Released Jan 2026</span>
              </div>
            </div>
            <div>
              <h4 className="font-bold text-sm text-slate-900 mb-4 uppercase tracking-wider">Resources</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li><button onClick={() => setActiveTab('docs')} className="hover:text-blue-600 transition-colors">Documentation</button></li>
                <li><button onClick={() => setActiveTab('community')} className="hover:text-blue-600 transition-colors">Community Forum</button></li>
                <li><button onClick={() => setActiveTab('practice')} className="hover:text-blue-600 transition-colors">Practice Task</button></li>
                <li><button onClick={() => setActiveTab('analytics')} className="hover:text-blue-600 transition-colors">Result Visualizer</button></li>
                <li><a href="#" className="hover:text-blue-600 transition-colors flex items-center gap-1">Methodology <ExternalLink className="w-3 h-3" /></a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold text-sm text-slate-900 mb-4 uppercase tracking-wider">Platform</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li><button onClick={() => setActiveTab('downloads')} className="hover:text-blue-600 transition-colors">Windows Desktop</button></li>
                <li><button onClick={() => setActiveTab('downloads')} className="hover:text-blue-600 transition-colors">macOS (Apple Silicon)</button></li>
                <li><button onClick={() => setActiveTab('downloads')} className="hover:text-blue-600 transition-colors">Linux Binaries</button></li>
                <li><a href="#" className="hover:text-blue-600 transition-colors">License Agreements</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-slate-100 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-xs text-slate-400 uppercase tracking-widest">
              &copy; 2026 Experimental Methodology Lab. All rights reserved.
            </p>
            <div className="flex items-center gap-6 text-xs font-medium text-slate-500">
              <a href="#" className="hover:text-slate-900">Privacy Policy</a>
              <a href="#" className="hover:text-slate-900">Terms of Service</a>
              <a href="#" className="hover:text-slate-900">Contact Support</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
