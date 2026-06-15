import React from 'react';
import { 
  BookOpen, 
  Code, 
  Database, 
  ShieldCheck, 
  Cpu, 
  HelpCircle,
  ExternalLink,
  ChevronRight
} from 'lucide-react';

export function Docs() {
  const sections = [
    {
      title: "Getting Started",
      icon: BookOpen,
      items: ["Quick Start Guide", "Installation", "Stimuli Requirements", "Experimental Protocols"]
    },
    {
      title: "Task Configuration",
      icon: Code,
      items: ["JSON Schema", "Timing Parameters", "Feedback Settings", "Language Support"]
    },
    {
      title: "Data & Storage",
      icon: Database,
      items: ["CSV Format Spec", "JSON Exports", "Hardware Sync Logs", "Cloud Backup"]
    }
  ];

  return (
    <div className="py-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-12">
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Documentation</h2>
          <p className="text-slate-500">Everything you need to run successful LDT experiments.</p>
        </div>
        <div className="flex items-center gap-3 p-2 bg-slate-100 rounded-xl border border-slate-200">
          <HelpCircle className="w-5 h-5 text-slate-400 ml-2" />
          <input 
            type="text" 
            placeholder="Search docs..." 
            className="bg-transparent border-none text-sm focus:ring-0 placeholder-slate-400 w-48"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
        {sections.map((section, idx) => (
          <div key={idx} className="space-y-6">
            <div className="flex items-center gap-3 text-slate-900">
              <div className="p-2 bg-white rounded-lg shadow-sm border border-slate-100">
                <section.icon className="w-5 h-5 text-blue-600" />
              </div>
              <h3 className="font-bold">{section.title}</h3>
            </div>
            <ul className="space-y-1">
              {section.items.map((item, i) => (
                <li key={i}>
                  <a href="#" className="flex items-center justify-between group p-3 rounded-xl hover:bg-white hover:shadow-sm transition-all border border-transparent hover:border-slate-100">
                    <span className="text-sm text-slate-600 group-hover:text-blue-600 transition-colors">{item}</span>
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all translate-x-[-10px] group-hover:translate-x-0" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm relative overflow-hidden group">
          <div className="relative z-10">
            <h4 className="text-xl font-bold text-slate-900 mb-4 flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-green-600" />
              Methodological Integrity
            </h4>
            <p className="text-slate-500 text-sm leading-relaxed mb-6">
              Our LDT implementation adheres to the Gold Standard of cognitive science methodology. 
              Learn how we handle sub-millisecond keyboard polling and display refreshes.
            </p>
            <button className="text-sm font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1">
              Read Methodology Whitepaper <ExternalLink className="w-4 h-4" />
            </button>
          </div>
          <div className="absolute top-[-20px] right-[-20px] w-32 h-32 bg-green-50 rounded-full group-hover:scale-110 transition-transform"></div>
        </div>

        <div className="bg-slate-900 p-8 rounded-3xl border border-slate-800 shadow-sm relative overflow-hidden group text-white">
          <div className="relative z-10">
            <h4 className="text-xl font-bold mb-4 flex items-center gap-2">
              <Cpu className="w-6 h-6 text-blue-400" />
              Developer API
            </h4>
            <p className="text-slate-400 text-sm leading-relaxed mb-6">
              Extend the runner with custom stimuli loaders or real-time event hooks. 
              Built with Node.js and Electron for maximum flexibility.
            </p>
            <button className="text-sm font-bold text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View Source on GitHub <ExternalLink className="w-4 h-4" />
            </button>
          </div>
          <div className="absolute top-[-20px] right-[-20px] w-32 h-32 bg-white/5 rounded-full group-hover:scale-110 transition-transform"></div>
        </div>
      </div>
    </div>
  );
}
