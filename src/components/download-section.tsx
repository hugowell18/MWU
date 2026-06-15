import React from 'react';
import { 
  Download, 
  Monitor, 
  Terminal, 
  Cpu, 
  ShieldCheck, 
  Globe,
  FileText,
  ChevronRight,
  HardDrive,
  CheckCircle2
} from 'lucide-react';

export function DownloadSection() {
  const versions = [
    {
      os: 'Windows',
      arch: 'x64 / ARM64',
      version: 'v2.4.1 Stable',
      icon: Monitor,
      filename: 'LDT-Setup-2.4.1.exe',
      size: '84.2 MB',
      type: 'Primary'
    },
    {
      os: 'macOS',
      arch: 'Universal (Apple / Intel)',
      version: 'v2.4.1 Stable',
      icon: Cpu,
      filename: 'LDT-Runner-Silicon.dmg',
      size: '92.5 MB',
      type: 'Primary'
    },
    {
      os: 'Linux',
      arch: 'AppImage / Deb / Rpm',
      version: 'v2.4.1 Stable',
      icon: Terminal,
      filename: 'LDT-Runner-2.4.1.AppImage',
      size: '76.8 MB',
      type: 'Community'
    }
  ];

  return (
    <div className="py-8">
      <div className="max-w-3xl mb-12">
        <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-4">Distribution Portal</h2>
        <p className="text-lg text-slate-600">
          Access the core Lexical Decision Task engine. All executables are digitally signed and 
          optimized for millisecond-accurate reaction time collection.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-16">
        {versions.map((v, i) => (
          <div key={i} className="bg-white rounded-3xl p-8 border border-slate-100 shadow-sm hover:shadow-md transition-all group">
            <div className="w-14 h-14 bg-slate-50 text-slate-900 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-blue-50 group-hover:text-blue-600 transition-all">
              <v.icon className="w-7 h-7" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 mb-1">{v.os}</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">{v.arch}</p>
            
            <div className="space-y-3 mb-8">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Version</span>
                <span className="font-bold text-slate-900">{v.version}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">File Size</span>
                <span className="font-bold text-slate-900">{v.size}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Status</span>
                <span className="inline-flex items-center gap-1 text-green-600 font-bold">
                  <CheckCircle2 className="w-3 h-3" /> Verified
                </span>
              </div>
            </div>

            <button className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-2 group/btn">
              <Download className="w-5 h-5 group-hover/btn:-translate-y-1 transition-transform" />
              Download for {v.os}
            </button>
          </div>
        ))}
      </div>

      <div className="bg-blue-600 rounded-[2.5rem] p-12 text-white overflow-hidden relative">
        <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <h3 className="text-3xl font-bold mb-6">Looking for documentation?</h3>
            <p className="text-blue-100 mb-8 text-lg">
              Detailed guides for stimuli preparation, hardware synchronization, 
              and data export formats are available in our central documentation.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <button className="bg-white text-blue-600 px-8 py-4 rounded-2xl font-bold hover:bg-blue-50 transition-all flex items-center justify-center gap-2">
                <FileText className="w-5 h-5" />
                Read User Guides
              </button>
              <button className="bg-blue-700/50 text-white border border-blue-400/30 px-8 py-4 rounded-2xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2">
                <Globe className="w-5 h-5" />
                API Reference
              </button>
            </div>
          </div>
          <div className="hidden md:block">
            <div className="bg-blue-500/30 backdrop-blur-xl border border-blue-400/30 rounded-3xl p-8 transform rotate-3 scale-110">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-3 h-3 rounded-full bg-red-400"></div>
                <div className="w-3 h-3 rounded-full bg-amber-400"></div>
                <div className="w-3 h-3 rounded-full bg-green-400"></div>
              </div>
              <div className="space-y-4 font-mono text-sm opacity-80">
                <p>$ git clone ldt-runner-core</p>
                <p>Cloning into 'ldt-runner'...</p>
                <p className="text-green-300">✓ Done. Stimuli assets initialized.</p>
                <p>$ npm install && npm run build</p>
                <p>Building production binaries for darwin-arm64...</p>
                <div className="h-1 w-full bg-white/20 rounded-full">
                  <div className="h-full bg-white w-3/4 animate-pulse"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Background blobs */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-black/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2"></div>
      </div>
    </div>
  );
}
